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


// 川面の深度の寄せ方（applyDepthPull）。距離1kmあたり RIVER_DEPTH_PULL*1000 m、
// 画面1画素ぶんの深度の変化の RIVER_DEPTH_SLOPE_PX 倍、それに RIVER_DEPTH_ABS_M
const RIVER_DEPTH_PULL = 2e-3;
const RIVER_DEPTH_SLOPE_PX = 2;
const RIVER_DEPTH_ABS_M = 4;

const WATER_INLAND_WAVES = 0.45; // 川・湖の波の強さ（海を1として）

// 河口の近くでは川床が海面下まで下がる（入り江・三角州）。そこの水は海の水面が
// 引き受けるが、川幅（半幅100〜250m）は地形のLODの格子（310m〜）より細いので、
// 地形のメッシュには谷が出ず、陸のまま描かれる——川が海岸の数km手前で途切れて見えた。
// 両岸がまだ陸（この高さより上）のあいだは、川面を海面の高さで張り続ける。
// 岸を見る位置は、川幅の外へこれだけ出た所。
const RIVER_BANK_PROBE_M = 60;
const RIVER_BANK_LAND_M = 0.3;

function initWater() {
  EnvState.waterGroup = new THREE.Group();
  EnvState.scene.add(EnvState.waterGroup);
  EnvState.builtWater = new Map();

  // 川と湖の水面のマテリアル。**海と同じ色・同じ透け方・同じ波のシェーダー**にする。
  // 以前は海より明るい色（0x14303f・不透明度0.82・映り込み控えめ）にしていたので、
  // 河口で川面が海へ入るところ（三角州の付け根）に色の境がはっきり出ていた。
  // 波は海より小さくする（風の吹き渡る距離が短い）。
  const makeWaterMaterial = () => new THREE.MeshPhongMaterial({
    color: 0x0b2135, specular: WATER_SPECULAR, shininess: 220,
    transparent: true, opacity: 0.80, side: THREE.DoubleSide,
  });
  EnvState.waterMaterial = applyWaterSurface(makeWaterMaterial(), { waves: WATER_INLAND_WAVES });
  // 水面は地形とほとんど同じ高さに乗る薄い面なので、滑走路の路面標識と同じく
  // デカール用の深度バイアスをかける。これが無いと、遠方のLODが粗いところで
  // 地形が水面を突き抜け、川がちぎれて見える。
  EnvState.waterMaterial.polygonOffset = true;
  EnvState.waterMaterial.polygonOffsetFactor = -4;
  EnvState.waterMaterial.polygonOffsetUnits = -4;
  // 川だけは深度を手前へ寄せる。山の中の急な川（勾配0.1なら310mで31m下る）では、
  // 地形のLODが310m以上の格子を直線でつなぐぶんの誤差が水深5mを超え、地形が
  // 傾いた川面を斜めに横切って、水面の縁がのこぎりの歯のように欠けて見えた。
  // 湖は岸の線で水面を切っているので寄せない（寄せると岸の斜面に水がにじむ）。
  EnvState.riverWaterMaterial = applyWaterSurface(applyDepthPull(makeWaterMaterial(),
    RIVER_DEPTH_PULL, 1, RIVER_DEPTH_SLOPE_PX, RIVER_DEPTH_ABS_M), { waves: WATER_INLAND_WAVES });
  // 川面どうし（本流と分流の付け根、支流の合流）が重なるところを二重に塗らない。
  // 半透明なので、重なったところだけ帯状に暗くなる。1画素に1回だけ塗る（ステンシル）。
  const m = EnvState.riverWaterMaterial;
  m.stencilWrite = true;
  m.stencilRef = 1;
  m.stencilFunc = THREE.NotEqualStencilFunc;
  m.stencilZPass = THREE.ReplaceStencilOp;

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

// 川の水面の高さ。川床（bedH）は世界側が河口で海面下まで下げているので、
// ここでそれを引き直さず、そのまま使う。
function riverSurfaceY(p) {
  const bed = p.bedH !== undefined ? p.bedH : p.h - RIVER_BED_OFFSET_M;
  return bed + RIVER_WATER_DEPTH_M;
}

// 川の水面を張ってよい点か。湖の中は湖の水面が引き受けるので張らない。
// 海面より下（河口の近く）は、両岸がまだ陸のあいだ（p.land）だけ張る——その先は海の水面が引き受ける。
// 海の上に張った川面は深度を手前へ寄せてあるので、同じ高さの海面はその奥に隠れ、二重には塗られない。
function riverPointWet(p) {
  return (riverSurfaceY(p) > 0 || p.land) && !worldLakeFootprintAt(p.x, p.z);
}

// 川面を張る高さ。海面より下には張らない（その高さの水は海そのもの）
function riverRibbonY(p) {
  return Math.max(riverSurfaceY(p), 0);
}

// 点列の各点に「両岸がまだ陸か」（land）を付けた写しを返す
function riverAnnotateBanks(pts) {
  const n = pts.length;
  return pts.map((p, i) => {
    const q = Object.assign({}, p);
    if (riverSurfaceY(p) > 0) return q; // 海面より上なら、岸を見るまでもなく張る
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const px = -(b.z - a.z) / len, pz = (b.x - a.x) / len;
    const off = (p.halfWidth || 12) + RIVER_BANK_MARGIN_M + RIVER_BANK_PROBE_M;
    q.land = worldHeightAt(p.x + px * off, p.z + pz * off) > RIVER_BANK_LAND_M
      || worldHeightAt(p.x - px * off, p.z - pz * off) > RIVER_BANK_LAND_M;
    return q;
  });
}

// 張る点と張らない点のあいだで、岸（または海面）をまたぐところを探す。
// 以前は最後に張れた点で帯を切っていたので、河口では海面の手前0〜2.5m・
// 最大375m手前で水面が終わり、その先の谷の斜面が乾いたまま海まで残っていた。
function riverEdgePoint(wet, dry) {
  let lo = 0, hi = 1;
  const at = (t) => ({
    x: wet.x + (dry.x - wet.x) * t,
    z: wet.z + (dry.z - wet.z) * t,
    bedH: riverSurfaceY(wet) + (riverSurfaceY(dry) - riverSurfaceY(wet)) * t - RIVER_WATER_DEPTH_M,
    halfWidth: (wet.halfWidth || 12) + ((dry.halfWidth || 12) - (wet.halfWidth || 12)) * t,
    land: t < 0.5 ? wet.land : dry.land,
  });
  for (let k = 0; k < 14; k++) {
    const t = (lo + hi) / 2;
    if (riverPointWet(at(t))) lo = t; else hi = t;
  }
  const e = at(hi);
  // 湖や海に出るところは、水面をちょうど湖面・海面に置いて同じ高さでつなぐ
  const lake = worldLakeFootprintAt(e.x, e.z);
  if (lake) e.bedH = lake.level - RIVER_WATER_DEPTH_M;
  else if (riverSurfaceY(e) < 0) e.bedH = -RIVER_WATER_DEPTH_M;
  return e;
}

// 経路を「水面を張る区間」に切り分ける。区間の両端は岸・海面ちょうどの点
function riverWetRuns(pts) {
  const runs = [];
  let run = null;
  for (let i = 0; i < pts.length; i++) {
    const wet = riverPointWet(pts[i]);
    if (wet && !run) {
      run = [];
      if (i > 0) run.push(riverEdgePoint(pts[i], pts[i - 1]));
    }
    if (wet) run.push(pts[i]);
    if (!wet && run) {
      run.push(riverEdgePoint(pts[i - 1], pts[i]));
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs.filter((r) => r.length >= 2);
}

// 経路に沿って左右へ幅を振り、帯状のメッシュにする
function buildRiverInstance(river) {
  const runs = riverWetRuns(riverAnnotateBanks(river.points));
  if (!runs.length) return;

  // 河口に街がある川は川床を海面下まで下げられない（worldMouthCityGuard）ので、
  // 水面が海面より上のまま終わる（グリムフィヨルド川は+3.6m）。
  // そのままだと海の手前に水面の段ができるので、最後の1区間ぶん先で海面まで下ろす。
  const tail = runs[runs.length - 1];
  const last = tail[tail.length - 1];
  if (river.mouthKind && riverSurfaceY(last) > 0.01) {
    const prev = tail[tail.length - 2];
    tail.push({
      x: last.x + (last.x - prev.x), z: last.z + (last.z - prev.z),
      bedH: -RIVER_WATER_DEPTH_M, halfWidth: last.halfWidth,
    });
  }
  // 三角州の分流にも川面を張る。分流も地形のLODより細いので、張らないと
  // 地形のメッシュに埋もれて、海へ届かずに砂地で行き止まるように見えた。
  if (river.mouthBranches) {
    for (const br of river.mouthBranches) runs.push(...riverWetRuns(riverAnnotateBanks(br)));
  }

  const pts0 = river.points;
  const ox = pts0[0].x, oz = pts0[0].z, oy = pts0[0].h;
  let total = 0;
  for (const run of runs) total += run.length;
  const positions = new Float32Array(total * 2 * 3);
  const normals = new Float32Array(total * 2 * 3);
  const indices = new Uint32Array((total - runs.length) * 6);
  let v = 0, k = 0;

  for (const pts of runs) {
    const n = pts.length;
    const base = v;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      // 水平面内で接線に直交する向き
      const px = -tz, pz = tx;
      const w = (p.halfWidth || 12) + RIVER_BANK_MARGIN_M;
      const y = riverRibbonY(p);

      const li = v * 3, ri = v * 3 + 3;
      positions[li] = p.x - ox + px * w; positions[li + 1] = y - oy; positions[li + 2] = p.z - oz + pz * w;
      positions[ri] = p.x - ox - px * w; positions[ri + 1] = y - oy; positions[ri + 2] = p.z - oz - pz * w;
      normals[li + 1] = 1; normals[ri + 1] = 1;
      v += 2;
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, EnvState.riverWaterMaterial);
  mesh.position.set(ox, oy, oz);
  mesh.renderOrder = ENV_ORDER.water; // 海より先、地形より後
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  EnvState.waterGroup.add(mesh);
  EnvState.builtWater.set(river.id, mesh);
}

// --- 湖 ---------------------------------------------------------------------

// 湖の岸は地形の等高線（世界側の worldFloodLake）。水面は「水の升目」を覆う板で、
// 升目の中心どうしを結んだ四角のうち、角のどれかが水のものを張る。岸の外の升目の中心は
// 地形が水面より高いので、四角の中で地形が水面を横切り、地形のほうが手前に出る——
// 描かれる岸は地形の等高線そのものになる。水の升目の外へは張らないので、あふれ口の先の
// 低い谷に水面が浮くこともない。
function buildLakeInstance(lake) {
  const m = lake.mask;
  const vid = new Int32Array((m.n) * (m.n)).fill(-1);
  const pos = [], idx = [];
  const vert = (i, j) => {
    const k = j * m.n + i;
    if (vid[k] < 0) {
      vid[k] = pos.length / 3;
      pos.push(m.x0 + (i + 0.5) * m.cell - lake.x, 0, m.z0 + (j + 0.5) * m.cell - lake.z);
    }
    return vid[k];
  };
  for (let j = 0; j < m.n - 1; j++) {
    for (let i = 0; i < m.n - 1; i++) {
      if (!(worldLakeWetCell(m, i, j) || worldLakeWetCell(m, i + 1, j)
        || worldLakeWetCell(m, i, j + 1) || worldLakeWetCell(m, i + 1, j + 1))) continue;
      const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
      // 上を向く巻き順（a→c→b：+z の向きを先に回る）
      idx.push(a, c, b, b, c, d);
    }
  }
  if (!idx.length) return;
  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  const indices = positions.length / 3 > 65000 ? new Uint32Array(idx) : new Uint16Array(idx);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, EnvState.waterMaterial);
  mesh.position.set(lake.x, lake.level, lake.z);
  mesh.renderOrder = ENV_ORDER.water;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  EnvState.waterGroup.add(mesh);
  EnvState.builtWater.set(lake.id, mesh);
}

// 夜は水面も暗くする（03-sky.js の updateSkyForSunDirection から呼ばれる）
function updateWaterForDaylight(dayFactor, warmth) {
  if (!EnvState.waterMaterial) return;
  // 海（updateSeaForDaylight）と同じ色にする（河口で色の境が出ないように）
  const night = new THREE.Color(0x030913);
  const day = new THREE.Color(0x0b2135).lerp(new THREE.Color(0x123049), warmth * 0.5);
  for (const mat of [EnvState.waterMaterial, EnvState.riverWaterMaterial]) {
    if (!mat) continue;
    mat.color.copy(night).lerp(day, dayFactor);
    mat.specular.setHex(WATER_SPECULAR).multiplyScalar(0.25 + dayFactor * 0.75);
  }
}
