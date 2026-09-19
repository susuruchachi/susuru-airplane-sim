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

// 建物の色。地形と同じく、sRGB出力で持ち上がるぶんを見越して暗めに置く。
const CITY_BUILDING_COLORS = [0x43413c, 0x4b4740, 0x3f4247, 0x504a43, 0x3a3d41];

// ラベルの種類ごとの見え方。国名は遠くからでも読めたほうが地図として使いやすい。
const LABEL_KINDS = {
  country: { fadeStart: 420000, fadeEnd: 1100000, minOpacity: 0.35, screenPx: 30, fontPx: 52 },
  range: { fadeStart: 150000, fadeEnd: 420000, minOpacity: 0, screenPx: 17, fontPx: 40 },
  city: { fadeStart: 70000, fadeEnd: 240000, minOpacity: 0, screenPx: 17, fontPx: 40 },
  airport: { fadeStart: 45000, fadeEnd: 160000, minOpacity: 0, screenPx: 16, fontPx: 40 },
  water: { fadeStart: 60000, fadeEnd: 200000, minOpacity: 0, screenPx: 15, fontPx: 38 },
  peak: { fadeStart: 90000, fadeEnd: 280000, minOpacity: 0, screenPx: 16, fontPx: 38 },
};

// 都市IDから決まる擬似乱数（世界側と同じ実装を使う）
const placesRng = worldRng;

// 直方体1つぶんの頂点・法線・色を配列へ積む（都市ごとに1メッシュへまとめるため）
function pushBox(positions, normals, colors, cx, cy, cz, sx, sy, sz, r, g, b) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy, y1 = cy + sy;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;

  // [法線, その面の4隅] の順に並べる
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
    for (const k of [0, 1, 2, 0, 2, 3]) {
      positions.push(q[k][0], q[k][1], q[k][2]);
      normals.push(nx, ny, nz);
      colors.push(r * shade, g * shade, b * shade);
    }
  }
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

  initPlaceLabels();
  refreshCities();
}

// 1フレームに建てる街の数。1都市ぶんの生成に30〜42msかかる（建物3.7万頂点＋
// 街路7,800頂点）ので、圏内に入った街をその場で全部建てると、街に近づくたびに
// 100ms超の引っかかりが出る。地形タイルと同じくキューに積んでフレームを分ける。
const CITY_BUILD_BUDGET = 1;
let _cityWork = [];

// カメラの周りにあるべき都市を揃える。片付けはその場で、建てるのはキューへ。
function refreshCities() {
  if (!EnvState.builtCities) return; // 地形の初期化のほうが先に走るため
  const cam = EnvState.camera.position;
  const R = cityActiveRadius();
  _cityWork = [];
  for (const city of WORLD_CITIES) {
    const d = Math.hypot(city.x - cam.x, city.z - cam.z);
    const built = EnvState.builtCities.has(city.id);
    if (d < R && !built) _cityWork.push({ city, d });
    else if (d >= R && built) disposeCityInstance(city.id);
  }
  // 近い街から建てる（見ている場所ほど早く出てほしい）
  _cityWork.sort((a, b) => a.d - b.d);
}

function updateCities() {
  let budget = CITY_BUILD_BUDGET;
  while (budget > 0 && _cityWork.length > 0) {
    const w = _cityWork.shift();
    if (!EnvState.builtCities.has(w.city.id)) buildCityInstance(w.city);
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
  }
  EnvState.builtCities.delete(id);
}

// 都市1つぶんの建物メッシュと夜景の灯りを作る。
// 頂点は街の中心からのローカル座標で持ち、位置はメッシュ側に入れる（遠方でのfloat32対策）。
function buildCityInstance(city) {
  const rand = placesRng(city.id);
  const radius = city.builtRadiusM;
  // 街区に収まるようになったぶん、軒数を増やす。以前（90+size*430＝167〜520軒）は
  // 半径3.5kmの街に230軒で、上空から見ると点が散らばっているだけだった。
  const buildingCount = Math.round(240 + city.size * 1100);

  const positions = [], normals = [], colors = [];
  const lightPositions = [], lightColors = [];

  const cosA = Math.cos(city.streetAngle), sinA = Math.sin(city.streetAngle);

  for (let i = 0; i < buildingCount; i++) {
    // 中心ほど密になるよう、半径方向の分布に偏りを付ける
    const t = Math.pow(rand(), 0.65);
    const ang = rand() * Math.PI * 2;
    const dist = t * radius;

    // 中心に近いほど高層になる
    const h = (7 + rand() * 22) * (0.6 + city.size * 1.5) * (0.45 + (1 - t) * 1.5);
    const fw = 11 + rand() * 26, fd = 11 + rand() * 26;

    // **街区の中へ寄せる。** 街路の上に来たものを弾く作りにすると、
    // 建物の間口（最大37m）ぶんの余白まで要るので街区の半分近くが使えなくなり、
    // 1都市あたりの建物が230軒から124軒まで減ってしまう。
    // 弾くのではなく、はみ出したぶんを街区の内側へ押し込む。
    // 街路の位置の決め方は世界側の worldCityStreetDist と同じ（街路は blockM の倍数）。
    const clear = CITY_STREET_HALF_W_M + CITY_STREET_CLEAR_M + Math.max(fw, fd) * 0.5;
    const block = city.blockM;
    const half = block * 0.5 - clear;
    if (half <= 0) continue;
    let u = Math.cos(ang) * dist * cosA + Math.sin(ang) * dist * sinA;
    let v = -Math.cos(ang) * dist * sinA + Math.sin(ang) * dist * cosA;
    const cu = (Math.floor(u / block) + 0.5) * block, cv = (Math.floor(v / block) + 0.5) * block;
    u = cu + worldClamp(u - cu, -half, half);
    v = cv + worldClamp(v - cv, -half, half);
    const ox = u * cosA - v * sinA, oz = u * sinA + v * cosA;

    // 地形メッシュの上の高さを使う。worldHeightAt の値だと、
    // 地形が格子点の間を三角形で結んでいるぶんだけ建物が浮いたり埋まったりする。
    const ground = terrainSurfaceHeightAt(city.x + ox, city.z + oz);
    if (ground <= 0.5) continue; // 海にはみ出したぶんは建てない
    const localY = ground - city.groundY;

    const hex = CITY_BUILDING_COLORS[(rand() * CITY_BUILDING_COLORS.length) | 0];
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;

    // 斜面で建物が浮かないよう、少し地面へ埋める
    pushBox(positions, normals, colors, ox, localY - 3, oz, fw, h + 3, fd, r, g, b);

    for (let k = 0; k < 2; k++) {
      const warm = 0.70 + rand() * 0.30;
      lightPositions.push(ox, localY + (k === 0 ? h * 0.9 : CITY_LIGHT_Y * 0.4), oz);
      lightColors.push(warm, warm * 0.66, warm * 0.34);
    }
  }

  // 街の外側にも街灯をまばらに置いて、郊外のにじみを作る
  for (let i = 0, n = Math.round(buildingCount * 0.9); i < n; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = radius * (1 + rand() * 0.9);
    const ox = Math.cos(ang) * dist, oz = Math.sin(ang) * dist;
    const ground = terrainSurfaceHeightAt(city.x + ox, city.z + oz);
    if (ground <= 0.5) continue;
    const warm = 0.5 + rand() * 0.3;
    lightPositions.push(ox, ground - city.groundY + CITY_LIGHT_Y, oz);
    lightColors.push(warm, warm * 0.62, warm * 0.3);
  }

  // 街路の舗装。建物と同じメッシュに混ぜてしまうと、夜に建物だけ発光させる
  // （updatePlacesForDaylight）ときに舗装まで光ってしまうので、別のメッシュにする。
  const streets = buildCityStreets(city);

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

  if (streets) {
    streets.position.copy(buildings.position);
    streets.matrixAutoUpdate = false;
    streets.updateMatrix();
    EnvState.cityGroup.add(streets);
  }

  EnvState.builtCities.set(city.id, { city, buildings, lights, streets });
}

// 街路の舗装。碁盤の目の線を市街地の円で切って、地形の上に帯として敷く。
//
// 街路の位置は世界側の worldCityStreetDist と同じ決め方（blockM の倍数）。
// 建物を建てない判定もそこを見ているので、舗装と建物がずれることはない。
//
// 地形は刻まない——街路の幅は14mで、いちばん細かいLODでも地形の頂点間隔は312m。
// 道路（03i-roads.js）と同じくデカールとして重ねる。
function buildCityStreets(city) {
  const R = city.builtRadiusM;
  const b = city.blockM;
  const w = CITY_STREET_HALF_W_M;
  const cosA = Math.cos(city.streetAngle), sinA = Math.sin(city.streetAngle);
  const kMax = Math.floor(R / b);

  const positions = [], normals = [], indices = [];
  let vi = 0;

  // 帯を地形なりに置くため、線に沿って刻んで高さを拾う
  const STEP = 90;
  // 街路の端をきれいな円で切ると、上空から見て街の輪郭がコンパスで描いた円になる。
  // 線ごとに長さをばらつかせて、外周をぎざぎざにする。
  const erand = placesRng('edge:' + city.id);
  const addStrip = (alongU) => {
    for (let k = -kMax; k <= kMax; k++) {
      const off = k * b;
      // 円で切る。線の中心からの弦の半分
      const rk = R * (0.80 + 0.20 * erand());
      const halfChord = Math.sqrt(Math.max(0, rk * rk - off * off))
        * (0.82 + 0.18 * erand());
      if (halfChord < STEP) continue;
      const n = Math.max(2, Math.round((2 * halfChord) / STEP));
      const first = vi;
      for (let i = 0; i <= n; i++) {
        const t = -halfChord + (2 * halfChord * i) / n;
        // alongU: 線が u 方向に走る（横は v 方向）
        const u = alongU ? t : off;
        const v = alongU ? off : t;
        const ox = u * cosA - v * sinA, oz = u * sinA + v * cosA;
        // 幅方向の単位ベクトル
        const px = alongU ? -sinA : cosA, pz = alongU ? cosA : sinA;
        const y = terrainSurfaceHeightAt(city.x + ox, city.z + oz) - city.groundY + CITY_STREET_LIFT_M;
        positions.push(ox + px * w, y, oz + pz * w);
        positions.push(ox - px * w, y, oz - pz * w);
        normals.push(0, 1, 0, 0, 1, 0);
        vi += 2;
      }
      // **巻き順は向きで入れ替える。** u方向とv方向では「進む向き×幅の向き」の
      // 手前・奥が逆になるので、同じ順で三角形を張ると片方が裏を向いて
      // 背面カリングで消える（実際、碁盤の目が一方向の縞にしか見えなかった）。
      for (let i = 0; i < n; i++) {
        const a = first + i * 2, c = a + 1, d = a + 2, e = a + 3;
        if (alongU) indices.push(a, d, c, c, d, e);
        else indices.push(a, c, d, c, e, d);
      }
    }
  };
  addStrip(true);
  addStrip(false);
  if (!indices.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setIndex(indices.length > 65000
    ? new THREE.BufferAttribute(new Uint32Array(indices), 1)
    : new THREE.BufferAttribute(new Uint16Array(indices), 1));
  geo.computeBoundingSphere();

  return new THREE.Mesh(geo, EnvState.streetMaterial);
}

// 夜になったら街の灯りを点ける（03-sky.js から dayFactor を受け取る）
function updatePlacesForDaylight(dayFactor) {
  const v = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
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

// ラベルを「画面上で一定の大きさ」に保ち、遠いものは薄くして消す。
// スプライトは常にカメラを向くので向きの調整は要らない。
function updatePlaceLabels() {
  if (!EnvState.labelGroup || !EnvState.labelGroup.visible) return;

  const cam = EnvState.camera;
  const vFov = THREE.MathUtils.degToRad(cam.fov);
  const viewH = EnvState.renderer.domElement.clientHeight || 1;
  const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;

  for (const entry of EnvState.labels) {
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

function setLabelsVisible(visible) {
  EnvState.env.labelsVisible = visible;
  if (EnvState.labelGroup) EnvState.labelGroup.visible = visible;
}
