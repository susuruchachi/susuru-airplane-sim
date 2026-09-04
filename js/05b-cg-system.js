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

// 「主翼から決定」— 左右主翼のX位置の中間点を重心のXに反映する
// （Y/Zは変更しない。左右対称の中心線を出すのが目的のため。尾翼は対象外とし主翼のみで判定する）
function setCgFromWings() {
  const wings = State.parts.filter(p => p.type === 'wing' && p.props.role === 'main');
  const leftWings = wings.filter(w => w.props.side === 'left');
  const rightWings = wings.filter(w => w.props.side === 'right');

  if (leftWings.length === 0 || rightWings.length === 0) {
    showToast('左翼・右翼が両方とも必要です（主翼の設定で左右を指定してください）', true);
    return false;
  }

  const avgX = (arr) => arr.reduce((s, w) => s + w.position.x, 0) / arr.length;
  const leftX = avgX(leftWings);
  const rightX = avgX(rightWings);
  const midX = (leftX + rightX) / 2;

  State.cg.position.x = midX;
  applyCgToGizmo();
  if (State.cg.selected) updateInspectorNumbersOnly(null, true);
  renderInspector();
  showToast(`左右主翼の中心（X = ${midX.toFixed(3)}）に重心を合わせました`);
  return true;
}
