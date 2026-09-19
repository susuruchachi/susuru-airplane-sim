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

// --- 河口 ---
// 川幅は「集めた水の量」で決まる（源流からの距離の平方根）。
// 以前は「何割来たか」だけで決めていたので、31kmの川も139kmの川も河口の半幅が
// 107mちょうどで、空から見て大河と小川の区別が付かなかった。
// 河口は入り江か三角州で海につなぐ。川床を海面下まで下げて海を呼び込むので、
// 下げすぎて河口の街を沈めていないかもここで見る。
{
  let widthMono = 0, deepEnough = 0, notDrowned = 0;
  const seaBound = W.WORLD_RIVERS.filter((r) => r.mouthKind);
  for (const r of W.WORLD_RIVERS) {
    // 幅は上流から下流へ細らない
    let shrinks = 0;
    for (let i = 1; i < r.points.length; i++) {
      if (r.points[i].halfWidth < r.points[i - 1].halfWidth - 0.001) shrinks++;
    }
    if (shrinks === 0) widthMono++;
    else check(false, `${r.nameLatin} の幅が下流へ広がる`, `${shrinks}区間が細くなっている`);

    // 川床も下り一方（河口の掘り下げを入れたあとで）
    let bedRises = 0;
    for (let i = 1; i < r.points.length; i++) {
      if (r.points[i].bedH > r.points[i - 1].bedH + 0.001) bedRises++;
    }
    if (bedRises === 0) deepEnough++;
    else check(false, `${r.nameLatin} の川床が下り一方（河口を含む）`, `${bedRises}区間が上っている`);
  }
  summary('幅が下流へ広がる川', widthMono, W.WORLD_RIVERS.length);
  summary('川床が下り一方の川（河口の掘り下げ込み）', deepEnough, W.WORLD_RIVERS.length);

  // 河口の掘り下げで街が水没していないか（街の判定は上の「陸の上にある都市」と同じ基準）
  for (const c of W.WORLD_CITIES) if (W.worldHeightAt(c.x, c.z) > 1) notDrowned++;
  summary('河口に沈んでいない都市', notDrowned, W.WORLD_CITIES.length);

  // 河口の半幅がばらけていること（同じ幅ばかりなら流量で決まっていない）
  const mw = seaBound.map((r) => r.points[r.points.length - 1].halfWidth).sort((a, b) => a - b);
  if (mw.length) {
    const lo = mw[0], hi = mw[mw.length - 1];
    console.log(`[  --  ] 河口の半幅: 最小${lo.toFixed(0)}m 中央${mw[mw.length >> 1].toFixed(0)}m 最大${hi.toFixed(0)}m`);
    check(hi > lo * 2, '河口の幅が川ごとに違う', `最大が最小の${(hi / lo).toFixed(1)}倍`);
  }

  const delta = W.WORLD_RIVERS.filter((r) => r.mouthKind === 'delta').length;
  const estuary = W.WORLD_RIVERS.filter((r) => r.mouthKind === 'estuary').length;
  console.log(`[  --  ] 河口: 入り江${estuary} 三角州${delta} 内陸（湖に注ぐ）${W.WORLD_RIVERS.length - estuary - delta}`);
  check(delta >= 2, '三角州がいくつかある', String(delta));
  check(estuary >= 10, '入り江が十分ある', String(estuary));

  // 三角州は「積もらせた土を分流が切り開く」形。中州が海面より上に出ていること、
  // 分流が海面より下に掘れていることの両方を見る（片方だけだと何も見えない）。
  let shaped = 0;
  for (const r of W.WORLD_RIVERS) {
    if (r.mouthKind !== 'delta' || !r.mouthBranches) continue;
    // 隣り合う分流の中間＝中州になるはずの場所。分流の長さは海に出るまでで
    // 決まるので固定の番号では拾えない。短いほうの真ん中で見る。
    const a = r.mouthBranches[0], b = r.mouthBranches[1];
    const k = Math.max(2, Math.min(a.length, b.length) >> 1);
    const ix = (a[k].x + b[k].x) / 2, iz = (a[k].z + b[k].z) / 2;
    const island = W.worldHeightAt(ix, iz);
    const channel = W.worldHeightAt(a[k].x, a[k].z);
    if (island > 0 && channel < 0) shaped++;
    else check(false, `${r.nameLatin} の三角州に中州と分流がある`,
      `中州 ${island.toFixed(1)}m / 分流 ${channel.toFixed(1)}m`);
  }
  summary('中州と分流のある三角州', shaped, delta);
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

// --- 山脈が「連なり」になっているか ---
// 山脈は稜線を1本引いて、そこからの距離で高さを決めている。
// 稜線の上を端から端まで歩いて、高さが途切れていないかを見る。
// 稜線を引く前は最高点の6割以上の場所が 29〜108個 の孤立した塊に割れていて、
// 上空から見ても山脈の背骨がどこにも無かった。
{
  let connected = 0, hasSummits = 0, worldPeak = 0, worldPeakName = '';
  const rows = [];
  for (const r of W.WORLD_RANGES) {
    const S = 400, hs = [];
    let len = 0, prev = null;
    for (let i = 0; i <= S; i++) {
      const t = -0.85 + (1.70 * i) / S;
      const p = W.worldRangeCrestAt(r, t);
      hs.push(W.worldHeightAt(p.x, p.z));
      if (prev) len += Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    const peak = Math.max(...hs);
    if (peak > worldPeak) { worldPeak = peak; worldPeakName = r.name; }

    // 峠＝稜線が最高点の5割を割る区間。海に出るところは山脈の途切れではないので除く
    let passes = 0, below = false, summits = 0, up = false;
    for (const h of hs) {
      if (h > 0 && h < peak * 0.5) { if (!below) passes++; below = true; } else below = false;
      if (h > peak * 0.85) { if (!up) summits++; up = true; } else up = false;
    }
    rows.push(`${r.name} 峠${passes} 峰${summits}`);
    // 峠だらけなら「連なり」ではなく、ちぎれた山の列
    if (passes <= 8) connected++;
    else check(false, `${r.name} の稜線が途切れていない`, `峠が${passes}ヶ所`);
    if (summits >= 4) hasSummits++;
    else check(false, `${r.name} に峰がいくつもある`, `${summits}座`);
  }
  summary('稜線がつながっている山脈', connected, W.WORLD_RANGES.length);
  summary('峰がいくつもある山脈', hasSummits, W.WORLD_RANGES.length);
  console.log(`[  --  ] 稜線: ${rows.join(' / ')}`);
  console.log(`[  --  ] 世界の最高地点: ${Math.round(worldPeak)}m（${worldPeakName}）`);
  // js/env/10-flight.js の WORLD_MAX_TERRAIN_M はこれより高くなければならない。
  // 低いと、当たり判定の足切りで高い山を素通りする。
  check(worldPeak < 5000, '最高地点が WORLD_MAX_TERRAIN_M(5000m) を超えない',
    `${Math.round(worldPeak)}m`);
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

// --- 森の濃さ（地表の色と、実際に生える木の、唯一の出どころ）---
// 03c-terrain.js（地表色）と 03g-vegetation.js（樹木・木立の塊）が
// そろって worldForestDensity を見る。ここが壊れると、森のある所と無い所の
// 境目が地面に色の段差として出る（前はこの2つが別々の式で、平均0.45ずれていた）。
{
  const N = 150;
  let land = 0, forest = 0, sparse = 0, sum = 0, any = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -W.WORLD_HALF + (i + 0.5) * (W.WORLD_SIZE / N);
      const z = -W.WORLD_HALF + (j + 0.5) * (W.WORLD_SIZE / N);
      const h = W.worldHeightAt(x, z);
      if (h <= 0) continue;
      land++;
      const e = 26;
      const slope = Math.hypot(
        (W.worldHeightAt(x + e, z) - h) / e,
        (W.worldHeightAt(x, z + e) - h) / e
      );
      const t = W.worldTemperatureAt(x, z, h);
      const d = W.worldDrynessAt(x, z, W.worldLandValueAt(x, z));
      const fd = W.worldForestDensity(h, slope, t, d, W.worldUrbanFactorAt(x, z));
      sum += fd;
      if (fd > 0.2) any++;
      if (fd > 0.5) forest++;
      else if (fd > 0.05) sparse++;
    }
  }
  const pf = (forest / land) * 100, ps = (sparse / land) * 100, pa = (any / land) * 100;
  console.log(`[  --  ] 陸の森: 森と呼べる濃さ${pa.toFixed(0)}%（うち濃い森${pf.toFixed(0)}%）`
    + ` まばら${ps.toFixed(0)}% 平均の濃さ${(sum / land).toFixed(2)}`);
  check(pa > 15 && pa < 70, '森が陸の一部を占めている（多すぎず少なすぎず）', pa.toFixed(0) + '%');
  check(sparse > 0, 'まばらな森（濃い森と裸地の間）がある', ps.toFixed(0) + '%');

  // 森林限界をまたぐところで密度が飛ばないこと。
  // 飛ぶと、地表の色がそこで段差になる（色は密度から作っているため）。
  let maxJump = 0, jumpAt = 0;
  for (const temp of [0.15, 0.35, 0.55, 0.8]) {
    const treeLine = (700 + temp * 3400) * 0.62;
    let prev = null;
    for (let h = treeLine - 260; h < treeLine + 60; h += 4) {
      const fd = W.worldForestDensity(h, 0.05, temp, 0.1, 0);
      if (prev !== null && Math.abs(fd - prev) > maxJump) { maxJump = Math.abs(fd - prev); jumpAt = h; }
      prev = fd;
    }
  }
  check(maxJump < 0.06, '森林限界で森の濃さが飛ばない（4mごとの変化）',
    `最大${maxJump.toFixed(3)}（標高${jumpAt.toFixed(0)}m付近）`);

  // 生えてはいけない所で0になること
  check(W.worldForestDensity(300, 0.05, 0.5, 0.95, 0) === 0, '砂漠には森が無い');
  check(W.worldForestDensity(300, 0.05, 0.01, 0.1, 0) === 0, '極寒地には森が無い');
  check(W.worldForestDensity(300, 0.05, 0.5, 0.1, 1) === 0, '市街地には森が無い');
  check(W.worldForestDensity(3000, 0.05, 0.5, 0.1, 0) === 0, '森林限界より上には森が無い');
  check(W.worldForestDensity(300, 1.2, 0.5, 0.1, 0) < 0.05, '切り立った斜面にはほぼ生えない');
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
