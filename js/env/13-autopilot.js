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
const AP_TRIM_QUIET_RADPS = 0.06; // これより速く回っている間はトリムを動かさない
const AP_ROLL_KP = 0.055;      // バンク角のずれ1°あたりのエルロン
const AP_ROLL_KD = 0.9;        // ロール角速度(rad/s)への戻し（符号は+：上のコメント参照）
const AP_HDG_KP = 1.5;         // 方位のずれ1°あたり、何度傾けるか
const AP_BANK_MAX = 25;        // 自動操縦が使うバンク角の上限(°)。低速機（〜194kt）はここまで
const AP_VS_KP = 0.10;         // 高度のずれ1mあたりの昇降率(m/s)
const AP_PITCH_FROM_VS = 0.9;  // 昇降率のずれ1m/sあたり、何度ピッチを足すか
const AP_PITCH_FROM_VS_MAX = 5; //   ただしこの角度まで（apPitchForVs 参照）
const AP_THR_KP_REL = 3.6;     // 速度が目標より何割ずれているかに対する、毎秒のスロットルの動き
const AP_YAW_KP = 0.05;        // 横滑り1°あたりのラダー（旋回の釣り合い）
const AP_STEER_KP = 0.05;      // 地上：方位のずれ1°あたりの前輪

const AP_PITCH_MAX = 15;       // 自動操縦が指示するピッチ角の上限(°)
const AP_PITCH_MIN = -12;      //                            下限(°)

const AP_CEILING_VS_MPS = 0.5; // 上昇中、これ未満の上昇率が続いたら上昇限度とみなす(m/s)
const AP_CEILING_SEC = 20;     // 何秒続いたら、か

// --- 垂直離着陸 ----------------------------------------------------------------
//
// 滑走路を使わない離陸・着陸。垂直離陸用エンジン（spinAxis='y'）を持つ機体だけ選べる。
// 低速・無風速でのピッチ／ロールは、10-flight.js の accumulateVtolControl が
// 姿勢制御ノズルとして拾ってくれる（前へ進むエンジンの舵とまったく同じ
// controls.pitch/roll/yaw を使う——低速なら効くのがノズル、速度が乗れば効くのが
// 舵面、というだけで、上のapElevatorForPitch/apAileronForBankはどちらの場合も
// そのまま使い回せる）。ここで新しく要るのは、水平方向へ移動するための
// 「わざと少し傾ける」制御と、垂直エンジンの出力そのものの制御だけ。
const AP_VTOL_CLIMB_MPS = 3;     // 垂直離陸で目指す上昇率(m/s)。姿勢制御の効く範囲でゆっくり
const AP_VTOL_SINK_KP = 0.15;    // 垂直着陸：残り高度1mあたりの目標沈下率(m/s)
const AP_VTOL_SINK_MAX = 3;      // 垂直着陸：目標沈下率の上限(m/s)
const AP_VTOL_VS_KP = 0.20;      // 昇降率のずれ1m/sあたり、毎秒どれだけ垂直エンジン出力を動かすか
const AP_VTOL_TRANSITION_AGL_M = 30; // これより高く上がったら、前へ進むエンジンへ切り替え始める
const AP_VTOL_HOVER_AGL_M = 80;  // 着陸時、この高さまで来たら垂直降下に切り替える
const AP_VTOL_HOVER_RADIUS_MIN_M = 300; // 着陸点からこの距離まで来たら垂直降下に切り替える（下限）
const AP_VTOL_CUT_SEC = 3;       // 接地後、垂直エンジンを抜ききるまでの秒数
// 垂直降下：対地速度がこれ以上あるうちは降りない（止まってから降ろす）。
// ここまで落ちれば、接地してブレーキを踏んでも前へ転がらない。
const AP_VTOL_DESCENT_GS_MPS = 4;
// 垂直降下：この高さから下では、ホバーの傾きを水平へ戻していく(m)
const AP_VTOL_LEVEL_AGL_M = 25;
const AP_VTOL_SETTLE_MPS = 0.5;  // 接地したあと弾んで浮いたときの、静かな沈下率(m/s)
const AP_VTOL_TILT_MAX = 10;     // ホバー中、水平移動のために傾ける角度の上限(°)
const AP_VTOL_POS_KP = 0.08;     // 着地点までの距離1mあたり、何度傾けるか
const AP_VTOL_VEL_KD = 1.6;      // 水平方向の速度1m/sあたり、何度戻すか

// 垂直降下へ切り替えていい半径。300mを基本にしつつ、進入速度での旋回半径
// （v²/(g·tanθ)）より広く取る——速い機体（サンダーバードのような）は進入速度でも
// 旋回半径が数百m〜1km級になり、300m固定では旋回してもその内側に入れず、
// 永遠に進入をやり直すだけになる（旋回半径のほうが広い円の外を回り続ける）。
function apVtolHoverEngageRadius(spd) {
  const turnRadius = (spd.approach * spd.approach) / (9.80665 * Math.tan(spd.bankMax * Math.PI / 180));
  return Math.max(AP_VTOL_HOVER_RADIUS_MIN_M, turnRadius * 1.5);
}

// 垂直エンジンの出力を、目標の昇降率へ少しずつ近づける（apThrottleForSpeedと同じ形）
function apVtolThrottleForVs(controls, currentVs, targetVs, dt) {
  const err = targetVs - currentVs;
  return apClamp((controls.vtolThrottle || 0) + err * AP_VTOL_VS_KP * dt, 0, 1);
}

// ホバー中に目標地点（世界座標）へ寄せるための、目標ピッチ角・バンク角。
// 前へ進むエンジンとは無関係に、姿勢を少し崩して水平方向の推力成分を作る——
// 実機のVTOL機と同じで、機首を下げれば前へ、右へ傾ければ右へ進む
// （実測して符号を決めてある。ピッチは上げるほど後ろへ、ロールは
// 右へ倒すほど右へ動く）。位置の誤差と速度の誤差、両方を見て収束させる。
function apVtolHoverAngles(state, targetX, targetZ, tiltMaxDeg) {
  const tiltMax = tiltMaxDeg === undefined ? AP_VTOL_TILT_MAX : tiltMaxDeg;
  const fwd = apForward(state.headingDeg), right = apRight(state.headingDeg);
  const dx = targetX - state.position.x, dz = targetZ - state.position.z;
  const along = dx * fwd.x + dz * fwd.z;   // +なら目標は前方
  const cross = dx * right.x + dz * right.z; // +なら目標は右
  const vAlong = state.velocity.x * fwd.x + state.velocity.z * fwd.z;
  const vCross = state.velocity.x * right.x + state.velocity.z * right.z;
  const pitchTilt = apClamp(along * AP_VTOL_POS_KP - vAlong * AP_VTOL_VEL_KD, -tiltMax, tiltMax);
  const bankTilt = apClamp(cross * AP_VTOL_POS_KP - vCross * AP_VTOL_VEL_KD, -tiltMax, tiltMax);
  return { wantPitchDeg: -pitchTilt, wantBankDeg: bankTilt };
}

// --- 地面をよける ---------------------------------------------------------------
//
// 自動操縦は「設定した高度（海面から）」を保つだけだったので、下の地面が
// 上がってきても知らんぷりで、山にそのまま突っ込んでいた（実測：30km先に
// 標高2500mの尾根、目標高度1500mで、練習機もマッハ2級も対地高度-1mまで
// めり込んだ）。前方の地面を見て、「いまこの高度以上にいないと越えられない」
// 高さ（＝床）を出し、目標高度をそれで底上げする。
//
// 越えられるかどうかは距離と上昇率で決まる。距離dの先に標高hの地面があるなら、
// そこへ着くまでの時間は d/v、そのあいだに稼げる高度は 上昇率×d/v なので、
// **いま必要な高度は h + 余裕 − 上昇率×d/v**。前方を何点か見て、その最大を取る。
// この形だと、遠くの高い山には早めに上りはじめ、近くの低い丘は無視できる。
const AP_TERRAIN_CLEARANCE_M = 300;   // 地面からどれだけ上を通るか(m)
const AP_TERRAIN_LOOKAHEAD_SEC = 120; // 何秒先まで見るか
const AP_TERRAIN_LOOKAHEAD_MIN_M = 10000;
const AP_TERRAIN_LOOKAHEAD_MAX_M = 60000;
const AP_TERRAIN_SAMPLES = 24;        // 前方を何点見るか
const AP_TERRAIN_CLIMB_MARGIN = 0.7;  // 上昇率をどれだけ割り引いて見積もるか
const AP_TERRAIN_REFRESH_SEC = 0.25;  // 何秒ごとに測り直すか（毎コマは重い）
// 目的地が近づいたら余裕を減らしていく。減らさないと、空港そのものの地面が
// 「越えるべき障害物」に見えて、降りられなくなる。
const AP_TERRAIN_TAPER_M = 15000;
// 巡航中、床が現在高度よりこれ以上高くなったら上昇の段へ戻す(m)
const AP_TERRAIN_CLIMB_BACK_M = 60;
// 巡航中、目標高度より低いのに沈んでいるとき、この沈み方（m/s）で
// 出力を全開まで戻す。小さすぎると平常の速度調整まで出力を戻してしまい、
// 大きすぎると手遅れになるまで気付けない。
const AP_CRUISE_SINK_URGENCY_MPS = 10;

// 前方の地面を見て、2つ返す。地面の高さが分からなければ「制限なし」。
//   floorM  … いま下回ってはいけない高度(m)。段の切り替えと、降下の目標に使う
//   vsNeed  … いま出していないと間に合わない昇降率(m/s)
//
// **昇降率のほうが要る**。高度の床だけを比例制御で追いかけると、床が
// 坂のように上がってくるあいだ必ず遅れる——比例ゲイン0.10で床が毎秒22m
// 上がるなら、220m低いところで釣り合ってしまう（実測でも山の上を76mで
// かすめ、床とのずれは215mだった）。降下の坂で同じことをやって滑走路を
// 素通りしたのと同じ話なので、ここでも**要る昇降率を直接出す**。
// 距離dの先に標高hがあるなら、そこへ着くまでの時間は d/v なので、
// 要る昇降率は (h + 余裕 − いまの高度) / (d/v)。前方の最大を取る。
function apTerrainFloor(state, env, clearanceM, spd) {
  // vsNeed の「制限なし」は 0 ではなく -Infinity。0 にすると
  // Math.max(降下率, 0) になって、降下そのものを止めてしまう。
  const none = { floorM: -Infinity, vsNeed: -Infinity, rising: false };
  const gh = env && env.groundHeightAt;
  if (typeof gh !== 'function') return none;
  const v = Math.max(state.airspeed, 1);
  // 進んでいる向き（航跡）で見る。横風で機首とずれていても、実際に行く先は航跡のほう。
  const dir = apForward(apGroundTrackDeg(state));
  const look = apClamp(v * AP_TERRAIN_LOOKAHEAD_SEC,
    AP_TERRAIN_LOOKAHEAD_MIN_M, AP_TERRAIN_LOOKAHEAD_MAX_M);
  const up = Math.max(apVsLimits(state).up * AP_TERRAIN_CLIMB_MARGIN, 0.1);
  let floorM = -Infinity, vsNeed = -Infinity, maxGroundAhead = -Infinity;
  // i=0（真下、d=0）も見る。前方サンプルは look/AP_TERRAIN_SAMPLES 間隔
  // （遅い機体でも最低10km/24点≈417m刻み）なので、越えている地形の
  // 残りがその刻み幅より短くなると前方サンプルが全部その先の平地を
  // 拾ってしまい、まだ真下・すぐ先に残っている地形を見失う——実測で
  // 幅4kmの尾根の終端付近（残り400m）で floorM が数フレームで
  // 300m台からマイナスへ落ち、対地0mまで沈んでいた。真下を毎回
  // 混ぜておけば、地形の上にいるあいだは floorM が地形の高さを
  // 下回らない。d=0 は vsNeed（d/v で割る）には使わない——真下の
  // ぶんは「これから何秒で着くか」という話ではないので馴染まない。
  for (let i = 0; i <= AP_TERRAIN_SAMPLES; i++) {
    const d = look * i / AP_TERRAIN_SAMPLES;
    const h = gh(state.position.x + dir.x * d, state.position.z + dir.z * d);
    if (!(h > -1e5)) continue;
    const top = h + clearanceM;
    const need = top - up * (d / v);
    if (need > floorM) floorM = need;
    if (h > maxGroundAhead) maxGroundAhead = h;
    if (d <= 0) continue;
    const vs = (top - state.altitudeM) / (d / v);
    if (vs > vsNeed) vsNeed = vs;
  }
  // 出せる以上の昇降率を指示しても仕方がない（機首だけ上がって速度を失う）
  // **越えるのに要る昇降率は、機体が出せるところまで許す**（apTerrainEscapeVs）。
  // ここを AP_CLIMB_DEG（7°）で頭打ちにしていたので、推力の大きい機体ほど
  // 出せる上昇率の一部しか使えず、山に間に合わなかった。
  // なお上の `up`（どこまで登れるかの見積もり＝床の高さを決めるほう）は
  // 7°のままにしてある——見積もりを甘くすると「まだ登らなくていい」と
  // 判断して登りはじめが遅れるので、**床は今までどおり早めに要求し、
  // 指示だけ出せるところまで出す**という組み合わせにする。
  // 急ぐのは**地面そのものが自分より高いとき**だけ。「余裕300mより低い」で
  // 見てはいけない——平らな地面でも離陸直後はこれを満たすので、ふつうの
  // 離陸がぜんぶ全力上昇になってしまう（実測でBoeing747の上昇の形が変わり、
  // そのまま進入に乗れず着陸できなくなった）。越える相手が自分の上に
  // あるときだけ、出せるところまで出す。
  const rising = maxGroundAhead > state.altitudeM;
  const need = Math.min(vsNeed,
    rising ? apTerrainEscapeVs(state, spd) : apVsLimits(state).up);
  // **上がれと言うときだけ効かせる**。vsNeed は「前方の地面を越えるのに要る
  // 上昇率」で、下限として使われる（Math.max(指示, vsNeed)）。ところが地面が
  // 自分より下にあると、これは「これ以上速く降りるな」という上限に化ける——
  // 平らな地面の上でさえ、120秒先の地面＋余裕へ向かう緩い降下率が上限になり、
  // 実測でBoeing 747の降下が -19m/s 出せるところを -9.3m/s に抑えられて、
  // 進入開始で経路より580m高いところに入っていた。地面より高いところに
  // いるあいだは、そもそも越えるべきものが無い。
  return { floorM, vsNeed: need > 0 ? need : -Infinity, rising };
}

// 測り直しは AP_TERRAIN_REFRESH_SEC ごと（地面の高さを引くのは安くない）。
// 空港へ近づくぶんだけ余裕を細らせる（AP_TERRAIN_TAPER_M のコメント参照）。
function apUpdateTerrainFloor(state, ap, env, dt, distToGoM, spd) {
  ap.terrainClock = (ap.terrainClock || 0) + dt;
  if (ap.terrainFloorM === undefined || ap.terrainClock >= AP_TERRAIN_REFRESH_SEC) {
    ap.terrainClock = 0;
    const taper = distToGoM === undefined ? 1
      : apClamp(distToGoM / AP_TERRAIN_TAPER_M, 0, 1);
    const r = apTerrainFloor(state, env, AP_TERRAIN_CLEARANCE_M * taper, spd);
    ap.terrainFloorM = r.floorM;
    ap.terrainVsNeed = r.vsNeed;
    ap.terrainRising = r.rising;
  }
  return { floorM: ap.terrainFloorM, vsNeed: ap.terrainVsNeed, rising: !!ap.terrainRising };
}

// --- 低いところでは深く傾けない -------------------------------------------------
//
// 離陸してすぐ、対地高度が数十mのうちに目的地の方位へ倒し込むと、傾けたぶん
// 揚力の上向き成分が減って沈み、そのまま地面に触る。実機でも離陸直後は
// 高度が取れるまで傾けない（そのあと段階的に深くしていく）。
// 進入・引き起こしはこの制限を掛けない——あちらは滑走路の中心線に乗せるための
// 浅いバンク（8°）で、低いところで効かなくなると逆に降りられなくなる。
const AP_BANK_AGL_LO = 60;   // これ以下の対地高度では傾けない(m)
const AP_BANK_AGL_HI = 300;  // ここまで上がれば上限いっぱいまで使う(m)
function apBankAglFactor(state) {
  if (state.onGround) return 0;
  return apClamp((state.altitudeAglM - AP_BANK_AGL_LO)
    / (AP_BANK_AGL_HI - AP_BANK_AGL_LO), 0, 1);
}

// --- 登る必要があるときは深く傾けない ---------------------------------------------
//
// バンク角φで水平を保つだけで揚力を1/cosφ倍に増やす必要があり、揚力係数が
// 上がったぶん誘導抗力はその2乗（Cdi∝Cl²）で増える。推力の余りはそこに
// 食われ、登る/降りるための力が残らない。実測（内蔵の練習機、指示+3m/s）：
//   バンク 0°→実際2.5m/s（ほぼ指示どおり）　15°→2.3m/s　30°→0.5m/s（8割減）
//   45°→ -1.5m/s（登るどころか沈む）　60°→ -5.3m/s
// 前方の地形を越えるのに昇降率が要る（terrain.vsNeed）とき、これまでは
// バンクを navから独立に旋回半径だけで決めていたので、旋回に揚力を使い切って
// 登れないまま地面へ近づいていく——「曲がり続けて地面が迫っても登ろうとしない」
// に見える壊れ方はこれ。実測で、Boeing 747・サンダーバード2号とも、目的地が
// 近く大きく旋回しながら山を越える場面で対地高度がほぼ0m（機体によっては
// 山にめり込んで負の値）まで落ちていた。
// TAWSの引き起こし操作が「バンクを戻して真っ直ぐ引き起こす」のと同じ理由で、
// 越えるのに要る昇降率が、出せる上昇率に対してどれだけ切迫しているかでバンクを絞る。
const AP_BANK_CLIMB_RATIO_ZERO = 0.5; // 要る昇降率が出せる上限のこの割合に達したら水平まで戻す
function apBankClimbFactor(state, vsNeededMps) {
  if (!(vsNeededMps > 0)) return 1;
  const up = Math.max(apVsLimits(state).up, 0.1);
  return apClamp(1 - (vsNeededMps / up) / AP_BANK_CLIMB_RATIO_ZERO, 0, 1);
}

// --- 経路の形 -----------------------------------------------------------------

const AP_GLIDE_DEG = 3;        // 進入の降下角。実機と同じ3°
const AP_FINAL_M = 9000;       // 最終進入を始める点（滑走路末端からの距離 m）
const AP_DESCENT_SLOPE = 1 / 20; // 巡航からの降下勾配（約2.9°）
const AP_TOUCHDOWN_M = 200;    // 末端から何m先を目標に降ろすか
const AP_HIGH_ON_PATH_M = 30;  // 進入経路よりこれ以上高ければ出力を切る／低ければ足す(m)
const AP_LOW_ON_PATH_M = 200;   // 経路よりこれだけ低いと、進入速度の上乗せを使い切る(m)
const AP_LOW_ON_PATH_GAIN = 0.15; // 上乗せの最大（進入速度の何割か）
// 降下中、抗力だけでどれくらい減速できるとみなすか(m/s²)。
// 進入速度まで落としきるのに要る距離の見積もりに使う（降下の段を参照）。
// 出力を絞って降りているときに見込める減速度(m/s²)。
// **降りるぶんだけ位置エネルギーが速度に変わる**ので、水平飛行で測った抗力の
// ぶんからそれを引いた値でないと足りない——実測でBoeing 747は水平・脚上げで
// 1.31m/s²、2.86°の降下ではそこから g·sin2.86°=0.49 を引いて0.8ほどしか残らない。
// 1.5 のままだと「まだ落とさなくていい」と判断して減速を先送りし、
// 進入開始に244kt（進入速度168kt）で入って、やり直しを26回繰り返していた。
const AP_DECEL_MPS2 = 0.7;
// ルートのうち、減速に使っていいと見なす割合（apSpeedSchedule の slowableV）
const AP_DECEL_ROUTE_FRACTION = 0.5;

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

// 舵の効き具合を、速度で割り引く倍率。
//
// 舵が出すモーメントは動圧（½ρv²）に比例する——同じ舵角でも、速く飛ぶほど
// 強く効く。ゲインを速度によらず固定にすると、速い機体では内側の段の
// ループゲインが1を超え、毎コマ舵が反対側へ振り切れる。
// 実測：同じ機体に「いまのピッチを保て」と言うだけで、
//   200kt  → 舵は0.00のまま静止（18秒で符号反転0回）
//   1282kt → ±1.00を18秒に764回振り、ピッチ角速度3.7rad/sで暴れる
// これが「行き過ぎて戻してまた行き過ぎる」プルプルの正体で、
// 高度維持と旋回が殴り合って見えるのも、暴れた舵が指示に追従できないため。
//
// **可動域（舵角の上限）を絞ってはいけない**——低速では逆に舵が足りなくなり、
// 全然効かなくなる。絞るべきなのは舵角そのものではなく「1°のずれあたり
// 何舵を当てるか」のほう、しかも速度に応じて連続的に。動圧の比で割れば
// 「舵角×動圧＝モーメント」が速度によらず一定になり、舵角の上限（±1）は
// そのまま残るので、低速では今までどおり目一杯まで使える。
//
// 基準の速度は機体ごとに違う（失速速度が機体の大きさと翼面荷重を代表する）。
// 失速速度の何倍か、で測り、それより遅い側ではゲインを上げない（1で頭打ち）
// ——低速側は実測でいまのままが正しく（練習機の旋回中の高度ずれは平均0m）、
// むやみに強めれば別のところが壊れる。絞るのは速すぎる側だけでいい。
const AP_GAIN_REF_STALLS = 4;  // 失速速度の何倍から、舵のゲインを絞り始めるか

function apSurfaceGain(state, spd) {
  if (!spd || !spd.stall) return 1;
  const ref = spd.stall * AP_GAIN_REF_STALLS;
  const v = Math.max(state.airspeed, 1);
  if (v <= ref) return 1;
  const r = ref / v;
  return r * r;
}

// 指示のピッチ角を保つエレベーター。
//
// 比例と微分だけでは足りない。フラップを下ろす、脚を出す、燃料は減らないが速度は変わる——
// 釣り合いの取れる舵の位置は飛んでいる間ずっと動き、比例項は「ずれが残ったまま」で
// 止まってしまう（実際、進入でフラップを全開にした途端に降下が止まった）。
// 残った舵をゆっくりトリムへ移すことで、これを積分項として働かせる。
// 人間が飛ばすときにトリムを取り直すのと同じことを、機械にやらせている。
//
// **指示そのものも、動かせる速さで動かす**。段でつなぐと、指示は一瞬で飛ぶ——
// 上昇（ピッチ15°固定）から巡航へ移った瞬間、まだ昇降率が30m/s残っているので
// apPitchForVs が下限の-12°を返し、指示が27°ぶん飛ぶ。重い機体はそれに追従できず、
// 行き過ぎては戻すのを繰り返して振幅が育ち、実測でBoeing 747が迎角73°まで
// 跳ね上がって失速し、巡航高度から墜ちていた。実機の自動操縦も同じ理由で
// ピッチ角の変化率を制限している。
// 動かしていい速さは機体ごとに違う——**曲がれる速さは荷重倍数で決まる**ので、
// 経路を曲げるのに使っていい余分なGを AP_PITCH_RATE_G とすれば、
// 出せるピッチ角速度は g·(n-1)/v [rad/s]。重い/速い機体ほど遅く、
// 軽い/遅い機体ほど速くなり、練習機（71ktで23°/s）の機敏さは保ったまま
// Boeing 747（220ktで7°/s）だけが穏やかになる。
const AP_PITCH_RATE_G = 1.5;
const AP_PITCH_RATE_MIN_DPS = 3;
const AP_PITCH_RATE_MAX_DPS = 30;
const AP_PITCH_LEAD_DEG = 20;  // 実際の姿勢からこれ以上は先走らせない(°)
function apPitchRateLimit(state) {
  const v = Math.max(state.airspeed, 1);
  const dps = (9.80665 * AP_PITCH_RATE_G / v) * 180 / Math.PI;
  return apClamp(dps, AP_PITCH_RATE_MIN_DPS, AP_PITCH_RATE_MAX_DPS);
}
function apElevatorForPitch(state, controls, wantPitchDeg, dt, spd, ap) {
  let want = wantPitchDeg;
  if (ap && dt > 0) {
    const prev = ap.pitchCmdDeg === undefined ? state.pitchDeg : ap.pitchCmdDeg;
    const step = apPitchRateLimit(state) * dt;
    want = apClamp(want, prev - step, prev + step);
    // 機体が付いてこられないときに指示だけ先へ行ってしまわないように
    want = apClamp(want, state.pitchDeg - AP_PITCH_LEAD_DEG, state.pitchDeg + AP_PITCH_LEAD_DEG);
    ap.pitchCmdDeg = want;
  }
  const g = apSurfaceGain(state, spd);
  const cmd = apClamp(((want - state.pitchDeg) * AP_PITCH_KP
    - state.angularVelocity.x * AP_PITCH_KD) * g, -1, 1);
  // 舵が振り切っている間は溜め込まない（大きく姿勢を変えている最中の巻き上がり防止）。
  // **地上でも溜め込まない**——脚が姿勢を押さえているあいだは舵を当てても機体は
  // 動かないので、「ずれが消えないから積む」を続けてトリムが端まで巻き上がる。
  // 実測で Concorde が離陸滑走のあいだにトリム+1.00（機首上げ一杯）まで巻き、
  // 翼が浮いた瞬間にそれが効いてピッチ50°へ跳ね、背面に入って落ちていた。
  // 実機でも、滑走中に操縦者がトリムを取り直したりはしない。
  // **揺れている最中は、深くする側だけ止める**。トリムは「釣り合いの位置が
  // ずれた」ぶんをゆっくり拾うためのもので、行って来いの最中に積むと、舵とほぼ
  // 90°ずれた位相で力を足すことになり、揺れを育てる側に回る（実測でConcordeの
  // 巡航移行が4秒周期で振幅を増やし、5往復で裏返った）。
  // ただし**戻す側まで止めてはいけない**——端まで巻いたトリムが揺れているあいだ
  // 動かせなくなり、「トリムが機首上げ一杯 → 上がる → 揺れる → 戻せない」で
  // 抜け出せなくなる（実際そうなった）。深くするのは静かなときだけ、
  // 中立へ戻すのはいつでも。
  if (dt && Math.abs(cmd) < 0.9 && !state.onGround) {
    const now = controls.trim || 0;
    const delta = cmd * AP_TRIM_RATE * dt;
    const backToNeutral = delta * now < 0;
    if (backToNeutral || Math.abs(state.angularVelocity.x) < AP_TRIM_QUIET_RADPS) {
      controls.trim = apClamp(now + delta, -1, 1);
    }
  }
  return cmd;
}

// 指示のバンク角を保つエルロン。ロール角速度は符号が逆なので足す。
// ゲインの速度による割り引きはエレベーターと同じ（apSurfaceGain 参照）。
function apAileronForBank(state, wantBankDeg, spd) {
  return apClamp(((wantBankDeg - state.rollDeg) * AP_ROLL_KP
    + state.angularVelocity.z * AP_ROLL_KD) * apSurfaceGain(state, spd), -1, 1);
}

// --- 中間の段 -----------------------------------------------------------------

// 昇降率の上限は「経路角」で決める。**推力から決めてはいけない**——
// 降りるのに推力は要らないので、推力の小さい重い機体で降下を頭打ちにしてしまい、
// 3°の進入線に一生乗れなくなる（実際、大型機で滑走路を素通りした）。
// 同じ角度でも速い機体ほど昇降率は大きくなり、それが正しい。
const AP_CLIMB_DEG = 7;  // 高度を取り戻すときの上昇角
const AP_SINK_DEG = 8;   // 高度を落とすときの降下角（3°の進入より深く取れるようにしておく——
                         // 5°では、減速しながらでは経路に追いつけず、実測でBoeing 747が
                         // 進入開始で経路より590m高く入っていた）

function apVsLimits(state) {
  const v = Math.max(state.airspeed, 10);
  return {
    up: v * Math.sin(AP_CLIMB_DEG * Math.PI / 180),
    down: v * Math.sin(AP_SINK_DEG * Math.PI / 180),
  };
}

// **地形を越えるときだけは、機体が出せるだけ上げる**。
//
// AP_CLIMB_DEG（7°）は「高度を取り戻すときの、乗っていて気持ちのいい上昇角」で、
// ふだんの高度合わせにはこれでいい。ところが山を越える指示（apTerrainFloor の
// vsNeed）にも同じ上限が掛かっていたので、**推力の大きい機体が、出せる上昇率の
// ごく一部しか使えないまま山へ近づいていた**——実測（全開・指示ピッチを変えて
// 60秒）で、出せる上昇角は 練習機5° / T/W2.4の高速機63° / T/W20のロケット機89° /
// T/W0.6の大型機20°。手で操縦すれば急上昇できるのに自動操縦だけ登れない、
// という報告になっていた。
//
// どこまで許すかは「速度の余裕」で決める（apClimbCap と同じ考え方）——
// 高度を追いかけて速度を使い切るのが自動操縦のいちばん危ない壊れ方なので、
// 余裕があるぶんだけ。出せない機体は、指示に届かないまま速度が落ち、
// apClimbCap が自分で絞ってくれる（＝上限を上げても失速側へは転ばない）。
const AP_TERRAIN_ESCAPE_DEG = 30; // 地形回避で許す上昇角の上限(°)
const AP_TERRAIN_PITCH_MAX = 35;  // 地形回避で許す指示ピッチの上限(°)
function apTerrainEscapeVs(state, spd) {
  const lim = apVsLimits(state);
  if (!spd) return lim.up;
  const byAngle = Math.max(state.airspeed, 10)
    * Math.sin(AP_TERRAIN_ESCAPE_DEG * Math.PI / 180);
  return apClamp(apClimbCap(state, spd), lim.up, byAngle);
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
  // 昇降率のずれぶんは「直し」であって主役ではない——経路角＋迎角だけで
  // すでに要る姿勢は出ている。頭打ちにしないと、上昇率の大きい機体
  // （実測でConcordeが42m/s）では昇降率のずれ30m/sがそのまま27°の指示になり、
  // ピッチの指示が上限と下限を往復するだけになる（＝行って来いが育つ）。
  const fix = apClamp((vsCmd - state.verticalSpeed) * AP_PITCH_FROM_VS,
    -AP_PITCH_FROM_VS_MAX, AP_PITCH_FROM_VS_MAX);
  const want = gammaDeg + state.alphaDeg + fix;
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
function apAileronForTrack(state, wantTrackDeg, bankMax, spd) {
  const err = apWrap180(wantTrackDeg - apGroundTrackDeg(state));
  const lim = bankMax === undefined ? AP_BANK_MAX : bankMax;
  return apAileronForBank(state, apClamp(err * AP_HDG_KP, -lim, lim), spd);
}

// 速度を保つスロットル（今の値から少しずつ動かす）
// 出力は「目標速度からの**割合**のずれ」で動かす。
//
// 秒速の絶対値で動かしていたので、速い機体ほど同じずれで出力が激しく動いた——
// 実測でBoeing 747が降下中に全開⇔絞りを40秒周期で繰り返し、指示-12m/sに対して
// 昇降率が+24〜-22m/sで振れていた（大型機の全開推力は降下率に直結するので、
// 出力の往復がそのまま経路の往復になる）。割合で見れば、練習機の動きは
// これまでどおりのまま、速い機体だけ穏やかになる。
function apThrottleForSpeed(state, controls, targetMps, dt) {
  const err = (targetMps - state.airspeed) / Math.max(targetMps, 1);
  return apClamp(controls.throttle + err * AP_THR_KP_REL * dt, 0, 1);
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

// バンク角の上限は、**必要なぶんだけ深く、出せるぶんだけ**で決める。
//
// 水平旋回の半径は r = v²/(g·tanφ) なので、許せる半径 radiusMax に収めるのに
// 要るバンク角は atan(v²/(g·radiusMax))。遅い機体ではこれが1°にもならないので、
// AP_BANK_MAX（25°＝1.1G、旅客機の常用域）で頭打ちにする——低速側の
// 振る舞いはこれまでどおり変わらない。
//
// 深くできる上限のほうは「そのバンクを保つ揚力を出せるか」で決まる。
// バンク角φの水平旋回に要る荷重倍数は n = 1/cosφ（60°で2G、85°で11.5G）、
// 出せる揚力は速度の2乗で増えるので、失速速度のk倍で飛んでいれば n = k² まで出せる。
// **手で飛ばすと超高速機がほぼ最高速度でもきつく曲がれるのはこれ**で、
// 実測では失速速度の22倍で半径1.5km、65倍で0.6kmまで回れた（60°バンク）。
// 自動操縦だけ60°で頭打ちにしていたので、曲がるには速度を落とすしかなく
// （巡航速度が turnableV で頭打ちになる）、「手動なら最高速度で旋回できるのに
// 自動操縦だと遅い」ことになっていた。上限を荷重倍数で決めれば、
// 速い機体はそのまま速く飛んだまま深く倒して曲がれる。
const AP_BANK_MAX_HARD = 85;    // それでもここまで(°)。n=11.5G相当
const AP_LOAD_MARGIN = 0.7;     // 出せる揚力のうち、旋回に使っていい割合（失速させない余裕）

// その速度で保てるバンク角の上限(°)
function apBankLimit(vMps, stallMps) {
  const k = Math.max(vMps, 1) / Math.max(stallMps, 1);
  const nMax = k * k * AP_LOAD_MARGIN;            // 出せる荷重倍数
  if (!(nMax > 1.02)) return AP_BANK_MAX;         // 失速ぎりぎりでは傾けない
  const deg = Math.acos(1 / nMax) * 180 / Math.PI;
  return apClamp(deg, AP_BANK_MAX, AP_BANK_MAX_HARD);
}

// その速度で、許せる旋回半径に収めるのに実際に使うバンク角の上限(°)
function apBankMaxFor(vMps, stallMps, radiusMax) {
  const r = radiusMax === undefined ? AP_CRUISE_TURN_RADIUS_MAX : radiusMax;
  const needed = Math.atan((vMps * vMps) / (9.80665 * Math.max(r, 1))) * 180 / Math.PI;
  return apClamp(needed, AP_BANK_MAX, apBankLimit(vMps, stallMps));
}

// 失速速度から、離陸・上昇・巡航・進入の速度を決める。
// analyzeAircraftPerformance と同じ式で失速速度を出す（重い呼び出しは避ける）。
// distToGoM（目的地までの距離）を渡すと、旋回半径をそのルートの長さに合わせて絞る
// （渡さなければ世界の大きさから決めた上限のまま——目的地未設定の高度維持モードなど）。
// currentVMps（いまの対気速度）を渡すと、実際に使うバンク角の上限をその速度で出す
// （渡さなければ巡航速度のぶん）。
function apSpeedSchedule(model, distToGoM, currentVMps) {
  const W = model.massKg * 9.80665;
  const S = Math.max(model.wingArea, 0.01);
  const stall = Math.sqrt((2 * W) / (1.225 * S * 1.5));
  const vMax = Math.max(model.vMaxMps || 0, stall * 2);
  const radiusMax = apCruiseTurnRadiusMax(distToGoM);
  // 「出したい速さ」で要るバンク角を先に出し、そこから曲がれる速さを決める。
  // 順序が逆（先にバンク角を決めて速さを頭打ちにする）だと、速い機体は
  // 曲がるために遅く飛ぶしかなくなる。
  const vWant = vMax * 0.97;
  const bankPlan = apBankMaxFor(vWant, stall, radiusMax);
  const turnableV = Math.sqrt(radiusMax * 9.80665
    * Math.tan(bankPlan * Math.PI / 180));
  // 実際に舵を切るときの上限は、いまの速度で保てるぶん。上昇中など巡航より
  // 遅いときに巡航ぶんの深いバンクを許すと、その揚力が出せず失速するだけになる。
  const bankMax = currentVMps === undefined ? bankPlan
    : apBankMaxFor(currentVMps, stall, radiusMax);
  // 目的地までに進入速度まで落としきれる速さ（cruise の説明を参照）
  const approach = stall * 1.3;
  let slowableV = Infinity;
  if (distToGoM > 0 && typeof aircraftDragLengthM === 'function') {
    const L = aircraftDragLengthM(model);
    if (L > 0) slowableV = approach * Math.exp((distToGoM * AP_DECEL_ROUTE_FRACTION) / L);
  }
  return {
    stall,
    rotate: stall * 1.15,               // 機首を上げる速度
    climb: apClamp(stall * 1.35, stall * 1.2, vMax * 0.6),
    // 巡航はできるだけ速く——ただし旋回できる速さを超えない範囲で。
    // ぴったり最高速度を目標にすると、推力と抵抗がほぼ釣り合ったところを
    // 延々スロットルで追いかけることになるだけなので、97%で十分
    // （届かなければ出力は自然に全開のまま張り付く）。
    // 巡航はできるだけ速く——ただし**目的地までに進入速度まで落としきれる速さ**を
    // 超えない。抗力で落とせる距離は L·ln(v0/v1)（aircraftDragLengthM 参照）なので、
    // 逆に解くと、残り距離 d のうち減速に使っていいぶんで出していい速さは
    //   v = 進入速度 × exp(d·割合 / L)。
    // ここが無いと、翼の小さい超高速機は落としきれないまま進入に入る——実測で
    // サンダーバード1号が進入開始2052kt（進入速度362kt）で突っ込み、
    // 何度やり直しても降りられなかった（あの機体の抗力長さは約300km、
    // 巡航から進入速度まで落とすのに1100km要る）。
    cruise: apClamp(Math.min(vMax * 0.97, turnableV, slowableV), stall * 1.4, vMax),
    approach,
    vMax,
    bankMax,  // 巡航中（nav()）が実際に使うバンク角の上限。進入・引き起こしはこれより浅い固定値のまま
    bankPlan, // 巡航速度を決めるのに使ったバンク角の上限（＝出したい速さで要るぶん）
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
// 引き起こしを始める高さ。機体の大きさ（＝翼幅）だけで決めていたが、
// **速い機体は同じ経路角でも沈下率が大きい**ので、同じ高さから引くと
// 抑えきる前に地面に着く——実測でサンダーバード1号（進入380kt、沈下10m/s）が
// -3708fpm/23.7Gで叩きつけていた。沈下率で見た「あと何秒で地面か」でも
// 判断すれば、速い機体は自然に高いところから引き起こしを始める。
const AP_FLARE_SEC = 4;
function apFlareHeight(model, state) {
  const bySize = apClamp(model.wingSpan * 0.5, 6, 20);
  if (!state) return bySize;
  const bySink = Math.max(-state.verticalSpeed, 0) * AP_FLARE_SEC;
  return Math.max(bySize, bySink);
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
    // takeoff/climb/cruise/descent/approach/goaround/flare/rollout/done に加え、
    // 垂直離着陸を選んだ機体では vtol_takeoff/vtol_transition（離陸）・
    // vtol_approach/vtol_descent（着陸）も通る
    phase: 'off',
    plan: null,            // apMakeApproachPlan の結果
    statusText: '',
    vtolTakeoff: false,     // 垂直離陸用エンジンを持つ機体で、離陸を垂直で行うか
    vtolLanding: false,     // 同じく、着陸を垂直で行うか
    terrainFloorM: undefined, // 前方の地面から決まる、下回ってはいけない高度(m)
    terrainVsNeed: -Infinity, // 前方の山を越えるのに要る昇降率(m/s)
    terrainClock: 0,          // 地面を測り直すまでの時間
    ceilingSec: 0,          // 上昇率がほぼ無いまま続いている秒数（上昇限度の判定）
    ceilingLimited: false,  // 上昇限度に当たって、目標高度を下げたか
    pitchCmdDeg: undefined, // 実際に舵へ渡している指示ピッチ（変化率を制限したあと）
    rotating: false,        // 離陸滑走で機首上げを始めたか
    descentSpeedCapMps: 0,  // 降下中の速度の上限（降下に入った時点の速さ）
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
    if (phase !== 'descent') ap.descentSpeedCapMps = 0; // 降下から出たら取り直す
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

  // 前方の地面から決まる「下回ってはいけない高度」。離陸から着陸まで、
  // どの段でも同じものを使う。
  //
  // 空港へ近づくほど余裕を減らす（タラップ参照）タイミングは、**接地点までの
  // 距離**で測る——distFaf（最終進入開始点までの距離）だと、FAFを過ぎたとたん
  // 「FAFから離れた距離」に転じて増えはじめ、滑走路のすぐ上で余裕300mが
  // 復活して接地の引き起こしと喧嘩する。それだけでなく、やり直し（goaround）は
  // 逆にFAFへ向かって戻るので、FAFの手前でdistFafが小さくなり、やり直し側の
  // 余裕だけ先に0へ近づく——進入と要求する高さが食い違って、
  // やり直し⇄進入を1秒に何度も往復する暴走が実際に起きた。
  // 接地点までの距離なら、FAFの前でもあとでも、やり直し中でも、着陸に近づくほど
  // 単調に減っていくので、どの段からでも同じ答えになる。
  const distTouchdown = plan
    ? Math.hypot(state.position.x - plan.aim.x, state.position.z - plan.aim.z)
    : undefined;
  const terrain = apUpdateTerrainFloor(state, ap, env, dt, distTouchdown, spd);
  const floorM = terrain.floorM;
  const overTerrain = (altM) => (floorM > -1e5 ? Math.max(altM, floorM) : altM);
  // 山を越えるのに要る昇降率。指示が足りなければこれで底上げする
  const overTerrainVs = (vs) => Math.max(vs, terrain.vsNeed);
  // 山に押されて、ふだんの上昇角（AP_CLIMB_DEG）より急に登らされているあいだは、
  // 指示ピッチの頭打ちも上げる——**上げないと指示した昇降率が出せない**。
  // 経路角30°で登るには、迎角ぶんを足して35°ほどの姿勢が要るのに、
  // ふだんの上限（15°）のままでは姿勢が足りず、せっかく上げた指示が
  // そのまま捨てられる。
  // 見るのは**地形の要求（terrain.vsNeed）だけ**。「指示が大きいかどうか」で
  // 見ると、ふつうの巡航高度合わせ（目標まで遠ければ指示は大きくなる）でも
  // 上限が上がってしまい、重い機体の姿勢が振れて経路に乗れなくなる
  // ——実測でBoeing747が進入まで行けず着陸しなくなった。
  const terrainPushing = terrain.rising && terrain.vsNeed > apVsLimits(state).up;
  const terrainPitchMax = () => (terrainPushing ? AP_TERRAIN_PITCH_MAX : undefined);

  // ---- 垂直離陸：真上へ上がる -------------------------------------------------
  if (ap.phase === 'vtol_takeoff') {
    controls.throttle = 0;
    controls.brake = 0;
    controls.gearDown = true;
    controls.flap = 0;
    // 姿勢は水平のまま。方位は離陸したときの向きを保つ
    // （accumulateVtolControlが低速でのピッチ/ロール/ヨーを姿勢制御ノズルとして拾う）
    const err = apWrap180(ap.takeoffHeadingDeg - state.headingDeg);
    controls.yaw = apClamp(err * AP_STEER_KP, -1, 1);
    controls.pitch = apElevatorForPitch(state, controls, 0, dt, spd, ap);
    controls.roll = apAileronForBank(state, 0, spd);
    controls.vtolThrottle = apVtolThrottleForVs(controls, state.verticalSpeed, AP_VTOL_CLIMB_MPS, dt);
    if (state.altitudeAglM > AP_VTOL_TRANSITION_AGL_M) say('vtol_transition', '前進エンジンへ切替');
    return;
  }

  // ---- 垂直離陸：前へ進むエンジンへ切り替えて加速 -------------------------------
  if (ap.phase === 'vtol_transition') {
    controls.gearDown = false;
    controls.flap = 0;
    const want = plan ? apBearingTo(state.position.x, state.position.z, tx, tz) : state.headingDeg;
    ap.targetHeadingDeg = want;
    controls.roll = apAileronForTrack(state, want, spd.bankMax, spd);
    controls.yaw = apRudderForCoordination(state);

    controls.throttle = 1;
    // 前へ進む速度が育つほど、垂直エンジンの出力を手放していく
    // （0m/sでは全開、上昇フェーズへ渡す速さに達したら0——実際に検証した
    // 手動操作の遷移と同じ形）。姿勢は少し機首下げにして加速を助ける。
    controls.vtolThrottle = apClamp(1 - state.airspeed / Math.max(spd.climb, 1), 0, 1);
    const want2 = apClamp(-6 * controls.vtolThrottle, -6, 0);
    controls.pitch = apElevatorForPitch(state, controls, want2, dt, spd, ap);
    ap.targetSpeedMps = spd.climb;
    ap.vsCmd = state.verticalSpeed;

    if (state.airspeed >= spd.climb || controls.vtolThrottle <= 0.01) {
      controls.vtolThrottle = 0;
      say('climb', '上昇');
    }
    return;
  }

  // ---- 離陸滑走 -------------------------------------------------------------
  if (ap.phase === 'takeoff') {
    // 上昇の速度を超えたら出力を戻す。**推力重量比が桁外れな機体は、
    // 全開のまま滑走させると数秒で音速を何倍も超える**——実測でサンダーバード1号
    // （推力重量比325）が離陸から20秒で2277ktに達し、目標高度を突き抜けて
    // そのまま降下に入り、進入までに落としきれず永久にやり直していた。
    // 滑走中は全開のまま。浮いたあとは上昇の速度で頭打ちにする。
    const over = state.airspeed - spd.climb;
    controls.throttle = (state.onGround || over <= 0) ? 1
      : apClamp(1 - over / Math.max(spd.climb * 0.5, 10), 0, 1);
    controls.brake = 0;
    controls.gearDown = true;
    // 前輪で滑走路の方位を保つ
    const err = apWrap180(ap.takeoffHeadingDeg - state.headingDeg);
    controls.yaw = apClamp(err * AP_STEER_KP, -1, 1);
    controls.roll = apAileronForBank(state, 0, spd);
    // 引き起こしを始めたら、そのあとは舵を放さない。
    // **前向きの対気速度は、機首が上がるとそれだけで減る**——引き起こし中に
    // 「引き起こす速度に足りない」と見なして舵を中立へ戻してしまい、上がりだした
    // 機首をそこで放り出していた。ピッチの復元も減衰も持たないデルタ機
    // （Concorde）はそのまま回り続け、実測で20秒後にピッチ83°から背面に入って
    // 滑走路へ落ちていた。一度上げると決めたら、姿勢は最後まで舵で押さえる。
    if (state.forwardAirspeed >= spd.rotate) ap.rotating = true;
    // 引き起こす速度までは**水平を保つ**。舵を中立に落としておくやり方だと、
    // 主翼が重心より前にある機体は速度が乗った時点で勝手に機首が上がり、
    // 誰も押さえないまま浮いて背面まで回ってしまう（実測でBoeing 747が121kt、
    // 引き起こし速度148ktのだいぶ手前でピッチ12.7°→84.6°）。
    // 姿勢を0°に保てば、尻もちを防ぐという元の目的もそのまま満たせる。
    controls.pitch = apElevatorForPitch(state, controls, ap.rotating ? 10 : 0, dt, spd, ap);
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
    // 対地高度が低いうちは浅く（apBankAglFactor）、地形を越えるのに昇降率が
    // 要るときも浅く（apBankClimbFactor）——登るほうを旋回より優先する。
    const bankLim = spd.bankMax * apBankAglFactor(state) * apBankClimbFactor(state, terrain.vsNeed);
    controls.roll = apAileronForTrack(state, want, bankLim, spd);
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
    // **ズームクライムが尽きて沈み始めたら、速度超過中でも出力を戻す**。
    // 推力重量比が極端な機体は、離陸直後に全開のまま曲がれる速さの何倍もへ
    // 加速し、この速度超過カットで出力0%のまま姿勢だけで登る（＝運動エネルギーを
    // 高度へ変えるズームクライム）。上っているうちはそれでいいが、エネルギーを
    // 使い切って昇降率が負に転じても速度がまだ超過しているというだけで
    // 出力0%が続くと、あとは沈むだけになる——実測（推力重量比約30の
    // フィクション機、目標高度12000m）で、対地3500m付近まで無出力の
    // ズームクライムで上がったあと、そのまま無出力で降下に転じ、
    // 高度を全部失って墜落した。沈み始めたら「曲がれる速さまで落とす」より
    // 「これ以上沈まない」を優先する。
    // **昇降率0を境にした二値の切り替えにしない**——ちょうどそのあたりで
    // 昇降率は±0付近を毎フレーム細かく上下するため、二値だと出力が
    // 0%⇔100%を毎フレーム往復し、平均すると速度超過カットが半分しか
    // 効かなくなって**かえって加速し続けた**（実測、1030ktから1150kt超まで
    // 1秒少々で加速）。沈み方に応じて滑らかに戻す。
    const sinkUrgency = apClamp(-state.verticalSpeed / AP_CRUISE_SINK_URGENCY_MPS, 0, 1);
    const overspeedCut = overCruise > 0 ? apClamp(1 - overCruise * 0.1, 0, 1) : 1;
    controls.throttle = Math.max(overspeedCut, sinkUrgency);
    // 山に追われているあいだは姿勢の頭打ちも上げる。上昇の姿勢は「上昇速度を
    // 保つところまで」で自分から止まるので、上限を上げても速度は割らない
    // （出せない機体は、上げたところで速度が落ちて勝手に戻る）。
    // 「床より低い」で見てはいけない——平らな地面でも離陸直後は余裕300mの
    // 床より低いので、ふつうの離陸がぜんぶ急上昇になってしまう。
    const pitchMax = terrainPushing ? AP_TERRAIN_PITCH_MAX : AP_PITCH_MAX;
    const want = apClamp(state.pitchDeg + (state.airspeed - spd.climb) * 0.8, 0, pitchMax);
    controls.pitch = apElevatorForPitch(state, controls, want, dt, spd, ap);
    ap.vsCmd = state.verticalSpeed;
    // 山があれば、目標高度に届いても上りつづける。
    //
    // 巡航へ渡すのは「目標の60m手前」ではなく、**渡した先が同じ昇降率を指示する
    // 高さ**。巡航の段は昇降率を高度のずれ×AP_VS_KP で出すので、いま40m/sで
    // 上っているなら 40/0.10 = 400m 手前で渡さないと、渡した瞬間に指示が
    // 40m/s→3m/s へ跳ぶ。跳べば姿勢の指示も一気に振れ、静安定の小さい機体は
    // そのまま行って来いが育って裏返る（実測でConcordeが巡航に入った4秒後に
    // ピッチ-12.6°、20秒後に迎角142°で墜ちた）。この式なら指示は連続でつながる。
    const levelAhead = Math.max(60, Math.max(state.verticalSpeed, 0) / AP_VS_KP);
    if (state.altitudeM > Math.max(ap.targetAltitudeM, floorM) - levelAhead) { say('cruise', '巡航'); return; }

    // 上昇を切り上げる条件は「目標に届いた」だけでは足りない。**届かない目標を
    // 設定されることがある**——高度のスライダーは12000mまで動くが、練習機の
    // 上昇限度は実測で約2900mしかない。目標3000mでも6000mでも、上昇のまま
    // 永遠に帰ってこず、降下も進入も始まらないまま目的地を通り過ぎていた
    // （「着陸でなかなか降下しないで全く間に合わない」のはこれ）。
    // 抜け道を2つ用意する。

    // (1) 上昇限度。全開で上がっているのに上昇率がほぼ無くなったら、
    //     そこを巡航高度として受け入れる。一瞬の谷で切り上げないよう、
    //     続いた時間で見る。
    if (state.verticalSpeed < AP_CEILING_VS_MPS) {
      ap.ceilingSec = (ap.ceilingSec || 0) + dt;
      if (ap.ceilingSec > AP_CEILING_SEC) {
        ap.targetAltitudeM = Math.round(state.altitudeM);
        ap.ceilingLimited = true;
        say('cruise', '巡航（上昇限度 ' + ap.targetAltitudeM + 'm）');
        return;
      }
    } else {
      ap.ceilingSec = 0;
    }

    // (2) 降下を始めないと間に合わない距離まで来たら、目標高度に関係なく降りる。
    //     上るほど降りるのに要る距離も伸びるので、放っておくと近づくほど
    //     間に合わなくなる。ここで打ち切れば「ルートの長さで上れるだけ上って
    //     から降りる」になる。
    if (plan) {
      const drop = Math.max(state.altitudeM - plan.fafAltM, 0);
      if (distFaf < drop / AP_DESCENT_SLOPE + 3000) {
        ap.targetAltitudeM = Math.round(state.altitudeM);
        say('descent', '降下（上昇を切り上げ）');
      }
    }
    return;
  }

  // ---- 巡航 -----------------------------------------------------------------
  if (ap.phase === 'cruise') {
    // 前方の山を越えるのに、いまの高度ではだいぶ足りない——巡航のままだと
    // 出力が「巡航速度を保つぶん」しか出ず、上っては速度が落ちて上れなくなる
    // （実測で、山の上を63mでかすめた）。上昇の段に戻せば全開で上れる。
    if (floorM > state.altitudeM + AP_TERRAIN_CLIMB_BACK_M) {
      say('climb', '上昇（地形回避）');
      return;
    }
    nav();
    ap.targetSpeedMps = spd.cruise;
    // **目標高度より低いのに沈んでいるときは、速度超過中でも出力を残す**。
    // 出力は「巡航速度を保つぶん」だけで決めていたので、上のズームクライム
    // （climbの項を参照）がエネルギー切れで沈みに転じたあとにこの段へ
    // 来ても、速度がまだ巡航の1.5倍を超えているというだけで出力0%が続き、
    // 高度を全部失って墜落していた（実測、目標高度12000mに対し対地3500m付近で
    // 頭打ちになったあとそのまま墜落）。沈み方に応じて滑らかに出力を戻す
    // ——二値の切り替えだと、沈み方がしきい値をまたぐたびに出力が飛んで
    // 昇降そのものが暴れる。
    const belowTarget = state.altitudeM < overTerrain(ap.targetAltitudeM);
    const sinkUrgency = belowTarget
      ? apClamp(-state.verticalSpeed / AP_CRUISE_SINK_URGENCY_MPS, 0, 1) : 0;
    controls.throttle = Math.max(apThrottleForSpeed(state, controls, spd.cruise, dt), sinkUrgency);
    ap.vsCmd = overTerrainVs(apVsForAltitude(state, overTerrain(ap.targetAltitudeM), apClimbCap(state, spd)));
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()), dt, spd, ap);
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
    // 降下しながら、進入速度まで落としきる。
    //
    // **「残りの距離で落としきれる速度」を目標にする**。以前は巡航速度の85%を
    // ずっと目標にしていて、進入速度まで落ちるのは偶然に頼っていた——
    // 目的地に近づくと旋回半径の上限が縮み、それに引きずられて巡航速度の
    // 見積もりも下がるので、結果として減速していた（apCruiseTurnRadiusMax参照）。
    // 旋回のための頭打ちを速い機体で外したとたん、この偶然が消えて
    // 進入に958ktで突っ込み、74Gを掛けてやり直すようになった。
    // 減速は旋回半径とは無関係の話なので、ここで正面から書く：
    // 抗力だけで落とせる減速度を AP_DECEL_MPS2 と見て、残り距離 distFaf で
    // 進入速度まで落とすのに、いま出していていい速度は
    //   v = √(進入速度² + 2·減速度·残り距離)
    const vAllowed = Math.sqrt(spd.approach * spd.approach
      + 2 * AP_DECEL_MPS2 * Math.max(distFaf, 0));
    // **降下では加速しない**。頭打ちを「巡航速度の85%」にしていたので、巡航が
    // 速い機体は降下に入ってから**加速していた**——実測でBoeing 747が降下開始の
    // 279ktから433ktまで上げてしまい、そのぶんを最後の15kmで落としきれず、
    // 進入開始に231kt（進入速度168kt）・経路より364m高いところで入って、
    // やり直しを繰り返していた。降りながら速くなる理由はどこにもないので、
    // 降下に入った時点の速さを上限にする。
    if (!(ap.descentSpeedCapMps > 0)) {
      ap.descentSpeedCapMps = Math.max(state.airspeed, spd.approach);
    }
    ap.targetSpeedMps = Math.min(ap.descentSpeedCapMps, vAllowed);
    controls.throttle = apThrottleForSpeed(state, controls, ap.targetSpeedMps, dt);
    // 最終進入開始点の高度へ、一定の勾配で降りる
    const wantAlt = overTerrain(
      Math.min(plan.fafAltM + distFaf * AP_DESCENT_SLOPE, ap.targetAltitudeM));
    // **予定より速ければ脚を出す**。降りることと減速することを姿勢ひとつで
    // 両立させようとすると、重い機体はどちらも中途半端になる（実測でBoeing 747が
    // 進入開始に260kt・経路より600m高いところで入り、やり直しを25回繰り返した）。
    // 実機の進入で最初に出す減速装置がこれで、抗力は速度の2乗で効くので
    // 速すぎるときほどよく効く。遅くなったらすぐ引っ込める。
    if (state.airspeed > ap.targetSpeedMps * (controls.gearDown ? 0.98 : 1.02)) {
      controls.gearDown = true;
    } else {
      controls.gearDown = false;
    }
    // 目標が巡航高度で頭打ちのあいだは、まだ坂に乗っていない＝前送りは要らない
    const onSlope = wantAlt < ap.targetAltitudeM - 1;
    ap.vsCmd = overTerrainVs(apVsForPath(state, wantAlt, onSlope ? AP_DESCENT_SLOPE : 0, apClimbCap(state, spd)));
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()), dt, spd, ap);
    if (distFaf < 2500) {
      say(ap.vtolLanding && model.hasVtol ? 'vtol_approach' : 'approach',
        ap.vtolLanding && model.hasVtol ? '最終進入（垂直着陸）' : '最終進入');
    }
    return;
  }

  // ---- 垂直着陸：着地点の上空へ寄せる（滑走路は要らないので中心線は気にしない） -----
  if (ap.phase === 'vtol_approach') {
    const want = apBearingTo(state.position.x, state.position.z, plan.threshold.x, plan.threshold.z);
    ap.targetHeadingDeg = want;
    controls.roll = apAileronForTrack(state, want, spd.bankMax, spd);
    controls.yaw = apRudderForCoordination(state);

    const distToTouchdown = Math.hypot(
      state.position.x - plan.threshold.x, state.position.z - plan.threshold.z);
    ap.distanceM = distToTouchdown;

    ap.targetSpeedMps = spd.approach;
    controls.throttle = apThrottleForSpeed(state, controls, spd.approach, dt);
    controls.gearDown = true;
    controls.flap = 1;

    // 中心線に乗せる必要が無いぶん、進入はずっと単純——垂直降下を始めていい
    // 高さまでただ寄せるだけでいい
    const hoverAltM = plan.elevationM + AP_VTOL_HOVER_AGL_M;
    // **垂直着陸の進入も地形を見る**。ここだけ overTerrain/overTerrainVs が
    // 抜けていたので、着地点の手前に山があると、ホバーの高さ（対地80m）へ
    // まっすぐ降りながら山へ突っ込めた。滑走路を使う進入（approach）と
    // 同じだけ地形は避けなければいけない。
    ap.vsCmd = overTerrainVs(apVsForAltitude(state, overTerrain(hoverAltM), apClimbCap(state, spd)));
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()), dt, spd, ap);

    if (distToTouchdown < apVtolHoverEngageRadius(spd)) say('vtol_descent', '垂直降下');
    return;
  }

  // ---- 垂直着陸：ホバーしながら真下へ降りる -------------------------------------
  if (ap.phase === 'vtol_descent') {
    controls.gearDown = true;
    controls.flap = 1;
    controls.throttle = 0; // 前へ進む推力は切る。速度は抗力任せで落ちていく

    // **接地の直前は水平に戻す**。ホバーの傾きは水平移動のためのものだが、
    // 傾いたまま降りると脚が1本だけ先に着く——そこで垂直エンジンが切れると
    // 支える力が無くなり、そのまま倒れる（実測でサンダーバード2号が
    // ピッチ-9.5°・ロール-12.6°のまま片脚接地し、24.9Gで転がった）。
    // 低いところでは位置を直すより、水平に降りることを優先する。
    const tiltMax = AP_VTOL_TILT_MAX
      * apClamp(state.altitudeAglM / AP_VTOL_LEVEL_AGL_M, 0.15, 1);
    const hover = apVtolHoverAngles(state, plan.threshold.x, plan.threshold.z, tiltMax);
    controls.pitch = apElevatorForPitch(state, controls, hover.wantPitchDeg, dt, spd, ap);
    controls.roll = apAileronForBank(state, hover.wantBankDeg, spd);
    controls.yaw = apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP, -1, 1);

    // 沈下率は残りの高さに比例させる（引き起こしと同じ考え方。高いうちは速く、近づくほどゆっくり）
    //
    // **ただし、前へ進む速度が残っているうちは降りない**。ここは沈下率を
    // 高さだけで決めていたので、進入速度のまま垂直降下に入った機体が、
    // 減速しきる前に接地していた——実測（進入157ktの垂直離着陸機）で、
    // 対地80mから降りはじめて対地速度15ktのまま接地し、そこから
    // ブレーキが効くにつれてピッチが 0.6°→-30°→-62° と突っ込んで、
    // **脚が重心より後ろ寄りの機体（サンダーバード1号など）はそのまま前へ転がった**
    // （接地後16G・ロール180°）。止まる前に降りてしまうと、着地点も
    // 通り過ぎる（実測で32m先に降り、そのまま滑っていった）。
    // ホバーの傾き（apVtolHoverAngles）は速度を打ち消す向きに働くので、
    // 降りずに待っていれば止まる。止まってから降りる。
    const slowEnough = apClamp(
      (AP_VTOL_DESCENT_GS_MPS - state.groundSpeed) / AP_VTOL_DESCENT_GS_MPS, 0, 1);
    const targetVs = -apClamp(state.altitudeAglM * AP_VTOL_SINK_KP, 0.3, AP_VTOL_SINK_MAX)
      * slowEnough;
    controls.vtolThrottle = apVtolThrottleForVs(controls, state.verticalSpeed, targetVs, dt);

    if (state.onGround) { say('vtol_touchdown', '接地'); return; }
    return;
  }

  // ---- 垂直着陸：接地して止まる -----------------------------------------------
  if (ap.phase === 'vtol_touchdown') {
    controls.throttle = 0;
    // **垂直エンジンは、接地した瞬間に切らずにゆっくり抜く**。低速では
    // ピッチ・ロール・ヨーの指示を姿勢制御ノズルとして拾っている
    // （accumulateVtolControl）ので、いきなり0にすると接地した瞬間に
    // 姿勢を保つ手段が無くなる。脚が高くて左右が狭い機体はそのまま倒れる——
    // 実測でサンダーバード1号（脚の高さ8.0m・左右8.4m）が、-46fpm という
    // 静かな接地のあと3秒で横倒しになり15.2Gを記録していた。
    // 実機の垂直着陸も、接地してから推力を絞っていく。
    // 抜くのは**脚が地面に着いているあいだだけ**。着いていないのに抜き続けると、
    // 一度弾んで浮いたときにそのまま落ちる——実測でサンダーバード1号が接地後
    // 3.7m跳ね上がり、推力が抜けきったところから-8m/sで落ちて8.8Gを記録した。
    // 浮いているあいだは静かに沈むぶんだけ出しておく。
    controls.vtolThrottle = state.onGround
      ? Math.max((controls.vtolThrottle || 0) - dt / AP_VTOL_CUT_SEC, 0)
      : apVtolThrottleForVs(controls, state.verticalSpeed, -AP_VTOL_SETTLE_MPS, dt);
    controls.pitch = apElevatorForPitch(state, controls, 0, dt, spd, ap);
    controls.roll = apAileronForBank(state, 0, spd);
    controls.trim = 0;
    // 脚に荷重が乗りきる前に強く踏むと、重心が車輪よりずっと上にある機体は
    // そのまま前へ倒れる。推力を抜きながらブレーキを効かせていく。
    controls.brake = 1 - controls.vtolThrottle;
    if (state.groundSpeed < 1.5) {
      controls.brake = 0;
      controls.parkingBrake = true;
      say('done', `${plan.airportId} に着陸しました`);
      ap.full = false;
    }
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
    controls.roll = apAileronForTrack(state, want, 20, spd);
    // 接地の直前だけ、横滑りを消すより滑走路と機首を合わせるほうを優先する。
    // 斜めを向いたまま降りると脚をねじるが、早くから機首を合わせてしまうと
    // 今度は横風でそのぶん流されるので、引き起こしにかかる高さで切り替える。
    controls.yaw = state.altitudeAglM < apFlareHeight(model) * 2
      ? apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP, -1, 1)
      : apRudderForCoordination(state);

    // 縦：接地点まであと何mかで高度が決まる
    const glideAlt = plan.elevationM + Math.max(t.before, 0) * plan.glide;

    // **最終進入区間にも地形を見る**。ここから先は「滑走路そのものへ降りるので
    // 掛けない」としていたが、それはFAF〜滑走路の9kmが山を越えていない前提の
    // 話——進入計画そのものが山を越えている空港（実際にありうる）では、
    // 見ないと引き起こしの直前まで気づけない。outer scope の floorM は
    // 接地点までの距離でタラップしてある（apStepFullの冒頭を参照）ので、
    // やり直し（goaroundはFAFへ戻るのでdistFafが縮む）と進入（滑走路へ
    // 進むのでt.beforeが縮む）とで要求する高さが食い違わない。
    //
    // **越えているあいだは、進入の細かい制御をいったん脇へ置く**。
    // 「地形の床がいまの3°経路より高い＝床のほうへ乗せる」だけを goaround への
    // 分岐でやろうとすると、床はまだ前方にあり続けるので、越えきって
    // 現在高度が十分でも「3°経路そのものはまだ床の下」という理由でgoaroundへ
    // 戻ってしまい、goaroundの再進入判定（FAFに近い・高さが合っている）も
    // すぐ満たしてしまうため、**1フレームおきに進入とやり直しを何百回も往復する
    // 暴走**になった（実測）。越えているあいだ（floorM>glideAlt）は素直に
    // 床そのものを目標にし、上昇の段と同じ上昇率まで許す——ここを
    // 「3°経路を細かく追う」ぶんの小さな上限（Math.max(speed*0.05,2)）に
    // 絞ったままだと、失速速度ぎりぎりに貼り付いて出力が0%⇔100%を往復する
    // 不安定な這うような飛び方になった（実測、対地高度70m前後で数百秒
    // 動けなくなった）。越え終えたらこれまでどおりの細かい経路追従へ戻る。
    const overFloor = floorM > -1e5 && floorM > glideAlt;
    const wantAlt = overFloor ? floorM : glideAlt;
    const upMax = overFloor ? apClimbCap(state, spd)
      : Math.min(apClimbCap(state, spd), Math.max(state.airspeed * 0.05, 2));
    ap.vsCmd = apVsForPath(state, wantAlt, overFloor ? 0 : plan.glide, upMax);
    controls.pitch = apElevatorForPitch(state, controls, apPitchForVs(state, ap.vsCmd, -8, 12), dt, spd, ap);

    // **経路より高いときは出力を切る**。高いのに速度を出力で保とうとすると、
    // 足した推力がそのまま浮く力になって降下が止まる——実測でBoeing 747が
    // 滑走路の2.5km手前・経路より150m高い位置で出力54%を入れ、そこから
    // まったく降りられずに滑走路を素通りしてやり直していた。
    // 実機の進入も、高いと分かった時点でまずアイドルにする。
    // 逆に**経路より低いときは出力を足す**。姿勢だけでは経路を保てないことが
    // あるからで、翼の小さい機体では迎角が頭打ちになってそのまま沈む——実測で
    // サンダーバード1号（進入362kt・翼73m²）が迎角10.7°で揚力を使い切り、
    // 出力0のまま滑走路の6km手前に-3708fpmで叩きつけていた。
    // 実機の進入操作と同じで、経路は「高ければ絞る・低ければ足す」で押さえる。
    // 低いときは**目標速度のほうを上げる**。出力を直接足すやり方だと、推力が
    // 桁外れな機体（サンダーバード1号は推力重量比325）が一瞬で加速して
    // 経路から飛び出す。速度で足せば、速度の輪がそのまま出力を押さえてくれる。
    //
    // **地形の床を追っているあいだは「高いから絞る」を掛けない**。山を
    // 越えるために意図して3°経路より高く飛んでいるので、それを「高すぎる」と
    // 見て出力を切ると、登るための力を自分で奪ってしまう（実測、これが
    // 抜けていたときに失速速度ぎりぎりの這うような飛び方になっていた）。
    const pathErr = state.altitudeM - glideAlt; // 正なら経路より高い
    const low = apClamp(-pathErr / AP_LOW_ON_PATH_M, 0, 1);
    ap.targetSpeedMps = spd.approach * (1 + AP_LOW_ON_PATH_GAIN * low);
    controls.throttle = (!overFloor && pathErr > AP_HIGH_ON_PATH_M)
      ? 0 : apThrottleForSpeed(state, controls, ap.targetSpeedMps, dt);
    controls.gearDown = true;
    // フラップは残りの距離で下ろす。高度で決めると、高い空港と低い空港で
    // 下ろす場所がずれる（進入経路のどこにいるかが本当に効く量）。
    controls.flap = t.before < 2500 ? 1 : 0.5;

    // 接地の直前で引き起こす。高さは機体の大きさで決める（大型機ほど高い位置で）。
    // **滑走路の近くにいることも条件にする**——対地高度だけで決めると、
    // 何km も手前で盛り上がった山の上を通っただけで引き起こしに入ってしまう。
    // 「滑走路の近く」も速度で測る。600m 固定だと、進入380ktの機体はそこを
    // 3秒で通り過ぎてしまい、引き起こしに入る間もなく接地する（実測23.7G）。
    const nearRunwayM = Math.max(600, state.groundSpeed * AP_FLARE_SEC * 2);
    if (t.before < nearRunwayM && state.altitudeAglM < apFlareHeight(model, state)) {
      say('flare', '接地'); return;
    }

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
    // **やり直しも地形を見る**。ここだけ overTerrain/overTerrainVs を掛けて
    // いなかったので、山のそばの空港でやり直すと、最終進入開始点の高さまでしか
    // 上がらず山へ突っ込めた。逃げる動きなのだから、行き先の空港と同じだけ
    // 地形は避けなければいけない。
    const wantAlt = overTerrain(plan.fafAltM + 150);
    ap.vsCmd = overTerrainVs(apVsForAltitude(state, wantAlt, apClimbCap(state, spd)));
    ap.targetSpeedMps = spd.climb;
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()), dt, spd, ap);
    // 最終進入開始点に戻って、高度も合っていれば進入をやり直す
    if (distFaf < 2500 && Math.abs(state.altitudeM - wantAlt) < 250) say('approach', '最終進入');
    return;
  }

  // ---- 引き起こし -----------------------------------------------------------
  if (ap.phase === 'flare') {
    const corr = apClamp(-apTrackPosition(plan, state.position.x, state.position.z).cross * 0.06, -12, 12);
    controls.roll = apAileronForTrack(state, plan.heading + corr, 8, spd);
    controls.yaw = apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP, -1, 1);
    controls.throttle = Math.max(controls.throttle - dt * 0.8, 0);

    // 沈下率は残りの高さに比例させる。一定の沈下率にすると、速い機体ほど
    // 何kmも浮いたまま滑走路を使い切ってしまう（大型機が2.7km先で接地した）。
    // 高いうちは速く、地面に近づくほどゆっくり——実際の引き起こしと同じ形。
    ap.vsCmd = -Math.max(state.altitudeAglM * 0.22, 0.3);
    // 接地の姿勢は少し機首上げ。前輪から落とすと跳ねる。
    const want = apClamp(apPitchForVs(state, ap.vsCmd, -3, 10), state.pitchDeg - 1, 10);
    controls.pitch = apElevatorForPitch(state, controls, want, dt, spd, ap);

    if (state.onGround) say('rollout', '滑走路上で減速');
    return;
  }

  // ---- 減速 -----------------------------------------------------------------
  if (ap.phase === 'rollout') {
    controls.throttle = 0;
    controls.flap = 1;
    controls.roll = apAileronForBank(state, 0, spd);
    controls.yaw = apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP, -1, 1);
    // 跳ねて浮いたら、ブレーキを離してもう一度接地の姿勢へ。
    // 浮いている間に舵を中立へ落とすと、前輪から突っ込むことになる。
    if (!state.onGround) {
      controls.brake = 0;
      controls.pitch = apElevatorForPitch(state, controls, apClamp(state.pitchDeg, 0, 8), dt, spd, ap);
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
  controls.pitch = apElevatorForPitch(state, controls, apPitchForVs(state, ap.vsCmd), dt, spd, ap);
  // 翼を水平に戻すのは、手でロールを当てていないときだけ
  if (Math.abs(controls.roll) < 0.02) controls.roll = apAileronForBank(state, 0, spd);
}

// 自動操縦を1フレーム進める（環境に依らない本体）
function stepAutopilot(model, state, controls, ap, dt, env) {
  if (state.crashed) { ap.full = false; ap.altHold = false; ap.phase = 'off'; return; }
  // 目的地までの距離（進入計画があれば最終進入開始点まで）。旋回半径をルートの
  // 長さに合わせて絞るのに使う（apCruiseTurnRadiusMax参照）。
  const distToGoM = ap.plan
    ? Math.hypot(ap.plan.faf.x - state.position.x, ap.plan.faf.z - state.position.z)
    : undefined;
  const spd = apSpeedSchedule(model, distToGoM, state.airspeed);
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
  const vtolTakeoff = ap.vtolTakeoff && f.aircraft.model.hasVtol;
  ap.phase = f.state.onGround ? (vtolTakeoff ? 'vtol_takeoff' : 'takeoff') : 'cruise';
  ap.rotating = false;
  ap.pitchCmdDeg = undefined;
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
    // 山を越えるために要る（apTerrainFloor）。描かれている面をそのまま読む
    groundHeightAt: flightGroundHeightAt,
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

  const vtolTakeoff = document.getElementById('envApVtolTakeoff');
  if (vtolTakeoff) vtolTakeoff.addEventListener('change', () => {
    flightAutopilot().vtolTakeoff = vtolTakeoff.checked;
    onEnvSettingsChanged();
  });
  const vtolLanding = document.getElementById('envApVtolLanding');
  if (vtolLanding) vtolLanding.addEventListener('change', () => {
    flightAutopilot().vtolLanding = vtolLanding.checked;
    onEnvSettingsChanged();
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

  // 垂直離着陸は、いまの機体に上向きエンジンがあるときだけ選べる
  // （無い機体でチェックを入れさせても、離陸/着陸のときに黙って通常運用に戻るだけなので、
  // ここで断っておいたほうが分かりやすい）。
  const hasVtol = !!(EnvState.flight.aircraft && EnvState.flight.aircraft.model.hasVtol);
  const vtolTakeoff = document.getElementById('envApVtolTakeoff');
  if (vtolTakeoff) { vtolTakeoff.checked = ap.vtolTakeoff; vtolTakeoff.disabled = !hasVtol; }
  const vtolLanding = document.getElementById('envApVtolLanding');
  if (vtolLanding) { vtolLanding.checked = ap.vtolLanding; vtolLanding.disabled = !hasVtol; }
  const vtolHint = document.getElementById('envApVtolHint');
  if (vtolHint) {
    vtolHint.textContent = hasVtol
      ? '入れると滑走路を使わず、真上へ上がって／真下へ降りて発着します。'
      : 'この機体には垂直離着陸用エンジンがありません。';
  }

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
  vtol_takeoff: '垂直離陸', vtol_transition: '前進切替',
  vtol_approach: '進入（垂直）', vtol_descent: '垂直降下', vtol_touchdown: '接地',
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
    apSurfaceGain, apBankLimit, apTerrainFloor, apBankAglFactor, apBankClimbFactor, apVsLimits,
    apTerrainEscapeVs, apVtolHoverAngles,
  apPitchForVs, apBankForHeading, apFlareHeight,
    apVsForAltitude, apThrottleForSpeed,
  };
}
