// 03d-places.js — 都市（建物・夜景の灯り）と地名ラベル
//
// 都市は js/env/03b-world.js の WORLD_CITIES から手続き的に生成する。
// 建物の配置は都市IDから作った決定論的な擬似乱数で決めるので、
// 何度読み込んでも同じ街並みになる（＝空港と同じく「固定のマップ」として扱える）。
//
// 世界には130の都市があるので、地形や空港と同じく **カメラの周りだけ** 建てて、
// 離れたら片付ける。地名ラベルも近づいてから作る（作った後はキャッシュする）。

const CITY_ACTIVE_RADIUS_BASE = 90000;
const CITY_ACTIVE_RADIUS_MIN = 20000;
function cityActiveRadius() {
  const scale = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.max(CITY_ACTIVE_RADIUS_BASE * scale, CITY_ACTIVE_RADIUS_MIN);
}
const CITY_LIGHT_Y = 14;
// 街路の舗装を地形メッシュより少しだけ上に浮かせる（深度バイアスだけだと途切れる）
const CITY_STREET_LIFT_M = 0.8;
// 街路の橋。道路の橋（03b-world.js の BRIDGE_*）より低く、急にのぼる（街中の橋）
const CITY_BRIDGE_CLEARANCE_M = 4;
const CITY_BRIDGE_RAMP_SLOPE = 0.08;
const CITY_BRIDGE_EVERY = 3;       // 街路何本に1本、橋を架けるか
const CITY_BRIDGE_MAX_M = 1200;    // これより長く水の上を行く街路には架けない

// 建物の色は国ごとに 03j-city-layout.js の CITY_COUNTRY_STYLE が持っている。

// ラベルの種類ごとの見え方。国名は遠くからでも読めたほうが地図として使いやすい。
const LABEL_KINDS = {
  country: { fadeStart: 420000, fadeEnd: 1100000, minOpacity: 0.35, screenPx: 30, fontPx: 52 },
  range: { fadeStart: 150000, fadeEnd: 420000, minOpacity: 0, screenPx: 17, fontPx: 40 },
  city: { fadeStart: 70000, fadeEnd: 240000, minOpacity: 0, screenPx: 17, fontPx: 40 },
  airport: { fadeStart: 45000, fadeEnd: 160000, minOpacity: 0, screenPx: 16, fontPx: 40 },
  water: { fadeStart: 60000, fadeEnd: 200000, minOpacity: 0, screenPx: 15, fontPx: 38 },
  peak: { fadeStart: 90000, fadeEnd: 280000, minOpacity: 0, screenPx: 16, fontPx: 38 },
  // 小さな峰（下の「近くの峰」）。近くを飛んでいるときだけ出す
  minorPeak: { fadeStart: 9000, fadeEnd: 16000, minOpacity: 0, screenPx: 13, fontPx: 34 },
};

// 都市IDから決まる擬似乱数（世界側と同じ実装を使う）
const placesRng = worldRng;

// 直方体1つぶんの頂点・法線・色を配列へ積む（都市ごとに1メッシュへまとめるため）。
// ang は水平面での向き（sx の辺がこの向きに沿う）。建物を街路の向きに揃えるのに使う。
function pushBox(positions, normals, colors, cx, cy, cz, sx, sy, sz, r, g, b, ang) {
  const c = Math.cos(ang || 0), sn = Math.sin(ang || 0);
  const x0 = -sx / 2, x1 = sx / 2;
  const y0 = cy, y1 = cy + sy;
  const z0 = -sz / 2, z1 = sz / 2;

  // [法線, その面の4隅] の順に並べる（向きを付ける前の、箱の軸に沿った座標）
  const faces = [
    [0, 1, 0, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], // 上
    [0, 0, 1, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // 南
    [0, 0, -1, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], // 北
    [1, 0, 0, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // 東
    [-1, 0, 0, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // 西
  ];

  for (const f of faces) {
    const nx = f[0], ny = f[1], nz = f[2];
    const q = [f[3], f[4], f[5], f[6]];
    // 面ごとに明るさを変えると、単色でも立体感が出る
    const shade = ny === 1 ? 1.15 : (nx !== 0 ? 0.82 : 0.95);
    // 回す：箱の x 軸 → (c, sn)、z 軸 → (-sn, c)
    const wnx = nx * c - nz * sn, wnz = nx * sn + nz * c;
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const lx = q[k][0], lz = q[k][2];
      positions.push(cx + lx * c - lz * sn, q[k][1], cz + lx * sn + lz * c);
      normals.push(wnx, ny, wnz);
      colors.push(r * shade, g * shade, b * shade);
    }
  }
}

// 間口 fw×fd の建物を (x, z) に建てると、中心か四隅が水（川・湖・海）に入るか。
// 水面が地面より高ければ水の中。岸の斜面で水面とほぼ同じ高さの地面（0.3m以内）も水際として避ける。
// 1都市で千軒以上を調べるので、地面の高さ（重い）は水の近くか海の近く（ground が低い）でだけ引く。
function cityFootprintWet(x, z, fw, fd, ground) {
  const hx = fw * 0.5, hz = fd * 0.5;
  const pts = fw > 0 ? [[0, 0], [-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]] : [[0, 0]];
  const nearSea = ground < 20;
  for (const [dx, dz] of pts) {
    const px = x + dx, pz = z + dz;
    const w = worldWaterSurfaceAt(px, pz);
    if (w === null && !nearSea) continue;
    const g = worldHeightAt(px, pz);
    if (g <= 0.5) return true;
    if (w !== null && w > g - 0.3) return true;
  }
  return false;
}

// --- 都市の出し入れ ---------------------------------------------------------

function initPlaces() {
  EnvState.cityGroup = new THREE.Group();
  EnvState.scene.add(EnvState.cityGroup);
  EnvState.builtCities = new Map();

  // 街路の舗装。街どうしで共有する（都市の出し入れのたびに作り直さない）。
  EnvState.streetMaterial = new THREE.MeshLambertMaterial({ color: 0x35322e });
  EnvState.streetMaterial.polygonOffset = true;
  EnvState.streetMaterial.polygonOffsetFactor = -5;
  EnvState.streetMaterial.polygonOffsetUnits = -5;

  if (typeof initPorts === 'function') initPorts();   // 港（03l-ports.js）
  initPlaceLabels();
  refreshCities();
}

// 1フレームに進める街の仕事の数。1都市ぶんの生成に30〜42msかかる（建物3.7万頂点＋
// 街路7,800頂点）ので、圏内に入った街をその場で全部建てると、街に近づくたびに
// 100ms超の引っかかりが出る。地形タイルと同じくキューに積んでフレームを分ける。
// 1都市は「街路網と建物の並びを決める」（03j-city-layout.js、路地の多い街で最大50ms）・
// 「建物と灯り」・「街路の舗装と橋」の3つの仕事に分けて、別々のフレームで進める。
const CITY_BUILD_BUDGET = 1;
let _cityWork = [];

// カメラの周りにあるべき都市を揃える。片付けはその場で、建てるのはキューへ。
function refreshCities() {
  if (!EnvState.builtCities) return; // 地形の初期化のほうが先に走るため
  const cam = EnvState.camera.position;
  const R = cityActiveRadius();
  // 作りかけの街（並べ方を決めた・建物を途中まで作った）は、列を作り直しても続きから進める。
  // 地形のタイルが切り替わるたびにここが呼ばれるので、捨てると速い機体では建ち終わらない
  const prev = new Map(_cityWork.map((w) => [w.city.id, w]));
  _cityWork = [];
  for (const city of WORLD_CITIES) {
    const d = Math.hypot(city.x - cam.x, city.z - cam.z);
    const entry = EnvState.builtCities.get(city.id);
    const built = !!entry;
    // 建物まで建って街路がまだの街も戻す（列を作り直すと、残りの仕事が消えるため）
    if (d < R && (!built || !entry.streets)) {
      const old = prev.get(city.id);
      if (old) { old.d = d; _cityWork.push(old); } else _cityWork.push({ city, d, plan: built ? true : null });
    }
    else if (d >= R && built) disposeCityInstance(city.id);
  }
  // 近い街から建てる（見ている場所ほど早く出てほしい）
  _cityWork.sort((a, b) => a.d - b.d);
  // 巨大都市の外側と都市群の帯（区画ごと。js/env/03n-districts.js）
  if (typeof refreshDistricts === 'function') refreshDistricts();
  // 港も同じ判断で出し入れする
  if (typeof refreshPorts === 'function') refreshPorts();
}

function updateCities() {
  if (typeof updateDistricts === 'function') updateDistricts();
  let budget = CITY_BUILD_BUDGET;
  while (budget > 0 && _cityWork.length > 0) {
    const w = _cityWork[0];
    const entry = EnvState.builtCities.get(w.city.id);
    if (!w.plan) {
      if (entry) { _cityWork.shift(); continue; } // もう建っている
      w.plan = cityBuildingPlan(w.city); // 街路網もここで作られる（街に持たせてある）
    } else if (!entry) {
      // 建物は CITY_BUILD_CHUNK 軒ずつ、何フレームかに分けて作る
      if (!w.job) w.job = cityBuildStart(w.city, w.plan);
      if (cityBuildStep(w.job, CITY_BUILD_CHUNK)) { cityBuildFinish(w.job); w.job = null; }
    } else {
      _cityWork.shift();
      if (!entry.streets) addCityStreets(entry);
    }
    budget--;
  }
}

function disposeCityInstance(id) {
  const entry = EnvState.builtCities.get(id);
  if (!entry) return;
  EnvState.cityGroup.remove(entry.buildings);
  EnvState.cityGroup.remove(entry.lights);
  entry.buildings.geometry.dispose();
  entry.buildings.material.dispose();
  entry.lights.geometry.dispose();
  entry.lights.material.dispose();
  if (entry.streets) {
    EnvState.cityGroup.remove(entry.streets);
    entry.streets.geometry.dispose();   // マテリアルは街で共有しているので dispose しない
    for (const c of entry.streets.children) c.geometry.dispose(); // 橋
  }
  EnvState.builtCities.delete(id);
}

// 都市1つぶんの建物メッシュと夜景の灯りを作る。
// 頂点は街の中心からのローカル座標で持ち、位置はメッシュ側に入れる（遠方でのfloat32対策）。
//
// **何フレームかに分けて作る**（cityBuildStart → cityBuildStep をくり返す → cityBuildFinish）。
// 屋根・高層ビル・名所の形を付けたら、建物の多い街（路地の街タラバード1,927軒）で
// 1回に78msかかるようになった。CITY_BUILD_CHUNK 軒ずつ進めて、1フレームの引っかかりを抑える。
// buildCityInstance は一気に作る版（検証やその場で建て直すとき用）。
const CITY_BUILD_CHUNK = 500;

function cityBuildStart(city, plan) {
  return { city, plan: plan || cityBuildingPlan(city), i: 0, S: cityShapeSink(), lit: [],
    rand: placesRng(city.id + ':lights') };
}

// n 軒ぶん進める。全部建て終わったら true
function cityBuildStep(job, n) {
  const { city, plan, S, lit, rand } = job;
  const end = Math.min(plan.length, job.i + n);
  // 建物の並び（どこに・どの向きで・どの大きさで・どの形で）は 03j-city-layout.js が決める。
  // いちばん近い街路に面して、その向きに揃えて建てる。
  for (; job.i < end; job.i++) {
    const bld = plan[job.i];
    const ox = bld.x, oz = bld.z;
    // 地形メッシュの上の高さを使う。worldHeightAt の値だと、
    // 地形が格子点の間を三角形で結んでいるぶんだけ建物が浮いたり埋まったりする。
    const ground = terrainSurfaceHeightAt(city.x + ox, city.z + oz);
    if (ground <= 0.5) continue; // 海にはみ出したぶんは建てない
    // 川の中にも建てない。街は川の谷をまたいで広がるので、何もしないと
    // 130都市の88,443軒のうち350軒（イーゼンダール152・アルドミア121など4都市）が水の上に建っていた。
    // 間口の四隅まで見る（中心だけだと岸に半分かかった建物が水に浸かる）。
    // 向きを付けたぶん四隅は回るが、外接する正方形で見ておけば取りこぼさない。
    const span = Math.max(bld.w, bld.d);
    if (cityFootprintWet(city.x + ox, city.z + oz, span, span, ground)) continue;
    cityShapeBuilding(S, bld, ground - city.groundY, lit, rand);
  }
  return job.i >= plan.length;
}

function buildCityInstance(city, plan) {
  const job = cityBuildStart(city, plan);
  cityBuildStep(job, Infinity);
  cityBuildFinish(job);
}

function cityBuildFinish(job) {
  const { city, plan, S, lit, rand } = job;
  const radius = city.builtRadiusM;
  const buildingCount = plan.length;
  const lightPositions = [], lightColors = [];
  // 街の真ん中の名所（教会・丸屋根・塔など）
  for (const m of cityLandmarks(city)) {
    const ground = terrainSurfaceHeightAt(city.x + m.x, city.z + m.z);
    if (ground <= 0.5 || cityFootprintWet(city.x + m.x, city.z + m.z, m.r * 2, m.r * 2, ground)) continue;
    cityShapeLandmark(S, m, ground - city.groundY, lit, city.country);
  }
  for (let i = 0; i < lit.length; i += 6) {
    lightPositions.push(lit[i], lit[i + 1], lit[i + 2]);
    lightColors.push(lit[i + 3], lit[i + 4], lit[i + 5]);
  }
  const positions = S.p, normals = S.n, colors = S.c;

  // 街の外側にも街灯をまばらに置いて、郊外のにじみを作る。
  // 巨大都市は都心の外が区画の市街地で、灯りはそちら（js/env/03n-districts.js）が出す
  for (let i = 0, n = city.megacity ? 0 : Math.round(buildingCount * 0.9); i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = radius * (1 + rand() * 0.9);
    const ox = Math.cos(ang) * dist, oz = Math.sin(ang) * dist;
    const ground = terrainSurfaceHeightAt(city.x + ox, city.z + oz);
    if (ground <= 0.5) continue;
    if (cityFootprintWet(city.x + ox, city.z + oz, 0, 0, ground)) continue; // 川面に灯りを浮かべない
    const warm = 0.5 + rand() * 0.3;
    lightPositions.push(ox, ground - city.groundY + CITY_LIGHT_Y, oz);
    lightColors.push(warm, warm * 0.62, warm * 0.3);
  }


  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeBoundingSphere();

  const buildings = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, emissive: 0x000000,
  }));
  buildings.position.set(city.x, city.groundY, city.z);
  buildings.matrixAutoUpdate = false;
  buildings.updateMatrix();
  EnvState.cityGroup.add(buildings);

  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lightPositions), 3));
  lightGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lightColors), 3));
  lightGeo.computeBoundingSphere();

  const lights = new THREE.Points(lightGeo, new THREE.PointsMaterial({
    size: 26, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true,
  }));
  lights.position.copy(buildings.position);
  lights.matrixAutoUpdate = false;
  lights.updateMatrix();
  EnvState.cityGroup.add(lights);

  // 街路は次の仕事（addCityStreets）で足す
  EnvState.builtCities.set(city.id, { city, buildings, lights, streets: null });
}

// 街路の舗装。建物と同じメッシュに混ぜてしまうと、夜に建物だけ発光させる
// （updatePlacesForDaylight）ときに舗装まで光ってしまうので、別のメッシュにする。
function addCityStreets(entry) {
  const streets = buildCityStreets(entry.city);
  if (!streets) return;
  streets.position.copy(entry.buildings.position);
  streets.matrixAutoUpdate = false;
  streets.updateMatrix();
  EnvState.cityGroup.add(streets);
  entry.streets = streets;
}

// 街路の舗装。03j-city-layout.js の街路網（折れ線の集まり）を、地形の上に帯として敷く。
// 建物もその街路網を見て並べているので、舗装と建物がずれることはない。
//
// 地形は刻まない——街路の幅は9〜20mで、いちばん細かいLODでも地形の頂点間隔は312m。
// 道路（03i-roads.js）と同じくデカールとして重ねる。
// netOverride を渡すと、その街路（{ streets }）を city の位置（x, z, groundY）を原点として敷く
// （巨大都市の外側・都市群の帯の区画。js/env/03n-districts.js）
function buildCityStreets(city, netOverride) {
  const net = netOverride || cityStreetNetwork(city);
  const positions = [], normals = [], indices = [];
  let vi = 0;
  // 橋の構造を作るための、街路ごとの断面の列（橋の無い街路は null）
  const bridgeRows = [];

  net.streets.forEach((st, lineNo) => {
    const w = st.halfW;
    const pts = st.pts;
    // 点ごとの幅方向（進む向きの左）。前後の点から向きを取る
    const smp = [];
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const ox = pts[i].x, oz = pts[i].z;
      const ground = terrainSurfaceHeightAt(city.x + ox, city.z + oz);
      const wet = cityFootprintWet(city.x + ox, city.z + oz, 0, 0, ground);
      const water = wet ? Math.max(worldWaterSurfaceAt(city.x + ox, city.z + oz) || 0, 0) : 0;
      smp.push({ ox, oz, px: -tz, pz: tx, ground, wet, water, s, prof: -Infinity, cut: false });
    }
    // **川を渡るところは橋にする。** 両側に陸がある水の区間だけ（線の端が水の中なら、
    // そこは街の外の川岸なので、以前と同じく舗装を切る）。道路の橋と同じく、
    // 桁は水面+CITY_BRIDGE_CLEARANCE_M、両岸は勾配 CITY_BRIDGE_RAMP_SLOPE でのぼる。
    const spans = [];
    for (let i = 0; i < smp.length;) {
      if (!smp[i].wet) { i++; continue; }
      let j = i;
      let waterY = 0;
      while (j < smp.length && smp[j].wet) { waterY = Math.max(waterY, smp[j].water); j++; }
      // 橋を架けるのは大通りと、街路3本に1本だけ。全部に架けると150〜230mおきに橋が並ぶ。
      // **川を横切る街路だけ**に架ける。川に沿って走る街路は、川の上を何百mも縦に渡っていた。
      // 水の区間の真ん中から、街路と直角の向きへ区間の半分だけ出てみて、両方とも水なら
      // 「川はこの街路の向きより直角の向きに広い」＝この街路は川を横切っている。
      const runLen = (j < smp.length ? smp[j].s : smp[smp.length - 1].s) - (i > 0 ? smp[i - 1].s : 0);
      let crosses = false;
      if (i > 0 && j < smp.length && (st.major || lineNo % CITY_BRIDGE_EVERY === 0) && runLen <= CITY_BRIDGE_MAX_M) {
        const m = smp[(i + j - 1) >> 1];
        const d = runLen * 0.5;
        const ax = city.x + m.ox + m.px * d, az = city.z + m.oz + m.pz * d;
        const bx = city.x + m.ox - m.px * d, bz = city.z + m.oz - m.pz * d;
        crosses = cityFootprintWet(ax, az, 0, 0, terrainSurfaceHeightAt(ax, az))
          && cityFootprintWet(bx, bz, 0, 0, terrainSurfaceHeightAt(bx, bz));
      }
      if (!crosses) {
        for (let k = i; k < j; k++) smp[k].cut = true;
      } else {
        const deckY = waterY + CITY_BRIDGE_CLEARANCE_M;
        const s1 = smp[i - 1].s, s2 = smp[j].s;
        for (const q of smp) {
          let prof;
          if (q.s < s1) prof = deckY - (s1 - q.s) * CITY_BRIDGE_RAMP_SLOPE;
          else if (q.s > s2) prof = deckY - (q.s - s2) * CITY_BRIDGE_RAMP_SLOPE;
          else prof = deckY;
          if (prof > q.prof) q.prof = prof;
        }
        spans.push({ s1, s2 });
      }
      i = j;
    }
    let prev = -1; // 直前の点の頂点番号（切ったところなら -1）
    const lineRows = [];
    for (const q of smp) {
      if (q.cut) { prev = -1; lineRows.push(null); continue; }
      const yW = Math.max(q.ground + CITY_STREET_LIFT_M, q.prof); // 世界の高さ
      const y = yW - city.groundY;
      positions.push(q.ox + q.px * w, y, q.oz + q.pz * w);
      positions.push(q.ox - q.px * w, y, q.oz - q.pz * w);
      normals.push(0, 1, 0, 0, 1, 0);
      // 左（進む向きの左）→右の順に積んでいるので、この巻き順で上を向く
      if (prev >= 0) {
        const a = prev, c = a + 1, d = vi, e = vi + 1;
        indices.push(a, d, c, c, d, e);
      }
      prev = vi;
      vi += 2;
      lineRows.push({
        x: city.x + q.ox, z: city.z + q.oz,
        lx: city.x + q.ox + q.px * w, lz: city.z + q.oz + q.pz * w,
        rx: city.x + q.ox - q.px * w, rz: city.z + q.oz - q.pz * w,
        yl: yW, yr: yW, gl: q.ground, gr: q.ground, s: q.s, prof: q.prof,
      });
    }
    bridgeRows.push(spans.length ? { rows: lineRows, spans } : null);
  });
  if (!indices.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setIndex(vi > 65000
    ? new THREE.BufferAttribute(new Uint32Array(indices), 1)
    : new THREE.BufferAttribute(new Uint16Array(indices), 1));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, EnvState.streetMaterial);
  // 橋の構造（桁・欄干・橋脚・擁壁）。道路の橋と同じ作り（03i-roads.js）を街路ごとに作ってまとめる
  if (typeof buildBridgeStructure === 'function') {
    for (const line of bridgeRows) {
      if (!line) continue;
      const spans = line.spans.map((sp) => ({ s0: -Infinity, s1: sp.s1, s2: sp.s2, s3: Infinity }));
      // 切ったところ（null）で列を分けて渡す
      let seg = [];
      const flush = () => {
        if (seg.length > 1) {
          const br = buildBridgeStructure(seg, spans, city.x, city.groundY, city.z);
          if (br) { br.position.set(0, 0, 0); br.updateMatrix(); mesh.add(br); }
        }
        seg = [];
      };
      for (const r of line.rows) { if (r) seg.push(r); else flush(); }
      flush();
    }
  }
  return mesh;
}

// 夜になったら街の灯りを点ける（03-sky.js から dayFactor を受け取る）
function updatePlacesForDaylight(dayFactor) {
  const v = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
  if (typeof updatePortsForDaylight === 'function') updatePortsForDaylight(dayFactor);
  if (typeof updateDistrictsForDaylight === 'function') updateDistrictsForDaylight(dayFactor);
  if (!EnvState.builtCities) return;
  for (const entry of EnvState.builtCities.values()) {
    entry.lights.material.opacity = v;
    entry.lights.visible = v > 0.01;
    // 夜、建物が光の中の黒い塊に見えないよう、窓明かりぶんだけ自発光させる
    entry.buildings.material.emissive.setRGB(v * 0.10, v * 0.072, v * 0.042);
  }
}

// --- 地名ラベル -------------------------------------------------------------

// キャンバスに文字を描いてスプライト化する。縁取りを付けて空にも地面にも埋もれないようにする。
function makeLabelSprite(text, color, fontPx) {
  const pad = 16;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `bold ${fontPx}px "Helvetica Neue", Arial, sans-serif`;
  const w = Math.ceil(measure.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontPx}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(4, fontPx * 0.14);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false,
  }));
  // **深度テストを切っただけでは前に出ない**。半透明はあとから描いたほうが上に乗るので、
  // 番号を振っていないと（＝0）海や雲底より先に描かれて、そのまま塗りつぶされる
  // ——「海の上や雲の中で地名が消える」の正体がこれだった（ENV_ORDER 参照）。
  sprite.renderOrder = ENV_ORDER.label;
  sprite.userData.aspect = w / h;
  return sprite;
}

function countryHex(id) {
  const c = worldCountryById(id);
  return '#' + (c ? c.tint : 0xffffff).toString(16).padStart(6, '0');
}

// ラベルは「どこに何を出すか」の一覧だけ先に作り、
// スプライト本体（キャンバス1枚ずつ）は近づいたときに初めて作る。
function initPlaceLabels() {
  EnvState.labelGroup = new THREE.Group();
  EnvState.scene.add(EnvState.labelGroup);
  EnvState.labels = [];

  const add = (kind, text, color, x, y, z, scale) => {
    EnvState.labels.push({ kind, text, color, x, y, z, scale: scale || 1, sprite: null });
  };

  for (const country of WORLD_COUNTRIES) {
    const cities = WORLD_CITIES.filter((c) => c.country === country.id);
    if (!cities.length) continue;
    const cx = cities.reduce((s, c) => s + c.x, 0) / cities.length;
    const cz = cities.reduce((s, c) => s + c.z, 0) / cities.length;
    add('country', country.nameLatin.toUpperCase(), countryHex(country.id),
      cx, worldHeightAt(cx, cz) + 14000, cz);
  }

  for (const range of WORLD_RANGES) {
    add('range', range.nameLatin, '#d8dde3', range.cx, worldHeightAt(range.cx, range.cz) + 3200, range.cz);
  }

  for (const city of WORLD_CITIES) {
    add('city', city.nameLatin, city.capital ? '#ffffff' : countryHex(city.country),
      city.x, city.groundY + 900 + city.size * 900, city.z, city.capital ? 1.3 : 1);
  }

  for (const ap of WORLD_AIRPORTS) {
    add('airport', ap.id, '#7fd4ff', ap.x, ap.elevationM + 620, ap.z);
  }

  // 山の名前と標高。**頂のすぐ上に置く**（山脈の札は山脈の中心にあるので別物）。
  // 標高を併記するのは、飛んでいるときに「この尾根はいくつか」が要るから。
  for (const peak of WORLD_PEAKS) {
    add('peak', peak.nameLatin + '  ' + peak.elevationM.toLocaleString() + 'm', '#e6e2d6',
      peak.x, peak.elevationM + 360, peak.z);
  }

  for (const lake of WORLD_LAKES) {
    add('water', lake.nameLatin, '#9fd8ee', lake.x, lake.level + 500, lake.z);
  }

  // 川の名前は経路の真ん中に置く
  for (const river of WORLD_RIVERS) {
    const m = river.points[Math.floor(river.points.length / 2)];
    add('water', river.nameLatin, '#9fd8ee', m.x, m.h + 500, m.z);
  }

  EnvState.labelGroup.visible = EnvState.env.labelsVisible !== false;
}

// --- 近くの峰 -------------------------------------------------------------------
//
// 「近くを飛んでいる時は、小さめだけど明らかに峰のある山は名前を表示して（標高2000m以上）」。
// 名前付きの山（WORLD_PEAKS）は山脈ごとに突出度の大きいものを最大6座、22km以上離して
// 選んであるので、そのあいだの2,000〜3,000m級の峰には名前が無い。遠くから見る分には
// それでいい（全部に札を付けると上空が札だらけになる）が、近くを飛ぶと「この尖った山は
// 何か」が知りたくなる。
//
// **世界の生成時には作らない。** 札は近くでしか出さないので、カメラのまわり48km四方だけを
// そのつど探す（世界全体で探すと起動が0.5秒近く延びる）。
//   ・2kmの格子（世界座標にそろえてあるので、どこから来ても同じ峰が見つかる）で
//     8近傍より高い点を拾い、山登りで頂へ寄せる
//   ・標高2,000m以上、かつ半径1.5kmの輪のどこよりも150m以上高い＝**尾根の肩ではなく峰**
//   ・名前付きの山から6km以内と、ほかの小さな峰から3km以内（低いほう）は捨てる
// 名前は頂の位置から作る乱数で決めるので、何度来ても同じ名前になる。
const MINOR_PEAK_MIN_M = 2000;
const MINOR_PEAK_GRID_M = 2000;
const MINOR_PEAK_SCAN_HALF_M = 24000;
const MINOR_PEAK_RESCAN_M = 8000;
const MINOR_PEAK_RING_M = 1500;
const MINOR_PEAK_RISE_M = 150;       // 輪のどこよりもこれだけ高ければ「峰」
const MINOR_PEAK_MAJOR_GAP_M = 6000;
const MINOR_PEAK_GAP_M = 3000;

let _minorPeakAt = null;
const _minorPeakLabels = new Map();   // key -> ラベル（EnvState.labels と同じ形）
let _minorPeakUsedNames = null;

function minorPeakClimb(x, z) {
  let bx = x, bz = z, bh = worldHeightAt(x, z);
  let step = MINOR_PEAK_GRID_M * 0.5;
  for (let pass = 0; pass < 6; pass++) {
    for (let guard = 0; guard < 20; guard++) {
      let moved = false;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const nx = bx + Math.cos(a) * step, nz = bz + Math.sin(a) * step;
        const nh = worldHeightAt(nx, nz);
        if (nh > bh) { bx = nx; bz = nz; bh = nh; moved = true; }
      }
      if (!moved) break;
    }
    step *= 0.5;
  }
  return { x: bx, z: bz, h: bh };
}

function findMinorPeaksAround(cx, cz) {
  const g = MINOR_PEAK_GRID_M;
  const i0 = Math.floor((cx - MINOR_PEAK_SCAN_HALF_M) / g) - 1;
  const j0 = Math.floor((cz - MINOR_PEAK_SCAN_HALF_M) / g) - 1;
  const n = Math.ceil((2 * MINOR_PEAK_SCAN_HALF_M) / g) + 3;
  const hs = new Float32Array(n * n);
  let top = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const h = worldHeightAt((i0 + i) * g, (j0 + j) * g);
      hs[j * n + i] = h;
      if (h > top) top = h;
    }
  }
  if (top < MINOR_PEAK_MIN_M) return [];

  const found = [];
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const h = hs[j * n + i];
      if (h < MINOR_PEAK_MIN_M - 300) continue;   // 山登りで300m以上は伸びない
      let isMax = true;
      for (let dj = -1; dj <= 1 && isMax; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((di || dj) && hs[(j + dj) * n + i + di] > h) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      const t = minorPeakClimb((i0 + i) * g, (j0 + j) * g);
      if (t.h < MINOR_PEAK_MIN_M) continue;
      let ring = -Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        ring = Math.max(ring, worldHeightAt(t.x + Math.cos(a) * MINOR_PEAK_RING_M,
          t.z + Math.sin(a) * MINOR_PEAK_RING_M));
      }
      if (t.h - ring < MINOR_PEAK_RISE_M) continue;
      let nearMajor = false;
      for (const p of WORLD_PEAKS) {
        if (Math.hypot(p.x - t.x, p.z - t.z) < MINOR_PEAK_MAJOR_GAP_M) { nearMajor = true; break; }
      }
      if (nearMajor) continue;
      found.push(t);
    }
  }
  // 近いものどうしは高いほうを残す
  found.sort((a, b) => b.h - a.h);
  const kept = [];
  for (const t of found) {
    if (kept.every((k) => Math.hypot(k.x - t.x, k.z - t.z) >= MINOR_PEAK_GAP_M)) kept.push(t);
  }
  return kept;
}

function minorPeakName(t) {
  if (!_minorPeakUsedNames) {
    // 名前付きの山と同じ名前にはしない
    _minorPeakUsedNames = new Set(WORLD_PEAKS.map((p) => p.nameLatin.replace(/^Mt\. /, '')));
  }
  const country = worldCountryById(worldNearestCountryId(t.x, t.z));
  const rand = worldRng('minorpeak:' + Math.round(t.x / 250) + ':' + Math.round(t.z / 250));
  // 名前付きの山とだけ重ならなければいい（小さな峰どうしは、見える範囲がほとんど重ならない）
  const used = new Set(_minorPeakUsedNames);
  return worldMakePlaceName(country ? country.nameStyle : 'vestarian', rand, used);
}

function refreshMinorPeaks() {
  const cam = EnvState.camera.position;
  _minorPeakAt = { x: cam.x, z: cam.z };
  const peaks = findMinorPeaksAround(cam.x, cam.z);
  const keep = new Set();
  for (const t of peaks) {
    // 頂の位置は格子から山登りで決まるので、どこから探しても同じ点に落ちる。
    // 念のため50mで丸めて同じ峰とみなす。
    const key = Math.round(t.x / 50) + ':' + Math.round(t.z / 50);
    keep.add(key);
    if (_minorPeakLabels.has(key)) continue;
    const nm = minorPeakName(t);
    _minorPeakLabels.set(key, {
      kind: 'minorPeak', text: 'Mt. ' + nm.nameLatin + '  ' + Math.round(t.h).toLocaleString() + 'm',
      color: '#cfc9b8', x: t.x, y: t.h + 160, z: t.z, scale: 1, sprite: null,
    });
  }
  for (const [key, entry] of _minorPeakLabels) {
    if (keep.has(key)) continue;
    if (entry.sprite) {
      EnvState.labelGroup.remove(entry.sprite);
      entry.sprite.material.map.dispose();
      entry.sprite.material.dispose();
    }
    _minorPeakLabels.delete(key);
  }
}

// ラベルを「画面上で一定の大きさ」に保ち、遠いものは薄くして消す。
// スプライトは常にカメラを向くので向きの調整は要らない。
function updatePlaceLabels() {
  if (!EnvState.labelGroup || !EnvState.labelGroup.visible) return;

  {
    const c = EnvState.camera.position;
    if (!_minorPeakAt || Math.hypot(c.x - _minorPeakAt.x, c.z - _minorPeakAt.z) > MINOR_PEAK_RESCAN_M) {
      refreshMinorPeaks();
    }
  }

  const cam = EnvState.camera;
  const vFov = THREE.MathUtils.degToRad(cam.fov);
  const viewH = EnvState.renderer.domElement.clientHeight || 1;
  const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;

  for (const entry of placeLabelEntries()) {
    const k = LABEL_KINDS[entry.kind];
    const dx = entry.x - cx, dy = entry.y - cy, dz = entry.z - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    let opacity = dist > k.fadeStart ? 1 - (dist - k.fadeStart) / (k.fadeEnd - k.fadeStart) : 1;
    if (opacity < k.minOpacity) opacity = k.minOpacity;
    if (opacity <= 0.02) {
      if (entry.sprite) entry.sprite.visible = false;
      continue;
    }

    // 初めて視界に入ったときにスプライトを作る（130都市＋82空港ぶんを最初から
    // 用意すると、使いもしないキャンバステクスチャを大量に抱えることになる）
    if (!entry.sprite) {
      entry.sprite = makeLabelSprite(entry.text, entry.color, k.fontPx);
      entry.sprite.position.set(entry.x, entry.y, entry.z);
      EnvState.labelGroup.add(entry.sprite);
    }

    // 画面上で screenPx ピクセルになるワールドサイズを逆算する
    const height = ((2 * Math.tan(vFov / 2) * dist) / viewH) * k.screenPx * entry.scale;
    entry.sprite.scale.set(height * entry.sprite.userData.aspect, height, 1);
    entry.sprite.material.opacity = opacity > 1 ? 1 : opacity;
    entry.sprite.visible = true;
  }
}

// 決まった地名と、いまカメラのまわりで見つけた小さな峰
function* placeLabelEntries() {
  yield* EnvState.labels;
  yield* _minorPeakLabels.values();
}

function setLabelsVisible(visible) {
  EnvState.env.labelsVisible = visible;
  if (EnvState.labelGroup) EnvState.labelGroup.visible = visible;
}
