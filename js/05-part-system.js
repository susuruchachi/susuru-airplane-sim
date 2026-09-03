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
        side: 'left',          // left | right | center（尾翼など）
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

function createPartGizmoMesh(type) {
  const color = new THREE.Color(PART_TYPE_COLORS[type]);
  let geo;
  switch (type) {
    case 'engine':
      geo = new THREE.CylinderGeometry(0.18, 0.22, 0.4, 16);
      break;
    case 'wing':
      geo = new THREE.BoxGeometry(1.2, 0.06, 0.35);
      break;
    case 'control_surface':
      geo = new THREE.BoxGeometry(0.4, 0.04, 0.18);
      break;
    case 'light':
      geo = new THREE.SphereGeometry(0.07, 12, 12);
      break;
    default:
      geo = new THREE.SphereGeometry(0.1, 8, 8);
  }
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: type === 'light' ? 0.9 : 0.25,
    roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.92,
  });
  const mesh = new THREE.Mesh(geo, mat);
  if (type === 'engine') mesh.rotation.z = Math.PI / 2;
  mesh.userData.isPartGizmo = true;
  return mesh;
}

function addPart(type, position) {
  if (!State.model.root) {
    showToast('先に機体モデルを読み込んでください', true);
    return null;
  }
  const id = genPartId();
  const count = State.parts.filter(p => p.type === type).length + 1;
  const name = `${PART_TYPE_LABELS[type]} ${count}`;

  const gizmoMesh = createPartGizmoMesh(type);
  const pos = position || defaultSpawnPosition();
  gizmoMesh.position.copy(pos);
  State.scene.add(gizmoMesh);

  const part = {
    id, type, name,
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    props: defaultPropsForType(type),
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
  renderPartList();
  renderInspector();
}

function selectPart(id) {
  State.selectedPartId = id;
  const part = getSelectedPart();
  if (part && part.gizmo) {
    State.transformControls.attach(part.gizmo);
    document.getElementById('gizmoModeBar').style.display = 'flex';
    document.getElementById('axisReadout').style.display = 'block';
  } else {
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

// 保存データからパーツを再構築（gizmo mesh を新規生成）
function rebuildPartsFromSaved(savedParts) {
  clearAllParts();
  let maxIdNum = 0;
  for (const sp of savedParts) {
    const gizmoMesh = createPartGizmoMesh(sp.type);
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
      props: { ...sp.props },
      gizmo: gizmoMesh,
    };
    State.parts.push(part);

    const numPart = parseInt(sp.id.replace('part_', ''), 10);
    if (!isNaN(numPart) && numPart > maxIdNum) maxIdNum = numPart;
  }
  State.partIdCounter = maxIdNum + 1;
  renderPartList();
}
