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
  settleAircraftOnGround,
  airDensityAt, solveLevelTrim, vtolClimbSpeedLimit, accumulateAeroForces, refreshFlightReadouts,
  createAutopilotState, stepAutopilot, apSpeedSchedule, apMakeApproachPlan,
  apPickRunwayHeading, apTrackPosition, apWrap180, apBearingTo, apBankMaxFor,
  apElevatorForPitch, apSurfaceGain, apBankLimit, apBankAglFactor, apTerrainFloor,
  aircraftDragLengthM, apBankClimbFactor, apVsLimits, apTerrainEscapeVs, apVtolHoverAngles,
  apAileronForBank, apSpoilerCommand, apReverseCommand,
  aircraftBestClimb, apUpdateTerrainFloor,
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
    // 脚は浮いたら上げる（出したままだと抗力になる——10-flight.js の gearDragArea）
    c.gearDown = s.altitudeAglM < 15;
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
  // 舵の力が空力中心の**後ろ**に掛かるようになってから（10-flight.js の
  // hingeArmChord）、エレボンだけの機体でも重心の真上でピッチのモーメントは出る。
  // つまり「舵に腕が無い」はもう正しい診断ではない。この配置で本当に飛べない
  // 理由は**静安定が0%**であること——実測で、静安定0%の機体は自動操縦でも
  // 姿勢が発散し、重心を少し前へ出して9%にしただけで着陸できた。
  note('デルタ翼テスト機：重心＝空力中心', `静安定 ${perfOnAc.staticMarginPct.toFixed(0)}% MAC`);
  check(Math.abs(perfOnAc.staticMarginPct) < 1, '重心＝空力中心なら静安定はほぼ0%',
    perfOnAc.staticMarginPct.toFixed(1));
  check(perfOnAc.notes.some((n) => n.level === 'error' && n.text.includes('静安定')),
    'エラーとして「静安定がない」ことが出る');
  check(perfOnAc.elevatorPower > 1e-3, '重心の真上のエレボンでも、ピッチのモーメントは出る',
    perfOnAc.elevatorPower.toFixed(0));

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

// --- 脚の長さが脚ごとに揃っていない機体でも、召喚した瞬間に墜落判定にならない -------
//
// placeAircraftOnGround は「いちばん深い脚が接地する高さに水平で置く」だけなので、
// それより浅い脚は宙に浮いたまま出てしまう（実際のユーザー機体で、GLBから
// 取り込んだ前脚の関節・伸縮節がほかの脚より1m以上短く、前脚だけ浮いた状態で
// 出ていた）。支えを欠いた状態から物理が姿勢を直そうとして激しく弾み、
// 離陸すらしていないのに衝撃Gの墜落判定に触れる——
// 「召喚すると高い位置に出て落っこちて墜落判定になる」の正体がこれ。
// settleAircraftOnGround は、その激しい過渡応答をプレイヤーに見せる前に、
// 物理そのものを静かに数秒ぶん回して釣り合う姿勢へ収めてしまう。
{
  const FLIGHT_CRASH_G = 12, FLIGHT_CRASH_SINK_MPS = 9;
  // 実際の毎フレームループ（12-flight-mode.jsのupdateFlight）と同じ墜落判定で、
  // 静かに置いたあと何秒か経っても墜落しないかを確かめる
  const flyAndCheckCrash = (m, st) => {
    const c = createFlightControls();
    c.parkingBrake = true; c.gearDown = true; c.throttle = 0;
    let crashed = false, maxG = 0;
    for (let t = 0; t < 15 && !crashed; t += 1 / 60) {
      const sinkBefore = st.velocity.y;
      advanceFlight(m, st, c, noWind, flatGround, 1 / 60);
      if (st.onGround) {
        maxG = Math.max(maxG, Math.abs(st.loadFactor));
        if (Math.abs(st.loadFactor) > FLIGHT_CRASH_G
          || (sinkBefore < -FLIGHT_CRASH_SINK_MPS && st.contactCount > 0)) crashed = true;
      }
    }
    return { crashed, maxG };
  };

  // 大型機と同じ拡大（4倍・推力200倍）に、前脚だけ主脚よりずっと浅い脚を作る
  const cfg = defaultAircraftConfig();
  cfg.name = '前脚だけ浮いた大型機';
  cfg.modelMaxSpeedValue = 480; cfg.modelMaxSpeedUnit = 'kt';
  const S = 4; const scaleV = (v) => { v.x *= S; v.y *= S; v.z *= S; };
  scaleV(cfg.cg);
  for (const p of cfg.parts) {
    scaleV(p.position);
    if (p.props && p.props.corners) for (const k in p.props.corners) scaleV(p.props.corners[k]);
    if (p.props && p.props.span) p.props.span *= S;
    if (p.props && p.props.thrustKgf) p.props.thrustKgf *= 200;
  }
  const preModel = buildAircraftModel(cfg);
  const nose = cfg.parts.find((p) => p.id === 'g_nose');
  nose.position.y = preModel.gearHeight * 0.85; // 主脚より15%浅い＝深さの15%ぶん浮く
  const brokenModel = buildAircraftModel(cfg);

  const naive = createFlightState();
  placeAircraftOnGround(brokenModel, naive, 0, 0, 90, flatGround);
  const naiveResult = flyAndCheckCrash(brokenModel, naive);
  note('前脚が浮いた機体：水平に置いただけ',
    `${naiveResult.crashed ? '墜落' : '無事'}（最大${naiveResult.maxG.toFixed(1)}G）`);
  // 水平に決め打ちで置くと、浮いた脚が地面に届くまで落ちて弾む。
  // 墜落判定（12G）に届くかどうかは機体しだいなので、ここでは
  // 「静定しなければ確かに強く弾む」ことだけを確かめる（テストが効いている確認）。
  check(naiveResult.maxG > 4, 'この機体は、水平へ決め打ちで置くと接地で強く弾む（テストが効いている確認）',
    `${naiveResult.maxG.toFixed(1)}G`);

  const settled = createFlightState();
  placeAircraftOnGround(brokenModel, settled, 0, 0, 90, flatGround);
  settleAircraftOnGround(brokenModel, settled, flatGround);
  const settledResult = flyAndCheckCrash(brokenModel, settled);
  note('前脚が浮いた機体：静定させてから置く',
    `${settledResult.crashed ? '墜落' : '無事'}（最大${settledResult.maxG.toFixed(1)}G） `
    + `姿勢=ピッチ${settled.pitchDeg.toFixed(1)}°`);
  check(!settledResult.crashed, '静定させれば、同じ機体でも召喚しただけで墜落しない',
    `${settledResult.maxG.toFixed(1)}G`);
  check(settledResult.maxG < naiveResult.maxG * 0.5, '衝撃そのものも大きく減っている',
    `${settledResult.maxG.toFixed(1)}G < ${(naiveResult.maxG * 0.5).toFixed(1)}G`);

  // --- 軽い機体に大推力を積んでも、脚のばねが硬くなりすぎて弾け飛ばない ---
  //
  // 脚のばねの硬さを「推力そのもの」で決めていたときは、1トン級の軽い機体に
  // 大推力を積んだ瞬間にばねが桁違いに硬くなり、1/240秒の刻みでは積分が持たず、
  // 滑走路に置いただけで弾け飛んでいた（実測：推力10倍で84G、100倍では
  // 1176G・上下90m/s）。「最高速度を上げてエンジン出力もそれに合わせたら
  // もっとひどく弾む」という報告がこれ。
  // 脚が実際に受け止めるのは推力そのものではなく「推力のモーメント÷脚の間隔」
  // なので、そちらで硬さを決める（gearDesignLoadN）。
  {
    const rows = [];
    for (const mul of [1, 10, 100, 1000]) {
      const lightCfg = defaultAircraftConfig();
      lightCfg.name = `軽量大推力機×${mul}`;
      for (const p of lightCfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 60 * mul;
      const lm = buildAircraftModel(lightCfg);
      const tw = lm.totalThrustN / (lm.massKg * FLIGHT_GRAVITY_FOR_TEST);
      const st = createFlightState();
      placeAircraftOnGround(lm, st, 0, 0, 90, flatGround);
      settleAircraftOnGround(lm, st, flatGround);
      const r = flyAndCheckCrash(lm, st);
      rows.push(`T/W${tw.toFixed(0)}:${r.maxG.toFixed(1)}G`);
      check(!r.crashed && r.maxG < 3,
        `推力/重量${tw.toFixed(0)}倍でも、滑走路に置いただけで弾け飛ばない`,
        `${r.crashed ? '墜落 ' : ''}最大${r.maxG.toFixed(1)}G`);
    }
    note('軽い機体に大推力', rows.join('  ') + '（以前は推力10倍で84G、100倍で1176G）');
  }

  // 素直な脚（内蔵の練習機・さっきの大型機そのもの）では、静定してもほとんど動かない
  const plainModel = buildAircraftModel(defaultAircraftConfig());
  const plainNaive = createFlightState();
  placeAircraftOnGround(plainModel, plainNaive, 0, 0, 90, flatGround);
  const plainSettled = createFlightState();
  placeAircraftOnGround(plainModel, plainSettled, 0, 0, 90, flatGround);
  settleAircraftOnGround(plainModel, plainSettled, flatGround);
  const drift = Math.abs(plainNaive.position.y - plainSettled.position.y);
  note('練習機：静定による変化', `高さ${drift.toFixed(3)}m ピッチ${Math.abs(plainNaive.pitchDeg - plainSettled.pitchDeg).toFixed(2)}°`);
  check(drift < 0.1, '素直な脚の機体では、静定してもほとんど動かない（無駄に暴れない）',
    drift.toFixed(3) + 'm');

  // 3本目の脚がどうやっても届かない（2本の脚だけがX方向に並んでいて、
  // ピッチ方向にまったく支えが無い）ような、直しようのない機体では、
  // 静定を諦めて元の水平placementのままにする
  const hopelessCfg = defaultAircraftConfig();
  hopelessCfg.name = '前脚が遠く離れて浮いた機体';
  scaleV(hopelessCfg.cg);
  for (const p of hopelessCfg.parts) {
    scaleV(p.position);
    if (p.props && p.props.corners) for (const k in p.props.corners) scaleV(p.props.corners[k]);
    if (p.props && p.props.span) p.props.span *= S;
    if (p.props && p.props.thrustKgf) p.props.thrustKgf *= 200;
  }
  const preHopeless = buildAircraftModel(hopelessCfg);
  const hopelessNose = hopelessCfg.parts.find((p) => p.id === 'g_nose');
  hopelessNose.position.y = preHopeless.gearHeight * 0.5;
  hopelessNose.position.z = 8; // 重心から遠く、主脚2本の並びからも外れた位置
  const hopelessModel = buildAircraftModel(hopelessCfg);
  const hopeless = createFlightState();
  placeAircraftOnGround(hopelessModel, hopeless, 0, 0, 90, flatGround);
  const beforeY = hopeless.position.y, beforePitch = hopeless.pitchDeg;
  settleAircraftOnGround(hopelessModel, hopeless, flatGround);
  note('直しようのない機体（前脚が遠くて2本足状態）',
    `静定前y=${beforeY.toFixed(2)} → 静定後y=${hopeless.position.y.toFixed(2)}（差${Math.abs(hopeless.position.y - beforeY).toFixed(2)}m）`);
  check(Math.abs(hopeless.position.y - beforeY) < 0.01
    && Math.abs(hopeless.pitchDeg - beforePitch) < 0.01,
    '支えようがない機体では、静定をあきらめて元の水平placementのまま残す',
    `y差${Math.abs(hopeless.position.y - beforeY).toFixed(3)}m`);
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

// --- 旋回中は登れなくなる／やり直し・進入も地形を見る ------------------------------
//
// 「旋回中に墜落しやすい、とくに降下中の旋回で、地面が近いのに曲がり続けて
// 登ろうとしない」という報告を、実測しながら追いかけた。
{
  // (1) バンク角φは水平を保つだけで揚力を1/cosφ倍に増やす必要があり、
  //     誘導抗力がその2乗で増えるぶん、登る/降りるための力が残らない。
  //     実測（内蔵の練習機、指示+3m/s）：
  //       0°→実際2.5m/s（ほぼ指示どおり）　30°→0.5m/s（8割減）　45°→ -1.5m/s（沈む）
  //     地形を越えるのに要る昇降率（vsNeeded）が出せる上昇率に近づくほど、
  //     バンクを浅くして登るほうへ回す。
  check(apBankClimbFactor({ airspeed: 60 }, 0) === 1,
    '登る必要が無ければ、バンクはそのまま');
  check(apBankClimbFactor({ airspeed: 60 }, -5) === 1,
    '降りるだけなら、バンクはそのまま');
  const up = apVsLimits({ airspeed: 60 }).up;
  const none = apBankClimbFactor({ airspeed: 60 }, up * 0.01);
  const some = apBankClimbFactor({ airspeed: 60 }, up * 0.3);
  const most = apBankClimbFactor({ airspeed: 60 }, up * 0.9);
  note('バンクと登る余裕', `わずかに要る:${none.toFixed(2)} そこそこ要る:${some.toFixed(2)} かなり要る:${most.toFixed(2)}`);
  check(none > 0.95, '要る昇降率がわずかなら、バンクはほぼそのまま', none.toFixed(2));
  check(some < none && most < some, '要る昇降率が増えるほど、バンクは単調に浅くなる',
    `${none.toFixed(2)} > ${some.toFixed(2)} > ${most.toFixed(2)}`);
  check(most < 0.3, '出せる上昇率に迫るほど要るときは、ほぼ水平まで戻す', most.toFixed(2));

  // (2) やり直し（goaround）は、これまで地形をまったく見ていなかった。
  //     FAFへ戻る途中に山があれば、そのまま突っ込んでいた。
  {
    const ridge = (x, z) => (z < -3000 && z > -12000 ? 1200 : 0);
    const fly = () => {
      const st = createFlightState(), c = createFlightControls();
      st.position.set(0, 1800, 0); st.velocity.set(0, 0, -80);
      st.headingDeg = 0;
      const ap = createAutopilotState();
      ap.full = true; ap.phase = 'goaround'; ap.destAirportId = 'DST'; ap.targetAltitudeM = 1800;
      ap.plan = apMakeApproachPlan({ id: 'DST', x: 0, z: -20000, elevationM: 0 },
        { runwayLengthM: 2400, headingDeg: 0 }, 0);
      let minAgl = Infinity;
      for (let i = 0; i < 60 * 300; i++) {
        stepAutopilot(model, st, c, ap, 1 / 60, { groundHeightAt: ridge });
        advanceFlight(model, st, c, noWind, ridge, 1 / 60);
        if (ridge(st.position.x, st.position.z) > 100) minAgl = Math.min(minAgl, st.altitudeAglM);
        if (st.crashed) break;
      }
      return minAgl;
    };
    const minAgl = fly();
    note('やり直し中に山を越える', `尾根上の最低対地高度 ${minAgl.toFixed(0)}m`);
    check(minAgl > 100, 'やり直し（goaround）も、FAFへ戻る途中の山を越える', minAgl.toFixed(0) + 'm');
  }

  // (3) 最終進入区間（FAF〜滑走路）に山を挟む空港でも、突っ込まず、
  //     かつ「やり直し⇄進入」を1秒間に何度も往復する暴走にもならないこと。
  //     風は180°（headingDeg=0の滑走路がそのまま選ばれる向き）で固定する。
  {
    const flyApproach = (ridgeH, ridgeFarZ, seconds) => {
      const ridge = (x, z) => (z < -3000 && z > ridgeFarZ ? ridgeH : 0);
      const st = createFlightState(), c = createFlightControls();
      const ap = createAutopilotState();
      ap.full = true; ap.destAirportId = 'DST';
      ap.plan = apMakeApproachPlan({ id: 'DST', x: 0, z: -9000, elevationM: 0 },
        { runwayLengthM: 2400, headingDeg: 0 }, 180);
      st.position.set(0, ap.plan.fafAltM, ap.plan.faf.z + 200);
      st.velocity.set(0, 0, -80);
      st.headingDeg = ap.plan.heading;
      ap.phase = 'approach'; ap.targetAltitudeM = ap.plan.fafAltM;
      let minAgl = Infinity, transitions = 0, prev = 'approach', done = false, crashed = false, t = 0;
      for (; t < seconds; t += 1 / 60) {
        stepAutopilot(model, st, c, ap, 1 / 60, { groundHeightAt: ridge });
        advanceFlight(model, st, c, noWind, ridge, 1 / 60);
        if (ridge(st.position.x, st.position.z) > 100) minAgl = Math.min(minAgl, st.altitudeAglM);
        if (ap.phase !== prev) { transitions++; prev = ap.phase; }
        if (st.crashed) { crashed = true; break; }
        if (ap.phase === 'done') { done = true; break; }
      }
      return { minAgl, transitions, done, crashed, t, phase: ap.phase };
    };

    // 平らな地面（回帰確認）：これまでどおり素直に着陸できる
    const flat = flyApproach(0, -7000, 500);
    check(flat.done && !flat.crashed, '山が無ければ、これまでどおり進入して着陸する',
      `${flat.done ? '着陸' : (flat.crashed ? '墜落' : '未着陸')} t=${flat.t.toFixed(0)}秒`);

    // 小さい丘（150m、幅1000m）：滑走路まで十分距離を残して越え、そのまま着陸できる
    const hill = flyApproach(150, -4000, 800);
    check(hill.minAgl > 30, '進入経路上の小さい丘は、越えて安全な高さを保つ', hill.minAgl.toFixed(0) + 'm');
    check(hill.done && !hill.crashed, '小さい丘を越えたあとも、ちゃんと着陸できる',
      `t=${hill.t.toFixed(0)}秒`);

    // 大きな尾根（500m、幅4000m・滑走路の800m手前まで迫る）：3°経路には
    // どのみち収まりきらない配置なので着陸は求めない——越えきれず
    // やり直しを繰り返しても、突っ込まず、暴走もしないことだけを見る。
    const big = flyApproach(500, -7000, 1500);
    note('最終進入区間に大きな尾根がある空港', `段=${big.phase || '?'} 尾根上の最低対地高度 ${big.minAgl.toFixed(0)}m`
      + ` / ${big.t.toFixed(0)}秒での段の切り替え ${big.transitions}回`);
    check(!big.crashed, '越えきれない尾根でも突っ込まない', big.minAgl.toFixed(0) + 'm');
    check(big.minAgl > -20, '尾根の上を通るときも、対地高度が大きく負に振れない',
      big.minAgl.toFixed(0) + 'm');
    check(big.transitions < 20, '進入とやり直しを1秒に何度も往復する暴走にならない',
      `${big.transitions}回/${big.t.toFixed(0)}秒`);
  }
}

// --- 実機で見つかった壊れ方の作り直し -------------------------------------------
//
// ここから下は、実際に報告された機体（Boeing 747 / Concorde / サンダーバード1号2号）で
// 見つかった壊れ方を、**その機体を特徴づける数字だけ**で作り直したもの。
// 機体ファイルそのものはリポジトリに入れられないので、原因になった性質
// （取付角・重心と空力中心の位置関係・尾翼の有無・推力重量比・翼面荷重）を再現する。

// (1) 主翼と水平尾翼の取付角が大きい大型機は、どの速度でも釣り合うこと。
//     実機の747は主翼+4.3°・水平尾翼-3.8°で、迎角0でも+9.4MN·mの機首上げが出る。
//     トリムがエレベーターと同じ舵を動かすだけだった頃は、全部倒しても足りず
//     「離陸すると頭が上がり続けて失速する」機体になっていた。
{
  const jet = defaultAircraftConfig();
  jet.name = '取付角の大きい大型機'; jet.modelWeightKg = 180000;
  jet.modelMaxSpeedValue = 560; jet.modelMaxSpeedUnit = 'kt';
  const S = 5.4;
  const scale = (v) => { v.x *= S; v.y *= S; v.z *= S; };
  scale(jet.cg);
  for (const p of jet.parts) {
    scale(p.position);
    if (p.props && p.props.corners) for (const k in p.props.corners) scale(p.props.corners[k]);
    if (p.props && p.props.span) p.props.span *= S;
    if (p.props && p.props.thrustKgf) p.props.thrustKgf *= 280;
    // 主翼を機首上げ、水平尾翼を機首下げに取り付ける（747と同じ向き・同じ大きさ）
    // 内蔵機の素の取付角（主翼+3.1° / 水平尾翼-1.1°）から、747と同じ
    // 主翼+4.3° / 水平尾翼-3.8° へ寄せる
    if (p.type === 'wing' && p.props && p.props.role === 'main') p.rotation.x = 1.2;
    if (p.type === 'wing' && p.props && p.props.role === 'htail') p.rotation.x = -2.7;
  }
  const jm = buildAircraftModel(jet);
  const jspd = apSpeedSchedule(jm);
  const inc = jm.surfaces.filter((s) => s.role !== 'vtail')
    .map((s) => `${s.role}${(s.incidenceRad * 180 / Math.PI).toFixed(1)}°`).join(' ');
  note('取付角の大きい大型機', `${jm.massKg.toLocaleString()}kg 翼${jm.wingArea.toFixed(0)}m² 取付角 ${inc}`);
  // 引き起こし速度は定義からして水平飛行できない速さなので、飛行の範囲だけ見る
  const speeds = [jspd.climb, jspd.approach, Math.min(jspd.cruise, jspd.stall * 4)];
  const solved = speeds.map((v) => solveLevelTrim(jm, v, 1000));
  check(solved.every((s) => s.ok), '取付角が大きくても、どの速度でも水平飛行の釣り合いが取れる',
    solved.map((s, i) => `${(speeds[i] * KT).toFixed(0)}kt:${s.ok ? '○' : '×' + s.reason}`).join(' '));
  // トリムが安定板まるごとを動かすので、エレベーター単独より効きが大きい
  const at = (pitch, trim) => {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 1000, 0); st.altitudeM = 1000;
    st.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(3), 0, 0, 'YXZ'));
    st.velocity.set(0, 0, -jspd.climb);
    c.pitch = pitch; c.trim = trim; c.throttle = 0; c.gearDown = false;
    const out = { force: new THREE.Vector3(), torque: new THREE.Vector3() };
    accumulateAeroForces(jm, st, c, noWind, out);
    return out.torque.x;
  };
  const elevOnly = Math.abs(at(-1, 0) - at(0, 0));
  const withTrim = Math.abs(at(-1, -1) - at(0, 0));
  note('安定板トリムの効き', `エレベーターだけ ${(elevOnly / 1e6).toFixed(1)}MN·m`
    + ` → トリムも足すと ${(withTrim / 1e6).toFixed(1)}MN·m`);
  check(withTrim > elevOnly * 1.2, 'トリムは安定板まるごとを動かすので、エレベーター単独より効く',
    `${(withTrim / elevOnly).toFixed(2)}倍`);
}

// (2) 水平尾翼を持たない機体（エレボン）は、重心の真上でもピッチの舵が効き、
//     失速しかけても**逆には効かない**こと。実機のConcordeがこれで背面に回っていた。
{
  const wing = (side, sign) => ({
    id: 'w_' + side, type: 'wing', name: '主翼', position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { role: 'main', corners: {
      // 後退角の強いデルタ翼（Concordeと同じくらい）
      rootLeading: { x: 0, y: 0, z: -8 }, rootTrailing: { x: 0, y: 0, z: 4 },
      tipLeading: { x: sign * 9, y: 0, z: 3 }, tipTrailing: { x: sign * 9, y: 0, z: 4 },
    } },
  });
  const delta = buildAircraftModel({
    name: 'デルタ機', modelWeightKg: 100000, modelMaxSpeedValue: 1300, modelMaxSpeedUnit: 'kt',
    cg: { x: 0, y: 0, z: 0 }, parts: [wing('r', 1), wing('l', -1)],
  });
  const w = delta.surfaces.find((s) => s.role === 'main');
  note('デルタ機（尾翼なし）', `主翼の空力中心 z=${w.center.z.toFixed(2)}m`
    + ` 後退角ぶんの迎角の倍率 ×${w.alphaGain.toFixed(2)}`);
  const M = (alphaDeg, el) => {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 1000, 0); st.altitudeM = 1000;
    st.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(alphaDeg), 0, 0, 'YXZ'));
    st.velocity.set(0, 0, -90);
    c.pitch = el; c.throttle = 0; c.gearDown = false;
    const out = { force: new THREE.Vector3(), torque: new THREE.Vector3() };
    accumulateAeroForces(delta, st, c, noWind, out);
    return out.torque.x;
  };
  check(Math.abs(M(0, 1)) > 1e4, '重心の真上のエレボンでも、ピッチのモーメントが出る',
    (M(0, 1) / 1e6).toFixed(2) + 'MN·m');
  const angles = [0, 3, 6, 9, 12, 15];
  const worst = angles.map((a) => M(a, -1) - M(a, 0)).reduce((x, y) => Math.max(x, y), -Infinity);
  note('エレボンの効き（機首下げを当てたとき）',
    angles.map((a) => `${a}°:${((M(a, -1) - M(a, 0)) / 1e6).toFixed(2)}`).join(' '));
  check(worst <= 0, '失速しかけても、機首下げの舵が機首上げに反転しない',
    (worst / 1e6).toFixed(3) + 'MN·m');
  // 重心の真上にある翼でも、回転を止める力が出る（Cmq）
  const damp = (q) => {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 1000, 0); st.altitudeM = 1000;
    st.velocity.set(0, 0, -90); st.angularVelocity.set(q, 0, 0);
    c.throttle = 0; c.gearDown = false;
    const out = { force: new THREE.Vector3(), torque: new THREE.Vector3() };
    accumulateAeroForces(delta, st, c, noWind, out);
    return out.torque.x;
  };
  check(damp(0.4) < damp(0) - 1e4, '重心の真上にある翼でも、ピッチの回転が減衰する',
    `q=0.4rad/s で ${((damp(0.4) - damp(0)) / 1e6).toFixed(3)}MN·m`);
}

// (3) 壊れたエンジン取付角は捨て、正しい取付角は残すこと。
{
  const tilted = (deg) => {
    const c = defaultAircraftConfig();
    for (const p of c.parts) {
      if (p.type !== 'engine') continue;
      p.position.y = -1.5;         // 重心より下に付ける＝推力が機首上げのモーメントを生む
      p.rotation.x = deg;
    }
    return buildAircraftModel(c);
  };
  const moment = (m) => {
    let t = 0;
    for (const e of m.engines) {
      if (e.lift) continue;
      t += e.position.y * (e.axis.z * e.thrustN) - e.position.z * (e.axis.y * e.thrustN);
    }
    return t;
  };
  const flat = moment(tilted(0));
  // 打ち消す向きの取付角を、実際に探して確かめる
  let best = 0, bestAbs = Math.abs(flat);
  for (let d = -60; d <= 60; d += 0.5) {
    const v = Math.abs(moment(tilted(d)));
    if (v < bestAbs) { bestAbs = v; best = d; }
  }
  note('エンジン取付角', `取付角0で ${(flat / 1000).toFixed(1)}kN·m / 打ち消す角度 ${best.toFixed(1)}°`);
  check(Math.abs(moment(tilted(best))) < Math.abs(flat) * 0.5,
    '打ち消す向きの取付角はそのまま効く', (moment(tilted(best)) / 1000).toFixed(1) + 'kN·m');
  check(tilted(best).engineTiltIgnored === false, '正しい取付角は捨てられない');
  check(Math.abs(moment(tilted(-best))) <= Math.abs(flat) + 1,
    '逆向き（モーメントを増やす）の取付角は捨てられる',
    (moment(tilted(-best)) / 1000).toFixed(1) + 'kN·m');
  check(tilted(-best).engineTiltIgnored === true, '捨てたことが機体に記録される');
}

// (4) 出した脚は抗力になる（自動操縦が減速に使う）
{
  const drag = (gear) => {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 1000, 0); st.altitudeM = 1000;
    st.velocity.set(0, 0, -80);
    c.throttle = 0; c.gearDown = gear;
    const out = { force: new THREE.Vector3(), torque: new THREE.Vector3() };
    accumulateAeroForces(model, st, c, noWind, out);
    return out.force.z;
  };
  note('脚の抗力', `脚上げ ${(drag(false)).toFixed(0)}N → 脚下げ ${(drag(true)).toFixed(0)}N`);
  check(drag(true) > drag(false) * 1.1, '脚を出すと抗力が増える',
    `${(drag(true) / drag(false)).toFixed(2)}倍`);
}

// (5) 平らな地面の上で、地形回避が降下を止めないこと。
//     vsNeed は「越えるのに要る上昇率」なので、地面が下にあるときは効かせてはいけない。
{
  const st = createFlightState();
  st.position.set(0, 3000, 0); st.altitudeM = 3000;
  st.velocity.set(0, -10, -140);
  st.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));
  const flatFloor = apTerrainFloor(st, { groundHeightAt: flatGround }, 300);
  note('平らな地面の上での地形回避', `床 ${flatFloor.floorM.toFixed(0)}m / 要る上昇率 ${flatFloor.vsNeed}`);
  check(flatFloor.vsNeed === -Infinity, '地面より高いところでは、降下の下限を作らない',
    String(flatFloor.vsNeed));
  // 山があるときは、ちゃんと上昇率を要求する
  // 機体は -Z（北）へ飛んでいるので、その先に尾根を置く
  const ridge = (x, z) => (-z > 5000 && -z < 20000 ? 4000 : 0);
  const overRidge = apTerrainFloor(st, { groundHeightAt: ridge }, 300);
  check(overRidge.vsNeed > 0, '前方に山があれば、越えるのに要る上昇率を出す',
    overRidge.vsNeed.toFixed(1) + 'm/s');
}

// (6) 目的地までに落としきれない速さでは巡航しないこと。
{
  const rocketCfg = defaultAircraftConfig();
  rocketCfg.name = '翼が小さくて推力が桁外れな機体';
  rocketCfg.modelWeightKg = 140000;
  rocketCfg.modelMaxSpeedValue = 21; rocketCfg.modelMaxSpeedUnit = 'mach';
  for (const p of rocketCfg.parts) {
    if (p.props && p.props.thrustKgf) p.props.thrustKgf *= 100000;
  }
  const rm = buildAircraftModel(rocketCfg);
  const L = aircraftDragLengthM(rm);
  const far = apSpeedSchedule(rm, 2000000);  // 2000km 先
  const near = apSpeedSchedule(rm, 80000);   // 80km 先
  note('抗力長さと巡航速度', `L=${(L / 1000).toFixed(0)}km`
    + ` / 2000km先なら${(far.cruise * KT).toFixed(0)}kt / 80km先なら${(near.cruise * KT).toFixed(0)}kt`);
  check(near.cruise < far.cruise, '目的地が近いほど、落としきれる速さまで巡航を絞る',
    `${(near.cruise * KT).toFixed(0)}kt < ${(far.cruise * KT).toFixed(0)}kt`);
  check(near.cruise <= near.approach * Math.exp(80000 * 0.5 / L) * 1.01,
    '巡航速度は「残りの半分で進入速度まで落とせる速さ」に収まる',
    `${(near.cruise * KT).toFixed(0)}kt`);
}

// (7) 沈み始めたら、速度超過中でも出力を戻す（NOVA→NORIでTB2が実際に見つけた壊れ方）。
//
// 推力重量比が桁外れな機体は、離陸直後に曲がれる速さの何倍もへ加速し、
// climb/cruiseの「曲がれる速さの1.5倍を超えたら出力を絞る」判定で出力0%のまま
// 姿勢だけで登る（＝運動エネルギーを高度へ変えるズームクライム）。エネルギーを
// 使い切って昇降率が負に転じても、速度がまだ超過しているというだけで出力0%が
// 続くと、あとは沈むだけになる——実測（推力重量比30・翼面荷重2160kg/m²の
// フィクション機、目標高度12000m）で、対地3500m付近まで無出力のズームクライムで
// 上がったあと、そのまま無出力で降下に転じ、高度を全部失って墜落していた。
{
  const cfg = defaultAircraftConfig();
  cfg.name = '推力過剰機（沈み込みテスト）';
  for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 60;
  const m2 = buildAircraftModel(cfg);

  const mkState = (vs, altitudeM) => {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, altitudeM, 0); st.altitudeM = altitudeM;
    st.airspeed = 500; st.groundSpeed = 500; st.verticalSpeed = vs;
    st.headingDeg = 90; st.pitchDeg = 5;
    return { st, c };
  };
  const ap = createAutopilotState();
  ap.full = true; ap.destAirportId = 'DST'; ap.targetAltitudeM = 12000;
  ap.plan = apMakeApproachPlan({ id: 'DST', x: 100000, z: 0, elevationM: 0 },
    { runwayLengthM: 2400, headingDeg: 90 }, 270);

  const climbAt = (vs) => {
    ap.phase = 'climb';
    const { st, c } = mkState(vs, 3000);
    stepAutopilot(m2, st, c, ap, 1 / 60, {});
    return c.throttle;
  };
  const tClimbing = climbAt(50), tSinking = climbAt(-15);
  note('上昇中・速度超過での出力', `登り(+50m/s):${(tClimbing * 100).toFixed(0)}%`
    + ` 沈み(-15m/s):${(tSinking * 100).toFixed(0)}%`);
  check(tClimbing < 0.3, '順調に登っているあいだは、速度超過なら出力を絞ったまま',
    (tClimbing * 100).toFixed(0) + '%');
  check(tSinking > 0.5, '沈み始めたら、速度超過中でも出力を戻す',
    (tSinking * 100).toFixed(0) + '%');

  // 昇降率0付近で出力が0%⇔100%を往復しない（しきい値の二値判定だと往復する——
  // 実測でこの往復が原因で速度超過カットが平均半分しか効かず、かえって加速し続けた）
  const near = [-2, -1, 0, 1, 2].map((vs) => climbAt(vs));
  const jumps = near.slice(1).map((v, i) => Math.abs(v - near[i]));
  check(Math.max(...jumps) < 0.3, '昇降率0付近で出力が飛び石にならない（往復のもと）',
    near.map((v) => (v * 100).toFixed(0)).join('→') + '%');

  const cruiseAt = (vs, altitudeM) => {
    ap.phase = 'cruise';
    const { st, c } = mkState(vs, altitudeM);
    stepAutopilot(m2, st, c, ap, 1 / 60, {});
    return c.throttle;
  };
  const tAboveSinking = cruiseAt(-15, 12500); // 目標より高いところを沈みながら戻る＝正常
  const tBelowSinking = cruiseAt(-15, 8000);  // 目標より低いのに沈んでいる＝危険
  note('巡航中・目標高度との関係での出力', `目標より高くて沈む:${(tAboveSinking * 100).toFixed(0)}%`
    + ` 目標より低くて沈む:${(tBelowSinking * 100).toFixed(0)}%`);
  check(tBelowSinking > tAboveSinking, '目標高度より低いのに沈んでいるときだけ、出力を余分に戻す',
    `${(tAboveSinking * 100).toFixed(0)}% < ${(tBelowSinking * 100).toFixed(0)}%`);
}

// (8) 山を越えるときは、機体が出せるだけ上げること。
//
// 「推力の大きい高速機が、標高の高い山で上昇が間に合わない。手で操縦すれば
// 急上昇できるのに」という報告。地形回避の指示昇降率が AP_CLIMB_DEG（7°）で
// 頭打ちになっていて、出せる上昇角（実測で T/W2.4 なら63°、T/W20 なら89°）の
// ごく一部しか使えていなかった。
{
  const fast = { airspeed: 300, verticalSpeed: 0 };
  const spd = { stall: 60, cruise: 400, approach: 78, bankMax: 30 };
  const normal = apVsLimits(fast).up;
  const escape = apTerrainEscapeVs(fast, spd);
  note('地形回避で許す上昇率', `ふだん ${normal.toFixed(0)}m/s（7°）`
    + ` → 山を越えるとき ${escape.toFixed(0)}m/s（${(Math.asin(escape / fast.airspeed) * 180 / Math.PI).toFixed(0)}°）`);
  check(escape > normal * 2, '速度に余裕があれば、ふだんよりずっと大きい上昇率を許す',
    `${escape.toFixed(0)} > ${normal.toFixed(0)}`);
  check(escape <= fast.airspeed * Math.sin(30 * Math.PI / 180) + 1e-6,
    '許すのは30°まで（青天井にはしない）', escape.toFixed(0) + 'm/s');
  // 速度の余裕が無いときは、ふだんの上限まで落ちる（失速側へは転ばない）
  const slow = { airspeed: 70, verticalSpeed: 0 };
  check(apTerrainEscapeVs(slow, spd) >= apVsLimits(slow).up - 1e-6,
    '余裕が無くても、ふだんの上限は下回らない');
  check(apTerrainEscapeVs(fast, undefined) === normal,
    '速度の表（spd）が無ければ、ふだんの上限のまま');

  // 離陸してすぐ前方に標高3800mの山。以前は突っ込んでいた距離で越えられること。
  {
    const cfg = defaultAircraftConfig();
    cfg.modelMaxSpeedValue = 2; cfg.modelMaxSpeedUnit = 'mach';
    for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 7;
    const m2 = buildAircraftModel(cfg);
    const startM = 12000, topM = 3800;
    const ridge = (x, z) => (z <= -startM && z >= -(startM + 20000)) ? topM : 0;
    const st = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(m2, st, 0, 0, 0, ridge);
    settleAircraftOnGround(m2, st, ridge);
    const ap = createAutopilotState();
    ap.full = true; ap.phase = 'takeoff'; ap.takeoffHeadingDeg = 0;
    ap.targetAltitudeM = 2000; ap.destAirportId = 'DST';
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 0, z: -200000, elevationM: 0 },
      { runwayLengthM: 3000, headingDeg: 0 }, 180);
    let t = 0, minAgl = Infinity, crashed = false, passed = false, maxPitch = -99;
    for (; t < 600; t += 1 / 60) {
      stepAutopilot(m2, st, c, ap, 1 / 60, { groundHeightAt: ridge });
      advanceFlight(m2, st, c, noWind, ridge, 1 / 60);
      if (ridge(st.position.x, st.position.z) > 100) minAgl = Math.min(minAgl, st.altitudeAglM);
      maxPitch = Math.max(maxPitch, st.pitchDeg || 0);
      if (st.crashed) { crashed = true; break; }
      if (st.position.z < -(startM + 21000)) { passed = true; break; }
    }
    note('離陸12km先の標高3800mの山', `最低対地高度 ${minAgl === Infinity ? '—' : minAgl.toFixed(0) + 'm'}`
      + ` 最大ピッチ ${maxPitch.toFixed(0)}°（直す前は対地-81mで突っ込んでいた）`);
    check(!crashed && passed, '推力の大きい機体は、近くて高い山でも越えられる',
      crashed ? '墜落' : (passed ? '越えた' : '未通過'));
    check(minAgl > 100, '山の上でも余裕を残して越える', minAgl.toFixed(0) + 'm');
  }
}

// (9) 垂直着陸は、前へ進む速度を止めてから降りること。
//
// 「垂直離着陸機が、前進速度が残ったまま着陸しようとして、脚が後ろ寄りの機体
// （サンダーバード1号など）はそのまま前に転ける」という報告。垂直降下の沈下率を
// 高さだけで決めていたので、進入速度のまま降りはじめて減速しきる前に接地し、
// ブレーキが効くにつれて前へ転がっていた（実測で接地後16G・ロール180°）。
{
  const cfg = defaultAircraftConfig();
  cfg.modelMaxSpeedValue = 2; cfg.modelMaxSpeedUnit = 'mach';
  for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 20;
  // 翼を小さくして進入速度を上げる（速い垂直離着陸機にする）
  for (const p of cfg.parts) {
    if (p.type !== 'wing' || !p.props || !p.props.corners || p.props.role !== 'main') continue;
    for (const k in p.props.corners) { const v = p.props.corners[k]; v.x *= 0.45; v.z *= 0.45; }
  }
  // 脚を後ろ寄りにする（前に転びやすい機体）
  for (const p of cfg.parts) if (p.type === 'landing_gear') p.position.z += 1.2;
  const lift = cfg.modelWeightKg * 1.6 / 4;
  const eng = (id, x, z) => ({ id, type: 'engine', name: '垂直' + id,
    position: { x, y: 0.4, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { thrustKgf: lift, spinAxis: 'y' } });
  cfg.parts = cfg.parts.concat([eng('v1', -1.2, -1.5), eng('v2', 1.2, -1.5),
    eng('v3', -1.2, 1.5), eng('v4', 1.2, 1.5)]);
  const m3 = buildAircraftModel(cfg);
  const spd3 = apSpeedSchedule(m3);

  const st = createFlightState(), c = createFlightControls();
  const plan = apMakeApproachPlan({ id: 'DST', x: 0, z: -60000, elevationM: 0 },
    { runwayLengthM: 3000, headingDeg: 0 }, 180);
  st.position.set(plan.threshold.x, 1200, plan.threshold.z + 25000);
  st.altitudeM = 1200;
  st.velocity.set(0, 0, -spd3.approach);
  st.headingDeg = plan.heading;
  const ap = createAutopilotState();
  ap.full = true; ap.vtolLanding = true; ap.destAirportId = 'DST';
  ap.plan = plan; ap.phase = 'vtol_approach'; ap.targetAltitudeM = 1200;

  let t = 0, wasAir = false, tdGs = null, tdDist = null, maxRoll = 0, maxPitch = 0;
  let done = false, crashed = false;
  for (; t < 900; t += 1 / 60) {
    stepAutopilot(m3, st, c, ap, 1 / 60, { groundHeightAt: flatGround });
    advanceFlight(m3, st, c, noWind, flatGround, 1 / 60);
    if (!st.onGround) wasAir = true;
    if (st.onGround && wasAir && tdGs === null) {
      tdGs = st.groundSpeed;
      tdDist = Math.hypot(st.position.x - plan.threshold.x, st.position.z - plan.threshold.z);
    }
    if (st.onGround) {
      maxRoll = Math.max(maxRoll, Math.abs(st.rollDeg || 0));
      maxPitch = Math.max(maxPitch, Math.abs(st.pitchDeg || 0));
    }
    if (st.crashed) { crashed = true; break; }
    if (ap.phase === 'done') { done = true; break; }
  }
  note('垂直着陸（進入157kt・脚が後ろ寄り）', `接地時の対地速度 ${tdGs === null ? '—' : (tdGs * KT).toFixed(0) + 'kt'}`
    + ` / 着地点からのずれ ${tdDist === null ? '—' : tdDist.toFixed(0) + 'm'}`
    + ` / 接地後の最大ロール ${maxRoll.toFixed(0)}°（直す前は15kt・32m・180°）`);
  check(done && !crashed, '垂直着陸できる', crashed ? '墜落' : (done ? '着陸' : '未完了'));
  check(tdGs !== null && tdGs < 3, '前へ進む速度を止めてから接地する',
    tdGs === null ? '—' : (tdGs * KT).toFixed(0) + 'kt');
  check(maxRoll < 30 && maxPitch < 30, '接地して前や横へ転がらない',
    `ロール${maxRoll.toFixed(0)}° ピッチ${maxPitch.toFixed(0)}°`);
  check(tdDist !== null && tdDist < 100, '着地点のそばに降りる',
    tdDist === null ? '—' : tdDist.toFixed(0) + 'm');
}

// (10) 回っている最中に、舵が回転を助ける側へ入らないこと。
//
// 「ふとローリングがかかると自動制御が必死にエルロンを当てるが、180度
// ひっくり返ったあたりの、やっと止まってくれそうなタイミングで舵を逆転させて
// しまい、止まらないままグルグル回り続けて進路変更不能になる」という報告。
// バンク角のずれだけで舵を決めていたので、回りながら±180°をまたぐたびに
// 指示が丸ごと逆転し（実測：ロール179°で-1.00、-179°で+1.00）、その反転が
// 回転と同じ周期で入って、ブランコを押すように回転を育てていた。
{
  const spd = { stall: 140, cruise: 400, approach: 180, bankMax: 85 };
  const at = (rollDeg, rateDegS, want) => apAileronForBank(
    { rollDeg, airspeed: 200, angularVelocity: { x: 0, y: 0, z: rateDegS * Math.PI / 180 } },
    want || 0, spd);

  // 止まっているときは今までどおり、近いほうへ起こす
  check(at(30, 0) < -0.1 && at(-30, 0) > 0.1, '止まっているときは、傾きを戻す向きに当てる',
    `30°:${at(30, 0).toFixed(2)} -30°:${at(-30, 0).toFixed(2)}`);
  // ずれは±180°で見る（折り返さないと、背面付近で遠回りのほうへ回そうとする）
  check(at(-170, 0, 85) < 0, 'バンク目標が大きくても、近いほうへ回す（遠回りしない）',
    at(-170, 0, 85).toFixed(2));

  // 速く回っているあいだは、背面をまたいでも舵が逆転しない
  const rows = [90, 120, 200, 300].map((r) => {
    const a = at(179, -r), b = at(-179, -r);
    return { r, a, b, same: Math.sign(a) === Math.sign(b) };
  });
  note('背面をまたぐときの指示エルロン', rows.map((x) =>
    `${x.r}°/s:${x.a.toFixed(2)}→${x.b.toFixed(2)}`).join(' '));
  check(rows.every((x) => x.same), '速く回っているあいだは、背面をまたいでも舵が逆転しない',
    rows.map((x) => (x.same ? '○' : '×')).join(''));
  // しかもその向きは、回転を止める向きであること
  check(rows.every((x) => x.a < 0 && x.b < 0), '回転を止める向きに当て続ける');

  // 上限を超えて回っているときは、回転を育てる側の指示を出さない
  const fastDriving = at(-179, -200);   // 角度だけ見れば「右へ回せ」と言う場面
  check(fastDriving < 0, '上限を超えて回っているときは、回転を育てる側へ出さない',
    fastDriving.toFixed(2));

  // 実際に回してみて、止まって水平に戻ること
  {
    const cfg = defaultAircraftConfig();
    cfg.modelMaxSpeedValue = 2; cfg.modelMaxSpeedUnit = 'mach';
    for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 20;
    const m4 = buildAircraftModel(cfg);
    const s4 = apSpeedSchedule(m4);
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 8000, 0); st.altitudeM = 8000;
    st.velocity.set(0, 0, -s4.cruise * 0.5);
    st.quaternion.setFromEuler(new THREE.Euler(0, 0, -170 * Math.PI / 180, 'YXZ'));
    st.angularVelocity.z = -2.5;   // 背面で、速く回っている
    const ap = createAutopilotState();
    ap.full = true; ap.phase = 'cruise'; ap.targetAltitudeM = 8000; ap.destAirportId = 'DST';
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 200000, z: -200000, elevationM: 0 },
      { runwayLengthM: 3000, headingDeg: 0 }, 180);
    let t = 0, prevRoll = st.rollDeg, turns = 0, levelAt = null, maxRate = 0;
    for (; t < 60; t += 1 / 60) {
      stepAutopilot(m4, st, c, ap, 1 / 60, {});
      advanceFlight(m4, st, c, noWind, flatGround, 1 / 60);
      let d = st.rollDeg - prevRoll;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      turns += Math.abs(d) / 360; prevRoll = st.rollDeg;
      maxRate = Math.max(maxRate, Math.abs(st.angularVelocity.z));
      if (levelAt === null && Math.abs(st.angularVelocity.z) < 0.2) levelAt = t;
      if (st.crashed) break;
    }
    note('背面・2.5rad/sから立て直す', `60秒で回った量 ${turns.toFixed(1)}回転`
      + ` / 回転が収まるまで ${levelAt === null ? '収まらず' : levelAt.toFixed(1) + '秒'}`);
    check(levelAt !== null && levelAt < 10, '速い回転でも、数秒で止まる',
      levelAt === null ? '止まらない' : levelAt.toFixed(1) + '秒');
    check(turns < 3, '止まるまでに何回転もしない', turns.toFixed(1) + '回転');
  }

  // やり直し（goaround）でも、曲がれる速さを大きく超えたら出力を絞ること。
  // ここだけ全開のままだったので、推力重量比が桁外れな機体は13,000ktまで
  // 加速し、その速さでは舵がほとんど効かずロールを止められなかった。
  {
    const cfg2 = defaultAircraftConfig();
    for (const p of cfg2.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 60;
    const m5 = buildAircraftModel(cfg2);
    const plan5 = apMakeApproachPlan({ id: 'DST', x: 60000, z: 0, elevationM: 0 },
      { runwayLengthM: 3000, headingDeg: 90 }, 270);
    // stepAutopilot が使うのと同じ距離で、その経路の「曲がれる速さ」を出す
    const distToFaf = Math.hypot(plan5.faf.x, plan5.faf.z);
    const cruise5 = apSpeedSchedule(m5, distToFaf, 100).cruise;
    const goaroundThrottle = (airspeed) => {
      const st = createFlightState(), c = createFlightControls();
      st.position.set(0, 2000, 0); st.altitudeM = 2000;
      st.airspeed = airspeed; st.groundSpeed = airspeed; st.headingDeg = 90;
      const ap = createAutopilotState();
      ap.full = true; ap.phase = 'goaround'; ap.destAirportId = 'DST';
      ap.targetAltitudeM = 2000;
      ap.plan = plan5;
      stepAutopilot(m5, st, c, ap, 1 / 60, {});
      return c.throttle;
    };
    const slow = goaroundThrottle(cruise5 * 0.8);  // 曲がれる速さの内側
    const fast = goaroundThrottle(cruise5 * 4);    // 曲がれる速さをはるかに超えている
    note('やり直し中の出力', `曲がれる速さ${(cruise5 * KT).toFixed(0)}kt に対して`
      + ` その0.8倍:${(slow * 100).toFixed(0)}% 4倍:${(fast * 100).toFixed(0)}%`);
    check(slow > 0.9, 'やり直しは基本、全開で登る', (slow * 100).toFixed(0) + '%');
    check(fast < 0.1, '曲がれる速さを大きく超えたら、やり直しでも出力を絞る',
      (fast * 100).toFixed(0) + '%');
  }

// (11) スポイラーと逆噴射。
//
// 「逆噴射能力がないのと、スポイラーを飛行中に使ってる?」という指摘から。
// 逆噴射はそもそも無く、スポイラーは**フラップのレバーを引き算する**形で
// 付いていた——つまりスポイラーを積んだ機体はフラップを下ろすほど
// スポイラーも一緒に立ち上がり、増えるはずの揚力を自分で削っていた。
// 減速の手立てが「出力を絞る・脚を出す」しかないせいで、推力の大きい機体が
// 進入までに落としきれないという、この自動操縦でずっと続いていた問題の根でもある。
{
  // スポイラーを2枚積んだ練習機（フラップはそのまま）
  const withSpoiler = () => {
    const cfg = defaultAircraftConfig();
    const mk = (id, name, wingId, x) => ({
      id, type: 'control_surface', name,
      position: { x, y: 1.55, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      props: { kind: 'spoiler', parentWingId: wingId, minDeg: -20, maxDeg: 20, hingeAxis: 'x', spanS: 0.5 },
    });
    cfg.parts.push(mk('cs_sp_l', 'スポイラー 左', 'w_main_l', -2.6));
    cfg.parts.push(mk('cs_sp_r', 'スポイラー 右', 'w_main_r', 2.6));
    return buildAircraftModel(cfg);
  };
  const plain = buildAircraftModel(defaultAircraftConfig());
  const sp = withSpoiler();

  // (a) スポイラーを積んでもフラップの効きが減らないこと
  const flapGain = (m) => m.surfaces.filter((s) => s.role === 'main')
    .reduce((a, s) => a + s.flap, 0) / 2;
  note('主翼のフラップの効き', `スポイラー無し ${(flapGain(plain) * 180 / Math.PI).toFixed(1)}°`
    + ` / スポイラー有り ${(flapGain(sp) * 180 / Math.PI).toFixed(1)}°`);
  check(Math.abs(flapGain(sp) - flapGain(plain)) < 1e-9,
    'スポイラーを積んでもフラップの効きは変わらない',
    `${(flapGain(plain) * 180 / Math.PI).toFixed(1)}° → ${(flapGain(sp) * 180 / Math.PI).toFixed(1)}°`);
  check(sp.hasSpoiler && !plain.hasSpoiler, 'スポイラーを積んだ機体だけ hasSpoiler が立つ',
    `有り:${sp.hasSpoiler} 無し:${plain.hasSpoiler}`);

  // (b) スポイラーを立てると揚力が減り、抗力が増えること
  const probe = (m, opt) => {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 1000, 0); st.altitudeM = 1000;
    st.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(6), 0, 0, 'YXZ'));
    st.velocity.set(0, 0, -60);
    c.throttle = 0; c.parkingBrake = false; c.gearDown = false;
    c.flap = opt.flap || 0; c.spoiler = opt.spoiler || 0;
    refreshFlightReadouts(m, st, flatGround);
    const v0 = st.velocity.clone();
    advanceFlight(m, st, c, noWind, flatGround, 1 / 600);
    const dv = st.velocity.clone().sub(v0).multiplyScalar(600);
    dv.y += FLIGHT_GRAVITY_FOR_TEST;
    return { lift: dv.y * m.massKg, drag: dv.z * m.massKg };
  };
  const clean = probe(sp, {});
  const out = probe(sp, { spoiler: 1 });
  const liftDrop = 1 - out.lift / clean.lift;
  const dragUp = out.drag / clean.drag - 1;
  note('スポイラー全開', `揚力 ${(clean.lift / 1000).toFixed(1)}kN→${(out.lift / 1000).toFixed(1)}kN`
    + `(${(-liftDrop * 100).toFixed(0)}%) 抗力 ${(clean.drag / 1000).toFixed(2)}kN→${(out.drag / 1000).toFixed(2)}kN`
    + `(+${(dragUp * 100).toFixed(0)}%) 揚抗比 ${(clean.lift / clean.drag).toFixed(1)}→${(out.lift / out.drag).toFixed(1)}`);
  check(liftDrop > 0.1 && liftDrop < 0.6, 'スポイラーは揚力を削る（実機の進入で3割前後）',
    (liftDrop * 100).toFixed(0) + '%');
  check(dragUp > 0.15, 'スポイラーは抗力を増やす', '+' + (dragUp * 100).toFixed(0) + '%');
  check(out.lift / out.drag < clean.lift / clean.drag * 0.75,
    'スポイラーを立てれば揚抗比が落ちる（＝急に降りられる）',
    `${(clean.lift / clean.drag).toFixed(1)}→${(out.lift / out.drag).toFixed(1)}`);

  // (c) フラップとスポイラーを両方使っても、フラップぶんの揚力は残ること
  const flapOnly = probe(sp, { flap: 1 });
  const both = probe(sp, { flap: 1, spoiler: 1 });
  note('フラップ全開', `素 ${(clean.lift / 1000).toFixed(1)}kN`
    + ` → フラップ ${(flapOnly.lift / 1000).toFixed(1)}kN`
    + ` → フラップ+スポイラー ${(both.lift / 1000).toFixed(1)}kN`);
  check(flapOnly.lift > clean.lift * 1.3, 'フラップは揚力を増やす',
    `+${((flapOnly.lift / clean.lift - 1) * 100).toFixed(0)}%`);
  check(both.lift > clean.lift, 'スポイラーを積んでいてもフラップは素より揚力が出る',
    `${((both.lift / clean.lift - 1) * 100).toFixed(0)}%`);

  // (d) 逆噴射：地上でだけ効く／「逆噴射なし」のエンジンは出さない／止まりかけで切れる
  const jet = () => {
    const cfg = defaultAircraftConfig();
    for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.noReverse = false;
    return buildAircraftModel(cfg);
  };
  const prop = buildAircraftModel(defaultAircraftConfig()); // 内蔵の練習機＝逆噴射なし
  check(prop.reverseThrustN === 0, '「逆噴射なし」のエンジンは逆推力を持たない',
    (prop.reverseThrustN / 1000).toFixed(1) + 'kN');
  check(jet().reverseThrustN > 0, '逆噴射できるエンジンは逆推力を持つ',
    (jet().reverseThrustN / 1000).toFixed(1) + 'kN');

  const decel = (m, opt) => {
    const st = createFlightState(), c = createFlightControls();
    if (opt.air) { st.position.set(0, 1000, 0); st.altitudeM = 1000; st.velocity.set(0, 0, -opt.v); }
    else { placeAircraftOnGround(m, st, 0, 0, 0, flatGround); settleAircraftOnGround(m, st, flatGround); st.velocity.set(0, 0, -opt.v); }
    c.throttle = 0; c.parkingBrake = false; c.reverse = opt.reverse || 0;
    refreshFlightReadouts(m, st, flatGround);
    const v0 = st.velocity.z;
    for (let i = 0; i < 6; i++) advanceFlight(m, st, c, noWind, flatGround, 1 / 60);
    return (st.velocity.z - v0) / (6 / 60); // +なら減速している
  };
  const j = jet();
  const groundNo = decel(j, { v: 50, reverse: 0 });
  const groundRev = decel(j, { v: 50, reverse: 1 });
  const airRev = decel(j, { v: 50, reverse: 1, air: true });
  const airNo = decel(j, { v: 50, reverse: 0, air: true });
  const propRev = decel(prop, { v: 50, reverse: 1 });
  const propNo = decel(prop, { v: 50, reverse: 0 });
  note('逆噴射の効き（毎秒の減速）', `地上 ${groundNo.toFixed(2)}→${groundRev.toFixed(2)}m/s²`
    + ` / 空中 ${airNo.toFixed(2)}→${airRev.toFixed(2)}m/s²`
    + ` / 逆噴射なしの機体 ${propNo.toFixed(2)}→${propRev.toFixed(2)}m/s²`);
  check(groundRev > groundNo + 0.5, '地上では逆噴射が効く',
    `${groundNo.toFixed(2)}→${groundRev.toFixed(2)}m/s²`);
  check(Math.abs(airRev - airNo) < 1e-6, '空中では逆噴射は効かない',
    `${airNo.toFixed(3)}→${airRev.toFixed(3)}m/s²`);
  check(Math.abs(propRev - propNo) < 1e-6, '「逆噴射なし」の機体はレバーを引いても変わらない',
    `${propNo.toFixed(3)}→${propRev.toFixed(3)}m/s²`);
  // 止まりかけで切れること（切れないと後ろへ走り出す）
  const crawl = decel(j, { v: 0.5, reverse: 1 });
  check(crawl < groundRev * 0.5, '止まりかけでは逆噴射を抜く（後ろへ走り出さない）',
    `50m/s:${groundRev.toFixed(2)} 0.5m/s:${crawl.toFixed(2)}m/s²`);

  // (e) 自動操縦が、進入では速すぎるときだけスポイラーを立て、
  //     接地したら全開にして逆噴射も入れること
  {
    const st = createFlightState(), c = createFlightControls();
    st.position.set(0, 1000, 0); st.altitudeM = 1000; st.altitudeAglM = 1000;
    st.airspeed = 100;
    c.throttle = 0;
    const onSpeed = apSpoilerCommand(sp, c, st, 100, 0);
    const tooFast = apSpoilerCommand(sp, c, st, 80, 0);
    const tooHigh = apSpoilerCommand(sp, c, st, 100, 300);
    c.throttle = 0.8;
    const powered = apSpoilerCommand(sp, c, st, 80, 300);
    note('自動操縦のスポイラー', `速度・高さとも合っている:${(onSpeed * 100).toFixed(0)}%`
      + ` 速すぎ:${(tooFast * 100).toFixed(0)}% 高すぎ:${(tooHigh * 100).toFixed(0)}%`
      + ` 出力80%で速すぎ:${(powered * 100).toFixed(0)}%`);
    check(onSpeed === 0, '経路どおりならスポイラーは立てない', (onSpeed * 100).toFixed(0) + '%');
    check(tooFast > 0.9, '速すぎればスポイラーを立てる', (tooFast * 100).toFixed(0) + '%');
    check(tooHigh > 0.9, '高すぎればスポイラーを立てる', (tooHigh * 100).toFixed(0) + '%');
    check(powered === 0, '出力を入れているあいだはスポイラーを立てない',
      (powered * 100).toFixed(0) + '%');
    const noneModel = apSpoilerCommand(plain, c, st, 80, 300);
    check(noneModel === 0, 'スポイラーの無い機体には指示を出さない', String(noneModel));

    // 逆噴射は「狙った減速度になるぶんだけ」。推力が桁外れでも一杯には入れない
    const big = (() => {
      const cfg = defaultAircraftConfig();
      for (const p of cfg.parts) if (p.type === 'engine' && p.props) {
        p.props.noReverse = false; p.props.thrustKgf *= 300;
      }
      return buildAircraftModel(cfg);
    })();
    st.groundSpeed = 60;
    const revNormal = apReverseCommand(j, st);
    const revBig = apReverseCommand(big, st);
    st.groundSpeed = 1;
    const revSlow = apReverseCommand(j, st);
    note('自動操縦の逆噴射', `ふつうの推力:${(revNormal * 100).toFixed(0)}%`
      + ` 300倍の推力:${(revBig * 100).toFixed(0)}% 対地1m/s:${(revSlow * 100).toFixed(0)}%`);
    check(revBig < revNormal, '推力が大きい機体ほどレバーを絞る',
      `${(revNormal * 100).toFixed(0)}% → ${(revBig * 100).toFixed(0)}%`);
    check(revSlow < revNormal, '止まりかけたらレバーを戻す',
      `${(revNormal * 100).toFixed(0)}% → ${(revSlow * 100).toFixed(0)}%`);
    check(apReverseCommand(prop, st) === 0, '「逆噴射なし」の機体には指示を出さない',
      String(apReverseCommand(prop, st)));
  }

  // (f) 減速装置を使うぶん、着陸滑走が短くなること。
  //     自動操縦の rollout の段をそのまま回して、装置を殺した場合と比べる
  //     （ただ地面に置いて速度を与えるだけだと、舵を押さえる者がいないので
  //      機体がそのまま浮き上がり、滑走ではなく弾道飛行を測ることになる）。
  {
    const jetSp = (() => {
      const cfg = defaultAircraftConfig();
      for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.noReverse = false;
      const mk = (id, name, wingId, x) => ({
        id, type: 'control_surface', name,
        position: { x, y: 1.55, z: 0.3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
        props: { kind: 'spoiler', parentWingId: wingId, minDeg: -20, maxDeg: 20, hingeAxis: 'x', spanS: 0.5 },
      });
      cfg.parts.push(mk('cs_sp_l', 'スポイラー 左', 'w_main_l', -2.6));
      cfg.parts.push(mk('cs_sp_r', 'スポイラー 右', 'w_main_r', 2.6));
      return buildAircraftModel(cfg);
    })();
    const roll = (m, useDevices) => {
      const st = createFlightState(), c = createFlightControls();
      placeAircraftOnGround(m, st, 0, 0, 90, flatGround);
      settleAircraftOnGround(m, st, flatGround);
      st.velocity.set(40, 0, 0); // 滑走路の向き（方位90°＝+X）へ
      c.parkingBrake = false;
      refreshFlightReadouts(m, st, flatGround);
      const ap = createAutopilotState();
      ap.full = true; ap.phase = 'rollout'; ap.destAirportId = 'DST';
      ap.plan = apMakeApproachPlan({ id: 'DST', x: 0, z: 0, elevationM: 0 },
        { runwayLengthM: 3000, headingDeg: 90 }, 0);
      const x0 = st.position.x;
      let t = 0;
      for (; t < 180; t += 1 / 60) {
        stepAutopilot(m, st, c, ap, 1 / 60, { groundHeightAt: flatGround });
        if (!useDevices) { c.spoiler = 0; c.reverse = 0; }
        advanceFlight(m, st, c, noWind, flatGround, 1 / 60);
        if (ap.phase === 'done' || st.groundSpeed < 1.5) break;
      }
      return Math.abs(st.position.x - x0);
    };
    const bare = roll(jetSp, false);
    const eq = roll(jetSp, true);
    note('着陸滑走（78kt から停止まで。自動操縦の rollout そのまま）',
      `ブレーキだけ ${bare.toFixed(0)}m / スポイラー+逆噴射 ${eq.toFixed(0)}m`);
    check(eq < bare * 0.95, '減速装置を使えば着陸滑走が短くなる',
      `${bare.toFixed(0)}m → ${eq.toFixed(0)}m`);
  }
}

// (12) 山越えと、その場に留まること。
//
// 「まえよりも山をよけきれてない」という報告から。原因は2つあった——
// (a) 自動操縦が「どの機体も経路角7°で登れる」と決め打ちしていた（推力に
//     何の関係もない幾何の仮定）。(b) 前方を見る距離が速度だけで決まっていて、
//     遅い機体は下限の10kmしか見ておらず、そこから登っても間に合わなかった。
// そして越えられない山は、そもそも登って越えるのではなく**よけて回る**。
{
  // (a) 出せる上昇率を、推力と抗力から測れていること
  const plain = buildAircraftModel(defaultAircraftConfig());
  const best = aircraftBestClimb(plain);
  note('内蔵の練習機の上昇率', `計算 ${best.rateMps.toFixed(1)}m/s（${(best.speedMps * KT).toFixed(0)}kt）`
    + ` / 幾何の7°だけなら ${(Math.max(best.speedMps, 10) * Math.sin(7 * Math.PI / 180)).toFixed(1)}m/s`);
  check(best.rateMps > 1 && best.rateMps < 8, '練習機の上昇率が実機並み（数m/s）',
    best.rateMps.toFixed(1) + 'm/s');

  const fast = (() => {
    const cfg = defaultAircraftConfig();
    for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 40;
    return buildAircraftModel(cfg);
  })();
  check(aircraftBestClimb(fast).rateMps > best.rateMps * 3,
    '推力を増やせば上昇率も増える',
    `${best.rateMps.toFixed(1)} → ${aircraftBestClimb(fast).rateMps.toFixed(1)}m/s`);
  // 推力重量比が桁外れでも、真上（sinγ=1）を超えない
  const rocket = (() => {
    const cfg = defaultAircraftConfig();
    for (const p of cfg.parts) if (p.type === 'engine' && p.props) p.props.thrustKgf *= 4000;
    return buildAircraftModel(cfg);
  })();
  const rb = aircraftBestClimb(rocket);
  check(rb.rateMps <= rb.speedMps + 1e-6, '真上より速くは登らない',
    `${rb.rateMps.toFixed(0)}m/s（そのときの速度 ${rb.speedMps.toFixed(0)}m/s）`);

  // (b) 上限が「幾何の7°」と「実力」の小さいほう
  const spdPlain = apSpeedSchedule(plain);
  const st = createFlightState();
  st.position.set(0, 1000, 0); st.altitudeM = 1000; st.airspeed = 70;
  const geoOnly = apVsLimits(st).up;
  const withModel = apVsLimits(st, spdPlain).up;
  note('昇降率の上限', `幾何だけ ${geoOnly.toFixed(1)}m/s → 実力を見て ${withModel.toFixed(1)}m/s`);
  check(withModel < geoOnly, '出せない上昇率を指示しない',
    `${geoOnly.toFixed(1)} → ${withModel.toFixed(1)}m/s`);
  check(withModel > 0, '上限が0にはならない', withModel.toFixed(2));

  // (c) 前方を見る距離が、登るのに要る距離で決まること
  const ridge = (x) => ((x > 25000 && x < 35000) ? 2500 : 0);
  const gh = (x) => ridge(x);
  const far = createFlightState();
  far.position.set(0, 1500, 0); far.altitudeM = 1500; far.airspeed = 70;
  far.velocity.set(70, 0, 0); far.headingDeg = 90;
  refreshFlightReadouts(plain, far, gh);
  far.position.set(0, 1500, 0); far.altitudeM = 1500;
  far.airspeed = 70; far.groundSpeed = 70; far.headingDeg = 90;
  const tf = apTerrainFloor(far, { groundHeightAt: gh }, 300, spdPlain);
  note('25km先の標高2500mの尾根', `見た距離 ${(tf.lookM / 1000).toFixed(0)}km`
    + ` / いま要る高度 ${tf.floorM < -1e5 ? '—' : tf.floorM.toFixed(0) + 'm'}`);
  check(tf.lookM > 25000, '登るのに要る距離まで先を見る', (tf.lookM / 1000).toFixed(0) + 'km');
  check(tf.floorM > 1500, '25km先の尾根でも、いまから登れと言う', tf.floorM.toFixed(0) + 'm');

  // (d) 目的地より先は見ない（着陸する空港の向こうの山を越えようとしない）
  const clipped = apTerrainFloor(far, { groundHeightAt: gh }, 300, spdPlain, 10000);
  check(clipped.floorM < 1000, '目的地より先の山は数えない',
    `床 ${clipped.floorM < -1e5 ? '—' : clipped.floorM.toFixed(0) + 'm'}（区切らないと ${tf.floorM.toFixed(0)}m）`);

  // (e) 越えられない山は、よけて回る。
  //     経路の40km先に半径12km・高さ3000mの単独峰。まわりは平地なので、
  //     練習機（上昇率3m/s台）でもよければ通れる。
  {
    const hill = (x, z) => {
      const d = Math.hypot(x - 40000, z);
      if (d >= 12000) return 0;
      const t = Math.cos((d / 12000) * Math.PI / 2);
      return 3000 * t * t;
    };
    const m = buildAircraftModel(defaultAircraftConfig());
    const st2 = createFlightState(), c = createFlightControls();
    placeAircraftOnGround(m, st2, 0, 0, 90, hill);
    settleAircraftOnGround(m, st2, hill);
    const ap = createAutopilotState();
    ap.full = true; ap.targetAltitudeM = 1500; ap.destAirportId = 'DST';
    ap.phase = 'takeoff'; ap.takeoffHeadingDeg = 90;
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 100000, z: 0, elevationM: 0 },
      { runwayLengthM: 3000, headingDeg: 90 }, 0);
    let t = 0, minAgl = Infinity, maxDodge = 0;
    for (; t < 6000; t += 1 / 60) {
      stepAutopilot(m, st2, c, ap, 1 / 60, { groundHeightAt: hill });
      advanceFlight(m, st2, c, noWind, hill, 1 / 60);
      maxDodge = Math.max(maxDodge, Math.abs(ap.terrainDodgeDeg || 0));
      if (!st2.onGround && hill(st2.position.x, st2.position.z) > 200) {
        minAgl = Math.min(minAgl, st2.altitudeAglM);
      }
      if (st2.crashed || ap.phase === 'done') break;
    }
    note('40km先の単独峰（半径12km・高さ3000m）',
      `山の上の最低対地 ${minAgl === Infinity ? '通らなかった' : minAgl.toFixed(0) + 'm'}`
      + ` / よけた角度 最大${maxDodge.toFixed(0)}°（直す前は対地-1m）`);
    check(!st2.crashed, '越えられない山でも墜ちない', st2.crashed ? '墜落' : 'ok');
    check(minAgl === Infinity || minAgl > 100, '越えられない山は、よけるか十分上を通る',
      minAgl === Infinity ? '通らなかった' : minAgl.toFixed(0) + 'm');
  }

  // (f) 空港のそばではよけない（進入は滑走路へ向かうしかない）
  {
    const ap2 = createAutopilotState();
    const st3 = createFlightState();
    st3.position.set(0, 200, 0); st3.altitudeM = 200; st3.airspeed = 80;
    st3.velocity.set(80, 0, 0); st3.headingDeg = 90; st3.groundSpeed = 80;
    // 東（機首の向き）だけ越えられない壁。北や南へ振ればよけられる
    const wall = (x, z) => (x > 3000 && Math.abs(z) < 30000 ? 3000 : 0);
    const near = apUpdateTerrainFloor(st3, ap2, { groundHeightAt: wall }, 1, 5000, spdPlain, 90);
    const ap3 = createAutopilotState();
    const farAway = apUpdateTerrainFloor(st3, ap3, { groundHeightAt: wall }, 1, 80000, spdPlain, 90);
    note('よける条件', `目的地まで5km:${near.dodgeDeg}° / 80km:${farAway.dodgeDeg}°`);
    check(near.dodgeDeg === 0, '空港のそばではよけない（進入を捨てない）', String(near.dodgeDeg));
    check(Math.abs(farAway.dodgeDeg) > 0, '遠いうちはよける', String(farAway.dodgeDeg));
  }

  // (g) ホバリング。垂直離着陸機がその場に留まれること
  {
    const cfg = defaultAircraftConfig();
    // 上向きエンジンを4基足して、垂直離着陸機にする
    for (const [i, x, z] of [[0, -3, -2], [1, 3, -2], [2, -3, 2], [3, 3, 2]]) {
      cfg.parts.push({
        id: 'lift' + i, type: 'engine', name: 'リフト' + i,
        position: { x, y: 1.2, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
        props: { thrustKgf: 500, spinAxis: 'y' },
      });
    }
    const m = buildAircraftModel(cfg);
    check(m.hasVtol, 'テスト機に上向きエンジンが付いている', String(m.hasVtol));
    const st4 = createFlightState(), c = createFlightControls();
    st4.position.set(0, 400, 0); st4.altitudeM = 400;
    st4.velocity.set(0, 0, -30);
    c.parkingBrake = false; c.throttle = 0.4; c.vtolThrottle = 0.3;
    refreshFlightReadouts(m, st4, flatGround);
    const ap = createAutopilotState();
    ap.hover = true;
    ap.hoverX = 0; ap.hoverZ = 0; ap.hoverAltM = 400; ap.hoverHeadingDeg = st4.headingDeg;
    const env = { manual: {} };
    let t = 0;
    for (; t < 300; t += 1 / 60) {
      stepAutopilot(m, st4, c, ap, 1 / 60, env);
      advanceFlight(m, st4, c, noWind, flatGround, 1 / 60);
      if (st4.crashed) break;
    }
    const drift = Math.hypot(st4.position.x - ap.hoverX, st4.position.z - ap.hoverZ);
    note('ホバリング（30m/sで入って300秒）',
      `高度のずれ ${(st4.altitudeM - ap.hoverAltM).toFixed(1)}m / 持ち場から ${drift.toFixed(0)}m`
      + ` / 対地速度 ${(st4.groundSpeed * KT).toFixed(1)}kt`);
    check(!st4.crashed, 'ホバリング中に墜ちない', st4.crashed ? '墜落' : 'ok');
    check(Math.abs(st4.altitudeM - ap.hoverAltM) < 20, 'ホバリングで高さを保つ',
      (st4.altitudeM - ap.hoverAltM).toFixed(1) + 'm');
    check(st4.groundSpeed * KT < 15, 'ホバリングで止まる',
      (st4.groundSpeed * KT).toFixed(1) + 'kt');
    check(drift < 400, '押した場所のそばに留まる', drift.toFixed(0) + 'm');
    // 舵を当てているあいだは持ち場を置き直す（押さえつけない）
    const before = { x: ap.hoverX, z: ap.hoverZ };
    env.manual = { pitch: true };
    st4.position.x += 100;
    stepAutopilot(m, st4, c, ap, 1 / 60, env);
    check(Math.abs(ap.hoverX - before.x) > 50, '舵を当てたら、離したところが新しい持ち場になる',
      `${before.x.toFixed(0)} → ${ap.hoverX.toFixed(0)}`);
  }

  // (h) 引き起こしで機首上げが止まらなくなる、の作り直し。
  //     apClamp は下限が優先なので、「いまの姿勢-1°」を下限にすると
  //     上限（10°）を追い越して頭打ちが効かなくなっていた。
  {
    const m = buildAircraftModel(defaultAircraftConfig());
    const spd = apSpeedSchedule(m);
    const st5 = createFlightState(), c = createFlightControls();
    st5.position.set(0, 30, 0); st5.altitudeM = 30; st5.altitudeAglM = 30;
    st5.airspeed = 60; st5.groundSpeed = 60;
    st5.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(25), 0, 0, 'YXZ'));
    refreshFlightReadouts(m, st5, flatGround);
    const ap = createAutopilotState();
    ap.full = true; ap.phase = 'flare'; ap.destAirportId = 'DST';
    ap.plan = apMakeApproachPlan({ id: 'DST', x: 200, z: 0, elevationM: 0 },
      { runwayLengthM: 3000, headingDeg: 90 }, 0);
    // **1コマでは分からない**。指示は姿勢から少しずつしか動かせない（変化率の
    // 制限）ので、直っているかどうかは「このあと上限へ降りてくるか、それとも
    // 姿勢と一緒に上がっていくか」で決まる。5秒ぶん回して見る。
    const first = [];
    for (let i = 0; i < 300; i++) {
      stepAutopilot(m, st5, c, ap, 1 / 60, {});
      if (i % 60 === 0) first.push(ap.pitchCmdDeg.toFixed(1));
    }
    note('引き起こし：姿勢25°から5秒', `指示ピッチ ${first.join('° → ')}°`);
    check(ap.pitchCmdDeg <= 10.001, '引き起こしの指示が上限（10°）まで降りてくる',
      ap.pitchCmdDeg.toFixed(1) + '°');
  }
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
