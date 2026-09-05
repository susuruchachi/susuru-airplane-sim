// 03e-minimap.js — 右パネルの2D世界地図（ミニマップ）
//
// 600km四方あると3Dビューの中だけでは自分がどこにいるか分からなくなるので、
// worldHeightAt() を等間隔にサンプルした地図を1枚焼いておき、
// その上にカメラ位置・視野・都市・空港を毎フレーム重ねて描く。
// クリックするとその地点へカメラを飛ばせる（＝マップ上の移動手段も兼ねる）。

const MINIMAP_SIZE = 232;          // 描画解像度（CSS上の表示サイズと合わせる）
const MINIMAP_SAMPLE_STEP = 1;     // 1なら1px=1サンプル

let _minimapBase = null;           // 焼き付けた地形（毎フレーム作り直さない）
let _minimapCanvas = null;
let _minimapCtx = null;

// 標高から地図の色を決める（3Dの地表色とは別に、地図として読みやすい配色にする）
function minimapColorFor(h) {
  if (h <= 0) {
    // 海：浅いほど明るい水色
    const t = Math.min(-h / 1400, 1);
    return [
      Math.round(58 - t * 40),
      Math.round(108 - t * 74),
      Math.round(150 - t * 84),
    ];
  }
  if (h < 40) return [206, 196, 156];        // 海岸・砂浜
  if (h < 300) {
    const t = h / 300;
    return [Math.round(104 - t * 26), Math.round(146 - t * 24), Math.round(84 - t * 24)];
  }
  if (h < 900) {
    const t = (h - 300) / 600;
    return [Math.round(78 + t * 60), Math.round(122 - t * 16), Math.round(60 + t * 6)];
  }
  if (h < 1800) {
    const t = (h - 900) / 900;
    return [Math.round(138 + t * 32), Math.round(106 + t * 14), Math.round(66 + t * 22)];
  }
  if (h < 2600) {
    const t = (h - 1800) / 800;
    return [Math.round(170 + t * 34), Math.round(120 + t * 46), Math.round(88 + t * 62)];
  }
  return [238, 242, 248]; // 雪
}

function initMinimap() {
  _minimapCanvas = document.getElementById('envMinimap');
  if (!_minimapCanvas) return;
  _minimapCanvas.width = MINIMAP_SIZE;
  _minimapCanvas.height = MINIMAP_SIZE;
  _minimapCtx = _minimapCanvas.getContext('2d');

  bakeMinimapTerrain();

  _minimapCanvas.addEventListener('click', onMinimapClick);
  _minimapCanvas.style.cursor = 'crosshair';
  EnvState.minimap = { canvas: _minimapCanvas, ctx: _minimapCtx };
}

// 地形を1枚の画像に焼く。起動時に一度だけ走る。
function bakeMinimapTerrain() {
  const n = MINIMAP_SIZE / MINIMAP_SAMPLE_STEP;
  const off = document.createElement('canvas');
  off.width = off.height = MINIMAP_SIZE;
  const ctx = off.getContext('2d');
  const img = ctx.createImageData(MINIMAP_SIZE, MINIMAP_SIZE);

  for (let j = 0; j < MINIMAP_SIZE; j++) {
    const z = -WORLD_HALF + ((j + 0.5) / MINIMAP_SIZE) * WORLD_SIZE;
    for (let i = 0; i < MINIMAP_SIZE; i++) {
      const x = -WORLD_HALF + ((i + 0.5) / MINIMAP_SIZE) * WORLD_SIZE;
      const h = worldHeightAt(x, z);
      const c = minimapColorFor(h);

      // 北西からの陰影を足すと、山脈の走り方が地図でも分かるようになる
      let shade = 1;
      if (h > 0) {
        const d = 2400;
        const hx = worldHeightAt(x - d, z) - h;
        const hz = worldHeightAt(x, z - d) - h;
        shade = 1 + Math.max(-0.45, Math.min(0.45, (hx + hz) / 900));
      }

      const o = (j * MINIMAP_SIZE + i) * 4;
      img.data[o] = Math.max(0, Math.min(255, c[0] * shade));
      img.data[o + 1] = Math.max(0, Math.min(255, c[1] * shade));
      img.data[o + 2] = Math.max(0, Math.min(255, c[2] * shade));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  _minimapBase = off;
  void n;
}

function minimapWorldToPx(x, z) {
  return {
    px: ((x + WORLD_HALF) / WORLD_SIZE) * MINIMAP_SIZE,
    py: ((z + WORLD_HALF) / WORLD_SIZE) * MINIMAP_SIZE,
  };
}

function minimapPxToWorld(px, py) {
  return {
    x: (px / MINIMAP_SIZE) * WORLD_SIZE - WORLD_HALF,
    z: (py / MINIMAP_SIZE) * WORLD_SIZE - WORLD_HALF,
  };
}

// 焼いた地形の上に、都市・空港・カメラ位置を重ねて描く
function updateMinimap() {
  if (!_minimapCtx || !_minimapBase) return;
  const ctx = _minimapCtx;
  ctx.drawImage(_minimapBase, 0, 0);

  // 都市
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (const c of WORLD_CITIES) {
    const p = minimapWorldToPx(c.x, c.z);
    const r = 1.1 + c.size * 2.0;
    ctx.beginPath();
    ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 空港（選択中のものは色を変えて大きく）
  for (let i = 0; i < EnvState.airports.length; i++) {
    const a = EnvState.airports[i];
    const p = minimapWorldToPx(a.def.x, a.def.z);
    const selected = i === EnvState.selectedAirportIndex;
    ctx.strokeStyle = selected ? '#ffd166' : '#7fd4ff';
    ctx.lineWidth = selected ? 2 : 1.2;
    const s = selected ? 4.5 : 3;
    ctx.beginPath();
    ctx.moveTo(p.px - s, p.py); ctx.lineTo(p.px + s, p.py);
    ctx.moveTo(p.px, p.py - s); ctx.lineTo(p.px, p.py + s);
    ctx.stroke();
  }

  // カメラの位置と、いま向いている方向の視野
  const cam = EnvState.camera.position;
  const tgt = EnvState.orbitControls.target;
  const cp = minimapWorldToPx(cam.x, cam.z);
  const dx = tgt.x - cam.x, dz = tgt.z - cam.z;
  const len = Math.hypot(dx, dz) || 1;
  const dirA = Math.atan2(dz / len, dx / len);
  const half = THREE.MathUtils.degToRad(EnvState.camera.fov * EnvState.camera.aspect * 0.5);
  const reach = 26;

  ctx.fillStyle = 'rgba(255,209,102,0.22)';
  ctx.beginPath();
  ctx.moveTo(cp.px, cp.py);
  ctx.arc(cp.px, cp.py, reach, dirA - half, dirA + half);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(cp.px, cp.py, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// クリックした地点へカメラを移す。高さは地形に合わせ、寄り具合は今の距離を保つ。
function onMinimapClick(ev) {
  const rect = _minimapCanvas.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * MINIMAP_SIZE;
  const py = ((ev.clientY - rect.top) / rect.height) * MINIMAP_SIZE;
  const w = minimapPxToWorld(px, py);

  const ground = Math.max(worldHeightAt(w.x, w.z), 0);
  const cam = EnvState.camera.position;
  const tgt = EnvState.orbitControls.target;
  const offset = { x: cam.x - tgt.x, y: cam.y - tgt.y, z: cam.z - tgt.z };

  tgt.set(w.x, ground, w.z);
  cam.set(w.x + offset.x, ground + offset.y, w.z + offset.z);
  EnvState.orbitControls.update();

  // 移した先の地形はまだ粗いLODのままなので、すぐ作り直させる
  if (typeof updateTerrainLod === 'function') updateTerrainLod(false);
}
