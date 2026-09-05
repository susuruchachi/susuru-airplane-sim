// 07-env-main.js — 環境プレビューの起動処理

let envBootstrapOk = false;

function bootstrapEnv() {
  try {
    initEnvScene();
    initSky();
    initClouds();
    initAirport();
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
