// gen-megalopolis.js — メガロポリス（都市群）の衛星都市と軸を一度だけ生成して、固定データの行を出す
//
//   node tools/gen-megalopolis.js
//
// 出力を js/env/03b-world.js の WORLD_CITY_DATA（衛星都市の行）と WORLD_MEGALOPOLIS_DATA に貼る。
// **初期化のたびに生成はしない**（都市の一覧が固定データなのと同じ理由。地形を少し変えただけで
// 地名がずれていくのを避ける）。地形を大きく変えて衛星都市が海に沈んだり山に乗ったりしたら、
// verify-world.js が知らせるので、そのときだけこれを流し直して貼り替える。
// なお、貼ったあとで流し直しても同じ結果にはならない（貼った衛星都市も、街として海岸の陸地を支える
// アンカーを持つので、まわりの陸の形が少し変わる）。貼り替えるときは、衛星都市の表を空にしてから流すこと。
//
// 作り方（首府の巨大都市 size ≥ 0.85 ごと）:
//   1) 軸の向き … 24方向を試し、中心から両側へ7.5kmおきに「陸・標高1,100m未満・起伏250m未満・同じ国」を
//      たどって、続く長さ（＋軸の近くにある同じ国の街）がいちばん長い向きを選ぶ。片側だけ（海岸の首府）もある
//   2) 仲間 … 軸から横に22km以内・軸に沿った範囲にある同じ国の街はそのまま仲間に入れる
//   3) 衛星都市 … 仲間どうしの間が MEGA_GAP_M より空いていれば、軸の上の平らな場所に新しい街を置く
//      （名前は国の音節表から。大きさは中心に近いほど大きい）

const W = require('../js/env/03b-world.js');

const MEGA_SIZE = 0.85;
const MEGA_SIDE_MAX_M = 190000;   // 片側に伸ばせる長さ
const MEGA_STEP_M = 7500;
const MEGA_LATERAL_M = 22000;     // 軸からこれ以内の街は仲間
const MEGA_GAP_M = 48000;         // 仲間どうしの間がこれより空けば衛星都市を置く
const MEGA_MIN_SPAN_M = 120000;   // これより短い軸しか取れない国は、都市群を作らない

function coreRadius(size) {
  const t = Math.min(Math.max((size - 0.85) / 0.13, 0), 1);
  return 10000 + t * 10000;
}
function builtRadius(size) { return 700 + size * (3800 - 700); }

// すでに貼ってある衛星都市は数に入れない（流し直すと、その上にさらに衛星都市を置いてしまう）
const satIds = new Set(W.WORLD_MEGALOPOLIS_CITY_DATA.map((d) => d[0]));
const origCities = W.WORLD_CITIES.filter((c) => !satIds.has(c.id));
const nearestOrig = (x, z) => {
  let best = null, bd = Infinity;
  for (const c of origCities) {
    const d = Math.hypot(c.x - x, c.z - z);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
};
const H = (x, z) => W.worldBaseHeightAt(x, z);
const pointOk = (x, z, country) => {
  const h = H(x, z);
  if (h < 6 || h > 1100) return false;
  if (W.worldLocalReliefAt(x, z, 3000, 5) > 250) return false;
  const n = nearestOrig(x, z);
  return !!n && n.country === country;
};

const used = new Set(origCities.map((c) => c.nameLatin));
const cityRows = [];
const megaRows = [];

for (const core of origCities.filter((c) => c.size >= MEGA_SIZE)) {
  const country = W.worldCountryById(core.country);
  const same = origCities.filter((c) => c !== core && c.country === core.country);
  // 1) 軸
  let best = null;
  for (let k = 0; k < 24; k++) {
    const th = (k / 24) * Math.PI;
    const ux = Math.cos(th), uz = Math.sin(th);
    const side = (sg) => {
      let last = 0, bad = 0;
      for (let d = MEGA_STEP_M; d <= MEGA_SIDE_MAX_M; d += MEGA_STEP_M) {
        if (pointOk(core.x + ux * d * sg, core.z + uz * d * sg, core.country)) { last = d; bad = 0; }
        else if (++bad >= 2) break;
      }
      return last;
    };
    const pos = side(1), neg = side(-1);
    let bonus = 0;
    for (const c of same) {
      const dx = c.x - core.x, dz = c.z - core.z;
      const along = dx * ux + dz * uz, lat = Math.abs(-dx * uz + dz * ux);
      if (lat < MEGA_LATERAL_M && along < pos + 10000 && along > -neg - 10000) bonus += 30000;
    }
    const score = pos + neg + bonus;
    if (!best || score > best.score) best = { th, ux, uz, pos, neg, score };
  }
  if (best.pos + best.neg < MEGA_MIN_SPAN_M) {
    console.error(`# ${core.id}: 軸が短すぎる（${((best.pos + best.neg) / 1000).toFixed(0)}km）ので都市群を作らない`);
    continue;
  }
  const { ux, uz } = best;
  const alongOf = (x, z) => (x - core.x) * ux + (z - core.z) * uz;
  const latOf = (x, z) => -(x - core.x) * uz + (z - core.z) * ux;
  // 2) 仲間（既存の街）
  const members = [{ id: core.id, along: 0, x: core.x, z: core.z, r: coreRadius(core.size) }];
  for (const c of same) {
    const a = alongOf(c.x, c.z);
    if (Math.abs(latOf(c.x, c.z)) < MEGA_LATERAL_M && a < best.pos + 10000 && a > -best.neg - 10000) {
      members.push({ id: c.id, along: a, x: c.x, z: c.z, r: builtRadius(c.size) });
    }
  }
  // 3) 衛星都市
  const rand = W.worldRng('mega:' + core.id);
  for (const sg of [1, -1]) {
    const lim = sg > 0 ? best.pos : best.neg;
    for (;;) {
      const onSide = members.filter((m) => m.along * sg >= 0).sort((p, q) => p.along * sg - q.along * sg);
      // 端から順に、間が空いているところを埋める
      let placed = false;
      for (let i = 0; i < onSide.length; i++) {
        const a0 = onSide[i].along * sg + onSide[i].r;
        const a1 = i + 1 < onSide.length ? onSide[i + 1].along * sg - onSide[i + 1].r : lim;
        if (a1 - a0 < MEGA_GAP_M * (i + 1 < onSide.length ? 1 : 0.6)) continue;
        const want = Math.min(a0 + MEGA_GAP_M * (0.55 + rand() * 0.25), a1 - 4000);
        if (want > lim) continue;
        const frac = Math.abs(want) / Math.max(lim, 1);
        const size = Math.min(0.82, Math.max(0.3, 0.78 - frac * 0.35 + (rand() - 0.5) * 0.18));
        const r = builtRadius(size);
        // 軸の上の平らな場所を探す（横へ最大10km、前後へ最大6km）
        let spot = null;
        for (let tr = 0; tr < 60 && !spot; tr++) {
          const da = (rand() - 0.5) * 12000, dl = (rand() - 0.5) * 2 * Math.min(10000, 2000 + tr * 300);
          const a = (want + da) * sg;
          const x = core.x + ux * a - uz * dl, z = core.z + uz * a + ux * dl;
          if (!pointOk(x, z, core.country)) continue;
          if (W.worldLocalReliefAt(x, z, r * 1.3, 5) > 120) continue;
          if (W.worldLocalReliefAt(x, z, 800, 3) > 60) continue;
          if (origCities.some((c) => Math.hypot(c.x - x, c.z - z) < (c.size >= MEGA_SIZE ? coreRadius(c.size) : builtRadius(c.size)) + r + 6000)) continue;
          if (cityRows.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + r + 6000)) continue;
          if (W.WORLD_AIRPORTS.some((ap) => Math.hypot(ap.x - x, ap.z - z) < ap.flatOuterR + r * 2.8 + 1500)) continue;
          spot = { x: Math.round(x), z: Math.round(z) };
        }
        if (!spot) { members.push({ id: null, along: want * sg, x: 0, z: 0, r: MEGA_GAP_M * 0.4 }); placed = true; break; }
        const nm = W.worldMakePlaceName(country.nameStyle, rand, used);
        const id = core.country + '-' + nm.nameLatin.toLowerCase().replace(/[^a-z0-9]+/g, '');
        const row = { id, name: nm.name, nameLatin: nm.nameLatin, country: core.country, x: spot.x, z: spot.z, size: Math.round(size * 1e4) / 1e4, r };
        cityRows.push(row);
        members.push({ id, along: alongOf(spot.x, spot.z), x: spot.x, z: spot.z, r });
        placed = true;
        break;
      }
      if (!placed) break;
    }
  }
  const real = members.filter((m) => m.id).sort((p, q) => p.along - q.along);
  const span = real[real.length - 1].along - real[0].along;
  megaRows.push({ core: core.id, axisDeg: Math.round(best.th * 180 / Math.PI), members: real.map((m) => m.id), spanKm: Math.round(span / 1000) });
}

console.log('// --- 衛星都市（WORLD_CITY_DATA の末尾に足す） ---');
for (const c of cityRows) {
  console.log(`  ['${c.id}', '${c.name}', '${c.nameLatin}', '${c.country}', ${c.x}, ${c.z}, ${c.size}, 0],`);
}
console.log('// --- WORLD_MEGALOPOLIS_DATA ---');
for (const m of megaRows) {
  console.log(`  ['${m.core}', [${m.members.map((id) => `'${id}'`).join(', ')}]], // 軸${m.axisDeg}° 端から端まで${m.spanKm}km`);
}
