// 10-flight.js — 飛行の物理（剛体＋翼ごとの空力＋接地）
//
// 揚力の式を機体全体に1本だけ当てるのではなく、**翼1枚ずつに当てる**。
// 手間はかかるが、そうすると欲しい挙動がほとんど勝手に出てくる。
//   - 尾翼が重心から離れているので、ピッチもヨーも自然に安定する
//   - 回転すると尾翼の局所的な迎角が変わるので、減衰も勝手に効く
//   - 片翼だけ失速すればそちら側から落ちる（＝スピン）
//   - 上反角がついていれば横滑りで勝手に起き上がる
// 係数表を並べて安定微係数を書くより、機体を組み替えたときに素直に追従する。
//
// 座標系は3つ。
//   ワールド（+X東 / -Z北 / +Y上、メートル）
//   機体（機首-Z / 上+Y / 右+X。09-aircraft.js が向きをここへ正規化してある）
//   翼の局所（前fwd / 翼幅spanA / 法線up）
// 位置と速度はワールド、角速度とモーメントは機体、迎角は翼の局所で扱う。
//
// このファイルもTHREE.jsの数学だけしか使わないので、Nodeから読んで飛ばせる
// （tools/verify-flight.js が離陸・上昇・旋回・失速をブラウザ抜きで確かめる）。

const FLIGHT_SUBSTEP = 1 / 240;   // 物理の刻み。接地のばねが硬いので細かく回す
// 1フレームで進める上限。描画ループが dt を0.1秒で頭打ちにしているので、
// そこまでは必ず追いつけるだけの数を持たせる。ここが足りないと、
// 描画が重い環境で**飛行機だけスローモーションになる**（実際そうなった）。
const FLIGHT_MAX_SUBSTEPS = 24;

const FLIGHT_GRAVITY = 9.80665;
const FLIGHT_RHO0 = 1.225;

// 接地のばね。静止時に GEAR_SQUASH_M だけ沈む硬さにする。
const GEAR_SQUASH_M = 0.08;
const GEAR_ROLL_FRICTION = 0.025;  // 転がり抵抗
const GEAR_BRAKE_FRICTION = 0.55;  // ブレーキ全踏み
const GEAR_SIDE_FRICTION = 0.85;   // 横滑りに耐えるタイヤの摩擦
const GEAR_STEER_MAX_DEG = 32;

// --- 大気 -------------------------------------------------------------------

// 国際標準大気（対流圏）。高いほど薄くなり、揚力も推力も落ちる。
function airDensityAt(altitudeM) {
  const h = Math.max(Math.min(altitudeM, 20000), -500);
  return FLIGHT_RHO0 * Math.pow(Math.max(1 - 2.2557e-5 * h, 0.05), 4.2559);
}

// --- 翼の揚力係数 -------------------------------------------------------------

// 失速までは薄翼理論の直線（2πα）、超えたら平板（2 sinα cosα）へなめらかに渡す。
// こうすると失速後もぬるりと揚力が残り、機首を下げれば素直に回復する。
function liftCoefficient(alphaRad, stallRad) {
  const a = alphaRad;
  const linear = 2 * Math.PI * a;
  const plate = 2 * Math.sin(a) * Math.cos(a);
  const m = Math.abs(a);
  const t = THREE.MathUtils.clamp((m - stallRad) / (stallRad * 0.85), 0, 1);
  const blend = t * t * (3 - 2 * t); // smoothstep
  return linear * (1 - blend) + plate * blend;
}

// 失速すると抗力が跳ね上がる（前面投影が増えるぶん）
function stallDragExtra(alphaRad, stallRad) {
  const over = Math.max(Math.abs(alphaRad) - stallRad, 0);
  return 1.6 * (1 - Math.cos(Math.min(over * 2.2, Math.PI)));
}

// --- 飛行状態 ---------------------------------------------------------------

function createFlightState() {
  return {
    position: new THREE.Vector3(),      // ワールド。重心の位置
    velocity: new THREE.Vector3(),      // ワールド m/s
    quaternion: new THREE.Quaternion(), // 機体→ワールド
    angularVelocity: new THREE.Vector3(), // 機体座標 rad/s

    onGround: false,
    contactCount: 0,
    crashed: false,

    // 読み出し用（HUDと検証が使う）
    airspeed: 0,        // 対気速度 m/s
    groundSpeed: 0,
    altitudeM: 0,       // 平均海面から
    altitudeAglM: 0,    // 地表から
    verticalSpeed: 0,   // m/s
    headingDeg: 0, pitchDeg: 0, rollDeg: 0,
    alphaDeg: 0, betaDeg: 0,
    loadFactor: 1,      // G
    stallRatio: 0,      // 主翼のうち失速している面積の割合 0〜1
    thrustN: 0,
    machLike: 0,
  };
}

function createFlightControls() {
  return {
    pitch: 0, roll: 0, yaw: 0,   // -1〜1
    throttle: 0,                 // 0〜1
    flap: 0,                     // 0〜1
    brake: 0,                    // 0〜1
    gearDown: true,
    parkingBrake: true,
  };
}

// --- 力とモーメント -----------------------------------------------------------

const _fv = {
  vAirWorld: new THREE.Vector3(), vAirBody: new THREE.Vector3(),
  omega: new THREE.Vector3(), local: new THREE.Vector3(), tmp: new THREE.Vector3(),
  force: new THREE.Vector3(), torque: new THREE.Vector3(),
  liftDir: new THREE.Vector3(), dragDir: new THREE.Vector3(), f: new THREE.Vector3(),
  qInv: new THREE.Quaternion(), up: new THREE.Vector3(),
};

// 機体にかかる力（機体座標）とモーメント（機体座標）を積み上げる。
// windWorld は風のベクトル（ワールド、m/s）。
function accumulateAeroForces(model, state, controls, windWorld, out) {
  out.force.set(0, 0, 0);
  out.torque.set(0, 0, 0);

  const rho = airDensityAt(state.altitudeM);
  const qInv = _fv.qInv.copy(state.quaternion).invert();

  // 対気速度（ワールド）→機体座標
  const vAirWorld = _fv.vAirWorld.copy(state.velocity).sub(windWorld);
  const vAirBody = _fv.vAirBody.copy(vAirWorld).applyQuaternion(qInv);
  const airspeed = vAirBody.length();
  const omega = _fv.omega.copy(state.angularVelocity);

  const stallRad = THREE.MathUtils.degToRad(AERO_DEFAULTS.stallDeg);
  let stalledArea = 0, mainArea = 0;

  for (const s of model.surfaces) {
    // その翼の位置での気流。回転しているぶん（ω×r）が乗る＝これが減衰の正体。
    const local = _fv.local.copy(vAirBody).add(_fv.tmp.crossVectors(omega, s.center));

    // 翼幅方向の流れは揚力に効かないので落とす（後退角のある翼でも素直に効く）
    const spanComp = local.dot(s.spanA);
    local.addScaledVector(s.spanA, -spanComp);
    const v2 = local.lengthSq();
    if (v2 < 1e-6) continue;
    const v = Math.sqrt(v2);

    // 迎角。前向き成分に対して法線方向へどれだけ流れているか。
    const u = local.dot(s.fwd);
    const w = local.dot(s.up);
    let alpha = Math.atan2(-w, Math.abs(u) < 1e-6 ? 1e-6 : u);
    if (u < 0) alpha = -alpha; // 後ろ向きに飛んでいるときも符号が破綻しないように

    // 取付角と舵角を足す
    const flapPart = s.flap * controls.flap;
    const deflect = s.pitch * controls.pitch + s.roll * controls.roll
      + s.yaw * controls.yaw + flapPart;
    const alphaEff = alpha + s.incidenceRad + deflect;

    // フラップは「翼のキャンバーを増やす」もの。迎角をずらすだけの扱いにすると、
    // 失速する迎角まで同じぶんだけ前倒しになって最大揚力が増えず、
    // フラップを下ろすほど失速が早まる——という逆の機体ができあがる。
    // そこで失速の判定からはフラップぶんを外し、揚力の曲線ごと持ち上げる。
    const stallLimit = stallRad + Math.abs(flapPart);

    const cl = liftCoefficient(alphaEff, stallLimit);
    const cdi = (cl * cl) / (Math.PI * s.aspect * AERO_DEFAULTS.oswald);
    const cd = AERO_DEFAULTS.cd0Wing + cdi + stallDragExtra(alphaEff, stallLimit)
      + Math.abs(deflect) * 0.35; // 舵を切れば抗力も増える

    const q = 0.5 * rho * v2 * s.area;

    // 揚力は流れに垂直、抗力は流れに沿って後ろ向き
    const dragDir = _fv.dragDir.copy(local).multiplyScalar(-1 / v);
    const liftDir = _fv.liftDir.crossVectors(s.spanA, local).normalize();

    const f = _fv.f.set(0, 0, 0)
      .addScaledVector(liftDir, cl * q)
      .addScaledVector(dragDir, cd * q);

    out.force.add(f);
    out.torque.add(_fv.tmp.crossVectors(s.center, f));

    if (s.role === 'main') {
      mainArea += s.area;
      if (Math.abs(alphaEff) > stallLimit) stalledArea += s.area;
    }
  }

  // 胴体。前からと横からで別々に効かせると、横滑りが自然に止まる。
  const qFront = 0.5 * rho * vAirBody.z * Math.abs(vAirBody.z) * model.fuselageFrontArea * AERO_DEFAULTS.fuselageCd;
  const qSide = 0.5 * rho * vAirBody.x * Math.abs(vAirBody.x) * model.fuselageSideArea * AERO_DEFAULTS.fuselageSideCd;
  const qVert = 0.5 * rho * vAirBody.y * Math.abs(vAirBody.y) * model.fuselageSideArea * AERO_DEFAULTS.fuselageSideCd;
  out.force.x -= qSide;
  out.force.y -= qVert;
  out.force.z -= qFront;

  // 推力。プロペラなので速度が上がるほど落ちる。
  const speedRatio = THREE.MathUtils.clamp(airspeed / Math.max(model.vMaxMps, 1), 0, 1.4);
  const propFactor = Math.max(1 - AERO_DEFAULTS.propDecay * speedRatio, 0.05);
  // 空気が薄いと出力も落ちる
  const thrustScale = controls.throttle * propFactor * (rho / FLIGHT_RHO0);
  let thrustTotal = 0;
  for (const e of model.engines) {
    const t = e.thrustN * thrustScale;
    thrustTotal += t;
    out.force.addScaledVector(e.axis, t);
    out.torque.add(_fv.tmp.crossVectors(e.position, _fv.f.copy(e.axis).multiplyScalar(t)));
  }

  state.thrustN = thrustTotal;
  state.airspeed = airspeed;
  // 迎角と横滑り角も、止まっているうちは意味を持たない
  const flying = airspeed > 8;
  state.alphaDeg = flying ? THREE.MathUtils.radToDeg(Math.atan2(-vAirBody.y, -vAirBody.z)) : 0;
  state.betaDeg = flying ? THREE.MathUtils.radToDeg(Math.atan2(vAirBody.x, -vAirBody.z)) : 0;
  // 止まっているときは迎角に意味が無い（わずかな風で±180°まで振れる）。
  // そのまま出すと駐機中の機体に「失速」の警告が点きっぱなしになる。
  state.stallRatio = (mainArea > 0 && airspeed > 8) ? stalledArea / mainArea : 0;
  return rho;
}

// --- 接地 -------------------------------------------------------------------

const _gv = {
  world: new THREE.Vector3(), vel: new THREE.Vector3(), r: new THREE.Vector3(),
  fwd: new THREE.Vector3(), side: new THREE.Vector3(), f: new THREE.Vector3(),
  tmp: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
};

// 脚ごとにばねと摩擦を出す。力は機体座標で返す（空力と同じ入れ物に足せるように）。
function accumulateGroundForces(model, state, controls, groundHeightAt, out) {
  state.contactCount = 0;
  if (!model.contacts.length) return;

  const q = state.quaternion;
  const qInv = _fv.qInv.copy(q).invert();
  const n = model.contacts.length;
  const kSpring = (model.massKg * FLIGHT_GRAVITY) / (GEAR_SQUASH_M * n);
  const cDamp = 2 * Math.sqrt(kSpring * (model.massKg / n)) * 0.9;

  const steerRad = THREE.MathUtils.degToRad(GEAR_STEER_MAX_DEG) * controls.yaw
    * THREE.MathUtils.clamp(1 - state.groundSpeed / 40, 0, 1);

  for (const c of model.contacts) {
    // 脚を畳んでいたら接地しない（＝胴体着陸になる）
    const r = _gv.r.copy(c.position);
    if (!controls.gearDown) r.y *= 0.15;

    const world = _gv.world.copy(r).applyQuaternion(q).add(state.position);
    const ground = groundHeightAt(world.x, world.z);
    const pen = ground - world.y;
    if (pen <= 0) continue;
    state.contactCount++;

    // その接点の速度（ワールド）
    const vel = _gv.vel.crossVectors(state.angularVelocity, r).applyQuaternion(q).add(state.velocity);

    // 垂直抗力。沈み込みのばねと、めり込む速度への減衰。
    const vNormal = vel.y;
    let normal = kSpring * pen - cDamp * vNormal;
    if (normal < 0) normal = 0;
    // 沈みすぎたときに弾き飛ばさないよう上限を置く
    normal = Math.min(normal, model.massKg * FLIGHT_GRAVITY * 8);

    // 車輪の向き（機体の前方を地面へ落とし、前輪なら舵角ぶん回す）
    const fwd = _gv.fwd.set(0, 0, -1);
    if (c.steer) fwd.applyAxisAngle(_gv.up, -steerRad);
    fwd.applyQuaternion(q);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1); else fwd.normalize();
    const side = _gv.side.crossVectors(_gv.up, fwd).normalize();

    const vFwd = vel.dot(fwd);
    const vSide = vel.dot(side);

    // 転がり抵抗＋ブレーキ（前後）と、タイヤの横グリップ
    const muRoll = GEAR_ROLL_FRICTION + (c.brake ? GEAR_BRAKE_FRICTION * controls.brake : 0)
      + (controls.parkingBrake ? 0.9 : 0);
    const fFwd = -Math.sign(vFwd) * Math.min(muRoll * normal, Math.abs(vFwd) * model.massKg * 4);
    const fSide = -Math.sign(vSide) * Math.min(GEAR_SIDE_FRICTION * normal, Math.abs(vSide) * model.massKg * 4);

    const f = _gv.f.set(0, normal, 0).addScaledVector(fwd, fFwd).addScaledVector(side, fSide);

    // ワールドの力を機体座標へ移してから積む
    const fBody = f.applyQuaternion(qInv);
    out.force.add(fBody);
    out.torque.add(_gv.tmp.crossVectors(r, fBody));
  }

  state.onGround = state.contactCount > 0;
}

// --- 積分 -------------------------------------------------------------------

const _iv = {
  accel: new THREE.Vector3(), alpha: new THREE.Vector3(), gyro: new THREE.Vector3(),
  Iw: new THREE.Vector3(), dq: new THREE.Quaternion(), gravity: new THREE.Vector3(),
  fWorld: new THREE.Vector3(),
};

function flightStep(model, state, controls, windWorld, groundHeightAt, dt) {
  const acc = { force: new THREE.Vector3(), torque: new THREE.Vector3() };

  accumulateAeroForces(model, state, controls, windWorld, acc);
  accumulateGroundForces(model, state, controls, groundHeightAt, acc);

  // 力（機体）→ワールドに直し、重力を足して加速度にする
  const fWorld = _iv.fWorld.copy(acc.force).applyQuaternion(state.quaternion);
  const accel = _iv.accel.copy(fWorld).divideScalar(model.massKg);
  // Gメーターは重力を除いた加速度の機体上下成分（＋1Gが水平飛行）
  state.loadFactor = _iv.gravity.copy(accel).applyQuaternion(_fv.qInv.copy(state.quaternion).invert()).y / FLIGHT_GRAVITY;
  accel.y -= FLIGHT_GRAVITY;

  state.velocity.addScaledVector(accel, dt);
  state.position.addScaledVector(state.velocity, dt);

  // 角加速度 α = I^-1 (τ - ω×(Iω))
  const I = model.inertia;
  const w = state.angularVelocity;
  const Iw = _iv.Iw.set(I.x * w.x, I.y * w.y, I.z * w.z);
  const gyro = _iv.gyro.crossVectors(w, Iw);
  const alpha = _iv.alpha.set(
    (acc.torque.x - gyro.x) / I.x,
    (acc.torque.y - gyro.y) / I.y,
    (acc.torque.z - gyro.z) / I.z
  );
  w.addScaledVector(alpha, dt);

  // クォータニオンの積分（角速度は機体座標なので右から掛ける）
  const dq = _iv.dq.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
  dq.multiplyQuaternions(state.quaternion, dq);
  state.quaternion.set(
    state.quaternion.x + dq.x, state.quaternion.y + dq.y,
    state.quaternion.z + dq.z, state.quaternion.w + dq.w
  ).normalize();
}

// 姿勢や高度など、表示と判定に使う値を作り直す
function refreshFlightReadouts(model, state, groundHeightAt) {
  state.altitudeM = state.position.y;
  const ground = groundHeightAt(state.position.x, state.position.z);
  state.altitudeAglM = state.position.y - ground - model.gearHeight;
  state.verticalSpeed = state.velocity.y;
  state.groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);

  const e = new THREE.Euler().setFromQuaternion(state.quaternion, 'YXZ');
  // YXZ順なら y=方位・x=ピッチ・z=ロールがそのまま取れる
  state.headingDeg = (THREE.MathUtils.radToDeg(-e.y) + 360) % 360;
  state.pitchDeg = THREE.MathUtils.radToDeg(e.x);
  state.rollDeg = THREE.MathUtils.radToDeg(-e.z);
  state.machLike = state.airspeed / 340;
}

// 1フレームぶん進める。刻みを固定して回すので、フレームレートが変わっても挙動が変わらない。
function advanceFlight(model, state, controls, windWorld, groundHeightAt, dtFrame) {
  let remain = Math.min(dtFrame, FLIGHT_SUBSTEP * FLIGHT_MAX_SUBSTEPS);
  let steps = 0;
  while (remain > 1e-6 && steps < FLIGHT_MAX_SUBSTEPS) {
    const dt = Math.min(FLIGHT_SUBSTEP, remain);
    flightStep(model, state, controls, windWorld, groundHeightAt, dt);
    refreshFlightReadouts(model, state, groundHeightAt);
    remain -= dt;
    steps++;
  }
  return steps;
}

// 地面へ機体を置く（滑走路の上に出すときと、リセットのとき）
function placeAircraftOnGround(model, state, x, z, headingDeg, groundHeightAt) {
  state.velocity.set(0, 0, 0);
  state.angularVelocity.set(0, 0, 0);
  state.crashed = false;
  state.quaternion.setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-headingDeg), 0, 'YXZ'));
  const ground = groundHeightAt(x, z);
  state.position.set(x, ground + model.gearHeight - GEAR_SQUASH_M, z);
  refreshFlightReadouts(model, state, groundHeightAt);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createFlightState, createFlightControls, advanceFlight, flightStep,
    refreshFlightReadouts, placeAircraftOnGround, airDensityAt, liftCoefficient,
    FLIGHT_SUBSTEP, GEAR_SQUASH_M,
  };
}
