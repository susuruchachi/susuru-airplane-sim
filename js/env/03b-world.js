// 03b-world.js — 世界の定義（地形の高さ関数・大陸・山脈・国・都市・空港）
//
// このファイルはTHREE.jsに一切依存しない純粋な計算だけで構成する。
// 地形メッシュ・海・都市・ミニマップはすべて worldHeightAt() を参照して作られるので、
// ここが「世界の唯一の正」になる。Node上でも読み込めるので、
// 「街が海に沈んでいないか」といった検証をブラウザ無しで回せる（tools/verify-world.js）。
//
// 座標系：ワールドの -Z が北、+X が東。原点は主大陸ヴェスタリアの首都アルヴィス付近。
// 単位はすべてメートル。

const WORLD_SEED = 20260905;
const WORLD_SIZE = 600000;      // 一辺600km
const WORLD_HALF = WORLD_SIZE / 2;

// --- 決定論的ノイズ ---------------------------------------------------------
// 乱数ではなくハッシュから作るので、何度読み込んでも同じ地形になる（＝空港の位置が固定できる）。

function worldHash2i(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ WORLD_SEED;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function worldLerp(a, b, t) { return a + (b - a) * t; }

// 0〜1に収めたうえで両端をなめらかにする
function worldSmooth01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// 格子点のハッシュ値を双一次補間する値ノイズ（0〜1）
function worldValueNoise(x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = worldSmooth01(x - x0), fz = worldSmooth01(z - z0);
  const n00 = worldHash2i(x0, z0), n10 = worldHash2i(x0 + 1, z0);
  const n01 = worldHash2i(x0, z0 + 1), n11 = worldHash2i(x0 + 1, z0 + 1);
  return worldLerp(worldLerp(n00, n10, fx), worldLerp(n01, n11, fx), fz);
}

// オクターブを重ねた起伏（0〜1）。値ノイズは格子に沿った縞が出やすいので、
// オクターブごとに座標を回転させて方向の偏りを崩している。
const _WFBM_COS = Math.cos(0.7), _WFBM_SIN = Math.sin(0.7);

function worldFbm(x, z, octaves) {
  let sum = 0, norm = 0, amp = 1, px = x, pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * worldValueNoise(px, pz);
    norm += amp;
    amp *= 0.5;
    const rx = px * _WFBM_COS - pz * _WFBM_SIN;
    const rz = px * _WFBM_SIN + pz * _WFBM_COS;
    px = rx * 2; pz = rz * 2;
  }
  return sum / norm;
}

// 尾根状のノイズ。|2n-1| を反転して二乗することで、稜線の鋭い山脈になる（0〜1）
function worldRidgedFbm(x, z, octaves) {
  let sum = 0, norm = 0, amp = 1, px = x, pz = z;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(worldValueNoise(px, pz) * 2 - 1);
    n *= n;
    sum += amp * n;
    norm += amp;
    amp *= 0.52;
    const rx = px * _WFBM_COS - pz * _WFBM_SIN;
    const rz = px * _WFBM_SIN + pz * _WFBM_COS;
    px = rx * 2.03; pz = rz * 2.03;
  }
  return sum / norm;
}

// 回転させた楕円の内側で1、外へ向かって0になる減衰（大陸・山脈の輪郭に使う）
function worldEllipseFalloff(x, z, e) {
  const dx = x - e.cx, dz = z - e.cz;
  const c = e._cos, s = e._sin;
  const lx = (dx * c + dz * s) / e.rx;
  const lz = (-dx * s + dz * c) / e.rz;
  const d = Math.sqrt(lx * lx + lz * lz);
  if (d >= 1) return 0;
  if (d <= e.inner) return 1;
  return worldSmooth01((1 - d) / (1 - e.inner));
}

function worldPrepEllipse(e) {
  const r = (e.rot || 0) * Math.PI / 180;
  e._cos = Math.cos(r);
  e._sin = Math.sin(r);
  if (e.inner === undefined) e.inner = 0.4;
  return e;
}

// --- 大陸・山脈 -------------------------------------------------------------

// 大陸のおおまかな形。ここに海岸線ノイズを足して最終的な陸/海を決める。
const WORLD_LANDMASSES = [
  // ヴェスタリア大陸（中央〜西の主大陸。原点はこの中）
  { cx: -40000, cz: -30000, rx: 210000, rz: 165000, rot: -12, weight: 1.0 },
  // 北へ伸びるノルドハイム半島（本土とは地峡でつながる）
  { cx: -95000, cz: -205000, rx: 122000, rz: 118000, rot: 20, weight: 0.96 },
  // 東のカルディス大陸（ヴェスタリアとは海で隔てられている）
  { cx: 200000, cz: -50000, rx: 128000, rz: 148000, rot: 8, weight: 0.96 },
  // 南のメリディア
  { cx: -55000, cz: 178000, rx: 152000, rz: 104000, rot: -6, weight: 0.96 },
  // セラフィナ諸島（南東の島々）
  { cx: 172000, cz: 150000, rx: 40000, rz: 34000, rot: 15, weight: 0.70 },
  { cx: 224000, cz: 192000, rx: 25000, rz: 21000, rot: -20, weight: 0.66 },
  { cx: 132000, cz: 196000, rx: 18000, rz: 15000, rot: 40, weight: 0.62 },
].map(worldPrepEllipse);

// 名前付きの山脈。inner を小さめにして、中心付近だけが高くなるようにしている。
const WORLD_RANGES = [
  {
    name: 'ノルドハイム山脈', nameLatin: 'Nordheim Range',
    cx: -92000, cz: -198000, rx: 106000, rz: 72000, rot: 25, inner: 0.12,
    height: 3400, freq: 0.000108,
  },
  {
    name: 'ヴェスタリア中央山地', nameLatin: 'Central Vestaria',
    cx: 22000, cz: -92000, rx: 122000, rz: 54000, rot: -18, inner: 0.12,
    height: 2050, freq: 0.000122,
  },
  {
    name: 'カルディス高原', nameLatin: 'Kaldis Plateau',
    cx: 204000, cz: -62000, rx: 104000, rz: 112000, rot: 0, inner: 0.3,
    height: 1550, freq: 0.000094,
  },
  {
    name: 'メリディア丘陵', nameLatin: 'Meridia Highlands',
    cx: -28000, cz: 192000, rx: 112000, rz: 48000, rot: 8, inner: 0.15,
    height: 920, freq: 0.000145,
  },
].map(worldPrepEllipse);

// --- 国 ---------------------------------------------------------------------

const WORLD_COUNTRIES = [
  { id: 'vestaria', name: 'ヴェスタリア連邦', nameLatin: 'Vestaria', tint: 0xa8d47e },
  { id: 'nordheim', name: 'ノルドハイム王国', nameLatin: 'Nordheim', tint: 0xa8c4e0 },
  { id: 'kaldis', name: 'カルディス自治領', nameLatin: 'Kaldis', tint: 0xe0c088 },
  { id: 'meridia', name: 'メリディア共和国', nameLatin: 'Meridia', tint: 0xb8d97a },
  { id: 'serafina', name: 'セラフィナ諸島', nameLatin: 'Serafina', tint: 0x7fe0c0 },
];

// --- 都市 -------------------------------------------------------------------
// size は街の規模（0〜1）。建物の数・高さ・広がりに効く。

const WORLD_CITIES = [
  // ヴェスタリア連邦
  { id: 'alvis', name: 'アルヴィス', nameLatin: 'Alvis', country: 'vestaria', x: 11000, z: 6000, size: 1.0, capital: true },
  { id: 'portrim', name: 'ポートリム', nameLatin: 'Portrim', country: 'vestaria', x: -178000, z: 32000, size: 0.62 },
  { id: 'kernford', name: 'ケルンフォード', nameLatin: 'Kernford', country: 'vestaria', x: 62000, z: -72000, size: 0.58 },
  { id: 'mirabel', name: 'ミラベル', nameLatin: 'Mirabel', country: 'vestaria', x: -88000, z: 62000, size: 0.4 },
  { id: 'halden', name: 'ハルデン', nameLatin: 'Halden', country: 'vestaria', x: -120000, z: -78000, size: 0.36 },
  { id: 'westmere', name: 'ウェストミア', nameLatin: 'Westmere', country: 'vestaria', x: 96000, z: 58000, size: 0.34 },

  // ノルドハイム王国
  { id: 'karsten', name: 'カルステン', nameLatin: 'Karsten', country: 'nordheim', x: -71000, z: -183000, size: 0.6, capital: true },
  { id: 'fjordnes', name: 'フィヨルドネス', nameLatin: 'Fjordnes', country: 'nordheim', x: -148000, z: -228000, size: 0.36 },
  { id: 'vinterholm', name: 'ヴィンターホルム', nameLatin: 'Vinterholm', country: 'nordheim', x: -46000, z: -252000, size: 0.3 },

  // カルディス自治領
  { id: 'tarik', name: 'タリク', nameLatin: 'Tarik', country: 'kaldis', x: 168000, z: -34000, size: 0.58, capital: true },
  { id: 'sabrin', name: 'サブリン', nameLatin: 'Sabrin', country: 'kaldis', x: 232000, z: -128000, size: 0.34 },
  { id: 'neva', name: 'ネヴァ', nameLatin: 'Neva', country: 'kaldis', x: 148000, z: -142000, size: 0.28 },

  // メリディア共和国
  { id: 'soleia', name: 'ソレイア', nameLatin: 'Soleia', country: 'meridia', x: -43500, z: 163000, size: 0.86, capital: true },
  { id: 'verde', name: 'ヴェルデ', nameLatin: 'Verde', country: 'meridia', x: -142000, z: 186000, size: 0.42 },
  { id: 'calasante', name: 'カラサンテ', nameLatin: 'Calasante', country: 'meridia', x: 44000, z: 196000, size: 0.36 },

  // セラフィナ諸島
  { id: 'marina', name: 'マリナ', nameLatin: 'Marina', country: 'serafina', x: 169000, z: 143500, size: 0.44, capital: true },
  { id: 'coralis', name: 'コーラリス', nameLatin: 'Coralis', country: 'serafina', x: 220000, z: 185000, size: 0.26 },
];

// --- 空港 -------------------------------------------------------------------
// elevationM はその空港の標高。地形はこの高さへ平滑化されるので、
// 滑走路は必ず平らな地面の上に乗る（山岳空港も同じ仕組みで作れる）。

const WORLD_AIRPORTS = [
  {
    id: 'VSAV', name: 'アルヴィス国際空港', nameLatin: 'Alvis Intl',
    country: 'vestaria', city: 'alvis',
    x: 0, z: 0, elevationM: 48,
    runwayLengthM: 3400, runwayWidthM: 60, headingDeg: 88,
  },
  {
    id: 'VSPR', name: 'ポートリム空港', nameLatin: 'Portrim',
    country: 'vestaria', city: 'portrim',
    x: -170000, z: 40000, elevationM: 14,
    runwayLengthM: 2600, runwayWidthM: 45, headingDeg: 32,
  },
  {
    id: 'VSKE', name: 'ケルンフォード空港', nameLatin: 'Kernford',
    country: 'vestaria', city: 'kernford',
    x: 56000, z: -62000, elevationM: 330,
    runwayLengthM: 2200, runwayWidthM: 45, headingDeg: 128,
  },
  {
    id: 'NHKR', name: 'カルステン空港', nameLatin: 'Karsten',
    country: 'nordheim', city: 'karsten',
    x: -63000, z: -176000, elevationM: 820,
    runwayLengthM: 3000, runwayWidthM: 45, headingDeg: 158,
  },
  {
    id: 'NHFJ', name: 'フィヨルドネス空港', nameLatin: 'Fjordnes',
    country: 'nordheim', city: 'fjordnes',
    x: -142000, z: -234000, elevationM: 26,
    runwayLengthM: 1800, runwayWidthM: 30, headingDeg: 68,
  },
  {
    id: 'KDTR', name: 'タリク空港', nameLatin: 'Tarik',
    country: 'kaldis', city: 'tarik',
    x: 176000, z: -26000, elevationM: 1260,
    runwayLengthM: 3200, runwayWidthM: 60, headingDeg: 22,
  },
  {
    id: 'MRSO', name: 'ソレイア国際空港', nameLatin: 'Soleia Intl',
    country: 'meridia', city: 'soleia',
    x: -36000, z: 172000, elevationM: 62,
    runwayLengthM: 3000, runwayWidthM: 60, headingDeg: 112,
  },
  {
    id: 'SFMA', name: 'マリナ空港', nameLatin: 'Marina',
    country: 'serafina', city: 'marina',
    x: 174000, z: 151000, elevationM: 10,
    runwayLengthM: 2000, runwayWidthM: 45, headingDeg: 52,
  },
  {
    id: 'SFCO', name: 'コーラリス空港', nameLatin: 'Coralis',
    country: 'serafina', city: 'coralis',
    x: 226000, z: 193000, elevationM: 6,
    runwayLengthM: 1500, runwayWidthM: 30, headingDeg: 94,
  },
];

// 空港ごとの「地形をならす範囲」。内側は完全に平ら、外側へ向かって元の地形へ戻す。
// 広く取りすぎると周囲が何kmも真っ平らな板になってしまうので、
// 「定義の滑走路長＋UIで伸ばせる余地」がちょうど収まるだけの大きさにしている。
const AIRPORT_LENGTH_HEADROOM_M = 900;

function worldPrepAirports() {
  for (const a of WORLD_AIRPORTS) {
    a.maxRunwayLengthM = a.runwayLengthM + AIRPORT_LENGTH_HEADROOM_M;
    a.flatInnerR = a.maxRunwayLengthM * 0.62 + 700;
    a.flatOuterR = a.flatInnerR * 2.2;
  }
}

// 都市の広がり。builtRadiusM は建物が建つ範囲（js/env/03d-places.js もこれを使う）、
// urbanR は市街地として色を変える範囲。
const CITY_BUILT_RADIUS_MIN_M = 800;
const CITY_BUILT_RADIUS_MAX_M = 3600;

// 街の下の地形をゆるく均す強さ。1.0だと完全な平面になって不自然なので、
// 元の起伏を2割ほど残す。空港（完全に平ら）と違い、街は多少の起伏があってよい。
const CITY_FLATTEN_STRENGTH = 0.90;

// 街の基準標高。街を均す前の地形の高さで、worldPrepCities() が起動時に一度だけ求める。
let _worldCityFlattenReady = false;

function worldPrepCities() {
  for (const c of WORLD_CITIES) {
    c.builtRadiusM = CITY_BUILT_RADIUS_MIN_M + c.size * (CITY_BUILT_RADIUS_MAX_M - CITY_BUILT_RADIUS_MIN_M);
    c.urbanR = 1500 + c.size * 5200;
    c.flatInnerR = c.builtRadiusM * 1.15;
    c.flatOuterR = c.flatInnerR * 2.4;
  }
  // 基準標高は「街を均していない地形」から取る必要があるので、
  // フラグを立てる前に求める（そうしないと自分自身を参照してしまう）
  for (const c of WORLD_CITIES) c.groundY = worldHeightAt(c.x, c.z);
  _worldCityFlattenReady = true;
}

// ある地点の「市街地らしさ」(0〜1)。地形の色を街の色へ寄せるのに使う。
function worldUrbanFactorAt(x, z) {
  let best = 0;
  for (let i = 0; i < WORLD_CITIES.length; i++) {
    const c = WORLD_CITIES[i];
    const r = c.urbanR;
    const dx = x - c.x, dz = z - c.z;
    if (dx > r || dx < -r || dz > r || dz < -r) continue;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= r) continue;
    const f = worldSmooth01(1 - d / r);
    if (f > best) best = f;
  }
  return best;
}

// 街・空港の周りは必ず陸にするためのアンカー（海岸線ノイズで沈むのを防ぐ）。
// 空港の flatOuterR を使うので、worldPrepAirports() の後で組み立てる。
const WORLD_LAND_ANCHORS = [];

function worldPrepLandAnchors() {
  WORLD_LAND_ANCHORS.length = 0;
  for (const a of WORLD_AIRPORTS) {
    WORLD_LAND_ANCHORS.push({ x: a.x, z: a.z, r: Math.max(a.flatOuterR * 1.5, 26000) });
  }
  for (const c of WORLD_CITIES) {
    WORLD_LAND_ANCHORS.push({ x: c.x, z: c.z, r: 15000 + c.size * 22000 });
  }
}

// --- 高さ関数 ---------------------------------------------------------------

// 陸/海の判定値。0より大きければ陸、小さければ海。1に近いほど内陸。
function worldLandValueAt(x, z) {
  let v = 0;
  for (let i = 0; i < WORLD_LANDMASSES.length; i++) {
    const m = WORLD_LANDMASSES[i];
    const f = m.weight * worldEllipseFalloff(x, z, m);
    if (f > v) v = f;
  }

  // 海岸線を崩して、入り江・半島・岬を作る
  v += (worldFbm(x * 0.0000168, z * 0.0000168, 4) - 0.5) * 0.52;

  // 街と空港の周辺は陸であることを保証する（ここだけノイズより優先する）
  for (let i = 0; i < WORLD_LAND_ANCHORS.length; i++) {
    const a = WORLD_LAND_ANCHORS[i];
    const dx = x - a.x, dz = z - a.z;
    if (dx > a.r || dx < -a.r || dz > a.r || dz < -a.r) continue;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= a.r) continue;
    const anchor = 0.5 + 0.15 * worldSmooth01(1 - d / a.r);
    if (anchor > v) v = anchor;
  }

  return v - 0.5;
}

// 標高(m)。海面下は負の値（海底）を返す。
function worldHeightAt(x, z) {
  const land = worldLandValueAt(x, z);
  let h;

  if (land <= 0) {
    // 海底：岸から離れるほど深くなる。大陸棚→深海のイメージ。
    const t = Math.min(-land / 0.55, 1);
    h = -(25 + t * t * 2600);
    // 海底にも起伏を入れておくと、浅瀬の色にムラが出て単調にならない
    h += (worldFbm(x * 0.000045, z * 0.000045, 3) - 0.5) * 220 * (1 - t);
  } else {
    const inland = Math.min(land / 0.5, 1);
    const shore = worldSmooth01(Math.min(land / 0.13, 1)); // 海岸線際だけ低く保つ

    // 海岸平野 → 内陸台地へのなだらかな立ち上がり
    h = shore * 40 + worldSmooth01(inland) * 240;

    // ゆるやかな起伏（丘陵）
    h += (worldFbm(x * 0.0000225, z * 0.0000225, 4) - 0.42) * 640 * inland;

    // 山脈。複数の山脈が重なっても足し合わせずに最大値を採る
    let mountain = 0;
    for (let i = 0; i < WORLD_RANGES.length; i++) {
      const r = WORLD_RANGES[i];
      const mask = worldEllipseFalloff(x, z, r);
      if (mask <= 0) continue;
      const ridge = worldRidgedFbm(x * r.freq, z * r.freq, 6);
      const m = mask * mask * ridge * r.height;
      if (m > mountain) mountain = m;
    }
    h += mountain * inland;

    // 細かい凹凸。LODの最小間隔（約310m）で潰れない程度の細かさに留める
    h += (worldFbm(x * 0.00019, z * 0.00019, 3) - 0.5) * 110 * inland;
    h += (worldFbm(x * 0.00052, z * 0.00052, 3) - 0.5) * 62 * inland;

    if (h < 1.5) h = 1.5; // 陸は必ず水面より上にする
  }

  // 街の下をゆるく均す。山の急斜面に街が貼り付くのを防ぐ。
  // 空港より先に適用して、滑走路の平面は最後に必ず勝つようにする。
  if (_worldCityFlattenReady) {
    for (let i = 0; i < WORLD_CITIES.length; i++) {
      const c = WORLD_CITIES[i];
      const dx = x - c.x, dz = z - c.z;
      if (dx > c.flatOuterR || dx < -c.flatOuterR || dz > c.flatOuterR || dz < -c.flatOuterR) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= c.flatOuterR) continue;
      const w = 1 - worldSmooth01((d - c.flatInnerR) / (c.flatOuterR - c.flatInnerR));
      h += (c.groundY - h) * w * CITY_FLATTEN_STRENGTH;
    }
  }

  // 空港のまわりをならす。ここだけは地形より空港の標高を優先する。
  for (let i = 0; i < WORLD_AIRPORTS.length; i++) {
    const a = WORLD_AIRPORTS[i];
    const dx = x - a.x, dz = z - a.z;
    if (dx > a.flatOuterR || dx < -a.flatOuterR || dz > a.flatOuterR || dz < -a.flatOuterR) continue;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= a.flatOuterR) continue;
    const w = 1 - worldSmooth01((d - a.flatInnerR) / (a.flatOuterR - a.flatInnerR));
    h += (a.elevationM - h) * w;
  }

  return h;
}

// --- 検索ヘルパー -----------------------------------------------------------

function worldCountryById(id) {
  return WORLD_COUNTRIES.find((c) => c.id === id) || null;
}

function worldCityById(id) {
  return WORLD_CITIES.find((c) => c.id === id) || null;
}

function worldAirportById(id) {
  return WORLD_AIRPORTS.find((a) => a.id === id) || null;
}

// ある地点にいちばん近い空港（オートパイロットや現在地表示に使う）
function worldNearestAirport(x, z) {
  let best = null, bestD = Infinity;
  for (const a of WORLD_AIRPORTS) {
    const d = Math.hypot(x - a.x, z - a.z);
    if (d < bestD) { bestD = d; best = a; }
  }
  return { airport: best, distanceM: bestD };
}

// ある地点がどの国か（もっとも近い都市の国とみなす簡易判定）
function worldRegionAt(x, z) {
  let best = null, bestD = Infinity;
  for (const c of WORLD_CITIES) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return null;
  return { city: best, country: worldCountryById(best.country), distanceM: bestD };
}

// --- 初期化 -----------------------------------------------------------------
// 準備処理はすべての定数・関数が出そろってから走らせる。
// worldPrepCities() は内部で worldHeightAt() を呼ぶので、宣言の途中に置くと
// まだ初期化されていない定数を触って落ちる（実際に踏んだ）。
worldPrepAirports();
worldPrepLandAnchors();
worldPrepCities();

// Node（検証スクリプト）から読めるようにしておく。ブラウザでは module が無いので何もしない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WORLD_SEED, WORLD_SIZE, WORLD_HALF,
    WORLD_LANDMASSES, WORLD_RANGES, WORLD_COUNTRIES, WORLD_CITIES, WORLD_AIRPORTS,
    worldHeightAt, worldLandValueAt, worldUrbanFactorAt, worldNearestAirport, worldRegionAt,
    CITY_FLATTEN_STRENGTH,
    worldCountryById, worldCityById, worldAirportById,
  };
}
