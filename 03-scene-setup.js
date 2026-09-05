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

  State.cameraMode = 'perspective'; // perspective | orthographic
  State.perspectiveCamera = new THREE.PerspectiveCamera(
    50, centerEl.clientWidth / centerEl.clientHeight, 0.05, 2000
  );
  State.perspectiveCamera.position.set(6, 4, 8);
  State.orthoCamera = createOrthoCamera(centerEl.clientWidth / centerEl.clientHeight);
  State.orthoCamera.position.set(6, 4, 8);
  State.camera = State.perspectiveCamera;

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

// 直交投影カメラを、現在の透視投影カメラの画角相当の表示範囲になるよう生成する
function createOrthoCamera(aspect) {
  const frustumHalfHeight = 5; // 初期の表示半高（切替時にsyncOrthoFrustumToDistanceで実距離に合わせ直す）
  const cam = new THREE.OrthographicCamera(
    -frustumHalfHeight * aspect, frustumHalfHeight * aspect,
    frustumHalfHeight, -frustumHalfHeight,
    0.05, 2000
  );
  return cam;
}

// 直交投影カメラのフラスタム半高を、現在のカメラ〜target距離とパースの画角から逆算して合わせる
// （切替時に「同じくらいの大きさで見える」ようにするための調整）
function syncOrthoFrustumToDistance() {
  const dist = State.perspectiveCamera.position.distanceTo(State.orbitControls.target);
  const vFovRad = THREE.MathUtils.degToRad(State.perspectiveCamera.fov);
  const halfHeight = Math.tan(vFovRad / 2) * dist;
  const aspect = State.orthoCamera.right !== State.orthoCamera.left
    ? (State.orthoCamera.right - State.orthoCamera.left) / (State.orthoCamera.top - State.orthoCamera.bottom)
    : 1;
  State.orthoCamera.top = halfHeight;
  State.orthoCamera.bottom = -halfHeight;
  State.orthoCamera.left = -halfHeight * aspect;
  State.orthoCamera.right = halfHeight * aspect;
  State.orthoCamera.updateProjectionMatrix();
}

// 遠近法（パース）⇔ 平行投影（オルソ）の切替
// 位置・向き・OrbitControlsのtargetは引き継ぎ、見た目の大きさもできるだけ揃える
function toggleCameraProjection() {
  const fromCam = State.camera;
  const toCam = State.cameraMode === 'perspective' ? State.orthoCamera : State.perspectiveCamera;

  toCam.position.copy(fromCam.position);
  toCam.quaternion.copy(fromCam.quaternion);
  toCam.up.copy(fromCam.up);

  if (toCam.isOrthographicCamera) {
    syncOrthoFrustumToDistance();
  }

  State.camera = toCam;
  State.cameraMode = State.cameraMode === 'perspective' ? 'orthographic' : 'perspective';

  // OrbitControls / TransformControls の対象カメラを差し替える
  State.orbitControls.object = State.camera;
  State.transformControls.camera = State.camera;

  onWindowResize(); // アスペクト比・投影行列を現在のcanvasサイズで再計算
  updateCameraModeButton();
}

function updateCameraModeButton() {
  const btn = document.getElementById('btnToggleProjection');
  if (!btn) return;
  const isOrtho = State.cameraMode === 'orthographic';
  btn.classList.toggle('active', isOrtho);
  btn.title = isOrtho ? '平行投影（クリックで遠近法に戻す）' : '遠近法（クリックで平行投影に切替）';
}

function setupCameraProjectionToggle() {
  const btn = document.getElementById('btnToggleProjection');
  if (!btn) return;
  btn.addEventListener('click', toggleCameraProjection);
  updateCameraModeButton();
}

function onWindowResize() {
  const centerEl = document.getElementById('center');
  const w = centerEl.clientWidth, h = centerEl.clientHeight;
  const aspect = w / h;

  State.perspectiveCamera.aspect = aspect;
  State.perspectiveCamera.updateProjectionMatrix();

  const halfHeight = (State.orthoCamera.top - State.orthoCamera.bottom) / 2;
  State.orthoCamera.left = -halfHeight * aspect;
  State.orthoCamera.right = halfHeight * aspect;
  State.orthoCamera.updateProjectionMatrix();

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
  const camPos = center.clone().add(dir.multiplyScalar(radius * 2.4));

  State.perspectiveCamera.position.copy(camPos);
  State.perspectiveCamera.near = Math.max(radius / 500, 0.01);
  State.perspectiveCamera.far = Math.max(radius * 200, 500);
  State.perspectiveCamera.updateProjectionMatrix();

  State.orthoCamera.position.copy(camPos);
  State.orthoCamera.near = Math.max(radius / 500, 0.01);
  State.orthoCamera.far = Math.max(radius * 200, 500);
  if (State.cameraMode === 'orthographic') syncOrthoFrustumToDistance();
  else State.orthoCamera.updateProjectionMatrix();

  State.orbitControls.minDistance = radius * 0.05;
  State.orbitControls.maxDistance = radius * 20;
  State.orbitControls.update();
}
