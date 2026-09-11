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

// 逆噴射は止まりかけでは切る。実機の逆推力装置も止まる前に格納する決まりで、
// 入れっぱなしにすると機体が後ろへ走り出す（手で引きっぱなしにしても同じ）。
const REVERSE_FADE_MPS = 2;

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
    forwardAirspeed: 0, // 機首方向の速度成分 m/s（垂直離着陸の姿勢制御ノズルの判定に使う）
    groundSpeed: 0,
    altitudeM: 0,       // 平均海面から
    altitudeAglM: 0,    // 地表から
    verticalSpeed: 0,   // m/s
    headingDeg: 0, pitchDeg: 0, rollDeg: 0,
    alphaDeg: 0, betaDeg: 0,
    loadFactor: 1,      // G
    stallRatio: 0,      // 主翼のうち失速している面積の割合 0〜1
    thrustN: 0,
    vtolThrustN: 0,
    machLike: 0,
  };
}

function createFlightControls() {
  return {
    pitch: 0, roll: 0, yaw: 0,   // -1〜1
    trim: 0,                     // -1〜1。舵の中立位置。手を離したときの姿勢を決める
    throttle: 0,                 // 0〜1（前へ進むエンジン）
    vtolThrottle: 0,             // 0〜1（垂直離陸用のリフトエンジン。別のレバー）
    flap: 0,                     // 0〜1
    // スポイラー（エアブレーキ）。揚力を削って抗力を出す、フラップとは別のレバー。
    spoiler: 0,                  // 0〜1
    // 逆噴射。地上でだけ効く（10-flight.js の推力の項を参照）。
    reverse: 0,                  // 0〜1
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
  arm: new THREE.Vector3(), dF: new THREE.Vector3(),
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
    // s.fwd はその翼の翼弦そのものなので、この時点で**取付角は入っている**。
    // ここへ s.incidenceRad を足すと取付角が二重に効いて、2°で付けた主翼が
    // 4°で飛んでしまう。重心の前にある主翼ならそのぶん機首上げの力が出て、
    // 手を離すと勝手に上を向く機体になる。取付角は表示用の数字として持つだけにする。
    const u = local.dot(s.fwd);
    const w = local.dot(s.up);
    let alpha = Math.atan2(-w, Math.abs(u) < 1e-6 ? 1e-6 : u);
    if (u < 0) alpha = -alpha; // 後ろ向きに飛んでいるときも符号が破綻しないように

    // 舵角を足す
    const flapPart = s.flap * controls.flap;
    // スポイラーは翼の上に板を立てるもの。揚力の側は「キャンバーを逆へ折る」
    // ぶんとしてフラップと同じ土俵で足し（符号は逆）、板そのものの抗力は
    // 下の cd に別口で足す。
    const spoilerCmd = THREE.MathUtils.clamp(controls.spoiler || 0, 0, 1);
    const spoilerPart = -(s.spoiler || 0) * spoilerCmd;
    // トリムは別勘定。水平尾翼を持つ機体では**安定板まるごとの取付角**を動かすので、
    // エレベーターとは足し算になる。尾翼を持たない機体ではトリムもエレベーターと
    // 同じ蝶番の舵を動かす（09-aircraft.js の assignTrimAuthority 参照）。
    const trimDefl = (s.trimAuth === undefined ? s.pitch : s.trimAuth)
      * THREE.MathUtils.clamp(controls.trim || 0, -1, 1);
    // 蝶番で付いた舵（エレベーター・エルロン・ラダー）。翼の後ろだけが動く。
    const hinged = s.pitch * THREE.MathUtils.clamp(controls.pitch, -1, 1)
      + s.roll * controls.roll + s.yaw * controls.yaw
      + (s.trimHinged === false ? 0 : trimDefl);
    // 翼まるごとの取付角が変わるぶん（安定板トリム）。力は空力中心にそのまま掛かる。
    const trimmed = s.trimHinged === false ? trimDefl : 0;
    const deflect = hinged + trimmed + flapPart + spoilerPart;
    const alphaEff = alpha + deflect;

    // フラップは「翼のキャンバーを増やす」もの。迎角をずらすだけの扱いにすると、
    // 失速する迎角まで同じぶんだけ前倒しになって最大揚力が増えず、
    // フラップを下ろすほど失速が早まる——という逆の機体ができあがる。
    // そこで失速の判定からはフラップぶんを外し、揚力の曲線ごと持ち上げる。
    //
    // **舵も同じ**。舵はキャンバーを変えるもので、翼まるごとを迎角ぶんひねる
    // ものではない。外しておかないと、失速が近い迎角で舵を当てたとたんに翼が
    // 失速して揚力が落ち、**舵が逆に効く**。実測で、水平尾翼を持たない Concorde が
    // 迎角12°で「機首下げ」を当てると機首上げに反転し、引き起こしを始めた瞬間に
    // 止められなくなって背面へ回っていた（ふつうの尾翼機ではエレベーターは
    // 水平尾翼に付くので、主翼の失速はこれまでどおり迎角だけで決まる）。
    // 失速角そのものは「機体の迎角で何度か」で決める（s.alphaGain の説明を参照）。
    // 舵とフラップのぶんは、もう翼が感じる角度で足してあるので倍率は掛けない。
    const stallLimit = stallRad * (s.alphaGain || 1)
      + Math.abs(flapPart) + Math.abs(spoilerPart) + Math.abs(hinged + trimmed);

    const cl = liftCoefficient(alphaEff, stallLimit);
    const cdi = (cl * cl) / (Math.PI * s.aspect * AERO_DEFAULTS.oswald);
    const cd = AERO_DEFAULTS.cd0Wing + cdi + stallDragExtra(alphaEff, stallLimit)
      + Math.abs(deflect) * 0.35 // 舵を切れば抗力も増える
      + (s.spoilerCd || 0) * spoilerCmd; // 立てた板そのものの抗力

    const q = 0.5 * rho * v2 * s.area;

    // 揚力は流れに垂直、抗力は流れに沿って後ろ向き
    const dragDir = _fv.dragDir.copy(local).multiplyScalar(-1 / v);
    const liftDir = _fv.liftDir.crossVectors(s.spanA, local).normalize();

    const f = _fv.f.set(0, 0, 0)
      .addScaledVector(liftDir, cl * q)
      .addScaledVector(dragDir, cd * q);

    out.force.add(f);
    out.torque.add(_fv.tmp.crossVectors(s.center, f));

    // **蝶番の舵で増えたぶんの揚力は、空力中心より後ろに掛かる**——動くのは翼の
    // 後ろ半分だけなので、増えた圧力の中心も後ろに寄る。これを入れないと、
    // 舵の力はすべて空力中心（前縁から1/4）に掛かることになり、
    // **翼の空力中心が重心の真上にある機体はピッチをまったく操縦できない**。
    // 実際そうなっていて、水平尾翼を持たずエレボンだけで飛ぶ Concorde は
    // 舵の効きが実測 ±0.00MN·m ——引き起こせず、離陸滑走のまま滑走路の端まで
    // 走り続けていた。実機のデルタ機はまさにこの腕で機首を上げている。
    //
    // フラップはここに入れない。この飛行モデルはフラップを「翼まるごとの
    // キャンバーが増える」ものとして扱っており（上のコメント参照）、蝶番の先だけが
    // 動く舵とは別物だから。入れると、フラップ全開で機首下げが勝ってしまい、
    // 内蔵の練習機がエレベーターを一杯に引いても失速させられなくなった（実測）。
    if (hinged) {
      let dCl = cl - liftCoefficient(alpha + trimmed + flapPart + spoilerPart, stallLimit);
      // **失速した舵は効かなくなるだけで、逆には効かない**。揚力の曲線の差で
      // 出すと、翼が崩れたところでは差の符号まで裏返り、当てた向きと逆の
      // モーメントが出る。実測で Concorde が迎角12°から「機首下げ」を当てると
      // +0.59MN·m の機首上げになり、引き起こしが止まらず背面へ回っていた。
      if (dCl * hinged < 0) dCl = 0;
      if (dCl) {
        const arm = _fv.arm.copy(s.fwd).multiplyScalar(-AERO_DEFAULTS.hingeArmChord * s.chord);
        out.torque.add(_fv.tmp.crossVectors(arm, _fv.dF.copy(liftDir).multiplyScalar(dCl * q)));
      }
    }

    // **翼弦方向の回転減衰**。上の ω×r は翼の位置が重心から離れているぶんしか
    // 拾わないので、**重心の真上にある翼はまったく減衰しない**。実際そうなっていて、
    // 主翼が重心の上にあるデルタ機（Concorde）はピッチ角速度0.4rad/sを与えても
    // 戻す力が0.001MN·mしか出ず、いちど機首が上がりだすと止まらないまま
    // 背面に入って滑走路に落ちていた。翼はそれ自身の翼弦の長さで回転を止める。
    const qRate = omega.dot(s.spanA);
    if (qRate) {
      out.torque.addScaledVector(s.spanA,
        -AERO_DEFAULTS.pitchDamp * rho * v * s.area * s.chord * s.chord * qRate);
    }

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

  // **出した脚は抗力になる**。ここが抜けていたので、脚を出しても速度がまったく
  // 落ちず、自動操縦は「降りる」と「減速する」を姿勢ひとつで両立するしかなかった
  // ——実測でBoeing 747が進入開始に260kt（進入速度168kt）・経路より600m高いところで
  // 入って、やり直しを25回繰り返していた。実機の進入で最初に出す減速装置がこれ。
  if (controls.gearDown && model.gearDragArea > 0 && airspeed > 1e-3) {
    const dGear = 0.5 * rho * airspeed * model.gearDragArea * AERO_DEFAULTS.gearCd;
    out.force.addScaledVector(vAirBody, -dGear);
  }

  // 推力。プロペラなので速度が上がるほど落ちる。
  const speedRatio = THREE.MathUtils.clamp(airspeed / Math.max(model.vMaxMps, 1), 0, 1.4);
  const propFactor = Math.max(1 - AERO_DEFAULTS.propDecay * speedRatio, 0.05);
  // 空気が薄いと出力も落ちる
  const envScale = propFactor * (rho / FLIGHT_RHO0);
  // 垂直離陸用（回転軸が上向き）のエンジンは別のレバーで出す。
  // 前へ進むためのエンジンと同じレバーにすると、離陸のために出力を上げた瞬間に
  // 前へも押されてしまい、ホバリングも垂直着陸もできない。
  const vtolScale = (controls.vtolThrottle || 0) * envScale;
  const mainScale = controls.throttle * envScale;
  // 逆噴射。ジェットは排気を前へ振り向け、ターボプロップは羽根を裏返して後ろへ引く。
  // どちらも順推力そのままは出ないので reverseFraction ぶんに絞る。
  // **地上で、前へ走っているあいだだけ効かせる**——空中で使えると、自動操縦も手動も
  // 「減速したいから引く」を高度でやってしまい、実機なら空中分解する使い方が
  // 最適解になってしまう。止まりかけで切るのは REVERSE_FADE_MPS の説明を参照。
  // 接地判定は前のフレームのものだが、1フレーム（16ms）のずれは効果に出ない。
  const revScale = state.onGround
    ? THREE.MathUtils.clamp(controls.reverse || 0, 0, 1) * envScale
      * AERO_DEFAULTS.reverseFraction
      * THREE.MathUtils.clamp(-vAirBody.z / REVERSE_FADE_MPS, 0, 1)
    : 0;
  let thrustTotal = 0, vtolTotal = 0;
  for (const e of model.engines) {
    // 垂直離陸用エンジンは前後バランス（trimScale）ぶん絞ってある。
    // ここで掛け忘れると、モデル構築時に消したはずの機首振りが物理では復活する。
    const t = e.lift ? e.thrustN * e.trimScale * vtolScale
      : e.thrustN * (mainScale - (e.canReverse ? revScale : 0));
    if (e.lift) vtolTotal += t; else thrustTotal += t;
    out.force.addScaledVector(e.axis, t);
    out.torque.add(_fv.tmp.crossVectors(e.position, _fv.f.copy(e.axis).multiplyScalar(t)));
  }

  state.thrustN = thrustTotal;
  state.vtolThrustN = vtolTotal;
  state.airspeed = airspeed;
  // 機首方向へどれだけ飛んでいるか（後ろ向きなら0扱い）。姿勢制御ノズルが
  // 手を引くタイミングをこれで決める——total speedで決めると、まっすぐ上へ
  // 加速しているだけの機体（前向きの速度は0）が一瞬で基準を超えてしまい、
  // 水平飛行用に向いた水平尾翼が真上からの風を受けて暴れるだけの状態に
  // 取り残される（姿勢が大きく傾いていないのにノズルだけ先に消える）。
  state.forwardAirspeed = Math.max(-vAirBody.z, 0);
  // 迎角と横滑り角も、止まっているうちは意味を持たない
  const flying = airspeed > 8;
  state.alphaDeg = flying ? THREE.MathUtils.radToDeg(Math.atan2(-vAirBody.y, -vAirBody.z)) : 0;
  state.betaDeg = flying ? THREE.MathUtils.radToDeg(Math.atan2(vAirBody.x, -vAirBody.z)) : 0;
  // 止まっているときは迎角に意味が無い（わずかな風で±180°まで振れる）。
  // そのまま出すと駐機中の機体に「失速」の警告が点きっぱなしになる。
  state.stallRatio = (mainArea > 0 && airspeed > 8) ? stalledArea / mainArea : 0;
  return rho;
}

// --- 垂直離陸中の姿勢制御 -------------------------------------------------------

// 舵は風が当たっていないと効かない。だから垂直に上がっている機体は、
// リフトエンジンだけでは姿勢を保てない——尾翼が「進んでいる向き」へ機首を向けようとして、
// 真上へ上がるほど機首も真上を向き、そのまま引っくり返る。
// 実機（ハリアーなど）はエンジンの空気を機首・尾部・翼端のノズルへ回してこれを押さえる。
// ここでも同じものを持たせる。リフトの出力に比例して効き、速度が出たら舵へ譲る。
// 角速度を戻すだけでは足りない。上昇が速くなるほど尾翼の起こす力も強くなるので、
// 舵を中立にしていると機首が少しずつ上を向いたまま止まらない。
// 舵から手を離しているあいだは**水平に戻す**ところまで面倒を見る。
// 実機でもホバリング中の姿勢は自動で保たれている（F-35Bはまさにこれ）。
const VTOL_RCS_DEG = { pitch: 14, roll: 34, yaw: 10 }; // 舵一杯のときの角加速度（°/s²）
const VTOL_RCS_DAMP = 1.3;      // 角速度を戻す強さ（1/s）
const VTOL_RCS_LEVEL = 0.7;     // 水平へ戻す強さ（rad/s² / 傾きのsin）
const VTOL_RCS_FADE_MPS = 60;   // 機首方向の速度がこれに達するまででノズルの効きを0にし、舵に任せる

const _vtolUp = new THREE.Vector3();

function accumulateVtolControl(model, state, controls, out) {
  if (!model.hasVtol) return;
  const power = controls.vtolThrottle || 0;
  if (power < 0.02) return;
  const fade = THREE.MathUtils.clamp(1 - (state.forwardAirspeed || 0) / VTOL_RCS_FADE_MPS, 0, 1);
  const auth = power * fade;
  if (auth <= 1e-4) return;

  const I = model.inertia;
  const w = state.angularVelocity;
  const rad = THREE.MathUtils.degToRad;

  // ワールドの真上を機体座標で見る。機首が上がっていれば z が負、
  // 右へ傾いていれば x が負になる（そのぶんだけ戻せばいい）。
  const up = _vtolUp.set(0, 1, 0).applyQuaternion(_fv.qInv.copy(state.quaternion).invert());
  const hold = (1 - Math.min(Math.abs(controls.pitch), 1)) * VTOL_RCS_LEVEL;
  const holdR = (1 - Math.min(Math.abs(controls.roll), 1)) * VTOL_RCS_LEVEL;

  // 符号は舵と同じ向きにそろえる（引く＝機首上げ／右へ倒す＝右ロール／右ラダー＝右ヨー）
  out.torque.x += I.x * (rad(VTOL_RCS_DEG.pitch) * controls.pitch
    + hold * up.z - VTOL_RCS_DAMP * w.x) * auth;
  out.torque.z += I.z * (-rad(VTOL_RCS_DEG.roll) * controls.roll
    - holdR * up.x - VTOL_RCS_DAMP * w.z) * auth;
  out.torque.y += I.y * (-rad(VTOL_RCS_DEG.yaw) * controls.yaw - VTOL_RCS_DAMP * w.y) * auth;
}

// --- 接地 -------------------------------------------------------------------

const _gv = {
  world: new THREE.Vector3(), vel: new THREE.Vector3(), r: new THREE.Vector3(),
  fwd: new THREE.Vector3(), side: new THREE.Vector3(), f: new THREE.Vector3(),
  tmp: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
};

// 数値的に持つ範囲の上限。接地のばねは陽解法で積分しているので、
// 固有振動数ωと刻みdtの積が大きすぎると弾け飛ぶ。実測では
// ω·dt=0.44までは静かなまま、0.70で84G、2.22で1176G・上下90m/sまで暴れた。
const GEAR_STABLE_WDT = 0.5;

// 脚のばねの硬さ。静止時に GEAR_SQUASH_M だけ沈む硬さを基本にする。
//
// **「脚が受け止める荷重」で決める。推力そのものではない。**
// 脚が支えるのは重さだけではない——推力の作用線が重心からずれていれば、
// そのモーメントも脚が押し返して支えることになる（内蔵機ならエンジンは
// 重心の20cm上にあり、推力が重さの14倍もあると機首下げのモーメントで
// 前脚が潰れ、機首が滑走路にめり込んでいた）。
// だからといって**推力の大きさをそのまま硬さにしてはいけない**。
// モーメントの腕（重心からのずれ）と脚の間隔しだいで、実際に脚へ来る力は
// 推力よりずっと小さいことがあるからで、そこを取り違えると
// 軽い機体に大推力を積んだ瞬間にばねが桁違いに硬くなる。
// 硬すぎるばねは1/240秒の刻みでは積分が持たず、**置いただけで弾け飛ぶ**
// （実測：1トンの機体で推力を10倍にしたら接地した瞬間に84G、
// 100倍では1176G・上下90m/sで跳ね回った）。
//
// 支えるべき荷重は「重さ ＋ 推力のモーメント ÷ 脚の間隔」。
// モーメントの腕は、前へ進むエンジンなら重心からの上下のずれ、
// 垂直離陸用エンジンなら前後のずれ（推力の向きが90°違う）。
// 脚1本あたりで見るので、脚の本数ぶんを掛ける。
function gearDesignLoadN(model) {
  const weight = model.massKg * FLIGHT_GRAVITY;
  let moment = 0;
  for (const e of (model.engines || [])) {
    moment += Math.abs(e.thrustN * (e.lift ? e.position.z : e.position.y));
  }
  if (!(moment > 0)) return weight;
  // 脚の前後の広がり（モーメントを受け止める腕の長さ）
  let lo = Infinity, hi = -Infinity;
  for (const c of model.contacts) { lo = Math.min(lo, c.position.z); hi = Math.max(hi, c.position.z); }
  const base = Math.max(hi - lo, 0.5);
  return weight + model.contacts.length * (moment / base);
}

function gearSpringRate(model) {
  const n = Math.max(model.contacts.length, 1);
  const k = gearDesignLoadN(model) / (GEAR_SQUASH_M * n);
  // どれだけ荷重が大きくても、刻みで積分できる硬さを超えさせない。
  // ここで頭打ちになると設計より深く沈むが、弾け飛ぶよりはるかにましで、
  // 「沈む」ほうは見た目が少し埋まるだけで済む。
  const kMax = Math.pow(GEAR_STABLE_WDT / FLIGHT_SUBSTEP, 2) * (model.massKg / n);
  return Math.min(k, kMax);
}

// 脚ごとにばねと摩擦を出す。力は機体座標で返す（空力と同じ入れ物に足せるように）。
function accumulateGroundForces(model, state, controls, groundHeightAt, out) {
  state.contactCount = 0;
  if (!model.contacts.length) return;

  const q = state.quaternion;
  const qInv = _fv.qInv.copy(q).invert();
  const n = model.contacts.length;
  const kSpring = gearSpringRate(model);
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
    // 沈みすぎたときに弾き飛ばさないよう上限を置く。ばねが GEAR_SQUASH_M の
    // 8倍まで縮んだぶん＝そのばねで出せる力の8倍を上限にする（硬さと同じ基準で
    // 決まるので、重い機体でも大推力の機体でも自動で釣り合う）。
    normal = Math.min(normal, kSpring * GEAR_SQUASH_M * 8);

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
  accumulateVtolControl(model, state, controls, acc);
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

// --- トリム（舵の中立位置）を求める ---------------------------------------------
//
// 尾翼が大きい機体ほど迎角が0°に張り付く。重心を主翼の空力中心へ合わせると
// 主翼のモーメントが消えるので、釣り合う迎角は「水平尾翼の取付角の裏返し」だけで決まり、
// 取付角0°の尾翼なら**揚力の出ない迎角**で釣り合ってしまう。そのまま手を離せば、
// 機体は高度を速度に替えながら長周期でうねる——TB1もTB2も内蔵機もこれだった。
//
// 実機はこれをトリムで解いている。ここでも同じで、
// 「その速度で水平飛行するのに必要な舵の中立位置」を、飛行モデルそのものを使って解く。
// 近似式を別に持つと本体の物理と食い違っていくので、力の計算は本番と同じものを呼ぶ。

// 探索は何百回も力を計算するので、状態と入れ物は使い回す。
// 毎回 createFlightState() すると Vector3 の生成だけで10ミリ秒近くかかり、
// 重心スライダーを動かすたびに画面が引っかかる。
const _trimScratch = {
  out: { force: new THREE.Vector3(), torque: new THREE.Vector3() },
  world: new THREE.Vector3(),
  euler: new THREE.Euler(),
  wind: new THREE.Vector3(),
  state: null, controls: null,
};

// 迎角 alphaRad・トリム trim・スロットル thr で釣り合いを見る。
// 返すのは「上向きの余り（＋なら浮きすぎ）」「機首上げモーメント」「前向きの余り」。
function trimResiduals(model, speedMps, altitudeM, alphaRad, trim, thr) {
  const s = _trimScratch;
  if (!s.state) { s.state = createFlightState(); s.controls = createFlightControls(); }
  const st = s.state, c = s.controls;
  st.position.set(0, altitudeM, 0);
  st.altitudeM = altitudeM;
  st.angularVelocity.set(0, 0, 0);
  // 速度は水平のまま、機体だけを迎角ぶん持ち上げる（＝水平飛行の姿勢）
  st.quaternion.setFromEuler(s.euler.set(alphaRad, 0, 0, 'YXZ'));
  st.velocity.set(0, 0, -speedMps);
  c.pitch = c.roll = c.yaw = c.flap = c.brake = 0;
  c.vtolThrottle = 0;
  c.trim = trim;
  c.throttle = thr;
  c.gearDown = false;
  c.parkingBrake = false;
  accumulateAeroForces(model, st, c, s.wind, s.out);
  const world = s.world.copy(s.out.force).applyQuaternion(st.quaternion);
  return {
    lift: world.y - model.massKg * FLIGHT_GRAVITY,
    moment: s.out.torque.x,
    thrust: -world.z, // 機首方向（水平）の余り
  };
}

// 単調な関数を挟み撃ちで解く。範囲内に解が無ければ、いちばん惜しい端を返す
// （釣り合わない機体でも「どちらへ倒せばマシか」は返したい）。
function trimBisect(f, lo, hi) {
  let a = f(lo), b = f(hi);
  if ((a < 0) === (b < 0)) return Math.abs(a) <= Math.abs(b) ? lo : hi;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if ((v < 0) === (a < 0)) { lo = mid; a = v; } else { hi = mid; b = v; }
  }
  return (lo + hi) / 2;
}

// 機体の「抗力長さ」——出力を絞ったとき、速度が 1/e に落ちるまでに進む距離(m)。
//
// 抗力は速度の2乗に比例するので m·dv/dt = -k·v² となり、距離で書き直すと
// dv/v = -(k/m)·dx。つまり **速度を v0 から v1 まで落とすのに要る距離は
// L·ln(v0/v1)**（L = m/k）で、速度によらない1本の物差しになる。
// 自動操縦はこれで「目的地までに進入速度まで落としきれるか」を判断する。
// 実測すると機体差は桁で違う——Boeing 747 が約15km、TB1（翼73m²に140t）は
// 約300kmで、TB1 は巡航のまま突っ込むと1000km走っても進入速度まで落ちない。
function aircraftDragLengthM(model) {
  if (model._dragLengthM > 0) return model._dragLengthM;
  const s = _trimScratch;
  if (!s.state) { s.state = createFlightState(); s.controls = createFlightControls(); }
  const st = s.state, c = s.controls;
  // 代表速度は失速の3倍あたり（進入から巡航までの真ん中）。誘導抗力はここでは
  // ほぼ効かないので、どこで測ってもLはあまり動かない。
  const stall = Math.sqrt((2 * model.massKg * FLIGHT_GRAVITY)
    / (1.225 * Math.max(model.wingArea, 0.01) * 1.5));
  const v = Math.max(stall * 3, 10);
  st.position.set(0, 0, 0); st.altitudeM = 0;
  st.angularVelocity.set(0, 0, 0);
  st.quaternion.setFromEuler(s.euler.set(0, 0, 0, 'YXZ'));
  st.velocity.set(0, 0, -v);
  c.pitch = c.roll = c.yaw = c.flap = c.brake = 0;
  c.trim = 0; c.throttle = 0; c.vtolThrottle = 0;
  c.gearDown = false; c.parkingBrake = false;
  accumulateAeroForces(model, st, c, s.wind, s.out);
  const drag = Math.max(s.out.force.z, 1e-6); // 機首は-z。抗力は+z
  model._dragLengthM = (model.massKg * v * v) / drag;
  return model._dragLengthM;
}

// その速度で水平飛行するトリム・迎角・スロットルを返す。
function solveLevelTrim(model, speedMps, altitudeM) {
  // 失速したところで探すと意味のない答えが出る。失速角のすこし手前で頭打ちにする——
  // 翼が小さすぎて失速角まで引かないと重さを支えられない機体は、
  // そもそも水平飛行できないので「解けなかった」と答えるのが正しい。
  const maxAlpha = THREE.MathUtils.degToRad(AERO_DEFAULTS.stallDeg * 0.75);
  let alpha = 0, trim = 0, thr = 0.5;
  // 3つは互いに影響し合うので、順に解いて数回まわす。
  //
  // **回す回数は速い機体で効いてくる**。迎角を解いたあとにトリムを解き直すと、
  // 水平尾翼が出す揚力そのものが変わるので、迎角の答えがずれる。このずれは
  // 動圧に比例して大きくなるため、4回では速い機体で収束しきらない——
  // 実測で、揚力の残差が 1300kt で503N（許容539Nのぎりぎり）、1400ktで562N、
  // 4000ktでは4573Nになり、許容を超えたところで「翼が足りない（wing）」と
  // 誤診断して**トリムを中立(0)で返していた**。中立は、その動圧では
  // まったく釣り合わない舵位置なので、返り値をそのまま当てると1.5秒で機体が
  // 裏返る（自動トリムを押すと超音速機が墜ちる、という壊れ方になる）。
  // 8回まわせば4000ktでも残差20Nまで落ちる（12回でも20回でも同じ＝収束済み）。
  for (let i = 0; i < 8; i++) {
    alpha = trimBisect((a) => trimResiduals(model, speedMps, altitudeM, a, trim, thr).lift,
      -maxAlpha, maxAlpha);
    trim = trimBisect((t) => trimResiduals(model, speedMps, altitudeM, alpha, t, thr).moment, -1, 1);
    thr = trimBisect((p) => trimResiduals(model, speedMps, altitudeM, alpha, trim, p).thrust, 0, 1);
  }
  const r = trimResiduals(model, speedMps, altitudeM, alpha, trim, thr);
  const liftOk = Math.abs(r.lift) < model.massKg * FLIGHT_GRAVITY * 0.05;
  const momentOk = Math.abs(r.moment) < model.massKg * 0.5;

  // 「舵が足りない」と「舵に腕（モーメントの効き）がそもそも無い」は別の壊れ方で、
  // 直しかたも違う。水平尾翼を持たずエルロンしか無い機体（デルタ翼のエレボンなど）で、
  // 重心を主翼の空力中心にぴったり合わせると、主翼をひねっても力の掛かる点が重心の
  // 真上（前後のずれ0）になり、トリムを一杯まで振っても回転モーメントがまったく
  // 変わらない——「翼が足りない」という診断（liftOkの失敗が優先されて出る）では
  // この根本原因が隠れてしまう。トリムを両端まで振ってモーメントの変化を直接測り、
  // ほぼ変わらなければそれを優先して理由に出す。
  //
  // **測るのは alpha=0 で、探索が収束した alpha ではない**。翼が小さすぎて浮けない
  // 機体は alpha 探索が上限に張り付いたまま返ってくる（liftOk がそもそも失敗する）。
  // そこは主翼の一部がすでに失速ぎりぎりで、揚力係数の曲線が非線形に潰れているので、
  // 「舵に腕はちゃんとあるのに、たまたま張り付いた alpha でだけモーメントが平らに見える」
  // という誤診断が起きる（実際、翼を大きくして直したはずの機体が、たまたま浮上に
  // 必要な速度が高いというだけの理由で「舵に腕が無い」と誤って報告された）。
  // 舵の腕そのものは重心と舵の位置関係で決まる幾何の話で、alpha にはほぼ依らないので、
  // 素直な alpha=0 で測るほうが的確に測れる。
  let reason = null;
  if (!liftOk || !momentOk) {
    const mLo = trimResiduals(model, speedMps, altitudeM, 0, -1, thr).moment;
    const mHi = trimResiduals(model, speedMps, altitudeM, 0, 1, thr).moment;
    reason = Math.abs(mHi - mLo) < model.massKg * 0.5 ? 'no_elevator' : (!liftOk ? 'wing' : 'elevator');
  }
  return {
    // 釣り合わない機体に探索の途中の値を当てると、かえって逆向きに舵を切ってしまう。
    // 解けなかったときは中立のまま返し、警告のほうで理由を伝える。
    trim: (liftOk && momentOk) ? THREE.MathUtils.clamp(trim, -1, 1) : 0,
    alphaDeg: THREE.MathUtils.radToDeg(alpha),
    throttle: thr,
    ok: liftOk && momentOk,
    // 釣り合わない理由。翼が足りない／舵が弱い／舵に腕が無い、で直しかたが違う
    reason,
  };
}

// いま飛んでいる状態に合わせてトリムを取り直す（実機で「トリムを取る」のと同じ操作）
function trimToCurrentFlight(model, state) {
  const v = Math.max(state.airspeed, 10);
  return solveLevelTrim(model, v, Math.max(state.altitudeM, 0));
}

// --- 垂直上昇できる速さの限界 ---------------------------------------------------
//
// 姿勢制御ノズル（accumulateVtolControl）は、位置のずれから来るモーメントは消せても、
// 「水平飛行のために向いている翼が真上からの風を受けて起こす」モーメントには
// 追いつけないことがある。水平尾翼は水平飛行では小さな力で効けばよいので、
// 面積を大きく・重心から遠くに置くほど強く効くよう作られている。ところが
// 真上への風（迎角ほぼ90°）に対しては、その面積と腕の長さがそのまま
// 桁違いに大きな抗力モーメントに化ける——本来の使われかたの外側なので、
// ノズルの出せる力（I×VTOL_RCS_LEVEL 程度）ではまったく足りなくなる。
//
// ここでは実際の空力計算（accumulateAeroForces）そのものを使って、
// 「姿勢は水平のまま、真上への速度だけを上げていったとき、モーメントが
// ノズルの持ち分を超える速度」を挟み撃ちで探す。エンジンの推力は姿勢に
// 効かない（釣り合っていれば）ので、この限界はスロットルに関係なく機体の
// 形だけで決まる。
function vtolClimbMomentAt(model, climbMps) {
  const s = _trimScratch;
  if (!s.state) { s.state = createFlightState(); s.controls = createFlightControls(); }
  const st = s.state, c = s.controls;
  st.position.set(0, 500, 0);
  st.altitudeM = 500;
  st.quaternion.identity();
  st.velocity.set(0, climbMps, 0);
  st.angularVelocity.set(0, 0, 0);
  c.pitch = c.roll = c.yaw = c.flap = c.brake = c.trim = 0;
  c.throttle = 0;
  c.vtolThrottle = 0;
  c.gearDown = false;
  c.parkingBrake = false;
  accumulateAeroForces(model, st, c, s.wind, s.out);
  return s.out.torque.x;
}

function vtolClimbSpeedLimit(model) {
  if (!model.hasVtol) return null;
  const budget = Math.max(model.inertia.x, 1) * VTOL_RCS_LEVEL;
  const over = (v) => Math.abs(vtolClimbMomentAt(model, v)) - budget;
  if (over(200) <= 0) return null; // 200 m/sまで安全（現実的にはまず起きない）
  return trimBisect(over, 0.2, 200);
}

// 地面へ機体を置く（滑走路の上に出すときと、リセットのとき）。
// 姿勢は常に水平（ピッチ・ロール0）に決め打ちし、高さは脚のいちばん深いところが
// 接地する位置にする。脚がどれも同じ深さで、重心のまわりに素直に並んでいれば
// これで合う——ただし脚の長さがバラついている機体では、浅い脚が地面に届かず
// 浮いたままになる（下の settleAircraftOnGround 参照）。
function placeAircraftOnGround(model, state, x, z, headingDeg, groundHeightAt) {
  state.velocity.set(0, 0, 0);
  state.angularVelocity.set(0, 0, 0);
  state.crashed = false;
  state.quaternion.setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-headingDeg), 0, 'YXZ'));
  const ground = groundHeightAt(x, z);
  state.position.set(x, ground + model.gearHeight - GEAR_SQUASH_M, z);
  refreshFlightReadouts(model, state, groundHeightAt);
}

const _settleControls = { gearDown: true, parkingBrake: true };
const _settleWind = new THREE.Vector3();

// placeAircraftOnGround の「水平に決め打ち」を、実際に釣り合う姿勢へ静定させる。
//
// **脚の長さが脚ごとに揃っていない機体で必要になる**。placeAircraftOnGround は
// いちばん深い脚が接地する高さに置くだけなので、それより浅い脚は宙に浮いたまま
// 出てしまう（実際、あるユーザー機体で前脚の伸縮節がほかの脚より1m以上短く、
// 前脚だけ浮いた状態で出ていた）。支えを欠いた状態から物理が姿勢を直そうとして
// 激しく弾み、離陸すらしていないのに衝撃Gの墜落判定（12-flight-mode.js）に
// 触れてしまう——「召喚すると高い位置に出て落っこちて墜落判定になる」がこれ。
//
// 姿勢を計算で解こうとはしない。**このシミュレータの脚のばねは、どんな並びの
// 脚が来てもいずれ釣り合う姿勢に収束する**ので、静かに（ブレーキを引いて、
// 舵も出力も入れずに）数秒ぶん物理を回してしまうのがいちばん確実——脚がどれだけ
// 変な位置にあっても、そのまま同じ物理で本番も扱うのと同じ理屈で必ず答えが出る。
// 墜落判定は呼び出し側（12-flight-mode.jsの毎フレームループ）の話なので、
// ここで先に静定させてしまえば、その激しい過渡応答をプレイヤーは目にしない。
//
// 収まるまでの時間は機体次第（素直な脚ならほぼ一瞬）なので、脚が全部接地して
// 沈み込みも回転も十分小さいまま0.5秒続いたら打ち切る。上限（既定12秒ぶん）を
// 過ぎても収まらない、収まった先が横倒し同然（ピッチ・ロールどちらかが60°を
// 超える）、または深く沈み込みすぎている（＝支えを完全に失って地面をすり抜けて
// いる）なら、静定は諦めて元の水平placementへ戻す——直せないなら、せめて
// 今までどおりの挙動のままにしておく。
//
// **「脚が全部接地しているか」まで見ないと、静定したつもりが実は静定していない**。
// このシミュレータの接地は点接触なので、2本の脚だけがX方向に並んで接地し、
// 3本目（前脚など）が僅かに浮いたままだと、ピッチ方向の支えが無いまま鉛筆を
// 立てたような釣り合いになる——速度・角速度はゼロで一見「静か」に見えても、
// ほんの少しの数値誤差で再び傾き始め、3本目の脚がようやく届いたところで
// 今度こそ大きな衝撃になる（実測：この判定を「接地して静か」とだけ書いていた
// ときは、静定を抜けたあと0.7秒で3本目の脚が接地し35Gの衝撃が出ていた）。
// 速度・角速度に加えて `state.contactCount === model.contacts.length`
// （脚が全部接地している）も条件に入れることで、この「あと少しで倒れる」
// 半端な状態では打ち切らないようにする。
//
// ピッチ角だけでは倒れきったかどうかも判定できない。支えを失ったまま延々
// 回転し続けると、90°を超えたところでEuler角の抽出が巻き戻り（THREE.jsの
// 'YXZ'順ではピッチ成分が±90°に丸め込まれ、続きはヨー・ロール側に現れる）、
// 実際は転がり続けているのに `pitchDeg` だけ見ると「-37°くらいで収まった」
// ように見えてしまう（実測：主脚2本だけの支えで、5秒足らずでピッチ-88°・
// 地面下2.5mまで転落）。沈み込み量（本来の接地深さからどれだけ余計に沈んだか）
// も一緒に見て、脚の深さぶんを超えて沈んでいたら「支えを失って落ちた」と判定する。
function settleAircraftOnGround(model, state, groundHeightAt, maxSeconds) {
  const p0 = state.position.clone();
  const q0 = state.quaternion.clone();

  const c = _settleControls;
  c.pitch = c.roll = c.yaw = c.trim = 0;
  c.throttle = c.vtolThrottle = c.flap = c.brake = 0;

  const gearCount = model.contacts.length;
  const dt = 1 / 60;
  const limit = Math.max(maxSeconds || 12, 0);
  let quietFrames = 0;
  for (let t = 0; t < limit; t += dt) {
    advanceFlight(model, state, c, _settleWind, groundHeightAt, dt);
    const quiet = state.onGround && state.contactCount >= gearCount
      && Math.abs(state.velocity.y) < 0.05 && state.angularVelocity.lengthSq() < 0.0004;
    quietFrames = quiet ? quietFrames + 1 : 0;
    if (quietFrames > 30) break; // 全脚が接地して0.5秒静かなら、もう収まったとみなす
  }

  const sunkTooFar = state.position.y < p0.y - Math.max(model.gearHeight, 1);
  const settled = state.onGround && state.contactCount >= gearCount && !sunkTooFar
    && Math.abs(state.pitchDeg) < 60 && Math.abs(state.rollDeg) < 60;
  if (!settled) {
    state.position.copy(p0);
    state.quaternion.copy(q0);
  }
  state.velocity.set(0, 0, 0);
  state.angularVelocity.set(0, 0, 0);
  refreshFlightReadouts(model, state, groundHeightAt);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createFlightState, createFlightControls, advanceFlight, flightStep,
    refreshFlightReadouts, placeAircraftOnGround, settleAircraftOnGround,
    airDensityAt, liftCoefficient,
    solveLevelTrim, trimToCurrentFlight, vtolClimbSpeedLimit, aircraftDragLengthM,
    FLIGHT_SUBSTEP, GEAR_SQUASH_M,
  };
}
