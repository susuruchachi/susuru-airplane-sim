// 03n-districts.js — 区画（巨大都市の外側の市街地と、メガロポリス＝都市群の帯）の出し入れ
//
// 区画の中身（街路と建物）は js/env/03j-city-layout.js の cityDistrictPlan が決める。ここは建てるだけ。
// 巨大都市は直径20〜40km、都市群は数百kmあるので、全部を建てると数万軒になる。
// **見ている場所からの距離で、区画ごとに詳しさを変える**:
//   0（近い）… 全部の建物（家・倉庫も）と街路の舗装
//   1（中）  … 背の高い建物（DISTRICT_MID_MIN_H 以上）だけ。家は小さく、この距離では1画素に満たない
//   2（遠い）… 高層ビル（DISTRICT_FAR_MIN_H 以上）だけ（都市群の帯の区画は灯りだけ）
// 灯りはどの段でも全部の建物ぶん出す（夜の街の広がりは灯りで見えるので）。遠い段の家は並べず、
// 並ぶはずの数（DISTRICT_HOUSE_REALIZED）だけ灯りを散らす。
// さらに遠く（区画を建てない距離）は、都市群まるごとの灯り（megaGlow）で夜の広がりを出す。
// 昼の広がりは地表の色（worldUrbanFactorAt）で見える。

const DISTRICT_NEAR_M = 5000;
const DISTRICT_MID_M = 12000;
const DISTRICT_FAR_M = 26000;
const DISTRICT_MID_MIN_H = 14;
const DISTRICT_FAR_MIN_H = 40;
const DISTRICT_BUILD_BUDGET_MS = 6;     // 1フレームで区画づくりに使っていい時間
const DISTRICT_PLAN_CACHE = 700;        // 並べ方を覚えておく区画の数
const DISTRICT_REFRESH_M = 600;         // 見ている場所がこれだけ動いたら、建てる区画を選び直す
// 家を並べていない区画の灯りの見込み。実際に並ぶ家の数は、密度の積分のこの割合
// （道路・中層の敷地・斜面・街路からの離れで落ちる。Oberfield の市街地0.379・都市群の帯0.386 で測った）
const DISTRICT_HOUSE_REALIZED = 0.38;
// 段ごとの灯りの間引き（残す割合）と点の大きさ。遠くの灯りの点は1画素に満たなくても1画素で描かれるので、
// 全部出すと遠いほど明るくなりすぎる（Oberfield を30km先から見て、都市群の灯りの10倍ほど明るかった）。
// 残す割合×大きさ² を一定にして（画面を埋める割合は同じ）、遠い段ほど少なく大きな点にする。
// 遠い段は都市群の灯り（MEGA_GLOW_*：1km²あたり16点・大きさ110）と揃う（市街地の区画の灯りは1km²あたり430ほど）
const DISTRICT_LIGHT_KEEP = [1, 0.25, 0.05];
const DISTRICT_LIGHT_SIZE = [26, 52, 116];
const MEGA_GLOW_BUILD_M = 220000;       // 都市群の灯りを作る距離（これより離れたら片付ける）
// 灯りの点の間隔と大きさ。遠い区画の家の灯り（1軒2つ・大きさ26、市街地で1km²あたり300ほど）と
// 画面を埋める割合が揃うようにする（点の数×大きさ²）。揃わないと、区画を建てる距離の縁で明るさが段になる
const MEGA_GLOW_CELL_M = 250;
const MEGA_GLOW_SIZE = 110;
const MEGA_GLOW_CHUNK = 20000;          // 1フレームに調べる格子の数（1格子0.2µsほど）

let _districtWork = [];
let _districtPlans = new Map();
let _districtLastAt = null;
let _districtDay = 1;

function districtRangeScale() {
  const q = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.min(Math.max(q, 0.45), 1.3);
}

function districtPlanFor(i, j) {
  const key = i + ',' + j;
  if (_districtPlans.has(key)) {
    const p = _districtPlans.get(key);
    _districtPlans.delete(key); _districtPlans.set(key, p);   // 使ったものを後ろへ（LRU）
    return p;
  }
  const p = cityDistrictPlan(i, j);
  _districtPlans.set(key, p);
  if (_districtPlans.size > DISTRICT_PLAN_CACHE) _districtPlans.delete(_districtPlans.keys().next().value);
  return p;
}

// 見ている場所のまわりで建てるべき区画と、その詳しさを決める
function refreshDistricts() {
  if (!EnvState.builtDistricts) {
    EnvState.builtDistricts = new Map();
    EnvState.megaGlows = new Map();
  }
  if (typeof cityDistrictInfo !== 'function') return;
  const cam = EnvState.camera.position;
  refreshMegaGlows(cam);
  if (_districtLastAt && Math.hypot(cam.x - _districtLastAt.x, cam.z - _districtLastAt.z) < DISTRICT_REFRESH_M
    && Math.abs(cam.y - _districtLastAt.y) < DISTRICT_REFRESH_M) return;
  _districtLastAt = { x: cam.x, y: cam.y, z: cam.z };
  const k = districtRangeScale();
  const near = DISTRICT_NEAR_M * k, mid = DISTRICT_MID_M * k, far = DISTRICT_FAR_M * k;
  const T = CITY_TILE_M;
  const groundY = typeof terrainSurfaceHeightAt === 'function' ? terrainSurfaceHeightAt(cam.x, cam.z) : 0;
  const agl = Math.max(cam.y - groundY, 0);
  // 近くに巨大都市も都市群も無ければ何もしない（格子を舐めるだけでも千区画ある）
  const anyNear = WORLD_MEGALOPOLISES.some((m) => cam.x > m.bounds.minX - far - 6000 && cam.x < m.bounds.maxX + far + 6000
    && cam.z > m.bounds.minZ - far - 6000 && cam.z < m.bounds.maxZ + far + 6000);
  const want = new Map();
  if (anyNear) {
    const r = Math.ceil(far / T) + 1;
    const ci = Math.floor(cam.x / T), cj = Math.floor(cam.z / T);
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const cx = (i + 0.5) * T, cz = (j + 0.5) * T;
        const d = Math.hypot(Math.hypot(cx - cam.x, cz - cam.z), agl);
        if (d > far) continue;
        const info = cityDistrictInfo(i, j);
        if (!info) continue;
        // 帯の区画は背の高い建物がほとんど無いので、遠い段は灯りだけになる
        const level = d < near ? 0 : d < mid ? 1 : 2;
        want.set(i + ',' + j, { i, j, level, d });
      }
    }
  }
  // 要らなくなった区画は片付ける。詳しさが変わる区画は建て直す（新しいのができるまで古いのを残す）
  for (const [key, e] of EnvState.builtDistricts) {
    if (!want.has(key)) disposeDistrict(key);
  }
  _districtWork = [];
  for (const [key, w] of want) {
    const e = EnvState.builtDistricts.get(key);
    if (e && e.level === w.level) continue;
    _districtWork.push(w);
  }
  // 近い区画から。詳しくする仕事を先に
  _districtWork.sort((a, b) => a.d - b.d);
}

function updateDistricts() {
  updateMegaGlows();
  if (!_districtWork.length) return;
  const t0 = performance.now();
  while (_districtWork.length && performance.now() - t0 < DISTRICT_BUILD_BUDGET_MS) {
    const w = _districtWork.shift();
    const key = w.i + ',' + w.j;
    const plan = districtPlanFor(w.i, w.j);
    const old = EnvState.builtDistricts.get(key);
    if (!plan) { if (old) disposeDistrict(key); continue; }
    const e = buildDistrict(plan, w.level);
    if (old) disposeDistrict(key);
    if (e) { e.level = w.level; EnvState.builtDistricts.set(key, e); }
  }
}

function disposeDistrict(key) {
  const e = EnvState.builtDistricts.get(key);
  if (!e) return;
  for (const o of [e.buildings, e.lights, e.streets]) {
    if (!o) continue;
    EnvState.cityGroup.remove(o);
    o.geometry.dispose();
    if (o !== e.streets) o.material.dispose();
    else for (const c of o.children) c.geometry.dispose();
  }
  EnvState.builtDistricts.delete(key);
}

// 家1軒ぶんの灯り（cityShapeBuilding が家に置くのと同じ2つ）
function districtHouseLights(lit, info, x, z, oy, rand) {
  const wx = info.cx + x, wz = info.cz + z;
  const ground = terrainSurfaceHeightAt(wx, wz);
  if (ground <= 0.5 || worldWaterSurfaceAt(wx, wz) !== null) return;
  for (let k = 0; k < 2; k++) {
    const c = 0.7 + rand() * 0.3;
    lit.push(x, ground - oy + (k === 0 ? 6 : CITY_LIGHT_Y * 0.4), z, c, c * 0.66, c * 0.34);
  }
}

// 区画1つぶんのメッシュ（建物・灯り・街路）
function buildDistrict(plan, level) {
  const info = plan.info;
  const minH = level === 0 ? 0 : level === 1 ? DISTRICT_MID_MIN_H : DISTRICT_FAR_MIN_H;
  const S = cityShapeSink();
  const lit = [];
  const litEst = [];   // 見込みで散らす家の灯り（もう間引いてある）
  const rand = placesRng(info.key + ':lights');
  const oy = plan.groundY;
  // 近い段は家も建てる。遠い段は家を並べず（並べるのは1区画数ms）、灯りだけ見込みで置く
  const houses = level === 0 ? cityDistrictHouses(plan) : plan.houses;
  const list = level === 0 ? plan.buildings.concat(houses) : plan.buildings;
  if (level > 0) {
    if (houses) {
      for (const b of houses) districtHouseLights(lit, info, b.x, b.z, oy, rand);
    } else if (plan.houseMax > 0.5) {
      const hs = CITY_TILE_M / 2;
      const n = Math.round(plan.houseMax * (CITY_TILE_M / 1000) * (CITY_TILE_M / 1000) * DISTRICT_LIGHT_KEEP[level]);
      for (let k = 0; k < n; k++) {
        const x = (rand() * 2 - 1) * hs, z = (rand() * 2 - 1) * hs;
        if (rand() > DISTRICT_HOUSE_REALIZED) continue;
        const dv = plan.ctx.dens(x + info.cx, z + info.cz);
        if (!dv || rand() * plan.houseMax > dv.house) continue;
        districtHouseLights(litEst, info, x, z, oy, rand);
      }
    }
  }
  for (const b of list) {
    const wx = info.cx + b.x, wz = info.cz + b.z;
    const ground = terrainSurfaceHeightAt(wx, wz);
    if (ground <= 0.5) continue;
    const tall = b.h + (b.roofH || 0) >= minH || b.kind === 'tower';
    if (level === 0 || tall) {
      const span = Math.max(b.w, b.d);
      if (cityFootprintWet(wx, wz, span, span, ground)) continue;
      if (tall || level === 0) cityShapeBuilding(S, b, ground - oy, lit, rand);
    } else {
      // 建てない家も、灯りだけは出す（夜の街の広がり）
      if (worldWaterSurfaceAt(wx, wz) !== null) continue;
      const k = 0.6 + rand() * 0.3;
      lit.push(b.x, ground - oy + CITY_LIGHT_Y * 0.5, b.z, k, k * 0.64, k * 0.32);
    }
  }
  const e = { level, buildings: null, lights: null, streets: null };
  if (S.p.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S.p), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(S.n), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(S.c), 3));
    geo.computeBoundingSphere();
    const v = 1 - THREE.MathUtils.clamp(_districtDay, 0, 1);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x000000 }));
    mesh.material.emissive.setRGB(v * 0.10, v * 0.072, v * 0.042);
    mesh.position.set(info.cx, oy, info.cz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    EnvState.cityGroup.add(mesh);
    e.buildings = mesh;
  }
  const lp = [], lc = [];
  const keep = DISTRICT_LIGHT_KEEP[level];
  for (let i = 0; i < lit.length; i += 6) {
    if (keep < 1 && rand() > keep) continue;
    lp.push(lit[i], lit[i + 1], lit[i + 2]); lc.push(lit[i + 3], lit[i + 4], lit[i + 5]);
  }
  for (let i = 0; i < litEst.length; i += 6) { lp.push(litEst[i], litEst[i + 1], litEst[i + 2]); lc.push(litEst[i + 3], litEst[i + 4], litEst[i + 5]); }
  if (lp.length) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lc), 3));
    lg.computeBoundingSphere();
    const v = 1 - THREE.MathUtils.clamp(_districtDay, 0, 1);
    const pts = new THREE.Points(lg, new THREE.PointsMaterial({
      size: DISTRICT_LIGHT_SIZE[level], sizeAttenuation: true, vertexColors: true, transparent: true, opacity: v,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    }));
    pts.visible = v > 0.01;
    pts.position.set(info.cx, oy, info.cz);
    pts.matrixAutoUpdate = false;
    pts.updateMatrix();
    EnvState.cityGroup.add(pts);
    e.lights = pts;
  }
  if (level === 0 && plan.streets.length) {
    const st = buildCityStreets({ x: info.cx, z: info.cz, groundY: oy }, { streets: plan.streets });
    if (st) {
      st.position.set(info.cx, oy, info.cz);
      st.matrixAutoUpdate = false;
      st.updateMatrix();
      EnvState.cityGroup.add(st);
      e.streets = st;
    }
  }
  return e.buildings || e.lights || e.streets ? e : null;
}

// --- 都市群まるごとの灯り（区画を建てない遠くから見たときの夜の広がり） -----------

function refreshMegaGlows(cam) {
  for (const m of WORLD_MEGALOPOLISES) {
    const b = m.bounds;
    const dx = Math.max(b.minX - cam.x, 0, cam.x - b.maxX), dz = Math.max(b.minZ - cam.z, 0, cam.z - b.maxZ);
    const d = Math.hypot(dx, dz);
    const g = EnvState.megaGlows.get(m.id);
    if (d < MEGA_GLOW_BUILD_M && !g) {
      EnvState.megaGlows.set(m.id, { mega: m, job: { i: 0, j: 0, pos: [], col: [], rand: placesRng(m.id + ':glow') }, points: null });
    } else if (d > MEGA_GLOW_BUILD_M * 1.2 && g) {
      if (g.points) { EnvState.cityGroup.remove(g.points); g.points.geometry.dispose(); g.points.material.dispose(); }
      EnvState.megaGlows.delete(m.id);
    }
  }
}

// 格子を少しずつ調べて灯りの点を置く（帯の濃さ・巨大都市の市街地に比例）。できたら Points にする
function updateMegaGlows() {
  if (!EnvState.megaGlows) return;
  for (const g of EnvState.megaGlows.values()) {
    if (!g.job) continue;
    const m = g.mega, b = m.bounds, job = g.job;
    const pad = 4000;
    const ni = Math.ceil((b.maxX - b.minX + pad * 2) / MEGA_GLOW_CELL_M);
    const nj = Math.ceil((b.maxZ - b.minZ + pad * 2) / MEGA_GLOW_CELL_M);
    let n = 0;
    while (job.i < ni && n < MEGA_GLOW_CHUNK) {
      const x = b.minX - pad + (job.i + job.rand()) * MEGA_GLOW_CELL_M;
      const z = b.minZ - pad + (job.j + job.rand()) * MEGA_GLOW_CELL_M;
      n++;
      if (++job.j >= nj) { job.j = 0; job.i++; }
      const u = worldUrbanFactorAt(x, z);
      if (u < 0.08 || job.rand() > u * 1.2) continue;
      const y = worldHeightAt(x, z);
      if (y <= 0.5 || worldWaterSurfaceAt(x, z) !== null) continue;
      const k = 0.55 + job.rand() * 0.35;
      job.pos.push(x - m.core.x, y + CITY_LIGHT_Y, z - m.core.z);
      job.col.push(k, k * 0.6, k * 0.28);
    }
    if (job.i < ni) return;   // 1フレームに1つの都市群だけ進める
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(job.pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(job.col), 3));
    geo.computeBoundingSphere();
    const v = 1 - THREE.MathUtils.clamp(_districtDay, 0, 1);
    const mat = new THREE.PointsMaterial({
      size: MEGA_GLOW_SIZE, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: v,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    // **区画を建てている距離では消す**（そこは区画の灯りがある）。点ごとに視点からの距離で薄めないと、
    // 街の上を低く飛んでいるときに、大きな灯りの点がすぐそばに浮いて見える。
    // 区画は区画の中心までの距離で選ぶので、縁（DISTRICT_FAR_M）の前後で入れ替える
    const fadeNear = DISTRICT_FAR_M * districtRangeScale() * 0.9, fadeFar = DISTRICT_FAR_M * districtRangeScale() * 1.05;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uGlowNear = { value: fadeNear };
      sh.uniforms.uGlowFar = { value: fadeFar };
      sh.vertexShader = 'uniform float uGlowNear;\nuniform float uGlowFar;\nvarying float vGlowFade;\n'
        + sh.vertexShader.replace('#include <project_vertex>',
          '#include <project_vertex>\n  vGlowFade = smoothstep(uGlowNear, uGlowFar, length(mvPosition.xyz));');
      sh.fragmentShader = 'varying float vGlowFade;\n'
        + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vGlowFade;');
    };
    const pts = new THREE.Points(geo, mat);
    pts.visible = v > 0.01;
    pts.position.set(m.core.x, 0, m.core.z);
    pts.matrixAutoUpdate = false;
    pts.updateMatrix();
    EnvState.cityGroup.add(pts);
    g.points = pts;
    g.job = null;
    return;
  }
}

function updateDistrictsForDaylight(dayFactor) {
  _districtDay = dayFactor;
  const v = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
  if (EnvState.builtDistricts) {
    for (const e of EnvState.builtDistricts.values()) {
      if (e.lights) { e.lights.material.opacity = v; e.lights.visible = v > 0.01; }
      if (e.buildings) e.buildings.material.emissive.setRGB(v * 0.10, v * 0.072, v * 0.042);
    }
  }
  if (EnvState.megaGlows) {
    for (const g of EnvState.megaGlows.values()) {
      if (!g.points) continue;
      g.points.material.opacity = v;
      g.points.visible = v > 0.01;
    }
  }
}
