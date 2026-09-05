// 04-model-loader.js — GLB/GLTFの読込（ファイル選択 / D&D / 保存済み復元）

const gltfLoader = new THREE.GLTFLoader();

function clearCurrentModel() {
  if (State.model.root) {
    // 重心ギズモがモデルの子になっている場合、モデルごと消えないようシーン直下に戻してから外す
    if (State.cg.gizmo && State.cg.gizmo.parent === State.model.root) {
      State.model.root.remove(State.cg.gizmo);
      State.scene.add(State.cg.gizmo);
    }
    State.scene.remove(State.model.root);
    State.model.root = null;
  }
  State.model.meshRoots = [];
  // モデルに紐づくパーツも全部消す（別モデルの座標は意味を持たないため）
  clearAllParts();
  State.model.name = null;
  State.model.fileBuffer = null;
  State.model.weightKg = 1000;
  State.model.maxSpeedValue = 250;
  State.model.maxSpeedUnit = 'kt';
  State.cg.position = { x: 0, y: 0, z: 0 };
  if (State.cg.gizmo) hideCgGizmo();
}

function loadModelFromArrayBuffer(arrayBuffer, fileName, fileType) {
  return new Promise((resolve, reject) => {
    const onLoaded = (gltf) => {
      clearCurrentModel();

      const root = gltf.scene;
      root.traverse(obj => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      // 実モデルのメッシュ群（ギズモ等を子として足す前の状態）を控えておく。
      // 後からパーツのギズモや重心ギズモがrootの子として追加されるため、
      // 「モデル本体だけ」のバウンディングボックスを測りたい場面（左右中心合わせ等）ではこちらを使う。
      State.model.meshRoots = root.children.slice();

      // 原点をモデルの中心（底面基準）に合わせて扱いやすくする
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const minY = box.min.y;
      root.position.x -= center.x;
      root.position.z -= center.z;
      root.position.y -= minY;

      State.scene.add(root);
      State.model.root = root;
      State.model.name = fileName;
      State.model.fileBuffer = arrayBuffer;
      State.model.fileType = fileType;

      frameCameraToObject(root);

      // 重心ギズモをモデルの子として付け替える（モデル本体の回転/拡縮に自動追従させるため）
      if (State.cg.gizmo.parent) State.cg.gizmo.parent.remove(State.cg.gizmo);
      root.add(State.cg.gizmo);

      // 重心の初期位置：モデル中心の高さ30%あたり（デフォルト値、後で調整可能）
      State.cg.position = { x: 0, y: State.model.boundingRadius * 0.15, z: 0 };
      showCgGizmo();

      updateModelInfoPanel();
      document.getElementById('dropHint').classList.add('hidden');
      resolve(root);
    };

    if (fileType === 'gltf') {
      // .gltf（JSON）はテキストとしてパースする必要がある。バイナリ埋め込み前提で単体パースを試みる
      const text = new TextDecoder('utf-8').decode(arrayBuffer);
      try {
        const json = JSON.parse(text);
        gltfLoader.parse(JSON.stringify(json), '', onLoaded, reject);
      } catch (e) {
        reject(e);
      }
    } else {
      gltfLoader.parse(arrayBuffer, '', onLoaded, reject);
    }
  });
}

// 現在の向き（root.rotation）はそのままに、モデルの左右中心をワールド原点のX=0に合わせる。
// root.positionを一時的に0にしてバウンディングボックスを測ることで、
// 「今の向きを保ったまま原点に置いたときの中心」を求め、そのX成分だけroot.positionに反映する。
// 位置を変更した直後はmatrixWorldがまだ更新されていないため、Box3を測る前に
// updateMatrixWorld(true)を明示的に呼んで反映させる（呼ばないと古い位置のまま計算されてズレる）。
// バウンディングボックスは State.model.meshRoots（＝モデル本来のメッシュ群）だけを対象にする。
// root自体には重心ギズモやパーツのギズモも子として乗っているため、rootをそのまま測ると
// それらの位置まで含んだ中心になってしまい、ボタンを押すたびに結果がズレ続ける原因になる。
function centerModelLeftRight() {
  const root = State.model.root;
  if (!root) return;
  const meshRoots = (State.model.meshRoots && State.model.meshRoots.length) ? State.model.meshRoots : [root];
  const originalX = root.position.x;
  root.position.x = 0;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  meshRoots.forEach(obj => box.expandByObject(obj));
  const center = box.getCenter(new THREE.Vector3());
  root.position.x = originalX - center.x;
  root.updateMatrixWorld(true);
}

function loadModelFromFile(file) {
  const ext = file.name.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
  return file.arrayBuffer().then(buf => loadModelFromArrayBuffer(buf, file.name, ext));
}

function updateModelInfoPanel() {
  const nameEl = document.querySelector('#modelInfo .name');
  const metaEl = document.getElementById('modelMeta');
  if (State.model.name) {
    nameEl.textContent = State.model.name;
    const sizeKb = State.model.fileBuffer ? Math.round(State.model.fileBuffer.byteLength / 1024) : 0;
    metaEl.textContent = `${State.model.fileType.toUpperCase()} ・ ${sizeKb.toLocaleString()} KB`;
  } else {
    nameEl.textContent = 'モデル未読込';
    metaEl.textContent = 'GLB / GLTFファイルを読み込んでください';
  }
  renderModelSettingsPanel();
}

function setupModelLoaderUI() {
  const fileInput = document.getElementById('fileInput');
  const btnLoad = document.getElementById('btnLoadModel');
  const centerEl = document.getElementById('center');
  const dropHint = document.getElementById('dropHint');

  btnLoad.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await loadModelFromFile(file);
      showToast(`「${file.name}」を読み込みました`);
    } catch (err) {
      console.error(err);
      showToast('モデルの読込に失敗しました', true);
    }
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt => {
    centerEl.addEventListener(evt, (e) => {
      e.preventDefault();
      dropHint.classList.remove('hidden');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    centerEl.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'dragleave' && e.target !== centerEl) return;
      if (State.model.root) dropHint.classList.add('hidden');
    });
  });
  centerEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.(glb|gltf)$/i.test(file.name)) {
      showToast('.glb または .gltf ファイルを選んでください', true);
      return;
    }
    try {
      await loadModelFromFile(file);
      showToast(`「${file.name}」を読み込みました`);
    } catch (err) {
      console.error(err);
      showToast('モデルの読込に失敗しました', true);
    }
  });
}
