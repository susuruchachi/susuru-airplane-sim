// 02-storage.js — IndexedDBへの設定＋モデル保存/復元
// DB構造: flightSimDB > configs ストア（key: configName）
//   { name, savedAt, modelName, modelFileType, modelBuffer(ArrayBuffer), parts:[...] }
// 別途 meta ストアに最後に保存/読込した configName を記録し、起動時自動読込に使う

const DB_NAME = 'flightSimDB';
const DB_VERSION = 1;
const STORE_CONFIGS = 'configs';
const STORE_META = 'meta';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_CONFIGS)) {
        db.createObjectStore(STORE_CONFIGS, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function dbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 現在のState.partsをシリアライズ可能な形に変換（gizmo/Object3D参照は除外）
function serializeParts() {
  return State.parts.map(p => ({
    id: p.id,
    type: p.type,
    name: p.name,
    position: { ...p.position },
    rotation: { ...p.rotation },
    scale: { ...p.scale },
    props: JSON.parse(JSON.stringify(p.props || {})),
  }));
}

async function saveCurrentConfig(configName) {
  if (!State.model.fileBuffer) {
    throw new Error('モデルが読み込まれていません');
  }
  const root = State.model.root;
  const record = {
    name: configName,
    savedAt: Date.now(),
    modelName: State.model.name,
    modelFileType: State.model.fileType,
    modelBuffer: State.model.fileBuffer,
    parts: serializeParts(),
    cg: { ...State.cg.position },
    modelTransform: root ? {
      rotation: { x: root.rotation.x, y: root.rotation.y, z: root.rotation.z }, // ラジアンのまま保存
      scale: { x: root.scale.x, y: root.scale.y, z: root.scale.z },
    } : null,
    modelWeightKg: State.model.weightKg,
    modelMaxSpeedValue: State.model.maxSpeedValue,
    modelMaxSpeedUnit: State.model.maxSpeedUnit,
    modelMeshOffset: { ...State.model.meshOffset },
  };
  await dbPut(STORE_CONFIGS, record);
  await dbPut(STORE_META, { key: 'lastConfigName', value: configName });
  State.configName = configName;
  return record;
}

// 3Dモデル本体（modelBuffer）を含まない、デバイス間で持ち運ぶ用の設定データを作る
// ファイルサイズを小さく保ち、モデルのライセンス上の懸念（バイナリ再配布）も避けるための設計
function buildPortableConfig(configName) {
  if (!State.model.root) {
    throw new Error('モデルが読み込まれていません');
  }
  const root = State.model.root;
  return {
    formatVersion: 1, // 将来のインポート側での互換性判定用
    exportedAppVersion: APP_VERSION,
    name: configName,
    savedAt: Date.now(),
    modelNameHint: State.model.name, // 参考情報。インポート時のモデル一致チェックには使わない（別モデルへの流用もできるように）
    parts: serializeParts(),
    cg: { ...State.cg.position },
    modelTransform: {
      rotation: { x: root.rotation.x, y: root.rotation.y, z: root.rotation.z },
      scale: { x: root.scale.x, y: root.scale.y, z: root.scale.z },
    },
    modelWeightKg: State.model.weightKg,
    modelMaxSpeedValue: State.model.maxSpeedValue,
    modelMaxSpeedUnit: State.model.maxSpeedUnit,
    modelMeshOffset: { ...State.model.meshOffset },
  };
}

// portable configをファイルとしてダウンロードさせる（3Dモデル本体は含まない）
function downloadPortableConfig(configName) {
  const data = buildPortableConfig(configName);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = (configName || 'flight-sim-config').replace(/[\\/:*?"<>|]/g, '_');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return data;
}

// ダウンロードされたportable configファイル(JSON)を読み込み、パース済みオブジェクトを返す
function readPortableConfigFile(file) {
  return file.text().then(text => {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.parts)) {
      throw new Error('設定ファイルの形式が正しくありません');
    }
    return data;
  });
}

async function loadConfigByName(configName) {
  const record = await dbGet(STORE_CONFIGS, configName);
  if (record) {
    await dbPut(STORE_META, { key: 'lastConfigName', value: configName });
  }
  return record;
}

async function getLastConfigName() {
  const meta = await dbGet(STORE_META, 'lastConfigName');
  return meta ? meta.value : null;
}

async function listAllConfigs() {
  return dbGetAll(STORE_CONFIGS);
}
