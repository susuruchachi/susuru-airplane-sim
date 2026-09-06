// 05b-weather.js — 天候（雲量・視程・降水・突風・雷）
//
// 天候は2つの入力から決まる。
//   1. 気象の場：worldWeatherFieldAt(x, z, 気象の時計) が返す「湿り」「荒れ」「霧」。
//      低気圧が風に乗って流れていくので、同じ場所でも時間で変わり、
//      同じ時刻でも場所で違う。3,000kmを飛べば天気は変わる。
//   2. 気候：その土地が乾いているか寒いか。砂漠では雨雲が来ても降りにくく、
//      寒い土地では雨ではなく雪になる。
//
// UIで「自動」以外を選ぶと、1のかわりに固定値を使う（手動プリセット）。
// どちらの場合も同じ導出（deriveWeather）を通るので、見え方の作りは1本。
//
// 求めた目標値へは指数平滑で寄せる。プリセットを切り替えても、
// 自動で天気が移り変わっても、パッと切り替わらず数十秒かけて変わる。

// 気象の時計は昼夜サイクルと同じ速さで進む（15分で24時間なら、天気も同じ速さで動く）
const WEATHER_TRANSITION_TAU = 6;      // 目標値へ寄る速さ（秒）。大きいほどゆっくり
const WEATHER_GUST_TAU = 1.2;

// 降水の粒。カメラを中心とした箱の中だけに置き、外へ出たら反対側から入れ直す。
const PRECIP_BOX_M = 150;
const RAIN_MAX = 5000;
const SNOW_MAX = 3500;
const RAIN_FALL_MPS = 22;
const SNOW_FALL_MPS = 1.6;

// 雲底に張る「曇り空の天井」。海面と同じく同心円メッシュにする
// （巨大な板を1枚のポリゴンで作ると対数深度が破綻するため。READMEの「深度バッファ」を参照）
const DECK_RINGS = 40;
const DECK_SECTORS = 64;
const DECK_INNER_R = 300;
const DECK_OUTER_R = 120000;
const DECK_PATTERN_M = 26000; // 雲のテクスチャ1タイルぶんの実寸

// 空の霞。霧や雨のときは空ドームまで霞んで見えなくなるはずなので、
// カメラを囲む球に霧色を塗る。地形より奥（半径9km）に置いて深度テストに任せるので、
// 手前の地形は普通に見えたまま、空と遠景の雲だけが霞に沈む。
const SKY_HAZE_RADIUS = 9000;

// 手動プリセット。wetness と storminess を固定するだけで、あとは自動と同じ導出を通る。
// climate:false のプリセットは、その土地の乾燥や気温に左右されない
// （「雨」を選んだのに砂漠だから降らない、では困る）。
const WEATHER_PRESETS = [
  { id: 'auto', name: '自動（場所と時間で変わる）' },
  { id: 'clear', name: '快晴', wetness: 0.00, storminess: 0.00, fogginess: 0 },
  { id: 'fair', name: '晴れ', wetness: 0.30, storminess: 0.00, fogginess: 0 },
  { id: 'cloudy', name: '曇り', wetness: 0.58, storminess: 0.06, fogginess: 0 },
  { id: 'rain', name: '雨', wetness: 0.82, storminess: 0.28, fogginess: 0, forcePrecip: 'rain' },
  { id: 'storm', name: '雷雨', wetness: 0.98, storminess: 0.95, fogginess: 0, forcePrecip: 'rain' },
  { id: 'snow', name: '雪', wetness: 0.88, storminess: 0.22, fogginess: 0, forcePrecip: 'snow' },
  { id: 'fog', name: '霧', wetness: 0.45, storminess: 0.00, fogginess: 1 },
  // 手動：湿りと荒れを自分で決める。値は EnvState.weather.manual に入っている。
  { id: 'manual', name: '手動' },
];

function weatherPresetById(id) {
  return WEATHER_PRESETS.find((p) => p.id === id) || WEATHER_PRESETS[0];
}

// --- 導出 -------------------------------------------------------------------

// 気象の場（湿り・荒れ・霧）と気候（気温・乾燥）から、見え方のパラメータを作る。
// 自動でも手動でもここを通るので、両者の見え方が食い違わない。
//
// opts.climate が真のときだけ、その土地の乾燥で湿り・荒れを弱める（＝自動のとき）。
// プリセットや手動は「選んだ天気をそのまま出す」ほうが分かりやすいので気候を掛けない。
// opts.forcePrecip は 'rain' / 'snow' / null。null のときは気温で雨か雪かが決まる。
// opts.climateAt に { temp, dry } を渡すと、その土地の気候を求め直さない。
// 気温は標高が要る＝worldHeightAt が要るので、ここがいちばん重い。
// 何百点も一度に評価するミニマップのレーダーは、地図を焼くときの標高を使い回す。
function deriveWeather(field, x, z, groundH, opts) {
  opts = opts || {};
  const forcePrecip = opts.forcePrecip || null;
  const temp = opts.climateAt
    ? opts.climateAt.temp
    : worldTemperatureAt(x, z, Math.max(groundH, 0));
  const dry = !opts.climate ? 0
    : (opts.climateAt ? opts.climateAt.dry : worldDrynessAt(x, z, worldLandValueAt(x, z)));

  // 乾いた土地では、雨雲が来ても雲が薄く雨になりにくい。
  // 0.75まで効かせると大陸の内側がほぼ快晴で固定されてしまうので0.55にしてある。
  const wet = field.wetness * (1 - dry * 0.55);
  const storm = field.storminess * (1 - dry * 0.5);
  const fog = field.fogginess;

  const snow = forcePrecip === 'snow' || (forcePrecip !== 'rain' && temp < 0.30);
  // 雲が空を覆いきってから雨が降り出すように、しきい値をずらしてある
  // （そうしないと「曇り」がいつも小雨になる）
  const overcast = worldClamp((wet - 0.34) / 0.28, 0, 1);
  const precipRate = worldClamp((wet - 0.62) / 0.30, 0, 1);

  // 視程：曇って霞み、降るとさらに落ちる。快晴で200km、曇りで35km、
  // 雨で8km、雪で3km、濃霧で0.7km。
  let visibilityM = 200000;
  visibilityM += (35000 - visibilityM) * overcast;
  visibilityM += ((snow ? 3000 : 8000) - visibilityM) * precipRate;
  visibilityM += (700 - visibilityM) * fog;

  return {
    wetness: wet,
    storminess: storm,
    fogginess: fog,
    cloudCoverage: worldClamp(0.06 + wet * 1.05, 0, 1),
    cloudBaseM: 2400 + (620 - 2400) * worldClamp(wet, 0, 1),
    overcast,
    precipRate,
    precipIsSnow: snow ? 1 : 0,
    visibilityM,
    windSpeedKmh: 6 + wet * 22 + storm * 72,
    gustiness: storm,
    // 曇る・霧が出るほど日射が減り、そのぶん空全体からの散乱光で底上げされる
    // （霧の中は影のない、のっぺりした明るさになる）
    sunFactor: worldClamp(1 - overcast * 0.86 - fog * 0.75, 0, 1),
    ambientFactor: 1 + overcast * 0.55 + fog * 0.5,
  };
}

// いま見えている天候を短い日本語にする（UIの表示用）
function weatherLabel(w) {
  if (w.fogginess > 0.45) return '霧';
  if (w.storminess > 0.45) return w.precipIsSnow > 0.5 ? '吹雪' : '雷雨';
  if (w.precipRate > 0.45) return w.precipIsSnow > 0.5 ? '雪' : '雨';
  if (w.precipRate > 0.12) return w.precipIsSnow > 0.5 ? '小雪' : '小雨';
  if (w.overcast > 0.55) return '曇り';
  if (w.cloudCoverage > 0.35) return '晴れ';
  return '快晴';
}

// --- 初期化 -----------------------------------------------------------------

function initWeather() {
  const zero = deriveWeather({ wetness: 0, storminess: 0, fogginess: 0 }, 0, 0, 0, null);
  EnvState.weather.current = { ...zero };
  EnvState.weather.target = { ...zero };

  EnvState.weatherGroup = new THREE.Group();
  EnvState.scene.add(EnvState.weatherGroup);

  buildSkyHaze();
  buildCloudDeck();
  buildPrecipitation();
}

// --- 空の霞 -----------------------------------------------------------------

// FogExp2 は地形や雲には効くが、空ドームには効かない（自前のシェーダーなので）。
// そのままだと「視程0.7kmの濃霧なのに青空が見える」ことになるので、
// カメラを囲む球に霧色を塗って空を覆う。
//
// 深度テストは有効のまま、半透明の中でいちばん先（renderOrder -1）に描く。
//   - 球より手前の地形・滑走路・水面・降水は、あとから普通に上書きされる
//   - 球より奥の空ドーム・遠景の雲は霞に沈む（そこはもう霧で真っ白な距離）
// 霧の色は自分で塗らず、霧そのものに塗らせる（fog: true）。
// トーンマッピングを通した色と、シェーダーが霧として書き込む色は一致しないので、
// 自前で塗ると霞の球だけ他と違う灰色になってしまう。
// 半径9kmで霧に埋まる割合は不透明度と同じ式なので、
// 「霧が薄くて球の色が出てしまう」ところでは、そもそも球がほぼ透明になる。
function buildSkyHaze() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xbfd6e8, transparent: true, opacity: 0,
    side: THREE.BackSide, depthWrite: false, fog: true,
  });
  const haze = new THREE.Mesh(new THREE.SphereGeometry(SKY_HAZE_RADIUS, 32, 16), mat);
  haze.frustumCulled = false;
  haze.renderOrder = -1;
  haze.visible = false;
  EnvState.skyHaze = haze;
  EnvState.scene.add(haze);
}

// 霧の色と濃さが決まったあとに 03-sky.js から呼ばれる。
// 「霞の球の距離でどれだけ霧に埋まるか」がそのまま不透明度になる。
function weatherUpdateSkyHaze(fogColor, density) {
  const haze = EnvState.skyHaze;
  if (!haze) return;
  const t = SKY_HAZE_RADIUS * density;
  const opacity = 1 - Math.exp(-t * t);
  haze.visible = opacity > 0.01;
  haze.material.opacity = opacity;
  haze.material.color.copy(fogColor);
  haze.position.copy(EnvState.camera.position);
}

// --- 曇り空の天井 -----------------------------------------------------------

// 中心が細かく外側ほど粗い円盤。海面と同じ作りで、対数深度が破綻しないようにする。
function buildDeckGeometry() {
  const vertCount = 1 + DECK_RINGS * DECK_SECTORS;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  normals[1] = -1; // 下から見上げるのが主なので法線は下向き

  const growth = Math.pow(DECK_OUTER_R / DECK_INNER_R, 1 / (DECK_RINGS - 1));
  for (let ri = 0; ri < DECK_RINGS; ri++) {
    const r = DECK_INNER_R * Math.pow(growth, ri);
    for (let si = 0; si < DECK_SECTORS; si++) {
      const a = (si / DECK_SECTORS) * Math.PI * 2;
      const vi = 1 + ri * DECK_SECTORS + si;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      positions[vi * 3] = x; positions[vi * 3 + 2] = z;
      normals[vi * 3 + 1] = -1;
      uvs[vi * 2] = x / DECK_PATTERN_M; uvs[vi * 2 + 1] = z / DECK_PATTERN_M;
    }
  }

  const indices = [];
  for (let si = 0; si < DECK_SECTORS; si++) {
    indices.push(0, 1 + si, 1 + ((si + 1) % DECK_SECTORS));
  }
  for (let ri = 0; ri < DECK_RINGS - 1; ri++) {
    for (let si = 0; si < DECK_SECTORS; si++) {
      const s1 = (si + 1) % DECK_SECTORS;
      const a = 1 + ri * DECK_SECTORS + si, b = 1 + ri * DECK_SECTORS + s1;
      const c = 1 + (ri + 1) * DECK_SECTORS + si, d = 1 + (ri + 1) * DECK_SECTORS + s1;
      indices.push(a, c, d, a, d, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), DECK_OUTER_R);
  return geo;
}

// 雲の濃淡テクスチャ。継ぎ目なくタイルさせたいので、サイン波の重ね合わせで作る。
//
// 模様は「明るさ」に入れ、不透明度はいじらない。
// 模様を不透明度に入れると、べったり曇っているはずの空にいつも穴が空き、
// 雲の上に出たとき床が透けて地面が見えてしまう。
// 空の覆われ具合そのものは material.opacity が受け持つ。
function buildDeckTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);

  const waves = [
    { fx: 1, fz: 1, a: 1.0, p: 0.0 }, { fx: 2, fz: -1, a: 0.6, p: 1.3 },
    { fx: -1, fz: 3, a: 0.45, p: 2.7 }, { fx: 3, fz: 2, a: 0.3, p: 0.4 },
    { fx: 5, fz: -3, a: 0.2, p: 2.1 }, { fx: -4, fz: 5, a: 0.14, p: 1.7 },
  ];
  let norm = 0;
  for (const w of waves) norm += w.a;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * Math.PI * 2, v = (j / size) * Math.PI * 2;
      let h = 0;
      for (const w of waves) h += w.a * Math.sin(w.fx * u + w.fz * v + w.p);
      const t = Math.max(0, Math.min(1, 0.5 + h / (norm * 1.6)));
      const o = (j * size + i) * 4;
      // 薄いところほど暗い（雲の底の陰）。白は飛ばしすぎないよう 245 まで。
      const shade = Math.round(150 + t * 95);
      img.data[o] = img.data[o + 1] = img.data[o + 2] = shade;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function buildCloudDeck() {
  const tex = buildDeckTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0,
    side: THREE.DoubleSide, depthWrite: false, fog: true,
  });
  EnvState.cloudDeck = new THREE.Mesh(buildDeckGeometry(), mat);
  EnvState.cloudDeck.frustumCulled = false;
  EnvState.cloudDeck.renderOrder = 3; // 半透明なので海(2)より後
  EnvState.cloudDeck.visible = false;
  EnvState.weatherGroup.add(EnvState.cloudDeck);
  EnvState.cloudDeckTexture = tex;
}

// --- 降水 -------------------------------------------------------------------

let _precipKind = null;      // 'rain' | 'snow' | null
let _precipLocal = null;     // 箱の中でのローカル座標
let _precipObject = null;
let _precipPositions = null;
let _prevCam = null;

function buildPrecipitation() {
  // 雨（線分）と雪（点）を両方用意しておき、表示するほうだけ visible にする
  const rainPos = new Float32Array(RAIN_MAX * 2 * 3);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  rainGeo.setDrawRange(0, 0);
  rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), PRECIP_BOX_M * 2);
  EnvState.rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
    color: 0xa8c4d8, transparent: true, opacity: 0.5, depthWrite: false, fog: true,
  }));
  EnvState.rain.frustumCulled = false;
  EnvState.rain.visible = false;
  EnvState.weatherGroup.add(EnvState.rain);

  const snowPos = new Float32Array(SNOW_MAX * 3);
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  snowGeo.setDrawRange(0, 0);
  snowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), PRECIP_BOX_M * 2);
  EnvState.snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
    color: 0xe8eef4, size: 0.55, sizeAttenuation: true,
    transparent: true, opacity: 0.85, depthWrite: false, fog: true,
  }));
  EnvState.snow.frustumCulled = false;
  EnvState.snow.visible = false;
  EnvState.weatherGroup.add(EnvState.snow);

  _precipLocal = new Float32Array(Math.max(RAIN_MAX, SNOW_MAX) * 3);
}

// 粒を箱いっぱいに撒き直す（降り始めや種類が変わったとき）
function seedPrecipitation(count) {
  for (let i = 0; i < count; i++) {
    _precipLocal[i * 3] = (Math.random() * 2 - 1) * PRECIP_BOX_M;
    _precipLocal[i * 3 + 1] = (Math.random() * 2 - 1) * PRECIP_BOX_M;
    _precipLocal[i * 3 + 2] = (Math.random() * 2 - 1) * PRECIP_BOX_M;
  }
}

// 粒を落として箱の中で折り返す。
// カメラの移動ぶんを引くので、飛んでいるときは粒が後ろへ流れていく。
function updatePrecipitation(dt, w, scale) {
  const cam = EnvState.camera.position;
  const rate = w.precipRate * scale;
  const wantKind = rate < 0.03 ? null : (w.precipIsSnow > 0.5 ? 'snow' : 'rain');

  if (wantKind !== _precipKind) {
    _precipKind = wantKind;
    EnvState.rain.visible = wantKind === 'rain';
    EnvState.snow.visible = wantKind === 'snow';
    if (wantKind) seedPrecipitation(wantKind === 'rain' ? RAIN_MAX : SNOW_MAX);
    _precipObject = wantKind === 'rain' ? EnvState.rain : (wantKind === 'snow' ? EnvState.snow : null);
    _precipPositions = _precipObject ? _precipObject.geometry.attributes.position : null;
  }
  if (!_precipKind) { _prevCam = null; return; }

  const isRain = _precipKind === 'rain';
  const maxCount = isRain ? RAIN_MAX : SNOW_MAX;
  const count = Math.round(maxCount * Math.min(rate * 1.15, 1));

  // 風で流される。突風のぶんも乗せる。
  const windRad = THREE.MathUtils.degToRad(EnvState.env.windDirectionDeg);
  const windMps = (EnvState.env.windSpeedKmh / 3.6) * (isRain ? 0.5 : 0.9);
  const vx = Math.cos(windRad) * windMps;
  const vz = Math.sin(windRad) * windMps;
  const vy = -(isRain ? RAIN_FALL_MPS : SNOW_FALL_MPS);

  // カメラの移動ぶん（前フレームとの差）
  let cvx = 0, cvy = 0, cvz = 0;
  if (_prevCam) { cvx = cam.x - _prevCam.x; cvy = cam.y - _prevCam.y; cvz = cam.z - _prevCam.z; }
  _prevCam = { x: cam.x, y: cam.y, z: cam.z };

  const B = PRECIP_BOX_M, B2 = B * 2;
  const wrap = (v) => (((v + B) % B2) + B2) % B2 - B;

  const arr = _precipPositions.array;
  const streak = isRain ? Math.hypot(vx, vy, vz) * 0.055 : 0;
  const sx = isRain ? (-vx / Math.hypot(vx, vy, vz)) * streak : 0;
  const sy = isRain ? (-vy / Math.hypot(vx, vy, vz)) * streak : 0;
  const sz = isRain ? (-vz / Math.hypot(vx, vy, vz)) * streak : 0;

  for (let i = 0; i < count; i++) {
    const li = i * 3;
    _precipLocal[li] = wrap(_precipLocal[li] + vx * dt - cvx);
    _precipLocal[li + 1] = wrap(_precipLocal[li + 1] + vy * dt - cvy);
    _precipLocal[li + 2] = wrap(_precipLocal[li + 2] + vz * dt - cvz);

    if (isRain) {
      const o = i * 6;
      arr[o] = _precipLocal[li]; arr[o + 1] = _precipLocal[li + 1]; arr[o + 2] = _precipLocal[li + 2];
      arr[o + 3] = _precipLocal[li] + sx; arr[o + 4] = _precipLocal[li + 1] + sy; arr[o + 5] = _precipLocal[li + 2] + sz;
    } else {
      arr[li] = _precipLocal[li]; arr[li + 1] = _precipLocal[li + 1]; arr[li + 2] = _precipLocal[li + 2];
    }
  }

  _precipObject.geometry.setDrawRange(0, isRain ? count * 2 : count);
  _precipPositions.needsUpdate = true;
  _precipObject.position.copy(cam);
}

// --- 毎フレームの更新 -------------------------------------------------------

function updateWeather(dt) {
  const w = EnvState.weather;

  // 気象の時計は昼夜サイクルと同じ速さで進む
  if (!EnvState.time.paused) {
    w.clockHours += dt * (24 / (EnvState.time.cycleMinutes * 60));
  }

  const cam = EnvState.camera.position;
  const groundH = worldHeightAt(cam.x, cam.z);
  const preset = weatherPresetById(w.presetId);

  let field;
  if (preset.id === 'auto') field = worldWeatherFieldAt(cam.x, cam.z, w.clockHours);
  else if (preset.id === 'manual') field = { ...w.manual };
  else field = { wetness: preset.wetness, storminess: preset.storminess, fogginess: preset.fogginess };

  w.target = deriveWeather(field, cam.x, cam.z, groundH, {
    forcePrecip: preset.forcePrecip || null,
    climate: preset.id === 'auto', // 気候が効くのは自動のときだけ
  });

  // 目標値へ指数平滑で寄せる（プリセットを切り替えても数十秒かけて変わる）
  const k = 1 - Math.exp(-dt / WEATHER_TRANSITION_TAU);
  for (const key in w.target) {
    w.current[key] += (w.target[key] - w.current[key]) * k;
  }

  // 突風。荒れているほど強く速く揺れる。
  const gustTarget = w.current.gustiness * (worldValueNoise(w.clockHours * 260, 3.7) * 2 - 1) * 34;
  w.gust += (gustTarget - w.gust) * (1 - Math.exp(-dt / WEATHER_GUST_TAU));

  // 雷。荒れているときだけ、たまに光る。
  if (w.current.storminess > 0.4 && Math.random() < w.current.storminess * dt * 0.5) {
    w.flash = 1;
  }
  w.flash = Math.max(0, w.flash - dt * 5.5);

  applyWeatherToScene(dt);
}

function applyWeatherToScene(dt) {
  const w = EnvState.weather.current;

  // 曇りの天井より上に出たら、雨も霧もそこには無い。
  // （雲量が無いときは天井も無いので、この抑制もかからない）
  EnvState.weather.aboveDeck =
    worldClamp((EnvState.camera.position.y - w.cloudBaseM) / 600, 0, 1) * w.overcast;

  // 雲量は常に天候が決める（手動モードでも、手動の「湿り」から導かれる）
  const target = Math.round(w.cloudCoverage * 100) / 100;
  if (Math.abs(EnvState.env.cloudCoverage - target) > 0.005) {
    EnvState.env.cloudCoverage = target;
    applyCloudCoverage();
  }
  EnvState.cloudAltitude = w.cloudBaseM;

  // 風速。天候に任せる設定のときだけ上書きする（風向はいつでも手動）
  if (EnvState.env.windFromWeather !== false) {
    EnvState.env.windSpeedKmh = Math.round(w.windSpeedKmh + EnvState.weather.gust);
    if (EnvState.env.windSpeedKmh < 0) EnvState.env.windSpeedKmh = 0;
  }

  // 曇り空の天井
  const deck = EnvState.cloudDeck;
  if (deck) {
    // べったり曇ったら不透明にする（雲の上に出たとき床が透けないように）
    const op = worldClamp(w.overcast * 1.08, 0, 1);
    deck.visible = op > 0.02;
    deck.material.opacity = op;
    const cam = EnvState.camera.position;
    deck.position.set(cam.x, w.cloudBaseM, cam.z);
    // メッシュを動かした分をUVで打ち消し、雲の模様がワールドに対して止まって見えるようにする
    const windRad = THREE.MathUtils.degToRad(EnvState.env.windDirectionDeg);
    EnvState.weather.deckDrift.x += (Math.cos(windRad) * (EnvState.env.windSpeedKmh / 3.6) / DECK_PATTERN_M) * dt;
    EnvState.weather.deckDrift.y += (Math.sin(windRad) * (EnvState.env.windSpeedKmh / 3.6) / DECK_PATTERN_M) * dt;
    EnvState.cloudDeckTexture.offset.set(
      cam.x / DECK_PATTERN_M + EnvState.weather.deckDrift.x,
      cam.z / DECK_PATTERN_M + EnvState.weather.deckDrift.y
    );
  }

  updatePrecipitation(dt, w, 1 - EnvState.weather.aboveDeck);
}

// 天候ぶんの光と霧を、昼夜の計算のあとに掛ける（03-sky.js から呼ばれる）
function applyWeatherToLighting(dayFactor) {
  const w = EnvState.weather.current;
  const flash = EnvState.weather.flash;

  EnvState.sunLight.intensity *= w.sunFactor;
  EnvState.moonLight.intensity *= w.sunFactor;
  EnvState.hemiLight.intensity *= w.ambientFactor;

  // 稲光。空全体が一瞬明るくなる
  if (flash > 0.01) {
    EnvState.hemiLight.intensity += flash * flash * 3.2;
  }

  // 曇り空の天井も昼夜で明るさが変わる（積雲と同じ扱い。夜に白く光ってしまわないように）
  if (EnvState.cloudDeck) {
    const lit = 0.06 + dayFactor * 0.94;
    EnvState.cloudDeck.material.color.setRGB(lit, lit, lit * 1.02);
  }

  // 太陽・月・星は雲の向こうへ隠れる
  const seeSky = 1 - w.overcast;
  EnvState.sunMesh.visible = EnvState.sunMesh.visible && seeSky > 0.35;
  EnvState.moonMesh.visible = EnvState.moonMesh.visible && seeSky > 0.35;
  EnvState.stars.material.opacity *= seeSky;
}

// 視程から霧の濃さを出す。FogExp2 は 1-exp(-(距離*密度)^2)。
// 「視程の4割の距離で半分霞む」ように合わせると density = sqrt(ln2)/(0.4*視程) ≒ 2.1/視程。
// （視程そのもので合わせると、近くがほとんど霞まず霧に見えない）
function weatherFogDensity() {
  const v = Math.max(EnvState.weather.current.visibilityM, 300);
  // 雲の上に出れば、その下の霧や雨に視界を邪魔されることはない
  return (2.1 / v) * (1 - EnvState.weather.aboveDeck * 0.97);
}

// 霧の色。雨や曇りでは青みが抜けて灰色になる。
function weatherApplyFogTint(color) {
  const w = EnvState.weather.current;
  const gray = new THREE.Color(0x9aa3ab).lerp(new THREE.Color(0x50575e), w.storminess * 0.7);
  color.lerp(gray, Math.min(w.overcast * 0.85 + w.fogginess * 0.9, 1));
  if (EnvState.weather.flash > 0.01) {
    color.lerp(new THREE.Color(0xdfe8f2), EnvState.weather.flash * 0.5);
  }
  return color;
}

function setWeatherPreset(id) {
  EnvState.weather.presetId = id;
}

// Node（tools/verify-world.js）から天候の導出だけを検査できるようにする。
// deriveWeather と weatherLabel は THREE も EnvState も使わない純粋な関数なので、
// 世界の関数さえ globalThis に入っていればブラウザの外でも同じ答えを出す。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WEATHER_PRESETS, weatherPresetById, deriveWeather, weatherLabel };
}
