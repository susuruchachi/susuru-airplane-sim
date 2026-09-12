// 03b-world.js — 世界の定義（地形の高さ関数・気候・大陸・山脈・国・都市・空港）
//
// このファイルはTHREE.jsに一切依存しない純粋な計算だけで構成する。
// 地形メッシュ・海・都市・植生・ミニマップはすべて worldHeightAt() を参照して作られるので、
// ここが「世界の唯一の正」になる。Nodeからもそのまま読めるので、
// 「街が海に沈んでいないか」といった検証をブラウザ無しで回せる（tools/verify-world.js）。
//
// 座標系：ワールドの -Z が北、+X が東。原点は主大陸ヴェスタリアのアルヴィス国際空港。
// 単位はすべてメートル。
//
// 世界は3,000km四方あるが、地形は「カメラの周りだけ」を作っては捨てる方式（03c-terrain.js）
// なので、WORLD_SIZE を大きくしてもメモリと描画の負荷は増えない。
// 増えるのは都市・空港の数（＝ここでの生成量）だけ。

const WORLD_SEED = 20260905;
const WORLD_SIZE = 3000000;     // 一辺3,000km
const WORLD_HALF = WORLD_SIZE / 2;

// ============================================================================
// 1. 決定論的ノイズ
// 乱数ではなくハッシュから作るので、何度読み込んでも同じ地形になる
// （＝空港や都市の位置を「マップ上の固定物」として扱える）。
// ============================================================================

function worldHash2i(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ WORLD_SEED;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function worldLerp(a, b, t) { return a + (b - a) * t; }

// 0〜1に収めたうえで両端をなめらかにする
function worldSmooth01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function worldClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// 格子点のハッシュ値を双一次補間する値ノイズ（0〜1）
function worldValueNoise(x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = worldSmooth01(x - x0), fz = worldSmooth01(z - z0);
  const n00 = worldHash2i(x0, z0), n10 = worldHash2i(x0 + 1, z0);
  const n01 = worldHash2i(x0, z0 + 1), n11 = worldHash2i(x0 + 1, z0 + 1);
  return worldLerp(worldLerp(n00, n10, fx), worldLerp(n01, n11, fx), fz);
}

// オクターブを重ねた起伏（0〜1）。値ノイズは格子に沿った縞が出やすいので、
// オクターブごとに座標を回転させて方向の偏りを崩している。
const _WFBM_COS = Math.cos(0.7), _WFBM_SIN = Math.sin(0.7);

function worldFbm(x, z, octaves) {
  let sum = 0, norm = 0, amp = 1, px = x, pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * worldValueNoise(px, pz);
    norm += amp;
    amp *= 0.5;
    const rx = px * _WFBM_COS - pz * _WFBM_SIN;
    const rz = px * _WFBM_SIN + pz * _WFBM_COS;
    px = rx * 2; pz = rz * 2;
  }
  return sum / norm;
}

// 尾根状のノイズ。|2n-1| を反転して二乗することで、稜線の鋭い山脈になる（0〜1）
function worldRidgedFbm(x, z, octaves) {
  let sum = 0, norm = 0, amp = 1, px = x, pz = z;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(worldValueNoise(px, pz) * 2 - 1);
    n *= n;
    sum += amp * n;
    norm += amp;
    amp *= 0.52;
    const rx = px * _WFBM_COS - pz * _WFBM_SIN;
    const rz = px * _WFBM_SIN + pz * _WFBM_COS;
    px = rx * 2.03; pz = rz * 2.03;
  }
  return sum / norm;
}

// 文字列から決まる擬似乱数（線形合同法）。都市名や建物配置の種にする。
function worldRng(str) {
  let s = 2166136261;
  for (let i = 0; i < str.length; i++) {
    s ^= str.charCodeAt(i);
    s = Math.imul(s, 16777619);
  }
  s = s >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 回転させた楕円の内側で1、外へ向かって0になる減衰（大陸・山脈の輪郭に使う）
function worldEllipseFalloff(x, z, e) {
  const dx = x - e.cx, dz = z - e.cz;
  const lx = (dx * e._cos + dz * e._sin) / e.rx;
  const lz = (-dx * e._sin + dz * e._cos) / e.rz;
  const d = Math.sqrt(lx * lx + lz * lz);
  if (d >= 1) return 0;
  if (d <= e.inner) return 1;
  return worldSmooth01((1 - d) / (1 - e.inner));
}

function worldPrepEllipse(e) {
  const r = (e.rot || 0) * Math.PI / 180;
  e._cos = Math.cos(r);
  e._sin = Math.sin(r);
  if (e.inner === undefined) e.inner = 0.4;
  e._bound = Math.max(e.rx, e.rz);
  return e;
}

// ============================================================================
// 2. 空間インデックス
// 3,000km四方には都市も空港も数百個ある。高さ関数は1フレームに何万回も呼ばれるので、
// 「全部との距離を測る」ことはできない。影響範囲を格子に登録して近傍だけ見る。
// ============================================================================

function makeWorldGrid(cellSize) {
  const cells = new Map();
  const keyOf = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);

  return {
    cellSize,
    // 半径 r の影響を持つ item を、重なるすべてのセルへ登録する
    insert(x, z, r, item) {
      const i0 = Math.floor((x - r) / cellSize), i1 = Math.floor((x + r) / cellSize);
      const j0 = Math.floor((z - r) / cellSize), j1 = Math.floor((z + r) / cellSize);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = keyOf(i, j);
          let arr = cells.get(k);
          if (!arr) { arr = []; cells.set(k, arr); }
          arr.push(item);
        }
      }
    },
    // (x,z) を含むセルの item だけを返す（登録時に重なるセル全てへ入れてあるので漏れない）
    at(x, z) {
      return cells.get(keyOf(Math.floor(x / cellSize), Math.floor(z / cellSize)));
    },
    clear() { cells.clear(); },
  };
}

// ============================================================================
// 3. 大陸と山脈
// 世界の骨格。ここだけは手で置いて、地理の個性を決める。
// ============================================================================

const WORLD_LANDMASSES = [
  // --- ヴェスタリア連邦：中央の主大陸（原点はこの中）---
  { cx: 20000, cz: -40000, rx: 430000, rz: 350000, rot: -12, weight: 1.0 },
  { cx: -260000, cz: 150000, rx: 220000, rz: 190000, rot: 20, weight: 0.94 },
  // --- ノルドハイム王国：北へ伸びる半島 ---
  { cx: -170000, cz: -560000, rx: 300000, rz: 290000, rot: 18, weight: 0.96 },
  // --- ボレアリス自治州：極北の凍った大地 ---
  { cx: 300000, cz: -1010000, rx: 360000, rz: 250000, rot: -8, weight: 0.94 },
  // --- アストラ帝国：西の大陸 ---
  { cx: -940000, cz: -140000, rx: 340000, rz: 420000, rot: 10, weight: 0.97 },
  { cx: -1180000, cz: 200000, rx: 190000, rz: 200000, rot: 0, weight: 0.86 },
  // --- カルディス自治領：東の乾いた大陸 ---
  { cx: 730000, cz: -280000, rx: 350000, rz: 400000, rot: 8, weight: 0.97 },
  // --- オリエンス公国：北東 ---
  { cx: 1010000, cz: -840000, rx: 270000, rz: 300000, rot: -14, weight: 0.94 },
  // --- メリディア共和国：南の温暖な大陸 ---
  { cx: -140000, cz: 640000, rx: 420000, rz: 310000, rot: -6, weight: 0.97 },
  // --- タラシア連合：南西の沿岸と島 ---
  { cx: -860000, cz: 720000, rx: 290000, rz: 250000, rot: 22, weight: 0.93 },
  { cx: -1130000, cz: 960000, rx: 130000, rz: 110000, rot: 0, weight: 0.78 },
  // --- ザナドゥ共和国：遠南東の熱帯 ---
  { cx: 1140000, cz: 1010000, rx: 260000, rz: 220000, rot: 16, weight: 0.93 },
  // --- セラフィナ諸島：南東の島々 ---
  { cx: 760000, cz: 700000, rx: 150000, rz: 130000, rot: 15, weight: 0.80 },
  { cx: 960000, cz: 840000, rx: 95000, rz: 80000, rot: -20, weight: 0.74 },
  { cx: 620000, cz: 880000, rx: 70000, rz: 62000, rot: 40, weight: 0.70 },
  { cx: 880000, cz: 560000, rx: 58000, rz: 50000, rot: 5, weight: 0.66 },
  // --- 散在する小島（航路の目印になる）---
  { cx: 380000, cz: 330000, rx: 52000, rz: 44000, rot: 30, weight: 0.66 },
  { cx: -520000, cz: -240000, rx: 60000, rz: 52000, rot: -25, weight: 0.68 },
  { cx: 480000, cz: -640000, rx: 68000, rz: 58000, rot: 12, weight: 0.68 },
  { cx: -600000, cz: 420000, rx: 46000, rz: 40000, rot: 0, weight: 0.64 },
  { cx: 1240000, cz: -180000, rx: 62000, rz: 54000, rot: -10, weight: 0.66 },
  { cx: -1080000, cz: -620000, rx: 74000, rz: 62000, rot: 20, weight: 0.70 },
];

// 名前付きの山脈。inner を小さめにして、中心付近だけが高くなるようにしている。
const WORLD_RANGES = [
  { name: 'ノルドハイム山脈', nameLatin: 'Nordheim Range', cx: -170000, cz: -540000, rx: 260000, rz: 165000, rot: 25, inner: 0.1, height: 3900, freq: 0.000105 },
  { name: 'ヴェスタリア中央山地', nameLatin: 'Central Vestaria', cx: 60000, cz: -140000, rx: 280000, rz: 120000, rot: -18, inner: 0.1, height: 2400, freq: 0.00012 },
  { name: 'アストラ大山脈', nameLatin: 'Astra Massif', cx: -930000, cz: -180000, rx: 210000, rz: 300000, rot: 8, inner: 0.1, height: 4400, freq: 0.0001 },
  { name: 'カルディス高原', nameLatin: 'Kaldis Plateau', cx: 760000, cz: -300000, rx: 280000, rz: 300000, rot: 0, inner: 0.3, height: 1800, freq: 0.00009 },
  { name: 'メリディア丘陵', nameLatin: 'Meridia Highlands', cx: -100000, cz: 690000, rx: 300000, rz: 130000, rot: 8, inner: 0.15, height: 1200, freq: 0.00014 },
  { name: 'ボレアリス氷嶺', nameLatin: 'Borealis Ridge', cx: 300000, cz: -1010000, rx: 260000, rz: 150000, rot: -8, inner: 0.12, height: 3100, freq: 0.00011 },
  { name: 'オリエンス連峰', nameLatin: 'Oriens Range', cx: 1000000, cz: -860000, rx: 190000, rz: 190000, rot: -14, inner: 0.12, height: 3300, freq: 0.000115 },
  { name: 'タラシア背稜', nameLatin: 'Thalassia Spine', cx: -860000, cz: 720000, rx: 210000, rz: 110000, rot: 22, inner: 0.12, height: 2200, freq: 0.000125 },
  { name: 'ザナドゥ山塊', nameLatin: 'Xanadu Highlands', cx: 1140000, cz: 1010000, rx: 180000, rz: 140000, rot: 16, inner: 0.14, height: 2600, freq: 0.00012 },
  { name: 'セラフィナ火山列', nameLatin: 'Serafina Volcanics', cx: 760000, cz: 700000, rx: 110000, rz: 90000, rot: 15, inner: 0.1, height: 1900, freq: 0.00016 },
];

// ============================================================================
// 4. 国
// 都市はここから手続き的に生成する。nameStyle が地名の雰囲気を決める。
// ============================================================================

const WORLD_COUNTRIES = [
  { id: 'vestaria', name: 'ヴェスタリア連邦', nameLatin: 'Vestaria', tint: 0xa8d47e, nameStyle: 'vestarian', cx: 20000, cz: -40000, radius: 470000, cityCount: 22 },
  { id: 'nordheim', name: 'ノルドハイム王国', nameLatin: 'Nordheim', tint: 0xa8c4e0, nameStyle: 'nordic', cx: -170000, cz: -560000, radius: 320000, cityCount: 12 },
  { id: 'borealis', name: 'ボレアリス自治州', nameLatin: 'Borealis', tint: 0xc9d8e8, nameStyle: 'nordic', cx: 300000, cz: -1010000, radius: 370000, cityCount: 8 },
  { id: 'astra', name: 'アストラ帝国', nameLatin: 'Astra', tint: 0xd8b0a0, nameStyle: 'imperial', cx: -940000, cz: -140000, radius: 440000, cityCount: 18 },
  { id: 'kaldis', name: 'カルディス自治領', nameLatin: 'Kaldis', tint: 0xe0c088, nameStyle: 'desert', cx: 730000, cz: -280000, radius: 420000, cityCount: 14 },
  { id: 'oriens', name: 'オリエンス公国', nameLatin: 'Oriens', tint: 0xb9a8e0, nameStyle: 'oriental', cx: 1010000, cz: -840000, radius: 310000, cityCount: 10 },
  { id: 'meridia', name: 'メリディア共和国', nameLatin: 'Meridia', tint: 0xb8d97a, nameStyle: 'latin', cx: -140000, cz: 640000, radius: 440000, cityCount: 18 },
  { id: 'thalassia', name: 'タラシア連合', nameLatin: 'Thalassia', tint: 0x7fe0c0, nameStyle: 'latin', cx: -880000, cz: 760000, radius: 340000, cityCount: 11 },
  { id: 'serafina', name: 'セラフィナ諸島', nameLatin: 'Serafina', tint: 0x86e0d8, nameStyle: 'island', cx: 790000, cz: 720000, radius: 300000, cityCount: 9 },
  { id: 'xanadu', name: 'ザナドゥ共和国', nameLatin: 'Xanadu', tint: 0x9fe08a, nameStyle: 'island', cx: 1140000, cz: 1010000, radius: 280000, cityCount: 8 },
];

// ============================================================================
// 5. 地名の生成
// 音節表から組み立てる。ラテン表記とカタカナ表記を対にして持ち、
// 表記ゆれが出ないようにしている。
// ============================================================================

const WORLD_NAME_STYLES = {
  vestarian: {
    head: [['Alv', 'アルヴ'], ['Kern', 'ケルン'], ['Hal', 'ハル'], ['West', 'ウェスト'], ['Mira', 'ミラ'], ['Ash', 'アッシュ'], ['Bram', 'ブラム'], ['Elm', 'エルム'], ['Green', 'グリーン'], ['Ald', 'オルド'], ['Ravens', 'レイヴンズ'], ['Thorn', 'ソーン'], ['Marl', 'マール'], ['Ober', 'オーバー'], ['Cald', 'カルド']],
    tail: [['is', 'イス'], ['ford', 'フォード'], ['den', 'デン'], ['mere', 'ミア'], ['wick', 'ウィック'], ['ton', 'トン'], ['bury', 'ベリー'], ['field', 'フィールド'], ['stead', 'ステッド'], ['gate', 'ゲート']],
  },
  nordic: {
    head: [['Nord', 'ノルド'], ['Vin', 'ヴィン'], ['Fjor', 'フィヨル'], ['Kar', 'カル'], ['Sten', 'ステン'], ['Bjor', 'ビョル'], ['Aur', 'アウル'], ['Sval', 'スヴァル'], ['Grim', 'グリム'], ['Hav', 'ハヴ'], ['Rik', 'リク'], ['Isen', 'イーゼン'], ['Vald', 'ヴァルド'], ['Skar', 'スカル']],
    tail: [['heim', 'ハイム'], ['sten', 'ステン'], ['fjord', 'フィヨルド'], ['vik', 'ヴィーク'], ['borg', 'ボルグ'], ['dal', 'ダール'], ['nes', 'ネス'], ['holm', 'ホルム'], ['berg', 'ベルグ'], ['lund', 'ルンド']],
  },
  imperial: {
    head: [['Aug', 'アウグ'], ['Cast', 'カスト'], ['Ferr', 'フェル'], ['Magn', 'マグン'], ['Praet', 'プラエト'], ['Sever', 'セヴェル'], ['Volt', 'ヴォルト'], ['Dran', 'ドラン'], ['Corv', 'コルヴ'], ['Aquil', 'アクィル'], ['Tarn', 'ターン'], ['Vesp', 'ヴェスプ']],
    tail: [['ium', 'イウム'], ['ara', 'アラ'], ['ent', 'エント'], ['ossa', 'オッサ'], ['urn', 'ウルン'], ['ica', 'イカ'], ['anum', 'アヌム'], ['or', 'オル'], ['essa', 'エッサ']],
  },
  desert: {
    head: [['Tar', 'タル'], ['Sab', 'サブ'], ['Nev', 'ネヴ'], ['Kal', 'カル'], ['Zah', 'ザー'], ['Mir', 'ミル'], ['Bas', 'バス'], ['Qar', 'カル'], ['Sam', 'サム'], ['Had', 'ハド'], ['Yaz', 'ヤズ'], ['Rus', 'ルス']],
    tail: [['ik', 'イク'], ['rin', 'リン'], ['an', 'アン'], ['ad', 'アド'], ['ur', 'ウル'], ['iya', 'イヤ'], ['kand', 'カンド'], ['esh', 'エシュ'], ['abad', 'アバード']],
  },
  oriental: {
    head: [['Ryo', 'リョウ'], ['Sen', 'セン'], ['Kai', 'カイ'], ['Tai', 'タイ'], ['Hoshi', 'ホシ'], ['Mizu', 'ミズ'], ['Kaze', 'カゼ'], ['Aki', 'アキ'], ['Shira', 'シラ'], ['Kuro', 'クロ'], ['Yuki', 'ユキ']],
    tail: [['ka', 'カ'], ['to', 'ト'], ['mi', 'ミ'], ['ryu', 'リュウ'], ['sei', 'セイ'], ['ha', 'ハ'], ['no', 'ノ'], ['gawa', 'ガワ']],
  },
  latin: {
    head: [['Sol', 'ソル'], ['Ver', 'ヴェル'], ['Cala', 'カラ'], ['Mira', 'ミラ'], ['Por', 'ポル'], ['Val', 'ヴァル'], ['Ari', 'アリ'], ['Lumi', 'ルミ'], ['Cor', 'コル'], ['Ser', 'セル'], ['Bella', 'ベラ'], ['Monte', 'モンテ'], ['Rio', 'リオ']],
    tail: [['ia', 'イア'], ['ante', 'アンテ'], ['mar', 'マール'], ['nova', 'ノヴァ'], ['ella', 'エラ'], ['ino', 'イーノ'], ['ora', 'オラ'], ['ana', 'アナ'], ['verde', 'ヴェルデ']],
  },
  island: {
    head: [['Mari', 'マリ'], ['Cora', 'コーラ'], ['Lagu', 'ラグ'], ['Palu', 'パル'], ['Tani', 'タニ'], ['Vaha', 'ヴァハ'], ['Moro', 'モロ'], ['Kela', 'ケラ'], ['Anua', 'アヌア'], ['Sula', 'スラ']],
    tail: [['na', 'ナ'], ['lis', 'リス'], ['tau', 'タウ'], ['may', 'マイ'], ['ika', 'イカ'], ['roa', 'ロア'], ['peni', 'ペニ'], ['va', 'ヴァ']],
  },
};

// 音節表から地名を1つ作る。既出の名前は避ける。
function worldMakePlaceName(styleId, rand, used) {
  const style = WORLD_NAME_STYLES[styleId] || WORLD_NAME_STYLES.vestarian;
  for (let attempt = 0; attempt < 60; attempt++) {
    const h = style.head[(rand() * style.head.length) | 0];
    const t = style.tail[(rand() * style.tail.length) | 0];
    const latin = h[0] + t[0];
    if (used.has(latin)) continue;
    used.add(latin);
    return { name: h[1] + t[1], nameLatin: latin };
  }
  // 出尽くしたら連番を足して必ず一意にする
  let n = 2;
  for (;;) {
    const h = style.head[(rand() * style.head.length) | 0];
    const t = style.tail[(rand() * style.tail.length) | 0];
    const latin = h[0] + t[0] + ' ' + n;
    if (!used.has(latin)) { used.add(latin); return { name: h[1] + t[1] + n, nameLatin: latin }; }
    n++;
  }
}

// ============================================================================
// 6. 生成される地物
// initWorld() が埋める。定義順の都合で先に空の配列だけ用意しておく。
// ============================================================================

const WORLD_CITIES = [];
const WORLD_AIRPORTS = [];
const WORLD_LAKES = [];
const WORLD_RIVERS = [];
const WORLD_LAND_ANCHORS = [];

// 高さ関数の「段階」。前の段階の地形を見て次の地物を配置するので、
// 準備が終わるまでは各段階を切っておく（切らないと自分自身を参照してしまう）。
let _worldCitiesReady = false;
let _worldAirportsReady = false;
let _worldWaterReady = false;

let _worldAnchorGrid = null;
let _worldCityGrid = null;
let _worldAirportGrid = null;
let _worldLandmassGrid = null;
let _worldRangeGrid = null;
let _worldLakeGrid = null;
let _worldRiverGrid = null;

// 都市の広がり。builtRadiusM は建物が建つ範囲（js/env/03d-places.js もこれを使う）、
// urbanR は市街地として地表色を変える範囲。
const CITY_BUILT_RADIUS_MIN_M = 700;
const CITY_BUILT_RADIUS_MAX_M = 3800;

// 街の下の地形をゆるく均す強さ。1.0だと完全な平面になって不自然なので、
// 元の起伏を1割残す。空港（完全に平ら）と違い、街は多少の起伏があってよい。
const CITY_FLATTEN_STRENGTH = 0.90;

// 空港はUIで滑走路をこれだけ伸ばせる。そのぶんの平地をあらかじめ確保しておく。
const AIRPORT_LENGTH_HEADROOM_M = 900;

// ============================================================================
// 7. 気候
// 3,000km四方を一様な緑にすると単調なので、緯度（-Zが北＝寒い）と
// 内陸度（海から遠いほど乾く）と標高から気候を出し、地表色と植生に効かせる。
// ============================================================================

// 0=極寒 〜 1=酷暑。標高が上がると下がる（気温減率）。
function worldTemperatureAt(x, z, h) {
  let t = worldSmooth01((z + WORLD_HALF) / WORLD_SIZE);
  // 帯が真っ直ぐだと地図臭いので、大きくうねらせる
  t += (worldFbm(x * 0.0000022, z * 0.0000022, 3) - 0.5) * 0.28;
  if (h > 0) t -= (h / 1000) * 0.145;
  return worldClamp(t, 0, 1);
}

// 0=湿潤 〜 1=乾燥。内陸ほど乾くが、内陸度だけで決めると大陸の中身が全部砂漠になる。
// 主役はノイズ（＝どこに乾燥帯があるか）で、内陸度はそれを底上げするだけにしている。
function worldDrynessAt(x, z, land) {
  // 係数は tools/verify-world.js の「陸の気候」の出方を見て決めた
  // （砂漠がおよそ15%、半乾燥がおよそ25%になるあたり）。
  const continentality = worldSmooth01((land - 0.10) / 0.45);
  const d = continentality * 0.60 + (worldFbm(x * 0.0000035, z * 0.0000035, 4) - 0.5) * 1.6 + 0.06;
  return worldClamp(d, 0, 1);
}

// 気象の場。位置と「気象の時計」から、湿り具合と荒れ具合を返す。
//
// 低気圧が風に乗って流れていくイメージで、時刻に応じて場そのものをずらしている。
// 気候（worldDrynessAt / worldTemperatureAt）とは別物であることに注意：
// 気候は「その土地がどういう場所か」、気象は「いま何が起きているか」。
// 実際の天候はこの2つを掛け合わせて決める（砂漠では雨雲が来ても雨になりにくい、など）。
const WEATHER_FIELD_SCALE = 0.0000042; // 気象系ひとつの大きさ ≒ 240km
const WEATHER_DRIFT_KMH = 34;          // 気圧配置が動く速さ

function worldWeatherFieldAt(x, z, hours) {
  const drift = hours * WEATHER_DRIFT_KMH * 1000;
  const sx = (x - drift) * WEATHER_FIELD_SCALE;
  const sz = (z - drift * 0.4) * WEATHER_FIELD_SCALE;

  // この2つの数は当てずっぽうではなく、陸と海のぜんぶを何時刻ぶんか分類して決めた値。
  // 0.24を上げると世界じゅうが快晴になり、下げるとどこもかしこも雨になる。
  // 0.58は傾き。ここを狭くすると smooth01 が上に張り付いて、
  // 「強い雨」が世界の2割を占めるようなことになる（レーダーが一面まっ赤になって気付いた）。
  // いまの内訳は tools/verify-world.js が「陸の天気」「海の天気」として毎回出す。
  const wetness = worldSmooth01((worldFbm(sx, sz, 4) - 0.24) / 0.58);
  // 荒れるのは湿っているところだけ（乾いた晴天が荒れることはない）
  const storminess = worldSmooth01((worldFbm(sx * 1.7 + 51.3, sz * 1.7 + 17.9, 3) - 0.52) / 0.24) * wetness;
  // 霧は別のチャンネル。荒れていると立たないので、風の弱い湿った所にだけ出る
  const fogginess = worldSmooth01((worldFbm(sx * 2.3 + 91.7, sz * 2.3 + 63.1, 3) - 0.60) / 0.18)
    * (1 - storminess) * worldSmooth01((wetness - 0.18) / 0.25);

  return { wetness, storminess, fogginess };
}

// ============================================================================
// 8. 高さ関数
// ============================================================================

// 大陸の輪郭を評価する座標を、ゆっくりしたノイズでずらす（ドメインワープ）。
// 楕円のまま重ねると大陸が丸い塊の集まりに見えてしまうが、
// 評価点をうねらせるだけで海岸線が一気に自然な形になる。
const WORLD_WARP_FREQ = 0.0000018;
const WORLD_WARP_AMP = 130000;

function worldWarpX(x, z) {
  return x + (worldFbm(x * WORLD_WARP_FREQ, z * WORLD_WARP_FREQ, 3) - 0.5) * WORLD_WARP_AMP;
}
function worldWarpZ(x, z) {
  return z + (worldFbm(x * WORLD_WARP_FREQ + 37.1, z * WORLD_WARP_FREQ + 13.7, 3) - 0.5) * WORLD_WARP_AMP;
}

// 陸/海の判定値。0より大きければ陸、小さければ海。1に近いほど内陸。
function worldLandValueAt(x, z) {
  let v = 0;
  const wx = worldWarpX(x, z), wz = worldWarpZ(x, z);
  const near = _worldLandmassGrid ? _worldLandmassGrid.at(wx, wz) : WORLD_LANDMASSES;
  if (near) {
    for (let i = 0; i < near.length; i++) {
      const m = near[i];
      const f = m.weight * worldEllipseFalloff(wx, wz, m);
      if (f > v) v = f;
    }
  }

  // 海岸線を崩して、入り江・半島・岬を作る
  v += (worldFbm(x * 0.0000168, z * 0.0000168, 4) - 0.5) * 0.52;

  // 街と空港の周辺は陸であることを保証する（ここだけノイズより優先する）
  const anchors = _worldAnchorGrid ? _worldAnchorGrid.at(x, z) : null;
  if (anchors) {
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const dx = x - a.x, dz = z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= a.r * a.r) continue;
      const anchor = 0.5 + 0.15 * worldSmooth01(1 - Math.sqrt(d2) / a.r);
      if (anchor > v) v = anchor;
    }
  }

  return v - 0.5;
}

// 大陸・山脈・起伏だけの標高。都市や空港をどこへ置くかを決めるときは、
// まだ均されていないこの高さを見る。
function worldBaseHeightAt(x, z) {
  const land = worldLandValueAt(x, z);

  if (land <= 0) {
    // 海底：岸から離れるほど深くなる。大陸棚→深海のイメージ。
    const t = Math.min(-land / 0.55, 1);
    let h = -(25 + t * t * 2600);
    h += (worldFbm(x * 0.000045, z * 0.000045, 3) - 0.5) * 220 * (1 - t);
    return h;
  }

  const inland = Math.min(land / 0.5, 1);
  const shore = worldSmooth01(Math.min(land / 0.13, 1));

  let h = shore * 40 + worldSmooth01(inland) * 240;
  h += (worldFbm(x * 0.0000225, z * 0.0000225, 4) - 0.42) * 640 * inland;

  // 山脈。複数が重なっても足し合わせずに最大値を採る
  let mountain = 0;
  const ranges = _worldRangeGrid ? _worldRangeGrid.at(x, z) : WORLD_RANGES;
  if (ranges) {
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const mask = worldEllipseFalloff(x, z, r);
      if (mask <= 0) continue;
      const m = mask * mask * worldRidgedFbm(x * r.freq, z * r.freq, 6) * r.height;
      if (m > mountain) mountain = m;
    }
  }
  h += mountain * inland;

  // 細かい凹凸。LODの最小間隔（約310m）で潰れない程度の細かさに留める
  h += (worldFbm(x * 0.00019, z * 0.00019, 3) - 0.5) * 110 * inland;
  h += (worldFbm(x * 0.00052, z * 0.00052, 3) - 0.5) * 62 * inland;

  return h < 1.5 ? 1.5 : h;
}

// 最終的な標高。街をゆるく均し、空港は完全に平らにする。
function worldHeightAt(x, z) {
  let h = worldBaseHeightAt(x, z);

  // 街の下をゆるく均す。山の急斜面に街が貼り付くのを防ぐ。
  // 空港より先に適用して、滑走路の平面が最後に必ず勝つようにする。
  if (_worldCitiesReady) {
    const cities = _worldCityGrid.at(x, z);
    if (cities) {
      for (let i = 0; i < cities.length; i++) {
        const c = cities[i];
        const dx = x - c.x, dz = z - c.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= c.flatOuterR * c.flatOuterR) continue;
        const d = Math.sqrt(d2);
        const w = 1 - worldSmooth01((d - c.flatInnerR) / (c.flatOuterR - c.flatInnerR));
        h += (c.groundY - h) * w * CITY_FLATTEN_STRENGTH;
      }
    }
  }

  // 湖と川を地形に刻む。どちらも「元の地形より下げる」だけ（min）なので、
  // 街の均しのあとに掛けても街が水没することはなく、谷はきちんと残る。
  // 空港の均しはこのあとに来るので、滑走路の平面が最後に必ず勝つ。
  if (_worldWaterReady) {
    h = worldCarveLakes(x, z, h);
    h = worldCarveRivers(x, z, h);
  }

  if (_worldAirportsReady) {
    const airports = _worldAirportGrid.at(x, z);
    if (airports) {
      for (let i = 0; i < airports.length; i++) {
        const a = airports[i];
        const dx = x - a.x, dz = z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= a.flatOuterR * a.flatOuterR) continue;
        const d = Math.sqrt(d2);
        const w = 1 - worldSmooth01((d - a.flatInnerR) / (a.flatOuterR - a.flatInnerR));
        h += (a.elevationM - h) * w;
      }
    }
  }

  return h;
}

// ある地点の「市街地らしさ」(0〜1)。地表色を街の色へ寄せるのに使う。
function worldUrbanFactorAt(x, z) {
  if (!_worldCityGrid) return 0;
  const cities = _worldCityGrid.at(x, z);
  if (!cities) return 0;
  let best = 0;
  for (let i = 0; i < cities.length; i++) {
    const c = cities[i];
    const dx = x - c.x, dz = z - c.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= c.urbanR * c.urbanR) continue;
    const f = worldSmooth01(1 - Math.sqrt(d2) / c.urbanR);
    if (f > best) best = f;
  }
  return best;
}

// ============================================================================
// 9. 都市と空港の生成
// ============================================================================

// ある地点の平坦さ（周囲 r での標高差, m）。街や空港を置けるか判断するのに使う。
function worldLocalReliefAt(x, z, r, samples) {
  const n = samples || 5;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const h = worldBaseHeightAt(x - r + (2 * r * i) / (n - 1), z - r + (2 * r * j) / (n - 1));
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return hi - lo;
}

function worldGenerateCities() {
  WORLD_CITIES.length = 0;
  const usedNames = new Set();

  for (const country of WORLD_COUNTRIES) {
    const rand = worldRng('city:' + country.id);
    const placed = [];
    const wanted = country.cityCount;

    // 候補をたくさん試して、平らで海でない場所だけ採る
    for (let attempt = 0; attempt < wanted * 90 && placed.length < wanted; attempt++) {
      const ang = rand() * Math.PI * 2;
      const dist = Math.sqrt(rand()) * country.radius;
      const x = Math.round(country.cx + Math.cos(ang) * dist);
      const z = Math.round(country.cz + Math.sin(ang) * dist);

      const h = worldBaseHeightAt(x, z);
      if (h < 8 || h > 2600) continue;

      // 首府は大きいので、置ける場所の条件も厳しくする
      const isCapital = placed.length === 0;
      const size = isCapital
        ? 0.82 + rand() * 0.18
        : 0.18 + Math.pow(rand(), 1.7) * 0.55;
      const builtR = CITY_BUILT_RADIUS_MIN_M + size * (CITY_BUILT_RADIUS_MAX_M - CITY_BUILT_RADIUS_MIN_M);

      if (worldLocalReliefAt(x, z, builtR, 5) > 420) continue;

      // 街どうしが近すぎないように
      const minGap = 46000 + size * 60000;
      let tooClose = false;
      for (const p of placed) {
        if (Math.hypot(p.x - x, p.z - z) < minGap) { tooClose = true; break; }
      }
      if (tooClose) continue;
      for (const p of WORLD_CITIES) {
        if (Math.hypot(p.x - x, p.z - z) < 40000) { tooClose = true; break; }
      }
      if (tooClose) continue;

      const nm = worldMakePlaceName(country.nameStyle, rand, usedNames);
      const city = {
        id: country.id + '-' + nm.nameLatin.toLowerCase().replace(/\s+/g, ''),
        name: nm.name, nameLatin: nm.nameLatin,
        country: country.id,
        x, z, size, capital: isCapital,
        builtRadiusM: builtR,
        urbanR: 1300 + size * 5400,
        flatInnerR: builtR * 1.15,
        flatOuterR: builtR * 1.15 * 2.4,
        groundY: 0,
      };
      placed.push(city);
      WORLD_CITIES.push(city);
    }
  }
}

// 空港のコードは「国の2文字 + 都市名の2文字」。衝突したら文字を送る。
function worldMakeAirportCode(country, city, used) {
  const cc = country.nameLatin.slice(0, 2).toUpperCase();
  const letters = city.nameLatin.replace(/[^A-Za-z]/g, '').toUpperCase();
  for (let i = 0; i + 1 < letters.length; i++) {
    const code = cc + letters[i] + letters[i + 1];
    if (!used.has(code)) { used.add(code); return code; }
  }
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of alpha) {
    for (const b of alpha) {
      const code = cc + a + b;
      if (!used.has(code)) { used.add(code); return code; }
    }
  }
  return cc + '00';
}

function worldGenerateAirports() {
  WORLD_AIRPORTS.length = 0;
  const usedCodes = new Set();

  for (const city of WORLD_CITIES) {
    // 小さすぎる街には空港を作らない
    if (!city.capital && city.size < 0.3) continue;

    const country = worldCountryById(city.country);
    const rand = worldRng('airport:' + city.id);

    const runwayLengthM = city.capital
      ? Math.round((3000 + rand() * 800) / 100) * 100
      : Math.round((1600 + city.size * 2000 + rand() * 400) / 100) * 100;
    const maxRunwayLengthM = runwayLengthM + AIRPORT_LENGTH_HEADROOM_M;
    const flatInnerR = maxRunwayLengthM * 0.62 + 700;
    const flatOuterR = flatInnerR * 2.2;

    // 街の均し範囲と重なると地面が傾くので、必ず外側へ出す
    const minDist = city.flatOuterR + flatOuterR + 2500;

    let best = null;
    for (let attempt = 0; attempt < 90; attempt++) {
      const ang = rand() * Math.PI * 2;
      const dist = minDist + rand() * 14000;
      const x = Math.round(city.x + Math.cos(ang) * dist);
      const z = Math.round(city.z + Math.sin(ang) * dist);

      const h = worldBaseHeightAt(x, z);
      if (h < 4) continue; // 海はだめ

      const relief = worldLocalReliefAt(x, z, flatInnerR, 5);
      // 他の空港と近すぎないように
      let clash = false;
      for (const a of WORLD_AIRPORTS) {
        if (Math.hypot(a.x - x, a.z - z) < a.flatOuterR + flatOuterR + 4000) { clash = true; break; }
      }
      if (clash) continue;

      if (!best || relief < best.relief) best = { x, z, h, relief };
      if (relief < 120) break; // 十分平らならそれ以上探さない
    }
    if (!best) continue;

    const code = worldMakeAirportCode(country, city, usedCodes);
    WORLD_AIRPORTS.push({
      id: code,
      name: city.name + (city.capital ? '国際空港' : '空港'),
      nameLatin: city.nameLatin + (city.capital ? ' Intl' : ''),
      country: country.id,
      city: city.id,
      x: best.x, z: best.z,
      elevationM: Math.round(best.h),
      runwayLengthM,
      runwayWidthM: city.capital ? 60 : (city.size > 0.45 ? 45 : 30),
      headingDeg: Math.round(rand() * 359),
      maxRunwayLengthM, flatInnerR, flatOuterR,
    });
  }
}

// ============================================================================
// 9b. 湖と川
//
// 湖：内陸の平らな窪地を探して椀状に掘り、水面は掘る前の地面の高さに置く。
// 川：山の高い所を源流に、ひたすら低い方へ歩かせて海か湖まで下ろす。
//     そのあと通り道に沿って谷を刻む。
//     谷を刻んでから歩かせると自分の掘った谷に落ちるので、
//     経路は必ず「刻む前の地形」の上で決める。
// ============================================================================

const LAKE_MIN_R = 2200;
const LAKE_MAX_R = 13000;

// 川の断面の決めごと。描画側（03f-water.js）もこの値を使うので、
// ここを直せば地形の刻み方と水面の張り方が同時に付いてくる。
//   川床      = 経路の高さ - RIVER_BED_OFFSET_M
//   水面      = 川床 + RIVER_WATER_DEPTH_M
//   岸までの幅 = halfWidth + RIVER_WATER_DEPTH_M / RIVER_VALLEY_SLOPE
//
// 谷の傾きを緩くしてあるのは見た目のためだけではない。急な谷にすると幅が1km程度になり、
// 数十km先の粗いLOD（1タイル24分割＝1.2km間隔）では谷そのものが再現されず、
// 地形が水面を突き抜けて川がちぎれて見える。
// （岸＝谷の斜面が水面の高さに達するところ。ここを合わせないと
//   水面が地面に埋まったり、逆に地面が水面から顔を出したりする）
const RIVER_VALLEY_SLOPE = 0.03;
const RIVER_BED_OFFSET_M = 8;
const RIVER_WATER_DEPTH_M = 5;
const RIVER_MAX_INFLUENCE = 2400;
const RIVER_STEP_M = 1500;
const RIVER_MAX_STEPS = 420;
const RIVER_MIN_LENGTH_M = 25000;

// 経路探索で使う「なだらかにした地形」。
// 山地の尾根ノイズは1〜3km規模の小さな窪地をいくらでも作るので、
// 素の地形を見て歩かせると川は数kmで穴にはまって止まる。
// 大陸規模の傾きだけが残るくらい強くならしてから歩かせる。
const RIVER_SMOOTH_R = 6500;

function worldSmoothHeightAt(x, z) {
  const d = RIVER_SMOOTH_R;
  return (worldBaseHeightAt(x, z)
    + worldBaseHeightAt(x + d, z) + worldBaseHeightAt(x - d, z)
    + worldBaseHeightAt(x, z + d) + worldBaseHeightAt(x, z - d)) / 5;
}

// ならしても残る窪地は、少しだけ登って越えることを許す（実際の川も鞍部を越える）。
// 越えられる高さと回数に上限を置いて、際限なく山を登らないようにする。
const RIVER_MAX_CLIMB_M = 45;
const RIVER_CLIMB_BUDGET = 80;

// --- 湖 ---------------------------------------------------------------------

function worldGenerateLakes() {
  WORLD_LAKES.length = 0;
  const usedNames = new Set();

  for (const country of WORLD_COUNTRIES) {
    const rand = worldRng('lake:' + country.id);
    const want = 2 + Math.round(country.radius / 190000);
    let placed = 0;

    for (let attempt = 0; attempt < want * 120 && placed < want; attempt++) {
      const ang = rand() * Math.PI * 2;
      const dist = Math.sqrt(rand()) * country.radius;
      const x = Math.round(country.cx + Math.cos(ang) * dist);
      const z = Math.round(country.cz + Math.sin(ang) * dist);

      const level = worldBaseHeightAt(x, z);
      if (level < 25 || level > 1500) continue;

      const outerR = LAKE_MIN_R + Math.pow(rand(), 1.7) * (LAKE_MAX_R - LAKE_MIN_R);
      // 窪地でないと湖にならないので、周囲が平らなことを確かめる
      if (worldLocalReliefAt(x, z, outerR, 5) > 320) continue;

      // 街・空港・他の湖と重ならないこと
      let clash = false;
      for (const c of WORLD_CITIES) {
        if (Math.hypot(c.x - x, c.z - z) < c.flatOuterR + outerR + 3000) { clash = true; break; }
      }
      if (!clash) for (const a of WORLD_AIRPORTS) {
        if (Math.hypot(a.x - x, a.z - z) < a.flatOuterR + outerR + 3000) { clash = true; break; }
      }
      if (!clash) for (const l of WORLD_LAKES) {
        if (Math.hypot(l.x - x, l.z - z) < l.outerR + outerR + 8000) { clash = true; break; }
      }
      if (clash) continue;

      const nm = worldMakePlaceName(country.nameStyle, rand, usedNames);
      WORLD_LAKES.push({
        id: 'lake-' + country.id + '-' + nm.nameLatin.toLowerCase(),
        name: nm.name + '湖', nameLatin: 'Lake ' + nm.nameLatin,
        country: country.id,
        x, z, level,
        innerR: outerR * 0.45,
        outerR,
        depth: 14 + rand() * 55,
        seed: nm.nameLatin,
      });
      placed++;
    }
  }
}

// 岸を真円にしないためのゆらぎ。中心からの距離を方位で伸び縮みさせる。
function worldLakeWobble(lake, x, z) {
  const a = Math.atan2(z - lake.z, x - lake.x);
  return 0.78 + worldFbm(Math.cos(a) * 2.6 + lake.x * 1e-5, Math.sin(a) * 2.6 + lake.z * 1e-5, 3) * 0.5;
}

function worldCarveLakes(x, z, h) {
  const lakes = _worldLakeGrid.at(x, z);
  if (!lakes) return h;
  for (let i = 0; i < lakes.length; i++) {
    const l = lakes[i];
    const dx = x - l.x, dz = z - l.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= l.outerR * l.outerR) continue;
    const d = Math.sqrt(d2) / worldLakeWobble(l, x, z);
    if (d >= l.outerR) continue;
    const t = worldSmooth01((l.outerR - d) / (l.outerR - l.innerR));
    const bed = l.level - l.depth * t;
    if (bed < h) h = bed;
  }
  return h;
}

// その地点が湖の中なら水面の高さを返す（湖の外なら null）
function worldLakeAt(x, z) {
  if (!_worldLakeGrid) return null;
  const lakes = _worldLakeGrid.at(x, z);
  if (!lakes) return null;
  for (let i = 0; i < lakes.length; i++) {
    const l = lakes[i];
    const d = Math.hypot(x - l.x, z - l.z) / worldLakeWobble(l, x, z);
    if (d < l.outerR && worldHeightAt(x, z) < l.level) return l;
  }
  return null;
}

// --- 川 ---------------------------------------------------------------------

// 川は **河口から上流へ遡って** 引く。
//
// 源流から下らせると、大陸の内側にいくらでもある窪地にはまって海まで届かない
// （尾根ノイズが大陸規模の傾きより強いので、下り一辺倒では抜けられない）。
// 逆に海岸から登る場合、「いまいる高さより高い隣のうち、いちばん低いところ」を
// 選び続ければ谷底を遡ることになり、行き止まりは山頂にしか無い。
// つまり必ず海に届く川ができる。最後に順序をひっくり返して上流→河口の経路にする。
function worldTraceRiverFromMouth(mx, mz) {
  const back = [];
  let x = mx, z = mz;
  let walkH = worldSmoothHeightAt(x, z);
  let dirX = 0, dirZ = 0;

  for (let i = 0; i < RIVER_MAX_STEPS; i++) {
    back.push({ x, z });

    let best = null;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const cx = Math.cos(ang), cz = Math.sin(ang);
      const nx = x + cx * RIVER_STEP_M, nz = z + cz * RIVER_STEP_M;
      const nh = worldSmoothHeightAt(nx, nz);
      if (nh <= walkH + 0.5) continue; // 上流は必ず今より高い

      // 慣性ぶんを引いて、まっすぐ遡るほど有利にする
      let score = nh - (cx * dirX + cz * dirZ) * 22;
      // 滑走路の真ん中を川が通ると破綻するので、空港の均し範囲は避ける
      for (let k = 0; k < WORLD_AIRPORTS.length; k++) {
        const ap = WORLD_AIRPORTS[k];
        const dx = nx - ap.x, dz = nz - ap.z;
        const r = ap.flatOuterR + 2000;
        if (dx * dx + dz * dz < r * r) { score += 1e6; break; }
      }
      // 「高い隣のうち、いちばん低いところ」＝谷底を遡る
      if (!best || score < best.score) best = { x: nx, z: nz, h: nh, score };
    }

    if (!best || best.score > 1e5) break; // 山頂に着いた（or 空港に囲まれた）
    if (best.h - walkH > 300) break;      // 崖を登り始めたら源流とみなす

    dirX = (best.x - x) / RIVER_STEP_M;
    dirZ = (best.z - z) / RIVER_STEP_M;
    x = best.x; z = best.z;
    walkH = best.h;
  }

  // 上流→河口の順に直してから角を落とす
  back.reverse();
  const smooth = worldChaikinPath(back, 2);

  // 川床の高さを入れる。上流から下流へ単調に下がり、
  // かつその場の地形より上には出さない（谷底を通す）。
  let bed = Infinity;
  const pts = [];
  for (let i = 0; i < smooth.length; i++) {
    const p = smooth[i];
    bed = Math.min(bed, worldBaseHeightAt(p.x, p.z));
    pts.push({ x: p.x, z: p.z, h: bed });
  }
  return pts;
}

// 経路探索の途中で使う軽い湖判定（worldHeightAt を呼ばずに済ませる）
function worldLakeGridHas(x, z, h) {
  if (!_worldLakeGrid) return false;
  const lakes = _worldLakeGrid.at(x, z);
  if (!lakes) return false;
  for (let i = 0; i < lakes.length; i++) {
    const l = lakes[i];
    if (Math.hypot(x - l.x, z - l.z) < l.outerR && h <= l.level + 30) return true;
  }
  return false;
}

// 経路の角を落とす（Chaikin）。8方向にしか進めないので折れ線は45°刻みになる。
// 2回かけると点数が約4倍になり、川らしい滑らかな蛇行になる。
function worldChaikinPath(pts, passes) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const out = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

// 海岸線の上に河口の候補を探す
function worldFindRiverMouth(country, rand) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const ang = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * country.radius;
    const x = country.cx + Math.cos(ang) * dist;
    const z = country.cz + Math.sin(ang) * dist;
    const h = worldBaseHeightAt(x, z);
    if (h < -60 || h > 25) continue; // 汀線の近くだけ

    // まわりに陸がなければ（孤立した浅瀬なら）河口にしない
    let land = 0;
    for (let a = 0; a < 8; a++) {
      const t = (a / 8) * Math.PI * 2;
      if (worldBaseHeightAt(x + Math.cos(t) * 6000, z + Math.sin(t) * 6000) > 40) land++;
    }
    if (land < 2) continue;
    return { x, z };
  }
  return null;
}

function worldGenerateRivers() {
  WORLD_RIVERS.length = 0;
  const usedNames = new Set();

  for (const country of WORLD_COUNTRIES) {
    const rand = worldRng('river:' + country.id);
    const want = Math.max(3, Math.round(country.radius / 55000));
    let placed = 0;

    for (let attempt = 0; attempt < want * 12 && placed < want; attempt++) {
      const mouth = worldFindRiverMouth(country, rand);
      if (!mouth) continue;

      // 河口どうしが近すぎると同じ川が二重に流れて見える
      let clash = false;
      for (const r of WORLD_RIVERS) {
        const e = r.points[r.points.length - 1];
        if (Math.hypot(e.x - mouth.x, e.z - mouth.z) < 55000) { clash = true; break; }
      }
      if (clash) continue;

      const pts = worldTraceRiverFromMouth(mouth.x, mouth.z);
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      if (length < RIVER_MIN_LENGTH_M) continue;

      const nm = worldMakePlaceName(country.nameStyle, rand, usedNames);
      WORLD_RIVERS.push({
        id: 'river-' + country.id + '-' + nm.nameLatin.toLowerCase(),
        name: nm.name + '川', nameLatin: nm.nameLatin + ' River',
        country: country.id, points: pts, lengthM: length,
        sourceHeightM: pts[0].h,
      });
      placed++;
    }
  }
}

// 海まで届かず内陸で止まった川の終端に湖を置く。
// 大陸の内側には必ず「そこから先へ下れない窪地」が残るので、
// 川をそこで唐突に切るのではなく、内陸湖に注ぐ形にする（実在の内陸河川と同じ）。
function worldAddTerminalLakes() {
  for (const r of WORLD_RIVERS) {
    const end = r.points[r.points.length - 1];
    if (end.h <= 20) continue;                       // 海に着いている
    if (worldLakeGridHas(end.x, end.z, end.h)) continue; // すでに湖に注いでいる

    const outerR = worldClamp(1800 + r.lengthM * 0.035, 1800, 11000);

    let clash = false;
    for (const c of WORLD_CITIES) {
      if (Math.hypot(c.x - end.x, c.z - end.z) < c.flatOuterR + outerR + 2000) { clash = true; break; }
    }
    if (!clash) for (const a of WORLD_AIRPORTS) {
      if (Math.hypot(a.x - end.x, a.z - end.z) < a.flatOuterR + outerR + 2000) { clash = true; break; }
    }
    if (!clash) for (const l of WORLD_LAKES) {
      if (Math.hypot(l.x - end.x, l.z - end.z) < l.outerR + outerR + 3000) { clash = true; break; }
    }
    if (clash) continue;

    const country = worldCountryById(r.country);
    WORLD_LAKES.push({
      id: 'lake-end-' + r.id,
      name: r.name.replace('川', '') + '湖',
      nameLatin: 'Lake ' + r.nameLatin.replace(' River', ''),
      country: r.country,
      x: Math.round(end.x), z: Math.round(end.z),
      level: end.h + 6,
      innerR: outerR * 0.45,
      outerR,
      depth: 12 + Math.min(r.lengthM / 12000, 40),
      seed: r.id,
      fedByRiver: r.id,
    });
    void country;
  }
}

function worldNearestCountryId(x, z) {
  let best = null, bestD = Infinity;
  for (const c of WORLD_COUNTRIES) {
    const d = Math.hypot(x - c.cx, z - c.cz);
    if (d < bestD) { bestD = d; best = c.id; }
  }
  return best;
}

// 点と線分の距離の二乗。t には線分上のどこに落ちたか（0〜1）が入る。
const _worldSegT = { t: 0 };
function worldPointSegDist2(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const wx = px - ax, wz = pz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = wx - vx * t, dz = wz - vz * t;
  _worldSegT.t = t;
  return dx * dx + dz * dz;
}

function worldCarveRivers(x, z, h) {
  const segs = _worldRiverGrid.at(x, z);
  if (!segs) return h;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const d2 = worldPointSegDist2(x, z, s.ax, s.az, s.bx, s.bz);
    if (d2 >= RIVER_MAX_INFLUENCE * RIVER_MAX_INFLUENCE) continue;
    const d = Math.sqrt(d2);
    // 線分上のどこかで川床の高さが変わるので、その位置で補間する
    const bed = s.ah + (s.bh - s.ah) * _worldSegT.t;
    const target = d < s.halfWidth ? bed : bed + (d - s.halfWidth) * RIVER_VALLEY_SLOPE;
    if (target < h) h = target;
  }
  return h;
}

// その地点が川の中なら水面の高さを返す（川の外なら null）
function worldRiverAt(x, z) {
  if (!_worldRiverGrid) return null;
  const segs = _worldRiverGrid.at(x, z);
  if (!segs) return null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const d2 = worldPointSegDist2(x, z, s.ax, s.az, s.bx, s.bz);
    if (d2 < s.halfWidth * s.halfWidth) {
      return s.ah + (s.bh - s.ah) * _worldSegT.t;
    }
  }
  return null;
}

// その地点の水面の高さ（湖か川の中なら）。陸なら null。
// 植生を水に生やさないためと、現在地表示のために使う。
function worldWaterSurfaceAt(x, z) {
  if (!_worldWaterReady) return null;

  const lakes = _worldLakeGrid.at(x, z);
  if (lakes) {
    for (let i = 0; i < lakes.length; i++) {
      const l = lakes[i];
      const d = Math.hypot(x - l.x, z - l.z) / worldLakeWobble(l, x, z);
      if (d < l.outerR) return l.level;
    }
  }

  const segs = _worldRiverGrid.at(x, z);
  if (segs) {
    const bank = RIVER_WATER_DEPTH_M / RIVER_VALLEY_SLOPE;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const w = s.halfWidth + bank;
      const d2 = worldPointSegDist2(x, z, s.ax, s.az, s.bx, s.bz);
      if (d2 < w * w) {
        return s.ah + (s.bh - s.ah) * _worldSegT.t + RIVER_WATER_DEPTH_M;
      }
    }
  }
  return null;
}

// ============================================================================
// 10. 検索ヘルパー
// ============================================================================

function worldCountryById(id) { return WORLD_COUNTRIES.find((c) => c.id === id) || null; }
function worldCityById(id) { return WORLD_CITIES.find((c) => c.id === id) || null; }
function worldAirportById(id) { return WORLD_AIRPORTS.find((a) => a.id === id) || null; }

// ある地点にいちばん近い空港（視点移動やオートパイロットに使う）
function worldNearestAirport(x, z) {
  let best = null, bestD = Infinity;
  for (const a of WORLD_AIRPORTS) {
    const d = Math.hypot(x - a.x, z - a.z);
    if (d < bestD) { bestD = d; best = a; }
  }
  return { airport: best, distanceM: bestD };
}

// ある地点がどの国か（もっとも近い都市の国とみなす簡易判定）
function worldRegionAt(x, z) {
  let best = null, bestD = Infinity;
  for (const c of WORLD_CITIES) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return null;
  return { city: best, country: worldCountryById(best.country), distanceM: bestD };
}

// ============================================================================
// 11. 初期化
// 各段階は前の段階の地形を見る。順番を入れ替えると、
// まだ用意できていないものを参照して静かに壊れるので触らないこと。
// ============================================================================

let _worldReady = false;

function initWorld() {
  if (_worldReady) return;

  WORLD_LANDMASSES.forEach(worldPrepEllipse);
  WORLD_RANGES.forEach(worldPrepEllipse);

  // 大陸と山脈の空間インデックス（3,000km四方を全部走査しないため）
  _worldLandmassGrid = makeWorldGrid(120000);
  for (const m of WORLD_LANDMASSES) _worldLandmassGrid.insert(m.cx, m.cz, m._bound, m);
  _worldRangeGrid = makeWorldGrid(120000);
  for (const r of WORLD_RANGES) _worldRangeGrid.insert(r.cx, r.cz, r._bound, r);

  // 1) 素の地形の上に街を置く
  worldGenerateCities();
  // 2) 街から少し離れた平らな場所に空港を置く
  worldGenerateAirports();

  // 3) 内陸の窪地に湖を置く（街・空港とは重ならない場所を選ぶ）
  worldGenerateLakes();
  _worldLakeGrid = makeWorldGrid(30000);
  for (const l of WORLD_LAKES) _worldLakeGrid.insert(l.x, l.z, l.outerR, l);

  // 4) 山から海（または湖）まで川を下ろす。
  //    経路は「刻む前の地形」の上で決めること。谷を刻んでから歩かせると
  //    自分の掘った谷に落ちて、そこから先へ進めなくなる。
  worldGenerateRivers();

  // 内陸で止まった川の終端に湖を足し、湖グリッドを作り直す
  worldAddTerminalLakes();
  _worldLakeGrid = makeWorldGrid(30000);
  for (const l of WORLD_LAKES) _worldLakeGrid.insert(l.x, l.z, l.outerR, l);

  _worldRiverGrid = makeWorldGrid(20000);
  for (const r of WORLD_RIVERS) {
    let acc = 0;
    r.points[0].halfWidth = 12;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], b = r.points[i];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      // 下流ほど幅が広がる
      const halfWidth = 12 + ((acc + segLen / 2) / r.lengthM) * 95;
      b.halfWidth = halfWidth;
      _worldRiverGrid.insert((a.x + b.x) / 2, (a.z + b.z) / 2, segLen / 2 + RIVER_MAX_INFLUENCE, {
        ax: a.x, az: a.z, ah: a.h - RIVER_BED_OFFSET_M,
        bx: b.x, bz: b.z, bh: b.h - RIVER_BED_OFFSET_M,
        halfWidth,
      });
      acc += segLen;
    }
  }

  // 5) 街と空港が海岸線ノイズで沈まないようアンカーを張る
  WORLD_LAND_ANCHORS.length = 0;
  for (const a of WORLD_AIRPORTS) {
    WORLD_LAND_ANCHORS.push({ x: a.x, z: a.z, r: Math.max(a.flatOuterR * 1.5, 22000) });
  }
  for (const c of WORLD_CITIES) {
    WORLD_LAND_ANCHORS.push({ x: c.x, z: c.z, r: 12000 + c.size * 20000 });
  }
  _worldAnchorGrid = makeWorldGrid(40000);
  for (const a of WORLD_LAND_ANCHORS) _worldAnchorGrid.insert(a.x, a.z, a.r, a);

  // 6) 街の基準標高を「街を均す前の地形」から取ってから、街の均しを有効にする
  _worldCityGrid = makeWorldGrid(40000);
  for (const c of WORLD_CITIES) {
    c.groundY = worldHeightAt(c.x, c.z);
    _worldCityGrid.insert(c.x, c.z, c.flatOuterR, c);
  }
  _worldCitiesReady = true;

  // 7) 湖と川の刻み込みを有効にする（街の均しのあと、空港の均しの前）
  _worldWaterReady = true;

  // 8) 空港の均しを有効にする（滑走路の平面が最後に勝つ）
  _worldAirportGrid = makeWorldGrid(40000);
  for (const a of WORLD_AIRPORTS) _worldAirportGrid.insert(a.x, a.z, a.flatOuterR, a);
  _worldAirportsReady = true;

  _worldReady = true;
}

// Node（検証スクリプト）から読めるようにしておく。ブラウザでは module が無いので何もしない。
if (typeof module !== 'undefined' && module.exports) {
  initWorld();
  module.exports = {
    WORLD_SEED, WORLD_SIZE, WORLD_HALF,
    WORLD_LANDMASSES, WORLD_RANGES, WORLD_COUNTRIES, WORLD_CITIES, WORLD_AIRPORTS,
    WORLD_LAKES, WORLD_RIVERS, worldLakeAt, worldRiverAt, worldWaterSurfaceAt,
    CITY_FLATTEN_STRENGTH, RIVER_VALLEY_SLOPE, RIVER_BED_OFFSET_M, RIVER_WATER_DEPTH_M,
    worldClamp, worldSmooth01, worldValueNoise, worldFbm,
    initWorld, worldHeightAt, worldBaseHeightAt, worldLandValueAt, worldUrbanFactorAt,
    worldTemperatureAt, worldDrynessAt, worldWeatherFieldAt, worldLocalReliefAt,
    worldNearestAirport, worldRegionAt, worldCountryById, worldCityById, worldAirportById,
  };
}
