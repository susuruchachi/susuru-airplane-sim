// 08-env-storage.js — 環境プレビューの設定の保存と読み込み
//
// 保存するのは「マップの定義（js/env/03b-world.js）からの変更ぶん」だけ。
// 地形・国・都市・空港の位置は種から決まる固定のものなので保存する必要がない。
// 逆にいうと、世界の定義を変えた保存データは意味を失う。そのために種と一辺を
// 一緒に書いておき、読み込むときに食い違いを知らせる。
//
// 保存先は2つ。
//   - localStorage：触るたびに自動で入る。次に開いたときそのまま復元される。
//   - .json ファイル：書き出し／読み込み。端末をまたいで持ち運ぶ用。

const ENV_STORAGE_KEY = 'flightSimEnvSettings';
const ENV_SNAPSHOT_VERSION = 1;

let _envSaveTimer = null;

// いまの設定を、保存できる形にまとめる
function collectEnvSnapshot() {
  const airports = {};
  for (const id in EnvState.airportSettings) {
    // 定義と同じものは書かない（保存データを小さく、かつ読みやすく保つ）
    if (airportSettingsChanged(id)) airports[id] = { ...EnvState.airportSettings[id] };
  }

  return {
    kind: 'flight-sim-env',
    version: ENV_SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    world: { seed: WORLD_SEED, size: WORLD_SIZE },
    time: {
      hours: EnvState.time.hours,
      cycleMinutes: EnvState.time.cycleMinutes,
      paused: EnvState.time.paused,
    },
    env: {
      cloudCoverage: EnvState.env.cloudCoverage,
      windSpeedKmh: EnvState.env.windSpeedKmh,
      windDirectionDeg: EnvState.env.windDirectionDeg,
      previewAltitudeM: EnvState.env.previewAltitudeM,
      labelsVisible: EnvState.env.labelsVisible,
      treesVisible: EnvState.env.treesVisible,
      radarVisible: EnvState.env.radarVisible,
      windFromWeather: EnvState.env.windFromWeather,
    },
    weather: {
      presetId: EnvState.weather.presetId,
      manual: { ...EnvState.weather.manual },
    },
    flight: {
      configName: EnvState.flight.configName,
      cameraMode: EnvState.flight.cameraMode,
      cgOffsets: EnvState.flight.cgOffsets,
      touchControls: document.body.classList.contains('touch-controls'),
      // 自動操縦は入切そのものは保存しない（次に開いたとき勝手に飛び出さないように）。
      // 目的地と目標高度だけを覚えておく。
      autopilot: EnvState.flight.autopilot ? {
        targetAltitudeM: EnvState.flight.autopilot.targetAltitudeM,
        destAirportId: EnvState.flight.autopilot.destAirportId,
      } : null,
    },
    selectedAirportId: EnvState.selectedAirportId,
    airports,
  };
}

// 読み込んだ設定を今のシーンへ流し込む。
// 知らない空港IDは黙って飛ばす（世界の定義が変わっても壊れないように）。
function applyEnvSnapshot(data) {
  if (!data || data.kind !== 'flight-sim-env') throw new Error('環境プレビューの設定ファイルではありません');

  const notes = [];
  if (data.world && (data.world.seed !== WORLD_SEED || data.world.size !== WORLD_SIZE)) {
    notes.push('別の世界（種または広さが違う）の設定です。空港の設定は一致するものだけ反映しました。');
  }

  if (data.time) {
    if (typeof data.time.hours === 'number') EnvState.time.hours = data.time.hours;
    if (typeof data.time.cycleMinutes === 'number') EnvState.time.cycleMinutes = data.time.cycleMinutes;
    if (typeof data.time.paused === 'boolean') EnvState.time.paused = data.time.paused;
  }
  if (data.env) {
    for (const k of ['cloudCoverage', 'windSpeedKmh', 'windDirectionDeg', 'previewAltitudeM']) {
      if (typeof data.env[k] === 'number') EnvState.env[k] = data.env[k];
    }
    if (typeof data.env.labelsVisible === 'boolean') EnvState.env.labelsVisible = data.env.labelsVisible;
    if (typeof data.env.treesVisible === 'boolean') EnvState.env.treesVisible = data.env.treesVisible;
    if (typeof data.env.radarVisible === 'boolean') EnvState.env.radarVisible = data.env.radarVisible;
    if (typeof data.env.windFromWeather === 'boolean') EnvState.env.windFromWeather = data.env.windFromWeather;
  }

  if (data.weather) {
    // 知らないプリセットIDは無視する（将来プリセットを増減しても壊れない）
    if (weatherPresetById(data.weather.presetId).id === data.weather.presetId) {
      EnvState.weather.presetId = data.weather.presetId;
    }
    const m = data.weather.manual;
    if (m) {
      for (const k of ['wetness', 'storminess', 'fogginess']) {
        if (typeof m[k] === 'number') EnvState.weather.manual[k] = Math.min(Math.max(m[k], 0), 1);
      }
    }
  }

  if (data.flight) applyFlightSnapshot(data.flight);

  let applied = 0, skipped = 0;
  if (data.airports) {
    for (const id in data.airports) {
      const def = worldAirportById(id);
      if (!def) { skipped++; continue; }
      const s = getAirportSettings(id);
      const src = data.airports[id];
      if (typeof src.runwayLengthM === 'number') {
        // 地形をならしてある範囲を超える長さは受け付けない（滑走路が斜面に乗ってしまう）
        s.runwayLengthM = Math.min(Math.max(src.runwayLengthM, 800), def.maxRunwayLengthM);
      }
      if (typeof src.runwayWidthM === 'number') s.runwayWidthM = Math.min(Math.max(src.runwayWidthM, 23), 60);
      if (typeof src.headingDeg === 'number') s.headingDeg = ((src.headingDeg % 360) + 360) % 360;
      if (src.lightsMode === 'auto' || src.lightsMode === 'on' || src.lightsMode === 'off') s.lightsMode = src.lightsMode;
      if (typeof src.visible === 'boolean') s.visible = src.visible;
      applied++;
    }
  }
  if (skipped) notes.push(`${skipped}件の空港は今の世界に存在しないため読み飛ばしました。`);

  if (data.selectedAirportId && worldAirportById(data.selectedAirportId)) {
    EnvState.selectedAirportId = data.selectedAirportId;
  }

  // 建て直し：設定を変えた空港が今建っているなら作り直す
  for (const id in EnvState.airportSettings) {
    const entry = EnvState.builtAirports.get(id);
    if (entry) populateAirportGroup(entry, EnvState.airportSettings[id]);
  }

  return { applied, skipped, notes };
}

// 飛行の設定を戻す。機体の候補は IndexedDB を読んでからでないと揃わないので、
// ここだけは initFlight のあとからもう一度呼べるように切り出してある
// （読み込みは起動処理より先に走るため、1回目では機体名が捨てられてしまう）。
function applyFlightSnapshot(flight) {
  if (!flight) return;
  // 機体は「今そこにある候補」の中にあるときだけ戻す（Builderで消された機体を掴まないため）
  if (typeof flight.configName === 'string'
      && EnvState.flight.configs.some((c) => c.name === flight.configName)) {
    EnvState.flight.configName = flight.configName;
  }
  if (typeof FLIGHT_CAMERA_MODES !== 'undefined'
      && FLIGHT_CAMERA_MODES.some((m) => m.id === flight.cameraMode)) {
    EnvState.flight.cameraMode = flight.cameraMode;
  }
  // 重心のずれ。数値以外や無限大が入っていたら捨てる（保存が壊れても飛べるように）
  if (flight.cgOffsets && typeof flight.cgOffsets === 'object') {
    for (const name in flight.cgOffsets) {
      const o = flight.cgOffsets[name];
      if (!o || typeof o !== 'object') continue;
      const clean = {};
      for (const k of ['x', 'y', 'z']) {
        clean[k] = Number.isFinite(o[k]) ? Math.min(Math.max(o[k], -500), 500) : 0;
      }
      EnvState.flight.cgOffsets[name] = clean;
    }
  }
  // 画面の操縦装置は、一度でも自分で切り替えたならその選択を尊重する
  // （タッチ画面でも消せるし、マウスしか無い端末でも出せる）
  if (typeof flight.touchControls === 'boolean' && typeof setFlightTouchEnabled === 'function') {
    setFlightTouchEnabled(flight.touchControls);
  }

  // 自動操縦の行き先と高度。知らない空港IDは黙って捨てる（世界が変わっても壊れない）
  if (flight.autopilot && typeof flightAutopilot === 'function') {
    const ap = flightAutopilot();
    const alt = flight.autopilot.targetAltitudeM;
    if (Number.isFinite(alt)) ap.targetAltitudeM = Math.min(Math.max(alt, 100), 12000);
    if (typeof flight.autopilot.destAirportId === 'string'
        && worldAirportById(flight.autopilot.destAirportId)) {
      ap.destAirportId = flight.autopilot.destAirportId;
    }
    if (typeof updateAutopilotUI === 'function') updateAutopilotUI();
    const sel = document.getElementById('envApDestination');
    if (sel) sel.value = ap.destAirportId || '';
  }
}

// 保存されている飛行の設定だけを読み直す（機体の一覧が揃ったあとに呼ぶ）
function reapplyStoredFlightSelection() {
  try {
    const raw = localStorage.getItem(ENV_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && data.flight) applyFlightSnapshot(data.flight);
  } catch (err) { /* 読めなくても既定の機体で飛べる */ }
}

// --- localStorage ------------------------------------------------------------

// 触るたびに呼ばれるので、書き込みは少し待ってからまとめて行う
function saveAirportSettings() {
  if (_envSaveTimer) clearTimeout(_envSaveTimer);
  _envSaveTimer = setTimeout(writeEnvToStorage, 400);
}

function writeEnvToStorage() {
  _envSaveTimer = null;
  try {
    localStorage.setItem(ENV_STORAGE_KEY, JSON.stringify(collectEnvSnapshot()));
    setEnvStorageStatus('この端末に保存済み');
  } catch (err) {
    // プライベートモードや容量超過。動作は続けられるので知らせるだけにする
    setEnvStorageStatus('この端末には保存できません（' + (err && err.name ? err.name : 'エラー') + '）');
  }
}

function loadEnvFromStorage() {
  let raw = null;
  try {
    raw = localStorage.getItem(ENV_STORAGE_KEY);
  } catch (err) {
    return null;
  }
  if (!raw) return null;
  try {
    const result = applyEnvSnapshot(JSON.parse(raw));
    const when = JSON.parse(raw).savedAt;
    setEnvStorageStatus(`この端末の保存を復元（${when ? when.slice(0, 16).replace('T', ' ') : '日時不明'}）`);
    return result;
  } catch (err) {
    console.warn('保存されていた環境設定を読み込めませんでした:', err);
    return null;
  }
}

function clearEnvStorage() {
  try { localStorage.removeItem(ENV_STORAGE_KEY); } catch (err) { /* 消せなくても続行 */ }
  EnvState.airportSettings = {};
  for (const [id, entry] of EnvState.builtAirports) {
    populateAirportGroup(entry, getAirportSettings(id));
  }
  setEnvStorageStatus('保存を消しました');
}

// --- ファイルの書き出し／読み込み ---------------------------------------------

function exportEnvJSON() {
  const data = collectEnvSnapshot();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flight-sim-env-${ENV_VERSION}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const n = Object.keys(data.airports).length;
  setEnvStorageStatus(`書き出しました（変更した空港 ${n} 件）`);
}

function importEnvJSONFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const result = applyEnvSnapshot(JSON.parse(reader.result));
      syncEnvUIToState();
      writeEnvToStorage();
      const msg = [`読み込みました（空港 ${result.applied} 件）`].concat(result.notes);
      setEnvStorageStatus(msg.join(' / '));
    } catch (err) {
      setEnvStorageStatus('読み込めませんでした: ' + (err && err.message ? err.message : String(err)));
    }
  };
  reader.onerror = () => setEnvStorageStatus('ファイルを読めませんでした');
  reader.readAsText(file);
}

function setEnvStorageStatus(text) {
  const el = document.getElementById('envStorageStatus');
  if (el) el.textContent = text;
}
