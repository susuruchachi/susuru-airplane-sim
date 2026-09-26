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

// いま開いている機体を、IndexedDB に入れる形（3Dモデル本体 modelBuffer 付き）にまとめる
function buildCurrentRecord(configName) {
  if (!State.model.fileBuffer) {
    throw new Error('モデルが読み込まれていません');
  }
  const root = State.model.root;
  return {
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
    modelBoneAxisOverrides: { ...State.model.boneAxisOverrides },
  };
}

async function saveCurrentConfig(configName) {
  const record = buildCurrentRecord(configName);
  await dbPut(STORE_CONFIGS, record);
  await dbPut(STORE_META, { key: 'lastConfigName', value: configName });
  State.configName = configName;
  return record;
}

// いま開いている機体を、設定と3Dモデルの入った1つのZIPとしてダウンロードさせる（js/02b-pack.js の形）。
// 中の config.json は、それだけで「設定だけの .json」としても読み込める
async function downloadCurrentAircraftZip(configName) {
  const record = buildCurrentRecord(configName);
  const zip = await buildPackZip([record], null);
  packDownload(zip, `${packSafeName(configName, 'flight-sim-config')}.zip`);
  return zip.length;
}

// 保存済みの機体すべてと、飛行画面の設定（この端末に保存されているもの）を1つのZIPにする
async function downloadAllSavedZip() {
  const records = (await listAllConfigs()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const env = packStoredEnv();
  if (!records.length && !env) return null;
  const zip = await buildPackZip(records, env);
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  packDownload(zip, `flight-sim-all-${ymd}.zip`);
  return { count: records.length, env: !!env, bytes: zip.length };
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
