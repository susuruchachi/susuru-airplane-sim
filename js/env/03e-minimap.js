// 03e-minimap.js — 右パネルの2D世界地図（ミニマップ）
//
// 3,000km四方あると3Dビューの中だけでは自分がどこにいるか分からなくなるので、
// worldHeightAt() を等間隔にサンプルした地図を焼いておき、
// その上にカメラ位置・視野・都市・空港を毎フレーム重ねて描く。
// クリックするとその地点へカメラが飛ぶ（＝マップ上の移動手段も兼ねる）。
//
// 焼くのは1枚あたり5万点以上のサンプルになるので、一気にやるとカクつく。
// 数行ずつ進める「焼き付けジョブ」にして、フレームをまたいで少しずつ仕上げる。

const MINIMAP_SIZE = 232;
const MINIMAP_BAKE_ROWS_PER_FRAME = 12;

// 表示範囲。世界全体は原点固定、それ以外はカメラを中心にする。
const MINIMAP_ZOOMS = [
  { id: 'world', label: '世界', span: 0 },       // span=0 は「世界全体」の意味
  { id: 'wide', label: '広域', span: 700000 },
  { id: 'local', label: '周辺', span: 160000 },
];

let _minimapCanvas = null;
let _minimapCtx = null;
let _minimapBase = null;        // 焼き上がった地形（表示に使う）
let _minimapBaseView = null;    // その地形がどの範囲を表しているか
let _minimapWorldCache = null;  // 「世界」ズームは一度焼いたら使い回す
let _minimapBakeJob = null;
let _minimapZoom = 0;

// 標高から地図の色を決める（3Dの地表色とは別に、地図として読みやすい配色にする）
function minimapColorFor(h) {
  if (h <= 0) {
    const t = Math.min(-h / 1400, 1);
    return [58 - t * 40, 108 - t * 74, 150 - t * 84];
  }
  if (h < 40) return [206, 196, 156];
  if (h < 300) { const t = h / 300; return [104 - t * 26, 146 - t * 24, 84 - t * 24]; }
  if (h < 900) { const t = (h - 300) / 600; return [78 + t * 60, 122 - t * 16, 60 + t * 6]; }
  if (h < 1800) { const t = (h - 900) / 900; return [138 + t * 32, 106 + t * 14, 66 + t * 22]; }
  if (h < 2600) { const t = (h - 1800) / 800; return [170 + t * 34, 120 + t * 46, 88 + t * 62]; }
  return [238, 242, 248];
}

function minimapCurrentView() {
  const z = MINIMAP_ZOOMS[_minimapZoom];
  if (z.span === 0) return { cx: 0, cz: 0, span: WORLD_SIZE };
  const cam = EnvState.camera.position;
  return { cx: cam.x, cz: cam.z, span: z.span };
}

function initMinimap() {
  _minimapCanvas = document.getElementById('envMinimap');
  if (!_minimapCanvas) return;
  _minimapCanvas.width = MINIMAP_SIZE;
  _minimapCanvas.height = MINIMAP_SIZE;
  _minimapCtx = _minimapCanvas.getContext('2d');
  _minimapCanvas.addEventListener('click', onMinimapClick);
  _minimapCanvas.style.cursor = 'crosshair';
  EnvState.minimap = { canvas: _minimapCanvas };
  startMinimapBake(minimapCurrentView());
}

// 焼き付けジョブを始める。前のジョブは捨てる（視点が動き続けている間は最新だけでよい）。
function startMinimapBake(view) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MINIMAP_SIZE;
  const ctx = canvas.getContext('2d');
  _minimapBakeJob = {
    view, canvas, ctx,
    img: ctx.createImageData(MINIMAP_SIZE, MINIMAP_SIZE),
    row: 0,
  };
}

// 数行ずつ焼く。北西からの陰影を足すと、地図でも山脈の走り方が分かるようになる。
function stepMinimapBake() {
  const job = _minimapBakeJob;
  if (!job) return;
  const { view, img } = job;
  const half = view.span / 2;
  const step = view.span / MINIMAP_SIZE;
  const shadeStep = Math.max(step * 1.4, 700);
  const end = Math.min(job.row + MINIMAP_BAKE_ROWS_PER_FRAME, MINIMAP_SIZE);

  for (let j = job.row; j < end; j++) {
    const z = view.cz - half + (j + 0.5) * step;
    for (let i = 0; i < MINIMAP_SIZE; i++) {
      const x = view.cx - half + (i + 0.5) * step;
      const h = worldHeightAt(x, z);
      const c = minimapColorFor(h);

      let shade = 1;
      if (h > 0) {
        const hx = worldHeightAt(x - shadeStep, z) - h;
        const hz = worldHeightAt(x, z - shadeStep) - h;
        shade = 1 + Math.max(-0.45, Math.min(0.45, (hx + hz) / (shadeStep * 0.38)));
      }

      const o = (j * MINIMAP_SIZE + i) * 4;
      img.data[o] = Math.max(0, Math.min(255, c[0] * shade));
      img.data[o + 1] = Math.max(0, Math.min(255, c[1] * shade));
      img.data[o + 2] = Math.max(0, Math.min(255, c[2] * shade));
      img.data[o + 3] = 255;
    }
  }
  job.row = end;

  if (job.row >= MINIMAP_SIZE) {
    job.ctx.putImageData(img, 0, 0);
    _minimapBase = job.canvas;
    _minimapBaseView = job.view;
    if (view.span === WORLD_SIZE && view.cx === 0 && view.cz === 0) {
      _minimapWorldCache = { canvas: job.canvas, view: job.view };
    }
    _minimapBakeJob = null;
  }
}

function minimapWorldToPx(view, x, z) {
  const half = view.span / 2;
  return {
    px: ((x - view.cx + half) / view.span) * MINIMAP_SIZE,
    py: ((z - view.cz + half) / view.span) * MINIMAP_SIZE,
  };
}

// 焼いた地形の上に、都市・空港・カメラ位置を重ねて描く
function updateMinimap() {
  if (!_minimapCtx) return;
  stepMinimapBake();

  // 表示したい範囲と、いま焼けている範囲がずれてきたら焼き直す
  const want = minimapCurrentView();
  if (!_minimapBakeJob && _minimapBaseView) {
    const moved = Math.hypot(want.cx - _minimapBaseView.cx, want.cz - _minimapBaseView.cz);
    if (want.span !== _minimapBaseView.span || moved > want.span * 0.12) {
      if (want.span === WORLD_SIZE && _minimapWorldCache) {
        _minimapBase = _minimapWorldCache.canvas;
        _minimapBaseView = _minimapWorldCache.view;
      } else {
        startMinimapBake(want);
      }
    }
  }
  if (!_minimapBase) return;

  const view = _minimapBaseView;
  const ctx = _minimapCtx;
  ctx.drawImage(_minimapBase, 0, 0);

  const zoomedIn = view.span < WORLD_SIZE * 0.5;
  const margin = view.span * 0.55;

  // 都市。広い表示のときは小さな街まで描くと点だらけになるので大きい街だけにする
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  for (const c of WORLD_CITIES) {
    if (!zoomedIn && !c.capital && c.size < 0.45) continue;
    if (Math.abs(c.x - view.cx) > margin || Math.abs(c.z - view.cz) > margin) continue;
    const p = minimapWorldToPx(view, c.x, c.z);
    ctx.beginPath();
    ctx.arc(p.px, p.py, 1.0 + c.size * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 空港（選択中のものは色を変えて大きく）
  for (const a of WORLD_AIRPORTS) {
    if (Math.abs(a.x - view.cx) > margin || Math.abs(a.z - view.cz) > margin) continue;
    const p = minimapWorldToPx(view, a.x, a.z);
    const selected = a.id === EnvState.selectedAirportId;
    if (!zoomedIn && !selected && a.runwayLengthM < 2600) continue;
    ctx.strokeStyle = selected ? '#ffd166' : '#7fd4ff';
    ctx.lineWidth = selected ? 2 : 1.1;
    const s = selected ? 4.5 : 2.6;
    ctx.beginPath();
    ctx.moveTo(p.px - s, p.py); ctx.lineTo(p.px + s, p.py);
    ctx.moveTo(p.px, p.py - s); ctx.lineTo(p.px, p.py + s);
    ctx.stroke();
  }

  // カメラの位置と、いま向いている方向の視野
  const cam = EnvState.camera.position;
  const tgt = EnvState.orbitControls.target;
  const cp = minimapWorldToPx(view, cam.x, cam.z);
  const dx = tgt.x - cam.x, dz = tgt.z - cam.z;
  const len = Math.hypot(dx, dz) || 1;
  const dirA = Math.atan2(dz / len, dx / len);
  const halfFov = THREE.MathUtils.degToRad(EnvState.camera.fov * EnvState.camera.aspect * 0.5);
  // 視野の扇は「実際に見えている距離（far）」をこの縮尺に直した長さで描く
  const reach = Math.max((EnvState.camera.far / view.span) * MINIMAP_SIZE, 10);

  ctx.fillStyle = 'rgba(255,209,102,0.20)';
  ctx.beginPath();
  ctx.moveTo(cp.px, cp.py);
  ctx.arc(cp.px, cp.py, reach, dirA - halfFov, dirA + halfFov);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(cp.px, cp.py, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 縮尺の目安
  const barM = view.span / 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(8, MINIMAP_SIZE - 10); ctx.lineTo(8 + MINIMAP_SIZE / 4, MINIMAP_SIZE - 10);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText(`${Math.round(barM / 1000).toLocaleString()} km`, 10, MINIMAP_SIZE - 14);

  // 焼き付け中はその旨を出す（固まったように見えないように）
  if (_minimapBakeJob) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, MINIMAP_SIZE, 14);
    ctx.fillStyle = '#cfe3ff';
    ctx.fillText('地図を描画中…', 6, 10);
  }
}

// クリックした地点へカメラを移す。高さは地形に合わせ、寄り具合は今の距離を保つ。
function onMinimapClick(ev) {
  if (!_minimapBaseView) return;
  const rect = _minimapCanvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * MINIMAP_SIZE;
  const py = ((ev.clientY - rect.top) / rect.height) * MINIMAP_SIZE;

  const view = _minimapBaseView;
  const half = view.span / 2;
  const wx = view.cx - half + (px / MINIMAP_SIZE) * view.span;
  const wz = view.cz - half + (py / MINIMAP_SIZE) * view.span;

  const ground = Math.max(worldHeightAt(wx, wz), 0);
  const cam = EnvState.camera.position;
  const tgt = EnvState.orbitControls.target;
  const offset = { x: cam.x - tgt.x, y: cam.y - tgt.y, z: cam.z - tgt.z };

  tgt.set(wx, ground, wz);
  cam.set(wx + offset.x, ground + offset.y, wz + offset.z);
  EnvState.orbitControls.update();

  // 飛んだ先の地形・街・空港をその場で揃える
  if (typeof terrainRebuildNow === 'function') terrainRebuildNow();
}

// ズーム切り替えのボタン（06-env-ui.js の setupWorldUI から呼ばれる）
function setupMinimapUI() {
  const host = document.getElementById('envMinimapZoom');
  if (!host) return;
  MINIMAP_ZOOMS.forEach((z, i) => {
    const btn = document.createElement('button');
    btn.textContent = z.label;
    btn.dataset.zoom = String(i);
    btn.className = i === _minimapZoom ? 'active' : '';
    btn.addEventListener('click', () => {
      _minimapZoom = i;
      host.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.dataset.zoom === String(i));
      });
    });
    host.appendChild(btn);
  });
}
