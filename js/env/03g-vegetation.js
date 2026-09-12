// 03g-vegetation.js — 植生（樹木）
//
// 木は「カメラの近くだけ」に生やす。800m角のタイルに分け、
// タイル1枚を1つの InstancedMesh にして、カメラが動いたら端のタイルを差し替える。
// 生える場所は座標のハッシュから決まるので、同じ場所へ戻れば同じ森になる。
//
// 密度は気候から出す（js/env/03b-world.js の気温・乾燥度）。
// 乾燥地には生えず、森林限界より上にも生えず、北へ行くほど限界が下がる。
// 街・空港・水面の上にも生やさない。

// 木を広く薄く撒くと「森」ではなく「点在する棒」に見える。
// 手前だけを森として成立する密度で埋め、遠景は地表色の森（03c-terrain.js）に任せる。
const TREE_TILE_SIZE = 400;
const TREE_ACTIVE_RADIUS = 1200;   // これより遠い木は描かない
const TREE_SPACING_M = 16;         // 候補を置く間隔。実際に生えるかは密度で決まる
const TREE_RECHECK_DIST = 150;     // カメラがこれだけ動いたらタイルを見直す

// 高いところからは、木を出す半径のふちが地面に円として見えてしまう。
// その高度では1本ずつの木に意味は無く、地表色の森で十分なので、まとめて消す。
const TREE_MAX_EYE_ALTITUDE_M = 2500;

let _treeTiles = new Map();
let _treeLastCheck = null;
let _treeGeometry = null;

// 木1本のジオメトリ。数千本を描くので、面数は極限まで削って円錐の側面だけにする
// （幹は数百m先では見えない）。上を明るく下を暗くして、単色でも立体感を出す。
function buildTreeGeometry() {
  const sides = 5;
  const positions = [];
  const colors = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    positions.push(0, 1, 0);
    positions.push(Math.cos(a0) * 0.38, 0, Math.sin(a0) * 0.38);
    positions.push(Math.cos(a1) * 0.38, 0, Math.sin(a1) * 0.38);
    colors.push(1.40, 1.40, 1.40);
    colors.push(0.72, 0.72, 0.72);
    colors.push(0.72, 0.72, 0.72);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  return geo;
}

function initVegetation() {
  EnvState.treeGroup = new THREE.Group();
  EnvState.scene.add(EnvState.treeGroup);
  _treeTiles = new Map();
  _treeGeometry = buildTreeGeometry();

  EnvState.treeMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide,
  });

  EnvState.treeGroup.visible = EnvState.env.treesVisible !== false;
  refreshVegetation(true);
}

// その地点にどれくらい木が生えるか（0〜1）。0なら1本も生えない。
function treeDensityAt(x, z, h, slope) {
  if (h < 6) return 0;

  const land = worldLandValueAt(x, z);
  const temp = worldTemperatureAt(x, z, h);
  const dry = worldDrynessAt(x, z, land);

  // 森林限界。気温から決まるので、北ほど低い標高で森が終わる（地表色と同じ基準）
  const treeLine = (700 + temp * 3400) * 0.62;
  if (h > treeLine) return 0;

  // 乾燥地には森ができない
  let d = 1 - worldSmooth01((dry - 0.30) / 0.28);
  // 寒すぎると育たない
  d *= worldSmooth01((temp - 0.06) / 0.14);
  // 低地の草原より、中腹の森林帯がいちばん濃い
  d *= 0.50 + 0.50 * worldSmooth01((h - treeLine * 0.18) / (treeLine * 0.35));
  // 森林限界の手前で疎らになる
  d *= 1 - worldSmooth01((h - treeLine * 0.78) / (treeLine * 0.22));
  // 急斜面には生えにくい
  d *= 1 - worldSmooth01((slope - 0.38) / 0.28);
  // 市街地は伐られている
  d *= 1 - worldUrbanFactorAt(x, z);

  return worldClamp(d, 0, 1);
}

// 気候から葉の色を決める（針葉樹の暗い緑〜熱帯の濃い緑〜乾燥地のオリーブ）
const _TREE_COLD = new THREE.Color(0x24402c);
const _TREE_TEMPERATE = new THREE.Color(0x2c5220);
const _TREE_TROPICAL = new THREE.Color(0x1d4a16);
const _TREE_DRY = new THREE.Color(0x4a4a26);

function treeColorAt(x, z, h, out) {
  const land = worldLandValueAt(x, z);
  const temp = worldTemperatureAt(x, z, h);
  const dry = worldDrynessAt(x, z, land);
  out.copy(_TREE_COLD);
  out.lerp(_TREE_TEMPERATE, worldSmooth01((temp - 0.18) / 0.28));
  out.lerp(_TREE_TROPICAL, worldSmooth01((temp - 0.6) / 0.3));
  out.lerp(_TREE_DRY, worldSmooth01((dry - 0.22) / 0.26));
  return out;
}

function treeTileKey(ix, iz) { return ix + ',' + iz; }

// タイル1枚ぶんの木を作る。位置・大きさ・傾きはすべて座標のハッシュから決まるので、
// 同じ場所へ戻ってきたときに木が生え変わったりしない。
function buildTreeTile(ix, iz) {
  const originX = ix * TREE_TILE_SIZE, originZ = iz * TREE_TILE_SIZE;
  const per = Math.max(1, Math.round(TREE_TILE_SIZE / TREE_SPACING_M));

  const mats = [];
  const cols = [];
  const color = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  for (let j = 0; j < per; j++) {
    for (let i = 0; i < per; i++) {
      // 格子に並ばないよう、セルの中でずらす
      const r1 = worldHash2i(ix * 4096 + i, iz * 4096 + j);
      const r2 = worldHash2i(ix * 4096 + i + 7919, iz * 4096 + j + 104729);
      const x = originX + (i + r1) * (TREE_TILE_SIZE / per);
      const z = originZ + (j + r2) * (TREE_TILE_SIZE / per);

      // 地形メッシュの上の高さを使う（worldHeightAt の値だと木が浮く／埋まる）
      const h = terrainSurfaceHeightAt(x, z);
      if (h < 6) continue;

      // 水面の上には生やさない
      const water = worldWaterSurfaceAt(x, z);
      if (water !== null && h <= water + 1.5) continue;

      // 空港の敷地にも生やさない
      let onAirfield = false;
      for (const entry of EnvState.builtAirports.values()) {
        const d = entry.def;
        if (Math.hypot(x - d.x, z - d.z) < d.flatInnerR) { onAirfield = true; break; }
      }
      if (onAirfield) continue;

      // 傾斜。候補1本ごとに何度も高さ関数を呼ぶと重いので、前進差分の2回で済ませる
      const e = 26;
      const slope = Math.hypot(
        (terrainSurfaceHeightAt(x + e, z) - h) / e,
        (terrainSurfaceHeightAt(x, z + e) - h) / e
      );

      const density = treeDensityAt(x, z, h, slope);
      const r3 = worldHash2i(ix * 4096 + i + 31337, iz * 4096 + j + 6971);
      if (r3 > density) continue;

      const r4 = worldHash2i(ix * 4096 + i + 15485863, iz * 4096 + j + 32452843);
      const height = 8 + r4 * 13;
      const width = height * (0.34 + r1 * 0.26);

      pos.set(x - originX, h - 0.5, z - originZ);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r2 * Math.PI * 2);
      scl.set(width, height, width);
      m.compose(pos, q, scl);
      mats.push(m.clone());

      treeColorAt(x, z, h, color);
      // 1本ずつわずかに明暗を変えて、森が一枚の板に見えないようにする
      const shade = 0.82 + r4 * 0.36;
      cols.push(color.r * shade, color.g * shade, color.b * shade);
    }
  }

  if (mats.length === 0) {
    _treeTiles.set(treeTileKey(ix, iz), { ix, iz, mesh: null });
    return;
  }

  const mesh = new THREE.InstancedMesh(_treeGeometry, EnvState.treeMaterial, mats.length);
  for (let k = 0; k < mats.length; k++) mesh.setMatrixAt(k, mats[k]);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cols), 3);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.position.set(originX, 0, originZ);
  // InstancedMesh の視錐台カリングは「共有しているジオメトリの境界球」で判定される。
  // ここでは木1本ぶん（半径1m）の球なので、タイルの隅がたまたま画面に入っていない限り
  // タイルまるごと消えてしまう（実際に、森が帯状にしか出ない不具合になった）。
  // 木は手前2.4km以内にしか作らないので、判定せず常に描くほうが正しい。
  mesh.frustumCulled = false;
  EnvState.treeGroup.add(mesh);
  _treeTiles.set(treeTileKey(ix, iz), { ix, iz, mesh });
}

function disposeTreeTile(tile) {
  if (tile.mesh) {
    EnvState.treeGroup.remove(tile.mesh);
    tile.mesh.dispose();
  }
}

// カメラの周りにあるべき木のタイルを揃える。
// 1フレームに作るのは数枚までにして、飛んでいる間にカクつかないようにする。
const TREE_BUILD_BUDGET = 2;
let _treeWork = [];

function refreshVegetation(immediate) {
  if (!EnvState.treeGroup || !EnvState.treeGroup.visible) return;
  const cam = EnvState.camera.position;
  _treeLastCheck = { x: cam.x, z: cam.z };

  const R = TREE_ACTIVE_RADIUS;
  const i0 = Math.floor((cam.x - R) / TREE_TILE_SIZE), i1 = Math.floor((cam.x + R) / TREE_TILE_SIZE);
  const j0 = Math.floor((cam.z - R) / TREE_TILE_SIZE), j1 = Math.floor((cam.z + R) / TREE_TILE_SIZE);

  const keep = new Set();
  const work = [];
  for (let ix = i0; ix <= i1; ix++) {
    for (let iz = j0; iz <= j1; iz++) {
      const cx = ix * TREE_TILE_SIZE + TREE_TILE_SIZE / 2;
      const cz = iz * TREE_TILE_SIZE + TREE_TILE_SIZE / 2;
      const d = Math.hypot(cam.x - cx, cam.z - cz);
      if (d - TREE_TILE_SIZE * 0.71 > R) continue;
      const key = treeTileKey(ix, iz);
      keep.add(key);
      if (!_treeTiles.has(key)) work.push({ ix, iz, d });
    }
  }

  for (const [key, tile] of _treeTiles) {
    if (!keep.has(key)) { disposeTreeTile(tile); _treeTiles.delete(key); }
  }

  work.sort((a, b) => a.d - b.d);
  if (immediate) {
    for (const w of work) buildTreeTile(w.ix, w.iz);
    _treeWork = [];
  } else {
    _treeWork = work;
  }
}

function updateVegetation() {
  if (!EnvState.treeGroup || EnvState.env.treesVisible === false) return;
  const cam = EnvState.camera.position;

  // 対地高度が高すぎるときは木を出さない
  const eyeAlt = cam.y - terrainSurfaceHeightAt(cam.x, cam.z);
  const wantTrees = eyeAlt < TREE_MAX_EYE_ALTITUDE_M;
  if (wantTrees !== EnvState.treeGroup.visible) {
    EnvState.treeGroup.visible = wantTrees;
    if (!wantTrees) {
      for (const tile of _treeTiles.values()) disposeTreeTile(tile);
      _treeTiles.clear();
      _treeWork = [];
      return;
    }
    refreshVegetation(false);
  }
  if (!wantTrees) return;

  if (_treeWork.length === 0 && _treeLastCheck) {
    const dx = cam.x - _treeLastCheck.x, dz = cam.z - _treeLastCheck.z;
    if (dx * dx + dz * dz > TREE_RECHECK_DIST * TREE_RECHECK_DIST) refreshVegetation(false);
  }
  let budget = TREE_BUILD_BUDGET;
  while (budget > 0 && _treeWork.length > 0) {
    const w = _treeWork.shift();
    if (!_treeTiles.has(treeTileKey(w.ix, w.iz))) buildTreeTile(w.ix, w.iz);
    budget--;
  }
}

function setTreesVisible(visible) {
  EnvState.env.treesVisible = visible;
  if (!EnvState.treeGroup) return;
  EnvState.treeGroup.visible = visible;
  // 実際に出るかどうかは updateVegetation() が対地高度で決める
  if (visible) refreshVegetation(false);
  else {
    for (const tile of _treeTiles.values()) disposeTreeTile(tile);
    _treeTiles.clear();
    _treeWork = [];
  }
}
