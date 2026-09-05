// 03d-places.js — 都市（建物・夜景の灯り）と地名ラベル
//
// 都市は js/env/03b-world.js の WORLD_CITIES から手続き的に生成する。
// 建物の配置は都市IDから作った決定論的な擬似乱数で決めるので、
// 何度読み込んでも同じ街並みになる（＝空港と同じく「固定のマップ」として扱える）。

const CITY_LIGHT_Y = 14;

// 建物の色。地形と同じく、sRGB出力で持ち上がるぶんを見越して暗めに置く。
const CITY_BUILDING_COLORS = [0x43413c, 0x4b4740, 0x3f4247, 0x504a43, 0x3a3d41];

// ラベルは遠すぎると邪魔になるので、この距離を超えたら消す
const LABEL_FADE_START_M = 90000;
const LABEL_FADE_END_M = 260000;

// 都市IDから決まる擬似乱数。文字列をハッシュして線形合同法の種にする。
function placesRng(str) {
  let s = 2166136261;
  for (let i = 0; i < str.length; i++) {
    s ^= str.charCodeAt(i);
    s = Math.imul(s, 16777619);
  }
  s = s >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

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
    const tri = [0, 1, 2, 0, 2, 3];
    // 面ごとに明るさを変えると、単色でも立体感が出る
    const shade = ny === 1 ? 1.15 : (nx !== 0 ? 0.82 : 0.95);
    for (const k of tri) {
      positions.push(q[k][0], q[k][1], q[k][2]);
      normals.push(nx, ny, nz);
      colors.push(r * shade, g * shade, b * shade);
    }
  }
}

// --- 都市 -------------------------------------------------------------------

function initPlaces() {
  EnvState.cityGroup = new THREE.Group();
  EnvState.scene.add(EnvState.cityGroup);

  const positions = [], normals = [], colors = [];
  const lightPositions = [], lightColors = [];

  for (const city of WORLD_CITIES) {
    buildCity(city, positions, normals, colors, lightPositions, lightColors);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeBoundingSphere();

  EnvState.cityBuildings = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, emissive: 0x000000,
  }));
  EnvState.cityBuildings.matrixAutoUpdate = false;
  EnvState.cityGroup.add(EnvState.cityBuildings);

  // 夜景。空港の灯火と同じく、頂点カラー付きの1つのPointsにまとめる。
  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lightPositions), 3));
  lightGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lightColors), 3));
  lightGeo.computeBoundingSphere();

  EnvState.cityLights = new THREE.Points(lightGeo, new THREE.PointsMaterial({
    size: 26, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true,
  }));
  EnvState.cityLights.matrixAutoUpdate = false;
  EnvState.cityGroup.add(EnvState.cityLights);

  initPlaceLabels();
}

// 都市1つぶんの建物と夜景の灯りを積む
function buildCity(city, positions, normals, colors, lightPositions, lightColors) {
  const rand = placesRng(city.id);
  // 建物が建つ範囲は世界側（03b-world.js）が持っている。
  // 地形もこの範囲に合わせて均されているので、定義を二重に持たない。
  const radius = city.builtRadiusM;
  const buildingCount = Math.round(90 + city.size * 430);

  for (let i = 0; i < buildingCount; i++) {
    // 中心ほど密になるよう、半径方向の分布に偏りを付ける
    const t = Math.pow(rand(), 0.65);
    const ang = rand() * Math.PI * 2;
    const dist = t * radius;
    const bx = city.x + Math.cos(ang) * dist;
    const bz = city.z + Math.sin(ang) * dist;

    const ground = worldHeightAt(bx, bz);
    if (ground <= 0.5) continue; // 海にはみ出したぶんは建てない

    // 中心に近いほど高層になる
    const centerness = 1 - t;
    const h = (7 + rand() * 22) * (0.6 + city.size * 1.5) * (0.45 + centerness * 1.5);
    const fw = 11 + rand() * 26;
    const fd = 11 + rand() * 26;

    const hex = CITY_BUILDING_COLORS[(rand() * CITY_BUILDING_COLORS.length) | 0];
    const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;

    // 斜面で建物が浮かないよう、少し地面へ埋める
    pushBox(positions, normals, colors, bx, ground - 3, bz, fw, h + 3, fd, r, g, b);

    // 夜景の灯り。屋上と足元にひとつずつ置く。
    for (let k = 0; k < 2; k++) {
      const warm = 0.70 + rand() * 0.30;
      lightPositions.push(bx, ground + (k === 0 ? h * 0.9 : CITY_LIGHT_Y * 0.4), bz);
      lightColors.push(warm, warm * 0.66, warm * 0.34);
    }
  }

  // 街の外側にも街灯をまばらに置いて、郊外のにじみを作る
  const outer = Math.round(buildingCount * 0.9);
  for (let i = 0; i < outer; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = radius * (1 + rand() * 0.9);
    const bx = city.x + Math.cos(ang) * dist;
    const bz = city.z + Math.sin(ang) * dist;
    const ground = worldHeightAt(bx, bz);
    if (ground <= 0.5) continue;
    const warm = 0.5 + rand() * 0.3;
    lightPositions.push(bx, ground + CITY_LIGHT_Y, bz);
    lightColors.push(warm, warm * 0.62, warm * 0.3);
  }
}

// 夜になったら街の灯りを点ける（03-sky.js から dayFactor を受け取る）
function updatePlacesForDaylight(dayFactor) {
  if (!EnvState.cityLights) return;
  const v = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
  EnvState.cityLights.material.opacity = v;
  EnvState.cityLights.visible = v > 0.01;

  // 夜、建物が光の中の黒い塊に見えないよう、窓明かりぶんだけ自発光させる
  if (EnvState.cityBuildings) {
    EnvState.cityBuildings.material.emissive.setRGB(v * 0.10, v * 0.072, v * 0.042);
  }
}

// --- 地名ラベル -------------------------------------------------------------

// キャンバスに文字を描いてスプライト化する。縁取りを付けて空にも地面にも埋もれないようにする。
function makeLabelSprite(text, opts) {
  const fontPx = opts.fontPx || 44;
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
  ctx.fillStyle = opts.color || '#ffffff';
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false,
  });
  const sprite = new THREE.Sprite(mat);

  // sizeAttenuation=false（既定の Sprite は距離で縮む）を使わず、
  // 画面上で一定の大きさにしたいのでスケールを毎フレーム調整する方式にする。
  sprite.userData.aspect = w / h;
  sprite.userData.screenPx = opts.screenPx || 20;
  return sprite;
}

function initPlaceLabels() {
  EnvState.labelGroup = new THREE.Group();
  EnvState.scene.add(EnvState.labelGroup);
  EnvState.labels = [];

  const add = (sprite, x, y, z, kind) => {
    sprite.position.set(x, y, z);
    EnvState.labelGroup.add(sprite);
    EnvState.labels.push({ sprite, kind });
  };

  // 国名（いちばん大きく、首都の少し上に置く）
  for (const country of WORLD_COUNTRIES) {
    const cities = WORLD_CITIES.filter((c) => c.country === country.id);
    if (cities.length === 0) continue;
    const cx = cities.reduce((s, c) => s + c.x, 0) / cities.length;
    const cz = cities.reduce((s, c) => s + c.z, 0) / cities.length;
    const hex = '#' + country.tint.toString(16).padStart(6, '0');
    const sprite = makeLabelSprite(country.nameLatin.toUpperCase(), { color: hex, fontPx: 52, screenPx: 30 });
    add(sprite, cx, worldHeightAt(cx, cz) + 5200, cz, 'country');
  }

  // 山脈名
  for (const range of WORLD_RANGES) {
    const sprite = makeLabelSprite(range.nameLatin, { color: '#d8dde3', fontPx: 40, screenPx: 17 });
    add(sprite, range.cx, worldHeightAt(range.cx, range.cz) + 2600, range.cz, 'range');
  }

  // 都市名（首都は少し大きく）
  for (const city of WORLD_CITIES) {
    const country = worldCountryById(city.country);
    const hex = '#' + (country ? country.tint : 0xffffff).toString(16).padStart(6, '0');
    const sprite = makeLabelSprite(city.nameLatin, {
      color: city.capital ? '#ffffff' : hex,
      fontPx: city.capital ? 46 : 40,
      screenPx: city.capital ? 22 : 17,
    });
    add(sprite, city.x, city.groundY + 900 + city.size * 900, city.z, 'city');
  }

  // 空港（4レターコード）
  for (const ap of WORLD_AIRPORTS) {
    const sprite = makeLabelSprite(ap.id, { color: '#7fd4ff', fontPx: 40, screenPx: 16 });
    add(sprite, ap.x, ap.elevationM + 620, ap.z, 'airport');
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

  for (const entry of EnvState.labels) {
    const s = entry.sprite;
    const dist = cam.position.distanceTo(s.position);

    // 画面上で screenPx ピクセルになるワールドサイズを逆算する
    const worldPerPx = (2 * Math.tan(vFov / 2) * dist) / viewH;
    const height = worldPerPx * s.userData.screenPx;
    s.scale.set(height * s.userData.aspect, height, 1);

    let opacity = 1;
    if (dist > LABEL_FADE_START_M) {
      opacity = 1 - (dist - LABEL_FADE_START_M) / (LABEL_FADE_END_M - LABEL_FADE_START_M);
    }
    // 国名は遠くからでも読めたほうが地図として使いやすいので、フェードを緩める
    if (entry.kind === 'country') opacity = Math.max(opacity, 0.35);
    s.material.opacity = THREE.MathUtils.clamp(opacity, 0, 1);
    s.visible = s.material.opacity > 0.02;
  }
}

function setLabelsVisible(visible) {
  EnvState.env.labelsVisible = visible;
  if (EnvState.labelGroup) EnvState.labelGroup.visible = visible;
}
