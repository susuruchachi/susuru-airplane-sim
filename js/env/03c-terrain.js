// 03c-terrain.js — 地形メッシュ（LOD付きタイル）と海
//
// 高さはすべて js/env/03b-world.js の worldHeightAt() から取る。
// 600km四方を一枚のメッシュにすると頂点が多すぎるので、30km角のタイルに分割し、
// カメラからの距離でタイルごとの解像度（LOD）を切り替える。
//
// 海は「y=0に置いた半透明の一枚板」。浅瀬の水色は海面ではなく
// 海底（地形メッシュ）の色で表現している。こうすると砂浜〜浅瀬〜深海の
// 移り変わりが地形の解像度そのままで出るので、海面側にシェーダーを書かずに済む。

const TERRAIN_TILE_COUNT = 20;                          // 20 x 20 タイル
const TERRAIN_TILE_SIZE = WORLD_SIZE / TERRAIN_TILE_COUNT; // 30km角

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

// LOD切り替えでカクつかないよう、1フレームに作り直すタイル数を制限する
const TERRAIN_REBUILD_BUDGET = 3;

// カメラがこれだけ動いたらLODを見直す（毎フレーム全タイル分の距離計算をしないため）
const TERRAIN_LOD_RECHECK_DIST = 3000;

// 生物相（標高と傾斜で決まる地表の色）。
// outputEncoding=sRGB で中間色が持ち上がるぶんを見越して、見た目より一段暗く指定する。
const TERRAIN_BIOME_STOPS = [
  { h: -2600, c: 0x040a16 }, // 深海底
  { h: -420, c: 0x08243a }, // 大陸棚
  { h: -70, c: 0x125a68 }, // 浅瀬（半透明の海面越しに水色に見える）
  { h: -8, c: 0x5c6a4e }, // 汀線
  { h: 9, c: 0x6b6247 }, // 砂浜
  { h: 45, c: 0x2c5220 }, // 草原
  { h: 650, c: 0x1b3a16 }, // 森
  { h: 1550, c: 0x443722 }, // 低木・土
  { h: 2150, c: 0x48443d }, // 岩
  { h: 2700, c: 0x63686e }, // 岩と雪の混在
  { h: 3150, c: 0x8f97a0 }, // 万年雪
];
const TERRAIN_ROCK_COLOR = 0x33312e; // 急斜面は標高によらず岩肌にする
const TERRAIN_URBAN_COLOR = 0x4a4640; // 市街地。上空から見て街だと分かるようにする

let _terrainTiles = [];
let _terrainRebuildQueue = [];
let _terrainLastLodCheck = null;

function terrainHexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

const _TERRAIN_STOP_RGB = TERRAIN_BIOME_STOPS.map((s) => terrainHexToRgb(s.c));
const _TERRAIN_ROCK_RGB = terrainHexToRgb(TERRAIN_ROCK_COLOR);
const _TERRAIN_URBAN_RGB = terrainHexToRgb(TERRAIN_URBAN_COLOR);

// 標高・傾斜・ゆらぎから地表色を決めて out[0..2] に書き込む
function terrainColorAt(h, slope, jitter, urban, out) {
  const stops = TERRAIN_BIOME_STOPS;
  let i = 0;
  while (i < stops.length - 2 && h > stops[i + 1].h) i++;

  const a = stops[i], b = stops[i + 1];
  const t = Math.min(Math.max((h - a.h) / (b.h - a.h), 0), 1);
  const ca = _TERRAIN_STOP_RGB[i], cb = _TERRAIN_STOP_RGB[i + 1];
  let r = ca[0] + (cb[0] - ca[0]) * t;
  let g = ca[1] + (cb[1] - ca[1]) * t;
  let bl = ca[2] + (cb[2] - ca[2]) * t;

  // 陸の急斜面は草木が付かないので岩肌へ寄せる（雪も付きにくい）
  if (h > 0 && slope > 0.32) {
    const k = Math.min((slope - 0.32) / 0.34, 1) * 0.85;
    r += (_TERRAIN_ROCK_RGB[0] - r) * k;
    g += (_TERRAIN_ROCK_RGB[1] - g) * k;
    bl += (_TERRAIN_ROCK_RGB[2] - bl) * k;
  }

  // 市街地は建物と道路で灰色寄りになる（建物メッシュだけだと上空から街に見えないため）
  if (urban > 0 && h > 0) {
    const k = urban * 0.72;
    r += (_TERRAIN_URBAN_RGB[0] - r) * k;
    g += (_TERRAIN_URBAN_RGB[1] - g) * k;
    bl += (_TERRAIN_URBAN_RGB[2] - bl) * k;
  }

  // 一様な色面にならないよう、わずかに明暗をばらつかせる
  const m = 0.86 + jitter * 0.28;
  out[0] = r * m; out[1] = g * m; out[2] = bl * m;
}

// --- タイルのジオメトリ生成 -------------------------------------------------

// タイル1枚ぶんのジオメトリを作る。
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
      const x = originX + i * step;
      const z = originZ + j * step;

      // 中央差分から法線を出す（外側リングがあるので端でも片側差分にならない）
      const dhx = (heights[gi + 1] - heights[gi - 1]) * inv2step;
      const dhz = (heights[gi + gw] - heights[gi - gw]) * inv2step;
      const len = Math.sqrt(dhx * dhx + 1 + dhz * dhz);
      const nx = -dhx / len, ny = 1 / len, nz = -dhz / len;

      const vi = (j * vw + i) * 3;
      positions[vi] = x; positions[vi + 1] = h; positions[vi + 2] = z;
      normals[vi] = nx; normals[vi + 1] = ny; normals[vi + 2] = nz;

      terrainColorAt(h, 1 - ny, worldValueNoise(x * 0.00042, z * 0.00042), worldUrbanFactorAt(x, z), rgb);
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

// --- 初期化・更新 -----------------------------------------------------------

function initTerrain() {
  EnvState.terrainGroup = new THREE.Group();
  EnvState.scene.add(EnvState.terrainGroup);

  EnvState.terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

  _terrainTiles = [];
  for (let j = 0; j < TERRAIN_TILE_COUNT; j++) {
    for (let i = 0; i < TERRAIN_TILE_COUNT; i++) {
      const originX = -WORLD_HALF + i * TERRAIN_TILE_SIZE;
      const originZ = -WORLD_HALF + j * TERRAIN_TILE_SIZE;
      _terrainTiles.push({
        originX, originZ,
        centerX: originX + TERRAIN_TILE_SIZE / 2,
        centerZ: originZ + TERRAIN_TILE_SIZE / 2,
        lod: -1,
        mesh: null,
      });
    }
  }

  // 起動時は全タイルを一気に作る。遠いタイルは分割数が小さいので実測で数百ms以内。
  updateTerrainLod(true);
  initSea();
}

function terrainSegmentsForDistance(d) {
  for (let i = 0; i < TERRAIN_LOD_STEPS.length; i++) {
    if (d < TERRAIN_LOD_STEPS[i].maxDistM) return TERRAIN_LOD_STEPS[i].segments;
  }
  return TERRAIN_LOD_STEPS[TERRAIN_LOD_STEPS.length - 1].segments;
}

function buildTerrainTile(tile) {
  if (tile.mesh) {
    EnvState.terrainGroup.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh = null;
  }
  const geo = buildTerrainTileGeometry(tile.originX, tile.originZ, TERRAIN_TILE_SIZE, tile.pendingLod);
  tile.mesh = new THREE.Mesh(geo, EnvState.terrainMaterial);
  tile.mesh.matrixAutoUpdate = false;
  tile.mesh.updateMatrix();
  tile.lod = tile.pendingLod;
  EnvState.terrainGroup.add(tile.mesh);
}

// カメラ位置から各タイルの目標LODを決め、変わったものを作り直しキューに積む
function updateTerrainLod(immediate) {
  const cam = EnvState.camera.position;
  _terrainLastLodCheck = { x: cam.x, z: cam.z };

  const dirty = [];
  for (const tile of _terrainTiles) {
    const dx = cam.x - tile.centerX, dz = cam.z - tile.centerZ;
    const d = Math.max(Math.sqrt(dx * dx + dz * dz) - TERRAIN_TILE_SIZE * 0.71, 0);
    const seg = terrainSegmentsForDistance(d);
    if (seg !== tile.lod) {
      tile.pendingLod = seg;
      tile.sortDist = d;
      dirty.push(tile);
    }
  }

  // 近いタイルから作り直す（見えている場所ほど早く差し替わってほしい）
  dirty.sort((a, b) => a.sortDist - b.sortDist);

  if (immediate) {
    for (const tile of dirty) buildTerrainTile(tile);
    _terrainRebuildQueue = [];
  } else {
    _terrainRebuildQueue = dirty;
  }
}

// 毎フレーム呼ぶ。カメラが十分動いたらLODを見直し、キューを少しずつ消化する。
function updateTerrain() {
  const cam = EnvState.camera.position;
  if (_terrainRebuildQueue.length === 0 && _terrainLastLodCheck) {
    const dx = cam.x - _terrainLastLodCheck.x, dz = cam.z - _terrainLastLodCheck.z;
    if (dx * dx + dz * dz > TERRAIN_LOD_RECHECK_DIST * TERRAIN_LOD_RECHECK_DIST) {
      updateTerrainLod(false);
    }
  }

  let budget = TERRAIN_REBUILD_BUDGET;
  while (budget > 0 && _terrainRebuildQueue.length > 0) {
    buildTerrainTile(_terrainRebuildQueue.shift());
    budget--;
  }
}

// --- 海 ---------------------------------------------------------------------

// 海面のメッシュ。
//
// r128 は WebGL2 だと対数深度を「頂点で計算して画面上で線形補間する」経路に落ちる。
// log は上に凸なので、1枚のポリゴンが手前から奥まで大きく伸びていると、
// 補間された深度が本来より手前に寄り、海面が陸地や滑走路を覆い隠してしまう。
// そこで海面は「カメラを中心とした同心円メッシュ」にして、
// 近いところほど細かく分割する（1つの四角形の中で距離が16%しか変わらないようにする）。
const SEA_RING_COUNT = 64;
const SEA_SECTOR_COUNT = 96;
const SEA_INNER_R = 30;
const SEA_OUTER_R = 350000;      // カメラのfar(260km)を全方位で覆える大きさ
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

  positions[0] = 0; positions[1] = 0; positions[2] = 0;
  normals[1] = 1;
  uvs[0] = 0; uvs[1] = 0;

  const growth = Math.pow(SEA_OUTER_R / SEA_INNER_R, 1 / (rings - 1));
  for (let ri = 0; ri < rings; ri++) {
    const r = SEA_INNER_R * Math.pow(growth, ri);
    for (let si = 0; si < sectors; si++) {
      const a = (si / sectors) * Math.PI * 2;
      const vi = 1 + ri * sectors + si;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      positions[vi * 3] = x; positions[vi * 3 + 1] = 0; positions[vi * 3 + 2] = z;
      normals[vi * 3 + 1] = 1;
      uvs[vi * 2] = x / P; uvs[vi * 2 + 1] = z / P;
    }
  }

  const indices = [];
  for (let si = 0; si < sectors; si++) {
    const a = 1 + si, b = 1 + ((si + 1) % sectors);
    indices.push(0, b, a); // 上から見て反時計回り（法線は+Y）
  }
  for (let ri = 0; ri < rings - 1; ri++) {
    for (let si = 0; si < sectors; si++) {
      const s0 = si, s1 = (si + 1) % sectors;
      const a = 1 + ri * sectors + s0, b = 1 + ri * sectors + s1;
      const c = 1 + (ri + 1) * sectors + s0, d = 1 + (ri + 1) * sectors + s1;
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
    color: 0x0b2135,
    specular: 0x8fb4cf,
    shininess: 140,
    transparent: true,
    opacity: 0.80,
    side: THREE.DoubleSide,
    normalMap: nmap,
  });
  mat.normalScale.set(0.32, 0.32);

  EnvState.sea = new THREE.Mesh(buildSeaGeometry(), mat);
  EnvState.sea.frustumCulled = false; // 常にカメラの真下にあるので判定するだけ無駄
  EnvState.sea.renderOrder = 2;       // 半透明なので地形より後に描く
  EnvState.scene.add(EnvState.sea);
  EnvState.seaNormalMap = nmap;
}

// うねり用のノーマルマップ。円形の膨らみをランダムに重ねて、継ぎ目なくタイルさせる。
function buildSeaNormalTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);

  const height = new Float32Array(size * size);
  // 端でつながるよう、サイン波の重ね合わせだけで作る（整数周期にすればタイルが合う）
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
      const dx = height[j * size + ir] - height[j * size + il];
      const dz = height[jr * size + i] - height[jl * size + i];
      const nx = -dx, nz = -dz, ny = 2.6;
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
