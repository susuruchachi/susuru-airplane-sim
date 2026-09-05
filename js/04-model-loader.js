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
  // モデルに紐づくパーツも全部消す（別モデルの座標は意味を持たないため）
  clearAllParts();
  State.model.name = null;
  State.model.fileBuffer = null;
  State.model.weightKg = 1000;
  State.model.maxSpeedValue = 250;
  State.model.maxSpeedUnit = 'kt';
  State.model.meshOffset = { x: 0, y: 0, z: 0 };
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
      // モデル本体のメッシュ群と、後から追加されるパーツ/重心ギズモを区別するための印。
      // 「原点を左右中心に揃える」機能で、モデル本体だけを動かすために使う
      for (const child of root.children) {
        child.userData.isModelMeshRoot = true;
      }

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

// モデル本体のメッシュ群だけのバウンディングボックスを求める
// （パーツのギズモや重心マーカーはmodel.rootの子として混在しているため、それらを除外する）
function computeModelMeshBoundingBox() {
  if (!State.model.root) return null;
  const box = new THREE.Box3();
  let found = false;
  for (const child of State.model.root.children) {
    if (!child.userData.isModelMeshRoot) continue;
    const childBox = new THREE.Box3().setFromObject(child);
    if (childBox.isEmpty()) continue;
    if (found) box.union(childBox);
    else { box.copy(childBox); found = true; }
  }
  return found ? box : null;
}

// モデルの寸法から「左右（翼幅）方向がどの軸か」を推定する。
// 上下は最も短い軸とみなし、残る水平2軸のうち短い方を左右とする
// （多くの機体で 全長 > 翼幅 のため）。あくまで初期値の提案であり、ユーザーが選び直せる
function guessLateralAxis() {
  const box = computeModelMeshBoundingBox();
  if (!box) return 'x';
  const size = box.getSize(new THREE.Vector3());
  const dims = [{ axis: 'x', len: size.x }, { axis: 'y', len: size.y }, { axis: 'z', len: size.z }];
  dims.sort((a, b) => a.len - b.len);
  // dims[0]が最短（上下とみなす）、dims[1]とdims[2]が水平2軸。そのうち短いdims[1]を左右とする
  return dims[1].axis;
}

// 機体モデル本体を、画面上の見た目の軸（ワールド座標系）で指定方向に動かし、
// 原点がモデルのその軸方向の中心に来るようにする。
// 機体の向き(root.rotation)が回っていても、見た目通りの軸で揃うよう、
// ワールドでの移動量をrootのローカル座標系に変換してからメッシュへ適用する。
// パーツ・重心ギズモは動かさない（ユーザーが配置した位置をそのまま保つ）ため、
// 既にパーツを置いている場合は相対位置がずれる点を呼び出し側で警告する
function centerModelOnAxis(axis) {
  if (!State.model.root) return null;
  const box = computeModelMeshBoundingBox(); // setFromObjectはワールド基準のbboxを返す
  if (!box) return null;

  const center = box.getCenter(new THREE.Vector3());

  // ワールド座標系での移動ベクトル（指定軸方向にだけ、中心を原点へ寄せる）
  const worldShift = new THREE.Vector3(0, 0, 0);
  worldShift[axis] = -center[axis];

  // それをrootのローカル座標系へ変換する。
  // rootの回転・スケールの逆変換を掛けることで、「見た目でその方向へ動く」ローカル移動量になる
  State.model.root.updateMatrixWorld(true);
  const rootQuat = new THREE.Quaternion();
  State.model.root.getWorldQuaternion(rootQuat);
  // 単位クォータニオンの逆元は共役（虚部の符号反転）と等しい。
  // Quaternion.invert()はThree.jsのバージョンによって名称が異なる（旧inverse）ため、依存せず自前で作る
  const invQuat = new THREE.Quaternion(-rootQuat.x, -rootQuat.y, -rootQuat.z, rootQuat.w);
  const localShift = worldShift.clone().applyQuaternion(invQuat);
  const rootScale = new THREE.Vector3();
  State.model.root.getWorldScale(rootScale);
  localShift.x /= (rootScale.x || 1);
  localShift.y /= (rootScale.y || 1);
  localShift.z /= (rootScale.z || 1);

  for (const child of State.model.root.children) {
    if (!child.userData.isModelMeshRoot) continue;
    child.position.x += localShift.x;
    child.position.y += localShift.y;
    child.position.z += localShift.z;
  }
  // 保存・復元で同じ状態を再現できるよう、ローカル移動量の累計を記録する
  State.model.meshOffset.x += localShift.x;
  State.model.meshOffset.y += localShift.y;
  State.model.meshOffset.z += localShift.z;

  return { axis, shift: worldShift[axis], previousCenter: center[axis] };
}

// 保存データから復元するときに、記録しておいた原点調整量をモデル本体へ適用し直す
function applyMeshOffset(offset) {
  if (!State.model.root || !offset) return;
  for (const child of State.model.root.children) {
    if (!child.userData.isModelMeshRoot) continue;
    child.position.x += offset.x || 0;
    child.position.y += offset.y || 0;
    child.position.z += offset.z || 0;
  }
  State.model.meshOffset = { x: offset.x || 0, y: offset.y || 0, z: offset.z || 0 };
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
