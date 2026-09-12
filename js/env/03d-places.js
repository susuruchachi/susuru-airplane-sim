// 03d-places.js — 都市（建物・夜景の灯り）と地名ラベル
//
// 都市は js/env/03b-world.js の WORLD_CITIES から手続き的に生成する。
// 建物の配置は都市IDから作った決定論的な擬似乱数で決めるので、
// 何度読み込んでも同じ街並みになる（＝空港と同じく「固定のマップ」として扱える）。
//
// 世界には130の都市があるので、地形や空港と同じく **カメラの周りだけ** 建てて、
// 離れたら片付ける。地名ラベルも近づいてから作る（作った後はキャッシュする）。

const CITY_ACTIVE_RADIUS = 90000;
const CITY_LIGHT_Y = 14;

// 建物の色。地形と同じく、sRGB出力で持ち上がるぶんを見越して暗めに置く。
const CITY_BUILDING_COLORS = [0x43413c, 0x4b4740, 0x3f4247, 0x504a43, 0x3a3d41];

// ラベルの種類ごとの見え方。国名は遠くからでも読めたほうが地図として使いやすい。
const LABEL_KINDS = {
  country: { fadeStart: 420000, fadeEnd: 1100000, minOpacity: 0.35, screenPx: 30, fontPx: 52 },
  range: { fadeStart: 150000, fadeEnd: 420000, minOpacity: 0, screenPx: 17, fontPx: 40 },
  city: { fadeStart: 70000, fadeEnd: 240000, minOpacity: 0, screenPx: 17, fontPx: 40 },
  airport: { fadeStart: 45000, fadeEnd: 160000, minOpacity: 0, screenPx: 16, fontPx: 40 },
  water: { fadeStart: 60000, fadeEnd: 200000, minOpacity: 0, screenPx: 15, fontPx: 38 },
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

  initPlaceLabels();
  refreshCities();
}

// カメラの周りにあるべき都市を揃える
function refreshCities() {
  if (!EnvState.builtCities) return; // 地形の初期化のほうが先に走るため
  const cam = EnvState.camera.position;
  for (const city of WORLD_CITIES) {
    const near = Math.hypot(city.x - cam.x, city.z - cam.z) < CITY_ACTIVE_RADIUS;
    const built = EnvState.builtCities.has(city.id);
    if (near && !built) buildCityInstance(city);
    else if (!near && built) disposeCityInstance(city.id);
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
  EnvState.builtCities.delete(id);
}

// 都市1つぶんの建物メッシュと夜景の灯りを作る。
// 頂点は街の中心からのローカル座標で持ち、位置はメッシュ側に入れる（遠方でのfloat32対策）。
function buildCityInstance(city) {
  const rand = placesRng(city.id);
  const radius = city.builtRadiusM;
  const buildingCount = Math.round(90 + city.size * 430);

  const positions = [], normals = [], colors = [];
  const lightPositions = [], lightColors = [];

  for (let i = 0; i < buildingCount; i++) {
    // 中心ほど密になるよう、半径方向の分布に偏りを付ける
    const t = Math.pow(rand(), 0.65);
    const ang = rand() * Math.PI * 2;
    const dist = t * radius;
    const ox = Math.cos(ang) * dist, oz = Math.sin(ang) * dist;

    // 地形メッシュの上の高さを使う。worldHeightAt の値だと、
    // 地形が格子点の間を三角形で結んでいるぶんだけ建物が浮いたり埋まったりする。
    const ground = terrainSurfaceHeightAt(city.x + ox, city.z + oz);
    if (ground <= 0.5) continue; // 海にはみ出したぶんは建てない
    const localY = ground - city.groundY;

    // 中心に近いほど高層になる
    const h = (7 + rand() * 22) * (0.6 + city.size * 1.5) * (0.45 + (1 - t) * 1.5);
    const fw = 11 + rand() * 26, fd = 11 + rand() * 26;

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

  EnvState.builtCities.set(city.id, { city, buildings, lights });
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
