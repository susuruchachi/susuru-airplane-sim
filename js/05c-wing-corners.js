// 05c-wing-corners.js — 翼（主翼／水平尾翼／垂直尾翼）の4頂点編集ギズモ
// 各頂点をドラッグしてモデルの実際の羽根形状に合わせ、その中心を揚力中心として扱う。
// 頂点ハンドル・輪郭線・中心マーカーは part.gizmo（翼の板メッシュ）の子として追加し、
// パーツの移動/回転/拡縮や機体モデルの向き/大きさ変更にも自動追従させる。

const WING_CORNER_HANDLE_COLOR = 0xffb300;
const WING_CENTER_MARKER_COLOR = 0xff5d5d;

// 頂点ハンドル一式（4つの球＋輪郭線＋中心マーカー）を作り、part.gizmoの子として追加する
function attachWingCornerHandles(part) {
  if (part.type !== 'wing' || !part.gizmo) return;
  detachWingCornerHandles(part); // 既存があれば作り直す

  const group = new THREE.Group();
  group.userData.isWingCornerHandleGroup = true;

  const handleMeshes = {};
  for (const key of csWingCornerKeys(part.props.corners)) {   // 折れ目のある翼は6頂点
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 12),
      new THREE.MeshStandardMaterial({
        color: WING_CORNER_HANDLE_COLOR, emissive: WING_CORNER_HANDLE_COLOR, emissiveIntensity: 0.5,
        roughness: 0.3, metalness: 0.3,
      })
    );
    const c = part.props.corners[key];
    mesh.position.set(c.x, c.y, c.z);
    mesh.userData.isWingCornerHandle = true;
    mesh.userData.cornerKey = key;
    mesh.userData.partId = part.id; // ピッキング時にどのパーツの頂点かを辿れるように
    group.add(mesh);
    handleMeshes[key] = mesh;
  }

  // 輪郭線（付け根前縁→（折れ目前縁）→翼端前縁→翼端後縁→（折れ目後縁）→付け根後縁→付け根前縁の順で閉じる）
  const lineOrder = wingOutlineOrder(part.props.corners);
  const linePositions = lineOrder.flatMap(key => {
    const c = part.props.corners[key];
    return [c.x, c.y, c.z];
  });
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: WING_CORNER_HANDLE_COLOR, transparent: true, opacity: 0.8 }));
  line.userData.isWingCornerOutline = true;
  group.add(line);

  // 中心マーカー（揚力中心）
  const center = wingLiftCenter(part.props.corners);
  const centerMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 10, 10),
    new THREE.MeshBasicMaterial({ color: WING_CENTER_MARKER_COLOR })
  );
  centerMesh.position.set(center.x, center.y, center.z);
  centerMesh.userData.isWingCenterMarker = true;
  group.add(centerMesh);
  // 中心から少し伸ばした十字線で「点」であることを見やすくする
  const crossSize = 0.08;
  const crossGeo = new THREE.BufferGeometry();
  crossGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    center.x - crossSize, center.y, center.z, center.x + crossSize, center.y, center.z,
    center.x, center.y, center.z - crossSize, center.x, center.y, center.z + crossSize,
  ], 3));
  const cross = new THREE.LineSegments(crossGeo, new THREE.LineBasicMaterial({ color: WING_CENTER_MARKER_COLOR }));
  cross.userData.isWingCenterCross = true;
  group.add(cross);

  part.gizmo.add(group);
  part.cornerHandleGroup = group;
  part.cornerHandleMeshes = handleMeshes;
}

// 輪郭線を引く頂点の順（折れ目があれば前縁・後縁の途中に入る）
function wingOutlineOrder(corners) {
  return csWingHasKink(corners)
    ? ['rootLeading', 'kinkLeading', 'tipLeading', 'tipTrailing', 'kinkTrailing', 'rootTrailing', 'rootLeading']
    : ['rootLeading', 'tipLeading', 'tipTrailing', 'rootTrailing', 'rootLeading'];
}

// 翼に折れ目（前縁・後縁の途中の2点）を足す。足した直後は形を変えない（前縁・後縁の直線上、翼幅の40%）ので、
// そこから後縁の点をドラッグして折る（Boeing 747 の後縁のように）。
const WING_KINK_DEFAULT_S = 0.4;
function addWingKink(part) {
  if (!part || part.type !== 'wing' || csWingHasKink(part.props.corners)) return;
  const c = part.props.corners;
  c.kinkLeading = csWingPoint(c, WING_KINK_DEFAULT_S, 0);
  c.kinkTrailing = csWingPoint(c, WING_KINK_DEFAULT_S, 1);
  attachWingCornerHandles(part);
  onWingCornerChanged(part);
}
function removeWingKink(part) {
  if (!part || part.type !== 'wing' || !csWingHasKink(part.props.corners)) return;
  delete part.props.corners.kinkLeading;
  delete part.props.corners.kinkTrailing;
  if (State.selectedCornerKey && State.selectedCornerKey.startsWith('kink')) deselectWingCorner();
  attachWingCornerHandles(part);
  onWingCornerChanged(part);
}

function detachWingCornerHandles(part) {
  if (!part || !part.cornerHandleGroup) return;
  if (part.cornerHandleGroup.parent) part.cornerHandleGroup.parent.remove(part.cornerHandleGroup);
  disposeObject3D(part.cornerHandleGroup);
  part.cornerHandleGroup = null;
  part.cornerHandleMeshes = null;
}

// 頂点ハンドルの位置・輪郭線・中心マーカーを、現在のprops.cornersの値に合わせて再配置する
// （数値入力での変更、ミラー、役割変更などcorners自体が書き換わった後に呼ぶ）
function refreshWingCornerHandles(part) {
  if (!part || !part.cornerHandleGroup) return;
  // 折れ目を足した・消したときは、ハンドルの数が変わるので作り直す
  const keys = csWingCornerKeys(part.props.corners);
  if (keys.length !== Object.keys(part.cornerHandleMeshes || {}).length) { attachWingCornerHandles(part); return; }
  for (const key of keys) {
    const c = part.props.corners[key];
    const mesh = part.cornerHandleMeshes[key];
    if (mesh) mesh.position.set(c.x, c.y, c.z);
  }
  const group = part.cornerHandleGroup;
  const line = group.children.find(c => c.userData.isWingCornerOutline);
  if (line) {
    const lineOrder = wingOutlineOrder(part.props.corners);
    const linePositions = lineOrder.flatMap(key => {
      const c = part.props.corners[key];
      return [c.x, c.y, c.z];
    });
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    line.geometry.attributes.position.needsUpdate = true;
  }
  const center = wingLiftCenter(part.props.corners);
  const centerMesh = group.children.find(c => c.userData.isWingCenterMarker);
  if (centerMesh) centerMesh.position.set(center.x, center.y, center.z);
  const cross = group.children.find(c => c.userData.isWingCenterCross);
  if (cross) {
    const crossSize = 0.08;
    cross.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      center.x - crossSize, center.y, center.z, center.x + crossSize, center.y, center.z,
      center.x, center.y, center.z - crossSize, center.x, center.y, center.z + crossSize,
    ], 3));
    cross.geometry.attributes.position.needsUpdate = true;
  }
}

// 頂点を動かした後の共通処理：翼本体のジオメトリ再構築＋ハンドル一式の再配置＋インスペクター数値更新
function onWingCornerChanged(part) {
  updateWingGizmoShape(part);
  refreshWingCornerHandles(part);
  syncControlSurfacesOfWing(part);
}

// ---- 舵面を親の翼から切り取る（形の計算は js/env/09e-part-proxy.js の csPanel） ----
//
// 舵面は親の翼の後ろ側を切り取った板。翼幅方向の範囲（spanFrom〜spanTo）と、後縁から測った
// 翼弦の割合（chordFrac）で形が決まり、前の辺が蝶番（回転軸）になる。位置・向き・大きさは
// **親の翼から決まる**ので、翼の頂点を動かしたり翼そのものを動かしたりすると舵面もついてくる。

function controlSurfaceParentWing(csPart) {
  const id = csPart && csPart.props && csPart.props.parentWingId;
  const w = id ? State.parts.find(p => p.id === id) : null;
  return (w && w.type === 'wing' && w.props && w.props.corners) ? w : null;
}

// 舵面の形・位置・向きを親の翼に合わせる。親の翼が無ければ何もしない（false）。
function syncControlSurfaceToWing(csPart) {
  if (!csPart || csPart.type !== 'control_surface') return false;
  const wing = controlSurfaceParentWing(csPart);
  if (!wing) return false;
  const shape = csResolveShape(csPart.props, wing.props.corners);
  // 大きさを持っていなかった旧データは、これまでと同じ効きの大きさに読み替えて書き戻す
  csPart.props.spanFrom = shape.spanFrom;
  csPart.props.spanTo = shape.spanTo;
  csPart.props.chordFrac = shape.chordFrac;
  csPart.props.spanS = (shape.spanFrom + shape.spanTo) / 2;
  const panel = csPanel(wing.props.corners, shape);
  // 部品の原点は蝶番の中点。向きと拡縮は翼と同じにする（板の形は翼のローカル座標で作るので）
  const hm = csWingToParent(wing, panel.hingeMid);
  csPart.position.x = hm.x; csPart.position.y = hm.y; csPart.position.z = hm.z;
  csPart.rotation.x = wing.rotation.x; csPart.rotation.y = wing.rotation.y; csPart.rotation.z = wing.rotation.z;
  csPart.scale.x = wing.scale.x; csPart.scale.y = wing.scale.y; csPart.scale.z = wing.scale.z;
  // 蝶番の向き（この部品のローカル座標）。飛行画面の仮モデルはこの軸で回す
  const hx = panel.hingeTip.x - panel.hingeRoot.x, hy = panel.hingeTip.y - panel.hingeRoot.y;
  const hz = panel.hingeTip.z - panel.hingeRoot.z, hl = Math.hypot(hx, hy, hz);
  if (hl > 1e-9) csPart.props.hingeVec = { x: hx / hl, y: hy / hl, z: hz / hl };
  if (csPart.gizmo && csPart.gizmo.geometry) {
    csPart.gizmo.geometry.dispose();
    csPart.gizmo.geometry = partShapeControlSurfaceGeometry(panel, wing.props.role);
    if (csPart.gizmo.material) { csPart.gizmo.material.side = THREE.DoubleSide; csPart.gizmo.material.needsUpdate = true; }
  }
  applyPartToGizmo(csPart);
  return true;
}

// 翼に付いている舵面をまとめて合わせ直す（翼の頂点・位置・向き・大きさが変わったとき）
function syncControlSurfacesOfWing(wingPart) {
  if (!wingPart || wingPart.type !== 'wing') return;
  for (const p of State.parts) {
    if (p.type === 'control_surface' && p.props.parentWingId === wingPart.id) syncControlSurfaceToWing(p);
  }
}

// 舵面の面積（m²）と親の翼の面積。表示用。機体まるごとの拡縮と翼の拡縮を掛けた実寸
function controlSurfaceAreas(csPart) {
  const wing = controlSurfaceParentWing(csPart);
  if (!wing) return null;
  const shape = csResolveShape(csPart.props, wing.props.corners);
  const panel = csPanel(wing.props.corners, shape);
  const sc = wing.scale || { x: 1, y: 1, z: 1 };
  const ws = (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1;
  const k = Math.pow(ws * modelRootScale(), 2);
  return {
    panelM2: panel.panelArea * k, wingM2: panel.wingArea * k, stripFrac: panel.stripFrac,
    tau: csFlapTau(shape.chordFrac), shape,
  };
}

// ---- 頂点ハンドルの選択・ドラッグ ----
// 頂点編集は「パーツ全体の移動/回転/拡縮」とは別モードとして扱う。
// State.selectedCornerKey が非nullの間、TransformControlsは頂点ハンドル(translateのみ)にアタッチされる
function selectWingCorner(part, cornerKey) {
  if (!part || part.type !== 'wing' || !part.cornerHandleMeshes) return;
  const handle = part.cornerHandleMeshes[cornerKey];
  if (!handle) return;
  State.selectedCornerKey = cornerKey;
  State.transformControls.attach(handle);
  State.transformControls.setMode('translate');
  document.getElementById('gizmoModeBar').style.display = 'none'; // 頂点は移動のみのため、モード切替バーは隠す
  document.getElementById('axisReadout').style.display = 'block';
  renderInspector();
}

function deselectWingCorner() {
  if (State.selectedCornerKey === null || State.selectedCornerKey === undefined) return;
  State.selectedCornerKey = null;
  if (State.transformControls.object && State.transformControls.object.userData.isWingCornerHandle) {
    State.transformControls.detach();
  }
}

// TransformControlsのobjectChangeから呼ばれる：選択中の頂点ハンドルのローカル位置をprops.cornersへ反映する
function syncWingCornerFromGizmo(part) {
  if (!part || !State.selectedCornerKey || !part.cornerHandleMeshes) return;
  const handle = part.cornerHandleMeshes[State.selectedCornerKey];
  if (!handle) return;
  const c = part.props.corners[State.selectedCornerKey];
  c.x = handle.position.x; c.y = handle.position.y; c.z = handle.position.z;
  onWingCornerChanged(part);
}

// 翼の4頂点から、任意の内部位置をバイリニア補間で求める。
// spanS: 0=付け根(root) 〜 1=翼端(tip)、chordT: 0=前縁(leading) 〜 1=後縁(trailing)
function wingPointAt(corners, spanS, chordT) {
  return csWingPoint(corners, spanS, chordT);   // 折れ目のある翼にも対応（js/env/09e-part-proxy.js）
}

// 翼の役割(role)・左右位置(side)から、可動翼面の種類の初期値をそれらしく推測する
function suggestControlSurfaceKindForWing(wingPart) {
  if (wingPart.props.role === 'vtail') return 'rudder';
  if (wingPart.props.role === 'htail') return 'elevator';
  return 'aileron'; // main（主翼）
}

// 「この翼に可動翼面を追加」ボタンから呼ばれる一気通貫の処理：
// 可動翼面パーツを新規作成し、種類を翼の役割から推測し、翼の後ろ側を切り取った形で置き、所属も設定する
function addControlSurfaceToWing(wingPart) {
  if (!wingPart || wingPart.type !== 'wing') return null;

  const kind = suggestControlSurfaceKindForWing(wingPart);
  const kindDef = CONTROL_SURFACE_KINDS.find(k => k.value === kind);
  const spanS = kindDef ? kindDef.suggestedSpanS : 0.78;

  // 位置はいったんデフォルトのスポーン位置で作成し、直後に翼から切り取った位置へ置き直す
  const csPart = addPart('control_surface');
  if (!csPart) return null; // モデル未読込などでaddPartがnullを返した場合

  csPart.props.kind = kind;
  const shape = CS_KIND_SHAPE[kind] || CS_KIND_SHAPE.aileron;
  csPart.props.spanFrom = shape.spanFrom;
  csPart.props.spanTo = shape.spanTo;
  csPart.props.chordFrac = shape.chordFrac;
  csPart.props.spanS = spanS;
  csPart.props.parentWingId = wingPart.id;
  syncControlSurfaceToWing(csPart);

  const kindLabel = kindDef ? kindDef.label : kind;
  csPart.name = `${kindLabel} 1`;
  // 同種の可動翼面が既にあれば連番にする
  const sameKindCount = State.parts.filter(p => p.type === 'control_surface' && p.props.kind === kind).length;
  csPart.name = `${kindLabel} ${sameKindCount}`;

  return csPart;
}


