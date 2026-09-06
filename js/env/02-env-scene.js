// 02-env-scene.js — レンダラー・カメラ・OrbitControls・リサイズ・描画ループ

function initEnvScene() {
  const canvas = document.getElementById('envViewport');
  const centerEl = document.getElementById('envCenter');

  // 対数深度バッファ。near=5m のまま 220km 先まで描くと、通常の深度バッファでは
  // 数十km先で数十mの高低差が潰れてしまい、海面(y=0)が標高10mの島を覆い隠す。
  // 対数深度なら遠方でも精度が保たれるので、低地の島も滑走路の路面標識も破綻しない。
  EnvState.renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, logarithmicDepthBuffer: true,
  });
  EnvState.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  EnvState.renderer.setSize(centerEl.clientWidth, centerEl.clientHeight);
  EnvState.renderer.outputEncoding = THREE.sRGBEncoding;
  // 大気散乱シェーダーは1.0を超える明るさを返すため、トーンマッピング無しだと
  // 空の上部が白飛びし、地表も露出オーバーになる（Three.jsのSky公式サンプルと同じ設定）
  EnvState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  EnvState.renderer.toneMappingExposure = 0.6;

  EnvState.scene = new THREE.Scene();

  // 対数深度バッファを使っているので near を詰めても遠方の精度が落ちない。
  // far は600km四方のマップを見渡せる距離。これ以上伸ばしても大気の霞で見えない。
  EnvState.camera = new THREE.PerspectiveCamera(
    55, centerEl.clientWidth / centerEl.clientHeight, 1, 260000
  );
  EnvState.camera.position.set(0, 60, 220);

  EnvState.orbitControls = new THREE.OrbitControls(EnvState.camera, EnvState.renderer.domElement);
  EnvState.orbitControls.enableDamping = true;
  EnvState.orbitControls.dampingFactor = 0.08;
  EnvState.orbitControls.target.set(0, 40, 0);
  EnvState.orbitControls.minDistance = 5;
  EnvState.orbitControls.maxDistance = 400000;
  EnvState.orbitControls.maxPolarAngle = Math.PI * 0.495; // 地面の下を覗き込みにくくする
  EnvState.orbitControls.update();

  EnvState.clock = new THREE.Clock();

  window.addEventListener('resize', onEnvWindowResize);
  window.addEventListener('orientationchange', () => setTimeout(onEnvWindowResize, 250));
}

function onEnvWindowResize() {
  const centerEl = document.getElementById('envCenter');
  const w = centerEl.clientWidth, h = centerEl.clientHeight;
  if (!w || !h) return;
  EnvState.camera.aspect = w / h;
  EnvState.camera.updateProjectionMatrix();
  EnvState.renderer.setSize(w, h);
}

function animateEnv() {
  requestAnimationFrame(animateEnv);
  const dt = Math.min(EnvState.clock.getDelta(), 0.1);
  EnvState.orbitControls.update();
  updateFlight(dt);     // 機体を進める。カメラも地形の読み込み基準もここで決まる
  updateWeather(dt);    // 光と霧に効くので、昼夜サイクルより先に決める
  updateDayNightCycle(dt);
  updateTerrain();      // カメラが動いたぶんだけ地形タイルのLODを入れ替える
  updateVegetation();
  updateSea(dt);
  updateClouds(dt);
  updateWindsock();
  updatePlaceLabels();
  updateMinimap();
  updateEnvWorldReadout();
  EnvState.renderer.render(EnvState.scene, EnvState.camera);
}
