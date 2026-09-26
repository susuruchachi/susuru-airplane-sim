// 01-env-state.js — 環境シーン（空・雲・昼夜サイクル）のグローバル状態
// 番号プレフィックス方式：flight.html 専用。Builder側(index.html)の State とは別の名前空間。

// 保存データの形式番号。**全体のバージョン名（js/00-version.js の APP_VERSION）とは別もの**で、
// 保存の読み書きの形が変わったときだけ上げる。画面に出す版名は APP_VERSION のほう。
const ENV_VERSION = 'env-v5';

// --- 半透明のものを描く順番（renderOrder）-------------------------------------
//
// Three.js は「不透明を全部 → 半透明を全部」の順に描き、半透明どうしは
// **renderOrder が小さいほうから**、同じ番号なら遠いほうから描く。
// 半透明は深度を書かない（書くと後ろのものが消える）ので、**重なったときは
// あとから描いたほうが必ず上に乗る**。番号を決めていないものが混ざると、
// 見えてほしいものが背景に塗りつぶされる。実際こうなっていた：
//   ・排煙（1）が 海（2）と 雲底（3）に塗りつぶされ、**海の上や雲の中で消えた**
//   ・地名ラベル（番号なし＝0）も同じ理由で、海の上と雲の中で消えた
//     （深度テストを切ってあるのに見えない、の正体がこれ）
// 一覧をここにまとめて、重なって困るものには必ず別の番号を振る。
//
// **雲底（曇り空の天井）は、雲や灯りと前後が入れ替わる。** 雲底より向こう側にあるものは
// 雲底より先に描いて雲底をかぶせ、こちら側にあるものは雲底より後に描く。
// 以前は雲底を積雲（番号なし＝0）より後、灯り（6）より前に固定していたので、
//   ・雲底より手前にある積雲の下の部分まで、雲底が上から塗りつぶした
//     （「雲が手前に見えるはずの時、雲底が手前に見える」）
//   ・見上げたとき、手前で降っている雨や雪にも雲底がかぶさった
//   ・雲の上から見下ろすと、雲底の下にある滑走路の灯りのにじみが雲底の上に乗った
// 積雲はひとつずつ「カメラと同じ側か」で cloudsFar と clouds に振り分け（04-clouds.js）、
// 雲底はそのあいだ（deck）で描く。べったり曇っているときは雲底が深度も書くので、
// 雲底より後に描くもののうち向こう側にあるもの（灯り・煙）は深度で消える。
const ENV_ORDER = {
  haze: 0,    // 霞の球（カメラを囲む。半透明の中でいちばん先に描く）
  water: 1,   // 川・湖
  sea: 2,     // 海
  cloudsFar: 2.25, // 雲底より向こう側にある積雲（雲底より先に描いて、雲底をかぶせる）
  deck: 2.5,  // 雲底（曇り空の天井）
  clouds: 3,  // 雲底よりこちら側にある積雲・降水
  smoke: 4,   // 排煙・飛行機雲・タイヤの煙
  effect: 5,  // 炎・陽炎・衝撃波・着陸灯の照り返し
  light: 6,   // 航行灯・空港の灯り
  label: 7,   // 地名ラベル（深度テストを切ってあるので、いちばん上）
};

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

  // 川と湖の水面（地形と同じくカメラの周りだけ作る）
  waterGroup: null,
  builtWater: null,     // Map(川/湖のid -> Mesh)
  waterMaterial: null,
  riverWaterMaterial: null,

  // 天候。気象の場（03b-world.js）と気候から、雲量・視程・降水・突風を決める。
  weatherGroup: null,
  skyHaze: null,          // 霧のとき空ドームをふさぐ霞の球
  cloudDeck: null,        // 曇り空の天井
  cloudDeckTexture: null,
  rain: null,             // 雨（線分）
  snow: null,             // 雪（点）
  weather: {
    presetId: 'auto',     // auto / clear / fair / cloudy / rain / storm / snow / fog / manual
    clockHours: 0,        // 気象の時計。昼夜の時刻と違って24で折り返さず単調に進む
    manual: { wetness: 0.35, storminess: 0, fogginess: 0 }, // 手動モードの入力
    current: null,        // いま見えている値（targetへ滑らかに寄る）
    target: null,
    gust: 0,              // 突風（風速に足す km/h）
    flash: 0,             // 稲光 0〜1
    aboveDeck: 0,         // 曇りの天井より上に出ている度合い 0〜1（雨と霧を抑える）
    deckDrift: { x: 0, y: 0 },
  },

  // 植生。カメラの手前だけにインスタンス描画で生やす。
  treeGroup: null,
  treeMaterial: null,

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

  // 飛行。機体・物理の状態・操縦入力をまとめて持つ。
  // active が false のあいだは環境プレビュー（カメラだけが飛ぶ）のまま。
  flight: {
    active: false,
    aircraft: null,       // { model, group, visual, lights, ... }（09b-aircraft-visual.js）
    state: null,          // 物理の状態（10-flight.js）
    controls: null,       // 操縦入力
    configs: [],          // 飛べる機体の一覧（Builderの保存＋内蔵機）
    configName: null,
    // 重心の微調整。Builderで決めた重心からのずれを機体ごとに持つ。
    // 設計そのものはBuilder側が正とし、こちらは「積み方を変える」ぶんとして扱う。
    // { 機体名: {x, y, z} }（機体座標。-Zが前・+Yが上・+Xが右）
    cgOffsets: {},
    cameraMode: 'chase',  // chase / cockpit / orbit / free
    // 自動操縦（13-autopilot.js の createAutopilotState）。
    // 高度維持と、離陸から着陸までの全自動をここに持つ。
    autopilot: null,
  },

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
    treesVisible: true,      // 樹木の表示
    radarVisible: false,     // ミニマップに気象レーダー（降水）を重ねるか
    windFromWeather: true,   // 風速を天候に任せるか（風向はいつでも手動）
    soundOn: true,           // 音を鳴らすか
    soundVolume: 0.7,        // 音量（0〜1）
    shadowsOn: true,         // 太陽の影（js/env/03m-shadows.js。画質「低」では描かない）
    quality: 'high',         // 画質プリセット 'high'|'medium'|'low'（js/env/03h-env-quality.js）
    // 手で飛ばすときのレバーの意味（js/env/13b-pilot-assist.js）。
    //   'direct' … 舵角そのもの（いままでどおり） ／ 'radius' … 旋回半径（100%で最小半径）
    controlMode: 'direct',
    attitudeHold: true,      // 直接のとき、レバーを離したら離した瞬間の姿勢を保つか
  },
};
