// 05-part-system.js — パーツ（エンジン/主翼/可動翼面/航行灯）の追加・削除・可視化

function defaultPropsForType(type) {
  switch (type) {
    case 'engine':
      return {
        thrustKgf: 2000,       // 最大推力（kgf、参考値・後の飛行モデルで使用）
        spinAxis: 'z',         // プロペラ/ファンの回転軸
      };
    case 'wing':
      return {
        span: 2.0,             // 翼幅（m）目安。羽の可動部の親として使う
        role: 'main',          // main | htail | vtail（主翼／水平尾翼／垂直尾翼）
        side: 'left',          // left | right | center（垂直尾翼など中心配置のもの）
      };
    case 'control_surface':
      return {
        kind: 'aileron',
        hingeAxis: 'x',        // 可動軸（ローカル座標系）
        minDeg: -20,
        maxDeg: 20,
        parentWingId: null,    // どの主翼に属するか（任意）
      };
    case 'light':
      return {
        kind: 'nav_red',
        color: LIGHT_KINDS[0].color,
        blink: LIGHT_KINDS[0].blink,
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

function createPartGizmoMesh(type, role) {
  const color = new THREE.Color(PART_TYPE_COLORS[type]);
  const geo = geometryForPart(type, role);
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: type === 'light' ? 0.9 : 0.25,
    roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.92,
  });
  const mesh = new THREE.Mesh(geo, mat);
  if (type === 'engine') mesh.rotation.z = Math.PI / 2;
  mesh.userData.isPartGizmo = true;
  return mesh;
}

function geometryForPart(type, role) {
  switch (type) {
    case 'engine':
      return new THREE.CylinderGeometry(0.18, 0.22, 0.4, 16);
    case 'wing':
      // 垂直尾翼は縦に立てた薄板、それ以外（主翼・水平尾翼）は横に広い薄板
      if (role === 'vtail') return new THREE.BoxGeometry(0.35, 0.9, 0.3);
      return new THREE.BoxGeometry(1.2, 0.06, 0.35);
    case 'control_surface':
      return new THREE.BoxGeometry(0.4, 0.04, 0.18);
    case 'light':
      return new THREE.SphereGeometry(0.07, 12, 12);
    default:
      return new THREE.SphereGeometry(0.1, 8, 8);
  }
}

// 翼の役割（主翼/水平尾翼/垂直尾翼）が変わったとき、ギズモの形状だけ差し替える
function updateWingGizmoShape(part) {
  if (part.type !== 'wing' || !part.gizmo) return;
  part.gizmo.geometry.dispose();
  part.gizmo.geometry = geometryForPart('wing', part.props.role);
}

// ---- 着陸脚（landing_gear）専用のギズモ構築 ----
// 構造：基点(Group) → [関節(Group,回転) → 伸縮節(Group,軸方向移動) → 関節 → ...] → 先端の車輪的マーカー
// joints/strutsの配列順が、そのまま基点から先端に向かうチェーンの順序になる
const GEAR_COLOR = 0xc792ea;

function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  });
}

function createJointVisual() {
  // 回転軸を示す短い円柱＋周囲リング
  const group = new THREE.Group();
  const axisMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10),
    new THREE.MeshStandardMaterial({ color: GEAR_COLOR, emissive: GEAR_COLOR, emissiveIntensity: 0.35, roughness: 0.4, transparent: true, opacity: 0.92 })
  );
  group.add(axisMesh);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.012, 8, 24),
    new THREE.MeshBasicMaterial({ color: GEAR_COLOR, transparent: true, opacity: 0.6 })
  );
  group.add(ring);
  return group;
}

function createStrutVisual(length) {
  // テレスコピック（入れ子シリンダー）風の二重円柱で伸縮節を表現
  const group = new THREE.Group();
  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, length, 10),
    new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.3, metalness: 0.5, transparent: true, opacity: 0.85 })
  );
  outer.position.y = length / 2; // 基点(付け根)から+方向に伸びる形にする
  group.add(outer);
  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, length * 0.6, 10),
    new THREE.MeshStandardMaterial({ color: GEAR_COLOR, emissive: GEAR_COLOR, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.4, transparent: true, opacity: 0.92 })
  );
  inner.position.y = length * 0.8;
  group.add(inner);
  group.userData.isStrutVisual = true;
  group.userData.baseLength = length;
  return group;
}

// jointsとstrutsの定義から、実際の3D階層（基点→関節→伸縮節→関節→...→先端）を組み立てる
// 戻り値のrootに対し、part.gizmo = root とする。各関節/伸縮節のGroupはuserDataにidと種別を持つので、
// 展開状態プレビュー（applyDeployStateToGear）でid照合して角度・長さを反映できる
function buildLandingGearHierarchy(props) {
  const root = new THREE.Group();
  root.userData.isPartGizmo = true;
  root.userData.isLandingGearRoot = true;

  // 基点マーカー（付け根の位置を示す小さな球）
  const baseMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 10, 10),
    new THREE.MeshStandardMaterial({ color: GEAR_COLOR, emissive: GEAR_COLOR, emissiveIntensity: 0.4, roughness: 0.4, transparent: true, opacity: 0.9 })
  );
  root.add(baseMarker);

  let current = root; // チェーンの末端（次のセグメントをここにぶら下げる）

  // joints[i] と struts[i] を交互に、定義順（関節→伸縮節→関節→伸縮節...）でチェーンする。
  // 数が揃っていなくても対応できるよう、長い方の配列に合わせてループする
  const n = Math.max(props.joints.length, props.struts.length);
  for (let i = 0; i < n; i++) {
    const jointDef = props.joints[i];
    if (jointDef) {
      const jointVisual = createJointVisual();
      jointVisual.userData.isJointVisual = true;
      jointVisual.userData.jointId = jointDef.id;
      current.add(jointVisual);
      current = jointVisual;
    }
    const strutDef = props.struts[i];
    if (strutDef) {
      const len = strutDef.minLength;
      const strutVisual = createStrutVisual(Math.max(len, 0.05));
      strutVisual.userData.strutId = strutDef.id;
      current.add(strutVisual);
      current = strutVisual;
    }
  }

  // 先端マーカー（車輪の位置目安）
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 10),
    new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.7, transparent: true, opacity: 0.9 })
  );
  current.add(tip);

  return root;
}

// 関節/伸縮節の追加・削除・軸変更のたびに呼び、gizmo階層を作り直す
// （既存のgizmoは破棄して新規に作り直す。シーンへの追加・位置/回転/スケールの再適用は呼び出し側で行う）
function rebuildLandingGearGizmo(part) {
  if (part.type !== 'landing_gear') return;
  const oldGizmo = part.gizmo;
  const newGizmo = buildLandingGearHierarchy(part.props);
  newGizmo.position.copy(oldGizmo.position);
  newGizmo.rotation.copy(oldGizmo.rotation);
  newGizmo.scale.copy(oldGizmo.scale);
  newGizmo.userData.partId = part.id;

  State.scene.add(newGizmo);
  State.scene.remove(oldGizmo);
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
  const t = part.props.retractedAtZero ? part.props.deployState : (1 - part.props.deployState);

  part.gizmo.traverse(obj => {
    if (obj.userData.isJointVisual) {
      const jointDef = part.props.joints.find(j => j.id === obj.userData.jointId);
      if (!jointDef) return;
      const deg = THREE.MathUtils.lerp(jointDef.minDeg, jointDef.maxDeg, t);
      const rad = THREE.MathUtils.degToRad(deg);
      obj.rotation.set(0, 0, 0);
      if (jointDef.axis === 'x') obj.rotation.x = rad;
      else if (jointDef.axis === 'y') obj.rotation.y = rad;
      else obj.rotation.z = rad;
    }
    if (obj.userData.isStrutVisual && obj.userData.strutId) {
      const strutDef = part.props.struts.find(s => s.id === obj.userData.strutId);
      if (!strutDef) return;
      const len = Math.max(THREE.MathUtils.lerp(strutDef.minLength, strutDef.maxLength, t), 0.05);
      // outer/inner の2子メッシュを長さに応じて再配置（createStrutVisualと対になるジオメトリ再生成）
      const outer = obj.children[0], inner = obj.children[1];
      if (outer) {
        outer.geometry.dispose();
        outer.geometry = new THREE.CylinderGeometry(0.05, 0.05, len, 10);
        outer.position.y = len / 2;
      }
      if (inner) {
        inner.geometry.dispose();
        inner.geometry = new THREE.CylinderGeometry(0.028, 0.028, len * 0.6, 10);
        inner.position.y = len * 0.8;
      }
    }
  });
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
    : createPartGizmoMesh(type, props.role);
  const pos = position || defaultSpawnPosition();
  gizmoMesh.position.copy(pos);
  State.scene.add(gizmoMesh);

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
  return new THREE.Vector3(target.x, target.y + r * 0.3, target.z);
}

function removePart(id) {
  const idx = State.parts.findIndex(p => p.id === id);
  if (idx === -1) return;
  const part = State.parts[idx];
  if (part.gizmo) {
    if (State.transformControls.object === part.gizmo) {
      State.transformControls.detach();
    }
    State.scene.remove(part.gizmo);
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
  for (const p of State.parts) {
    if (p.gizmo) {
      State.scene.remove(p.gizmo);
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
  State.selectedPartId = id;
  if (id !== null) deselectCg();
  const part = getSelectedPart();
  if (part && part.gizmo) {
    State.transformControls.attach(part.gizmo);
    document.getElementById('gizmoModeBar').style.display = 'flex';
    document.getElementById('axisReadout').style.display = 'block';
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
  part.position.x = part.gizmo.position.x;
  part.position.y = part.gizmo.position.y;
  part.position.z = part.gizmo.position.z;
  part.rotation.x = THREE.MathUtils.radToDeg(part.gizmo.rotation.x);
  part.rotation.y = THREE.MathUtils.radToDeg(part.gizmo.rotation.y);
  part.rotation.z = THREE.MathUtils.radToDeg(part.gizmo.rotation.z);
  part.scale.x = part.gizmo.scale.x;
  part.scale.y = part.gizmo.scale.y;
  part.scale.z = part.gizmo.scale.z;
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

  const baseName = src.name.replace(/（ミラー）$/, '');
  const name = `${baseName}（ミラー）`;

  const gizmoMesh = src.type === 'landing_gear'
    ? buildLandingGearHierarchy(mirroredProps)
    : createPartGizmoMesh(src.type, mirroredProps.role);
  gizmoMesh.position.set(-src.position.x, src.position.y, src.position.z);
  // 鏡像変換：X軸まわりの回転はそのまま、Y・Z軸まわりの回転は符号反転
  gizmoMesh.rotation.set(
    THREE.MathUtils.degToRad(src.rotation.x),
    THREE.MathUtils.degToRad(-src.rotation.y),
    THREE.MathUtils.degToRad(-src.rotation.z)
  );
  gizmoMesh.scale.set(src.scale.x, src.scale.y, src.scale.z);
  State.scene.add(gizmoMesh);

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
    if (sp.type === 'landing_gear') {
      // 旧データ互換（着陸脚の概念が無かった頃のデータには存在しないため、無ければ空配列で補う）
      if (!props.joints) props.joints = [];
      if (!props.struts) props.struts = [];
      if (props.deployState === undefined) props.deployState = 1;
      if (props.retractedAtZero === undefined) props.retractedAtZero = true;
    }

    const gizmoMesh = sp.type === 'landing_gear'
      ? buildLandingGearHierarchy(props)
      : createPartGizmoMesh(sp.type, props.role);
    gizmoMesh.position.set(sp.position.x, sp.position.y, sp.position.z);
    gizmoMesh.rotation.set(
      THREE.MathUtils.degToRad(sp.rotation.x),
      THREE.MathUtils.degToRad(sp.rotation.y),
      THREE.MathUtils.degToRad(sp.rotation.z)
    );
    gizmoMesh.scale.set(sp.scale.x, sp.scale.y, sp.scale.z);
    State.scene.add(gizmoMesh);
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
  renderPartList();
}
