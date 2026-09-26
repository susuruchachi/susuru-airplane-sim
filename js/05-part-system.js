// 05-part-system.js — パーツ（エンジン/主翼/可動翼面/航行灯）の追加・削除・可視化

function defaultPropsForType(type) {
  switch (type) {
    case 'engine':
      return {
        thrustKgf: 2000,       // 最大推力（kgf、参考値・後の飛行モデルで使用）
        spinAxis: 'z',         // プロペラ/ファンの回転軸
        // 着陸滑走で推力を後ろ向きに使えないエンジン（固定ピッチのプロペラ機）
        noReverse: false,
        // エンジンの種別。推力の出かた（速度・空気の薄さへの強さ）と、
        // 排気や炎の見た目が変わる。既定はプロペラ——これまでの機体は
        // すべてプロペラの式で飛んでいたので、既定を変えると全機の性能が動く。
        engineKind: 'prop',    // prop | jet | jet_ab | rocket
        // エンジンのグループ（1〜4）。飛行中にグループ単位で止められる。
        engineGroup: 1,
        // このグループで出せる最高速度。0なら機体の最高速度をそのまま使う。
        // 例：ロケットのグループだけマッハ21、ほかのエンジンはマッハ5。
        groupMaxSpeedValue: 0,
        groupMaxSpeedUnit: 'mach',
        // 排気や炎の見た目。0なら推力から自動で決める（09b-aircraft-visual.js）。
        plumeWidth: 0,        // ノズルの直径(m)
        plumeLength: 1,       // 長さの倍率
      };
    case 'wing':
      return {
        span: 2.0,             // 翼幅（m）目安。羽の可動部の親として使う
        role: 'main',          // main | htail | vtail（主翼／水平尾翼／垂直尾翼）
        side: 'left',          // left | right | center（垂直尾翼など中心配置のもの）
        // 4頂点（コーナー）。パーツのposition基準のローカルオフセット {x,y,z}。
        // モデルの実際の羽根形状に合わせて個別にドラッグするためのもの。中心が揚力中心として扱われる
        corners: defaultWingCorners('main'),
      };
    case 'control_surface':
      return {
        kind: 'aileron',
        hingeAxis: 'x',        // 可動軸（ローカル座標系）
        minDeg: -20,
        maxDeg: 20,
        parentWingId: null,    // どの主翼に属するか（任意）
        spanS: 0.78,           // 翼幅方向の位置（0=付け根 〜 1=翼端）。範囲の中央（旧データ互換）
        // 大きさ（親の翼から切り取る。js/env/09e-part-proxy.js の csPanel）
        spanFrom: CS_KIND_SHAPE.aileron.spanFrom,   // 翼幅方向の範囲（0=付け根 〜 1=翼端）
        spanTo: CS_KIND_SHAPE.aileron.spanTo,
        chordFrac: CS_KIND_SHAPE.aileron.chordFrac, // 後縁から測った翼弦の割合。前の辺が蝶番
      };
    case 'viewpoint':
      // コックピットの目の位置。パーツの回転がそのまま視線の向きになる
      // （機首が-Z・上が+Y の機体座標で、回転0なら真っ直ぐ前を見る）。
      return {};
    case 'light':
      return {
        kind: 'nav_red',
        color: LIGHT_KINDS[0].color,
        blink: LIGHT_KINDS[0].blink,
        // 着陸灯のときだけ意味を持つ（LANDING_BEAM_DEFAULT の説明を参照）
        beamDownDeg: LANDING_BEAM_DEFAULT.downDeg,
        beamSpreadDeg: LANDING_BEAM_DEFAULT.spreadDeg,
        beamRangeM: LANDING_BEAM_DEFAULT.rangeM,
      };
    case 'landing_gear':
      return {
        gearPosition: 'nose',   // nose | main_left | main_right | other
        deployState: 1,         // 0=格納 〜 1=展開（プレビュー用の現在値）
        retractedAtZero: true,  // true: deployState=0が「関節角度・伸縮ともに最小」＝格納 / false: 逆
        // 初期状態で1関節+1伸縮節を持たせ、追加直後から「折りたたみ脚」らしい見た目にする
        joints: [{ id: genJointId(), axis: 'x', minDeg: -90, maxDeg: 0, label: '主関節' }],
        struts: [{ id: genStrutId(), axis: 'y', minLength: 0.3, maxLength: 0.7, label: '伸縮支柱' }],
      };
    default:
      return {};
  }
}

function createPartGizmoMesh(type, role, corners, props) {
  const color = new THREE.Color(PART_TYPE_COLORS[type]);
  const geo = (type === 'wing' && corners) ? buildWingGeometryFromCorners(corners, role) : geometryForPart(type, role, props);
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: type === 'light' ? 0.9 : 0.25,
    roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.92,
    // 着陸灯の円錐は側面だけの筒（openEnded）なので、裏からも見えないと
    // 「照らす向き」が分からない角度ができる。翼と同じく両面で描く。
    side: (type === 'wing' || type === 'light') ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.isPartGizmo = true;
  return mesh;
}

// 機体モデルにかけている拡縮。パーツの座標もギズモの形も**この倍率がかかった状態で**
// 画面に出る。ノズルの直径のように「実寸(m)で言いたい」ものは、ここで割ってから
// ジオメトリを作らないと、拡縮した機体では見た目と実寸が食い違う。
function modelRootScale() {
  const r = State.model && State.model.root;
  if (!r) return 1;
  const s = (Math.abs(r.scale.x) + Math.abs(r.scale.y) + Math.abs(r.scale.z)) / 3;
  return s > 1e-6 ? s : 1;
}

// エンジンのノズル（排気口）の直径(m)。
// Builderで入れていればその値、0なら推力から決める。
//
// 合わせるのは「ファンの直径」ではなく**排気ノズルの直径**。実機の排気ノズルは
// 推力の平方根におよそ比例する（d ≒ 0.0016·√(推力N)。実機7種で比の幾何平均0.98。
// 09b-aircraft-visual.js の PLUME_NOZZLE_K の説明に内訳）。
// 飛行側の既定（enginePlumeRadius）と同じ式で、
// **ここで見ている太さの筒が、そのまま炎・排気の太さになる**。
// 推力が桁外れな架空の機体（推力40万kNのロケットなど）では、この式のままだと
// 直径30mを超えて機体が見えなくなる。機体の大きさに対して極端にならないよう、
// いちばん長い辺の0.4〜2.4%に収める（飛行側も同じように抑えている）。
// 返すのは**実寸(m)**。境界箱も world 空間なので、そのまま比べられる。
function engineNozzleDiameter(props) {
  const w = props && props.plumeWidth;
  if (w > 0) return w;
  const kgf = Math.max((props && props.thrustKgf) || 0, 0);
  let d = Math.max(0.0016 * Math.sqrt(kgf * 9.80665), 0.06);
  const box = typeof computeModelMeshBoundingBox === 'function' ? computeModelMeshBoundingBox() : null;
  if (box) {
    const size = box.getSize(new THREE.Vector3());
    const unit = Math.max(size.x, size.y, size.z);
    if (unit > 0.2) d = Math.min(Math.max(d, unit * 0.004), unit * 0.024);
  }
  return d;
}

// エンジンのギズモを噴射の向きに合わせる回転（js/env/09e-part-proxy.js の partShapeOrientEngine。
// 飛行画面の仮モデルと同じ形にするため、形の作り方はそちらに1か所だけ置く）
function orientEngineGeometry(geo, spinAxis) { return partShapeOrientEngine(geo, spinAxis); }

// 回転軸・推力・ノズル直径を変えたとき、ギズモの形と向きを作り直す
function updateEngineGizmoShape(part) {
  if (part.type !== 'engine' || !part.gizmo) return;
  part.gizmo.geometry.dispose();
  part.gizmo.geometry = geometryForPart('engine', null, part.props);
}

// 種類・伏せ角・広がりを変えたとき、ギズモの形を作り直す
// （着陸灯は円錐、それ以外は玉。エンジンの updateEngineGizmoShape と同じ形）
function updateLightGizmoShape(part) {
  if (part.type !== 'light' || !part.gizmo) return;
  part.gizmo.geometry.dispose();
  part.gizmo.geometry = geometryForPart('light', null, part.props);
}

function geometryForPart(type, role, props) {
  switch (type) {
    case 'engine': {
      // ノズル（大きいほうの円）が -Y 側。吸い込み側は少し細くして、
      // どちらが噴射口か見ただけで分かるようにする。
      // 直径は実寸(m)なので、機体の拡縮ぶんで割ってからジオメトリにする
      // （そうしないと、拡縮した機体では画面の太さと飛行中の炎の太さが食い違う）。
      return partShapeEngineGeometry(engineNozzleDiameter(props) / modelRootScale(), props && props.spinAxis);
    }
    case 'wing':
      // 垂直尾翼は縦に立てた薄板、それ以外（主翼・水平尾翼）は横に広い薄板
      if (role === 'vtail') return new THREE.BoxGeometry(0.35, 0.9, 0.3);
      return new THREE.BoxGeometry(1.2, 0.06, 0.35);
    case 'control_surface':
      return new THREE.BoxGeometry(0.4, 0.04, 0.18);
    case 'light': {
      // 着陸灯だけは**どちらを照らすか**が要るので、向きの見える円錐にする。
      // 頂点が灯りの位置、底面が照らす先。太さは「広がり」そのままなので、
      // 広げれば円錐も太くなる。伏せ角ぶん下へ傾けて描くから、ギズモを
      // 回していなくても実際に照らす向きが分かる（回転はこれに上乗せされる）。
      if (!props || props.kind !== 'landing') return new THREE.SphereGeometry(0.07, 12, 12);
      const len = 0.6;
      const r = Math.max(len * Math.tan(THREE.MathUtils.degToRad(lightBeamSpreadDeg(props))), 0.05);
      const geo = new THREE.ConeGeometry(r, len, 16, 1, true);
      geo.rotateX(Math.PI / 2);        // +Y → +Z（頂点が後ろ・底面が前）
      geo.translate(0, 0, -len / 2);   // 頂点を原点（灯りの位置）へ
      geo.rotateX(-THREE.MathUtils.degToRad(lightBeamDownDeg(props)));  // 伏せ角ぶん下へ
      return geo;
    }
    case 'viewpoint': {
      // 視線の向きが見えるよう、前（-Z）へ尖った円錐にする。
      // エンジンと同じ理由で、メッシュの rotation ではなくジオメトリを回す
      // （パーツの回転で上書きされてしまうため）。
      const cone = new THREE.ConeGeometry(0.12, 0.34, 12);
      cone.rotateX(-Math.PI / 2);
      return cone;
    }
    default:
      return new THREE.SphereGeometry(0.1, 8, 8);
  }
}

// 翼パーツの初期形状ジオメトリ（geometryForPartのwingサイズ）に合わせた4頂点の初期オフセットを返す。
// 水平翼(main/htail): ルート/翼端はローカルX軸、前縁/後縁はローカルZ軸
// 垂直尾翼(vtail): ルート/翼端(=下端/上端)はローカルY軸、前縁/後縁はローカルZ軸
function defaultWingCorners(role) {
  if (role === 'vtail') {
    const halfY = 0.45, halfZ = 0.15;
    return {
      rootLeading:  { x: 0, y: -halfY, z: -halfZ },
      rootTrailing: { x: 0, y: -halfY, z: halfZ },
      tipLeading:   { x: 0, y: halfY, z: -halfZ },
      tipTrailing:  { x: 0, y: halfY, z: halfZ },
    };
  }
  const halfX = 0.6, halfZ = 0.175;
  return {
    rootLeading:  { x: -halfX, y: 0, z: -halfZ },
    rootTrailing: { x: -halfX, y: 0, z: halfZ },
    tipLeading:   { x: halfX, y: 0, z: -halfZ },
    tipTrailing:  { x: halfX, y: 0, z: halfZ },
  };
}

// 揚力のかかる点（平均空力翼弦の前縁から1/4。js/env/09e-part-proxy.js の csWingMacInfo）。
// 頂点の編集で出る赤い印はこの点。飛行の側も同じ点に揚力をかける。
function wingLiftCenter(corners) {
  return csWingMacInfo(corners).ac;
}

// 4頂点の中心（形の真ん中）
function wingCornersCenter(corners) {
  const keys = WING_CORNER_KEYS;
  const sum = { x: 0, y: 0, z: 0 };
  for (const k of keys) {
    sum.x += corners[k].x; sum.y += corners[k].y; sum.z += corners[k].z;
  }
  return { x: sum.x / keys.length, y: sum.y / keys.length, z: sum.z / keys.length };
}

// 翼の4頂点から厚みを持つ板を作る（形の作り方は js/env/09e-part-proxy.js の partShapeWingGeometry）
function buildWingGeometryFromCorners(corners, role) { return partShapeWingGeometry(corners, role); }

// 翼の役割（主翼/水平尾翼/垂直尾翼）が変わったとき、ギズモの形状だけ差し替える
function updateWingGizmoShape(part) {
  if (part.type !== 'wing' || !part.gizmo) return;
  part.gizmo.geometry.dispose();
  part.gizmo.geometry = buildWingGeometryFromCorners(part.props.corners, part.props.role);
}

// ---- 着陸脚（landing_gear）専用のギズモ構築 ----
// 形（銀色の支柱・関節・タイヤ）の作り方は js/env/09e-part-proxy.js にまとめてある
// （飛行画面の仮モデルも同じ形を使う）。ここは Builder 側の出し入れだけ。

function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  });
}

// obj が ancestor の子孫（孫以下も含む）かどうかを親を辿って判定する
function isDescendantOf(obj, ancestor) {
  let cur = obj ? obj.parent : null;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

function buildLandingGearHierarchy(props) { return partShapeGearHierarchy(props); }

// 関節/伸縮節の追加・削除・軸変更のたびに呼び、gizmo階層を作り直す
// （既存のgizmoは破棄して新規に作り直す。シーンへの追加・位置/回転/スケールの再適用は呼び出し側で行う）
function rebuildLandingGearGizmo(part) {
  if (part.type !== 'landing_gear') return;
  const oldGizmo = part.gizmo;
  const parent = oldGizmo.parent || State.model.root;
  const newGizmo = buildLandingGearHierarchy(part.props);
  newGizmo.position.copy(oldGizmo.position);
  newGizmo.rotation.copy(oldGizmo.rotation);
  newGizmo.scale.copy(oldGizmo.scale);
  newGizmo.userData.partId = part.id;

  parent.add(newGizmo);
  parent.remove(oldGizmo);
  disposeObject3D(oldGizmo);

  if (State.transformControls.object === oldGizmo) {
    State.transformControls.detach();
    State.transformControls.attach(newGizmo);
  }

  part.gizmo = newGizmo;
  applyDeployStateToGear(part); // 現在のdeployStateを新しい階層にも反映
}

// deployState(0〜1)に応じて、各関節の角度・各伸縮節の長さを線形補間してプレビューに反映する
function applyDeployStateToGear(part) {
  if (part.type !== 'landing_gear' || !part.gizmo) return;
  partShapeApplyGearDeploy(part.gizmo, part.props, part.props.deployState);
}

// 全展開(deployState=1)時に、脚の先端（タイヤ）が地面(Y=0)にちょうど届くよう、
// 地面に一番近い伸縮節のmaxLengthを自動調整する。関節の角度（斜めの向き）も含めて
// 実際のワールド座標で計算するため、脚がどんな折れ方をしていても正確に合わせられる。
// 伸縮節が1つも無い場合は調整できないため、その旨を知らせる。
function fitGearToGround(part) {
  if (part.type !== 'landing_gear' || !part.gizmo) return false;
  if (part.props.struts.length === 0) {
    showToast('伸縮節がありません。地面合わせには伸縮節を1つ以上追加してください', true);
    return false;
  }

  const savedDeployState = part.props.deployState;
  part.props.deployState = 1;
  applyDeployStateToGear(part);
  part.gizmo.updateMatrixWorld(true);

  let tipWorldY = null;
  part.gizmo.traverse(obj => {
    if (obj.userData.isGearTip) {
      const worldPos = new THREE.Vector3();
      obj.getWorldPosition(worldPos);
      tipWorldY = worldPos.y;
    }
  });

  if (tipWorldY === null) {
    part.props.deployState = savedDeployState;
    applyDeployStateToGear(part);
    showToast('脚の先端が見つかりませんでした', true);
    return false;
  }

  const shortfall = tipWorldY - 0; // 地面(Y=0)との差。正なら地面に届いていない（脚が短い）
  if (Math.abs(shortfall) < 0.005) {
    showToast('すでに地面の高さに合っています');
    part.props.deployState = savedDeployState;
    applyDeployStateToGear(part);
    return true;
  }

  // 地面に一番近い（＝先端に一番近い）伸縮節を延長/短縮する。
  // 関節の角度によって伸縮節の向きが斜めになっている場合、その伸縮節を1m伸ばしたときの
  // 実際のワールドY方向の変化量（現在の傾き分）を先に測り、必要な伸び量に換算する
  const lastStrutDef = part.props.struts[part.props.struts.length - 1];
  let strutWorldObj = null;
  part.gizmo.traverse(obj => {
    if (obj.userData.isStrutVisual && obj.userData.strutId === lastStrutDef.id) strutWorldObj = obj;
  });
  if (!strutWorldObj) {
    part.props.deployState = savedDeployState;
    applyDeployStateToGear(part);
    showToast('伸縮節の位置を特定できませんでした', true);
    return false;
  }

  // その伸縮節のワールド空間での「伸びる方向(-Y、ローカル)」がどれだけYに寄与するかを、
  // ワールド行列から取り出す（quaternionでローカル-Y軸をワールドに変換し、Y成分を見る）。
  // 機体モデル自体が拡縮されている場合、ローカル1単位の伸びがワールドではスケール倍になる点も考慮する
  const worldQuat = new THREE.Quaternion();
  strutWorldObj.getWorldQuaternion(worldQuat);
  const worldScale = new THREE.Vector3();
  strutWorldObj.getWorldScale(worldScale);
  const localDown = new THREE.Vector3(0, -1, 0).applyQuaternion(worldQuat);
  // Y軸方向のスケール（伸縮節はローカルY方向に伸びるため、そのワールドスケールを乗じる）
  const yContributionPerUnit = localDown.y * worldScale.y; // この伸縮節を1m伸ばすとワールドYがどれだけ変化するか（脚が下を向いていれば負の値になる）

  if (Math.abs(yContributionPerUnit) < 0.05) {
    part.props.deployState = savedDeployState;
    applyDeployStateToGear(part);
    showToast('この脚は伸縮節がほぼ水平を向いており、地面合わせができません（関節の角度を調整してください）', true);
    return false;
  }

  // 必要な伸び量：先端をワールドY方向に -shortfall だけ動かしたい（地面に近づける）ので、
  // ΔY = neededDelta × yContributionPerUnit の関係から neededDelta = (-shortfall) / yContributionPerUnit
  const neededDelta = -shortfall / yContributionPerUnit;
  const newMaxLength = Math.max(lastStrutDef.maxLength + neededDelta, lastStrutDef.minLength + 0.05, 0.1);
  lastStrutDef.maxLength = Math.round(newMaxLength * 1000) / 1000;

  part.props.deployState = savedDeployState;
  applyDeployStateToGear(part);
  showToast(`「${lastStrutDef.label}」の展開側の長さを ${lastStrutDef.maxLength.toFixed(3)}m に調整しました`);
  return true;
}

function addPart(type, position) {
  if (!State.model.root) {
    showToast('先に機体モデルを読み込んでください', true);
    return null;
  }
  const id = genPartId();
  const props = defaultPropsForType(type);
  const name = type === 'wing'
    ? `${WING_ROLES.find(r => r.value === props.role)?.label || '主翼'} ${State.parts.filter(p => p.type === 'wing' && p.props.role === props.role).length + 1}`
    : `${PART_TYPE_LABELS[type]} ${State.parts.filter(p => p.type === type).length + 1}`;

  const gizmoMesh = type === 'landing_gear'
    ? buildLandingGearHierarchy(props)
    : createPartGizmoMesh(type, props.role, props.corners, props);
  const pos = position || defaultSpawnPosition();
  gizmoMesh.position.copy(pos);
  // モデルのローカル座標系の子として追加する：モデル本体の回転/拡縮に自動追従させるため
  State.model.root.add(gizmoMesh);

  const part = {
    id, type, name,
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    props,
    gizmo: gizmoMesh,
  };
  State.parts.push(part);
  gizmoMesh.userData.partId = id;

  selectPart(id);
  renderPartList();
  return part;
}

function defaultSpawnPosition() {
  const r = State.model.boundingRadius || 1;
  const target = State.orbitControls.target;
  const worldPos = new THREE.Vector3(target.x, target.y + r * 0.3, target.z);
  // パーツはモデルのローカル座標系に配置するため、カメラ注視点(ワールド座標)をモデル基準に変換する
  return State.model.root.worldToLocal(worldPos);
}

function removePart(id) {
  const idx = State.parts.findIndex(p => p.id === id);
  if (idx === -1) return;
  const part = State.parts[idx];
  if (part.gizmo) {
    // TransformControlsが、このパーツ自体か、その子孫（翼の頂点ハンドル等）にアタッチされている場合は先に外す
    const attached = State.transformControls.object;
    if (attached && (attached === part.gizmo || isDescendantOf(attached, part.gizmo))) {
      State.transformControls.detach();
      State.selectedCornerKey = null;
    }
    if (part.gizmo.parent) part.gizmo.parent.remove(part.gizmo);
    disposeObject3D(part.gizmo);
  }
  State.parts.splice(idx, 1);
  if (State.selectedPartId === id) {
    State.selectedPartId = null;
    renderInspector();
  }
  renderPartList();
}

function clearAllParts() {
  State.transformControls.detach();
  State.selectedCornerKey = null;
  for (const p of State.parts) {
    if (p.gizmo) {
      if (p.gizmo.parent) p.gizmo.parent.remove(p.gizmo);
      disposeObject3D(p.gizmo);
    }
  }
  State.parts = [];
  State.selectedPartId = null;
  State.cg.selected = false;
  renderPartList();
  renderInspector();
}

function selectPart(id) {
  // 直前に選択されていたパーツが翼なら、頂点ハンドルを消しておく（別パーツ選択・選択解除どちらでも）
  const prevPart = getSelectedPart();
  if (prevPart && prevPart.type === 'wing') {
    deselectWingCorner();
    detachWingCornerHandles(prevPart);
  }

  State.selectedPartId = id;
  if (id !== null) deselectCg();
  const part = getSelectedPart();
  if (part && part.gizmo) {
    State.transformControls.attach(part.gizmo);
    document.getElementById('gizmoModeBar').style.display = 'flex';
    document.getElementById('axisReadout').style.display = 'block';
    if (part.type === 'wing') attachWingCornerHandles(part);
    if (isMobileLayout()) openDrawer('right');
  } else if (!State.cg.selected) {
    State.transformControls.detach();
    document.getElementById('gizmoModeBar').style.display = 'none';
    document.getElementById('axisReadout').style.display = 'none';
  }
  renderPartList();
  renderInspector();
}

// gizmoが動かされた後、part.position/rotation/scaleへ反映
function syncPartFromGizmo(part) {
  if (!part || !part.gizmo) return;
  // 翼に付いている舵面は、ギズモで動かしても翼の上に戻す（形は範囲と翼弦比で決める）
  if (part.type === 'control_surface' && controlSurfaceParentWing(part)) {
    syncControlSurfaceToWing(part);
    return;
  }
  part.position.x = part.gizmo.position.x;
  part.position.y = part.gizmo.position.y;
  part.position.z = part.gizmo.position.z;
  part.rotation.x = THREE.MathUtils.radToDeg(part.gizmo.rotation.x);
  part.rotation.y = THREE.MathUtils.radToDeg(part.gizmo.rotation.y);
  part.rotation.z = THREE.MathUtils.radToDeg(part.gizmo.rotation.z);
  part.scale.x = part.gizmo.scale.x;
  part.scale.y = part.gizmo.scale.y;
  part.scale.z = part.gizmo.scale.z;
  if (part.type === 'wing') syncControlSurfacesOfWing(part);
}

function applyPartToGizmo(part) {
  if (!part || !part.gizmo) return;
  part.gizmo.position.set(part.position.x, part.position.y, part.position.z);
  part.gizmo.rotation.set(
    THREE.MathUtils.degToRad(part.rotation.x),
    THREE.MathUtils.degToRad(part.rotation.y),
    THREE.MathUtils.degToRad(part.rotation.z)
  );
  part.gizmo.scale.set(part.scale.x, part.scale.y, part.scale.z);
  // 翼を動かしたら、付いている舵面もついてくる（舵面の位置は翼から決まる）
  if (part.type === 'wing') syncControlSurfacesOfWing(part);
}

// パーツをX軸反転（機体中心線=X0を挟んで鏡像）した複製を作る
// 対象: engine / wing（主翼・水平尾翼・垂直尾翼） / control_surface / light / landing_gear
// 中心線付近（X≈0）のパーツはmirrorPart内でその旨を警告する（複製自体は行う。双垂直尾翼など中心以外に置くケースもあるため一律には除外しない）
function canMirrorPart(part) {
  if (!part) return false;
  if (!['engine', 'wing', 'control_surface', 'light', 'landing_gear'].includes(part.type)) return false;
  return true;
}

function mirrorPart(id) {
  const src = State.parts.find(p => p.id === id);
  if (!src || !canMirrorPart(src)) return null;

  if (Math.abs(src.position.x) < 0.02) {
    showToast('中心線付近のパーツはミラーの意味がほぼありません（X座標を確認してください）', true);
  }

  const newId = genPartId();
  const mirroredProps = JSON.parse(JSON.stringify(src.props));
  if (mirroredProps.side === 'left') mirroredProps.side = 'right';
  else if (mirroredProps.side === 'right') mirroredProps.side = 'left';
  if (mirroredProps.gearPosition === 'main_left') mirroredProps.gearPosition = 'main_right';
  else if (mirroredProps.gearPosition === 'main_right') mirroredProps.gearPosition = 'main_left';

  // 着陸脚は関節/伸縮節のidを複製先で振り直す（gizmo階層のuserData参照とprops配列の対応がずれないように）
  if (src.type === 'landing_gear') {
    mirroredProps.joints = mirroredProps.joints.map(j => ({ ...j, id: genJointId() }));
    mirroredProps.struts = mirroredProps.struts.map(s => ({ ...s, id: genStrutId() }));
  }

  // 翼の4頂点もX座標を反転する（パーツ全体のミラーと整合させ、左右対称の形にするため）
  if (src.type === 'wing' && mirroredProps.corners) {
    for (const key of csWingCornerKeys(mirroredProps.corners)) {
      mirroredProps.corners[key].x = -mirroredProps.corners[key].x;
    }
  }

  const baseName = src.name.replace(/（ミラー）$/, '');
  const name = `${baseName}（ミラー）`;

  const gizmoMesh = src.type === 'landing_gear'
    ? buildLandingGearHierarchy(mirroredProps)
    : createPartGizmoMesh(src.type, mirroredProps.role, mirroredProps.corners, mirroredProps);
  gizmoMesh.position.set(-src.position.x, src.position.y, src.position.z);
  // 鏡像変換：X軸まわりの回転はそのまま、Y・Z軸まわりの回転は符号反転
  gizmoMesh.rotation.set(
    THREE.MathUtils.degToRad(src.rotation.x),
    THREE.MathUtils.degToRad(-src.rotation.y),
    THREE.MathUtils.degToRad(-src.rotation.z)
  );
  gizmoMesh.scale.set(src.scale.x, src.scale.y, src.scale.z);
  State.model.root.add(gizmoMesh);

  const part = {
    id: newId, type: src.type, name,
    position: { x: -src.position.x, y: src.position.y, z: src.position.z },
    rotation: { x: src.rotation.x, y: -src.rotation.y, z: -src.rotation.z },
    scale: { ...src.scale },
    props: mirroredProps,
    gizmo: gizmoMesh,
  };
  State.parts.push(part);
  gizmoMesh.userData.partId = newId;
  // 舵面は、親の翼の鏡像の翼（同じ役割で左右反対にあるもの）へ付け替えてから形を合わせる
  if (src.type === 'control_surface') {
    const srcWing = controlSurfaceParentWing(src);
    if (srcWing) {
      const tol = Math.max(0.05, Math.abs(srcWing.position.x) * 0.05);
      const twin = State.parts.find(w => w.type === 'wing' && w.id !== srcWing.id
        && w.props.role === srcWing.props.role
        && Math.abs(w.position.x + srcWing.position.x) <= tol
        && Math.abs(w.position.y - srcWing.position.y) <= tol + Math.abs(srcWing.position.y) * 0.05
        && Math.abs(w.position.z - srcWing.position.z) <= tol + Math.abs(srcWing.position.z) * 0.05);
      if (twin) mirroredProps.parentWingId = twin.id;
    }
    syncControlSurfaceToWing(part);
  }

  selectPart(newId);
  renderPartList();
  showToast(`「${baseName}」をミラー配置しました`);
  return part;
}

// 保存データからパーツを再構築（gizmo mesh を新規生成）
function rebuildPartsFromSaved(savedParts) {
  clearAllParts();
  let maxIdNum = 0;
  let maxJointNum = 0;
  let maxStrutNum = 0;
  for (const sp of savedParts) {
    const props = { ...sp.props };
    if (sp.type === 'wing' && !props.role) props.role = 'main'; // 旧データ互換（role未設定→主翼扱い）
    if (sp.type === 'wing' && !props.corners) props.corners = defaultWingCorners(props.role); // 旧データ互換（4頂点未設定→デフォルト形状）
    if (sp.type === 'control_surface' && props.spanS === undefined) {
      // 旧データ互換（spanS未設定→種類ごとの推奨値、不明ならデフォルトのエルロン相当値）
      const kindDef = CONTROL_SURFACE_KINDS.find(k => k.value === props.kind);
      props.spanS = kindDef ? kindDef.suggestedSpanS : 0.78;
    }
    if (sp.type === 'landing_gear') {
      // 旧データ互換（着陸脚の概念が無かった頃のデータには存在しないため、無ければ空配列で補う）
      if (!props.joints) props.joints = [];
      if (!props.struts) props.struts = [];
      if (props.deployState === undefined) props.deployState = 1;
      if (props.retractedAtZero === undefined) props.retractedAtZero = true;
    }

    const gizmoMesh = sp.type === 'landing_gear'
      ? buildLandingGearHierarchy(props)
      : createPartGizmoMesh(sp.type, props.role, props.corners, props);
    gizmoMesh.position.set(sp.position.x, sp.position.y, sp.position.z);
    gizmoMesh.rotation.set(
      THREE.MathUtils.degToRad(sp.rotation.x),
      THREE.MathUtils.degToRad(sp.rotation.y),
      THREE.MathUtils.degToRad(sp.rotation.z)
    );
    gizmoMesh.scale.set(sp.scale.x, sp.scale.y, sp.scale.z);
    State.model.root.add(gizmoMesh);
    gizmoMesh.userData.partId = sp.id;

    const part = {
      id: sp.id, type: sp.type, name: sp.name,
      position: { ...sp.position }, rotation: { ...sp.rotation }, scale: { ...sp.scale },
      props,
      gizmo: gizmoMesh,
    };
    State.parts.push(part);
    if (sp.type === 'landing_gear') applyDeployStateToGear(part);

    const numPart = parseInt(sp.id.replace('part_', ''), 10);
    if (!isNaN(numPart) && numPart > maxIdNum) maxIdNum = numPart;
    if (sp.type === 'landing_gear') {
      for (const j of props.joints) {
        const n = parseInt(String(j.id).replace('joint_', ''), 10);
        if (!isNaN(n) && n > maxJointNum) maxJointNum = n;
      }
      for (const s of props.struts) {
        const n = parseInt(String(s.id).replace('strut_', ''), 10);
        if (!isNaN(n) && n > maxStrutNum) maxStrutNum = n;
      }
    }
  }
  State.partIdCounter = maxIdNum + 1;
  State.jointIdCounter = maxJointNum + 1;
  State.strutIdCounter = maxStrutNum + 1;
  // 舵面を親の翼から切り取った形にする（翼が後から読まれることもあるので、全部読んでから）。
  // 大きさを持っていない旧データは、これまでと同じ効きの大きさに読み替わる。
  // 親の翼の指定が、この機体に無い翼を指しているとき（部品を消した・別の機体から写した）は、
  // 飛行の側と同じく、いちばん近い翼を親にする。
  for (const p of State.parts) {
    if (p.type !== 'control_surface' || !p.props.parentWingId || controlSurfaceParentWing(p)) continue;
    let best = null, bestD = Infinity;
    for (const w of State.parts) {
      if (w.type !== 'wing' || !w.props.corners) continue;
      const c = csWingToParent(w, wingCornersCenter(w.props.corners));
      const d = (c.x - p.position.x) ** 2 + (c.y - p.position.y) ** 2 + (c.z - p.position.z) ** 2;
      if (d < bestD) { bestD = d; best = w; }
    }
    if (best) p.props.parentWingId = best.id;
  }
  for (const p of State.parts) if (p.type === 'control_surface') syncControlSurfaceToWing(p);
  renderPartList();
}
