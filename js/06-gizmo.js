// 06-gizmo.js — ギズモモード切替、ビューポートクリックでの選択（パーツ／重心）、軸方向ビュー

function setupGizmoUI() {
  const modeBar = document.getElementById('gizmoModeBar');
  modeBar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      State.gizmoMode = mode;
      State.transformControls.setMode(mode);
      modeBar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  State.transformControls.addEventListener('objectChange', () => {
    if (State.cg.selected) {
      syncCgFromGizmo();
      updateInspectorNumbersOnly(null, true);
      return;
    }
    const part = getSelectedPart();
    if (part) {
      syncPartFromGizmo(part);
      updateInspectorNumbersOnly(part);
    }
  });

  // キーボードショートカット（W/E/R = 移動/回転/拡縮、船シム/宇宙船シムと共通の慣習）
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'w' || e.key === 'W') setGizmoMode('translate');
    if (e.key === 'e' || e.key === 'E') setGizmoMode('rotate');
    if (e.key === 'r' || e.key === 'R') setGizmoMode('scale');
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (State.selectedPartId && document.activeElement.tagName !== 'INPUT') {
        removePart(State.selectedPartId);
      }
    }
    if (e.key === 'Escape') { selectPart(null); deselectCg(); renderInspector(); }
  });
}

function setGizmoMode(mode) {
  if (State.cg.selected) return; // 重心は移動のみ
  State.gizmoMode = mode;
  State.transformControls.setMode(mode);
  document.querySelectorAll('#gizmoModeBar button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function setupViewportPicking() {
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const canvas = document.getElementById('viewport');
  let downPos = null;

  canvas.addEventListener('pointerdown', (e) => {
    downPos = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const dx = e.clientX - downPos.x, dy = e.clientY - downPos.y;
    downPos = null;
    if (Math.sqrt(dx * dx + dy * dy) > 4) return; // ドラッグ（カメラ操作）は無視

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, State.camera);

    const pickables = State.parts.map(p => p.gizmo).filter(Boolean);
    if (State.cg.gizmo && State.cg.gizmo.visible) pickables.push(State.cg.gizmo);
    const hits = raycaster.intersectObjects(pickables, true);
    if (hits.length > 0) {
      let obj = hits[0].object;
      // 重心ギズモはGroupなので子メッシュからルートを辿る
      while (obj.parent && !obj.userData.partId && !obj.userData.isCgGizmo) obj = obj.parent;
      if (obj.userData.isCgGizmo) {
        deselectCg();
        selectPart(null);
        selectCg();
      } else if (obj.userData.partId) {
        deselectCg();
        selectPart(obj.userData.partId);
      }
    }
  });
}

function updateAxisReadout() {
  const el = document.getElementById('axisReadout');
  if (el.style.display === 'none') return;
  if (State.cg.selected) {
    el.innerHTML = `
      <div class="row" style="color:#ffd23f;margin-bottom:2px;">重心（原点）</div>
      <div class="row"><span class="axis-x">X ${State.cg.position.x.toFixed(2)}</span></div>
      <div class="row"><span class="axis-y">Y ${State.cg.position.y.toFixed(2)}</span></div>
      <div class="row"><span class="axis-z">Z ${State.cg.position.z.toFixed(2)}</span></div>
    `;
    return;
  }
  const part = getSelectedPart();
  if (!part) return;
  el.innerHTML = `
    <div class="row"><span class="axis-x">X ${part.position.x.toFixed(2)}</span></div>
    <div class="row"><span class="axis-y">Y ${part.position.y.toFixed(2)}</span></div>
    <div class="row"><span class="axis-z">Z ${part.position.z.toFixed(2)}</span></div>
  `;
}

// ---- 軸方向ビュー（前後/左右/上下からの正投影的な見た目のパースビュー） ----
// 機体モデルの中心を基準に、各軸の遠方からtargetを見る形でカメラを配置する
// 機体のローカル座標系は機首が-Z方向という一般的な3D慣習に合わせている（front=-Z側から見る＝機首を正面に見る）
const AXIS_VIEW_DIRS = {
  front: { vec: [0, 0, -1], label: '前' },
  back:  { vec: [0, 0, 1], label: '後' },
  left:  { vec: [-1, 0, 0], label: '左' },
  right: { vec: [1, 0, 0], label: '右' },
  top:   { vec: [0, 1, 0], label: '上' },
  bottom:{ vec: [0, -1, 0], label: '下' },
};

function goToAxisView(axisKey) {
  const def = AXIS_VIEW_DIRS[axisKey];
  if (!def) return;
  const target = State.orbitControls.target.clone();
  const radius = Math.max(State.model.boundingRadius * 2.2, 3);
  const dir = new THREE.Vector3(def.vec[0], def.vec[1], def.vec[2]);
  State.camera.position.copy(target.clone().add(dir.multiplyScalar(radius)));
  State.camera.up.set(0, axisKey === 'top' || axisKey === 'bottom' ? 0 : 1, 0);
  if (axisKey === 'top' || axisKey === 'bottom') State.camera.up.set(0, 0, -1);
  State.camera.lookAt(target);
  State.orbitControls.update();
}

function setupAxisViewButtons() {
  document.querySelectorAll('#axisViewBar button').forEach(btn => {
    btn.addEventListener('click', () => goToAxisView(btn.dataset.axis));
  });
}
