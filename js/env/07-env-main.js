// 07-env-main.js — 環境プレビューの起動処理

let envBootstrapOk = false;

function bootstrapEnv() {
  try {
    initWorld();     // 地形の高さ関数・国・都市・空港を用意する（以降すべての土台）
    initEnvScene();
    initSky();
    initTerrain();   // 地形と海。以降の都市・空港はこの高さの上に載る
    initWater();     // 川と湖の水面
    initRoads();     // 街と街・街と空港を結ぶ道路（地形の上に敷くので地形のあと）
    initPlaces();    // 都市と地名ラベル
    initClouds();
    initWeather();   // 雲・霧・光に効くので、雲のあと・UIの前に用意する
    initAirport();
    initVegetation(); // 空港の敷地を避けて生やすので、空港のあとに作る
    initMinimap();
    initFlight();    // 機体の一覧を読む（IndexedDBなので非同期。飛ぶのはボタンを押してから）
    setupEnvUI();
    if (typeof setupSoundUnlock === 'function') setupSoundUnlock();  // 最初の操作で音を起こす

    // 前回この端末で触った設定があれば復元する（無ければ何も起きない）
    if (loadEnvFromStorage()) {
      syncEnvUIToState();
      applyCloudCoverage();
      setLabelsVisible(EnvState.env.labelsVisible !== false);
      setTreesVisible(EnvState.env.treesVisible !== false);
      if (typeof applyEnvQuality === 'function') applyEnvQuality(EnvState.env.quality || 'high');
    }

    focusCameraOnAirport(); // 起動時は空港全体が見える位置から始める
    animateEnv();
    envBootstrapOk = true;
  } catch (err) {
    console.error('環境シーンの初期化中にエラーが発生しました:', err);
    if (typeof _markFailed === 'function') {
      _markFailed('bootstrapEnv()例外: ' + (err && err.message ? err.message : String(err)));
    }
  }
  if (typeof _renderVersionTag === 'function') _renderVersionTag();
}

bootstrapEnv();
