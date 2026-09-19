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

// --- 山脈の稜線 -------------------------------------------------------------
//
// 山脈は「楕円のなかのリッジノイズ」ではなく、**稜線を1本引いて、そこからの距離**で
// 高さを決める。前の作り方（中心からの距離で減衰させたドームにノイズを掛ける）だと、
//
//   ・尾根が 29〜108個 の孤立した塊に割れて、連なりに見えない
//     （アストラ大山脈で69個。最高点の60%以上の場所を連結成分で数えた実測）
//   ・細長く定義しても主軸比が 1.5〜2.2 にしかならず、丸く見える
//   ・長軸の半分まで来ると mask*mask が 0.36 まで落ちるので、端が高くならない
//
// という壊れ方をしていた。上空22kmから見ると、稜線のない雪原にでこぼこが
// 散らばっているだけで、山脈の背骨がどこにも無かった。

// 長軸方向にこの割合までは高さを落とさない（落とすとドームになる）
const RANGE_END_FLAT = 0.42;
// 稜線の芯の太さ（短軸半径に対する割合）。ここだけ下支えする。
// 山脈ぜんぶに下支えを掛けると、稜線ではなく広い高原になって傾斜がむしろ緩くなる
// （実際に掛けてみたら最大傾斜が 14〜43% から 10〜28% に下がり、
//   標高1000m超の陸が 10.6% から 26.2% に増えてしまった）。
const RANGE_CREST_W = 0.30;
// 芯の下支えの強さ。稜線の低いところだけを持ち上げ、峰と山腹はノイズのまま残す。
// 0にすると（＝前の式）またノイズだけになって塊に割れる。
const RANGE_CREST_CORE = 0.62;
// 稜線の蛇行の大きさ（短軸半径に対する割合）。まっすぐな棒に見せないためのもの
const RANGE_BEND = 0.26;
// リッジノイズのサンプル位置をずらす量（ノイズ1周期に対する割合）。
// 大きくしすぎると稜線が渦を巻いて山脈に見えなくなる。
const RANGE_WARP = 1.7;

function worldPrepRange(r) {
  worldPrepEllipse(r);
  // 長いほうの軸に稜線を沿わせる
  r._swap = r.rz > r.rx;
  r._long = r._swap ? r.rz : r.rx;
  r._half = r._swap ? r.rx : r.rz;
  const rand = worldRng('range:' + r.nameLatin);
  r._phase = rand() * Math.PI * 2;
  // 片側だけ急にする（沈み込み側が急、という実際の山脈の非対称）。
  // 1.0 で左右対称、大きいほど片側が切り立つ。
  r._steep = 1.25 + rand() * 0.55;
  return r;
}

// 稜線が長軸の中心線からどれだけ横へずれているか（t は -1〜1）。
// 2つの正弦を重ねて、周期が読めないようにしている。
function worldRangeBend(r, t) {
  return r._half * RANGE_BEND
    * (Math.sin(t * 2.3 + r._phase) + 0.54 * Math.sin(t * 5.1 + r._phase * 1.7));
}

// 稜線上の点（t は -1〜1 で、長軸の端から端）。検証で稜線を歩くのに使う。
function worldRangeCrestAt(r, t) {
  const u = t * r._long, v = worldRangeBend(r, t);
  const a = r._swap ? v : u, b = r._swap ? u : v;
  return { x: r.cx + a * r._cos - b * r._sin, z: r.cz + a * r._sin + b * r._cos };
}

// その地点における1本の山脈の盛り上がり（0〜r.height）
function worldRangeHeightAt(x, z, r) {
  const dx = x - r.cx, dz = z - r.cz;
  let u = dx * r._cos + dz * r._sin;
  let v = -dx * r._sin + dz * r._cos;
  if (r._swap) { const t = u; u = v; v = t; }

  const t = u / r._long;
  if (t <= -1 || t >= 1) return 0;

  // 長軸方向：中ほどは目いっぱいのまま、両端だけ落とす
  const along = 1 - worldSmooth01((Math.abs(t) - RANGE_END_FLAT) / (1 - RANGE_END_FLAT));
  if (along <= 0) return 0;

  let off = (v - worldRangeBend(r, t)) / r._half;
  off *= off > 0 ? r._steep : 1 / r._steep;
  off = Math.abs(off);
  if (off >= 1) return 0;
  const across = 1 - worldSmooth01((off - r.inner) / (1 - r.inner));

  const mask = along * across;

  // リッジノイズをそのまま使うと、稜線が格子に沿って直角に折れた「碁盤の目」になる。
  // 値ノイズは格子点の双一次補間なので、|2n-1| が0になる線＝稜線が格子の向きに
  // 揃ってしまうため。サンプル位置自体を別のノイズでずらして（ドメインワープ）、
  // 格子の向きを崩す。1点あたり値ノイズ2回ぶんの上乗せで済む。
  const nx = x * r.freq, nz = z * r.freq;
  const wx = worldValueNoise(nx * 0.45 + 17.3, nz * 0.45 - 8.1) - 0.5;
  const wz = worldValueNoise(nx * 0.45 - 31.7, nz * 0.45 + 22.9) - 0.5;
  const ridged = worldRidgedFbm(nx + wx * RANGE_WARP, nz + wz * RANGE_WARP, 6);
  // 稜線の芯の低いところだけを持ち上げる。峰（ridgedが1に近い所）は動かないので、
  // 峰の高さと山腹の起伏はそのままに、連なりだけが切れなくなる。
  const crest = 1 - worldSmooth01(off / RANGE_CREST_W);
  const shape = ridged + crest * RANGE_CREST_CORE * (1 - ridged);
  return mask * mask * r.height * shape;
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
const WORLD_DELTAS = [];
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
let _worldDeltaGrid = null;

// 都市の広がり。builtRadiusM は建物が建つ範囲（js/env/03d-places.js もこれを使う）、
// urbanR は市街地として地表色を変える範囲。
const CITY_BUILT_RADIUS_MIN_M = 700;
const CITY_BUILT_RADIUS_MAX_M = 3800;

// 街路の碁盤の目。街区の一辺と、街路そのものの半幅。
// 街区を小さくしすぎると、建物1個より街路のほうが太くなって「舗装の海」になる。
// 建物の間口が11〜37mなので、街区は1辺に数軒が並ぶ大きさにする。
const CITY_BLOCK_MIN_M = 150;
const CITY_BLOCK_MAX_M = 230;
const CITY_STREET_HALF_W_M = 7;
// 建物を街路から離す余白。0だと建物の角が舗装にかぶって街路が途切れて見える。
const CITY_STREET_CLEAR_M = 4;

// 街の中心からの相対位置 (ox,oz) が、いちばん近い街路の中心線からどれだけ離れているか。
// 建物を街路に建てないためと、街路の帯を描くために使う——**同じ式を両方が見る**ので、
// 建物と舗装がずれない。
function worldCityStreetDist(city, ox, oz) {
  const c = Math.cos(city.streetAngle), s = Math.sin(city.streetAngle);
  const u = ox * c + oz * s, v = -ox * s + oz * c;
  const b = city.blockM;
  const du = Math.abs(u - Math.round(u / b) * b);
  const dv = Math.abs(v - Math.round(v / b) * b);
  return du < dv ? du : dv;
}

// 街の下の地形をゆるく均す強さ。1.0だと完全な平面になって不自然なので、
// 元の起伏を1割残す。空港（完全に平ら）と違い、街は多少の起伏があってよい。
const CITY_FLATTEN_STRENGTH = 0.90;

// 空港はUIで滑走路をこれだけ伸ばせる。そのぶんの平地をあらかじめ確保しておく。
const AIRPORT_LENGTH_HEADROOM_M = 900;

// 平行滑走路の間隔。実際の国際空港（成田760m・羽田など）に比べると詰めてあるが、
// 広げるほど空港の平地が要るので、見て「2本ある」と分かる最小限にしてある。
const AIRPORT_RUNWAY_SPACING_M = 480;
// いちばん外の滑走路の縁から、ターミナルまでの距離（エプロンを挟む）
const AIRPORT_TERMINAL_OFFSET_M = 430;
// ターミナルから、道路が入ってくる場所（車寄せ）までの距離
const AIRPORT_GATE_OFFSET_M = 190;

// 滑走路の並びが、中心線から左右どれだけ広がっているか
function airportRunwayHalfSpan(a) {
  const n = a.runwayCount || 1;
  return ((n - 1) * (a.runwaySpacingM || AIRPORT_RUNWAY_SPACING_M)) / 2;
}

// 空港のローカル座標（+X が滑走路の進行方向、+Z が右手）を世界座標へ。
// **描画側（04b-airport.js）のグループ回転と同じ式**にしてあるので、
// 道路がターミナルへ着く位置と、実際にターミナルが建つ位置がずれない。
function airportLocalToWorld(a, lx, lz) {
  const t = ((90 - a.headingDeg) * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return { x: a.x + lx * c + lz * s, z: a.z - lx * s + lz * c };
}

// **実際に使う滑走路の中心。**
// 空港の中心 (a.x, a.z) は、平行滑走路があるときは滑走路の「あいだの草地」なので、
// そこを狙うと離陸も着陸も草の上になる。ターミナル側の1本を使う。
// 滑走路が1本なら空港の中心と同じ値を返す。
function worldAirportRunwayCenter(a) {
  return airportLocalToWorld(a, 0, airportRunwayHalfSpan(a));
}

// 道路が空港へ入る場所（ターミナルの車寄せ）
function worldAirportGateAt(a) {
  return airportLocalToWorld(a, a.terminalLocalX, a.gateLocalZ);
}

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

// 森の濃さ（0〜1）。**地表の色と、実際に生える木の、唯一の出どころ。**
//
// もともと地表色（03c-terrain.js）と樹木（03g-vegetation.js）が別々の式で
// 森を決めていて、実測で**平均0.45も食い違っていた**（陸を20,000点サンプルした
// ときの |色の森混合率 − 木の密度| の平均）。食い違いは両方向に出ていて、
//   ・標高400m・乾燥0.63の土地 … 地表は森の色100%なのに木は1本も生えない
//   ・標高40m・温暖湿潤の土地 … 地表は草地の色なのに木は密度0.5で生える
// 後者がとくに目立つ。手前1.2kmだけ濃い緑の木が立ち、その先は明るい草地の色が
// のっぺり続くので、**木の出る半径が地面に色の境目として見えてしまう**。
// 同じ式を両方が見れば、この境目は原理的に出ない。
//
// h=標高, slope=傾き, temp=気温(0〜1), dry=乾燥度(0〜1), urban=市街地度(0〜1)
function worldForestDensity(h, slope, temp, dry, urban) {
  if (h < 6) return 0;
  // 森林限界。気温から決まるので、北ほど低い標高で森が終わる
  const treeLine = (700 + temp * 3400) * 0.62;
  if (h > treeLine) return 0;

  // 乾燥地には森ができない
  let d = 1 - worldSmooth01((dry - 0.30) / 0.28);
  // 寒すぎると育たない
  d *= worldSmooth01((temp - 0.06) / 0.14);
  // 低地の草原より、中腹の森林帯がいちばん濃い
  d *= 0.50 + 0.50 * worldSmooth01((h - treeLine * 0.18) / (treeLine * 0.35));
  // 森林限界の手前で疎らになる
  d *= 1 - worldSmooth01((h - treeLine * 0.78) / (treeLine * 0.22));
  // 急斜面には生えにくい
  d *= 1 - worldSmooth01((slope - 0.38) / 0.28);
  // 市街地は伐られている
  d *= 1 - urban;

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
      const m = worldRangeHeightAt(x, z, ranges[i]);
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
    // 三角州は「積もらせてから切り開く」。堆積を刻み込みより先に掛ける。
    h = worldDepositDeltas(x, z, h);
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
      const id = country.id + '-' + nm.nameLatin.toLowerCase().replace(/\s+/g, '');
      // 街路の向きと街区の大きさは、**街の名前から引いた別の乱数**で決める。
      // 配置用の rand() をここで消費すると、以降の街の位置がぜんぶずれる
      // （実際にずらしてしまい、ステンハイムが標高差270mの斜面に乗って検証が落ちた）。
      const srand = worldRng('street:' + id);
      const city = {
        id,
        name: nm.name, nameLatin: nm.nameLatin,
        country: country.id,
        x, z, size, capital: isCapital,
        builtRadiusM: builtR,
        urbanR: 1300 + size * 5400,
        flatInnerR: builtR * 1.15,
        flatOuterR: builtR * 1.15 * 2.4,
        groundY: 0,
        // 街路の碁盤の目の向きと街区の大きさ。街ごとに変える。
        // 全部が同じ向きだと、上空から見たときに世界中の街が同じ判子に見える。
        streetAngle: srand() * Math.PI * 0.5,
        blockM: CITY_BLOCK_MIN_M + srand() * (CITY_BLOCK_MAX_M - CITY_BLOCK_MIN_M),
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
    // 大きな空港は滑走路を複数本持つ。首府の国際空港は2〜3本の平行滑走路。
    const runwayCount = city.capital ? (city.size > 0.92 ? 3 : 2) : 1;

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
      runwayCount,
      runwaySpacingM: AIRPORT_RUNWAY_SPACING_M,
      // ターミナルと、そこへ車が入ってくる位置。**定義の値だけで決める**
      // （UIで滑走路の長さを変えても動かないように）。
      // ローカル座標は +X が滑走路の進行方向、+Z が右手。
      terminalLocalX: -maxRunwayLengthM * 0.5 + 420,
      terminalLocalZ: airportRunwayHalfSpan({ runwayCount, runwaySpacingM: AIRPORT_RUNWAY_SPACING_M })
        + AIRPORT_TERMINAL_OFFSET_M,
      gateLocalZ: airportRunwayHalfSpan({ runwayCount, runwaySpacingM: AIRPORT_RUNWAY_SPACING_M })
        + AIRPORT_TERMINAL_OFFSET_M + AIRPORT_GATE_OFFSET_M,
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

// 川幅は「そこまでに集めた水の量」で決める。
//
// 以前は 12 + (源流からの割合) * 95 だった。これは長さに関係なく
// 「何割来たか」だけで決まるので、31kmの川も139kmの川も河口の半幅が107mちょうどになり、
// 空から見て大河と小川の区別がつかなかった。
// 集水面積は流路長のおよそ1.8乗、川幅は流量のおよそ0.5乗で増えるので、
// 合わせると幅は流路長の0.9乗——ここでは平方根で近似する（少なめに見積もる側）。
const RIVER_WIDTH_K = 0.30;          // 半幅[m] = K * sqrt(源流からの距離[m])
const RIVER_MIN_HALF_WIDTH_M = 10;

// --- 河口 -------------------------------------------------------------------
//
// 川が海岸線でぶつ切りになっていたのを、入り江か三角州で海につなぐ。
// どちらになるかは海岸の傾きで決める（実際の地形と同じ理屈）。
//
//   遠浅の海岸 … 運んできた土砂が溜まるので河口が埋まり、流れが分かれる＝三角州
//   急な海岸   … 谷がそのまま海に沈むので、細長い入り江（溺れ谷）になる
//
// どちらの場合も河口の川床を海面下まで下げる。地形が海面(y=0)より低くなれば
// そこは自動的に海になるので、「海が内陸へ入り込む」形が地形だけで出る。
const RIVER_MOUTH_FLARE_M = 9000;    // 河口からこの距離のあいだで幅を広げる
const RIVER_MOUTH_FLARE_MUL = 2.4;   // 河口での幅の倍率
const RIVER_MOUTH_SEA_DEPTH_M = 12;  // 河口の川床を海面下このぶんまで下げる
const RIVER_OFFSHORE_PROBE_M = 12000; // 海岸の傾きを測る沖への距離
const DELTA_MIN_SHELF_H = -45;       // 沖がこれより浅ければ遠浅＝三角州にする
const DELTA_MIN_LENGTH_M = 65000;    // 短い川は土砂を運べないので三角州にしない
const DELTA_REACH_M = 5200;          // 分流が海へ伸びる距離のめやす（実際は海に出るまで歩く）
const DELTA_STEP_M = 870;
const DELTA_MAX_STEPS = 14;          // 遠浅すぎて海に出られないときの打ち切り（約12km）
const DELTA_SPREAD_RAD = 0.70;       // いちばん外の分流が本流から開く角度
const DELTA_BRANCH_WIDTH = 0.40;     // 分流の幅（本流の河口幅に対する割合）
const DELTA_BRANCH_DEPTH = 0.50;     // 分流の深さ（河口の掘り下げに対する割合）
const DELTA_DRIFT_MAX = 0.30;        // 分流が扇形の向きから曲がってよい角度
const DELTA_BRANCHES = 3;
const DELTA_DEPOSIT_H = 4;           // 堆積でできる中州の高さ（海面から）
const DELTA_DEPOSIT_FLAT = 0.45;     // 扇のこの割合までは高さを落とさない

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

// --- 河口 -------------------------------------------------------------------

// 海に出ている川の河口の形を決める。worldAddTerminalLakes のあとに呼ぶこと
// （湖に注ぐ川は海岸を持たないので対象外）。
// ここでは「向き」と「入り江か三角州か」だけを決め、実際の幅・川床・分流は
// worldBuildRiverGrid が作る（本流の幅が決まっていないと分流の幅を決められないため）。
function worldShapeRiverMouths() {
  WORLD_DELTAS.length = 0;

  for (const r of WORLD_RIVERS) {
    r.mouthKind = null;
    const end = r.points[r.points.length - 1];
    if (end.h > 20) continue;                            // 内陸で終わっている
    if (worldLakeGridHas(end.x, end.z, end.h)) continue; // 湖に注いでいる

    // 河口での流れの向き。最後の1区間だけ見ると Chaikin のギザギザを拾うので、
    // 3kmほど手前から見る。
    const back = r.points[Math.max(0, r.points.length - 9)];
    const base = Math.atan2(end.z - back.z, end.x - back.x);

    // その向きが本当に沖かを確かめる。海岸線は曲がっているので、上流からの向きを
    // そのまま伸ばすと陸へ突っ込むことがある。±90°のうち一番深いほうを沖とする。
    let ang = base, shelf = Infinity;
    for (let k = -4; k <= 4; k++) {
      const a = base + (k / 4) * (Math.PI / 2);
      const h = worldBaseHeightAt(end.x + Math.cos(a) * RIVER_OFFSHORE_PROBE_M,
                                  end.z + Math.sin(a) * RIVER_OFFSHORE_PROBE_M);
      if (h < shelf) { shelf = h; ang = a; }
    }
    if (shelf > 0) continue; // どちらを向いても陸。海に出ていないので触らない

    r.mouthAngle = ang;
    // 遠浅なら土砂が溜まって流れが分かれる＝三角州。
    // 急に落ちる海岸なら谷がそのまま沈む＝入り江（溺れ谷）。
    // 短い川は土砂を運べないので、遠浅でも入り江にする。
    if (shelf < DELTA_MIN_SHELF_H || r.lengthM < DELTA_MIN_LENGTH_M) {
      r.mouthKind = 'estuary';
      continue;
    }
    r.mouthKind = 'delta';
    WORLD_DELTAS.push({
      x: end.x, z: end.z, dx: Math.cos(ang), dz: Math.sin(ang),
      reach: DELTA_REACH_M * 1.15,
      halfAngle: DELTA_SPREAD_RAD + 0.28,
      river: r.id,
    });
  }
}

// 三角州の堆積。河口の沖に広がる扇形を、海面より少しだけ高い平地にする。
// 川の刻み込みより先に呼ぶこと——「積もらせた土を分流が切り開く」という順番でないと、
// 分流を掘っても海底を掘るだけになって、水面下で何も見えない。
function worldDepositDeltas(x, z, h) {
  if (!_worldDeltaGrid) return h;
  const ds = _worldDeltaGrid.at(x, z);
  if (!ds) return h;
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    const vx = x - d.x, vz = z - d.z;
    const dist = Math.hypot(vx, vz);
    if (dist < 1 || dist > d.reach) continue;
    // 扇の内側か（河口から沖へ向く向きとの角度で見る）
    const a = Math.acos(worldClamp((vx * d.dx + vz * d.dz) / dist, -1, 1));
    if (a > d.halfAngle) continue;
    // 縁は海へなだらかに沈める。外形を波打たせないと、扇が定規で描いた
    // 「きれいな円弧＋まっすぐな二辺」になって、上空から見たときに一目で作り物と分かる。
    // 半径方向と角度方向の両方を、別のノイズで揺らす。
    const wr = 0.80 + 0.32 * worldValueNoise(x * 0.00035 + 40, z * 0.00035 - 17);
    const wa = 0.72 + 0.46 * worldValueNoise(x * 0.00021 - 63, z * 0.00021 + 88);
    // 河口のすぐ先から減らしはじめると、分流が短い（すぐ海に出る）三角州で
    // 中州が水面まで届かない。ターンオル川は分流が2.6kmしかなく、
    // 中州が海面下0.2mになっていた。内側 DELTA_DEPOSIT_FLAT までは目いっぱい積もらせる。
    const fr = 1 - worldSmooth01((dist / (d.reach * wr) - DELTA_DEPOSIT_FLAT)
      / (1 - DELTA_DEPOSIT_FLAT));
    const edge = d.halfAngle * wa;
    const fa = 1 - worldSmooth01((a - edge * 0.55) / (edge * 0.45));
    const target = DELTA_DEPOSIT_H * fr * fa;
    if (target > h) h = target;
  }
  return h;
}

// 川の幅と川床を決め、地形を刻むための空間インデックスに入れる。
// 経路（worldGenerateRivers）と河口の種類（worldShapeRiverMouths）が決まったあとに呼ぶ。
function worldBuildRiverGrid() {
  _worldRiverGrid = makeWorldGrid(20000);

  for (const r of WORLD_RIVERS) {
    const pts = r.points;
    const n = pts.length;

    // 幅：源流からの距離の平方根に比例（＝集めた水の量で決まる）
    let acc = 0;
    pts[0].fromSource = 0;
    for (let i = 1; i < n; i++) {
      acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      pts[i].fromSource = acc;
    }
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      p.halfWidth = Math.max(RIVER_MIN_HALF_WIDTH_M, RIVER_WIDTH_K * Math.sqrt(p.fromSource));
      p.bedH = p.h - RIVER_BED_OFFSET_M;
    }

    // 河口：手前で幅を広げ、川床を海面下まで下ろす。
    // 地形が海面(y=0)より低くなればそこは海になるので、
    // 「海が谷へ入り込む」形（入り江）が地形だけで出る。
    if (r.mouthKind) {
      const g = worldMouthCityGuard(r);
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const fromMouth = r.lengthM - p.fromSource;
        if (fromMouth > RIVER_MOUTH_FLARE_M) continue;
        const t = worldSmooth01(1 - fromMouth / RIVER_MOUTH_FLARE_M) * g;
        p.halfWidth *= 1 + (RIVER_MOUTH_FLARE_MUL - 1) * t;
        // 下げるだけ。すでに海面下12mより深い川床（急な海岸に出る川）を
        // 持ち上げてしまうと、そこだけ川床が上って水が溜まる形になる。
        p.bedH = Math.min(p.bedH, p.bedH + (-RIVER_MOUTH_SEA_DEPTH_M - p.bedH) * t);
      }
    }

    for (let i = 1; i < n; i++) worldInsertRiverSegment(pts[i - 1], pts[i]);

    // 三角州の分流。本流の河口の幅・川床が決まってから作る。
    r.mouthBranches = r.mouthKind === 'delta' ? worldBuildDeltaBranches(r) : null;
    if (r.mouthBranches) {
      for (const br of r.mouthBranches) {
        for (let i = 1; i < br.length; i++) worldInsertRiverSegment(br[i - 1], br[i]);
      }
    }
  }

  // 堆積の広がりは分流を歩いてみないと決まらないので、空間インデックスはここで作る
  _worldDeltaGrid = makeWorldGrid(20000);
  for (const d of WORLD_DELTAS) _worldDeltaGrid.insert(d.x, d.z, d.reach, d);
}

// 河口を掘り下げてよい強さ（0〜1）。街の上を通る河口は掘らない。
//
// 街の均しは川の刻み込みより先に掛かるので、掘ったぶんは街にもそのまま効く。
// 河口を海面下12mまで下げると、河口に建っている街がまるごと水没する
// （グリムフィヨルド川は街の中心から98mのところを流れていて、実際に沈んだ）。
//
// 点ごとに弱めるのではなく、川ごとに1つの値にしてある。点ごとにすると
// 街の手前だけ川床が持ち上がって、そこに水が溜まる形になってしまう。
function worldMouthCityGuard(r) {
  let g = 1;
  for (const p of r.points) {
    if (r.lengthM - p.fromSource > RIVER_MOUTH_FLARE_M) continue;
    for (const c of WORLD_CITIES) {
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d >= c.flatOuterR) continue;
      const f = worldSmooth01((d - c.flatInnerR) / (c.flatOuterR - c.flatInnerR));
      if (f < g) g = f;
    }
  }
  return g;
}

function worldInsertRiverSegment(a, b) {
  const segLen = Math.hypot(b.x - a.x, b.z - a.z);
  _worldRiverGrid.insert((a.x + b.x) / 2, (a.z + b.z) / 2, segLen / 2 + RIVER_MAX_INFLUENCE, {
    ax: a.x, az: a.z, ah: a.bedH,
    bx: b.x, bz: b.z, bh: b.bedH,
    halfWidth: Math.max(a.halfWidth, b.halfWidth),
  });
}

// 三角州の分流。河口から扇形に開いて海へ向かう水路を DELTA_BRANCHES 本作る。
// 本流をそのまま伸ばさずに分けるのは、あいだに残る中州が「三角州らしさ」そのものだから。
//
// 長さは決め打ちにしない。三角州になる海岸はとても遠浅で、河口から5kmでも
// まだ地面が標高+1.5mある（だから土砂が溜まって三角州になる）。
// 決め打ちだと水路が陸のなかで行き止まりになって、ただの池になってしまう。
// 素の地形が海面下に落ちるところまで歩かせて、そこで海につなぐ。
function worldBuildDeltaBranches(r) {
  const end = r.points[r.points.length - 1];
  const rand = worldRng('delta:' + r.id);
  const width = end.halfWidth * DELTA_BRANCH_WIDTH;
  const out = [];
  let longest = DELTA_REACH_M;

  for (let b = 0; b < DELTA_BRANCHES; b++) {
    // -DELTA_SPREAD_RAD 〜 +DELTA_SPREAD_RAD に均等に開く
    const spread = DELTA_BRANCHES === 1 ? 0
      : (b / (DELTA_BRANCHES - 1) * 2 - 1) * DELTA_SPREAD_RAD;
    // 分流を曲げる。まっすぐだと扇形に引いた定規の線にしか見えない。
    //
    // ただの乱歩にすると際限なく流れて分流どうしが交わり、あいだの中州が消える
    // （実際 6本中2本で中州が海面下2.5mまで沈んだ）。
    // 前の値を0.85倍して引き戻し、さらに DELTA_DRIFT_MAX で頭打ちにする。
    // 隣の分流とは 2*DELTA_SPREAD_RAD/(DELTA_BRANCHES-1) = 0.70rad 離れているので、
    // 両方が目いっぱい寄っても 0.70-2*0.30 = 0.10rad 残る＝交わらない。
    // 引き戻しが弱いぶん向きの変化はゆっくりで、細かく震えずに大きく弧を描く。
    let drift = 0, run = 0;
    const br = [{ x: end.x, z: end.z, bedH: end.bedH, halfWidth: end.halfWidth }];
    for (let i = 1; i <= DELTA_MAX_STEPS; i++) {
      const prev = br[br.length - 1];
      // 曲がってよい幅は河口から離れるほど大きくする。分かれた直後は
      // 3本が寄り集まっているので、そこで曲げると隣とくっついてしまう。
      const cap = DELTA_DRIFT_MAX * Math.min(1, run / DELTA_REACH_M);
      drift = worldClamp(drift * 0.85 + (rand() - 0.5) * 0.34, -cap, cap);
      const ang = r.mouthAngle + spread + drift;
      const x = prev.x + Math.cos(ang) * DELTA_STEP_M;
      const z = prev.z + Math.sin(ang) * DELTA_STEP_M;
      run += DELTA_STEP_M;
      br.push({
        x, z,
        // 分流は本流より浅い。流れが分かれたぶん運ぶ力が落ちて、沖ほど埋まっていく。
        //
        // 深さは中州の広さを直接決める。谷の斜面が0.03なので、川床が12m深いと
        // 水面まで戻るのに水路の縁から400m要る。分流の間隔が狭いところでは
        // それが足りず、中州が海面下0.2mに沈んでいた（ターンオル川）。
        // 沖ほど浅くすると、あいだの中州が河口の近くから顔を出す。
        bedH: end.bedH + (-RIVER_MOUTH_SEA_DEPTH_M * DELTA_BRANCH_DEPTH - end.bedH)
          * worldSmooth01(run / (DELTA_STEP_M * 2)),
        // 流れが分かれるぶん、1本の幅は本流より細い。
        // ゆっくり細らせると河口のすぐ先で3本が重なって1本の広い水路になり、
        // 中州が出ないので、最初の3分の1で細りきらせる。
        halfWidth: end.halfWidth
          + (width - end.halfWidth) * worldSmooth01((run / DELTA_REACH_M) * 2.8),
      });
      // 素の地形が海面下に落ちたら、そこから先は海。もう掘る必要はない
      if (run >= DELTA_REACH_M * 0.5 && worldBaseHeightAt(x, z) < -3) break;
    }
    if (run > longest) longest = run;
    out.push(br);
  }

  // 堆積（中州）の広がりを、実際に歩いた長さに合わせる
  const d = WORLD_DELTAS.find((v) => v.river === r.id);
  if (d) d.reach = longest * 1.15;
  return out;
}

// ============================================================================
// 山の名前と標高
//
// 山脈は稜線を1本持っているので、その上を歩いて「峰」を拾う。
// ただし稜線の真上がいちばん高いとは限らない（リッジノイズが峰を少し脇へずらす）ので、
// 候補ごとに山登りで本当の頂へ寄せる。
//
// 峰は稜線1本に10〜18座あるが、全部に名前を付けると上空が札だらけになる。
// **突出度**（その峰から、より高い峰へ向かう途中でいちばん下がるところまでの落差）で
// 絞る。単に「高い順」だと、大きな山の肩が2位3位を占めて名前が固まってしまう。
// ============================================================================

const WORLD_PEAKS = [];

const PEAK_WALK_SAMPLES = 300;      // 稜線を何点で歩くか
// 各点で稜線に直交する向きへ振る幅と刻み。
// **短軸半径に対する割合にしてはいけない。** アストラ大山脈の短軸半径は210kmもあるので、
// 割合(0.45)で9点に振ると刻みが23.6kmになり、稜線から5.2km外れた世界最高地点を
// またいで素通りする（実際に取り逃がして、いちばん高い山に名前が付かなかった）。
// 峰は稜線のすぐ脇にあるので、絶対値で細かく振る。
const PEAK_LATERAL_REACH_M = 12000;
const PEAK_LATERAL_STEP_M = 1500;
const PEAK_MIN_PROMINENCE_M = 260;  // これ未満の突出度は「肩」とみなして名前を付けない
const PEAK_MIN_GAP_M = 22000;       // 峰どうしがこれより近ければ低いほうを捨てる
const PEAK_MAX_PER_RANGE = 6;

// 候補の近くで本当の頂を探す（粗い格子だと尾根の肩を拾ってしまう）
function worldClimbToSummit(x, z) {
  let bx = x, bz = z, bh = worldHeightAt(x, z);
  let step = 1600;
  for (let pass = 0; pass < 7; pass++) {
    for (let guard = 0; guard < 40; guard++) {
      let moved = false;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const nx = bx + Math.cos(a) * step, nz = bz + Math.sin(a) * step;
        const nh = worldHeightAt(nx, nz);
        if (nh > bh) { bx = nx; bz = nz; bh = nh; moved = true; }
      }
      if (!moved) break;
    }
    step *= 0.5;
  }
  return { x: bx, z: bz, h: bh };
}

function worldGeneratePeaks() {
  WORLD_PEAKS.length = 0;
  const usedNames = new Set();

  for (const range of WORLD_RANGES) {
    const rand = worldRng('peak:' + range.nameLatin);
    const country = worldCountryById(worldNearestCountryId(range.cx, range.cz));
    const style = country ? country.nameStyle : 'vestarian';

    // 1) 稜線を歩いて高さの列を取る。
    //    **稜線の真上だけを見てはいけない。** リッジノイズが峰を脇へずらすので、
    //    線の上だけだと最高峰を取り逃がす（実際、世界の最高地点4,708.8mは
    //    稜線から7.5km外れていて、名前が付かなかった）。
    //    各点で横方向にも振って、その断面でいちばん高いところを拾う。
    const pts = [], hs = [];
    const cosR = Math.cos((range.rot || 0) * Math.PI / 180);
    const sinR = Math.sin((range.rot || 0) * Math.PI / 180);
    // 稜線に直交する向き（worldRangeHeightAt の v 方向）
    const nx = range._swap ? cosR : -sinR;
    const nz = range._swap ? sinR : cosR;
    for (let i = 0; i <= PEAK_WALK_SAMPLES; i++) {
      const t = -0.9 + (1.8 * i) / PEAK_WALK_SAMPLES;
      const c = worldRangeCrestAt(range, t);
      let best = { x: c.x, z: c.z }, bh = -Infinity;
      const kMax = Math.round(PEAK_LATERAL_REACH_M / PEAK_LATERAL_STEP_M);
      for (let k = -kMax; k <= kMax; k++) {
        const o = k * PEAK_LATERAL_STEP_M;
        const x = c.x + nx * o, z = c.z + nz * o;
        const h = worldHeightAt(x, z);
        if (h > bh) { bh = h; best = { x, z }; }
      }
      pts.push(best);
      hs.push(bh);
    }

    // 2) 局所最大を拾う
    const cands = [];
    for (let i = 3; i < hs.length - 3; i++) {
      if (hs[i] < hs[i - 1] || hs[i] < hs[i + 1]) continue;
      if (hs[i] < hs[i - 3] || hs[i] < hs[i + 3]) continue;
      cands.push(i);
    }

    // 3) 突出度：より高い峰へ向かう途中の最低点までの落差。
    //    左右それぞれで「自分より高いところ」に当たるまで下がった最低点を見て、
    //    浅いほうを採る（＝どちらか一方でも大きく下がらなければ、それはただの肩）。
    const scored = cands.map((i) => {
      let lo = hs[i];
      for (let j = i - 1; j >= 0; j--) {
        if (hs[j] > hs[i]) break;
        if (hs[j] < lo) lo = hs[j];
      }
      let lo2 = hs[i];
      for (let j = i + 1; j < hs.length; j++) {
        if (hs[j] > hs[i]) break;
        if (hs[j] < lo2) lo2 = hs[j];
      }
      return { i, h: hs[i], prominence: hs[i] - Math.max(lo, lo2) };
    });
    scored.sort((a, b) => b.prominence - a.prominence);

    // 4) 突出度が足りるものから、離れている順に採る
    const taken = [];
    for (const c of scored) {
      if (taken.length >= PEAK_MAX_PER_RANGE) break;
      if (c.prominence < PEAK_MIN_PROMINENCE_M) continue;
      const p = pts[c.i];
      let tooClose = false;
      for (const t of taken) {
        if (Math.hypot(t.x - p.x, t.z - p.z) < PEAK_MIN_GAP_M) { tooClose = true; break; }
      }
      if (tooClose) continue;
      const top = worldClimbToSummit(p.x, p.z);
      if (top.h < 400) continue;   // 海際まで下りた稜線の端は山と呼ばない
      taken.push({ x: top.x, z: top.z, h: top.h, prominence: c.prominence });
    }

    // 5) 高い順に名前を付ける（いちばん高い山がいちばん良い名前、という気分の問題ではなく、
    //    生成が決定論的である以上どこかで順序を決めないといけないので、高さで決める）
    taken.sort((a, b) => b.h - a.h);
    for (const t of taken) {
      const nm = worldMakePlaceName(style, rand, usedNames);
      WORLD_PEAKS.push({
        id: 'peak-' + range.nameLatin.toLowerCase().replace(/\s+/g, '') + '-'
          + nm.nameLatin.toLowerCase(),
        name: nm.name + '山',
        nameLatin: 'Mt. ' + nm.nameLatin,
        range: range.nameLatin,
        x: Math.round(t.x), z: Math.round(t.z),
        elevationM: Math.round(t.h),
        prominenceM: Math.round(t.prominence),
      });
    }
  }
  WORLD_PEAKS.sort((a, b) => b.elevationM - a.elevationM);
}

// ============================================================================
// 道路
// 街と街、街と空港を結ぶ。
//
// 直線で結ぶと山も川も突っ切る。実際の道路は谷を選んで登り坂を避けるので、
// 傾斜と水にコストを付けた経路探索（A*）で引く。
// 地形は刻まない——道路の幅は26mで、いちばん細かいLODでも頂点間隔が312mある。
// 刻んでも再現できないので、地形メッシュの上に帯を敷く（滑走路の路面標識と同じ扱い）。
// ============================================================================

const WORLD_ROADS = [];

const ROAD_CELL_M = 3500;           // 経路探索の格子
const ROAD_CORRIDOR_FRAC = 0.40;    // 直線からどれだけ外へ出てよいか（距離に対する割合）
const ROAD_CORRIDOR_MIN_M = 17500;
// 傾斜1.0（45°）の道は、平地の何倍の「長さ」とみなすか。
// 大きいほど遠回りしてでも谷を選ぶ。
const ROAD_SLOPE_COST = 26;
// 水の上を通るときの倍率（＝橋）。渡らせないのではなく、なるべく短く渡らせる。
const ROAD_WATER_COST = 5;
const ROAD_MAX_LINK_M = 260000;     // これより遠い街どうしは結ばない
// 橋で渡せる長さの上限。これを超えて海の上を連続するなら、道ではなく航路。
const ROAD_MAX_SEA_M = 2500;
// 空港の舗装（滑走路・誘導路・エプロン）の外側にとる余裕
const ROAD_AIRPORT_MARGIN_M = 120;
// 空港の舗装を通るときの倍率。水（5倍）よりずっと重くして、事実上の通行止めにする
const ROAD_AIRPORT_COST = 400;
// 空港の取り付き点を、車寄せからどれだけ手前に置くか（ここまではA*、ここからは直線）
const ROAD_AIRPORT_APPROACH_M = 2600;
// 経路探索のときだけ空港の判定を広げる量（Chaikinの角落としで内側へ寄るぶん）
const ROAD_AIRPORT_SEARCH_PAD_M = 700;
const ROAD_HALF_WIDTH_M = 13;
const ROAD_SPUR_HALF_WIDTH_M = 9;   // 空港へ行く支線は細い

// 2点を結ぶ道の経路を探す。見つからなければ null。
//
// 世界ぜんぶを格子にすると3,000km四方ぶんの高さを取ることになるので、
// 「2点を結ぶ直線のまわりの帯（回廊）」だけを格子にして、そこから出さない。
// 回廊の幅は距離に比例させる——短い道は大きく迂回しないし、
// 長い道は山脈をよけるだけの余地が要る。
function worldRouteRoad(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < ROAD_CELL_M) return null;

  const ux = dx / L, uz = dz / L;      // 進行方向
  const px = -uz, pz = ux;             // 横方向
  const halfW = Math.max(ROAD_CORRIDOR_MIN_M, L * ROAD_CORRIDOR_FRAC);
  const nU = Math.max(2, Math.round(L / ROAD_CELL_M));
  const nV = Math.max(1, Math.round(halfW / ROAD_CELL_M));
  const stepU = L / nU, stepV = ROAD_CELL_M;
  const cols = nU + 1, rows = 2 * nV + 1;

  const at = (i, j) => i * rows + (j + nV);
  const posX = (i, j) => ax + ux * (i * stepU) + px * (j * stepV);
  const posZ = (i, j) => az + uz * (i * stepU) + pz * (j * stepV);

  // 高さと「水かどうか」を先に全部取る（A*の中で取ると同じ点を何度も測る）
  const h = new Float64Array(cols * rows);
  const wet = new Uint8Array(cols * rows);
  const blocked = new Uint8Array(cols * rows);
  for (let i = 0; i <= nU; i++) {
    for (let j = -nV; j <= nV; j++) {
      const x = posX(i, j), z = posZ(i, j);
      const k = at(i, j);
      const hh = worldHeightAt(x, z);
      h[k] = hh;
      // 格子の目は3.5kmあるので、幅300mの川は**点で測ると素通りしてしまう**。
      // 実測で、水の上を通る距離の9割点が直線の501mに対し探索した道は878mと、
      // 避けるどころか増えていた。格子点のまわりも見て、川を格子1つぶんの
      // 太さの障害物として扱う。ここは worldWaterSurfaceAt（格子引き）だけなので安い。
      let w = (hh <= 0 || worldWaterSurfaceAt(x, z) !== null) ? 1 : 0;
      if (!w) {
        const o = ROAD_CELL_M * 0.4;
        w = (worldWaterSurfaceAt(x + o, z) !== null || worldWaterSurfaceAt(x - o, z) !== null
          || worldWaterSurfaceAt(x, z + o) !== null || worldWaterSurfaceAt(x, z - o) !== null) ? 1 : 0;
      }
      wet[k] = w;

      // 空港の舗装の上は通さない。川と同じく、3.5kmの格子で点だけ見ると
      // 幅60mの滑走路を素通りするので、格子点のまわりも見る。
      const pad = ROAD_AIRPORT_SEARCH_PAD_M;
      let bl = worldAirportRoadBlock(x, z, pad);
      if (!bl) {
        const o = ROAD_CELL_M * 0.4;
        bl = (worldAirportRoadBlock(x + o, z, pad) || worldAirportRoadBlock(x - o, z, pad)
          || worldAirportRoadBlock(x, z + o, pad) || worldAirportRoadBlock(x, z - o, pad)) ? 1 : 0;
      }
      blocked[k] = bl;
    }
  }

  // A*。始点は (0,0)、終点は (nU,0)——街の中心そのものは動かせない。
  const g = new Float64Array(cols * rows).fill(Infinity);
  const from = new Int32Array(cols * rows).fill(-1);
  const done = new Uint8Array(cols * rows);
  const start = at(0, 0), goal = at(nU, 0);
  g[start] = 0;

  // 開いている点は少ない（せいぜい数千）ので、優先度付きキューではなく
  // 「未確定のうち f がいちばん小さいもの」を線形に探す。
  // 格子は 30×25 程度なので、これで十分速い。
  const open = [start];
  const fOf = (k) => g[k] + Math.abs(nU - ((k / rows) | 0)) * stepU;

  while (open.length) {
    let bi = 0;
    for (let t = 1; t < open.length; t++) if (fOf(open[t]) < fOf(open[bi])) bi = t;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (cur === goal) break;
    if (done[cur]) continue;
    done[cur] = 1;

    const ci = (cur / rows) | 0, cj = (cur % rows) - nV;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (di === 0 && dj === 0) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || ni > nU || nj < -nV || nj > nV) continue;
        const nk = at(ni, nj);
        if (done[nk]) continue;

        const segX = di * stepU * ux + dj * stepV * px;
        const segZ = di * stepU * uz + dj * stepV * pz;
        const seg = Math.hypot(segX, segZ);
        const slope = Math.abs(h[nk] - h[cur]) / seg;
        let cost = seg * (1 + slope * ROAD_SLOPE_COST);
        if (wet[nk] || wet[cur]) cost *= ROAD_WATER_COST;
        // 空港の舗装は「高い」のではなく「通れない」。迂回しようがないときだけ通る
        if (blocked[nk]) cost *= ROAD_AIRPORT_COST;

        const ng = g[cur] + cost;
        if (ng < g[nk]) { g[nk] = ng; from[nk] = cur; open.push(nk); }
      }
    }
  }

  if (from[goal] < 0 && goal !== start) return null;

  const cells = [];
  for (let k = goal; k >= 0; k = from[k]) {
    cells.push(k);
    if (k === start) break;
  }
  cells.reverse();
  if (cells[0] !== start) return null;

  const raw = cells.map((k) => {
    const i = (k / rows) | 0, j = (k % rows) - nV;
    return { x: posX(i, j), z: posZ(i, j) };
  });
  // 8方向の折れ線なので角を落とす（川と同じ Chaikin）
  return worldChaikinPath(raw, 2);
}

// tail を渡すと、経路のあとにその点列をそのままつなぐ（空港の取り付き〜車寄せなど、
// A* に任せず必ずまっすぐ通したい区間に使う）。
function worldAddRoad(id, ax, az, bx, bz, halfWidth, kind, tail) {
  const pts = worldRouteRoad(ax, az, bx, bz);
  if (!pts || pts.length < 2) return null;
  if (tail) {
    // 取り付き点は経路の終点と同じ場所なので重複を避ける
    for (let i = 1; i < tail.length; i++) pts.push({ x: tail[i].x, z: tail[i].z });
  }

  // **海をまたぐ道は引かない。** 全域木は陸か海かを見ずに街を結ぶので、
  // 島がいくつもある国（セラフィナ諸島など）では海の上に道ができる。
  // 実測で 156km・117km・111km を海の上で渡る道があった。
  // 川を渡る橋（世界ぜんぶで18km）は残したいので、連続して水の上にいる距離で切る。
  let len = 0, run = 0, longestRun = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    len += d;
    if (worldHeightAt(b.x, b.z) <= 0) {
      run += d;
      if (run > longestRun) longestRun = run;
    } else run = 0;
  }
  if (longestRun > ROAD_MAX_SEA_M) return null;

  const road = { id, points: pts, lengthM: len, halfWidth, kind, longestSeaM: longestRun };
  WORLD_ROADS.push(road);
  return road;
}

function worldGenerateRoads() {
  WORLD_ROADS.length = 0;

  for (const country of WORLD_COUNTRIES) {
    const cities = WORLD_CITIES.filter((c) => c.country === country.id);
    if (cities.length < 2) continue;

    // 1) 最小全域木（プリム法）で、まず国内の街をひとつながりにする＝幹線。
    //    「近い順に何本か引く」だと孤立した街が残るが、全域木なら必ず全部つながる。
    const inTree = new Array(cities.length).fill(false);
    inTree[0] = true;
    const edges = [];
    for (let n = 1; n < cities.length; n++) {
      let bd = Infinity, ba = -1, bb = -1;
      for (let a = 0; a < cities.length; a++) {
        if (!inTree[a]) continue;
        for (let b = 0; b < cities.length; b++) {
          if (inTree[b]) continue;
          const d = Math.hypot(cities[a].x - cities[b].x, cities[a].z - cities[b].z);
          if (d < bd) { bd = d; ba = a; bb = b; }
        }
      }
      if (bb < 0) break;
      inTree[bb] = true;
      if (bd <= ROAD_MAX_LINK_M) edges.push([ba, bb]);
    }

    // 2) 木のままだと必ず行き止まりの枝分かれになって、上空から「網」に見えない。
    //    近いのに木の上では遠回りになる組を足して、環を作る。
    const adj = cities.map(() => []);
    for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
    const extra = [];
    for (let a = 0; a < cities.length; a++) {
      for (let b = a + 1; b < cities.length; b++) {
        if (adj[a].indexOf(b) >= 0) continue;
        const d = Math.hypot(cities[a].x - cities[b].x, cities[a].z - cities[b].z);
        if (d > ROAD_MAX_LINK_M * 0.5) continue;
        // 木をたどった距離が直線の2.2倍を超えるなら、近道を1本引く価値がある
        const hops = worldGraphDistance(cities, adj, a, b);
        if (hops > d * 2.2) extra.push([a, b, d]);
      }
    }
    extra.sort((p, q) => p[2] - q[2]);
    for (const [a, b] of extra.slice(0, Math.max(1, Math.round(cities.length * 0.25)))) {
      edges.push([a, b]);
      adj[a].push(b); adj[b].push(a);
    }

    for (const [a, b] of edges) {
      const ca = cities[a], cb = cities[b];
      worldAddRoad('road-' + ca.id + '-' + cb.id, ca.x, ca.z, cb.x, cb.z,
        ROAD_HALF_WIDTH_M, 'trunk');
    }
  }

  // 3) 空港はどれも街から13〜33km離れているので、親の街から支線を引く。
  //    **終点は空港の中心ではなくターミナルの車寄せ。** 中心を終点にしていたので、
  //    72本すべてが滑走路のど真ん中に着いていた（実測で滑走路との距離0m）。
  for (const a of WORLD_AIRPORTS) {
    const c = worldCityById(a.city);
    if (!c) continue;
    // 車寄せへ直接A*を走らせると、格子の目が3.5kmあるせいで最後の詰めが利かず、
    // 舗装の上を通ってから着いてしまう（実測で32本が舗装にかかった）。
    // **陸側に取り付き点を置いて、そこから車寄せまではまっすぐ**入れる。
    // 取り付き点はターミナルの正面（ローカル +Z 方向）なので、滑走路は絶対にまたがない。
    const via = airportLocalToWorld(a, a.terminalLocalX, a.gateLocalZ + ROAD_AIRPORT_APPROACH_M);
    const gate = worldAirportGateAt(a);
    worldAddRoad('road-' + a.id, c.x, c.z, via.x, via.z, ROAD_SPUR_HALF_WIDTH_M, 'spur',
      [via, gate]);
  }
}

// その地点が、どこかの空港の「舗装のある側」にどれだけ食い込んでいるか（0〜1）。
// 滑走路・誘導路・エプロンの上に道路を通さないために使う。
// 1 を返すところは通行止め、0 なら自由。
// extra を足すと判定を広げられる。経路探索では広めに見て避けさせ、
// 「実際に舗装に乗っているか」の検証では素の値で見る——Chaikinで角を落とすと
// 経路が内側へ寄るので、探索時だけ余裕を持たせないと縁をかすめる。
function worldAirportRoadBlock(x, z, extra) {
  if (!_worldAirportGrid) return 0;
  const pad = extra || 0;
  const aps = _worldAirportGrid.at(x, z);
  if (!aps) return 0;
  let worst = 0;
  for (let i = 0; i < aps.length; i++) {
    const a = aps[i];
    const t = ((90 - a.headingDeg) * Math.PI) / 180;
    const c = Math.cos(t), s = Math.sin(t);
    const dx = x - a.x, dz = z - a.z;
    // 世界→ローカル（airportLocalToWorld の逆）
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    // 滑走路の並び＋誘導路・エプロンが載っている帯。長さ方向は滑走路の全長＋余裕。
    const halfLen = a.maxRunwayLengthM * 0.5 + ROAD_AIRPORT_MARGIN_M + pad;
    // ターミナル側（+Z）は車寄せの手前まで、反対側（−Z）は滑走路の縁まで
    const spanPlus = a.terminalLocalZ - 60;
    const spanMinus = airportRunwayHalfSpan(a) + a.runwayWidthM + ROAD_AIRPORT_MARGIN_M + pad;
    if (lx < -halfLen || lx > halfLen) continue;
    if (lz > spanPlus || lz < -spanMinus) continue;
    if (worst < 1) worst = 1;
  }
  return worst;
}

// 木の上での2点間の距離（辺の長さの合計）。近道を足すかどうかの判断に使う。
function worldGraphDistance(cities, adj, from, to) {
  const dist = new Array(cities.length).fill(Infinity);
  dist[from] = 0;
  const seen = new Array(cities.length).fill(false);
  for (;;) {
    let cur = -1, best = Infinity;
    for (let i = 0; i < cities.length; i++) {
      if (!seen[i] && dist[i] < best) { best = dist[i]; cur = i; }
    }
    if (cur < 0 || cur === to) break;
    seen[cur] = true;
    for (const n of adj[cur]) {
      const d = dist[cur] + Math.hypot(cities[cur].x - cities[n].x, cities[cur].z - cities[n].z);
      if (d < dist[n]) dist[n] = d;
    }
  }
  return dist[to];
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
        const surface = s.ah + (s.bh - s.ah) * _worldSegT.t + RIVER_WATER_DEPTH_M;
        // 河口は川床が海面下まで落ちている。そこは川ではなく海なので、
        // 海面より低い「川の水面」は返さない（呼ぶ側は海を別に見ている）。
        if (surface <= 0) return null;
        return surface;
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
  WORLD_RANGES.forEach(worldPrepRange);

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

  // 5) 河口の形（入り江か三角州か）を決めてから、川の幅・川床・分流を作る
  worldShapeRiverMouths();
  worldBuildRiverGrid();

  // 6) 街と空港が海岸線ノイズで沈まないようアンカーを張る
  WORLD_LAND_ANCHORS.length = 0;
  for (const a of WORLD_AIRPORTS) {
    WORLD_LAND_ANCHORS.push({ x: a.x, z: a.z, r: Math.max(a.flatOuterR * 1.5, 22000) });
  }
  for (const c of WORLD_CITIES) {
    WORLD_LAND_ANCHORS.push({ x: c.x, z: c.z, r: 12000 + c.size * 20000 });
  }
  _worldAnchorGrid = makeWorldGrid(40000);
  for (const a of WORLD_LAND_ANCHORS) _worldAnchorGrid.insert(a.x, a.z, a.r, a);

  // 7) 街の基準標高を「街を均す前の地形」から取ってから、街の均しを有効にする
  _worldCityGrid = makeWorldGrid(40000);
  for (const c of WORLD_CITIES) {
    c.groundY = worldHeightAt(c.x, c.z);
    _worldCityGrid.insert(c.x, c.z, c.flatOuterR, c);
  }
  _worldCitiesReady = true;

  // 8) 湖と川の刻み込みを有効にする（街の均しのあと、空港の均しの前）
  _worldWaterReady = true;

  // 9) 空港の均しを有効にする（滑走路の平面が最後に勝つ）
  _worldAirportGrid = makeWorldGrid(40000);
  for (const a of WORLD_AIRPORTS) _worldAirportGrid.insert(a.x, a.z, a.flatOuterR, a);
  _worldAirportsReady = true;

  // 10) 山の名前と標高。稜線の上を歩いて峰を拾うので、地形が出来上がってから。
  worldGeneratePeaks();

  // 11) 道路。**いちばん最後**に引く。経路は「出来上がった地形」の上で探さないと、
  //     川の谷も空港の平地も見えないまま山と川を突っ切る道になる。
  worldGenerateRoads();

  _worldReady = true;
}

// Node（検証スクリプト）から読めるようにしておく。ブラウザでは module が無いので何もしない。
if (typeof module !== 'undefined' && module.exports) {
  initWorld();
  module.exports = {
    WORLD_SEED, WORLD_SIZE, WORLD_HALF,
    WORLD_LANDMASSES, WORLD_RANGES, WORLD_COUNTRIES, WORLD_CITIES, WORLD_AIRPORTS,
    WORLD_LAKES, WORLD_RIVERS, WORLD_DELTAS, WORLD_ROADS, WORLD_PEAKS,
    worldLakeAt, worldRiverAt, worldWaterSurfaceAt,
    CITY_FLATTEN_STRENGTH, RIVER_VALLEY_SLOPE, RIVER_BED_OFFSET_M, RIVER_WATER_DEPTH_M,
    worldClamp, worldSmooth01, worldValueNoise, worldFbm,
    initWorld, worldHeightAt, worldBaseHeightAt, worldLandValueAt, worldUrbanFactorAt,
    worldTemperatureAt, worldDrynessAt, worldForestDensity, worldWeatherFieldAt, worldLocalReliefAt,
    worldNearestAirport, worldRegionAt, worldCountryById, worldCityById, worldAirportById,
    worldRangeCrestAt, worldRangeHeightAt, worldCityStreetDist,
    airportLocalToWorld, airportRunwayHalfSpan, worldAirportGateAt, worldAirportRoadBlock,
    worldAirportRunwayCenter,
    CITY_STREET_HALF_W_M, CITY_STREET_CLEAR_M,
  };
}
