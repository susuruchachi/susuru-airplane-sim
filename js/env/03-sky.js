// 03-sky.js — 空（大気散乱シェーダー）・太陽・月・星・霧・仮地面
// 太陽方向はjs/env/05-daynight.jsが計算し、updateSkyForSunDirection()を毎フレーム呼ぶ。

const ENV_SUN_DISTANCE = 4000;
const ENV_MOON_DISTANCE = 4000;
const ENV_BASE_FOG_DENSITY = 0.00035;

function initSky() {
  // 大気散乱シェーダーによる空ドーム（Preethamモデル。CDNのTHREE.Skyを利用）
  EnvState.sky = new THREE.Sky();
  EnvState.sky.scale.setScalar(45000);
  EnvState.scene.add(EnvState.sky);

  const uniforms = EnvState.sky.material.uniforms;
  uniforms['turbidity'].value = 3;
  uniforms['rayleigh'].value = 1.6;
  uniforms['mieCoefficient'].value = 0.006;
  uniforms['mieDirectionalG'].value = 0.8;

  // 太陽の見た目（光源とは別に、球として描画する）
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff2d0, fog: false });
  EnvState.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(60, 16, 16), sunMat);
  EnvState.scene.add(EnvState.sunMesh);

  // 月
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xcfd6e6, fog: false });
  EnvState.moonMesh = new THREE.Mesh(new THREE.SphereGeometry(40, 16, 16), moonMat);
  EnvState.scene.add(EnvState.moonMesh);

  // 星（夜間のみフェードインする点群。地表付近は不要なので上半球寄りに分布）
  const starCount = 2500;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 9000;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 0.98);
    starPositions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.cos(phi);
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 6, sizeAttenuation: true, transparent: true, opacity: 0, fog: false,
  });
  EnvState.stars = new THREE.Points(starGeo, starMat);
  EnvState.scene.add(EnvState.stars);

  // ライト（太陽＝主光源、月＝夜間の弱い補助光、半球光＝全体の底上げ）
  EnvState.hemiLight = new THREE.HemisphereLight(0x8fb3d9, 0x2b2318, 0.6);
  EnvState.scene.add(EnvState.hemiLight);

  EnvState.sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
  EnvState.scene.add(EnvState.sunLight);

  EnvState.moonLight = new THREE.DirectionalLight(0x8fa8e0, 0);
  EnvState.scene.add(EnvState.moonLight);

  EnvState.scene.fog = new THREE.FogExp2(0xbfd6e8, ENV_BASE_FOG_DENSITY);

  // 仮の地面（陸地・海の実装はロードマップの後続項目。今は基準面として平面のみ）
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x2d5a3d });
  EnvState.ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), groundMat);
  EnvState.ground.rotation.x = -Math.PI / 2;
  EnvState.scene.add(EnvState.ground);
}

// 太陽の単位方向ベクトルと仰角(度)から、空・太陽・月・星・光源・霧の見た目をまとめて更新する
function updateSkyForSunDirection(sunDir, elevationDeg) {
  EnvState.sky.material.uniforms['sunPosition'].value.copy(sunDir);
  // Preethamモデルは仰角が下がっても十分に暗くならないため、深夜帯はドームごと隠して
  // 背景色（updateSkyColorsForAltitudeで設定する夜の霧色）と星・月だけに任せる
  EnvState.sky.visible = elevationDeg > -8;

  const moonDir = sunDir.clone().negate();
  EnvState.sunMesh.position.copy(sunDir).multiplyScalar(ENV_SUN_DISTANCE);
  EnvState.moonMesh.position.copy(moonDir).multiplyScalar(ENV_MOON_DISTANCE);
  EnvState.sunLight.position.copy(sunDir).multiplyScalar(500);
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
  EnvState.moonLight.intensity = nightFactor * 0.25;
  EnvState.moonMesh.visible = elevationDeg < 8;

  EnvState.hemiLight.intensity = 0.15 + dayFactor * 0.55;

  const starOpacity = THREE.MathUtils.clamp(1 - THREE.MathUtils.smoothstep(elevationDeg, -18, -2), 0, 1);
  EnvState.stars.material.opacity = starOpacity * 0.9;

  updateSkyColorsForAltitude(dayFactor);
  if (typeof tintClouds === 'function') tintClouds(dayFactor, warmth);
}

// 高度（プレビュー用スライダー）に応じて霧の色・濃さを変える。高いほど霞が減り、空の色が濃くなる。
function updateSkyColorsForAltitude(dayFactor) {
  const altitude = EnvState.env.previewAltitudeM;
  const altFactor = THREE.MathUtils.clamp(altitude / 12000, 0, 1); // 0=地表 1=成層圏付近

  const dayFog = new THREE.Color(0xbfd6e8).lerp(new THREE.Color(0x1c3a6e), altFactor * 0.85);
  const nightFog = new THREE.Color(0x0a1220).lerp(new THREE.Color(0x02050f), altFactor);
  const fogColor = nightFog.lerp(dayFog, dayFactor);

  EnvState.scene.fog.color.copy(fogColor);
  EnvState.scene.fog.density = ENV_BASE_FOG_DENSITY * (1 - altFactor * 0.9);
  EnvState.renderer.setClearColor(fogColor); // 空ドームの外側（遠景）にも霧色を反映させる
}
