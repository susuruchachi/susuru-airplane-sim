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

// --- 天候（自動モード）---
// 見え方は js/env/05b-weather.js の deriveWeather が決めるので、そこを直接呼ぶ。
// 「3,000km飛べば天気が変わる」「どこもかしこも雨」にならない、を確かめる。
{
  const WX = require(path.join(__dirname, '..', 'js', 'env', '05b-weather.js'));
  // ブラウザでは番号順に読み込まれて全部が同じスコープに並ぶ。
  // Node ではモジュールごとに閉じてしまうので、天候が使う世界の関数を渡しておく。
  for (const k of ['worldClamp', 'worldLandValueAt', 'worldTemperatureAt', 'worldDrynessAt']) {
    globalThis[k] = W[k];
  }
  const auto = (x, z, hours) => {
    const h = W.worldHeightAt(x, z);
    return WX.deriveWeather(W.worldWeatherFieldAt(x, z, hours), x, z, h, { climate: true });
  };

  // 1) 天気の内訳。ある一瞬だけを見ると偏るので、1日ぶんの何時刻かをまとめて数える。
  //    陸と海を分けて見るのが大事。陸は乾燥で雨が抑えられるが海は抑えが効かないので、
  //    陸だけ見て調整すると、海の上だけ土砂降りだらけになる（ミニマップのレーダーで発覚した）。
  const N = 120;
  const HOURS = [0, 7, 15, 23];
  const bins = { land: {}, sea: {} };
  const total = { land: 0, sea: 0 };
  const heavy = { land: 0, sea: 0 };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -W.WORLD_HALF + (i + 0.5) * (W.WORLD_SIZE / N);
      const z = -W.WORLD_HALF + (j + 0.5) * (W.WORLD_SIZE / N);
      const kind = W.worldHeightAt(x, z) > 0 ? 'land' : 'sea';
      for (const hr of HOURS) {
        const w = auto(x, z, hr);
        total[kind]++;
        if (w.precipRate > 0.7) heavy[kind]++;
        const label = WX.weatherLabel(w);
        bins[kind][label] = (bins[kind][label] || 0) + 1;
      }
    }
  }
  const WET_LABELS = ['雨', '小雨', '雷雨', '雪', '小雪', '吹雪'];
  for (const kind of ['land', 'sea']) {
    const b = bins[kind], n = total[kind];
    const pct = (k) => (((b[k] || 0) / n) * 100).toFixed(0) + '%';
    const name = kind === 'land' ? '陸' : '海';
    console.log(`[  --  ] ${name}の天気: ` + Object.keys(b).sort().map((k) => `${k}${pct(k)}`).join(' ')
      + `  強い雨${((heavy[kind] / n) * 100).toFixed(0)}%`);

    const fine = ((b['快晴'] || 0) + (b['晴れ'] || 0)) / n;
    const wet = WET_LABELS.reduce((s, k) => s + (b[k] || 0), 0) / n;
    check(fine > 0.25 && fine < 0.85, `${name}に晴れている所がほどよくある`, (fine * 100).toFixed(0) + '%');
    check(wet > 0.05 && wet < 0.40, `${name}に降っている所がほどよくある`, (wet * 100).toFixed(0) + '%');
    // 強い雨は「たまにある」もの。ここが2割にもなると、レーダーが一面まっ赤になる。
    check(heavy[kind] / n < 0.10, `${name}の強い雨がまれである`, ((heavy[kind] / n) * 100).toFixed(0) + '%');
    check(Object.keys(b).length >= 4, `${name}の天気の種類が出そろっている`, Object.keys(b).join('/'));
  }
  // 海のほうが陸より湿っている（乾燥した内陸ほど降りにくい、が効いているか）
  const wetOf = (k) => WET_LABELS.reduce((s, l) => s + (bins[k][l] || 0), 0) / total[k];
  check(wetOf('sea') > wetOf('land'), '海のほうが陸より降っている',
    `海${(wetOf('sea') * 100).toFixed(0)}% > 陸${(wetOf('land') * 100).toFixed(0)}%`);

  // 2) 場所で変わること：1,500km離れた2点の天気が、そこそこの割合で食い違う
  let differ = 0, pairs = 0;
  for (let i = 0; i < 400; i++) {
    const x = ((i * 8887) % W.WORLD_SIZE) - W.WORLD_HALF;
    const z = ((i * 4241) % W.WORLD_SIZE) - W.WORLD_HALF;
    const x2 = x + 1500000 > W.WORLD_HALF ? x - 1500000 : x + 1500000;
    pairs++;
    if (WX.weatherLabel(auto(x, z, 0)) !== WX.weatherLabel(auto(x2, z, 0))) differ++;
  }
  check(differ / pairs > 0.4, '1,500km離れれば天気が変わる', `${((differ / pairs) * 100).toFixed(0)}%が別の天気`);

  // 3) 時間で変わること：同じ場所でも1日回せば天気が移り変わる
  const px = W.WORLD_CITIES[0].x, pz = W.WORLD_CITIES[0].z;
  const seen = new Set();
  for (let h = 0; h < 48; h += 2) seen.add(WX.weatherLabel(auto(px, pz, h)));
  check(seen.size >= 2, '同じ場所でも時間で天気が変わる', `${W.WORLD_CITIES[0].name}で2日間に ${[...seen].join('→')}`);

  // 4) 切れ目がないこと。
  //    霧の縁のように数kmで一気に変わる場所はあってよい（実際そういうものだし、
  //    飛び込むのが面白い）ので、見るのは「1秒ぶん飛んだ距離」での変化。
  //    ここが跳ねるときは場が不連続になっている。
  let worstJump = 0;
  for (let i = 0; i < 1500; i++) {
    const x = ((i * 7717) % W.WORLD_SIZE) - W.WORLD_HALF;
    const z = ((i * 3313) % W.WORLD_SIZE) - W.WORLD_HALF;
    const a = auto(x, z, 0).visibilityM, b = auto(x + 500, z, 0).visibilityM;
    worstJump = Math.max(worstJump, Math.max(a, b) / Math.min(a, b));
  }
  check(worstJump < 1.5, '天候の場に切れ目がない', `500mあたり最大 ${worstJump.toFixed(2)}倍`);

  // 5) プリセットは選んだとおりの天気になること（気候に打ち消されない）
  //    砂漠のど真ん中で「雨」を選んでも降る、が要点。
  let dryX = 0, dryZ = 0, dryest = -1;
  for (let i = 0; i < 20000; i++) {
    const x = ((i * 9973) % W.WORLD_SIZE) - W.WORLD_HALF;
    const z = ((i * 6151) % W.WORLD_SIZE) - W.WORLD_HALF;
    if (W.worldHeightAt(x, z) <= 0) continue;
    const d = W.worldDrynessAt(x, z, W.worldLandValueAt(x, z));
    if (d > dryest) { dryest = d; dryX = x; dryZ = z; }
  }
  const expected = { clear: '快晴', fair: '晴れ', cloudy: '曇り', rain: '雨', storm: '雷雨', snow: '雪', fog: '霧' };
  let okPresets = 0;
  const got = [];
  for (const id in expected) {
    const p = WX.weatherPresetById(id);
    const w = WX.deriveWeather(p, dryX, dryZ, W.worldHeightAt(dryX, dryZ),
      { forcePrecip: p.forcePrecip || null, climate: false });
    const label = WX.weatherLabel(w);
    got.push(`${p.name}→${label}`);
    if (label === expected[id]) okPresets++;
  }
  summary(`プリセットが名前どおりの天気になる（乾燥度${dryest.toFixed(2)}の土地で）`,
    okPresets, Object.keys(expected).length, got.join(' '));
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
