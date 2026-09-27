// 03-sky.js — 空（大気散乱シェーダー）・太陽・月・星・霧・仮地面
// 太陽方向はjs/env/05-daynight.jsが計算し、updateSkyForSunDirection()を毎フレーム呼ぶ。

// 太陽・月・星は「カメラから見た方向」だけが意味を持つので、天球ごとカメラに追従させる。
// 600km四方のマップでは原点固定にすると、少し飛んだだけで太陽を後ろに置き去りにしてしまう。
const ENV_SUN_DISTANCE = 18000;
const ENV_MOON_DISTANCE = 18000;
// 霧の濃さの既定値。ふだんは天候（js/env/05b-weather.js）の視程から計算した値を使うので、
// これは天候がまだ用意できていない起動直後だけの保険。
const ENV_BASE_FOG_DENSITY = 0.0000105;
// 夜の明るさ。月齢と月の高さ（moonSky：0＝月の無い夜〜1＝満月が高い夜）で、この2つのあいだを動く。
// 以前は月齢が無く、いつも満月の明るさ（月明かり0.25・環境光0.12・空の色 0x0a1220）だった。
const ENV_MOONLIGHT_FULL = 0.3;       // 満月が高く昇ったときの月明かり
const ENV_NIGHT_AMBIENT_DARK = 0.06;  // 月の無い夜の環境光（星明かり）
const ENV_NIGHT_AMBIENT_MOON = 0.15;  // 満月の夜の環境光
const ENV_NIGHT_SKY_DARK = 0x03060d;  // 月の無い夜の空（霧）の色
const ENV_NIGHT_SKY_MOON = 0x122038;  // 満月の夜の空（霧）の色

function initSky() {
  // 天球（空ドーム・太陽・月・星）をまとめてカメラ位置へ移動させるための入れ物。
  // THREE.Skyのシェーダーは gl_Position.z = gl_Position.w で常に最遠面に描くので、
  // ドームの大きさが地形より小さくても地形を隠すことはない。
  EnvState.celestial = new THREE.Group();
  EnvState.scene.add(EnvState.celestial);

  // 大気散乱シェーダーによる空ドーム（Preethamモデル。CDNのTHREE.Skyを利用）
  EnvState.sky = new THREE.Sky();
  EnvState.sky.scale.setScalar(60000);
  EnvState.celestial.add(EnvState.sky);

  const uniforms = EnvState.sky.material.uniforms;
  uniforms['turbidity'].value = 3;
  uniforms['rayleigh'].value = 1.6;
  uniforms['mieCoefficient'].value = 0.006;
  uniforms['mieDirectionalG'].value = 0.8;

  // 太陽の見た目（光源とは別に、球として描画する）。
  // 深度は無限遠（applyAtInfinity）。18km先のまま描くと、それより遠い山や雲底の手前に出てしまう。
  // 空のドームより後に描く（ドームも最遠に描かれ、深度を書かないので、先に描くと上から塗られる）。
  const sunMat = applyAtInfinity(new THREE.MeshBasicMaterial({ color: 0xfff2d0, fog: false }));
  EnvState.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(270, 16, 16), sunMat);
  EnvState.sunMesh.renderOrder = 1;
  EnvState.celestial.add(EnvState.sunMesh);

  // 月。**太陽に照らされた側だけ光る**球にして、満ち欠けを形そのもので出す（createMoonMaterial）。
  // 月も太陽も無限遠に見立てているので、月面のある点が照らされているかは「その点の向き」と
  // 「太陽の向き」だけで決まる——新月は照らされた側が向こうを向き、満月はこちらを向く。
  EnvState.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 24), createMoonMaterial());
  // 欠けた側は透けて空や星が見えるよう半透明にする。**霞の球より後、川・海・雲より先**に描く
  // （雲底・雲は上から重なる）。星と同じく霞より先に描くと、昼は霞の色がかぶって空とほとんど
  // 同じ灰色になり見えなかった。霧・べた曇りのときは天候の側が月ごと隠す（applyWeatherToLighting）
  EnvState.moonMesh.renderOrder = ENV_ORDER.haze + 0.5;
  EnvState.celestial.add(EnvState.moonMesh);

  // 星（夜間のみフェードインする点群。地表付近は不要なので上半球寄りに分布）
  const starCount = 2500;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 24000;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 0.98);
    starPositions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.cos(phi);
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  // 距離で縮ませると天球の半径では点が消えてしまうので、画面上で一定の大きさにする
  const starMat = applyAtInfinity(new THREE.PointsMaterial({
    color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false,
  }));
  EnvState.stars = new THREE.Points(starGeo, starMat);
  // 半透明のなかでいちばん先に描く（霞・雲底・雲がその上から重なる）
  EnvState.stars.renderOrder = ENV_ORDER.haze - 1;
  EnvState.celestial.add(EnvState.stars);

  // ライト（太陽＝主光源、月＝夜間の弱い補助光、半球光＝全体の底上げ）
  EnvState.hemiLight = new THREE.HemisphereLight(0x8fb3d9, 0x2b2318, 0.6);
  EnvState.scene.add(EnvState.hemiLight);

  EnvState.sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
  EnvState.scene.add(EnvState.sunLight);

  EnvState.moonLight = new THREE.DirectionalLight(0x8fa8e0, 0);
  EnvState.scene.add(EnvState.moonLight);

  EnvState.scene.fog = new THREE.FogExp2(0xbfd6e8, ENV_BASE_FOG_DENSITY);

  // 地面は js/env/03c-terrain.js が作る（陸・海・標高はすべて worldHeightAt() 由来）
}

// 月の材質。MeshBasicMaterial（無限遠に描く applyAtInfinity 込み）の色の出口に、満ち欠けの計算を差し込む。
//   uSunDir … 太陽の向き（ワールド）。月面の向きとの内積が正なら照らされている
//   uEarth  … 欠けた側の濃さ（地球照。夜の、細い月のときだけ見える。欠けた側は空や星をふさぐ）
//   uOpacity … 月全体の濃さ（昼の空では薄く見える）
function createMoonMaterial() {
  const mat = applyAtInfinity(new THREE.MeshBasicMaterial({ color: ENV_MOON_COLOR_NIGHT, fog: false, transparent: true }));
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uEarth: { value: 0 },
    uOpacity: { value: 1 },
  };
  // トーンマッピングを掛けない。掛けると白が灰色まで落ち、昼の空（の明るい青）とほとんど区別が付かなかった
  mat.toneMapped = false;
  mat.userData.moonUniforms = uniforms;
  const atInfinity = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    atInfinity(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vMoonNormal;\n' + shader.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      'vMoonNormal = normalize( mat3( modelMatrix ) * normal );',
    ].join('\n'));
    shader.fragmentShader = [
      'varying vec3 vMoonNormal;',
      'uniform vec3 uSunDir;',
      'uniform float uEarth;',
      'uniform float uOpacity;',
    ].join('\n') + '\n' + shader.fragmentShader.replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', [
      // 明暗の境目（明暗境界線）は少しだけぼかす
      // 境目は暗くせず透かす（暗くすると昼の空に黒い縁が出る）。欠けた側は地球照の色で、その濃さだけ見せる
      'float moonLit = smoothstep( -0.03, 0.06, dot( normalize( vMoonNormal ), normalize( uSunDir ) ) );',
      'float moonEarth = uEarth * ( 1.0 - moonLit );',
      'float moonA = moonLit + moonEarth;',
      'vec3 moonCol = ( outgoingLight * moonLit + outgoingLight * vec3( 0.08, 0.09, 0.12 ) * moonEarth ) / max( moonA, 1e-3 );',
      'gl_FragColor = vec4( moonCol, uOpacity * moonA );',
    ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'atInfinity-moon';
  return mat;
}

// 月を照らす向き。**欠け方は月齢から決める**。この空は簡易モデルで、太陽と月の見かけの角度差が
// 時刻によって変わる（上弦の月齢7.4でも、15時には48°しか離れず太い三日月に見えていた）。
// 月から見た太陽の向きを、月と太陽の離角（月齢÷朔望月×360°。新月0°・上弦90°・満月180°）で作り直し、
// 光る縁だけはいまの太陽のある側へ向ける：L = cos(離角)·月の向き + sin(離角)·（月の向きに垂直で太陽側）
const ENV_MOON_COLOR_NIGHT = 0xf2f4f8;
const _moonDayColor = new THREE.Color(0xffffff);
const _moonShadeT = new THREE.Vector3();
const _moonShadeL = new THREE.Vector3();
function moonShadingSunDir(moonDir, sunDir, ageDays) {
  const e = (ageDays / (typeof MOON_SYNODIC_DAYS === 'number' ? MOON_SYNODIC_DAYS : 29.53)) * Math.PI * 2;
  _moonShadeT.copy(sunDir).addScaledVector(moonDir, -sunDir.dot(moonDir));
  if (_moonShadeT.lengthSq() < 1e-8) _moonShadeT.set(0, 1, 0).addScaledVector(moonDir, -moonDir.y);
  _moonShadeT.normalize();
  return _moonShadeL.copy(moonDir).multiplyScalar(Math.cos(e)).addScaledVector(_moonShadeT, Math.abs(Math.sin(e)));
}

// 月齢から決まる夜の明るさ（0＝月の無い夜〜1＝満月が高く昇った夜）。天候の減光は含まない。
// 夜の霧の色・環境光・星の見え方に使う（updateSkyForSunDirection が毎フレーム更新する）
function moonSkyLight() {
  return EnvState.moonSky || 0;
}

// 太陽の単位方向ベクトルと仰角(度)から、空・太陽・月・星・光源・霧の見た目をまとめて更新する。
// moon は computeMoonDirection の結果 { dir, elevationDeg }。無ければ太陽の反対側（満月）
function updateSkyForSunDirection(sunDir, elevationDeg, moon) {
  // 天球をカメラへ追従させる（太陽・月・星もこの中にぶら下がっている）
  EnvState.celestial.position.copy(EnvState.camera.position);
  EnvState.sky.material.uniforms['sunPosition'].value.copy(sunDir);
  // Preethamモデルは仰角が下がっても十分に暗くならないため、深夜帯はドームごと隠して
  // 背景色（updateSkyColorsForAltitudeで設定する夜の霧色）と星・月だけに任せる
  EnvState.sky.visible = elevationDeg > -8;

  const moonDir = moon ? moon.dir.clone() : sunDir.clone().negate();
  const moonElevationDeg = moon ? moon.elevationDeg : -elevationDeg;
  const phase = typeof moonPhaseInfo === 'function'
    ? moonPhaseInfo(EnvState.time.moonAgeDays || 0) : { illuminated: 1, brightness: 1 };
  EnvState.sunMesh.position.copy(sunDir).multiplyScalar(ENV_SUN_DISTANCE);
  EnvState.moonMesh.position.copy(moonDir).multiplyScalar(ENV_MOON_DISTANCE);
  EnvState.sunLight.position.copy(sunDir).multiplyScalar(500);
  // 光の向きはここに持つ。影を描くときは光の位置と狙う点を見ている場所へ動かすので（03m-shadows.js）、
  // 位置から向きを読むと狂う
  EnvState.sunDirection = (EnvState.sunDirection || new THREE.Vector3()).copy(sunDir).normalize();
  EnvState.moonLight.position.copy(moonDir).multiplyScalar(500);

  // 日中度合い（市民薄明の目安：仰角-6°〜10°でなだらかに切り替える）
  const dayFactor = THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(elevationDeg, -6, 10), 0, 1);
  // 朝焼け・夕焼けらしいオレンジ寄りの色付け（仰角が低いほど強く）
  const warmth = 1 - THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(elevationDeg, 0, 35), 0, 1);

  const sunColor = new THREE.Color(0xffffff).lerp(new THREE.Color(0xfff3e0), warmth * 0.6);
  sunColor.lerp(new THREE.Color(0xff9d5c), warmth * 0.55 * dayFactor);
  EnvState.sunLight.color.copy(sunColor);
  EnvState.sunLight.intensity = dayFactor * 1.5;
  EnvState.sunMesh.material.color.copy(sunColor);
  EnvState.sunMesh.visible = elevationDeg > -3;

  const nightFactor = 1 - dayFactor;
  // **月明かりは月齢と月の高さで決まる**。満月が高く昇った夜がいちばん明るく、半月で満月の1割ほど、
  // 新月や月が沈んでいる夜は月明かりが無い。地平線の近くでは大気を長く通るぶん弱い。
  const moonUp = THREE.MathUtils.smoothstep(moonElevationDeg, -1, 12);
  const moonSky = phase.brightness * moonUp;
  EnvState.moonSky = moonSky;
  EnvState.moonLight.intensity = nightFactor * ENV_MOONLIGHT_FULL * moonSky;
  // 月の見た目：昇っていれば昼でも見える（昼の空では薄く）。地球照は夜の、細い月のときだけ
  EnvState.moonMesh.visible = moonElevationDeg > -3;
  const mu = EnvState.moonMesh.material.userData.moonUniforms;
  if (mu) {
    mu.uSunDir.value.copy(moonShadingSunDir(moonDir, sunDir, phase.age === undefined ? 14.77 : phase.age));
    mu.uOpacity.value = 0.8 + 0.2 * nightFactor;
    // 地球照は細い月ほど強い（半月ではほとんど見えない）
    mu.uEarth.value = 0.35 * nightFactor * Math.pow(1 - phase.illuminated, 2);
    // 昼の青空の中では白く（夜の色のままだと空とほとんど同じ明るさで見えない）
    EnvState.moonMesh.material.color.setHex(ENV_MOON_COLOR_NIGHT).lerp(_moonDayColor, dayFactor);
  }

  // 夜の環境光（空全体からのほのかな明るさ）も月明かりで変わる。月の無い夜は星明かりだけ
  EnvState.hemiLight.intensity = ENV_NIGHT_AMBIENT_DARK + (ENV_NIGHT_AMBIENT_MOON - ENV_NIGHT_AMBIENT_DARK) * moonSky
    + dayFactor * 0.42;

  // 星は月が明るいほど見えにくい（満月の夜は暗い星が消える）
  const starOpacity = THREE.MathUtils.clamp(1 - THREE.MathUtils.smoothstep(elevationDeg, -18, -2), 0, 1);
  EnvState.stars.material.opacity = starOpacity * 0.9 * (1 - 0.55 * moonSky);

  // 天候ぶんの減光・稲光は、昼夜の計算が終わってから掛ける
  if (typeof applyWeatherToLighting === 'function') applyWeatherToLighting(dayFactor);

  updateSkyColorsForAltitude(dayFactor);
  if (typeof tintClouds === 'function') tintClouds(dayFactor, warmth);
  if (typeof updateAirportForDaylight === 'function') updateAirportForDaylight(dayFactor);
  if (typeof updateSeaForDaylight === 'function') updateSeaForDaylight(dayFactor, warmth);
  if (typeof updateWaterForDaylight === 'function') updateWaterForDaylight(dayFactor, warmth);
  if (typeof updatePlacesForDaylight === 'function') updatePlacesForDaylight(dayFactor);
  if (typeof updateRoadsForDaylight === 'function') updateRoadsForDaylight(dayFactor);
  if (typeof updateSmokeForDaylight === 'function') updateSmokeForDaylight(dayFactor);
}

// 高度（プレビュー用スライダー）に応じて霧の色・濃さを変える。高いほど霞が減り、空の色が濃くなる。
function updateSkyColorsForAltitude(dayFactor) {
  const altitude = EnvState.env.previewAltitudeM;
  const altFactor = THREE.MathUtils.clamp(altitude / 12000, 0, 1); // 0=地表 1=成層圏付近

  const dayFog = new THREE.Color(0xbfd6e8).lerp(new THREE.Color(0x1c3a6e), altFactor * 0.85);
  // 夜の空の色は月明かりで変わる（月の無い夜はほぼ黒、満月の夜は深い青）
  const nightFog = new THREE.Color(ENV_NIGHT_SKY_DARK).lerp(new THREE.Color(ENV_NIGHT_SKY_MOON), moonSkyLight())
    .lerp(new THREE.Color(0x02050f), altFactor);
  const fogColor = nightFog.lerp(dayFog, dayFactor);

  // 雨や曇りでは青みが抜けて灰色になる。稲光では一瞬明るくなる。
  // 昼夜を渡す。曇りの灰色は「昼の色」なので、夜にそのまま混ぜると
  // 地平線が昼の曇り空と同じ明るさになる（weatherApplyFogTint の説明）。
  if (typeof weatherApplyFogTint === 'function') weatherApplyFogTint(fogColor, dayFactor);

  // 霧の濃さは天候の視程から決まる（快晴200km〜濃霧0.7km）。
  // 高いところほど霞が薄いのは変わらないので、その掛け算は残す。
  const density = (typeof weatherFogDensity === 'function' ? weatherFogDensity() : ENV_BASE_FOG_DENSITY);
  EnvState.scene.fog.color.copy(fogColor);
  EnvState.scene.fog.density = density * (1 - altFactor * 0.9);
  EnvState.renderer.setClearColor(fogColor); // 空ドームの外側（遠景）にも霧色を反映させる

  // 空ドームには霧が効かないので、霧が濃いときは霞の球でふさぐ
  if (typeof weatherUpdateSkyHaze === 'function') {
    weatherUpdateSkyHaze(fogColor, EnvState.scene.fog.density);
  }
}
