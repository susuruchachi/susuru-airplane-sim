// 03g-vegetation.js — 植生（樹木と、遠くの森）
//
// 森は距離で3段に受け持ちを分ける。どこで切り替わるか分からないよう、
// 3段が同じ濃さ（worldForestDensity）と同じ色を見るようにしてある。
//
//   〜1.2km   1本ずつの木    … このファイル前半（タイルごとの InstancedMesh）
//   〜4.5km   木立の塊       … このファイル後半（まとめて1つの InstancedMesh）
//   それ以遠  地表の色と斑   … 03c-terrain.js の terrainColorAt
//
// 生える場所は座標のハッシュから決まるので、同じ場所へ戻れば同じ森になる。
// 密度は気候から出す（js/env/03b-world.js の気温・乾燥度）。
// 乾燥地には生えず、森林限界より上にも生えず、北へ行くほど限界が下がる。
// 街・空港・水面の上にも生やさない。

// 木を広く薄く撒くと「森」ではなく「点在する棒」に見える。
// 手前だけを森として成立する密度で埋め、その先は木立の塊（このファイル後半）に渡す。
const TREE_TILE_SIZE = 400;
const TREE_ACTIVE_RADIUS_BASE = 1200;   // これより遠い木は描かない
const TREE_ACTIVE_RADIUS_MIN = TREE_TILE_SIZE;
function treeActiveRadius() {
  const scale = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.max(TREE_ACTIVE_RADIUS_BASE * scale, TREE_ACTIVE_RADIUS_MIN);
}
const TREE_SPACING_M = 16;         // 候補を置く間隔。実際に生えるかは密度で決まる
const TREE_RECHECK_DIST = 150;     // カメラがこれだけ動いたらタイルを見直す

// 高いところからは、木を出す半径のふちが地面に円として見えてしまう。
// その高度では1本ずつの木に意味は無く、地表色の森で十分なので、まとめて消す。
const TREE_MAX_EYE_ALTITUDE_M = 2500;

let _treeTiles = new Map();
let _treeLastCheck = null;
let _treeGeometry = null;

// 木1本（および遠くの木立の塊）のジオメトリ。数千個を描くので、面数は極限まで
// 削って円錐の側面だけにする（幹は数百m先では見えない）。
// 上を明るく下を暗くして、単色でも立体感を出す。
// top は頂点の明るさ、radius は底面の半径（高さ1に対する比）。
function buildConeGeometry(sides, top, radius) {
  const positions = [];
  const colors = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    positions.push(0, 1, 0);
    positions.push(Math.cos(a0) * radius, 0, Math.sin(a0) * radius);
    positions.push(Math.cos(a1) * radius, 0, Math.sin(a1) * radius);
    colors.push(top, top, top);
    colors.push(0.72, 0.72, 0.72);
    colors.push(0.72, 0.72, 0.72);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  return geo;
}

function buildTreeGeometry() { return buildConeGeometry(5, 1.40, 0.38); }

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
  initFarForest();
}

// その地点にどれくらい木が生えるか（0〜1）。0なら1本も生えない。
// **式そのものは 03b-world.js の worldForestDensity が持っている**——地表の色
// （03c-terrain.js）と同じものを見ないと、木の出る半径が色の境目として見えてしまう。
function treeDensityAt(x, z, h, slope) {
  if (h < 6) return 0;
  const land = worldLandValueAt(x, z);
  const temp = worldTemperatureAt(x, z, h);
  const dry = worldDrynessAt(x, z, land);
  return worldForestDensity(h, slope, temp, dry, worldUrbanFactorAt(x, z));
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

  const R = treeActiveRadius();
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
  setFarForestVisible(visible);
}

// ============================================================================
// 遠くの森（木立の塊）
//
// 細かい木は手前 treeActiveRadius()（既定1.2km）までしか立てない。その先は
// 地表の色だけなので、**森が「のっぺりした緑の面」になり、手前の木の生えた所と
// 地続きに見えなかった**。そこで、1本の木ではなく**木立の塊**を、低ポリの丸い山と
// して数km先まで撒く。
//
// **なぜ板（ビルボード）ではなく塊なのか。** 飛行機からは森を真上に近い角度で
// 見ることが多く、縦に立てた板は真上から見ると線になって消える。塊なら上から
// 見ても横から見ても形が残る。しかも不透明なので、半透明の板に付きまとう
// 重ね合わせの順番の問題も、塗りつぶしの重さも無い。
//
// **まとめて1つの InstancedMesh にする。** タイルに分けると、数km四方をカバー
// するのに描画呼び出しが200を超えてしまう（画面全体で今183）。塊は1個7三角形と
// 軽いので、ひとかたまりに持って描画呼び出し1回で済ませ、カメラが動いたら
// 「いま見せる範囲のぶんだけ」を先頭へ詰め直して mesh.count で切る。
// ============================================================================

const FOREST_FAR_RADIUS_BASE = 4500;  // 塊を見せる半径（画質プリセットで縮む）
// カメラがアンカーからこれだけ離れるまでは、塊の一覧を作り直さない。
// そのぶん一覧は見せる半径より広く作っておく（先へ進んだとき縁が欠けないように）。
const FOREST_FAR_SLACK = 900;
// 塊の大きさは「木の塊に見えるか」を決める。
//
// 以前は 幅105m × 高さ30m を 90m 間隔に置いていた。幅が間隔より広いので**必ず隣と
// 重なり**、25%地面に埋めてあったのと合わせて、ひと続きのなめらかな面に溶けていた。
// 縦横比も3.5:1と平たいので、上空から見ると森ではなく「小山の連なり」に見える。
// いまは間隔より狭くして隣とのあいだに地面を見せ、縦横比も2.2:1まで立てた。
const FOREST_FAR_CELL = 70;           // 候補を置く間隔
const FOREST_FAR_WIDTH = 58;          // 塊の幅(m)。間隔より狭いので、塊と塊のあいだに地面が見える
const FOREST_FAR_HEIGHT = 26;         // 塊の高さ(m)
// 見せる半径のふちで、塊を小さく潰して地表の色へ溶かす割合。
// ここが無いと、半径いっぱいのところで質感がぷつりと切れて円い境目が見える
// （もともと直したかったのと同じ症状が、遠くへ移動するだけになってしまう）。
const FOREST_FAR_TAPER = 0.26;
const FOREST_FAR_SINK = 0.10;         // 地面へ埋める割合（下の「高さの取り方」参照）
const FOREST_FAR_MAX_EYE_ALTITUDE_M = 9000;  // これより高く上がったら塊も消す
const FOREST_FAR_SCAN_BUDGET = 1200;  // 1フレームに調べる候補の数
const FOREST_FAR_REPACK_DIST = 120;   // カメラがこれだけ動いたら詰め直す

let _farMounds = [];       // 一覧（ワールド座標）。カメラが大きく動いたときだけ作り直す
let _farAnchor = null;     // 一覧を作ったときのカメラ位置
let _farScan = null;       // 走査の途中経過
let _farLastRepack = null;
let _farLastNear = -1;     // 詰め直したときの「手前をどこまで空けたか」
let _farGeometry = null;
const _farColor = new THREE.Color();

function forestFarRadius() {
  const scale = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.max(FOREST_FAR_RADIUS_BASE * scale, treeActiveRadius() + FOREST_FAR_CELL * 4);
}

function initFarForest() {
  // 平たい笠ではなく、少し尖った葉の塊にする（1.30→1.55）
  _farGeometry = buildConeGeometry(7, 1.55, 0.5);
  EnvState.forestFarGroup = new THREE.Group();
  EnvState.forestFarGroup.visible = EnvState.env.treesVisible !== false;
  EnvState.scene.add(EnvState.forestFarGroup);
  _farMounds = [];
  _farAnchor = null;
  _farScan = null;
  _farLastRepack = null;
}

// 塊1つぶんの候補を調べる。生やすなら一覧へ足す。
//
// **高さは worldHeightAt（真の高さ）で取る。** 木が使う terrainSurfaceHeightAt は
// 描かれているメッシュに正確に載るが、内部で高さ関数を4回呼ぶ。塊は候補が1万個
// 近くあるので、そのぶんの差（1回 対 4回）がそのまま走査の重さになる。
// 塊は手前1.2kmより遠くにしか出さないので、両者の差（尾根で数十m）は
// 見た目にほとんど出ない。念のため塊は高さの25%を地面へ埋めてある。
function scanFarForestCell(ix, iz, out) {
  const r1 = worldHash2i(ix + 1013, iz + 9187);
  const r2 = worldHash2i(ix + 7919, iz + 104729);
  const x = (ix + r1) * FOREST_FAR_CELL;
  const z = (iz + r2) * FOREST_FAR_CELL;

  const h = worldHeightAt(x, z);
  if (h < 6) return;

  const e = 40;
  const slope = Math.hypot(
    (worldHeightAt(x + e, z) - h) / e,
    (worldHeightAt(x, z + e) - h) / e
  );

  const land = worldLandValueAt(x, z);
  const temp = worldTemperatureAt(x, z, h);
  const dry = worldDrynessAt(x, z, land);
  const density = worldForestDensity(h, slope, temp, dry, worldUrbanFactorAt(x, z));
  if (density <= 0) return;

  const r3 = worldHash2i(ix + 31337, iz + 6971);
  if (r3 > density) return;

  // 水面と空港の敷地には生やさない（木と同じ扱い）
  const water = worldWaterSurfaceAt(x, z);
  if (water !== null && h <= water + 1.5) return;
  for (const entry of EnvState.builtAirports.values()) {
    const d = entry.def;
    if (Math.hypot(x - d.x, z - d.z) < d.flatInnerR) return;
  }

  const r4 = worldHash2i(ix + 15485863, iz + 32452843);
  const height = FOREST_FAR_HEIGHT * (0.74 + r4 * 0.52);
  const width = FOREST_FAR_WIDTH * (0.78 + r1 * 0.44);

  const color = _farColor;
  treeColorAt(x, z, h, color);
  // **塊は手前の木より暗くする。** 塊は幅の広いなめらかな面なので光をよく受け、
  // 同じ色を与えると手前の細い木より明るく出る。実際、手前の木は濃い緑なのに
  // その先の塊だけ淡い緑になって、木が終わって草地の丘が始まったように見えていた。
  // ばらつきも大きくして、隣どうしが別々の木立に見えるようにする。
  const shade = 0.50 + r4 * 0.32;
  out.push({
    x, y: h - height * FOREST_FAR_SINK, z,
    w: width, h: height, rot: r2 * Math.PI * 2,
    r: color.r * shade, g: color.g * shade, b: color.b * shade,
  });
}

// カメラの周りの塊の一覧を作り直しはじめる（実際の走査は少しずつ進める）
function startFarForestScan(cx, cz) {
  const R = forestFarRadius() + FOREST_FAR_SLACK;
  const i0 = Math.floor((cx - R) / FOREST_FAR_CELL), i1 = Math.floor((cx + R) / FOREST_FAR_CELL);
  const j0 = Math.floor((cz - R) / FOREST_FAR_CELL), j1 = Math.floor((cz + R) / FOREST_FAR_CELL);
  _farScan = { i0, i1, j0, j1, i: i0, j: j0, cx, cz, r2: R * R, out: [] };
  _farAnchor = { x: cx, z: cz };
}

function stepFarForestScan(budget) {
  const s = _farScan;
  if (!s) return;
  let n = 0;
  while (n < budget) {
    if (s.j > s.j1) {   // 走査しきった
      _farMounds = s.out;
      _farScan = null;
      rebuildFarForestMesh();
      return;
    }
    const x = s.i * FOREST_FAR_CELL, z = s.j * FOREST_FAR_CELL;
    const dx = x - s.cx, dz = z - s.cz;
    if (dx * dx + dz * dz <= s.r2) scanFarForestCell(s.i, s.j, s.out);
    n++;
    s.i++;
    if (s.i > s.i1) { s.i = s.i0; s.j++; }
  }
}

// 一覧の長さに合わせて InstancedMesh を作り直す（走査が終わったときだけ）
function rebuildFarForestMesh() {
  const group = EnvState.forestFarGroup;
  if (!group) return;
  if (EnvState.forestFarMesh) {
    group.remove(EnvState.forestFarMesh);
    EnvState.forestFarMesh.dispose();
    EnvState.forestFarMesh = null;
  }
  if (!_farMounds.length) return;

  const mesh = new THREE.InstancedMesh(_farGeometry, EnvState.treeMaterial, _farMounds.length);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(_farMounds.length * 3), 3);
  // 境界球は共有ジオメトリ（塊1個ぶん）で判定されるので、視錐台に任せると
  // まとめて消える。木のタイルで森が帯状にしか出なくなったのと同じ理由。
  mesh.frustumCulled = false;
  mesh.count = 0;
  EnvState.forestFarMesh = mesh;
  group.add(mesh);
  _farLastRepack = null;
  repackFarForest();
}

// いま見せる範囲（手前は本物の木、奥は地表の色に任せる）の塊だけを
// 先頭へ詰め直して、mesh.count でそこまでを描かせる。
const _farM = new THREE.Matrix4();
const _farQ = new THREE.Quaternion();
const _farP = new THREE.Vector3();
const _farS = new THREE.Vector3();
const _farAxis = new THREE.Vector3(0, 1, 0);

// 手前をどこまで空けるか。ふだんは本物の木に任せて treeActiveRadius() まで空けるが、
// **木が消える高さ（対地2,500m超）では0にする**。空けたままにすると、真下に
// 半径1.2kmの木の生えていない円ができて、上空から見ると丸くくり抜かれて見える。
function farForestNearRadius() {
  const treesOn = EnvState.treeGroup && EnvState.treeGroup.visible
    && EnvState.env.treesVisible !== false;
  return treesOn ? treeActiveRadius() : 0;
}

function repackFarForest() {
  const mesh = EnvState.forestFarMesh;
  if (!mesh) return;
  const cam = EnvState.camera.position;
  _farLastRepack = { x: cam.x, z: cam.z };

  const near = farForestNearRadius(), far = forestFarRadius();
  _farLastNear = near;
  const near2 = near * near, far2 = far * far;
  const taperFrom = far * (1 - FOREST_FAR_TAPER);
  const taperSpan = far - taperFrom;
  const colors = mesh.instanceColor.array;
  let n = 0;
  for (const m of _farMounds) {
    const dx = m.x - cam.x, dz = m.z - cam.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < near2 || d2 > far2) continue;
    // ふちに近い塊ほど小さく潰して、地表の色へなだらかに溶かす。
    // 埋める深さは元の高さで決めてあるので、縮んだ塊は地面に沈んで先に消える
    // （そのぶん溶け方が少し早い。狙いどおりなので直していない）。
    let s = 1;
    if (d2 > taperFrom * taperFrom) s = 1 - (Math.sqrt(d2) - taperFrom) / taperSpan;
    _farP.set(m.x, m.y, m.z);
    _farQ.setFromAxisAngle(_farAxis, m.rot);
    _farS.set(m.w * s, m.h * s, m.w * s);
    _farM.compose(_farP, _farQ, _farS);
    mesh.setMatrixAt(n, _farM);
    colors[n * 3] = m.r; colors[n * 3 + 1] = m.g; colors[n * 3 + 2] = m.b;
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}

function setFarForestVisible(visible) {
  if (!EnvState.forestFarGroup) return;
  EnvState.forestFarGroup.visible = visible;
}

// 画質を変えたとき（半径が変わる）に呼ぶ。一覧から作り直す。
function refreshFarForest() {
  if (!EnvState.forestFarGroup) return;
  const cam = EnvState.camera.position;
  startFarForestScan(cam.x, cam.z);
}

function updateFarForest() {
  const group = EnvState.forestFarGroup;
  if (!group || EnvState.env.treesVisible === false) return;
  const cam = EnvState.camera.position;

  // 高く上がりすぎたら、塊も消して地表の色だけにする（木より高いところまで残す）
  const eyeAlt = cam.y - terrainSurfaceHeightAt(cam.x, cam.z);
  const want = eyeAlt < FOREST_FAR_MAX_EYE_ALTITUDE_M;
  if (want !== group.visible) group.visible = want;
  if (!want) return;

  if (_farScan) { stepFarForestScan(FOREST_FAR_SCAN_BUDGET); return; }

  if (!_farAnchor) { startFarForestScan(cam.x, cam.z); return; }
  const ax = cam.x - _farAnchor.x, az = cam.z - _farAnchor.z;
  if (ax * ax + az * az > FOREST_FAR_SLACK * FOREST_FAR_SLACK) {
    startFarForestScan(cam.x, cam.z);
    return;
  }

  if (!_farLastRepack) { repackFarForest(); return; }
  // 木が出たり消えたりしたら、手前を空ける範囲が変わるので詰め直す
  if (farForestNearRadius() !== _farLastNear) { repackFarForest(); return; }
  const rx = cam.x - _farLastRepack.x, rz = cam.z - _farLastRepack.z;
  if (rx * rx + rz * rz > FOREST_FAR_REPACK_DIST * FOREST_FAR_REPACK_DIST) repackFarForest();
}
