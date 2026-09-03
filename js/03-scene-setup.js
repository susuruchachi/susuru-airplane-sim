// 03-scene-setup.js — Three.jsシーンの初期化とレンダーループ

function initScene() {
  const canvas = document.getElementById('viewport');
  const centerEl = document.getElementById('center');

  State.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  State.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  State.renderer.setSize(centerEl.clientWidth, centerEl.clientHeight);
  State.renderer.outputEncoding = THREE.sRGBEncoding;
  State.renderer.shadowMap.enabled = true;
  State.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  State.scene = new THREE.Scene();
  State.scene.background = new THREE.Color(0x0b1016);
  State.scene.fog = new THREE.Fog(0x0b1016, 40, 220);

  State.camera = new THREE.PerspectiveCamera(
    50, centerEl.clientWidth / centerEl.clientHeight, 0.05, 2000
  );
  State.camera.position.set(6, 4, 8);

  // ライティング
  const hemi = new THREE.HemisphereLight(0x8fb3d9, 0x1a1410, 0.9);
  State.scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(8, 12, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0015;
  State.scene.add(sun);

  const fillLight = new THREE.DirectionalLight(0x3a5a80, 0.35);
  fillLight.position.set(-6, 3, -8);
  State.scene.add(fillLight);

  // グラウンド（作業用の基準面。実際の地形は本編シーンで別途）
  const groundGeo = new THREE.CircleGeometry(200, 48);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x0e1a12, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  State.scene.add(ground);

  const grid = new THREE.GridHelper(200, 100, 0x2a3a4c, 0x18222c);
  grid.position.y = 0;
  State.scene.add(grid);

  // OrbitControls
  State.orbitControls = new THREE.OrbitControls(State.camera, State.renderer.domElement);
  State.orbitControls.enableDamping = true;
  State.orbitControls.dampingFactor = 0.08;
  State.orbitControls.target.set(0, 1, 0);
  State.orbitControls.minDistance = 0.5;
  State.orbitControls.maxDistance = 150;
  State.orbitControls.update();

  // TransformControls（パーツ配置用ギズモ）— 06-gizmo.js で本設定
  State.transformControls = new THREE.TransformControls(State.camera, State.renderer.domElement);
  State.transformControls.addEventListener('dragging-changed', (e) => {
    State.orbitControls.enabled = !e.value;
  });
  State.scene.add(State.transformControls);

  window.addEventListener('resize', onWindowResize);
  window.addEventListener('orientationchange', () => {
    // 一部ブラウザはorientationchange直後にまだ新しいビューポート寸法を反映していないため、少し遅らせて再計算する
    setTimeout(onWindowResize, 250);
  });
  animate();
}

function onWindowResize() {
  const centerEl = document.getElementById('center');
  const w = centerEl.clientWidth, h = centerEl.clientHeight;
  State.camera.aspect = w / h;
  State.camera.updateProjectionMatrix();
  State.renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  State.orbitControls.update();
  updateAxisReadout();
  State.renderer.render(State.scene, State.camera);
}

// フレームさせるモデルに合わせてカメラを寄せる
function frameCameraToObject(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.5);

  State.model.boundingRadius = radius;
  State.orbitControls.target.copy(center);
  const dir = new THREE.Vector3(1, 0.6, 1).normalize();
  State.camera.position.copy(center.clone().add(dir.multiplyScalar(radius * 2.4)));
  State.camera.near = Math.max(radius / 500, 0.01);
  State.camera.far = Math.max(radius * 200, 500);
  State.camera.updateProjectionMatrix();
  State.orbitControls.minDistance = radius * 0.05;
  State.orbitControls.maxDistance = radius * 20;
  State.orbitControls.update();
}
