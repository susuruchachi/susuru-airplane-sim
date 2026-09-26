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
// ピッチ角速度(rad/s)への戻し。0.9では縦の慣性が大きい機体で揺れが残った——
// 指示ピッチを5°上げる段差で、Concordeが5.3°行き過ぎて舵が6回反転し、
// Boeing 747も1.9°行き過ぎた。3にすると2.1°・0.8°（練習機は変わらず）。
// ただし**失速の4倍を大きく超える速さでは0.9へ戻す**（apPitchKd）。舵の効きが動圧で桁違いに
// 大きくなるので、3のままでは舵が毎コマ逆へ振り切れた（プルプル試験機で1,079回/18秒）。
const AP_PITCH_KD = 3;
const AP_PITCH_KD_FAST = 0.9;
function apPitchKd(state, spd) {
  if (!spd || !spd.stall) return AP_PITCH_KD;
  const r = (spd.stall * AP_GAIN_REF_STALLS) / Math.max(state.airspeed, 1);
  return AP_PITCH_KD_FAST + (AP_PITCH_KD - AP_PITCH_KD_FAST) * Math.min(r * r, 1);
}
const AP_PITCH_RATE_FF = 0.5;  // 指示ピッチの動く速さを、減衰から差し引く割合（apElevatorForPitch）
const AP_PITCH_RATE_FF_TAU = 0.3; // その速さをならす時定数(秒)
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
// 足りないときに足す側の速さ。絞るのはゆっくりでいいが、足すのが遅いと
// 失速まで落ちてから慌てることになる（実測でTB2の接地が-1781fpm/48.7G→
// -570fpm/14.2Gまで柔らかくなった）。
const AP_THR_KP_REL_UP = 15;
const AP_YAW_KP = 0.05;        // 横滑り1°あたりのラダー（旋回の釣り合い）
const AP_YAW_RATE_KD = 0.12;  // ヨーダンパー：機首の振れる速さ1°/sあたりの舵（apRudderYawDamped）
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
// 垂直着陸：目標沈下率の上限(m/s)。3では対地200mから降りきるのに93〜153秒かかっていた
// （実測、サンダーバード4機）。8にして66〜69秒、接地は-52〜-55fpmのまま（沈下率は
// 残りの高さに比例して絞るので、効くのは高いところだけ）。
const AP_VTOL_SINK_MAX = 8;
const AP_VTOL_SINK_SLOW = 3;     // 前へ進む速度が残っているあいだの上限(m/s)
const AP_VTOL_VS_KP = 0.20;      // 昇降率のずれ1m/sあたり、毎秒どれだけ垂直エンジン出力を動かすか
// 上下の加速度に対する減衰。**これが無いと必ず振動する**——垂直エンジンの出力は
// 加速度を決めるもので、そこから昇降率まではもう一段の積分がある。その二重積分を
// 積分だけ（AP_VTOL_VS_KP）で回すと位相が180°遅れて、止まらない往復になる。
// 実測でサンダーバード1号が接地の直前に昇降率+120〜-240fpmを2.5秒周期で振り、
// 接地の硬さが「その瞬間どの位相だったか」で2.2G〜4.0Gに散らばっていた。
const AP_VTOL_VS_KD = 0.15;
const AP_VTOL_ACCEL_TAU = 0.25; // 加速度の測り方をならす時定数(秒)。差分そのままは跳ねる
// これより高く上がったら、前へ進むエンジンへ切り替え始める。
// 30mだと切り替えの沈み込みで地面に触れるので、余裕を持たせてある。
const AP_VTOL_TRANSITION_AGL_M = 60;
// 翼が支えられるようになってから、垂直エンジンを抜ききるまでの秒数
const AP_VTOL_WEAN_S = 12;
// 前進切替のあいだに、切り替えた高さからどれだけ上を目指すか(m)
const AP_VTOL_TRANS_CLIMB_M = 120;
// **垂直着陸は、いったん空中で止まってから降りる**。以前は滑走路の進入と同じように
// 「降りながら寄せる」で、対地80mへ向けてまっすぐ降ろしていた——止まる算段が
// どこにも無いので、進入速度の速い機体は着地点を通り過ぎながら地面に届いていた
// （実測：サンダーバード1号 NOVA→NOIS が389kt・沈下24m/sのまま着地点の
// 8.0km手前で垂直着陸に切り替わり、そのまま降下して着地点から8,668m先の地面へ
// 3,097fpm・18.9Gで突っ込み、裏返しになって滑っていった）。
// 対地200mでホバリングに入り、着地点の真上で静止してから真下へ降ろす。
const AP_VTOL_STOP_AGL_M = 200;  // 着陸時、この高さでいったん静止する(対地m)
const AP_VTOL_STOP_RADIUS_M = 120; // 着地点の真上とみなす半径(m)
const AP_VTOL_STOP_GS_MPS = 2.5; // 静止したとみなす対地速度(m/s)
const AP_VTOL_HOVER_YAW_KP = 0.02; // ホバリング中、方位のずれ1°あたりのラダー
// 空中で使っていい減速度の上限(m/s²)。0.5G。これ以上は乗っているほうが持たない。
// **実測で決めた**。サンダーバード1号（140t）を高度3000mで水平に保ったまま
// 20秒走らせると、抗力だけでは486ktでほぼ0（-0.5m/s²＝抗力長さが300km級）、
// 脚とスポイラーを足しても変わらず、逆噴射を全開にすると+10.7m/s²。
// 抗力に頼れない機体では、止まる手段は逆噴射しかない。
const AP_VTOL_BRAKE_MAX_MPS2 = 5.0;
// 逆推力がほとんど無い機体でも、抗力ぶんはあると見ておく下限(m/s²)
const AP_VTOL_BRAKE_MIN_MPS2 = 0.5;
// 見積もりに使うのは、出せるぶんの何割か。推力は速度と気圧で目減りする
// （engineThrustScale）ので、レバー一杯が机上の値どおりには出ない——実測で
// サンダーバード1号は5m/s²を指示して1.6m/s²しか出ていなかった。
// 足りないぶんは「早めに切り替える」で吸収する。
const AP_VTOL_BRAKE_PLAN_FRAC = 0.5;
const AP_VTOL_STOP_MARGIN_M = 1500; // 止まれる距離に足す余裕(m)
const AP_VTOL_STOP_MAX_M = 40000;   // 垂直着陸へ切り替えていちばん早い距離(m)
const AP_VTOL_CUT_SEC = 3;       // 接地後、垂直エンジンの出力が1/eまで落ちる秒数
const AP_VTOL_CUT_FLOOR = 0.02;  // 割合で抜くだけだと0に着かないので、足す絶対の速さ(毎秒)
// 垂直降下：対地速度がこれ以上あるうちは降りない（止まってから降ろす）。
// ここまで落ちれば、接地してブレーキを踏んでも前へ転がらない。
const AP_VTOL_DESCENT_GS_MPS = 4;
// 垂直降下：この高さから下では、ホバーの傾きを水平へ戻していく(m)
const AP_VTOL_LEVEL_AGL_M = 25;
// 垂直降下：風に逆らう傾きを、高いうちの指示からこの時定数でならして覚える（秒）。
// 傾きの上限のこの割合まで（それ以上傾けたまま降りると片脚から着く）
const AP_VTOL_WIND_TAU_SEC = 8;
const AP_VTOL_WIND_TILT_FRAC = 0.6;
// 地面すれすれ（この高さ未満）で、流されて降りられないままこれだけたったら降ろしきる
const AP_VTOL_STUCK_AGL_M = 3;
const AP_VTOL_STUCK_SEC = 8;
// 垂直着陸：これより遅くなったら駐機ブレーキを掛ける(m/s)。後ろへこれより速く転がっているうちは踏まない
const AP_VTOL_PARK_MPS = 0.3;
const AP_VTOL_SETTLE_MPS = 0.5;  // 接地したあと弾んで浮いたときの、静かな沈下率(m/s)
// --- ホバリング（その場に留まる） ---------------------------------------------
// 垂直離着陸機が空中で止まっていられるようにする。高さと場所と機首の向きを保つ。
// 手で舵を当てているあいだはその操作を通し、**離したところを新しい持ち場にする**
// ——押さえつけるだけだと、留まれても動かせない道具になってしまう。
const AP_HOVER_ALT_KP = 0.4;   // 高さのずれ1mあたりの目標昇降率(m/s)
const AP_HOVER_VS_MAX = 3;     // ホバリング中に使う昇降率の上限(m/s)
// ホバリング中に高さを上げ下げする速さ(m/s)。保つ輪の昇降率の上限（3m/s）より少しだけ
// 遅くしておく——速くすると目標だけが先へ逃げていき、離したあと追いつくまで上がり続ける。
const AP_HOVER_ADJ_MPS = 2.5;
// 地面からこれより下へは目標を下げない（着地はホバリングではなく垂直レバーか垂直着陸で）
const AP_HOVER_MIN_AGL_M = 3;
// **止まるまでは持ち場を追いかけない**。押した場所へ戻ろうとすると、進入速度の
// まま入ったときに何kmも行き過ぎてから引き返すことになり、傾きの上限（10°）に
// 張り付いたまま行ったり来たりを繰り返す——実測でサンダーバード1号を300ktで
// ホバリングに入れると、8.5km先まで流れてから戻り、150秒たっても77ktで
// 振り子のように往復していた。まず止まる。止まったところが持ち場。
const AP_HOVER_CAPTURE_MPS = 4;
const AP_VTOL_TILT_MAX = 10;     // ホバー中、水平移動のために傾ける角度の上限(°)
const AP_VTOL_POS_KP = 0.08;     // 着地点までの距離1mあたり、何度傾けるか
const AP_VTOL_VEL_KD = 1.6;
// ホバリングの傾きを、水平方向の加速度でも減衰させる（apVtolHoverAngles 参照）。
// 10 で TB2 の振れが18.8kt→9.2kt、TB1 は0ktのまま。25 以上にすると
// TB1 のほうが振れはじめるので、両方が穏やかになるところを採った。
const AP_VTOL_HOVER_ACCEL_KD = 10;
const AP_VTOL_HOVER_ACCEL_TAU = 0.55; // 加速度の測り方をならす時定数(秒)      // 水平方向の速度1m/sあたり、何度戻すか

// ホバリングに要るレバーの位置（重さ ÷ 垂直エンジンの推力）。
// 機体ごとに桁が違う——実測でサンダーバード1号は約36%、2号は約6%。
function apVtolHoverLever(model) {
  if (!(model.vtolThrustN > 0)) return 0;
  return apClamp((model.massKg * 9.80665) / model.vtolThrustN, 0, 1);
}

// 垂直着陸の進入で使う逆噴射。**残りの距離で止まるのに要るぶんだけ**出す。
// 着陸滑走で使う apReverseCommand は「3m/s²ぶん」の決め打ちで、それだと
// サンダーバード1号は 486kt から17kmかけても 334kt までしか落ちなかった
// （実測。抗力がほぼ無い機体なので、頼れるのは逆噴射だけ）。
//   要る減速度 a = (v² - 目標v²) / (2 · 残り距離)
// を出して、0.5G（AP_VTOL_BRAKE_MAX_MPS2）で頭打ちにする。
function apVtolBrakeCommand(model, controls, state, distM, wantVMps) {
  const revN = apReverseThrustAvailN(model, controls);
  if (!(revN > 0)) return 0;
  const v = state.airspeed;
  if (v <= wantVMps) return 0;
  const need = (v * v - wantVMps * wantVMps) / (2 * Math.max(distM, 1));
  const a = apClamp(need, 0, AP_VTOL_BRAKE_MAX_MPS2);
  return apClamp((model.massKg * a) / revN, 0, 1)
    * apClamp(v / AP_REVERSE_FADE_MPS, 0, 1);
}

// 空中で止まるのに見込める減速度(m/s²)。切り替える距離と目標速度の両方に使う。
// **回っている群の逆推力から出す**——機体ごとに桁が違うので、決め打ちにすると
// 片方は止まれず、もう片方は何十kmも手前から這うことになる。
function apVtolBrakeDecel(model, controls) {
  const revN = apReverseThrustAvailN(model, controls);
  return apClamp(revN / Math.max(model.massKg, 1),
    AP_VTOL_BRAKE_MIN_MPS2, AP_VTOL_BRAKE_MAX_MPS2) * AP_VTOL_BRAKE_PLAN_FRAC;
}

// --- 垂直着陸：着地点までの距離で、前後の速さを追う（進入・ホバリング共通） -------------
//
// **進入のあいだにしっかり減速し、遅すぎたらメインエンジンでゆっくり前へ出る**。
// 以前は、進入の段は逆噴射を見積もりから決め打ち（開ループ）で当てていたので、速さによる
// 推力の落ち方やアイドルの押しが入らず、計画の半分ほどしか減速しなかった（実測でTB1新は
// 計画2.4m/s²に対して1.3m/s²）。失速の0.9倍でホバリングに渡ったときには、着地点の1〜1.7km手前で
// まだ250kt出ていて、ホバリングは前進エンジンを切って傾きだけで寄せるので、着地点を494〜1,560m
// 通り過ぎてから、機首を上げて垂直エンジンで戻っていた（TB1 はホバリングに131秒）。
// いまは、進入でもホバリングでも「残りの距離で止まりきれる速さ」
//   v = √(2 · 減速度 · (残り距離 − 着地点の上とみなす半径の半分))
// を目標にして、速すぎれば逆噴射、遅すぎればメインエンジンで押す（比例＋積分。見積もりがずれても
// 追いつく）。前進は AP_VTOL_CREEP_ACCEL まで、止まるのも同じ減速度で計画する。
const AP_VTOL_SPEED_TAU = 2;        // 速さのずれを詰める時定数(秒)
const AP_VTOL_SPEED_KI = 0.3;       // 速さのずれ1m/sが1秒続くと足す加速度(m/s²)
const AP_VTOL_CREEP_ACCEL = 1.5;    // メインエンジンで前へ出すときの加速度の上限(m/s²)
const AP_VTOL_CREEP_MAX_MPS = 40;   // ホバリングで前へ出す速さの上限(m/s ≒ 78kt)
const AP_VTOL_FINE_M = 25;          // ここまで寄ったら、機体を傾けて合わせる（前後のエンジンは使わない）
const AP_VTOL_FACE_DEG = 40;        // 遠いとき、着地点の方位と機首のずれがこれ以内でだけメインエンジンで押す
const AP_VTOL_TURN_TO_PAD_M = 300;  // これより遠ければ、機首を着地点へ回す（近ければ機首はそのまま、前後で寄せる）
const AP_VTOL_BACK_MAX_MPS = 5;     // 通り過ぎたとき、機首上げで後ろへ戻る速さの上限(m/s)
// extraDecel：逆噴射のほかに見込める減速度（ホバリングで機首を上げて推力を後ろへ傾けるぶん）。
// stopAtM：止まりきる点（着地点からの距離）。ホバリングでは、傾けて合わせる範囲（AP_VTOL_FINE_M）の
// 入口で歩くくらいの速さになるように、その少し内側で止まる計画にする。入口へ7m/sのまま入ると、
// 傾けて止めきれずに着地点を越えて行き来し、止まるまで30秒近くかかった（検証の垂直離着陸機）
function apVtolPadSpeed(model, controls, distM, extraDecel, stopAtM) {
  const a = apVtolBrakeDecel(model, controls) + (extraDecel || 0) * AP_VTOL_BRAKE_PLAN_FRAC;
  const stopAt = stopAtM === undefined ? AP_VTOL_STOP_RADIUS_M * 0.5 : stopAtM;
  return Math.sqrt(2 * a * Math.max(distM - stopAt, 0));
}
// 前後の速さ vAlong（着地点へ向かう向きが＋）を vWant へ寄せる出力と逆噴射。controls に書く
function apVtolAlongSpeed(model, state, controls, ap, vWant, vAlong, dt) {
  const err = vWant - vAlong;
  ap.vtolAccI = apClamp((ap.vtolAccI || 0) + err * AP_VTOL_SPEED_KI * dt, -AP_VTOL_BRAKE_MAX_MPS2, AP_VTOL_CREEP_ACCEL);
  const accel = apClamp(err / AP_VTOL_SPEED_TAU + ap.vtolAccI, -AP_VTOL_BRAKE_MAX_MPS2, AP_VTOL_CREEP_ACCEL);
  // 要る推力（抗力のぶんを足す）。＋ならメインエンジン、−なら逆噴射
  const v = Math.max(state.airspeed, 0);
  const force = model.massKg * accel + apDragEstimateN(model, v, state.altitudeM);
  if (force > 0 && accel > 0) {
    controls.throttle = apLeverForThrustN(model, controls, force, v, state.altitudeM);
    controls.reverse = 0;
  } else {
    controls.throttle = 0;
    const revN = apReverseThrustAvailN(model, controls);
    // 逆噴射は前へ動いているあいだしか効かない（10-flight.js の revLever）
    controls.reverse = revN > 0 && vAlong > 0.5 ? apClamp(model.massKg * -accel / revN, 0, 1) : 0;
  }
  // 逆噴射で出しきれない減速度（ホバリングでは、そのぶん機首を上げて推力を後ろへ傾ける）
  const revA = vAlong > 0.5 ? apReverseThrustAvailN(model, controls) / Math.max(model.massKg, 1) : 0;
  return { accel, brakeShort: accel < 0 ? Math.max(-accel - revA, 0) : 0 };
}

// 減速しながらの進入で、**翼が支えきれなくなるぶんを垂直エンジンに移す**。
// 揚力は速度の2乗で効くので、失速速度の1.2倍を下回ったところから
// (1 - (v/1.2Vs)²) ぶんの重さが宙に浮く。昇降率の輪（apVtolThrottleForVs）
// だけに任せると、沈みはじめてから初めて出力が上がる＝必ず一度落ちるので、
// 「要るぶん」を下限として先に回しておく。上回るぶんは輪が受け持つ。
function apVtolSupport(model, state, controls, ap, spd, wantVs, dt) {
  const fb = apVtolThrottleForVs(controls, state.verticalSpeed, wantVs, dt, ap);
  const wing = apClamp(state.airspeed / Math.max(spd.stall * 1.2, 1), 0, 1);
  let floor = apVtolHoverLever(model) * (1 - wing * wing);
  // **狙いより上がっているあいだは、下限を外していく**。翼の揚力は見積もり（失速の1.2倍で全部）より
  // 残っていることが多く、下限のぶん垂直エンジンを回し続けると上がっていく——実測（検証の
  // 垂直離着陸機）で、ホバリングの高さ（対地200m）を保つはずが650mまで上がり、そこから降りるのに
  // 何十秒もかかっていた。狙いより1m/s上がったところから、3m/sで下限を0にする。
  const over = state.verticalSpeed - wantVs - 1;
  if (over > 0) floor *= apClamp(1 - over / 3, 0, 1);
  return apClamp(Math.max(fb, floor), 0, 1);
}

// 垂直エンジンの出力を、目標の昇降率へ少しずつ近づける（apThrottleForSpeedと同じ形）
function apVtolThrottleForVs(controls, currentVs, targetVs, dt, ap) {
  const err = targetVs - currentVs;
  // いまの上下の加速度を、昇降率の差分から測ってならす（AP_VTOL_VS_KDの説明を参照）。
  let accel = 0;
  if (ap) {
    if (ap.vtolLastVs !== undefined && dt > 0) {
      const raw = (currentVs - ap.vtolLastVs) / dt;
      const k = apClamp(dt / AP_VTOL_ACCEL_TAU, 0, 1);
      ap.vtolAccel = (ap.vtolAccel || 0) + (raw - (ap.vtolAccel || 0)) * k;
    }
    ap.vtolLastVs = currentVs;
    accel = ap.vtolAccel || 0;
  }
  return apClamp((controls.vtolThrottle || 0)
    + (err * AP_VTOL_VS_KP - accel * AP_VTOL_VS_KD) * dt, 0, 1);
}

// ホバー中に目標地点（世界座標）へ寄せるための、目標ピッチ角・バンク角。
// 前へ進むエンジンとは無関係に、姿勢を少し崩して水平方向の推力成分を作る——
// 実機のVTOL機と同じで、機首を下げれば前へ、右へ傾ければ右へ進む
// （実測して符号を決めてある。ピッチは上げるほど後ろへ、ロールは
// 右へ倒すほど右へ動く）。位置の誤差と速度の誤差、両方を見て収束させる。
function apVtolHoverAngles(state, targetX, targetZ, tiltMaxDeg, ap) {
  const tiltMax = tiltMaxDeg === undefined ? AP_VTOL_TILT_MAX : tiltMaxDeg;
  const fwd = apForward(state.headingDeg), right = apRight(state.headingDeg);
  const dx = targetX - state.position.x, dz = targetZ - state.position.z;
  const along = dx * fwd.x + dz * fwd.z;   // +なら目標は前方
  const cross = dx * right.x + dz * right.z; // +なら目標は右
  const vAlong = state.velocity.x * fwd.x + state.velocity.z * fwd.z;
  const vCross = state.velocity.x * right.x + state.velocity.z * right.z;
  // **水平方向の加速度でも減衰させる**。位置と速度だけだと、指示した傾きに
  // 機体の姿勢が追いつくまでの遅れぶんだけ位相が回り、止まっていられない
  // ——実測でサンダーバード2号がその場ホバリング中に対地18.8ktまで
  // 行ったり来たりしていた（傾き指示が±11°で往復）。もう減速しているなら
  // それ以上傾けない、という項を足すと9.2ktまで収まる。
  // サンダーバード1号（推力が大きく姿勢がすぐ追いつく）は元から0ktで、
  // ここを強くしすぎると逆に振れるので、実測でいちばん穏やかな値を選んだ。
  let aAlong = 0, aCross = 0;
  if (ap) {
    if (ap.hovLastVA !== undefined) {
      const k = 1 - Math.exp(-1 / (AP_VTOL_HOVER_ACCEL_TAU * 60));
      ap.hovAccelA = (ap.hovAccelA || 0) + ((vAlong - ap.hovLastVA) * 60 - (ap.hovAccelA || 0)) * k;
      ap.hovAccelC = (ap.hovAccelC || 0) + ((vCross - ap.hovLastVC) * 60 - (ap.hovAccelC || 0)) * k;
    }
    ap.hovLastVA = vAlong; ap.hovLastVC = vCross;
    aAlong = ap.hovAccelA || 0; aCross = ap.hovAccelC || 0;
  }
  const pitchTilt = apClamp(along * AP_VTOL_POS_KP - vAlong * AP_VTOL_VEL_KD
    - aAlong * AP_VTOL_HOVER_ACCEL_KD, -tiltMax, tiltMax);
  const bankTilt = apClamp(cross * AP_VTOL_POS_KP - vCross * AP_VTOL_VEL_KD
    - aCross * AP_VTOL_HOVER_ACCEL_KD, -tiltMax, tiltMax);
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
// **どこまで先を見るかは「登るのに要る距離」で決める**。
// 秒数（速度×120秒）だけで決めていたので、遅い機体は下限の10kmしか見ておらず、
// そこから登りはじめても間に合わなかった——実測で、内蔵の練習機（上昇率3.9m/s・
// 巡航70m/s）が標高2500mの尾根を10km手前で見つけ、1300m登るのに要る23kmには
// まったく足りず、尾根の斜面に対地2mで突っ込んでいた。
// この世界の最高標高は4780.7m（アストラ大山脈）。そこまで登れる距離を丸ごと
// 見ようとすると遅い機体で先読みが長くなりすぎるので、ここは「たいていの尾根に
// 間に合う分」に留め、越えられない山は下の「よけて回る」に任せる。
const AP_TERRAIN_CLIMB_RESERVE_M = 2500;
// 前方を見る刻み(m)。**細かさは山の細さで決まる**——この世界で標高2500mを
// 超える区間は 386本あり、中央値1,200m・最短100m。細い尾根は刻みが粗いと
// 山頂をまたいで見落とす。60km先まで300m刻みで200点、1点あたり0.9μs
// （worldHeightAt）なので、0.25秒に1回の測り直しで0.6msほど。十分安い。
const AP_TERRAIN_SAMPLE_STEP_M = 300;
const AP_TERRAIN_SAMPLES_MAX = 200;   // 前方を何点まで見るか
// **越えられない山は、よけて回る**。
// 地形回避はこれまで「登って越える」しか持っていなかったので、機体の上昇力で
// 越えきれない山にはそのまま突っ込んでいた——実測で、内蔵の練習機（上昇率
// 3.2m/s）が25km先の標高2500mの尾根に対地1mで、Boeing 747が12km先の
// 標高3800mの山に対地-11m（＝めり込む）で当たっていた。どちらも、
// あの距離であの高さは物理的に登りきれない（練習機は25kmで2100mしか
// 稼げないのに2800m要る）。実機なら旋回して回り込むか、そもそも越えない。
// 目的地の方位から左右に振って、越えられる向きがあればそちらへ寄せる。
const AP_TERRAIN_DODGE_MAX_DEG = 75;   // よけるのに使っていい最大の振り角
const AP_TERRAIN_DODGE_STEP_DEG = 15;  // 何度刻みで試すか
// よける向きを探す走査は粗くていい（「こっちは壁か」を見たいだけ）。
// 11方向×40点で440点、0.25秒に1回なので、まっすぐ見る走査より安い。
const AP_TERRAIN_DODGE_SAMPLES = 40;
// **空港の近くではよけない**。進入と着陸は滑走路へ向かうしかないので、そこで
// 「山があるから曲がる」を許すと帰ってこられない——実測でBoeing 747が
// 進入とやり直しのあいだ3300秒（飛行時間の2/3）ずっと75°よけ続け、
// 一度も着陸できなかった。近くの地面は余裕を細らせる（AP_TERRAIN_TAPER_M）
// ほうで面倒を見る。
const AP_TERRAIN_DODGE_MIN_DIST_M = 20000;
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
// 指定の向きに沿って前方の地面を見る。apTerrainFloor の中身であり、
// 「よけて回る向き」を探すとき（apTerrainDodgeDeg）にも同じものを使う。
//
// i=0（真下、d=0）も見る。前方サンプルは AP_TERRAIN_SAMPLE_STEP_M 刻み
// （300m前後）なので、越えている地形の残りがその刻み幅より短くなると
// 前方サンプルが全部その先の平地を拾ってしまい、まだ真下・すぐ先に
// 残っている地形を見失う——実測で幅4kmの尾根の終端付近（残り400m）で
// floorM が数フレームで300m台からマイナスへ落ち、対地0mまで沈んでいた。
// 真下を毎回混ぜておけば、地形の上にいるあいだは floorM が地形の高さを
// 下回らない。d=0 は vsNeed（d/v で割る）には使わない——真下のぶんは
// 「これから何秒で着くか」という話ではないので馴染まない。
function apTerrainScan(state, gh, dir, clearanceM, up, look, samples) {
  const v = Math.max(state.airspeed, 1);
  let floorM = -Infinity, vsNeed = -Infinity, maxGroundAhead = -Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = look * i / samples;
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
  return { floorM, vsNeed, maxGroundAhead };
}

function apTerrainFloor(state, env, clearanceM, spd, maxLookM) {
  // vsNeed の「制限なし」は 0 ではなく -Infinity。0 にすると
  // Math.max(降下率, 0) になって、降下そのものを止めてしまう。
  const none = { floorM: -Infinity, vsNeed: -Infinity, rising: false };
  const gh = env && env.groundHeightAt;
  if (typeof gh !== 'function') return none;
  const v = Math.max(state.airspeed, 1);
  // 進んでいる向き（航跡）で見る。横風で機首とずれていても、実際に行く先は航跡のほう。
  const dir = apForward(apGroundTrackDeg(state));
  const up = Math.max(apVsLimits(state, spd).up * AP_TERRAIN_CLIMB_MARGIN, 0.1);
  // 登るのに要る距離（AP_TERRAIN_CLIMB_RESERVE_M の説明を参照）と、
  // 秒数で決めた距離の、長いほう。
  let look = apClamp(Math.max(v * AP_TERRAIN_LOOKAHEAD_SEC,
    v * (AP_TERRAIN_CLIMB_RESERVE_M / up)),
    AP_TERRAIN_LOOKAHEAD_MIN_M, AP_TERRAIN_LOOKAHEAD_MAX_M);
  // **目的地より先は見ない**。遠くまで見るようにしたぶん、着陸する空港の
  // 向こう側にある山まで「越えるべきもの」に数えてしまう——そこへは行かない。
  if (maxLookM > 0) look = Math.min(look, maxLookM);
  const samples = Math.round(apClamp(look / AP_TERRAIN_SAMPLE_STEP_M,
    24, AP_TERRAIN_SAMPLES_MAX));
  const scan = apTerrainScan(state, gh, dir, clearanceM, up, look, samples);
  const { floorM, vsNeed, maxGroundAhead } = scan;
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
    rising ? apTerrainEscapeVs(state, spd) : apVsLimits(state, spd).up);
  // **上がれと言うときだけ効かせる**。vsNeed は「前方の地面を越えるのに要る
  // 上昇率」で、下限として使われる（Math.max(指示, vsNeed)）。ところが地面が
  // 自分より下にあると、これは「これ以上速く降りるな」という上限に化ける——
  // 平らな地面の上でさえ、120秒先の地面＋余裕へ向かう緩い降下率が上限になり、
  // 実測でBoeing 747の降下が -19m/s 出せるところを -9.3m/s に抑えられて、
  // 進入開始で経路より580m高いところに入っていた。地面より高いところに
  // いるあいだは、そもそも越えるべきものが無い。
  return { floorM, vsNeed: need > 0 ? need : -Infinity, rising, rawVsNeed: vsNeed, lookM: look };
}

// 測り直しは AP_TERRAIN_REFRESH_SEC ごと（地面の高さを引くのは安くない）。
// 空港へ近づくぶんだけ余裕を細らせる（AP_TERRAIN_TAPER_M のコメント参照）。
// 越えられる向きを探す。返すのは「目的地の方位から何度ずらすか」。
// 越えられる向きが無ければ、いちばん楽な向きを返す。
function apTerrainDodgeDeg(state, ap, env, wantHeadingDeg, clearanceM, spd, look, samples) {
  const gh = env && env.groundHeightAt;
  if (typeof gh !== 'function' || !(wantHeadingDeg >= -720)) return 0;
  const up = Math.max(apVsLimits(state, spd).up * AP_TERRAIN_CLIMB_MARGIN, 0.1);
  const prev = ap.terrainDodgeDeg || 0;
  let bestDeg = 0, bestNeed = Infinity;
  for (let a = 0; a <= AP_TERRAIN_DODGE_MAX_DEG; a += AP_TERRAIN_DODGE_STEP_DEG) {
    // **前に選んだ側を先に試す**。毎回左右を選び直すと、山の手前で
    // 右へ左へ振り続けてどちらへも進まなくなる。
    const order = a === 0 ? [0] : (prev < 0 ? [-a, a] : [a, -a]);
    for (const off of order) {
      const dir = apForward(wantHeadingDeg + off);
      const r = apTerrainScan(state, gh, dir, clearanceM, up, look, samples);
      if (r.vsNeed <= up) return off; // この向きなら登って越えられる
      if (r.vsNeed < bestNeed) { bestNeed = r.vsNeed; bestDeg = off; }
    }
  }
  return bestDeg;
}

function apUpdateTerrainFloor(state, ap, env, dt, distToGoM, spd, wantHeadingDeg) {
  ap.terrainClock = (ap.terrainClock || 0) + dt;
  if (ap.terrainFloorM === undefined || ap.terrainClock >= AP_TERRAIN_REFRESH_SEC) {
    ap.terrainClock = 0;
    const taper = distToGoM === undefined ? 1
      : apClamp(distToGoM / AP_TERRAIN_TAPER_M, 0, 1);
    const clearance = AP_TERRAIN_CLEARANCE_M * taper;
    const r = apTerrainFloor(state, env, clearance, spd, distToGoM);
    ap.terrainFloorM = r.floorM;
    ap.terrainVsNeed = r.vsNeed;
    ap.terrainRising = r.rising;
    // まっすぐでは越えられないときだけ、よける向きを探す（ふだんはただ）。
    // r.vsNeed は出せる範囲に丸めたあとの値なので、丸める前の生の要求
    // （r.rawVsNeed）で「間に合っていない」を判定する。
    const up = Math.max(apVsLimits(state, spd).up * AP_TERRAIN_CLIMB_MARGIN, 0.1);
    const farEnough = distToGoM === undefined || distToGoM > AP_TERRAIN_DODGE_MIN_DIST_M;
    ap.terrainDodgeDeg = (farEnough && wantHeadingDeg !== undefined && r.rawVsNeed > up)
      ? apTerrainDodgeDeg(state, ap, env, wantHeadingDeg, clearance, spd,
        r.lookM, AP_TERRAIN_DODGE_SAMPLES)
      : 0;
  }
  return {
    floorM: ap.terrainFloorM, vsNeed: ap.terrainVsNeed,
    rising: !!ap.terrainRising, dodgeDeg: ap.terrainDodgeDeg || 0,
  };
}

// --- 低いところでは深く傾けない -------------------------------------------------
//
// 離陸してすぐ、対地高度が数十mのうちに目的地の方位へ倒し込むと、傾けたぶん
// 揚力の上向き成分が減って沈み、そのまま地面に触る。実機でも離陸直後は
// 高度が取れるまで傾けない（そのあと段階的に深くしていく）。
// 進入・引き起こしはこの制限を掛けない——あちらは滑走路の中心線に乗せるための
// 浅いバンク（8°）で、低いところで効かなくなると逆に降りられなくなる。
// 離陸のあと、滑走路の向きのまま登る高さ（目標高度の何割か・下限・上限）と、
// そこから何倍の高さまでに旋回の上限を戻すか（nav の説明）
const AP_TAKEOFF_TURN_FRAC = 0.4;
const AP_TAKEOFF_TURN_MIN_M = 450;
const AP_TAKEOFF_TURN_MAX_M = 1500;
const AP_TAKEOFF_TURN_RAMP = 1.6;
// **待つ高さは「出発した地面から上がった高さ」で測り、目標高度まで上がる高さの半分を超えない**。
// 対地高度で測っていたので、標高1,200mの空港から目標1,500mへ飛ぶと対地は300mにしかならず、
// 待つ高さ（下限450m）に一生届かないまま、離陸の向きでまっすぐ飛び続けた（練習機・747・TB1新、
// 垂直離陸でも。山の上を飛んで対地高度が小さいときも同じ）。
const AP_TAKEOFF_TURN_SPAN_MAX = 0.5;
// **浮いてから一定の時間がたったら、高さに届かなくても旋回を許す**。上昇の遅い機体は待つ高さまで
// 何分もかかる（練習機は標高0mから目標3,000mで、目的地へ向くまで448秒まっすぐ飛んでいた）。
const AP_TAKEOFF_TURN_WAIT_S = 45;   // 浮いてからこれだけは、高さで決める
const AP_TAKEOFF_TURN_RAMP_S = 30;   // そこからこの秒数で旋回の上限を戻しきる
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
// --- 指示より速く沈んでいるときは傾きを戻す -----------------------------------------
//
// 深く傾けるほど揚力の上向きの成分が減り（85°で cos=0.09）、姿勢の輪が追いつかない
// 機体はそのまま沈む。沈みはじめても傾きを保ったままだと、上向きの成分が戻らない。
// 実測でサンダーバード1号が、対地4900mで85°のまま向きを変え続けるうちに
// 機首-9°・毎秒-328mまで沈み、40秒後に地面に突っ込んだ。
// 地面接近警報の回復操作と同じく、指示した昇降率より速く沈んでいるぶんだけ翼を戻す。
// 指示どおりに降りている（降下・進入）ぶんには効かない。
const AP_BANK_SINK_FROM_MPS = 15;   // 指示よりこれだけ速く沈んだら戻しはじめ
const AP_BANK_SINK_SPAN_MPS = 45;   // さらにこれだけ速ければ AP_BANK_SINK_MIN まで
const AP_BANK_SINK_MIN = 0.25;
function apBankSinkFactor(state, ap) {
  const cmd = ap && Number.isFinite(ap.vsCmd) ? ap.vsCmd : 0;
  const excess = cmd - state.verticalSpeed;
  return apClamp(1 - (excess - AP_BANK_SINK_FROM_MPS) / AP_BANK_SINK_SPAN_MPS * (1 - AP_BANK_SINK_MIN),
    AP_BANK_SINK_MIN, 1);
}

// 逆に、**指示より速く上がっている**ときも翼を戻す。上がりすぎを止めるには機首を押す（負のG）しかなく、
// 深く傾けたまま押すと、押した力が横向きに働いて**曲がりたい向きと逆へ**回ってしまう。
// 実測でTB1が上昇の段から巡航へ渡った直後（マッハ3で毎秒120m上昇中）に右へ69°倒したまま-4.5Gで押し、
// 方位が2°→339°と左へ23°回ってから戻ってきた。沈むときと同じ幅で戻す。
function apBankRiseFactor(state, ap) {
  const cmd = ap && Number.isFinite(ap.vsCmd) ? ap.vsCmd : 0;
  const excess = state.verticalSpeed - cmd;
  return apClamp(1 - (excess - AP_BANK_SINK_FROM_MPS) / AP_BANK_SINK_SPAN_MPS * (1 - AP_BANK_SINK_MIN),
    AP_BANK_SINK_MIN, 1);
}

function apBankClimbFactor(state, vsNeededMps, spd) {
  if (!(vsNeededMps > 0)) return 1;
  const up = Math.max(apVsLimits(state, spd).up, 0.1);
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
// 経路より高くて出力を切っているとき、失速速度のこの倍を下回ったら出力を戻す。
// 1.15 は引き起こし（機首上げ）に要る速度の目安と同じ。
const AP_APPROACH_MIN_STALL = 1.15;
// 進入でフラップを全開にする残り距離(m)と、そこまでに増やしていく幅(m)。
const AP_FLAP_FULL_M = 2500;
const AP_FLAP_RAMP_M = 5000;
// 機首下げのトリムがここまで来たら「張り付いている」と見なし、フラップを戻す
// 昇降率→ピッチの指示を、ピッチ角速度で減衰させる量。実測で決めた——
// 0だとTB2の接地が28.4G、2で11.2Gまで落ちる（直す前の16.1Gより柔らかい）。
// 4まで上げると今度は行き過ぎて19.4Gに戻る。
const AP_PITCH_VS_KD = 2;
const AP_FLARE_PITCH_MAX = 10;  // 引き起こしで許す機首上げの上限(°)
// 着陸滑走で跳ねて浮いたときに狙う機首上げ(°)。0にすると前輪から突っ込む
const AP_ROLLOUT_PITCH_DEG = 5;
const AP_TAIL_BRAKE_MARGIN_DEG = 3;  // 尾輪式：駐機姿勢からこれより下がったらブレーキを緩めはじめる(°)
const AP_DECRAB_AGL_M = 4;         // この高さより下で、機首を滑走路の向きに合わせる
const AP_FLARE_CROSS_KP = 0.15;    // 引き起こし中、中心線からのずれ1mあたりの寄せ角(°)
const AP_FLAP_TRIM_PIN = 0.9;
const AP_FLAP_BACK_RATE = 0.05; // 戻す／また下ろす速さ（毎秒）
const AP_FLAP_BACK_MIN = 0.3;   // これ以上は戻さない
const AP_FLAP_STALL_GAIN = 0.20; // フラップ全開で失速速度がこの割合下がる
// 「高いから絞る」を効かせきるまでの幅(m)。AP_HIGH_ON_PATH_M から始めて、
// これだけ高くなったら絞りきる。
const AP_HIGH_ON_PATH_BAND = 60;
// 降下中、抗力だけでどれくらい減速できるとみなすか(m/s²)。
// 進入速度まで落としきるのに要る距離の見積もりに使う（降下の段を参照）。
// 出力を絞って降りているときに見込める減速度(m/s²)。
// **降りるぶんだけ位置エネルギーが速度に変わる**ので、水平飛行で測った抗力の
// ぶんからそれを引いた値でないと足りない——実測でBoeing 747は水平・脚上げで
// 1.31m/s²、2.86°の降下ではそこから g·sin2.86°=0.49 を引いて0.8ほどしか残らない。
// 1.5 のままだと「まだ落とさなくていい」と判断して減速を先送りし、
// 進入開始に244kt（進入速度168kt）で入って、やり直しを26回繰り返していた。
const AP_DECEL_MPS2 = 0.7;
// 抗力で落とせる速さの見積もり（apSlowableSpeed）。
// 以前は「残り距離の半分で落とせる速さ」にしていたので、
// 目標速度が**抗力の半分の速さでしか下がらず**、そのぶん早くから・長く減速していた
// ——TB1が高度3000mのマッハ9.4から、残り1,000kmで減速を始め、出力5〜19%を残したまま
// 何百kmもかけて落としていた（抗力だけで落とせば395km）。
// いまは「抗力の 1/AP_DECEL_DRAG_MARGIN の速さで落とす」＋「最後に AP_DECEL_MARGIN_M の余裕」。
const AP_DECEL_DRAG_MARGIN = 1.2;
const AP_DECEL_MARGIN_M = 20000;
function apSlowableSpeed(vEndMps, distM, dragLengthM) {
  if (!(dragLengthM > 0)) return Infinity;
  const d = Math.max(distM - AP_DECEL_MARGIN_M, 0);
  return vEndMps * Math.exp(Math.min(d / (dragLengthM * AP_DECEL_DRAG_MARGIN), 50));
}

// --- 減速装置（スポイラー・逆噴射） ---------------------------------------------
//
// どちらも実機の進入と着陸でいちばん頼る減速手段なのに、自動操縦はこれまで
// 「出力を絞る」「脚を出す」「フラップを下ろす」しか持っていなかった。そのせいで
// 降りることと減速することが姿勢ひとつの取り合いになり、推力の大きい機体は
// 進入までに落としきれずにやり直しを繰り返していた。
//
// **どちらも割合で効かせる**。0か1で切り替えると60Hzで往復して平均50%の
// 中途半端な効きになる（この自動操縦で何度も踏んだ失敗）。
const AP_SPOILER_OVERSPEED = 0.06; // 目標速度をこの割合こえたら全開
const AP_SPOILER_PATH_M = 120;     // 経路をこれだけ上回ったら全開(m)
const AP_SPOILER_THR_GATE = 0.25;  // 出力がこれ以上入っていたら立てない
// 逆噴射で足す減速度の目安(m/s²)。推力が桁外れな機体（推力重量比300超の
// フィクション機がある）にレバーを一杯まで入れさせると、逆向きに10Gが掛かって
// 機体を裏返す。「止まるのに要るぶんだけ」出すよう、力ではなく減速度で決める。
const AP_REVERSE_DECEL_MPS2 = 3.0;
const AP_REVERSE_FADE_MPS = 8;     // これより遅くなったらレバーを戻す(m/s)
// 滑走路の残りが分かるときは、そこで止まるのに要る減速度（の AP_REVERSE_NEED_MARGIN 倍）まで
// 上げる（上限 AP_REVERSE_DECEL_MAX_MPS2）。一定の3m/s²だと、逆推力の大きいサンダーバード1号は
// レバー10%で済む計算になり、337ktで接地して3000mの滑走路を760m走り越した。
const AP_REVERSE_DECEL_MAX_MPS2 = 6.0;
const AP_REVERSE_NEED_MARGIN = 1.2;
const AP_REVERSE_STOP_MARGIN_M = 150; // 滑走路の端のこれだけ手前で止まるつもりで見積もる

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
//
const AP_GAIN_REF_STALLS = 4;
// **絞るのにも下限が要る**。v²で割り続けると、超高速機では舵がまったく
// 使えなくなる。実測でサンダーバード1号（巡航4116kt／失速279kt＝14.8倍）の
// 倍率は0.073で、毎秒24m落ちているのにエレベーターは0.02しか当たらず、
// 6秒で198m沈んでなお降下中だった——「落ち始めてるのにエレベーターを
// 効かせようとしない」というのがこれ。
//
// 下限は**失速の8倍の機体に与えるぶん**（(4/8)²＝0.25）に置く。それより
// 速い機体も、そこまでは舵を使える。基準そのものを上げる手もあるが、
// それだと失速の4〜10倍で飛ぶ機体（Boeing 747は4.2倍）のゲインまで
// 上がってしまい、マッハ2の試験機で符号反転が41回/18秒に戻った。
// 実測（下限を入れる前→後、毎秒24m落ちている状態から高度維持）：
//   6秒後の高度ずれ  -198m → -16m ／ プルプル試験 符号反転 0回→1回/18秒・
//   最大ピッチ角速度 0.01→0.00 rad/s（暴れは戻っていない）
const AP_GAIN_FLOOR = 0.25;

function apSurfaceGain(state, spd) {
  if (!spd || !spd.stall) return 1;
  const ref = spd.stall * AP_GAIN_REF_STALLS;
  const v = Math.max(state.airspeed, 1);
  if (v <= ref) return 1;
  const r = ref / v;
  return Math.max(r * r, AP_GAIN_FLOOR);
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
  // 指示そのものが動いている速さ(rad/s)。減衰は実際の回転だけでなく「指示の回転とのずれ」にも
  // 掛ける——実際の回転だけに掛けると、自分で指示した姿勢変化まで押しとどめてしまう。
  // AP_PITCH_KD を上げたとき、引き起こしで機首が指示から3°遅れたまま接地し、
  // サンダーバード新型の接地が-300fpmから-550fpmへ荒くなった。全部を見込むと
  // （AP_PITCH_RATE_FF=1）、こんどは練習機の接地が-369fpmから-568fpmへ荒れた。
  let cmdRate = 0;
  if (ap && dt > 0) {
    const prev = ap.pitchCmdDeg === undefined ? state.pitchDeg : ap.pitchCmdDeg;
    const step = apPitchRateLimit(state) * dt;
    want = apClamp(want, prev - step, prev + step);
    // 機体が付いてこられないときに指示だけ先へ行ってしまわないように
    want = apClamp(want, state.pitchDeg - AP_PITCH_LEAD_DEG, state.pitchDeg + AP_PITCH_LEAD_DEG);
    // 指示の速さはならしてから使う。刻みごとの差分をそのまま使うと、指示が折れ曲がるたびに
    // 舵が跳ねる（実測で練習機の引き起こしの最後に舵が-0.7⇔+1.0と振れ、接地-369→-466fpm）。
    const raw = ((want - prev) / dt) * Math.PI / 180;
    ap.pitchCmdRate = (ap.pitchCmdRate || 0)
      + (raw - (ap.pitchCmdRate || 0)) * apClamp(dt / AP_PITCH_RATE_FF_TAU, 0, 1);
    cmdRate = ap.pitchCmdRate;
    ap.pitchCmdDeg = want;
  }
  const g = apSurfaceGain(state, spd);
  // pd：比例と減衰だけのぶん。トリムと積分（ap.pitchI）はこれで動かす——出した舵（積分込み）で
  // 動かすと、積分が自分自身を積み増して、ずれが無くなっても増え続ける。
  const pd = apClamp(((want - state.pitchDeg) * AP_PITCH_KP
    + (cmdRate * AP_PITCH_RATE_FF - state.angularVelocity.x) * apPitchKd(state, spd)) * g, -1, 1);
  const cmd = apClamp(pd + (ap && ap.pitchI ? ap.pitchI : 0), -1, 1);
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
  // **舵を振り切っていても、姿勢が指示から離れていく向きに動いているなら積む**。
  // 振り切っているあいだは積まないようにしていたが、舵だけでは止めきれない機首上げ
  // （Boeing 747の引き起こし直後）では、振り切ったままトリムも固まり、そのまま
  // ピッチ80°まで上がって失速した（実測、横風8m/sの離陸。無風では舵が一瞬
  // 振り切りから外れてトリムが取れていたので、たまたま助かっていた）。
  const errDeg = want - state.pitchDeg;
  const diverging = errDeg * state.angularVelocity.x < 0 && Math.abs(errDeg) > 3;
  if (dt && (Math.abs(pd) < 0.9 || diverging) && !state.onGround) {
    const now = controls.trim || 0;
    const delta = pd * AP_TRIM_RATE * dt;
    const backToNeutral = delta * now < 0;
    if (backToNeutral || Math.abs(state.angularVelocity.x) < AP_TRIM_QUIET_RADPS) {
      controls.trim = apClamp(now + delta, -1, 1);
      // **トリムが端に着いたら、あふれたぶんは舵の積分に積む**。トリムだけが積分なので、
      // 端に張り付くと残りは比例項だけになり、ずれが残ったまま止まる——実測でTB1が
      // 進入でトリム+1.00・舵+0.5のまま指示12°に対して機首4°までしか上がらず、
      // 毎秒18mで沈んで滑走路の5km手前に着いた（操縦補助のelevIと同じ考え方）。
      if (ap && Math.abs(now + delta) > 1 && !backToNeutral) {
        ap.pitchI = apClamp((ap.pitchI || 0) + delta, -1, 1);
      }
    }
  }
  // 積分は、トリムが端から離れたら（舵が反対を向いたら）トリムへ返していく
  if (ap && ap.pitchI && dt && pd * ap.pitchI < 0) {
    const back = Math.sign(ap.pitchI) * Math.min(Math.abs(ap.pitchI), AP_TRIM_RATE * dt);
    ap.pitchI -= back;
  }
  if (ap && state.onGround) ap.pitchI = 0;
  return cmd;
}

// 指示のバンク角を保つエルロン。ロール角速度は符号が逆なので足す。
// ゲインの速度による割り引きはエレベーターと同じ（apSurfaceGain 参照）。
// **回っている最中は、角度を合わせにいく前に回転を止める**。
//
// バンク角のずれだけで舵を決めていたので、機体が回りはじめると次の2つが起きた。
//   1. ずれを折り返していなかったので、背面付近では「遠回りのほう」へ回そうと
//      した。バンク上限の大きい機体（サンダーバード1号は85°）では、
//      最大265°ぶんのずれを指示にしていた。
//   2. 回りながら±180°をまたぐたびに指示が**丸ごと逆転**する
//      （実測：ロール179°で-1.00、-179°で+1.00）。回転と同じ周期で
//      反転が入るので、ブランコを押すのと同じで回転を育てる側に回る。
//      「やっと止まりそうなところで舵が逆になり、また回りだす」という
//      報告そのもの——実測でサンダーバード1号が200°/sで回り続け、
//      方位を変えられないまま高度が±190kmで暴れて戻れなくなった。
// 直し方は2つ。ずれは±180°で折り返して近いほうへ回す。そのうえで、
// **いまの回転を育てる向きの角度項だけ**を、ロール率が上限に近いほど薄める
// （回転を止める向きなら薄めない）。こうすると速く回っているあいだ、舵は
// ロール角がどこにあっても必ず回転を止める向きになり、背面をまたいでも
// 逆転しない。止まってから起こす、という実機の立て直しと同じ順番になる。
// ついでにロール率がこの上限で頭打ちになる——ピッチに入れてある
// apPitchRateLimit と同じで、自動操縦が使っていい回転の速さの上限。
// ふつうの旋回で使うロール率は実測で 練習機16°/s・747で51°/s・TB2で25°/s
// なので、69°/sを上限にすれば通常の飛行には触らない。
// **舵は「角度のずれ」ではなく「ロール率のずれ」で決める**。
//
// 角度のずれに比例させると、ずれが大きいうちは舵が振り切れたままになり、
// 水平に戻ったときには大きなロール率が残っている——そこから初めて逆舵が
// 入るので、必ず反対側へ行き過ぎる。実測でTB1は30°から戻すと1秒後に-24°
// （54°の行き過ぎ）、747は-117°まで転がって戻れなかった。
// 「ロールがかかり始めるとエルロンで余計に回してしまう」というのがこれ。
//
// そこで2段にする：角度のずれ → 目標のロール率（上限つき）→ 舵。
// こうすると、目標のロール率は水平に近づくほど小さくなるので、機体は
// 行き過ぎる前に自分で回転を止める。舵は常に「いまの回転を目標へ寄せる」
// 向きにしかならないので、背面をまたいでも反転しない。
//
// 符号：この飛行モデルでは **rollDeg と角速度z は符号が逆**（実測：
// エルロン+1を1秒当てると rollDeg +33.0°／角速度z -48.3°/s）。
// バンクを減らしたいときは角速度zを正にしたいので、目標率は -err に比例させ、
// 舵はさらに符号を反転させる。
const AP_ROLL_RATE_MAX = 1.2;        // 自動操縦が使っていいロール率の上限(rad/s ≒ 69°/s)
const AP_ROLL_RATE_PER_DEG = 0.024;  // バンクのずれ1°あたりの目標ロール率(rad/s)
const AP_ROLL_RATE_KP = 2.2;         // ロール率のずれ(rad/s)あたりのエルロン
function apAileronForBank(state, wantBankDeg, spd) {
  const err = apWrap180(wantBankDeg - state.rollDeg);
  const wantRate = apClamp(-err * AP_ROLL_RATE_PER_DEG, -AP_ROLL_RATE_MAX, AP_ROLL_RATE_MAX);
  const rate = state.angularVelocity.z;
  return apClamp(-(wantRate - rate) * AP_ROLL_RATE_KP * apSurfaceGain(state, spd), -1, 1);
}

// --- 中間の段 -----------------------------------------------------------------

// 昇降率の上限は「経路角」で決める。**推力から決めてはいけない**——
// 降りるのに推力は要らないので、推力の小さい重い機体で降下を頭打ちにしてしまい、
// 3°の進入線に一生乗れなくなる（実際、大型機で滑走路を素通りした）。
// 同じ角度でも速い機体ほど昇降率は大きくなり、それが正しい。
const AP_CLIMB_DEG = 7;  // 高度を取り戻すときの上昇角
// 上昇中、指示ピッチを速度のずれで動かす量(°/(m/s))と、その振動を止める
// 加速度の減衰(°/(m/s²))。減衰の値は実測で決めた——0だと練習機の昇降率が
// 標準偏差±2.1m/sで振れ、3にすると±0.5に収まる（上昇率は3.2m/sのまま変わらない）。
const AP_CLIMB_SPEED_KP = 0.8;
const AP_CLIMB_SPEED_KD = 3;
const AP_CLIMB_ACCEL_TAU = 0.5; // 加速度の測り方をならす時定数(秒)
const AP_SINK_DEG = 8;   // 高度を落とすときの降下角（3°の進入より深く取れるようにしておく——
                         // 5°では、減速しながらでは経路に追いつけず、実測でBoeing 747が
                         // 進入開始で経路より590m高く入っていた）

// 上げるほうは**幾何の7°と、機体が実際に出せる上昇率の小さいほう**。
//
// 7°だけで決めていたので、推力の足りない機体には出せない上昇率を指示していた
// ——内蔵の練習機は実測3.9m/sしか出ないのに8.5m/sを指示していて、
// (1) 指示に届かず速度が落ちる → apClimbCap が指示を切り下げる → 速度が戻る →
// また指示が上がる、という10秒周期の往復（実測でピッチ3°⇔18°）になり、
// (2) 地形回避も「このくらい登れるはず」と見積もって登りはじめが遅れ、
// 標高2500mの尾根に対地2mでぶつかっていた。
// 実力は aircraftBestClimb（10-flight.js）が推力と抗力から出す。
// 空気が薄いほど登れないので、高度ぶんは密度で割り引く。
function apVsLimits(state, spd) {
  const v = Math.max(state.airspeed, 10);
  const geo = v * Math.sin(AP_CLIMB_DEG * Math.PI / 180);
  let able = Infinity;
  if (spd && spd.climbRate > 0) {
    able = spd.climbRate * (typeof airDensityAt === 'function'
      ? airDensityAt(state.altitudeM) / 1.225 : 1);
  }
  return {
    up: Math.min(geo, able),
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
  const lim = apVsLimits(state, spd);
  if (!spd) return lim.up;
  const byAngle = Math.max(state.airspeed, 10)
    * Math.sin(AP_TERRAIN_ESCAPE_DEG * Math.PI / 180);
  return apClamp(apClimbCap(state, spd), lim.up, byAngle);
}

// 高度のずれ → 目標の昇降率(m/s)。上限は上下で別（上げるのは推力次第、下げるのは自由）
// **upMax／downMax は「さらに絞る」ものであって、置き換えるものではない**。
//
// 置き換えにしていたので、速度の余裕から出す上限（apClimbCap）が幾何の上限
// （AP_CLIMB_DEG＝7°ぶん）より大きい機体では、7°の縛りがまるごと消えていた。
// 実測でサンダーバード1号（マッハ6・失速143m/s）の apClimbCap は **2907m/s**、
// 高度のずれ6.2km×AP_VS_KP がそのまま通って **昇降率の指示が626m/s**（＝上昇角17°）。
// 機体はそれに乗って高度30kmまでズームクライムし、空気の無いところで
// 弾道飛行に入って、そこから旋回も降下もできなくなっていた
// （「離陸後の最初の旋回がうまくいかない」のはここから始まる）。
// 幾何の上限では同じ速度でも 256m/s までしか許さない。
function apVsForAltitude(state, targetAltM, upMax, downMax, spd) {
  const lim = apVsLimits(state, spd);
  const up = upMax === undefined ? lim.up : Math.min(lim.up, upMax);
  const down = downMax === undefined ? lim.down : Math.min(lim.down, downMax);
  return apClamp((targetAltM - state.altitudeM) * AP_VS_KP, -down, up);
}

// 傾いた経路（降下や進入）を追うときの昇降率。
//
// 「高度のずれ×比例」だけでは、下り坂を追いかけると必ず遅れる——
// ずれが無ければ降下率もゼロになってしまうので、降下率を出すには
// ずれが残り続けるしかない。大型機で3°の進入線から60m浮いたまま
// 滑走路を通り過ぎたのがこれ。**経路そのものが要求する降下率を先に足す**（前送り）。
function apVsForPath(state, wantAltM, slope, upMax, spd) {
  const lim = apVsLimits(state, spd);
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
  // **迎角をそのまま足すと正のフィードバックになる**。機首が上がった瞬間は
  // 経路角より姿勢のほうが先に動くので迎角が跳ね、その跳ねがそのまま
  // 「もっと機首を上げろ」という指示に乗る——遅れを伴う正の帰還なので振動する。
  // 実測でサンダーバード2号が最終進入のあいだずっと、指示ピッチ+9.6°⇔-5.9°・
  // 昇降率-1900⇔+900fpm を12秒周期で往復し、引き起こしに入る瞬間がその谷に
  // 当たると-2180fpmで叩きつけられていた（接地28.4G）。ピッチ角速度で減衰させる。
  const want = gammaDeg + state.alphaDeg + fix
    - state.angularVelocity.x * AP_PITCH_VS_KD * 180 / Math.PI;
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

// 旋回の終わりを**速さによらず同じ時間で**詰める（巡航・上昇・降下の nav 用）。
//
// バンクを「ずれ1°あたり1.5°」の比例で決めると、旋回率は g·tanφ/v なので、ずれが縮む
// 時定数は v/(1.5g)——練習機（60m/s）なら4秒でも、TB1の2,100m/sでは**143秒**になる。
// 旋回の後半は、ずれが小さくなるほどバンクも浅くなり、いつまでも曲がりきれない
// （実測で、方位のずれ40°を詰めるのに300秒、旋回半径にして1,000km）。
// 時定数が AP_HDG_TAU_MAX_S を超える速さでは、「ずれ÷時定数」の旋回率を出すバンクにする。
// それより遅い機体はいままでの比例のまま（1ノットも変わらない）。
const AP_HDG_TAU_MAX_S = 8;
function apBankForTurnErr(state, errDeg, lim) {
  const v = Math.max(state.airspeed || 0, 1);
  if (v / (AP_HDG_KP * 9.80665) <= AP_HDG_TAU_MAX_S) return apClamp(errDeg * AP_HDG_KP, -lim, lim);
  const w = (errDeg * Math.PI / 180) / AP_HDG_TAU_MAX_S;   // 欲しい旋回率(rad/s)
  return apClamp(Math.atan(v * w / 9.80665) * 180 / Math.PI, -lim, lim);
}
function apAileronForTrackNav(state, wantTrackDeg, bankMax, spd) {
  const err = apWrap180(wantTrackDeg - apGroundTrackDeg(state));
  return apAileronForBank(state, apBankForTurnErr(state, err, bankMax === undefined ? AP_BANK_MAX : bankMax), spd);
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

// スポイラーをどれだけ立てるか。
// 「出力を絞っているのに、まだ速い／まだ高い」ぶんだけ立てる。速度のずれは
// 割合で見る——出力と同じ理由で、絶対値だと速い機体ほど同じずれで激しく動く。
// 出力が入っているあいだは立てない（推力とエアブレーキを同時に使うのは、
// 自分で自分と綱引きしているだけ）。
// スポイラーで失っていい揚力（重さに対して）。スポイラーは翼のキャンバーを逆に折る扱いなので、
// 失う揚力は動圧に比例する。全部立てたときに失うのは、進入の速さで重さの0.37倍・上昇の速さで0.40倍
// （TB1・TB2・三式戦闘機とも同じ）だが、高度3000mのマッハ9では**重さの71倍**になる。
// 自動操縦が巡航中の減速に立てたら、ピッチの輪が追いつく前に-26Gまで振れた。
// 立てる量を「失う揚力が重さの AP_SPOILER_LIFT_LOSS_W 倍まで」に抑える——進入・着陸は今までどおり
// 全部立てられ、極超音速ではほぼ立てない（マッハ9で1.4%。抗力も動圧に比例して大きいので、減速には困らない）。
// 0.6倍にしたら、進入の1.5倍の速さで降りてくる旧TB1が67%しか立てられず、速いまま引き起こして
// 浮き上がり、-964fpmで落ちるように接地した（1倍なら-36fpm）。
const AP_SPOILER_LIFT_LOSS_W = 1.0;
function apSpoilerLiftCap(model, state) {
  if (model._spoilerArea === undefined) {
    let k = 0;
    for (const s of model.surfaces || []) k += (s.spoiler || 0) * (s.area || 0);
    model._spoilerArea = k;
  }
  if (!(model._spoilerArea > 0)) return 1;
  const q = 0.5 * airDensityAt(state.altitudeM || 0) * state.airspeed * state.airspeed;
  const lossFullN = 2 * Math.PI * model._spoilerArea * q;
  return apClamp(AP_SPOILER_LIFT_LOSS_W * model.massKg * FLIGHT_GRAVITY / Math.max(lossFullN, 1), 0, 1);
}

function apSpoilerCommand(model, controls, state, targetSpeedMps, aboveM) {
  if (!model.hasSpoiler) return 0;
  let fast = apClamp((state.airspeed / Math.max(targetSpeedMps, 1) - 1)
    / AP_SPOILER_OVERSPEED, 0, 1);
  // **経路より下にいるときは、速いというだけでは立てない**（下にいるほど弱める）。
  // 揚力を捨てれば沈むだけで、速度より先に高さが足りなくなる——実測でTB1が進入を
  // 474kt（進入速度362kt）で始め、速すぎるぶんスポイラーを立てたまま経路の下へ沈み、
  // 滑走路の3.9km手前で対地2mを這っていた。
  if (aboveM < 0) fast *= apClamp(1 + aboveM / AP_SPOILER_PATH_M, 0, 1);
  const high = apClamp((aboveM || 0) / AP_SPOILER_PATH_M, 0, 1);
  const idle = apClamp(1 - controls.throttle / AP_SPOILER_THR_GATE, 0, 1);
  return Math.max(fast, high) * idle * apSpoilerLiftCap(model, state);
}

// いま実際に使える逆推力(N)。
//
// **model.reverseThrustN は機体ぜんぶのぶんで、降りる段では当てにならない**。
// 自動操縦は降下・進入・着陸滑走では「いちばん遅いグループ」だけを回す
// （AP_SLOW_PHASES）ので、止めているグループの逆推力は出ない。それを数に
// 入れたままレバーを決めていたので、指示した減速度がまるで出ていなかった——
// 実測でサンダーバード1号は全機ぶんなら73.4m/s²ぶんの逆推力があるのに、
// 進入で回っている群だけだと5.63m/s²、2号は4.6m/s²に対して0.57m/s²しかない。
// 5m/s²を狙って入れた7%のレバーが、実際には0.4m/s²しか出していなかった。
function apReverseThrustAvailN(model, controls) {
  let n = 0;
  for (const e of model.engines) {
    if (e.lift || !e.canReverse) continue;
    if (typeof engineGroupOff === 'function' && engineGroupOff(controls, e.group)) continue;
    n += e.thrustN;
  }
  return n * AERO_DEFAULTS.reverseFraction;
}

// 逆噴射をどれだけ入れるか。狙った減速度になるぶんだけ。
function apReverseCommand(model, state, controls, remainingM) {
  const revN = controls ? apReverseThrustAvailN(model, controls) : model.reverseThrustN;
  if (!(revN > 0)) return 0;
  let decel = AP_REVERSE_DECEL_MPS2;
  if (Number.isFinite(remainingM)) {
    const room = Math.max(remainingM - AP_REVERSE_STOP_MARGIN_M, 100);
    const need = (state.groundSpeed * state.groundSpeed) / (2 * room);
    decel = apClamp(need * AP_REVERSE_NEED_MARGIN, AP_REVERSE_DECEL_MPS2, AP_REVERSE_DECEL_MAX_MPS2);
  }
  const want = model.massKg * decel / revN;
  return apClamp(want, 0, 1) * apClamp(state.groundSpeed / AP_REVERSE_FADE_MPS, 0, 1);
}

// 旋回の釣り合い。横滑りを打ち消す向きへラダーを当てる。
// 符号（実測）：ラダー+0.5を1秒当てると横滑りは−2.7°（三式戦闘機）。**横滑りと同じ向きに当てると消える**。
// 以前は −β を当てていて、横滑りを増やす向きだった（ゲインが小さく±0.5で頭打ちなので、尾翼の風見安定が
// 勝って目立たなかったが、全自動の旋回で練習機は横滑り8〜9°のまま回っていた）。
function apRudderForCoordination(state) {
  return apClamp(state.betaDeg * AP_YAW_KP, -0.5, 0.5);
}

// 手で飛ばしているときのヨーダンパー。**ラダーに触っていないあいだだけ**、機首の振れる速さを
// 止める向きに舵を足す（実機のヨーダンパーと同じく、向きそのものは直さない。曲げたければ
// ラダーを当てればそのとおりに曲がる）。地上の滑走でも、速さが AP_MANUAL_YAW_DAMP_FROM_MPS を越えたら効かせる。
// 無いと、横風4m/sでサンダーバード1号が滑走を始めて4秒で機首を風上へ3.5°取られ、そのあと
// ±1.2°/s・周期2秒で左右に首を振りながら走った（「出発する瞬間に左右にぶれる」）。
const AP_MANUAL_YAW_DAMP_FROM_MPS = 5;
function apManualYawDamper(state) {
  if (state.groundSpeed < AP_MANUAL_YAW_DAMP_FROM_MPS) return 0;
  const yawRateDeg = state.angularVelocity.y * 180 / Math.PI;
  return apClamp(yawRateDeg * AP_YAW_RATE_KD, -0.5, 0.5);
}

// 横滑りを消すのに加えて、**機首の振れる速さで止める**（ヨーダンパー）。離陸の直後と上昇で使う。
// 横滑りだけで舵を決めていたので、浮いた瞬間の横風で振られた機首がゆっくりしか収まらず、
// 左右に首を振った——実測でサンダーバード1号（TB1_21）が横風2.5m/sで浮いた直後、ヨー角速度
// ±1°/s・周期1.6秒で振れ、ロールも±2.3°まで揺れていた。
// 体軸のヨー角速度は、正のとき機首が左へ回る（方位が減る）向き。
function apRudderYawDamped(state) {
  const yawRateDeg = state.angularVelocity.y * 180 / Math.PI;
  return apClamp(state.betaDeg * AP_YAW_KP + yawRateDeg * AP_YAW_RATE_KD, -0.5, 0.5);
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

// 旋回で深く倒していいのは、**速度に余裕があるとき**だけ。失速の AP_BANK_ENERGY_K0 倍までは
// いままでどおり AP_BANK_MAX（25°）、そこから K1 倍にかけて、翼が出せる上限（apBankLimit）まで広げる。
// 遅いときに深く倒すと、誘導抗力で速度を失って機首が落ちる——実測で練習機がやり直しの旋回を
// 40m/s（失速の1.4倍）で52°まで倒し、対地364mから156m沈んで、前にあった500mの尾根の壁に突っ込んだ。
// 推力で保てる荷重倍数から決めることも試したが、胴体・尾翼・トリムの抗力を見落として楽観的に出た。
// 速い側（Boeing 747 の巡航は失速の3.2倍、TB1は22倍）は、旋回で速度を削りながら深く倒していい。
const AP_BANK_ENERGY_K0 = 1.6;
const AP_BANK_ENERGY_K1 = 2.6;

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
// 直線に入ったかどうかの判定（行って来いしないよう、入る／出るの境目をずらす）
const AP_STRAIGHT_IN_DEG = 6;    // 目的地の方角とのずれがこれ以下になったら「直線」
const AP_STRAIGHT_OUT_DEG = 14;  // これを超えたら「まだ曲がる」に戻す
// 高さ altitudeM での失速の**真対気速度**。失速は動圧（½ρv²）で決まるので、空気が薄いほど
// 同じ翼でも速く飛ばないと支えきれない（高度12,000mでは海面の約2倍）。
function apStallTasAt(stallSeaMps, altitudeM) {
  if (!Number.isFinite(altitudeM) || typeof airDensityAt !== 'function') return stallSeaMps;
  return stallSeaMps * Math.sqrt(1.225 / Math.max(airDensityAt(altitudeM), 1e-3));
}
function apSpeedSchedule(model, distToGoM, currentVMps, controls, straight, altitudeM, currentAltM) {
  const W = model.massKg * 9.80665;
  const S = Math.max(model.wingArea, 0.01);
  const stall = Math.sqrt((2 * W) / (1.225 * S * 1.5));
  // 止めているエンジングループぶんを差し引いた「いま出せる最高速度」。
  // model.vMaxMps を直に読むと、ロケットを止めていても自動操縦がロケット込みの
  // 速度を指示しつづけ、出るはずのない速度を追いかけることになる。
  const vMax = Math.max(
    (typeof aircraftVMaxMps === 'function' ? aircraftVMaxMps(model, controls) : model.vMaxMps) || 0,
    stall * 2);
  const radiusMax = apCruiseTurnRadiusMax(distToGoM);
  // 「出したい速さ」で要るバンク角を先に出し、そこから曲がれる速さを決める。
  // 順序が逆（先にバンク角を決めて速さを頭打ちにする）だと、速い機体は
  // 曲がるために遅く飛ぶしかなくなる。
  const vWant = vMax * 0.97;
  // **曲がるときは、その速さで保てるいちばん深いバンクまで使う**（apBankLimit）。
  // 以前は「許せる半径 radiusMax（40kmか、目的地までの1/6）に収まるぶん」だけ倒していたので、
  // 翼にはもっと余裕があるのに、どの機体も40km前後の大きな輪でしか曲がらなかった
  // （Concordeがマッハ2で42°、半径40km。倒せる上限は85°で半径3.5km）。
  // **失速速度は、その高さの空気の薄さで直してから比べる**（apStallTasAt）。海面の失速速度の
  // ままだと、空気の薄い高空では出せる揚力を多く見積もり、支えきれないほど深く倒していた
  // （実測、巡航12,000mで目的地が真後ろ：旋回中の最低昇降率がTB1で-152m/s。直して-10m/s）。
  // 巡航速度を決めるほう（bankPlan）は巡航高度 altitudeM、いま倒していい上限（bankMax）は
  // いまの高さ currentAltM で見る（渡されなければ altitudeM）。
  const stallPlan = apStallTasAt(stall, altitudeM);
  const stallNow = apStallTasAt(stall, Number.isFinite(currentAltM) ? currentAltM : altitudeM);
  const bankPlan = apBankLimit(vWant, stallPlan);
  const turnableV = Math.sqrt(radiusMax * 9.80665
    * Math.tan(bankPlan * Math.PI / 180));
  // 実際に舵を切るときの上限は、いまの速度で保てるぶん。上昇中など巡航より
  // 遅いときに巡航ぶんの深いバンクを許すと、その揚力が出せず失速するだけになる。
  const bankMax = currentVMps === undefined ? bankPlan
    : apBankLimit(currentVMps, stallNow);
  // 目的地までに進入速度まで落としきれる速さ（cruise の説明を参照）
  const approach = stall * 1.3;
  // **上昇・引き起こし・進入の速さも、いまの高さの失速を見て決める**（真対気速度で飛んでいるので）。
  // 海面の失速のままだと、高く上るほど目標の速さが実際の失速に近づき、やがて下回る——
  // 実測でConcordeが高度12,000mを目指して上昇中、目標184ktのまま機首15°で上り続け、
  // 高度7,500m・169kt（その高さの失速は約190kt）で失速して落ちた。
  // 空港の標高では1,200mで6%ほど上がるだけで、海面ではこれまでと変わらない。
  const kAlt = stallNow / stall;
  const bestClimb = (typeof aircraftBestClimb === 'function') ? aircraftBestClimb(model, controls) : null;
  let slowableV = Infinity;
  if (distToGoM > 0 && typeof aircraftDragLengthM === 'function') {
    // 高さを渡されたら、その高さでの抗力長さで見積もる（apDecelLengthM）。海面の値のままだと、
    // 空気の薄い巡航高度では抗力を多く見積もりすぎる。
    const L = altitudeM !== undefined ? apDecelLengthM(model, altitudeM) : aircraftDragLengthM(model);
    if (L > 0) slowableV = apSlowableSpeed(approach, distToGoM, L);
  }
  return {
    stall: stallNow,    // いまの高さでの失速の真対気速度
    stallSea: stall,    // 海面での失速速度
    rotate: stallNow * 1.15,            // 機首を上げる速度
    // **この機体が実際に出せる上昇率(m/s)**。無い（古い呼び出し）なら undefined で、
    // apVsLimits はこれまでどおり幾何の7°だけで決める。
    climbRate: bestClimb ? bestClimb.rateMps : undefined,
    // 上昇は海面の失速の1.35倍のまま、**その高さの失速の1.2倍は割らない**。全部をその高さの
    // 失速で決める（1.35倍）と、練習機が高いところで上りが鈍り、越えられない山をよけきれず
    // 山腹の上を対地96mで通った（直す前283m）。
    climb: apClamp(Math.max(stall * 1.35, stallNow * 1.2), stallNow * 1.2, vMax * 0.6),
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
    // **もう曲がらなくていいなら、曲がれる速さで頭打ちにしない**。
    // turnableV は「その半径で曲がれる速さ」なので、旋回を終えて目的地へ
    // まっすぐ向いているだけの区間でもこれで抑えられていた——どんな機体でも
    // 巡航が旋回できる速さまでしか出ず、最高速度に届かなかった。
    // まっすぐ飛ぶだけになったら外す（減速のぶん slowableV は残す——
    // これを外すと目的地までに進入速度まで落としきれなくなる）。
    cruise: apClamp(Math.min(vMax * 0.97, straight ? Infinity : turnableV, slowableV),
      stallPlan * 1.4, vMax),
    straight: !!straight,
    approach: approach * kAlt,
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
  let elev = airport.elevationM || 0;

  // 進入端（手前側の末端）。
  // **空港の中心ではなく「実際に使う滑走路の中心」から測る** ——平行滑走路のある
  // 空港では、空港の中心は滑走路と滑走路のあいだの草地にあたる。
  // 向きは**いまの設定のもの**を使う（UIで回した空港で、定義の向きのまま測ると
  // 平行滑走路のあいだの草地を狙う）。
  // 地図で選んだ平地（airport.isField）は、帯の中心がそのまま滑走路の中心
  const rc = typeof worldAirportRunwayCenter === 'function' && !airport.isField
    ? worldAirportRunwayCenter(airport, settings.headingDeg) : { x: airport.x, z: airport.z };
  const thrX = rc.x - f.x * half;
  const thrZ = rc.z - f.z * half;
  const aimX = thrX + f.x * AP_TOUCHDOWN_M;
  const aimZ = thrZ + f.z * AP_TOUCHDOWN_M;
  const fafX = thrX - f.x * AP_FINAL_M;
  const fafZ = thrZ - f.z * AP_FINAL_M;
  const glide = Math.tan(AP_GLIDE_DEG * Math.PI / 180);
  // 平地は平らではない（勾配1.2%まで）。降下の経路は接地を狙う点の地面の高さへ引く。
  // 帯の中心の高さへ引いていたので、勾配0.67%・長さ5kmの帯でTB1が端の643m手前に接地し、
  // 帯の外の地面を413ktで走るうちに向きが180°回って、横へ1.4km飛び出した。
  if (airport.isField && Number.isFinite(airport.elevA)) {
    const ff = apForward(airport.headingDeg);
    const along = (aimX - airport.x) * ff.x + (aimZ - airport.z) * ff.z;
    elev = (airport.elevA + airport.elevB) * 0.5 + (along / settings.runwayLengthM) * (airport.elevB - airport.elevA);
  }

  return {
    airportId: airport.id,
    label: airport.isField ? '選んだ地点' : airport.id,
    heading, forward: f, right: apRight(heading),
    elevationM: elev,
    runwayLengthM: settings.runwayLengthM,
    aim: { x: aimX, z: aimZ },
    threshold: { x: thrX, z: thrZ },
    // 垂直着陸で真下へ降りる点。空港は進入端、地図で選んだ平地は帯の中心
    // （進入端にすると、長さ600mの帯の端に降りていた）
    pad: airport.isField ? { x: rc.x, z: rc.z } : { x: thrX, z: thrZ },
    faf: { x: fafX, z: fafZ },
    fafAltM: elev + (AP_FINAL_M + AP_TOUCHDOWN_M) * glide,
    glide,
  };
}

// 引き起こしの最後に保つ沈下率(m/s)。速い機体ほど大きく（練習機0.7・747 1.0・TB1 1.6）
const AP_FLARE_SINK_BASE = 0.45;
const AP_FLARE_SINK_PER_MPS = 0.0065;
const AP_FLARE_SINK_MAX = 1.8;
function apFlareMinSink(state) {
  return apClamp(AP_FLARE_SINK_BASE + state.groundSpeed * AP_FLARE_SINK_PER_MPS, 0.5, AP_FLARE_SINK_MAX);
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
  const bySink = Math.max(-state.verticalSpeed, 0) * AP_FLARE_SEC * apFlareQuick(state);
  return Math.max(bySize, bySink);
}

// **速い機体ほど、引き起こしを短く強くする**（1＝以前どおり、速いほど小さい）。
// 引き起こしの長さは時間で決まるので、距離は速さに比例して伸びる——実測で
// サンダーバード2号（接地362kt）が対地47mから11.6秒・2.3km引き起こしを続けて
// 進入端から1.6km先で接地し、3000mの滑走路の端を179m越えた。秒速100m（194kt）までは
// 以前どおりで、それより速いと、始める高さ（沈下率×4秒）と沈下率を絞る時定数を
// 速さに反比例して縮める（秒速125mで0.8倍が下限）。
// 下限をもっと小さくすると、引き起こしが間に合わずに叩きつける——実測で0.44倍では
// 747が27.8G、0.6倍でもサンダーバード1号が-1372fpm/12.1Gだった（0.8倍で-549fpm/4.3G）。
const AP_FLARE_QUICK_FROM_MPS = 100;
const AP_FLARE_QUICK_MIN = 0.8;
function apFlareQuick(state) {
  return apClamp(AP_FLARE_QUICK_FROM_MPS / Math.max(state.groundSpeed, 1), AP_FLARE_QUICK_MIN, 1);
}

// 最終進入で、中心線からのずれ1mあたり何度向きを振るか。
// 0.06°/m（955m先の中心線を見て寄せるのと同じ）で決めていたが、速い機体ほど
// 同じバンクでもゆっくりしか曲がれない（旋回率は速さに反比例）——実測で
// サンダーバード2号（進入390kt）は20°バンクで1°/sしか向きを変えられず、
// 中心線の左右を±300m・周期45秒で蛇行したまま、206m横で引き起こしに入り、
// 滑走路の外（81m横）に接地した。見る先を旋回半径（20°バンク）の AP_LOC_RADII 倍より
// 近くしない。進入180kt（747・Concordeまで）は旋回半径が短いので以前どおり。
const AP_LOC_GAIN_DEG_PER_M = 0.06;
const AP_LOC_RADII = 0.35;
function apLocGainDegPerM(state) {
  const r20 = (state.groundSpeed * state.groundSpeed) / (9.80665 * Math.tan((20 * Math.PI) / 180));
  const minLook = 180 / Math.PI / AP_LOC_GAIN_DEG_PER_M;
  return AP_LOC_GAIN_DEG_PER_M * Math.min(1, minLook / Math.max(r20 * AP_LOC_RADII, 1));
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
    hover: false,          // その場に留まる（垂直離着陸機だけ）
    full: false,           // 離陸から着陸まで全自動
    // ホバリングの持ち場（入れた瞬間の場所・高さ・機首の向き）
    hoverX: 0, hoverZ: 0, hoverAltM: 0, hoverHeadingDeg: 0,
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
    terrainDodgeDeg: 0,       // 越えられない山をよけるための、方位の振り角
    ceilingSec: 0,          // 上昇率がほぼ無いまま続いている秒数（上昇限度の判定）
    ceilingLimited: false,  // 上昇限度に当たって、目標高度を下げたか
    pitchCmdDeg: undefined, // 実際に舵へ渡している指示ピッチ（変化率を制限したあと）
    rotating: false,        // 離陸滑走で機首上げを始めたか
    descentSpeedCapMps: 0,  // 降下中の速度の上限（降下に入った時点の速さ）
    apprThr: undefined,     // 最終進入の出力の積分（絞るぶんとは別に持つ）
    apprFlapMax: undefined, // 最終進入で下ろしていいフラップの上限（トリムの余裕で決まる）
    // 垂直エンジンの輪の減衰に使う、上下の加速度（apVtolThrottleForVs）
    vtolLastVs: undefined, vtolAccel: 0,
    hovLastVA: undefined, hovLastVC: 0, hovAccelA: 0, hovAccelC: 0,
    // 上昇の輪の減衰に使う、前後の加速度（上昇の段）
    climbLastV: undefined, climbAccel: 0,
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
// --- エンジングループの入り切り（自動操縦）-----------------------------------
//
// グループごとに出せる最高速度が違う機体（ロケットを点ければマッハ21、
// ジェットだけならマッハ5、のような機体）では、**いつ速いグループを使うか**が
// 操縦の一部になる。手で数字キーを押すのと同じことを自動操縦にもやらせる。
//
// 方針は単純に「巡航では要るぶんだけ点け、降りはじめたら落とす」。
//   ・上昇と巡航 … 目的地が遠いほど速いグループまで使う。近ければ遅いグループだけ
//   ・降下から着陸まで … いちばん遅いグループだけ（速いエンジンで進入したくない）
//   ・離陸 … 遅いグループだけ（滑走路の上でロケットを焚く理由がない）
//
// **ばたつかせないこと**が大事。グループを1つ入り切りするだけで出せる最高速度が
// 何倍も変わるので、境目で往復すると速度指示ごと往復して機体が揺れる。
// 入れる距離と切る距離を離し（ヒステリシス）、切り替えたあとは
// AP_ENGINE_HOLD_S のあいだ触らない。
// 速いグループを点ける条件は「そのグループの最高速度で飛んでも、まだ
// これだけの時間がかかる距離が残っている」こと。加速して、巡航して、
// 落としきるまでを考えると、4分ぶんは要る。
// 例：マッハ21（7,140m/s）のグループなら 1,714km より遠いときだけ点く。
// マッハ5（1,700m/s）なら 408km。80kmの短い便では、どちらも点かない。
const AP_ENGINE_HOLD_S = 20;         // 切り替えたあと、次まで最低これだけ空ける（秒）
const AP_ENGINE_ON_S = 240;          // 点ける境目（そのグループの最高速度で何秒ぶん残っているか）
const AP_ENGINE_OFF_S = 150;         // 切る境目。点ける境目と離しておかないと、境目で往復する

// 降りる段では、いちばん遅いグループだけを回す
const AP_SLOW_PHASES = ['descent', 'approach', 'flare', 'rollout', 'taxi',
  'vtol_approach', 'vtol_hover', 'vtol_descent', 'vtol_touchdown', 'takeoff', 'vtol_takeoff'];

function apManageEngineGroups(model, state, controls, ap, spd, dt, env) {
  const groups = model.engineGroups || [];
  if (!controls.engineGroupOff) controls.engineGroupOff = {};
  // グループが1つしかない機体は切り替えるものが無いが、**止まっていたら点け直す**。
  // 前に乗っていた機体で止めたグループの記録が残っていると（グループの番号は機体どうしで重なる）、
  // この機体のただ一つのエンジンが止まったままになり、全自動を入れても出力が上がらず動かなかった
  // ——実測でTB2_18の自動離陸（グループ1を止める）のあとTB1_21に替えると、推力0のまま滑走路に止まっていた。
  if (groups.length < 2) {
    if (groups[0] && controls.engineGroupOff[groups[0].id]) controls.engineGroupOff[groups[0].id] = false;
    return;
  }
  ap.engineHold = Math.max((ap.engineHold || 0) - dt, 0);
  if (ap.engineHold > 0) return;

  // 遅い順に並べる。いちばん遅いグループは常に回す（止めると降りられない）。
  const sorted = groups.slice().sort((a, b) => a.vMaxMps - b.vMaxMps);
  const slowest = sorted[0];
  const slowPhase = AP_SLOW_PHASES.indexOf(ap.phase) >= 0;
  const distM = ap.distanceM === undefined ? Infinity : ap.distanceM;

  // **点けるのは必ず「遅いほうから順に」**。グループを1本ずつ独立に判断すると、
  // いちばん速いグループといちばん遅いグループだけが点いて真ん中が抜ける、
  // という並びが出てしまう（速いグループほど「目的地まで何秒」が短くなるので、
  // 判定が素直に順番になってくれない）。そこで決めるのは**何段目まで点けるか**
  // という数ひとつにして、その段までを全部点ける。
  let wantCount = 1;                    // いちばん遅いグループは常に回す
  if (!slowPhase) {
    for (let i = 1; i < sorted.length; i++) {
      // そのグループを点ければ出せる速度で、目的地まで何秒かかるか。
      // 何分もかかるほど遠いときだけ、速いエンジンを使う値打ちがある。
      const secs = distM / Math.max(sorted[i].vMaxMps, 1);
      const on = !controls.engineGroupOff[sorted[i].id];
      // 入れる／切るの境目をずらす（同じ値だと境目で往復する）
      if (secs > (on ? AP_ENGINE_OFF_S : AP_ENGINE_ON_S)) wantCount = i + 1;
      else break;                       // ここで止める。先だけ点けたりはしない
    }
  }

  // **いちばん遅いグループで進入速度が出せないなら、そこまでは落とさない**。
  // 「降りる段はいちばん遅いグループだけ」は、遅いグループでも飛べることを
  // 前提にしていた。サンダーバード2号はいちばん遅いグループの最高速度が
  // 170m/sで、進入速度197m/s（失速152m/s）にも届かない——上昇限度の2.4kmで
  // 降下に切り替わった瞬間に速いグループを止められ、そこから速度が
  // 270kt→9ktまで落ちてピッチ53°で錐揉みに入り、45分たっても降下の段から
  // 出られずに空中で回り続けていた（実測。垂直着陸でもふつうの着陸でも同じ）。
  // 進入速度を出せる段までは残す。
  if (spd && spd.approach > 0) {
    while (wantCount < sorted.length && sorted[wantCount - 1].vMaxMps < spd.approach) {
      wantCount++;
    }
  }

  // いま何段目まで（頭から連続して）点いているか
  let nowCount = 0;
  while (nowCount < sorted.length && !controls.engineGroupOff[sorted[nowCount].id]) nowCount++;
  // 途中に穴があれば埋める（手で切られた場合など）。無ければ1段ずつ動かす。
  const holes = sorted.slice(0, Math.max(nowCount, 1))
    .some((g) => controls.engineGroupOff[g.id]);
  const next = holes ? wantCount
    : (wantCount > nowCount ? nowCount + 1 : (wantCount < nowCount ? nowCount - 1 : nowCount));
  if (next === nowCount && !holes) return;

  const before = sorted.map((g) => !controls.engineGroupOff[g.id]);
  sorted.forEach((g, i) => { controls.engineGroupOff[g.id] = i >= next; });
  ap.engineHold = AP_ENGINE_HOLD_S;
  if (env && env.announce) {
    for (let i = 0; i < sorted.length; i++) {
      const on = i < next;
      if (on !== before[i]) env.announce(`自動操縦：${sorted[i].label} ${on ? '始動' : '停止'}`);
    }
  }
}

// --- 最終進入へのつなぎ（回りきれない機体のための「入口」） --------------------------
//
// 「一部の旋回の大きい機体が、降下から進入に入ると、回りきれないで永遠とやり直しになる」。
// 降下もやり直しも**最終進入開始点（FAF）へまっすぐ**向かっていたので、滑走路の向きと
// 関係ない方角から FAF に着く。そこから中心線に乗るには旋回が要るが、進入のバンクは20°までで、
// 旋回半径は 200ktで約3km・300ktで約6.6km——FAFから滑走路まで9kmでは乗りきれず、
// 「滑走路の4km手前で中心線から2km以上ずれている」でやり直し、またFAFへまっすぐ戻って
// 同じ角度で着く、を繰り返していた（実測：逆向きから入るとBoeing 747が17回・Concordeが19回
// やり直して着陸できず、TB1は進入のまま4000秒回り続けた）。
//
// FAFへまっすぐ向かって中心線から30°以内で着けるときは、これまでどおりまっすぐ行く
// （正面から来る場合は何も変わらない）。そうでなければ、**中心線をさらに外へ延ばした
// 「入口」**へまず向かい、そこで中心線から20°以内に入れたら（旋回半径の2.5倍以上外で）、
// そこからFAFへ向かう。入口はFAFから旋回半径の3.3倍外に置くので、どの向きから来ても
// 回りきるだけの距離が残る。FAFに着いたとき機首が滑走路の向きから45°以上ずれていたら、
// 最終進入に入らずやり直す（入口からやり直す）。
const AP_ENTRY_CONE_DEG = 30;     // FAFへまっすぐ向かってよい、中心線からの角度
const AP_ENTRY_LEAVE_CONE_DEG = 45; // まっすぐ向かっている途中で、これより外れたら入口へ切り替える
const AP_ENTRY_CAPTURE_RADII = 1.5; // 中心線に乗りにいってよい横ずれ（旋回半径の倍数）
const AP_ENTRY_RADII = 2.5;       // 中心線に乗っていたい、FAFから外への距離（旋回半径の倍数）
// 入口を置く、FAFから外への距離（旋回半径の倍数）。外向きに飛んできて入口で折り返すと、
// 折り返しで旋回半径の2倍ぶん横へずれ、そこから中心線に乗るのにさらに2倍ほど要る。
// 3.3倍では足りず、ConcordeがFAFに37°ずれて着いた。
const AP_ENTRY_GATE_RADII = 4.5;
const AP_ENTRY_ALIGN_DEG = 45;
const AP_ENTRY_CLOSE_ALIGN_DEG = 60; // 中心線のすぐ近くなら、中心線に乗りにいってよい向きのずれ    // 最終進入に入るときに許す、機首と滑走路の向きのずれ
const AP_ENTRY_MIN_M = 3000;
// 入口から戻るときは、FAFの点ではなく**中心線に乗りにいく**。点へまっすぐ向かうと、
// 入口で振り向いたぶんの横ずれを斜めに詰めながらFAFに着くので、機首が滑走路の向きから
// 30〜46°ずれたまま着いていた（実測、Concorde）。横ずれが旋回半径1つぶんで45°の角度で
// 寄せ、近づくほど浅くする。FAFまで旋回半径の2.5倍あるので、着くころには乗りきっている。
const AP_ENTRY_CAPTURE_DEG = 45;

// 旋回半径の見積もり。速さは**上昇の速度で頭打ち**にする——いまの速さそのままだと、
// 巡航で加速するほど入口が遠ざかり、遠ざかるほど道のりが延びてまた加速する、
// の繰り返しになった（実測でTB1が入口を追いかけて4,000ktを超え、3,000km飛んだ）。
// 入口のまわりを回るのは降下ややり直しの速さなので、上昇の速度で見積もる。
// （降下の速さをそこまで落とすのはやめた——上昇の速度が失速の1.35倍しかない機体
// （TB1）や、失速24ktの機体で上昇32kt（三式戦闘機）では、そこまで落とすと降下で
// 地面まで沈んだ。）
//
// バンクは**進入と同じ20°で見る**。巡航の上限（35°まで）で見積もると、実際には
// そこまで傾けないので半径を半分ほどに見誤り（Boeing 747で1.8km、実際は3.4km）、
// 入口がFAFのすぐ外に来て、その上を回っているうちに横から中心線をつかみにいっていた。
const AP_ENTRY_BANK_DEG = 20;
// 入口を回っているあいだの速さの上限（上昇・進入の速度の大きいほうの1.3倍）。
// 見積もりにこの速さを使い、降下ややり直しでも実際にここまで落とす——見積もりより
// 速く飛んでいると、入口のまわりを見積もりより大きな輪で回ってしまい、中心線に
// 乗りにいく条件（横ずれが旋回半径の1.5倍以内）をいつまでも満たさなかった（TB2）。
// 上昇の速度そのものにすると遅すぎる機体がある（三式戦闘機は失速24kt・上昇32kt）。
function apEntrySpeedCapMps(spd) {
  return Math.max(spd.climb || 0, spd.approach || 0) * 1.3;
}
function apTurnRadiusM(state, spd) {
  const cap = apEntrySpeedCapMps(spd);
  const v = Math.max(Math.min(state.airspeed, cap || state.airspeed), spd.approach || 0);
  return (v * v) / (9.80665 * Math.tan((AP_ENTRY_BANK_DEG * Math.PI) / 180));
}

// いま向かう点（FAFか入口）と、そこを通ってFAFまでの道のり
function apApproachNavTarget(plan, state, ap, spd, straightOnly, model) {
  const faf = plan.faf, f = plan.forward, r = plan.right;
  const dx = state.position.x - faf.x, dz = state.position.z - faf.z;
  const dFaf = Math.hypot(dx, dz);
  ap.entrySpeedLimitMps = undefined;
  if (straightOnly) return { x: faf.x, z: faf.z, distM: dFaf };
  const out = -(dx * f.x + dz * f.z);          // FAFから、進入してくる側へ何m出ているか
  const cross = dx * r.x + dz * r.z;
  const R = apTurnRadiusM(state, spd);
  const sMin = Math.max(R * AP_ENTRY_RADII, AP_ENTRY_MIN_M);
  const angDeg = (Math.atan2(Math.abs(cross), Math.max(out, 1e-3)) * 180) / Math.PI;
  const inCone = (lim) => out >= sMin && angDeg <= lim;
  const lg = sMin * (AP_ENTRY_GATE_RADII / AP_ENTRY_RADII);
  const gx = faf.x - f.x * lg, gz = faf.z - f.z * lg;
  const dGate = Math.hypot(state.position.x - gx, state.position.z - gz);
  if (ap.navPlan !== plan) { ap.navPlan = plan; ap.navMode = undefined; }
  if (ap.navMode === undefined) ap.navMode = inCone(AP_ENTRY_CONE_DEG) ? 'faf' : 'gate';
  // **まっすぐ向かってよい範囲から出たら、入口へ切り替える**。決めるのは最初の一度だけだったので、
  // 離陸した向きが目的地と逆だと、決めた時点では中心線の延長上にいても、そこから大きく
  // 回って戻ってくるあいだに横へ外れ、FAFへ横から着いてやり直していた（実測でTB2が
  // 標高1200mの空港から逆向きに出て、FAFに滑走路の向きから54°ずれて着いた）。
  // 入る角度（30°）より広い角度で見て、境目で行ったり来たりしないようにする。
  else if (ap.navMode === 'faf' && dFaf > sMin && angDeg > AP_ENTRY_LEAVE_CONE_DEG) ap.navMode = 'gate';
  else if (ap.navMode === 'gate') {
    // 入口の近くまで来て、**滑走路へ向かう向き（内向き）に飛んでいる**なら、中心線に乗りにいく。
    // 外向きのまま入口を過ぎたら、入口へ戻ろうとして自然に折り返す（そのあとで内向きになる）。
    // 「入口に着いたら」だけで切り替えると、外向きのまま中心線へ寄せはじめ、
    // 折り返しの旋回ぶん横へずれたまま FAF に着いていた。
    // 「内向き」は滑走路の向きから45°以内。90°以内にしていたら、中心線を真横に横切って
    // いるところで切り替わり、寄せきれずにFAFへ横から着いて、入口とのあいだを往復した
    // （実測でBoeing 747）。入口の上を回っているうちに、いずれこの向きになる。
    const hdgErr = Math.abs(apWrap180(plan.heading - state.headingDeg));
    const inbound = hdgErr <= AP_ENTRY_ALIGN_DEG;
    // 中心線からの横ずれも旋回半径の1.5倍まで（それより離れていると、FAFまでに寄せきれない）
    if (out >= sMin && Math.abs(cross) <= R * AP_ENTRY_CAPTURE_RADII && inbound) ap.navMode = 'capture';
    // **中心線のすぐ近く（横ずれ1旋回半径以内）なら、向きは AP_ENTRY_CLOSE_ALIGN_DEG まで許す**。
    // 入口へ斜めに入ってくると、入口の上で向きのずれが45°をわずかに超えたまま通り過ぎ、
    // 折り返して入口のまわりを一周してから乗ることになる——実測でTB1がずれ48°で入口を過ぎ、
    // 4分かけて一周していた。中心線の近くなら、寄せる向き（最大45°）へは少し回るだけで済む。
    // 遠いところでまで広げると、中心線を真横に横切るところで乗りにいってしまう（上の747の実測）。
    else if (out >= sMin && Math.abs(cross) <= R && hdgErr <= AP_ENTRY_CLOSE_ALIGN_DEG) ap.navMode = 'capture';
  }
  if (ap.navMode === 'faf') return { x: faf.x, z: faf.z, distM: dFaf };
  // 入口を回るときの速さの上限。入口まで残り dGate で、そこで上限の速さに落ちている速さ
  // （巡航でも掛ける。巡航のまま数千ktで入口に着くと、何十kmもの輪で回って
  // 中心線に乗れなかった：TB1）。中心線に乗りにいっている間は上限そのもの。
  const cap = apEntrySpeedCapMps(spd);
  if (ap.navMode === 'capture') {
    ap.entrySpeedLimitMps = cap;
    // 中心線へ寄せる向き（横ずれ1旋回半径で45°、近づくほど浅く）
    const ang = apClamp((-cross / Math.max(R, 1)) * AP_ENTRY_CAPTURE_DEG,
      -AP_ENTRY_CAPTURE_DEG, AP_ENTRY_CAPTURE_DEG);
    // FAFを過ぎたら点そのものへ（最終進入の判定はFAFからの距離で行う）
    if (out <= 0) return { x: faf.x, z: faf.z, distM: dFaf };
    const hd = ((plan.heading + ang) * Math.PI) / 180;
    const fx = Math.sin(hd), fz = -Math.cos(hd);
    return { x: state.position.x + fx * 5000, z: state.position.z + fz * 5000, distM: dFaf };
  }
  // 抗力は速さの2乗で効くので、速いうちほど大きく減速できる。一定の減速度（AP_DECEL_MPS2）だけで
  // 見積もると、入口まで2,800kmあるTB1でも「3,850ktまで」になり、残り距離に比例して
  // 目標速度が下がりつづけた（実測でマッハ5.8から巡航中ずっと落ち、マッハ3を切った）。
  // 実際は抗力だけでもマッハ9.7から395kmで進入速度まで落ちる。抗力長さ
  // （apDecelLengthM）で落とせる速さも出し、大きいほうを採る。落とせる距離の半分
  // 見積もりは apSlowableSpeed（抗力の1/1.2の速さで落とし、最後に20kmの余裕）。
  const constDecel = Math.sqrt(cap * cap + 2 * AP_DECEL_MPS2 * dGate);
  const Ld = model ? apDecelLengthM(model, Number.isFinite(ap.targetAltitudeM) ? ap.targetAltitudeM : state.altitudeM) : 0;
  const dragDecel = Ld > 0 ? apSlowableSpeed(cap, dGate, Ld) : 0;
  ap.entrySpeedLimitMps = Math.max(constDecel, dragDecel);
  return { x: gx, z: gz, distM: dGate + lg };
}

// 最終進入に入ってよいか（機首が滑走路の向きを向いているか）
function apAlignedForFinal(plan, state) {
  return Math.abs(apWrap180(plan.heading - state.headingDeg)) <= AP_ENTRY_ALIGN_DEG;
}

// --- 地上で中心線を保つ（離陸滑走・着陸後の滑走） ------------------------------------
//
// 「自動の離着陸のとき、風に煽られて左右にブレるのを、ラダーで抑えて」。
// 地上の方向は「方位のずれ×0.05」だけで舵を当てていたので、横風で機首が風上へ振られて
// から遅れて当てることになり、しかも中心線へ戻す力も、振れを止める減衰も無かった。
// 実測（横風8m/s±3）：Boeing 747が離陸滑走で機首を18°風上へ取られ、中心線から70m
// 流れたまま浮いた。Concordeは211m、練習機は無風に近くても40m流れた。
//   ・目標の方位を、中心線からのずれで少しだけ中心線側へ寄せる（最大8°）
//   ・方位のずれへの舵を強くする（1°で1.2。はじめ0.12にしていたが、下の「すべり角」「積分」の説明を参照）
//   ・機首の振れる速さで止める（減衰、1°/sで0.8）
// 前輪の操向は速くなると効かなくなり（40m/sで0）、そこから先はラダーの空力だけで
// 保つことになるので、振れを早めに止めておくことが効く。
const AP_GROUND_HDG_KP = 1.2;       // 方位のずれ1°あたりの舵
const AP_GROUND_RATE_KD = 0.8;      // 振れる速さ1°/sあたりの舵
const AP_GROUND_CROSS_KP = 0.25;    // 中心線からのずれ1mあたり、目標の方位を寄せる角(°)
const AP_GROUND_CROSS_MAX_DEG = 8;
// 中心線へ寄る横の速さの上限(m/s)。寄せる角を速さで割って決める（56ktより遅ければ8°のまま）。
// 角だけで決めていたので、速いほど同じ角で激しく横へ動いた——実測でサンダーバード1号が
// 中心線から19m横に接地し、300ktのまま4秒で中心線へ戻ろうとして（横へ秒速5m）
// 重心の高さで振られ、ロール-5°→+7°→-27°→-83°と転がった。
const AP_GROUND_CROSS_RATE_MPS = 4;
// **舵を「方位」だけで決めると、横風のあいだ中心線から流れ続ける**。2つ足した。
//   ・進む向き（対地の速度の向き）と機首の向きのずれ（タイヤのすべり角）を目標の方位に足す。
//     横風を受けているタイヤは、機首の向きより風下へずれて進む——方位だけ合わせていると、
//     そのずれのぶん斜めに走り続ける。
//   ・方位のずれを積む（I）。風見鶏のように機首を風上へ回す力は滑走中ずっと掛かっているので、
//     比例だけでは「ずれが残るから舵が出る」ところで釣り合い、ずれたまま走る。
//     速い機体ほど同じずれで横へ速く動く（200m/sで1°なら秒速3.5m）。
// 実測（横風8m/s、真横）：サンダーバード2号(18)が地上で中心線から29.6m流れていた
// （方位のずれは2.7°で、舵は0.5しか使っていなかった）。
// **効きも10倍にした**（方位1°で0.12→1.2、振れ1°/sで0.08→0.8）。サンダーバードは滑走路の上で
// 200〜400m/sまで出るので、1°ずれただけで秒速3.5〜7m横へ動く。弱い効きでは戻しきる前に流れた。
// 横風4/8/12m/sで、Concorde 11/37/67m → 0.6/1.3/2.0m、TB2_18 12/30/47m → 0.8/1.7/2.6m、
// TB1_21 5/10/15m → 1.0/2.0/3.7m。ヨー角速度の最大は1.3°/s以下、舵の動きは1秒あたり合計0.33以下。
const AP_GROUND_HDG_KI = 0.1;       // 方位のずれ1°が1秒続くと足す舵
const AP_GROUND_INT_MAX = 0.6;
const AP_GROUND_SLIP_TAU_S = 2;     // すべり角をならす時定数
function apGroundSteer(state, ap, courseDeg, crossM, dt) {
  if (ap.gndPrevHdg === undefined) { ap.gndInt = 0; ap.gndSlip = 0; }
  const prev = ap.gndPrevHdg === undefined ? state.headingDeg : ap.gndPrevHdg;
  ap.gndPrevHdg = state.headingDeg;
  const rate = dt > 0 ? apWrap180(state.headingDeg - prev) / dt : 0;
  const v = Math.max(state.groundSpeed, AP_GROUND_CROSS_RATE_MPS);
  const maxDeg = Math.min(AP_GROUND_CROSS_MAX_DEG,
    (Math.asin(AP_GROUND_CROSS_RATE_MPS / v) * 180) / Math.PI);
  // 進む向き（方位と同じ取り方：北=0、東=90）。遅いときは向きが定まらないので使わない
  const vel = state.velocity;
  const moving = state.groundSpeed > 5;
  const slipNow = moving
    ? apClamp(apWrap180(state.headingDeg - Math.atan2(vel.x, -vel.z) * 180 / Math.PI), -10, 10) : 0;
  const a = dt > 0 ? Math.min(1, dt / AP_GROUND_SLIP_TAU_S) : 1;
  ap.gndSlip = (ap.gndSlip || 0) + (slipNow - (ap.gndSlip || 0)) * a;
  const want = courseDeg + apClamp(-crossM * AP_GROUND_CROSS_KP, -maxDeg, maxDeg);
  // 動いているときは「進む向き」を目標に合わせる（= 機首の向きをすべり角ぶん風上へ）
  const err = apWrap180(want - (state.headingDeg - ap.gndSlip));
  if (moving && dt > 0) {
    ap.gndInt = apClamp((ap.gndInt || 0) + err * AP_GROUND_HDG_KI * dt, -AP_GROUND_INT_MAX, AP_GROUND_INT_MAX);
  } else ap.gndInt = 0;
  return apClamp(err * AP_GROUND_HDG_KP + ap.gndInt - rate * AP_GROUND_RATE_KD, -1, 1);
}
// 滑走路の中心線からの横ずれ（右が正）。origin を通って course の向きの線から測る。
function apCrossFromLine(state, originX, originZ, courseDeg) {
  const r = apRight(courseDeg);
  return (state.position.x - originX) * r.x + (state.position.z - originZ) * r.z;
}

// 手で滑走しているときの「まっすぐ」。**ラダーに触っていないあいだだけ**、滑走を始めた線
// （動き出したとき・接地したときの位置と進む向き）を apGroundSteer で保つ。
// 線は**動き出した瞬間に**取る（秒速0.2m）。練習機はブレーキを離して最初の0.4mを進むあいだに
// 横風で機首を1.7°取られる——5m/sや1m/sで線を取ると、その斜めの線を律儀に保って流れた
// （横風8±3m/sで、5m/sで取ると36m・1m/sで17m・0.2m/sで4.8m）。
// ヨーダンパー（apManualYawDamper）は振れを止めるだけで向きを戻さないので、横風で機首を
// 風上へ取られると、止まった向きのまま斜めに走って滑走路から出ていた——実測で横風4m/sの
// サンダーバード1号(21)が、機首は2.2°しか振れていないのに、400m/sを越える滑走で中心線から
// 126m流れた。ラダーを当てれば手の舵がそのまま効き、離すとその場所・その向きで線を取り直す
// （曲がりたくて当てたのだから、元の線へは戻さない）。止まりかけと空中では何もしない。
// hold は呼び出し側が持つ入れ物（線と apGroundSteer の積分など）。
const AP_MANUAL_HOLD_FROM_MPS = 0.2;
const AP_MANUAL_HOLD_TRACK_MPS = 15;
function apManualGroundHold(state, hold, dt) {
  if (!state.onGround || state.groundSpeed < AP_MANUAL_HOLD_FROM_MPS) { hold.course = undefined; return null; }
  if (hold.course === undefined) {
    // 速いとき（接地した瞬間）は**進んでいる向き**で取る。機首の向きで取ると、横風の中を機首を
    // 風上へ向けたまま（クラブ）接地したとき、その斜めの向きへ走っていってしまう。
    // 動き出し（遅いとき）は機首の向きで取る。歩くほどの速さではタイヤが横風で横へずれていて、
    // 進む向きが数°ぶれる——それで取ると、Concordeが横風12m/sで中心線から4m→32m流れた。
    const v = state.velocity;
    hold.course = state.groundSpeed >= AP_MANUAL_HOLD_TRACK_MPS
      ? Math.atan2(v.x, -v.z) * 180 / Math.PI : state.headingDeg;
    hold.x = state.position.x; hold.z = state.position.z;
    hold.gndPrevHdg = undefined;
  }
  return apGroundSteer(state, hold, hold.course, apCrossFromLine(state, hold.x, hold.z, hold.course), dt);
}

// 主脚の列より後ろ（1m以上）に車輪があるか（尾輪など）。機体の前は -Z
function apHasWheelBehindMains(model) {
  if (model._wheelBehind !== undefined) return model._wheelBehind;
  const cs = model.contacts || [];
  const mains = cs.filter((c) => c.brake);
  if (!mains.length) { model._wheelBehind = false; return false; }
  const mz = Math.max(...mains.map((c) => c.position.z));
  model._wheelBehind = cs.some((c) => !c.brake && c.position.z > mz + 1);
  return model._wheelBehind;
}

// 尾輪式（操向輪が主脚より後ろ）か。そうなら、主脚と尾輪がどちらも接地する姿勢（°）も返す。
function apTailwheelRestPitch(model) {
  if (model._tailRest !== undefined) return model._tailRest;
  const cs = model.contacts || [];
  const tail = cs.find((c) => c.steer && c.steerSign < 0);
  const mains = cs.filter((c) => c.brake);
  if (!tail || !mains.length) { model._tailRest = null; return null; }
  const my = mains.reduce((a, c) => a + c.position.y, 0) / mains.length;
  const mz = mains.reduce((a, c) => a + c.position.z, 0) / mains.length;
  // 機首上げθで y cosθ − z sinθ が等しくなる角度
  const dz = mz - tail.position.z;
  model._tailRest = Math.abs(dz) < 1e-6 ? 0
    : Math.atan((my - tail.position.y) / dz) * 180 / Math.PI;
  return model._tailRest;
}

function apStepFull(model, state, controls, ap, spd, dt, env) {
  const plan = ap.plan;
  const say = (phase, text) => {
    if (ap.phase === phase) return;
    if (phase !== 'descent') ap.descentSpeedCapMps = 0; // 降下から出たら取り直す
    // 垂直着陸の進入から出たら、単調に下げていた速度上限を取り直す
    if (phase !== 'vtol_approach') { ap.vtolSpeedCapMps = undefined; ap.vtolAltCapM = undefined; }
    // 前進切替から出たら、そこで覚えた高さと垂直エンジンの蓋を取り直す
    if (phase !== 'vtol_transition') { ap.vtolTransAltM = undefined; ap.vtolWean = undefined; }
    // 垂直降下から出たら、覚えた風の傾きと「降りられない」時間を取り直す
    if (phase !== 'vtol_descent') { ap.vtolWindPitch = undefined; ap.vtolWindBank = undefined; ap.vtolLowSec = 0; }
    if (phase !== 'vtol_touchdown') ap.vtolParked = false;
    if (phase !== 'vtol_hover') ap.vtolHoverCapMps = undefined;
    if (phase !== 'vtol_hover' && phase !== 'vtol_approach') ap.vtolAccI = 0;
    ap.gndPrevHdg = undefined; // 地上の操向の積分・すべり角は段ごとに取り直す
    if (phase !== 'approach') { ap.apprThr = undefined; ap.apprFlapMax = undefined; }
    // やり直すときは、FAFへまっすぐ戻るか入口を経由するかを決め直す
    if (phase === 'goaround') { ap.navMode = undefined; ap.gaThr = undefined; }
    ap.phase = phase;
    ap.statusText = text;
    if (env && env.announce) env.announce('自動操縦：' + text);
  };

  controls.parkingBrake = false;
  // 減速装置は「使う段が毎フレーム入れ直す」ことにする。段をまたいだときに
  // 前の段の指示が残っていると、たとえば進入で立てたスポイラーがやり直しの
  // 上昇にそのまま付いてくる。
  controls.spoiler = 0;
  controls.reverse = 0;

  // エンジングループの入り切り。速い段では速いグループも点け、降りる段では
  // 遅いグループだけに戻す（apManageEngineGroups）。
  apManageEngineGroups(model, state, controls, ap, spd, dt, env);

  // 目的地までの距離（進入計画があれば最終進入開始点まで）。
  // 最終進入開始点へ回りきれない向きから来るときは、中心線を延ばした入口を経由する
  // （apApproachNavTarget）。そのときの距離は入口を通る道のり。
  // 垂直着陸は中心線に乗る必要が無いので、まっすぐ向かう。
  const navT = plan
    ? apApproachNavTarget(plan, state, ap, spd, !!(ap.vtolLanding && model.hasVtol), model) : null;
  const tx = navT ? navT.x : state.position.x;
  const tz = navT ? navT.z : state.position.z;
  const distFaf = navT ? navT.distM : 0;
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
  // 目的地の方位。よける向きを探すのに要る（apTerrainDodgeDeg）ので、
  // nav() より先に出しておく。
  const bearingToGo = plan
    ? apBearingTo(state.position.x, state.position.z, tx, tz) : undefined;
  const terrain = apUpdateTerrainFloor(state, ap, env, dt, distTouchdown, spd, bearingToGo);
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
  const terrainPushing = terrain.rising && terrain.vsNeed > apVsLimits(state, spd).up;
  const terrainPitchMax = () => (terrainPushing ? AP_TERRAIN_PITCH_MAX : undefined);

  // ---- 垂直着陸へ切り替える距離 -------------------------------------------------
  // 滑走路へ降りる進入は「最終進入開始点(FAF)まで2.5km」で切り替えていたが、
  // 垂直着陸に要るのは中心線ではなく**着地点の真上で止まること**で、止まるのに
  // 要る距離は速度の2乗で伸びる。FAFは滑走路末端の9km手前にあるので、FAFで
  // 測ると速い機体は止まる場所を何kmも通り過ぎてから切り替わっていた
  // （AP_VTOL_STOP_AGL_M の説明にある実測）。着地点までの距離で、
  // 「いまの速度から止まれる距離＋余裕」まで詰まったところで切り替える。
  // **切り替えていい距離には上限を置く**。止まるのに要る距離は速度の2乗で
  // 伸びるので、マッハ20で巡航する機体だと8,750kmぶんになり、2,877kmの
  // 路線では離陸81秒後に「もう最終進入」と言い出した（実測）。速度を巡航から
  // 進入まで落とすのは降下の段の仕事で、垂直着陸の段が受け持つのは
  // 「進入速度から静止まで」だけ。その手前までは降下に任せる。
  if (plan && ap.vtolLanding && model.hasVtol
      && (ap.phase === 'cruise' || ap.phase === 'descent')) {
    const padM = Math.hypot(state.position.x - plan.pad.x,
      state.position.z - plan.pad.z);
    const brakeM = (state.groundSpeed * state.groundSpeed)
      / (2 * apVtolBrakeDecel(model, controls));
    if (padM < Math.min(brakeM + AP_VTOL_STOP_MARGIN_M, AP_VTOL_STOP_MAX_M)) {
      say('vtol_approach', '最終進入（垂直着陸）');
    }
  }

  // ---- 垂直離陸：真上へ上がる -------------------------------------------------
  if (ap.phase === 'vtol_takeoff') {
    if (ap.departElevM === undefined) ap.departElevM = state.altitudeM - state.altitudeAglM;
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
    controls.vtolThrottle = apVtolThrottleForVs(controls, state.verticalSpeed, AP_VTOL_CLIMB_MPS, dt, ap);
    if (state.altitudeAglM > AP_VTOL_TRANSITION_AGL_M) say('vtol_transition', '前進エンジンへ切替');
    return;
  }

  // ---- 垂直離陸：前へ進むエンジンへ切り替えて加速 -------------------------------
  //
  // **速度が乗るまで、向きは変えない。高さは垂直エンジンで保つ。**
  // ここは切り替えた瞬間から目的地の方角へ舵を当てていて、垂直エンジンの出力も
  // 「速度に比例して手放す」開ループだった。そのせいで、
  //   (1) ほぼ止まっている機体がいきなりバンクする。翼はまだ効かないので、
  //       傾くのは垂直エンジンの推力の向きだけ——支えを横へ逃がすことになる
  //   (2) 支えを失ったぶん沈むが、出力は速度だけで決まっているので戻らない
  // 実測（サンダーバード1号を、目的地が真後ろになる向きで垂直離陸）で、
  // 切り替えた13秒に19ktでバンクが-5°→-30°まで入り、迎角-31°、対地41mから
  // **-8m（地面の下）まで落ちた**。「垂直上昇のあと、旋回はおろか上昇もままならない
  // 速度で曲がろうとして墜ちる」の正体がこれ。
  // 離陸の向きのまま、翼が支えられる速さになるまでまっすぐ加速する。旋回は
  // 上昇の段（climb）に渡してから。
  if (ap.phase === 'vtol_transition') {
    controls.gearDown = false;
    controls.flap = 0;
    // 翼がどれだけ支えているか（失速速度の1.2倍で1.0）
    const wing = apClamp(state.airspeed / Math.max(spd.stall * 1.2, 1), 0, 1);
    ap.targetHeadingDeg = ap.takeoffHeadingDeg;
    controls.roll = apAileronForBank(state, 0, spd);
    // 遅いうちは方位を保ち（姿勢制御ノズルが拾う）、速くなったら横滑りを消すほうへ
    const hold = apClamp(apWrap180(ap.takeoffHeadingDeg - state.headingDeg) * AP_STEER_KP, -1, 1);
    controls.yaw = hold * (1 - wing) + apRudderForCoordination(state) * wing;

    // 前へ進む出力は、加速が重さの AP_VTOL_TRANS_ACCEL_G 倍に収まるところまで。
    // 全開にしていたので、推力が重さの325倍あるサンダーバード1号は切り替えた0.75秒で
    // 1271ktに達し、翼が支えを引き受ける前に「速すぎるので渡す」抜け道に入って
    // 垂直エンジンを対地60mで一度に切り、機首が少し下がったまま7000ktで地面に突っ込んだ。
    // 推力は「抗力＋重さの AP_VTOL_TRANS_ACCEL_G 倍」を、はしごを踏まえたレバーに直して出す
    // （apLeverForThrustN。比例で解くと、遅いグループの小さいエンジンにしか届かない）。
    controls.throttle = apLeverForThrustN(model, controls,
      AP_VTOL_TRANS_ACCEL_G * model.massKg * FLIGHT_GRAVITY + apDragEstimateN(model, state.airspeed, state.altitudeM),
      state.airspeed, state.altitudeM);
    // 高さは**そのときの高度を目標にした輪で**保つ。
    // 「昇降率3m/sぶんの姿勢」を開ループで指示していたので、垂直エンジンを
    // 抜きはじめて沈んでも、指示ピッチは+1°のまま動かなかった——迎角が足りず
    // 翼は仕事をせず、そのまま落ちていく（実測で対地114m→-8m、-27m/s）。
    // 高度のずれから昇降率を出せば、沈んだぶんだけ機首が上がって翼が引き受ける。
    if (ap.vtolTransAltM === undefined) ap.vtolTransAltM = state.altitudeM;
    const transAlt = overTerrain(ap.vtolTransAltM + AP_VTOL_TRANS_CLIMB_M);
    ap.vsCmd = overTerrainVs(apVsForAltitude(state, transAlt, apClimbCap(state, spd), undefined, spd));
    // **翼が支えられる速さになったら、垂直エンジンを時間をかけて抜く。**
    // 昇降率の輪は「ずれ」で動くので、垂直エンジンが釣り合わせているかぎり
    // ずれは0のまま——放っておくと100%のまま速度だけが伸びていき、
    // 翼はいつまでも仕事をしない（実測で、583ktまで垂直エンジン100%のままだった）。
    // 上から蓋をして少しずつ下ろすと、そのぶんを翼が引き受けにいく。
    ap.vtolWean = wing >= 1
      ? Math.max((ap.vtolWean === undefined ? 1 : ap.vtolWean) - dt / AP_VTOL_WEAN_S, 0)
      : 1;
    controls.vtolThrottle = Math.min(
      apVtolSupport(model, state, controls, ap, spd, ap.vsCmd, dt), ap.vtolWean);
    // 姿勢は、遅いうちは機首下げ（加速を助ける）、翼が効きだしたら
    // **「その昇降率を出すための姿勢」**へ移す。
    // 機首下げのままだと迎角が負のままで、翼はいつまでも揚力を出さない
    // ——垂直エンジンだけが支え続けることになる。
    const want2 = -6 * (1 - wing)
      + apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()) * wing;
    controls.pitch = apElevatorForPitch(state, controls, want2, dt, spd, ap);
    ap.targetSpeedMps = spd.climb;

    // **渡すのは、翼がもう自分で支えているとき**。速度だけで渡してはいけない。
    // 上昇速度に届いた瞬間に垂直エンジンを切っていたので、そのときまだ
    // 93%出していた支えが一度に消えて、そのぶんを落ちていた——実測で、
    // 渡した直後に対地118mから**-8m（地面の下）**まで7秒で沈み、-23m/sで
    // 地面をこすった。垂直エンジンの出力が自然に抜けきるまで待てば、
    // 支えの受け渡しは途切れない。
    // 速度が出すぎているのに抜けないときのための抜け道も用意しておく。
    const handOff = controls.vtolThrottle <= 0.05 && state.verticalSpeed > -0.5;
    if ((state.airspeed >= spd.climb && handOff)
      || state.airspeed >= spd.climb * 1.6) {
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
    // 滑走中は全開のまま。浮いたあとは**上昇の段と同じ基準**（曲がれる速さの1.5倍）で
    // 頭打ちにする。以前は「上昇の速度」を超えたら絞っていたが、浮いた時点で
    // たいてい上昇の速度を超えている（引き起こしの速度のほうが速い機体が多い）ので、
    // 浮いた瞬間に出力を落とし、上昇の段に渡ったとたん全開へ戻していた——
    // 「自動操縦で離陸するとき、一瞬エンジンの出力を弱める」の正体。
    // 実測で、浮いてから1秒以内に三式戦闘機・TB1・TB2が0%、Concordeが67%まで落ちていた。
    // 桁外れな機体の加速は上昇の段と同じく 1.5倍 で止まる。
    const over = state.airspeed - spd.cruise * 1.5;
    controls.throttle = (state.onGround || over <= 0) ? 1
      : apClamp(1 - over * 0.1, 0, 1);
    controls.brake = 0;
    controls.gearDown = true;
    // 滑走路の中心線を保つ（apGroundSteer）。中心線は、離陸を始めた位置を通る
    // 離陸方位の線。浮いたあとは、ラダーは横滑りを消すほうへ戻し、補助翼で
    // 滑走路の延長線を追う（翼を水平に保つだけだと、横風でそのまま流される）。
    if (ap.takeoffOrigin === undefined) {
      ap.takeoffOrigin = { x: state.position.x, z: state.position.z };
    }
    if (ap.departElevM === undefined) ap.departElevM = state.altitudeM - state.altitudeAglM;
    const toCross = apCrossFromLine(state, ap.takeoffOrigin.x, ap.takeoffOrigin.z, ap.takeoffHeadingDeg);
    if (state.onGround) {
      controls.yaw = apGroundSteer(state, ap, ap.takeoffHeadingDeg, toCross, dt);
      controls.roll = apAileronForBank(state, 0, spd);
    } else {
      controls.yaw = apRudderYawDamped(state);
      controls.roll = apAileronForTrack(state, ap.takeoffHeadingDeg
        + apClamp(-toCross * 0.1, -15, 15), 10, spd);
    }
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
    // 越えられない山があれば、目的地の方位から振ってよける（apTerrainDodgeDeg）。
    let want = (bearingToGo === undefined ? state.headingDeg : bearingToGo)
      + terrain.dodgeDeg;
    // **離陸したら、高さが取れるまで滑走路の向きのまま登る。** 対地300mで旋回の上限が
    // いっぱいになっていたので、上昇の速い機体は浮いた直後に目的地へ倒し込んでいた——
    // 実測でサンダーバード1号が浮いて3秒後（対地300m・8000kt）にバンク84°まで入り、
    // 「自動で離陸した瞬間に自分から進路を曲げる」に見えていた。
    // 目標高度の4割（450〜1500m）までは滑走路の延長線に沿い、そこから1.6倍の高さまでに
    // 旋回の上限を少しずつ戻す。山をよけるとき（dodgeDeg）はこれより優先する。
    let turnFactor = 1;
    // 上昇の段だけでなく巡航にも掛ける。速すぎる機体は、運動エネルギーだけで目標高度に
    // 届く見込みが立つと対地400mでもう巡航の段へ移り、そこで倒し込んでいた。
    if ((ap.phase === 'climb' || ap.phase === 'cruise') && ap.takeoffHeadingDeg !== undefined
      && !terrain.dodgeDeg && !ap.takeoffTurnDone) {
      // 出発した地面の高さ（途中から入れたときは、いまの地面）から上がった高さで測る
      const depElev = ap.departElevM !== undefined ? ap.departElevM : state.altitudeM - state.altitudeAglM;
      const span = Math.max(ap.targetAltitudeM - depElev, 0);
      const turnH = Math.min(apClamp(AP_TAKEOFF_TURN_FRAC * span, AP_TAKEOFF_TURN_MIN_M, AP_TAKEOFF_TURN_MAX_M),
        span * AP_TAKEOFF_TURN_SPAN_MAX);
      const byHeight = turnH > 1
        ? apClamp((state.altitudeM - depElev - turnH) / (turnH * (AP_TAKEOFF_TURN_RAMP - 1)), 0, 1) : 1;
      ap.departSec = (ap.departSec || 0) + dt;
      const byTime = apClamp((ap.departSec - AP_TAKEOFF_TURN_WAIT_S) / AP_TAKEOFF_TURN_RAMP_S, 0, 1);
      turnFactor = Math.max(byHeight, byTime);
      if (turnFactor <= 0) want = ap.takeoffHeadingDeg;
      // 一度上がりきったら、あとで沈んでも（山越えなどで）まっすぐに戻さない
      if (turnFactor >= 1) ap.takeoffTurnDone = true;
    }
    ap.targetHeadingDeg = (want + 360) % 360;
    // 対地高度が低いうちは浅く（apBankAglFactor）、地形を越えるのに昇降率が
    // 要るときも浅く（apBankClimbFactor）——登るほうを旋回より優先する。
    // 深く倒すのは速度に余裕があるときだけ（AP_BANK_ENERGY_K0 の説明を参照）
    const kStall = state.airspeed / Math.max(spd.stall, 1);
    const bankCap = Math.min(spd.bankMax, AP_BANK_MAX + Math.max(spd.bankMax - AP_BANK_MAX, 0)
      * apClamp((kStall - AP_BANK_ENERGY_K0) / (AP_BANK_ENERGY_K1 - AP_BANK_ENERGY_K0), 0, 1));
    const bankLim = bankCap * apBankAglFactor(state) * apBankClimbFactor(state, terrain.vsNeed, spd)
      * Math.max(turnFactor, 0.02) * apBankSinkFactor(state, ap) * apBankRiseFactor(state, ap);
    controls.roll = apAileronForTrackNav(state, want, bankLim, spd);
    // 上昇の段はヨーダンパーも掛ける（離陸の直後の首振りを持ち越さない）
    controls.yaw = ap.phase === 'climb' ? apRudderYawDamped(state) : apRudderForCoordination(state);
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
    // さらに**推力は重さの AP_CLIMB_THRUST_MAX_W 倍まで**。上の二つはどちらも「速すぎたら
    // 絞る」後追いなので、推力が重さの325倍あるサンダーバード1号では、上限を下回った
    // 1フレームの全開だけで秒速50m以上伸びる。垂直離陸から上昇の段に渡った474ktが
    // 1.5秒で3018ktになり、機首を下げきれないまま高度100km超まで上がっていった。
    // 推力重量比がこれより小さいふつうの機体には効かない。
    controls.throttle = Math.min(Math.max(overspeedCut, sinkUrgency), apAirThrottleCap(model, state, controls));
    // 山に追われているあいだは姿勢の頭打ちも上げる。上昇の姿勢は「上昇速度を
    // 保つところまで」で自分から止まるので、上限を上げても速度は割らない
    // （出せない機体は、上げたところで速度が落ちて勝手に戻る）。
    // 「床より低い」で見てはいけない——平らな地面でも離陸直後は余裕300mの
    // 床より低いので、ふつうの離陸がぜんぶ急上昇になってしまう。
    const pitchMax = terrainPushing ? AP_TERRAIN_PITCH_MAX : AP_PITCH_MAX;
    // 上昇の指示ピッチは「いまの姿勢＋速度のずれ」で出す——姿勢そのものを
    // 積み上げる形なので、機体ごとに違う「上昇速度で釣り合う姿勢」を測らずに
    // 済む。ただし**積分だけでは必ず振動する**。姿勢を上げる→速度が落ちる→
    // 指示が下がる→速度が戻る→また上がる、が止まらない（実測で、内蔵の練習機が
    // 上昇中ずっとピッチ3°⇔18°・昇降率0⇔8m/sを40秒周期で往復していた）。
    // 速度の変化（加速度）で減衰させる——速すぎても減速中ならもう上げない。
    if (ap.climbLastV !== undefined && dt > 0) {
      const raw = (state.airspeed - ap.climbLastV) / dt;
      ap.climbAccel = (ap.climbAccel || 0)
        + (raw - (ap.climbAccel || 0)) * apClamp(dt / AP_CLIMB_ACCEL_TAU, 0, 1);
    }
    ap.climbLastV = state.airspeed;
    // **空気が薄いほど、速度のずれで姿勢を動かす量を絞る**。薄い空気では姿勢を変えても経路
    // （＝速度）が付いてくるのが遅れるので、海面と同じ強さで動かすと行って来いが育つ——
    // 実測でConcordeが高度7,000m付近で、姿勢±12°・舵を端から端まで振る揺れに入り、
    // 失速して裏返った。密度の比で割り引けば、海面近くはこれまでと変わらない。
    const sigma = typeof airDensityAt === 'function' ? apClamp(airDensityAt(state.altitudeM) / 1.225, 0.1, 1) : 1;
    const want = apClamp(state.pitchDeg + ((state.airspeed - spd.climb) * AP_CLIMB_SPEED_KP
      + (ap.climbAccel || 0) * AP_CLIMB_SPEED_KD) * sigma, 0, pitchMax);
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
    // **巡航が地形で上昇へ送り返す帯の中で、巡航へ渡してはいけない**。
    // 巡航は floorM > 高度 + AP_TERRAIN_CLIMB_BACK_M(60m) なら上昇へ戻すので、
    // こちらが floorM - levelAhead で渡すと、
    //   floorM - levelAhead < 高度 < floorM - 60m
    // の帯では両方が同時に成り立ち、**毎フレーム上昇と巡航を往復する**。
    // levelAhead は昇降率 ÷ AP_VS_KP なので、毎秒6mより速く上っていれば
    // この帯は必ず生まれる（地形の床が目標高度より高いとき）。
    // 実際、上昇の姿勢を試しに絞ったときにConcordeがこの帯に入り、
    // 113秒から6000秒まで往復し続けて降下も進入も始まらなかった。
    // 地形の床は、送り返される余裕のぶんだけ上で渡す。
    const handOver = Math.max(ap.targetAltitudeM - levelAhead,
      floorM + AP_TERRAIN_CLIMB_BACK_M);
    // **離陸してまっすぐ登っているあいだは、目標の手前60mまで巡航へ渡さない。**
    // 上昇の速い機体は levelAhead が何kmにもなり（サンダーバード1号は毎秒249mで2.5km）、
    // 対地400mで巡航へ渡っていた。巡航は高度のずれで昇降率を決めるので、渡った直後に
    // 出力の変化で機首が下がっても戻しきれず、対地176mまで沈んだ。上昇の段は
    // 速度を姿勢で使うので、速すぎる機体はそのまま機首を上げて高さに変える。
    const straightOut = ap.takeoffHeadingDeg !== undefined && !ap.takeoffTurnDone;
    if (state.altitudeM > (straightOut ? Math.max(handOver, ap.targetAltitudeM - 60) : handOver)) {
      say('cruise', '巡航'); return;
    }

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
    // 入口を経由しているときは、入口に着くまでに落とせる速さまで（apApproachNavTarget）
    const cruiseV = ap.entrySpeedLimitMps > 0 ? Math.min(spd.cruise, ap.entrySpeedLimitMps) : spd.cruise;
    ap.targetSpeedMps = cruiseV;
    // **目標高度より低いのに沈んでいるときは、速度超過中でも出力を残す**。
    // 出力は「巡航速度を保つぶん」だけで決めていたので、上のズームクライム
    // （climbの項を参照）がエネルギー切れで沈みに転じたあとにこの段へ
    // 来ても、速度がまだ巡航の1.5倍を超えているというだけで出力0%が続き、
    // 高度を全部失って墜落していた（実測、目標高度12000mに対し対地3500m付近で
    // 頭打ちになったあとそのまま墜落）。沈み方に応じて滑らかに出力を戻す
    // ——二値の切り替えだと、沈み方がしきい値をまたぐたびに出力が飛んで
    // 昇降そのものが暴れる。
    const belowTarget = state.altitudeM < overTerrain(ap.targetAltitudeM);
    let sinkUrgency = belowTarget
      ? apClamp(-state.verticalSpeed / AP_CRUISE_SINK_URGENCY_MPS, 0, 1) : 0;
    // 入口へ向けて減速しているのに速すぎるあいだは、沈んでも出力では戻さない（姿勢で戻す）。
    // 入口のまわりで深く傾けると沈むので、そこで全開にしてしまい、推力重量比325の
    // TB1が6,000ktまで加速して入口のまわりを何十kmもの輪で回り続けた。
    if (ap.entrySpeedLimitMps > 0 && state.airspeed > cruiseV * 1.05) sinkUrgency = 0;
    // 推力の上限は上昇の段と同じ（apAirThrottleCap）
    controls.throttle = Math.min(Math.max(apThrottleForSpeed(state, controls, cruiseV, dt), sinkUrgency),
      apAirThrottleCap(model, state, controls));
    // 目標より速いぶんはスポイラーで落とす（降下と同じ）。入口へ向かうときだけにしていたので、
    // 推力の桁外れな機体が上昇で目標の何倍にも加速したまま巡航に入ると、抗力だけでは
    // 落ちきらず、速いまま降下へ持ち込んでいた。ただし巡航が短い路線では効く間がない
    // （TB1で60km先の空港へは巡航が2秒しかなく、降下開始1051kt・進入開始663ktのまま）。
    if (!terrainPushing) {
      controls.spoiler = apSpoilerCommand(model, controls, state, cruiseV, 0);
    }
    ap.vsCmd = overTerrainVs(apVsForAltitude(state, overTerrain(ap.targetAltitudeM), apClimbCap(state, spd), undefined, spd));
    // 旋回中はバンクのぶん機首を上げる（apTurnPitchComp、高度維持と同じ）。深く倒すようになって、
    // 無しでは速い機体が90°旋回で202m沈んだ（入れて34m）。ただし速い機体ほど1Gに要る迎角は小さいので、
    // 舵の効き（apSurfaceGain）の平方根で割り引く——そのまま足すとTB1がマッハ9で機首を12°上げて
    // 3,318mまで上がり、旋回に176秒かかった。
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()) + apTurnPitchComp(state.rollDeg) * Math.sqrt(apSurfaceGain(state, spd)), dt, spd, ap);
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
    // 入口を回っているあいだは、旋回半径を見積もった速さまで落とす
    if (ap.entrySpeedLimitMps > 0) ap.targetSpeedMps = Math.min(ap.targetSpeedMps, ap.entrySpeedLimitMps);
    controls.throttle = Math.min(apThrottleForSpeed(state, controls, ap.targetSpeedMps, dt),
      apAirThrottleCap(model, state, controls));
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
    // 出力を絞ってもまだ速い／まだ高いぶんだけスポイラーを立てる。
    // 脚と同じ「降りることと減速することを姿勢の取り合いにしない」ための道具で、
    // 脚より効きが大きく、引っ込めるのも速い。
    // **山に押されているあいだは立てない**。進入の段と同じ理由で、越えるための
    // 揚力を自分で削ってしまう（出力を切るのと同じ）。速度超過だけを見ていると、
    // 山越えで機首を上げて速度が余っている場面がまさにこれに当たる。
    controls.spoiler = terrainPushing ? 0 : apSpoilerCommand(model, controls, state,
      ap.targetSpeedMps, state.altitudeM - wantAlt);
    // 目標が巡航高度で頭打ちのあいだは、まだ坂に乗っていない＝前送りは要らない
    const onSlope = wantAlt < ap.targetAltitudeM - 1;
    ap.vsCmd = overTerrainVs(apVsForPath(state, wantAlt, onSlope ? AP_DESCENT_SLOPE : 0, apClimbCap(state, spd), spd));
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()) + apTurnPitchComp(state.rollDeg) * Math.sqrt(apSurfaceGain(state, spd)), dt, spd, ap);
    if (distFaf < 2500) {
      if (ap.vtolLanding && model.hasVtol) say('vtol_approach', '最終進入（垂直着陸）');
      // 滑走路の向きを向いていなければ、最終進入に入らず入口からやり直す
      else if (apAlignedForFinal(plan, state)) say('approach', '最終進入');
      else say('goaround', 'やり直し（滑走路の向きに回りきれない）');
    }
    return;
  }

  // ---- 垂直着陸：着地点の上空へ寄せる（滑走路は要らないので中心線は気にしない） -----
  if (ap.phase === 'vtol_approach') {
    const want = apBearingTo(state.position.x, state.position.z, plan.pad.x, plan.pad.z);
    ap.targetHeadingDeg = want;
    controls.roll = apAileronForTrackNav(state, want, spd.bankMax, spd);
    controls.yaw = apRudderForCoordination(state);

    const distToTouchdown = Math.hypot(
      state.position.x - plan.pad.x, state.position.z - plan.pad.z);
    ap.distanceM = distToTouchdown;

    controls.gearDown = true;
    controls.flap = 1;

    // 高さは**着地点までの距離で決める**。「対地200mへ降りろ」とだけ言うと、
    // 止まるのに要る距離（速い機体では17km）の手前から一気に落ちにいく——
    // 実測で沈下率-33m/sの突っ込みになり、位置エネルギーが速度に変わるので
    // 減速とも喧嘩した。滑走路の進入と同じ3°の坂を、着地点の上空200mへ
    // 引いてやれば、遠いうちは高く、近づくほど低く、着いたところで200mになる。
    //
    // **上げ直さない**。切り替えた時点ですでに坂より下にいると（滑走路の進入と
    // 同じ降下をしてきたあとなので、よくある）、坂に戻ろうとして登りにいく——
    // 実測で+22m/sのズームクライムになり、垂直エンジンが100%に張り付いたまま
    // 高度と速度が振れ続けた。入った高さを天井として持つ。
    const stopAltM = plan.elevationM + AP_VTOL_STOP_AGL_M;
    if (ap.vtolAltCapM === undefined) ap.vtolAltCapM = Math.max(state.altitudeM, stopAltM);
    const hoverAltM = Math.max(stopAltM, Math.min(
      stopAltM + distToTouchdown * AP_DESCENT_SLOPE,
      ap.vtolAltCapM, ap.targetAltitudeM));
    // **垂直着陸の進入も地形を見る**。ここだけ overTerrain/overTerrainVs が
    // 抜けていたので、着地点の手前に山があると、ホバーの高さへ
    // まっすぐ降りながら山へ突っ込めた。滑走路を使う進入（approach）と
    // 同じだけ地形は避けなければいけない。
    ap.vsCmd = overTerrainVs(apVsForAltitude(state, overTerrain(hoverAltM), apClimbCap(state, spd), undefined, spd));
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()), dt, spd, ap);

    // **残りの距離で止まりきる速度を目標にする**。以前はここが進入速度の
    // 据え置きで、止まる算段がどこにも無かった（AP_VTOL_STOP_AGL_M の説明）。
    //   v = √(2 · 減速度 · 残り距離)
    const vForDist = Math.min(spd.approach, apVtolPadSpeed(model, controls, distToTouchdown));
    // **一度下げた目標は上げない**。距離だけで決めると、行き過ぎたとたんに
    // 「まだ遠いから速くていい」に戻って加速しなおす——着地点の周りを
    // 速いまま行ったり来たりすることになる。降下の速度上限（descentSpeedCapMps）
    // と同じ考え方で、単調に落ちていく上限として持つ。
    ap.vtolSpeedCapMps = ap.vtolSpeedCapMps === undefined
      ? vForDist : Math.min(ap.vtolSpeedCapMps, vForDist);
    ap.targetSpeedMps = ap.vtolSpeedCapMps;
    controls.spoiler = terrainPushing ? 0
      : apSpoilerCommand(model, controls, state, ap.targetSpeedMps, 0);
    // 翼が支えきれなくなるぶんは垂直エンジンへ移す
    controls.vtolThrottle = apVtolSupport(model, state, controls, ap, spd, ap.vsCmd, dt);
    // 速さは、速すぎれば逆噴射（垂直着陸用の機体だけが空中で開ける。10-flight.js の revLever）、
    // 遅すぎればメインエンジンで（apVtolAlongSpeed。見積もりの逆噴射を決め打ちで当てると減速が足りなかった）
    apVtolAlongSpeed(model, state, controls, ap, ap.targetSpeedMps, state.airspeed, dt);

    // **翼が支えを失ったらホバリングへ**。距離だけで切り替えると、止まりきる前に
    // 着地点の真上へ来た機体がそのまま通り過ぎ、ホバーの傾き（±10°）では
    // 止められずに裏返っていた（実測でバンク-108°、地面に-19mまで潜った）。
    // 遅くなっていればまだ遠くてもホバリングのほうが素直に寄せられる。
    // 速さは **velocity からも見る**。state.airspeed は物理を1回まわして
    // はじめて入るので、飛行中の状態を組み立てて途中の段から始めたとき
    // （試験や再開）には0のまま——157ktで進入しているのに「もう止まっている」と
    // 判断して、着地点の25km手前でホバリングに入っていた。
    const vNow = Math.max(state.airspeed, state.velocity.length());
    if (distToTouchdown < AP_VTOL_STOP_RADIUS_M || vNow < spd.stall * 0.9) {
      say('vtol_hover', 'ホバリング（着地点上空）');
    }
    return;
  }

  // ---- 垂直着陸：着地点の真上で、対地200mに静止する ------------------------------
  // 「降りながら止まる」を一段に混ぜると、止まりきる前に地面へ届いてしまう。
  // 高さを保ったまま先に止めて、止まってから降ろす——このほうが機体の速さに
  // 関係なく同じ手順になる。
  if (ap.phase === 'vtol_hover') {
    controls.gearDown = true;
    controls.flap = 1;

    const distToTouchdown = Math.hypot(
      state.position.x - plan.pad.x, state.position.z - plan.pad.z);
    ap.distanceM = distToTouchdown;
    const slowFrac = apClamp(1 - state.airspeed / Math.max(spd.stall, 1), 0, 1);
    // 着地点へ向かう向きと、機首の向きに沿った前後の距離・速さ（前が＋）
    const bearingPad = apBearingTo(state.position.x, state.position.z, plan.pad.x, plan.pad.z);
    const hf = apForward(state.headingDeg);
    const dAlong = (plan.pad.x - state.position.x) * hf.x + (plan.pad.z - state.position.z) * hf.z;
    const vFwd = state.velocity.x * hf.x + state.velocity.z * hf.z;
    // **着地点のすぐ近くまで、前後はエンジンと機首の上げ下げで寄せる**（apVtolAlongSpeed）。
    // 以前はここで前進エンジンを切り、機体を傾けるだけ（10°まで）で寄せていたので遅く、
    // 着地点を通り過ぎてから機首を上げて戻っていた。前へはメインエンジン、止まるのは逆噴射と
    // 機首上げ（推力を後ろへ傾ける）、後ろへ戻るのは機首上げ。着地点のすぐ上（AP_VTOL_FINE_M）まで
    // 来たら、傾けて合わせる仕掛け（apVtolHoverAngles）に任せる。
    const fine = distToTouchdown < AP_VTOL_FINE_M;
    const tiltMaxDeg = AP_VTOL_TILT_MAX * slowFrac;
    if (!fine) {
      // 前後：残りの距離で止まりきれる速さ（逆噴射を持たない機体もあるので、機首を上げて推力を後ろへ
      // 傾けるぶんも減速に見込む）。上限は AP_VTOL_CREEP_MAX_MPS と入ってきた速さ。後ろへは傾きだけで戻る
      const tiltDecel = FLIGHT_GRAVITY * Math.tan(tiltMaxDeg * Math.PI / 180);
      if (ap.vtolHoverCapMps === undefined) ap.vtolHoverCapMps = Math.max(vFwd, AP_VTOL_CREEP_MAX_MPS);
      let vWant = Math.min(apVtolPadSpeed(model, controls, Math.abs(dAlong), tiltDecel, AP_VTOL_FINE_M), ap.vtolHoverCapMps);
      ap.vtolHoverCapMps = Math.max(Math.min(ap.vtolHoverCapMps, Math.max(vWant, AP_VTOL_CREEP_MAX_MPS)), 0);
      if (dAlong < 0) vWant = -Math.min(vWant, AP_VTOL_BACK_MAX_MPS);
      // **押すのは機首が着地点を向いているときだけ**（遠いとき）。メインエンジンは機首の向きにしか
      // 押せないので、向きがずれたまま押すと着地点から離れていく（実測で、着地点を背にしてホバリングに
      // 入った機体が、機首を回しながら押し続けて輪を描き、342ktまで加速して50km先へ飛んでいった）。
      const errPad = apWrap180(bearingPad - state.headingDeg);
      const turnToPad = distToTouchdown > AP_VTOL_TURN_TO_PAD_M;
      if (turnToPad) {
        const face = apClamp((Math.cos(errPad * Math.PI / 180) - Math.cos(AP_VTOL_FACE_DEG * Math.PI / 180))
          / (1 - Math.cos(AP_VTOL_FACE_DEG * Math.PI / 180)), 0, 1);
        vWant = Math.max(vWant, 0) * face;
      }
      ap.targetSpeedMps = vWant;
      const cmd = apVtolAlongSpeed(model, state, controls, ap, vWant, vFwd, dt);
      // 逆噴射で足りない減速（と後ろへ戻るぶん）は、機首を上げて推力を後ろへ傾けて出す（遅いほど深く。最大10°）
      const noseUp = apClamp(Math.atan(cmd.brakeShort / FLIGHT_GRAVITY) * 180 / Math.PI, 0, tiltMaxDeg);
      // 横：着地点への線からのずれを、傾きで詰める（apVtolHoverAngles の横の成分）
      const hover = apVtolHoverAngles(state, plan.pad.x, plan.pad.z, tiltMaxDeg, ap);
      controls.pitch = apElevatorForPitch(state, controls, noseUp, dt, spd, ap);
      controls.roll = apAileronForBank(state, hover.wantBankDeg, spd);
      // 機首：遠ければ着地点へ回す（遅いほど強く。速いうちは横滑りを消すだけ）。近ければそのまま
      const yawToPad = turnToPad ? apClamp(errPad * AP_VTOL_HOVER_YAW_KP, -0.5, 0.5) : 0;
      controls.yaw = yawToPad * slowFrac + apRudderForCoordination(state) * (1 - slowFrac);
    } else {
      controls.throttle = 0;
      ap.vtolAccI = 0;
      // 位置と速度は機体の傾きで詰める（垂直降下と同じ仕掛け）。
      // **傾けていい角度は、失速速度をどれだけ下回っているかで決める**。
      // ホバーの傾きは「推力の向きを変えて水平に動く」ための道具で、翼が生きて
      // いる速度でやると翼のほうが強い——実測で、まだ278ktある機体に10°の
      // 指示を出したとたんバンク95°・ピッチ-33°まで持っていかれ、対地16mまで
      // 落ちて34.4Gを記録した。速いうちは水平のまま逆噴射で削り、遅くなるほど
      // 傾けられるようにする。
      const hover = apVtolHoverAngles(state, plan.pad.x, plan.pad.z,
        AP_VTOL_TILT_MAX * slowFrac, ap);
      controls.pitch = apElevatorForPitch(state, controls, hover.wantPitchDeg, dt, spd, ap);
      controls.roll = apAileronForBank(state, hover.wantBankDeg, spd);
      // **機首の向きを合わせるのも、止まってから**。垂直降下と同じ式
      // （方位のずれ×AP_STEER_KP）をそのまま使っていたが、あれは前輪の操舵用で
      // 20°ずれれば舵一杯になる。ホバリングに入った瞬間の機首は着地点のほうを
      // 向いていて滑走路の方位とは何十度も違うから、246ktの機体がいきなり
      // ラダー一杯を当てることになり、横滑り11°から横転していった——実測で
      // バンクが4°→-79°まで流れ、そのまま地面へ落ちた。速いうちは横滑りを
      // 消すだけにして、遅くなるほど方位合わせに移す。
      const yawHold = apClamp(apWrap180(plan.heading - state.headingDeg)
        * AP_VTOL_HOVER_YAW_KP, -0.5, 0.5);
      controls.yaw = yawHold * slowFrac + apRudderForCoordination(state) * (1 - slowFrac);
      // 残った前進速度は逆噴射で殺す。**前へ進んでいるあいだだけ**——
      // apReverseCommand が見る groundSpeed は向きを持たない大きさなので、
      // 止まったあとも押し続けて機体を後ろ向きに飛ばしていた（実測で、
      // 一度7ktまで落ちたあと逆向きに48ktまで加速し、迎角180°・横滑り-120°の
      // 尻から飛ぶ姿勢で戻ってきた）。機首方向の対地速度で見る。
      const fwd = apForward(state.headingDeg);
      const vFwd = state.velocity.x * fwd.x + state.velocity.z * fwd.z;
      controls.reverse = vFwd > AP_VTOL_STOP_GS_MPS
        ? apReverseCommand(model, state, controls) : 0;
      ap.targetSpeedMps = 0;
    }

    // 高さは対地200mのまま保つ
    const hoverAltM = plan.elevationM + AP_VTOL_STOP_AGL_M;
    ap.vsCmd = apClamp((hoverAltM - state.altitudeM) * AP_VS_KP,
      -AP_VTOL_SINK_MAX, AP_VTOL_SINK_MAX);
    controls.vtolThrottle = apVtolSupport(model, state, controls, ap, spd, ap.vsCmd, dt);

    if (state.groundSpeed < AP_VTOL_STOP_GS_MPS
      && distToTouchdown < AP_VTOL_STOP_RADIUS_M) say('vtol_descent', '垂直降下');
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
    //
    // **ただし「水平」は風に逆らうのに要る傾き（ap.vtolWindPitch/Bank）を中心にする**。
    // 0°を中心に±1.5°まで絞っていたので、風の中では持ち場を保てなくなり、流されている
    // あいだは「速すぎるので降りない」ままになった——実測でサンダーバード2号（旧データ）が
    // 風8m/sの中、対地2mで対地速度8m/sのまま横へ流され続け、いつまでも接地しなかった。
    // 高いうち（傾きを絞らないところ）で指示した傾きをならしておき、それを風の傾きとする。
    const lim = AP_VTOL_TILT_MAX * apClamp(state.altitudeAglM / AP_VTOL_LEVEL_AGL_M, 0.15, 1);
    const hover = apVtolHoverAngles(state, plan.pad.x, plan.pad.z, AP_VTOL_TILT_MAX, ap);
    if (ap.vtolWindPitch === undefined) { ap.vtolWindPitch = 0; ap.vtolWindBank = 0; }
    if (state.altitudeAglM > AP_VTOL_LEVEL_AGL_M) {
      const k = 1 - Math.exp(-dt / AP_VTOL_WIND_TAU_SEC);
      const cap = AP_VTOL_TILT_MAX * AP_VTOL_WIND_TILT_FRAC;
      ap.vtolWindPitch = apClamp(ap.vtolWindPitch + (hover.wantPitchDeg - ap.vtolWindPitch) * k, -cap, cap);
      ap.vtolWindBank = apClamp(ap.vtolWindBank + (hover.wantBankDeg - ap.vtolWindBank) * k, -cap, cap);
    }
    const wantPitch = apClamp(hover.wantPitchDeg, ap.vtolWindPitch - lim, ap.vtolWindPitch + lim);
    const wantBank = apClamp(hover.wantBankDeg, ap.vtolWindBank - lim, ap.vtolWindBank + lim);
    controls.pitch = apElevatorForPitch(state, controls, wantPitch, dt, spd, ap);
    controls.roll = apAileronForBank(state, wantBank, spd);
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
    let slowEnough = apClamp(
      (AP_VTOL_DESCENT_GS_MPS - state.groundSpeed) / AP_VTOL_DESCENT_GS_MPS, 0, 1);
    // それでも地面すれすれで止まれないまま AP_VTOL_STUCK_SEC たったら、ゆっくり降ろしきる
    // （宙に浮いたまま流され続けるより、流されながらでも静かに着いたほうがいい）
    ap.vtolLowSec = state.altitudeAglM < AP_VTOL_STUCK_AGL_M && slowEnough < 0.5
      ? (ap.vtolLowSec || 0) + dt : 0;
    if (ap.vtolLowSec > AP_VTOL_STUCK_SEC) slowEnough = Math.max(slowEnough, 0.5);
    // 速く降りる（AP_VTOL_SINK_MAX）のは、前へ進む速度がほぼ止まってから。流されているうちに
    // 速く降りると、止めきる前に低いところへ着いてしまう（実測、進入157ktで入った機体が
    // 対地速度7ktのまま接地した）。止まるまでは以前どおりの AP_VTOL_SINK_SLOW まで。
    const sinkMax = AP_VTOL_SINK_SLOW + (AP_VTOL_SINK_MAX - AP_VTOL_SINK_SLOW)
      * apClamp((slowEnough - 0.8) / 0.2, 0, 1);
    const targetVs = -apClamp(state.altitudeAglM * AP_VTOL_SINK_KP, 0.3, sinkMax)
      * slowEnough;
    controls.vtolThrottle = apVtolThrottleForVs(controls, state.verticalSpeed, targetVs, dt, ap);

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
    //
    // 抜く速さは**いまの出力に対する割合**で決める。「毎秒いくら」という絶対の
    // 速さにすると、推力が桁外れな機体はホバーに6%しか使っていないので
    // 0.2秒で抜けきってしまう——片脚が着いた瞬間（機体はまだ沈みきっておらず、
    // 傾いていれば残りの脚は宙に浮いている）に支えが消え、そこから自由落下する。
    // 実測でサンダーバード2号が対地0.85mで片脚接地 → 0.18秒で推力0 → 残り0.57mを
    // -2.2m/sまで加速して落ち、静かな接地(-23fpm)のはずが9.7Gになっていた。
    // 割合で抜けば、ホバー出力がいくつの機体でも同じ時定数で沈んでいく。
    // 最後に小さい絶対値ぶんを引くのは、割合だけだと0に着かないから。
    //
    // **抜くのは、沈むのが止まってから**。接地の判定は脚が1本でも触れれば立つので、
    // 傾いた機体は「まだ0.6m浮いていて、残りの脚は宙にある」状態でも接地扱いになる。
    // そこで抜きはじめると支えが消えてそのぶんを落ちる。沈下率が静かな値より速い
    // あいだは、地面に触れていても昇降率の輪を回して受け止める。
    const v0 = controls.vtolThrottle || 0;
    const settling = state.onGround && state.verticalSpeed > -AP_VTOL_SETTLE_MPS;
    controls.vtolThrottle = settling
      ? Math.max(v0 - (v0 / AP_VTOL_CUT_SEC + AP_VTOL_CUT_FLOOR) * dt, 0)
      : apVtolThrottleForVs(controls, state.verticalSpeed, -AP_VTOL_SETTLE_MPS, dt, ap);
    controls.pitch = apElevatorForPitch(state, controls, 0, dt, spd, ap);
    controls.roll = apAileronForBank(state, 0, spd);
    controls.trim = 0;
    // 脚に荷重が乗りきる前に強く踏むと、重心が車輪よりずっと上にある機体は
    // そのまま前へ倒れる。推力を抜きながらブレーキを効かせていく。
    //
    // **後ろへ転がっているあいだは踏まない**。後ろ向きに進みながら車輪で止めると、
    // 止める力が重心より下に掛かるぶん機首が上がる。主脚が重心のすぐ後ろにある機体は
    // それで尻もちをつく——実測でサンダーバード2号（旧データ：主脚が重心の0.6m後ろ、
    // 重心は車輪の10.6m上＝3.2°起きれば後ろへ倒れる）が、垂直着陸で後ろへ0.4m/sで
    // 接地し、駐機ブレーキで止めたところで機首が3.3°→89°と起きてひっくり返った。
    // 後ろへ転がるぶんは転がり抵抗だけで静かに止める。
    // 主脚より後ろに車輪（尾輪）がある機体は、後ろへ転がっていても踏んでよい（起きた尻を尾輪が受ける）。
    // 1号（尾輪式）は踏まないと、尾が下りて後ろへ傾いた垂直エンジンの推力に押され、後ろへ1m/sまで転がった。
    const fwdT = apForward(state.headingDeg);
    const vFwdT = state.velocity.x * fwdT.x + state.velocity.z * fwdT.z;
    const backOk = vFwdT > -AP_VTOL_PARK_MPS || apHasWheelBehindMains(model);
    controls.brake = backOk ? 1 - controls.vtolThrottle : 0;
    // **垂直エンジンを抜ききってから「着陸しました」にする**。以前は止まった（1.5m/s未満）
    // 時点で自動操縦を切っていたので、接地した瞬間（速度はもう0）に抜きはじめる前の出力のまま
    // 手放していた——実測でTB1_21は垂直エンジン61%、TB2_18は76%のまま点きっぱなしになり、
    // 車輪に重さが乗らないので、風8m/sで60秒のうちに587m・164m流された。
    // ほぼ止まったら駐機ブレーキを掛けて、抜ききるのを待つ。
    // 一度止まったら駐機ブレーキは掛けたままにする（段の頭で毎フレーム外しているので、
    // 抜いている途中に少し動くと外れて、そのまま転がっていった）
    if (state.groundSpeed < AP_VTOL_PARK_MPS) ap.vtolParked = true;
    if (ap.vtolParked) {
      controls.brake = 0;
      controls.parkingBrake = true;
      if (controls.vtolThrottle <= 0) {
        controls.vtolThrottle = 0;
        say('done', `${plan.label || plan.airportId} に着陸しました`);
        ap.full = false;
      }
    }
    return;
  }

  // ---- 最終進入（中心線と3°の降下角） ------------------------------------------
  if (ap.phase === 'approach') {
    const t = apTrackPosition(plan, state.position.x, state.position.z);
    ap.distanceM = t.before;

    // 横：中心線からのずれを方位で詰める。近づくほど滑走路の方位そのものへ寄せる。
    const corr = apClamp(-t.cross * apLocGainDegPerM(state), -35, 35);
    const want = plan.heading + corr;
    ap.targetHeadingDeg = (want + 360) % 360;
    controls.roll = apAileronForTrack(state, want, 20, spd);
    // 接地の直前だけ、横滑りを消すより滑走路と機首を合わせるほうを優先する。
    // 斜めを向いたまま降りると脚をねじるが、早くから機首を合わせてしまうと
    // 今度は横風でそのぶん流されるので、引き起こしにかかる高さで切り替える。
    //
    // **機首を合わせる（クラブを解く）のは接地の直前だけ**（AP_DECRAB_AGL_M）。
    // 引き起こし高さの2倍（対地12〜40m）から合わせていたので、そこから接地まで
    // 十数秒、機首は滑走路を向いたまま横風に流されっぱなしになり、横風8m/sで
    // 三式戦闘機とBoeing 747が中心線から53m・52m横で接地していた。
    controls.yaw = state.altitudeAglM < AP_DECRAB_AGL_M
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
    ap.vsCmd = apVsForPath(state, wantAlt, overFloor ? 0 : plan.glide, upMax, spd);
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
    // **経路より高いときは出力を切る。ただし翼が飛べなくなるまでは切らない。**
    // 速度と無関係に切っていたので、降りきれずに高いままの機体は最終進入の
    // あいだずっと出力0%になり、失速速度まで落ちてから落下していた——実測で
    // Boeing 747（失速129kt・進入168kt）が対地105mで104kt・沈下-1896fpm、
    // そのまま-3530fpmで引き起こしに入って11.1Gで叩きつけられていた。
    // 戻す基準は**進入速度ではなく失速速度**にする。進入速度で戻すと、
    // 「高くて速度も足りない」ふつうの場面で出力が入って降りられなくなり、
    // やり直しを繰り返す（実測で同じ747が20回やり直して着陸できなかった）。
    // 翼が落ちる寸前だけ戻せばいい。
    // 出力は2段構え。まず速度の輪（積分）で「その速度を保つのに要る出力」を作り、
    // そのうえで「経路より高い」ぶんだけ絞る。
    //
    // **積分に直接カットを掛けてはいけない**。apThrottleForSpeed は
    // controls.throttle を足し込む形なので、絞った値をそのまま次のコマの
    // 出発点にすると積分が育たなくなる——高くて絞られているあいだは
    // 速度がいくら足りなくても出力が0のまま張り付き、経路に戻ってきた
    // 瞬間から改めて0から積み上げ直すことになる（実測でBoeing 747が
    // 進入速度168ktに対して138ktのまま、出力0.02で浮き沈みしていた）。
    // 積分は別に持ち、絞るのは出口だけにする。
    if (ap.apprThr === undefined) ap.apprThr = controls.throttle;
    const err = (ap.targetSpeedMps - state.airspeed) / Math.max(ap.targetSpeedMps, 1);
    // 足すほうは速く、絞るほうはゆっくり。落ちかけてから出力を足すのでは
    // 間に合わない（実機の自動推力も、出すのは速く戻すのはゆっくり）。
    ap.apprThr = apClamp(ap.apprThr
      + err * (err > 0 ? AP_THR_KP_REL_UP : AP_THR_KP_REL) * dt, 0, 1);
    // **0か1かで切り替えない**。しきい値で切ると、そのあたりを毎フレーム
    // 往復して出力が全開⇔全閉になる——実測でBoeing 747の最終進入が
    // 昇降率±3000fpm・高度±100mで振れ続けていた（この自動操縦で何度も
    // 踏んだ失敗の形）。
    const high = apClamp((pathErr - AP_HIGH_ON_PATH_M) / AP_HIGH_ON_PATH_BAND, 0, 1);
    // ただし**翼が飛べなくなるまでは絞らない**。失速速度を割ってから落ちるよりは、
    // 高いまま飛んでやり直すほうがいい。
    // 失速速度はフラップを下ろせば下がる（揚力係数が上がるぶん、
    // 速度は 1/√CLmax で効く）。全開でだいたい2割落ちる。ここを素の失速速度の
    // まま見ると、フラップを下ろして十分飛べている機体にまで出力を戻してしまい、
    // 今度は降りられなくなる。
    const floorV = spd.stall * (1 - AP_FLAP_STALL_GAIN * controls.flap) * AP_APPROACH_MIN_STALL;
    const tooSlow = apClamp((floorV - state.airspeed) / Math.max(spd.stall * 0.1, 1), 0, 1);
    controls.throttle = overFloor ? ap.apprThr
      : ap.apprThr * Math.max(1 - high, tooSlow);
    // スポイラーも「高い・速い」ときの手。ただし**地形の床を追って登っている
    // あいだは使わない**（出力を切るのと同じ理由で、越えるための揚力を自分で削る）。
    // 引き起こしが近づいたら畳む——接地の直前に揚力を削ると、そのまま落ちる。
    const flareFade = apClamp(
      state.altitudeAglM / Math.max(apFlareHeight(model) * 3, 1) - 1, 0, 1);
    controls.spoiler = overFloor ? 0
      : apSpoilerCommand(model, controls, state, ap.targetSpeedMps, pathErr) * flareFade;
    controls.gearDown = true;
    // フラップは残りの距離で下ろす。高度で決めると、高い空港と低い空港で
    // 下ろす場所がずれる（進入経路のどこにいるかが本当に効く量）。
    // フラップは残りの距離で下ろす。高度で決めると、高い空港と低い空港で
    // 下ろす場所がずれる（進入経路のどこにいるかが本当に効く量）。
    // **段で下ろさない**。0.5から1.0へ一段で切り替えると、その瞬間に揚力が
    // 跳ねて機体が浮き上がる——実測でBoeing 747が滑走路2.2km手前で降下を
    // やめ、経路より70m高いまま滑走路を通り過ぎてやり直していた。
    // 実機も段階的に下ろす。距離で連続に増やせば、昇降舵の輪が追いつける。
    // 下限も0にする。進入に入った瞬間に0→0.5の段で下ろすと、そこでも同じ
    // 浮き上がりが起きる——実測でBoeing 747が進入開始の6秒で55m浮いて、
    // 経路より140m高いところから最終進入を始めていた。
    // **下ろせるのは「機首下げのトリムが足りている範囲」まで**。
    // この飛行モデルのフラップは翼まるごとのキャンバーを増やすので、主翼が重心より
    // 前にある機体では強い機首上げが出る。全開にするとトリムが下げ側の端に張り付き、
    // 舵も AP_PITCH_LEAD_DEG で頭打ちになるため、**指示した降下角まで機首を
    // 下げられなくなる**——実測でBoeing 747が滑走路2.7km手前で降下をやめ
    // （指示-9.4m/s に対して実際-0.1m/s、トリム-1.00・舵-0.32）、経路より115m
    // 高いまま滑走路を通り過ぎ、24回やり直しても着陸できなかった。
    // 張り付いているあいだだけゆっくり戻し、収まったらまた下ろす。実機でも
    // 「機首を押さえきれないならフラップを戻す」は素直な手。
    // 足りている機体（練習機・三式戦闘機・サンダーバード）は全開のまま変わらない。
    const trimPinned = -(controls.trim || 0) > AP_FLAP_TRIM_PIN;
    ap.apprFlapMax = apClamp((ap.apprFlapMax === undefined ? 1 : ap.apprFlapMax)
      + (trimPinned ? -AP_FLAP_BACK_RATE : AP_FLAP_BACK_RATE) * dt, AP_FLAP_BACK_MIN, 1);
    controls.flap = Math.min(
      apClamp(1 - (t.before - AP_FLAP_FULL_M) / AP_FLAP_RAMP_M, 0, 1), ap.apprFlapMax);

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
    // **やり直しでも、曲がれる速さを大きく超えたら出力を絞る**（climbと同じ）。
    // ここだけ全開のままだったので、推力重量比が桁外れな機体はやり直しに
    // 入った瞬間から青天井に加速した——実測でサンダーバード1号が13,000ktに達し、
    // その速さでは動圧で割り引いた舵（apSurfaceGain）がほとんど効かなくなって、
    // 一度入ったロールを止められないまま回り続けた。曲がれない速さで
    // 飛び続けても、やり直しの目的（FAFへ戻る）は果たせない。
    const overCruise = state.airspeed - spd.cruise * 1.5;
    controls.throttle = overCruise > 0 ? apClamp(1 - overCruise * 0.1, 0, 1) : 1;
    nav();
    // **高さが戻ったら、残りの道のりで進入速度まで落とせる速さにする**（降下と同じ式）。
    // 全開のまま水平に飛んでいたので、入口を回って戻ってくるあいだに加速し、
    // 最終進入に 299kt（Concordeの進入速度は177kt）で入って 10.7G で接地していた。
    // 上がっているあいだは全開のまま（やり直しは、まず上がるのが先）。
    // 上がりきる前でも、その速さを超えているなら絞る（推力の大きい機体は、上がりながら
    // 600ktまで加速して旋回半径が倍になり、入口から中心線に乗りきれなかった。TB1）。
    const gaAlt = plan.fafAltM + 150;
    const vAllowed = Math.sqrt(spd.approach * spd.approach
      + 2 * AP_DECEL_MPS2 * Math.max(distFaf, 0));
    // 上限は上昇の速度ではなく巡航の速度（上昇の速度が失速の1.3倍ほどしかない機体
    // ——三式戦闘機は失速24kt・上昇32kt——をそこまで落とすと、傾けられずに
    // ゆっくり大回りするだけになり、中心線に乗れなかった）
    const vWant = Math.min(spd.cruise, vAllowed,
      ap.entrySpeedLimitMps > 0 ? ap.entrySpeedLimitMps : Infinity);
    if (state.altitudeM > gaAlt - 150 || state.airspeed > vWant) {
      // 出力の積分は別に持つ（controls.throttle は毎フレーム上で1に戻しているので、
      // それを出発点に足し込むと下がらない。最終進入の apprThr と同じ理由）
      if (ap.gaThr === undefined) ap.gaThr = controls.throttle;
      const err = (vWant - state.airspeed) / Math.max(vWant, 1);
      ap.gaThr = apClamp(ap.gaThr + err * (err > 0 ? AP_THR_KP_REL_UP : AP_THR_KP_REL) * dt, 0, 1);
      controls.throttle = Math.min(controls.throttle, ap.gaThr);
      if (!terrainPushing) controls.spoiler = apSpoilerCommand(model, controls, state, vWant, 0);
    }
    // **やり直しも地形を見る**。ここだけ overTerrain/overTerrainVs を掛けて
    // いなかったので、山のそばの空港でやり直すと、最終進入開始点の高さまでしか
    // 上がらず山へ突っ込めた。逃げる動きなのだから、行き先の空港と同じだけ
    // 地形は避けなければいけない。
    const wantAlt = overTerrain(plan.fafAltM + 150);
    ap.vsCmd = overTerrainVs(apVsForAltitude(state, wantAlt, apClimbCap(state, spd), undefined, spd));
    ap.targetSpeedMps = spd.climb;
    controls.pitch = apElevatorForPitch(state, controls,
      apPitchForVs(state, ap.vsCmd, undefined, terrainPitchMax()), dt, spd, ap);
    // 最終進入開始点に戻って、高度も合っていれば進入をやり直す
    if (distFaf < 2500 && Math.abs(state.altitudeM - wantAlt) < 250) {
      if (apAlignedForFinal(plan, state)) say('approach', '最終進入');
      else ap.navMode = 'gate';   // 向きが合っていないまま着いた：入口へ回り直す
    }
    return;
  }

  // ---- 引き起こし -----------------------------------------------------------
  if (ap.phase === 'flare') {
    // 引き起こしの間も、接地の直前（AP_DECRAB_AGL_M）までは風上へ機首を向けたまま
    // （クラブ）で航跡を中心線に保ち、最後にラダーで機首を滑走路へ合わせる。
    // 中心線への寄せも最終進入より強くする（残りが短いので、ずれを持ち越さない）。
    const corr = apClamp(-apTrackPosition(plan, state.position.x, state.position.z).cross
      * AP_FLARE_CROSS_KP, -15, 15);
    controls.roll = apAileronForTrack(state, plan.heading + corr, 10, spd);
    controls.yaw = state.altitudeAglM < AP_DECRAB_AGL_M
      ? apClamp(apWrap180(plan.heading - state.headingDeg) * AP_STEER_KP * 2, -1, 1)
      : apRudderForCoordination(state);
    controls.throttle = Math.max(controls.throttle - dt * 0.8, 0);

    // 沈下率は残りの高さに比例させる。一定の沈下率にすると、速い機体ほど
    // 何kmも浮いたまま滑走路を使い切ってしまう（大型機が2.7km先で接地した）。
    // 高いうちは速く、地面に近づくほどゆっくり——実際の引き起こしと同じ形。
    // **ただし最後は一定の沈下率で降ろしきる**（速いほど大きく）。比例だけだと、
    // 地面に近づくほど指示が0に近づいて、対地7mから接地まで12秒かかる——実測で
    // サンダーバード1号が340ktで対地5〜7mを1.5km浮いたまま進み（画面の表示は「接地」）、
    // そのあいだに横風で中心線から28m流された。
    ap.vsCmd = -Math.max(state.altitudeAglM * 0.22 / apFlareQuick(state), apFlareMinSink(state));
    // 接地の姿勢は少し機首上げ。前輪から落とすと跳ねる。
    // **「機首を下げない」の下限が、上限を追い越さないようにする**。
    // apClamp は下限が優先なので（v < lo ? lo : …）、いったん上限を超えると
    // 下限（いまの姿勢-1°）のほうが高くなり、上限が効かなくなる。姿勢が上がるほど
    // 下限も上がるので、**機首上げが自分で自分を押し上げて止まらない**——実測で
    // Boeing 747 が引き起こしで30°まで起き上がり、滑走路の上で233mまで舞い上がって
    // 78kt（失速129kt）で失速し、-8210fpmで落ちて9.9Gを記録していた。
    const floor = Math.min(state.pitchDeg - 1, AP_FLARE_PITCH_MAX);
    const want = apClamp(apPitchForVs(state, ap.vsCmd, -3, AP_FLARE_PITCH_MAX),
      floor, AP_FLARE_PITCH_MAX);
    controls.pitch = apElevatorForPitch(state, controls, want, dt, spd, ap);

    if (state.onGround) say('rollout', '滑走路上で減速');
    return;
  }

  // ---- 減速 -----------------------------------------------------------------
  if (ap.phase === 'rollout') {
    controls.throttle = 0;
    // **接地したあとにフラップを足さない**。ここで全開（1.0）にしていたので、
    // 接地した直後に揚力が増えて、そのまま浮き上がっていた——実測で
    // Boeing747が148kt（失速129kt）で接地した0.5秒後にフラップが0.3→1.0になり、
    // **対地102mまで舞い上がって**、10秒かけて落ちてきて-4,030fpm・10.7Gで
    // 叩きつけられていた（このあいだ昇降舵は-1.00に張り付いていて、
    // 姿勢はもう戻せない）。スポイラーを積んでいない機体で揚力を捨てる手段は
    // フラップを戻すことしかないので、戻す。積んでいる機体はスポイラーが
    // その役目をするので、フラップはそのままでいい。
    // **スポイラーのある機体でもフラップは戻す**。以前はスポイラーが揚力を捨てるので
    // フラップはそのまま（全開）にしていたが、フラップが重心より前の主翼にある機体では、
    // 全開にした揚力が機首を持ち上げる——実測でサンダーバード2号が352ktで接地した
    // 1.5秒後にピッチ0°→5.6°で浮き上がり、昇降舵を押しても対地214mまで上がり続けた
    // （フラップを戻すとピッチ0.3°のまま接地を続けて止まる）。
    controls.flap = 0;
    controls.roll = apAileronForBank(state, 0, spd);
    // 中心線を保つ（離陸滑走と同じ apGroundSteer）
    controls.yaw = apGroundSteer(state, ap, plan.heading,
      apTrackPosition(plan, state.position.x, state.position.z).cross, dt);
    // 跳ねて浮いたら、ブレーキを離してもう一度接地の姿勢へ。
    // 浮いている間に舵を中立へ落とすと、前輪から突っ込むことになるので、
    // 機首は少しだけ上げたところ（AP_ROLLOUT_PITCH_DEG）を狙う。
    //
    // **指示ピッチに「いまのピッチ」を使ってはいけない**。
    // `clamp(state.pitchDeg, 0, 8)` は上がったぶんをそのまま追認するだけで、
    // 戻す力がどこにも無い。**トリムも接地のぶんを持ち越していた**ので、
    // いったん浮くと機首上げが残ったまま上がり続ける——実測でBoeing747が
    // 148ktで接地したあと、ピッチ2.8°→46°で**対地137mまで舞い上がり**、
    // 10秒かけて落ちてきて-4,346fpm・8.8Gで叩きつけられていた。
    // **スポイラーも立てたままにする**。浮いているあいだに引っ込めると
    // 捨てたはずの揚力が戻り、失速速度の1.15倍で接地した機体は素直に
    // また飛ぶ。実機の地上スポイラーも、跳ねている最中に戻したりはしない。
    if (!state.onGround) {
      controls.brake = 0;
      controls.trim = 0;
      controls.spoiler = model.hasSpoiler ? 1 : 0;
      controls.pitch = apElevatorForPitch(state, controls, AP_ROLLOUT_PITCH_DEG, dt, spd, ap);
      return;
    }
    controls.trim = 0; // 接地で溜めた機首上げを残すと、前輪が浮いて舵が効かない
    // **速いうちは機首を少し上げたまま保つ**（実機のエアロダイナミック
    // ブレーキングと同じ）。舵を中立へ落としていたので、スポイラーとブレーキの
    // 抗力が重心より下に掛かるぶんで機首が突っ込んでいた——実測で
    // サンダーバード1号が接地の1.5秒後にピッチ-16.6°、2.5秒後に-87.7°まで
    // 突っ込み、前脚から地面を掘って22.4Gを記録した。失速速度に近づいたら
    // 中立へ戻す（前輪が接地しないとブレーキも操舵も効かない）。
    const noseUp = apClamp(state.groundSpeed / Math.max(spd.stall, 1) - 0.6, 0, 1);
    controls.pitch = noseUp > 0
      ? apElevatorForPitch(state, controls, AP_ROLLOUT_PITCH_DEG * noseUp, dt, spd, ap)
      : 0;
    controls.brake = 1;
    // **尾輪式は、ブレーキで前にのめらないようにする**。主脚が重心より前にあるので、
    // 速いうちにブレーキを一杯に踏むと主脚を支点に前へ回る——実測でTB1が390ktで
    // 踏んだ2秒後にピッチ-82°まで倒れて裏返っていた（接地のたびに出ていた12〜30Gの
    // 正体）。昇降舵で尾を押さえ（主脚と尾輪が両方接地する姿勢を狙う）、機首がその
    // 姿勢より下がりはじめたらブレーキを緩める。実機の尾輪式も同じ踏み方をする。
    const rest = apTailwheelRestPitch(model);
    if (rest !== null) {
      controls.pitch = apElevatorForPitch(state, controls, rest, dt, spd, ap);
      controls.brake = apClamp(1 - (rest - AP_TAIL_BRAKE_MARGIN_DEG - state.pitchDeg) / 2, 0, 1);
    }
    // 接地したらスポイラーを全開にする（実機の「揚力を捨てる」操作）。
    // 車輪のブレーキは車輪に掛かっている重さのぶんしか効かないので、
    // 翼が揚力を出したままだと踏んでも減速しない。逆噴射は車輪の効きとは
    // 無関係に効くので、濡れた滑走路の代わりに翼が浮いている状態でも使える。
    controls.spoiler = model.hasSpoiler ? 1 : 0;
    // 滑走路の残り＝長さ −（進入端から来た距離）。接地を狙う点は進入端の AP_TOUCHDOWN_M 先
    const past = AP_TOUCHDOWN_M - apTrackPosition(plan, state.position.x, state.position.z).before;
    controls.reverse = apReverseCommand(model, state, controls, plan.runwayLengthM - past);
    // 誘導路の道筋を知っている空港（画面で飛んでいるとき）は、歩くくらいまで落ちたら
    // ターミナルの前まで地上走行する。知らないとき（検証ツールの空港）は以前どおり止まる。
    if (plan.taxi && state.groundSpeed < AP_TAXI_START_MPS) {
      apStartTaxi(plan, state, ap);
      controls.brake = 0;
      controls.spoiler = 0;
      controls.reverse = 0;
      controls.flap = 0;
      controls.parkingBrake = false;
      say('taxi', 'ターミナルへ地上走行');
      return;
    }
    if (state.groundSpeed < 1.5) {
      controls.brake = 0;
      controls.spoiler = 0;
      controls.reverse = 0;
      controls.parkingBrake = true;
      controls.yaw = 0;
      say('done', `${plan.label || plan.airportId} に着陸しました`);
      ap.full = false;
    }
    return;
  }

  if (ap.phase === 'taxi') {
    const res = apStepTaxi(model, state, controls, ap, dt);
    if (res === 'arrived') {
      controls.throttle = 0;
      controls.brake = 0;
      controls.parkingBrake = true;
      controls.yaw = 0;
      say('done', `${plan.airportId} のターミナルに着きました`);
      ap.full = false;
    }
    return;
  }
}

// --- 着陸後の地上走行 -----------------------------------------------------------
//
// 「着陸後にターミナルまで地上走行」から。滑走路の出口 → 平行誘導路 → エプロンの中ほど、
// の順に誘導路の中心線をたどる（道筋は 04b-airport.js の airportTaxiRouteWorld）。
//   出口 … 進んでいる向きで前にあるうち、いちばん近いもの。前に無ければ（出口を過ぎてから
//          止まったら）、いちばん近い後ろの出口へ、滑走路の上で向きを変えて戻る
//   舵   … 道筋の上を「速さに応じて少し先」の点へ向ける（前輪の操向とラダーは apGroundSteer と同じ）
//   速さ … 直線は AP_TAXI_MPS、曲がり角の手前と向きが大きくずれているときは AP_TAXI_TURN_MPS。
//          止まる点までは一定の減速で落とす。出力は積分で合わせ、速すぎればブレーキ
const AP_TAXI_START_MPS = 8;       // 減速してこの速さを切ったら地上走行へ
const AP_TAXI_MPS = 8;             // 直線の速さ（約15kt。実機の地上走行と同じくらい）
const AP_TAXI_TURN_MPS = 3;        // 曲がるときの速さ
const AP_TAXI_TURN_SLOW_M = 70;    // 曲がり角のこの手前から落とす
const AP_TAXI_DECEL = 0.6;         // 止まる点へ向けて落とす減速度(m/s²)
const AP_TAXI_EXIT_AHEAD_M = 40;   // これより近い出口は「もう曲がれない」ので次を選ぶ
const AP_TAXI_STOP_M = 4;          // 止まる点からこれ以内で停止
// 出力は「重さの何割の推力か」で考える（apTaxiThrottlePerWeight で出力レバーに直す）
const AP_TAXI_THR_KI_W = 0.02;     // 積分の強さ（1秒・1m/sあたり、重さに対する推力の割合）
const AP_TAXI_THR_KP_W = 0.015;    // 比例の強さ
const AP_TAXI_THR_MAX_W = 0.25;    // 地上走行で使う推力の上限（重さに対して）
const AP_TAXI_THR_MAX = 0.8;       // 出力レバーの上限

// 出力レバー1あたりが重さの何分の1か（＝重さ1ぶんの推力を出すレバーの量）。
// 前へ進むエンジンの推力の合計で見る（垂直離陸用は数えない）。
function apTaxiThrottlePerWeight(model) {
  if (model._taxiPerW !== undefined) return model._taxiPerW;
  let T = 0;
  for (const e of model.engines || []) if (!e.lift) T += e.thrustN || 0;
  model._taxiPerW = T > 0 ? (model.massKg * 9.81) / T : 1;
  return model._taxiPerW;
}

const AP_CLIMB_THRUST_MAX_W = 3;    // 上昇・巡航・降下で使う「抗力を超えるぶんの推力」の上限（重さに対して）
const AP_VTOL_TRANS_ACCEL_G = 0.5;   // 垂直離陸の前進切替で許す加速（重さに対する、抗力を超えるぶんの推力）

// 前へ進むエンジンで推力 wantN を出す出力レバー。
// **レバーは遅いグループから順に上がる**（engineGroupLadder）ので、「推力の合計に比例する」とは
// かぎらない。比例として解いていたので、TB2（グループ1のロケット2基2954kN・グループ2のAB付き
// ジェット2基5920kN・グループ3の小さいジェット2基426kN、重さ4960kN）の前進切替は
// 「重さの0.35倍＝レバー18.7%」のつもりが、はしごのいちばん下のグループ3に37%を渡しただけ
// ——出ていたのは重さの3%で、355ktから先へ加速せず、翼が支えられる速さに届かなかった。
// はしごを下から積み上げて、そのグループの中で割り振る。推力はいまの速さ・高さで測る。
function apLeverForThrustN(model, controls, wantN, speedMps, altitudeM) {
  const ladder = engineGroupLadder(model, controls);
  const n = ladder.length;
  if (!n || !(wantN > 0)) return 0;
  const rho = airDensityAt(altitudeM || 0);
  const cut = aircraftVMaxCutMps(model, controls);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let g = 0;
    for (const e of ladder[i].engines || []) {
      if (e.lift) continue;
      g += e.thrustN * Math.max(-e.axis.z, 0) * engineThrustScale(e, speedMps, rho, 1, cut);
    }
    if (g > 0 && acc + g >= wantN) return (i + (wantN - acc) / g) / n;
    acc += g;
  }
  return 1;
}

// いまの速さ・高さでの抗力の見積もり(N)。抗力長さ（aircraftDragLengthM、海面の密度で測ったもの）から
// D = m·v²/L を、空気の薄さのぶん減らして出す。
function apDragEstimateN(model, speedMps, altitudeM) {
  const L = aircraftDragLengthM(model);
  if (!(L > 0)) return 0;
  return model.massKg * speedMps * speedMps / L * (airDensityAt(altitudeM || 0) / FLIGHT_RHO0);
}

// 減速の見積もりに使う抗力長さ(m)。その高さの空気の薄さぶん伸ばす（薄いほど抗力が小さく、
// 止まるまでに長く走る）。
// **スポイラーは数に入れない**。立てれば半分ほどの距離で落ちる（TB1がマッハ9.7から395km→208km）が、
// マッハ8で巡航中に立てると揚力が一度に抜け、ピッチの輪が追いつかずに毎秒200m沈み、
// 沈んだぶん出力が戻って畳む——の往復で±20〜30Gに振れた。抗力だけで落ちるぶんで見積もる。
function apDecelLengthM(model, altitudeM) {
  const L = aircraftDragLengthM(model);
  return L * FLIGHT_RHO0 / Math.max(airDensityAt(Math.max(altitudeM || 0, 0)), 1e-3);
}

// 上昇・巡航・降下で使う出力レバーの上限。**抗力を超えるぶんの推力が重さの AP_CLIMB_THRUST_MAX_W 倍**
// になる量まで（推力が重さの325倍あった頃のTB1が、1フレームの全開で秒速50m伸びたため）。
// 以前は「推力そのものを重さの3倍まで」にしていたので、抗力が重さの3倍を超える速さ
// ——TB1（推力は重さの6.7倍）なら高度3000mでマッハ6あたり——から先は、レバーが45%で
// 止まったまま加速できなかった。抗力のぶんを足せば、最高速度の近くでも全開まで使える。
function apAirThrottleCap(model, state, controls) {
  const W = model.massKg * FLIGHT_GRAVITY;
  const v = state ? state.airspeed : 0, h = state ? state.altitudeM : 0;
  return Math.min(1, apLeverForThrustN(model, controls, AP_CLIMB_THRUST_MAX_W * W + apDragEstimateN(model, v, h), v, h));
}

function apStartTaxi(plan, state, ap) {
  const t = plan.taxi;
  const f = plan.forward;
  const px = state.position.x, pz = state.position.z;
  const along = (q) => (q.x - px) * f.x + (q.z - pz) * f.z;
  let best = null;
  for (const e of t.exits) {
    const a = along(e.runway);
    if (a >= AP_TAXI_EXIT_AHEAD_M && (!best || a < best.a)) best = { e, a };
  }
  if (!best) {
    for (const e of t.exits) {
      const a = along(e.runway);
      if (!best || a > best.a) best = { e, a };
    }
  }
  ap.taxi = {
    path: [{ x: px, z: pz }, best.e.runway, best.e.parallel, t.apronEntry]
      .concat(t.apronPath || [], [t.apronStop]),
    seg: 0,
  };
  ap.taxiThr = 0;
}

function apStepTaxi(model, state, controls, ap, dt) {
  const T = ap.taxi;
  const P = T.path;
  const px = state.position.x, pz = state.position.z;
  const gs = state.groundSpeed;

  // いまの区間への投影。区間の終わりを過ぎたら次の区間へ
  let proj = null;
  for (;;) {
    const a = P[T.seg], b = P[T.seg + 1];
    const vx = b.x - a.x, vz = b.z - a.z;
    const L2 = vx * vx + vz * vz || 1;
    const tt = ((px - a.x) * vx + (pz - a.z) * vz) / L2;
    if (tt >= 1 && T.seg < P.length - 2) { T.seg++; continue; }
    proj = { t: Math.max(tt, 0), len: Math.sqrt(L2) };
    break;
  }
  // 道筋に沿って、投影した点から look だけ先の点を狙う。
  // **見る先は、その機体がいちばん小さく回れる半径より近くしない。** 前輪と主脚が離れた
  // 長い機体は小さく回れない（747は前輪を一杯に切っても半径66m）。それより近い点を見ていると
  // 角の手前で切りはじめるのが遅れ、外へ40mふくらんでから戻ってきていた。
  const geo = typeof gearSteerGeometry === 'function' ? gearSteerGeometry(model) : null;
  const wheelbase = geo ? Math.abs(geo.arm) : 10;
  const steerMaxDeg = (typeof GEAR_STEER_MAX_DEG !== 'undefined')
    ? GEAR_STEER_HIGHSPEED_DEG + (GEAR_STEER_MAX_DEG - GEAR_STEER_HIGHSPEED_DEG) * apClamp(1 - gs / 40, 0, 1)
    : 30;
  const turnR = wheelbase / Math.tan(steerMaxDeg * Math.PI / 180);
  const look = Math.max(12, gs * 2.5, turnR * 1.1);
  let rest = look + proj.t * proj.len;
  let tx = P[P.length - 1].x, tz = P[P.length - 1].z;
  for (let i = T.seg; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (rest <= L) { tx = a.x + (b.x - a.x) * rest / (L || 1); tz = a.z + (b.z - a.z) * rest / (L || 1); break; }
    rest -= L;
  }
  const want = apBearingTo(px, pz, tx, tz);
  // ほぼ真後ろを狙うとき（出口を過ぎてから向きを変えて戻る）は、曲がる向きを決めたら
  // 変えない。±180°の境目で左右が毎フレーム入れ替わると、切り返しを繰り返して回れない。
  let err = apWrap180(want - state.headingDeg);
  if (Math.abs(err) > 150) {
    if (!T.turnSign) T.turnSign = err >= 0 ? 1 : -1;
    err = T.turnSign * Math.abs(err);
  } else if (Math.abs(err) < 90) T.turnSign = 0;
  // 舵は「狙う点へ届く円」の曲がり具合から、前輪の切れ角をそのまま決める（純追従）。
  // 滑走路の上の中心線保持（apGroundSteer）は速い滑走のための強い効きで、
  // 歩くような速さで角を曲がると行き過ぎた（747が180°へ曲がるはずの角で223°まで回った）。
  const Ld = Math.max(Math.hypot(tx - px, tz - pz), 1);
  const alpha = err * Math.PI / 180;
  const delta = Math.abs(alpha) >= Math.PI / 2
    ? Math.sign(alpha) * Math.PI / 2
    : Math.atan(2 * Math.sin(alpha) * wheelbase / Ld);
  controls.yaw = apClamp(delta / (steerMaxDeg * Math.PI / 180), -1, 1);
  void dt;

  // 止まる点までの残り（道筋に沿って）と、次の曲がり角までの距離・曲がる角度
  const end = P[P.length - 1];
  let toEnd = (1 - proj.t) * proj.len;
  for (let i = T.seg + 1; i < P.length - 1; i++) toEnd += Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z);
  let vWant = AP_TAXI_MPS;
  if (T.seg < P.length - 2) {
    const a = P[T.seg], b = P[T.seg + 1], c = P[T.seg + 2];
    const h1 = Math.atan2(b.x - a.x, -(b.z - a.z)), h2 = Math.atan2(c.x - b.x, -(c.z - b.z));
    const turn = Math.abs(apWrap180((h2 - h1) * 180 / Math.PI));
    const toCorner = (1 - proj.t) * proj.len;
    if (turn > 25 && toCorner < AP_TAXI_TURN_SLOW_M) vWant = AP_TAXI_TURN_MPS;
  }
  if (Math.abs(err) > 35) vWant = AP_TAXI_TURN_MPS;
  vWant = Math.min(vWant, Math.sqrt(2 * AP_TAXI_DECEL * Math.max(toEnd - AP_TAXI_STOP_M, 0)));

  controls.pitch = 0;
  controls.roll = 0;
  controls.flap = 0;
  controls.spoiler = 0;
  controls.reverse = 0;
  controls.trim = 0;
  controls.parkingBrake = false;
  // 出力の効きは推力と重さの比で割っておく。サンダーバード1号は推力が重さの何倍もあり、
  // 練習機と同じ効きで足すと少し開けただけで34ktまで走り出した。
  const perW = apTaxiThrottlePerWeight(model);
  const thrMax = Math.min(AP_TAXI_THR_MAX, AP_TAXI_THR_MAX_W * perW);
  const ev = vWant - gs;
  ap.taxiThr = apClamp((ap.taxiThr || 0) + ev * AP_TAXI_THR_KI_W * perW * dt, 0, thrMax);
  if (ev < -1) ap.taxiThr *= Math.max(0, 1 - dt * 2); // 速すぎるときは積分を抜く
  controls.throttle = apClamp(ap.taxiThr + ev * AP_TAXI_THR_KP_W * perW, 0, thrMax);
  controls.brake = apClamp((-ev - 0.8) * 0.35, 0, 1);

  const stopping = toEnd < AP_TAXI_STOP_M;
  if (stopping) { controls.throttle = 0; controls.brake = 1; }
  // 尾輪式は、ブレーキで前にのめらないように踏み方を加減する（着陸滑走と同じ）
  const tailRest = apTailwheelRestPitch(model);
  if (tailRest !== null) {
    controls.brake *= apClamp(1 - (tailRest - AP_TAIL_BRAKE_MARGIN_DEG - state.pitchDeg) / 2, 0, 1);
  }
  if (stopping && gs < 0.3) return 'arrived';
  return 'taxi';
}

// その場に留まる（垂直離着陸機だけ）。
//
// 高さ・場所・機首の向きを保つ。**手で舵を当てているあいだはその操作を通し、
// 離したところを新しい持ち場にする**ので、ホバリングのまま少しずつ寄せていける。
function apStepHover(model, state, controls, ap, spd, dt, env) {
  const manual = (env && env.manual) || {};
  // 前へ進むエンジンは切る。ホバリングは垂直エンジンと機体の傾きでやる。
  controls.throttle = 0;
  controls.gearDown = true;

  // 高さ。垂直レバーを手で動かしているあいだは任せる。
  // 出力のキー（Shift/Ctrl）かタッチの▲▼を押しているあいだは、保つ高さそのものを
  // 上げ下げする（レバーを直接動かすより、上げ下げのあとそこでぴたりと止まる）。
  if (manual.hoverAlt && !manual.vtol) {
    const ground = state.altitudeM - (state.altitudeAglM || 0);
    ap.hoverAltM = Math.max(ap.hoverAltM + apClamp(manual.hoverAlt, -1, 1) * AP_HOVER_ADJ_MPS * dt,
      ground + AP_HOVER_MIN_AGL_M);
  }
  if (manual.vtol) {
    ap.hoverAltM = state.altitudeM;
  } else {
    const targetVs = apClamp((ap.hoverAltM - state.altitudeM) * AP_HOVER_ALT_KP,
      -AP_HOVER_VS_MAX, AP_HOVER_VS_MAX);
    controls.vtolThrottle = apVtolThrottleForVs(controls, state.verticalSpeed, targetVs, dt, ap);
  }

  // 場所。機体を傾けて水平方向の推力を作る（垂直着陸と同じ apVtolHoverAngles）。
  // 前へ速度が残っていても、速度を打ち消す向きに傾くので自然に止まる。
  if (manual.pitch || manual.roll || state.groundSpeed > AP_HOVER_CAPTURE_MPS) {
    ap.hoverX = state.position.x;
    ap.hoverZ = state.position.z;
  }
  {
    const hover = apVtolHoverAngles(state, ap.hoverX, ap.hoverZ, undefined, ap);
    controls.pitch = apElevatorForPitch(state, controls, hover.wantPitchDeg, dt, spd, ap);
    controls.roll = apAileronForBank(state, hover.wantBankDeg, spd);
  }

  // 機首の向き。ラダーを手で当てているあいだは任せる。
  if (manual.yaw) {
    ap.hoverHeadingDeg = state.headingDeg;
  } else {
    controls.yaw = apClamp(apWrap180(ap.hoverHeadingDeg - state.headingDeg) * AP_STEER_KP, -1, 1);
  }

  ap.vsCmd = state.verticalSpeed;
  ap.targetHeadingDeg = ap.hoverHeadingDeg;
  ap.targetAltitudeM = Math.round(ap.hoverAltM);
}

// 高度維持のとき、**手を離したバンクをそのまま保つ**（水平には戻さない）。
// 水平へ戻していたので、高度維持を入れると旋回ができなかった——エルロンを
// 当てているあいだだけ傾き、離した瞬間に翼が起きてしまう。実機の
// 「ウイングレベラー」ではなく「アティテュードホールド」の振る舞いにする。
// ほぼ水平のところだけは0へ吸わせる（でないと0.5°の傾きが残り続けて、
// 何もしていないのにゆっくり向きが変わる）。
const AP_HOLD_BANK_SNAP_DEG = 2.5;   // これ以下の傾きは水平とみなす
const AP_HOLD_BANK_MAX_DEG = 60;     // 保つバンクの上限
// 旋回中は揚力の縦成分が cos(バンク) に減る。高度のずれが出てから追いかけると
// 必ず沈むので、**要るぶんを先に足す**（前送り）。水平旋回に要る荷重倍数は
// 1/cos(φ)、そのぶんの迎角＝ピッチを足す。30°バンクで+15%、45°で+41%。
const AP_TURN_PITCH_COMP = 6;        // (1/cosφ - 1) 1.0あたり何度足すか

// 「手で当てているか」は、**自動操縦が前のコマに書いた値と比べて**判断する。
// controls.roll が0かどうかで見ると、自動操縦が自分で書いた舵を次のコマで
// 「手の操作だ」と読んでしまい、そこで制御をやめる（バンクを保つように
// してから表に出た。水平へ戻していたころは自分の出力もほぼ0だったので
// たまたま動いていた）。実測で内蔵の練習機は30°で離したあと62.7°まで倒れ、
// 60秒で386m落ちていた。
function apHoldBankDeg(state, controls, ap) {
  const wrote = ap.rollCmdOut === undefined ? 0 : ap.rollCmdOut;
  if (Math.abs((controls.roll || 0) - wrote) >= 0.02) {
    // 手で当てているあいだは、いまの傾きを覚えるだけ（操作はそのまま通す）
    ap.holdBankDeg = apClamp(state.rollDeg, -AP_HOLD_BANK_MAX_DEG, AP_HOLD_BANK_MAX_DEG);
    ap.rollCmdOut = undefined;
    return undefined;
  }
  if (ap.holdBankDeg === undefined) ap.holdBankDeg = state.rollDeg;
  if (Math.abs(ap.holdBankDeg) < AP_HOLD_BANK_SNAP_DEG) ap.holdBankDeg = 0;
  return apClamp(ap.holdBankDeg, -AP_HOLD_BANK_MAX_DEG, AP_HOLD_BANK_MAX_DEG);
}

// 旋回のためにエレベーターも使う（バンクぶんの前送り）
function apTurnPitchComp(bankDeg) {
  const c = Math.cos(apClamp(bankDeg, -80, 80) * Math.PI / 180);
  return apClamp((1 / Math.max(c, 0.17) - 1) * AP_TURN_PITCH_COMP, 0, 12);
}

// 高度維持だけ（横と出力は手動のまま）
function apStepAltHold(model, state, controls, ap, spd, dt) {
  const hold = apHoldBankDeg(state, controls, ap);
  if (hold !== undefined) {
    controls.roll = apAileronForBank(state, hold, spd);
    ap.rollCmdOut = controls.roll;
  }
  ap.vsCmd = apVsForAltitude(state, ap.targetAltitudeM, apClimbCap(state, spd), undefined, spd);
  controls.pitch = apElevatorForPitch(state, controls,
    apPitchForVs(state, ap.vsCmd) + apTurnPitchComp(state.rollDeg), dt, spd, ap);
}

// 自動操縦を1フレーム進める（環境に依らない本体）
// --- ヘリコプター -------------------------------------------------------------------
//
// ヘリは翼で浮かないので、固定翼の自動操縦（速度の段取り・進入の経路・滑走）は使わない。
// どの段も同じ「速度を指示 → 欲しい加速度 → 機体の傾き」の1本で飛ぶ：
//   ・横 … 欲しい対地速度（目的地の向き。近づいたら止まれる速さまで落とす）と今の速度の差から
//          加速度を出し、それを前後・左右の傾きにする（前へ加速したければ機首を下げる）。
//          操縦桿は姿勢の指示（10-flight.js の accumulateHeliControl）なので、傾きをそのまま渡せる
//   ・縦 … 欲しい昇降率とのずれでコレクティブ（出力レバー）を動かす（ホバリングの出力＋比例＋積分）
//   ・向き … 速ければ進む向きへ、遅ければいまの向きのまま
// 段は 離陸（真上へ30m）→ 巡航（地形より上を目的地へ）→ 進入（止まれる距離から減速して降り場の上60mへ）
//   → 降下（降り場の上で止まったまま真下へ）→ 接地（コレクティブを0へ）→ 着陸
const HELI_AP_CRUISE_FRAC = 0.85;     // 巡航の速さ（最高速度に対する割合）
const HELI_AP_CRUISE_MAX_MPS = 70;
const HELI_AP_BRAKE_MPS2 = 1.2;       // 目的地へ向けて減速するときの加速度
const HELI_AP_ACC_MAX = 3.5;          // 横に出す加速度の上限（m/s²。およそ20°の傾き）
const HELI_AP_VEL_KP = 0.6;           // 速度のずれ1m/sあたりの加速度
const HELI_AP_TAKEOFF_AGL_M = 30;
const HELI_AP_MIN_AGL_M = 150;        // 巡航で地形からこれだけ上を飛ぶ
const HELI_AP_APPROACH_AGL_M = 60;
const HELI_AP_VS_UP = 7, HELI_AP_VS_DOWN = 5;
const HELI_AP_COL_KP = 0.06;          // 昇降率のずれ1m/sあたりのコレクティブ
const HELI_AP_COL_KI = 0.04;

// ホバリングに要るコレクティブの見積もり（その高さの空気の濃さと、いまの傾きで）
function heliHoverCollective(model, state) {
  const rho = airDensityAt(state.altitudeM || 0);
  const tilt = Math.cos(THREE.MathUtils.degToRad(Math.min(Math.hypot(state.pitchDeg || 0, state.rollDeg || 0), 60)));
  const f = heliRotorFactor(model, state, state.airspeed || 0);
  const T = model.vtolThrustN * (rho / FLIGHT_RHO0) * f * Math.max(tilt, 0.3);
  return T > 0 ? (model.massKg * FLIGHT_GRAVITY) / T : 1;
}

// 昇降率を targetVs に合わせるコレクティブ（出力レバー）
function heliCollectiveForVs(model, state, controls, ap, targetVs, dt) {
  const err = targetVs - state.verticalSpeed;
  ap.heliColI = apClamp((ap.heliColI || 0) + err * HELI_AP_COL_KI * dt, -0.2, 0.2);
  return apClamp(heliHoverCollective(model, state) + err * HELI_AP_COL_KP + ap.heliColI, 0, 1);
}

// 欲しい対地速度（ワールドの x, z）へ向けて傾ける。向きは wantHdg（undefined ならそのまま）
function heliSteer(model, state, controls, vx, vz, wantHdg) {
  let ax = (vx - state.velocity.x) * HELI_AP_VEL_KP, az = (vz - state.velocity.z) * HELI_AP_VEL_KP;
  const a = Math.hypot(ax, az);
  if (a > HELI_AP_ACC_MAX) { ax *= HELI_AP_ACC_MAX / a; az *= HELI_AP_ACC_MAX / a; }
  const h = THREE.MathUtils.degToRad(state.headingDeg);
  const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
  const aF = ax * fx + az * fz, aR = ax * rx + az * rz;
  const g = FLIGHT_GRAVITY;
  controls.pitch = apClamp(-Math.atan(aF / g) / THREE.MathUtils.degToRad(HELI_PITCH_MAX_DEG), -1, 1);
  controls.roll = apClamp(Math.atan(aR / g) / THREE.MathUtils.degToRad(HELI_ROLL_MAX_DEG), -1, 1);
  if (wantHdg === undefined) controls.yaw = 0;
  else {
    const err = apWrap180(wantHdg - state.headingDeg);
    controls.yaw = apClamp((err * 1.2) / HELI_YAW_RATE_DEG, -1, 1);
  }
}

// ヘリの上がれる高さ（推力が重さの1.1倍を切る高さ）。巡航の高さの上限に使う
function heliCeilingM(model) {
  if (model._heliCeil !== undefined) return model._heliCeil;
  let lo = 0, hi = 9000;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const T = model.vtolThrustN * (airDensityAt(mid) / FLIGHT_RHO0);
    if (T > model.massKg * FLIGHT_GRAVITY * 1.1) lo = mid; else hi = mid;
  }
  model._heliCeil = lo;
  return lo;
}

function apStepHeli(model, state, controls, ap, dt, env) {
  const plan = ap.plan;
  const ground = (x, z) => (env && env.groundHeightAt ? env.groundHeightAt(x, z) : 0);
  const say = (phase, text) => {
    if (ap.phase === phase) return;
    ap.phase = phase; ap.statusText = text;
    if (env && env.announce) env.announce('自動操縦：' + text);
  };
  controls.gearDown = true;
  controls.parkingBrake = false;
  controls.brake = 0;
  if (!plan) { apStepHeliHover(model, state, controls, ap, dt, env); return; }
  const tx = plan.pad.x, tz = plan.pad.z;
  const dx = tx - state.position.x, dz = tz - state.position.z;
  const dist = Math.hypot(dx, dz);
  const ux = dist > 1e-3 ? dx / dist : 0, uz = dist > 1e-3 ? dz / dist : 0;
  const bearing = apBearingTo(state.position.x, state.position.z, tx, tz);
  const agl = state.altitudeAglM || 0;
  const vCruise = Math.min(model.vMaxMps * HELI_AP_CRUISE_FRAC, HELI_AP_CRUISE_MAX_MPS);
  if (ap.phase === 'takeoff' || ap.phase === 'off' || !ap.phase) say('heli_takeoff', '離陸（真上へ）');

  if (ap.phase === 'heli_takeoff') {
    heliSteer(model, state, controls, 0, 0, undefined);
    controls.throttle = heliCollectiveForVs(model, state, controls, ap, 3, dt);
    if (agl > HELI_AP_TAKEOFF_AGL_M) say('heli_cruise', '巡航');
    return;
  }
  if (ap.phase === 'heli_cruise' || ap.phase === 'heli_approach') {
    // 高さ：巡航は指示の高さ（上がれる高さまで）、ただし行く手の地形より HELI_AP_MIN_AGL_M 上。
    // 進入は降り場の上 HELI_AP_APPROACH_AGL_M へ降りる（途中の地形より下がらない）
    let floor = 0;
    const look = Math.max(state.groundSpeed * 40, 800);
    for (let d = 0; d <= look; d += 200) {
      const k = Math.min(d, dist);
      floor = Math.max(floor, ground(state.position.x + ux * k, state.position.z + uz * k));
    }
    const padY = plan.elevationM;
    let altT;
    if (ap.phase === 'heli_cruise') {
      altT = Math.max(Math.min(ap.targetAltitudeM || 1000, heliCeilingM(model)), floor + HELI_AP_MIN_AGL_M);
    } else {
      altT = Math.max(padY + HELI_AP_APPROACH_AGL_M, floor + 40);
    }
    const vs = apClamp((altT - state.altitudeM) * 0.25, -HELI_AP_VS_DOWN, HELI_AP_VS_UP);
    controls.throttle = heliCollectiveForVs(model, state, controls, ap, vs, dt);
    // 横：止まれる速さ（√(2aD)）までで目的地へ
    const v = Math.min(vCruise, Math.sqrt(2 * HELI_AP_BRAKE_MPS2 * Math.max(dist - 8, 0)));
    heliSteer(model, state, controls, ux * v, uz * v, state.groundSpeed > 12 ? bearing : (dist > 60 ? bearing : undefined));
    const brakeDist = (vCruise * vCruise) / (2 * HELI_AP_BRAKE_MPS2);
    if (ap.phase === 'heli_cruise' && dist < brakeDist + 500) say('heli_approach', '進入（減速）');
    if (ap.phase === 'heli_approach' && dist < 12 && state.groundSpeed < 2) say('heli_descent', '降下（真下へ）');
    return;
  }
  if (ap.phase === 'heli_descent') {
    // 降り場の上で止まったまま、低くなるほどゆっくり降りる
    const v = Math.min(3, dist * 0.4);
    heliSteer(model, state, controls, ux * v, uz * v, undefined);
    const vs = -Math.min(3, Math.max(0.4, agl * 0.12));
    controls.throttle = heliCollectiveForVs(model, state, controls, ap, vs, dt);
    if (state.onGround) { ap.heliTouchAt = 0; say('heli_touchdown', '接地'); }
    return;
  }
  if (ap.phase === 'heli_touchdown') {
    heliSteer(model, state, controls, 0, 0, undefined);
    controls.throttle = Math.max(0, controls.throttle - dt * 0.5);
    controls.parkingBrake = true;
    if (controls.throttle <= 0) {
      ap.full = false;
      say('done', `${plan.label || plan.airportId || ''} に着陸しました`);
    }
  }
}

// ヘリのホバリング（J）。その場所・その高さに止まる。出力のキーで保つ高さを上げ下げ、
// 操縦桿を倒しているあいだは手に任せ、放したところで止まり直す
function apStepHeliHover(model, state, controls, ap, dt, env) {
  const manual = (env && env.manual) || {};
  if (ap.hoverAltM === undefined) ap.hoverAltM = state.altitudeM;
  if (manual.hoverAlt) {
    const ground = state.altitudeM - (state.altitudeAglM || 0);
    ap.hoverAltM = Math.max(ap.hoverAltM + apClamp(manual.hoverAlt, -1, 1) * AP_HOVER_ADJ_MPS * dt, ground + 2);
  }
  const vs = apClamp((ap.hoverAltM - state.altitudeM) * 0.4, -HELI_AP_VS_DOWN, HELI_AP_VS_UP);
  controls.throttle = heliCollectiveForVs(model, state, controls, ap, vs, dt);
  if (manual.pitch || manual.roll || ap.hoverX === undefined) {
    ap.hoverX = state.position.x; ap.hoverZ = state.position.z;
    if (manual.pitch || manual.roll) return;   // 桿は手のまま
  }
  const dx = ap.hoverX - state.position.x, dz = ap.hoverZ - state.position.z;
  const d = Math.hypot(dx, dz), v = Math.min(5, d * 0.4);
  const yaw = controls.yaw;
  heliSteer(model, state, controls, d > 1e-3 ? dx / d * v : 0, d > 1e-3 ? dz / d * v : 0, undefined);
  if (manual.yaw) controls.yaw = yaw;
}

// ヘリの高度維持（O）。コレクティブだけ受け持ち、桿とペダルは手のまま
function apStepHeliAltHold(model, state, controls, ap, dt) {
  const vs = apClamp(((ap.targetAltitudeM || state.altitudeM) - state.altitudeM) * 0.3, -HELI_AP_VS_DOWN, HELI_AP_VS_UP);
  controls.throttle = heliCollectiveForVs(model, state, controls, ap, vs, dt);
}

function stepAutopilot(model, state, controls, ap, dt, env) {
  if (state.crashed) {
    ap.full = false; ap.altHold = false; ap.hover = false; ap.phase = 'off'; return;
  }
  if (model.isHelicopter) {
    if (ap.full) apStepHeli(model, state, controls, ap, dt, env);
    else if (ap.hover) apStepHeliHover(model, state, controls, ap, dt, env);
    else if (ap.altHold) apStepHeliAltHold(model, state, controls, ap, dt);
    return;
  }
  // 目的地までの距離（進入計画があれば最終進入開始点まで）。旋回半径をルートの
  // 長さに合わせて絞るのに使う（apCruiseTurnRadiusMax参照）。
  const distToGoM = ap.plan
    ? Math.hypot(ap.plan.faf.x - state.position.x, ap.plan.faf.z - state.position.z)
    : undefined;
  // 目的地へまっすぐ向いているか（旋回の余力を残さなくていいか）
  if (ap.full && ap.plan) {
    const bearing = Math.atan2(ap.plan.faf.x - state.position.x,
      -(ap.plan.faf.z - state.position.z)) * 180 / Math.PI;
    const err = Math.abs(apWrap180(bearing - state.headingDeg));
    ap.straightRun = ap.straightRun ? err < AP_STRAIGHT_OUT_DEG : err < AP_STRAIGHT_IN_DEG;
  } else {
    ap.straightRun = false;
  }
  // 減速の見積もりの高さは**巡航の目標高度**（いまの高さではなく）。いまの高さで測ると、
  // 沈むほど空気が濃くなって「もっと速くていい」になり、出力が戻ってまた浮く——実測でTB1が
  // マッハ9からの減速中、目標速度が上下して出力0⇔100%（推力にして重さの6.7倍）を4秒ごとに
  // 繰り返し、±30Gで振れた。目標高度で測れば、巡航中は動かない。
  const spd = apSpeedSchedule(model, distToGoM, state.airspeed, controls, ap.straightRun,
    ap.full && Number.isFinite(ap.targetAltitudeM) ? Math.max(ap.targetAltitudeM, 0) : state.altitudeM,
    state.altitudeM);
  if (ap.full) apStepFull(model, state, controls, ap, spd, dt, env);
  else if (ap.hover) apStepHover(model, state, controls, ap, spd, dt, env);
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

// 目的地の空港（選ばれていなければ null）。地図で平地を選んだときは、その帯を
// 滑走路1本の「空港」に見立てたもの（isField）。進入・引き起こし・着陸滑走はそのまま使える
function autopilotDestination() {
  const ap = flightAutopilot();
  if (ap.destField) return apFieldAirport(ap.destField);
  if (!ap.destAirportId) return null;
  return worldAirportById(ap.destAirportId);
}

function apFieldAirport(field) {
  return {
    id: 'FIELD', name: '地図で選んだ平地', isField: true,
    x: field.x, z: field.z, elevationM: field.elevationM, elevA: field.elevA, elevB: field.elevB,
    runwayLengthM: field.lengthM, headingDeg: field.headingDeg,
  };
}

// 目的地の滑走路の設定（長さと向き）。平地は探した帯そのもの
function apDestinationSettings(dest) {
  if (dest.isField) return { runwayLengthM: dest.runwayLengthM, headingDeg: dest.headingDeg };
  return getAirportSettings(dest.id);
}

// 平地に降りるのに要る長さ。接地までの空中の距離（600m）と、進入速度から
// 1.8m/s²で止まるまでの距離。2.5m/s²・400mで見積もっていたら、747が長さ1886mの帯の
// 端を251m走り越した（空港とちがって逆噴射で止まりきる前に帯が終わる）。
// いまの見積もりは練習機970m・747 2664m・Concorde 2897m・TB2 1682m・TB1 5000m（上限）。
// 垂直着陸なら狙いの点（末端の200m先）に真下へ降りるが、そこから200mほど行き過ぎて
// 止まるので、600mとる。
const AP_FIELD_DECEL = 1.8;
const AP_FIELD_AIR_M = 600;
const AP_FIELD_MIN_M = 900;
const AP_FIELD_MAX_M = 5000;
const AP_FIELD_VTOL_M = 600;
// 垂直着陸の降り場の大きさ（四方）。翼幅と脚の前後の広がりの大きいほうの1.5倍（40m以上）
function apVtolPadSize(model) {
  let zMin = 0, zMax = 0;
  for (const c of model.contacts || []) { zMin = Math.min(zMin, c.position.z); zMax = Math.max(zMax, c.position.z); }
  return Math.max(Math.max(model.wingSpan || 0, zMax - zMin) * 1.5, 40);
}

// 垂直に降りるか（ヘリはいつも。垂直離着陸機は「垂直着陸」を入れたとき）
function apVerticalLanding(model, ap) {
  return !!(model && (model.isHelicopter || (ap && ap.vtolLanding && model.hasVtol)));
}

function apFieldLengthFor(model, vtolLanding) {
  if (model.isHelicopter || (vtolLanding && model.hasVtol)) return AP_FIELD_VTOL_M;
  const v = apSpeedSchedule(model, 80000).approach;
  return apClamp(AP_FIELD_AIR_M + (v * v) / (2 * AP_FIELD_DECEL), AP_FIELD_MIN_M, AP_FIELD_MAX_M);
}

// 地図で選んだ地点 (x, z) のそばの平地を探して、目的地にする。見つかれば true
function apPickLandingField(x, z) {
  const f = EnvState.flight;
  const ap = flightAutopilot();
  if (!f.active || !f.aircraft) { announceFlight('先に飛行を始めてください'); return false; }
  const model = f.aircraft.model;
  // **垂直着陸なら長い帯は探さない**。選んだ所のすぐそばの、機体が収まる大きさの平らな所に
  // 真下へ降りる（worldFindVtolPad）。以前は垂直着陸でも600mの帯を探していたので、
  // 選んだ所から何kmも離れた所に降りたり、丘陵では見つからなかったりした。
  // 機首は風上へ向ける（風に向かってホバリングするほうが持ち場を保ちやすい）。
  const vtol = apVerticalLanding(model, ap);
  const L = vtol ? apVtolPadSize(model) : apFieldLengthFor(model, false);
  const field = vtol
    ? worldFindVtolPad(x, z, L, EnvState.env.windDirectionDeg || 0)
    : worldFindLandingField(x, z, L);
  if (!field) {
    const hint = model.hasVtol && !ap.vtolLanding ? '（垂直着陸を入れると、選んだ所のすぐそばに降りられます）' : '';
    announceFlight(vtol ? `近くに垂直着陸できる平らな所（${Math.round(L)}m四方）が見つかりませんでした`
      : `近くに降りられる平地（長さ${Math.round(L)}m）が見つかりませんでした${hint}`);
    return false;
  }
  field.pickX = x; field.pickZ = z;
  ap.destField = field;
  ap.destAirportId = null;
  if (ap.full) {
    const d = autopilotDestination();
    ap.plan = apMakeApproachPlan(d, apDestinationSettings(d), EnvState.env.windDirectionDeg);
  }
  announceFlight(vtol
    ? `垂直着陸の地点：選んだ所から${Math.round(field.searchR)}m・標高${Math.round(field.elevationM)}m`
    : `着陸地点：選んだ所から${(field.searchR / 1000).toFixed(1)}km・長さ${Math.round(L)}m・標高${Math.round(field.elevationM)}m`);
  updateAutopilotUI();
  return true;
}

// 着陸したあとの地上走行の道筋を計画に付ける（空港の誘導路を知っている画面側だけ）
function apAttachTaxi(plan, dest) {
  if (typeof airportTaxiRouteWorld !== 'function' || dest.isField) return;
  plan.taxi = airportTaxiRouteWorld(dest, getAirportSettings(dest.id));
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

  ap.plan = apMakeApproachPlan(dest, apDestinationSettings(dest), EnvState.env.windDirectionDeg);
  apAttachTaxi(ap.plan, dest);
  ap.full = true;
  ap.altHold = false;
  ap.takeoffHeadingDeg = f.state.headingDeg;
  ap.takeoffTurnDone = !f.state.onGround; // 飛んでいる途中で入れたときは、まっすぐ登る段は無い
  ap.departElevM = undefined;             // 離陸の段で、出発した地面の高さを覚える
  ap.departSec = 0;
  const vtolTakeoff = ap.vtolTakeoff && f.aircraft.model.hasVtol;
  ap.phase = f.state.onGround ? (vtolTakeoff ? 'vtol_takeoff' : 'takeoff') : 'cruise';
  ap.rotating = false;
  ap.pitchCmdDeg = undefined;
  // 自動操縦の状態は飛行をまたいで使い回されるので、前の着陸で溜めた
  // 加速度の記憶を持ち込まない
  ap.vtolLastVs = undefined;
  ap.vtolAccel = 0;
  ap.hovLastVA = undefined; ap.hovAccelA = 0; ap.hovAccelC = 0;
  ap.climbLastV = undefined;
  ap.climbAccel = 0;
  ap.statusText = f.state.onGround ? '離陸' : '巡航';
  announceFlight(`自動操縦：${dest.isField ? '' : dest.id + ' '}${dest.name} へ — ${ap.statusText}`);
  updateAutopilotUI();
  return true;
}

function toggleHover() {
  const f = EnvState.flight;
  const ap = flightAutopilot();
  if (ap.full) { stopAutopilot('自動操縦：解除'); return; }
  if (!f.active || !f.aircraft) { announceFlight('先に飛行を始めてください'); return; }
  if (!ap.hover) {
    if (!f.aircraft.model.hasVtol) {
      announceFlight('この機体は垂直離着陸用エンジンを持っていません');
      return;
    }
    // **地上では入れない**。接地しているあいだは昇降率が0のままなので、
    // 「いまの高さを保て」は「何もするな」と同じになり、押しても浮かない。
    // 浮かせるのは垂直レバー（X）の仕事で、ホバリングは浮いたあとに使う道具。
    if (f.state.onGround) {
      announceFlight(f.aircraft.model.isHelicopter ? '先に Shift（出力）で浮いてからホバリングに入れてください'
        : '先に X で浮いてからホバリングに入れてください');
      return;
    }
    ap.hover = true;
    ap.altHold = false;
    ap.hoverX = f.state.position.x;
    ap.hoverZ = f.state.position.z;
    ap.hoverAltM = f.state.altitudeM;
    ap.hoverHeadingDeg = f.state.headingDeg;
    ap.vtolLastVs = undefined;
    ap.vtolAccel = 0;
    announceFlight('ホバリング');
  } else {
    ap.hover = false;
    announceFlight('ホバリング：解除');
  }
  updateAutopilotUI();
}

function stopAutopilot(reason) {
  const ap = flightAutopilot();
  if (!ap.full && !ap.altHold && !ap.hover) return;
  ap.full = false;
  ap.altHold = false;
  ap.hover = false;
  ap.phase = 'off';
  ap.statusText = '';
  // 減速装置は自動操縦が立てたもの。手に戻すときに出しっぱなしにすると、
  // 解除した覚えのない機体がスポイラーを立てたまま飛ぶことになる。
  const c = EnvState.flight && EnvState.flight.controls;
  if (c) { c.spoiler = 0; c.reverse = 0; }
  announceFlight(reason || '自動操縦：解除');
  updateAutopilotUI();
}

function toggleAltitudeHold() {
  const f = EnvState.flight;
  const ap = flightAutopilot();
  if (ap.full) { stopAutopilot('自動操縦：解除'); return; }
  if (!f.active || !f.aircraft) { announceFlight('先に飛行を始めてください'); return; }
  ap.altHold = !ap.altHold;
  if (ap.altHold) ap.hover = false;
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
  if (!ap || (!ap.full && !ap.altHold && !ap.hover)) return;

  const wasPhase = ap.phase;
  stepAutopilot(f.aircraft.model, f.state, f.controls, ap, dt, {
    announce: announceFlight,
    // ホバリング中、どの舵を手で当てているか（apStepHover が持ち場を置き直す）
    manual: typeof flightManualAxes === 'function' ? flightManualAxes() : undefined,
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
      if (dest.value === '__field') return; // 地図で選んだ平地のまま
      ap.destAirportId = dest.value || null;
      ap.destField = null;
      // 飛んでいる途中で行き先を変えたら、経路も引き直す
      if (ap.full && ap.destAirportId) {
        const d = worldAirportById(ap.destAirportId);
        if (d) { ap.plan = apMakeApproachPlan(d, apDestinationSettings(d), EnvState.env.windDirectionDeg); apAttachTaxi(ap.plan, d); }
      }
      updateAutopilotUI();
      onEnvSettingsChanged();
      // 選び終わったら焦点を離す。セレクトに焦点が残っていると、
      // そのまま I を押しても「入力欄で打っている」と見なされて効かない。
      dest.blur();
    });
  }

  // 地図で着陸地点を選ぶ。押したあとに右の地図をクリックすると、そのそばの平地を探す
  const pick = document.getElementById('envApPickField');
  if (pick) pick.addEventListener('click', () => {
    EnvState.flight.pickingField = !EnvState.flight.pickingField;
    // 右のメニューを閉じていると地図が見えないので開く。地図は「地図」のタブにあるので、そちらへ移る
    // （選び終わったら元のタブへ戻す。03e-minimap.js の onMinimapClick）
    if (EnvState.flight.pickingField && typeof setEnvPanelCollapsed === 'function') setEnvPanelCollapsed(false);
    if (typeof setEnvTab === 'function') {
      if (EnvState.flight.pickingField) { EnvState.flight.tabBeforePick = envCurrentTab(); setEnvTab('map'); }
      else if (EnvState.flight.tabBeforePick) { setEnvTab(EnvState.flight.tabBeforePick); EnvState.flight.tabBeforePick = null; }
    }
    if (EnvState.flight.pickingField) announceFlight(EnvState.flight.aircraft && apVerticalLanding(EnvState.flight.aircraft.model, flightAutopilot())
      ? '右の地図をクリックすると、そのすぐそばに垂直着陸します（地図はドラッグで動かし、ホイール・2本指で拡大）'
      : '右の地図をクリックすると、そのそばの平地を探して着陸地点にします（地図はドラッグで動かし、ホイール・2本指で拡大）');
    updateAutopilotUI();
    pick.blur();
  });

  const alt = document.getElementById('envApAltitude');
  if (alt) {
    alt.value = ap.targetAltitudeM;
    alt.addEventListener('input', () => {
      ap.targetAltitudeM = parseFloat(alt.value);
      // ホバリング中は、保つ高さをそのまま動かす（ホバリングは毎コマ targetAltitudeM を
      // 自分の高さで上書きするので、目標高度だけ変えても戻されてしまう）
      if (ap.hover) ap.hoverAltM = ap.targetAltitudeM;
      updateAutopilotUI();
    });
    alt.addEventListener('change', onEnvSettingsChanged);
  }

  const hold = document.getElementById('envApAltHold');
  if (hold) hold.addEventListener('change', () => {
    if (hold.checked !== flightAutopilot().altHold) toggleAltitudeHold();
  });

  const hov = document.getElementById('envApHover');
  if (hov) hov.addEventListener('change', () => {
    if (hov.checked !== flightAutopilot().hover) toggleHover();
  });

  const vtolTakeoff = document.getElementById('envApVtolTakeoff');
  if (vtolTakeoff) vtolTakeoff.addEventListener('change', () => {
    flightAutopilot().vtolTakeoff = vtolTakeoff.checked;
    onEnvSettingsChanged();
  });
  const vtolLanding = document.getElementById('envApVtolLanding');
  if (vtolLanding) vtolLanding.addEventListener('change', () => {
    const ap = flightAutopilot();
    ap.vtolLanding = vtolLanding.checked;
    // 地図で選んだ着陸地点は、垂直着陸かどうかで探し方が違う（小さな降り場／長い帯）。
    // 切り替えたら、同じ選んだ地点で探し直す——垂直着陸用の降り場のまま滑走で降りると帯が足りない
    const fd = ap.destField;
    if (fd && !!fd.vtolPad !== !!(EnvState.flight.aircraft && apVerticalLanding(EnvState.flight.aircraft.model, ap))) {
      apPickLandingField(fd.pickX !== undefined ? fd.pickX : fd.x, fd.pickZ !== undefined ? fd.pickZ : fd.z);
    }
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
  const hov = document.getElementById('envApHover');
  if (hov) { hov.checked = ap.hover; hov.disabled = !hasVtol; }
  // ヘリはいつも真上へ上がって真下へ降りるので、選ばせない（入った状態で固める）
  const heli = !!(EnvState.flight.aircraft && EnvState.flight.aircraft.model.isHelicopter);
  const vtolTakeoff = document.getElementById('envApVtolTakeoff');
  if (vtolTakeoff) { vtolTakeoff.checked = heli || ap.vtolTakeoff; vtolTakeoff.disabled = !hasVtol || heli; }
  const vtolLanding = document.getElementById('envApVtolLanding');
  if (vtolLanding) { vtolLanding.checked = heli || ap.vtolLanding; vtolLanding.disabled = !hasVtol || heli; }
  const vtolHint = document.getElementById('envApVtolHint');
  if (vtolHint) {
    vtolHint.textContent = heli ? 'ヘリコプターはいつも真上へ上がって、降り場の真上から真下へ降ります。'
      : hasVtol ? '入れると滑走路を使わず、真上へ上がって／真下へ降りて発着します。'
        : 'この機体には垂直離着陸用エンジンがありません。';
  }

  // 地図で平地を選んだら、セレクトはその項目を指す（無ければ足す）
  const destSel = document.getElementById('envApDestination');
  if (destSel) {
    let opt = destSel.querySelector('option[value="__field"]');
    if (ap.destField && !opt) {
      opt = document.createElement('option');
      opt.value = '__field'; opt.textContent = '（地図で選んだ平地）';
      destSel.insertBefore(opt, destSel.children[1] || null);
    }
    if (opt) opt.hidden = !ap.destField;
    destSel.value = ap.destField ? '__field' : (ap.destAirportId || '');
  }
  const pick = document.getElementById('envApPickField');
  if (pick) pick.textContent = EnvState.flight.pickingField ? '地図をクリックしてください（もう一度押すと取りやめ）' : '🗺 地図で着陸地点を選ぶ';

  const out = document.getElementById('envApReadout');
  if (out) out.textContent = autopilotStatusLine();
}

// 目的地の呼び方（空港ならコードと名前）
function apDestinationLabel(dest) {
  return dest.isField ? dest.name : `${dest.id} ${dest.name}`;
}

// いま何をしているかの1行
function autopilotStatusLine() {
  const ap = flightAutopilot();
  const dest = autopilotDestination();
  if (ap.full) {
    const km = ap.distanceM > 0 ? `残り ${(ap.distanceM / 1000).toFixed(1)} km` : '';
    return `${dest ? (dest.isField ? '選んだ平地' : dest.id) + ' へ' : ''} ${ap.statusText}　${km}`.trim();
  }
  if (ap.hover) return `ホバリング中（高度 ${Math.round(ap.hoverAltM).toLocaleString()} m）`;
  if (ap.altHold) return `高度 ${Math.round(ap.targetAltitudeM).toLocaleString()} m を維持中`;
  if (!dest) return '目的地を選ぶと、全自動で飛べます。';
  const f = EnvState.flight;
  if (f.state) {
    const d = Math.hypot(f.state.position.x - dest.x, f.state.position.z - dest.z) / 1000;
    return `${apDestinationLabel(dest)} まで ${d.toFixed(0)} km`;
  }
  return apDestinationLabel(dest);
}

// HUDに出す短い表示（11-flight-ui.js が呼ぶ）
const AP_PHASE_LABEL = {
  takeoff: '離陸', climb: '上昇', cruise: '巡航', descent: '降下',
  approach: '進入', goaround: 'やり直し', flare: '接地', rollout: '減速', taxi: '地上走行', done: '着陸',
  vtol_takeoff: '垂直離陸', vtol_transition: '前進切替',
  vtol_approach: '進入（垂直）', vtol_hover: 'ホバリング',
  vtol_descent: '垂直降下', vtol_touchdown: '接地',
};

function autopilotHudText() {
  const ap = EnvState.flight.autopilot;
  if (!ap) return null;
  if (ap.full) return AP_PHASE_LABEL[ap.phase] || '自動';
  if (ap.hover) return 'ホバリング';
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
    apSpoilerCommand, apReverseCommand, apStepHover, apTerrainDodgeDeg, apTerrainScan,
    apPitchForVs, apBankForHeading, apFlareHeight,
    apVsForAltitude, apThrottleForSpeed, apStartTaxi, apStepTaxi,
  };
}
