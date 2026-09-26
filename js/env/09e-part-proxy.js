// 09e-part-proxy.js — 部品の「仮モデル」（Builder と flight.html の両方が読む）
//
// Builder で部品を置くと、画面にはその部品を表す仮の形が出る（銀色の脚、エンジンの筒、
// 翼の板、舵面の板）。機体のモデル（GLB）にその部品が作り込まれていないとき——たとえば
// 脚の無いモデルに脚の部品だけ置いたとき——飛行画面では何も描かれず、機体が宙に浮いて見えた。
// 部品ごとに「飛行画面でも仮モデルを出す」（props.proxyInFlight）を選べるようにし、
// オンの部品は飛行画面にも同じ形を出す。
//
// 形の作り方は**ここ1か所**にまとめ、Builder（js/05-part-system.js）もここを呼ぶ。
// 2か所に書くと、Builder で見ている形と飛行画面の形がいつの間にか食い違う。
//
// 飛行画面では、仮モデルは操縦に合わせて動く：
//   ・脚 … 脚の上げ下げ（G）で格納・展開する（PART_PROXY_GEAR_S かけて）
//   ・舵面 … 昇降舵・補助翼・方向舵・フラップ・スポイラーを操縦のとおりに振る
//   ・エンジンと翼 … 動かない
// 見た目だけで、飛び方（物理）は何も変わらない。当たり判定（09d）にも入れない。

const PART_PROXY_TYPES = ['landing_gear', 'engine', 'wing', 'control_surface'];
const PART_PROXY_GEAR_S = 4;          // 脚を出し切る／しまい切るまでの秒数
const PART_PROXY_SURFACE_SMOOTH_S = 0.08;

// ---- 翼の板 ------------------------------------------------------------------

// 翼の頂点（rootLeading, rootTrailing, tipLeading, tipTrailing。折れ目があれば kinkLeading, kinkTrailing も）から、
// 厚みを持つ板状のジオメトリを生成する。
// モデルの実際の羽根形状に頂点を合わせたとき、翼のプレースホルダー自体の見た目もそれに追従させるためのもの。
// 水平翼(main/htail)は厚みをY方向に、垂直尾翼(vtail)は厚みをX方向に加える（板が広がる平面が違うため）
// 折れ目のある翼は、付け根→折れ目→翼端の2枚の四角形をつないだ板になる（csWingStations）。
function partShapeWingGeometry(corners, role) {
  const thickness = 0.025; // 板の厚み（半分ずつオフセット）
  const half = thickness / 2;
  const thicknessAxis = role === 'vtail' ? 'x' : 'y';

  const positions = [];
  const addTri = (a, b, c) => { positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); };
  const offset = (p, sign) => ({
    x: p.x + (thicknessAxis === 'x' ? sign * half : 0),
    y: p.y + (thicknessAxis === 'y' ? sign * half : 0),
    z: p.z,
  });

  // 翼幅方向に並んだ「前縁・後縁」の組（付け根・折れ目・翼端）
  const st = csWingStations(corners);
  for (let i = 0; i + 1 < st.length; i++) {
    const [aL, aT] = st[i], [bL, bT] = st[i + 1];
    const aLU = offset(aL, 1), aTU = offset(aT, 1), bLU = offset(bL, 1), bTU = offset(bT, 1);
    const aLD = offset(aL, -1), aTD = offset(aT, -1), bLD = offset(bL, -1), bTD = offset(bT, -1);
    // 表面（+方向側）と裏面（-方向側。法線が逆になるよう頂点順を反転）
    addTri(aLU, bLU, bTU); addTri(aLU, bTU, aTU);
    addTri(aLD, bTD, bLD); addTri(aLD, aTD, bTD);
    // 前縁・後縁の側面
    addTri(aLU, aLD, bLD); addTri(aLU, bLD, bLU);
    addTri(aTU, bTD, aTD); addTri(aTU, bTU, bTD);
  }
  // 付け根と翼端の側面
  const [rl, rt] = st[0], [tl, tt] = st[st.length - 1];
  addTri(offset(rl, 1), offset(rt, -1), offset(rl, -1)); addTri(offset(rl, 1), offset(rt, 1), offset(rt, -1));
  addTri(offset(tl, 1), offset(tt, -1), offset(tl, -1)); addTri(offset(tl, 1), offset(tt, 1), offset(tt, -1));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

// ---- エンジンの筒 ------------------------------------------------------------

// エンジンのギズモを**噴射の向き**に合わせる回転。
//
// 円柱は既定で軸が+Y、**大きいほうの円（＝ノズル）が-Y側**にある。
// 噴射は推力と逆向きなので、-Y を噴射の向きへ向ける
// （＝ +Y を推力の向きへ向ける）。推力の向きは 09-aircraft.js と同じ約束で、
// spinAxis が 'z' なら -Z（機首の向き）、'x' なら +X、'y' なら +Y。
//
// **メッシュの rotation ではなくジオメトリを回す**。メッシュの rotation は
// パーツの回転（applyPartToGizmo）で上書きされるので、パーツを動かした瞬間や
// 保存から読み直した瞬間に向きが消えてしまう——実際、ノズル径を入れ直した
// ときだけ正しく、そのあと位置を動かすとまた横を向いていた。
function partShapeOrientEngine(geo, spinAxis) {
  if (spinAxis === 'y') return geo;                  // 上向き：+Yが推力、ノズルは下。そのまま
  if (spinAxis === 'x') { geo.rotateZ(-Math.PI / 2); return geo; }   // +Y → +X
  geo.rotateX(-Math.PI / 2);                         // 既定：+Y → -Z（機首の向き）
  return geo;
}

// ノズル（大きいほうの円）が -Y 側。吸い込み側は少し細くして、どちらが噴射口か見ただけで分かるようにする。
// d はノズルの直径（部品の座標系での長さ）。
function partShapeEngineGeometry(d, spinAxis) {
  const r = d / 2;
  return partShapeOrientEngine(new THREE.CylinderGeometry(r * 0.62, r, d * 1.8, 16), spinAxis);
}

// 推力からノズルの直径(m)を決める（Builder の engineNozzleDiameter と同じ式）。
// unit は機体のいちばん長い辺(m)。0 なら抑えない。
function partShapeNozzleDiameter(props, unit) {
  const w = props && props.plumeWidth;
  if (w > 0) return w;
  const kgf = Math.max((props && props.thrustKgf) || 0, 0);
  let d = Math.max(0.0016 * Math.sqrt(kgf * 9.80665), 0.06);
  if (unit > 0.2) d = Math.min(Math.max(d, unit * 0.004), unit * 0.024);
  return d;
}

// ---- 着陸脚 ------------------------------------------------------------------
// 構造：基点(Group) → [関節(Group,回転) → 伸縮節(Group,軸方向移動) → 関節 → ...] → 先端の車輪的マーカー
// joints/strutsの配列順が、そのまま基点から先端に向かうチェーンの順序になる
// 見た目は「軸を示す記号」ではなく、脚そのものを表す銀色の円柱にする（実機の脚を模した仮モデル）
const GEAR_METAL_COLOR = 0xc8ccd2;   // 銀色（脚の支柱本体）
const GEAR_ACCENT_COLOR = 0x8a8f99;  // 関節部分のアクセント（やや暗い銀）
const GEAR_TIRE_COLOR = 0x1a1a1a;    // タイヤ（先端マーカー）

function partShapeGearMaterial(color, opts) {
  return new THREE.MeshStandardMaterial(Object.assign({
    color, roughness: 0.28, metalness: 0.75,
    emissive: color, emissiveIntensity: 0.06,
  }, opts || {}));
}

function partShapeGearJoint() {
  // 関節部分：脚の支柱と同じ太さの短い円柱（回転軸そのものが脚の一部に見えるようにする）
  const group = new THREE.Group();
  const axisMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.16, 14),
    partShapeGearMaterial(GEAR_ACCENT_COLOR)
  );
  group.add(axisMesh);
  // 関節の可動を示す薄いリング（円柱よりわずかに太い径で、繋ぎ目の存在がわかるように）
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.052, 0.008, 8, 24),
    partShapeGearMaterial(0xdddddd, { metalness: 0.9, roughness: 0.15 })
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  return group;
}

function partShapeGearStrut(length) {
  // テレスコピック（入れ子シリンダー）の脚支柱。銀色の太い円柱（外筒）＋少し細い円柱（内筒）
  // 着陸脚は機体の下（-Y方向）へ伸びて地面に届く想定なので、-Y方向に伸ばす
  const group = new THREE.Group();
  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.05, length, 14),
    partShapeGearMaterial(GEAR_METAL_COLOR)
  );
  outer.position.y = -length / 2; // 基点(付け根)から-Y方向（下方向）に伸びる形にする
  group.add(outer);
  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, length * 0.55, 14),
    partShapeGearMaterial(0xe8eaed, { metalness: 0.85, roughness: 0.2 })
  );
  inner.position.y = -length * 0.78;
  group.add(inner);
  group.userData.isStrutVisual = true;
  group.userData.baseLength = length;

  // 次のセグメント（関節や先端）をぶら下げるためのアンカー。伸縮節の先端位置（-Y方向）に置く。
  // 長さが変わるたびに partShapeApplyGearDeploy 側でこのアンカーのposition.yも更新すること。
  const endAnchor = new THREE.Group();
  endAnchor.position.y = -length;
  endAnchor.userData.isStrutEndAnchor = true;
  group.add(endAnchor);

  return group;
}

// jointsとstrutsの定義から、実際の3D階層（基点→関節→伸縮節→関節→...→先端）を組み立てる
// 各関節/伸縮節のGroupはuserDataにidと種別を持つので、展開状態（partShapeApplyGearDeploy）で
// id照合して角度・長さを反映できる
function partShapeGearHierarchy(props) {
  const root = new THREE.Group();
  root.userData.isPartGizmo = true;
  root.userData.isLandingGearRoot = true;

  // 基点マーカー（付け根の位置を示す小さな球、脚の取付部分）
  const baseMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 12, 12),
    partShapeGearMaterial(GEAR_ACCENT_COLOR)
  );
  root.add(baseMarker);

  let current = root; // チェーンの末端（次のセグメントをここにぶら下げる）
  const joints = props.joints || [], struts = props.struts || [];

  // joints[i] と struts[i] を交互に、定義順（関節→伸縮節→関節→伸縮節...）でチェーンする。
  // 数が揃っていなくても対応できるよう、長い方の配列に合わせてループする
  const n = Math.max(joints.length, struts.length);
  for (let i = 0; i < n; i++) {
    const jointDef = joints[i];
    if (jointDef) {
      const jointVisual = partShapeGearJoint();
      jointVisual.userData.isJointVisual = true;
      jointVisual.userData.jointId = jointDef.id;
      current.add(jointVisual);
      current = jointVisual;
    }
    const strutDef = struts[i];
    if (strutDef) {
      const len = strutDef.minLength;
      const strutVisual = partShapeGearStrut(Math.max(len, 0.05));
      strutVisual.userData.strutId = strutDef.id;
      current.add(strutVisual);
      // 次のセグメントは伸縮節の「先端アンカー」にぶら下げる（伸縮節自体ではなく、その子）
      current = strutVisual.children.find(c => c.userData.isStrutEndAnchor);
    }
  }

  // 先端マーカー（車輪＝タイヤ相当。黒めのトーラスでそれらしく）
  const tip = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.045, 10, 20),
    new THREE.MeshStandardMaterial({ color: GEAR_TIRE_COLOR, roughness: 0.8, metalness: 0.1 })
  );
  tip.userData.isGearTip = true;
  current.add(tip);

  return root;
}

// deployState(0〜1)に応じて、各関節の角度・各伸縮節の長さを線形補間して反映する。
// 0〜1 の意味は retractedAtZero で決まる（true なら 0＝格納・1＝展開）。
function partShapeApplyGearDeploy(root, props, deployState) {
  if (!root) return;
  const t = props.retractedAtZero === false ? (1 - deployState) : deployState;
  const joints = props.joints || [], struts = props.struts || [];

  root.traverse(obj => {
    if (obj.userData.isJointVisual) {
      const jointDef = joints.find(j => j.id === obj.userData.jointId);
      if (!jointDef) return;
      const rad = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(jointDef.minDeg || 0, jointDef.maxDeg || 0, t));
      obj.rotation.set(0, 0, 0);
      if (jointDef.axis === 'x') obj.rotation.x = rad;
      else if (jointDef.axis === 'y') obj.rotation.y = rad;
      else obj.rotation.z = rad;
    }
    if (obj.userData.isStrutVisual && obj.userData.strutId) {
      const strutDef = struts.find(s => s.id === obj.userData.strutId);
      if (!strutDef) return;
      const len = Math.max(THREE.MathUtils.lerp(strutDef.minLength || 0, strutDef.maxLength || 0, t), 0.05);
      // 外筒・内筒を長さに合わせて伸ばし、endAnchor（次のセグメントの接続点）もこの長さぶん
      // 先端（-Y方向）へ押し出す——これが無いと伸縮しても先のパーツ（関節や車輪）が動かない。
      // 形は作り直さずに縦の拡縮で伸ばす（毎フレーム動かす飛行画面でジオメトリを作り直さないため）。
      const outer = obj.children[0], inner = obj.children[1], endAnchor = obj.children[2];
      const base = obj.userData.baseLength || len;
      if (outer) { outer.scale.y = len / base; outer.position.y = -len / 2; }
      if (inner) { inner.scale.y = len / base; inner.position.y = -len * 0.78; }
      if (endAnchor && endAnchor.userData.isStrutEndAnchor) endAnchor.position.y = -len;
    }
  });
}

// ---- 舵面の形（親の翼から切り取る） ------------------------------------------
//
// 舵面（エレベーター・ラダー・エルロン・フラップ・スポイラー）は、**親の翼の後ろ側を切り取った板**
// として持つ。大きさは3つの数で決まる：
//   spanFrom / spanTo … 翼幅方向の範囲（0＝付け根 〜 1＝翼端）
//   chordFrac          … 後縁から測った舵面の翼弦の割合（0.3 なら後ろ30%が動く）
// 前の辺（前縁から 1−chordFrac の線）が蝶番＝回転軸になる。
//
// 以前は舵面が「位置（翼幅のどこか）」しか持たず、効きは種類ごとの固定値だった——
// Boeing 747 の大きなフラップも、小さな練習機のフラップも同じ効き。いまは切り取った
// 大きさから効きを出す（10-flight.js・09-aircraft.js）。
// 翼そのもの（固定部＋舵面）はこれまでどおり1枚の翼として揚力を出し、舵を切ったときの
// 揚力の変化だけが、舵面が覆っている範囲の分になる（実機でも中立の舵面は翼型の一部として揚力を出す）。

// 新しく置くときの形（種類ごと）。実機の目安：エルロンは外翼の後ろ25%、昇降舵・方向舵は
// 尾翼の全幅で後ろ30%、フラップは内翼の後ろ30%、スポイラーは翼の上面の15%。
const CS_KIND_SHAPE = {
  aileron: { spanFrom: 0.65, spanTo: 0.95, chordFrac: 0.25 },
  elevator: { spanFrom: 0, spanTo: 1, chordFrac: 0.3 },
  rudder: { spanFrom: 0, spanTo: 1, chordFrac: 0.3 },
  flap: { spanFrom: 0.05, spanTo: 0.6, chordFrac: 0.3 },
  spoiler: { spanFrom: 0.25, spanTo: 0.65, chordFrac: 0.15 },
};
// 大きさを持っていなかった旧データを読み替えるときの形。**これまでと同じ効きになる大きさ**にする：
// 以前の効き（種類ごとの固定値）は「翼のどれだけを覆うか」に直すと、昇降舵・方向舵が全面、
// エルロン・スポイラーが翼面積の20%、フラップが64%（09-aircraft.js の CONTROL_SPAN_FRACTION・flapEffect）。
const CS_LEGACY_SHAPE = {
  aileron: { areaFrac: 0.2, chordFrac: 0.25 },
  elevator: { areaFrac: 1, chordFrac: 0.25 },
  rudder: { areaFrac: 1, chordFrac: 0.25 },
  flap: { areaFrac: 0.636, chordFrac: 0.25 },
  spoiler: { areaFrac: 0.2, chordFrac: 0.15 },
};
const CS_CHORD_MIN = 0.05, CS_CHORD_MAX = 0.6;

// ---- 翼の形（4頂点、または折れ目つきの6頂点） --------------------------------
//
// 翼は4頂点（付け根と翼端の前縁・後縁）の四角形。Boeing 747 のように**後縁（や前縁）が途中で折れる翼**は、
// 折れ目の前縁・後縁（kinkLeading / kinkTrailing）を足した6頂点にでき、付け根→折れ目と折れ目→翼端の
// 2枚の四角形をつないだ形として扱う。翼幅方向の位置（0=付け根〜1=翼端）は2枚を通して測り、
// 折れ目の位置は付け根・折れ目・翼端それぞれの翼弦の中点の間の長さの比で決める。
const CS_WING_KINK_KEYS = ['kinkLeading', 'kinkTrailing'];
function csWingHasKink(corners) {
  return !!(corners && corners.kinkLeading && corners.kinkTrailing);
}
// その翼の頂点の名前（折れ目があれば6つ）
function csWingCornerKeys(corners) {
  const base = ['rootLeading', 'rootTrailing', 'tipLeading', 'tipTrailing'];
  return csWingHasKink(corners) ? base.concat(CS_WING_KINK_KEYS) : base;
}
// 翼幅方向に並んだ前縁・後縁の組
function csWingStations(corners) {
  const st = [[corners.rootLeading, corners.rootTrailing]];
  if (csWingHasKink(corners)) st.push([corners.kinkLeading, corners.kinkTrailing]);
  st.push([corners.tipLeading, corners.tipTrailing]);
  return st;
}
// 折れ目の翼幅方向の位置（0〜1）。折れ目が無ければ null
function csWingKinkS(corners) {
  if (!csWingHasKink(corners)) return null;
  const m = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const r = m(corners.rootLeading, corners.rootTrailing), k = m(corners.kinkLeading, corners.kinkTrailing);
  const t = m(corners.tipLeading, corners.tipTrailing);
  const d1 = d(r, k), d2 = d(k, t);
  if (!(d1 + d2 > 1e-9)) return null;
  return Math.min(Math.max(d1 / (d1 + d2), 0.01), 0.99);
}

// 翼の中の点（spanS: 0=付け根〜1=翼端、chordT: 0=前縁〜1=後縁）。05c-wing-corners.js の wingPointAt と同じ
function csWingPoint(corners, spanS, chordT) {
  const l = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  const quad = (rL, rT, tL, tT, s) => l(l(rL, rT, chordT), l(tL, tT, chordT), s);
  const sk = csWingKinkS(corners);
  if (sk === null) return quad(corners.rootLeading, corners.rootTrailing, corners.tipLeading, corners.tipTrailing, spanS);
  if (spanS <= sk) return quad(corners.rootLeading, corners.rootTrailing, corners.kinkLeading, corners.kinkTrailing, spanS / sk);
  return quad(corners.kinkLeading, corners.kinkTrailing, corners.tipLeading, corners.tipTrailing, (spanS - sk) / (1 - sk));
}
// 4点の四角形の面積（対角線の外積の半分。少しねじれた四角形でも使える）
function csQuadArea(a, b, c, d) {
  const d1 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const d2 = { x: d.x - b.x, y: d.y - b.y, z: d.z - b.z };
  const cx = d1.y * d2.z - d1.z * d2.y, cy = d1.z * d2.x - d1.x * d2.z, cz = d1.x * d2.y - d1.y * d2.x;
  return 0.5 * Math.hypot(cx, cy, cz);
}
// 翼の、翼幅 s0〜s1・翼弦 t0〜t1 の範囲の面積（折れ目をまたぐときは2枚に分けて足す）
function csRegionArea(corners, s0, s1, t0, t1) {
  const sk = csWingKinkS(corners);
  if (sk !== null && s0 < sk && s1 > sk) return csRegionArea(corners, s0, sk, t0, t1) + csRegionArea(corners, sk, s1, t0, t1);
  return csQuadArea(csWingPoint(corners, s0, t0), csWingPoint(corners, s1, t0),
    csWingPoint(corners, s1, t1), csWingPoint(corners, s0, t1));
}

// ---- 翼の揚力のかかる点（平均空力翼弦の前縁から1/4） ----------------------------
//
// 揚力のかかる点（空力中心）は**平均空力翼弦（MAC）の前縁から1/4**。翼幅方向の各位置の
// 「前縁から1/4の点」を、その位置の面積（≒翼弦）で重みをつけて平均したものがこれになる。
// 以前は「翼幅の真ん中の、前縁から1/4」を使っていたので、後退角と先細りのある翼では
// 大きく後ろへずれていた——翼端の細い部分に引っぱられるぶんを数えていなかったため。
// 実測で Boeing 747（付け根の翼弦12.4m・翼端2.5m・後退約37°）は 2.76m 後ろ（平均空力翼弦の32%）で、
// 重心を主翼に合わせると後ろ脚より後ろに来ていた。
// corners は4頂点（x,y,z を持つ物。THREE.Vector3 でもよい）。返すのは同じ座標系の点。
//   ac   … 空力中心（平均空力翼弦の前縁から1/4）
//   mac  … 平均空力翼弦の長さ（∫c²/∫c）
//   area … 翼の面積
const CS_MAC_STRIPS = 48;
function csWingMacInfo(corners) {
  let area = 0, cx = 0, cy = 0, cz = 0, c2 = 0;
  for (let i = 0; i < CS_MAC_STRIPS; i++) {
    const s0 = i / CS_MAC_STRIPS, s1 = (i + 1) / CS_MAC_STRIPS, sm = (s0 + s1) / 2;
    const dA = csRegionArea(corners, s0, s1, 0, 1);
    const le = csWingPoint(corners, sm, 0), te = csWingPoint(corners, sm, 1);
    const chord = Math.hypot(te.x - le.x, te.y - le.y, te.z - le.z);
    const q = csWingPoint(corners, sm, 0.25);
    area += dA; cx += q.x * dA; cy += q.y * dA; cz += q.z * dA; c2 += chord * dA;
  }
  if (!(area > 1e-12)) {
    const q = csWingPoint(corners, 0.5, 0.25);
    return { ac: q, mac: 0, area: 0 };
  }
  return { ac: { x: cx / area, y: cy / area, z: cz / area }, mac: c2 / area, area };
}

// 主翼が後ろへ吹き下ろす流れで、後ろの水平尾翼の迎角の変化が減る割合 dε/dα。
// 楕円翼の吹き下ろし ε = 2·CL/(π·AR)。この飛行モデルの翼の揚力傾斜は 2π なので dε/dα = 4/AR。
// 細長い翼（アスペクト比が大きい）ほど小さい。0.9 を上限にする（尾翼が効かなくなりきらないように）。
function csDownwashSlope(mainAspect) {
  return Math.min(4 / Math.max(mainAspect, 1), 0.9);
}

// 旧データ：翼幅の中心 spanS のまわりに、翼の面積の areaFrac を覆う幅を探す（端に当たったら内へずらす）
function csLegacyRange(corners, spanS, areaFrac) {
  if (areaFrac >= 0.999) return { spanFrom: 0, spanTo: 1 };
  const total = Math.max(csRegionArea(corners, 0, 1, 0, 1), 1e-9);
  const c = Math.min(Math.max(Number.isFinite(spanS) ? spanS : 0.5, 0), 1);
  const range = (w) => {
    let a = c - w / 2, b = c + w / 2;
    if (a < 0) { b -= a; a = 0; }
    if (b > 1) { a -= b - 1; b = 1; }
    return [Math.max(a, 0), Math.min(b, 1)];
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const w = (lo + hi) / 2;
    const [a, b] = range(w);
    if (csRegionArea(corners, a, b, 0, 1) / total < areaFrac) lo = w; else hi = w;
  }
  const [a, b] = range(hi);
  return { spanFrom: a, spanTo: b };
}

// 舵面の形（範囲と翼弦比）。大きさを持っていない旧データは、これまでと同じ効きの大きさに読み替える
function csResolveShape(props, corners) {
  const kind = (props && props.kind) || 'aileron';
  const p = props || {};
  if (Number.isFinite(p.spanFrom) && Number.isFinite(p.spanTo) && Number.isFinite(p.chordFrac)) {
    const a = Math.min(Math.max(Math.min(p.spanFrom, p.spanTo), 0), 1);
    const b = Math.min(Math.max(Math.max(p.spanFrom, p.spanTo), 0), 1);
    return { spanFrom: a, spanTo: b, chordFrac: Math.min(Math.max(p.chordFrac, CS_CHORD_MIN), CS_CHORD_MAX), legacy: false };
  }
  const lg = CS_LEGACY_SHAPE[kind] || CS_LEGACY_SHAPE.aileron;
  const r = corners ? csLegacyRange(corners, p.spanS, lg.areaFrac) : { spanFrom: 0, spanTo: 1 };
  return { spanFrom: r.spanFrom, spanTo: r.spanTo, chordFrac: lg.chordFrac, legacy: true };
}

// 切り取った板の形と面積（翼のローカル座標）。
// hingeRoot/hingeTip が蝶番（前の辺）、trailRoot/trailTip が後縁。
function csPanel(corners, shape) {
  const t0 = 1 - shape.chordFrac;
  const hingeRoot = csWingPoint(corners, shape.spanFrom, t0), hingeTip = csWingPoint(corners, shape.spanTo, t0);
  const trailRoot = csWingPoint(corners, shape.spanFrom, 1), trailTip = csWingPoint(corners, shape.spanTo, 1);
  const wingArea = csRegionArea(corners, 0, 1, 0, 1);
  const stripArea = csRegionArea(corners, shape.spanFrom, shape.spanTo, 0, 1);
  const panelArea = csRegionArea(corners, shape.spanFrom, shape.spanTo, t0, 1);
  const w = Math.max(wingArea, 1e-9);
  // 舵面が翼の折れ目をまたぐときは、板も折れ目で折る
  const sk = csWingKinkS(corners);
  const kink = (sk !== null && shape.spanFrom < sk && shape.spanTo > sk)
    ? { hinge: csWingPoint(corners, sk, t0), trail: csWingPoint(corners, sk, 1) } : null;
  return {
    hingeRoot, hingeTip, trailRoot, trailTip, kink,
    hingeMid: { x: (hingeRoot.x + hingeTip.x) / 2, y: (hingeRoot.y + hingeTip.y) / 2, z: (hingeRoot.z + hingeTip.z) / 2 },
    wingArea, stripArea, panelArea,
    stripFrac: stripArea / w,   // 舵面が覆う翼幅の範囲の、翼ぜんぶに対する面積比（翼弦は全部）
    panelFrac: panelArea / w,   // 舵面そのものの面積比
  };
}

// 舵面の効き（薄翼理論のフラップ効率 τ）。舵面を δ 振ると、覆っている範囲の翼は
// 迎角が τ·δ 増えたのと同じ揚力を出す。翼弦比25%で0.61、30%で0.66、50%で0.82。
function csFlapTau(chordFrac) {
  const cf = Math.min(Math.max(chordFrac, 0.01), 0.99);
  const th = Math.acos(2 * cf - 1);
  return 1 - (th - Math.sin(th)) / Math.PI;
}
// 舵を切って増えた揚力が、翼の空力中心（前縁から1/4）からどれだけ後ろに掛かるか（翼弦に対する割合）。
// 薄翼理論で ΔCm/ΔCl = sinθ(1−cosθ) / (4(π−θ+sinθ))。翼弦比25%で0.170。
function csFlapArm(chordFrac) {
  const cf = Math.min(Math.max(chordFrac, 0.01), 0.99);
  const th = Math.acos(2 * cf - 1);
  return Math.sin(th) * (1 - Math.cos(th)) / (4 * (Math.PI - th + Math.sin(th)));
}

// 舵面の形の板（蝶番の中点を原点に置く）。Builder のギズモと飛行画面の仮モデルが使う
function partShapeControlSurfaceGeometry(panel, role) {
  const o = panel.hingeMid;
  const rel = (p) => ({ x: p.x - o.x, y: p.y - o.y, z: p.z - o.z });
  const c = {
    rootLeading: rel(panel.hingeRoot), tipLeading: rel(panel.hingeTip),
    rootTrailing: rel(panel.trailRoot), tipTrailing: rel(panel.trailTip),
  };
  if (panel.kink) { c.kinkLeading = rel(panel.kink.hinge); c.kinkTrailing = rel(panel.kink.trail); }
  return partShapeWingGeometry(c, role);
}

// 翼のパーツの変換（位置・回転(°)・拡縮）で、翼のローカル座標の点を機体（部品の入れ物）の座標へ
function csWingToParent(wingPart, p) {
  const s = wingPart.scale || { x: 1, y: 1, z: 1 };
  const r = wingPart.rotation || { x: 0, y: 0, z: 0 };
  const v = new THREE.Vector3(p.x * s.x, p.y * s.y, p.z * s.z)
    .applyEuler(new THREE.Euler(THREE.MathUtils.degToRad(r.x), THREE.MathUtils.degToRad(r.y), THREE.MathUtils.degToRad(r.z)));
  const pos = wingPart.position || { x: 0, y: 0, z: 0 };
  return { x: v.x + pos.x, y: v.y + pos.y, z: v.z + pos.z };
}

// ---- 飛行画面の仮モデル ------------------------------------------------------

const _ppQ = new THREE.Quaternion();
const _ppV = new THREE.Vector3();
const _ppAft = new THREE.Vector3();
const _ppAxis = new THREE.Vector3();

// 部品を置く入れ物（Builder の State.model.root にあたる modelXform）へ、仮モデルを足す。
// body は機体座標の入れ物（機首が-Z・上が+Y・右が+X、重心が原点）。舵の向きを測るのに使う。
// unit は機体のいちばん長い辺(m)（エンジンの筒の太さを抑える基準。Builder と同じ）。
// 返すのは毎フレーム動かすための一覧。
function buildPartProxies(config, modelXform, body, unit) {
  const out = { gears: [], surfaces: [], group: new THREE.Group(), gearT: 1 };
  out.group.name = 'partProxies';
  modelXform.add(out.group);
  const parts = (config.parts || []).filter(p => p.props && p.props.proxyInFlight
    && PART_PROXY_TYPES.includes(p.type));
  if (!parts.length) return out;

  // エンジンの筒の直径は実寸(m)。機体まるごとの拡縮ぶんで割ってから形にする（Builder と同じ）
  const s = modelXform.scale;
  const rootScale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
  const paint = (color, opts) => new THREE.MeshStandardMaterial(
    Object.assign({ color, roughness: 0.55, metalness: 0.15 }, opts || {}));
  const skin = paint(0xd6dbe1);
  const engineMat = paint(0x3a3f47, { metalness: 0.6, roughness: 0.35 });

  const placed = [];
  for (const p of parts) {
    let obj = null;
    if (p.type === 'landing_gear') {
      obj = partShapeGearHierarchy(p.props);
      partShapeApplyGearDeploy(obj, p.props, 1);
      out.gears.push({ root: obj, props: p.props });
    } else if (p.type === 'engine') {
      const d = partShapeNozzleDiameter(p.props, unit) / rootScale;
      obj = new THREE.Mesh(partShapeEngineGeometry(d, p.props.spinAxis), engineMat);
    } else if (p.type === 'wing' && p.props.corners) {
      obj = new THREE.Mesh(partShapeWingGeometry(p.props.corners, p.props.role), paint(0xd6dbe1, { side: THREE.DoubleSide }));
    } else if (p.type === 'control_surface') {
      const wing = p.props.parentWingId
        ? (config.parts || []).find(w => w.id === p.props.parentWingId && w.type === 'wing' && w.props && w.props.corners) : null;
      const pivot = new THREE.Group();
      if (wing) {
        // 親の翼から切り取った板。原点が蝶番（前の辺）の中点なので、そのまま回せば前の辺で回る
        const panel = csPanel(wing.props.corners, csResolveShape(p.props, wing.props.corners));
        pivot.add(new THREE.Mesh(partShapeControlSurfaceGeometry(panel, wing.props.role),
          paint(0xd6dbe1, { side: THREE.DoubleSide })));
        pivot.userData.csPanel = panel;
        pivot.userData.csPlace = { position: csWingToParent(wing, panel.hingeMid), rotation: wing.rotation, scale: wing.scale };
      } else {
        // 翼に付いていない舵面は小さな板。回転の中心（ヒンジ）が前縁に来るよう、形を後ろへずらしてから回す（下の aft で決める）
        pivot.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.18), skin));
      }
      obj = pivot;
    }
    if (!obj) continue;
    // 翼に付いた舵面の位置・向きは翼から決める（保存された位置は古いことがある）
    const place = obj.userData.csPlace || p;
    obj.position.set(place.position.x, place.position.y, place.position.z);
    obj.rotation.set(THREE.MathUtils.degToRad(place.rotation.x), THREE.MathUtils.degToRad(place.rotation.y),
      THREE.MathUtils.degToRad(place.rotation.z));
    obj.scale.set(place.scale.x, place.scale.y, place.scale.z);
    out.group.add(obj);
    placed.push({ part: p, obj });
  }

  // 舵面：操縦のどの入力で、どちらへ回すかを**機体座標で測って**決める。
  // 部品の回転・機体まるごとの回転（前後反転など）が掛かっているので、ローカルの軸のままでは
  // 向きが分からない。「ヒンジ軸のまわりに回したとき後縁が動く向き」を機体座標で出し、
  // 昇降舵なら「引いたとき上」、補助翼なら「右へ倒したとき右翼が上・左翼が下」……と合わせる。
  body.updateMatrixWorld(true);
  const bodyInv = new THREE.Quaternion();
  body.getWorldQuaternion(bodyInv).invert();
  for (const { part, obj } of placed) {
    if (part.type !== 'control_surface') continue;
    const props = part.props;
    const kind = props.kind || 'aileron';
    const panel = obj.userData.csPanel;
    let localAxis = props.hingeAxis === 'y' ? new THREE.Vector3(0, 1, 0)
      : props.hingeAxis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    // 翼から切り取った舵面は、蝶番（前の辺）そのものを軸にする
    if (panel) {
      localAxis = new THREE.Vector3(panel.hingeTip.x - panel.hingeRoot.x, panel.hingeTip.y - panel.hingeRoot.y,
        panel.hingeTip.z - panel.hingeRoot.z);
      if (localAxis.lengthSq() < 1e-12) continue;
      localAxis.normalize();
    }
    obj.getWorldQuaternion(_ppQ).premultiply(bodyInv);      // 部品 → 機体座標
    let axisBody = _ppAxis.copy(localAxis).applyQuaternion(_ppQ).normalize();
    // 決めてあるヒンジ軸では、その舵の動くべき向き（方向舵なら左右、ほかは上下）へ後縁が動かない
    // ときは、その向きへ動く軸（方向舵は機体の上下、ほかは左右の軸）に替える。
    // 内蔵の練習機の方向舵はヒンジ軸がXのままで、仮モデルが上下に振れていた。
    const want = kind === 'rudder' ? 'x' : 'y';
    const moveTry = new THREE.Vector3().crossVectors(axisBody, new THREE.Vector3(0, 0, 1));
    if (!panel && Math.abs(moveTry[want]) < 0.3) {
      axisBody.set(kind === 'rudder' ? 0 : 1, kind === 'rudder' ? 1 : 0, 0);
      localAxis = axisBody.clone().applyQuaternion(_ppQ.clone().invert()).normalize();
    }
    // 後ろ（機体の+Z）のうち、ヒンジ軸に直交する成分を「後縁の向き」にする
    _ppAft.set(0, 0, 1).addScaledVector(axisBody, -axisBody.z);
    if (_ppAft.lengthSq() < 1e-4) continue;                // ヒンジが前後を向いている舵は回せない
    _ppAft.normalize();
    // 形を後ろへ半分ずらして、前縁をヒンジ（部品の原点）に合わせる（切り取った板は初めから合っている）
    if (!panel) {
      const aftLocal = _ppV.copy(_ppAft).applyQuaternion(_ppQ.clone().invert());
      obj.children[0].position.copy(aftLocal).multiplyScalar(0.09);
    }
    // 回したときの後縁の動き（機体座標）
    const move = new THREE.Vector3().crossVectors(axisBody, _ppAft);
    obj.getWorldPosition(_ppV).applyMatrix4(new THREE.Matrix4().copy(body.matrixWorld).invert());
    const right = _ppV.x >= 0;
    const up = move.y, side = move.x;
    const g = { pitch: 0, roll: 0, yaw: 0, flap: 0, spoiler: 0 };
    if (kind === 'elevator') g.pitch = Math.sign(up) || 1;
    else if (kind === 'aileron') g.roll = (right ? 1 : -1) * (Math.sign(up) || 1);
    else if (kind === 'rudder') g.yaw = Math.sign(side) || 1;
    else if (kind === 'flap') g.flap = -(Math.sign(up) || 1);
    else if (kind === 'spoiler') g.spoiler = Math.sign(up) || 1;
    const maxDeg = Math.max(Math.abs(props.maxDeg || 0), Math.abs(props.minDeg || 0)) || 20;
    out.surfaces.push({
      obj, gain: g, maxRad: THREE.MathUtils.degToRad(maxDeg), angle: 0,
      rest: obj.quaternion.clone(), axis: localAxis,
    });
  }
  return out;
}

// 毎フレーム：脚の上げ下げと舵面の振れ
function updatePartProxies(ac, controls, dt) {
  const px = ac && ac.proxies;
  if (!px) return;
  if (px.gears.length) {
    const want = controls.gearDown ? 1 : 0;
    const step = dt / PART_PROXY_GEAR_S;
    const t = px.gearT + THREE.MathUtils.clamp(want - px.gearT, -step, step);
    if (t !== px.gearT) {
      px.gearT = t;
      for (const g of px.gears) partShapeApplyGearDeploy(g.root, g.props, t);
    }
  }
  if (px.surfaces.length) {
    const k = dt > 0 ? 1 - Math.exp(-dt / PART_PROXY_SURFACE_SMOOTH_S) : 1;
    const c = THREE.MathUtils.clamp;
    const pitch = c(controls.pitch || 0, -1, 1), roll = c(controls.roll || 0, -1, 1);
    const yaw = c(controls.yaw || 0, -1, 1), flap = c(controls.flap || 0, 0, 1);
    const spoiler = c(controls.spoiler || 0, 0, 1);
    for (const s of px.surfaces) {
      const g = s.gain;
      const cmd = c(g.pitch * pitch + g.roll * roll + g.yaw * yaw + g.flap * flap + g.spoiler * spoiler, -1, 1);
      s.angle += (cmd * s.maxRad - s.angle) * k;
      s.obj.quaternion.copy(s.rest).multiply(_ppQ.setFromAxisAngle(s.axis, s.angle));
    }
  }
}
