// 03i-roads.js — 街と街・街と空港を結ぶ道路
//
// 経路は js/env/03b-world.js が持っている（WORLD_ROADS）。傾斜と水にコストを付けた
// A* で、山と川をよけて引いてある。ここはそれを見て地形の上に帯を敷くだけ。
//
// **地形は刻まない。** 道路の幅は26mで、いちばん細かいLODでも地形の頂点間隔は312m。
// 刻んでも再現できないので、滑走路の路面標識と同じく、地形メッシュの上に
// デカールとして重ねる。高さは terrainSurfaceHeightAtLod で「実際に描かれている
// メッシュの高さ」から取る——worldHeightAt の値を使うと、地形が格子点の間を
// 三角形で結んでいるぶんだけ道が浮いたり地面に潜ったりする。

// 道は100km以上に伸びるので、川と同じく経路の点との最短距離で出し入れを決める。
// 幅26mは10kmで2.3px、30kmで0.8pxなので、それより遠くは出しても見えない。
const ROAD_ACTIVE_RADIUS_BASE = 55000;
const ROAD_ACTIVE_RADIUS_MIN = 18000;
// 地形メッシュの折れ面より少しだけ上に浮かせる。深度バイアスだけだと、
// 遠方の粗いLODで地形が道を突き抜けて、道がまだらに途切れる。
const ROAD_LIFT_M = 1.2;
// 経路の点をそのまま頂点にすると、遠くの道まで細かい帯になって頂点が増える。
// 距離に応じて間引く。
const ROAD_STEP_NEAR_M = 400;
const ROAD_STEP_FAR_M = 2000;

function roadActiveRadius() {
  // 03h-env-quality.js はこのファイルより後に読まれるので、呼ばれる時点では
  // 必ずあるが、念のため（他の実体化半径と同じ書き方）
  const scale = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.max(ROAD_ACTIVE_RADIUS_BASE * scale, ROAD_ACTIVE_RADIUS_MIN);
}

function initRoads() {
  EnvState.roadGroup = new THREE.Group();
  EnvState.scene.add(EnvState.roadGroup);
  EnvState.builtRoads = new Map();

  // 舗装の色。地表より暗く、けれど影に沈まない程度に。
  EnvState.roadMaterial = new THREE.MeshLambertMaterial({
    color: 0x2b2926, vertexColors: false,
  });
  EnvState.roadMaterial.polygonOffset = true;
  EnvState.roadMaterial.polygonOffsetFactor = -6;
  EnvState.roadMaterial.polygonOffsetUnits = -6;

  refreshRoads();
}

function refreshRoads() {
  if (!EnvState.builtRoads) return;
  const cam = EnvState.camera.position;
  const R = roadActiveRadius();

  for (const road of WORLD_ROADS) {
    const near = roadNearCamera(road, cam, R);
    const built = EnvState.builtRoads.has(road.id);
    if (near && !built) buildRoadInstance(road);
    else if (!near && built) disposeRoadInstance(road.id);
  }
}

function roadNearCamera(road, cam, R) {
  const r2 = (R + 8000) * (R + 8000);
  for (let i = 0; i < road.points.length; i += 2) {
    const p = road.points[i];
    const dx = p.x - cam.x, dz = p.z - cam.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

function disposeRoadInstance(id) {
  const mesh = EnvState.builtRoads.get(id);
  if (!mesh) return;
  EnvState.roadGroup.remove(mesh);
  mesh.geometry.dispose();
  EnvState.builtRoads.delete(id);
}

// 経路に沿って左右へ幅を振り、帯状のメッシュにする（川の水面と同じ作り）
function buildRoadInstance(road) {
  const cam = EnvState.camera.position;
  const src = road.points;

  // カメラからの距離で間引く。近い所は細かく、遠い所は粗く。
  const pts = [src[0]];
  let acc = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    acc += Math.hypot(b.x - a.x, b.z - a.z);
    const d = Math.hypot(b.x - cam.x, b.z - cam.z);
    const want = d < 12000 ? ROAD_STEP_NEAR_M
      : ROAD_STEP_NEAR_M + (ROAD_STEP_FAR_M - ROAD_STEP_NEAR_M)
        * Math.min(1, (d - 12000) / 30000);
    if (acc >= want || i === src.length - 1) { pts.push(b); acc = 0; }
  }
  const n = pts.length;
  if (n < 2) return;

  const ox = pts[0].x, oz = pts[0].z;
  const oy = terrainSurfaceHeightAt(ox, oz);
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);

  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    const px = -tz, pz = tx;              // 水平面内で接線に直交する向き
    const w = road.halfWidth;

    // その場所で実際に描かれているLODに合わせて高さを取る
    const seg = terrainSegmentsForDistance(Math.hypot(p.x - cam.x, p.z - cam.z));
    const y = terrainSurfaceHeightAtLod(p.x, p.z, seg) + ROAD_LIFT_M;

    const li = i * 6, ri = i * 6 + 3;
    positions[li] = p.x - ox + px * w; positions[li + 1] = y - oy; positions[li + 2] = p.z - oz + pz * w;
    positions[ri] = p.x - ox - px * w; positions[ri + 1] = y - oy; positions[ri + 2] = p.z - oz - pz * w;
    normals[li + 1] = 1; normals[ri + 1] = 1;
  }

  const indices = new Uint32Array((n - 1) * 6);
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices[k++] = a; indices[k++] = c; indices[k++] = b;
    indices[k++] = b; indices[k++] = c; indices[k++] = d;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();

  // 不透明なので renderOrder は要らない（半透明の並び順とは別のリストで描かれる）。
  // 地形との重なりは、上の深度バイアスと ROAD_LIFT_M で処理する。
  const mesh = new THREE.Mesh(geo, EnvState.roadMaterial);
  mesh.position.set(ox, oy, oz);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  EnvState.roadGroup.add(mesh);
  EnvState.builtRoads.set(road.id, mesh);
}

// カメラが動いたら、出し入れと間引きをやり直す。
// 間引きがカメラ距離で決まるので、川や地形と違って「近づいたら作り直す」も要る。
const ROAD_REBUILD_DIST_M = 6000;
let _roadLastCam = null;

function updateRoads() {
  if (!EnvState.builtRoads) return;
  const cam = EnvState.camera.position;
  if (_roadLastCam) {
    const d = Math.hypot(cam.x - _roadLastCam.x, cam.z - _roadLastCam.z);
    if (d < ROAD_REBUILD_DIST_M) return;
  }
  _roadLastCam = { x: cam.x, z: cam.z };

  // 間引きの細かさが変わるので、出ているぶんは作り直す
  for (const id of Array.from(EnvState.builtRoads.keys())) disposeRoadInstance(id);
  refreshRoads();
}

function setRoadsVisible(visible) {
  if (EnvState.roadGroup) EnvState.roadGroup.visible = visible;
}
