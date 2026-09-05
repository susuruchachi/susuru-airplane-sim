// 01-state.js — アプリ全体のグローバル状態
// 番号プレフィックス方式：全モジュールはグローバルスコープを共有する

const APP_VERSION = 'v12';

const State = {
  // Three.js 中枢
  scene: null,
  camera: null,
  renderer: null,
  orbitControls: null,
  transformControls: null,

  // 現在読み込まれている機体モデル
  model: {
    root: null,        // THREE.Group（モデルのルート）
    name: null,        // 表示名（ファイル名）
    fileBuffer: null,  // ArrayBuffer（保存用に保持）
    fileType: 'glb',   // 'glb' | 'gltf'
    boundingRadius: 1,
    // 機体全体の設定。向き・大きさは root.rotation / root.scale が正の値（UIはそこを読み書きする）。
    // ここには保存/復元のためのメタデータとして重量・最高速度のみ持つ
    weightKg: 1000,          // 総重量（kg）
    maxSpeedValue: 250,      // 最高速度の数値（単位はmaxSpeedUnitに従う）
    maxSpeedUnit: 'kt',      // 'kt'（ノット） | 'mach'（マッハ）
    meshOffset: { x: 0, y: 0, z: 0 }, // 「原点を中心に揃える」で機体本体をずらした累計量（保存・復元用）
  },

  // パーツ定義一覧
  // 各パーツ: { id, type, name, position:{x,y,z}, rotation:{x,y,z}, scale:{x,y,z},
  //             gizmo: THREE.Object3D (画面上のハンドル), props: {...種別固有} }
  parts: [],
  selectedPartId: null,
  selectedCornerKey: null, // 翼パーツの4頂点編集で、現在ドラッグ対象になっている頂点キー（rootLeading等）
  partIdCounter: 1,
  jointIdCounter: 1,
  strutIdCounter: 1,

  // 重心（CG / 原点）— パーツとは別枠で機体に1つだけ持つ
  cg: {
    position: { x: 0, y: 0, z: 0 },
    gizmo: null,      // 専用ギズモ（THREE.Group）
    selected: false,  // ギズモで選択中かどうか
  },

  // UI
  gizmoMode: 'translate', // translate | rotate | scale

  // 設定保存メタ
  configName: 'default',
};

const PART_TYPE_LABELS = {
  engine: 'エンジン',
  wing: '主翼／尾翼',
  control_surface: '可動翼面',
  light: '航行灯',
  landing_gear: '着陸脚',
};

const PART_TYPE_COLORS = {
  engine: '#ff9f40',
  wing: '#3fa9ff',
  control_surface: '#4fd18b',
  light: '#e0e0ff',
  landing_gear: '#c8ccd2',
};

// 翼パーツの役割（主翼／水平尾翼／垂直尾翼）
const WING_ROLES = [
  { value: 'main', label: '主翼' },
  { value: 'htail', label: '水平尾翼' },
  { value: 'vtail', label: '垂直尾翼' },
];

// 翼の4頂点（コーナー）の識別子。水平な翼（主翼・水平尾翼）と垂直尾翼でラベルの意味が変わる。
// 配列順は常に [ルート前縁側, ルート後縁側, 翼端前縁側, 翼端後縁側] に対応する頂点キーで統一する
const WING_CORNER_KEYS = ['rootLeading', 'rootTrailing', 'tipLeading', 'tipTrailing'];
const WING_CORNER_LABELS_HORIZONTAL = {
  rootLeading: '付け根・前縁', rootTrailing: '付け根・後縁',
  tipLeading: '翼端・前縁', tipTrailing: '翼端・後縁',
};
const WING_CORNER_LABELS_VTAIL = {
  rootLeading: '下端・前縁', rootTrailing: '下端・後縁',
  tipLeading: '上端・前縁', tipTrailing: '上端・後縁',
};
function wingCornerLabel(role, key) {
  return (role === 'vtail' ? WING_CORNER_LABELS_VTAIL : WING_CORNER_LABELS_HORIZONTAL)[key];
}

// 可動翼面のサブ種別（エルロン／エレベーター／ラダー／フラップ／スポイラー等）
const CONTROL_SURFACE_KINDS = [
  { value: 'aileron', label: 'エルロン（補助翼）', suggestedSpanS: 0.78 },
  { value: 'elevator', label: 'エレベーター（昇降舵）', suggestedSpanS: 0.5 },
  { value: 'rudder', label: 'ラダー（方向舵）', suggestedSpanS: 0.5 },
  { value: 'flap', label: 'フラップ（フラップ）', suggestedSpanS: 0.3 },
  { value: 'spoiler', label: 'スポイラー', suggestedSpanS: 0.5 },
];

// 航行灯の種別（位置により色や点滅パターンの慣習がある）
const LIGHT_KINDS = [
  { value: 'nav_red', label: '左舷灯（赤）', color: '#ff3b3b', blink: 'steady' },
  { value: 'nav_green', label: '右舷灯（緑）', color: '#3bff6a', blink: 'steady' },
  { value: 'nav_white_tail', label: '尾灯（白）', color: '#ffffff', blink: 'steady' },
  { value: 'beacon', label: 'ビーコン（赤）', color: '#ff2020', blink: 'pulse' },
  { value: 'strobe', label: 'ストロボ（白）', color: '#ffffff', blink: 'strobe' },
  { value: 'landing', label: '着陸灯（白）', color: '#fff6dd', blink: 'steady' },
];

// 着陸脚の取付位置（機体の前脚／主脚 左右）
const LANDING_GEAR_POSITIONS = [
  { value: 'nose', label: '前脚（ノーズギア）' },
  { value: 'main_left', label: '主脚（左）' },
  { value: 'main_right', label: '主脚（右）' },
  { value: 'other', label: 'その他' },
];

function genJointId() { return 'joint_' + (State.jointIdCounter++); }
function genStrutId() { return 'strut_' + (State.strutIdCounter++); }

function genPartId() {
  return 'part_' + (State.partIdCounter++);
}

function getSelectedPart() {
  return State.parts.find(p => p.id === State.selectedPartId) || null;
}
