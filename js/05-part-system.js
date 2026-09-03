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

  const gizmoMesh = createPartGizmoMesh(type, props.role);
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
    if (p.gizmo) State.scene.remove(p.gizmo);
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
// 対象: engine / wing（主翼・水平尾翼） / control_surface / light
// vtail（垂直尾翼）や side=center のパーツは中心配置が前提のため対象外とする
function canMirrorPart(part) {
  if (!part) return false;
  if (!['engine', 'wing', 'control_surface', 'light'].includes(part.type)) return false;
  if (part.type === 'wing' && part.props.role === 'vtail') return false;
  if (part.type === 'wing' && part.props.side === 'center') return false;
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

  const baseName = src.name.replace(/（ミラー）$/, '');
  const name = `${baseName}（ミラー）`;

  const gizmoMesh = createPartGizmoMesh(src.type, mirroredProps.role);
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
  for (const sp of savedParts) {
    const props = { ...sp.props };
    if (sp.type === 'wing' && !props.role) props.role = 'main'; // 旧データ互換（role未設定→主翼扱い）

    const gizmoMesh = createPartGizmoMesh(sp.type, props.role);
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

    const numPart = parseInt(sp.id.replace('part_', ''), 10);
    if (!isNaN(numPart) && numPart > maxIdNum) maxIdNum = numPart;
  }
  State.partIdCounter = maxIdNum + 1;
  renderPartList();
}
