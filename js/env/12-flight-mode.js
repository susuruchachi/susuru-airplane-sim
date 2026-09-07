// 12-flight-mode.js — 飛行モードの出入りと、毎フレームの進行
//
// 環境プレビューは「カメラだけが飛び回る」作りだった。飛行モードでは機体が主役になり、
// 地形・街・空港・天候の読み込みは機体を中心に回る。切り替えでやることは3つ。
//   - カメラをOrbitControlsから機体追従へ渡す（自由視点に戻せば元どおり）
//   - 機体を選んだ空港の滑走路端に置く
//   - 毎フレーム、風を天候からもらって物理を進め、見た目と計器へ反映する
//
// 地面の高さは terrainSurfaceHeightAt（実際に描かれている面）を使う。
// worldHeightAt（真の高さ関数）を使うと、遠くのLODが粗いところで
// 車輪が地面にめり込んだり浮いたりする。

const FLIGHT_CRASH_G = 12;          // これを超える衝撃で「墜落」とする
const FLIGHT_CRASH_SINK_MPS = 9;    // 接地の瞬間にこれ以上沈んでいたら脚が折れる

// --- 出入り -------------------------------------------------------------------

async function initFlight() {
  EnvState.flight.state = createFlightState();
  EnvState.flight.controls = createFlightControls();

  // 機体の候補をそろえる。Builderの保存があればそれを優先し、内蔵機は必ず末尾に置く。
  const builder = await loadBuilderAircraftConfigs();
  const builtin = defaultAircraftConfig();
  EnvState.flight.configs = builder.list.concat([builtin]);
  EnvState.flight.configName = (builder.preferred && builder.preferred.name) || builtin.name;

  // 保存してあった機体と視点をここで戻す。設定の読み込みは起動処理より先に走るので、
  // 機体の一覧が揃うこの時点でもう一度当て直さないと、選んでいた機体が戻らない。
  if (typeof reapplyStoredFlightSelection === 'function') reapplyStoredFlightSelection();

  refreshFlightAircraftList();
  const camSel = document.getElementById('envFlightCamera');
  if (camSel) camSel.value = EnvState.flight.cameraMode;
  updateFlightPanelReadout();
  setupFlightControls();
  initFlightHUD();
  initFlightTouch();

  const touchChk = document.getElementById('envFlightTouch');
  if (touchChk) {
    touchChk.checked = document.body.classList.contains('touch-controls');
    touchChk.addEventListener('change', () => {
      setFlightTouchEnabled(touchChk.checked);
      if (typeof saveAirportSettings === 'function') saveAirportSettings();
    });
  }
}

// いま選んでいる機体の重心のずれ（無ければゼロ）
function currentCgOffset() {
  const o = EnvState.flight.cgOffsets[EnvState.flight.configName];
  return o ? { x: o.x || 0, y: o.y || 0, z: o.z || 0 } : { x: 0, y: 0, z: 0 };
}

// 設計の重心にずれを足したものを返す
function cgWithOffset(config, offset) {
  const base = config.cg || { x: 0, y: 0, z: 0 };
  return { x: (base.x || 0) + offset.x, y: (base.y || 0) + offset.y, z: (base.z || 0) + offset.z };
}

// 選んだ機体を組み立てる（まだシーンには置かない）
async function buildSelectedAircraft() {
  const f = EnvState.flight;
  const config = f.configs.find((c) => c.name === f.configName) || f.configs[f.configs.length - 1];
  if (f.aircraft) {
    EnvState.scene.remove(f.aircraft.group);
    disposeFlightObject(f.aircraft.group);
  }
  f.aircraft = await createAircraft(config, cgWithOffset(config, currentCgOffset()));
  f.aircraft.config = config;
  EnvState.scene.add(f.aircraft.group);
  f.aircraft.group.visible = f.active;
  if (typeof syncCgUI === 'function') syncCgUI(); // 目盛の実寸は機体の大きさで変わる
  updateFlightPanelReadout();
  return f.aircraft;
}

async function selectFlightAircraft(name) {
  const f = EnvState.flight;
  if (f.configName === name) return;
  f.configName = name;
  await buildSelectedAircraft();
  if (f.active) resetFlightToRunway();
}

function disposeFlightObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) { if (m.map) m.map.dispose(); m.dispose(); }
    }
  });
}

async function toggleFlightMode() {
  const f = EnvState.flight;
  if (f.active) {
    f.active = false;
    if (f.aircraft) f.aircraft.group.visible = false;
    EnvState.orbitControls.enabled = true;
    document.body.classList.remove('flying');
    releaseFlightTouch(); // 指を置いたまま飛行を抜けても舵が残らないように
    updateFlightPanelReadout();
    updateFlightHUD();
    focusCameraOnAirport();
    return;
  }

  if (!f.aircraft) await buildSelectedAircraft();
  f.active = true;
  f.aircraft.group.visible = true;
  document.body.classList.add('flying');
  setFlightCamera(f.cameraMode === 'free' ? 'chase' : f.cameraMode);
  resetFlightToRunway();
  updateFlightPanelReadout();
}

// 重心のずれを変えたときに呼ぶ。**機体を作り直さない**——GLBの読み直しは重く、
// スライダーを動かすたびに数百ミリ秒止まってしまう。飛行モデルだけを組み直し、
// 見た目は「重心ぶん戻す」位置をずらすだけで済ませる。
function applyCgOffset() {
  const f = EnvState.flight;
  const ac = f.aircraft;
  if (!ac || !ac.config) return;

  const cg = cgWithOffset(ac.config, currentCgOffset());
  ac.model = buildAircraftModel(Object.assign({}, ac.config, { cg }));
  ac.modelRoot.position.set(-cg.x, -cg.y, -cg.z);

  // 重心を上下に動かすと車輪までの距離も変わるので、接地しているなら置き直す
  if (f.active && f.state.onGround) {
    placeAircraftOnGround(ac.model, f.state,
      f.state.position.x, f.state.position.z, f.state.headingDeg, flightGroundHeightAt);
    syncAircraftVisual();
  }
  updateFlightPanelReadout();
}

// --- 滑走路に置く -------------------------------------------------------------

// 飛行で使う地面の高さ。描かれている面をそのまま読む。
function flightGroundHeightAt(x, z) {
  if (typeof terrainSurfaceHeightAt === 'function') return terrainSurfaceHeightAt(x, z);
  return worldHeightAt(x, z);
}

// 選んでいる空港の滑走路の端に、離陸の向きで置く
function resetFlightToRunway() {
  const f = EnvState.flight;
  if (!f.aircraft) return;
  const def = selectedAirportDef();
  const st = getAirportSettings(def.id);

  // 滑走路の向き。追い風にならないよう、風上側の端から出す。
  const hdgA = st.headingDeg;
  const hdgB = (st.headingDeg + 180) % 360;
  const windDir = EnvState.env.windDirectionDeg; // 風が「吹いていく」向き
  // 向かい風になるのは、機首が風の来る方（windDir+180）に近いほう
  const from = (windDir + 180) % 360;
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const heading = diff(hdgA, from) <= diff(hdgB, from) ? hdgA : hdgB;

  // 滑走路の端から少し内側に置く
  const rad = THREE.MathUtils.degToRad(heading);
  const fx = Math.sin(rad), fz = -Math.cos(rad);
  const back = st.runwayLengthM * 0.5 - 40;
  const x = def.x - fx * back;
  const z = def.z - fz * back;

  placeAircraftOnGround(f.aircraft.model, f.state, x, z, heading, flightGroundHeightAt);
  f.state.crashed = false;
  f.controls.throttle = 0;
  f.controls.vtolThrottle = 0;
  f.controls.pitch = f.controls.roll = f.controls.yaw = 0;
  f.controls.flap = 0;
  f.controls.brake = 0;
  f.controls.gearDown = true;
  f.controls.parkingBrake = true;
  // 上昇していく速度でトリムを取っておく。ここを0のまま出すと、機体によって
  // 手を離した瞬間に機首が上がったり下がったりして、まっすぐ飛ぶことすらできない。
  setFlightTrimForClimb();

  // 周りの地形・街・空港をその場でそろえる（飛んだ先が空っぽにならないように）
  EnvState.camera.position.set(x, f.state.position.y + 30, z + 60);
  EnvState.orbitControls.target.copy(f.state.position);
  if (typeof terrainRebuildNow === 'function') terrainRebuildNow();
  // 地形ができてから改めて置き直す（最初の1回は地面の高さがまだ粗い）
  placeAircraftOnGround(f.aircraft.model, f.state, x, z, heading, flightGroundHeightAt);
  syncAircraftVisual();
  announceFlight(`${def.id} ${runwayDesignatorFor(heading)} — 出力を上げて離陸`);
}

// --- トリム -------------------------------------------------------------------

// 離陸したあとの上昇速度でトリムを取っておく。滑走路に出すたびに呼ぶ。
function setFlightTrimForClimb() {
  const f = EnvState.flight;
  if (!f.aircraft) return;
  const perf = analyzeAircraftPerformance(f.aircraft.model);
  // 空気の濃さで釣り合いは変わるので、滑走路の高さを基準にする（高地の空港もある）
  const sol = solveLevelTrim(f.aircraft.model, perf.liftoffMps * 1.25, f.state.altitudeM + 300);
  f.controls.trim = sol.trim;
}

// いま飛んでいる速度・高度に合わせてトリムを取り直す（Tキー／画面のボタン）
function autoTrimFlight() {
  const f = EnvState.flight;
  if (!f.active || !f.aircraft) return;
  const sol = trimToCurrentFlight(f.aircraft.model, f.state);
  f.controls.trim = sol.trim;
  announceFlight(sol.ok
    ? `トリム ${sol.trim >= 0 ? '+' : ''}${Math.round(sol.trim * 100)}%（迎角 ${sol.alphaDeg.toFixed(1)}° で釣り合い）`
    : `トリムを一杯まで取っても釣り合いません（水平尾翼が大きすぎます）`);
}

// 方位から滑走路の呼称（09/27など）を作る
function runwayDesignatorFor(headingDeg) {
  const n = Math.round(((headingDeg % 360) + 360) % 360 / 10);
  return String(n === 0 ? 36 : n).padStart(2, '0');
}

// --- 毎フレーム ---------------------------------------------------------------

const _flightWind = new THREE.Vector3();

// 天候から風のベクトルを作る。風向は「吹いていく向き」（ワールド）。
function flightWindVector(out) {
  const rad = THREE.MathUtils.degToRad(EnvState.env.windDirectionDeg);
  const mps = EnvState.env.windSpeedKmh / 3.6;
  // 高いところほど風が強い（地面の摩擦が効かなくなる）
  const alt = Math.max(EnvState.flight.state.altitudeAglM, 0);
  const shear = 1 + THREE.MathUtils.clamp(alt / 1200, 0, 1) * 0.5;
  out.set(Math.cos(rad) * mps * shear, 0, Math.sin(rad) * mps * shear);
  return out;
}

function updateFlight(dt) {
  const f = EnvState.flight;
  if (!f.active || !f.aircraft) return;

  updateFlightInput(dt);
  const wind = flightWindVector(_flightWind);

  const before = f.state.velocity.clone();
  advanceFlight(f.aircraft.model, f.state, f.controls, wind, flightGroundHeightAt, dt);

  // 墜落判定。接地の瞬間の沈下と、その1フレームの加速度で見る。
  if (!f.state.crashed && f.state.onGround) {
    const dv = before.sub(f.state.velocity).length() / Math.max(dt, 1e-4) / 9.80665;
    if (dv > FLIGHT_CRASH_G || (before.y < -FLIGHT_CRASH_SINK_MPS && f.state.contactCount > 0)) {
      f.state.crashed = true;
      announceFlight('墜落しました — R で滑走路へ戻る');
    }
  }

  // 「高度による空の色」のプレビュー用スライダーを、実際の機体高度で置き換える。
  // これが元々スライダーだったのは機体が無かったからで、いまは本物がある。
  EnvState.env.previewAltitudeM = Math.max(f.state.altitudeM, 0);
  const alt = document.getElementById('envAltitude');
  if (alt) {
    alt.value = Math.min(EnvState.env.previewAltitudeM, alt.max || 12000);
    const r = document.getElementById('envAltitudeReadout');
    if (r) r.textContent = Math.round(EnvState.env.previewAltitudeM).toLocaleString() + ' m';
  }

  syncAircraftVisual();
  updateAircraftVisual(f.aircraft, f.controls, f.state, dt, EnvState.clock.elapsedTime);
  updateFlightCamera(dt);
  updateFlightHUD();
}

// 物理の位置と姿勢を見た目へ移す
function syncAircraftVisual() {
  const f = EnvState.flight;
  if (!f.aircraft) return;
  f.aircraft.group.position.copy(f.state.position);
  f.aircraft.group.quaternion.copy(f.state.quaternion);
}
