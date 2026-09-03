// 06-gizmo.js — ギズモモード切替、ビューポートクリックでのパーツ選択

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
    if (e.key === 'Escape') selectPart(null);
  });
}

function setGizmoMode(mode) {
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

    const gizmoMeshes = State.parts.map(p => p.gizmo).filter(Boolean);
    const hits = raycaster.intersectObjects(gizmoMeshes, false);
    if (hits.length > 0) {
      const partId = hits[0].object.userData.partId;
      selectPart(partId);
    }
  });
}

function updateAxisReadout() {
  const el = document.getElementById('axisReadout');
  const part = getSelectedPart();
  if (!part || el.style.display === 'none') return;
  el.innerHTML = `
    <div class="row"><span class="axis-x">X ${part.position.x.toFixed(2)}</span></div>
    <div class="row"><span class="axis-y">Y ${part.position.y.toFixed(2)}</span></div>
    <div class="row"><span class="axis-z">Z ${part.position.z.toFixed(2)}</span></div>
  `;
}
