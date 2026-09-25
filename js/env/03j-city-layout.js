// 03j-city-layout.js — 街の形（街路網と建物の並べ方）
//
// 以前は130都市すべてが碁盤の目だった（街ごとに違うのは向きと街区の大きさだけ）。
// 建物は街区の中へ押し込むだけで、向きは世界の軸のまま——斜めの碁盤の目の街では、
// 建物だけが北を向いて並んでいた。
//
// ここでは街ごとに街路の「型」を選び、街路を折れ線の集まりとして作る。建物は
// いちばん近い街路に面して、その街路の向きに揃えて建てる。型の選び方・建物の色・
// 高さの傾向は国ごとに変える（CITY_COUNTRY_STYLE）。
//
//   grid   … 碁盤の目（計画都市）。4本に1本は広い大通り
//   warped … 碁盤の目を大きくうねらせたもの（地形なりに育った街）
//   radial … 環状道路と放射道路（中心に広場のある古い都）
//   core   … 中心だけ環状＋放射の旧市街、その外は碁盤の目の新市街
//   medina … 細い路地が曲がりくねって、ところどころ行き止まる旧市街
//
// 形はすべて街のIDから決まる乱数で作るので、何度読み込んでも同じ街になる。
// THREE.js には依存しない（Node の tools/verify-world.js からも読む）。
// 座標は街の中心からの相対位置（x が東、z が南、単位 m）。

const _CL_WORLD = (typeof module !== 'undefined' && module.exports) ? require('./03b-world.js') : null;
const clRng = _CL_WORLD ? _CL_WORLD.worldRng : worldRng;
const clFbm = _CL_WORLD ? _CL_WORLD.worldFbm : worldFbm;
const clTemperatureAt = _CL_WORLD ? _CL_WORLD.worldTemperatureAt : worldTemperatureAt;
const clDrynessAt = _CL_WORLD ? _CL_WORLD.worldDrynessAt : worldDrynessAt;
const clLandValueAt = _CL_WORLD ? _CL_WORLD.worldLandValueAt : worldLandValueAt;

// 街路の半幅（ふつう・大通り・路地）と、建物を街路から離す余白。
// 余白が0だと、建物の角が舗装にかぶって街路が途切れて見える。
const CL_STREET_HALF_W = 7;
const CL_MAJOR_HALF_W = 10;
const CL_LANE_HALF_W = 4.5;
const CL_STREET_CLEAR = 4;
// 折れ線の点の間隔。まっすぐな街路は粗く、曲がる街路は細かく
const CL_STEP_STRAIGHT = 90;
const CL_STEP_CURVED = 55;
// これより短い切れ端の街路は捨てる
const CL_MIN_RUN_M = 70;

// 国ごとの街の性格。layouts は型の重み、palette は建物の色（出力がsRGBで明るく
// 持ち上がるぶん、見た目より一段暗い値）、height は建物の高さの倍率、density は軒数の倍率。
const CITY_COUNTRY_STYLE = {
  vestaria: { layouts: { grid: 3, core: 2, warped: 1 }, height: 1.0, density: 1.0,
    palette: [0x43413c, 0x4b4740, 0x3f4247, 0x504a43, 0x3a3d41] },
  nordheim: { layouts: { warped: 3, core: 2, radial: 1 }, height: 0.75, density: 0.95,
    palette: [0x4a3530, 0x3c3f44, 0x57493b, 0x40362f, 0x4d4f52] },
  borealis: { layouts: { grid: 2, warped: 2 }, height: 0.7, density: 0.85,
    palette: [0x484c52, 0x3d4146, 0x55504a, 0x4a3f38] },
  astra: { layouts: { radial: 3, core: 2, grid: 1 }, height: 1.1, density: 1.05,
    palette: [0x4f4a42, 0x58524a, 0x46423d, 0x5c5549, 0x3f3c38] },
  kaldis: { layouts: { medina: 3, core: 1, warped: 1 }, height: 0.6, density: 1.15,
    palette: [0x5e5242, 0x66584a, 0x564a3b, 0x6b5e4c, 0x4f4538] },
  oriens: { layouts: { grid: 3, warped: 1 }, height: 1.25, density: 1.1,
    palette: [0x45474a, 0x3d3f43, 0x4f4f4d, 0x38393d, 0x505254] },
  meridia: { layouts: { core: 2, radial: 2, warped: 1 }, height: 0.85, density: 1.0,
    palette: [0x5d4638, 0x645a4c, 0x584033, 0x6a6255, 0x4e3d33] },
  thalassia: { layouts: { warped: 2, medina: 1, core: 1 }, height: 0.8, density: 1.0,
    palette: [0x676259, 0x5f5646, 0x6e695e, 0x544a3c, 0x625a4b] },
  serafina: { layouts: { warped: 2, medina: 1 }, height: 0.7, density: 0.9,
    palette: [0x5f5a4e, 0x55605a, 0x645848, 0x5a5160] },
  xanadu: { layouts: { grid: 2, warped: 1, radial: 1 }, height: 1.0, density: 1.0,
    palette: [0x4d4a42, 0x55524a, 0x46443f, 0x5a5448] },
};
const CITY_DEFAULT_STYLE = CITY_COUNTRY_STYLE.vestaria;

function cityStyleOf(city) {
  return CITY_COUNTRY_STYLE[city.country] || CITY_DEFAULT_STYLE;
}

// 街の型を選ぶ（首都は環状＋放射の古い都になりやすい）
function cityLayoutOf(city) {
  if (city._layout) return city._layout;
  const style = cityStyleOf(city);
  const rand = clRng('layout:' + city.id);
  const w = Object.assign({}, style.layouts);
  if (city.capital) { w.radial = (w.radial || 0) + 2; w.core = (w.core || 0) + 1; }
  // とても小さな街に環状道路は似合わない
  if (city.builtRadiusM < 1200) { w.grid = (w.grid || 0) + (w.radial || 0); w.radial = 0; }
  let total = 0;
  for (const k in w) total += w[k];
  let r = rand() * total, type = 'grid';
  for (const k in w) { r -= w[k]; if (r <= 0) { type = k; break; } }
  city._layout = { type, style };
  return city._layout;
}

// --- 街の性格（規模・山あい・気候・名所） -----------------------------------
//
// 以前はどの街も「大きさの違う同じ街」だった（違うのは街路の型と国ごとの色・高さだけ）。
// 街ごとに次の3つを決め、建物の形・高さ・屋根と、街の真ん中の名所を変える。
//   規模 … town（町・村）/ city（市）/ metro（大都市）/ megalopolis（首都級の巨大都市）
//          町は2〜3階の家が並び、大都市は中心に高層ビル、巨大都市は超高層の摩天楼と展望塔
//   山あい … 標高 CITY_HIGHLAND_M 以上の街。低く、屋根は急、建物はまばらで石の色
//   気候 … 寒冷（急な切妻屋根）/ 温帯（切妻と寄棟）/ 乾燥（平屋根と丸屋根）/ 熱帯（軒の深い寄棟・白と淡い色）
// 名所は国の性格で決める（尖塔の教会・丸屋根・丸屋根と尖塔（ミナレット）・五重塔・鐘楼）。
const CITY_HIGHLAND_M = 900;
const CITY_TIERS = [
  { id: 'town', maxSize: 0.3 },
  { id: 'city', maxSize: 0.6 },
  { id: 'metro', maxSize: 0.85 },
  { id: 'megalopolis', maxSize: Infinity },
];
const CITY_LANDMARK_BY_COUNTRY = {
  vestaria: 'spire', nordheim: 'spire', borealis: 'spire', astra: 'dome',
  kaldis: 'minarets', oriens: 'pagoda', meridia: 'campanile', thalassia: 'campanile',
  serafina: 'campanile', xanadu: 'dome',
};
// 屋根の色（気候ごと）。壁は国の palette。出力が sRGB で明るく持ち上がるので、
// 赤瓦も濃いめに置く（淡い値だと空から桃色に見えた）
const CITY_ROOF_COLORS = {
  cold: [0x2e1e1c, 0x262a2e, 0x3d201a, 0x22302a],
  temperate: [0x5a2a1e, 0x66301f, 0x3e3d3c, 0x4d3528],
  arid: [0x7d6c55, 0x6e5f4a],
  tropical: [0x6e3822, 0x4a5648, 0x7a5236, 0x3e4a54],
};
// 熱帯・乾燥の街は壁を明るく（白壁・漆喰）。国の palette にこれを混ぜる
const CITY_BRIGHT_WALLS = { arid: [0x8c8574, 0x958b76, 0x7f7866], tropical: [0x8e8a80, 0x7f8a86, 0x8f8272, 0x86808c] };
// 家の壁は国の palette（中層ビル向けの暗い色）をこの色へ寄せる。暗い壁に淡い屋根で、明暗が逆に見えた
const CITY_HOUSE_WALL_LIGHT = 0xb0a898;
const CITY_HOUSE_WALL_MIX = 0.6;
// 高層ビルの外装。乾燥の街は石と砂の色、ほかはガラス（熱帯は明るめ）
const CITY_TOWER_COLORS = {
  arid: [0x7a6e5a, 0x857a64, 0x6e6452, 0x8a806c],
  tropical: [0x5d6d78, 0x6a7a80, 0x7a8288, 0x5a6a66],
  other: [0x4a5a6a, 0x55626c, 0x5a6670, 0x46546a, 0x66707a, 0x566a64],
};

function clMixHex(a, b, t) {
  const ch = (sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

function cityCharacterOf(city) {
  if (city._character) return city._character;
  const tier = CITY_TIERS.find((t) => city.size < t.maxSize).id;
  const highland = (city.groundY || 0) >= CITY_HIGHLAND_M;
  const temp = clTemperatureAt(city.x, city.z, city.groundY || 0);
  const dry = clDrynessAt(city.x, city.z, clLandValueAt(city.x, city.z));
  const climate = temp < 0.22 ? 'cold' : (dry > 0.55 && temp > 0.45) ? 'arid'
    : (temp > 0.72 && dry < 0.45) ? 'tropical' : 'temperate';
  const landmark = CITY_LANDMARK_BY_COUNTRY[city.country] || 'spire';
  city._character = { tier, highland, climate, landmark, temp, dry };
  return city._character;
}

// --- 街の外周 ---------------------------------------------------------------

// 方位ごとの市街地の半径。円で切ると上空から見てコンパスで描いた円になるので、
// 周期の違う正弦を重ねてうねらせる（0.72〜1.0 R）。
function cityEdgeFn(city) {
  const rand = clRng('edge:' + city.id);
  const R = city.builtRadiusM;
  const p1 = rand() * 6.283, p2 = rand() * 6.283, p3 = rand() * 6.283;
  return (ang) => R * (0.86 + 0.14 * (0.5 * Math.sin(3 * ang + p1)
    + 0.3 * Math.sin(5 * ang + p2) + 0.2 * Math.sin(9 * ang + p3)));
}

// --- 街路の型 ----------------------------------------------------------------

// 直線を step おきの点列にする
function clLine(ax, az, bx, bz, step) {
  const L = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(L / step));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push({ x: ax + (bx - ax) * i / n, z: az + (bz - az) * i / n });
  return pts;
}

// 碁盤の目。angle の向きに、間隔 block で両方向に線を引く（半径 reach まで）。
// every 本に1本を大通りにする
function clGridLines(angle, block, reach, step, halfW, every) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const out = [];
  const kMax = Math.ceil(reach / block);
  for (const along of [true, false]) {
    for (let k = -kMax; k <= kMax; k++) {
      const off = k * block;
      const half = Math.sqrt(Math.max(0, reach * reach - off * off));
      if (half < CL_MIN_RUN_M) continue;
      // along: u 方向に走る線（v = off）
      const u0 = -half, u1 = half;
      const p = (u, v) => ({ x: u * c - v * s, z: u * s + v * c });
      const a = along ? p(u0, off) : p(off, u0);
      const b = along ? p(u1, off) : p(off, u1);
      const major = every > 0 && k % every === 0;
      out.push({ pts: clLine(a.x, a.z, b.x, b.z, step), halfW: major ? CL_MAJOR_HALF_W : halfW, major });
    }
  }
  return out;
}

// 半径 r の環
function clRing(r, major) {
  const n = Math.max(12, Math.ceil(2 * Math.PI * r / CL_STEP_CURVED));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return { pts, halfW: major ? CL_MAJOR_HALF_W : CL_STREET_HALF_W, major };
}

// 環状＋放射。環は ringStep おき、放射は外へ行くほど本数を倍にして街区が大きくなりすぎないようにする
function clRadialLines(reach, ringStep, block, rand) {
  const out = [];
  for (let k = 1; k * ringStep < reach; k++) out.push(clRing(k * ringStep, k % 3 === 0));
  // 放射。中心の広場（ringStep の半分）から外へ
  let n = 8 + Math.floor(rand() * 5);
  const phase = rand() * Math.PI * 2;
  let angles = [];
  for (let i = 0; i < n; i++) angles.push({ a: phase + (i / n) * Math.PI * 2, from: ringStep * 0.5, major: true });
  for (let k = 1; k * ringStep < reach; k++) {
    const r = k * ringStep;
    if (2 * Math.PI * r / n > block * 2.4) {
      const add = [];
      for (let i = 0; i < n; i++) add.push({ a: phase + ((i + 0.5) / n) * Math.PI * 2, from: r, major: false });
      angles = angles.concat(add);
      n *= 2;
    }
  }
  for (const ra of angles) {
    const c = Math.cos(ra.a), s = Math.sin(ra.a);
    out.push({
      pts: clLine(c * ra.from, s * ra.from, c * reach, s * reach, CL_STEP_CURVED),
      halfW: ra.major ? CL_MAJOR_HALF_W : CL_STREET_HALF_W, major: ra.major,
    });
  }
  return out;
}

// 街路網をうねらせる。すべての線に同じ変位の場を掛けるので、交差点はつながったまま
function clWarp(lines, amp, wavelength, seed) {
  const f = 1 / wavelength;
  const ox = seed * 17.3, oz = seed * 31.7;
  for (const l of lines) {
    for (const p of l.pts) {
      const dx = (clFbm(p.x * f + ox, p.z * f + oz, 3) - 0.5) * 2 * amp;
      const dz = (clFbm(p.x * f + oz + 5.1, p.z * f + ox + 9.7, 3) - 0.5) * 2 * amp;
      p.x += dx; p.z += dz;
    }
  }
  return lines;
}

// 線を交差点ごとの区間に切り、ところどころ捨てる（行き止まりの路地）
function clDropPieces(lines, pieceM, keep, rand) {
  const out = [];
  for (const l of lines) {
    if (l.major) { out.push(l); continue; }
    let cur = [l.pts[0]], run = 0;
    for (let i = 1; i < l.pts.length; i++) {
      run += Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].z - l.pts[i - 1].z);
      cur.push(l.pts[i]);
      if (run >= pieceM || i === l.pts.length - 1) {
        if (rand() < keep) out.push({ pts: cur, halfW: l.halfW, major: false });
        cur = [l.pts[i]]; run = 0;
      }
    }
  }
  return out;
}

// 折れ線を、keep(x, z) が真の区間ごとに切り分ける（短すぎる切れ端は捨てる）
function clClip(lines, keep) {
  const out = [];
  for (const l of lines) {
    let cur = [], len = 0;
    const flush = () => {
      if (cur.length >= 2 && len >= CL_MIN_RUN_M) out.push({ pts: cur, halfW: l.halfW, major: l.major });
      cur = []; len = 0;
    };
    for (const p of l.pts) {
      if (keep(p.x, p.z)) {
        if (cur.length) len += Math.hypot(p.x - cur[cur.length - 1].x, p.z - cur[cur.length - 1].z);
        cur.push(p);
      } else flush();
    }
    flush();
  }
  return out;
}

// --- 街路網 -----------------------------------------------------------------

// 街路網を作る（街ごとに1回。結果は city に持たせておく）。
//   streets … [{ pts: [{x, z}], halfW, major }]
function cityStreetNetwork(city) {
  if (city._streets) return city._streets;
  const L = cityLayoutOf(city);
  const rand = clRng('streets:' + city.id);
  const edge = cityEdgeFn(city);
  const R = city.builtRadiusM;
  const b = city.blockM;
  const A = city.streetAngle;
  const reach = R * 1.05;
  let lines;
  switch (L.type) {
    case 'warped':
      lines = clWarp(clGridLines(A, b, reach * 1.1, CL_STEP_CURVED, CL_STREET_HALF_W, 4),
        b * 0.38, b * 4.5, rand() * 100);
      break;
    case 'radial':
      lines = clWarp(clRadialLines(reach * 1.05, b * 1.45, b, rand), b * 0.14, b * 6, rand() * 100);
      break;
    case 'core': {
      const rc = R * (0.32 + rand() * 0.12);
      const inner = clClip(clRadialLines(rc * 1.02, b * 1.2, b, rand), (x, z) => Math.hypot(x, z) <= rc + 1);
      const ring = [clRing(rc, true)];
      const outer = clClip(clGridLines(A, b, reach, CL_STEP_STRAIGHT, CL_STREET_HALF_W, 4),
        (x, z) => Math.hypot(x, z) >= rc);
      lines = clWarp(inner.concat(ring), b * 0.12, b * 5, rand() * 100).concat(outer);
      break;
    }
    case 'medina': {
      const bm = b * 0.55;
      const grid = clGridLines(A, bm, reach * 1.1, CL_STEP_CURVED, CL_LANE_HALF_W, 0);
      // 街を通り抜ける広い道を2本だけ残す
      for (const l of grid) {
        if (l === grid[Math.floor(grid.length * 0.25)] || l === grid[Math.floor(grid.length * 0.75)]) {
          l.major = true; l.halfW = CL_STREET_HALF_W;
        }
      }
      lines = clWarp(clDropPieces(grid, bm, 0.65, rand), bm * 0.45, bm * 3.5, rand() * 100);
      break;
    }
    default:
      lines = clGridLines(A, b, reach, CL_STEP_STRAIGHT, CL_STREET_HALF_W, 4);
  }
  // 外周で切る
  const streets = clClip(lines, (x, z) => Math.hypot(x, z) <= edge(Math.atan2(z, x)));
  city._streets = { streets, edge, index: clIndexStreets(streets) };
  return city._streets;
}

// --- 街路の近さ -------------------------------------------------------------

const CL_CELL = 100;
function clKey(i, j) { return (i + 32768) * 65536 + (j + 32768); }

// 区間を格子に入れる。舗装の端から CL_STREET_CLEAR+1 m までにかかる升目すべてに入れるので、
// 「舗装から十分離れているか」はその点の升目1つを見れば分かる（cityStreetClearance）。
function clIndexStreets(streets) {
  const cells = new Map();
  streets.forEach((st) => {
    const pad = st.halfW + CL_STREET_CLEAR + 1;
    for (let i = 1; i < st.pts.length; i++) {
      const a = st.pts[i - 1], b = st.pts[i];
      const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, halfW: st.halfW };
      const i0 = Math.floor((Math.min(a.x, b.x) - pad) / CL_CELL), i1 = Math.floor((Math.max(a.x, b.x) + pad) / CL_CELL);
      const j0 = Math.floor((Math.min(a.z, b.z) - pad) / CL_CELL), j1 = Math.floor((Math.max(a.z, b.z) + pad) / CL_CELL);
      for (let ii = i0; ii <= i1; ii++) {
        for (let jj = j0; jj <= j1; jj++) {
          const k = clKey(ii, jj);
          let arr = cells.get(k);
          if (!arr) { arr = []; cells.set(k, arr); }
          arr.push(seg);
        }
      }
    }
  });
  return cells;
}

// いちばん近い街路（周り1升ぶん、およそ100m以内）。無ければ null。
//   d … 中心線からの距離、foot … 中心線上の最寄り点、tx/tz … 街路の向き、seg.halfW … 半幅
const _clNear = { d: 0, fx: 0, fz: 0, tx: 1, tz: 0, halfW: 0, clear: 0 };
function cityNearestStreet(net, x, z) {
  const ci = Math.floor(x / CL_CELL), cj = Math.floor(z / CL_CELL);
  let best = Infinity, bestClear = Infinity, found = false;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const arr = net.index.get(clKey(ci + di, cj + dj));
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const s = arr[k];
        const vx = s.bx - s.ax, vz = s.bz - s.az;
        const len2 = vx * vx + vz * vz || 1;
        let t = ((x - s.ax) * vx + (z - s.az) * vz) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const fx = s.ax + vx * t, fz = s.az + vz * t;
        const d = Math.hypot(x - fx, z - fz);
        const clear = d - s.halfW;
        if (clear < bestClear) bestClear = clear;
        if (d < best) {
          best = d; found = true;
          const len = Math.sqrt(len2);
          _clNear.d = d; _clNear.fx = fx; _clNear.fz = fz;
          _clNear.tx = vx / len; _clNear.tz = vz / len; _clNear.halfW = s.halfW;
        }
      }
    }
  }
  _clNear.clear = bestClear;
  return found ? _clNear : null;
}

// 街路の舗装の端からの距離。CL_STREET_CLEAR+1 m より遠いときは、正確な値ではなく
// それより大きい値（または Infinity）を返す
function cityStreetClearance(net, x, z) {
  const arr = net.index.get(clKey(Math.floor(x / CL_CELL), Math.floor(z / CL_CELL)));
  if (!arr) return Infinity;
  let best = Infinity;
  for (let k = 0; k < arr.length; k++) {
    const s = arr[k];
    const vx = s.bx - s.ax, vz = s.bz - s.az;
    const len2 = vx * vx + vz * vz || 1;
    let t = ((x - s.ax) * vx + (z - s.az) * vz) / len2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const dx = x - s.ax - vx * t, dz = z - s.az - vz * t;
    const clear = Math.sqrt(dx * dx + dz * dz) - s.halfW;
    if (clear < best) best = clear;
  }
  return best;
}

// --- 建物 -------------------------------------------------------------------

// 建てる予定の軒数。以前（全都市が碁盤の目）と同じ 240+size×1100 に、国ごとの倍率を掛ける。
// 路地の街は建物が小さい（間口8〜22m）ぶん、軒数を増やさないとまばらに見える。
// 山あいの街はまばらにする（斜面に貼りつく小さな町）
function cityBuildingTarget(city) {
  const L = cityLayoutOf(city);
  const ch = cityCharacterOf(city);
  return Math.round((240 + city.size * 1100) * L.style.density * (L.type === 'medina' ? 1.5 : 1)
    * (ch.highland ? 0.8 : 1));
}

// 建物の形。
//   house … 2〜3階の家（屋根は気候で切妻・寄棟・平屋根）
//   block … 中層の建物（平屋根。屋上に機械室を載せることがある）
//   tower … 高層ビル（段々に細くなり、いちばん高いものは尖塔を載せる）
// 町は家ばかり、市は中心が中層で外が家、大都市・巨大都市は中心に高層ビルが立つ。
const CITY_HOUSE_H = [6, 11];
const CITY_PLAZA_K = 2.4;
const CITY_TOWER_FROM_T = { metro: 0.24, megalopolis: 0.36 };   // 中心からこの割合の内側に高層ビル
const CITY_TOWER_P = { metro: 0.35, megalopolis: 0.6 };         // その範囲の建物が高層ビルになる確率
const CITY_TOWER_H = { metro: [55, 150], megalopolis: [80, 380] };

function cityRoofFor(ch, rand) {
  if (ch.climate === 'arid') return rand() < 0.85 ? 'flat' : 'hip';
  if (ch.climate === 'tropical') return rand() < 0.75 ? 'hip' : 'flat';
  if (ch.climate === 'cold' || ch.highland) return rand() < 0.85 ? 'gable' : 'hip';
  return rand() < 0.6 ? 'gable' : (rand() < 0.6 ? 'hip' : 'flat');
}

// 建物の並べ方。[{ x, z, w（間口・街路に沿う向き）, d（奥行き）, h, ang（街路の向き）, t（中心からの割合）, color,
//   kind（house/block/tower）, roof（gable/hip/flat）, roofH, roofColor, skin（高層ビルの外装）, spire }]
// 地面の高さと水の上かどうかは呼ぶ側で見る（ブラウザでは地形メッシュの高さを使うため）。
// 名所は cityLandmarks が別に返す（その場所には建物を建てない）。
function cityBuildingPlan(city) {
  const net = cityStreetNetwork(city);
  const L = cityLayoutOf(city);
  const ch = cityCharacterOf(city);
  const style = L.style;
  const medina = L.type === 'medina';
  const rand = clRng(city.id);
  // 形・屋根の乱数は配置の乱数とは別の列にする（配置は以前と同じ場所のまま）
  const krand = clRng('kind:' + city.id);
  const count = cityBuildingTarget(city);
  const marks = cityLandmarks(city);
  const walls = CITY_BRIGHT_WALLS[ch.climate] ? style.palette.concat(CITY_BRIGHT_WALLS[ch.climate]) : style.palette;
  const roofs = CITY_ROOF_COLORS[ch.climate];
  const towerFrom = ch.highland ? 0 : (CITY_TOWER_FROM_T[ch.tier] || 0);
  const out = [];
  let tallest = null;
  for (let i = 0; i < count; i++) {
    // 中心ほど密に（以前と同じ分布）
    const t = Math.pow(rand(), 0.65);
    const ang = rand() * Math.PI * 2;
    const dist = t * net.edge(ang);
    let x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    let w = medina ? 8 + rand() * 14 : 11 + rand() * 26;
    let d = medina ? 8 + rand() * 14 : 11 + rand() * 26;
    const hBase = (7 + rand() * 22) * (0.6 + city.size * 1.5) * (0.45 + (1 - t) * 1.5) * style.height;
    const color = walls[(rand() * walls.length) | 0];
    const setJitter = rand() * 6;

    // 形を決める
    let kind = 'block', h = medina ? Math.min(hBase, 16) : hBase;
    const outer = ch.tier === 'town' ? 0 : ch.tier === 'city' ? 0.5 : 0.62;
    if (t < towerFrom && krand() < CITY_TOWER_P[ch.tier]) {
      kind = 'tower';
      const [h0, h1] = CITY_TOWER_H[ch.tier];
      const k = krand();
      // 中心に近いほど高い。いちばん高い数本だけが上限近くまで伸びる
      h = (h0 + (h1 - h0) * k * k * k) * (1.15 - t / towerFrom * 0.5);
      w = Math.max(w, 26 + krand() * 22); d = Math.max(d, 26 + krand() * 22);
    } else if (t >= outer || ch.highland) {
      kind = 'house';
      h = CITY_HOUSE_H[0] + krand() * (CITY_HOUSE_H[1] - CITY_HOUSE_H[0]) * (ch.highland ? 0.7 : 1);
      if (!medina) { w = 9 + krand() * 9; d = 8 + krand() * 7; }
    } else if (ch.highland || ch.tier === 'town') {
      h = Math.min(h, 14);
    }
    const roof = kind === 'tower' ? 'flat' : kind === 'house' ? cityRoofFor(ch, krand) : (krand() < 0.2 ? cityRoofFor(ch, krand) : 'flat');
    const pitch = ch.climate === 'cold' || ch.highland ? 0.55 : ch.climate === 'tropical' ? 0.28 : 0.36;
    const roofColor = roofs[(krand() * roofs.length) | 0];
    const towers = CITY_TOWER_COLORS[ch.climate] || CITY_TOWER_COLORS.other;
    const skin = kind === 'tower' ? towers[(krand() * towers.length) | 0] : 0;
    const wall = kind === 'house' ? clMixHex(color, CITY_HOUSE_WALL_LIGHT, CITY_HOUSE_WALL_MIX) : color;

    // いちばん近い街路に面して、その向きに揃える。街区の奥にある（表の建物の
    // 奥行きより深い）ものは、その場所のまま向きだけ揃える（中庭側の建物）。
    const n = cityNearestStreet(net, x, z);
    let dirX = Math.cos(city.streetAngle), dirZ = Math.sin(city.streetAngle);
    if (n) {
      dirX = n.tx; dirZ = n.tz;
      const setback = n.halfW + CL_STREET_CLEAR + d * 0.5 + setJitter;
      if (n.d < setback + d) {
        // 街路のどちら側か
        const px = -n.tz, pz = n.tx;
        const side = ((x - n.fx) * px + (z - n.fz) * pz) >= 0 ? 1 : -1;
        x = n.fx + px * side * setback;
        z = n.fz + pz * side * setback;
      }
    }
    // 名所のまわりは広場にして建てない（敷地の半径の CITY_PLAZA_K 倍）。
    // 敷地ぶんだけ空けていたら、中心の中層ビルに囲まれて名所が埋もれて見えなかった
    if (marks.some((m) => Math.hypot(x - m.x, z - m.z) < m.r * (m.kind === 'tvtower' ? 1.5 : CITY_PLAZA_K) + Math.max(w, d) * 0.6)) continue;
    // 四隅がどの街路の舗装からも離れているか。かかるなら一回り小さくしてもう一度
    let ok = false;
    for (let tryN = 0; tryN < 2 && !ok; tryN++) {
      ok = clFootprintClear(net, x, z, w, d, dirX, dirZ);
      if (!ok) { w *= 0.65; d *= 0.65; }
    }
    if (!ok) continue;
    const bld = { x, z, w, d, h, ang: Math.atan2(dirZ, dirX), t, color: wall, skin, kind, roof,
      roofH: roof === 'flat' ? 0 : Math.min(w, d) * pitch, roofColor, spire: 0 };
    if (kind === 'tower' && (!tallest || h > tallest.h)) tallest = bld;
    out.push(bld);
  }
  // 巨大都市のいちばん高いビルには尖塔を載せる（街の顔）
  if (tallest && ch.tier === 'megalopolis') tallest.spire = tallest.h * 0.18;
  return out;
}

// 街の真ん中の名所。[{ kind, x, z, ang, r（敷地の半径）, h }]
//   spire … 尖塔の教会 / dome … 丸屋根の大聖堂 / minarets … 丸屋根と尖塔（ミナレット）
//   pagoda … 五重塔 / campanile … 鐘楼 / tvtower … 展望塔（巨大都市だけ。国によらない）
// 中心のそばで、舗装にかからない場所を探して置く（中心から外へ渦を巻いて探す）。
const CITY_LANDMARK_SIZE = {
  spire: { r: 26, h: 62 }, dome: { r: 34, h: 48 }, minarets: { r: 36, h: 58 },
  pagoda: { r: 16, h: 42 }, campanile: { r: 14, h: 58 }, tvtower: { r: 22, h: 360 },
};
function cityLandmarks(city) {
  if (city._landmarks) return city._landmarks;
  const net = cityStreetNetwork(city);
  const ch = cityCharacterOf(city);
  const rand = clRng('landmark:' + city.id);
  const want = [ch.landmark];
  if (ch.tier === 'megalopolis') want.push('tvtower');
  const out = [];
  const scale = ch.tier === 'town' ? 0.75 : ch.tier === 'city' ? 1 : 1.2;
  for (const kind of want) {
    const sz = CITY_LANDMARK_SIZE[kind];
    const r = sz.r * (kind === 'tvtower' ? 1 : scale);
    const h = sz.h * (kind === 'tvtower' ? 0.85 + rand() * 0.45 : scale);
    const start = kind === 'tvtower' ? city.builtRadiusM * 0.3 : 0;
    const a0 = rand() * Math.PI * 2;
    let placed = null;
    for (let k = 0; k < 400 && !placed; k++) {
      const rr = start + Math.sqrt(k) * 22;
      const a = a0 + k * 2.39996;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (out.some((m) => Math.hypot(x - m.x, z - m.z) < m.r + r + 20)) continue;
      const nb = cityNearestStreet(net, x, z);
      const ang = nb ? Math.atan2(nb.tz, nb.tx) : city.streetAngle;
      if (!clAreaClear(net, x, z, r)) continue;
      placed = { kind, x, z, ang, r, h };
    }
    if (placed) out.push(placed);
  }
  city._landmarks = out;
  return out;
}

// 半径 r の円の中が、どの街路の舗装からも CL_STREET_CLEAR 以上離れているか。
// 名所の敷地は建物より広く（直径30〜70m）、四隅と辺の中点だけ見ると、そのあいだを
// 街路が1本くぐり抜けていた（130都市のうち11か所）。8mより細かい格子で見る。
function clAreaClear(net, x, z, r) {
  const n = Math.max(2, Math.ceil(r / 8));
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const u = (i / n) * r, v = (j / n) * r;
      if (u * u + v * v > r * r * 1.02) continue;
      if (cityStreetClearance(net, x + u, z + v) < CL_STREET_CLEAR) return false;
    }
  }
  return true;
}

// 間口 w（向き dir）× 奥行き d の建物の中心と四隅が、どの街路の舗装からも CL_STREET_CLEAR 以上離れているか
function clFootprintClear(net, x, z, w, d, dirX, dirZ) {
  const px = -dirZ, pz = dirX;
  const hw = w * 0.5, hd = d * 0.5;
  const pts = [[0, 0], [hw, hd], [hw, -hd], [-hw, hd], [-hw, -hd], [hw, 0], [-hw, 0], [0, hd], [0, -hd]];
  for (const [a, b] of pts) {
    const cx = x + dirX * a + px * b, cz = z + dirZ * a + pz * b;
    if (cityStreetClearance(net, cx, cz) < CL_STREET_CLEAR) return false;
  }
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CITY_COUNTRY_STYLE, cityLayoutOf, cityStyleOf, cityStreetNetwork, cityNearestStreet,
    cityStreetClearance, cityBuildingPlan, cityBuildingTarget, cityEdgeFn,
    cityCharacterOf, cityLandmarks, CITY_HIGHLAND_M,
    CL_STREET_CLEAR, CL_STREET_HALF_W, CL_MAJOR_HALF_W, CL_LANE_HALF_W,
  };
}
