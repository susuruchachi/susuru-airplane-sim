// 07-env-main.js — 環境プレビューの起動処理

let envBootstrapOk = false;

function bootstrapEnv() {
  try {
    initWorld();     // 地形の高さ関数・国・都市・空港を用意する（以降すべての土台）
    initEnvScene();
    initSky();
    initTerrain();   // 地形と海。以降の都市・空港はこの高さの上に載る
    initWater();     // 川と湖の水面
    initPlaces();    // 都市と地名ラベル
    initClouds();
    initAirport();
    initMinimap();
    setupEnvUI();
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
