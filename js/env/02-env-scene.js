// 02-env-scene.js — レンダラー・カメラ・OrbitControls・リサイズ・描画ループ

function initEnvScene() {
  const canvas = document.getElementById('envViewport');
  const centerEl = document.getElementById('envCenter');

  EnvState.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  EnvState.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  EnvState.renderer.setSize(centerEl.clientWidth, centerEl.clientHeight);
  EnvState.renderer.outputEncoding = THREE.sRGBEncoding;

  EnvState.scene = new THREE.Scene();

  EnvState.camera = new THREE.PerspectiveCamera(
    55, centerEl.clientWidth / centerEl.clientHeight, 0.5, 100000
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
  EnvState.renderer.render(EnvState.scene, EnvState.camera);
}
