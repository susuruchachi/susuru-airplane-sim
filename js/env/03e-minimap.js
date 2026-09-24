// 03e-minimap.js — 右パネルの2D世界地図（ミニマップ）
//
// 3,000km四方あると3Dビューの中だけでは自分がどこにいるか分からなくなるので、
// worldHeightAt() を等間隔にサンプルした地図を焼いておき、
// その上にカメラ位置・視野・都市・空港を毎フレーム重ねて描く。
// 国境は焼くときに一緒に塗り、川・湖と地名（国・都市・空港コード・山脈・峰・川・湖）は
// 範囲が変わったときに一度だけ配置を決めて、毎フレームそれを描く。
// クリックするとその地点へカメラが飛ぶ（＝マップ上の移動手段も兼ねる）。
//
// 焼くのは1枚あたり5万点以上のサンプルになるので、一気にやるとカクつく。
// 数行ずつ進める「焼き付けジョブ」にして、フレームをまたいで少しずつ仕上げる。

const MINIMAP_SIZE = 232;
const MINIMAP_BAKE_ROWS_PER_FRAME = 12;

// 気象レーダー。地図の4画素にひとつの粗さで降水を塗り、拡大して重ねる。
// 重いのは標高（＝気温）なので、地図を焼くときに一緒に採っておいて使い回す。
// 時間で変わるのは気象の場のほうだけなので、そこだけを塗り直す。
const MINIMAP_RADAR_STRIDE = 4;
const MINIMAP_RADAR_CELLS = MINIMAP_SIZE / MINIMAP_RADAR_STRIDE; // 58
const MINIMAP_RADAR_REFRESH_MS = 300;

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

let _radarClimate = null;       // { view, temp, dry }（地図と同じ範囲の気候。時間では変わらない）
let _radarCanvas = null;        // 58×58 のオフスクリーン
let _radarCtx = null;
let _radarImg = null;
let _radarAt = 0;               // 最後に塗り直した時刻
let _radarSnowShare = 0;        // いま映っている降水のうち雪の割合（凡例の表示に使う）

let _minimapDpr = 1;            // 高精細な画面では、地名が滲まないよう内部の解像度を上げる
let _minimapLabels = null;      // { view, selected, rivers, lakes, symbols, labels }（範囲ごとに作り直す）

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
  // 座標はすべて MINIMAP_SIZE 基準のまま描き、変換行列で画面の画素へ広げる
  _minimapDpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  _minimapCanvas.width = Math.round(MINIMAP_SIZE * _minimapDpr);
  _minimapCanvas.height = Math.round(MINIMAP_SIZE * _minimapDpr);
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
  const cells = MINIMAP_RADAR_CELLS * MINIMAP_RADAR_CELLS;
  _minimapBakeJob = {
    view, canvas, ctx,
    img: ctx.createImageData(MINIMAP_SIZE, MINIMAP_SIZE),
    row: 0,
    // レーダー用の気候。標高を採るついでに埋めるので、余分な worldHeightAt は増えない
    climate: { view, temp: new Float32Array(cells), dry: new Float32Array(cells) },
    // 国境を引くための「どの国の陸か」（0は海）。現在地の表示と同じく、いちばん近い都市の国で決める
    country: new Uint8Array(MINIMAP_SIZE * MINIMAP_SIZE),
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

      if (h > 0) job.country[j * MINIMAP_SIZE + i] = minimapCountryIndexAt(x, z);

      const o = (j * MINIMAP_SIZE + i) * 4;
      img.data[o] = Math.max(0, Math.min(255, c[0] * shade));
      img.data[o + 1] = Math.max(0, Math.min(255, c[1] * shade));
      img.data[o + 2] = Math.max(0, Math.min(255, c[2] * shade));
      img.data[o + 3] = 255;

      // レーダーの粗い格子に当たる画素では、いま採った標高から気候も控えておく
      if ((i % MINIMAP_RADAR_STRIDE) === 0 && (j % MINIMAP_RADAR_STRIDE) === 0) {
        const ci = (j / MINIMAP_RADAR_STRIDE) * MINIMAP_RADAR_CELLS + (i / MINIMAP_RADAR_STRIDE);
        job.climate.temp[ci] = worldTemperatureAt(x, z, Math.max(h, 0));
        job.climate.dry[ci] = worldDrynessAt(x, z, worldLandValueAt(x, z));
      }
    }
  }
  job.row = end;

  if (job.row >= MINIMAP_SIZE) {
    paintMinimapBorders(img, job.country);
    job.ctx.putImageData(img, 0, 0);
    _minimapBase = job.canvas;
    _minimapBaseView = job.view;
    _radarClimate = job.climate;
    _radarAt = 0; // 範囲が変わったので次のフレームで塗り直す
    if (view.span === WORLD_SIZE && view.cx === 0 && view.cz === 0) {
      _minimapWorldCache = { canvas: job.canvas, view: job.view, climate: job.climate };
    }
    _minimapBakeJob = null;
  }
}

// その地点がどの国か（WORLD_COUNTRIES の番号+1）。worldRegionAt と同じく、いちばん近い都市の国。
// 1画素ごとに130都市を見るので、平方根を取らずに比べる。
function minimapCountryIndexAt(x, z) {
  let best = null, bestD = Infinity;
  for (let k = 0; k < WORLD_CITIES.length; k++) {
    const c = WORLD_CITIES[k];
    const dx = x - c.x, dz = z - c.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return 0;
  if (!best._countryIndex) best._countryIndex = WORLD_COUNTRIES.findIndex((co) => co.id === best.country) + 1;
  return best._countryIndex;
}

// 国境。陸どうしで国が変わる境目の両側の画素を破線で塗る（海の上には引かない）。
// 片側1画素だけだと、高精細な画面で地図を引き伸ばしたときに滲んで見えなくなる。
function paintMinimapBorders(img, country) {
  const N = MINIMAP_SIZE;
  const mark = new Uint8Array(N * N);
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const k = j * N + i;
      const a = country[k];
      if (!a) continue;
      const r = country[k + 1], d = country[k + N];
      if (r && r !== a) { mark[k] = 1; mark[k + 1] = 1; }
      if (d && d !== a) { mark[k] = 1; mark[k + N] = 1; }
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (!mark[k] || (i + j) % 6 >= 4) continue; // 4画素描いて2画素空ける破線
      const o = k * 4;
      img.data[o] = img.data[o] * 0.15 + 225 * 0.85;
      img.data[o + 1] = img.data[o + 1] * 0.15 + 92 * 0.85;
      img.data[o + 2] = img.data[o + 2] * 0.15 + 150 * 0.85;
    }
  }
}

// --- 気象レーダー -----------------------------------------------------------
//
// 本物のレーダーと同じく、映すのは降水だけ。雲や霧は映らない
// （霧の中を飛ぶことになっても、レーダーには何も出ない）。
// 弱い雨は青、強くなるほど緑→黄→橙→赤。雪は寒色でひとまとめ。
// 雷が鳴っているところは紫に寄せる。

const RADAR_RAIN_STOPS = [
  [0.00, [80, 170, 240]], [0.22, [40, 120, 235]], [0.42, [70, 195, 120]],
  [0.62, [240, 220, 70]], [0.80, [245, 150, 50]], [1.00, [235, 70, 60]],
];
const RADAR_SNOW_STOPS = [
  [0.00, [205, 228, 246]], [0.35, [150, 200, 240]], [0.70, [110, 165, 230]], [1.00, [78, 118, 214]],
];

function radarRamp(stops, t) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0] || i === stops.length - 1) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const u = b === a ? 0 : Math.max(0, Math.min(1, (t - a) / (b - a)));
      return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u];
    }
  }
  return stops[0][1];
}

// 粗い格子ぶんの降水を塗り直す。気候は焼き付け済みのものを使うので、
// ここで呼ぶのは気象の場（fBm 3本）と deriveWeather だけ＝1面あたり数ミリ秒。
function bakeMinimapRadar(view) {
  if (!_radarCanvas) {
    _radarCanvas = document.createElement('canvas');
    _radarCanvas.width = _radarCanvas.height = MINIMAP_RADAR_CELLS;
    _radarCtx = _radarCanvas.getContext('2d');
    _radarImg = _radarCtx.createImageData(MINIMAP_RADAR_CELLS, MINIMAP_RADAR_CELLS);
  }

  const preset = weatherPresetById(EnvState.weather.presetId);
  const hours = EnvState.weather.clockHours;
  const opts = { forcePrecip: preset.forcePrecip || null, climate: preset.id === 'auto', climateAt: null };
  const climateAt = { temp: 0, dry: 0 };
  opts.climateAt = climateAt;

  const half = view.span / 2;
  const step = view.span / MINIMAP_RADAR_CELLS;
  const data = _radarImg.data;
  let wet = 0, snowy = 0;

  for (let j = 0; j < MINIMAP_RADAR_CELLS; j++) {
    const z = view.cz - half + (j + 0.5) * step;
    for (let i = 0; i < MINIMAP_RADAR_CELLS; i++) {
      const x = view.cx - half + (i + 0.5) * step;
      const ci = j * MINIMAP_RADAR_CELLS + i;
      climateAt.temp = _radarClimate.temp[ci];
      climateAt.dry = _radarClimate.dry[ci];

      const field = preset.id === 'auto' ? worldWeatherFieldAt(x, z, hours)
        : (preset.id === 'manual' ? EnvState.weather.manual : preset);
      const w = deriveWeather(field, x, z, 0, opts);

      const o = ci * 4;
      if (w.precipRate < 0.04) { data[o + 3] = 0; continue; }
      wet++;
      if (w.precipIsSnow > 0.5) snowy++;

      const c = w.precipIsSnow > 0.5
        ? radarRamp(RADAR_SNOW_STOPS, w.precipRate)
        : radarRamp(RADAR_RAIN_STOPS, w.precipRate);
      // 雷が鳴っているところは紫へ寄せる
      if (w.storminess > 0.45) {
        const u = ((w.storminess - 0.45) / 0.55) * 0.7;
        c[0] += (196 - c[0]) * u; c[1] += (84 - c[1]) * u; c[2] += (220 - c[2]) * u;
      }
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
      // 濃くしすぎると全域が降っているとき地図が読めなくなる
      data[o + 3] = Math.round((0.28 + Math.min(w.precipRate, 1) * 0.38) * 255);
    }
  }
  _radarCtx.putImageData(_radarImg, 0, 0);
  _radarSnowShare = wet ? snowy / wet : 0;
}

function drawMinimapRadar(ctx, view) {
  if (!EnvState.env.radarVisible) return;
  if (!_radarClimate || _radarClimate.view !== view) return;
  if (typeof deriveWeather !== 'function' || !EnvState.weather.current) return;

  const now = performance.now();
  if (now - _radarAt > MINIMAP_RADAR_REFRESH_MS) {
    _radarAt = now;
    bakeMinimapRadar(view);
  }
  if (!_radarCanvas) return;

  // 粗い格子のまま拡大すると四角が並ぶので、なめらかに伸ばす
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(_radarCanvas, 0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
}

// レーダーの凡例。色が何を意味するかは見ただけでは分からないので出しておく。
function drawMinimapRadarLegend(ctx) {
  if (!EnvState.env.radarVisible) return;
  const w = 76, h = 6, x = MINIMAP_SIZE - w - 8, y = MINIMAP_SIZE - 16;

  // 色の意味は、いま映っているものに合わせる（雪だけのときに雨の色を出しても仕方ない）
  const stops = _radarSnowShare > 0.5 ? RADAR_SNOW_STOPS : RADAR_RAIN_STOPS;
  const kind = _radarSnowShare > 0.85 ? '雪' : (_radarSnowShare > 0.15 ? '雨雪' : '雨');

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - 4, y - 11, w + 8, h + 15);
  for (let i = 0; i < w; i++) {
    const c = radarRamp(stops, i / (w - 1));
    ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    ctx.fillRect(x + i, y, 1, h);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillText(kind + ' 弱', x, y - 3);
  ctx.textAlign = 'right';
  ctx.fillText('強', x + w, y - 3);
  ctx.textAlign = 'left';

  // 固定プリセットのときは全域おなじ天気になる。何も出ない/一面が塗られる理由を書いておく。
  // 縮尺と重ならないよう上の隅に出す（焼き付け中の表示とは入れ替わりで出るので衝突しない）。
  if (EnvState.weather.presetId !== 'auto' && !_minimapBakeJob) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, 138, 14);
    ctx.fillStyle = '#cfe3ff';
    ctx.fillText('天候を固定中：全域おなじ', 5, 10);
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
        _radarClimate = _minimapWorldCache.climate;
        _radarAt = 0;
      } else {
        startMinimapBake(want);
      }
    }
  }
  if (!_minimapBase) return;

  const view = _minimapBaseView;
  const ctx = _minimapCtx;
  ctx.setTransform(_minimapDpr, 0, 0, _minimapDpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(_minimapBase, 0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

  // 地名の配置は範囲・選んでいる空港・レーダーの有無が変わったときだけ決め直す
  const selected = EnvState.selectedAirportId;
  const radar = !!EnvState.env.radarVisible;
  let L = _minimapLabels;
  if (!L || L.view !== view || L.selected !== selected || L.radar !== radar) {
    L = _minimapLabels = buildMinimapLabels(ctx, view, selected, radar);
  }

  // 湖と川は地形の上・レーダーの下
  ctx.fillStyle = 'rgb(66,122,170)';
  ctx.fill(L.lakes);
  ctx.strokeStyle = 'rgba(120,186,232,0.95)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const r of L.rivers) {
    ctx.lineWidth = r.width;
    ctx.stroke(r.path);
  }

  // 降水は地形の上・記号の下に重ねる（街や空港がレーダーで隠れないように）
  drawMinimapRadar(ctx, view);

  drawMinimapSymbols(ctx, L.symbols);
  drawMinimapLabelText(ctx, L.labels);

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

  drawMinimapRadarLegend(ctx);

  // 焼き付け中はその旨を出す（固まったように見えないように）
  if (_minimapBakeJob) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, MINIMAP_SIZE, 14);
    ctx.fillStyle = '#cfe3ff';
    ctx.fillText('地図を描画中…', 6, 10);
  }
}

// --- 地名 -------------------------------------------------------------------
//
// 地図は 232px しかないので、全部を書くと文字が重なって読めない。
// 大事なものから順に置いていき、すでに置いた文字や記号と重なるものは書かない
// （国名 → 選んでいる空港 → 首府 → 山脈 → 峰 → 湖 → 川 → 都市 → 空港コード の順）。
// 点の地物は右・左・上・下の順に置ける場所を探す。川の名前は川筋に沿って傾ける。

const MINIMAP_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function minimapHex(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

function buildMinimapLabels(ctx, view, selected, radar) {
  const N = MINIMAP_SIZE;
  const zoomedIn = view.span < WORLD_SIZE * 0.5;
  const mPerPx = view.span / N;
  const margin = view.span * 0.55;
  const near = (x, z) => Math.abs(x - view.cx) <= margin && Math.abs(z - view.cz) <= margin;
  const toPx = (x, z) => minimapWorldToPx(view, x, z);

  const placed = [];
  const labels = [];
  const symbols = [];
  const hit = (b) => {
    for (let k = 0; k < placed.length; k++) {
      const q = placed[k];
      if (b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0) return true;
    }
    return false;
  };
  const inside = (b) => b.x0 >= 1 && b.y0 >= 1 && b.x1 <= N - 1 && b.y1 <= N - 1;

  // 縮尺・凡例のぶんは空けておく
  placed.push({ x0: 0, y0: N - 26, x1: 74, y1: N });
  if (radar) placed.push({ x0: N - 92, y0: N - 30, x1: N, y1: N });

  // 点の地物の名前を置く。r は記号の半径（そのぶん離して置く）
  const tryPoint = (text, font, px, py, r, color, sizePx) => {
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const h = sizePx;
    const g = r + 2;
    const cands = [
      [px + g, py + h * 0.35, 'left'], [px - g, py + h * 0.35, 'right'],
      [px, py - g - 1, 'center'], [px, py + g + h * 0.8, 'center'],
    ];
    for (const [x, y, align] of cands) {
      const x0 = align === 'left' ? x : (align === 'right' ? x - w : x - w / 2);
      const b = { x0: x0 - 1, y0: y - h * 0.8 - 1, x1: x0 + w + 1, y1: y + h * 0.25 + 1 };
      if (!inside(b) || hit(b)) continue;
      placed.push(b);
      labels.push({ text, font, x, y, align, color });
      return true;
    }
    return false;
  };

  // 1) 国名。広域・世界で、国の中心に大きく。
  //    記号より先に置く（国の中心には首府などの街があることが多く、記号を避けると
  //    10か国のうち1か国しか書けなかった）。記号は文字の上から描かれるので隠れない。
  if (view.span > 300000) {
    for (const co of WORLD_COUNTRIES) {
      if (!near(co.cx, co.cz)) continue;
      const p = toPx(co.cx, co.cz);
      const size = zoomedIn ? 12 : 10;
      const font = `bold ${size}px ${MINIMAP_FONT}`;
      const text = co.nameLatin.toUpperCase();
      ctx.font = font;
      const w = ctx.measureText(text).width;
      for (const dy of [0, -11, 11, -22, 22]) {
        const y = p.py + dy + size * 0.35;
        const b = { x0: p.px - w / 2 - 1, y0: y - size * 0.8, x1: p.px + w / 2 + 1, y1: y + size * 0.25 };
        if (!inside(b) || hit(b)) continue;
        placed.push(b);
        labels.push({ text, font, x: p.px, y, align: 'center', color: minimapHex(co.tint), strong: true });
        break;
      }
    }
  }

  // --- 記号（先に場所を取っておき、名前が記号を隠さないようにする） ---
  const cities = [];
  for (const c of WORLD_CITIES) {
    if (!zoomedIn && !c.capital && c.size < 0.45) continue;
    if (!near(c.x, c.z)) continue;
    const p = toPx(c.x, c.z);
    const r = 1.0 + c.size * 2.2;
    symbols.push({ kind: 'city', px: p.px, py: p.py, r });
    placed.push({ x0: p.px - r, y0: p.py - r, x1: p.px + r, y1: p.py + r });
    cities.push({ c, p, r });
  }
  const airports = [];
  for (const a of WORLD_AIRPORTS) {
    if (!near(a.x, a.z)) continue;
    const isSel = a.id === selected;
    if (!zoomedIn && !isSel && a.runwayLengthM < 2600) continue;
    const p = toPx(a.x, a.z);
    const s = isSel ? 4.5 : 2.6;
    symbols.push({ kind: 'airport', px: p.px, py: p.py, s, selected: isSel });
    placed.push({ x0: p.px - s, y0: p.py - s, x1: p.px + s, y1: p.py + s });
    airports.push({ a, p, s, isSel });
  }

  // --- 湖と川の形（ラベルとは別に、名前が置けなくても描く） ---
  const lakes = new Path2D();
  const lakeList = [];
  for (const l of WORLD_LAKES) {
    if (!near(l.x, l.z)) continue;
    const c = toPx(l.x, l.z);
    const rPx = l.outerR / mPerPx;
    if (rPx < 0.6) continue;
    // 岸は地形の等高線なので、世界側が方位ごとに持っている岸までの距離（l.shore）で結ぶ
    const rays = l.shore.length;
    const n = rPx > 6 ? rays : 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = l.shore[Math.floor((i / n) * rays)] / mPerPx;
      const x = c.px + Math.cos(a) * rr, y = c.py + Math.sin(a) * rr;
      if (i === 0) lakes.moveTo(x, y); else lakes.lineTo(x, y);
    }
    lakes.closePath();
    lakeList.push({ l, c, rPx });
  }

  const rivers = [];
  const riverLines = [];
  for (const r of WORLD_RIVERS) {
    const path = new Path2D();
    const line = []; // 画面の中に見えている部分（名前を置くのに使う）
    let last = null, drawing = false, any = false;
    const end = r.points[r.points.length - 1];
    for (let i = 0; i < r.points.length; i++) {
      const q = r.points[i];
      const p = toPx(q.x, q.z);
      const vis = p.px > -4 && p.py > -4 && p.px < N + 4 && p.py < N + 4;
      if (!vis) { drawing = false; last = null; continue; }
      if (last && i !== r.points.length - 1 && Math.hypot(p.px - last.px, p.py - last.py) < 1.2) continue;
      if (!drawing) { path.moveTo(p.px, p.py); drawing = true; } else path.lineTo(p.px, p.py);
      line.push(p);
      last = p;
      any = true;
    }
    if (!any) continue;
    // 太さは実際の川幅を縮尺に直したもの（ただし細すぎると見えないので下限を付ける）
    const width = Math.max(zoomedIn ? 1.0 : 0.7, Math.min(3, (2 * (end.halfWidth || 60)) / mPerPx));
    rivers.push({ path, width });
    riverLines.push({ r, line });
  }

  // --- 名前 ---

  // 2) 選んでいる空港
  for (const ap of airports) {
    if (ap.isSel) tryPoint(ap.a.id, `bold 10px ${MINIMAP_FONT}`, ap.p.px, ap.p.py, ap.s, '#ffd166', 10);
  }

  // 3) 首府
  for (const ct of cities) {
    if (ct.c.capital) tryPoint(ct.c.nameLatin, `bold 9px ${MINIMAP_FONT}`, ct.p.px, ct.p.py, ct.r, '#ffffff', 9);
  }

  // 4) 山脈（広域・世界）
  if (view.span > 300000) {
    for (const rg of WORLD_RANGES) {
      if (!near(rg.cx, rg.cz)) continue;
      const p = toPx(rg.cx, rg.cz);
      tryPoint(rg.nameLatin, `italic 8.5px ${MINIMAP_FONT}`, p.px, p.py, 0, '#ead9b4', 8.5);
    }
  }

  // 5) 峰（高い順。世界全体では高い10座まで）
  const peaks = WORLD_PEAKS.filter((pk) => near(pk.x, pk.z))
    .sort((a, b) => b.elevationM - a.elevationM)
    .slice(0, zoomedIn ? 999 : 10);
  for (const pk of peaks) {
    const p = toPx(pk.x, pk.z);
    const text = zoomedIn ? `${pk.nameLatin} ${pk.elevationM.toLocaleString()}m` : pk.nameLatin;
    const b = { x0: p.px - 3, y0: p.py - 3, x1: p.px + 3, y1: p.py + 2 };
    if (!inside(b) || hit(b)) continue;
    placed.push(b);
    if (tryPoint(text, `8px ${MINIMAP_FONT}`, p.px, p.py, 3, '#f3e6cc', 8)) {
      symbols.push({ kind: 'peak', px: p.px, py: p.py });
    } else {
      placed.pop();
    }
  }

  // 6) 湖（大きい順）
  lakeList.sort((a, b) => b.rPx - a.rPx);
  for (const lk of lakeList) {
    if (!zoomedIn && lk.rPx < 0.9) continue;
    tryPoint(lk.l.nameLatin, `italic 8px ${MINIMAP_FONT}`, lk.c.px, lk.c.py, Math.max(lk.rPx, 1), '#a8dcf2', 8);
  }

  // 7) 川（長い順）。見えている川筋の真ん中に、川の向きに沿って置く
  riverLines.sort((a, b) => b.r.lengthM - a.r.lengthM);
  for (const { r, line } of riverLines) {
    if (line.length < 3) continue;
    const font = `italic 8px ${MINIMAP_FONT}`;
    ctx.font = font;
    const w = ctx.measureText(r.nameLatin).width;
    // 見えている部分の長さ
    const acc = [0];
    for (let i = 1; i < line.length; i++) acc.push(acc[i - 1] + Math.hypot(line[i].px - line[i - 1].px, line[i].py - line[i - 1].py));
    const total = acc[acc.length - 1];
    // 短い川筋でも、はみ出すのが半分までなら川の真ん中に置く（広域では川が文字より短い）
    if (total < w * 0.5) continue;
    const at = (d) => {
      let i = 1;
      while (i < acc.length - 1 && acc[i] < d) i++;
      const t = (d - acc[i - 1]) / Math.max(acc[i] - acc[i - 1], 1e-6);
      return { px: line[i - 1].px + (line[i].px - line[i - 1].px) * t, py: line[i - 1].py + (line[i].py - line[i - 1].py) * t };
    };
    const fracs = total >= w * 1.3 ? [0.5, 0.3, 0.7] : [0.5];
    for (const frac of fracs) {
      const mid = total * frac;
      const span = Math.min(w, total) / 2;
      const a0 = at(mid - span), a1 = at(mid + span), c = at(mid);
      let ang = Math.atan2(a1.py - a0.py, a1.px - a0.px);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      // 傾けた文字の外接矩形で重なりを見る
      const hw = w / 2, hh = 4.5, ca = Math.abs(Math.cos(ang)), sa = Math.abs(Math.sin(ang));
      const ex = hw * ca + hh * sa, ey = hw * sa + hh * ca;
      const b = { x0: c.px - ex, y0: c.py - ey, x1: c.px + ex, y1: c.py + ey };
      if (!inside(b) || hit(b)) continue;
      placed.push(b);
      labels.push({ text: r.nameLatin, font, x: c.px, y: c.py, align: 'center', color: '#a8dcf2', angle: ang });
      break;
    }
  }

  // 8) 都市（大きい順）
  cities.sort((a, b) => b.c.size - a.c.size);
  for (const ct of cities) {
    if (ct.c.capital) continue;
    tryPoint(ct.c.nameLatin, `8.5px ${MINIMAP_FONT}`, ct.p.px, ct.p.py, ct.r, '#eeeeee', 8.5);
  }

  // 9) 空港コード（滑走路の長い順）
  airports.sort((a, b) => b.a.runwayLengthM - a.a.runwayLengthM);
  for (const ap of airports) {
    if (ap.isSel) continue;
    tryPoint(ap.a.id, `8px ${MINIMAP_FONT}`, ap.p.px, ap.p.py, ap.s, '#8fdcff', 8);
  }

  return { view, selected, radar, lakes, rivers, symbols, labels };
}

function drawMinimapSymbols(ctx, symbols) {
  for (const s of symbols) {
    if (s.kind === 'city') {
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(s.px, s.py, s.r, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.kind === 'airport') {
      ctx.strokeStyle = s.selected ? '#ffd166' : '#7fd4ff';
      ctx.lineWidth = s.selected ? 2 : 1.1;
      ctx.beginPath();
      ctx.moveTo(s.px - s.s, s.py); ctx.lineTo(s.px + s.s, s.py);
      ctx.moveTo(s.px, s.py - s.s); ctx.lineTo(s.px, s.py + s.s);
      ctx.stroke();
    } else if (s.kind === 'peak') {
      ctx.fillStyle = '#f3e6cc';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(s.px, s.py - 3); ctx.lineTo(s.px + 2.8, s.py + 2); ctx.lineTo(s.px - 2.8, s.py + 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

// 地形の色に負けないよう、暗い縁取りを付けて描く
function drawMinimapLabelText(ctx, labels) {
  ctx.lineJoin = 'round';
  for (const l of labels) {
    ctx.font = l.font;
    ctx.textAlign = l.align;
    ctx.save();
    ctx.translate(l.x, l.y);
    if (l.angle) {
      ctx.rotate(l.angle);
      // 傾けた文字は中心を川筋に合わせる（y は文字の中ほど）
      ctx.translate(0, 3);
    }
    ctx.strokeStyle = l.strong ? 'rgba(10,16,24,0.8)' : 'rgba(10,16,24,0.72)';
    ctx.lineWidth = l.strong ? 3 : 2.4;
    ctx.strokeText(l.text, 0, 0);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }
  ctx.textAlign = 'left';
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
