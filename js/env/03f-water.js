// 03f-water.js — 川と湖の水面
//
// 形は js/env/03b-world.js が持っている（WORLD_RIVERS / WORLD_LAKES）。
// ここはそれを見て水面のメッシュを張るだけ。地形側はすでに
// worldCarveRivers / worldCarveLakes で谷と窪地に刻まれている。
//
// 地形・都市・空港と同じく、カメラの周りだけ作っては捨てる。
// 頂点はその川・湖の原点からのローカル座標で持つ（遠方でのfloat32対策）。

const WATER_ACTIVE_RADIUS = 130000;

// 川の断面の値は世界側（03b-world.js）が持っている。
// 岸＝谷の斜面が水面の高さに達するところ。ここを合わせないと、
// 水面が地面に埋まったり、地面が水面から顔を出したりする。
const RIVER_BANK_MARGIN_M = RIVER_WATER_DEPTH_M / RIVER_VALLEY_SLOPE;

const LAKE_SHORE_RAYS = 72;

function initWater() {
  EnvState.waterGroup = new THREE.Group();
  EnvState.scene.add(EnvState.waterGroup);
  EnvState.builtWater = new Map();

  // 川と湖で共有する水面のマテリアル。海より浅い色で、映り込みも控えめにする。
  EnvState.waterMaterial = new THREE.MeshPhongMaterial({
    color: 0x14303f, specular: 0x6f93ad, shininess: 90,
    transparent: true, opacity: 0.82, side: THREE.DoubleSide,
  });
  // 水面は地形とほとんど同じ高さに乗る薄い面なので、滑走路の路面標識と同じく
  // デカール用の深度バイアスをかける。これが無いと、遠方のLODが粗いところで
  // 地形が水面を突き抜け、川がちぎれて見える。
  EnvState.waterMaterial.polygonOffset = true;
  EnvState.waterMaterial.polygonOffsetFactor = -4;
  EnvState.waterMaterial.polygonOffsetUnits = -4;

  refreshWater();
}

function refreshWater() {
  if (!EnvState.builtWater) return;
  const cam = EnvState.camera.position;

  for (const river of WORLD_RIVERS) {
    const near = riverNearCamera(river, cam);
    const built = EnvState.builtWater.has(river.id);
    if (near && !built) buildRiverInstance(river);
    else if (!near && built) disposeWaterInstance(river.id);
  }

  for (const lake of WORLD_LAKES) {
    const near = Math.hypot(lake.x - cam.x, lake.z - cam.z) < WATER_ACTIVE_RADIUS + lake.outerR;
    const built = EnvState.builtWater.has(lake.id);
    if (near && !built) buildLakeInstance(lake);
    else if (!near && built) disposeWaterInstance(lake.id);
  }
}

// 川は100km以上に伸びるので、中心との距離ではなく経路の点との最短距離で判定する
function riverNearCamera(river, cam) {
  const r2 = (WATER_ACTIVE_RADIUS + 20000) * (WATER_ACTIVE_RADIUS + 20000);
  for (let i = 0; i < river.points.length; i += 3) {
    const p = river.points[i];
    const dx = p.x - cam.x, dz = p.z - cam.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

function disposeWaterInstance(id) {
  const mesh = EnvState.builtWater.get(id);
  if (!mesh) return;
  EnvState.waterGroup.remove(mesh);
  mesh.geometry.dispose();
  EnvState.builtWater.delete(id);
}

// --- 川 ---------------------------------------------------------------------

// 経路に沿って左右へ幅を振り、帯状のメッシュにする
function buildRiverInstance(river) {
  const pts = river.points;
  const n = pts.length;
  if (n < 2) return;

  const ox = pts[0].x, oz = pts[0].z, oy = pts[0].h;
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);

  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    // 水平面内で接線に直交する向き
    const px = -tz, pz = tx;
    const w = (p.halfWidth || 12) + RIVER_BANK_MARGIN_M;
    const y = p.h - RIVER_BED_OFFSET_M + RIVER_WATER_DEPTH_M;

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

  const mesh = new THREE.Mesh(geo, EnvState.waterMaterial);
  mesh.position.set(ox, oy, oz);
  mesh.renderOrder = 1; // 海(2)より先、地形より後
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  EnvState.waterGroup.add(mesh);
  EnvState.builtWater.set(river.id, mesh);
}

// --- 湖 ---------------------------------------------------------------------

// 岸の形は「中心から外へ地形を辿って、水面の高さに達したところ」で決める。
// 掘り方（worldCarveLakes）と描き方をここで一致させておくと、
// 湖が丘に食い込む形もそのまま出る。
function buildLakeInstance(lake) {
  const rays = LAKE_SHORE_RAYS;
  const positions = new Float32Array((rays + 1) * 3);
  const normals = new Float32Array((rays + 1) * 3);
  normals[1] = 1;

  const step = lake.outerR / 26;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    let shore = lake.outerR;
    for (let d = step; d <= lake.outerR * 1.35; d += step) {
      if (worldHeightAt(lake.x + cx * d, lake.z + cz * d) >= lake.level) { shore = d; break; }
    }
    const vi = (i + 1) * 3;
    positions[vi] = cx * shore;
    positions[vi + 2] = cz * shore;
    normals[vi + 1] = 1;
  }

  const indices = new Uint16Array(rays * 3);
  for (let i = 0; i < rays; i++) {
    indices[i * 3] = 0;
    indices[i * 3 + 1] = 1 + ((i + 1) % rays);
    indices[i * 3 + 2] = 1 + i;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, EnvState.waterMaterial);
  mesh.position.set(lake.x, lake.level, lake.z);
  mesh.renderOrder = 1;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  EnvState.waterGroup.add(mesh);
  EnvState.builtWater.set(lake.id, mesh);
}

// 夜は水面も暗くする（03-sky.js の updateSkyForSunDirection から呼ばれる）
function updateWaterForDaylight(dayFactor, warmth) {
  if (!EnvState.waterMaterial) return;
  const mat = EnvState.waterMaterial;
  const night = new THREE.Color(0x050c14);
  const day = new THREE.Color(0x14303f).lerp(new THREE.Color(0x1d4055), warmth * 0.5);
  mat.color.copy(night).lerp(day, dayFactor);
  mat.specular.setHex(0x6f93ad).multiplyScalar(0.25 + dayFactor * 0.75);
}
