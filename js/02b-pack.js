// 02b-pack.js — 機体と設定を1つのZIPにまとめる／ZIPから戻す（index.html・flight.html の両方が読む）
//
// ZIPは自前で読み書きする（外部のライブラリを増やさない。オフラインのアプリでも動くように）。
//   ・書くとき … 圧縮はブラウザの CompressionStream('deflate-raw')。使えないブラウザや、
//     縮まないファイル（圧縮済みの画像だけのGLBなど）は無圧縮で入れる
//   ・読むとき … 無圧縮と deflate を読める。deflate は DecompressionStream を使う。
//     中身の場所と大きさは末尾の目次（セントラルディレクトリ）から取るので、
//     Mac の Finder や Windows で作り直したZIPでも読める
//   ・ファイル名は UTF-8（日本語の機体名がそのまま入る）
//   ・4GBを超えるZIP（ZIP64）は扱わない
//
// ZIPの中身（「機体パック」）:
//   pack.json                       … 何が入っているかの目録（kind: 'flight-sim-pack'）
//   aircraft/<機体名>/config.json   … 設定（部品・重心・向き・重さ…）。単体の .json としても読める
//   aircraft/<機体名>/<モデルのファイル名>  … 3Dモデル本体（.glb / .gltf）
//   env.json                        … 飛行画面の設定（時刻・天候・風・空港の変更…）。まとめて書き出したときだけ
// 読むときは目録に頼らず、どこかの階層にある config.json を1機ずつ拾う
// （展開してフォルダごと圧縮し直すと、1段深いところに入るため）。

const PACK_KIND = 'flight-sim-pack';
const PACK_VERSION = 1;
const PACK_AIRCRAFT_KIND = 'flight-sim-aircraft';
const PACK_DB_NAME = 'flightSimDB';
const PACK_STORE_CONFIGS = 'configs';
const PACK_STORE_META = 'meta';
const PACK_ENV_STORAGE_KEY = 'flightSimEnvSettings';   // 08-env-storage.js の ENV_STORAGE_KEY と同じ

// --- CRC-32 -------------------------------------------------------------------

let _packCrcTable = null;
function packCrc32(bytes) {
  if (!_packCrcTable) {
    _packCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _packCrcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _packCrcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- 圧縮・展開 ---------------------------------------------------------------

async function packStreamBytes(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

async function packDeflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try { return await packStreamBytes(bytes, new CompressionStream('deflate-raw')); } catch (err) { return null; }
}

async function packInflate(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザは圧縮されたZIPを開けません（無圧縮のZIPなら開けます）');
  }
  return packStreamBytes(bytes, new DecompressionStream('deflate-raw'));
}

function packToBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

// --- ZIPを書く ----------------------------------------------------------------

// files: [{ name, data: Uint8Array|ArrayBuffer|string, date?: Date }] → ZIPのバイト列（Uint8Array）
async function zipBuild(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const raw = packToBytes(f.data);
    const nameBytes = enc.encode(f.name);
    const crc = packCrc32(raw);
    const deflated = raw.length > 64 ? await packDeflate(raw) : null;
    const useDeflate = !!deflated && deflated.length < raw.length * 0.97;
    const body = useDeflate ? deflated : raw;
    const d = f.date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const method = useDeflate ? 8 : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);            // 展開に要る版（2.0）
    local.setUint16(6, 0x0800, true);        // ファイル名は UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, body);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, raw.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  let cenSize = 0;
  for (const c of central) cenSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
  let total = 0;
  for (const c of all) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

// --- ZIPを読む ----------------------------------------------------------------

// ZIPのバイト列 → [{ name, data: Uint8Array }]（フォルダの項目は除く）
async function zipParse(buffer) {
  const bytes = packToBytes(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 末尾の目録の終わり（コメントが付いていることがあるので後ろから探す）
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIPファイルではありません');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('4GBを超えるZIP（ZIP64）は開けません');
  const utf8 = new TextDecoder('utf-8');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPの目録が壊れています');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    const nameRaw = bytes.subarray(p + 46, p + 46 + nameLen);
    // UTF-8 の印が無い古いZIPは、ASCII の範囲ならそのまま読める
    const name = utf8.decode(nameRaw);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('パスワード付きのZIPは開けません');
    const lNameLen = dv.getUint16(localAt + 26, true);
    const lExtraLen = dv.getUint16(localAt + 28, true);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const body = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = body.slice();
    else if (method === 8) data = await packInflate(body);
    else throw new Error(`「${name}」の圧縮方式（${method}）は開けません`);
    if (data.length !== size || packCrc32(data) !== crc) throw new Error(`「${name}」が壊れています`);
    out.push({ name, data });
  }
  return out;
}

// --- 機体パック ---------------------------------------------------------------

// ファイル名に使えない文字を置き換える（Windows でも展開できるように）
function packSafeName(s, fallback) {
  const t = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return t.slice(0, 80) || fallback;
}

// IndexedDB の保存1件（modelBuffer 付き）→ ZIPに入れるファイル
function packAircraftFiles(record, dir) {
  const modelFile = packSafeName(record.modelName, `model.${record.modelFileType || 'glb'}`);
  const config = {};
  for (const k in record) if (k !== 'modelBuffer') config[k] = record[k];
  config.kind = PACK_AIRCRAFT_KIND;
  config.formatVersion = 2;
  config.exportedAppVersion = typeof APP_VERSION !== 'undefined' ? APP_VERSION : null;
  config.modelFile = modelFile;
  config.modelNameHint = record.modelName;
  const date = record.savedAt ? new Date(record.savedAt) : new Date();
  return [
    { name: `${dir}config.json`, data: JSON.stringify(config, null, 2), date },
    { name: `${dir}${modelFile}`, data: record.modelBuffer, date },
  ];
}

// records: IndexedDB の保存（modelBuffer 付き）の配列、env: 飛行画面の設定（無ければ null）
async function buildPackZip(records, env) {
  const files = [];
  const used = new Set();
  const list = [];
  for (const r of records) {
    if (!r || !r.modelBuffer) continue;
    let base = packSafeName(r.name, 'aircraft'), dir = base, n = 2;
    while (used.has(dir.toLowerCase())) dir = `${base}_${n++}`;
    used.add(dir.toLowerCase());
    const f = packAircraftFiles(r, `aircraft/${dir}/`);
    files.push(...f);
    list.push({ name: r.name, config: f[0].name, model: f[1].name, bytes: packToBytes(r.modelBuffer).length });
  }
  if (env) files.push({ name: 'env.json', data: JSON.stringify(env, null, 2) });
  const manifest = {
    kind: PACK_KIND, version: PACK_VERSION,
    appVersion: typeof APP_VERSION !== 'undefined' ? APP_VERSION : null,
    exportedAt: new Date().toISOString(),
    aircraft: list, env: env ? 'env.json' : null,
  };
  files.unshift({ name: 'pack.json', data: JSON.stringify(manifest, null, 2) });
  return zipBuild(files);
}

// ZIP → { aircraft: [保存1件（modelBuffer 付き）], env: 飛行画面の設定 or null, skipped: [理由] }
async function readPackZip(buffer) {
  const entries = (await zipParse(buffer)).filter((e) => !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\._/.test(e.name));
  const byName = new Map(entries.map((e) => [e.name, e]));
  const utf8 = new TextDecoder('utf-8');
  const json = (e) => { try { return JSON.parse(utf8.decode(e.data)); } catch (err) { return null; } };
  const aircraft = [], skipped = [];
  let env = null;
  for (const e of entries) {
    if (!/\.json$/i.test(e.name)) continue;
    const cfg = json(e);
    if (!cfg) continue;
    if (cfg.kind === 'flight-sim-env') { if (!env) env = cfg; continue; }
    if (!Array.isArray(cfg.parts)) continue;       // pack.json など
    const dir = e.name.slice(0, e.name.length - e.name.split('/').pop().length);
    // モデルは config.json と同じフォルダ。名前が書いてなければ、そこにある .glb / .gltf
    let model = cfg.modelFile ? byName.get(dir + cfg.modelFile) : null;
    if (!model) {
      const cands = entries.filter((m) => m.name.startsWith(dir) && !m.name.slice(dir.length).includes('/')
        && /\.(glb|gltf)$/i.test(m.name));
      if (cands.length === 1) model = cands[0];
    }
    const name = String(cfg.name || dir.replace(/\/$/, '').split('/').pop() || 'aircraft');
    if (!model) { skipped.push(`「${name}」の3Dモデルが入っていません`); continue; }
    const rec = {};
    for (const k in cfg) {
      if (['kind', 'formatVersion', 'exportedAppVersion', 'modelFile', 'modelNameHint'].includes(k)) continue;
      rec[k] = cfg[k];
    }
    rec.name = name;
    rec.savedAt = Number.isFinite(cfg.savedAt) ? cfg.savedAt : Date.now();
    rec.modelName = cfg.modelName || cfg.modelNameHint || model.name.split('/').pop();
    rec.modelFileType = cfg.modelFileType || (/\.gltf$/i.test(model.name) ? 'gltf' : 'glb');
    const d = model.data;
    rec.modelBuffer = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    aircraft.push(rec);
  }
  return { aircraft, env, skipped };
}

// --- 保存先（IndexedDB・localStorage）とのやりとり ----------------------------

function packOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PACK_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(PACK_STORE_CONFIGS)) db.createObjectStore(PACK_STORE_CONFIGS, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(PACK_STORE_META)) db.createObjectStore(PACK_STORE_META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function packAllSavedAircraft() {
  const db = await packOpenDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(PACK_STORE_CONFIGS, 'readonly').objectStore(PACK_STORE_CONFIGS).getAll();
    r.onsuccess = () => { db.close(); resolve(r.result || []); };
    r.onerror = () => { db.close(); reject(r.error); };
  });
}

// 保存に書き込む。同じ名前があれば置き換える
async function packPutAircraft(records) {
  if (!records.length) return;
  const db = await packOpenDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PACK_STORE_CONFIGS, 'readwrite');
    const st = tx.objectStore(PACK_STORE_CONFIGS);
    for (const r of records) st.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function packStoredEnv() {
  try {
    const raw = localStorage.getItem(PACK_ENV_STORAGE_KEY);
    const d = raw ? JSON.parse(raw) : null;
    return d && d.kind === 'flight-sim-env' ? d : null;
  } catch (err) { return null; }
}

function packStoreEnv(env) {
  localStorage.setItem(PACK_ENV_STORAGE_KEY, JSON.stringify(env));
}

// 取り込む前に「同じ名前の保存を置き換える」ものを数える
async function packExistingNames(records) {
  const have = new Set((await packAllSavedAircraft()).map((r) => r.name));
  return records.filter((r) => have.has(r.name)).map((r) => r.name);
}

function packDownload(bytes, fileName) {
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function packIsZipFile(file) {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

function packSizeText(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { packCrc32, zipBuild, zipParse, buildPackZip, readPackZip, packSafeName };
}
