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
for (const f of ['09-aircraft.js', '10-flight.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'env', f), 'utf8');
  vm.runInContext(src, ctx, { filename: f });
}
const {
  buildAircraftModel, defaultAircraftConfig, analyzeAircraftPerformance,
  createFlightState, createFlightControls, advanceFlight, placeAircraftOnGround,
  airDensityAt,
} = ctx;

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
