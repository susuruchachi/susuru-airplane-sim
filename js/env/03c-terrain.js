// 03c-terrain.js — 地形メッシュ（ストリーミング＋LOD）と海
//
// 高さはすべて js/env/03b-world.js の worldHeightAt() から取る。
//
// 世界は3,000km四方あるが、地形は **カメラの周りだけを作っては捨てる**。
// 30km角のタイルに切り、カメラから約300km（＝カメラのfarより少し広い）以内のタイルだけを
// 実体化し、外へ出たものは破棄する。これで WORLD_SIZE をいくら大きくしても
// メモリと描画の負荷は変わらない。
//
// 座標について：タイルの頂点は **タイル原点からのローカル座標** で持ち、
// ワールド上の位置は mesh.position に入れる。頂点をワールド座標のまま持つと、
// 原点から1,000km以上離れた場所で float32 の精度が1m近くまで落ち、
// 滑走路の路面標識のような細かい造作が壊れる。
// three.js は modelViewMatrix を倍精度で組んでから float32 に落とすので、
// この持ち方なら遠方でも精度が保たれる。
//
// 海は「y=0に置いた半透明の水面」。浅瀬の水色は海面ではなく
// 海底（地形メッシュ）の色で表現している。こうすると砂浜〜浅瀬〜深海の
// 移り変わりが地形の解像度そのままで出るので、海面側にシェーダーを書かずに済む。

const TERRAIN_TILE_SIZE = 30000;        // 30km角
const TERRAIN_ACTIVE_RADIUS = 300000;   // この距離までのタイルを実体化する（カメラのfarより少し広く）

// カメラからの水平距離でタイルの分割数を決める。近いほど細かい。
const TERRAIN_LOD_STEPS = [
  { maxDistM: 22000, segments: 96 },   // 約310m間隔
  { maxDistM: 50000, segments: 48 },
  { maxDistM: 100000, segments: 24 },
  { maxDistM: 180000, segments: 16 },
  { maxDistM: Infinity, segments: 10 },
];

// LODが違うタイル同士の境目にできる隙間を隠すための「スカート」（縁を下へ垂らす）
const TERRAIN_SKIRT_DEPTH = 1200;

// 1フレームに作り直すタイル数の上限（LOD切り替えでカクつかないように）
const TERRAIN_REBUILD_BUDGET = 3;

// カメラがこれだけ動いたらタイルの取捨とLODを見直す
const TERRAIN_RECHECK_DIST = 3000;

// 気候はタイル内で緩やかにしか変わらないので、頂点ごとではなく
// 粗い格子で拾って補間する（気候の計算は高さ関数と同じくらい重いため）
const TERRAIN_CLIMATE_GRID = 4;

// --- 地表の色 ---------------------------------------------------------------
// outputEncoding=sRGB で中間色が持ち上がるぶんを見越して、見た目より一段暗く指定する。

const TERRAIN_SEA_STOPS = [
  { h: -2600, c: 0x040a16 }, // 深海底
  { h: -420, c: 0x08243a }, // 大陸棚
  { h: -70, c: 0x125a68 }, // 浅瀬（半透明の海面越しに水色に見える）
  { h: -8, c: 0x5c6a4e }, // 汀線
];

const TERRAIN_C = {
  beach: 0x6b6247,
  grassCold: 0x35402c,     // 寒帯の草地・ツンドラ
  grassTemperate: 0x2c5220,
  grassTropical: 0x1e4a18,
  steppe: 0x51492c,        // 半乾燥の草原
  desert: 0x6e5c3a,
  forestCold: 0x1e3024,    // 針葉樹林
  forestTemperate: 0x1b3a16,
  forestTropical: 0x14330f,
  alpine: 0x443722,        // 森林限界より上の低木・土
  rock: 0x48443d,
  snow: 0x8f97a0,
  steepRock: 0x33312e,     // 急斜面は標高によらず岩肌
  urban: 0x4a4640,
};

function terrainHexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

const _TC = {};
for (const k in TERRAIN_C) _TC[k] = terrainHexToRgb(TERRAIN_C[k]);
const _TERRAIN_SEA_RGB = TERRAIN_SEA_STOPS.map((s) => terrainHexToRgb(s.c));

// out = a を b へ t だけ寄せる
function terrainMix(out, b, t) {
  if (t <= 0) return;
  if (t > 1) t = 1;
  out[0] += (b[0] - out[0]) * t;
  out[1] += (b[1] - out[1]) * t;
  out[2] += (b[2] - out[2]) * t;
}

// 標高・傾斜・気候から地表色を決めて out[0..2] に書き込む。
// 森林限界と雪線は気温から決まるので、北へ行くほど低い標高から岩と雪になる。
function terrainColorAt(h, slope, jitter, urban, temp, dry, out) {
  if (h <= 0) {
    const stops = TERRAIN_SEA_STOPS;
    let i = 0;
    while (i < stops.length - 2 && h > stops[i + 1].h) i++;
    const t = Math.min(Math.max((h - stops[i].h) / (stops[i + 1].h - stops[i].h), 0), 1);
    const ca = _TERRAIN_SEA_RGB[i], cb = _TERRAIN_SEA_RGB[i + 1];
    out[0] = ca[0] + (cb[0] - ca[0]) * t;
    out[1] = ca[1] + (cb[1] - ca[1]) * t;
    out[2] = ca[2] + (cb[2] - ca[2]) * t;
    const m0 = 0.86 + jitter * 0.28;
    out[0] *= m0; out[1] *= m0; out[2] *= m0;
    return;
  }

  const snowLine = 700 + temp * 3400;
  const treeLine = snowLine * 0.62;

  // 低地の色：寒帯→温帯→熱帯、そこへ乾燥をかけて草原→砂漠へ寄せる
  const lowland = [_TC.grassCold[0], _TC.grassCold[1], _TC.grassCold[2]];
  terrainMix(lowland, _TC.grassTemperate, (temp - 0.15) / 0.3);
  terrainMix(lowland, _TC.grassTropical, (temp - 0.6) / 0.3);
  terrainMix(lowland, _TC.steppe, (dry - 0.40) / 0.22);
  terrainMix(lowland, _TC.desert, (dry - 0.62) / 0.23);

  // 森の色。乾燥地には森が育たないので、乾くほど低地と同じ色へ潰す
  const forest = [_TC.forestCold[0], _TC.forestCold[1], _TC.forestCold[2]];
  terrainMix(forest, _TC.forestTemperate, (temp - 0.2) / 0.3);
  terrainMix(forest, _TC.forestTropical, (temp - 0.6) / 0.3);
  terrainMix(forest, lowland, (dry - 0.35) / 0.3);

  if (h < 11) {
    out[0] = _TC.beach[0]; out[1] = _TC.beach[1]; out[2] = _TC.beach[2];
    terrainMix(out, lowland, (h - 4) / 7);
  } else if (h < treeLine * 0.34) {
    out[0] = lowland[0]; out[1] = lowland[1]; out[2] = lowland[2];
  } else if (h < treeLine) {
    out[0] = lowland[0]; out[1] = lowland[1]; out[2] = lowland[2];
    terrainMix(out, forest, (h - treeLine * 0.34) / (treeLine * 0.5));
  } else if (h < snowLine) {
    out[0] = forest[0]; out[1] = forest[1]; out[2] = forest[2];
    const t = (h - treeLine) / (snowLine - treeLine);
    terrainMix(out, _TC.alpine, t * 2.2);
    terrainMix(out, _TC.rock, (t - 0.5) * 1.8);
  } else {
    out[0] = _TC.rock[0]; out[1] = _TC.rock[1]; out[2] = _TC.rock[2];
    terrainMix(out, _TC.snow, (h - snowLine) / 420);
  }

  // 陸の急斜面は草木も雪も付かないので岩肌へ寄せる
  if (slope > 0.32) terrainMix(out, _TC.steepRock, Math.min((slope - 0.32) / 0.34, 1) * 0.85);

  // 市街地は建物と道路で灰色寄りになる（建物メッシュだけだと上空から街に見えない）
  if (urban > 0) terrainMix(out, _TC.urban, urban * 0.72);

  // 一様な色面にならないよう、わずかに明暗をばらつかせる
  const m = 0.86 + jitter * 0.28;
  out[0] *= m; out[1] *= m; out[2] *= m;
}

// --- タイルのジオメトリ生成 -------------------------------------------------

// タイル1枚ぶんのジオメトリを作る。頂点はタイル原点からのローカル座標。
// 法線をタイル境界でも滑らかにつなぐため、高さは外側に1リング広く（n+3角）サンプルし、
// 実際に描くのは内側の (n+1)^2 頂点だけにしている。
function buildTerrainTileGeometry(originX, originZ, size, segments) {
  const n = segments;
  const step = size / n;
  const gw = n + 3; // 外側1リングぶん広い高さグリッド

  const heights = new Float32Array(gw * gw);
  for (let j = 0; j < gw; j++) {
    const z = originZ + (j - 1) * step;
    for (let i = 0; i < gw; i++) {
      heights[j * gw + i] = worldHeightAt(originX + (i - 1) * step, z);
    }
  }

  // 気候は数百km単位でしか変わらないので粗い格子で拾って双一次補間する
  const cg = TERRAIN_CLIMATE_GRID;
  const climT = new Float32Array((cg + 1) * (cg + 1));
  const climD = new Float32Array((cg + 1) * (cg + 1));
  for (let j = 0; j <= cg; j++) {
    for (let i = 0; i <= cg; i++) {
      const x = originX + (size * i) / cg, z = originZ + (size * j) / cg;
      const land = worldLandValueAt(x, z);
      const h = heights[Math.min(Math.round((i * n) / cg) + 1, gw - 1) + gw * Math.min(Math.round((j * n) / cg) + 1, gw - 1)];
      climT[j * (cg + 1) + i] = worldTemperatureAt(x, z, h);
      climD[j * (cg + 1) + i] = worldDrynessAt(x, z, land);
    }
  }
  const sampleClimate = (arr, u, v) => {
    const fu = u * cg, fv = v * cg;
    const i0 = Math.min(Math.floor(fu), cg - 1), j0 = Math.min(Math.floor(fv), cg - 1);
    const tu = fu - i0, tv = fv - j0;
    const a = arr[j0 * (cg + 1) + i0], b = arr[j0 * (cg + 1) + i0 + 1];
    const c = arr[(j0 + 1) * (cg + 1) + i0], d = arr[(j0 + 1) * (cg + 1) + i0 + 1];
    return (a + (b - a) * tu) + ((c + (d - c) * tu) - (a + (b - a) * tu)) * tv;
  };

  const vw = n + 1;
  const vertCount = vw * vw;
  const skirtCount = vw * 4;
  const positions = new Float32Array((vertCount + skirtCount) * 3);
  const normals = new Float32Array((vertCount + skirtCount) * 3);
  const colors = new Float32Array((vertCount + skirtCount) * 3);
  const rgb = [0, 0, 0];
  const inv2step = 1 / (2 * step);

  for (let j = 0; j < vw; j++) {
    for (let i = 0; i < vw; i++) {
      const gi = (j + 1) * gw + (i + 1);
      const h = heights[gi];
      const lx = i * step, lz = j * step;      // タイル原点からのローカル座標
      const wx = originX + lx, wz = originZ + lz; // 色や気候の判定はワールド座標で

      // 中央差分から法線を出す（外側リングがあるので端でも片側差分にならない）
      const dhx = (heights[gi + 1] - heights[gi - 1]) * inv2step;
      const dhz = (heights[gi + gw] - heights[gi - gw]) * inv2step;
      const len = Math.sqrt(dhx * dhx + 1 + dhz * dhz);
      const ny = 1 / len;

      const vi = (j * vw + i) * 3;
      positions[vi] = lx; positions[vi + 1] = h; positions[vi + 2] = lz;
      normals[vi] = -dhx / len; normals[vi + 1] = ny; normals[vi + 2] = -dhz / len;

      terrainColorAt(
        h, 1 - ny,
        worldValueNoise(wx * 0.00042, wz * 0.00042),
        worldUrbanFactorAt(wx, wz),
        sampleClimate(climT, i / n, j / n),
        sampleClimate(climD, i / n, j / n),
        rgb
      );
      colors[vi] = rgb[0]; colors[vi + 1] = rgb[1]; colors[vi + 2] = rgb[2];
    }
  }

  // スカート：4辺の頂点を真下へ複製する。LOD差でできる隙間を裏から塞ぐ。
  let sv = vertCount;
  const skirtBase = [];
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < vw; k++) {
      let i, j;
      if (e === 0) { i = k; j = 0; }
      else if (e === 1) { i = k; j = n; }
      else if (e === 2) { i = 0; j = k; }
      else { i = n; j = k; }

      const src = (j * vw + i) * 3;
      const dst = sv * 3;
      positions[dst] = positions[src];
      positions[dst + 1] = positions[src + 1] - TERRAIN_SKIRT_DEPTH;
      positions[dst + 2] = positions[src + 2];
      normals[dst] = normals[src]; normals[dst + 1] = normals[src + 1]; normals[dst + 2] = normals[src + 2];
      colors[dst] = colors[src]; colors[dst + 1] = colors[src + 1]; colors[dst + 2] = colors[src + 2];
      skirtBase.push(j * vw + i, sv);
      sv++;
    }
  }

  const quadCount = n * n + 4 * n;
  const IndexArray = (vertCount + skirtCount) > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(quadCount * 6);
  let p = 0;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * vw + i, b = a + 1, c = a + vw, d = c + 1;
      indices[p++] = a; indices[p++] = c; indices[p++] = b;
      indices[p++] = b; indices[p++] = c; indices[p++] = d;
    }
  }

  // 各辺のスカートを2枚の三角形で張る。辺ごとに表裏が変わるので巻き方向を分ける。
  for (let e = 0; e < 4; e++) {
    const base = e * vw * 2;
    const flip = (e === 0 || e === 3);
    for (let k = 0; k < n; k++) {
      const t0 = skirtBase[base + k * 2], s0 = skirtBase[base + k * 2 + 1];
      const t1 = skirtBase[base + (k + 1) * 2], s1 = skirtBase[base + (k + 1) * 2 + 1];
      if (flip) {
        indices[p++] = t0; indices[p++] = s0; indices[p++] = t1;
        indices[p++] = t1; indices[p++] = s0; indices[p++] = s1;
      } else {
        indices[p++] = t0; indices[p++] = t1; indices[p++] = s0;
        indices[p++] = t1; indices[p++] = s1; indices[p++] = s0;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

// --- タイルの出し入れ -------------------------------------------------------

const _terrainTiles = new Map();     // "ix,iz" -> { ix, iz, originX, originZ, lod, mesh }
let _terrainWork = [];               // これから作る／作り直すタイル
let _terrainLastCheck = null;

function terrainTileKey(ix, iz) { return ix + ',' + iz; }

function terrainSegmentsForDistance(d) {
  for (let i = 0; i < TERRAIN_LOD_STEPS.length; i++) {
    if (d < TERRAIN_LOD_STEPS[i].maxDistM) return TERRAIN_LOD_STEPS[i].segments;
  }
  return TERRAIN_LOD_STEPS[TERRAIN_LOD_STEPS.length - 1].segments;
}

function initTerrain() {
  EnvState.terrainGroup = new THREE.Group();
  EnvState.scene.add(EnvState.terrainGroup);
  EnvState.terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

  refreshTerrainTiles(true);
  initSea();
}

function disposeTerrainTile(tile) {
  if (!tile.mesh) return;
  EnvState.terrainGroup.remove(tile.mesh);
  tile.mesh.geometry.dispose();
  tile.mesh = null;
}

function buildTerrainTile(tile) {
  disposeTerrainTile(tile);
  const geo = buildTerrainTileGeometry(tile.originX, tile.originZ, TERRAIN_TILE_SIZE, tile.pendingLod);
  tile.mesh = new THREE.Mesh(geo, EnvState.terrainMaterial);
  tile.mesh.position.set(tile.originX, 0, tile.originZ);
  tile.mesh.matrixAutoUpdate = false;
  tile.mesh.updateMatrix();
  tile.lod = tile.pendingLod;
  EnvState.terrainGroup.add(tile.mesh);
}

// カメラの周りにあるべきタイルを揃える。
// 圏外のタイルは捨て、足りないタイルとLODが変わったタイルを作業キューへ積む。
function refreshTerrainTiles(immediate) {
  const cam = EnvState.camera.position;
  _terrainLastCheck = { x: cam.x, z: cam.z };

  const R = TERRAIN_ACTIVE_RADIUS;
  const i0 = Math.floor((cam.x - R) / TERRAIN_TILE_SIZE), i1 = Math.floor((cam.x + R) / TERRAIN_TILE_SIZE);
  const j0 = Math.floor((cam.z - R) / TERRAIN_TILE_SIZE), j1 = Math.floor((cam.z + R) / TERRAIN_TILE_SIZE);

  const keep = new Set();
  const work = [];

  for (let ix = i0; ix <= i1; ix++) {
    for (let iz = j0; iz <= j1; iz++) {
      const originX = ix * TERRAIN_TILE_SIZE, originZ = iz * TERRAIN_TILE_SIZE;
      const centerX = originX + TERRAIN_TILE_SIZE / 2, centerZ = originZ + TERRAIN_TILE_SIZE / 2;
      const dx = cam.x - centerX, dz = cam.z - centerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist - TERRAIN_TILE_SIZE * 0.71 > R) continue; // 円の外は作らない

      const key = terrainTileKey(ix, iz);
      keep.add(key);

      let tile = _terrainTiles.get(key);
      if (!tile) {
        tile = { ix, iz, originX, originZ, lod: -1, mesh: null };
        _terrainTiles.set(key, tile);
      }
      const seg = terrainSegmentsForDistance(Math.max(dist - TERRAIN_TILE_SIZE * 0.71, 0));
      if (seg !== tile.lod) {
        tile.pendingLod = seg;
        tile.sortDist = dist;
        work.push(tile);
      }
    }
  }

  // 圏外に出たタイルを捨てる
  for (const [key, tile] of _terrainTiles) {
    if (!keep.has(key)) {
      disposeTerrainTile(tile);
      _terrainTiles.delete(key);
    }
  }

  // 街と空港も同じ判断で出し入れする（判定のタイミングを揃えておく）
  if (typeof refreshCities === 'function') refreshCities();
  if (typeof refreshAirports === 'function') refreshAirports();

  // 近いタイルから作る（見ている場所ほど早く出てほしい）
  work.sort((a, b) => a.sortDist - b.sortDist);

  if (immediate) {
    for (const tile of work) buildTerrainTile(tile);
    _terrainWork = [];
  } else {
    _terrainWork = work;
  }
}

// 毎フレーム呼ぶ。カメラが十分動いたらタイルを見直し、作業キューを少しずつ消化する。
function updateTerrain() {
  const cam = EnvState.camera.position;
  if (_terrainWork.length === 0 && _terrainLastCheck) {
    const dx = cam.x - _terrainLastCheck.x, dz = cam.z - _terrainLastCheck.z;
    if (dx * dx + dz * dz > TERRAIN_RECHECK_DIST * TERRAIN_RECHECK_DIST) refreshTerrainTiles(false);
  }

  let budget = TERRAIN_REBUILD_BUDGET;
  while (budget > 0 && _terrainWork.length > 0) {
    buildTerrainTile(_terrainWork.shift());
    budget--;
  }
}

// 視点を大きく飛ばしたあとなど、周囲の地形をすぐ作り直したいときに使う
function terrainRebuildNow() {
  refreshTerrainTiles(true);
}

// 地形を作り直させたい範囲を指示する（空港を足した／消したときなど）
function terrainInvalidateArea(x, z, radius) {
  for (const tile of _terrainTiles.values()) {
    const cx = tile.originX + TERRAIN_TILE_SIZE / 2, cz = tile.originZ + TERRAIN_TILE_SIZE / 2;
    if (Math.hypot(cx - x, cz - z) < radius + TERRAIN_TILE_SIZE) tile.lod = -1;
  }
  refreshTerrainTiles(false);
}

// --- 海 ---------------------------------------------------------------------
//
// r128 は WebGL2 だと対数深度を「頂点で計算して画面上で線形補間する」経路に落ちる。
// log は上に凸なので、1枚のポリゴンが手前から奥まで大きく伸びていると、
// 補間された深度が本来より手前に寄り、海面が陸地や滑走路を覆い隠してしまう。
// そこで海面は「カメラを中心とした同心円メッシュ」にして、
// 近いところほど細かく分割する（1つの四角形の中で距離が16%しか変わらないようにする）。

const SEA_RING_COUNT = 64;
const SEA_SECTOR_COUNT = 96;
const SEA_INNER_R = 30;
const SEA_OUTER_R = 400000;      // カメラのfarを全方位で覆える大きさ
const SEA_WAVE_PATTERN_M = 9000; // ノーマルマップ1タイルぶんの実寸

let _seaWaveDrift = { x: 0, y: 0 };

// 中心が細かく外側ほど粗い円盤を作る。UVはワールド座標そのままにしておき、
// 板をカメラへ動かしたぶんはテクスチャのoffsetで打ち消す（うねりが付いて来ないように）。
function buildSeaGeometry() {
  const rings = SEA_RING_COUNT, sectors = SEA_SECTOR_COUNT;
  const vertCount = 1 + rings * sectors;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const P = SEA_WAVE_PATTERN_M;

  normals[1] = 1;

  const growth = Math.pow(SEA_OUTER_R / SEA_INNER_R, 1 / (rings - 1));
  for (let ri = 0; ri < rings; ri++) {
    const r = SEA_INNER_R * Math.pow(growth, ri);
    for (let si = 0; si < sectors; si++) {
      const a = (si / sectors) * Math.PI * 2;
      const vi = 1 + ri * sectors + si;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      positions[vi * 3] = x; positions[vi * 3 + 2] = z;
      normals[vi * 3 + 1] = 1;
      uvs[vi * 2] = x / P; uvs[vi * 2 + 1] = z / P;
    }
  }

  const indices = [];
  for (let si = 0; si < sectors; si++) {
    indices.push(0, 1 + ((si + 1) % sectors), 1 + si); // 上から見て反時計回り（法線は+Y）
  }
  for (let ri = 0; ri < rings - 1; ri++) {
    for (let si = 0; si < sectors; si++) {
      const s1 = (si + 1) % sectors;
      const a = 1 + ri * sectors + si, b = 1 + ri * sectors + s1;
      const c = 1 + (ri + 1) * sectors + si, d = 1 + (ri + 1) * sectors + s1;
      indices.push(a, d, c, a, b, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), SEA_OUTER_R);
  return geo;
}

// 浅瀬の色は海底（地形）側が持っているので、ここでは
// 「深い青の半透明の水面＋太陽の映り込み」だけを用意する。
function initSea() {
  const nmap = buildSeaNormalTexture();
  nmap.wrapS = nmap.wrapT = THREE.RepeatWrapping;

  const mat = new THREE.MeshPhongMaterial({
    color: 0x0b2135, specular: 0x8fb4cf, shininess: 140,
    transparent: true, opacity: 0.80, side: THREE.DoubleSide, normalMap: nmap,
  });
  mat.normalScale.set(0.32, 0.32);

  EnvState.sea = new THREE.Mesh(buildSeaGeometry(), mat);
  EnvState.sea.frustumCulled = false; // 常にカメラの真下にあるので判定するだけ無駄
  EnvState.sea.renderOrder = 2;       // 半透明なので地形より後に描く
  EnvState.scene.add(EnvState.sea);
  EnvState.seaNormalMap = nmap;
}

// うねり用のノーマルマップ。サイン波の重ね合わせだけで作ると継ぎ目なくタイルできる。
function buildSeaNormalTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);

  const waves = [
    { fx: 1, fz: 2, a: 1.0, p: 0.0 },
    { fx: 3, fz: -1, a: 0.55, p: 1.1 },
    { fx: -2, fz: 3, a: 0.4, p: 2.3 },
    { fx: 5, fz: 4, a: 0.22, p: 0.7 },
    { fx: -6, fz: 2, a: 0.15, p: 3.1 },
  ];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * Math.PI * 2, v = (j / size) * Math.PI * 2;
      let h = 0;
      for (const w of waves) h += w.a * Math.sin(w.fx * u + w.fz * v + w.p);
      height[j * size + i] = h;
    }
  }

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const il = (i - 1 + size) % size, ir = (i + 1) % size;
      const jl = (j - 1 + size) % size, jr = (j + 1) % size;
      const nx = -(height[j * size + ir] - height[j * size + il]);
      const nz = -(height[jr * size + i] - height[jl * size + i]);
      const ny = 2.6;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const o = (j * size + i) * 4;
      img.data[o] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[o + 1] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[o + 2] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// 海面をカメラへ追従させ、うねりをゆっくり流す（風向・風速に合わせる）。
// メッシュを動かすとうねりの模様も一緒に付いてきてしまうので、
// 動かしたぶんをUVのoffsetで打ち消し、模様はワールドに対して止まって見えるようにする。
function updateSea(dt) {
  if (!EnvState.sea) return;

  const cam = EnvState.camera.position;
  EnvState.sea.position.x = cam.x;
  EnvState.sea.position.z = cam.z;

  const d = THREE.MathUtils.degToRad(EnvState.env.windDirectionDeg);
  const speed = ((EnvState.env.windSpeedKmh / 3.6) / SEA_WAVE_PATTERN_M) * 0.35;
  _seaWaveDrift.x += Math.cos(d) * speed * dt;
  _seaWaveDrift.y += Math.sin(d) * speed * dt;

  EnvState.seaNormalMap.offset.x = cam.x / SEA_WAVE_PATTERN_M + _seaWaveDrift.x;
  EnvState.seaNormalMap.offset.y = cam.z / SEA_WAVE_PATTERN_M + _seaWaveDrift.y;
}

// 夜は海面も暗くする（03-sky.js の updateSkyForSunDirection から呼ばれる）
function updateSeaForDaylight(dayFactor, warmth) {
  if (!EnvState.sea) return;
  const mat = EnvState.sea.material;
  const night = new THREE.Color(0x030913);
  const day = new THREE.Color(0x0b2135).lerp(new THREE.Color(0x123049), warmth * 0.5);
  mat.color.copy(night).lerp(day, dayFactor);
  mat.specular.setHex(0x8fb4cf).multiplyScalar(0.25 + dayFactor * 0.75);
}
