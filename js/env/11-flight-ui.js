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
  { id: 'cockpit', label: 'コックピット' },
  { id: 'orbit', label: '機体まわり' },
  { id: 'free', label: '自由（環境）' },
];

const _flightKeys = Object.create(null);
let _flightKeyHandlersBound = false;

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
  brake: ['KeyB', 'Space'],
};

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
    case 'KeyP': f.controls.parkingBrake = !f.controls.parkingBrake; announceFlight(f.controls.parkingBrake ? '駐機ブレーキ' : '駐機ブレーキ解除'); return true;
    case 'KeyR': resetFlightToRunway(); return true;
    case 'KeyF': if (typeof toggleFlightMode === 'function') toggleFlightMode(); return true;
    case 'Tab': cycleFlightCamera(); return true;
    default: return false;
  }
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

  c.pitch = axis(c.pitch, FLIGHT_KEYMAP.pitchDown, FLIGHT_KEYMAP.pitchUp);
  c.roll = axis(c.roll, FLIGHT_KEYMAP.rollLeft, FLIGHT_KEYMAP.rollRight);
  c.yaw = axis(c.yaw, FLIGHT_KEYMAP.yawLeft, FLIGHT_KEYMAP.yawRight);

  const dThrottle = (_keyDown(FLIGHT_KEYMAP.throttleUp) ? 1 : 0) - (_keyDown(FLIGHT_KEYMAP.throttleDown) ? 1 : 0);
  if (dThrottle !== 0) {
    c.throttle = THREE.MathUtils.clamp(c.throttle + dThrottle * FLIGHT_THROTTLE_RATE * dt, 0, 1);
    if (c.throttle > 0.02) c.parkingBrake = false; // 出力を入れたら駐機ブレーキは外す
  }

  c.brake = _keyDown(FLIGHT_KEYMAP.brake) ? 1 : 0;
  if (c.brake > 0) c.parkingBrake = false;
}

// --- カメラ -------------------------------------------------------------------

const _cam = {
  want: new THREE.Vector3(), look: new THREE.Vector3(), tmp: new THREE.Vector3(),
  up: new THREE.Vector3(), q: new THREE.Quaternion(),
};

function cycleFlightCamera() {
  const f = EnvState.flight;
  const i = FLIGHT_CAMERA_MODES.findIndex((m) => m.id === f.cameraMode);
  setFlightCamera(FLIGHT_CAMERA_MODES[(i + 1) % FLIGHT_CAMERA_MODES.length].id);
}

function setFlightCamera(id) {
  const f = EnvState.flight;
  f.cameraMode = id;
  // 「自由」と「機体まわり」だけ OrbitControls に操作を渡す
  EnvState.orbitControls.enabled = (id === 'free' || id === 'orbit');
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

  if (f.cameraMode === 'cockpit') {
    // 重心より少し前・少し上。機体と一緒に回る。
    const eye = _cam.tmp.set(0, ac.model.gearHeight * 0.35 + 0.55, -size * 0.16).applyQuaternion(st.quaternion);
    cam.position.copy(st.position).add(eye);
    const fwd = _cam.want.set(0, 0, -1).applyQuaternion(st.quaternion);
    cam.up.copy(_cam.up.set(0, 1, 0).applyQuaternion(st.quaternion));
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
      <div class="hud-tile sm"><span class="k">フラップ</span><b id="hudFlap">0</b><span class="u">%</span></div>
      <div class="hud-tile sm"><span class="k">脚</span><b id="hudGear">下</b></div>
      <div class="hud-tile sm"><span class="k">迎角</span><b id="hudAoa">0</b><span class="u">°</span></div>
      <div class="hud-tile sm"><span class="k">G</span><b id="hudG">1.0</b></div>
      <div class="hud-tile sm"><span class="k">対地</span><b id="hudAgl">--</b><span class="u">ft</span></div>
    </div>
    <div id="hudWarn"></div>
    <div id="hudMsg"></div>
    <div id="hudHelp">
      W/S・↑↓ ピッチ ／ A/D・←→ ロール ／ Q/E ラダー ／ Shift・Ctrl 出力 ／
      B・Space ブレーキ ／ G 脚 ／ V・C フラップ ／ P 駐機 ／ Tab 視点 ／ R 滑走路へ戻る ／ F 飛行終了
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
  set('hudFlap', Math.round(c.flap * 100));
  set('hudGear', c.gearDown ? '下' : '上');
  set('hudAoa', s.alphaDeg.toFixed(1));
  set('hudG', s.loadFactor.toFixed(1));
  set('hudAgl', s.altitudeAglM > 3000 ? '—' : Math.round(s.altitudeAglM * 3.28084).toLocaleString());

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
  set('envFlightSpecReadout',
    `${m.massKg.toLocaleString()}kg ／ 翼${m.wingArea.toFixed(1)}m² ／ 翼幅${m.wingSpan.toFixed(1)}m ／ 推力${(m.totalThrustN / 9.80665).toFixed(0)}kgf`);

  // その機体が飛べるかどうかを出す。Builderは教えてくれないので、ここで名指しする。
  const a = analyzeAircraftPerformance(m);
  const kt = (v) => Math.round(v * 1.94384);
  set('envFlightPerfReadout',
    `失速 ${kt(a.stallMps)}kt ／ 離陸滑走 ${a.takeoffM ? Math.round(a.takeoffM).toLocaleString() + 'm' : '不可'}`
    + ` ／ 翼面荷重 ${Math.round(a.wingLoading)}kg/m²`);

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
