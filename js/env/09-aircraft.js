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
  fuselageCd: 1.00,      // 胴体の抗力係数（前面投影面積基準）
  fuselageSideCd: 0.80,  // 横滑りしたときの側面抗力
  propDecay: 0.75,       // 推力の速度低下。最高速度で静止推力の(1-この値)倍になる
};

// --- 小さなベクトル道具 -------------------------------------------------------

function acVec(o) { return new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0); }

// パーツのローカル座標を機体座標へ移す行列（位置・回転・拡縮）。
// **Builderのパーツ回転は「度」で保存されている**（applyPartToGizmo が degToRad してから
// gizmo に入れている）。ラジアンとして読むと 180 が 28回転になり、脚も翼も明後日を向く。
function acPartMatrix(part) {
  const r = part.rotation || {};
  return new THREE.Matrix4().compose(
    acVec(part.position || {}),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(r.x || 0),
      THREE.MathUtils.degToRad(r.y || 0),
      THREE.MathUtils.degToRad(r.z || 0)
    )),
    part.scale ? acVec(part.scale) : new THREE.Vector3(1, 1, 1)
  );
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
function acWingGeometry(part) {
  const m = acPartMatrix(part);
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

// --- 飛行モデルを組み立てる ---------------------------------------------------

// config は Builder の保存レコード（またはportable config）と同じ形:
//   { parts:[...], cg:{x,y,z}, modelWeightKg, modelMaxSpeedValue, modelMaxSpeedUnit }
function buildAircraftModel(config) {
  const parts = (config && config.parts) || [];
  const massKg = Math.max(config && config.modelWeightKg || 1000, 50);

  // 最高速度（推力の速度低下に使う）
  const maxUnit = (config && config.modelMaxSpeedUnit) || 'kt';
  const maxVal = (config && config.modelMaxSpeedValue) || 200;
  const vMaxMps = maxUnit === 'mach' ? maxVal * 340 : maxVal * 0.514444;

  // 1) 翼の幾何をいったん素の機体座標で作り、機首の向きを読む
  const rawWings = parts.filter((p) => p.type === 'wing').map((p) => ({
    part: p, role: (p.props && p.props.role) || 'main', geo: acWingGeometry(p),
  }));
  const qFix = acOrientationFix(rawWings);

  // 2) 重心。以降すべての位置は「重心からの相対」で持つ（モーメントがそのまま出せる）
  const cg = acVec((config && config.cg) || {}).applyQuaternion(qFix);
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
    const chordVec = dirBody(geo.chordVec);
    const spanVec = dirBody(geo.spanVec);
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
    };
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
      const pos = acVec(p.position || {}).applyQuaternion(qFix).sub(cg);
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
    const gain = THREE.MathUtils.degToRad(maxDeg) * AERO_DEFAULTS.surfaceEffect;

    // 符号は操縦桿の向きに合わせる。エレベーターは「引く＝機首上げ」なので、
    // 尾翼の迎角は下がる向き（尾を押し下げる向き）に動かす。
    // エルロンは「右へ倒す＝右へロール」なので、右翼の迎角を下げる。
    if (kind === 'elevator') target.pitch -= gain;
    else if (kind === 'rudder') target.yaw += gain;
    else if (kind === 'aileron') target.roll += gain * (target.side === 'left' ? 1 : -1);
    else if (kind === 'flap') target.flap += THREE.MathUtils.degToRad(maxDeg) * AERO_DEFAULTS.flapEffect;
    else if (kind === 'spoiler') target.flap -= THREE.MathUtils.degToRad(maxDeg) * AERO_DEFAULTS.flapEffect * 0.5;
  }

  // 舵面が1枚も無い機体でも飛べるように、役割から最低限の効きを与える
  ensureDefaultControls(surfaces);

  // 誘導抗力に使うアスペクト比を、役割ごとに「左右をつないだ翼ぜんぶ」で出し直す
  applyGroupAspect(surfaces);

  // 4) エンジン
  // 推力の向きは Builder の spinAxis（プロペラ/ファンの回転軸）から決める。
  // z＝前向き（ふつうの推進）、y＝上向き（垂直離陸用のリフトエンジン）、x＝横向き。
  const engines = parts.filter((p) => p.type === 'engine').map((p) => {
    const spin = (p.props && p.props.spinAxis) || 'z';
    const axis = spin === 'y' ? new THREE.Vector3(0, 1, 0)
      : (spin === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1));
    return {
      name: p.name || 'エンジン',
      spinAxis: spin,
      // 上を向いているエンジンは垂直離陸用。前へ進むためのエンジンとは別のレバーで動かす。
      lift: spin === 'y',
      position: acVec(p.position || {}).applyQuaternion(qFix).sub(cg),
      // 回転軸そのものは機体に固定なので、向きの正規化ぶんだけ回しておく
      axis: axis.applyQuaternion(qFix).normalize(),
      thrustN: Math.max((p.props && p.props.thrustKgf) || 0, 0) * 9.80665,
    };
  }).filter((e) => e.thrustN > 0);
  applyVtolTrim(engines);

  // 5) 着陸脚の接地点。
  //    Builderの「地面にフィット」は脚の先端がモデル座標のY=0に来るように作るので、
  //    脚パーツの真下のY=0が接地点になる。脚が無い機体は境界箱の底から3点を作る。
  const gearParts = parts.filter((p) => p.type === 'landing_gear');
  let contacts = gearParts.map((p) => {
    const kind = (p.props && p.props.gearPosition) || 'other';
    // 脚を出しきったときの車輪の位置を、関節と伸縮節をたどって実際に求める
    const tip = acGearTipLocal(p.props).applyMatrix4(acPartMatrix(p));
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
    massKg, cg, qFix, vMaxMps,
    surfaces, engines, contacts, inertia, extent,
    wingArea, wingSpan,
    // 胴体の抗力。境界箱から出すと**翼幅を胴体の幅として数えてしまい**、
    // 前面投影が6m²を超えて推力の何倍もの抗力になる（実際にそうなって飛ばなかった）。
    // 機体の大きさに比例する量として翼面積から見積もるほうが素直で外さない。
    // 前面 0.022×翼面積（Cd=1.0）で、翼面積基準の有害抗力係数が 0.02 前後になる。
    fuselageFrontArea: Math.max(0.022 * wingArea, 0.15),
    fuselageSideArea: Math.max(0.10 * wingArea, 0.6),
    totalThrustN: engines.reduce((a, e) => a + (e.lift ? 0 : e.thrustN), 0),
    // 前後バランスで絞ったぶんを差し引いた「実際に使える」垂直推力
    vtolThrustN: engines.reduce((a, e) => a + (e.lift ? e.thrustN * e.trimScale : 0), 0),
    vtolThrustNRaw: engines.reduce((a, e) => a + (e.lift ? e.thrustN : 0), 0),
    hasVtol: engines.some((e) => e.lift),
    // 車輪の高さ（接地点が重心からどれだけ下か）
    gearHeight: contacts.length ? -Math.min(...contacts.map((c) => c.position.y)) : 1,
  };
}

// 誘導抗力は「翼が空気をどれだけ広く押し下げるか」で決まるので、
// 左右に分かれた板1枚ではなく、つながった翼ぜんぶの翼幅で測る。
// 片翼だけで span²/面積 を出すと実際のアスペクト比の半分になり、
// 誘導抗力が2倍になって、まともに飛ばない機体ができあがる。
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

// 舵面を置いていない機体でも操縦できるようにする。
// 「無いものは効かない」が正しいが、それだと機体を組んだ人が飛ばせないので、
// 役割から素直に決まるぶんだけ補う（尾翼があれば舵はあるはず、という程度の仮定）。
function ensureDefaultControls(surfaces) {
  const g = THREE.MathUtils.degToRad(AERO_DEFAULTS.controlMaxDeg) * AERO_DEFAULTS.surfaceEffect;
  const has = (k) => surfaces.some((s) => Math.abs(s[k]) > 1e-6);

  if (!has('pitch')) {
    const tails = surfaces.filter((s) => s.role === 'htail');
    for (const s of (tails.length ? tails : surfaces.filter((s) => s.role === 'main'))) s.pitch -= g;
  }
  if (!has('yaw')) {
    for (const s of surfaces.filter((s) => s.role === 'vtail')) s.yaw += g;
  }
  if (!has('roll')) {
    for (const s of surfaces.filter((s) => s.role === 'main' && s.side !== 'center')) {
      s.roll += g * (s.side === 'left' ? 1 : -1);
    }
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

  // 滑走距離。浮上速度の7割あたりでの加速度から見積もる。
  const v = liftoffMps * 0.7;
  const q = 0.5 * rho * v * v;
  const cl = Math.min(W / Math.max(q * S, 1e-6), AC_CLMAX);
  const ar = model.surfaces.length
    ? Math.max(...model.surfaces.filter((x) => x.role === 'main').map((x) => x.aspect), 1) : 6;
  const cd = AERO_DEFAULTS.cd0Wing + (cl * cl) / (Math.PI * ar * AERO_DEFAULTS.oswald)
    + (model.fuselageFrontArea * AERO_DEFAULTS.fuselageCd) / S;
  const drag = q * S * cd;
  const propFactor = Math.max(1 - AERO_DEFAULTS.propDecay * (v / Math.max(model.vMaxMps, 1)), 0.05);
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
      elevatorPower += qL * s.area * 2 * Math.PI * Math.abs(s.pitch) * Math.abs(s.center.z);
    }
  }

  const notes = [];
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
  if (staticMarginPct < 0) {
    notes.push({ level: 'warn', text:
      `重心が翼より後ろにあり、ピッチが不安定です（静安定 ${staticMarginPct.toFixed(0)}% MAC）。`
      + `重心を前へ出すか、水平尾翼を大きくしてください。` });
  } else if (staticMarginPct > 60) {
    notes.push({ level: 'warn', text:
      `安定しすぎです（静安定 ${staticMarginPct.toFixed(0)}% MAC、ふつうは5〜20%）。`
      + `水平尾翼が主翼に対して大きすぎるか後ろすぎて、迎角がほとんど0°に固定され、`
      + `舵を引いても機首が上がりません。水平尾翼を小さくしてください。` });
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
        + `抑えています。前後のエンジンを重心を挟んで対称に近づけるほど使える推力が増えます。` });
    }
  }

  return {
    wingLoading, stallMps, liftoffMps, thrustToWeight,
    fwdThrust, liftThrust, takeoffM, staticMarginPct, rotateRatio, notes,
    wingAcZ, wingAcOffsetMac, thrustPitchMoment, elevatorPower,
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
        props: { thrustKgf: 380, spinAxis: 'z' },
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
