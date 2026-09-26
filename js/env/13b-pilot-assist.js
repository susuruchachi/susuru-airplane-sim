// 13b-pilot-assist.js — 手で飛ばすときの補助（姿勢の保持・旋回半径で操るレバー）
//
// 2つの操縦のしかたを切り替えられる（どちらもキーボードとタッチの両方）。
//
//   直接（いままでどおり）… レバーはエレベーター・エルロンの舵角そのもの。
//     **レバーを離したら、離した瞬間の姿勢（ピッチ角とバンク角）を保つ**。
//     保つのに要る舵とトリムは自分で当てる（トリムは積分として動かす）。
//     以前は離すと舵が中立へ戻るだけで、機体はトリムの釣り合う姿勢へ勝手に
//     戻っていった（離した姿勢は保たれない）。
//
//   旋回半径 … レバーは「どれだけきつく曲がるか」。100%がその速さでの最小旋回半径。
//     昇降舵のレバー … 上下に曲がる（引けば機首が上がる向きに回る）。100%で最小半径の宙返り。
//                     離すと、離したときの上昇角（経路角）を保つ。ほぼ水平なら高度を保つ。
//     補助翼のレバー … **高度を変えずに**左右へ水平旋回する。100%で最小半径。
//                     バンク角は半径から決まる（倒しっぱなしでもロールし続けない）。
//                     離すと翼を水平に戻して、まっすぐ飛ぶ。
//     旋回で落ちる揚力は昇降舵が自分で足す（レバーを当てていなくても高度を保つ）。
//
// 最小旋回半径は「その速さで出せる荷重倍数」で決まる。失速速度の k 倍で飛んでいれば
// 翼は k² 倍の揚力を出せる。自動操縦と同じく7割（AP_LOAD_MARGIN）までを使い、
// 85°バンク（11.5G）で頭打ちにする（apBankLimit と同じ上限）。水平旋回の半径は
// v²/(g·√(n²-1))、宙返りの半径は v²/(g·(n-1))。
//
// 中身は「欲しい角速度 → 舵」の内側の輪と、「欲しい姿勢・経路 → 欲しい角速度」の外側の輪。
//   縦 … ピッチ角速度 q を昇降舵で追う（比例＋トリムを積分に使う）。
//         欲しい q は、荷重倍数 n から q = g/v·(n − cosγ·cosφ)（γ経路角・φバンク角）。
//         姿勢の保持は Euler 角の式 θ' = q·cosφ − r·sinφ から逆に q を出す。
//   横 … バンク角を自動操縦の apAileronForBank で追う（ロール率で止めてから合わせる）。
//   ヨー … 旋回半径のときは横滑りを消すラダーを足す（apRudderForCoordination）。
// 符号（実測）：rollDeg＋で右バンク（方位が増える）、ロール率 p = −ω.z、ヨー率 r = −ω.y、
// ピッチ率 q = ω.x（機首上げ＋）。

const PA_N_HARD = 1 / Math.cos(85 * Math.PI / 180);   // 荷重倍数の上限（85°バンク相当）
const PA_Q_KP = 5;            // ピッチ率のずれ 1rad/s あたりの昇降舵
const PA_Q_KI = 2.5;          // ピッチ率のずれ 1rad/s が1秒続くと動かすトリム
// 1コマで取り返すピッチ率のずれの割合の上限。昇降舵は次のコマにはもう角速度を変えているので、
// 比例のゲイン×（舵1あたり1コマで変わるピッチ率）が2を超えると、1コマごとに行き過ぎて向きが
// 反転し、振れが育つ。速さでゲインを割り引く apSurfaceGain は「失速の4倍」を基準にした目安で、
// 実測でマッハ2級の練習機（失速の5倍・高度3000m）は舵1で1コマ0.67rad/s変わり、ゲイン5×0.64で
// 2.2。レバーを離しただけで昇降舵が±1を1コマごとに往復し、荷重倍数が-2.4Gに張り付いた。
// 舵の効き（動圧×舵の面積×腕÷慣性）を機体から出して、ここで頭を押さえる
const PA_Q_STEP_GAIN = 0.8;
const PA_THETA_K = 1.5;       // 姿勢（ピッチ角）のずれ 1rad あたりの欲しい角速度(rad/s)
const PA_GAMMA_K = 0.8;       // 経路角のずれ 1rad あたりの欲しい経路の曲がる速さ(rad/s)
const PA_ALT_KP = 0.1;        // 高度のずれ 1m あたりの昇降率(m/s)（AP_VS_KP と同じ）
const PA_ALT_HOLD_DEG = 2;    // 離したときの経路角がこれ以内なら、高度そのものを保つ
const PA_ROLL_SNAP_DEG = 1;   // 離したときのバンクがこれ以内なら水平にする（0.5°残すと少しずつ曲がる）
const PA_VERTICAL_DEG = 70;   // ピッチ・経路角がこれを超えたらバンク角は意味を持たない（真上・真下）
const PA_ROLL_RATE_KP = 2.2;  // ロール率を0に止める強さ（真上・真下を向いているとき）
// バンク角を合わせるロールの輪（自動操縦の apAileronForBank と同じ2段：角度のずれ → 欲しいロール率 → 舵）。
// 自動操縦のままのゲイン（1°あたり0.024rad/s・率のずれ1rad/sあたり2.2）では、手で倒す速さとして鈍すぎる——
// 三式戦闘機は補助翼50%（79°）まで倒すのに12秒かかった。
const PA_ROLL_PER_DEG = 0.05;   // バンクのずれ1°あたりの欲しいロール率(rad/s)
const PA_ROLL_RATE_MAX = 1.6;   // 欲しいロール率の上限(rad/s ≒ 92°/s)
const PA_ROLL_KP = 5;           // ロール率のずれ1rad/sあたりの補助翼
// 旋回の釣り合い（横滑りを消すラダー）。自動操縦の apRudderForCoordination（1°あたり0.05・±0.5まで）では
// 足りない機体がある——三式戦闘機は30m/sの補助翼100%で横滑り12〜17°のまま回り、横滑りでバンクが
// 深まるのを補助翼で押さえきれず、離しても55°から戻らなかった。比例に積分を足し、ラダーを一杯まで使う
const PA_BETA_KP = 0.08;      // 横滑り1°あたりのラダー
const PA_BETA_KI = 0.1;       // 横滑り1°が1秒続くと足すラダー
const PA_MIN_STALLS = 1.05;   // 失速速度のこれ倍より遅いときは補助しない（舵をそのまま渡す）
// 補助翼100%の水平旋回に使う荷重倍数（出せる上限に対して）。残りは高度を保つ引き上げに取っておく。
// 全部を旋回に使うと、速度が落ちたときに高度を支える余力が無く、練習機が60秒で306m沈んだ
const PA_TURN_LOAD_FRAC = 0.9;
// 迎角の守り。主翼が失速する迎角（AERO_DEFAULTS.stallDeg 15°。主翼の取付角ぶん手前）に近づいたら、
// 引いているレバーより守りを優先して機首を押さえる（実機のフライ・バイ・ワイヤの迎角保護と同じ）。
// 失速速度は翼面積と最大揚力係数1.5からの見積もりなので、機体によっては見積もりの荷重倍数まで
// 引く前に翼が失速する（TB1 が補助翼100%で失速して3,000m落ちた）。
const PA_ALPHA_PROT_DEG = 12;       // 主翼の失速迎角が測れないときの守りの迎角
const PA_ALPHA_PROT_MARGIN_DEG = 3; // 主翼が失速する機体の迎角の、これだけ手前で守る
const PA_ALPHA_K = 6;         // 守りの迎角を1rad超えたら、欲しいピッチ率から引く量(rad/s)
// 翼がいま実際に出せる荷重倍数の見積もりをならす時定数(秒)。迎角と荷重倍数から出す
const PA_NAVAIL_TAU = 1.0;
// 荷重倍数を指示へ寄せる速さ（秒）。q = g/v·(n − cosγ·cosφ) は「その荷重倍数で曲がっているときの
// ピッチ率」でしかなく、荷重倍数を**上げる**のに要る迎角の増しぶん（α'）が入っていない。
// 速い機体ほど g/v が小さいので迎角が育たず、TB1新（350m/s）は補助翼100%で荷重倍数が
// 1→2.9G に上がるまで20秒かかり、そのあいだに600m沈んだ。ずれを迎角に直して足す
const PA_LOAD_TAU = 0.5;
const PA_NFILT_TAU = 0.25;    // 荷重倍数の測り値をならす時定数(秒)
const PA_GROW_MAX_DEG = 8;    // 荷重倍数を寄せるために動かす迎角の速さの上限(°/s)
// 旋回のバンクは、いま出ている荷重倍数で重さの9割（PA_BANK_LIFT_FRAC）を支えられるところまでしか倒さない。
// 翼が揚力を出すより先に倒しきると、そのあいだ沈む（TB1新は補助翼100%を入れて6秒で22m、
// 立て直すまでに140m沈んだ）。縦の側も、要る荷重倍数を「PA_LOAD_TAU 秒先のバンク」
// （いまのロール率から）で出して、先に揚力を用意しておく。
// 荷重倍数を「いまより0.4G先まで」で縛ったときは、バンクが荷重倍数を待ち、荷重倍数がバンクを待って、
// 三式戦闘機が50%（79°）まで倒すのに12秒以上かかった。1.5G先までにすると深いバンクでは緩すぎ、
// TB1 がマッハ2で83°まで先に倒して、縦の揚力が足りないまま430m沈んだ。戻すときは縛らない（縛ると離して5秒たっても
// 80°倒れたままだった）
const PA_BANK_LIFT_FRAC = 0.9;   // 倒してよいのは、いまの荷重倍数の縦の成分が重さのこの割合を下回らないところまで

function createPilotAssist() {
  return {
    pitchHold: null,   // 直接：{ thetaDeg } ／ 旋回半径：{ gammaRad, altM | undefined }
    rollHold: null,    // 直接：{ bankDeg }
    heliHold: null,    // ヘリ：{ pitch, roll }（操縦桿の位置）
    stallModel: null, stallMps: 0,
    nAvail: null,      // 翼がいま出せる荷重倍数の見積もり（迎角の守りまで）
    elevI: 0,          // トリムの端を越えて昇降舵に積んだ積分
    nFilt: null,       // ならした荷重倍数
    yawI: 0,           // 横滑りを消すラダーの積分
    saturated: false,  // 縦の舵（トリム＋昇降舵）が振り切れているか
  };
}

function paClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// その機体の失速速度（フラップで下がる）。重い計算なので機体ごとに覚えておく
function paStallMps(model, controls, pa) {
  if (pa.stallModel !== model) {
    pa.stallModel = model;
    const s = typeof apSpeedSchedule === 'function' ? apSpeedSchedule(model) : null;
    pa.stallMps = s && s.stall > 0 ? s.stall : 0;
  }
  const flapGain = typeof AP_FLAP_STALL_GAIN === 'number' ? AP_FLAP_STALL_GAIN : 0.2;
  return pa.stallMps * (1 - flapGain * paClamp(controls.flap || 0, 0, 1));
}

// その速さで出せる荷重倍数（旋回半径100%に使う）
function paLoadMax(state, stallMps) {
  if (!(stallMps > 0)) return PA_N_HARD;
  // 失速速度は海面の空気で出してある。高いところでは同じ対気速度でも揚力が小さい
  const rho = typeof airDensityAt === 'function' ? airDensityAt(Math.max(state.altitudeM || 0, 0)) : 1.225;
  const k = Math.max(state.airspeed, 1) * Math.sqrt(rho / 1.225) / stallMps;
  const margin = typeof AP_LOAD_MARGIN === 'number' ? AP_LOAD_MARGIN : 0.7;
  return paClamp(k * k * margin, 1, PA_N_HARD);
}

// その速さでの最小旋回半径（水平旋回と宙返り）。計器と検証が使う
function paMinTurnRadii(state, stallMps) {
  const n = paLoadMax(state, stallMps);
  const v2 = Math.max(state.airspeed, 1) ** 2, g = FLIGHT_GRAVITY;
  return {
    loadMax: n,
    level: n > 1.0001 ? v2 / (g * Math.sqrt(n * n - 1)) : Infinity,
    loop: n > 1.0001 ? v2 / (g * (n - 1)) : Infinity,
  };
}

// 経路角(rad)。速度の向きの水平からの角度
function paGammaRad(state) {
  const v = state.velocity.length();
  return v > 1 ? Math.asin(paClamp(state.velocity.y / v, -1, 1)) : 0;
}

// 欲しいピッチ率 → 昇降舵。トリムを積分に使う（手を離しても保てる舵の位置へ、トリムが寄っていく）。
// 速いときの舵の効き過ぎは自動操縦と同じ倍率（apSurfaceGain）で割り引く。
// トリムが端まで行ったら、残りは昇降舵に積む（pa.elevI）。TB1 はマッハ2で補助翼100%に入れると
// トリムが+1で止まり、昇降舵は比例のぶん（0.4）しか使われず、要る8.2Gに6.8Gで止まって430m沈んだ
function paElevatorForRate(model, state, controls, qCmd, dt, spd, pa) {
  let gs = typeof apSurfaceGain === 'function' ? apSurfaceGain(state, spd) : 1;
  const perStep = paPitchRatePerElevator(model, state) * dt;
  if (perStep > 0 && PA_Q_KP * gs * perStep > PA_Q_STEP_GAIN) gs = PA_Q_STEP_GAIN / (PA_Q_KP * perStep);
  const err = qCmd - state.angularVelocity.x;
  const p = err * PA_Q_KP * gs;
  const d = err * PA_Q_KI * gs * dt;
  const now = controls.trim || 0;
  let ei = pa.elevI || 0;
  const total = p + ei;
  // 舵が振り切っているあいだは、積分を深くする側へは溜めない（巻き上がり防止）
  if (Math.abs(total) < 1 || d * total < 0) {
    // まず昇降舵に積んだぶんを戻し（トリムと逆向きに積んでいたら先に抜く）、残りをトリムへ
    if (ei && d * ei < 0) {
      const back = Math.sign(ei) * Math.min(Math.abs(d), Math.abs(ei));
      ei -= back;
      const rest = d + back;
      controls.trim = paClamp(now + rest, -1, 1);
    } else {
      const t = now + d;
      controls.trim = paClamp(t, -1, 1);
      ei += t - controls.trim;   // トリムの端からはみ出したぶん
    }
  }
  pa.elevI = paClamp(ei, -1, 1);
  pa.saturated = Math.abs(controls.trim) > 0.99 && Math.abs(p + pa.elevI) >= 0.98;
  return paClamp(p + pa.elevI, -1, 1);
}

// 昇降舵1あたりのピッチ角加速度(rad/s²)。舵で増える揚力（揚力の傾き2π×舵の効き）×腕÷慣性。
// 腕は 09-aircraft.js の elevatorPower と同じ（重心からの前後距離＋蝶番ぶん）。
// 実測（1コマ当てて比べた角速度の変わり方）とのずれは練習機・マッハ2級で3〜11%（見積もりが大きめ・速いほど大きい）
function paPitchRatePerElevator(model, state) {
  if (model._paElevK === undefined) {
    let k = 0;
    for (const s of model.surfaces || []) {
      if (!s.pitch || !s.center) continue;
      const arm = Math.abs(s.center.z) + (s.hingeArm !== undefined ? s.hingeArm : AERO_DEFAULTS.hingeArmChord) * (s.chord || 0);
      k += s.area * 2 * Math.PI * Math.abs(s.pitch) * arm;
    }
    const ix = model.inertia && model.inertia.x > 0 ? model.inertia.x : 0;
    model._paElevK = ix > 0 ? k / ix : 0;
  }
  const rho = typeof airDensityAt === 'function' ? airDensityAt(Math.max(state.altitudeM || 0, 0)) : 1.225;
  return model._paElevK * 0.5 * rho * state.airspeed * state.airspeed;
}

// 迎角1radあたりの荷重倍数（揚力の傾き2π・主翼の面積・動圧から）
function paLoadPerAlpha(model, state) {
  const rho = typeof airDensityAt === 'function' ? airDensityAt(Math.max(state.altitudeM || 0, 0)) : 1.225;
  const q = 0.5 * rho * state.airspeed * state.airspeed;
  return Math.max(q * Math.max(model.wingArea || 0, 0.01) * 2 * Math.PI / (model.massKg * FLIGHT_GRAVITY), 0.5);
}

// 荷重倍数 → ピッチ率（γ経路角・φバンク角）。いまの荷重倍数とのずれは、迎角を動かすぶんとして足す。
// 荷重倍数の測り値はピッチの揺れをそのまま拾うので、ならしたもの（pa.nFilt）を使い、
// 足す量も「迎角を PA_GROW_MAX_DEG/s まで」に抑える。そのままだと TB2新（揚力の傾きが見積もりの2倍）
// で輪の強さが2倍になり、-4G⇔+5Gを3秒周期で往復した
function paRateForLoad(model, state, pa, n, gamma, phiRad) {
  const turn = (FLIGHT_GRAVITY / Math.max(state.airspeed, 1)) * (n - Math.cos(gamma) * Math.cos(phiRad));
  const nNow = pa.nFilt === null ? (state.loadFactor || 1) : pa.nFilt;
  const lim = PA_GROW_MAX_DEG * Math.PI / 180;
  const grow = paClamp((n - nNow) / paLoadPerAlpha(model, state) / PA_LOAD_TAU, -lim, lim);
  return turn + grow;
}

function paFilterLoad(state, pa, dt) {
  const k = Math.min(dt / PA_NFILT_TAU, 1);
  const n = state.loadFactor || 1;
  pa.nFilt = pa.nFilt === null ? n : pa.nFilt + (n - pa.nFilt) * k;
  return pa.nFilt;
}

// 指示のバンク角へ倒す補助翼（符号：rollDeg と角速度zは逆向き。apAileronForBank の説明を参照）
function paAileronForBank(state, wantBankDeg, spd) {
  const err = ((wantBankDeg - state.rollDeg + 540) % 360) - 180;
  const wantRate = paClamp(-err * PA_ROLL_PER_DEG, -PA_ROLL_RATE_MAX, PA_ROLL_RATE_MAX);
  const gs = typeof apSurfaceGain === 'function' ? apSurfaceGain(state, spd) : 1;
  return paClamp(-(wantRate - state.angularVelocity.z) * PA_ROLL_KP * gs, -1, 1);
}

// 主翼が失速する「機体の迎角」(°)。翼には取付角があり、後退角のぶん感じる迎角も大きい
// （10-flight.js の stallLimit・09-aircraft.js の surfaceAlphaGain）。飛行モデルと同じく、
// 翼幅方向の流れを落とした残りで翼が感じる迎角を出し、失速角（×alphaGain）に届く機体の迎角を探す。
// 主翼が何枚もあれば、いちばん早く失速するもの。機体ごとに1回だけ測って覚えておく
function paBodyStallDeg(model) {
  if (model._paStallDeg !== undefined) return model._paStallDeg;
  const stallRad = (typeof AERO_DEFAULTS !== 'undefined' ? AERO_DEFAULTS.stallDeg : 15) * Math.PI / 180;
  let best = Infinity;
  for (const s of model.surfaces || []) {
    if (s.role !== 'main' || !s.fwd || !s.up || !s.spanA) continue;
    const felt = (deg) => {
      const r = deg * Math.PI / 180;
      const ly = -Math.sin(r), lz = -Math.cos(r);
      const sp = ly * s.spanA.y + lz * s.spanA.z;
      const x = -s.spanA.x * sp, y = ly - s.spanA.y * sp, z = lz - s.spanA.z * sp;
      const u = x * s.fwd.x + y * s.fwd.y + z * s.fwd.z, w = x * s.up.x + y * s.up.y + z * s.up.z;
      return Math.atan2(-w, Math.abs(u) < 1e-9 ? 1e-9 : u);
    };
    const lim = stallRad * (s.alphaGain || 1);
    let lo = -10, hi = 40;
    if (felt(hi) < lim) continue;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (felt(m) < lim) lo = m; else hi = m; }
    best = Math.min(best, hi);
  }
  model._paStallDeg = Number.isFinite(best) ? best : null;
  return model._paStallDeg;
}
function paAlphaProtDeg(model) {
  const st = paBodyStallDeg(model);
  return st === null ? PA_ALPHA_PROT_DEG : Math.max(st - PA_ALPHA_PROT_MARGIN_DEG, 3);
}

// 迎角の守り：守りの迎角を超えたぶんだけ、欲しいピッチ率を押し戻す（負の迎角も同じ）
function paAlphaProtect(model, state, qCmd) {
  const a = state.alphaDeg || 0;
  const over = Math.abs(a) - paAlphaProtDeg(model);
  if (over <= 0) return qCmd;
  return qCmd - Math.sign(a) * over * Math.PI / 180 * PA_ALPHA_K;
}

// 翼がいま出せる荷重倍数（守りの迎角まで引いたら）。揚力は迎角にほぼ比例するので、
// いまの荷重倍数を「守りの迎角 ÷ いまの迎角」倍する。迎角が小さいうちは当てにならないので上限のまま
function paUpdateLoadAvail(model, state, pa, nMax, dt) {
  const a = state.alphaDeg || 0;
  let est = nMax;
  if (a > 2 && state.loadFactor > 0.3) est = Math.min(nMax, state.loadFactor * paAlphaProtDeg(model) / a);
  // 縦の舵（トリムと昇降舵）が振り切れていれば、翼にはまだ余裕があっても、いまの荷重倍数が上限
  if (pa.saturated && state.loadFactor > 1) est = Math.min(est, state.loadFactor);
  const k = Math.min(dt / PA_NAVAIL_TAU, 1);
  pa.nAvail = pa.nAvail === null ? est : pa.nAvail + (est - pa.nAvail) * k;
  pa.nAvail = paClamp(pa.nAvail, 1, nMax);
  return pa.nAvail;
}

// 補助が効く状態か（地上・失速付近・ヘリ・ホバリング中の垂直離着陸機は、舵をそのまま渡す）
function paAirborneAssist(model, state, controls, pa) {
  if (state.onGround || state.crashed || model.isHelicopter) return false;
  const vs = paStallMps(model, controls, pa);
  if (!(vs > 0) || state.airspeed < vs * PA_MIN_STALLS) return false;
  // 垂直離着陸用エンジンで浮いている（姿勢はノズルが見ている）
  if (model.hasVtol && (controls.vtolThrottle || 0) > 0.05 && state.forwardAirspeed < VTOL_RCS_FADE_MPS) return false;
  return true;
}

// 1コマぶん。stick = { pitch, roll }（-1〜1、いまのレバー）、active = { pitch, roll }（手で当てているか）。
// mode は 'direct' か 'radius'。hold が false なら直接のときは離しても保たない（いままでと同じ）。
// controls.pitch / roll / trim を書く。返り値はラダーに足す量（旋回半径で補助しているときの釣り合い）。
// 釣り合いを取っていないときは null（手の操縦のヨーダンパーをそのまま使う）。
function pilotAssistStep(model, state, controls, pa, stick, active, mode, hold, dt) {
  // ヘリ：操縦桿は姿勢の指示なので、離したら離したときの位置に置いておけば姿勢が保たれる
  if (model.isHelicopter) {
    pa.pitchHold = pa.rollHold = null;
    if (!hold || state.onGround) { pa.heliHold = null; controls.pitch = stick.pitch; controls.roll = stick.roll; return null; }
    const h = pa.heliHold || (pa.heliHold = { pitch: null, roll: null });
    const maxP = typeof HELI_PITCH_MAX_DEG === 'number' ? HELI_PITCH_MAX_DEG : 25;
    const maxR = typeof HELI_ROLL_MAX_DEG === 'number' ? HELI_ROLL_MAX_DEG : 35;
    if (active.pitch) h.pitch = null;
    else if (h.pitch === null) h.pitch = paClamp(state.pitchDeg / maxP, -1, 1);
    if (active.roll) h.roll = null;
    else if (h.roll === null) h.roll = paClamp(state.rollDeg / maxR, -1, 1);
    controls.pitch = active.pitch ? stick.pitch : h.pitch;
    controls.roll = active.roll ? stick.roll : h.roll;
    return null;
  }
  pa.heliHold = null;
  if (!paAirborneAssist(model, state, controls, pa) || (mode !== 'radius' && !hold)) {
    pa.pitchHold = pa.rollHold = null;
    pa.nAvail = null;
    pa.elevI = 0;
    pa.nFilt = null;
    pa.yawI = 0;
    controls.pitch = stick.pitch;
    controls.roll = stick.roll;
    return null;
  }
  const stall = paStallMps(model, controls, pa);
  const spd = { stall };
  paFilterLoad(state, pa, dt);
  const nMax = paLoadMax(state, stall);
  const gamma = paGammaRad(state);
  const phi = state.rollDeg * Math.PI / 180;
  const vertical = Math.abs(state.pitchDeg) > PA_VERTICAL_DEG || Math.abs(gamma) > PA_VERTICAL_DEG * Math.PI / 180;
  // ピッチ率の上限。荷重倍数はすでに nMax で頭打ちにしてあるので、ここは迎角を育てるぶんを残した緩い上限
  const qLim = FLIGHT_GRAVITY * (nMax + 1) / Math.max(state.airspeed, 1) + nMax / paLoadPerAlpha(model, state) / PA_LOAD_TAU;

  if (mode === 'radius') {
    // --- 横：補助翼のレバー → 高度を保つ水平旋回のバンク角（100%で最小半径） ---
    pa.rollHold = null;
    const nTurn = Math.max(paUpdateLoadAvail(model, state, pa, nMax, dt) * PA_TURN_LOAD_FRAC, 1);
    const tanMax = Math.sqrt(Math.max(nTurn * nTurn - 1, 0));
    let bankCmd = Math.atan(Math.abs(stick.roll) * tanMax) * Math.sign(stick.roll) * 180 / Math.PI;
    const nNow = Math.max(pa.nFilt || 1, 1);
    const bankHi = Math.acos(paClamp(PA_BANK_LIFT_FRAC / nNow, 0, 1)) * 180 / Math.PI;
    bankCmd = Math.sign(bankCmd) * Math.min(Math.abs(bankCmd), bankHi);
    if (vertical && !active.roll) {
      // 真上・真下ではバンク角が決まらないので、ロールを止めておくだけ
      controls.roll = paClamp(state.angularVelocity.z * PA_ROLL_RATE_KP, -1, 1);
    } else {
      controls.roll = paAileronForBank(state, bankCmd, spd);
    }
    // --- 縦：昇降舵のレバー → 上下に曲がる荷重倍数（100%で最小半径） ---
    // 要る荷重倍数は少し先のバンクで出す（揚力が育つのに PA_LOAD_TAU かかるので）
    const phiAhead = vertical ? phi : paClamp(phi - state.angularVelocity.z * PA_LOAD_TAU, -85 * Math.PI / 180, 85 * Math.PI / 180);
    const cosPhi = Math.cos(Math.abs(phiAhead) > Math.abs(phi) ? phiAhead : phi);
    const n0 = Math.cos(gamma) / (Math.sign(cosPhi || 1) * Math.max(Math.abs(cosPhi), 0.1));
    let n;
    if (active.pitch && Math.abs(stick.pitch) > 1e-3) {
      pa.pitchHold = null;
      const nMin = 2 - nMax;   // 押したときも、引いたときと同じ半径まで
      n = stick.pitch > 0 ? n0 + stick.pitch * (nMax - n0) : n0 + stick.pitch * (n0 - nMin);
    } else {
      // 離したときの経路角を保つ。ほぼ水平なら高度を保つ
      if (!pa.pitchHold || pa.pitchHold.kind !== 'gamma') {
        pa.pitchHold = Math.abs(gamma) < PA_ALT_HOLD_DEG * Math.PI / 180
          ? { kind: 'gamma', altM: state.altitudeM, gammaRad: 0 }
          : { kind: 'gamma', gammaRad: gamma };
      }
      const h = pa.pitchHold;
      let gWant = h.gammaRad;
      if (h.altM !== undefined) {
        const v = Math.max(state.airspeed, 1);
        const vsCmd = paClamp((h.altM - state.altitudeM) * PA_ALT_KP, -v * 0.12, v * 0.12);
        gWant = Math.asin(vsCmd / v);
      }
      const gDot = (gWant - gamma) * PA_GAMMA_K;
      n = n0 + Math.max(state.airspeed, 1) * gDot / FLIGHT_GRAVITY / (Math.sign(cosPhi || 1) * Math.max(Math.abs(cosPhi), 0.1));
    }
    n = paClamp(n, 2 - nMax, nMax);
    const qCmd = paAlphaProtect(model, state, paClamp(paRateForLoad(model, state, pa, n, gamma, phi), -qLim, qLim));
    pa.nCmd = n; pa.qCmd = qCmd; pa.bankCmd = bankCmd;
    controls.pitch = paElevatorForRate(model, state, controls, qCmd, dt, spd, pa);
    // 横滑りを消すラダー（旋回の釣り合い）
    const beta = state.betaDeg || 0;
    // 符号（実測）：ラダー+0.5を1秒当てると横滑りは-2.7°（三式戦闘機）。横滑りと同じ向きに当てると消える
    pa.yawI = paClamp((pa.yawI || 0) + beta * PA_BETA_KI * dt, -1, 1);
    return paClamp(beta * PA_BETA_KP + pa.yawI, -1, 1);
  }

  // --- 直接：当てているあいだは舵をそのまま、離したら離した瞬間の姿勢を保つ ---
  if (active.pitch) {
    pa.pitchHold = null;
    controls.pitch = stick.pitch;
  } else {
    if (!pa.pitchHold || pa.pitchHold.kind !== 'theta') pa.pitchHold = { kind: 'theta', thetaDeg: state.pitchDeg };
    let qCmd;
    const cosPhi = Math.cos(phi);
    if (Math.abs(state.pitchDeg) > PA_VERTICAL_DEG || Math.abs(cosPhi) < 0.3) {
      // 真上・真下、または真横に近いほど倒れているとピッチ角は昇降舵では保てない。回転を止めるだけ
      qCmd = 0;
    } else {
      const errRad = (pa.pitchHold.thetaDeg - state.pitchDeg) * Math.PI / 180;
      const r = -state.angularVelocity.y;
      qCmd = (errRad * PA_THETA_K + r * Math.sin(phi)) / cosPhi;
    }
    controls.pitch = paElevatorForRate(model, state, controls, paClamp(qCmd, -qLim, qLim), dt, spd, pa);
  }
  if (active.roll) {
    pa.rollHold = null;
    controls.roll = stick.roll;
  } else {
    if (!pa.rollHold) {
      const b = state.rollDeg;
      pa.rollHold = { bankDeg: Math.abs(b) < PA_ROLL_SNAP_DEG ? 0 : b };
    }
    controls.roll = vertical
      ? paClamp(state.angularVelocity.z * PA_ROLL_RATE_KP, -1, 1)
      : paAileronForBank(state, pa.rollHold.bankDeg, spd);
  }
  return null;
}

// 補助翼100%でいま実際に回る水平旋回の半径(m)（計器に出す）。翼の余裕（pa.nAvail）と、
// 高度を保つために残すぶん（PA_TURN_LOAD_FRAC）まで入れた値。曲がれない速さなら Infinity
function paLevelTurnRadiusNow(model, state, controls, pa) {
  if (model.isHelicopter || state.onGround) return Infinity;
  const stall = paStallMps(model, controls, pa);
  let n = paLoadMax(state, stall);
  if (pa.nAvail !== null && pa.nAvail !== undefined) n = Math.min(n, pa.nAvail);
  n = Math.max(n * PA_TURN_LOAD_FRAC, 1);
  if (!(n > 1.0001) || state.airspeed < stall * PA_MIN_STALLS) return Infinity;
  return (state.airspeed * state.airspeed) / (FLIGHT_GRAVITY * Math.sqrt(n * n - 1));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createPilotAssist, pilotAssistStep, paMinTurnRadii, paLoadMax, paLoadPerAlpha, paBodyStallDeg, paLevelTurnRadiusNow };
}
