// 07-env-main.js — 環境プレビューの起動処理

let envBootstrapOk = false;

function bootstrapEnv() {
  try {
    initEnvScene();
    initSky();
    initClouds();
    setupEnvUI();
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
