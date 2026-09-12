// 11b-flight-touch.js — 画面の上の操縦装置（キーボードのない端末で飛ばすため）
//
// スマホには Shift も Tab も無い。指で触れるレバーとボタンを画面に重ねる。
//
// 作りの決めごと：
//   ・エレベーター（ピッチ）とエルロン（ロール）は別々のレバー。実機のスティックのように
//     1本にまとめると、片方だけを微妙に動かしたいときに反対側も一緒に動いてしまう。
//     指で細かく操作するにはそれぞれ別に触れたほうがいい。
//   ・エレベーター・エルロンは離すと中央へ戻る。キーボードのばね戻りと同じ扱い。
//   ・出力レバーは離しても位置が残る。実機のスロットルと同じで、
//     指を離すたびに全閉になったら離陸もできない。
//   ・レバーは controls.throttle を直接書く。キーボードは「毎秒どれだけ動かすか」を
//     足し込む作りなので、どちらを触っても同じ値が動き、取り合いにならない。
//   ・pointer イベントを1本ずつ捕まえる（setPointerCapture）。
//     こうしないと、エレベーターを握ったままエルロンも操作する——という当たり前の
//     ことができない。

const _flightTouch = {
  el: null,
  enabled: false,
  // 自分で切り替えたか（保存から戻した場合も含む）。真なら端末の自動判定より優先する。
  explicit: false,
  // 指で押さえている間だけ真になる。離れていればキーボード側の値を使う。
  hold: { pitch: false, roll: false, yaw: 0, brake: false, reverse: false, vtolLever: false },
  pitch: 0, roll: 0,
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
      <div class="ft-attitude">
        <div class="ft-lever ft-elevator" id="ftElevator">
          <div class="ft-center-line ft-center-h"></div>
          <div class="ft-fill"></div>
          <div class="ft-lever-label"><span>昇降舵</span><b>0%</b></div>
        </div>
        <div class="ft-lever ft-aileron" id="ftAileron">
          <div class="ft-center-line ft-center-v"></div>
          <div class="ft-fill"></div>
          <div class="ft-lever-label"><span>補助翼</span><b>0%</b></div>
        </div>
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
      <button type="button" class="ft-btn" id="ftHover" data-tap="hover" hidden>ホバリング</button>
      <button type="button" class="ft-btn" id="ftSpoiler" data-tap="spoiler" hidden>スポイラー</button>
      <button type="button" class="ft-btn" id="ftReverse" data-hold="reverse" hidden>逆噴射</button>
      <button type="button" class="ft-btn" data-tap="trim">トリム</button>
      <button type="button" class="ft-btn" data-tap="park">駐機</button>
      <button type="button" class="ft-btn" data-tap="camera">視点</button>
      <button type="button" class="ft-btn" data-tap="reset">滑走路へ</button>
    </div>`;
  host.appendChild(el);
  _flightTouch.el = el;

  bindFlightAxisLever(el.querySelector('#ftElevator'), 'vertical', 'pitch');
  bindFlightAxisLever(el.querySelector('#ftAileron'), 'horizontal', 'roll');
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
  t.hold.pitch = t.hold.roll = t.hold.brake = t.hold.reverse = false;
  t.hold.vtolLever = false;
  t.hold.yaw = 0;
  t.pitch = t.roll = 0;
  if (_flightTouch.el) {
    paintAxisLever(_flightTouch.el.querySelector('#ftElevator'), 0);
    paintAxisLever(_flightTouch.el.querySelector('#ftAileron'), 0);
    for (const b of _flightTouch.el.querySelectorAll('.ft-btn.on')) b.classList.remove('on');
  }
}

// --- エレベーター・エルロン（中央へ戻るレバー） --------------------------------

// v（-1〜1）を中央から伸びる帯として描く。中央からの距離で舵の大きさが、
// 伸びている向きで舵の方向がひと目でわかる。要素の大きさをJS側で測らずに済むよう、
// すべて%で位置決めする（レスポンシブでレバーの寸法が変わっても計算し直さなくていい）。
function paintAxisLever(el, v) {
  if (!el) return;
  const fill = el.querySelector('.ft-fill');
  const label = el.querySelector('.ft-lever-label b');
  const pct = Math.abs(v) * 50;
  if (fill) {
    if (el.classList.contains('ft-aileron')) {
      if (v >= 0) { fill.style.left = '50%'; fill.style.right = (50 - pct) + '%'; }
      else { fill.style.right = '50%'; fill.style.left = (50 - pct) + '%'; }
    } else {
      if (v >= 0) { fill.style.top = '50%'; fill.style.bottom = (50 - pct) + '%'; }
      else { fill.style.bottom = '50%'; fill.style.top = (50 - pct) + '%'; }
    }
  }
  if (label) label.textContent = `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
}

function bindFlightAxisLever(el, orientation, axis) {
  if (!el) return;
  const t = _flightTouch;
  let pointer = null;

  const move = (e) => {
    const r = el.getBoundingClientRect();
    const v = orientation === 'vertical'
      ? ((e.clientY - r.top) / Math.max(r.height, 1) - 0.5) * 2
      : ((e.clientX - r.left) / Math.max(r.width, 1) - 0.5) * 2;
    t[axis] = THREE.MathUtils.clamp(v, -1, 1);
    t.hold[axis] = true;
    paintAxisLever(el, t[axis]);
  };

  el.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return;
    pointer = e.pointerId;
    el.setPointerCapture(e.pointerId);
    move(e);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (pointer !== e.pointerId) return;
    move(e);
    e.preventDefault();
  });
  const up = (e) => {
    if (pointer !== e.pointerId) return;
    pointer = null;
    t.hold[axis] = false;
    t[axis] = 0;
    paintAxisLever(el, 0);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
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
    if (kind === 'vtol') _flightTouch.hold.vtolLever = true;
    move(e);
    e.preventDefault();
  });
  lever.addEventListener('pointermove', (e) => {
    if (pointer !== e.pointerId) return;
    move(e);
    e.preventDefault();
  });
  const up = (e) => {
    if (pointer !== e.pointerId) return;
    pointer = null;
    if (kind === 'vtol') _flightTouch.hold.vtolLever = false;
  };
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
    else if (what === 'reverse') t.hold.reverse = on;
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
    gear: 'KeyG', flapDown: 'KeyV', flapUp: 'KeyC', trim: 'KeyT',
    spoiler: 'KeyK', hover: 'KeyJ', park: 'KeyP', camera: 'Tab', reset: 'KeyR',
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
  if (name === 'reverse') return t.hold.reverse ? 1 : null;
  // 「垂直レバーに触れているか」だけ知りたい（値はレバーが直接書いている）
  if (name === 'vtolLever') return t.hold.vtolLever ? 1 : null;
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
  // ホバリングは垂直離着陸機だけ
  const hovBtn = t.el.querySelector('#ftHover');
  if (hovBtn) {
    hovBtn.hidden = !(model && model.hasVtol);
    hovBtn.classList.toggle('on', !!(f.autopilot && f.autopilot.hover));
  }
  // 減速装置のボタンは、積んでいる機体にだけ出す
  const spoilerBtn = t.el.querySelector('#ftSpoiler');
  if (spoilerBtn) {
    spoilerBtn.hidden = !(model && model.hasSpoiler);
    spoilerBtn.classList.toggle('on', (f.controls.spoiler || 0) > 0.5);
  }
  const revBtn = t.el.querySelector('#ftReverse');
  if (revBtn) revBtn.hidden = !(model && model.reverseThrustN > 0);

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

  // 指で触れていない間は、キーボードで動かした値もレバーの表示に映す
  // （触れた瞬間に自分の値へ戻すので、取り合いにはならない）
  if (!t.hold.pitch) paintAxisLever(t.el.querySelector('#ftElevator'), f.controls.pitch);
  if (!t.hold.roll) paintAxisLever(t.el.querySelector('#ftAileron'), f.controls.roll);
}
