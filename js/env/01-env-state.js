// 01-env-state.js — 環境シーン（空・雲・昼夜サイクル）のグローバル状態
// 番号プレフィックス方式：flight.html 専用。Builder側(index.html)の State とは別の名前空間。

const ENV_VERSION = 'env-v3';

const EnvState = {
  // Three.js 中枢
  scene: null,
  camera: null,
  renderer: null,
  orbitControls: null,
  clock: null,

  // 空・天体
  celestial: null,  // 空ドーム・太陽・月・星をまとめた、カメラに追従するGroup
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

  // 地形（js/env/03b-world.js の高さ関数から作るLOD付きタイル群）と海
  terrainGroup: null,
  terrainMaterial: null,
  sea: null,
  seaNormalMap: null,

  // 川と湖の水面（地形と同じくカメラの周りだけ作る）
  waterGroup: null,
  builtWater: null,     // Map(川/湖のid -> Mesh)
  waterMaterial: null,

  // 都市。世界には130あるので、カメラの周りだけを建てて離れたら片付ける。
  cityGroup: null,
  builtCities: null,   // Map(都市id -> { city, buildings, lights })

  // 地名ラベル。一覧だけ先に持ち、スプライトは近づいたときに作る。
  labelGroup: null,
  labels: [],

  // 空港。世界には82あるので、都市と同じくカメラの周りだけを建てる。
  builtAirports: null,     // Map(空港id -> { def, group, lights, windsockYaw, windsockPitch })
  selectedAirportId: null, // 右パネルの操作対象になっている空港

  // 空港idごとの設定（マップ定義からの変更ぶん）。保存/読込の対象でもある。
  // { runwayLengthM, runwayWidthM, headingDeg, lightsMode, visible }
  airportSettings: {},

  // ミニマップ（2Dの世界地図）
  minimap: null,

  cloudAltitude: 1900, // 雲を浮かべる基準高度(m)。積雲の雲底のイメージ

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
    labelsVisible: true,     // 国名・都市名・空港コードのラベル表示
  },
};
