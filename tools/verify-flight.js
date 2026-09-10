#!/usr/bin/env node
// tools/verify-flight.js — 飛行モデルの検証（ブラウザ不要）
//
//   node tools/verify-flight.js           … 検証
//   node tools/verify-flight.js --trace   … 各試験の時間変化も出す
//
// 飛行機は「それらしく見える」だけでは足りない。滑走して浮くか、
// 手を離して落ち着くか、失速して回復できるか、旋回して戻ってこられるか——
// 数字で確かめられることは全部ここで確かめる。ブラウザで飛ばして「なんか変」と
// 気付くより、こちらのほうが早いし原因も分かる。
//
// THREE.js は数学（Vector3/Quaternion）にしか使っていないので、
// ブラウザ用のファイルをそのまま読んで同じ計算をさせられる。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// three.js を用意する。無ければ検証を飛ばす（CIに three を置かない前提のため）。
let THREE = null;
for (const p of [
  path.join(__dirname, '..', 'vendor', 'three.min.js'),
  path.join(process.env.SP || '/nonexistent', 'vendor', 'three.min.js'),
  path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.min.js'),
]) {
  if (fs.existsSync(p)) { THREE = require(p); break; }
}
if (!THREE) {
  console.log('three.js が見つからないので飛行の検証は飛ばします');
  console.log('（vendor/three.min.js を置くか、npm i three すると走ります）');
  process.exit(0);
}

// ブラウザ用のファイルを1つのスコープに並べて読む（flight.html と同じ読み方）
const ctx = vm.createContext({ THREE, console, module: undefined, Math, Number, Array, Object, JSON });
for (const f of ['09-aircraft.js', '10-flight.js', '13-autopilot.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'env', f), 'utf8');
  vm.runInContext(src, ctx, { filename: f });
}
const {
  buildAircraftModel, defaultAircraftConfig, analyzeAircraftPerformance,
  createFlightState, createFlightControls, advanceFlight, placeAircraftOnGround,
  airDensityAt, solveLevelTrim, vtolClimbSpeedLimit, accumulateAeroForces, refreshFlightReadouts,
  createAutopilotState, stepAutopilot, apSpeedSchedule, apMakeApproachPlan,
  apPickRunwayHeading, apTrackPosition, apWrap180, apBearingTo, apBankMaxFor,
  apElevatorForPitch, apSurfaceGain, apBankLimit, apBankAglFactor,
} = ctx;

// 13-autopilot.js / 10-flight.js の同名の定数と同じ値。vmコンテキストの外からは
// トップレベルのconstを直接読めない（関数と違ってグローバルオブジェクトに乗らない）
// ので、比較用にここでも複製する。
const AP_BANK_AGL_LO_FOR_TEST = 60;
const FLIGHT_GRAVITY_FOR_TEST = 9.80665;

let failures = 0;
const TRACE = process.argv.includes('--trace');
function check(ok, label, detail) {
  if (!ok) failures++;
  if (!ok || process.env.VERBOSE || TRACE) {
    console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? '  — ' + detail : ''}`);
  }
  return ok;
}
function note(label, detail) { console.log(`[  --  ] ${label}${detail ? ': ' + detail : ''}`); }

const flatGround = () => 0;
const noWind = new THREE.Vector3();
const KT = 1.94384;

// --- 機体の組み立て -----------------------------------------------------------

const model = buildAircraftModel(defaultAircraftConfig());
note('内蔵機', `${model.massKg}kg / 翼面積${model.wingArea.toFixed(1)}m² / 翼幅${model.wingSpan.toFixed(1)}m`
  + ` / 推力${(model.totalThrustN / 9.80665).toFixed(0)}kgf / 翼${model.surfaces.length}枚 / 接地点${model.contacts.length}`);
note('慣性モーメント', `ロール${model.inertia.x.toFixed(0)} ピッチ${model.inertia.y.toFixed(0)} ヨー${model.inertia.z.toFixed(0)} kg·m²`);

{
  check(model.surfaces.length === 5, '翼が5枚とも読めている', `${model.surfaces.length}枚`);
  check(model.wingArea > 12 && model.wingArea < 22, '主翼面積がそれらしい', model.wingArea.toFixed(1) + 'm²');
  check(model.contacts.length === 3, '接地点が3つ', `${model.contacts.length}`);
  check(model.engines.length === 1 && model.totalThrustN > 1000, 'エンジンが読めている');
  check(Math.abs(model.gearHeight - 1.05) < 0.3, '車輪の高さが重心の下にある', model.gearHeight.toFixed(2) + 'm');

  // 舵が全部そろっているか（効きが0だと操縦できない）
  const sum = (k) => model.surfaces.reduce((a, s) => a + Math.abs(s[k]), 0);
  check(sum('pitch') > 0.01, 'エレベーターが効く');
  check(sum('roll') > 0.01, 'エルロンが効く');
  check(sum('yaw') > 0.01, 'ラダーが効く');
  check(sum('flap') > 0.01, 'フラップが効く');
  // エルロンは左右で逆向きでなければロールしない
  const ail = model.surfaces.filter((s) => s.role === 'main');
  check(ail.length === 2 && ail[0].roll * ail[1].roll < 0, 'エルロンが左右で逆に効く',
    ail.map((s) => `${s.side}:${s.roll.toFixed(3)}`).join(' '));
}

// 機首が-Zを向いているか（向きの正規化が効いているか）
{
  const fwd = model.surfaces.find((s) => s.role === 'main').fwd;
  check(fwd.z < -0.9, '主翼の前方が機首(-Z)を向いている', `fwd=(${fwd.toArray().map((v) => v.toFixed(2)).join(',')})`);

  // わざと180°ひっくり返した機体を作っても、同じ向きに正規化されること
  const flipped = defaultAircraftConfig();
  for (const p of flipped.parts) {
    p.position.x *= -1; p.position.z *= -1;
    if (p.props && p.props.corners) {
      for (const k in p.props.corners) { p.props.corners[k].x *= -1; p.props.corners[k].z *= -1; }
    }
  }
  const m2 = buildAircraftModel(flipped);
  const fwd2 = m2.surfaces.find((s) => s.role === 'main').fwd;
  check(fwd2.z < -0.9, '+Zを向いた機体でも機首を読み取って直せる',
    `fwd=(${fwd2.toArray().map((v) => v.toFixed(2)).join(',')})`);
}

// --- 着陸脚（Builderの定義から車輪の位置を組み立てられているか）-------------------
{
  // 関節と伸縮節を持つ脚。伸縮節は-Y方向へ伸びるので、先端は付け根の 2.5m 下。
  const gearCfg = defaultAircraftConfig();
  gearCfg.parts = gearCfg.parts.filter((p) => p.type !== 'landing_gear').concat([
    { id: 'g1', type: 'landing_gear', name: '主脚右', position: { x: 2, y: 1, z: 0.5 },
      rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      props: { gearPosition: 'main_right', deployState: 1, retractedAtZero: true,
        joints: [{ id: 'j', axis: 'x', minDeg: -90, maxDeg: 0 }],
        struts: [{ id: 's', minLength: 1, maxLength: 2.5 }] } },
    { id: 'g2', type: 'landing_gear', name: '主脚左', position: { x: -2, y: 1, z: 0.5 },
      rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      props: { gearPosition: 'main_left', deployState: 1, retractedAtZero: true,
        joints: [{ id: 'j2', axis: 'x', minDeg: -90, maxDeg: 0 }],
        struts: [{ id: 's2', minLength: 1, maxLength: 2.5 }] } },
    // 札は「前脚」だが実際は後ろ。役割は配置から決まるべき。
    { id: 'g3', type: 'landing_gear', name: '後輪（札は前脚）', position: { x: 0, y: 1, z: 4 },
      rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      props: { gearPosition: 'nose', deployState: 1, retractedAtZero: true,
        joints: [], struts: [{ id: 's3', minLength: 1, maxLength: 2.5 }] } },
  ]);
  gearCfg.cg = { x: 0, y: 1, z: 0 };
  const gm = buildAircraftModel(gearCfg);
  const ys = gm.contacts.map((c) => c.position.y);
  check(Math.abs(Math.min(...ys) + 2.5) < 0.01, '車輪が伸縮節の長さぶん下に来る',
    `最下点 ${Math.min(...ys).toFixed(2)}m（伸縮節2.5m）`);
  check(Math.abs(gm.gearHeight - 2.5) < 0.01, '車輪の高さが伸縮節から決まる', gm.gearHeight.toFixed(2) + 'm');
  const steer = gm.contacts.filter((c) => c.steer), brake = gm.contacts.filter((c) => c.brake);
  check(steer.length === 1 && Math.abs(steer[0].position.x) < 0.1,
    '操向輪は中心線上の1輪（札ではなく配置で決まる）', steer.map((c) => c.name).join('/'));
  check(brake.length === 2, 'ブレーキは左右に開いた対', brake.map((c) => c.name).join('/'));

  // パーツの回転は「度」。180°回すと伸縮節は上向きになる。
  const flipCfg = JSON.parse(JSON.stringify(gearCfg));
  flipCfg.parts.find((p) => p.id === 'g1').rotation = { x: 180, y: 0, z: 0 };
  const fm = buildAircraftModel(flipCfg);
  const g1 = fm.contacts.find((c) => c.name === '主脚右');
  check(g1 && Math.abs(g1.position.y - 2.5) < 0.01, 'パーツの回転を「度」として読む',
    g1 ? `180°回した脚の先端 y=${g1.position.y.toFixed(2)}m` : '—');
}

// --- エンジンの向き（spinAxis）------------------------------------------------
{
  const cfg = defaultAircraftConfig();
  cfg.parts = cfg.parts.concat([{
    id: 'lift', type: 'engine', name: 'リフトエンジン',
    position: { x: 0, y: 1.05, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { thrustKgf: 500, spinAxis: 'y' },
  }]);
  const m2 = buildAircraftModel(cfg);
  const lift = m2.engines.find((e) => e.name === 'リフトエンジン');
  check(lift && lift.axis.y > 0.99, 'spinAxis=y のエンジンは上向きに押す',
    lift ? `軸=(${lift.axis.toArray().map((v) => v.toFixed(2)).join(',')})` : '—');
  const fwd = m2.engines.find((e) => e.spinAxis === 'z');
  check(fwd && fwd.axis.z < -0.99, 'spinAxis=z のエンジンは機首方向に押す');
}

// --- 機体が成立しているかの診断 -------------------------------------------------
{
  const a = analyzeAircraftPerformance(model);
  note('内蔵機の成立性', `翼面荷重${Math.round(a.wingLoading)}kg/m² / 失速${(a.stallMps * KT).toFixed(0)}kt`
    + ` / 離陸滑走${a.takeoffM ? Math.round(a.takeoffM) + 'm' : '不可'} / 静安定${a.staticMarginPct.toFixed(0)}%MAC`
    + ` / 引き起こし余力${a.rotateRatio.toFixed(2)}`);
  check(a.flyable, '内蔵機は「飛べる」と判定される', a.notes.map((n) => n.text).join(' / ') || '指摘なし');
  check(Math.abs(a.stallMps * KT - 58) < 10, '診断の失速速度が実測と合う',
    `診断${(a.stallMps * KT).toFixed(0)}kt / 実測58kt`);
  check(a.takeoffM && Math.abs(a.takeoffM - 287) < 120, '診断の滑走距離が実測と合う',
    `診断${Math.round(a.takeoffM)}m / 実測287m`);

  // 重すぎる機体はきちんと「飛べない」と言えること
  const heavy = defaultAircraftConfig();
  heavy.modelWeightKg = 90000;
  const ha = analyzeAircraftPerformance(buildAircraftModel(heavy));
  check(!ha.flyable && ha.notes.some((n) => n.level === 'error'), '飛べない機体は理由を挙げる',
    ha.notes.filter((n) => n.level === 'error').length + '件の指摘');
}

// --- 重心を動かしたときの効き ---------------------------------------------------
// 飛行画面から重心を前後上下に動かせるようにしてあるので、動かしたぶんが
// ちゃんと安定と接地に効くことを確かめる。
{
  const withCg = (dz, dy) => {
    const c = defaultAircraftConfig();
    c.cg = { x: c.cg.x, y: c.cg.y + dy, z: c.cg.z + dz };
    return buildAircraftModel(c);
  };
  const base = analyzeAircraftPerformance(withCg(0, 0));
  const fwd = analyzeAircraftPerformance(withCg(-1.0, 0));
  const aft = analyzeAircraftPerformance(withCg(1.0, 0));
  note('重心と静安定', `前へ1m ${fwd.staticMarginPct.toFixed(0)}%`
    + ` / 設計どおり ${base.staticMarginPct.toFixed(0)}%`
    + ` / 後ろへ1m ${aft.staticMarginPct.toFixed(0)}% MAC`);
  check(fwd.staticMarginPct > base.staticMarginPct, '重心を前へ出すと静安定が増える');
  check(aft.staticMarginPct < base.staticMarginPct, '重心を後ろへ下げると静安定が減る');

  // 上下に動かすと車輪までの距離が変わる（＝地面に置く高さが変わる）
  const up = withCg(0, 0.5), down = withCg(0, -0.5);
  check(Math.abs(up.gearHeight - (model.gearHeight + 0.5)) < 0.01,
    '重心を上げると車輪までの距離が伸びる', up.gearHeight.toFixed(2) + 'm');
  check(Math.abs(down.gearHeight - (model.gearHeight - 0.5)) < 0.01,
    '重心を下げると車輪までの距離が縮む', down.gearHeight.toFixed(2) + 'm');

  // 重心を後ろへ下げすぎた機体は不安定だと言えること
  const unstable = analyzeAircraftPerformance(withCg(3.0, 0));
  check(unstable.staticMarginPct < 0 && unstable.notes.some((n) => /不安定/.test(n.text)),
    '重心が後ろすぎる機体は不安定だと指摘する', unstable.staticMarginPct.toFixed(0) + '% MAC');
}

// --- 大気 -------------------------------------------------------------------
{
  check(Math.abs(airDensityAt(0) - 1.225) < 0.001, '海面の空気密度が1.225');
  const r5 = airDensityAt(5500);
  check(r5 > 0.6 && r5 < 0.72, '5,500mでおよそ半分の密度になる', r5.toFixed(3));
}

// --- 試験の道具 ---------------------------------------------------------------

// 指定の操作で回しながら、毎秒の様子を集める
function fly(seconds, setup, opts) {
  opts = opts || {};
  const state = opts.state || createFlightState();
  const controls = opts.controls || createFlightControls();
  if (!opts.state) placeAircraftOnGround(model, state, 0, 0, 0, flatGround);
  const ground = opts.ground || flatGround;
  const wind = opts.wind || noWind;
  const dt = 1 / 60;
  const log = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const t = i * dt;
    if (setup) setup(controls, state, t);
    advanceFlight(model, state, controls, wind, ground, dt);
    if (i % 60 === 0) log.push({ t, ...snapshot(state) });
    if (!isFinite(state.position.y) || !isFinite(state.velocity.x)) {
      return { state, controls, log, blewUp: true };
    }
  }
  log.push({ t: seconds, ...snapshot(state) });
  return { state, controls, log, blewUp: false };
}
function snapshot(s) {
  return {
    kt: s.airspeed * KT, altAgl: s.altitudeAglM, vs: s.verticalSpeed,
    pitch: s.pitchDeg, roll: s.rollDeg, hdg: s.headingDeg,
    alpha: s.alphaDeg, g: s.loadFactor, stall: s.stallRatio, onGround: s.onGround,
  };
}
function trace(name, log) {
  if (!TRACE) return;
  console.log('    ' + name);
  for (const r of log) {
    console.log(`      t=${r.t.toFixed(0).padStart(3)}s ${r.kt.toFixed(0).padStart(4)}kt`
      + ` ${r.altAgl.toFixed(0).padStart(6)}m VS${(r.vs * 196.85).toFixed(0).padStart(6)}fpm`
      + ` ピッチ${r.pitch.toFixed(1).padStart(6)}° ロール${r.roll.toFixed(1).padStart(7)}°`
      + ` 方位${r.hdg.toFixed(0).padStart(3)}° α${r.alpha.toFixed(1).padStart(5)}°`
      + ` ${r.g.toFixed(2)}G${r.onGround ? ' 接地' : ''}${r.stall > 0.1 ? ' 失速' : ''}`);
  }
}

// --- 駐機 -------------------------------------------------------------------
{
  const r = fly(10, (c) => { c.throttle = 0; c.parkingBrake = true; });
  const s = r.state;
  trace('駐機', r.log);
  check(!r.blewUp, '駐機で数値が壊れない');
  check(s.onGround, '駐機したまま地面にいる');
  check(Math.abs(s.groundSpeed) < 0.5, '勝手に動き出さない', s.groundSpeed.toFixed(3) + ' m/s');
  check(Math.abs(s.pitchDeg) < 3 && Math.abs(s.rollDeg) < 3, '地面で水平に落ち着く',
    `ピッチ${s.pitchDeg.toFixed(2)}° ロール${s.rollDeg.toFixed(2)}°`);
  const sink = model.gearHeight - (s.position.y - 0);
  check(Math.abs(sink) < 0.25, '脚の沈み込みが妥当', sink.toFixed(3) + 'm');
}

// --- 離陸 -------------------------------------------------------------------
let takeoffRun = null;
{
  // 全開にして滑走、55ktを超えたら機首上げ
  // 実機と同じく「姿勢を保つ」操縦をする。舵を固定して放っておくと長周期振動に乗るだけで、
  // 機体の上昇力ではなく振動の位相を測ることになってしまう。
  const holdPitch = (s, wantDeg) => THREE.MathUtils.clamp(
    (wantDeg - s.pitchDeg) * 0.06 - s.angularVelocity.x * 0.8, -1, 1);
  const r = fly(60, (c, s) => {
    c.parkingBrake = false;
    c.throttle = 1;
    c.brake = 0;
    if (s.airspeed * KT < 55 && s.onGround) c.pitch = 0;
    else if (s.altitudeAglM < 15) c.pitch = 0.45;
    else c.pitch = holdPitch(s, 8); // 上昇姿勢8°を保つ
  });
  trace('離陸', r.log);
  takeoffRun = r;
  const s = r.state;
  check(!r.blewUp, '離陸で数値が壊れない');
  // 60秒には滑走している時間も入る。高さそのものより上昇率のほうが機体の性能をよく表すので、
  // ここは「ちゃんと離れて上がっていく」ことだけを見て、速さは下の上昇率で見る。
  check(s.altitudeAglM > 100, '離陸して上昇できる', s.altitudeAglM.toFixed(0) + 'm');
  // 上昇率は「浮いてから」で測る。滑走している時間まで混ぜると機体の性能が見えない。
  const climbing = r.log.filter((x) => !x.onGround && x.altAgl > 20);
  const climbFpm = climbing.length >= 2
    ? ((climbing[climbing.length - 1].altAgl - climbing[0].altAgl)
       / (climbing[climbing.length - 1].t - climbing[0].t)) * 196.85 : 0;
  note('上昇率', `${climbFpm.toFixed(0)} fpm（浮いてから60秒までの平均）`);
  check(climbFpm > 300, '上昇率がそれらしい', climbFpm.toFixed(0) + ' fpm');
  check(!s.onGround, '地面を離れている');
  check(s.airspeed * KT > 55 && s.airspeed * KT < 160, '上昇中の速度がそれらしい', (s.airspeed * KT).toFixed(0) + 'kt');

  // 滑走距離：離陸するまでに何メートル使ったか
  let liftOffAt = null;
  const st2 = createFlightState();
  const c2 = createFlightControls();
  placeAircraftOnGround(model, st2, 0, 0, 0, flatGround);
  for (let i = 0; i < 60 * 60; i++) {
    c2.parkingBrake = false; c2.throttle = 1; c2.brake = 0;
    c2.pitch = st2.airspeed * KT > 55 ? 0.45 : 0;
    advanceFlight(model, st2, c2, noWind, flatGround, 1 / 60);
    if (!st2.onGround && liftOffAt === null) { liftOffAt = Math.hypot(st2.position.x, st2.position.z); break; }
  }
  note('離陸滑走', liftOffAt ? `${liftOffAt.toFixed(0)}m で浮く` : '浮かなかった');
  check(liftOffAt !== null && liftOffAt > 80 && liftOffAt < 900, '離陸滑走距離がそれらしい',
    liftOffAt ? liftOffAt.toFixed(0) + 'm' : '—');
}

// --- 超音速機のフルパワー離陸で墜落判定にならないか ------------------------------
//
// 12-flight-mode.js の墜落判定（FLIGHT_CRASH_G=12）は、以前は速度ベクトル全体の
// 変化量で見ていた。これだと推力そのものの加速度まで拾ってしまい、推力/重量比が
// 18倍を超える超音速機（実際にユーザーから来たサンダーバード1号）がフルパワーで
// 滑走を始めた瞬間、こけたわけでもないのに「墜落」になっていた。
// 直した先は state.loadFactor（機体の上下方向のG。HUDの「G」計器と同じ）で、
// これは推力の向き（ほぼ真後ろ）を拾わない。ここでは 12-flight-mode.js の
// 判定式そのものは読み込めない（ブラウザ側のファイルのため）ので、
// 判定に使っている loadFactor が、この状況で本当に閾値を超えないことを確かめる。
{
  const rocket = defaultAircraftConfig();
  rocket.name = '超音速機テスト';
  // 推力だけ極端に上げる（推力/重量18倍——実際の超音速機の報告値と同じくらい）
  for (const p of rocket.parts) {
    if (p.type === 'engine' && p.props) p.props.thrustKgf *= 60;
  }
  const rocketModel = buildAircraftModel(rocket);
  const tw = rocketModel.totalThrustN / (rocketModel.massKg * 9.80665);
  note('超音速機テスト', `推力/重量 ${tw.toFixed(1)}倍`);
  check(tw > 12, 'この機体は「速度ベクトル全体」で見れば12Gを軽く超える推力を持つ',
    tw.toFixed(1) + '倍');

  const st = createFlightState();
  const c = createFlightControls();
  placeAircraftOnGround(rocketModel, st, 0, 0, 0, flatGround);
  c.parkingBrake = false; c.throttle = 1;
  let maxLoadFactor = 0, maxOldMetric = 0;
  for (let i = 0; i < 60 * 3; i++) {
    const before = st.velocity.clone();
    advanceFlight(rocketModel, st, c, noWind, flatGround, 1 / 60);
    if (!st.onGround) break;
    maxLoadFactor = Math.max(maxLoadFactor, Math.abs(st.loadFactor));
    maxOldMetric = Math.max(maxOldMetric, before.sub(st.velocity).length() * 60 / 9.80665);
  }
  note('超音速機テスト', `フルパワー滑走中：loadFactor最大${maxLoadFactor.toFixed(1)}G`
    + `（旧判定なら${maxOldMetric.toFixed(1)}G）`);
  check(maxOldMetric > 12, '旧判定（速度ベクトル全体）なら実際に12Gを超えていた',
    maxOldMetric.toFixed(1) + 'G');
  check(maxLoadFactor < 12, '新判定（loadFactor）なら、ただ加速しているだけでは墜落にならない',
    maxLoadFactor.toFixed(1) + 'G');
}

// --- 手放しの安定 -------------------------------------------------------------
{
  // 上空で舵を中立にして放置。落ち着くのが正しい（発散したら安定していない）。
  const state = createFlightState();
  const controls = createFlightControls();
  state.position.set(0, 1000, 0);
  state.velocity.set(0, 0, -55);
  state.quaternion.identity();
  controls.parkingBrake = false;
  controls.throttle = 0.6;
  const r = fly(60, null, { state, controls });
  trace('手放し', r.log);
  const s = r.state;
  check(!r.blewUp, '手放しで数値が壊れない');
  check(Math.abs(s.rollDeg) < 25, '手放しでロールが発散しない', s.rollDeg.toFixed(1) + '°');
  check(Math.abs(s.pitchDeg) < 30, '手放しでピッチが発散しない', s.pitchDeg.toFixed(1) + '°');
  check(s.altitudeM > 300, '手放しで墜落しない', s.altitudeM.toFixed(0) + 'm');
  // ピッチの振れ幅が時間とともに小さくなっている＝短周期振動が減衰している
  const half = Math.floor(r.log.length / 2);
  const amp = (a) => Math.max(...a.map((x) => Math.abs(x.pitch))) - Math.min(...a.map((x) => Math.abs(x.pitch)));
  check(amp(r.log.slice(half)) <= amp(r.log.slice(0, half)) + 2, 'ピッチの揺れが収まっていく',
    `前半${amp(r.log.slice(0, half)).toFixed(1)}° → 後半${amp(r.log.slice(half)).toFixed(1)}°`);
}

// --- 失速と回復 ---------------------------------------------------------------
//
// 失速速度は「水平飛行を保ったまま減速していって、支えきれなくなる速度」で測る。
// 引き起こしっぱなしにすると上昇の頂点で0.3Gほどになり、そのぶん失速速度も
// 見かけ上さがってしまう（Gの平方根で効く）。それは機体の性能ではない。
function stallSpeedLevel(flap) {
  const st = createFlightState();
  const c = createFlightControls();
  st.position.set(0, 2500, 0);
  st.velocity.set(0, 0, -60);
  c.parkingBrake = false;
  c.flap = flap;
  // 比例だけの操縦だと、下がりながら釣り合う位置で落ち着いてしまって減速しきらない。
  // 実際の失速確認と同じく、高度を保てるまで引き続ける（積分を入れる）。
  let stalledKt = null;
  let trim = 0;
  for (let i = 0; i < 60 * 240; i++) {
    c.throttle = 0.05;
    // ゆっくり引く。急に引くと引き起こしのGで失速が早まり、機体の性能ではなく
    // 操作の荒さを測ることになる（実際の失速確認も毎秒1ktずつ落とす）。
    trim = THREE.MathUtils.clamp(trim + (0 - st.verticalSpeed) * 0.0006, -1, 1);
    c.pitch = THREE.MathUtils.clamp(trim - st.angularVelocity.x * 0.6, -1, 1);
    advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
    if (st.stallRatio > 0.5 && st.loadFactor > 0.85 && st.loadFactor < 1.2) {
      stalledKt = st.airspeed * KT; break;
    }
    if (st.altitudeM < 1200) break;
  }
  return stalledKt;
}

{
  const clean = stallSpeedLevel(0);
  note('失速速度（1G・フラップ無し）', clean ? clean.toFixed(0) + 'kt' : '失速しなかった');
  check(clean !== null, '水平飛行から減速すると失速する');
  check(clean !== null && clean > 35 && clean < 75, '失速速度がそれらしい', clean ? clean.toFixed(0) + 'kt' : '—');

  // 失速に入れてから、機首を下げて出力を入れれば回復できること
  const state = createFlightState();
  const controls = createFlightControls();
  state.position.set(0, 1500, 0);
  state.velocity.set(0, 0, -55);
  controls.parkingBrake = false;
  let stalled = false;
  const r = fly(25, (c, s) => {
    c.throttle = 0; c.pitch = 1;
    if (s.stallRatio > 0.5) stalled = true;
  }, { state, controls });
  trace('失速', r.log);
  check(!r.blewUp, '失速で数値が壊れない');
  check(stalled, '全力で引き続けると失速する');

  const r2 = fly(30, (c) => { c.throttle = 1; c.pitch = -0.15; }, { state: r.state, controls: r.controls });
  trace('失速からの回復', r2.log);
  check(r2.state.stallRatio < 0.2, '機首を下げれば失速から回復する', r2.state.stallRatio.toFixed(2));
  check(r2.state.airspeed * KT > 60, '回復後に速度が戻る', (r2.state.airspeed * KT).toFixed(0) + 'kt');
}

// --- 旋回 -------------------------------------------------------------------
{
  const state = createFlightState();
  const controls = createFlightControls();
  state.position.set(0, 1200, 0);
  state.velocity.set(0, 0, -60);
  controls.parkingBrake = false;

  const hdg0 = 0;
  const r = fly(40, (c, s) => {
    c.throttle = 0.75;
    // 30°バンクを保ち、そのぶん引く
    const want = 30;
    c.roll = THREE.MathUtils.clamp((want - s.rollDeg) * 0.05, -1, 1);
    c.pitch = THREE.MathUtils.clamp(0.12 + (0 - s.verticalSpeed) * 0.02, -0.6, 0.8);
  }, { state, controls });
  trace('旋回', r.log);
  const s = r.state;
  check(!r.blewUp, '旋回で数値が壊れない');
  check(Math.abs(s.rollDeg - 30) < 12, 'バンクを保てる', s.rollDeg.toFixed(1) + '°');
  const turned = ((s.headingDeg - hdg0) % 360 + 360) % 360;
  check(turned > 30, 'バンクすると旋回する', `方位が${turned.toFixed(0)}°変わった`);
  check(Math.abs(s.altitudeM - 1200) < 400, '旋回で高度をおおむね保てる', s.altitudeM.toFixed(0) + 'm');
  // 30°バンクの定常旋回は約1.15G
  check(s.loadFactor > 0.9 && s.loadFactor < 1.6, '旋回中のGがそれらしい', s.loadFactor.toFixed(2) + 'G');
}

// --- 風の影響 ---------------------------------------------------------------
{
  // 向かい風のほうが早く浮く（対気速度が先に立つため）
  const runTo = (wind) => {
    const st = createFlightState();
    const c = createFlightControls();
    placeAircraftOnGround(model, st, 0, 0, 0, flatGround);
    for (let i = 0; i < 60 * 60; i++) {
      c.parkingBrake = false; c.throttle = 1; c.brake = 0;
      c.pitch = st.airspeed * KT > 55 ? 0.45 : 0;
      advanceFlight(model, st, c, wind, flatGround, 1 / 60);
      if (!st.onGround) return Math.hypot(st.position.x, st.position.z);
    }
    return null;
  };
  // 機首は-Z（北）。向かい風は+Z方向へ吹く風。
  const head = runTo(new THREE.Vector3(0, 0, 8));
  const calm = runTo(noWind);
  note('滑走距離', `無風${calm ? calm.toFixed(0) : '—'}m / 向かい風16kt ${head ? head.toFixed(0) : '—'}m`);
  check(head !== null && calm !== null && head < calm, '向かい風のほうが短い滑走で浮く');
}

// --- 着陸 -------------------------------------------------------------------
{
  // 進入して接地し、ブレーキで止まれること
  const state = createFlightState();
  const controls = createFlightControls();
  state.position.set(0, 120, 900);
  state.velocity.set(0, -3, -32);
  controls.parkingBrake = false;
  controls.gearDown = true;
  controls.flap = 1;

  let touched = false, touchVs = 0;
  const r = fly(90, (c, s) => {
    c.throttle = s.altitudeAglM > 15 ? 0.25 : 0;
    // 降下率を-2.5m/sあたりに保ち、接地直前に引き起こす
    const wantVs = s.altitudeAglM > 12 ? -2.5 : -0.5;
    c.pitch = THREE.MathUtils.clamp((wantVs - s.verticalSpeed) * 0.10, -0.5, 0.9);
    if (s.onGround) {
      if (!touched) { touched = true; touchVs = s.verticalSpeed; }
      c.pitch = 0.1; c.brake = 1; c.throttle = 0;
    }
  }, { state, controls });
  trace('着陸', r.log);
  const s = r.state;
  check(!r.blewUp, '着陸で数値が壊れない');
  check(touched, '接地できる');
  note('接地時の降下率', `${(touchVs * 196.85).toFixed(0)} fpm`);
  check(s.onGround && s.groundSpeed < 3, 'ブレーキで止まれる', s.groundSpeed.toFixed(2) + ' m/s');
  check(Math.abs(s.rollDeg) < 12, '着陸後に横転していない', s.rollDeg.toFixed(1) + '°');
}

// --- フラップ -----------------------------------------------------------------
{
  const clean = stallSpeedLevel(0), full = stallSpeedLevel(1);
  note('失速速度', `フラップ無し${clean ? clean.toFixed(0) : '—'}kt / 全開${full ? full.toFixed(0) : '—'}kt`);
  check(clean !== null && full !== null && full < clean - 1, 'フラップを下ろすと失速速度が下がる',
    `${clean ? clean.toFixed(0) : '—'}kt → ${full ? full.toFixed(0) : '—'}kt`);
}

// --- 垂直離陸 -----------------------------------------------------------------
// 上を向いたエンジンは前へ進むエンジンとは別のレバーで出す。同じレバーにすると、
// 浮かせようとしただけで前へ走り出してしまい、ホバリングも垂直着陸もできない。
{
  const cfg = defaultAircraftConfig();
  cfg.parts = cfg.parts.concat([{
    id: 'e_lift', type: 'engine', name: '垂直離陸用',
    position: { x: 0, y: 1.05, z: -0.35 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { thrustKgf: 1500, spinAxis: 'y' },
  }]);
  const vm = buildAircraftModel(cfg);
  check(vm.hasVtol, '上を向いたエンジンを垂直離陸用として見分ける');
  check(Math.round(vm.totalThrustN / 9.80665) === 380 && Math.round(vm.vtolThrustN / 9.80665) === 1500,
    '前へ進む推力と持ち上げる推力を分けて数える',
    `前${(vm.totalThrustN / 9.80665).toFixed(0)}kgf / 上${(vm.vtolThrustN / 9.80665).toFixed(0)}kgf`);

  const run = (drive, secs) => {
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(vm, st, 0, 0, 0, flatGround);
    c.parkingBrake = false;
    let peakTilt = 0;
    for (let i = 0; i < 60 * secs; i++) {
      drive(c, st, i / 60);
      advanceFlight(vm, st, c, noWind, flatGround, 1 / 60);
      if (st.altitudeAglM > 3) peakTilt = Math.max(peakTilt, Math.abs(st.pitchDeg), Math.abs(st.rollDeg));
    }
    return { st, peakTilt };
  };

  // レバーの取り違えが無いこと
  const fwdOnly = run((c) => { c.throttle = 1; c.vtolThrottle = 0; }, 1).st;
  check(fwdOnly.thrustN > 0 && fwdOnly.vtolThrustN === 0, '出力を上げても垂直エンジンは動かない');
  const upOnly = run((c) => { c.throttle = 0; c.vtolThrottle = 1; }, 1).st;
  check(upOnly.thrustN === 0 && upOnly.vtolThrustN > 0, '垂直レバーを上げても前へは押さない');

  // ホバリング。舵は触らず、高度30mを保つ操作だけをする。
  const hov = run((c, s) => {
    c.vtolThrottle = Math.max(0, Math.min(1, 0.72 + (30 - s.altitudeAglM) * 0.02 - s.velocity.y * 0.05));
  }, 30);
  check(Math.abs(hov.st.altitudeAglM - 30) < 6, '垂直エンジンだけでホバリングできる',
    hov.st.altitudeAglM.toFixed(1) + 'm');
  check(hov.peakTilt < 45, 'ホバリング中に引っくり返らない', peakLabel(hov.peakTilt));
  check(Math.abs(hov.st.pitchDeg) < 6 && Math.abs(hov.st.rollDeg) < 6,
    '舵から手を離すと水平に戻る',
    `ピッチ${hov.st.pitchDeg.toFixed(1)}° ロール${hov.st.rollDeg.toFixed(1)}°`);

  // 垂直で浮いてから、前のエンジンへ渡して普通の飛行へ移る
  const tr = run((c, s) => {
    c.vtolThrottle = s.altitudeAglM < 40 ? 0.85 : Math.max(0, 1 - s.airspeed / 45);
    c.throttle = s.altitudeAglM > 35 ? 1 : 0;
    c.pitch = Math.max(-1, Math.min(1, (3 - s.pitchDeg) * 0.05 - s.angularVelocity.x * 0.6));
  }, 50);
  note('垂直離陸から巡航へ', `${(tr.st.airspeed * KT).toFixed(0)}kt / 高度${tr.st.altitudeAglM.toFixed(0)}m`);
  check(tr.st.airspeed * KT > 80 && !tr.st.onGround && tr.st.altitudeAglM > 20,
    '垂直で浮いてから通常の飛行へ移れる',
    `${(tr.st.airspeed * KT).toFixed(0)}kt 高度${tr.st.altitudeAglM.toFixed(0)}m`);
}
function peakLabel(v) { return `最大 ${v.toFixed(0)}°`; }

// --- 垂直上昇できる速さの限界 ---------------------------------------------------
// 前後・左右の位置と推力が完璧に釣り合っていても、上がる速さそのものが
// 姿勢制御ノズルの手に負えないほど速ければ機体は回る。水平飛行のために向いている
// 水平尾翼が真上からの風を受けると、面積と腕の長さがそのまま桁違いの
// 抗力モーメントになり、ノズルでは追いつけなくなる——位置や推力の釣り合いとは別の限界。
{
  // 水平尾翼を大きく・後ろへ伸ばした機体（垂直上昇に弱いはず）
  const heavy = defaultAircraftConfig();
  for (const p of heavy.parts) {
    if (p.type === 'wing' && p.props.role === 'htail') {
      p.position.z += 2;
      for (const k in p.props.corners) p.props.corners[k].x *= 2;
    }
  }
  heavy.parts = heavy.parts.concat([{
    id: 'e_lift', type: 'engine', name: '垂直離陸用',
    position: { x: 0, y: 1.05, z: -0.35 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { thrustKgf: 1500, spinAxis: 'y' },
  }]);
  const hm = buildAircraftModel(heavy);
  const heavyLimit = vtolClimbSpeedLimit(hm);
  note('尾翼を大きくした機体の上昇速度限界', heavyLimit === null ? '制限なし' : `${heavyLimit.toFixed(1)} m/s`);
  check(heavyLimit !== null && heavyLimit < 20,
    '尾翼が大きく後ろにある機体は、上昇速度の限界が低く出る', `${heavyLimit.toFixed(1)} m/s`);

  // 内蔵機（尾翼が小さい）は同じ推力でも限界がずっと高いか、そもそも掛からない
  const lightCfg = defaultAircraftConfig();
  lightCfg.parts = lightCfg.parts.concat([{
    id: 'e_lift', type: 'engine', name: '垂直離陸用',
    position: { x: 0, y: 1.05, z: -0.35 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { thrustKgf: 1500, spinAxis: 'y' },
  }]);
  const lightLimit = vtolClimbSpeedLimit(buildAircraftModel(lightCfg));
  check(lightLimit === null || lightLimit > heavyLimit,
    '尾翼が小さければ限界はもっと高いか、そもそも掛からない',
    `${lightLimit === null ? '制限なし' : lightLimit.toFixed(1) + ' m/s'} > ${heavyLimit.toFixed(1)} m/s`);

  const hoverThr = (hm.massKg * 9.80665) / hm.vtolThrustN;
  const climb = (drive, secs) => {
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(hm, st, 0, 0, 0, flatGround);
    c.parkingBrake = false;
    let peakTilt = 0;
    for (let i = 0; i < 60 * secs; i++) {
      drive(c, st, i / 60);
      advanceFlight(hm, st, c, noWind, flatGround, 1 / 60);
      if (st.altitudeAglM > 2) peakTilt = Math.max(peakTilt, Math.abs(st.pitchDeg), Math.abs(st.rollDeg));
    }
    return peakTilt;
  };
  // 限界よりずっと遅い上昇率に抑えれば姿勢を保てる
  const slowTilt = climb((c, s) => {
    c.vtolThrottle = Math.max(0, Math.min(1, hoverThr + 0.06 - s.velocity.y * 0.02));
  }, 20);
  check(slowTilt < 15, '限界より十分遅く上昇すれば姿勢を保てる', peakLabel(slowTilt));
  // 全開にすると、診断が示す限界をすぐ超えて姿勢を崩す
  const fullTilt = climb((c) => { c.vtolThrottle = 1; }, 8);
  check(fullTilt > 30, '全開で上昇すると診断どおり姿勢を崩す', peakLabel(fullTilt));
}

// --- 垂直離陸中は姿勢制御ノズルが総速度でなく前進速度でフェードする -------------------
// まっすぐ上へ加速しているだけの機体（前向きの速度は0）を「総速度」で判定すると、
// 一瞬で基準を超えてノズルを失う。姿勢が水平のままなら、どれだけ速く上がっても
// ノズルは効き続けるべき。
{
  const cfg = defaultAircraftConfig();
  cfg.parts = cfg.parts.concat([{
    id: 'e_lift', type: 'engine', name: '垂直離陸用',
    position: { x: 0, y: 1.05, z: -0.35 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { thrustKgf: 1500, spinAxis: 'y' },
  }]);
  const vm2 = buildAircraftModel(cfg);
  const st = createFlightState();
  st.position.y = 500; st.altitudeM = 500;
  st.quaternion.identity();
  st.velocity.set(0, 90, 0); // 姿勢は水平のまま、真上へ90m/s
  const c = createFlightControls();
  c.vtolThrottle = 1;
  const acc = { force: new THREE.Vector3(), torque: new THREE.Vector3() };
  accumulateAeroForces(vm2, st, c, noWind, acc);
  check(Math.abs(st.forwardAirspeed) < 1 && st.airspeed > 80,
    '姿勢が水平なら、真上へどれだけ速く上がっても前進速度は0のまま',
    `前進速度${st.forwardAirspeed.toFixed(1)}m/s / 総速度${st.airspeed.toFixed(1)}m/s`);
}

// --- 垂直離陸エンジンの前後バランス ---------------------------------------------
// 前後に離れた位置へ置いた垂直離陸用エンジンは、それだけで機首を振る力になる。
// ぴったり重心に合わせなくても、自動で出力配分を釣り合わせて飛べることを確かめる。
{
  const cfg = JSON.parse(JSON.stringify(defaultAircraftConfig()));
  cfg.cg = { x: 0, y: 1.05, z: 0 }; // 数字をきれいにするため、この試験だけ重心を原点に
  cfg.parts = cfg.parts.concat([
    {
      id: 'e_front', type: 'engine', name: '前', position: { x: 0, y: 1.05, z: -10 },
      rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, props: { thrustKgf: 100, spinAxis: 'y' },
    },
    {
      id: 'e_rear', type: 'engine', name: '後', position: { x: 0, y: 1.05, z: 20 },
      rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, props: { thrustKgf: 100, spinAxis: 'y' },
    },
  ]);
  const vm = buildAircraftModel(cfg);
  const front = vm.engines.find((e) => e.name === '前');
  const rear = vm.engines.find((e) => e.name === '後');
  // 重心までの腕は前10・後20で2倍。弱いほう（前）を基準に、強いほう（後）を半分に絞れば釣り合う。
  check(Math.abs(front.trimScale - 1) < 0.01, '腕の短いほうは絞らない', front.trimScale.toFixed(3));
  check(Math.abs(rear.trimScale - 0.5) < 0.01, '腕の長いほうを腕の比ぶんだけ絞る', rear.trimScale.toFixed(3));
  check(Math.abs(vm.vtolThrustN / vm.vtolThrustNRaw - 0.75) < 0.01,
    '使える推力の合計は定格の75%になる', (vm.vtolThrustN / vm.vtolThrustNRaw * 100).toFixed(1) + '%');

  // 実際に飛ばしても、位置をぴったり合わせていないぶんで機首を振り続けたりしない
  const st = createFlightState(), c = createFlightControls();
  placeAircraftOnGround(vm, st, 0, 0, 0, flatGround);
  c.parkingBrake = false;
  const hoverThr = (vm.massKg * 9.80665) / vm.vtolThrustN;
  let peakTilt = 0;
  for (let i = 0; i < 60 * 40; i++) {
    c.vtolThrottle = Math.max(0, Math.min(1,
      hoverThr + (20 - st.altitudeAglM) * 0.02 - st.velocity.y * 0.05));
    advanceFlight(vm, st, c, noWind, flatGround, 1 / 60);
    if (st.altitudeAglM > 2) peakTilt = Math.max(peakTilt, Math.abs(st.pitchDeg), Math.abs(st.rollDeg));
  }
  check(peakTilt < 45, '前後の位置がずれていても引っくり返らずにホバリングできる', peakLabel(peakTilt));
  check(Math.abs(st.pitchDeg) < 6 && Math.abs(st.rollDeg) < 6, '最終的に水平で落ち着く',
    `ピッチ${st.pitchDeg.toFixed(1)}° ロール${st.rollDeg.toFixed(1)}°`);
}

// --- 機体まるごとの向き・大きさ（modelTransform）---------------------------------
// Builderでは GLBのメッシュもパーツも同じ root の子なので、機体全体を回すと両方が回る。
// 飛行側もそう扱わないと「物理は反転しているのに見た目は元のまま」になる。
{
  const base = buildAircraftModel(defaultAircraftConfig());

  // 180°回した機体は、**飛ばしたときの姿は変わらない**（向きの正規化が吸収する）
  const spun = defaultAircraftConfig();
  spun.modelTransform = { rotation: { x: 0, y: Math.PI, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  const sm = buildAircraftModel(spun);
  const sameContacts = base.contacts.every((c, i) =>
    c.position.distanceTo(sm.contacts[i].position) < 1e-6);
  check(sameContacts, '機体を180°回しても接地点は同じ場所に来る',
    sm.contacts.map((c) => `z${c.position.z.toFixed(2)}`).join(' '));
  check(Math.abs(sm.wingArea - base.wingArea) < 1e-6, '機体を180°回しても翼面積は変わらない');
  const sf = sm.surfaces.find((s) => s.role === 'main').fwd;
  check(sf.z < -0.9, '機体を180°回しても主翼の前方は機首(-Z)を向く',
    `fwd=(${sf.toArray().map((v) => v.toFixed(2)).join(',')})`);
  // エンジンの spinAxis に modelTransform の回転そのものは掛けない（掛けるのは
  // qFix だけ）。理由は下の「前後逆さに作られたモデル」の節で確かめる——
  // spinAxis は常にBuilderの画面に映っている向きを指す約束で、その画面は
  // 常に modelTransform を適用したあとの見た目だから。

  // エンジン自身の回転（Builderで傾けて取り付けた場合）も推力の向きに乗ること
  const tilted = defaultAircraftConfig();
  tilted.parts.find((p) => p.type === 'engine').rotation = { x: 10, y: 0, z: 0 };
  const tm = buildAircraftModel(tilted);
  const tiltDeg = Math.acos(THREE.MathUtils.clamp(-tm.engines[0].axis.z, -1, 1)) * 180 / Math.PI;
  check(Math.abs(tiltDeg - 10) < 0.5, 'エンジンを傾けて取り付ければ、推力もその向きへ出る',
    tiltDeg.toFixed(1) + '°');

  // 180°回した機体では、向きの補正（qFix）がそのぶん打ち消される。
  // 見た目には modelTransform と qFix の両方がかかるので、ここが噛み合っていないと食い違う。
  const spunYaw = new THREE.Euler().setFromQuaternion(sm.qFix, 'YXZ').y;
  const baseYaw = new THREE.Euler().setFromQuaternion(base.qFix, 'YXZ').y;
  check(Math.abs(Math.abs(spunYaw - baseYaw) - Math.PI) < 1e-6,
    '機体を回したぶんだけ向きの補正が打ち消される',
    `${(baseYaw * 180 / Math.PI).toFixed(0)}° → ${(spunYaw * 180 / Math.PI).toFixed(0)}°`);

  // 大きさも root にかかっている。2倍にすれば翼幅は2倍・面積は4倍。
  const big = defaultAircraftConfig();
  big.modelTransform = { rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } };
  const bm = buildAircraftModel(big);
  check(Math.abs(bm.wingSpan / base.wingSpan - 2) < 0.01, '2倍に拡大すると翼幅も2倍',
    `${base.wingSpan.toFixed(1)}m → ${bm.wingSpan.toFixed(1)}m`);
  check(Math.abs(bm.wingArea / base.wingArea - 4) < 0.02, '2倍に拡大すると翼面積は4倍',
    `${base.wingArea.toFixed(1)}m² → ${bm.wingArea.toFixed(1)}m²`);
}

// --- 前後逆さに作られたモデルを modelTransform で直した機体 ----------------------
//
// 実際にユーザーから「モデルが前後逆だから反転してるんだけど、フライトでは
// 元の向きのまま出てきちゃう」という報告があり、パーツの位置は直したが
// （54abce9）、エンジンの推力の向きは直っていなかった——180°反転した機体で
// 主翼は正しく機首(-Z)を向くのに、エンジンの推力だけ後ろ向きのままで、
// 前へ進むはずが後ろへ進む機体になっていた。ここでは「翼もエンジンも
// 生の座標では後ろ向きに作られていて、modelTransformで直す」という
// **実際にBuilderで起きる順番**を再現する（座標だけ後から動かす前の節とは違う）。
{
  const wing = (side, sign) => ({
    id: 'w_' + side, type: 'wing', name: '主翼', position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: {
      span: 5, role: 'main', side,
      // 生の座標では前縁が+Z（後ろ向き＝逆さ）。実際の反転モデルと同じ形。
      corners: {
        rootLeading: { x: 0, y: 0, z: 3 }, rootTrailing: { x: 0, y: 0, z: -1 },
        tipLeading: { x: sign * 4, y: 0, z: 2.5 }, tipTrailing: { x: sign * 4, y: 0, z: -0.5 },
      },
    },
  });
  const engine = (id, x) => ({
    id, type: 'engine', name: 'エンジン', position: { x, y: -0.3, z: 2 },
    rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { thrustKgf: 2000, spinAxis: 'z' },
  });
  const backward = {
    name: '反転モデルテスト機', modelWeightKg: 8000, modelMaxSpeedValue: 300, modelMaxSpeedUnit: 'kt',
    cg: { x: 0, y: 0, z: 1 },
    // 生の座標のまま（modelTransformなし）だと機首は逆(+Z)を向く
    parts: [wing('right', 1), wing('left', -1), engine('e1', -1.5), engine('e2', 1.5)],
  };
  // qFix は主翼の向きから毎回自動で決まるので、翼自身の「機首方向」（surf.fwd）は
  // modelTransformが無くても常に-Zに正規化される——それがqFixの仕事そのもの。
  // なのでここで確かめられるのは「主翼が-Zを自称している」ことではなく、
  // qFixが実際に大きく効いていること（＝生の座標では前後が逆だったこと）。
  const raw = buildAircraftModel(backward);
  const rawYaw = Math.abs(new THREE.Euler().setFromQuaternion(raw.qFix, 'YXZ').y);
  check(rawYaw > Math.PI * 0.9,
    '直す前：qFixがほぼ180°効いている（生の座標では前後が逆さ、の再現）',
    (rawYaw * 180 / Math.PI).toFixed(0) + '°');

  // Builderの「機体全体の向き」でユーザーが180°直す
  const fixed = Object.assign({}, backward, {
    modelTransform: { rotation: { x: 0, y: Math.PI, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  });
  const fm = buildAircraftModel(fixed);
  check(fm.surfaces.find((s) => s.role === 'main').fwd.z < -0.9,
    'modelTransformで直したあと：主翼は機首(-Z)を向く');
  check(fm.engines[0].axis.z < -0.9,
    'modelTransformで直したあと：エンジンの推力も機首(-Z)向きになる（翼と食い違わない）',
    `axis=(${fm.engines[0].axis.toArray().map((v) => v.toFixed(2)).join(',')})`);

  // 実際に地上でフルパワーにして、前へ進むことを確かめる（うしろへ進まない）
  const st = createFlightState(), c = createFlightControls();
  placeAircraftOnGround(fm, st, 0, 0, 0, flatGround);
  c.parkingBrake = false; c.throttle = 1;
  for (let i = 0; i < 60 * 2; i++) advanceFlight(fm, st, c, noWind, flatGround, 1 / 60);
  check(st.velocity.z < -1, '直した機体はフルパワーで前(-Z)へ進む（後ろへ進まない）',
    'velocity.z=' + st.velocity.z.toFixed(1));

  // --- Builder側のエンジン系ツール（05e/05f）も、この機体で同じように正しく判定できるか ---
  //
  // 実際にユーザーから「Boeing 747の推力調整ボタンが、エンジンの向きが変って
  // いって推力を変えられない」という報告があった。09-aircraft.js（実際の飛行
  // モデル）は上のテストの通りmodelTransformを正しく扱えているが、Builder側の
  // 05e/05f（pbNoseDirection経由でqFixを作る）は modelTransform を掛けずに
  // 「生の座標での前」を返していた。エンジンの spinAxis は「Builderの画面に
  // 見えている向き」（＝modelTransform適用後の見た目）を指す約束なので、これに
  // 合わせるqFixも modelTransform適用後の翼から作らないと、前向きエンジンが
  // 「前を向いていない」と誤判定される——実際、推力調整ボタンが「エンジンが
  // 前向きを向いていません」と断り続け、推力を変えられなくなっていた。
  {
    const toasts = [];
    const ectx = vm.createContext({
      THREE, console, Math, Number, Array, Object, JSON,
      WING_CORNER_KEYS: ['rootLeading', 'rootTrailing', 'tipLeading', 'tipTrailing'],
      State: null, showToast: (m, e) => toasts.push({ msg: m, error: !!e }),
      renderPartList: () => {}, renderInspector: () => {}, renderModelSettingsPanel: () => {},
      applyCgToGizmo: () => {}, applyPartToGizmo: () => {}, updateInspectorNumbersOnly: () => {},
    });
    for (const f of ['05b-cg-system.js', '05d-vtol-balance.js', '05e-pitch-balance.js', '05f-engine-power.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
      vm.runInContext(src, ectx, { filename: f });
    }
    ectx.State = {
      parts: JSON.parse(JSON.stringify(fixed.parts)),
      cg: { position: { ...fixed.cg }, gizmo: { position: new THREE.Vector3() } },
      model: {
        weightKg: fixed.modelWeightKg, maxSpeedValue: fixed.modelMaxSpeedValue, maxSpeedUnit: fixed.modelMaxSpeedUnit,
        root: { rotation: new THREE.Euler(0, Math.PI, 0), scale: new THREE.Vector3(1, 1, 1) },
      },
    };

    const rawNose = ectx.pbNoseDirection();
    const worldNose = ectx.pbNoseDirection(true);
    check(rawNose.z > 0.9, '生の座標だけ見ると「前」は+Z（機体は逆さに作られている）',
      `(${rawNose.toArray().map((v) => v.toFixed(2)).join(',')})`);
    check(worldNose.z < -0.9, 'modelTransform込みで見ると「前」は正しく-Z',
      `(${worldNose.toArray().map((v) => v.toFixed(2)).join(',')})`);

    const rep = ectx.epSpeedThrustReport();
    check(rep.engines.every((e) => e.fwd > 0.9),
      'エンジン出力の自動設定：この機体でも、前向きエンジンをちゃんと前向きと判定できる',
      rep.engines.map((e) => e.fwd.toFixed(2)).join('/'));

    toasts.length = 0;
    const thrustBefore = ectx.State.parts.filter((p) => p.type === 'engine').map((p) => p.props.thrustKgf);
    check(ectx.applyEngineSpeedTarget() === true,
      'エンジン出力の自動設定：「前向きエンジンが無い」と誤って断らず、推力を変更できる');
    const thrustAfter = ectx.State.parts.filter((p) => p.type === 'engine').map((p) => p.props.thrustKgf);
    check(thrustAfter.every((t, i) => t !== thrustBefore[i]),
      '実際に推力の値が変わっている（同じ値のまま=何もしていない、ではない）',
      `${thrustBefore.join(',')} → ${thrustAfter.join(',')}`);

    // 空力バランスを整えるほうも、エンジンのモーメント判定に同じqFixの取り違えがあった。
    // 直前でエンジン出力の自動設定が推力を大きく変えているので、独立に確かめるため
    // 機体を作り直す（さもないと、推力が増えたぶんモーメントも増えて、
    // ティルトの上限（PB_ENGINE_TILT_MAX_DEG=20°）内で打ち消しきれず、
    // 「qFixが正しいか」とは無関係な理由で失敗する）。
    ectx.State = {
      parts: JSON.parse(JSON.stringify(fixed.parts)),
      cg: { position: { ...fixed.cg }, gizmo: { position: new THREE.Vector3() } },
      model: {
        weightKg: fixed.modelWeightKg, maxSpeedValue: fixed.modelMaxSpeedValue, maxSpeedUnit: fixed.modelMaxSpeedUnit,
        root: { rotation: new THREE.Euler(0, Math.PI, 0), scale: new THREE.Vector3(1, 1, 1) },
      },
    };
    const beforeReport = ectx.pbBalanceReport();
    toasts.length = 0;
    check(ectx.balancePitchTrim() === true, '空力バランスを整える：この機体でも実行できる');
    const afterReport = ectx.pbBalanceReport();
    // このエンジン配置は推力に対して腕が短く、ティルトの上限（20°）だけでは
    // 完全には打ち消しきれない（momentOkの基準では足りない）——それ自体は
    // このテスト機の形状の問題であって、qFixの向きが正しいかどうかとは別の話。
    // ここで確かめたいのは「正しい向きへ（＝モーメントが減る向きに）ティルトが
    // 効いているか」——qFixが180°ずれていれば、逆向きに効いてモーメントは
    // 減らずむしろ増える。
    check(Math.abs(afterReport.thrustPitchMoment) < Math.abs(beforeReport.thrustPitchMoment) * 0.8,
      '空力バランスを整える：エンジンのティルトが正しい向きに効いて、モーメントが減っている',
      `${beforeReport.thrustPitchMoment.toFixed(0)} → ${afterReport.thrustPitchMoment.toFixed(0)} N·m`);
  }
}

// --- 車輪の並び ---------------------------------------------------------------
// 重心を前後で挟んでいないと、置いただけで倒れる
{
  // 機首が-Zなので、dzを負にすると車輪は前へ、正にすると後ろへ動く
  const tip = (dz) => {
    const cfg = defaultAircraftConfig();
    cfg.parts = cfg.parts.map((p) => (p.type === 'landing_gear'
      ? Object.assign({}, p, { position: { x: p.position.x, y: p.position.y, z: p.position.z + dz } })
      : p));
    return analyzeAircraftPerformance(buildAircraftModel(cfg)).notes
      .filter((n) => /車輪がすべて重心より/.test(n.text));
  };
  check(tip(0).length === 0, '素直な脚の並びには何も言わない');
  check(tip(-8).some((n) => n.level === 'error' && /すべて重心より前/.test(n.text)),
    '車輪が全部重心より前なら止める（尻もち）', (tip(-8)[0] || {}).text || '—');
  check(tip(8).some((n) => n.level === 'error' && /すべて重心より後ろ/.test(n.text)),
    '車輪が全部重心より後ろなら止める（前のめり）', (tip(8)[0] || {}).text || '—');

  // ミラーしたつもりでX位置が反転していない脚
  const lop = defaultAircraftConfig();
  lop.parts = lop.parts.map((p) => (p.type === 'landing_gear' && p.position.x < -0.1
    ? Object.assign({}, p, { position: { x: -p.position.x, y: p.position.y, z: p.position.z } })
    : p));
  const lopNotes = analyzeAircraftPerformance(buildAircraftModel(lop)).notes;
  check(lopNotes.some((n) => /片側にしか/.test(n.text)), '車輪が片側に寄っていたら止める',
    (lopNotes.find((n) => /片側にしか/.test(n.text)) || {}).text || '—');
}

// --- トリム -------------------------------------------------------------------
// 尾翼が大きい機体ほど迎角が0°付近に張り付き、手を離すと高度と速度を交換しながら
// うねり続ける。実機と同じで、これはトリム（舵の中立位置）で解く。
{
  const perf = analyzeAircraftPerformance(model);
  const alt = 1500;
  const v = perf.liftoffMps * 1.25;
  const sol = solveLevelTrim(model, v, alt);
  note('内蔵機のトリム', `${sol.trim >= 0 ? '+' : ''}${(sol.trim * 100).toFixed(0)}%`
    + ` / 迎角 ${sol.alphaDeg.toFixed(1)}° / スロットル ${(sol.throttle * 100).toFixed(0)}%`);
  check(sol.ok, '水平飛行のトリムが解ける');
  check(sol.trim > 0 && sol.trim < 1, 'トリムは機首上げ側の途中に収まる', sol.trim.toFixed(3));

  // トリムを当てて舵から手を離す。高度を保てるのが目的。
  const st = createFlightState(), c = createFlightControls();
  placeAircraftOnGround(model, st, 0, 0, 0, flatGround);
  st.position.y = alt;
  st.quaternion.setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(sol.alphaDeg), 0, 0, 'YXZ'));
  st.velocity.set(0, 0, -v);
  c.parkingBrake = false; c.gearDown = false;
  c.trim = sol.trim; c.throttle = sol.throttle;
  let lo = alt, hi = alt;
  for (let i = 0; i < 60 * 60; i++) {
    advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
    lo = Math.min(lo, st.position.y); hi = Math.max(hi, st.position.y);
  }
  note('トリムしたまま60秒', `高度差 ${(st.position.y - alt).toFixed(0)}m / 振れ幅 ${(hi - lo).toFixed(0)}m`);
  check(Math.abs(st.position.y - alt) < 60, 'トリムを取れば手を離しても高度を保てる',
    (st.position.y - alt).toFixed(0) + 'm');
  check(Math.abs(st.pitchDeg) < 15, '手を離しても姿勢が暴れない', st.pitchDeg.toFixed(1) + '°');

  // 速い機体でもトリムが解けること。
  //
  // 迎角→トリム→スロットルの順に解いて回す作りなので、トリムを解き直すと
  // 水平尾翼の揚力が変わって迎角の答えがずれる。このずれは動圧に比例するため、
  // 回数が足りないと速い機体で収束しきらず、「翼が足りない」と誤診断して
  // **トリムを中立(0)で返して**いた。中立はその動圧では全く釣り合わない舵位置で、
  // 当てると1.5秒で裏返る（自動トリムを押すと超音速機が墜ちる、という壊れ方）。
  {
    const jet = defaultAircraftConfig();
    jet.name = '超音速トリム試験機';
    jet.modelMaxSpeedValue = 6; jet.modelMaxSpeedUnit = 'mach';
    for (const p of jet.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 200;
    const jm = buildAircraftModel(jet);
    const bad = [];
    for (const kt of [800, 1300, 1400, 1500, 2000, 3000, 4000]) {
      const s = solveLevelTrim(jm, kt / KT, 8000);
      if (!s.ok || Math.abs(s.trim) < 1e-6) bad.push(`${kt}kt(${s.reason || 'trim=0'})`);
    }
    note('超音速でのトリム', bad.length ? '解けなかった: ' + bad.join(' ') : '800〜4000kt すべて解けた');
    check(bad.length === 0, '速い機体でも水平トリムが解ける（中立で投げ返さない）',
      bad.join(' ') || 'すべて解けた');

    // 解が本物か——その舵位置のまま飛ばして、勝手に裏返らないことで確かめる。
    // 中立(0)を返していたころは1.5秒で裏返っていたので、10秒見れば十分。
    // **空を飛んでいるあいだだけ見る**。この機体は2500ktを超えると水平飛行を
    // 保てずに沈んでいく（推力が要求に届かない＝そもそも出せない速度）ので、
    // そのまま回し続けると地面の下での挙動を測ることになってしまう。
    const worst = [];
    for (const kt of [1400, 2000, 3000]) {
      const v = kt / KT;
      const s = solveLevelTrim(jm, v, 8000);
      const s2 = createFlightState(), c2 = createFlightControls();
      s2.position.set(0, 8000, 0); s2.velocity.set(0, 0, -v);
      s2.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(s.alphaDeg), 0, 0, 'YXZ'));
      c2.gearDown = false; c2.parkingBrake = false; c2.throttle = s.throttle; c2.trim = s.trim;
      let maxRoll = 0;
      for (let i = 0; i < 60 * 10; i++) {
        advanceFlight(jm, s2, c2, noWind, flatGround, 1 / 60);
        if (s2.position.y < 1000) break; // 地面に近づいたらそこまで（別の話になる）
        maxRoll = Math.max(maxRoll, Math.abs(s2.rollDeg));
      }
      worst.push(`${kt}kt:${maxRoll.toFixed(0)}°`);
      check(maxRoll < 10, `${kt}ktのトリムを当てたまま10秒飛んでも姿勢が崩れない`,
        maxRoll.toFixed(0) + '°');
    }
    note('超音速でトリムしたまま10秒', '勝手に転がった最大 ' + worst.join(' '));
  }

  // 遅く飛ぶほど機首上げのトリムが要る（実機と同じ）。長周期の振動に紛れないよう、
  // 飛ばして測るのではなく釣り合いそのもので見る。
  const slow = solveLevelTrim(model, perf.liftoffMps * 1.05, alt);
  const fast = solveLevelTrim(model, perf.liftoffMps * 2.0, alt);
  note('速度とトリム', `${(perf.liftoffMps * 1.05 * KT).toFixed(0)}kt→${(slow.trim * 100).toFixed(0)}%`
    + ` / ${(perf.liftoffMps * 2.0 * KT).toFixed(0)}kt→${(fast.trim * 100).toFixed(0)}%`);
  check(slow.trim > fast.trim, '遅く飛ぶほど機首上げのトリムが要る',
    `${(slow.trim * 100).toFixed(0)}% > ${(fast.trim * 100).toFixed(0)}%`);
  check(slow.alphaDeg > fast.alphaDeg, '遅く飛ぶほど迎角が大きくなる',
    `${slow.alphaDeg.toFixed(1)}° > ${fast.alphaDeg.toFixed(1)}°`);

  // 同じ状態から、トリムを機首上げ側へ振れば機首が上がりはじめる
  const rate = (trim) => {
    const s2 = createFlightState(), c2 = createFlightControls();
    placeAircraftOnGround(model, s2, 0, 0, 0, flatGround);
    s2.position.y = alt; s2.velocity.set(0, 0, -v);
    c2.parkingBrake = false; c2.gearDown = false; c2.throttle = sol.throttle; c2.trim = trim;
    for (let i = 0; i < 60 * 2; i++) advanceFlight(model, s2, c2, noWind, flatGround, 1 / 60);
    return s2.angularVelocity.x * 180 / Math.PI;
  };
  const up = rate(1), down = rate(-1);
  check(up > down + 1, 'トリムを機首上げ側へ振ると機首が上がりはじめる',
    `${down.toFixed(1)}°/s → ${up.toFixed(1)}°/s`);
}

// --- ピッチ舵に腕が無い機体（デルタ翼のエレボンなど）--------------------------------
//
// 水平尾翼を持たず、主翼のエルロンだけで飛ばす機体（デルタ翼・エレボン機）で、
// 重心を主翼の空力中心にぴったり合わせると、主翼をひねっても力の掛かる点が
// 重心の真上になり、トリムを一杯まで振っても回転モーメントがまったく変わらない。
// 実際にユーザーの機体（Concorde型）でこれが起き、原因の分からないまま
// 「うまく飛べない」という報告になった——「翼が足りない」に埋もれず、
// この根本原因（ピッチ舵に腕が無い）が理由としてちゃんと出ることを確かめる。
{
  const wing = (side, sign) => ({
    id: 'w_' + side, type: 'wing', name: '主翼', position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: {
      span: 5, role: 'main', side,
      corners: {
        rootLeading: { x: 0, y: 0, z: -9 },
        rootTrailing: { x: 0, y: 0, z: 2 },
        tipLeading: { x: sign * 5, y: 0, z: 1 },
        tipTrailing: { x: sign * 5, y: 0, z: 2 },
      },
    },
  });
  const aileron = (side, sign) => ({
    id: 'a_' + side, type: 'control_surface', name: 'エルロン', position: { x: sign * 4, y: 0, z: 1.5 },
    rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { kind: 'aileron', hingeAxis: 'x', minDeg: -20, maxDeg: 20, parentWingId: 'w_' + side, spanS: 0.7 },
  });
  const deltaConfig = (cgZ) => ({
    name: 'デルタ翼テスト機', modelWeightKg: 50000, modelMaxSpeedValue: 400, modelMaxSpeedUnit: 'kt',
    cg: { x: 0, y: 0, z: cgZ },
    parts: [wing('right', 1), wing('left', -1), aileron('right', 1), aileron('left', -1)],
  });

  // まず重心z=0で組んで、主翼の空力中心のz位置を読む（このモデルはcg基準の相対座標なので、
  // cg=0で組んだときの surface.center.z がそのまま「重心0の場合のAC位置」になる）
  const probe = buildAircraftModel(deltaConfig(0));
  const acZ = probe.surfaces.find((s) => s.role === 'main').center.z;
  note('デルタ翼テスト機', `主翼の空力中心 z=${acZ.toFixed(2)}m（Builderの「主翼から重心を決定」が置く位置）`);

  // 重心をぴったりその位置に合わせる
  const onAc = buildAircraftModel(deltaConfig(acZ));
  const perfOnAc = analyzeAircraftPerformance(onAc);
  check(!perfOnAc.flyable, '重心が主翼の空力中心と一致すると、飛行不能と判定される');
  check(perfOnAc.trimForClimb.reason === 'no_elevator',
    '「翼が足りない」に埋もれず、ピッチ舵に腕が無いことが理由として出る', String(perfOnAc.trimForClimb.reason));
  check(perfOnAc.notes.some((n) => n.level === 'error' && n.text.includes('ピッチ舵')),
    'エラーとして「ピッチ舵」の説明が出る');

  // 重心を主翼より少し前へ出せば、同じ主翼・同じエルロンのままモーメントの腕がつく
  const ahead = buildAircraftModel(deltaConfig(acZ - 2));
  const perfAhead = analyzeAircraftPerformance(ahead);
  check(perfAhead.elevatorPower > 1e-3, '重心を主翼より前へ出せば、同じ機体でもピッチ舵に腕がつく',
    perfAhead.elevatorPower.toFixed(0));
  check(perfAhead.trimForClimb.reason !== 'no_elevator',
    '理由も「腕が無い」ではなくなる', String(perfAhead.trimForClimb.reason));
}

// --- ロールの速さ -------------------------------------------------------------
// 舵は「親の翼をまるごとひねる」扱いなので、翼の一部にしか付かないエルロンを
// そのまま扱うとロールが実機の何倍にもなる（実際に毎秒310°で転がっていた）。
{
  const rollRate = (vMps) => {
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(model, st, 0, 0, 0, flatGround);
    st.position.y = 1500; st.velocity.set(0, 0, -vMps);
    c.parkingBrake = false; c.gearDown = false; c.throttle = 0.6; c.roll = 1;
    let sum = 0, n = 0;
    for (let i = 0; i < 60 * 6; i++) {
      advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
      if (i > 60 * 4) { sum += Math.abs(st.angularVelocity.z) * 180 / Math.PI; n++; }
    }
    return sum / n;
  };
  const slow = rollRate(50), fast = rollRate(90);
  note('エルロン全開のロール率', `${(50 * KT).toFixed(0)}kt で ${slow.toFixed(0)}°/s`
    + ` / ${(90 * KT).toFixed(0)}kt で ${fast.toFixed(0)}°/s`);
  // 軽single（セスナ172くらい）の実機は毎秒45〜60°ほど。ゲームとして少し軽快でも、
  // 桁が違えば操縦できない。
  check(slow > 25 && slow < 120, 'ロール率が実機の桁に収まっている', slow.toFixed(0) + '°/s');
  check(fast > slow, '速度が上がるとロールも速くなる', `${slow.toFixed(0)} → ${fast.toFixed(0)}°/s`);
}

// --- Builderの「推力を釣り合わせる」------------------------------------------
// 複数エンジンで垂直離着陸させる機体は、推力の中心が重心を通っていないと浮いた瞬間に
// 機首が振れる。飛行側は強いほうを絞って釣り合わせるが、絞ったぶんは使えない推力になる。
// Builderで推力そのものを解き直しておけば、位置を動かさずに全部使えるようになる。
{
  // js/05d-vtol-balance.js は Builder 側のファイル。THREE を使わない素の計算なので、
  // Builderのグローバルを最小限だけ用意すればここで動かせる。
  const toasts = [];
  const bctx = vm.createContext({
    console, Math, Number, Array, Object, JSON,
    State: null, showToast: (m, e) => toasts.push({ msg: m, error: !!e }), renderInspector: () => {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', '05d-vtol-balance.js'), 'utf8'),
    bctx, { filename: '05d-vtol-balance.js' });

  const setup = (engines, cg) => {
    bctx.State = {
      parts: engines.map((e, i) => ({
        id: 'e' + i, type: 'engine', name: 'E' + i,
        position: { x: e.x || 0, y: 0, z: e.z },
        props: { thrustKgf: e.t, spinAxis: 'y' },
      })).concat([{
        // 機首の向きを読ませるための主翼（前縁が-Z＝機首-Z）
        id: 'w', type: 'wing', name: '主翼', position: { x: 0, y: 0, z: 0 },
        props: { role: 'main', side: 'left', corners: {
          rootLeading: { x: 0, y: 0, z: -1 }, rootTrailing: { x: 0, y: 0, z: 1 },
          tipLeading: { x: 5, y: 0, z: -1 }, tipTrailing: { x: 5, y: 0, z: 1 } } },
      }]),
      cg: { position: cg || { x: 0, y: 0, z: 0 } },
      model: { weightKg: 10000 },
    };
    toasts.length = 0;
  };

  // 腕の長さが違う前後2群。前10m・後20mなら、推力は逆比の2:1で釣り合う。
  setup([{ z: -10, x: 2, t: 1000 }, { z: -10, x: -2, t: 1000 },
    { z: 20, x: 2, t: 1000 }, { z: 20, x: -2, t: 1000 }]);
  const before = bctx.vtolBalanceReport();
  check(Math.abs(before.aheadM - 5) < 0.01, '推力中心のずれを機首側からの距離で出す',
    before.aheadM.toFixed(2) + 'm');
  check(Math.abs(before.usableRatio - 0.75) < 0.01, '絞られたあとに使える割合が出る',
    (before.usableRatio * 100).toFixed(0) + '%');

  check(bctx.balanceVtolThrust() === true, '推力を釣り合わせられる');
  const after = bctx.vtolBalanceReport();
  const t = after.engines.map((e) => e.props.thrustKgf);
  check(Math.abs(after.aheadM) < 0.01 && Math.abs(after.offsetX) < 0.01,
    '釣り合わせると推力中心が重心の真上に来る',
    `前後${after.aheadM.toFixed(3)}m 左右${after.offsetX.toFixed(3)}m`);
  check(Math.abs(after.total - before.total) < 2, '合計推力は変えない',
    `${before.total} → ${after.total}`);
  check(Math.abs(t[0] / t[2] - 2) < 0.02, '腕の長さの逆比で推力が決まる',
    `${t[0]} : ${t[2]}`);
  check(t[0] === t[1] && t[2] === t[3], '左右のミラーは同じ推力のまま', t.join('/'));
  check(after.usableRatio > 0.999, '絞られるぶんが無くなる',
    (after.usableRatio * 100).toFixed(0) + '%');

  // 左右のずれも一緒に消える
  setup([{ z: -10, x: 3, t: 1000 }, { z: -10, x: -1, t: 1000 }, { z: 10, x: 0, t: 1000 }]);
  check(Math.abs(bctx.vtolBalanceReport().offsetX) > 0.5, '左右のずれも見えている');
  bctx.balanceVtolThrust();
  check(Math.abs(bctx.vtolBalanceReport().offsetX) < 0.01, '左右のずれも同時に消える',
    bctx.vtolBalanceReport().offsetX.toFixed(3) + 'm');

  // 前後どちらかにしか無い配置は、無理に触らず断る
  setup([{ z: -10, x: 2, t: 1000 }, { z: -12, x: -2, t: 1000 }]);
  check(bctx.balanceVtolThrust() === false, '片側にしか無ければ断る');
  check(toasts.length > 0 && toasts[toasts.length - 1].error, '断るときは理由を出す',
    (toasts[toasts.length - 1] || {}).msg || '—');
  check(bctx.vtolBalanceReport().engines.every((e) => e.props.thrustKgf === 1000),
    '断ったときは推力を書き換えない');
}

// --- Builderの「空力バランスを整える」------------------------------------------
//
// 「主翼から決定」で重心を主翼の空力中心へぴったり合わせると、水平尾翼を持たない
// 機体（デルタ翼のエレボンなど）では舵に腕（モーメントの効き）が無くなり、操縦できない
// 機体になる。この節では、重心を中立点から少し前へ・エンジンの角度で推力のずれを
// 打ち消す自動修正（js/05e-pitch-balance.js）が、実際にそれを直すことを確かめる。
{
  // js/05e-pitch-balance.js もBuilder側のファイル。THREEは使うが、DOM/画面は無い。
  const toasts = [];
  const pctx = vm.createContext({
    THREE, console, Math, Number, Array, Object, JSON,
    WING_CORNER_KEYS: ['rootLeading', 'rootTrailing', 'tipLeading', 'tipTrailing'],
    State: null, showToast: (m, e) => toasts.push({ msg: m, error: !!e }),
    applyPartToGizmo: () => {}, renderPartList: () => {}, renderInspector: () => {},
    updateInspectorNumbersOnly: () => {},
  });
  for (const f of ['05b-cg-system.js', '05e-pitch-balance.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
    vm.runInContext(src, pctx, { filename: f });
  }

  // 水平尾翼を持たない、デルタ翼のエレボン機。エンジンは重心の下・後ろに4基
  // （実機のConcordeと同じ配置感）——これが実際にユーザーから来た機体の作り。
  const pWing = (side, sign) => ({
    id: 'w_' + side, type: 'wing', name: '主翼', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    props: { role: 'main', side, corners: {
      rootLeading: { x: 0, y: 0, z: -9 }, rootTrailing: { x: 0, y: 0, z: 2 },
      tipLeading: { x: sign * 5, y: 0, z: 1 }, tipTrailing: { x: sign * 5, y: 0, z: 2 } } },
  });
  const pEngine = (id, x) => ({
    id, type: 'engine', name: 'E', position: { x, y: -0.5, z: 6.75 }, rotation: { x: 0, y: 0, z: 0 },
    props: { thrustKgf: 17250, spinAxis: 'z' },
  });
  const buildState = () => ({
    parts: [pWing('right', 1), pWing('left', -1),
      pEngine('e1', -1.9), pEngine('e2', 1.9), pEngine('e3', -2.4), pEngine('e4', 2.4)],
    cg: { position: { x: 0, y: 0, z: 0 }, gizmo: { position: new THREE.Vector3() } },
    model: { weightKg: 100000 },
  });

  // 重心を主翼の空力中心にぴったり合わせておく（「主翼から決定」を押した直後の状態）
  pctx.State = buildState();
  const ac = pctx.wingsAeroCenterByRole('main');
  pctx.State.cg.position.x = ac.point.x;
  pctx.State.cg.position.y = ac.point.y;
  pctx.State.cg.position.z = ac.point.z;

  const before = pctx.pbBalanceReport();
  check(Math.abs(before.staticMarginPct) < 0.5, '整える前：静安定はほぼ0%（重心が空力中心にある）',
    before.staticMarginPct.toFixed(1) + '%');
  check(!before.momentOk, '整える前：エンジン推力のモーメントが打ち消せていない',
    before.thrustPitchMoment.toFixed(0) + ' N·m');

  toasts.length = 0;
  check(pctx.balancePitchTrim() === true, '空力バランスを整えられる');

  const after = pctx.pbBalanceReport();
  check(after.staticMarginPct > 8 && after.staticMarginPct < 12,
    '整えたあと：静安定が目標の10%付近になる', after.staticMarginPct.toFixed(1) + '%');
  check(after.momentOk, '整えたあと：エンジン推力のモーメントが打ち消せている',
    after.thrustPitchMoment.toFixed(2) + ' N·m');
  const tilted = pctx.State.parts.filter((p) => p.type === 'engine').map((p) => p.rotation.x);
  check(tilted.every((t) => Math.abs(t - tilted[0]) < 1e-6), 'エンジンは全基そろって同じ角度だけ傾く',
    tilted.map((t) => t.toFixed(2)).join('/'));
  check(Math.abs(tilted[0]) > 0.1 && Math.abs(tilted[0]) < 20, '傾ける角度は現実的な範囲に収まる',
    tilted[0].toFixed(2) + '°');

  // これを実際の飛行モデルへ通すと、ピッチ舵にちゃんと腕がつく
  // （node tools/verify-flight.js は THREE 以外は自前で読むので、
  //  Builderが直した config をそのまま buildAircraftModel に渡して確かめられる）
  const fixedConfig = {
    name: 'balanced', modelWeightKg: 100000, modelMaxSpeedValue: 500, modelMaxSpeedUnit: 'kt',
    cg: pctx.State.cg.position, parts: pctx.State.parts,
  };
  const fixedModel = buildAircraftModel(fixedConfig);
  const fixedPerf = analyzeAircraftPerformance(fixedModel);
  check(fixedPerf.elevatorPower > 1e5, '実際の飛行モデルでも、ピッチ舵に大きな腕がつく',
    fixedPerf.elevatorPower.toFixed(0));
  check(fixedPerf.trimForClimb.reason !== 'no_elevator',
    '実際の飛行モデルでも「舵に腕が無い」ではなくなる', String(fixedPerf.trimForClimb.reason));

  // 主翼が無ければ、決めようがないので断る
  pctx.State = { parts: [pEngine('e1', 0)], cg: { position: { x: 0, y: 0, z: 0 }, gizmo: { position: new THREE.Vector3() } }, model: { weightKg: 1000 } };
  check(pctx.balancePitchTrim() === false, '主翼が無ければ断る');
}

// --- Builderの「エンジン出力の自動設定」------------------------------------------
//
// エンジンを置いても、その推力で「設定した最高速度まで出せるか」「垂直に浮けるか」は
// 自分で計算しないと分からない。09-aircraft.js と同じ抗力・推力の式をBuilder側で
// 再現して逆算する（js/05f-engine-power.js）。ここでは逆算した推力を実際の飛行モデル
// （buildAircraftModel／solveLevelTrim／advanceFlight）へ通し、Builder側の簡略式が
// 出した答えが、本物の物理でも成立しているかまで確かめる。
{
  const toasts = [];
  const ectx = vm.createContext({
    THREE, console, Math, Number, Array, Object, JSON,
    WING_CORNER_KEYS: ['rootLeading', 'rootTrailing', 'tipLeading', 'tipTrailing'],
    State: null, showToast: (m, e) => toasts.push({ msg: m, error: !!e }),
    renderPartList: () => {}, renderInspector: () => {}, renderModelSettingsPanel: () => {},
  });
  for (const f of ['05b-cg-system.js', '05d-vtol-balance.js', '05e-pitch-balance.js', '05f-engine-power.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
    vm.runInContext(src, ectx, { filename: f });
  }

  // --- 最高速度に必要な推力 --------------------------------------------------
  // 内蔵の練習機（140kt用の小さなエンジン）に、もっと速い最高速度を設定する。
  // もとの推力のままでは到底届かないはずで、そこを直せるかを見る。
  const trainerConfig = defaultAircraftConfig();
  ectx.State = {
    parts: trainerConfig.parts,
    cg: { position: { ...trainerConfig.cg }, gizmo: { position: new THREE.Vector3() } },
    model: { weightKg: trainerConfig.modelWeightKg, maxSpeedValue: 350, maxSpeedUnit: 'kt' },
  };
  const engineBefore = ectx.State.parts.find((p) => p.type === 'engine');
  const thrustBefore = engineBefore.props.thrustKgf;

  const speedConfigOf = (state) => ({
    name: 'speed-test', modelWeightKg: state.model.weightKg,
    modelMaxSpeedValue: state.model.maxSpeedValue, modelMaxSpeedUnit: state.model.maxSpeedUnit,
    cg: state.cg.position, parts: state.parts,
  });
  const beforeModel = buildAircraftModel(speedConfigOf(ectx.State));
  const beforeTrim = solveLevelTrim(beforeModel, beforeModel.vMaxMps, 0);
  check(!beforeTrim.ok || beforeTrim.throttle >= 0.999,
    '直す前：もとの推力のままでは、本物の飛行モデルでも最高速度で水平飛行できない',
    `ok=${beforeTrim.ok} throttle=${beforeTrim.throttle.toFixed(2)}`);

  toasts.length = 0;
  check(ectx.applyEngineSpeedTarget() === true, '最高速度に必要な出力へ自動設定できる');
  const engineAfter = ectx.State.parts.find((p) => p.type === 'engine');
  check(engineAfter.props.thrustKgf > thrustBefore, '推力が増える方向に直る',
    `${thrustBefore} → ${engineAfter.props.thrustKgf}`);

  const afterModel = buildAircraftModel(speedConfigOf(ectx.State));
  const afterTrim = solveLevelTrim(afterModel, afterModel.vMaxMps, 0);
  check(afterTrim.ok && afterTrim.throttle < 0.95,
    '直したあと：本物の飛行モデルでも、最高速度でスロットルに余裕を残して水平飛行できる',
    `ok=${afterTrim.ok} throttle=${afterTrim.throttle.toFixed(2)}`);

  // 主翼が無ければ最高速度に必要な推力の計算しようがないので断る
  ectx.State = {
    parts: [engineAfter],
    cg: { position: { x: 0, y: 0, z: 0 }, gizmo: { position: new THREE.Vector3() } },
    model: { weightKg: 1000, maxSpeedValue: 200, maxSpeedUnit: 'kt' },
  };
  check(ectx.applyEngineSpeedTarget() === false, '主翼が無ければ断る');

  // --- 垂直離陸に必要な推力 ----------------------------------------------------
  const vtolEngine = (id, x, z, thrustKgf) => ({
    id, type: 'engine', name: 'VTOL', position: { x, y: 0, z }, rotation: { x: 0, y: 0, z: 0 },
    props: { thrustKgf, spinAxis: 'y' },
  });
  ectx.State = {
    parts: [vtolEngine('v1', -1, -1, 500), vtolEngine('v2', 1, -1, 500),
      vtolEngine('v3', -1, 1, 500), vtolEngine('v4', 1, 1, 500)],
    cg: { position: { x: 0, y: 0, z: 0 }, gizmo: { position: new THREE.Vector3() } },
    model: { weightKg: 8000 },
  };
  const vtolConfigOf = (state) => ({
    name: 'vtol-test', modelWeightKg: state.model.weightKg, modelMaxSpeedValue: 300, modelMaxSpeedUnit: 'kt',
    cg: state.cg.position, parts: state.parts,
  });
  const vtolBefore = buildAircraftModel(vtolConfigOf(ectx.State));
  check(vtolBefore.vtolThrustN < vtolBefore.massKg * 9.80665,
    '直す前：もとの推力のままでは自重を持ち上げられない',
    `推力${(vtolBefore.vtolThrustN / 9.80665).toFixed(0)}kgf / 重量${vtolBefore.massKg}kg`);

  toasts.length = 0;
  check(ectx.applyVtolSpeedTarget() === true, '垂直離陸に必要な出力へ自動設定できる');
  const vtolAfterModel = buildAircraftModel(vtolConfigOf(ectx.State));
  const vtolTwrAfter = vtolAfterModel.vtolThrustN / (vtolAfterModel.massKg * 9.80665);
  check(vtolTwrAfter > 1.15 && vtolTwrAfter < 1.5,
    '直したあと：実際の飛行モデルでも、前後バランスで絞られたあとの使える推力が重量の120〜150%くらいになる',
    vtolTwrAfter.toFixed(2));

  // 本当に浮くか——実際に地面から垂直レバー全開で走らせて確かめる
  const liftSt = createFlightState();
  const liftC = createFlightControls();
  placeAircraftOnGround(vtolAfterModel, liftSt, 0, 0, 0, flatGround);
  liftC.vtolThrottle = 1;
  liftC.throttle = 0;
  liftC.gearDown = true;
  liftC.parkingBrake = false;
  const groundY = liftSt.position.y;
  for (let i = 0; i < 180; i++) advanceFlight(vtolAfterModel, liftSt, liftC, noWind, flatGround, 1 / 60);
  check(liftSt.position.y - groundY > 5, '実際に垂直レバー全開で走らせると、3秒で浮き上がる',
    `+${(liftSt.position.y - groundY).toFixed(1)}m`);
  check(Math.abs(liftSt.rollDeg) < 10 && Math.abs(liftSt.pitchDeg) < 10,
    '浮き上がる間、姿勢が大きく崩れない（前後バランスが取れている）',
    `roll=${liftSt.rollDeg.toFixed(1)}° pitch=${liftSt.pitchDeg.toFixed(1)}°`);

  // 上向きのエンジンが無ければ断る
  ectx.State = {
    parts: [{ id: 'f1', type: 'engine', name: 'F', position: { x: 0, y: 0, z: -1 }, rotation: { x: 0, y: 0, z: 0 }, props: { thrustKgf: 500, spinAxis: 'z' } }],
    cg: { position: { x: 0, y: 0, z: 0 }, gizmo: { position: new THREE.Vector3() } },
    model: { weightKg: 1000 },
  };
  check(ectx.applyVtolSpeedTarget() === false, '上向きのエンジンが無ければ断る');

  // --- 通常／垂直、それぞれ一括で倍率調整 --------------------------------------
  ectx.State = {
    parts: [vtolEngine('v1', -1, -1, 1000), vtolEngine('v2', 1, -1, 1000),
      { id: 'f1', type: 'engine', name: 'F', position: { x: 0, y: 0, z: -1 }, rotation: { x: 0, y: 0, z: 0 }, props: { thrustKgf: 2000, spinAxis: 'z' } }],
    cg: { position: { x: 0, y: 0, z: 0 }, gizmo: { position: new THREE.Vector3() } },
    model: { weightKg: 8000 },
  };
  check(ectx.epScaleEngines(false, 1.5) === true, '通常エンジンの一括倍率が適用できる');
  check(ectx.State.parts.find((p) => p.id === 'f1').props.thrustKgf === 3000,
    '通常エンジンに倍率がかかる', String(ectx.State.parts.find((p) => p.id === 'f1').props.thrustKgf));
  check(ectx.State.parts.find((p) => p.id === 'v1').props.thrustKgf === 1000,
    '垂直エンジンは通常エンジンの倍率では変わらない（別レバー）');

  check(ectx.epScaleEngines(true, 2) === true, '垂直エンジンの一括倍率が適用できる');
  check(ectx.State.parts.find((p) => p.id === 'v1').props.thrustKgf === 2000,
    '垂直エンジンに倍率がかかる', String(ectx.State.parts.find((p) => p.id === 'v1').props.thrustKgf));
  check(ectx.State.parts.find((p) => p.id === 'f1').props.thrustKgf === 3000,
    '通常エンジンは垂直エンジンの倍率では変わらない');

  check(ectx.epScaleEngines(false, -1) === false, '倍率が0以下なら断る（マイナス推力を防ぐ）');
  check(ectx.epScaleEngines(false, 0) === false, '倍率が0なら断る');
}

// --- 自動操縦：経路の組み立て ---------------------------------------------------
{
  // 追い風では降りられないので、風上へ向かう側の末端から進入する
  check(apPickRunwayHeading(90, 90) === 270, '向かい風になる側の滑走路を選ぶ（風が東へ吹く）',
    String(apPickRunwayHeading(90, 90)));
  check(apPickRunwayHeading(90, 270) === 90, '風向が反対なら反対の末端から',
    String(apPickRunwayHeading(90, 270)));

  // 方位0は-Z、90は+X（10-flight.js と同じ約束）
  check(Math.abs(apBearingTo(0, 0, 0, -100) - 0) < 0.01, '真北(-Z)の方位は0°');
  check(Math.abs(apBearingTo(0, 0, 100, 0) - 90) < 0.01, '真東(+X)の方位は90°');
  check(Math.abs(apWrap180(350 - 10) - -20) < 1e-9, '方位の差は近いほうを回る', String(apWrap180(340)));

  // 東西の滑走路（方位90）。進入は西端から東へ。
  const plan = apMakeApproachPlan(
    { id: 'TST', x: 0, z: 0, elevationM: 120 },
    { runwayLengthM: 2400, headingDeg: 90 }, 270);
  check(plan.heading === 90, '滑走路の向きが決まる', String(plan.heading));
  check(Math.abs(plan.threshold.x - -1200) < 1 && Math.abs(plan.threshold.z) < 1,
    '進入端は滑走路の手前側', `(${plan.threshold.x.toFixed(0)}, ${plan.threshold.z.toFixed(0)})`);
  check(plan.aim.x > plan.threshold.x, '狙う接地点は進入端より先');
  check(Math.abs(plan.faf.x - (plan.threshold.x - 9000)) < 1, '最終進入開始点は延長線上の手前9km');
  // 標高120mの空港なら、進入開始点の高度も標高ぶん上がる
  check(plan.fafAltM > 120 + 400 && plan.fafAltM < 120 + 600,
    '進入開始点の高度は標高＋3°ぶん', plan.fafAltM.toFixed(0) + 'm');

  // 経路上のどこにいるか
  const on = apTrackPosition(plan, plan.aim.x - 5000, 0);
  check(Math.abs(on.before - 5000) < 1 && Math.abs(on.cross) < 1,
    '中心線上にいれば横ずれ0', `before=${on.before.toFixed(0)} cross=${on.cross.toFixed(0)}`);
  const right = apTrackPosition(plan, plan.aim.x - 5000, 300);
  check(right.cross > 299 && right.cross < 301, '中心線の右にいれば横ずれは+',
    right.cross.toFixed(0) + 'm');
}

// --- 自動操縦：高度維持 ---------------------------------------------------------
//
// ユーザーの最初の要望がこれ（「設定した高度を飛び続ける機能」）。
// 上げるほうと下げるほう、どちらもきっちり止まることを確かめる。
{
  const st = createFlightState();
  const c = createFlightControls();
  st.position.set(0, 600, 0);
  st.velocity.set(0, 0, -50);
  c.gearDown = false; c.parkingBrake = false; c.throttle = 0.7;
  const ap = createAutopilotState();
  ap.altHold = true; ap.targetAltitudeM = 1000;

  const spd = apSpeedSchedule(model);
  let minSpeed = Infinity;
  const run = (seconds) => {
    for (let i = 0; i < seconds * 60; i++) {
      stepAutopilot(model, st, c, ap, 1 / 60, {});
      advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
      minSpeed = Math.min(minSpeed, st.airspeed);
    }
  };

  run(400);
  check(Math.abs(st.altitudeM - 1000) < 15, '設定した高度まで上がって止まる',
    st.altitudeM.toFixed(1) + 'm');
  check(Math.abs(st.rollDeg) < 3, '翼が水平に戻っている', st.rollDeg.toFixed(1) + '°');
  // 高度を追いかけて失速するのがいちばん危ない壊れ方（出力は操縦者が持ったままなので）
  check(minSpeed > spd.stall, '高度を追いかけて失速速度を割らない',
    `最低${minSpeed.toFixed(1)} / 失速${spd.stall.toFixed(1)} m/s`);

  ap.targetAltitudeM = 400;
  run(300);
  check(Math.abs(st.altitudeM - 400) < 15, '下げるほうも設定した高度で止まる',
    st.altitudeM.toFixed(1) + 'm');

  // 揺れずに保てているか（最後の60秒の高度の振れ幅）
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 60 * 60; i++) {
    stepAutopilot(model, st, c, ap, 1 / 60, {});
    advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
    lo = Math.min(lo, st.altitudeM); hi = Math.max(hi, st.altitudeM);
  }
  check(hi - lo < 5, '保っている間、高度が上下に揺れない', `振れ幅 ${(hi - lo).toFixed(2)}m`);
}

// --- 自動操縦：離陸から着陸まで --------------------------------------------------
//
// ここが本題。滑走路に置いた機体が、自分で浮いて、飛んで、降りて、止まるか。
// 進む向きを変えて4通り試す——旋回が要る経路で初めて出るずれがあるため
// （実際、90°横の滑走路へ回り込む経路で中心線に乗れない不具合が出た）。
function autopilotFlight(opts) {
  const st = createFlightState();
  const c = createFlightControls();
  const depHeading = opts.departHeading === undefined ? 90 : opts.departHeading;
  const f = { x: Math.sin(depHeading * Math.PI / 180), z: -Math.cos(depHeading * Math.PI / 180) };
  placeAircraftOnGround(model, st, -f.x * 1160, -f.z * 1160, depHeading, flatGround);

  const dest = { id: 'DST', x: opts.destX, z: opts.destZ, elevationM: 0 };
  const settings = { runwayLengthM: 2400, headingDeg: opts.destHeading };
  const ap = createAutopilotState();
  ap.full = true;
  ap.targetAltitudeM = opts.altitudeM || 900;
  ap.destAirportId = dest.id;
  ap.plan = apMakeApproachPlan(dest, settings, 0);
  ap.takeoffHeadingDeg = depHeading;
  ap.phase = 'takeoff';

  const seen = [];
  let t = 0, prev = '', worstG = 0, sink = 0, prevVs = 0;
  const wind = opts.wind || noWind;
  while (t < (opts.maxSeconds || 2200)) {
    stepAutopilot(model, st, c, ap, 1 / 60, {});
    advanceFlight(model, st, c, wind, flatGround, 1 / 60);
    // 接地の衝撃は loadFactor（機体の上下方向のG）で見る。全体の速度変化で見ると
    // 推力そのものの加速度も拾ってしまう（12-flight-mode.js の墜落判定と同じ理由）。
    if (st.onGround) {
      worstG = Math.max(worstG, Math.abs(st.loadFactor));
      if (!sink && ap.phase !== 'takeoff') sink = prevVs;
    }
    prevVs = st.verticalSpeed;
    t += 1 / 60;
    if (ap.phase !== prev) { prev = ap.phase; seen.push(ap.phase); }
    if (ap.phase === 'done' || st.crashed) break;
  }
  return { st, c, ap, t, seen, worstG, sink, track: apTrackPosition(ap.plan, st.position.x, st.position.z) };
}

{
  const routes = [
    { label: '東へ60km（旋回なし）', destX: 60000, destZ: 0, destHeading: 90 },
    { label: '北東へ50km・滑走路は南北', destX: 35000, destZ: -35000, destHeading: 0 },
    { label: '西へ40km（180°の旋回）', destX: -40000, destZ: 0, destHeading: 270 },
    { label: '南へ35km・滑走路は東西', destX: 0, destZ: 35000, destHeading: 90 },
  ];
  for (const r of routes) {
    const f = autopilotFlight(r);
    note('自動操縦', `${r.label} … ${f.seen.join('→')} ${f.t.toFixed(0)}秒`);
    check(f.ap.phase === 'done', `${r.label}：着陸まで通しでできる`,
      `${f.ap.phase} / ${f.t.toFixed(0)}秒`);
    check(!f.st.crashed, `${r.label}：墜落しない`);
    // 中心線に乗れているか。滑走路の幅（45m）の半分より内側であること。
    check(Math.abs(f.track.cross) < 22, `${r.label}：滑走路の中心線の上に降りる`,
      f.track.cross.toFixed(1) + 'm');
    // 狙った接地点から滑走路の中に収まっているか（滑走路は2400m、狙いは末端から200m）
    check(f.track.before > -2000, `${r.label}：滑走路の中に降りる`,
      `狙いの${(-f.track.before).toFixed(0)}m先`);
    // 接地の衝撃。12-flight-mode.js の墜落判定（12G）に届いてはいけない
    check(f.worstG < 6, `${r.label}：脚を壊さずに降りる`, f.worstG.toFixed(1) + 'G');
    check(Math.abs(f.sink) < 3, `${r.label}：接地の沈下が穏やか`, f.sink.toFixed(1) + 'm/s');
    check(f.st.groundSpeed < 2 && f.c.parkingBrake, `${r.label}：止まって駐機ブレーキまで入る`,
      f.st.groundSpeed.toFixed(1) + 'm/s');
  }
}

// --- 自動操縦：風の中でも降りられるか ---------------------------------------------
{
  // 横風。中心線に乗るには機首を風上へ向けたまま降りることになる。
  const cross = autopilotFlight({
    destX: 40000, destZ: 0, destHeading: 90,
    wind: new THREE.Vector3(0, 0, 25 / 3.6), // 南へ25km/h＝滑走路に真横から
    maxSeconds: 2600,
  });
  note('自動操縦', `横風25km/h … ${cross.seen.join('→')} ${cross.t.toFixed(0)}秒`);
  check(cross.ap.phase === 'done' && !cross.st.crashed, '横風25km/hでも着陸できる',
    `${cross.ap.phase} / ${cross.t.toFixed(0)}秒`);
  check(Math.abs(cross.track.cross) < 30, '横風でも中心線から流されない',
    cross.track.cross.toFixed(1) + 'm');
}

// --- 自動操縦：降りられなければやり直す ------------------------------------------
//
// 高すぎるところから進入に放り込む。そのまま突っ込むのでも素通りするのでもなく、
// 上がり直してもう一度進入に入れること（ここで諦めると永遠に飛び続ける）。
{
  const st = createFlightState();
  const c = createFlightControls();
  const dest = { id: 'DST', x: 0, z: 0, elevationM: 0 };
  const ap = createAutopilotState();
  ap.full = true; ap.targetAltitudeM = 900; ap.destAirportId = 'DST';
  ap.plan = apMakeApproachPlan(dest, { runwayLengthM: 2400, headingDeg: 90 }, 0);
  ap.phase = 'approach';

  // 接地点の1km手前・高度500m＝3°の進入線から450m高い
  st.position.set(ap.plan.aim.x - 1000, 500, ap.plan.aim.z);
  st.quaternion.setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-90), 0, 'YXZ'));
  st.velocity.set(45, 0, 0);
  c.gearDown = true; c.parkingBrake = false; c.throttle = 0.5;
  refreshFlightReadouts(model, st, flatGround); // 位置を直に置いたので計器を合わせる

  const seen = [];
  let t = 0, prev = 'approach';
  while (t < 1400) {
    stepAutopilot(model, st, c, ap, 1 / 60, {});
    advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
    t += 1 / 60;
    if (ap.phase !== prev) { prev = ap.phase; seen.push(ap.phase); }
    if (ap.phase === 'done' || st.crashed) break;
  }
  note('自動操縦', `高すぎる進入 … approach→${seen.join('→')} ${t.toFixed(0)}秒`);
  check(seen.indexOf('goaround') === 0, '降りられなければやり直しに入る', seen.join('→'));
  check(seen[seen.length - 1] === 'done' && !st.crashed, 'やり直したあと着陸まで行ける',
    `${ap.phase} / ${t.toFixed(0)}秒`);
}

// --- 自動操縦：機体が違っても飛ばせるか ------------------------------------------
//
// 練習機に合わせた数字を並べていないか。寸法4倍・重量150倍・推力200倍の
// 大型機を作って、同じ制御で降りられることを確かめる。
{
  const big = defaultAircraftConfig();
  big.name = '大型機'; big.modelWeightKg = 165000;
  big.modelMaxSpeedValue = 480; big.modelMaxSpeedUnit = 'kt';
  const S = 4;
  const scale = (v) => { v.x *= S; v.y *= S; v.z *= S; };
  scale(big.cg);
  for (const p of big.parts) {
    scale(p.position);
    if (p.props && p.props.corners) for (const k in p.props.corners) scale(p.props.corners[k]);
    if (p.props && p.props.span) p.props.span *= S;
    if (p.props && p.props.thrustKgf) p.props.thrustKgf *= 200;
  }
  const bigModel = buildAircraftModel(big);
  const spd = apSpeedSchedule(bigModel);
  note('大型機', `${bigModel.massKg.toLocaleString()}kg / 翼${bigModel.wingArea.toFixed(0)}m²`
    + ` / 失速${(spd.stall * KT).toFixed(0)}kt / 巡航${(spd.cruise * KT).toFixed(0)}kt`);

  const st = createFlightState();
  const c = createFlightControls();
  placeAircraftOnGround(bigModel, st, -1160, 0, 90, flatGround);
  const ap = createAutopilotState();
  ap.full = true; ap.targetAltitudeM = 3000; ap.destAirportId = 'DST';
  ap.plan = apMakeApproachPlan({ id: 'DST', x: 120000, z: 0, elevationM: 0 },
    { runwayLengthM: 3500, headingDeg: 90 }, 0);
  ap.takeoffHeadingDeg = 90; ap.phase = 'takeoff';

  let t = 0, worstG = 0;
  const seen = [];
  let prev = '';
  while (t < 2500) {
    stepAutopilot(bigModel, st, c, ap, 1 / 60, {});
    advanceFlight(bigModel, st, c, noWind, flatGround, 1 / 60);
    if (st.onGround) worstG = Math.max(worstG, Math.abs(st.loadFactor));
    t += 1 / 60;
    if (ap.phase !== prev) { prev = ap.phase; seen.push(ap.phase); }
    if (ap.phase === 'done' || st.crashed) break;
  }
  const track = apTrackPosition(ap.plan, st.position.x, st.position.z);
  note('自動操縦', `大型機で120km … ${seen.join('→')} ${t.toFixed(0)}秒`);
  check(ap.phase === 'done' && !st.crashed, '大型機でも離陸から着陸まで通せる',
    `${ap.phase} / ${t.toFixed(0)}秒`);
  check(Math.abs(track.cross) < 30, '大型機でも中心線の上に降りる', track.cross.toFixed(1) + 'm');
  check(worstG < 12, '大型機でも脚が壊れる衝撃にならない', worstG.toFixed(1) + 'G');
}

// --- 自動操縦：高速機ほどバンク角を深くして旋回性能を上げる -----------------------
//
// バンク角の上限（25°）は民間機の常用域を基準にした値で、遅い機体はそれで十分だが、
// 速い機体ほど「バンクを目一杯使っても曲がりきれない」影響を強く受ける
// （旋回半径 v²/(g·tanθ) が速度の2乗で効くため）。実機の戦闘機のように、
// 速い機体はもっと深く傾けられるようにして、旋回半径を詰められるようにする。
{
  // 13-autopilot.js の同名の定数と同じ値。vmコンテキストの外からはトップレベルの
  // constを直接読めない（関数と違ってグローバルオブジェクトに乗らない）ので、
  // 比較用にここでも複製する（下の旋回半径のテストで25°を複製していたのと同じ理由）。
  const BANK_SLOW = 25, BANK_HARD = 85, RADIUS_MAX = 40000;
  const STALL = 28; // 内蔵機の失速速度に近い値(m/s)。以下の判定はこれを基準に測る

  // 遅い機体は、必要なバンクが浅いので民間機の常用域のまま
  check(Math.abs(apBankMaxFor(50, STALL, RADIUS_MAX) - BANK_SLOW) < 0.01,
    '遅い機体はバンク角の上限がそのまま（曲がるのに深く倒す必要がない）',
    apBankMaxFor(50, STALL, RADIUS_MAX).toFixed(1) + '°');

  // 速い機体は、必要なだけ深くなる（旋回半径 v²/(g·tanφ) を収めるため）
  const b660 = apBankMaxFor(660, STALL, RADIUS_MAX);
  const b1980 = apBankMaxFor(1980, STALL, RADIUS_MAX);
  check(b660 > BANK_SLOW && b660 < b1980,
    '速い機体ほどバンク角の上限が深くなる（速いほど深く倒さないと同じ半径で回れない）',
    `660m/s→${b660.toFixed(0)}° < 1980m/s→${b1980.toFixed(0)}°`);
  check(b1980 <= BANK_HARD + 0.01, 'どれだけ速くても、上限そのものは超えない',
    b1980.toFixed(1) + '°');
  // 実際にその半径で回れる角度になっているか（＝必要なぶんはちゃんと出ている）
  const rAt660 = (660 * 660) / (9.80665 * Math.tan(b660 * Math.PI / 180));
  check(rAt660 <= RADIUS_MAX * 1.01, 'その上限で、狙った旋回半径に収まる',
    `${(rAt660 / 1000).toFixed(1)}km ≤ ${(RADIUS_MAX / 1000).toFixed(0)}km`);

  // 出せる揚力を超えるバンクは許さない（失速速度に近い速度で深く倒さない）
  check(apBankLimit(STALL * 1.3, STALL) < 40,
    '進入速度あたりでは、揚力が足りないので深いバンクを許さない',
    apBankLimit(STALL * 1.3, STALL).toFixed(0) + '°');
  check(apBankLimit(STALL * 20, STALL) > 60,
    '失速速度の20倍で飛んでいれば、揚力は余っているので深く倒せる',
    apBankLimit(STALL * 20, STALL).toFixed(0) + '°');

  // マッハ2級の機体で、実際に巡航速度が上がる（＝曲がれる速さの上限が上がる）ことを確かめる
  const fast = defaultAircraftConfig();
  fast.name = '高速機テスト';
  fast.modelMaxSpeedValue = 2; fast.modelMaxSpeedUnit = 'mach';
  const fastModel = buildAircraftModel(fast);
  const fastSpd = apSpeedSchedule(fastModel);
  // 「以前の固定25°バンクなら、曲がれる速さの上限は何m/sだったか」を計算し直して比べる
  const oldTurnableV = Math.sqrt(RADIUS_MAX * 9.80665 * Math.tan(BANK_SLOW * Math.PI / 180));
  check(fastSpd.bankMax > BANK_SLOW + 10,
    'マッハ2級の機体は、バンク角の上限が民間機の常用域よりだいぶ深くなる',
    fastSpd.bankMax.toFixed(1) + '°');
  check(fastSpd.cruise > oldTurnableV * 1.3,
    'そのぶん、以前の固定25°より速く巡航できる（旋回性能が上がる）',
    `${(fastSpd.cruise * KT).toFixed(0)}kt > ${(oldTurnableV * KT).toFixed(0)}kt(旧上限)`);
}

// --- 自動操縦：速い機体でも、ほぼ最高速度のまま旋回できる -------------------------
//
// 手で飛ばせば超音速機はほぼ最高速度でもしっかり曲がれる（実測で、失速速度の
// 22倍の速さでも半径1.5kmで回れた）のに、自動操縦だけがバンク角60°で
// 頭打ちになっていたため、曲がるには速度を落とすしかなかった
// （巡航速度が turnableV で頭打ちになる）。バンク角の上限を「必要なだけ深く、
// 出せる揚力のぶんだけ」に変えて、速いまま曲がれるようにする。
{
  const fast = (mach) => {
    const cfg = defaultAircraftConfig();
    cfg.name = `旋回試験機M${mach}`;
    cfg.modelMaxSpeedValue = mach; cfg.modelMaxSpeedUnit = 'mach';
    for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 40;
    return buildAircraftModel(cfg);
  };
  const rows = [];
  for (const mach of [2, 3, 6]) {
    const m2 = fast(mach);
    const s2 = apSpeedSchedule(m2, 200000);
    const frac = s2.cruise / m2.vMaxMps;
    rows.push(`M${mach}:${(frac * 100).toFixed(0)}%/${s2.bankMax.toFixed(0)}°`);
    check(frac > 0.9, `マッハ${mach}級は、旋回のために速度を落とさず最高速度近くで巡航する`,
      `${(s2.cruise * KT).toFixed(0)}kt / 最高${(m2.vMaxMps * KT).toFixed(0)}kt (${(frac * 100).toFixed(0)}%)`);
    // その巡航速度・そのバンク角で、旋回半径がちゃんと収まっていること
    const r = (s2.cruise * s2.cruise) / (9.80665 * Math.tan(s2.bankMax * Math.PI / 180));
    check(r < 40000 * 1.02, `マッハ${mach}級でも、その速さのまま旋回半径が収まる`,
      (r / 1000).toFixed(1) + 'km');
  }
  note('速いまま旋回', '巡航速度が最高速度の何%か／バンク上限 … ' + rows.join('  '));

  // 実際に、90°の旋回が要る経路を通しで飛ばして着陸できること
  for (const mach of [3, 6]) {
    const m2 = fast(mach);
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(m2, st, 0, 0, 90, flatGround);
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = 6000; ap.destAirportId = 'DST'; ap.phase = 'takeoff';
    ap.takeoffHeadingDeg = 90;
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 0, z: -200000, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 0 }, 0);
    let t = 0, prev = '', seen = [], vAtApproach = null;
    while (t < 4000) {
      stepAutopilot(m2, st, c, ap, 1 / 60, {});
      advanceFlight(m2, st, c, noWind, flatGround, 1 / 60);
      t += 1 / 60;
      if (ap.phase !== prev) {
        if (ap.phase === 'approach' && vAtApproach === null) vAtApproach = st.airspeed;
        prev = ap.phase; seen.push(ap.phase);
      }
      if (ap.phase === 'done' || st.crashed) break;
    }
    const spd2 = apSpeedSchedule(m2);
    note(`自動操縦: マッハ${mach}級・90°旋回`, `${seen.join('→')} ${t.toFixed(0)}秒`
      + ` / 進入開始時 ${vAtApproach === null ? '—' : (vAtApproach * KT).toFixed(0) + 'kt'}`
      + `（進入速度${(spd2.approach * KT).toFixed(0)}kt）`);
    check(ap.phase === 'done' && !st.crashed,
      `マッハ${mach}級でも、旋回して目的地へ着陸できる`, `${ap.phase} / ${t.toFixed(0)}秒`);
    // 降下で進入速度まで落としきれていること。以前は「目的地に近づくと旋回半径の
    // 上限が縮み、それに引きずられて巡航速度の見積もりも下がる」という偶然に
    // 頼って減速していたので、速いまま曲がれるようにした途端に進入へ958ktで
    // 突っ込み、74Gを掛けてやり直していた。
    check(vAtApproach !== null && vAtApproach < spd2.approach * 4,
      `マッハ${mach}級でも、降下のあいだに進入速度まで減速できている`,
      `${vAtApproach === null ? '—' : (vAtApproach * KT).toFixed(0) + 'kt'} < ${(spd2.approach * 4 * KT).toFixed(0)}kt`);
  }
}

// --- 自動操縦：推力重量比が桁外れな機体でも、旋回して着陸できるか -----------------------
//
// サンダーバード1号（実機の報告値で推力/重量20倍超）を自動操縦で飛ばすと、
// 上昇中に姿勢を目一杯（15°）まで上げても速度が青天井に伸び続け、
// 旋回できる速さ（spd.cruise）を秒速2,000kt以上も超えて目的地をはるかに
// 通り過ぎてしまい、目的地の周りを永遠に旋回し続けて（＝旋回できず、
// 巡航中フラフラする）一生降りられなくなっていた。
//   1. 上昇中、速度が「曲がれる速さの1.5倍」を超えたら出力を絞る
//      （climb フェーズの overCruise 判定）
//   2. 旋回半径は世界の大きさだけでなく、いま飛んでいるルートの長さにも
//      合わせて絞る（apCruiseTurnRadiusMax）
// の2つを直したことで、それでも実際に旋回して着陸できることを確かめる。
{
  const rocket = defaultAircraftConfig();
  rocket.name = '推力過剰機テスト';
  rocket.modelMaxSpeedValue = 3; rocket.modelMaxSpeedUnit = 'mach';
  for (const p of rocket.parts) { if (p.type === 'engine' && p.props) p.props.thrustKgf *= 60; }
  const rocketModel = buildAircraftModel(rocket);
  const tw = rocketModel.totalThrustN / (rocketModel.massKg * 9.80665);
  check(tw > 15, 'この機体も、実際に報告のあった超音速機と同じくらい推力が桁外れ',
    tw.toFixed(1) + '倍');

  const noRouteSpd = apSpeedSchedule(rocketModel);
  const st = createFlightState();
  const c = createFlightControls();
  placeAircraftOnGround(rocketModel, st, 0, 0, 90, flatGround);
  const ap = createAutopilotState();
  ap.full = true; ap.targetAltitudeM = 2000; ap.destAirportId = 'DST';
  // 90°の旋回が要る経路（出発は東向き、目的地は北東40km）
  ap.plan = apMakeApproachPlan({ id: 'DST', x: 40000, z: 40000, elevationM: 0 },
    { runwayLengthM: 2400, headingDeg: 0 }, 0);
  ap.takeoffHeadingDeg = 90; ap.phase = 'takeoff';
  let t = 0; const seen = []; let prev = ''; let maxSpeedDuringClimb = 0;
  while (t < 1800) {
    stepAutopilot(rocketModel, st, c, ap, 1 / 60, {});
    advanceFlight(rocketModel, st, c, noWind, flatGround, 1 / 60);
    t += 1 / 60;
    if (ap.phase === 'climb') maxSpeedDuringClimb = Math.max(maxSpeedDuringClimb, st.airspeed);
    if (ap.phase !== prev) { prev = ap.phase; seen.push(ap.phase); }
    if (ap.phase === 'done' || st.crashed) break;
  }
  note('推力過剰機テスト', `${seen.join('→')} ${t.toFixed(0)}秒 / 上昇中の最高速度`
    + `${(maxSpeedDuringClimb * KT).toFixed(0)}kt（曲がれる速さ${(noRouteSpd.cruise * KT).toFixed(0)}kt）`);
  check(maxSpeedDuringClimb < noRouteSpd.cruise * 2,
    '上昇中、出力の絞りが効いて、曲がれる速さを大きく超えたまま伸び続けない',
    `${(maxSpeedDuringClimb * KT).toFixed(0)}kt`);
  check(ap.phase === 'done' && !st.crashed,
    '推力が桁外れでも、旋回して目的地へ着陸できる（以前は旋回できず永遠に周り続けた）',
    `${ap.phase} / ${t.toFixed(0)}秒`);
}

// --- 自動操縦：垂直離着陸を選んでオンオフできる ------------------------------------
//
// 垂直離着陸用エンジンを持つ機体で、離陸・着陸それぞれを独立に「滑走路を使う
// ふつうの離着陸」と「真上へ上がる／真下へ降りる垂直離着陸」に切り替えられる。
// takeoff→vtol_takeoff→vtol_transition→climb で離陸を、
// approach→flare→rollout→done の代わりに vtol_approach→vtol_descent→
// vtol_touchdown→done で着陸をやり直す。既存の巡航・降下はそのまま使う。
{
  const vtolEngine = (id, x, z) => ({
    id, type: 'engine', name: '垂直' + id, position: { x, y: 1.05, z }, rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }, props: { thrustKgf: 900, spinAxis: 'y' },
  });
  const vtolConfig = () => {
    const cfg = defaultAircraftConfig();
    cfg.parts = cfg.parts.concat([
      vtolEngine('1', -1, -1.5), vtolEngine('2', 1, -1.5),
      vtolEngine('3', -1, 1.5), vtolEngine('4', 1, 1.5),
    ]);
    return cfg;
  };
  const model = buildAircraftModel(vtolConfig());
  check(model.hasVtol, '垂直離着陸用エンジンを積んだ機体だと分かる');
  check(model.vtolThrustN > model.massKg * 9.80665, '積んだ推力で自重を持ち上げられる',
    `推力/重量 ${(model.vtolThrustN / (model.massKg * 9.80665)).toFixed(2)}`);

  function runVtolRoute(vtolTakeoff, vtolLanding) {
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(model, st, 0, 0, 90, flatGround);
    const ap = createAutopilotState();
    ap.vtolTakeoff = vtolTakeoff; ap.vtolLanding = vtolLanding;
    ap.full = true; ap.targetAltitudeM = 1500; ap.destAirportId = 'DST';
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 40000, z: 40000, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 0 }, 0);
    ap.takeoffHeadingDeg = 90;
    ap.phase = vtolTakeoff ? 'vtol_takeoff' : 'takeoff';
    let t = 0; const seen = []; let prev = '';
    while (t < 1800) {
      stepAutopilot(model, st, c, ap, 1 / 60, {});
      advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
      t += 1 / 60;
      if (ap.phase !== prev) { prev = ap.phase; seen.push(prev); }
      if (ap.phase === 'done' || st.crashed) break;
    }
    return { st, ap, t, seen };
  }

  const both = runVtolRoute(true, true);
  note('自動操縦：垂直離着陸（両方）', `${both.seen.join('→')} ${both.t.toFixed(0)}秒`);
  check(both.seen.includes('vtol_takeoff') && both.seen.includes('vtol_transition'),
    '垂直離陸をオンにすると、その手順を通る');
  check(both.seen.includes('vtol_approach') && both.seen.includes('vtol_descent')
    && both.seen.includes('vtol_touchdown'),
    '垂直着陸をオンにすると、その手順を通る');
  check(both.ap.phase === 'done' && !both.st.crashed, '垂直離着陸だけで、離陸から着陸まで通せる',
    `${both.ap.phase} / ${both.t.toFixed(0)}秒`);

  const takeoffOnly = runVtolRoute(true, false);
  check(takeoffOnly.seen.includes('vtol_takeoff') && takeoffOnly.seen.includes('flare')
    && !takeoffOnly.seen.includes('vtol_approach'),
    '垂直離陸だけオンにすると、離陸は垂直・着陸はふつうの滑走路になる',
    takeoffOnly.seen.join('→'));
  check(takeoffOnly.ap.phase === 'done' && !takeoffOnly.st.crashed, '垂直離陸のみでも通しで飛べる');

  const landingOnly = runVtolRoute(false, true);
  check(landingOnly.seen.includes('takeoff') && landingOnly.seen.includes('vtol_descent')
    && !landingOnly.seen.includes('vtol_takeoff'),
    '垂直着陸だけオンにすると、離陸はふつうの滑走路・着陸は垂直になる',
    landingOnly.seen.join('→'));
  check(landingOnly.ap.phase === 'done' && !landingOnly.st.crashed, '垂直着陸のみでも通しで飛べる');

  // 垂直離着陸用エンジンが無い機体では、チェックを入れても通常運用のまま
  const plain = buildAircraftModel(defaultAircraftConfig());
  check(!plain.hasVtol, '垂直離着陸用エンジンが無い機体だと分かる');
}

// --- 自動操縦：最高速度が桁外れな機体でも旋回できるか ------------------------------
//
// フィクションの超音速機には最高速度に「マッハ21」のような桁外れな値が
// 入ることがある（実際にユーザーの機体がそうだった）。巡航をできるだけ
// 速くする仕組み（前の節）は、この値をそのまま使うと秒速数kmまで加速してしまい、
// 旋回半径が v²/(g·tanθ) で速度の2乗に効くぶん数千kmに膨れ上がって、
// バンク角を目一杯使っても目的地へ向き直せず、直進しかできなくなっていた
// （手動操縦はできるのに自動操縦だけ曲がれない、という報告になった）。
{
  const hyper = defaultAircraftConfig();
  hyper.name = '極超音速機テスト';
  hyper.modelMaxSpeedValue = 20; hyper.modelMaxSpeedUnit = 'mach'; // 秒速6800m相当
  const hm = buildAircraftModel(hyper);
  const hspd = apSpeedSchedule(hm);
  note('極超音速機テスト', `vMax=${(hm.vMaxMps * 1.94384).toFixed(0)}kt / 巡航=${(hspd.cruise * 1.94384).toFixed(0)}kt`);
  check(hspd.cruise < hm.vMaxMps * 0.5, '最高速度が桁外れでも、巡航速度はそのまま追従しない',
    `巡航${hspd.cruise.toFixed(0)}m/s ≪ 最高${hm.vMaxMps.toFixed(0)}m/s`);
  // その巡航速度・最大バンク角なら、旋回半径は十分に小さい（世界の広さに対して）
  const radius = (hspd.cruise * hspd.cruise) / (9.80665 * Math.tan(hspd.bankMax * Math.PI / 180));
  check(radius < 60000, '巡航速度での旋回半径が実用的な範囲に収まる', (radius / 1000).toFixed(0) + 'km');

  // 実際に、旋回が要る経路（横へ40km）を自動操縦で飛ばして確かめる
  const st = createFlightState(), c = createFlightControls();
  placeAircraftOnGround(hm, st, 0, 0, 90, flatGround);
  const ap = createAutopilotState();
  ap.full = true; ap.targetAltitudeM = 2000; ap.destAirportId = 'DST';
  ap.plan = apMakeApproachPlan({ id: 'DST', x: 0, z: 40000, elevationM: 0 },
    { runwayLengthM: 2400, headingDeg: 0 }, 0);
  ap.takeoffHeadingDeg = 90; ap.phase = 'takeoff';
  let t = 0; const seen = []; let prev = '';
  while (t < 2000) {
    stepAutopilot(hm, st, c, ap, 1 / 60, {});
    advanceFlight(hm, st, c, noWind, flatGround, 1 / 60);
    t += 1 / 60;
    if (ap.phase !== prev) { prev = ap.phase; seen.push(ap.phase); }
    if (ap.phase === 'done' || st.crashed) break;
  }
  note('自動操縦', `極超音速機・横へ90°旋回 … ${seen.join('→')} ${t.toFixed(0)}秒`);
  check(ap.phase === 'done' && !st.crashed, '最高速度が桁外れでも、旋回して目的地へ着陸できる',
    `${ap.phase} / ${t.toFixed(0)}秒`);
}

// --- 速い機体で舵がプルプルしない（かつ低速の効きは落とさない） -------------------
//
// 舵のモーメントは動圧に比例するので、ゲインを速度によらず固定にすると
// 速い機体では内側の段のループゲインが1を超え、毎コマ舵が反対へ振り切れる。
// 「行き過ぎて戻してまた行き過ぎる」という報告がこれで、
// 直し方は**可動域を絞ることではない**（低速で効かなくなる）——
// 「1°のずれあたり何舵か」を動圧で割る（apSurfaceGain）。
{
  const cfg = defaultAircraftConfig();
  cfg.name = 'プルプル試験機';
  cfg.modelMaxSpeedValue = 2; cfg.modelMaxSpeedUnit = 'mach';
  for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 40;
  const fm = buildAircraftModel(cfg);
  const fspd = apSpeedSchedule(fm);

  // 「いまのピッチをそのまま保て」とだけ指示して、舵が暴れないかを見る
  const hold = (v) => {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 6000, 0); st.velocity.set(0, 0, -v);
    const sol = solveLevelTrim(fm, v, 6000);
    st.quaternion.setFromEuler(new THREE.Euler(sol.alphaDeg * Math.PI / 180, 0, 0, 'YXZ'));
    c.gearDown = false; c.parkingBrake = false; c.throttle = sol.throttle; c.trim = sol.trim;
    const want = st.pitchDeg;
    let t = 0, prev = 0, flips = 0, maxQ = 0;
    while (t < 20) {
      c.pitch = apElevatorForPitch(st, c, want, 1 / 60, fspd);
      advanceFlight(fm, st, c, noWind, flatGround, 1 / 60);
      t += 1 / 60;
      if (t > 2) {
        if (prev * c.pitch < 0) flips++;
        prev = c.pitch; maxQ = Math.max(maxQ, Math.abs(st.angularVelocity.x));
      }
    }
    return { flips, maxQ };
  };
  const slowHold = hold(200 / 1.94384);
  const fastHold = hold(fspd.cruise);
  note('舵のゲイン', `${(fspd.cruise * 1.94384).toFixed(0)}kt で 符号反転${fastHold.flips}回/18秒`
    + ` 最大ピッチ角速度${fastHold.maxQ.toFixed(2)}rad/s（補正前は764回・3.67rad/s）`);
  check(fastHold.flips < 20, '速い機体でも、舵が毎コマ逆へ振り切れない',
    `${fastHold.flips}回/18秒`);
  check(fastHold.maxQ < 1.0, '速い機体でも、ピッチ角速度が暴れない',
    fastHold.maxQ.toFixed(2) + 'rad/s');
  check(slowHold.flips < 20, '同じ機体を遅く飛ばしたときも静かなまま',
    `${slowHold.flips}回/18秒`);

  // 低速側は「今までどおり」でなければならない（絞りすぎると効かなくなる）
  const slowModel = model; // 内蔵の練習機
  const sspd = apSpeedSchedule(slowModel);
  const sst = createFlightState();
  sst.velocity.set(0, 0, -sspd.cruise);
  sst.angularVelocity.set(0.05, 0, 0);
  const sc = createFlightControls();
  const withSpd = apElevatorForPitch(sst, sc, sst.pitchDeg + 5, 0, sspd);
  const withoutSpd = apElevatorForPitch(sst, sc, sst.pitchDeg + 5, 0);
  check(Math.abs(withSpd - withoutSpd) < 1e-12, '低速の機体では、舵の効きが以前とまったく変わらない',
    `${withSpd.toFixed(6)} / ${withoutSpd.toFixed(6)}`);
  check(apSurfaceGain({ airspeed: sspd.stall * 2 }, sspd) === 1, '失速速度の2倍では、ゲインを絞らない');
  check(apSurfaceGain({ airspeed: sspd.stall * 8 }, sspd) < 0.3, '失速速度の8倍では、ゲインを大きく絞る',
    apSurfaceGain({ airspeed: sspd.stall * 8 }, sspd).toFixed(3));

  // 旋回と高度維持がケンカしない（速い機体を、水平トリムから90°旋回させる）
  {
    const v = 300 / 1.94384;
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 6000, 0); st.velocity.set(0, 0, -v);
    const sol = solveLevelTrim(fm, v, 6000);
    st.quaternion.setFromEuler(new THREE.Euler(sol.alphaDeg * Math.PI / 180, 0, 0, 'YXZ'));
    c.gearDown = false; c.parkingBrake = false; c.throttle = sol.throttle; c.trim = sol.trim;
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = 6000; ap.phase = 'cruise'; ap.destAirportId = 'DST';
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 400000, z: 0, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 90 }, 0);
    let t = 0, worst = 0;
    while (t < 240) {
      stepAutopilot(fm, st, c, ap, 1 / 60, {});
      advanceFlight(fm, st, c, noWind, flatGround, 1 / 60);
      t += 1 / 60;
      worst = Math.max(worst, Math.abs(st.altitudeM - 6000));
      if (st.crashed) break;
    }
    note('旋回と高度維持', `速い機体で90°旋回中の高度ずれ 最大${worst.toFixed(0)}m（補正前は1556m）`);
    check(worst < 200 && !st.crashed, '速い機体でも、旋回しながら高度を保てる',
      `最大${worst.toFixed(0)}m`);
  }
}

// --- 届かない目標高度でも、降下が間に合う ----------------------------------------
//
// 上昇を抜ける条件が「目標高度に届いた」だけだったので、機体が上がれない
// 高さを設定されると（高度スライダーは12000mまで動く）上昇のまま帰ってこず、
// 降下も進入も始まらないまま目的地を通り過ぎていた。
{
  const runTo = (targetAltM, distKm, limitSec) => {
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(model, st, 0, 0, 90, flatGround);
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = targetAltM; ap.destAirportId = 'DST';
    ap.plan = apMakeApproachPlan({ id: 'DST', x: distKm * 1000, z: 0, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 90 }, 0);
    ap.takeoffHeadingDeg = 90; ap.phase = 'takeoff';
    let t = 0, peak = 0;
    while (t < limitSec) {
      stepAutopilot(model, st, c, ap, 1 / 60, {});
      advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
      t += 1 / 60; peak = Math.max(peak, st.altitudeM);
      if (ap.phase === 'done' || st.crashed) break;
    }
    return { ap, st, t, peak };
  };

  // 練習機の上昇限度は約2900〜5400m。届く目標はこれまでどおり。
  const ok = runTo(1500, 60, 4000);
  check(ok.ap.phase === 'done' && !ok.st.crashed, '届く目標高度なら、これまでどおり着陸できる',
    `${ok.ap.phase} / ${ok.t.toFixed(0)}秒 / 最高${ok.peak.toFixed(0)}m`);

  // ルートが短ければ、目標に届く前でも降下へ切り上げる
  const short = runTo(6000, 60, 4000);
  note('上昇の切り上げ', `目標6000m・経路60km … ${short.ap.phase} ${short.t.toFixed(0)}秒 最高${short.peak.toFixed(0)}m`);
  check(short.ap.phase === 'done' && !short.st.crashed,
    '届かない目標高度でも、ルートの長さで上昇を切り上げて着陸できる',
    `${short.ap.phase} / ${short.t.toFixed(0)}秒`);
  check(short.peak < 6000, 'そのとき、目標高度まで無理に上ろうとしない',
    `最高${short.peak.toFixed(0)}m`);

  // 上昇限度そのものの検出。実機で当てようとすると、上昇限度に届くまで
  // 数千秒ぶん回すことになる（検証が100秒近くかかる）ので、
  // 「上がれない状態」を直接こしらえて、上昇の段だけを回す。
  {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 4000, 0);
    st.velocity.set(0, 0.2, -60);   // 上昇率0.2m/s ＝ もう上がれない
    c.gearDown = false; c.parkingBrake = false;
    advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = 12000; ap.destAirportId = 'DST';
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 600000, z: 0, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 90 }, 0);
    ap.phase = 'climb';
    let t = 0, atTen = null;
    while (t < 60 && ap.phase === 'climb') {
      stepAutopilot(model, st, c, ap, 1 / 60, {});
      // 高度も上昇率も動かさない（上がれない状態のまま張り付かせる）
      st.verticalSpeed = 0.2;
      t += 1 / 60;
      if (atTen === null && t > 10) atTen = ap.phase;
    }
    note('上昇限度', `上昇率0.2m/sのまま ${t.toFixed(0)}秒で ${ap.phase}`
      + ` 打ち切り=${!!ap.ceilingLimited} 巡航高度=${ap.targetAltitudeM}m`);
    check(atTen === 'climb', '一瞬上昇率が落ちただけでは、上昇を切り上げない', `10秒後: ${atTen}`);
    check(ap.phase === 'cruise' && ap.ceilingLimited === true,
      '上がれなくなったら、そこを巡航高度として受け入れる',
      `${ap.phase} / ${t.toFixed(0)}秒 / 巡航${ap.targetAltitudeM}m`);
    check(Math.abs(ap.targetAltitudeM - st.altitudeM) < 100,
      'そのとき、目標高度は実際に届いた高さに書き換わる',
      `${ap.targetAltitudeM}m vs ${st.altitudeM.toFixed(0)}m`);
  }
}

// --- 推力が桁外れでも、離陸滑走で機首が滑走路にめり込まない -----------------------
//
// 脚のばねの硬さも、めり込みを止める垂直抗力の上限も「重さの何倍」で決めていた。
// 脚が受け止めるのは重さだけではなく、そのとき機体に掛かっている力ぜんぶで、
// 推力が重さの何倍もある機体は、推力の作用線が重心より上にあるぶん機首下げの
// モーメントが出る。重さぶんの硬さしかない脚ではそれを支えられず、
// 離陸滑走中に機首が滑走路へめり込んでいた。
{
  const rows = [];
  for (const [label, mul] of [['ふつう', 1], ['7倍', 20], ['14倍', 40], ['21倍', 60]]) {
    const cfg = defaultAircraftConfig();
    cfg.name = `滑走試験機${label}`;
    cfg.modelMaxSpeedValue = 3; cfg.modelMaxSpeedUnit = 'mach';
    for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= mul;
    const gm = buildAircraftModel(cfg);
    const tw = gm.totalThrustN / (gm.massKg * FLIGHT_GRAVITY_FOR_TEST);
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(gm, st, 0, 0, 90, flatGround);
    const restY = st.position.y;
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = 3000; ap.destAirportId = 'DST';
    ap.phase = 'takeoff'; ap.takeoffHeadingDeg = 90;
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 60000, z: 0, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 90 }, 0);
    let t = 0, sink = 0, worstPitch = 0;
    while (t < 30 && ap.phase === 'takeoff' && !st.crashed) {
      stepAutopilot(gm, st, c, ap, 1 / 60, { groundHeightAt: flatGround });
      advanceFlight(gm, st, c, noWind, flatGround, 1 / 60);
      t += 1 / 60;
      if (st.onGround) {
        sink = Math.max(sink, restY - st.position.y);
        worstPitch = Math.min(worstPitch, st.pitchDeg);
      }
    }
    rows.push(`推力${label}:沈み${sink.toFixed(2)}m/ピッチ${worstPitch.toFixed(0)}°`);
    check(sink < 0.5, `推力が重さの${label}でも、離陸滑走で機首が滑走路にめり込まない`,
      `T/W${tw.toFixed(1)} 沈み${sink.toFixed(2)}m ピッチ${worstPitch.toFixed(0)}°`);
  }
  note('離陸滑走の沈み込み', rows.join('  '));
}

// --- 地面が上がってきたら越える／低いところでは深く傾けない -----------------------
//
// 自動操縦は設定した高度（海面から）を保つだけで、下の地面が上がってきても
// 知らんぷりだった（実測：30km先に標高2500mの尾根、目標高度1500mで、
// 対地高度-1mまでめり込んだ）。前方の地面を見て、越えるのに要る高度と昇降率を
// 出して底上げする。あわせて、離陸直後に深く傾けて沈むのを防ぐ。
{
  // 30km地点を頂点にした、標高2500mの尾根
  const ridge = (x, z) => {
    const d = Math.hypot(x - 30000, z);
    if (d > 15000) return 0;
    return 2500 * 0.5 * (1 + Math.cos(Math.PI * d / 15000));
  };
  const fly = (m, withTerrain) => {
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(m, st, 0, 0, 90, ridge);
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = 1500; ap.destAirportId = 'DST';
    ap.phase = 'takeoff'; ap.takeoffHeadingDeg = 90;
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 60000, z: 0, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 90 }, 0);
    const env = withTerrain ? { groundHeightAt: ridge } : {};
    let t = 0, minOverHill = Infinity, airborne = false;
    while (t < 5000) {
      stepAutopilot(m, st, c, ap, 1 / 60, env);
      advanceFlight(m, st, c, noWind, ridge, 1 / 60);
      t += 1 / 60;
      if (!airborne && !st.onGround && st.altitudeAglM > 30) airborne = true;
      // 山の上（標高100m超）にいるあいだの対地高度だけを見る
      if (airborne && !st.onGround && ridge(st.position.x, st.position.z) > 100) {
        minOverHill = Math.min(minOverHill, st.altitudeAglM);
      }
      if (st.crashed || ap.phase === 'done') break;
    }
    return { minOverHill, phase: ap.phase, crashed: st.crashed, t };
  };

  const cfg = defaultAircraftConfig();
  cfg.name = '地形試験機';
  cfg.modelMaxSpeedValue = 2; cfg.modelMaxSpeedUnit = 'mach';
  for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 10;
  const tm = buildAircraftModel(cfg);

  const blind = fly(tm, false);
  const seeing = fly(tm, true);
  note('山越え', `地面を見ない: 山の上で${blind.minOverHill.toFixed(0)}m`
    + ` / 見る: ${seeing.minOverHill.toFixed(0)}m（尾根は標高2500m、目標高度は1500m）`);
  check(blind.minOverHill < 50,
    'この経路は、地面を見なければ山に突っ込む（テストが効いていることの確認）',
    blind.minOverHill.toFixed(0) + 'm');
  check(seeing.minOverHill > 150, '前方の地面が上がってきたら、越えるだけ上る',
    seeing.minOverHill.toFixed(0) + 'm');
  check(seeing.phase === 'done' && !seeing.crashed, '山を越えたあとも、ちゃんと着陸できる',
    `${seeing.phase} / ${seeing.t.toFixed(0)}秒`);

  // 対地高度が低いうちは深く傾けない
  check(apBankAglFactor({ onGround: false, altitudeAglM: 30 }) === 0,
    '対地30mでは、まったく傾けない');
  check(apBankAglFactor({ onGround: true, altitudeAglM: 500 }) === 0,
    '接地しているあいだは傾けない');
  const mid = apBankAglFactor({ onGround: false, altitudeAglM: 180 });
  check(mid > 0 && mid < 1, '対地180mでは、上限の途中まで', mid.toFixed(2));
  check(apBankAglFactor({ onGround: false, altitudeAglM: 500 }) === 1,
    '対地500mまで上がれば、上限いっぱいまで使える');

  // 実際に、180°の旋回が要る経路で離陸してみる
  {
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(tm, st, 0, 0, 90, flatGround);
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = 3000; ap.destAirportId = 'DST';
    ap.phase = 'takeoff'; ap.takeoffHeadingDeg = 90;
    ap.plan = apMakeApproachPlan({ id: 'DST', x: -60000, z: 0, elevationM: 0 },
      { runwayLengthM: 2400, headingDeg: 270 }, 0);
    let t = 0, bankLow = 0, bankHigh = 0;
    while (t < 400 && ap.phase !== 'cruise' && !st.crashed) {
      stepAutopilot(tm, st, c, ap, 1 / 60, { groundHeightAt: flatGround });
      advanceFlight(tm, st, c, noWind, flatGround, 1 / 60);
      t += 1 / 60;
      if (!st.onGround && ap.phase !== 'takeoff') {
        if (st.altitudeAglM < AP_BANK_AGL_LO_FOR_TEST) bankLow = Math.max(bankLow, Math.abs(st.rollDeg));
        else if (st.altitudeAglM > 400) bankHigh = Math.max(bankHigh, Math.abs(st.rollDeg));
      }
    }
    note('離陸直後のバンク', `対地60m未満で${bankLow.toFixed(0)}° / 対地400m超で${bankHigh.toFixed(0)}°`);
    check(bankLow < 3, '離陸してすぐ、対地高度が低いうちは傾けない（沈んで地面に触る）',
      bankLow.toFixed(0) + '°');
    check(bankHigh > 10, '高度が取れたら、ふつうに旋回する', bankHigh.toFixed(0) + '°');
  }
}

// --- 計算の速さ ---------------------------------------------------------------
{
  const st = createFlightState();
  const c = createFlightControls();
  st.position.set(0, 1000, 0); st.velocity.set(0, 0, -60);
  c.parkingBrake = false; c.throttle = 0.7;
  const N = 3000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) advanceFlight(model, st, c, noWind, flatGround, 1 / 60);
  const ms = Date.now() - t0;
  note('計算コスト', `1フレーム ${(ms / N).toFixed(3)}ms（60fpsぶん${N}回で${ms}ms）`);
  check(ms / N < 1.0, '1フレームの物理が十分速い', (ms / N).toFixed(3) + 'ms');
}

console.log(`\n${failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`}`);
process.exit(failures === 0 ? 0 : 1);
