// 02-env-scene.js — レンダラー・カメラ・OrbitControls・リサイズ・描画ループ

function initEnvScene() {
  const canvas = document.getElementById('envViewport');
  const centerEl = document.getElementById('envCenter');

  EnvState.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  EnvState.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  EnvState.renderer.setSize(centerEl.clientWidth, centerEl.clientHeight);
  EnvState.renderer.outputEncoding = THREE.sRGBEncoding;
  // 大気散乱シェーダーは1.0を超える明るさを返すため、トーンマッピング無しだと
  // 空の上部が白飛びし、地表も露出オーバーになる（Three.jsのSky公式サンプルと同じ設定）
  EnvState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  EnvState.renderer.toneMappingExposure = 0.6;

  EnvState.scene = new THREE.Scene();

  // nearを詰めすぎると深度バッファの精度が遠方で足りなくなり、
  // 地面と滑走路のように高さ差の小さい面が数km先で描き負ける（滑走路が消える）
  EnvState.camera = new THREE.PerspectiveCamera(
    55, centerEl.clientWidth / centerEl.clientHeight, 5, 100000
  );
  EnvState.camera.position.set(0, 60, 220);

  EnvState.orbitControls = new THREE.OrbitControls(EnvState.camera, EnvState.renderer.domElement);
  EnvState.orbitControls.enableDamping = true;
  EnvState.orbitControls.dampingFactor = 0.08;
  EnvState.orbitControls.target.set(0, 40, 0);
  EnvState.orbitControls.minDistance = 5;
  EnvState.orbitControls.maxDistance = 6000;
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
  updateDayNightCycle(dt);
  updateClouds(dt);
  updateWindsock();
  EnvState.renderer.render(EnvState.scene, EnvState.camera);
}
