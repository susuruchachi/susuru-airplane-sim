// 01-env-state.js — 環境シーン（空・雲・昼夜サイクル）のグローバル状態
// 番号プレフィックス方式：flight.html 専用。Builder側(index.html)の State とは別の名前空間。

const ENV_VERSION = 'env-v1';

const EnvState = {
  // Three.js 中枢
  scene: null,
  camera: null,
  renderer: null,
  orbitControls: null,
  clock: null,

  // 空・天体
  sky: null,        // THREE.Sky（大気散乱シェーダーのドーム）
  sunLight: null,   // THREE.DirectionalLight（太陽本体の光）
  moonLight: null,  // THREE.DirectionalLight（月明かり。夜間のみ弱く点く）
  hemiLight: null,
  sunMesh: null,    // 太陽の見た目（発光球）
  moonMesh: null,   // 月の見た目
  stars: null,      // THREE.Points（夜間に浮かぶ星）

  // 雲
  cloudGroup: null,
  cloudClusters: [], // { group, baseX, baseZ, driftX, driftZ } の配列

  // 仮の地面（陸地・海の本実装までのプレースホルダー）
  ground: null,

  cloudAltitude: 300, // 雲を浮かべる基準高度(m)

  // 昼夜サイクル
  time: {
    hours: 9,          // 現在時刻（0〜24の小数）
    cycleMinutes: 15,  // 24時間ぶんを何分で一周させるか（デフォルト15分。README記載の仕様）
    paused: false,
  },

  // 環境パラメータ（UIから調整）
  env: {
    cloudCoverage: 0.45,     // 雲量 0〜1
    windSpeedKmh: 20,
    windDirectionDeg: 90,
    previewAltitudeM: 0,     // 「高度による空の色の変化」のプレビュー用（機体が無いのでスライダーで代用）
  },
};
