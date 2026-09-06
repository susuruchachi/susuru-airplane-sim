#!/usr/bin/env node
// tools/verify-world.js — 世界の定義（js/env/03b-world.js）を検証する
//
//   node tools/verify-world.js          … 検証
//   node tools/verify-world.js --list   … 生成された国・都市・空港の一覧も出す
//
// 地形は手続き生成なので、パラメータを触ると「街が海に沈む」「空港が崖の上にある」
// といった壊れ方を静かに起こす。ブラウザを開かずに気付けるよう、
// 陸/海の比率・都市と空港の成立条件・生成にかかる時間をここで確認する。

const path = require('path');
const t0 = Date.now();
const W = require(path.join(__dirname, '..', 'js', 'env', '03b-world.js'));
const genMs = Date.now() - t0;

let failures = 0;
function check(ok, label, detail) {
  if (!ok) failures++;
  if (!ok || process.env.VERBOSE || process.argv.includes('--list')) {
    console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? '  — ' + detail : ''}`);
  }
  return ok;
}
function summary(label, ok, total, detail) {
  if (ok < total) failures++;
  console.log(`[${ok === total ? '  ok  ' : ' FAIL '}] ${label}: ${ok}/${total}${detail ? '  — ' + detail : ''}`);
}

console.log(`世界の生成: ${genMs}ms  /  一辺 ${(W.WORLD_SIZE / 1000).toLocaleString()}km`);
console.log(`国 ${W.WORLD_COUNTRIES.length} / 都市 ${W.WORLD_CITIES.length} / 空港 ${W.WORLD_AIRPORTS.length}\n`);
check(genMs < 8000, '世界の生成が現実的な時間で終わる', `${genMs}ms`);

// --- 陸と海の比率 ---
{
  const N = 220;
  let land = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -W.WORLD_HALF + (i + 0.5) * (W.WORLD_SIZE / N);
      const z = -W.WORLD_HALF + (j + 0.5) * (W.WORLD_SIZE / N);
      if (W.worldHeightAt(x, z) > 0) land++;
    }
  }
  const ratio = land / (N * N);
  check(ratio > 0.15 && ratio < 0.6, '陸と海のバランスが極端でない',
    `陸 ${(ratio * 100).toFixed(1)}% / 海 ${((1 - ratio) * 100).toFixed(1)}%`);
}

// --- 名前・コードの一意性 ---
{
  const names = new Set(W.WORLD_CITIES.map((c) => c.nameLatin));
  check(names.size === W.WORLD_CITIES.length, '都市名が重複していない',
    `${names.size}/${W.WORLD_CITIES.length}`);
  const codes = new Set(W.WORLD_AIRPORTS.map((a) => a.id));
  check(codes.size === W.WORLD_AIRPORTS.length, '空港コードが重複していない',
    `${codes.size}/${W.WORLD_AIRPORTS.length}`);
}

// --- 各国に首府と空港があるか ---
{
  let ok = 0;
  for (const co of W.WORLD_COUNTRIES) {
    const cities = W.WORLD_CITIES.filter((c) => c.country === co.id);
    const airports = W.WORLD_AIRPORTS.filter((a) => a.country === co.id);
    const hasCapital = cities.some((c) => c.capital);
    if (cities.length >= 3 && airports.length >= 1 && hasCapital) ok++;
    else check(false, `${co.name} に都市と空港がある`,
      `都市${cities.length} 空港${airports.length} 首府${hasCapital ? 'あり' : 'なし'}`);
  }
  summary('都市と空港のある国', ok, W.WORLD_COUNTRIES.length);
}

// --- 都市が陸の上にあり、市街地が平坦か ---
{
  let onLand = 0, flat = 0;
  for (const c of W.WORLD_CITIES) {
    if (W.worldHeightAt(c.x, c.z) > 0) onLand++;
    else check(false, `${c.name} が陸の上にある`, `標高 ${W.worldHeightAt(c.x, c.z).toFixed(0)}m`);

    const R = c.builtRadiusM;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        const dx = -R + (2 * R * i) / 15, dz = -R + (2 * R * j) / 15;
        if (Math.hypot(dx, dz) > R) continue;
        const h = W.worldHeightAt(c.x + dx, c.z + dz);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    if (hi - lo < 150) flat++;
    else check(false, `${c.name} の市街地が平坦`, `標高差 ${Math.round(hi - lo)}m`);
  }
  summary('陸の上にある都市', onLand, W.WORLD_CITIES.length);
  summary('市街地が平坦な都市', flat, W.WORLD_CITIES.length);
}

// --- 空港：標高どおりに均されていて、滑走路の全長が平らか ---
{
  let level = 0, flat = 0, apart = 0;
  for (const a of W.WORLD_AIRPORTS) {
    if (Math.abs(W.worldHeightAt(a.x, a.z) - a.elevationM) < 1) level++;
    else check(false, `${a.id} が定義どおりの標高`, `地形 ${W.worldHeightAt(a.x, a.z).toFixed(1)}m / 定義 ${a.elevationM}m`);

    // UIで伸ばせる上限（maxRunwayLengthM）まで含めて平地に収まるか
    const half = a.maxRunwayLengthM / 2 + 400;
    const hd = (a.headingDeg * Math.PI) / 180;
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      const t = -half + (2 * half * i) / 20;
      for (const off of [-a.runwayWidthM, 0, a.runwayWidthM]) {
        const x = a.x + Math.sin(hd) * t + Math.cos(hd) * off;
        const z = a.z - Math.cos(hd) * t + Math.sin(hd) * off;
        worst = Math.max(worst, Math.abs(W.worldHeightAt(x, z) - a.elevationM));
      }
    }
    if (worst < 1) flat++;
    else check(false, `${a.id} の滑走路全体が平ら`, `最大のずれ ${worst.toFixed(2)}m`);

    // 街の均しの遷移帯に空港が乗ると、そこだけ地面が傾いて滑走路が崩れる
    const c = W.worldCityById(a.city);
    if (c && Math.hypot(a.x - c.x, a.z - c.z) > a.flatOuterR + c.flatOuterR) apart++;
    else if (c) check(false, `${a.id} と ${c.name} が離れている`,
      `${(Math.hypot(a.x - c.x, a.z - c.z) / 1000).toFixed(1)}km`);
  }
  summary('標高どおりに均された空港', level, W.WORLD_AIRPORTS.length);
  summary('滑走路全体が平らな空港', flat, W.WORLD_AIRPORTS.length);
  summary('街と十分離れた空港', apart, W.WORLD_AIRPORTS.length);
}

// --- 川 ---
// 川は「河口から谷を遡って」引いている。下流へ向かって必ず下がること、
// 全部が海に届くこと、滑走路を突っ切っていないことを見る。
{
  console.log(`\n川 ${W.WORLD_RIVERS.length} 本 / 湖 ${W.WORLD_LAKES.length}`);
  let toSea = 0, monotone = 0, clearOfAirports = 0;
  for (const r of W.WORLD_RIVERS) {
    if (r.points[r.points.length - 1].h <= 25) toSea++;
    else check(false, `${r.nameLatin} が海に届く`, `河口の標高 ${r.points[r.points.length - 1].h.toFixed(0)}m`);

    let rises = 0;
    for (let i = 1; i < r.points.length; i++) if (r.points[i].h > r.points[i - 1].h + 0.001) rises++;
    if (rises === 0) monotone++;
    else check(false, `${r.nameLatin} の川床が下り一方`, `${rises}区間が上っている`);

    let hits = 0;
    for (const p of r.points) {
      for (const a of W.WORLD_AIRPORTS) {
        if (Math.hypot(p.x - a.x, p.z - a.z) < a.flatInnerR) { hits++; break; }
      }
    }
    if (hits === 0) clearOfAirports++;
    else check(false, `${r.nameLatin} が空港を通っていない`, `${hits}点が滑走路の平地の中`);
  }
  summary('海に届く川', toSea, W.WORLD_RIVERS.length);
  summary('川床が下り一方の川', monotone, W.WORLD_RIVERS.length);
  summary('空港を通らない川', clearOfAirports, W.WORLD_RIVERS.length);

  const lens = W.WORLD_RIVERS.map((r) => r.lengthM / 1000).sort((a, b) => b - a);
  if (lens.length) {
    console.log(`[  --  ] 川の長さ: 最長${lens[0].toFixed(0)}km 中央${lens[Math.floor(lens.length / 2)].toFixed(0)}km 最短${lens[lens.length - 1].toFixed(0)}km`);
  }
  check(W.WORLD_RIVERS.length >= 20, '川が十分な数ある', String(W.WORLD_RIVERS.length));
}

// --- 湖 ---
{
  let deep = 0, clear = 0;
  for (const l of W.WORLD_LAKES) {
    // 中心の地形が水面より下＝ちゃんと窪地になっている
    if (W.worldHeightAt(l.x, l.z) < l.level - 1) deep++;
    else check(false, `${l.nameLatin} が窪地になっている`, `地形 ${W.worldHeightAt(l.x, l.z).toFixed(0)}m / 水面 ${l.level.toFixed(0)}m`);

    let clash = false;
    for (const a of W.WORLD_AIRPORTS) {
      if (Math.hypot(a.x - l.x, a.z - l.z) < a.flatOuterR + l.outerR) { clash = true; break; }
    }
    for (const c of W.WORLD_CITIES) {
      if (Math.hypot(c.x - l.x, c.z - l.z) < c.flatOuterR + l.outerR) { clash = true; break; }
    }
    if (!clash) clear++;
    else check(false, `${l.nameLatin} が街や空港と重なっていない`);
  }
  summary('窪地になっている湖', deep, W.WORLD_LAKES.length);
  summary('街や空港と重ならない湖', clear, W.WORLD_LAKES.length);
  check(W.WORLD_LAKES.length >= 15, '湖が十分な数ある', String(W.WORLD_LAKES.length));
}

// --- 山脈 ---
{
  let ok = 0;
  for (const r of W.WORLD_RANGES) {
    let peak = -Infinity;
    for (let i = 0; i < 70; i++) {
      for (let j = 0; j < 70; j++) {
        const h = W.worldHeightAt(r.cx - r.rx + (2 * r.rx * i) / 69, r.cz - r.rz + (2 * r.rz * j) / 69);
        if (h > peak) peak = h;
      }
    }
    r._peak = peak;
    if (peak > r.height * 0.4) ok++;
    else check(false, `${r.name} が山らしい高さ`, `${peak.toFixed(0)}m`);
  }
  summary('山らしい高さの山脈', ok, W.WORLD_RANGES.length);
}

// --- 気候が世界の中で振れているか（一様だと地表が単調になる）---
{
  let tLo = 1, tHi = 0, dLo = 1, dHi = 0;
  for (let i = 0; i < 60; i++) {
    for (let j = 0; j < 60; j++) {
      const x = -W.WORLD_HALF + (i + 0.5) * (W.WORLD_SIZE / 60);
      const z = -W.WORLD_HALF + (j + 0.5) * (W.WORLD_SIZE / 60);
      const h = W.worldHeightAt(x, z);
      if (h <= 0) continue;
      const t = W.worldTemperatureAt(x, z, h);
      const d = W.worldDrynessAt(x, z, W.worldLandValueAt(x, z));
      tLo = Math.min(tLo, t); tHi = Math.max(tHi, t);
      dLo = Math.min(dLo, d); dHi = Math.max(dHi, d);
    }
  }
  check(tHi - tLo > 0.6, '気温が寒帯から熱帯まで振れている', `${tLo.toFixed(2)}〜${tHi.toFixed(2)}`);
  check(dHi - dLo > 0.5, '乾燥度が湿潤から乾燥まで振れている', `${dLo.toFixed(2)}〜${dHi.toFixed(2)}`);
}

// --- 気候の分布（地表がどの気候で埋まっているか）---
// 内陸=乾燥にしすぎると大陸の中身が全部砂漠になる、というような偏りをここで見る。
{
  const N = 150;
  const bins = { 雪氷: 0, 寒帯: 0, 温帯: 0, 熱帯: 0, 半乾燥: 0, 砂漠: 0 };
  let land = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -W.WORLD_HALF + (i + 0.5) * (W.WORLD_SIZE / N);
      const z = -W.WORLD_HALF + (j + 0.5) * (W.WORLD_SIZE / N);
      const h = W.worldHeightAt(x, z);
      if (h <= 0) continue;
      land++;
      const t = W.worldTemperatureAt(x, z, h);
      const d = W.worldDrynessAt(x, z, W.worldLandValueAt(x, z));
      if (h > 700 + t * 3400) bins['雪氷']++;
      else if (d > 0.62) bins['砂漠']++;
      else if (d > 0.40) bins['半乾燥']++;
      else if (t < 0.30) bins['寒帯']++;
      else if (t > 0.68) bins['熱帯']++;
      else bins['温帯']++;
    }
  }
  const pct = (k) => ((bins[k] / land) * 100).toFixed(0) + '%';
  console.log(`[  --  ] 陸の気候: 温帯${pct('温帯')} 熱帯${pct('熱帯')} 寒帯${pct('寒帯')} 半乾燥${pct('半乾燥')} 砂漠${pct('砂漠')} 雪氷${pct('雪氷')}`);
  // どれか1つの気候が陸を埋め尽くしていないこと
  let worst = '', worstV = 0;
  for (const k in bins) { const v = bins[k] / land; if (v > worstV) { worstV = v; worst = k; } }
  check(worstV < 0.5, '特定の気候が陸を埋め尽くしていない', `最大は${worst} ${(worstV * 100).toFixed(0)}%`);
  check(bins['砂漠'] / land > 0.03 && bins['砂漠'] / land < 0.3, '砂漠が適度にある', pct('砂漠'));
  check(bins['熱帯'] / land > 0.05, '熱帯がある', pct('熱帯'));
  check(bins['寒帯'] / land > 0.05, '寒帯がある', pct('寒帯'));
}

// --- 高さ関数の速度（地形メッシュはこれを毎フレーム何万回も呼ぶ）---
{
  const t = Date.now();
  const N = 200000;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    acc += W.worldHeightAt((i * 977) % W.WORLD_SIZE - W.WORLD_HALF, (i * 613) % W.WORLD_SIZE - W.WORLD_HALF);
  }
  const ms = Date.now() - t;
  check(Number.isFinite(acc), '高さがNaNになっていない');
  check(ms < 4000, '高さ関数が十分速い', `${((ms / N) * 1000).toFixed(2)} µs/回`);
}

if (process.argv.includes('--list')) {
  console.log('\n=== 国 ===');
  for (const co of W.WORLD_COUNTRIES) {
    const cities = W.WORLD_CITIES.filter((c) => c.country === co.id);
    const cap = cities.find((c) => c.capital);
    console.log(`${co.name} (${co.nameLatin}) 首府:${cap ? cap.name : '-'} 都市${cities.length} 空港${W.WORLD_AIRPORTS.filter((a) => a.country === co.id).length}`);
    console.log('   ' + cities.map((c) => c.name).join('、'));
  }
  console.log('\n=== 山脈 ===');
  for (const r of W.WORLD_RANGES) console.log(`${r.name} (${r.nameLatin}) 最高 ${Math.round(r._peak / 10) * 10}m`);
  console.log('\n=== 空港 ===');
  for (const a of W.WORLD_AIRPORTS) {
    console.log(`${a.id}  ${a.name.padEnd(16, '　')} ${String(a.elevationM).padStart(5)}m  ${a.runwayLengthM}×${a.runwayWidthM}m`);
  }
}

console.log(`\n${failures === 0 ? '✅ すべて通過' : `❌ ${failures} 件の失敗`}`);
process.exit(failures === 0 ? 0 : 1);
