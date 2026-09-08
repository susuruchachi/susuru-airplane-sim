// 13-autopilot.js — 高度維持と、離陸から着陸までの全自動飛行
//
// 手で飛ばすときにいちばん難しいのは「同じ高度をまっすぐ保つ」ことで、
// そこができないと景色を見る余裕も出てこない。まずそこを機械に任せる。
// そのうえで、出発の空港（いま選んでいる空港）から目的地の空港まで、
// 離陸・上昇・巡航・降下・進入・着陸を通しでやらせる。
//
// 作りは4段の入れ子。外側ほどゆっくりした量を決め、内側が舵を動かす。
//
//   高度のずれ → 昇降率 → ピッチ角 → エレベーター
//   方位のずれ → バンク角          → エルロン
//   速度のずれ →                    → スロットル
//
// どの段も比例＋角速度の微分（PD）で、これは既にトリム計算や垂直離着陸の
// 姿勢制御で使っている形と同じ。**符号は実測して決めてある**——
//   ピッチ：controls.pitch を + にすると pitchDeg が増え、angularVelocity.x も +
//   ロール：controls.roll  を + にすると rollDeg  が増えるが angularVelocity.z は −
//   ヨー  ：controls.yaw   を + にすると headingDeg が増える（地上の前輪も同じ向き）
// なのでロールの減衰だけ足し算になる。ここを取り違えると発散する。
//
// 機体はBuilderで作った何でもが来る。練習機からサンダーバードまで、
// 重さも推力も舵の効きも桁が違うので、ゲインは「角度の誤差」で書き、
// 速度は失速速度を基準にした倍率で決める。機体ごとの調整表は持たない。

// --- 段ごとのゲイン -----------------------------------------------------------

const AP_PITCH_KP = 0.06;      // ピッチ角のずれ1°あたりのエレベーター
const AP_PITCH_KD = 0.9;       // ピッチ角速度(rad/s)への戻し
const AP_TRIM_RATE = 0.22;     // 残った舵をトリムへ逃がす速さ（＝積分項。毎秒）
const AP_ROLL_KP = 0.055;      // バンク角のずれ1°あたりのエルロン
const AP_ROLL_KD = 0.9;        // ロール角速度(rad/s)への戻し（符号は+：上のコメント参照）
const AP_HDG_KP = 1.5;         // 方位のずれ1°あたり、何度傾けるか
const AP_BANK_MAX = 25;        // 自動操縦が使うバンク角の上限(°)。低速機（〜194kt）はここまで
const AP_VS_KP = 0.10;         // 高度のずれ1mあたりの昇降率(m/s)
const AP_PITCH_FROM_VS = 0.9;  // 昇降率のずれ1m/sあたり、何度ピッチを足すか
const AP_THR_KP = 0.10;        // 速度のずれ1m/sあたり、毎秒どれだけスロットルを動かすか
const AP_YAW_KP = 0.05;        // 横滑り1°あたりのラダー（旋回の釣り合い）
const AP_STEER_KP = 0.05;      // 地上：方位のずれ1°あたりの前輪

const AP_PITCH_MAX = 15;       // 自動操縦が指示するピッチ角の上限(°)
const AP_PITCH_MIN = -12;      //                            下限(°)

// --- 経路の形 -----------------------------------------------------------------

const AP_GLIDE_DEG = 3;        // 進入の降下角。実機と同じ3°
const AP_FINAL_M = 9000;       // 最終進入を始める点（滑走路末端からの距離 m）
const AP_DESCENT_SLOPE = 1 / 20; // 巡航からの降下勾配（約2.9°）
const AP_TOUCHDOWN_M = 200;    // 末端から何m先を目標に降ろすか

// --- 小道具 -------------------------------------------------------------------

// 角度の差を -180〜180 に畳む
function apWrap180(deg) {
  return ((deg + 540) % 360) - 180;
}

function apClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// 方位(°) → 前方向の単位ベクトル。方位0は -Z（10-flight.js と同じ約束）
function apForward(headingDeg) {
  const r = headingDeg * Math.PI / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

// 方位(°) → 右方向の単位ベクトル
function apRight(headingDeg) {
  const r = headingDeg * Math.PI / 180;
  return { x: Math.cos(r), z: Math.sin(r) };
}

// 地点(x,z)へ向かう方位(°)
function apBearingTo(fromX, fromZ, toX, toZ) {
  return (Math.atan2(toX - fromX, -(toZ - fromZ)) * 180 / Math.PI + 360) % 360;
}

// --- 内側の段（舵） -----------------------------------------------------------

// 指示のピッチ角を保つエレベーター。
//
// 比例と微分だけでは足りない。フラップを下ろす、脚を出す、燃料は減らないが速度は変わる——
// 釣り合いの取れる舵の位置は飛んでいる間ずっと動き、比例項は「ずれが残ったまま」で
// 止まってしまう（実際、進入でフラップを全開にした途端に降下が止まった）。
// 残った舵をゆっくりトリムへ移すことで、これを積分項として働かせる。
// 人間が飛ばすときにトリムを取り直すのと同じことを、機械にやらせている。
function apElevatorForPitch(state, controls, wantPitchDeg, dt) {
  const cmd = apClamp((wantPitchDeg - state.pitchDeg) * AP_PITCH_KP
    - state.angularVelocity.x * AP_PITCH_KD, -1, 1);
  // 舵が振り切っている間は溜め込まない（大きく姿勢を変えている最中の巻き上がり防止）
  if (dt && Math.abs(cmd) < 0.9) {
    controls.trim = apClamp((controls.trim || 0) + cmd * AP_TRIM_RATE * dt, -1, 1);
  }
  return cmd;
}

// 指示のバンク角を保つエルロン。ロール角速度は符号が逆なので足す。
function apAileronForBank(state, wantBankDeg) {
  return apClamp((wantBankDeg - state.rollDeg) * AP_ROLL_KP
    + state.angularVelocity.z * AP_ROLL_KD, -1, 1);
}

// --- 中間の段 -----------------------------------------------------------------

// 昇降率の上限は「経路角」で決める。**推力から決めてはいけない**——
// 降りるのに推力は要らないので、推力の小さい重い機体で降下を頭打ちにしてしまい、
// 3°の進入線に一生乗れなくなる（実際、大型機で滑走路を素通りした）。
// 同じ角度でも速い機体ほど昇降率は大きくなり、それが正しい。
const AP_CLIMB_DEG = 7;  // 高度を取り戻すときの上昇角
const AP_SINK_DEG = 5;   // 高度を落とすときの降下角（3°の進入より少しきつい程度）

function apVsLimits(state) {
  const v = Math.max(state.airspeed, 10);
  return {
    up: v * Math.sin(AP_CLIMB_DEG * Math.PI / 180),
    down: v * Math.sin(AP_SINK_DEG * Math.PI / 180),
  };
}

// 高度のずれ → 目標の昇降率(m/s)。上限は上下で別（上げるのは推力次第、下げるのは自由）
function apVsForAltitude(state, targetAltM, upMax, downMax) {
  const lim = apVsLimits(state);
  return apClamp((targetAltM - state.altitudeM) * AP_VS_KP,
    -(downMax === undefined ? lim.down : downMax),
    upMax === undefined ? lim.up : upMax);
}

// 傾いた経路（降下や進入）を追うときの昇降率。
//
// 「高度のずれ×比例」だけでは、下り坂を追いかけると必ず遅れる——
// ずれが無ければ降下率もゼロになってしまうので、降下率を出すには
// ずれが残り続けるしかない。大型機で3°の進入線から60m浮いたまま
// 滑走路を通り過ぎたのがこれ。**経路そのものが要求する降下率を先に足す**（前送り）。
function apVsForPath(state, wantAltM, slope, upMax) {
  const lim = apVsLimits(state);
  const feedForward = -Math.max(state.groundSpeed, 0) * slope;
  return apClamp(feedForward + (wantAltM - state.altitudeM) * AP_VS_KP,
    -lim.down, upMax === undefined ? lim.up : upMax);
}

// 目標の昇降率 → 目標のピッチ角(°)
//
// ピッチ角 ＝ 経路角 ＋ 迎角。いまの迎角を足しておくと、機体ごとに違う
// 「水平飛行のときのピッチ」を測らずに済む。残りは昇降率の誤差で詰める。
function apPitchForVs(state, vsCmd, loDeg, hiDeg) {
  const v = Math.max(state.airspeed, 1);
  const gammaDeg = Math.asin(apClamp(vsCmd / v, -0.5, 0.5)) * 180 / Math.PI;
  const want = gammaDeg + state.alphaDeg + (vsCmd - state.verticalSpeed) * AP_PITCH_FROM_VS;
  return apClamp(want, loDeg === undefined ? AP_PITCH_MIN : loDeg,
    hiDeg === undefined ? AP_PITCH_MAX : hiDeg);
}

// 目標の方位 → 目標のバンク角(°)
function apBankForHeading(state, wantHeadingDeg, bankMax) {
  const err = apWrap180(wantHeadingDeg - state.headingDeg);
  const lim = bankMax === undefined ? AP_BANK_MAX : bankMax;
  return apClamp(err * AP_HDG_KP, -lim, lim);
}

// いま地面に対して進んでいる向き（＝航跡）。横風があると機首の向きとずれる。
function apGroundTrackDeg(state) {
  const v = state.velocity;
  if (v.x * v.x + v.z * v.z < 1) return state.headingDeg;
  return (Math.atan2(v.x, -v.z) * 180 / Math.PI + 360) % 360;
}

// 「この向きへ地面を進みたい」に対するエルロン。
//
// 機首の向きを合わせるだけでは横風で流される。機首を風上へ何度向ければいいかは
// 風速と対気速度で決まるが、それを計算しなくても——**航跡のずれで舵を切れば
// 必要なぶんだけ勝手に機首が風上へ向く**。横風25km/hで中心線から130m流された
// のがこれで、方位ではなく航跡を見るようにして直した。
function apAileronForTrack(state, wantTrackDeg, bankMax) {
  const err = apWrap180(wantTrackDeg - apGroundTrackDeg(state));
  const lim = bankMax === undefined ? AP_BANK_MAX : bankMax;
  return apAileronForBank(state, apClamp(err * AP_HDG_KP, -lim, lim));
}

// 速度を保つスロットル（今の値から少しずつ動かす）
function apThrottleForSpeed(state, controls, targetMps, dt) {
  const err = targetMps - state.airspeed;
  return apClamp(controls.throttle + err * AP_THR_KP * dt, 0, 1);
}

// 旋回の釣り合い。横滑りを打ち消す向きへラダーを当てる。
function apRudderForCoordination(state) {
  return apClamp(-state.betaDeg * AP_YAW_KP, -0.5, 0.5);
}

// --- 機体ごとの速度の目安 -------------------------------------------------------

// 巡航中に許す旋回半径の上限（m）。バンクさせる旋回の半径は v²/(g·tanθ) で
// 速度の2乗に効くので、最高速度が桁外れな機体（フィクションの超音速機で
// マッハ21のように入力されることがある）をそのまま97%まで加速させると、
// バンク角を目一杯（AP_BANK_MAX）使っても半径が数千kmになり、
// 事実上まっすぐにしか飛べなくなる——実際、マッハ10まで出ていた機体が
// 目的地へ旋回できず素通りし続けた。「できるだけ速く」は「実際に着ける
// 速さで」という意味のはずなので、曲がれる速さを上限にする。
const AP_CRUISE_TURN_RADIUS_MAX = 40000;

// 旋回半径は「世界の大きさに対して」だけでなく、**いま飛んでいるルートの長さに
// 対しても**無理のない値に抑える。旋回そのものに使う弧の長さは半径×旋回角で、
// 目的地までの直線距離よりそれが長ければ、いくら旋回しても目的地の方を向けない
// まま延々と周り続ける——実際、目的地まで数十kmしかないところへ、上の
// AP_CRUISE_TURN_RADIUS_MAX（世界の大きさから決めた40km）をそのまま使う超音速機を
// 飛ばすと、旋回半径のほうが目的地までの距離より大きく、旋回できず（＝直進のまま）
// 目的地の周りをフラフラ回り続けて一生降りられなくなった。
const AP_TURN_RADIUS_ROUTE_FRACTION = 1 / 6; // 目的地までの距離の、これぶんまでに抑える
const AP_TURN_RADIUS_MIN = 3000;             // 極端に近い目的地でも、これより短くはしない
function apCruiseTurnRadiusMax(distToGoM) {
  if (!(distToGoM > 0)) return AP_CRUISE_TURN_RADIUS_MAX;
  return apClamp(distToGoM * AP_TURN_RADIUS_ROUTE_FRACTION, AP_TURN_RADIUS_MIN, AP_CRUISE_TURN_RADIUS_MAX);
}

// バンク角の上限は、機体の最高速度が上がるほど引き上げる。
// AP_BANK_MAX（25°）は民間機の常用域——乗客がいる想定でゆったり曲がる角度で、
// 遅い機体はそのまま使う。実機の戦闘機はもっと深く傾けて旋回半径を詰めており
// （tanθが効くので、25°→60°で半径は1/3強になる）、速い機体ほどそちらへ寄せる。
// ここを上げないと、速い機体ほど「バンクを目一杯使っても曲がりきれない」影響を
// 強く受ける（AP_CRUISE_TURN_RADIUS_MAXのコメント参照）——上限そのものを
// 引き上げれば、同じ半径でもっと速く巡航でき、旋回性能が上がる。
// マッハ2見当（680m/s）より速い機体（フィクションの超音速機）は60°で頭打ちにする。
const AP_BANK_MAX_FAST = 60;   // 高速機のバンク角上限(°)
const AP_BANK_SPEED_LO = 100;  // この速さ(m/s、約194kt)以下は低速機としてAP_BANK_MAXのまま
const AP_BANK_SPEED_HI = 680;  // この速さ(m/s、マッハ2見当)でAP_BANK_MAX_FASTに達する
function apBankMaxFor(vMax) {
  const t = apClamp((vMax - AP_BANK_SPEED_LO) / (AP_BANK_SPEED_HI - AP_BANK_SPEED_LO), 0, 1);
  return AP_BANK_MAX + t * (AP_BANK_MAX_FAST - AP_BANK_MAX);
}

// 失速速度から、離陸・上昇・巡航・進入の速度を決める。
// analyzeAircraftPerformance と同じ式で失速速度を出す（重い呼び出しは避ける）。
// distToGoM（目的地までの距離）を渡すと、旋回半径をそのルートの長さに合わせて絞る
// （渡さなければ世界の大きさから決めた上限のまま——目的地未設定の高度維持モードなど）。
function apSpeedSchedule(model, distToGoM) {
  const W = model.massKg * 9.80665;
  const S = Math.max(model.wingArea, 0.01);
  const stall = Math.sqrt((2 * W) / (1.225 * S * 1.5));
  const vMax = Math.max(model.vMaxMps || 0, stall * 2);
  const bankMax = apBankMaxFor(vMax);
  const radiusMax = apCruiseTurnRadiusMax(distToGoM);
  const turnableV = Math.sqrt(radiusMax * 9.80665
    * Math.tan(bankMax * Math.PI / 180));
  return {
    stall,
    rotate: stall * 1.15,               // 機首を上げる速度
    climb: apClamp(stall * 1.35, stall * 1.2, vMax * 0.6),
    // 巡航はできるだけ速く——ただし旋回できる速さを超えない範囲で。
    // ぴったり最高速度を目標にすると、推力と抵抗がほぼ釣り合ったところを
    // 延々スロットルで追いかけることになるだけなので、97%で十分
    // （届かなければ出力は自然に全開のまま張り付く）。
    cruise: apClamp(Math.min(vMax * 0.97, turnableV), stall * 1.4, vMax),
    approach: stall * 1.3,
    vMax,
    bankMax, // 巡航中（nav()）が実際に使うバンク角の上限。進入・引き起こしはこれより浅い固定値のまま
  };
}

// 上昇していい量を、速度の余裕から決める。
//
// 高度を追いかけて速度を使い切るのが、自動操縦のいちばん危ない壊れ方——
// 高度維持を入れたまま出力を絞ると、機首を上げ続けて失速速度の下で
// ぶら下がったまま飛ぶことになる（実際、練習機が失速速度以下の27m/sで200秒飛んだ）。
// 出力は操縦者が持っていることもあるので、余裕が無ければ高度をあきらめる。
function apClimbCap(state, spd) {
  return Math.max((state.airspeed - spd.stall * 1.15) * 1.5, 0);
}

// --- 目的地の滑走路をどう使うか --------------------------------------------------
//
// 追い風で降りると止まれないので、風上へ向かう側の末端から進入する。
// 出発のとき（12-flight-mode.js の resetFlightToRunway）と同じ選び方。
function apPickRunwayHeading(headingDeg, windDirectionDeg) {
  const a = ((headingDeg % 360) + 360) % 360;
  const b = (a + 180) % 360;
  const from = (windDirectionDeg + 180) % 360; // 風が吹いてくる方角
  const diff = (p, q) => Math.abs(apWrap180(p - q));
  return diff(a, from) <= diff(b, from) ? a : b;
}

// 進入の計画を作る。
//   aim   … 接地を狙う点（末端から少し先）
//   faf   … 最終進入を始める点（延長線上、末端から AP_FINAL_M 手前）
// 高度はすべて平均海面から。
function apMakeApproachPlan(airport, settings, windDirectionDeg) {
  const heading = apPickRunwayHeading(settings.headingDeg, windDirectionDeg);
  const f = apForward(heading);
  const half = settings.runwayLengthM * 0.5;
  const elev = airport.elevationM || 0;

  // 進入端（手前側の末端）
  const thrX = airport.x - f.x * half;
  const thrZ = airport.z - f.z * half;
  const aimX = thrX + f.x * AP_TOUCHDOWN_M;
  const aimZ = thrZ + f.z * AP_TOUCHDOWN_M;
  const fafX = thrX - f.x * AP_FINAL_M;
  const fafZ = thrZ - f.z * AP_FINAL_M;
  const glide = Math.tan(AP_GLIDE_DEG * Math.PI / 180);

  return {
    airportId: airport.id,
    heading, forward: f, right: apRight(heading),
    elevationM: elev,
    runwayLengthM: settings.runwayLengthM,
    aim: { x: aimX, z: aimZ },
    threshold: { x: thrX, z: thrZ },
    faf: { x: fafX, z: fafZ },
    fafAltM: elev + (AP_FINAL_M + AP_TOUCHDOWN_M) * glide,
    glide,
  };
}

// 引き起こしを始める高さ。大型機ほど高い位置から機首を起こす。
function apFlareHeight(model) {
  return apClamp(model.wingSpan * 0.5, 6, 20);
}

// 機体が進入経路のどこにいるか。
//   before … 接地点まであと何m（負なら通り過ぎた）
//   cross  … 中心線から右へ何m（負なら左）
function apTrackPosition(plan, x, z) {
  const dx = x - plan.aim.x, dz = z - plan.aim.z;
  const along = dx * plan.forward.x + dz * plan.forward.z;
  const cross = dx * plan.right.x + dz * plan.right.z;
  return { before: -along, cross };
}

// --- 状態を作る ---------------------------------------------------------------

function createAutopilotState() {
  return {
    altHold: false,        // 高度維持だけ（横は手動）
    full: false,           // 離陸から着陸まで全自動
    targetAltitudeM: 1500,
    destAirportId: null,
    phase: 'off',          // takeoff / climb / cruise / descent / approach / flare / rollout / done
    plan: null,            // apMakeApproachPlan の結果
    statusText: '',
    // 表示用
    vsCmd: 0, targetHeadingDeg: 0, targetSpeedMps: 0, distanceM: 0,
  };
}

// --- 全自動の本体 ---------------------------------------------------------------
//
// 段階を1つの関数で回す。段階が変わる条件は「高度」「距離」「接地」の3つだけで、
// 時間で切り替えない——機体によって加速も上昇率も違うため。
//
// 引数の env は環境から渡すぶん：{ groundHeightAt, windDirectionDeg, announce }
function apStepFull(model, state, controls, ap, spd, dt, env) {
  const plan = ap.plan;
  const say = (phase, text) => {
    if (ap.phase === phase) return;
    ap.phase = phase;
    ap.statusText = text;
    if (env && env.announce) env.announce('自動操縦：' + text);
  };

  controls.parkingBrake = false;

  // 目的地までの距離（進入計画があれば最終進入開始点まで）
  const tx = plan ? plan.faf.x : state.position.x;
  const tz = plan ? plan.faf.z : state.position.z;
  const distFaf = Math.hypot(state.position.x - tx, state.position.z - tz);
  ap.distanceM = distFaf;

  // ---- 離陸滑走 -------------------------------------------------------------
  if (ap.phase === 'takeoff') {
    controls.throttle = 1;
    controls.brake = 0;
    controls.gearDown = true;
    // 前輪で滑走路の方位を保つ
    const err = apWrap180(ap.takeoffHeadingDeg - state.headingDeg);
    controls.yaw = apClamp(err * AP_STEER_KP, -1, 1);
    controls.roll = apAileronForBank(state, 0);
    if (state.forwardAirspeed < spd.rotate) {
      controls.pitch = 0; // 引き起こす速度までは舵を当てない（尻もちを防ぐ）
    } else {
      controls.pitch = apElevatorForPitch(state, controls, 10, dt); // 機首を10°へ
    }
    if (!state.onGround && state.altitudeAglM > 25) {
      say('climb', '上昇');
      controls.gearDown = false;
    }
    return;
  }

  // ---- 進入より前の共通部分（横は目的地へ向ける） -----------------------------
  const nav = () => {
    const want = plan ? apBearingTo(state.position.x, state.position.z, tx, tz) : state.headingDeg;
    ap.targetHeadingDeg = want;
    controls.roll = apAileronForTrack(state, want, spd.bankMax);
    controls.yaw = apRudderForCoordination(state);
  };

  // ---- 上昇 -----------------------------------------------------------------
  if (ap.phase === 'climb') {
    controls.gearDown = false;
    controls.flap = 0;
    nav();
    ap.targetSpeedMps = spd.climb;
    // 上昇は基本「速度を保つように機首を上げ下げする」で、出力は全開のまま
    // （ふつうの機体は、姿勢を目一杯（15°）まで上げれば抗力が増えて頭打ちになる）。
    // ただし推力重量比が桁外れな機体（実機の何倍もの推力を持つフィクションの
    // 超音速機）は、姿勢を上げるだけでは頭打ちにならず、上昇中に秒速数kmまで
    // 加速して目的地をはるかに通り過ぎてしまう——旋回半径は速度の2乗で効くので、
    // 曲がれる速さ（spd.cruise）を大きく超えたまま飛び続けると、そのぶん先で
    // 目的地の周りを永遠に旋回するはめになる（実際、旋回できずフラフラする
    // 報告になった）。曲がれる速さの1.5倍を超えたら、そこだけ出力を絞る。
    const overCruise = state.airspeed - spd.cruise * 1.5;
    controls.throttle = overCruise > 0 ? apClamp(1 - overCruise * 0.1, 0, 1) : 1;
    const want = apClamp(state.pitchDeg + (state.airspeed - spd.climb) * 0.8, 0, AP_PITCH_MAX);
    controls.pitch = apElevatorForPitch(state, controls, want, dt);
    ap.vsCmd = state.verticalSpeed;
    if (state.altitudeM > ap.targetAltitudeM - 60) say('cruise', '巡航');
    return;
  }

  // ---- 巡航 -----------------------------------------------------------------
  if (ap.phase === 'cruise') {
    nav();
    ap.targetSpeedMps = spd.cruise;
    controls.throttle = apThrottleForSpeed(state, controls, spd.cruise, dt);
    ap.vsCmd = apVsForAltitude(state, ap.targetAltitudeM, apClimbCap(state, spd));
    controls.pitch = apElevatorForPitch(state, controls, apPitchForVs(state, ap.vsCmd), dt);
    // 3°で降りきれる距離まで詰まったら降下へ。少し余裕を持たせる。
    if (plan) {
      const drop = Math.max(state.altitudeM - plan.fafAltM, 0);
      if (distFaf < drop / AP_DESCENT_SLOPE + 3000) say('descent', '降下');
    }
    return;
  }

  // ---- 降下 -----------------------------------------------------------------
  if (ap.phase === 'descent') {
    nav();
    ap.targetSpeedMps = spd.cruise * 0.85;
    controls.throttle = apThrottleForSpeed(state, controls, ap.targetSpeedMps, dt);
    // 最終進入開始点の高度へ、一定の勾配で降りる
    const wantAlt = Math.min(plan.fafAltM + distFaf * AP_DESCENT_SLOPE, ap.targetAltitudeM);
    // 目標が巡航高度で頭打ちのあいだは、まだ坂に乗っていない＝前送りは要らない
    const onSlope = wantAlt < ap.targetAltitudeM - 1;
    ap.vsCmd = apVsForPath(state, wantAlt, onSlope ? AP_DESCENT_SLOPE : 0, apClimbCap(state, spd));
    controls.pitch = apElevatorForPitch(state, controls, apPitchForVs(state, ap.vsCmd), dt);
    if (distFaf < 2500) say('approach', '最終進入');
    return;
  }

  // ---- 最終進入（中心線と3°の降下角） ------------------------------------------
  if (ap.phase === 'approach') {
    const t = apTrackPosition(plan, state.position.x, state.position.z);
    ap.distanceM = t.before;

    // 横：中心線からのずれを方位で詰める。近づくほど滑走路の方位そのものへ寄せる。
    const corr = apClamp(-t.cross * 0.06, -35, 35);
    const want = plan.heading + corr;
    ap.targetHeadingDeg = (want + 360) % 360;
    controls.roll = apAileronForTrack(state, want, 20);
    // 接地の直前だけ、横滑りを消すより滑走路と機首を合わせるほうを優先する。
    // 斜めを向いたまま降りると脚をねじるが、早くから機首を合わせてしまうと
    // 今度は横風でそのぶん流されるので、引き起こしにかかる高さで切り替える。
    controls.yaw = state.altitudeAglM < apFlareHeight(model) * 2
      ? apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP, -1, 1)
      : apRudderForCoordination(state);

    // 縦：接地点まであと何mかで高度が決まる
    const wantAlt = plan.elevationM + Math.max(t.before, 0) * plan.glide;
    // 進入では上げ過ぎない（高すぎたときは降りるほうを優先する）
    ap.vsCmd = apVsForPath(state, wantAlt, plan.glide,
      Math.min(apClimbCap(state, spd), Math.max(state.airspeed * 0.05, 2)));
    controls.pitch = apElevatorForPitch(state, controls, apPitchForVs(state, ap.vsCmd, -8, 12), dt);

    ap.targetSpeedMps = spd.approach;
    controls.throttle = apThrottleForSpeed(state, controls, spd.approach, dt);
    controls.gearDown = true;
    // フラップは残りの距離で下ろす。高度で決めると、高い空港と低い空港で
    // 下ろす場所がずれる（進入経路のどこにいるかが本当に効く量）。
    controls.flap = t.before < 2500 ? 1 : 0.5;

    // 接地の直前で引き起こす。高さは機体の大きさで決める（大型機ほど高い位置で）。
    // **滑走路の近くにいることも条件にする**——対地高度だけで決めると、
    // 何km も手前で盛り上がった山の上を通っただけで引き起こしに入ってしまう。
    if (t.before < 600 && state.altitudeAglM < apFlareHeight(model)) { say('flare', '接地'); return; }

    // 降りられなかったときはやり直す。滑走路の半ばを過ぎてもまだ浮いているなら、
    // そのまま降ろしても止まりきれない。ここで諦めないと素通りしたまま飛び続ける。
    if (t.before < -plan.runwayLengthM * 0.35) say('goaround', 'やり直し（もう一度進入）');

    // 旋回半径が大きい機体（速い機体ほど）は、中心線から大きくずれたまま
    // 最終進入点に着くことがある——横のずれを詰めきる前に滑走路が迫ってしまい、
    // このまま進んでも間に合わない。滑走路が近いのに中心線から大きくずれている
    // ときは、素通りするのを待たずにやり直す（実際、これが無いと合わせきれない
    // まま延々と進入を続け、いつまで経っても着陸できなかった）。
    if (t.before < 4000 && Math.abs(t.cross) > 2000) say('goaround', 'やり直し（中心線に乗り切れない）');
    return;
  }

  // ---- やり直し（進入復行）---------------------------------------------------
  //
  // 巡航高度まで戻すと行って来いが大きすぎるので、最終進入開始点の高度まで上げて、
  // その点へ向き直し、近づいたらもう一度進入に入る。飛行場の周りを回るのと同じ。
  if (ap.phase === 'goaround') {
    controls.flap = 0.5;
    controls.gearDown = false;
    controls.throttle = 1;
    nav();
    const wantAlt = plan.fafAltM + 150;
    ap.vsCmd = apVsForAltitude(state, wantAlt, apClimbCap(state, spd));
    ap.targetSpeedMps = spd.climb;
    controls.pitch = apElevatorForPitch(state, controls, apPitchForVs(state, ap.vsCmd), dt);
    // 最終進入開始点に戻って、高度も合っていれば進入をやり直す
    if (distFaf < 2500 && Math.abs(state.altitudeM - wantAlt) < 250) say('approach', '最終進入');
    return;
  }

  // ---- 引き起こし -----------------------------------------------------------
  if (ap.phase === 'flare') {
    const corr = apClamp(-apTrackPosition(plan, state.position.x, state.position.z).cross * 0.06, -12, 12);
    controls.roll = apAileronForTrack(state, plan.heading + corr, 8);
    controls.yaw = apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP, -1, 1);
    controls.throttle = Math.max(controls.throttle - dt * 0.8, 0);

    // 沈下率は残りの高さに比例させる。一定の沈下率にすると、速い機体ほど
    // 何kmも浮いたまま滑走路を使い切ってしまう（大型機が2.7km先で接地した）。
    // 高いうちは速く、地面に近づくほどゆっくり——実際の引き起こしと同じ形。
    ap.vsCmd = -Math.max(state.altitudeAglM * 0.22, 0.3);
    // 接地の姿勢は少し機首上げ。前輪から落とすと跳ねる。
    const want = apClamp(apPitchForVs(state, ap.vsCmd, -3, 10), state.pitchDeg - 1, 10);
    controls.pitch = apElevatorForPitch(state, controls, want, dt);

    if (state.onGround) say('rollout', '滑走路上で減速');
    return;
  }

  // ---- 減速 -----------------------------------------------------------------
  if (ap.phase === 'rollout') {
    controls.throttle = 0;
    controls.flap = 1;
    controls.roll = apAileronForBank(state, 0);
    controls.yaw = apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP, -1, 1);
    // 跳ねて浮いたら、ブレーキを離してもう一度接地の姿勢へ。
    // 浮いている間に舵を中立へ落とすと、前輪から突っ込むことになる。
    if (!state.onGround) {
      controls.brake = 0;
      controls.pitch = apElevatorForPitch(state, controls, apClamp(state.pitchDeg, 0, 8), dt);
      return;
    }
    controls.pitch = 0;
    controls.trim = 0; // 接地で溜めた機首上げを残すと、前輪が浮いて舵が効かない
    controls.brake = 1;
    if (state.groundSpeed < 1.5) {
      controls.brake = 0;
      controls.parkingBrake = true;
      controls.yaw = 0;
      say('done', `${plan.airportId} に着陸しました`);
      ap.full = false;
    }
    return;
  }
}

// 高度維持だけ（横と出力は手動のまま）
function apStepAltHold(model, state, controls, ap, spd, dt) {
  ap.vsCmd = apVsForAltitude(state, ap.targetAltitudeM, apClimbCap(state, spd));
  controls.pitch = apElevatorForPitch(state, controls, apPitchForVs(state, ap.vsCmd), dt);
  // 翼を水平に戻すのは、手でロールを当てていないときだけ
  if (Math.abs(controls.roll) < 0.02) controls.roll = apAileronForBank(state, 0);
}

// 自動操縦を1フレーム進める（環境に依らない本体）
function stepAutopilot(model, state, controls, ap, dt, env) {
  if (state.crashed) { ap.full = false; ap.altHold = false; ap.phase = 'off'; return; }
  // 目的地までの距離（進入計画があれば最終進入開始点まで）。旋回半径をルートの
  // 長さに合わせて絞るのに使う（apCruiseTurnRadiusMax参照）。
  const distToGoM = ap.plan
    ? Math.hypot(ap.plan.faf.x - state.position.x, ap.plan.faf.z - state.position.z)
    : undefined;
  const spd = apSpeedSchedule(model, distToGoM);
  if (ap.full) apStepFull(model, state, controls, ap, spd, dt, env);
  else if (ap.altHold) apStepAltHold(model, state, controls, ap, spd, dt);
}

// ============================================================================
// ここから下は環境（EnvState・DOM）につなぐぶん。Nodeの検証では読み込まない。
// ============================================================================

// 自動操縦の状態を取り出す（無ければ作る）
function flightAutopilot() {
  const f = EnvState.flight;
  if (!f.autopilot) f.autopilot = createAutopilotState();
  return f.autopilot;
}

// 目的地の空港（選ばれていなければ null）
function autopilotDestination() {
  const ap = flightAutopilot();
  if (!ap.destAirportId) return null;
  return worldAirportById(ap.destAirportId);
}

// 全自動を入れる。出発は「いま機体がいる場所」、目的地はセレクトで選んだ空港。
function startFullAutopilot() {
  const f = EnvState.flight;
  const ap = flightAutopilot();
  if (!f.active || !f.aircraft) { announceFlight('先に飛行を始めてください'); return false; }

  const dest = autopilotDestination();
  if (!dest) { announceFlight('目的地の空港を選んでください'); return false; }
  if (dest.id === EnvState.selectedAirportId && f.state.onGround) {
    announceFlight('目的地が出発の空港と同じです');
    return false;
  }

  ap.plan = apMakeApproachPlan(dest, getAirportSettings(dest.id), EnvState.env.windDirectionDeg);
  ap.full = true;
  ap.altHold = false;
  ap.takeoffHeadingDeg = f.state.headingDeg;
  ap.phase = f.state.onGround ? 'takeoff' : 'cruise';
  ap.statusText = f.state.onGround ? '離陸' : '巡航';
  announceFlight(`自動操縦：${dest.id} ${dest.name} へ — ${ap.statusText}`);
  updateAutopilotUI();
  return true;
}

function stopAutopilot(reason) {
  const ap = flightAutopilot();
  if (!ap.full && !ap.altHold) return;
  ap.full = false;
  ap.altHold = false;
  ap.phase = 'off';
  ap.statusText = '';
  announceFlight(reason || '自動操縦：解除');
  updateAutopilotUI();
}

function toggleAltitudeHold() {
  const f = EnvState.flight;
  const ap = flightAutopilot();
  if (ap.full) { stopAutopilot('自動操縦：解除'); return; }
  if (!f.active || !f.aircraft) { announceFlight('先に飛行を始めてください'); return; }
  ap.altHold = !ap.altHold;
  if (ap.altHold) {
    // 入れた瞬間の高度が目標——今いるところを保ちたいのが普通なので。
    // ただし地上や地面すれすれなら、スライダーで決めた高度をそのまま使う。
    if (!f.state.onGround && f.state.altitudeAglM > 60) {
      ap.targetAltitudeM = Math.round(f.state.altitudeM / 10) * 10;
    }
    announceFlight(`高度維持：${Math.round(ap.targetAltitudeM).toLocaleString()} m`);
  } else {
    announceFlight('高度維持：解除');
  }
  updateAutopilotUI();
}

// 毎フレーム。updateFlightInput のあとに呼ぶので、自分が持つ舵だけ上書きする。
function updateAutopilot(dt) {
  const f = EnvState.flight;
  if (!f.active || !f.aircraft) return;
  const ap = f.autopilot;
  if (!ap || (!ap.full && !ap.altHold)) return;

  const wasPhase = ap.phase;
  stepAutopilot(f.aircraft.model, f.state, f.controls, ap, dt, {
    announce: announceFlight,
  });
  if (ap.phase !== wasPhase) updateAutopilotUI();
}

// --- 画面 ---------------------------------------------------------------------

function setupAutopilotUI() {
  const ap = flightAutopilot();

  const dest = document.getElementById('envApDestination');
  if (dest) {
    const none = document.createElement('option');
    none.value = ''; none.textContent = '（選んでいません）';
    dest.appendChild(none);
    for (const country of WORLD_COUNTRIES) {
      const list = WORLD_AIRPORTS.filter((a) => a.country === country.id);
      if (!list.length) continue;
      const group = document.createElement('optgroup');
      group.label = country.name;
      for (const a of list) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = `${a.id}  ${a.name}`;
        group.appendChild(opt);
      }
      dest.appendChild(group);
    }
    dest.value = ap.destAirportId || '';
    dest.addEventListener('change', () => {
      ap.destAirportId = dest.value || null;
      // 飛んでいる途中で行き先を変えたら、経路も引き直す
      if (ap.full && ap.destAirportId) {
        const d = worldAirportById(ap.destAirportId);
        if (d) ap.plan = apMakeApproachPlan(d, getAirportSettings(d.id), EnvState.env.windDirectionDeg);
      }
      updateAutopilotUI();
      onEnvSettingsChanged();
      // 選び終わったら焦点を離す。セレクトに焦点が残っていると、
      // そのまま I を押しても「入力欄で打っている」と見なされて効かない。
      dest.blur();
    });
  }

  const alt = document.getElementById('envApAltitude');
  if (alt) {
    alt.value = ap.targetAltitudeM;
    alt.addEventListener('input', () => {
      ap.targetAltitudeM = parseFloat(alt.value);
      updateAutopilotUI();
    });
    alt.addEventListener('change', onEnvSettingsChanged);
  }

  const hold = document.getElementById('envApAltHold');
  if (hold) hold.addEventListener('change', () => {
    if (hold.checked !== flightAutopilot().altHold) toggleAltitudeHold();
  });

  const full = document.getElementById('envBtnApFull');
  if (full) full.addEventListener('click', () => {
    if (flightAutopilot().full) stopAutopilot();
    else startFullAutopilot();
  });

  updateAutopilotUI();
}

// 状態 → 画面（右パネルとHUD）
function updateAutopilotUI() {
  const ap = flightAutopilot();
  const hold = document.getElementById('envApAltHold');
  if (hold) hold.checked = ap.altHold;
  const alt = document.getElementById('envApAltitude');
  if (alt) alt.value = ap.targetAltitudeM;
  const altR = document.getElementById('envApAltReadout');
  if (altR) altR.textContent = Math.round(ap.targetAltitudeM).toLocaleString() + ' m';
  const btn = document.getElementById('envBtnApFull');
  if (btn) btn.textContent = ap.full ? '⏹ 自動操縦をやめる（I）' : '🛫 全自動で離陸〜着陸（I）';

  const out = document.getElementById('envApReadout');
  if (out) out.textContent = autopilotStatusLine();
}

// いま何をしているかの1行
function autopilotStatusLine() {
  const ap = flightAutopilot();
  const dest = autopilotDestination();
  if (ap.full) {
    const km = ap.distanceM > 0 ? `残り ${(ap.distanceM / 1000).toFixed(1)} km` : '';
    return `${dest ? dest.id + ' へ' : ''} ${ap.statusText}　${km}`.trim();
  }
  if (ap.altHold) return `高度 ${Math.round(ap.targetAltitudeM).toLocaleString()} m を維持中`;
  if (!dest) return '目的地を選ぶと、全自動で飛べます。';
  const f = EnvState.flight;
  if (f.state) {
    const d = Math.hypot(f.state.position.x - dest.x, f.state.position.z - dest.z) / 1000;
    return `${dest.id} ${dest.name} まで ${d.toFixed(0)} km`;
  }
  return `${dest.id} ${dest.name}`;
}

// HUDに出す短い表示（11-flight-ui.js が呼ぶ）
const AP_PHASE_LABEL = {
  takeoff: '離陸', climb: '上昇', cruise: '巡航', descent: '降下',
  approach: '進入', goaround: 'やり直し', flare: '接地', rollout: '減速', done: '着陸',
};

function autopilotHudText() {
  const ap = EnvState.flight.autopilot;
  if (!ap) return null;
  if (ap.full) return AP_PHASE_LABEL[ap.phase] || '自動';
  if (ap.altHold) return '高度維持';
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createAutopilotState, stepAutopilot, apSpeedSchedule,
    apMakeApproachPlan, apPickRunwayHeading, apTrackPosition,
    apWrap180, apBearingTo, apForward, apRight,
    apElevatorForPitch, apAileronForBank, apAileronForTrack, apGroundTrackDeg,
  apPitchForVs, apBankForHeading, apFlareHeight,
    apVsForAltitude, apThrottleForSpeed,
  };
}
