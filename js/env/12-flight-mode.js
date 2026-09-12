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
  if (typeof restoreAttitudeIndicator === 'function') restoreAttitudeIndicator();
  initFlightHUD();
  initFlightTouch();

  if (typeof setupAutopilotUI === 'function') setupAutopilotUI();

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
    // 飛行機雲はワールドに置き去りにする点の集まりなので、機体とは別にシーンへ
    // 置いてある（09b-aircraft-visual.js）。片付けも別に要る。
    if (f.aircraft.fx) {
      EnvState.scene.remove(f.aircraft.fx);
      disposeFlightObject(f.aircraft.fx);
    }
  }
  f.aircraft = await createAircraft(config, cgWithOffset(config, currentCgOffset()));
  f.aircraft.config = config;
  EnvState.scene.add(f.aircraft.group);
  if (f.aircraft.fx) EnvState.scene.add(f.aircraft.fx);
  f.aircraft.group.visible = f.active;
  if (f.aircraft.fx) f.aircraft.fx.visible = f.active;
  if (typeof syncCgUI === 'function') syncCgUI(); // 目盛の実寸は機体の大きさで変わる
  updateFlightPanelReadout();
  // 自動操縦のパネルも描き直す。垂直離着陸のチェックボックスは「上向きエンジンを
  // 持つ機体か」で押せるかどうかが変わるので、機体を差し替えたら必ず要る——
  // ここを呼び忘れていたために、垂直離着陸機を選んでもチェックボックスが
  // ずっと灰色のまま（「垂直離着陸用エンジンがありません」の説明のまま）で、
  // 垂直離着陸をそもそも選べなかった。
  if (typeof updateAutopilotUI === 'function') updateAutopilotUI();
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
    if (typeof stopAutopilot === 'function') stopAutopilot(null);
    if (f.aircraft) { f.aircraft.group.visible = false; if (f.aircraft.fx) f.aircraft.fx.visible = false; }
    EnvState.orbitControls.enabled = true;
    // 「機体固定」の視点は真下からも覗けるように上下の制限を外してある。
    // 環境プレビューへ戻るときは、地面の下を覗き込みにくい元の制限へ戻す。
    EnvState.orbitControls.maxPolarAngle = Math.PI * 0.495;
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
  if (f.aircraft.fx) f.aircraft.fx.visible = true;
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
  // 戻すのは「機体まるごとの回転を掛けたあとの重心」。回す前の値を引くと、
  // 機体を回してある機体だけ見た目が重心からずれる。
  const cgm = ac.model.cgModel;
  ac.modelRoot.position.set(-cgm.x, -cgm.y, -cgm.z);

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

  // 滑走路へ戻すのは「やり直す」ということなので、自動操縦も必ず切っておく
  if (typeof stopAutopilot === 'function') stopAutopilot(null);

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
  // 脚の長さが脚ごとに揃っていない機体だと、水平の決め打ちでは浅い脚が
  // 宙に浮いたまま出てしまい、支えを欠いた姿勢から物理が激しく弾んで、
  // 離陸もしていないのに衝撃Gの墜落判定に触れる（settleAircraftOnGround 参照）。
  if (typeof settleAircraftOnGround === 'function') {
    settleAircraftOnGround(f.aircraft.model, f.state, flightGroundHeightAt);
  }
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
  // 自動操縦は手の入力のあと。自分が受け持つ舵だけを上書きするので、
  // 高度維持だけ入れているときは横と出力を手で操れる。
  if (typeof updateAutopilot === 'function') updateAutopilot(dt);
  const wind = flightWindVector(_flightWind);

  const sinkBefore = f.state.velocity.y;
  advanceFlight(f.aircraft.model, f.state, f.controls, wind, flightGroundHeightAt, dt);

  // 墜落判定。接地の瞬間の沈下と、機体にかかる上下方向のG（loadFactor）で見る。
  //
  // 前は速度ベクトル全体の変化量（進行方向も含む）で見ていた。これだと推力そのものの
  // 加速度まで拾ってしまい、推力/重量比が18倍を超える超音速機（サンダーバード1号）が
  // フルパワーで滑走を始めただけで「墜落」になっていた——前へ加速しているだけで、
  // 機体にかかる荷重はふつうの1G程度のまま。loadFactor は機体の**上下方向**（重力を
  // 除いた分）だけを見るので、推力の向き（ほぼ真後ろ）はほとんど出てこず、
  // 接地の衝撃（車輪のばねが縮む向き＝上下方向）はちゃんと拾える。
  if (!f.state.crashed && f.state.onGround) {
    if (Math.abs(f.state.loadFactor) > FLIGHT_CRASH_G
        || (sinkBefore < -FLIGHT_CRASH_SINK_MPS && f.state.contactCount > 0)) {
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
