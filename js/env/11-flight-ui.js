// 11-flight-ui.js — 操縦入力・カメラ・計器
//
// 操縦：キーボード。押しっぱなしで舵が中央から動き、離すとばねで戻る。
//   舵をいきなり最大にすると細かい修正ができないので、押している間に効き量が育つ形にする。
// カメラ：追尾／機首方向／コックピット／自由（もとの環境プレビューの視点）。
// 計器：DOMで出す。キャンバスに描くよりも文字が読みやすく、拡大にも耐える。

const FLIGHT_CONTROL_RATE = 2.6;    // 舵が中央から最大まで動くのにかかる時間の逆数
const FLIGHT_CONTROL_RETURN = 4.2;  // 離したときに中央へ戻る速さ
const FLIGHT_THROTTLE_RATE = 0.55;  // スロットルが0→1まで動く速さ（毎秒）

const FLIGHT_CAMERA_MODES = [
  { id: 'chase', label: '追尾' },
  // 機体に貼り付いた視点。追尾は「世界の上下」を保つのでロールしても画面は回らないが、
  // こちらは機体と一緒に回る——宙返りやロールの見え方が実際の機動そのものになる。
  { id: 'rigid', label: '機体固定' },
  { id: 'cockpit', label: 'コックピット' },
  { id: 'orbit', label: '機体まわり' },
  { id: 'free', label: '自由（環境）' },
];
// 機体固定の視点の位置（機体の大きさに対する割合。後ろ・上）
const FLIGHT_RIGID_BACK = 1.5;
const FLIGHT_RIGID_UP = 0.42;

const _flightKeys = Object.create(null);
let _flightKeyHandlersBound = false;

// いまどの舵を手で当てているか。ホバリング（apStepHover）が「持ち場を置き直すか、
// 押さえるか」を決めるのに使う。**controls の値では判定できない**——自動操縦が
// 前のコマに書いた値がばね戻りの出発点になるので、手を離しても数フレームは
// 残ってしまう。押されているキー／触れているレバーそのものを見る。
const _flightManual = { pitch: false, roll: false, yaw: false, vtol: false };
function flightManualAxes() { return _flightManual; }

// キーの割り当て。1つの操作に複数のキーを当てておく（矢印とWASDのどちらでも飛ばせる）
const FLIGHT_KEYMAP = {
  pitchUp: ['ArrowDown', 'KeyS'],
  pitchDown: ['ArrowUp', 'KeyW'],
  rollLeft: ['ArrowLeft', 'KeyA'],
  rollRight: ['ArrowRight', 'KeyD'],
  yawLeft: ['KeyQ', 'Comma'],
  yawRight: ['KeyE', 'Period'],
  throttleUp: ['ShiftLeft', 'ShiftRight'],
  throttleDown: ['ControlLeft', 'ControlRight'],
  // 垂直離陸用のエンジンは別のレバー。前へ進むエンジンと同じにすると、
  // 浮かせようとしただけで前へ走り出してしまう。
  vtolUp: ['KeyX'],
  vtolDown: ['KeyZ'],
  // トリム＝舵の中立位置。手を離したときにどの姿勢で釣り合うかを決める。
  // キーの上下がそのまま機首の上下になるよう Y（上）と H（下）に置く。
  trimUp: ['KeyY'],
  trimDown: ['KeyH'],
  brake: ['KeyB', 'Space'],
  // 逆噴射は押しているあいだだけ。ブレーキと同時に使うので、Bのとなりに置く。
  reverse: ['KeyN'],
};

const FLIGHT_TRIM_RATE = 0.35; // トリムが端から端まで動く速さ（毎秒）

function setupFlightControls() {
  if (_flightKeyHandlersBound) return;
  _flightKeyHandlersBound = true;

  const isTyping = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  };

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    _flightKeys[e.code] = true;
    if (handleFlightKeyPress(e.code)) e.preventDefault();
    // 矢印とスペースでページが動かないように。ただし飛行中だけ——
    // 飛んでいないときにスペースを奪うと、キーボードでボタンを押せなくなる。
    if (EnvState.flight && EnvState.flight.active
        && (e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { _flightKeys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in _flightKeys) _flightKeys[k] = false; });
}

// 押した瞬間に1回だけ効く操作
function handleFlightKeyPress(code) {
  const f = EnvState.flight;
  if (!f || !f.active) {
    if (code === 'KeyF' && typeof toggleFlightMode === 'function') { toggleFlightMode(); return true; }
    return false;
  }
  switch (code) {
    case 'KeyG': f.controls.gearDown = !f.controls.gearDown; announceFlight(f.controls.gearDown ? '脚 下げ' : '脚 上げ'); return true;
    case 'KeyV': f.controls.flap = Math.min(f.controls.flap + 0.5, 1); announceFlight(`フラップ ${Math.round(f.controls.flap * 100)}%`); return true;
    case 'KeyC': f.controls.flap = Math.max(f.controls.flap - 0.5, 0); announceFlight(`フラップ ${Math.round(f.controls.flap * 100)}%`); return true;
    case 'KeyK': {
      // スポイラーは出し入れするもの（フラップのように段を刻むものではない）ので、
      // 実機のレバーと同じく全開と格納の切り替えにする。
      const m = f.aircraft && f.aircraft.model;
      if (m && !m.hasSpoiler) { announceFlight('この機体にスポイラーはありません'); return true; }
      f.controls.spoiler = (f.controls.spoiler || 0) > 0.5 ? 0 : 1;
      announceFlight(f.controls.spoiler ? 'スポイラー 展開' : 'スポイラー 格納');
      return true;
    }
    case 'KeyJ': if (typeof toggleHover === 'function') toggleHover(); return true;
    case 'KeyU': return toggleAttitudeIndicator();
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
      return toggleEngineGroup(parseInt(code.slice(5), 10));
    case 'KeyL':
      f.controls.landingLight = !f.controls.landingLight;
      announceFlight(f.controls.landingLight ? '着陸灯 点灯' : '着陸灯 消灯');
      return true;
    case 'KeyP': f.controls.parkingBrake = !f.controls.parkingBrake; announceFlight(f.controls.parkingBrake ? '駐機ブレーキ' : '駐機ブレーキ解除'); return true;
    case 'KeyT': autoTrimFlight(); return true;
    case 'KeyO': if (typeof toggleAltitudeHold === 'function') toggleAltitudeHold(); return true;
    case 'KeyI':
      if (typeof startFullAutopilot !== 'function') return false;
      if (f.autopilot && f.autopilot.full) stopAutopilot(); else startFullAutopilot();
      return true;
    case 'KeyR': resetFlightToRunway(); return true;
    case 'KeyF': if (typeof toggleFlightMode === 'function') toggleFlightMode(); return true;
    case 'Tab': cycleFlightCamera(); return true;
    default: return false;
  }
}

// 水平器の表示／非表示。狭い画面や横画面では、真ん中に丸い計器があると
// いちばん見たいところ（機首の先）がふさがれるので、消せるようにしてある。
// 選択は localStorage に覚える。
const HUD_ATTITUDE_KEY = 'flightSimHudAttitudeOff';

// 音速をまたいだ回数のうち、計器がすでに知らせたぶん
let _hudSeenMachCross = 0;

function setAttitudeIndicator(on) {
  document.body.classList.toggle('hud-attitude-off', !on);
  try { localStorage.setItem(HUD_ATTITUDE_KEY, on ? '0' : '1'); } catch (err) { /* 覚えられなくても続行 */ }
}

function attitudeIndicatorOn() {
  return !document.body.classList.contains('hud-attitude-off');
}

function toggleAttitudeIndicator() {
  const on = !attitudeIndicatorOn();
  setAttitudeIndicator(on);
  announceFlight(on ? '水平器 表示' : '水平器 非表示');
  return true;
}

// 起動時に、前回の選択を戻す
function restoreAttitudeIndicator() {
  let off = false;
  try { off = localStorage.getItem(HUD_ATTITUDE_KEY) === '1'; } catch (err) { /* 読めなくても続行 */ }
  setAttitudeIndicator(!off);
}

// エンジングループの入り切り（数字キー1〜4）。
// グループごとに出せる最高速度が違うので、「ロケットを止めればマッハ5、
// 点ければマッハ21」という飛ばし方ができる。
function toggleEngineGroup(id) {
  const f = EnvState.flight;
  const model = f.aircraft && f.aircraft.model;
  if (!model) return false;
  const g = (model.engineGroups || []).find((x) => x.id === id);
  if (!g) { announceFlight(`グループ${id}のエンジンはありません`); return true; }
  const off = f.controls.engineGroupOff || (f.controls.engineGroupOff = {});
  const nowOff = !off[id];
  // 全部止めると、ただ落ちるだけの機体になる。最後の1グループは止めさせない。
  if (nowOff) {
    const alive = (model.engineGroups || []).filter((x) => !off[x.id] && x.id !== id);
    if (!alive.length) { announceFlight('最後のエンジンは止められません'); return true; }
  }
  off[id] = nowOff;
  const kt = Math.round(aircraftVMaxMps(model, f.controls) / 0.514444);
  announceFlight(`${g.label} ${nowOff ? '停止' : '始動'}（最高速度 ${kt}kt）`);
  return true;
}

const _keyDown = (list) => list.some((k) => _flightKeys[k]);

// 舵の入力を作る。押している間に中央から育ち、離すと戻る。
function updateFlightInput(dt) {
  const f = EnvState.flight;
  const c = f.controls;

  const axis = (cur, neg, pos) => {
    const want = (_keyDown(pos) ? 1 : 0) - (_keyDown(neg) ? 1 : 0);
    if (want === 0) {
      const back = FLIGHT_CONTROL_RETURN * dt;
      return Math.abs(cur) <= back ? 0 : cur - Math.sign(cur) * back;
    }
    return THREE.MathUtils.clamp(cur + want * FLIGHT_CONTROL_RATE * dt, -1, 1);
  };

  // 画面の操縦装置を触っている舵は、そちらの値をそのまま使う。
  // 指を離せば null が返り、下のばね戻りに戻る。
  const touch = (name) => (typeof flightTouchOverride === 'function' ? flightTouchOverride(name) : null);
  const tp = touch('pitch'), tr = touch('roll'), ty = touch('yaw');

  _flightManual.pitch = tp !== null
    || _keyDown(FLIGHT_KEYMAP.pitchUp) || _keyDown(FLIGHT_KEYMAP.pitchDown);
  _flightManual.roll = tr !== null
    || _keyDown(FLIGHT_KEYMAP.rollLeft) || _keyDown(FLIGHT_KEYMAP.rollRight);
  _flightManual.yaw = ty !== null
    || _keyDown(FLIGHT_KEYMAP.yawLeft) || _keyDown(FLIGHT_KEYMAP.yawRight);

  c.pitch = tp !== null ? tp : axis(c.pitch, FLIGHT_KEYMAP.pitchDown, FLIGHT_KEYMAP.pitchUp);
  c.roll = tr !== null ? tr : axis(c.roll, FLIGHT_KEYMAP.rollLeft, FLIGHT_KEYMAP.rollRight);
  c.yaw = ty !== null ? ty : axis(c.yaw, FLIGHT_KEYMAP.yawLeft, FLIGHT_KEYMAP.yawRight);

  // 出力レバーは画面側が controls を直接書くので、ここではキーぶんを足すだけでいい
  const dThrottle = (_keyDown(FLIGHT_KEYMAP.throttleUp) ? 1 : 0) - (_keyDown(FLIGHT_KEYMAP.throttleDown) ? 1 : 0);
  if (dThrottle !== 0) {
    c.throttle = THREE.MathUtils.clamp(c.throttle + dThrottle * FLIGHT_THROTTLE_RATE * dt, 0, 1);
    if (c.throttle > 0.02) c.parkingBrake = false; // 出力を入れたら駐機ブレーキは外す
  }
  const dTrim = (_keyDown(FLIGHT_KEYMAP.trimUp) ? 1 : 0) - (_keyDown(FLIGHT_KEYMAP.trimDown) ? 1 : 0);
  if (dTrim !== 0) {
    c.trim = THREE.MathUtils.clamp((c.trim || 0) + dTrim * FLIGHT_TRIM_RATE * dt, -1, 1);
  }

  const dVtol = (_keyDown(FLIGHT_KEYMAP.vtolUp) ? 1 : 0) - (_keyDown(FLIGHT_KEYMAP.vtolDown) ? 1 : 0);
  _flightManual.vtol = dVtol !== 0 || touch('vtolLever') !== null;
  if (dVtol !== 0) {
    c.vtolThrottle = THREE.MathUtils.clamp((c.vtolThrottle || 0) + dVtol * FLIGHT_THROTTLE_RATE * dt, 0, 1);
    if (c.vtolThrottle > 0.02) c.parkingBrake = false;
  }

  c.brake = touch('brake') !== null ? 1 : (_keyDown(FLIGHT_KEYMAP.brake) ? 1 : 0);
  if (c.brake > 0) c.parkingBrake = false;

  // 逆噴射は押しているあいだだけ。地上で前へ走っているときしか効かないのは
  // 物理の側で見ている（10-flight.js の推力の項）ので、ここでは素直にレバーを渡す。
  c.reverse = touch('reverse') !== null ? 1 : (_keyDown(FLIGHT_KEYMAP.reverse) ? 1 : 0);
  if (c.reverse > 0) c.parkingBrake = false;
}

// --- カメラ -------------------------------------------------------------------

const _cam = {
  want: new THREE.Vector3(), look: new THREE.Vector3(), tmp: new THREE.Vector3(),
  up: new THREE.Vector3(), q: new THREE.Quaternion(),
  // 機体固定の視点：機体から見たカメラの位置と、前のコマの機体の位置・姿勢。
  // ドラッグで回した角度を「機体に対する角度」として持ち越すのに使う。
  rigid: new THREE.Vector3(), rigidPrevPos: new THREE.Vector3(),
  rigidPrevQ: new THREE.Quaternion(), rigidReady: false,
};

function cycleFlightCamera() {
  const f = EnvState.flight;
  const i = FLIGHT_CAMERA_MODES.findIndex((m) => m.id === f.cameraMode);
  setFlightCamera(FLIGHT_CAMERA_MODES[(i + 1) % FLIGHT_CAMERA_MODES.length].id);
}

function setFlightCamera(id) {
  const f = EnvState.flight;
  f.cameraMode = id;
  // 「自由」「機体まわり」「機体固定」は OrbitControls に操作を渡す。
  // 機体固定はドラッグで見る角度を変えられるが、変えた角度は**機体に対して**
  // 覚える（updateFlightCamera を参照）。
  EnvState.orbitControls.enabled = (id === 'free' || id === 'orbit' || id === 'rigid');
  // 機体固定だけは真下や真上からも見せる。他の視点は地面の下を覗き込みにくく
  // するために浅い角度で止めてある。
  EnvState.orbitControls.maxPolarAngle = id === 'rigid' ? Math.PI : Math.PI * 0.495;
  // 入り直したら、いつもの「斜め後ろ上から」に戻す
  if (id === 'rigid') _cam.rigidReady = false;
  const sel = document.getElementById('envFlightCamera');
  if (sel && sel.value !== id) sel.value = id;
  announceFlight('視点：' + (FLIGHT_CAMERA_MODES.find((m) => m.id === id) || {}).label);
}

function updateFlightCamera(dt) {
  const f = EnvState.flight;
  const ac = f.aircraft;
  if (!ac) return;
  const st = f.state;
  const cam = EnvState.camera;
  const size = Math.max(ac.model.wingSpan, 6);

  if (f.cameraMode === 'free') return; // 環境プレビューのまま

  if (f.cameraMode === 'orbit') {
    // 機体を中心に、いつもの操作で回して見る
    EnvState.orbitControls.target.copy(st.position);
    return;
  }

  if (f.cameraMode === 'rigid') {
    // 機体に貼り付いて、機体に対して同じ向き・同じ位置を保つ。ばね追従は入れない
    // （遅れがあると「機体に対して固定」ではなくなる）。
    //
    // **見る角度はドラッグで変えられる**。ただし変えた角度は世界ではなく
    // **機体に対して**覚える——そうしないと、せっかく選んだ「右斜め前から」が
    // 機体が向きを変えるたびに別の角度になってしまう。
    //
    // やり方：このコマの頭で OrbitControls が（前のコマの機体位置を中心に）
    // カメラを動かしている。その結果を**前のコマの姿勢**で機体座標へ畳み戻せば、
    // ドラッグぶんがそのまま「機体から見たカメラの位置」の変化になる。
    // あとはそれを**今のコマの姿勢**で世界へ戻せばいい。
    if (!_cam.rigidReady) {
      _cam.rigid.set(0, size * FLIGHT_RIGID_UP, size * FLIGHT_RIGID_BACK);
      _cam.rigidReady = true;
    } else {
      _cam.rigid.copy(cam.position).sub(_cam.rigidPrevPos)
        .applyQuaternion(_cam.q.copy(_cam.rigidPrevQ).invert());
      // 中心に吸い込まれて向きを見失わないよう、近すぎるところで止める
      const min = size * 0.15;
      if (_cam.rigid.lengthSq() < min * min) _cam.rigid.setLength(min);
    }
    cam.position.copy(st.position)
      .add(_cam.want.copy(_cam.rigid).applyQuaternion(st.quaternion));
    cam.up.copy(_cam.up.set(0, 1, 0).applyQuaternion(st.quaternion));
    cam.lookAt(st.position);
    _cam.rigidPrevPos.copy(st.position);
    _cam.rigidPrevQ.copy(st.quaternion);
    EnvState.orbitControls.target.copy(st.position);
    return;
  }

  if (f.cameraMode === 'cockpit') {
    // 目の位置は**Builderで置いたコックピット視点のパーツ**があればそこ。
    // 無ければ、重心より少し前・少し上という機体の大きさからの見積もり。
    const m = ac.model;
    const eye = m.eyeLocal
      ? _cam.tmp.copy(m.eyeLocal)
      : _cam.tmp.set(0, m.gearHeight * 0.35 + 0.55, -size * 0.16);
    cam.position.copy(st.position).add(eye.applyQuaternion(st.quaternion));
    // 視線の向きも、パーツの回転があればそれに従う（横を向いた席や、
    // 少し下を見下ろす配置ができる）。
    const look = _cam.q.copy(st.quaternion);
    if (m.eyeQuat) look.multiply(m.eyeQuat);
    const fwd = _cam.want.set(0, 0, -1).applyQuaternion(look);
    cam.up.copy(_cam.up.set(0, 1, 0).applyQuaternion(look));
    cam.lookAt(_cam.look.copy(cam.position).add(fwd));
    EnvState.orbitControls.target.copy(cam.position).add(fwd.multiplyScalar(50));
    return;
  }

  // 追尾。機体の後ろ上に、少し遅れてついていく。
  // 姿勢そのままだと背面飛行で天地がひっくり返るので、ロールぶんは持ち込まない。
  const heading = THREE.MathUtils.degToRad(-st.headingDeg);
  const pitch = THREE.MathUtils.degToRad(st.pitchDeg) * 0.35;
  const q = _cam.q.setFromEuler(new THREE.Euler(pitch, heading, 0, 'YXZ'));
  const want = _cam.want.set(0, size * 0.42, size * 1.5).applyQuaternion(q).add(st.position);

  // ばね追従。速いほど引きが強くなり、機体が画面の中で前に出る。
  const k = 1 - Math.exp(-dt * 5.5);
  cam.position.lerp(want, k);
  cam.up.set(0, 1, 0);
  const look = _cam.look.copy(st.position).addScaledVector(
    _cam.tmp.set(0, 0, -1).applyQuaternion(st.quaternion), size * 0.6);
  cam.lookAt(look);
  EnvState.orbitControls.target.copy(st.position);
}

// --- 計器 ---------------------------------------------------------------------

let _hudEl = null;
let _hudAt = 0;
let _announceAt = 0;

function initFlightHUD() {
  const host = document.getElementById('envCenter');
  if (!host || document.getElementById('flightHud')) return;
  const el = document.createElement('div');
  el.id = 'flightHud';
  el.innerHTML = `
    <div class="hud-row hud-top">
      <div class="hud-tile"><span class="k">対気速度</span><b id="hudSpeed">--</b><span class="u">kt</span></div>
      <div class="hud-tile"><span class="k">高度</span><b id="hudAlt">--</b><span class="u">ft</span></div>
      <div class="hud-tile"><span class="k">方位</span><b id="hudHdg">--</b><span class="u">°</span></div>
      <div class="hud-tile"><span class="k">昇降</span><b id="hudVs">--</b><span class="u">fpm</span></div>
    </div>
    <div class="hud-row hud-bottom">
      <div class="hud-tile sm"><span class="k">出力</span><b id="hudThr">0</b><span class="u">%</span></div>
      <div class="hud-tile sm" id="hudVtolTile" hidden><span class="k">垂直</span><b id="hudVtol">0</b><span class="u">%</span></div>
      <div class="hud-tile sm"><span class="k">トリム</span><b id="hudTrim">0</b><span class="u">%</span></div>
      <div class="hud-tile sm"><span class="k">フラップ</span><b id="hudFlap">0</b><span class="u">%</span></div>
      <div class="hud-tile sm" id="hudSpoilerTile" hidden><span class="k">スポイラー</span><b id="hudSpoiler">0</b><span class="u">%</span></div>
      <div class="hud-tile sm" id="hudRevTile" hidden><span class="k">逆噴射</span><b id="hudRev">0</b><span class="u">%</span></div>
      <div class="hud-tile sm" id="hudEngTile" hidden><span class="k">エンジン</span><b id="hudEng">—</b></div>
      <div class="hud-tile sm" id="hudAbTile" hidden><span class="k">AB</span><b id="hudAb">0</b><span class="u">%</span></div>
      <div class="hud-tile sm" id="hudMachTile" hidden><span class="k">マッハ</span><b id="hudMach">0.00</b></div>
      <div class="hud-tile sm"><span class="k">脚</span><b id="hudGear">下</b></div>
      <div class="hud-tile sm"><span class="k">迎角</span><b id="hudAoa">0</b><span class="u">°</span></div>
      <div class="hud-tile sm"><span class="k">G</span><b id="hudG">1.0</b></div>
      <div class="hud-tile sm"><span class="k">対地</span><b id="hudAgl">--</b><span class="u">ft</span></div>
      <div class="hud-tile sm" id="hudApTile" hidden><span class="k">自動</span><b id="hudAp">—</b></div>
    </div>
    <div id="hudAttitude"><canvas id="hudAttitudeCanvas" width="300" height="300"></canvas></div>
    <div id="hudWarn"></div>
    <div id="hudMsg"></div>
    <div id="hudHelp">
      W/S・↑↓ ピッチ ／ A/D・←→ ロール ／ Q/E ラダー ／ Shift・Ctrl 出力 ／ X/Z 垂直エンジン ／
      T トリムを取る ／ Y/H トリム微調整 ／ B・Space ブレーキ ／ G 脚 ／ V・C フラップ ／
      K スポイラー ／ N 逆噴射（地上のみ） ／ J ホバリング ／ L 着陸灯 ／
      1〜4 エンジングループ入切 ／ U 水平器 ／
      O 高度維持 ／ I 全自動（離陸〜着陸） ／
      P 駐機 ／ Tab 視点 ／ R 滑走路へ戻る ／ F 飛行終了
    </div>`;
  host.appendChild(el);
  _hudEl = el;
}

function announceFlight(text) {
  const el = document.getElementById('hudMsg');
  if (!el) return;
  el.textContent = text;
  el.style.opacity = '1';
  _announceAt = performance.now();
}

// --- 水平器（人工水平儀） -------------------------------------------------------
//
// ピッチとロールは数字でも出しているが、**姿勢は絵で見るほうが速い**——とくに
// 雲の中や夜、視点を機体固定にしているときは、外を見ても水平がどこか分からない。
// 実機と同じで、地と空の境目・ピッチの目盛り・上のロール指標の3つだけ描く。
// 計器は「機体が動く」のではなく「世界が動く」向きに描く（実機と同じ）。
const HUD_ATT_PITCH_PER_PX = 1 / 2.6;  // 1°あたり何px動かすか（の逆数）
const HUD_ATT_SKY = '#2f6ea8';
const HUD_ATT_GROUND = '#6b4a2a';

function drawAttitudeIndicator(canvas, pitchDeg, rollDeg) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2;
  // 1°あたりの画素。計器の半径に対して決めるので、大きさを変えても見え方が変わらない。
  const pxPerDeg = r / 55;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  // 丸い窓の中だけに描く
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.translate(cx, cy);
  ctx.rotate(-rollDeg * Math.PI / 180);   // 機体が右へ傾けば、地平線は左へ傾く
  ctx.translate(0, pitchDeg * pxPerDeg);  // 機首を上げれば、地平線は下がる

  // 空と地面。回して動かすぶん、はみ出さないよう十分大きく塗る
  const big = r * 4;
  ctx.fillStyle = HUD_ATT_SKY;
  ctx.fillRect(-big, -big, big * 2, big);
  ctx.fillStyle = HUD_ATT_GROUND;
  ctx.fillRect(-big, 0, big * 2, big);
  // 地平線
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = Math.max(1.5, r * 0.012);
  ctx.beginPath();
  ctx.moveTo(-big, 0); ctx.lineTo(big, 0); ctx.stroke();

  // ピッチの目盛り。10°ごとに長い線と数字、5°ごとに短い線。
  ctx.font = `${Math.round(r * 0.14)}px 'SF Mono',Menlo,Consolas,monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1, r * 0.008);
  for (let d = -90; d <= 90; d += 5) {
    if (d === 0) continue;
    const y = -d * pxPerDeg;
    if (Math.abs(y) > r * 1.05) continue;
    const long = d % 10 === 0;
    const half = long ? r * 0.30 : r * 0.15;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(-half, y); ctx.lineTo(half, y); ctx.stroke();
    if (long) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(String(Math.abs(d)), -half - r * 0.14, y);
      ctx.fillText(String(Math.abs(d)), half + r * 0.14, y);
    }
  }
  ctx.restore();

  // ロールの目盛り（動かない側）。上の弧に、傾きの基準を刻む。
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(1, r * 0.01);
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const rad = (-90 + a) * Math.PI / 180;
    const len = (a === 0 || Math.abs(a) === 30 || Math.abs(a) === 60) ? r * 0.13 : r * 0.07;
    ctx.beginPath();
    ctx.moveTo(Math.cos(rad) * (r - 1), Math.sin(rad) * (r - 1));
    ctx.lineTo(Math.cos(rad) * (r - 1 - len), Math.sin(rad) * (r - 1 - len));
    ctx.stroke();
  }
  // いまの傾きを指す三角
  ctx.rotate(-rollDeg * Math.PI / 180);
  ctx.fillStyle = '#ffd24a';
  ctx.beginPath();
  ctx.moveTo(0, -r + r * 0.05);
  ctx.lineTo(-r * 0.07, -r + r * 0.19);
  ctx.lineTo(r * 0.07, -r + r * 0.19);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 機体の印（動かない）。実機と同じ「翼と胴体」の形。
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#ffd24a';
  ctx.lineWidth = Math.max(2, r * 0.022);
  ctx.beginPath();
  ctx.moveTo(-r * 0.45, 0); ctx.lineTo(-r * 0.16, 0);
  ctx.moveTo(-r * 0.16, 0); ctx.lineTo(-r * 0.16, r * 0.10);
  ctx.moveTo(r * 0.45, 0); ctx.lineTo(r * 0.16, 0);
  ctx.moveTo(r * 0.16, 0); ctx.lineTo(r * 0.16, r * 0.10);
  ctx.stroke();
  ctx.fillStyle = '#ffd24a';
  ctx.beginPath(); ctx.arc(0, 0, Math.max(1.5, r * 0.022), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function updateFlightHUD() {
  const f = EnvState.flight;
  if (!_hudEl) return;
  _hudEl.style.display = f.active ? '' : 'none';
  if (!f.active) return;

  const now = performance.now();
  if (now - _announceAt > 2200) {
    const m = document.getElementById('hudMsg');
    if (m) m.style.opacity = '0';
  }
  if (now - _hudAt < 100) return; // 10回/秒で十分読める
  _hudAt = now;

  const s = f.state, c = f.controls;
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('hudSpeed', Math.round(s.airspeed * 1.94384));
  set('hudAlt', Math.round(s.altitudeM * 3.28084).toLocaleString());
  set('hudHdg', String(Math.round(s.headingDeg)).padStart(3, '0'));
  set('hudVs', Math.round(s.verticalSpeed * 196.85).toLocaleString());
  set('hudThr', Math.round(c.throttle * 100));
  const vtolTile = document.getElementById('hudVtolTile');
  const hasVtol = !!(f.aircraft && f.aircraft.model && f.aircraft.model.hasVtol);
  if (vtolTile) vtolTile.hidden = !hasVtol;
  if (hasVtol) set('hudVtol', Math.round((c.vtolThrottle || 0) * 100));
  set('hudTrim', `${(c.trim || 0) >= 0 ? '+' : ''}${Math.round((c.trim || 0) * 100)}`);
  set('hudFlap', Math.round(c.flap * 100));
  // 減速装置は、積んでいる機体にだけ計器を出す（持っていない機体に0%を並べない）
  const model = f.aircraft && f.aircraft.model;
  const spoilerTile = document.getElementById('hudSpoilerTile');
  if (spoilerTile) spoilerTile.hidden = !(model && model.hasSpoiler);
  if (model && model.hasSpoiler) set('hudSpoiler', Math.round((c.spoiler || 0) * 100));
  const revTile = document.getElementById('hudRevTile');
  if (revTile) revTile.hidden = !(model && model.reverseThrustN > 0);
  if (model && model.reverseThrustN > 0) set('hudRev', Math.round((c.reverse || 0) * 100));
  // エンジングループ。2つ以上ある機体だけ、どれが回っているかを出す（1･2･-･4 のように）
  const engTile = document.getElementById('hudEngTile');
  if (engTile) engTile.hidden = !(model && model.hasEngineGroups);
  if (model && model.hasEngineGroups) {
    const off = c.engineGroupOff || {};
    set('hudEng', model.engineGroups.map((g) => (off[g.id] ? '−' : String(g.id))).join('･'));
  }
  // マッハ数。ゆっくり飛んでいるときは出さない（遅い機体の計器を増やさない）。
  // 音速は高度で変わるので、同じ対気速度でも高いところほどマッハ数は大きい。
  const machTile = document.getElementById('hudMachTile');
  const mach = s.mach || 0;
  if (machTile) machTile.hidden = mach < 0.5;
  if (mach >= 0.5) set('hudMach', mach.toFixed(2));
  // 音速をまたいだら知らせる（音は鳴らせないので文字で）。
  // 物理は1フレームに何度も進むので、旗ではなく「またいだ回数」で気付く。
  const cross = s.machCrossCount || 0;
  if (cross !== _hudSeenMachCross) {
    _hudSeenMachCross = cross;
    announceFlight(mach >= 1 ? '音速突破（ソニックブーム）' : '音速以下へ');
  }
  const abTile = document.getElementById('hudAbTile');
  if (abTile) abTile.hidden = !(model && model.hasAfterburner);
  if (model && model.hasAfterburner) set('hudAb', Math.round((s.afterburner || 0) * 100));
  set('hudGear', c.gearDown ? '下' : '上');
  const att = document.getElementById('hudAttitudeCanvas');
  if (att && attitudeIndicatorOn()) drawAttitudeIndicator(att, s.pitchDeg, s.rollDeg);
  set('hudAoa', s.alphaDeg.toFixed(1));
  set('hudG', s.loadFactor.toFixed(1));
  set('hudAgl', s.altitudeAglM > 3000 ? '—' : Math.round(s.altitudeAglM * 3.28084).toLocaleString());

  // 自動操縦。切れているあいだは枠ごと隠す（計器を増やしすぎないように）
  const apText = typeof autopilotHudText === 'function' ? autopilotHudText() : null;
  const apTile = document.getElementById('hudApTile');
  if (apTile) apTile.hidden = !apText;
  if (apText) set('hudAp', apText);
  if (typeof updateAutopilotUI === 'function' && apText) updateAutopilotUI();

  // 警告。優先度の高いものだけを1行で出す。
  const warn = document.getElementById('hudWarn');
  if (warn) {
    let text = '', cls = '';
    if (s.crashed) { text = '墜落　—　R で滑走路へ戻る'; cls = 'crash'; }
    else if (s.stallRatio > 0.35) { text = '失速'; cls = 'stall'; }
    else if (!s.onGround && !c.gearDown && s.altitudeAglM < 150 && s.verticalSpeed < 0) { text = '脚が上がっています'; cls = 'stall'; }
    else if (c.parkingBrake && c.throttle > 0.05) { text = '駐機ブレーキ'; cls = 'note'; }
    warn.textContent = text;
    warn.className = cls;
  }

  if (typeof updateFlightTouchReadout === 'function') updateFlightTouchReadout();
}

// --- 右パネルの飛行セクション ---------------------------------------------------

function setupFlightPanelUI() {
  const btn = document.getElementById('envBtnFly');
  if (btn) btn.addEventListener('click', () => toggleFlightMode());

  const sel = document.getElementById('envFlightCamera');
  if (sel) {
    for (const m of FLIGHT_CAMERA_MODES) {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label;
      sel.appendChild(o);
    }
    sel.value = EnvState.flight.cameraMode;
    sel.addEventListener('change', () => setFlightCamera(sel.value));
  }

  const acSel = document.getElementById('envFlightAircraft');
  if (acSel) acSel.addEventListener('change', () => selectFlightAircraft(acSel.value));

  const reset = document.getElementById('envBtnFlightReset');
  if (reset) reset.addEventListener('click', () => resetFlightToRunway());

  setupCgUI();
}

// --- 重心の調整 ---------------------------------------------------------------
//
// Builderで決めた重心からの「ずれ」を動かす。設計はBuilder側が正で、
// こちらは積み方を変えるようなもの——なので0に戻せば必ず設計どおりに戻る。
// スライダーは -100〜100 の整数で、機体の大きさに合わせた実寸へ変換する。
// 機体が10mでも100mでも同じ操作感になるように。

const CG_AXES = [
  // 前後は「前へ出すと安定」なので、スライダー右＝前（-Z）になるよう符号を反転する
  { id: 'Z', key: 'z', sign: -1, label: '前後', extent: 'z', frac: 0.30 },
  { id: 'Y', key: 'y', sign: 1, label: '上下', extent: 'y', frac: 0.40 },
  { id: 'X', key: 'x', sign: 1, label: '左右', extent: 'x', frac: 0.15 },
];

// スライダー1目盛ぶんの実寸。機体の広がりから決める。
function cgAxisRange(axis) {
  const ac = EnvState.flight.aircraft;
  if (!ac) return 1;
  return Math.max(ac.model.extent[axis.extent] * axis.frac, 0.5);
}

function setupCgUI() {
  for (const axis of CG_AXES) {
    const el = document.getElementById('envCg' + axis.id);
    if (!el) continue;
    el.addEventListener('input', () => {
      const f = EnvState.flight;
      if (!f.aircraft) return;
      const off = f.cgOffsets[f.configName] || (f.cgOffsets[f.configName] = { x: 0, y: 0, z: 0 });
      off[axis.key] = (parseFloat(el.value) / 100) * cgAxisRange(axis) * axis.sign;
      applyCgOffset();
    });
    el.addEventListener('change', onEnvSettingsChanged);
  }
  const reset = document.getElementById('envBtnCgReset');
  if (reset) {
    reset.addEventListener('click', () => {
      const f = EnvState.flight;
      f.cgOffsets[f.configName] = { x: 0, y: 0, z: 0 };
      syncCgUI();
      applyCgOffset();
      onEnvSettingsChanged();
    });
  }
}

// 状態 → スライダー
function syncCgUI() {
  const f = EnvState.flight;
  const off = (f.cgOffsets && f.cgOffsets[f.configName]) || { x: 0, y: 0, z: 0 };
  for (const axis of CG_AXES) {
    const el = document.getElementById('envCg' + axis.id);
    if (!el) continue;
    const range = cgAxisRange(axis);
    el.value = Math.round(THREE.MathUtils.clamp(
      ((off[axis.key] || 0) / range) * axis.sign * 100, -100, 100));
  }
  updateCgReadout();
}

function updateCgReadout() {
  const f = EnvState.flight;
  const off = (f.cgOffsets && f.cgOffsets[f.configName]) || { x: 0, y: 0, z: 0 };
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  for (const axis of CG_AXES) {
    const v = (off[axis.key] || 0) * axis.sign;
    // 前後は「前へ+」として読ませる（スライダーを右へ倒すと前へ出る、と一致させる）
    set('envCg' + axis.id + 'Readout', (v >= 0 ? '+' : '') + v.toFixed(2) + ' m');
  }
  const total = Math.hypot(off.x || 0, off.y || 0, off.z || 0);
  set('envCgReadout', (total < 0.005 ? '設計どおり' : '±' + total.toFixed(2) + ' m'));
}

// 機体の一覧をセレクトに流し込む
function refreshFlightAircraftList() {
  const sel = document.getElementById('envFlightAircraft');
  if (!sel) return;
  sel.innerHTML = '';
  for (const c of EnvState.flight.configs) {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.builtin ? c.name : `${c.name}（Builder）`;
    sel.appendChild(o);
  }
  if (EnvState.flight.configName) sel.value = EnvState.flight.configName;
}

function updateFlightPanelReadout() {
  const f = EnvState.flight;
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const btn = document.getElementById('envBtnFly');
  if (btn) btn.textContent = f.active ? '✈ 飛行をやめる' : '✈ この空港から飛ぶ';

  const notes = document.getElementById('envFlightNotes');
  if (!f.aircraft) {
    set('envFlightSpecReadout', '—');
    set('envFlightPerfReadout', '');
    if (notes) notes.innerHTML = '';
    return;
  }
  const m = f.aircraft.model;
  const kgf = (n) => Number((n / 9.80665).toFixed(0)).toLocaleString();
  set('envFlightSpecReadout',
    `${m.massKg.toLocaleString()}kg ／ 翼${m.wingArea.toFixed(1)}m² ／ 翼幅${m.wingSpan.toFixed(1)}m`
    + ` ／ 推力${kgf(m.totalThrustN)}kgf`
    // 垂直離陸用は前へ進む推力とは別のレバーなので、数字も分けて出す
    + (m.hasVtol ? ` ／ 垂直${kgf(m.vtolThrustN)}kgf` : ''));

  // その機体が飛べるかどうかを出す。Builderは教えてくれないので、ここで名指しする。
  const a = analyzeAircraftPerformance(m);
  const kt = (v) => Math.round(v * 1.94384);
  set('envFlightPerfReadout',
    `失速 ${kt(a.stallMps)}kt ／ 離陸滑走 ${a.takeoffM ? Math.round(a.takeoffM).toLocaleString() + 'm' : '不可'}`
    + ` ／ 翼面荷重 ${Math.round(a.wingLoading)}kg/m²`
    + ` ／ 静安定 ${a.staticMarginPct >= 0 ? '+' : ''}${a.staticMarginPct.toFixed(0)}%MAC`);
  updateCgReadout(); // 重心を動かすたびここを通るので、表示もここで合わせる

  if (notes) {
    notes.innerHTML = '';
    for (const n of a.notes) {
      const d = document.createElement('div');
      d.className = n.level;
      d.textContent = n.text;
      notes.appendChild(d);
    }
  }
}
