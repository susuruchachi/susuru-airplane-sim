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
  for (const key of WING_CORNER_KEYS) {
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

  // 輪郭線（rootLeading→tipLeading→tipTrailing→rootTrailing→rootLeadingの順で閉じる）
  const lineOrder = ['rootLeading', 'tipLeading', 'tipTrailing', 'rootTrailing', 'rootLeading'];
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
  const center = wingCornersCenter(part.props.corners);
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
  for (const key of WING_CORNER_KEYS) {
    const c = part.props.corners[key];
    const mesh = part.cornerHandleMeshes[key];
    if (mesh) mesh.position.set(c.x, c.y, c.z);
  }
  const group = part.cornerHandleGroup;
  const line = group.children.find(c => c.userData.isWingCornerOutline);
  if (line) {
    const lineOrder = ['rootLeading', 'tipLeading', 'tipTrailing', 'rootTrailing', 'rootLeading'];
    const linePositions = lineOrder.flatMap(key => {
      const c = part.props.corners[key];
      return [c.x, c.y, c.z];
    });
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    line.geometry.attributes.position.needsUpdate = true;
  }
  const center = wingCornersCenter(part.props.corners);
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
  const lerp3 = (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  });
  // まず付け根側・翼端側それぞれで前縁→後縁を補間し、その2点を span方向にさらに補間する
  const rootPoint = lerp3(corners.rootLeading, corners.rootTrailing, chordT);
  const tipPoint = lerp3(corners.tipLeading, corners.tipTrailing, chordT);
  return lerp3(rootPoint, tipPoint, spanS);
}

// 可動翼面を「翼の後縁側1/4」の位置に自動配置する。
// chordT=0.875（前縁から87.5%＝後縁から1/4の中心線）、spanSは指定位置（デフォルトは翼幅の中央）。
// 新規パーツを作らず、既存のcontrol_surfaceパーツを対象翼に合わせて配置し直す用途にも使えるよう、
// 対象パーツ(csPart)と対象翼(wingPart)、span方向の位置(spanS, 0〜1)を引数に取る
function placeControlSurfaceAtTrailingQuarter(csPart, wingPart, spanS) {
  if (!csPart || !wingPart || wingPart.type !== 'wing') return;
  const chordT = 0.875; // 前縁から87.5% = 後縁から1/4の帯の中心線
  const posOnWing = wingPointAt(wingPart.props.corners, spanS, chordT);

  // wingPart側のローカル座標(位置pos基準)を、csPart側のローカル座標に変換する。
  // 両パーツは同じ親(機体モデルroot)を共有しているため、
  // 「wingPart.position + posOnWing(翼のローカル頂点オフセット)」が機体基準の位置になり、
  // そこからcsPart.positionを引けば良い……のだが、可動翼面はwingPartの子ではなく兄弟なので、
  // 単純に「機体基準の絶対位置」をそのままcsPart.positionとして設定すれば良い
  // （wingPart.positionは翼パーツの基準点であり、corners自体がその基準点からのオフセットのため）
  csPart.position.x = wingPart.position.x + posOnWing.x;
  csPart.position.y = wingPart.position.y + posOnWing.y;
  csPart.position.z = wingPart.position.z + posOnWing.z;
  applyPartToGizmo(csPart);

  csPart.props.parentWingId = wingPart.id;
}

// 翼の役割(role)・左右位置(side)から、可動翼面の種類の初期値をそれらしく推測する
function suggestControlSurfaceKindForWing(wingPart) {
  if (wingPart.props.role === 'vtail') return 'rudder';
  if (wingPart.props.role === 'htail') return 'elevator';
  return 'aileron'; // main（主翼）
}

// 「この翼に可動翼面を追加」ボタンから呼ばれる一気通貫の処理：
// 可動翼面パーツを新規作成し、種類を翼の役割から推測し、後縁1/4の位置に自動配置し、所属も設定する
function addControlSurfaceToWing(wingPart) {
  if (!wingPart || wingPart.type !== 'wing') return null;

  const kind = suggestControlSurfaceKindForWing(wingPart);
  const kindDef = CONTROL_SURFACE_KINDS.find(k => k.value === kind);
  const spanS = kindDef ? kindDef.suggestedSpanS : 0.78;

  // 位置はいったんデフォルトのスポーン位置で作成し、直後に後縁1/4へ配置し直す
  const csPart = addPart('control_surface');
  if (!csPart) return null; // モデル未読込などでaddPartがnullを返した場合

  csPart.props.kind = kind;
  csPart.props.spanS = spanS;
  placeControlSurfaceAtTrailingQuarter(csPart, wingPart, spanS);

  const kindLabel = kindDef ? kindDef.label : kind;
  csPart.name = `${kindLabel} 1`;
  // 同種の可動翼面が既にあれば連番にする
  const sameKindCount = State.parts.filter(p => p.type === 'control_surface' && p.props.kind === kind).length;
  csPart.name = `${kindLabel} ${sameKindCount}`;

  return csPart;
}


