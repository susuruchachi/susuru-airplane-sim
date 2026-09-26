// 05b-cg-system.js — 機体重心（CG / 原点）の表示・調整
// パーツとは別枠：機体に1つだけ存在し、専用のクロスヘア型ギズモで表示する

function createCgGizmoMesh() {
  const group = new THREE.Group();
  const color = 0xffd23f;

  // 球（中心点）
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 16, 16),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, roughness: 0.3 })
  );
  group.add(core);

  // 3軸クロスヘア（重心らしい記号性のため、通常パーツと視覚的に区別する）
  const axisLen = 0.26;
  const mkAxis = (dir, col) => {
    const geo = new THREE.CylinderGeometry(0.012, 0.012, axisLen, 8);
    const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(geo, mat);
    if (dir === 'x') mesh.rotation.z = Math.PI / 2;
    if (dir === 'z') mesh.rotation.x = Math.PI / 2;
    return mesh;
  };
  group.add(mkAxis('x', 0xff6b6b));
  group.add(mkAxis('y', 0x5cd65c));
  group.add(mkAxis('z', 0x5c9cff));

  // 外周リング（重心マーカーであることを示す記号）
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.16, 0.008, 8, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  group.userData.isCgGizmo = true;
  return group;
}

function initCgSystem() {
  State.cg.gizmo = createCgGizmoMesh();
  State.cg.gizmo.visible = false; // モデル読込後に表示
  State.scene.add(State.cg.gizmo);
}

function showCgGizmo() {
  State.cg.gizmo.visible = true;
  applyCgToGizmo();
}

function hideCgGizmo() {
  State.cg.gizmo.visible = false;
  if (State.transformControls.object === State.cg.gizmo) {
    State.transformControls.detach();
  }
}

function applyCgToGizmo() {
  State.cg.gizmo.position.set(State.cg.position.x, State.cg.position.y, State.cg.position.z);
}

function syncCgFromGizmo() {
  State.cg.position.x = State.cg.gizmo.position.x;
  State.cg.position.y = State.cg.gizmo.position.y;
  State.cg.position.z = State.cg.gizmo.position.z;
}

function selectCg() {
  // 直前に選択されていたパーツが翼なら、頂点ハンドルを消しておく
  const prevPart = getSelectedPart();
  if (prevPart && prevPart.type === 'wing') {
    deselectWingCorner();
    detachWingCornerHandles(prevPart);
  }
  State.selectedPartId = null; // パーツ選択とは排他
  State.cg.selected = true;
  State.transformControls.attach(State.cg.gizmo);
  State.transformControls.setMode('translate'); // 重心は移動のみ（回転/拡縮の概念がない）
  document.getElementById('gizmoModeBar').style.display = 'none';
  document.getElementById('axisReadout').style.display = 'block';
  if (isMobileLayout()) openDrawer('right');
  renderPartList();
  renderInspector();
}

function deselectCg() {
  State.cg.selected = false;
  if (State.transformControls.object === State.cg.gizmo) {
    State.transformControls.detach();
  }
}

// --- 主翼の空力中心 -----------------------------------------------------------

// 機体まるごとにかかっている向き・大きさ（Builderでは State.model.root の変換）。
// 09-aircraft.js の acModelMatrix と同じもの。**root.rotation はラジアンのまま**
// （THREE.Object3Dのプロパティをそのまま読むため）。
//
// これは cgPartMatrix には**掛けない**——State.cg.position は「まだ
// modelTransformを掛けていない、パーツと同じ素のroot基準の値」として保存・
// 復元されるので（buildAircraftModelがconfig.cgへ自分でmodelMatを掛ける）、
// wingsAeroCenterByRole が返す位置もその空間のままでないと、「主翼から決定」で
// 書き込んだCGが二重にmodelMatを受けることになる。実際、ここへ足しても
// 数学的には無意味だった——空力中心（前縁から1/4翼弦の面積加重平均）は
// アフィン変換で可換（modelMat(f(素の頂点)) = f(modelMat(頂点))）なので、
// 「素の頂点から出した空力中心」をそのままCGに使えば、あとでbuildAircraftModel
// がmodelMatを掛けたときに正しい位置に来る。
// 一方、**エンジンの向き（spinAxis）はBuilderの画面に見えている向きを指す約束**
// なので、これに掛けるqFixは逆にmodelTransform適用後の翼から出す必要がある
// （pbNoseDirectionの引数 worldSpace 参照）。
function cgModelMatrix() {
  const root = State.model.root;
  if (!root) return new THREE.Matrix4();
  return new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 0),
    new THREE.Quaternion().setFromEuler(root.rotation),
    new THREE.Vector3(root.scale.x, root.scale.y, root.scale.z)
  );
}

// パーツのローカル座標→機体座標の行列。rotation は「度」で持っているので直して使う。
function cgPartMatrix(part) {
  const r = part.rotation || { x: 0, y: 0, z: 0 };
  const s = part.scale || { x: 1, y: 1, z: 1 };
  return new THREE.Matrix4().compose(
    new THREE.Vector3(part.position.x, part.position.y, part.position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(r.x || 0),
      THREE.MathUtils.degToRad(r.y || 0),
      THREE.MathUtils.degToRad(r.z || 0)
    )),
    new THREE.Vector3(s.x || 1, s.y || 1, s.z || 1)
  );
}

// 三角形2枚ぶんの面積（4頂点の四角形を割って足す）
function cgQuadArea(a, b, c, d) {
  const tri = (p, q, r) => new THREE.Vector3()
    .crossVectors(new THREE.Vector3().subVectors(q, p), new THREE.Vector3().subVectors(r, p))
    .length() * 0.5;
  return tri(a, b, c) + tri(a, c, d);
}

// 指定した役割（main / htail など）の翼を面積で重み付けして、空力中心（揚力が
// 実際にかかる点）とそのあたりの翼弦を求める。
//
// 翼の4頂点の真ん中は「翼弦の中央」で、揚力がかかるのはそこではなく**前縁から1/4**。
// 重心をここに置くと主翼が自分でひねる力を出さなくなる。パーツの原点は
// 翼のどこにあってもいい（原点は形の基準でしかない）ので、原点で合わせると
// 実際の揚力の位置と何メートルもずれることがある。
//
//   point … 空力中心（前縁から1/4翼弦）の位置。複数枚あれば面積で重み付け平均
//   area  … その役割の翼の合計面積
//   chord … いちばん大きい翼弦（静安定を「翼弦の何%」で言うときの基準）
function wingsAeroCenterByRole(role) {
  const wings = State.parts.filter(p => p.type === 'wing' && p.props && p.props.role === role);
  if (!wings.length) return null;

  const acc = new THREE.Vector3();
  let area = 0, chordSum = 0, chordMax = 0;
  for (const w of wings) {
    const m = cgPartMatrix(w);
    const c = (w.props && w.props.corners) || {};
    const P = {};
    for (const k of WING_CORNER_KEYS) {
      const v = c[k] || { x: 0, y: 0, z: 0 };
      P[k] = new THREE.Vector3(v.x || 0, v.y || 0, v.z || 0).applyMatrix4(m);
    }
    const mid = (a, b) => new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const leading = mid(P.rootLeading, P.tipLeading);
    const trailing = mid(P.rootTrailing, P.tipTrailing);
    const a = cgQuadArea(P.rootLeading, P.tipLeading, P.tipTrailing, P.rootTrailing);
    if (!(a > 1e-9)) continue;
    // 前縁→後縁の1/4の点
    const quarter = leading.clone().lerp(trailing, 0.25);
    acc.addScaledVector(quarter, a);
    const chord = new THREE.Vector3().subVectors(trailing, leading).length();
    chordSum += chord * a;
    chordMax = Math.max(chordMax, chord);
    area += a;
  }
  if (area <= 1e-9) return null;
  return { point: acc.multiplyScalar(1 / area), area, chord: chordSum / area, chordMax };
}

// 主翼の空力中心。「主翼から決定」ボタンが使う（従来どおりの名前で残してある）。
function mainWingAeroCenter() {
  return wingsAeroCenterByRole('main');
}

// 「主翼から決定」— 主翼の空力中心へ重心を合わせる（X・Y・Zとも）
//
//   X … 左翼と右翼の中間（左右対称の中心線）
//   Z … 主翼の空力中心（前縁から1/4翼弦）の前後位置
//   Y … 主翼の面の高さ
//
// Zが合っていないと、主翼の揚力が重心の前後にずれた場所にかかり、
// 飛ばすと勝手に機首上げ／機首下げを始める。Yが合っていないと、
// 速度が上がるほど抗力が重心をひねる。尾翼は対象外（主翼だけで決める）。
function setCgFromWings() {
  const wings = State.parts.filter(p => p.type === 'wing' && p.props.role === 'main');
  const leftWings = wings.filter(w => w.props.side === 'left');
  const rightWings = wings.filter(w => w.props.side === 'right');

  if (leftWings.length === 0 || rightWings.length === 0) {
    showToast('左翼・右翼が両方とも必要です（主翼の設定で左右を指定してください）', true);
    return false;
  }

  const avgX = (arr) => arr.reduce((s, w) => s + w.position.x, 0) / arr.length;
  const midX = (avgX(leftWings) + avgX(rightWings)) / 2;

  const ac = mainWingAeroCenter();
  if (!ac) {
    showToast('主翼の形（4頂点）が読めませんでした', true);
    return false;
  }

  State.cg.position.x = midX;
  State.cg.position.y = ac.point.y;
  State.cg.position.z = ac.point.z;
  applyCgToGizmo();
  if (State.cg.selected) updateInspectorNumbersOnly(null, true);
  renderInspector();
  showToast('主翼の空力中心（前縁から1/4翼弦）へ重心を合わせました'
    + ` X ${midX.toFixed(2)} / Y ${ac.point.y.toFixed(2)} / Z ${ac.point.z.toFixed(2)}`);
  return true;
}

// 「主翼と推力線から決定」— 前後・左右は主翼（setCgFromWings と同じ）、上下は**前へ押すエンジンの推力線の上**。
//
// 重心が推力線より上か下にあると、出力を変えるたびに機首が上下する（下にエンジンがあれば、出すほど機首上げ）。
// 推力線の高さは、エンジンの推力で重心まわりにピッチの力が出ない高さ：
//   Σ推力·[(エンジンの位置 − 重心) × 推力の向き]の左右成分 = 0
// を重心の高さについて解く。エンジンを傾けて付けていれば、その傾きも入る（推力線が重心の前後位置で
// どの高さを通るか）。計算は飛行の側と同じ約束で行う——位置には機体まるごとの向き・大きさ
// （cgModelMatrix）を掛け、推力の向きは画面で見えている向き（spinAxis とパーツの回転）のまま使う
// （09-aircraft.js のエンジンの項）。垂直離陸用（上向き）とヘリのローターは数えない。
function cgForwardEngines() {
  return State.parts.filter(p => p.type === 'engine' && p.props
    && (p.props.spinAxis || 'z') !== 'y' && p.props.engineKind !== 'rotor'
    && (p.props.thrustKgf || 0) > 0);
}

function setCgFromWingsAndThrust() {
  const engines = cgForwardEngines();
  if (!engines.length) {
    showToast('前へ押すエンジンがありません（推力線が決まりません）', true);
    return false;
  }
  // まず前後・左右を主翼から（上下もいったん主翼の面の高さになる）
  if (!setCgFromWings()) return false;
  const M = cgModelMatrix();
  const c = new THREE.Vector3(State.cg.position.x, State.cg.position.y, State.cg.position.z).applyMatrix4(M);
  let num = 0, den = 0;
  for (const e of engines) {
    const spin = e.props.spinAxis || 'z';
    const d = spin === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1);
    const r = e.rotation || {};
    d.applyEuler(new THREE.Euler(THREE.MathUtils.degToRad(r.x || 0), THREE.MathUtils.degToRad(r.y || 0),
      THREE.MathUtils.degToRad(r.z || 0)));
    const p = new THREE.Vector3(e.position.x, e.position.y, e.position.z).applyMatrix4(M);
    const t = e.props.thrustKgf;
    // (p − c) × d の左右（X）成分 = (py − cy)·dz − (pz − cz)·dy を 0 にする cy
    num += t * (p.y * d.z - (p.z - c.z) * d.y);
    den += t * d.z;
  }
  if (Math.abs(den) < 1e-9) {
    showToast('エンジンが前後を向いていないので、推力線の高さが決まりません', true);
    return false;
  }
  c.y = num / den;
  // 機体座標から、重心を保存している素の座標（パーツと同じ）へ戻す
  const local = c.applyMatrix4(new THREE.Matrix4().copy(M).invert());
  const wingY = State.cg.position.y;
  State.cg.position.x = local.x;
  State.cg.position.y = local.y;
  State.cg.position.z = local.z;
  applyCgToGizmo();
  if (State.cg.selected) updateInspectorNumbersOnly(null, true);
  renderInspector();
  showToast('前後・左右を主翼の空力中心、上下を推力線の上に合わせました'
    + ` X ${local.x.toFixed(2)} / Y ${local.y.toFixed(2)}（主翼の面 ${wingY.toFixed(2)}） / Z ${local.z.toFixed(2)}`);
  return true;
}

// ヘリコプターのローター（エンジン種別 rotor・回転軸Y）。推力の重み付きで並べる
function cgRotorEngines() {
  return State.parts.filter(p => p.type === 'engine' && p.props
    && p.props.engineKind === 'rotor' && p.props.spinAxis === 'y');
}

// 「ローターから決定」— ヘリの重心をローターの真下へ合わせる
//
//   X・Z … ローター（複数あれば推力の重み付き平均）の回転軸の真下
//   Y    … いまの重心がローターより下ならそのまま。上にあれば、ローターの直径の2割だけ下
//          （ヘリの重心は胴体の中、ローターの頭より下にある。下にあるほど振り子のように落ち着く）
//
// ヘリは主翼を持たないので「主翼から決定」が使えない。重心がローターの軸から前後左右にずれていると、
// ローターの推力がそのまま機体を傾ける力になる——飛行側ではサイクリックのトリムでローター直径の5%
// （11mのローターで0.55m）までは打ち消すが、それを超えると姿勢を保てず、自動操縦でも降りられない
// （実測で前後2mずれた内蔵のヘリは、降り場の上で止まれずに通り過ぎつづけた）。
function setCgFromRotors() {
  const rotors = cgRotorEngines();
  if (!rotors.length) {
    showToast('ヘリのローター（エンジン種別「ヘリのローター」）がありません', true);
    return false;
  }
  let w = 0, x = 0, y = 0, z = 0, dia = 0;
  for (const r of rotors) {
    const t = Math.max(r.props.thrustKgf || 0, 1);
    w += t; x += r.position.x * t; y += r.position.y * t; z += r.position.z * t;
    // 飛行側と同じ見積もり（09-aircraft.js の ROTOR_DIAMETER_K）
    dia = Math.max(dia, (r.props.rotorDiameter || 0) > 0 ? r.props.rotorDiameter : 0.19 * Math.sqrt(t));
  }
  x /= w; y /= w; z /= w;
  const cgY = State.cg.position.y < y ? State.cg.position.y : y - dia * 0.2;
  State.cg.position.x = x;
  State.cg.position.y = cgY;
  State.cg.position.z = z;
  applyCgToGizmo();
  if (State.cg.selected) updateInspectorNumbersOnly(null, true);
  renderInspector();
  showToast('ローターの回転軸の真下へ重心を合わせました'
    + ` X ${x.toFixed(2)} / Y ${cgY.toFixed(2)} / Z ${z.toFixed(2)}`);
  return true;
}
