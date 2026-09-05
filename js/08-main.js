// 08-main.js — 起動処理・保存/読込UI・最終モデルの自動読込

function setupSaveLoadUI() {
  const btnSave = document.getElementById('btnSaveConfig');
  const btnLoadSaved = document.getElementById('btnLoadSaved');
  const btnDownload = document.getElementById('btnDownloadConfig');
  const btnImport = document.getElementById('btnImportConfig');
  const configFileInput = document.getElementById('configFileInput');
  const statusEl = document.getElementById('saveStatus');

  btnSave.addEventListener('click', async () => {
    if (!State.model.root) {
      showToast('保存するにはまずモデルを読み込んでください', true);
      return;
    }
    let name = State.configName;
    const input = prompt('保存名を入力してください', name || State.model.name || 'default');
    if (input === null) return; // キャンセル
    name = input.trim() || 'default';

    statusEl.textContent = '保存中…';
    try {
      await saveCurrentConfig(name);
      statusEl.textContent = `「${name}」を保存しました（${formatNow()}）`;
      showToast('設定とモデルを保存しました');
    } catch (err) {
      console.error(err);
      statusEl.textContent = '保存に失敗しました';
      showToast('保存に失敗しました', true);
    }
  });

  btnLoadSaved.addEventListener('click', async () => {
    const configs = await listAllConfigs();
    if (configs.length === 0) {
      showToast('保存済みの設定がありません', true);
      return;
    }
    const listText = configs
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((c, i) => `${i + 1}. ${c.name}（${c.modelName || '不明'} / ${new Date(c.savedAt).toLocaleString('ja-JP')}）`)
      .join('\n');
    const choice = prompt(`読み込む設定の番号を入力してください:\n\n${listText}`, '1');
    if (choice === null) return;
    const idx = parseInt(choice, 10) - 1;
    const sorted = configs.sort((a, b) => b.savedAt - a.savedAt);
    const record = sorted[idx];
    if (!record) {
      showToast('番号が正しくありません', true);
      return;
    }
    await applyLoadedConfig(record);
  });

  // 3Dモデル本体を含まない設定ファイル(.json)をダウンロード — デバイス間で設定だけ持ち運ぶ用
  btnDownload.addEventListener('click', () => {
    if (!State.model.root) {
      showToast('ダウンロードするにはまずモデルを読み込んでください', true);
      return;
    }
    const defaultName = State.configName || State.model.name || 'flight-sim-config';
    const input = prompt('ダウンロードする設定の名前を入力してください', defaultName);
    if (input === null) return; // キャンセル
    const name = input.trim() || 'flight-sim-config';
    try {
      downloadPortableConfig(name);
      showToast('設定ファイルをダウンロードしました（3Dモデル本体は含まれません）');
    } catch (err) {
      console.error(err);
      showToast('ダウンロードに失敗しました', true);
    }
  });

  // 設定ファイル(.json)を読み込んで、今開いているモデルに適用する
  btnImport.addEventListener('click', () => {
    if (!State.model.root) {
      showToast('設定を読み込む前に、まず機体モデルを読み込んでください', true);
      return;
    }
    configFileInput.click();
  });
  configFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await readPortableConfigFile(file);
      applyConfigDataToCurrentModel(data);
      State.configName = data.name || State.configName;
      statusEl.textContent = `「${data.name || 'インポートした設定'}」を適用しました`;
      showToast('設定を読み込みました（今開いているモデルに適用されました）');
    } catch (err) {
      console.error(err);
      showToast('設定ファイルの読込に失敗しました。ファイル形式を確認してください', true);
    }
    configFileInput.value = '';
  });
}

async function applyLoadedConfig(record) {
  try {
    await loadModelFromArrayBuffer(record.modelBuffer, record.modelName, record.modelFileType);
    applyConfigDataToCurrentModel(record);
    State.configName = record.name;
    document.getElementById('saveStatus').textContent = `「${record.name}」を読み込みました`;
    showToast(`「${record.name}」を読み込みました`);
  } catch (err) {
    console.error(err);
    showToast('設定の読込に失敗しました', true);
  }
}

// パーツ・重心・機体の向き/大きさ/重量/速度を、現在読み込み済みのモデルに適用する共通処理。
// 保存済み設定の読込(applyLoadedConfig)と、モデルを含まないポータブル設定のインポート(importPortableConfigFile)の両方から使う
function applyConfigDataToCurrentModel(data) {
  if (data.modelTransform && State.model.root) {
    const t = data.modelTransform;
    // position は旧バージョンの保存データには存在しない場合がある（未指定なら読込直後の自動中央寄せ位置のまま）
    if (t.position) State.model.root.position.set(t.position.x, t.position.y, t.position.z);
    State.model.root.rotation.set(t.rotation.x, t.rotation.y, t.rotation.z);
    State.model.root.scale.set(t.scale.x, t.scale.y, t.scale.z);
  }
  if (data.modelWeightKg !== undefined) State.model.weightKg = data.modelWeightKg;
  if (data.modelMaxSpeedValue !== undefined) State.model.maxSpeedValue = data.modelMaxSpeedValue;
  if (data.modelMaxSpeedUnit !== undefined) State.model.maxSpeedUnit = data.modelMaxSpeedUnit;
  renderModelSettingsPanel();

  rebuildPartsFromSaved(data.parts || []);
  if (data.cg) {
    State.cg.position = { ...data.cg };
    applyCgToGizmo();
    if (State.cg.selected) updateInspectorNumbersOnly(null, true);
  }
}

function formatNow() {
  return new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// 起動時：最後に開いた設定があれば自動読込
async function autoLoadLastConfig() {
  try {
    const lastName = await getLastConfigName();
    if (!lastName) return;
    const record = await loadConfigByName(lastName);
    if (record) {
      await applyLoadedConfig(record);
    }
  } catch (err) {
    console.warn('自動読込に失敗:', err);
  }
}

let bootstrapOk = false;

async function bootstrap() {
  // ドロワー開閉はThree.js等の初期化に依存しないため、最優先で確実にセットアップする。
  // これより後の処理（3Dシーン初期化など）が万一失敗しても、パーツ/設定パネルの開閉だけは機能させる。
  try {
    setupMobileDrawers();
  } catch (err) {
    console.error('setupMobileDrawers()でエラー:', err);
    if (typeof _markFailed === 'function') {
      _markFailed('ドロワー初期化エラー: ' + (err && err.message ? err.message : String(err)));
    }
  }

  try {
    initScene();
    initCgSystem();
    setupModelLoaderUI();
    setupPartTypeButtons();
    setupGizmoUI();
    setupViewportPicking();
    setupSaveLoadUI();
    setupAxisViewButtons();
    setupCameraProjectionToggle();
    await autoLoadLastConfig();
    bootstrapOk = true;
  } catch (err) {
    console.error('初期化中にエラーが発生しました:', err);
    showToast('初期化に失敗しました。コンソールを確認してください', true);
    if (typeof _markFailed === 'function') {
      _markFailed('bootstrap()例外: ' + (err && err.message ? err.message : String(err)));
    }
  }
  if (typeof _renderVersionTag === 'function') _renderVersionTag();
}

bootstrap();
