// 11b-flight-touch.js — 画面の上の操縦装置（キーボードのない端末で飛ばすため）
//
// スマホには Shift も Tab も無い。指で触れる操縦桿とレバーを画面に重ねる。
//
// 作りの決めごと：
//   ・操縦桿（ピッチ・ロール）は離すと中央へ戻る。キーボードのばね戻りと同じ扱い。
//   ・出力レバーは離しても位置が残る。実機のスロットルと同じで、
//     指を離すたびに全閉になったら離陸もできない。
//   ・レバーは controls.throttle を直接書く。キーボードは「毎秒どれだけ動かすか」を
//     足し込む作りなので、どちらを触っても同じ値が動き、取り合いにならない。
//   ・pointer イベントを1本ずつ捕まえる（setPointerCapture）。
//     こうしないと、操縦桿を握ったまま出力を上げる——という当たり前のことができない。

const FLIGHT_TOUCH_STICK_R = 52;   // 操縦桿を倒しきる距離（px）

const _flightTouch = {
  el: null,
  enabled: false,
  // 自分で切り替えたか（保存から戻した場合も含む）。真なら端末の自動判定より優先する。
  explicit: false,
  // 指で押さえている間だけ真になる。離れていればキーボード側の値を使う。
  hold: { pitch: false, roll: false, yaw: 0, brake: false },
  pitch: 0, roll: 0,
  stickPointer: null,
};

// 触る端末か。マウスしか無いPCに操縦桿を出しても邪魔なだけなので、既定は自動判定。
function flightTouchLikely() {
  return (navigator.maxTouchPoints || 0) > 0
    || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

function initFlightTouch() {
  const host = document.getElementById('envCenter');
  if (!host || document.getElementById('flightTouch')) return;

  const el = document.createElement('div');
  el.id = 'flightTouch';
  el.innerHTML = `
    <div class="ft-left">
      <div class="ft-stick" id="ftStick">
        <div class="ft-cross"></div>
        <div class="ft-knob" id="ftKnob"></div>
      </div>
      <div class="ft-rudder">
        <button type="button" class="ft-btn" data-hold="yawLeft">◀ 旋回</button>
        <button type="button" class="ft-btn" data-hold="yawRight">旋回 ▶</button>
      </div>
    </div>

    <div class="ft-right">
      <div class="ft-lever" id="ftThrottle" data-lever="throttle">
        <div class="ft-fill"></div>
        <div class="ft-lever-label"><span>出力</span><b>0%</b></div>
      </div>
      <div class="ft-lever ft-vtol" id="ftVtol" data-lever="vtol" hidden>
        <div class="ft-fill"></div>
        <div class="ft-lever-label"><span>垂直</span><b>0%</b></div>
      </div>
    </div>

    <div class="ft-actions">
      <button type="button" class="ft-btn" data-hold="brake">ブレーキ</button>
      <button type="button" class="ft-btn" data-tap="gear">脚</button>
      <button type="button" class="ft-btn" data-tap="flapDown">FLAP ▼</button>
      <button type="button" class="ft-btn" data-tap="flapUp">FLAP ▲</button>
      <button type="button" class="ft-btn" data-tap="park">駐機</button>
      <button type="button" class="ft-btn" data-tap="camera">視点</button>
      <button type="button" class="ft-btn" data-tap="reset">滑走路へ</button>
    </div>`;
  host.appendChild(el);
  _flightTouch.el = el;

  bindFlightTouchStick(el.querySelector('#ftStick'));
  for (const lever of el.querySelectorAll('[data-lever]')) bindFlightTouchLever(lever);
  for (const b of el.querySelectorAll('[data-hold]')) bindFlightTouchHold(b);
  for (const b of el.querySelectorAll('[data-tap]')) bindFlightTouchTap(b);

  // 保存から戻した選択があればそれを使い、無ければ端末を見て決める
  setFlightTouchEnabled(_flightTouch.explicit ? _flightTouch.enabled : flightTouchLikely(),
    _flightTouch.explicit);
}

function setFlightTouchEnabled(on, explicit) {
  _flightTouch.enabled = !!on;
  if (explicit !== false) _flightTouch.explicit = true;
  document.body.classList.toggle('touch-controls', !!on);
  if (!on) releaseFlightTouch();
  const chk = document.getElementById('envFlightTouch');
  if (chk && chk.checked !== !!on) chk.checked = !!on;
}

// 指がどこかへ行ってしまったとき（機体を切り替えた、飛行を終えた等）に舵を戻す
function releaseFlightTouch() {
  const t = _flightTouch;
  t.hold.pitch = t.hold.roll = t.hold.brake = false;
  t.hold.yaw = 0;
  t.pitch = t.roll = 0;
  t.stickPointer = null;
  const knob = document.getElementById('ftKnob');
  if (knob) knob.style.transform = 'translate(-50%,-50%)';
  if (_flightTouch.el) {
    for (const b of _flightTouch.el.querySelectorAll('.ft-btn.on')) b.classList.remove('on');
  }
}

// --- 操縦桿 -------------------------------------------------------------------

function bindFlightTouchStick(pad) {
  if (!pad) return;
  const knob = pad.querySelector('#ftKnob');
  const t = _flightTouch;

  const move = (e) => {
    const r = pad.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    const max = FLIGHT_TOUCH_STICK_R;
    if (len > max) { dx *= max / len; dy *= max / len; }
    // 手前に引く（下へ動かす）と機首上げ。実機の操縦桿と同じ向き。
    t.pitch = THREE.MathUtils.clamp(dy / max, -1, 1);
    t.roll = THREE.MathUtils.clamp(dx / max, -1, 1);
    t.hold.pitch = t.hold.roll = true;
    if (knob) knob.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px))`;
  };

  pad.addEventListener('pointerdown', (e) => {
    if (t.stickPointer !== null) return;
    t.stickPointer = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    move(e);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (t.stickPointer !== e.pointerId) return;
    move(e);
    e.preventDefault();
  });
  const up = (e) => {
    if (t.stickPointer !== e.pointerId) return;
    t.stickPointer = null;
    t.hold.pitch = t.hold.roll = false;
    if (knob) knob.style.transform = 'translate(-50%,-50%)';
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
}

// --- 出力レバー ---------------------------------------------------------------

function bindFlightTouchLever(lever) {
  const kind = lever.getAttribute('data-lever');
  let pointer = null;

  const move = (e) => {
    const f = EnvState.flight;
    if (!f || !f.active) return;
    const r = lever.getBoundingClientRect();
    // 上が全開、下が全閉
    const v = THREE.MathUtils.clamp(1 - (e.clientY - r.top) / Math.max(r.height, 1), 0, 1);
    if (kind === 'vtol') f.controls.vtolThrottle = v;
    else {
      f.controls.throttle = v;
      if (v > 0.02) f.controls.parkingBrake = false;
    }
  };

  lever.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return;
    pointer = e.pointerId;
    lever.setPointerCapture(e.pointerId);
    move(e);
    e.preventDefault();
  });
  lever.addEventListener('pointermove', (e) => {
    if (pointer !== e.pointerId) return;
    move(e);
    e.preventDefault();
  });
  const up = (e) => { if (pointer === e.pointerId) pointer = null; };
  lever.addEventListener('pointerup', up);
  lever.addEventListener('pointercancel', up);
}

// --- 押している間だけ効くボタン ------------------------------------------------

function bindFlightTouchHold(btn) {
  const what = btn.getAttribute('data-hold');
  let pointer = null;
  const set = (on) => {
    btn.classList.toggle('on', on);
    const t = _flightTouch;
    if (what === 'brake') t.hold.brake = on;
    else if (what === 'yawLeft') t.hold.yaw = on ? -1 : 0;
    else if (what === 'yawRight') t.hold.yaw = on ? 1 : 0;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return;
    pointer = e.pointerId;
    btn.setPointerCapture(e.pointerId);
    set(true);
    e.preventDefault();
  });
  const up = (e) => { if (pointer !== e.pointerId) return; pointer = null; set(false); };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('lostpointercapture', up);
}

// --- 押した瞬間に1回効くボタン --------------------------------------------------

function bindFlightTouchTap(btn) {
  const what = btn.getAttribute('data-tap');
  const codes = {
    gear: 'KeyG', flapDown: 'KeyV', flapUp: 'KeyC',
    park: 'KeyP', camera: 'Tab', reset: 'KeyR',
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    // キーボードと同じ入口を通す。処理が2か所に分かれると必ず片方だけ直し忘れる。
    if (codes[what]) handleFlightKeyPress(codes[what]);
  });
}

// --- 毎フレーム ---------------------------------------------------------------

// 指の入力を controls へ流す。押さえていない舵は false を返し、
// キーボード側のばね戻りにそのまま任せる。
function flightTouchOverride(name) {
  const t = _flightTouch;
  if (!t.enabled) return null;
  if (name === 'pitch') return t.hold.pitch ? t.pitch : null;
  if (name === 'roll') return t.hold.roll ? t.roll : null;
  if (name === 'yaw') return t.hold.yaw !== 0 ? t.hold.yaw : null;
  if (name === 'brake') return t.hold.brake ? 1 : null;
  return null;
}

function updateFlightTouchReadout() {
  const t = _flightTouch;
  if (!t.enabled || !t.el) return;
  const f = EnvState.flight;
  if (!f || !f.active) return;

  const model = f.aircraft && f.aircraft.model;
  const vtol = t.el.querySelector('#ftVtol');
  if (vtol) vtol.hidden = !(model && model.hasVtol);

  const paint = (id, v) => {
    const lever = t.el.querySelector(id);
    if (!lever || lever.hidden) return;
    const fill = lever.querySelector('.ft-fill');
    if (fill) fill.style.height = `${(v * 100).toFixed(0)}%`;
    const b = lever.querySelector('b');
    if (b) b.textContent = `${Math.round(v * 100)}%`;
  };
  paint('#ftThrottle', f.controls.throttle);
  paint('#ftVtol', f.controls.vtolThrottle || 0);
}
