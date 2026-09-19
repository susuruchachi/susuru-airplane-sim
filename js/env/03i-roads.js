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

// --- 街灯 -------------------------------------------------------------------
// 夜に道路が消えると、街と街のあいだが真っ暗になって世界が途切れて見える。
// 建物を置くと重いので、街と同じ「加算で重ねる点」で灯りだけ出す。
// 明るさは街明かりに合わせる（道路灯だけ目立つと高速道路の絵にならない）。
const ROAD_LAMP_SPACING_M = 260;   // 街灯の間隔
const ROAD_LAMP_Y = 9;             // 路面からの高さ
const ROAD_LAMP_SIZE = 22;
// 街灯を出す範囲。灯りは小さな点なので、道の帯より手前で切ってよい。
const ROAD_LAMP_RADIUS_BASE = 26000;
// 街の灯りと同じ強さ（03d-places.js は opacity をそのまま 0〜1 で使っている）。
// 1.0 だと点が白く飛んで高速道路というより滑走路の灯火に見えたので、少し落とす。
const ROAD_LAMP_OPACITY = 0.75;

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

  // 街灯。道どうしで共有する（道の出し入れのたびに作り直さない）。
  // 街の灯り（03d-places.js）と同じ加算合成で、昼は opacity 0 にして消す。
  if (!_roadLampTexture) _roadLampTexture = buildRoadLampTexture();
  EnvState.roadLampMaterial = new THREE.PointsMaterial({
    size: ROAD_LAMP_SIZE, map: _roadLampTexture, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true,
    color: 0xffd9a0,
  });

  refreshRoads();
}

// 街灯の点の絵（中心が明るく外へ向かって消える円）。街の灯りと同じ作り。
let _roadLampTexture = null;
function buildRoadLampTexture() {
  const size = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,225,180,0.55)');
  grad.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function roadLampRadius() {
  const scale = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.max(ROAD_LAMP_RADIUS_BASE * scale, 9000);
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
  const e = EnvState.builtRoads.get(id);
  if (!e) return;
  EnvState.roadGroup.remove(e.strip);
  e.strip.geometry.dispose();
  if (e.lamps) {
    EnvState.roadGroup.remove(e.lamps);
    e.lamps.geometry.dispose();   // マテリアルは道で共有しているので dispose しない
  }
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

  const lamps = buildRoadLamps(road, pts, ox, oy, oz);
  if (lamps) EnvState.roadGroup.add(lamps);

  EnvState.builtRoads.set(road.id, { strip: mesh, lamps });
}

// 道に沿って街灯を置く。左右に振らず中央に1列（遠目には中央分離帯の灯りに見える）。
// 近い道にだけ出す——灯りは小さな点なので、遠くでは点が潰れて線にならず、
// 頂点だけ増えて何も見えない。
function buildRoadLamps(road, pts, ox, oy, oz) {
  const cam = EnvState.camera.position;
  const R = roadLampRadius();
  const positions = [];
  let acc = ROAD_LAMP_SPACING_M; // 始点にも1つ置く
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    acc += d;
    if (acc < ROAD_LAMP_SPACING_M) continue;
    acc = 0;
    if (Math.hypot(b.x - cam.x, b.z - cam.z) > R) continue;
    const y = terrainSurfaceHeightAt(b.x, b.z) + ROAD_LAMP_Y;
    positions.push(b.x - ox, y - oy, b.z - oz);
  }
  if (!positions.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.computeBoundingSphere();
  const pts2 = new THREE.Points(geo, EnvState.roadLampMaterial);
  pts2.position.set(ox, oy, oz);
  pts2.matrixAutoUpdate = false;
  pts2.updateMatrix();
  return pts2;
}

// 夜になったら道の街灯を点ける。明るさは街の灯りに合わせる
// （03d-places.js の updatePlacesForDaylight と同じ dayFactor を受け取る）。
function updateRoadsForDaylight(dayFactor) {
  if (!EnvState.roadLampMaterial) return;
  const v = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
  EnvState.roadLampMaterial.opacity = v * ROAD_LAMP_OPACITY;
  if (EnvState.roadGroup) {
    for (const e of EnvState.builtRoads.values()) {
      if (e.lamps) e.lamps.visible = v > 0.01;
    }
  }
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
