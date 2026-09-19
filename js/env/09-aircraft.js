// 09-aircraft.js — 機体の飛行モデル（Builderで作った機体定義を、飛ばせる形に翻訳する）
//
// Builderが持っているのは「見た目のための定義」——翼の4頂点、エンジンの推力、重心、重量。
// ここではそれを空力の言葉に直す。翼1枚ごとに面積・翼幅・翼弦・取付角・法線を出し、
// エンジンは推力ベクトルに、着陸脚は接地点に、部品の散らばりは慣性モーメントになる。
//
// 機体の前後左右は決め打ちにしない。Builderの既定値では前縁が-Z側だが、
// +Zを向いたモデルに合わせて頂点を置いた機体も作れてしまう。
// そこで**主翼の前縁と後縁から機首の向きを読み取り**、標準の姿勢（機首-Z・上+Y・右+X）へ
// 直す補正クォータニオンを作る。以降の物理はこの標準の機体座標系だけを見ればよい。
//
// このファイルはTHREE.jsの数学（Vector3/Quaternion）だけを使い、シーンには触らない。
// Nodeからも読めるので、飛行の検証（tools/verify-flight.js）はブラウザ抜きで走る。

const AIRCRAFT_WING_CORNER_KEYS = ['rootLeading', 'rootTrailing', 'tipLeading', 'tipTrailing'];

// 空力の既定値。Builderが持っていない量はここで補う。
const AERO_DEFAULTS = {
  cd0Wing: 0.010,        // 翼の有害抗力係数（翼面積基準）
  oswald: 0.80,          // 翼効率。誘導抗力 Cdi = Cl^2/(pi*AR*e)
  stallDeg: 15,          // 失速角。これを超えるとClが崩れる
  flapMaxDeg: 30,        // フラップ全開の舵角
  controlMaxDeg: 28,     // 舵面の最大舵角（Builderのmin/maxDegがあればそちらを使う）
  surfaceEffect: 0.55,   // 舵角に対する迎角の変化率（薄翼理論の目安）
  flapEffect: 0.35,      // フラップは面積が小さいので効きも小さい（全開でCl+0.85ほど）
  // スポイラー（＝エアブレーキ）。翼の上に板を立てて、揚力を削り抗力を出す。
  // 揚力のほうはフラップを逆に使うのと同じ「キャンバーが減る」扱い、
  // 抗力のほうは立てた板の正面投影ぶん（翼面積基準）として別に足す。
  //
  // spoilerEffect は実測で合わせた。実機の旅客機は進入でスポイラーを全部立てると
  // 揚力が3割ほど落ちて揚抗比がだいたい半分になる。0.25 だと Thunderbird2 で
  // 揚力-48%・揚抗比9.3→3.2、軽い三式戦闘機では-78%まで落ちて飛べなくなり、
  // 0.15 なら -29%(9.3→4.4)、-22%、-47% と機体をまたいで実機並みに収まる。
  // spoilerDragCd のほうは、舵角20°で有害抗力+0.068（実機の0.06〜0.08）。
  spoilerEffect: 0.15,
  spoilerDragCd: 0.20,
  // 逆噴射で出せる推力（順推力に対する割合）。実機のターボファンの逆推力は
  // 定格の40〜50%ほど。
  reverseFraction: 0.45,
  fuselageCd: 1.00,      // 胴体の抗力係数（前面投影面積基準）
  gearCd: 1.00,          // 出した脚の抗力係数（gearDragArea 基準）
  fuselageSideCd: 0.80,  // 横滑りしたときの側面抗力
  propDecay: 0.75,       // 推力の速度低下。最高速度で静止推力の(1-この値)倍になる
  // 水平安定板の可動角。トリムは**安定板まるごとの取付角**を動かすもので、
  // 尾部に蝶番で付いたエレベーターとは別に効く（stabTrimRad 参照）。
  stabTrimDeg: 8,
  // 翼弦方向の減衰。翼が回れば、前縁と後縁で気流の当たる角度が変わる——
  // その差が回転を止める向きの力になる（実機の Cmq）。平板の薄翼理論で
  // Cmq = -π/4（翼弦・速度で無次元化）なので、モーメントは -(π/16)·ρ·V·S·c²·q。
  pitchDamp: Math.PI / 16,
  // 舵で増えたぶんの揚力が、翼の空力中心よりどれだけ後ろに掛かるか（翼弦に対する割合）。
  // 蝶番より後ろだけがひねられるので、増えたぶんの圧力中心は空力中心（前縁から1/4）
  // より後ろに来る。薄翼理論で 25%弦のフラップだと 0.45〜0.5弦あたり。
  hingeArmChord: 0.25,
};

// --- エンジンの種別 -----------------------------------------------------------
//
// 推力の出かたを、種別ごとに2つの数字で表す。
//   decay  : 速度が上がるとどれだけ推力が落ちるか。最高速度で (1-decay) 倍。
//   rhoPow : 空気の薄さへの強さ。(ρ/ρ0)^rhoPow を掛ける。0なら高度に無関係。
//   ab     : アフターバーナーの増し分（出力レバーを AB_FROM より上げたときだけ）。
//
// プロペラの 0.75 / 1.0 は**これまで全機に使ってきた値**そのままで、既定も prop。
// 種別を触らないかぎり、いまある機体の性能は1ノットも変わらない。
//
// ジェットの decay 0.20 は「ターボファンの推力は巡航速度あたりまでで2割ほど落ちる」
// という実機の傾向から。rhoPow 0.85 は、高度11kmで ρ/ρ0=0.30 のとき推力が
// 定格の36%（実機のターボファンは30〜40%）になる。プロペラの式（1.0乗）だと30%で、
// 実機より落ちすぎる。
// ロケットは空気を吸わないので decay も rhoPow も 0——真空でも同じ推力を出す。
const ENGINE_KINDS = {
  prop:   { label: 'プロペラ', decay: 0.75, rhoPow: 1.00, ab: 0 },
  jet:    { label: 'ジェット', decay: 0.20, rhoPow: 0.85, ab: 0 },
  jet_ab: { label: 'ジェット（AB付き）', decay: 0.20, rhoPow: 0.85, ab: 0.5 },
  rocket: { label: 'ロケット', decay: 0.00, rhoPow: 0.00, ab: 0 },
};
// アフターバーナーが点きはじめる出力レバーの位置と、全開までの幅
const ENGINE_AB_FROM = 0.90;
const ENGINE_AB_FULL = 1.00;

// kt / マッハ を m/s に直す（Builderの入力欄と同じ換算）
function speedToMps(value, unit) {
  const v = Math.max(value || 0, 0);
  return unit === 'mach' ? v * 340 : v * 0.514444;
}

// エンジンをグループにまとめる。グループごとに「出せる最高速度」を持つ。
// 同じグループのエンジンに別々の値を入れられてしまうので、いちばん大きい値を採る。
//
// **垂直離陸用のリフトエンジンはグループに入れない**。グループは
// 「前へ進むエンジンを束ねて入り切りし、束ごとに出せる最高速度を決める」ための
// 仕組みで、浮くための力とは筋が違う——数字キーで切れてしまうと、
// ホバリング中にエンジンを止めて落ちる操作ができてしまう。
// グループ0（どのキーにも割り当てていない）に置いて、常に回っている扱いにする。
function buildEngineGroups(engines, vMaxMps) {
  const map = new Map();
  for (const e of engines) {
    if (e.lift) {
      e.group = 0;
      e.groupVMaxMps = vMaxMps;
      e.groupVMaxExplicit = false;
      continue;
    }
    let g = map.get(e.group);
    if (!g) { g = { id: e.group, engines: [], vMaxMps: 0, explicit: false }; map.set(e.group, g); }
    g.engines.push(e);
    if (e.groupVMaxMps > 0) { g.vMaxMps = Math.max(g.vMaxMps, e.groupVMaxMps); g.explicit = true; }
  }
  const groups = [...map.values()].sort((a, b) => a.id - b.id);
  for (const g of groups) {
    if (!g.explicit) g.vMaxMps = vMaxMps;
    g.thrustN = g.engines.reduce((a, e) => a + e.thrustN, 0);
    g.label = `グループ${g.id}`;
    for (const e of g.engines) {                             // エンジン側にも配っておく
      e.groupVMaxMps = g.vMaxMps;
      e.groupVMaxExplicit = g.explicit;
    }
  }
  return groups;
}

// 舵面が「その翼のどれだけを占めるか」。
//
// この飛行モデルは舵を「親の翼まるごとを少しひねる」ものとして扱う。エレベーターと
// ラダーは尾翼のほぼ全幅にわたって付くので、それでほぼ合っている。ところが
// **エルロンは外翼の一部にしか付かない**。同じ扱いにすると「エルロンを20°切る＝主翼を
// まるごと11°ひねる」ことになり、ロールが実機の5倍以上速くなる。
// 実際そうなっていて、内蔵の練習機が毎秒310°（実機の6倍）で転がっていた。
// 数字は内蔵機（セスナ172くらいの機体）が実機並みの毎秒60°前後で転がるように合わせてある。
// ピッチの静安定はここを下回ったら「無い」と見なす（%MAC）。実測で、0%の機体は
// 自動操縦でも姿勢が発散して飛ばせず、9%あれば同じ設定のまま着陸できた。
const AC_MIN_STATIC_MARGIN_PCT = 3;

const CONTROL_SPAN_FRACTION = {
  elevator: 1.00,  // 水平尾翼の全幅
  rudder: 1.00,    // 垂直尾翼の全高
  aileron: 0.20,   // 外翼の一部だけ
  spoiler: 0.20,
  // エレボン（水平尾翼を持たない機体が主翼の後ろでピッチを取る舵）。
  // エルロンより広く取る——ロールのついでではなく、ピッチの主舵だから。
  // ここを1.00（翼まるごと）にすると舵だけで失速角を越えて**効きが逆になり**、
  // 0.20（エルロン並み）だと引き起こしに実測304kt要って離陸できない。
  elevon: 0.35,
};

// --- 小さなベクトル道具 -------------------------------------------------------

function acVec(o) { return new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0); }

// パーツ自身にかかっている拡縮（Builderの `applyPartToGizmo` が入れるもの）の代表値。
// ギズモの見た目の大きさはこれが掛かっているので、見た目に合わせたい寸法
// （エンジンのノズル径など）には必ず掛ける。
function partScale(p) {
  const s = (p && p.scale) || {};
  const v = (Math.abs(s.x === undefined ? 1 : s.x)
    + Math.abs(s.y === undefined ? 1 : s.y)
    + Math.abs(s.z === undefined ? 1 : s.z)) / 3;
  return v > 1e-6 ? v : 1;
}

// 機体まるごとにかかっている向きと大きさ（Builderの `State.model.root` の変換）。
//
// Builderでは**GLBのメッシュもパーツも同じ root の子**なので、機体全体を回すと
// 両方が一緒に回る。したがってこちらでも両方に同じだけ掛けないと食い違う。
// メッシュにだけ掛けてパーツに掛けていなかったせいで、前後を反転させた機体は
// 「パーツ（＝物理）は反転しているのに、見た目だけ元の向き」になっていた。
//
// **この回転だけは「ラジアン」で保存されている**（root.rotation をそのまま書き出しているため）。
// パーツの回転が「度」なのとは違うので、同じつもりで読むと壊れる。
function acModelMatrix(config) {
  const t = config && config.modelTransform;
  if (!t) return new THREE.Matrix4();
  const r = t.rotation || {};
  const s = t.scale || {};
  return new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x || 0, r.y || 0, r.z || 0)),
    new THREE.Vector3(s.x || 1, s.y || 1, s.z || 1)
  );
}

// パーツのローカル座標を機体座標へ移す行列（位置・回転・拡縮）。
// **Builderのパーツ回転は「度」で保存されている**（applyPartToGizmo が degToRad してから
// gizmo に入れている）。ラジアンとして読むと 180 が 28回転になり、脚も翼も明後日を向く。
function acPartMatrix(part, modelMat) {
  const r = part.rotation || {};
  const m = new THREE.Matrix4().compose(
    acVec(part.position || {}),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(r.x || 0),
      THREE.MathUtils.degToRad(r.y || 0),
      THREE.MathUtils.degToRad(r.z || 0)
    )),
    part.scale ? acVec(part.scale) : new THREE.Vector3(1, 1, 1)
  );
  return modelMat ? new THREE.Matrix4().multiplyMatrices(modelMat, m) : m;
}

// 着陸脚の先端（車輪）が、脚の付け根からどこにあるか。
// Builderの脚は「関節→伸縮節→関節→伸縮節…」を交互につないだ鎖で、
// 伸縮節は必ず -Y 方向へ伸びる（js/05-part-system.js の buildLandingGearHierarchy と同じ組み方）。
// ここを「モデル座標のY=0が接地面」と決め打ちしていたせいで、
// 地面合わせをしていない機体が地面に埋もれていた。
function acGearTipLocal(props) {
  const joints = (props && props.joints) || [];
  const struts = (props && props.struts) || [];
  // 接地に使うのは脚を出しきった状態（deployState=1）のときの先端
  const t = props && props.retractedAtZero === false ? 0 : 1;

  const m = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const n = Math.max(joints.length, struts.length);
  for (let i = 0; i < n; i++) {
    const j = joints[i];
    if (j) {
      const rad = THREE.MathUtils.degToRad(
        THREE.MathUtils.lerp(j.minDeg || 0, j.maxDeg || 0, t));
      if (j.axis === 'x') tmp.makeRotationX(rad);
      else if (j.axis === 'y') tmp.makeRotationY(rad);
      else tmp.makeRotationZ(rad);
      m.multiply(tmp);
    }
    const s = struts[i];
    if (s) {
      const len = Math.max(THREE.MathUtils.lerp(s.minLength || 0, s.maxLength || 0, t), 0.05);
      m.multiply(tmp.makeTranslation(0, -len, 0));
    }
  }
  return new THREE.Vector3().setFromMatrixPosition(m);
}

// 三角形2枚に割って四角形の面積を出す（4頂点は平面上にあるとは限らないため）
function acQuadArea(a, b, c, d) {
  const t = (p, q, r) => new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(r, p)).length() * 0.5;
  return t(a, b, c) + t(a, c, d);
}

// --- 翼1枚ぶんの幾何 ---------------------------------------------------------

// 4頂点を機体座標へ移し、前縁・後縁・付け根・翼端の中点から翼弦と翼幅を出す
function acWingGeometry(part, modelMat) {
  const m = acPartMatrix(part, modelMat);
  const P = {};
  for (const k of AIRCRAFT_WING_CORNER_KEYS) {
    const c = (part.props && part.props.corners && part.props.corners[k]) || { x: 0, y: 0, z: 0 };
    P[k] = acVec(c).applyMatrix4(m);
  }
  const mid = (a, b) => new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const leading = mid(P.rootLeading, P.tipLeading);
  const trailing = mid(P.rootTrailing, P.tipTrailing);
  const root = mid(P.rootLeading, P.rootTrailing);
  const tip = mid(P.tipLeading, P.tipTrailing);

  const center = new THREE.Vector3();
  for (const k of AIRCRAFT_WING_CORNER_KEYS) center.add(P[k]);
  center.multiplyScalar(0.25);

  return {
    corners: P, center,
    chordVec: new THREE.Vector3().subVectors(trailing, leading), // 前縁→後縁（＝後ろ向き）
    spanVec: new THREE.Vector3().subVectors(tip, root),
    area: acQuadArea(P.rootLeading, P.tipLeading, P.tipTrailing, P.rootTrailing),
  };
}

// --- 機首の向きを機体から読み取る ---------------------------------------------

// 主翼（無ければ水平尾翼、それも無ければ全部の翼）の翼弦から機首方向を決め、
// 標準の姿勢（機首-Z・上+Y）へ直すクォータニオンを返す。
function acOrientationFix(wings) {
  const pick = wings.filter((w) => w.role === 'main');
  const use = pick.length ? pick : (wings.filter((w) => w.role === 'htail').length
    ? wings.filter((w) => w.role === 'htail') : wings);

  const chord = new THREE.Vector3();
  for (const w of use) chord.add(w.geo.chordVec.clone().multiplyScalar(w.geo.area));
  if (chord.lengthSq() < 1e-12) return new THREE.Quaternion(); // 翼が無い＝直しようがない

  // 前は後縁→前縁の向き。上下の情報は翼弦には無いので、水平成分だけを使う。
  const fwd = chord.negate().normalize();
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-9) return new THREE.Quaternion();
  fwd.normalize();

  // fwd を -Z へ重ねる回転（ヨーだけ）
  const q = new THREE.Quaternion().setFromUnitVectors(fwd, new THREE.Vector3(0, 0, -1));
  return q;
}

// --- 垂直離陸用エンジンの前後バランス -------------------------------------------

// 垂直離陸用のエンジンは、重心の前後どちらかに寄っているだけでそのまま機首を振る力になる。
// ぴったり左右対称の位置に置くのは簡単でも、前後まで重心にきっちり合わせるのは難しい
// （実際、前後の調整だけがやりにくいという声があった）。
// 実機（F-35Bなど）は前後のノズルの配分を変えてこれを消しているので、ここでも同じことをする：
// 前群・後群のうち、重心まわりのモーメントが小さいほうを基準にもう片方を絞り、
// 均等に出力しても機首が振れないようにする。ぴったり位置を合わせなくても飛べるように
// なるぶん、絞った側の出力は使い切れない（性能診断にその割合を出す）。
function applyVtolTrim(engines) {
  const lift = engines.filter((e) => e.lift);
  for (const e of lift) e.trimScale = 1;
  if (lift.length < 2) return;

  const front = lift.filter((e) => e.position.z < -1e-6); // 重心より前
  const rear = lift.filter((e) => e.position.z > 1e-6);   // 重心より後ろ
  if (!front.length || !rear.length) return; // 前後どちらかにしか無ければ自動では釣り合わせられない

  const sumThrust = (arr) => arr.reduce((s, e) => s + e.thrustN, 0);
  const sumMoment = (arr) => arr.reduce((s, e) => s + e.thrustN * e.position.z, 0);
  const frontThrust = sumThrust(front), frontMoment = sumMoment(front); // 負
  const rearThrust = sumThrust(rear), rearMoment = sumMoment(rear);     // 正

  // 弱いほうを1.0のまま使い切り、強いほうをちょうど釣り合う分だけ絞る
  let kFront = 1, kRear = 1;
  if (Math.abs(frontMoment) <= rearMoment) kRear = Math.abs(frontMoment) / rearMoment;
  else kFront = rearMoment / Math.abs(frontMoment);

  for (const e of front) e.trimScale = kFront;
  for (const e of rear) e.trimScale = kRear;
}

// 前へ進むエンジンが全開のときに出るピッチモーメント（重心まわり）。
// 05e-pitch-balance.js の pbEngineMoment と同じ式。
function enginePitchMoment(engines, useTilt) {
  let total = 0;
  for (const e of engines) {
    if (e.lift) continue;
    const a = useTilt ? e.axis : e.axisNoTilt;
    const fy = a.y * e.thrustN, fz = a.z * e.thrustN;
    total += e.position.y * fz - e.position.z * fy;
  }
  return total;
}

// **エンジンの取付角は「推力のずれを打ち消す」ためのもの**——だから、
// 打ち消すどころか増やす取付角は、取付角ではなく壊れた数値である。
//
// この判定が要るのは、取付角を書き込むのが人ではなく Builder の
// 「空力バランスを整える」ボタンだから。あのボタンは重心まわりの
// モーメントを解いて rotation.x を書くが、modelTransform でまるごと
// 反転させた機体（実際に来た Boeing 747）では腕の前後が逆に出ていて、
// **ちょうど符号だけ逆の答え**を保存していた（打ち消す角は-22.2°、
// 保存されていたのは+22.2°）。ボタン側は直したが、そのころ保存した
// 機体ファイルには誤った角度が焼き付いたまま残る。
//
// 実測（747）：取付角0で推力モーメント2.94MN·m、+22.22°では5.45MN·mと
// **倍**になり、地上では尻もちをついて滑走路にめり込み、空中では
// エレベーターを一杯に当てても頭が上がり続けて離陸フェーズから出られなかった。
// 角度の大小ではなく「モーメントを減らすか増やすか」だけで見るので、
// 正しく解けている機体（TB2の10.62°＝87.96MN·m→0）はそのまま残る。
function dropHarmfulEngineTilt(engines) {
  const withTilt = enginePitchMoment(engines, true);
  const without = enginePitchMoment(engines, false);
  if (Math.abs(withTilt) <= Math.abs(without)) return false;
  for (const e of engines) {
    if (e.lift) continue;
    e.axis.copy(e.axisNoTilt);
    e.tiltIgnored = true;
  }
  return true;
}

// --- 飛行モデルを組み立てる ---------------------------------------------------

// config は Builder の保存レコード（またはportable config）と同じ形:
//   { parts:[...], cg:{x,y,z}, modelWeightKg, modelMaxSpeedValue, modelMaxSpeedUnit }
function buildAircraftModel(config) {
  const parts = (config && config.parts) || [];
  const massKg = Math.max(config && config.modelWeightKg || 1000, 50);

  // 最高速度（推力の速度低下に使う）
  const maxUnit = (config && config.modelMaxSpeedUnit) || 'kt';
  const maxVal = (config && config.modelMaxSpeedValue) || 200;
  const vMaxMps = speedToMps(maxVal, maxUnit);

  // 0) 機体まるごとの向き・大きさ。パーツもメッシュもこの下にぶら下がっているので、
  //    どのパーツ座標を読むときも最初にこれを掛ける。
  const modelMat = acModelMatrix(config);

  // 1) 翼の幾何をいったん素の機体座標で作り、機首の向きを読む
  const rawWings = parts.filter((p) => p.type === 'wing').map((p) => ({
    part: p, role: (p.props && p.props.role) || 'main', geo: acWingGeometry(p, modelMat),
  }));
  const qFix = acOrientationFix(rawWings);

  // 2) 重心。以降すべての位置は「重心からの相対」で持つ（モーメントがそのまま出せる）
  const cgModel = acVec((config && config.cg) || {}).applyMatrix4(modelMat);
  const cg = cgModel.clone().applyQuaternion(qFix);
  const toBody = (v) => v.clone().applyQuaternion(qFix).sub(cg);
  const dirBody = (v) => v.clone().applyQuaternion(qFix);

  // 3) 舵面を親の翼へ割り当てる。親指定が無ければいちばん近い翼に付ける。
  const surfaces = [];
  const wingById = new Map();
  for (const w of rawWings) {
    const geo = w.geo;
    // 力をかける点は4頂点の中心（＝翼弦の中央）ではなく**前縁から1/4**の空力中心。
    // 中央にかけると重心から1/4翼弦ぶん後ろにずれ、そのぶん機体が余計に安定してしまう。
    // 実際そうなっていて、エレベーターを一杯に引いても迎角が2°までしか上がらず、
    // 失速させることも、ゆっくり飛ぶこともできない機体になっていた。
    const center = toBody(geo.center);
    let chordVec = dirBody(geo.chordVec);
    let spanVec = dirBody(geo.spanVec);
    // **「付け根→翼端」と「前縁→後縁」が入れ替わって入っていたら直す**。
    //
    // 4隅を手で入れると、rootLeading/rootTrailing に「左端／右端」を入れて
    // しまうことがある。そうなると翼弦が左右に走る翼として読まれ、
    // 空力中心が横へずれ、舵の効きも別物になる——実測でTB2の水平尾翼は
    // 翼弦25.6m・翼幅7.5m・空力中心 x=-6.4m と読まれていた（本当は
    // 翼幅25.6m・翼弦7.5m・x=0）。**昇降舵のモーメントは実測でぴったり0**だった。
    // 翼幅は機体の横方向（垂直尾翼なら上下方向）を向くはずなので、
    // そうなっていなければ2つを入れ替える。
    const spanAxis = w.role === 'vtail' ? 'y' : 'x';
    if (Math.abs(spanVec[spanAxis]) < Math.abs(chordVec[spanAxis])) {
      const t = chordVec; chordVec = spanVec; spanVec = t;
      // 翼弦は「前縁→後縁」＝後ろ向き(+Z)でなければならない。入れ替えた側は
      // 向きが保証されないので、前を向いていたら裏返す（さもないと翼が前後逆になり、
      // 取付角の符号まで反転する）。
      if (chordVec.z < 0) chordVec.negate();
    }
    const chord = chordVec.length();
    const span = spanVec.length();
    if (geo.area < 1e-6 || chord < 1e-6 || span < 1e-6) continue;

    const fwd = chordVec.clone().negate().normalize();   // 翼の前方（≒機首方向）
    let spanA = spanVec.clone().normalize();
    // 法線が上向き（垂直尾翼なら翼幅が上向き）になるよう、翼幅の向きをそろえる。
    // ここをそろえないと、左右の翼で揚力が逆向きに出てしまう。
    if (w.role === 'vtail') {
      if (spanA.y < 0) spanA.negate();
    } else {
      if (new THREE.Vector3().crossVectors(spanA, fwd).y < 0) spanA.negate();
    }
    const up = new THREE.Vector3().crossVectors(spanA, fwd).normalize();
    center.addScaledVector(fwd, chord * 0.25); // 翼弦中央 → 前縁から1/4へ

    const surf = {
      id: w.part.id,
      name: w.part.name || w.role,
      role: w.role,
      center, fwd, spanA, up,
      area: geo.area,
      span, chord,
      // アスペクト比はあとで「左右をつないだ翼ぜんぶ」で計算し直す。
      // 片翼だけで span²/面積 を出すと実際の半分になり、誘導抗力が倍になってしまう。
      aspect: Math.max((span * span) / geo.area, 0.6),
      // 取付角：翼弦が機体の前後軸に対して持ち上がっている角度。そのまま迎角に足される。
      incidenceRad: Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)),
      side: center.x > 0.05 ? 'right' : (center.x < -0.05 ? 'left' : 'center'),
      // 舵の効き。舵面を割り当てるときに埋める
      pitch: 0, roll: 0, yaw: 0, flap: 0,
      // スポイラー（別のレバー）。揚力を削るぶんと、立てた板が出す抗力
      spoiler: 0, spoilerCd: 0,
    };
    surf.alphaGain = surfaceAlphaGain(surf);
    surfaces.push(surf);
    wingById.set(w.part.id, surf);
  }

  // 舵面 → 親の翼の迎角を動かす量として畳み込む
  for (const p of parts) {
    if (p.type !== 'control_surface') continue;
    const kind = (p.props && p.props.kind) || 'aileron';
    let target = p.props && p.props.parentWingId ? wingById.get(p.props.parentWingId) : null;
    if (!target) {
      // 親指定が無ければ、いちばん近い翼を親にする
      const pos = acVec(p.position || {}).applyMatrix4(modelMat).applyQuaternion(qFix).sub(cg);
      let best = null, bestD = Infinity;
      for (const s of surfaces) {
        const d = s.center.distanceToSquared(pos);
        if (d < bestD) { bestD = d; best = s; }
      }
      target = best;
    }
    if (!target) continue;

    const maxDeg = Math.max(
      Math.abs((p.props && p.props.maxDeg) || 0),
      Math.abs((p.props && p.props.minDeg) || 0)
    ) || AERO_DEFAULTS.controlMaxDeg;
    const gain = THREE.MathUtils.degToRad(maxDeg) * AERO_DEFAULTS.surfaceEffect
      * (CONTROL_SPAN_FRACTION[kind] || CONTROL_SPAN_FRACTION.aileron);

    // 符号は操縦桿の向きに合わせる。エレベーターは「引く＝機首上げ」なので、
    // 尾翼の迎角は下がる向き（尾を押し下げる向き）に動かす。
    // エルロンは「右へ倒す＝右へロール」なので、右翼の迎角を下げる。
    if (kind === 'elevator') target.pitch -= gain;
    else if (kind === 'rudder') target.yaw += gain;
    else if (kind === 'aileron') target.roll += gain * (target.side === 'left' ? 1 : -1);
    else if (kind === 'flap') target.flap += THREE.MathUtils.degToRad(maxDeg) * AERO_DEFAULTS.flapEffect;
    // スポイラーは**フラップとは別のレバー**。ここを target.flap の引き算にすると、
    // フラップを下ろした瞬間にスポイラーも一緒に立ち上がり、増えるはずの揚力を
    // 自分で削ってしまう——実測で Thunderbird2 のフラップ全開が、スポイラーを
    // 積んでいるせいで揚力+94%から+47%まで落ち、抗力も52kNから34kNしか出ず、
    // 「スポイラーを付けるほど降りられず止まれない機体」になっていた。
    else if (kind === 'spoiler') {
      target.spoiler += THREE.MathUtils.degToRad(maxDeg) * AERO_DEFAULTS.spoilerEffect;
      target.spoilerCd += Math.sin(THREE.MathUtils.degToRad(maxDeg)) * AERO_DEFAULTS.spoilerDragCd;
    }
  }

  // **1枚の翼に積み上がった舵の効きに上限を置く**。
  //
  // 舵面をいくつ重ねても、その翼が流れを曲げられる量には限りがある。実際の
  // 舵は30°ほどで剥がれ、それ以上切っても揚力は増えない。上限が無いと、
  // 同じ翼に何枚も舵面を貼った機体で効きが青天井になり——実測でTB2の
  // 水平尾翼は昇降舵7枚（各±80°）ぶんが積み上がって**308°**になっていた。
  // そこまで行くと迎角が失速角のはるか外へ飛び、揚力の差がゼロになって
  // **昇降舵がまったく効かない**（実測でモーメントぴったり0）。
  capControlAuthority(surfaces);
  // **昇降舵と方向舵は左右で連動している**。実機の昇降舵は左右が1本の桁で
  // つながっていて、引けば必ず両方が同じだけ動く。片側にだけ舵面を置いた
  // 機体でも、その「連動」を再現しないと引いた瞬間にロールする——実測でTB1は
  // 上側の水平尾翼の昇降舵2枚が**どちらも右パネルに紐づいていて**、
  // 右-22°／左0°。押すとロール18.4°/s、ヨー-4.0°/sが出ていた。
  balancePairedControls(surfaces);

  // 舵面が1枚も無い機体でも飛べるように、役割から最低限の効きを与える
  ensureDefaultControls(surfaces);

  // 誘導抗力に使うアスペクト比を、役割ごとに「左右をつないだ翼ぜんぶ」で出し直す
  applyGroupAspect(surfaces);

  // 4) エンジン
  // 推力の向きは Builder の spinAxis（プロペラ/ファンの回転軸）から決める。
  // z＝前向き（ふつうの推進）、y＝上向き（垂直離陸用のリフトエンジン）、x＝横向き。
  //
  // spinAxis はモデル座標の軸ではなく、**Builderの画面で見えている向き**（＝
  // modelTransform を適用したあとの見た目）を指す約束——ユーザーは常にその画面を
  // 見ながら「前」「上」「横」を選ぶ。なので modelTransform の回転はここでは掛けない。
  // 掛けてしまうと、モデルをまるごと反転させる調整（前後逆さに作られたモデルの
  // 修正）をしている機体で、主翼は正しく直るのにエンジンの推力だけ二重に
  // 回ってしまい、前へ進むはずが後ろへ進む機体になる（実際にそうなった）。
  // qFix（主翼の向きから来る自動補正）だけは掛ける——これは主翼と同じ土俵で
  // 機体の前後を最終的にそろえるためのもので、spinAxis を選ぶときに見ていた
  // 画面とは無関係に、あとから物理エンジン側が機体ぜんぶへ一律にかける補正だから。
  const engines = parts.filter((p) => p.type === 'engine').map((p) => {
    const spin = (p.props && p.props.spinAxis) || 'z';
    const axis = spin === 'y' ? new THREE.Vector3(0, 1, 0)
      : (spin === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1));
    // パーツ自身の回転（度）は推力の向きに乗せる。Builderでエンジンを傾けて
    // 取り付ければ、見た目どおり推力もその向きへ出る（傾けても真後ろへ推力を
    // 出し続ける機体になっていた）。
    const r = p.rotation || {};
    // 取付角（rotation.x）を抜いた向きも作っておく。壊れた取付角を捨てるのに使う
    // （dropHarmfulEngineTilt 参照）。
    const axisNoTilt = axis.clone();
    if (r.y || r.z) {
      axisNoTilt.applyEuler(new THREE.Euler(0,
        THREE.MathUtils.degToRad(r.y || 0), THREE.MathUtils.degToRad(r.z || 0)));
    }
    if (r.x || r.y || r.z) {
      axis.applyEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(r.x || 0),
        THREE.MathUtils.degToRad(r.y || 0),
        THREE.MathUtils.degToRad(r.z || 0)
      ));
    }
    return {
      name: p.name || 'エンジン',
      spinAxis: spin,
      // 上を向いているエンジンは垂直離陸用。前へ進むためのエンジンとは別のレバーで動かす。
      lift: spin === 'y',
      position: acVec(p.position || {}).applyMatrix4(modelMat).applyQuaternion(qFix).sub(cg),
      // 向きの正規化ぶんだけ回しておく
      axis: axis.applyQuaternion(qFix).normalize(),
      axisNoTilt: axisNoTilt.applyQuaternion(qFix).normalize(),
      thrustN: Math.max((p.props && p.props.thrustKgf) || 0, 0) * 9.80665,
      // 逆噴射できるか。ジェットは排気を前へ振り向け、ターボプロップは羽根の角度を
      // 裏返して後ろへ引ける。**ふつうのプロペラ機（固定ピッチ）はできない**ので、
      // Builderの「逆噴射なし」で切れるようにしてある（内蔵の練習機や三式戦闘機）。
      canReverse: !(p.props && p.props.noReverse) && spin !== 'y',
      // 種別（推力の出かたと、排気・炎の見た目）。既定はプロペラ。
      kind: ENGINE_KINDS[(p.props && p.props.engineKind)] ? p.props.engineKind : 'prop',
      // グループ（1〜4）と、そのグループで出せる最高速度（0＝機体の最高速度）
      group: THREE.MathUtils.clamp(Math.round((p.props && p.props.engineGroup) || 1), 1, 4),
      groupVMaxMps: speedToMps((p.props && p.props.groupMaxSpeedValue) || 0,
        (p.props && p.props.groupMaxSpeedUnit) || 'mach'),
      // 排気や炎の見た目（0なら推力から自動）。
      // **パーツ自身の拡縮を必ず掛ける**。Builderのギズモは model.root の子で、
      // applyPartToGizmo が part.scale をそのまま入れるので、画面に見えている筒の
      // 太さは「入れた直径 × パーツの拡縮」になっている。ここで拡縮を無視すると、
      // 拡縮を小さくして機体モデルのエンジンに合わせた人ほど炎だけが桁違いに太くなる
      // ——実測でTB2は、見えている筒1.0m（入力10m×拡縮0.1）に対して炎が10mだった。
      plumeWidthM: Math.max((p.props && p.props.plumeWidth) || 0, 0) * partScale(p),
      plumeScale: partScale(p),
      plumeLengthScale: Math.max((p.props && p.props.plumeLength) || 1, 0),
    };
  }).filter((e) => e.thrustN > 0);
  applyVtolTrim(engines);
  const engineTiltIgnored = dropHarmfulEngineTilt(engines);
  const engineGroups = buildEngineGroups(engines, vMaxMps);

  // 4b) コックピットの目の位置。Builderで置いていなければ undefined で、
  //     飛行側は機体の大きさから決めた既定の位置を使う。
  //     パーツの回転がそのまま視線の向きになる（回転0＝真っ直ぐ前）。
  const eyePart = parts.find((p) => p.type === 'viewpoint');
  const eyeLocal = eyePart
    ? acVec(eyePart.position || {}).applyMatrix4(modelMat).applyQuaternion(qFix).sub(cg)
    : undefined;
  let eyeQuat;
  if (eyePart) {
    const r = eyePart.rotation || {};
    eyeQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(r.x || 0),
      THREE.MathUtils.degToRad(r.y || 0),
      THREE.MathUtils.degToRad(r.z || 0)
    )).premultiply(qFix);
  }

  // 5) 着陸脚の接地点。
  //    Builderの「地面にフィット」は脚の先端がモデル座標のY=0に来るように作るので、
  //    脚パーツの真下のY=0が接地点になる。脚が無い機体は境界箱の底から3点を作る。
  const gearParts = parts.filter((p) => p.type === 'landing_gear');
  let contacts = gearParts.map((p) => {
    const kind = (p.props && p.props.gearPosition) || 'other';
    // 脚を出しきったときの車輪の位置を、関節と伸縮節をたどって実際に求める
    const tip = acGearTipLocal(p.props).applyMatrix4(acPartMatrix(p, modelMat));
    return {
      name: p.name || kind,
      kind,
      position: tip.applyQuaternion(qFix).sub(cg),
      steer: false, brake: false,
    };
  });
  if (!contacts.length) contacts = fallbackContacts(surfaces, cg);
  assignGearRoles(contacts);

  // 6) 慣性モーメント。部品の広がりを箱と見なして概算する。
  const extent = aircraftExtent(surfaces, engines, contacts);
  const inertia = {
    // ロールは翼幅、ピッチは前後長、ヨーはその両方が効く
    x: (massKg / 12) * (extent.y * extent.y + extent.z * extent.z) * 1.0,
    y: (massKg / 12) * (extent.x * extent.x + extent.z * extent.z) * 1.0,
    z: (massKg / 12) * (extent.x * extent.x + extent.y * extent.y) * 1.0,
  };
  // ロール慣性が小さすぎると数値が暴れるので下限を置く
  inertia.x = Math.max(inertia.x, massKg * 0.35);
  inertia.y = Math.max(inertia.y, massKg * 0.35);
  inertia.z = Math.max(inertia.z, massKg * 0.35);

  const wingArea = surfaces.filter((s) => s.role === 'main').reduce((a, s) => a + s.area, 0)
    || surfaces.reduce((a, s) => a + s.area, 0);
  const wingSpan = Math.max(...surfaces.filter((s) => s.role === 'main').map((s) => Math.abs(s.center.x) * 2 + s.span), 1);

  return {
    massKg, cg, cgModel, qFix, modelMat, vMaxMps,
    surfaces, engines, engineGroups, contacts, inertia, extent,
    wingArea, wingSpan,
    // 胴体の抗力。境界箱から出すと**翼幅を胴体の幅として数えてしまい**、
    // 前面投影が6m²を超えて推力の何倍もの抗力になる（実際にそうなって飛ばなかった）。
    // 機体の大きさに比例する量として翼面積から見積もるほうが素直で外さない。
    // 前面 0.022×翼面積（Cd=1.0）で、翼面積基準の有害抗力係数が 0.02 前後になる。
    fuselageFrontArea: Math.max(0.022 * wingArea, 0.15),
    fuselageSideArea: Math.max(0.10 * wingArea, 0.6),
    // 出した脚の前面投影。実機の旅客機は脚を出すと有害抗力がほぼ倍になるので、
    // 胴体の前面（0.022×翼面積）と同じくらいの大きさに取る。
    gearDragArea: 0.020 * wingArea,
    totalThrustN: engines.reduce((a, e) => a + (e.lift ? 0 : e.thrustN), 0),
    // 前後バランスで絞ったぶんを差し引いた「実際に使える」垂直推力
    vtolThrustN: engines.reduce((a, e) => a + (e.lift ? e.thrustN * e.trimScale : 0), 0),
    vtolThrustNRaw: engines.reduce((a, e) => a + (e.lift ? e.thrustN : 0), 0),
    hasVtol: engines.some((e) => e.lift),
    // 減速装置を持っているか。自動操縦と計器は「積んでいる機体だけ使う」ので、
    // 持っていない機体に効かないレバーを引かせないためにここで数えておく。
    hasSpoiler: surfaces.some((s) => s.spoiler > 0 || s.spoilerCd > 0),
    // 逆噴射で実際に出せる力（絞ったあと）。自動操縦はこれでレバーの量を決める。
    reverseThrustN: engines.reduce((a, e) => a + (e.canReverse ? e.thrustN : 0), 0)
      * AERO_DEFAULTS.reverseFraction,
    // 壊れた取付角を捨てたか（性能診断に出す）
    engineTiltIgnored,
    // グループが2つ以上あるか（計器とキー操作を出すかどうかの判断に使う）
    hasEngineGroups: engineGroups.length > 1,
    // アフターバーナーを持つエンジンがあるか
    hasAfterburner: engines.some((e) => e.kind === 'jet_ab'),
    // 車輪の高さ（接地点が重心からどれだけ下か）
    gearHeight: contacts.length ? -Math.min(...contacts.map((c) => c.position.y)) : 1,
    // コックピット視点（重心からの位置と、視線の向き）。置いていなければ undefined
    eyeLocal, eyeQuat,
  };
}

// 誘導抗力は「翼が空気をどれだけ広く押し下げるか」で決まるので、
// 左右に分かれた板1枚ではなく、つながった翼ぜんぶの翼幅で測る。
// 片翼だけで span²/面積 を出すと実際のアスペクト比の半分になり、
// 誘導抗力が2倍になって、まともに飛ばない機体ができあがる。
// 機体の迎角が1°増えたとき、その翼が感じる迎角は何度増えるか。
//
// 飛行モデルは「翼幅方向に流れるぶんは揚力に効かない」として落としている
// （後退角のある翼を素直に扱うための、実機の後退翼理論と同じ考え方）。ところが
// 落とすと前向き成分 u が cosΛ ぶん縮むので、**残った流れの迎角は機体の迎角より
// 大きく出る**。揚力そのものはこれで合っているが、失速の判定までその見かけの
// 迎角で行うと、後退角が強い翼ほど早く失速することになる——実測で、後退49°の
// Concorde は機体の迎角6°で翼が15.6°を感じ、7°あたりで失速していた。
// 実機のデルタ翼はむしろ深い迎角まで粘るので、これは明らかに行き過ぎ。
// 失速角は「機体の迎角で何度か」で決めたいので、その倍率をここで測っておき、
// 失速の判定にだけ掛ける（10-flight.js の stallLimit）。
function surfaceAlphaGain(s) {
  const at = (deg) => {
    const r = THREE.MathUtils.degToRad(deg);
    const local = new THREE.Vector3(0, -Math.sin(r), -Math.cos(r));
    local.addScaledVector(s.spanA, -local.dot(s.spanA));
    const u = local.dot(s.fwd), w = local.dot(s.up);
    return Math.atan2(-w, Math.abs(u) < 1e-9 ? 1e-9 : u);
  };
  const d = THREE.MathUtils.degToRad(1);
  const gain = (at(1) - at(-1)) / (2 * d);
  return THREE.MathUtils.clamp(Math.abs(gain), 1, 4);
}

function applyGroupAspect(surfaces) {
  for (const role of ['main', 'htail', 'vtail']) {
    const group = surfaces.filter((s) => s.role === role);
    if (!group.length) continue;
    const area = group.reduce((a, s) => a + s.area, 0);
    let span;
    if (role === 'vtail') {
      span = Math.max(...group.map((s) => s.span)); // 尾びれは片側だけなのでそのまま
    } else {
      // 左右対称に生えている前提で、翼端までの距離を2倍したものが全翼幅
      span = 2 * Math.max(...group.map((s) => Math.abs(s.center.x) + s.span * 0.5));
    }
    const aspect = Math.max((span * span) / Math.max(area, 1e-6), 0.6);
    for (const s of group) { s.aspect = aspect; s.groupSpan = span; s.groupArea = area; }
  }
}

// 1枚の翼が舵で曲げられる迎角の上限（実舵角30°ぶん）。
// 実際の舵はこのあたりで流れが剥がれ、それ以上切っても揚力は増えない。
const CONTROL_DEFLECT_CAP_DEG = 30;

function capControlAuthority(surfaces) {
  const cap = THREE.MathUtils.degToRad(CONTROL_DEFLECT_CAP_DEG) * AERO_DEFAULTS.surfaceEffect;
  const clip = (v) => THREE.MathUtils.clamp(v, -cap, cap);
  for (const s of surfaces) {
    s.pitch = clip(s.pitch);
    s.roll = clip(s.roll);
    s.yaw = clip(s.yaw);
  }
}

// 左右で連動する舵（昇降舵・方向舵）の効きを、同じ役割の翼どうしでならす。
//
// ならすのは面積で重みをつけた平均なので、**機体ぜんぶのピッチの効きは変えずに**、
// 左右のかたよりだけが消える（左右対称に並んだ尾翼なら、ロールのモーメントは
// Σ x·揚力 = 0 になる）。エルロンは左右で逆に動くのが仕事なので触らない。
function balancePairedControls(surfaces) {
  for (const role of ['htail', 'vtail', 'canard']) {
    const group = surfaces.filter((s) => s.role === role);
    if (group.length < 2) continue;
    const area = group.reduce((a, s) => a + s.area, 0);
    if (area < 1e-6) continue;
    const key = role === 'vtail' ? 'yaw' : 'pitch';
    const mean = group.reduce((a, s) => a + s[key] * s.area, 0) / area;
    for (const s of group) s[key] = mean;
  }
}

// 舵面を置いていない機体でも操縦できるようにする。
// 「無いものは効かない」が正しいが、それだと機体を組んだ人が飛ばせないので、
// 役割から素直に決まるぶんだけ補う（尾翼があれば舵はあるはず、という程度の仮定）。
function ensureDefaultControls(surfaces) {
  const g = THREE.MathUtils.degToRad(AERO_DEFAULTS.controlMaxDeg) * AERO_DEFAULTS.surfaceEffect;
  const has = (k) => surfaces.some((s) => Math.abs(s[k]) > 1e-6);

  if (!has('pitch')) {
    const tails = surfaces.filter((s) => s.role === 'htail');
    if (tails.length) {
      for (const s of tails) s.pitch -= g;
    } else {
      // 水平尾翼が無い機体は主翼の後ろでピッチを取る＝エレボン。エルロンと同じで
      // **翼の一部にしか付かない**ので、翼まるごとをひねる扱いにしてはいけない。
      // 全幅ぶん（15.4°）当てると主翼が舵だけで失速角を越え、**舵が逆に効く**——
      // 実測で Concorde が迎角6°から「機首下げ」を当てると +1.22MN·m の機首上げに
      // 反転し、離陸のたびに背面へ回っていた。
      for (const s of surfaces.filter((s) => s.role === 'main')) {
        s.pitch -= g * CONTROL_SPAN_FRACTION.elevon;
      }
    }
  }
  if (!has('yaw')) {
    for (const s of surfaces.filter((s) => s.role === 'vtail')) s.yaw += g;
  }
  if (!has('roll')) {
    // 舵面を置いていない機体でも、エルロンは翼の一部ぶんの効きに留める（上の表と同じ理由）
    for (const s of surfaces.filter((s) => s.role === 'main' && s.side !== 'center')) {
      s.roll += g * CONTROL_SPAN_FRACTION.aileron * (s.side === 'left' ? 1 : -1);
    }
  }
  assignTrimAuthority(surfaces);
}

// トリムがどの翼をどれだけ動かすか。
//
// **水平尾翼を持つ機体では、トリムは安定板まるごとの取付角を動かす**——実機の
// 旅客機がそうで、離着陸のたびに安定板を数度ずつ振り直している。ここを
// 「エレベーターと同じ舵に足すだけ」にしていたせいで、ピッチの効きの総量が
// エレベーターの舵角ぶんで頭打ちになっていた。実測（Boeing 747）で、
// 主翼と水平尾翼の取付角から迎角0でも +9.4MN·m の機首上げが出るのに対し、
// エレベーターは全部倒しても ±7.5MN·m しか出せず、**どの速度でも水平飛行の
// 釣り合いが取れない**（離陸すると頭が上がり続け、失速して落ちる）機体になっていた。
// 安定板まで動かせれば釣り合う。
//
// 尾翼を持たない機体（エレボンのデルタ翼など）はこれまでどおり、トリムは
// エレベーターと同じ舵を動かす。動かせる安定板がそもそも無いのだから。
function assignTrimAuthority(surfaces) {
  const stab = THREE.MathUtils.degToRad(AERO_DEFAULTS.stabTrimDeg);
  for (const s of surfaces) {
    s.trimAuth = s.pitch;
    // trimHinged … トリムが「エレベーターと同じ蝶番の舵」を動かすのか、
    // 「安定板まるごと」を動かすのか。前者は舵と同じで空力中心の後ろに力が
    // 掛かる（hingeArmChord）、後者は翼まるごとの取付角が変わるだけなので
    // 空力中心にそのまま掛かる。ここを取り違えると、エレボンしか無い機体で
    // **トリムがピッチにまったく効かなくなる**（実測でConcordeが
    // 「舵に腕が無い（no_elevator）」と診断され、トリムが端まで巻いたまま
    // 何も起きなかった）。
    s.trimHinged = true;
  }
  // 安定板はエレベーターより効く（蝶番の先だけでなく翼まるごとが動くので）。
  // エレベーターの効きを下回らせない——下回らせると、これまで飛べていた機体の
  // トリムだけが弱くなってしまう。
  for (const s of surfaces) {
    if (s.role !== 'htail' || Math.abs(s.pitch) < 1e-6) continue;
    s.trimAuth = Math.sign(s.pitch) * Math.max(Math.abs(s.pitch), stab);
    s.trimHinged = false;
  }
}

// どの車輪が「操向する1輪」でどれが「ブレーキの効く主脚」かを、**名前ではなく配置**から決める。
// gearPosition は人が付ける札なので、後ろの車輪に「前脚」と付いていることもある
// （実際そういう機体が来た）。左右に開いている対を主脚、中心線上に1つだけあるものを
// 操向輪と見なせば、札が何であっても正しく振る舞う。
function assignGearRoles(contacts) {
  if (!contacts.length) return;
  const spread = Math.max(...contacts.map((c) => Math.abs(c.position.x)));
  const isPair = (c) => Math.abs(c.position.x) > Math.max(spread * 0.35, 0.2);
  const mains = contacts.filter(isPair);
  const singles = contacts.filter((c) => !isPair(c));

  for (const c of contacts) { c.brake = false; c.steer = false; }
  if (mains.length >= 2) {
    for (const c of mains) c.brake = true;
    for (const c of singles) c.steer = true;
  } else {
    // 対が見つからない（自転車のような配置）ときは前後で振り分ける
    const sorted = contacts.slice().sort((a, b) => a.position.z - b.position.z);
    sorted[0].steer = true;
    for (const c of sorted.slice(1)) c.brake = true;
  }
}

// 脚が無い機体のための接地点（機首・左右）。境界から3点を作って三脚にする。
function fallbackContacts(surfaces, cg) {
  let minZ = 0, maxX = 1;
  for (const s of surfaces) {
    minZ = Math.min(minZ, s.center.z - s.chord);
    maxX = Math.max(maxX, Math.abs(s.center.x));
  }
  const y = -Math.max(1, maxX * 0.18); // 重心の下に適当な脚の長さ
  return [
    { name: '前脚（推定）', position: new THREE.Vector3(0, y, minZ * 0.8), steer: true, brake: false },
    { name: '主脚左（推定）', position: new THREE.Vector3(-maxX * 0.25, y, 0.4), steer: false, brake: true },
    { name: '主脚右（推定）', position: new THREE.Vector3(maxX * 0.25, y, 0.4), steer: false, brake: true },
  ].map((c) => ({ ...c, position: c.position.clone() }));
}

// 部品がどれだけ広がっているか（慣性と胴体抗力の見積もりに使う）
function aircraftExtent(surfaces, engines, contacts) {
  const box = new THREE.Box3();
  let any = false;
  const add = (v) => { box.expandByPoint(v); any = true; };
  for (const s of surfaces) {
    add(s.center.clone().addScaledVector(s.spanA, s.span * 0.5).addScaledVector(s.fwd, s.chord * 0.5));
    add(s.center.clone().addScaledVector(s.spanA, -s.span * 0.5).addScaledVector(s.fwd, -s.chord * 0.5));
  }
  for (const e of engines) add(e.position);
  for (const c of contacts) add(c.position);
  if (!any) return new THREE.Vector3(8, 2, 8);
  const size = new THREE.Vector3();
  box.getSize(size);
  return new THREE.Vector3(Math.max(size.x, 1), Math.max(size.y, 1), Math.max(size.z, 1));
}

// --- 機体が成立しているかを調べる ---------------------------------------------
//
// Builderは「その機体が飛べるか」を何も教えてくれない。組み上げて飛行モードに入って、
// 滑走路の端まで走っても浮かない——それでは何を直せばいいのか分からない。
// 翼面荷重・推力重量比・静安定・地上での引き起こし能力を出して、
// 引っかかっているところを名指しする。

const AC_CLMAX = 1.5;          // 失速時の最大揚力係数の目安
const AC_LIFTOFF_MARGIN = 1.15; // 浮上速度は失速速度の何倍か

function analyzeAircraftPerformance(model) {
  const W = model.massKg * FLIGHT_GRAVITY_APPROX;
  const S = Math.max(model.wingArea, 0.01);
  const rho = 1.225;

  const wingLoading = model.massKg / S;
  const stallMps = Math.sqrt((2 * W) / (rho * S * AC_CLMAX));
  const liftoffMps = stallMps * AC_LIFTOFF_MARGIN;
  const thrustToWeight = model.totalThrustN / W;

  // 前向きの推力だけを数える（垂直離陸用のリフトエンジンは滑走の役に立たない）。
  // リフトエンジンは前後バランスで絞った後の値（trimScale）を使う——
  // 絞る前の定格で「浮ける」と出しても、実際に使える推力はそれより少ない。
  let fwdThrust = 0, liftThrust = 0;
  for (const e of model.engines) {
    fwdThrust += e.thrustN * Math.max(-e.axis.z, 0);
    liftThrust += e.thrustN * e.trimScale * Math.max(e.axis.y, 0);
  }
  // 滑走の加速に使う「速度ぶんの落ち」は、エンジンの種別ごとに違う
  // （プロペラは速度で落ち、ロケットは落ちない）。速度の重みは推力で付ける。
  const thrustScaleAt = (v) => {
    let num = 0, den = 0;
    for (const e of model.engines) {
      const w = e.thrustN * Math.max(-e.axis.z, 0);
      if (w <= 0) continue;
      // 離陸滑走の速度なので頭打ちは効かない（第5引数は0＝頭打ちなし）
      num += w * engineThrustScale(e, v, rho, 1, 0);
      den += w;
    }
    return den > 0 ? num / den : 1;
  };

  // 滑走距離。浮上速度の7割あたりでの加速度から見積もる。
  const v = liftoffMps * 0.7;
  const q = 0.5 * rho * v * v;
  const cl = Math.min(W / Math.max(q * S, 1e-6), AC_CLMAX);
  const ar = model.surfaces.length
    ? Math.max(...model.surfaces.filter((x) => x.role === 'main').map((x) => x.aspect), 1) : 6;
  const cd = AERO_DEFAULTS.cd0Wing + (cl * cl) / (Math.PI * ar * AERO_DEFAULTS.oswald)
    + (model.fuselageFrontArea * AERO_DEFAULTS.fuselageCd) / S;
  const drag = q * S * cd;
  const propFactor = thrustScaleAt(v);
  const roll = 0.025 * Math.max(W - q * S * cl, 0);
  const accel = (fwdThrust * propFactor - drag - roll) / model.massKg;
  const takeoffM = accel > 0.05 ? (liftoffMps * liftoffMps) / (2 * accel) : null;

  // 静安定。水平の翼を面積で重み付けした位置（中立点）が重心より後ろなら安定。
  let num = 0, den = 0, mac = 1;
  for (const s of model.surfaces) {
    if (s.role !== 'main' && s.role !== 'htail') continue;
    num += s.area * s.center.z;
    den += s.area;
    if (s.role === 'main') mac = Math.max(mac, s.chord);
  }
  const neutralZ = den > 0 ? num / den : 0;
  const staticMarginPct = (neutralZ / mac) * 100;

  // 地上で引き起こせるか。後ろの車輪を支点に、尾翼の下向きの力が重心の重さに勝てるか。
  const rear = model.contacts.length
    ? model.contacts.reduce((a, b) => (a.position.z > b.position.z ? a : b)) : null;
  let rotateRatio = null;
  if (rear) {
    const qL = 0.5 * rho * liftoffMps * liftoffMps;
    let elevatorMoment = 0;
    for (const s of model.surfaces) {
      if (Math.abs(s.pitch) < 1e-6) continue;
      const dCl = 2 * Math.PI * Math.abs(s.pitch);
      elevatorMoment += qL * s.area * dCl * Math.abs(s.center.z - rear.position.z);
    }
    const weightMoment = W * Math.abs(0 - rear.position.z);
    rotateRatio = weightMoment > 1e-6 ? elevatorMoment / weightMoment : null;
  }

  // 主翼の揚力が重心の前後どちらに、どれだけずれてかかっているか。
  // s.center は「重心からの相対」で、しかも前縁から1/4の点まで動かしてあるので、
  // ここのzがそのまま「揚力の腕」になる。ずれていると飛ばした瞬間から
  // 機首が勝手に上がる（前にずれ）／下がる（後ろにずれ）。
  let wingNum = 0, wingDen = 0;
  for (const s of model.surfaces) {
    if (s.role !== 'main') continue;
    wingNum += s.area * s.center.z;
    wingDen += s.area;
  }
  const wingAcZ = wingDen > 0 ? wingNum / wingDen : 0;
  const wingAcOffsetMac = wingAcZ / mac;

  // エンジンが重心を通っていないと、スロットルを開けただけで機体が回る。
  // 上下のずれはピッチに出る（下にあるエンジン＝機首上げ）。
  // リフトエンジンは前後バランスで絞った後の値を使う——ここが釣り合っているのが
  // 自動バランスの狙いなので、絞る前の定格で見ると直したはずのズレがまだ出ていることになる。
  let thrustPitchMoment = 0;
  for (const e of model.engines) {
    const t = e.lift ? e.thrustN * e.trimScale : e.thrustN;
    thrustPitchMoment += e.position.y * (e.axis.z * t) - e.position.z * (e.axis.y * t);
  }
  // 比べる相手はエレベーターの力（浮上速度のとき、重心まわり）
  let elevatorPower = 0;
  {
    const qL = 0.5 * rho * liftoffMps * liftoffMps;
    for (const s of model.surfaces) {
      if (Math.abs(s.pitch) < 1e-6) continue;
      // 腕は「重心からの前後距離」だけではない。舵で増えたぶんの揚力は
      // その翼自身の空力中心より後ろに掛かるので、重心の真上にある翼でも
      // 翼弦ぶんの腕を持つ（10-flight.js の hingeArmChord）。ここを入れないと、
      // 尾翼を持たないデルタ機の舵の効きを 0 と報告してしまう。
      const arm = Math.abs(s.center.z) + AERO_DEFAULTS.hingeArmChord * s.chord;
      elevatorPower += qL * s.area * 2 * Math.PI * Math.abs(s.pitch) * arm;
    }
  }

  const notes = [];
  let trimForClimb = null;
  const kt = (mps) => Math.round(mps * 1.94384);
  if (wingLoading > 900) {
    notes.push({ level: 'error', text:
      `翼面荷重が ${Math.round(wingLoading)} kg/m² と非常に高く、浮くのに ${kt(liftoffMps)} kt 必要です。`
      + `翼を大きくするか重量を減らしてください。` });
  }
  if (takeoffM === null) {
    notes.push({ level: 'error', text: '推力が抗力に負けていて、滑走しても浮上速度に届きません。' });
  } else if (takeoffM > 3000) {
    notes.push({ level: 'error', text:
      `離陸に約 ${(takeoffM / 1000).toFixed(1)} km の滑走が要ります（滑走路は最長4.2km）。`
      + `推力を上げるか、翼を大きくしてください。` });
  }
  if (rotateRatio !== null && rotateRatio < 1) {
    notes.push({ level: 'error', text:
      '地上で機首を上げられません。水平尾翼が後ろの車輪の真上にあると、'
      + '舵を切っても機体を回すてこが働きません。尾翼を後ろへ、または車輪を前へ。' });
  }
  // 車輪の並びが重心を挟んでいないと、駐機しているだけで前か後ろへ倒れる。
  // 機体座標では**機首が-Z**なので、zが小さいほど前。重心はz=0。
  if (model.contacts.length >= 2) {
    const cz = model.contacts.map((c) => c.position.z);
    const cx = model.contacts.map((c) => c.position.x);
    const nose = Math.min(...cz);   // いちばん前の車輪
    const main = Math.max(...cz);   // いちばん後ろの車輪
    const wheelbase = main - nose;
    if (main < -0.05) {
      notes.push({ level: 'error', text:
        `車輪がすべて重心より前にあります（いちばん後ろの車輪でも ${(-main).toFixed(1)} m 前）。`
        + `後ろを支えるものが無いので、置いただけで尻もちをつきます。`
        + `主脚を重心より後ろへ下げるか、重心を前へ動かしてください。` });
    } else if (nose > 0.05) {
      notes.push({ level: 'error', text:
        `車輪がすべて重心より後ろにあります（いちばん前の車輪でも ${nose.toFixed(1)} m 後ろ）。`
        + `前を支えるものが無いので、機首から突っ込みます。`
        + `前脚を重心より前へ出すか、重心を後ろへ動かしてください。` });
    } else if (wheelbase > 0.1 && main < wheelbase * 0.04) {
      // 主脚が重心の真下だと、少しの揺れで尻もちをつく（実機は重心の少し後ろに置く）
      notes.push({ level: 'warn', text:
        `いちばん後ろの車輪が重心のほぼ真下（${main.toFixed(2)} m）です。`
        + `少しの揺れで尻もちをつくので、主脚をもう少し後ろへ下げてください。` });
    }
    // 左右も同じ。片側に寄っていれば横へ倒れる。
    const right = Math.max(...cx), left = -Math.min(...cx);
    if (right < 0.05 || left < 0.05) {
      notes.push({ level: 'error', text:
        '車輪が左右どちらか片側にしかありません。横に倒れます。'
        + 'ミラー複製した脚のX位置が反転しているか確かめてください。' });
    } else if (Math.min(right, left) < Math.max(right, left) * 0.5) {
      notes.push({ level: 'warn', text:
        `車輪の左右の張り出しが揃っていません（右 ${right.toFixed(1)} m / 左 ${left.toFixed(1)} m）。`
        + `狭いほうへ傾きます。ミラー複製した脚のX位置が反転しているか確かめてください。` });
    }
  }
  if (staticMarginPct < AC_MIN_STATIC_MARGIN_PCT) {
    // **静安定が0%付近の機体は、舵が効いても飛ばせない**。いちど機首が動くと
    // 戻す力がまったく無いので、自動操縦でも手動でも、当てた舵をそのぶん
    // きっちり戻さないかぎり姿勢が発散する。実測で、静安定0%のConcordeは
    // 巡航へ移った20秒後に迎角142°まで回って墜ち、重心を0.6m前へ出して
    // 静安定を9%にしただけで、同じ自動操縦のまま518秒で着陸できた。
    notes.push({ level: 'error', text:
      `ピッチが不安定です（静安定 ${staticMarginPct.toFixed(0)}% MAC、ふつうは5〜20%）。`
      + `主翼の揚力がかかる点に重心がぴったり乗っているか、それより後ろにあります。`
      + `いちど機首が動くと戻す力が出ないので、舵が効いても姿勢を保てません。`
      + `Builderの重心設定にある「空力バランスを整える」を押すか、重心を主翼より`
      + `少し前へ出してください（水平尾翼を大きくしても同じ効果があります）。` });
  } else if (staticMarginPct > 60) {
    notes.push({ level: 'warn', text:
      `安定しすぎです（静安定 ${staticMarginPct.toFixed(0)}% MAC、ふつうは5〜20%）。`
      + `水平尾翼が主翼に対して大きすぎるか後ろすぎて、迎角がほとんど0°に固定され、`
      + `舵を引いても機首が上がりにくくなります。水平尾翼を小さくしてください。` });
  }
  // トリムを一杯まで取っても水平飛行に釣り合わない機体は、飛ばす前に分かる
  if (typeof solveLevelTrim === 'function') {
    const sol = solveLevelTrim(model, liftoffMps * 1.25, 300);
    trimForClimb = sol;
    if (!sol.ok && sol.reason === 'no_elevator') {
      notes.push({ level: 'error', text:
        `ピッチ舵（エレベーター）を一杯まで振っても、機体を回すモーメントがほとんど`
        + `変わりません。舵面が重心とほぼ同じ前後位置にあり、力を出しても腕（重心からの`
        + `距離）が無いためです。水平尾翼を持たずエルロンだけの機体（デルタ翼のエレボンなど）で、`
        + `重心を主翼の空力中心にぴったり合わせると起きます——`
        + `重心を主翼より少し前へずらす（そのぶん主翼の力に腕がつきます）か、`
        + `重心から前後に離れた位置に水平尾翼とエレベーターを追加してください。` });
    } else if (!sol.ok && sol.reason === 'elevator') {
      notes.push({ level: 'warn', text:
        `トリムを一杯まで取っても、上昇速度（${kt(liftoffMps * 1.25)} kt）で釣り合いません。`
        + `水平尾翼に対してエレベーターの舵角が足りないか、水平尾翼そのものが大きすぎます。`
        + `舵角を増やすか、水平尾翼を小さくしてください。` });
    } else if (!sol.ok && sol.reason === 'wing') {
      notes.push({ level: 'warn', text:
        `上昇速度（${kt(liftoffMps * 1.25)} kt）では、失速しない迎角のままだと重さを支えられません。`
        + `主翼を大きくするか、重量を減らしてください。` });
    } else if (Math.abs(sol.trim) > 0.7) {
      notes.push({ level: 'info', text:
        `水平飛行にトリムを ${Math.round(sol.trim * 100)}% 使います。`
        + `舵の残りが少ないので、水平尾翼の取付角を ${sol.trim > 0 ? 'マイナス' : 'プラス'}側へ`
        + `少し振ると操縦しやすくなります。` });
    }
  }
  if (Math.abs(wingAcOffsetMac) > 0.15) {
    const ahead = wingAcOffsetMac < 0;
    notes.push({ level: 'warn', text:
      `主翼の揚力が重心の${ahead ? '前' : '後ろ'} ${Math.abs(wingAcZ).toFixed(2)} m`
      + `（翼弦の ${Math.abs(wingAcOffsetMac * 100).toFixed(0)}%）にかかっていて、`
      + `飛ばすと勝手に機首${ahead ? '上げ' : '下げ'}を始めます。`
      + `Builderの重心設定にある「主翼から決定」を押すと揃います。` });
  }
  if (elevatorPower > 1e-6 && Math.abs(thrustPitchMoment) > elevatorPower * 0.15) {
    const up = thrustPitchMoment > 0;
    notes.push({ level: 'warn', text:
      `エンジンが重心を通っていません（推力が重心の${up ? '下' : '上'}へ寄っている）。`
      + `スロットルを開けるほど機首${up ? '上げ' : '下げ'}になります。`
      + `上下対のエンジンが同じ位置に重なっていないか、鏡像複製を確かめてください。` });
  }
  const anyIncidence = model.surfaces.some((s) => s.role === 'main' && Math.abs(s.incidenceRad) > 0.005);
  if (!anyIncidence) {
    notes.push({ level: 'info', text:
      '主翼に取付角がありません。機体が水平のままだと揚力が出ないので、'
      + '離陸時にしっかり引き起こす必要があります。' });
  }
  if (liftThrust > 0 && liftThrust < W * 0.9) {
    notes.push({ level: 'info', text:
      `垂直離陸用の推力は重量の ${Math.round((liftThrust / W) * 100)}% です（浮くには100%必要）。` });
  }
  {
    const liftEngines = model.engines.filter((e) => e.lift);
    const hasFront = liftEngines.some((e) => e.position.z < -0.05);
    const hasRear = liftEngines.some((e) => e.position.z > 0.05);
    if (liftEngines.length > 1 && (!hasFront || !hasRear)) {
      notes.push({ level: 'warn', text:
        '垂直離陸用エンジンが重心の前後どちらかにしか無く、出力の配分を自動では釣り合わせられません。'
        + '反対側にも置くと、機体を傾けずに上がれるようになります。' });
    } else if (hasFront && hasRear && model.vtolThrustNRaw > 0
        && model.vtolThrustN < model.vtolThrustNRaw * 0.97) {
      notes.push({ level: 'info', text:
        `垂直離陸用エンジンの前後位置が重心からずれているため、出力を自動で調整し、`
        + `使える推力を定格の${Math.round((model.vtolThrustN / model.vtolThrustNRaw) * 100)}%に`
        + `抑えています。Builderで上向きエンジンを選び「推力を釣り合わせる」を押すと、`
        + `位置はそのままで推力を解き直して全部使えるようになります。` });
    }

    // 位置も推力もぴったり釣り合っていても、上がる速さそのものが姿勢制御ノズルの
    // 手に負えないほど速ければ機体は回る。水平飛行のために向いている水平尾翼が
    // 真上からの風を受けると、面積と腕の長さがそのまま桁違いの抗力モーメントになり、
    // ノズルでは追いつけなくなる——エンジンの位置や推力の釣り合いとは別の限界。
    if (typeof vtolClimbSpeedLimit === 'function') {
      const limit = vtolClimbSpeedLimit(model);
      if (limit !== null && limit < 40) {
        const accelFull = (liftThrust - W) / model.massKg;
        const timeToLimit = accelFull > 0.1 ? limit / accelFull : null;
        notes.push({ level: 'warn', text:
          `垂直に毎秒${limit.toFixed(0)}m（${kt(limit)}kt）を超えて上昇すると、`
          + `水平尾翼が真上からの風を受けて起こす力が姿勢制御ノズルの手に負えなくなり、`
          + `姿勢を保てず回転します。`
          + (timeToLimit !== null
            ? `垂直の出力を全開にすると約${timeToLimit.toFixed(1)}秒でこの速度を超えます。`
            : '')
          + `垂直レバーはゆっくり操作するか、水平尾翼を小さく・重心に近づけてください。` });
      }
    }
  }

  return {
    wingLoading, stallMps, liftoffMps, thrustToWeight,
    fwdThrust, liftThrust, takeoffM, staticMarginPct, rotateRatio, notes,
    wingAcZ, wingAcOffsetMac, thrustPitchMoment, elevatorPower, trimForClimb,
    flyable: !notes.some((n) => n.level === 'error'),
  };
}

// 10-flight.js の定数をここでも使いたいが、読み込み順が先なので同じ値を持つ
const FLIGHT_GRAVITY_APPROX = 9.80665;

// --- 内蔵の既定機 -------------------------------------------------------------
//
// Builderで機体を作っていなくても flight.html だけで飛べるようにするための1機。
// 形はBuilderの設定とまったく同じ書式で持つので、読み込み経路も飛行モデルも1本で済む。

function defaultAircraftConfig() {
  // incidDeg は取付角。前縁を持ち上げると、機体が水平のままでも迎角がついて揚力が出る。
  const wing = (id, name, role, side, x, y, z, halfSpan, chord, sweep, incidDeg) => {
    const lift = (chord / 2) * Math.sin(THREE.MathUtils.degToRad(incidDeg || 0));
    const dihedral = 0.25;
    return {
      id, type: 'wing', name,
      position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      props: {
        role, side, span: halfSpan * 2,
        corners: role === 'vtail' ? {
          rootLeading: { x: 0, y: 0, z: -chord / 2 },
          rootTrailing: { x: 0, y: 0, z: chord / 2 },
          tipLeading: { x: 0, y: halfSpan, z: -chord / 2 + sweep },
          tipTrailing: { x: 0, y: halfSpan, z: chord / 2 },
        } : {
          rootLeading: { x: 0, y: lift, z: -chord / 2 },
          rootTrailing: { x: 0, y: -lift, z: chord / 2 },
          tipLeading: { x: halfSpan * (side === 'left' ? -1 : 1), y: dihedral + lift, z: -chord / 2 + sweep },
          tipTrailing: { x: halfSpan * (side === 'left' ? -1 : 1), y: dihedral - lift, z: chord / 2 },
        },
      },
    };
  };
  const cs = (id, name, kind, parentWingId, x, y, z) => ({
    id, type: 'control_surface', name,
    position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { kind, parentWingId, minDeg: -28, maxDeg: 28, hingeAxis: 'x', spanS: 0.7 },
  });
  const gear = (id, name, pos, x, z) => ({
    id, type: 'landing_gear', name,
    position: { x, y: 0, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    props: { gearPosition: pos, deployState: 1, retractedAtZero: true, joints: [], struts: [] },
  });

  // 軽single。翼面積 約16m^2 / 翼幅11m / 1,100kg（セスナ172くらいの大きさ）
  return {
    name: '内蔵の練習機',
    builtin: true,
    modelWeightKg: 1100,
    modelMaxSpeedValue: 140,
    modelMaxSpeedUnit: 'kt',
    // 重心は主翼の中心より少し前。ここを主翼と同じ位置にすると、
    // 尾翼が釣り合うのが「揚力ゼロの迎角」になってしまい、永遠に浮かない。
    cg: { x: 0, y: 1.05, z: -0.35 },
    parts: [
      wing('w_main_l', '主翼 左', 'main', 'left', -0.55, 1.55, 0.05, 4.95, 1.55, 0.10, 3.0),
      wing('w_main_r', '主翼 右', 'main', 'right', 0.55, 1.55, 0.05, 4.95, 1.55, 0.10, 3.0),
      wing('w_htail_l', '水平尾翼 左', 'htail', 'left', -0.30, 1.25, 4.35, 1.55, 0.95, 0.16, -1.0),
      wing('w_htail_r', '水平尾翼 右', 'htail', 'right', 0.30, 1.25, 4.35, 1.55, 0.95, 0.16, -1.0),
      wing('w_vtail', '垂直尾翼', 'vtail', 'center', 0, 1.35, 4.20, 1.45, 1.20, 0.55, 0),
      cs('cs_ail_l', 'エルロン 左', 'aileron', 'w_main_l', -3.9, 1.55, 0.65),
      cs('cs_ail_r', 'エルロン 右', 'aileron', 'w_main_r', 3.9, 1.55, 0.65),
      cs('cs_flap_l', 'フラップ 左', 'flap', 'w_main_l', -1.9, 1.55, 0.65),
      cs('cs_flap_r', 'フラップ 右', 'flap', 'w_main_r', 1.9, 1.55, 0.65),
      cs('cs_elev_l', 'エレベーター 左', 'elevator', 'w_htail_l', -0.9, 1.25, 4.72),
      cs('cs_elev_r', 'エレベーター 右', 'elevator', 'w_htail_r', 0.9, 1.25, 4.72),
      cs('cs_rud', 'ラダー', 'rudder', 'w_vtail', 0, 2.1, 4.70),
      {
        id: 'eng_1', type: 'engine', name: 'エンジン',
        position: { x: 0, y: 1.25, z: -1.85 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
        // 練習機は固定ピッチのプロペラ機。羽根の角度を裏返せないので逆噴射はできない。
        props: { thrustKgf: 380, spinAxis: 'z', noReverse: true },
      },
      gear('g_nose', '前脚', 'nose', 0, -1.35),
      gear('g_main_l', '主脚 左', 'main_left', -1.30, 0.35),
      gear('g_main_r', '主脚 右', 'main_right', 1.30, 0.35),
    ],
  };
}

// Node（tools/verify-flight.js）からモデルの組み立てだけを検査できるようにする
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildAircraftModel, defaultAircraftConfig, analyzeAircraftPerformance, AERO_DEFAULTS,
  };
}
