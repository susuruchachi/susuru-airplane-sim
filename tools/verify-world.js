#!/usr/bin/env node
// tools/verify-world.js — 世界の定義（js/env/03b-world.js）を検証する
//
//   node tools/verify-world.js
//
// 地形は手続き生成なので、パラメータを触ると「街が海に沈む」「空港が崖の上にある」
// といった壊れ方を静かに起こす。ブラウザを開かずに気付けるよう、
// 陸/海の比率・各都市と空港の標高・山脈の最高地点をここで確認する。

const path = require('path');
const W = require(path.join(__dirname, '..', 'js', 'env', '03b-world.js'));

let failures = 0;
function check(ok, label, detail) {
  if (!ok) failures++;
  const mark = ok ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${label}${detail ? '  — ' + detail : ''}`);
}

console.log('=== 陸と海の比率 ===');
{
  const N = 240;
  let land = 0, total = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -W.WORLD_HALF + (i + 0.5) * (W.WORLD_SIZE / N);
      const z = -W.WORLD_HALF + (j + 0.5) * (W.WORLD_SIZE / N);
      if (W.worldHeightAt(x, z) > 0) land++;
      total++;
    }
  }
  const ratio = land / total;
  console.log(`  陸地: ${(ratio * 100).toFixed(1)}%  /  海: ${((1 - ratio) * 100).toFixed(1)}%`);
  check(ratio > 0.2 && ratio < 0.6, '陸と海のバランスが極端でない', `陸 ${(ratio * 100).toFixed(1)}%`);
}

console.log('\n=== 都市 ===');
for (const c of W.WORLD_CITIES) {
  const h = W.worldHeightAt(c.x, c.z);
  const country = W.worldCountryById(c.country);
  check(h > 0, `${c.name} (${c.nameLatin})`,
    `${country ? country.name : '?'} / 標高 ${h.toFixed(0)}m`);
}

console.log('\n=== 市街地の平坦さ ===');
// 街の下は worldPrepCities() がゆるく均している。ここが急だと建物が斜面に貼り付いて見える。
// 建物が実際に建つ円の中だけを見る（外側は元の地形へ戻すための遷移帯なので急で当然）。
for (const c of W.WORLD_CITIES) {
  const R = c.builtRadiusM;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      const dx = -R + (2 * R * i) / 23, dz = -R + (2 * R * j) / 23;
      if (Math.hypot(dx, dz) > R) continue;
      const h = W.worldHeightAt(c.x + dx, c.z + dz);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  check(hi - lo < 150, `${c.name} の市街地が平坦`, `標高差 ${Math.round(hi - lo)}m`);
}

console.log('\n=== 街と空港の位置関係 ===');
// 街が空港のならしの遷移帯に乗ると、そこだけ地面が傾いて建物が崩れる
for (const a of W.WORLD_AIRPORTS) {
  const c = W.worldCityById(a.city);
  const d = Math.hypot(a.x - c.x, a.z - c.z);
  check(d > a.flatOuterR + c.builtRadiusM,
    `${a.id} と ${c.name} が離れている`,
    `${(d / 1000).toFixed(1)}km（必要 ${((a.flatOuterR + c.builtRadiusM) / 1000).toFixed(1)}km 超）`);
}

console.log('\n=== 空港 ===');
for (const a of W.WORLD_AIRPORTS) {
  const h = W.worldHeightAt(a.x, a.z);
  const diff = Math.abs(h - a.elevationM);
  check(diff < 1, `${a.id} ${a.name}`, `地形 ${h.toFixed(1)}m / 定義 ${a.elevationM}m`);
}

console.log('\n=== 滑走路の全長が平地に収まっているか ===');
// UIで伸ばせる上限（maxRunwayLengthM）まで含めて、平地からはみ出さないか見る
for (const a of W.WORLD_AIRPORTS) {
  const half = a.maxRunwayLengthM / 2 + 400;
  let worst = 0;
  for (let i = 0; i <= 24; i++) {
    const t = -half + (2 * half * i) / 24;
    for (const off of [-a.runwayWidthM, 0, a.runwayWidthM]) {
      const hd = (a.headingDeg * Math.PI) / 180;
      const x = a.x + Math.sin(hd) * t + Math.cos(hd) * off;
      const z = a.z - Math.cos(hd) * t + Math.sin(hd) * off;
      worst = Math.max(worst, Math.abs(W.worldHeightAt(x, z) - a.elevationM));
    }
  }
  check(worst < 1, `${a.id} の滑走路全体が平ら（最大長 ${a.maxRunwayLengthM}m でも）`, `最大のずれ ${worst.toFixed(2)}m`);
}

console.log('\n=== 山脈 ===');
for (const r of W.WORLD_RANGES) {
  let peak = -Infinity, peakAt = null;
  const N = 90;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = r.cx + (-r.rx + (2 * r.rx * i) / (N - 1));
      const z = r.cz + (-r.rz + (2 * r.rz * j) / (N - 1));
      const h = W.worldHeightAt(x, z);
      if (h > peak) { peak = h; peakAt = [x, z]; }
    }
  }
  console.log(`  ${r.name}: 最高 ${peak.toFixed(0)}m  @ (${peakAt[0].toFixed(0)}, ${peakAt[1].toFixed(0)})`);
  check(peak > r.height * 0.4, `${r.name} が山らしい高さになっている`, `${peak.toFixed(0)}m`);
}

console.log('\n=== 高さ関数の速度 ===');
{
  const t0 = Date.now();
  const N = 200000;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    acc += W.worldHeightAt((i * 977) % W.WORLD_SIZE - W.WORLD_HALF, (i * 613) % W.WORLD_SIZE - W.WORLD_HALF);
  }
  const ms = Date.now() - t0;
  console.log(`  ${N} 回で ${ms}ms（${((ms / N) * 1000).toFixed(2)} µs/回）`);
  check(ms < 4000, '地形メッシュ生成が現実的な速度', `${ms}ms / ${N}回`);
  if (!Number.isFinite(acc)) check(false, '高さがNaNになっていない');
}

console.log('\n=== 最寄り空港の検索 ===');
{
  const r = W.worldNearestAirport(0, 0);
  check(r.airport && r.airport.id === 'VSAV', '原点の最寄りはアルヴィス', r.airport && r.airport.id);
  const r2 = W.worldNearestAirport(226000, 193000);
  check(r2.airport && r2.airport.id === 'SFCO', '南東の島の最寄りはコーラリス', r2.airport && r2.airport.id);
}

console.log(`\n${failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`}`);
process.exit(failures === 0 ? 0 : 1);
