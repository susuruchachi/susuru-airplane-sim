// 03k-city-shapes.js — 街の建物と名所の形
//
// 03j-city-layout.js が決めた「どこに・どの形の建物を」（cityBuildingPlan / cityLandmarks）を、
// 三角形の列にする。都市ごとに1メッシュへまとめるので（03d-places.js の buildCityInstance）、
// ここは配列へ頂点・法線・色を積むだけで、THREE の物は作らない。
//
//   家・中層 … 箱の上に屋根（切妻・寄棟・平屋根。平屋根の中層は屋上に機械室を載せることがある）
//   高層ビル … 基壇・胴・頭の3段で細くなる。いちばん高いビルには尖塔
//   名所 … 尖塔の教会 / 丸屋根 / 丸屋根と尖塔（ミナレット）/ 五重塔 / 鐘楼 / 展望塔
//
// 座標は街の中心からのローカル（x 東・z 南・y は街の基準の高さからの差）。

const CITY_STONE = 0x6f685c;
const CITY_CONCRETE = 0x6b6e72;

// 積む先。{ p: 位置, n: 法線, c: 色 }
function cityShapeSink() { return { p: [], n: [], c: [] }; }

function _skRGB(hex, shade) {
  return [((hex >> 16) & 255) / 255 * shade, ((hex >> 8) & 255) / 255 * shade, (hex & 255) / 255 * shade];
}

// 三角形1枚（外から見て反時計回りに並べる）
function skTri(S, a, b, c, hex, shade) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  // 面の向きで明るさを変える（単色でも立体に見える。pushBox と同じ考え方）
  const sh = (shade || 1) * (ny > 0.7 ? 1.12 : 0.86 + 0.1 * Math.abs(nz));
  const [r, g, bl] = _skRGB(hex, sh);
  for (const q of [a, b, c]) { S.p.push(q[0], q[1], q[2]); S.n.push(nx, ny, nz); S.c.push(r, g, bl); }
}
function skQuad(S, a, b, c, d, hex, shade) { skTri(S, a, b, c, hex, shade); skTri(S, a, c, d, hex, shade); }

// 向きの付いた枠。u は ang の向き（間口）、v はそれと直角（奥行き）
function skFrame(cx, cz, ang) {
  const dx = Math.cos(ang), dz = Math.sin(ang);
  return (u, v, y) => [cx + dx * u - dz * v, y, cz + dz * u + dx * v];
}

// 箱（底なし）
function skBox(S, cx, y0, cz, w, h, d, ang, hex) {
  const [r, g, b] = _skRGB(hex, 1);
  pushBox(S.p, S.n, S.c, cx, y0, cz, w, h, d, r, g, b, ang);
}

// 切妻屋根。棟は間口（u）の向き。妻壁は wallHex
function skGable(S, F, w, d, y, rh, eave, roofHex, wallHex) {
  const hw = w / 2, hd = d / 2;
  const R1 = F(-hw - eave, 0, y + rh), R2 = F(hw + eave, 0, y + rh);
  const e1 = F(-hw - eave, -hd - eave, y - eave * 0.5), e2 = F(hw + eave, -hd - eave, y - eave * 0.5);
  const e3 = F(hw + eave, hd + eave, y - eave * 0.5), e4 = F(-hw - eave, hd + eave, y - eave * 0.5);
  skQuad(S, e1, R1, R2, e2, roofHex);
  skQuad(S, e3, R2, R1, e4, roofHex);
  skTri(S, F(hw, -hd, y), F(hw, 0, y + rh), F(hw, hd, y), wallHex);
  skTri(S, F(-hw, hd, y), F(-hw, 0, y + rh), F(-hw, -hd, y), wallHex);
}

// 寄棟屋根（四方に流れる）。w===d なら方形（ピラミッド）
function skHip(S, F, w, d, y, rh, eave, roofHex) {
  const hw = w / 2 + eave, hd = d / 2 + eave;
  const ridge = Math.max(hw - hd, 0);
  const y0 = y - eave * 0.5;
  const A = F(-hw, -hd, y0), B = F(hw, -hd, y0), C = F(hw, hd, y0), D = F(-hw, hd, y0);
  const R1 = F(-ridge, 0, y + rh), R2 = F(ridge, 0, y + rh);
  skQuad(S, A, R1, R2, B, roofHex);
  skQuad(S, C, R2, R1, D, roofHex);
  skTri(S, B, R2, C, roofHex);
  skTri(S, D, R1, A, roofHex);
}

// n角の錐台（r1=0 なら錐）。上面も張る
function skPrism(S, cx, cz, y0, h, r0, r1, n, hex) {
  const top = y0 + h;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const b0 = [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0];
    const b1 = [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0];
    const t0 = [cx + Math.cos(a0) * r1, top, cz + Math.sin(a0) * r1];
    const t1 = [cx + Math.cos(a1) * r1, top, cz + Math.sin(a1) * r1];
    if (r1 > 0) {
      skQuad(S, b0, t0, t1, b1, hex);
      skTri(S, [cx, top, cz], t1, t0, hex);
    } else skTri(S, b0, [cx, top, cz], b1, hex);
  }
}

// 半球の丸屋根（n 分割・rings 段）
function skDome(S, cx, cz, y0, r, n, rings, hex) {
  for (let k = 0; k < rings; k++) {
    const p0 = (k / rings) * Math.PI / 2, p1 = ((k + 1) / rings) * Math.PI / 2;
    const r0 = Math.cos(p0) * r, r1 = Math.cos(p1) * r;
    const y0k = y0 + Math.sin(p0) * r, y1k = y0 + Math.sin(p1) * r;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const b0 = [cx + Math.cos(a0) * r0, y0k, cz + Math.sin(a0) * r0];
      const b1 = [cx + Math.cos(a1) * r0, y0k, cz + Math.sin(a1) * r0];
      const t0 = [cx + Math.cos(a0) * r1, y1k, cz + Math.sin(a0) * r1];
      const t1 = [cx + Math.cos(a1) * r1, y1k, cz + Math.sin(a1) * r1];
      if (k < rings - 1) skQuad(S, b0, t0, t1, b1, hex);
      else skTri(S, b0, [cx, y0 + r, cz], b1, hex);
    }
  }
}

// --- 建物1軒 ---------------------------------------------------------------------
//
// y0 は地面の高さ（ローカル）。斜面で浮かないよう、壁は地面より3m下から立てる。
// lights へは夜の窓明かり [x, y, z, r, g, b] を積む（rand は灯りの色のゆらぎ）。
function cityShapeBuilding(S, bld, y0, lights, rand) {
  const { x, z, w, d, h, ang } = bld;
  const warm = () => { const k = 0.7 + rand() * 0.3; return [k, k * 0.66, k * 0.34]; };
  if (bld.kind === 'tower') {
    // 基壇・胴・頭の3段。上ほど細く
    const glass = bld.skin || 0x55626c;   // 外装の色は気候で決まっている（03j-city-layout.js）
    const podH = Math.min(h * 0.12, 18);
    skBox(S, x, y0 - 3, z, w, podH + 3, d, ang, bld.color);
    const midTop = h * 0.72;
    skBox(S, x, y0 + podH, z, w * 0.82, midTop - podH, d * 0.82, ang, glass);
    skBox(S, x, y0 + midTop, z, w * 0.64, h - midTop, d * 0.64, ang, glass);
    // 頭の帯（明るい縁取り）
    skBox(S, x, y0 + h, z, w * 0.66, 2.5, d * 0.66, ang, CITY_CONCRETE);
    if (bld.spire > 0) skPrism(S, x, z, y0 + h + 2.5, bld.spire, Math.min(w, d) * 0.1, 0, 6, CITY_CONCRETE);
    // 窓明かりを高さに沿って、いちばん上には航空障害灯（赤）
    for (let yy = 12; yy < h; yy += 26) {
      const c = warm();
      const a = rand() * Math.PI * 2, rr = Math.min(w, d) * 0.45;
      lights.push(x + Math.cos(a) * rr, y0 + yy, z + Math.sin(a) * rr, c[0], c[1], c[2]);
    }
    lights.push(x, y0 + h + 3 + (bld.spire || 0), z, 1, 0.1, 0.05);
    return;
  }
  skBox(S, x, y0 - 3, z, w, h + 3, d, ang, bld.color);
  const F = skFrame(x, z, ang);
  const top = y0 + h;
  if (bld.roof === 'gable') skGable(S, F, w, d, top, bld.roofH, 0.6, bld.roofColor, bld.color);
  else if (bld.roof === 'hip') skHip(S, F, w, d, top, bld.roofH, bld.kind === 'house' ? 0.9 : 0.5, bld.roofColor);
  else if (bld.kind === 'block' && h > 14 && ((x * 31 + z * 17) & 1)) {
    // 平屋根の中層は屋上に機械室を載せる（半分ほど）
    skBox(S, x + w * 0.12, top, z, w * 0.3, 3, d * 0.3, ang, CITY_CONCRETE);
  }
  for (let k = 0; k < 2; k++) {
    const c = warm();
    lights.push(x, y0 + (k === 0 ? h * 0.9 : CITY_LIGHT_Y * 0.4), z, c[0], c[1], c[2]);
  }
}

// --- 名所 -------------------------------------------------------------------------
function cityShapeLandmark(S, m, y0, lights, country) {
  const { x, z, ang, r, h } = m;
  const F = skFrame(x, z, ang);
  const flood = (yy) => lights.push(x, y0 + yy, z, 1, 0.82, 0.55);
  switch (m.kind) {
    case 'spire': {
      // 身廊（切妻）と、正面の塔の上の尖塔
      const L = r * 1.6, W = r * 0.75, H = h * 0.26;
      skBox(S, x, y0 - 3, z, L, H + 3, W, ang, CITY_STONE);
      skGable(S, F, L, W, y0 + H, W * 0.6, 0.4, 0x3d3a38, CITY_STONE);
      const [tx, , tz] = F(-L / 2 - r * 0.18, 0, 0);
      const tw = r * 0.42, tH = h * 0.55;
      skBox(S, tx, y0 - 3, tz, tw, tH + 3, tw, ang, CITY_STONE);
      skHip(S, skFrame(tx, tz, ang), tw, tw, y0 + tH, h - tH, 0.2, 0x39403f);
      flood(tH * 0.5);
      break;
    }
    case 'dome':
    case 'minarets': {
      const gold = country === 'kaldis';
      const base = r * (m.kind === 'dome' ? 1.35 : 1.1), bH = h * 0.32;
      skBox(S, x, y0 - 3, z, base, bH + 3, base, ang, m.kind === 'minarets' ? 0x7e725c : CITY_STONE);
      const dr = base * 0.36;
      skPrism(S, x, z, y0 + bH, h * 0.1, dr * 1.02, dr * 1.02, 12, m.kind === 'minarets' ? 0x7e725c : CITY_STONE);
      skDome(S, x, z, y0 + bH + h * 0.1, dr, 12, 4, gold ? 0x8a7440 : 0x4f7a68);
      skPrism(S, x, z, y0 + bH + h * 0.1 + dr, dr * 0.5, dr * 0.12, 0, 6, gold ? 0x8a7440 : 0x4f7a68);
      if (m.kind === 'minarets') {
        for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const [mx, , mz] = F(su * (base / 2 + 3), sv * (base / 2 + 3), 0);
          skPrism(S, mx, mz, y0 - 2, h + 2, 2.2, 1.8, 8, 0x8a8068);
          skPrism(S, mx, mz, y0 + h, 7, 2.2, 0, 8, gold ? 0x8a7440 : 0x6a6456);
          lights.push(mx, y0 + h * 0.8, mz, 1, 0.85, 0.6);
        }
      }
      flood(bH);
      break;
    }
    case 'pagoda': {
      // 5重。上ほど小さく、各層に軒の深い屋根
      const levels = 5, lh = h * 0.16;
      let size = r * 1.1;
      for (let i = 0; i < levels; i++) {
        const yb = y0 + i * lh;
        skBox(S, x, yb - (i === 0 ? 3 : 0), z, size, lh * 0.55 + (i === 0 ? 3 : 0), size, ang, 0x6e2a22);
        skHip(S, F, size, size, yb + lh * 0.55, lh * 0.45, size * 0.28, 0x2f3336);
        size *= 0.84;
      }
      skPrism(S, x, z, y0 + levels * lh, h - levels * lh, 0.9, 0.3, 6, 0x6a5a3a);
      flood(lh * 2);
      break;
    }
    case 'campanile': {
      const tw = r * 0.9, tH = h * 0.78;
      skBox(S, x, y0 - 3, z, tw, tH + 3, tw, ang, 0x7a6a58);
      // 鐘の部屋（少し太い）と四角錐の屋根
      skBox(S, x, y0 + tH, z, tw * 1.08, h * 0.08, tw * 1.08, ang, 0x857563);
      skHip(S, F, tw * 1.08, tw * 1.08, y0 + tH + h * 0.08, h * 0.14, 0.4, 0x6e3a2c);
      flood(tH * 0.6);
      break;
    }
    case 'tvtower': {
      // 細い胴と、上の方の展望台（2段）とアンテナ
      const podY = h * 0.62;
      skPrism(S, x, z, y0 - 3, podY + 3, 9, 5, 12, CITY_CONCRETE);
      skPrism(S, x, z, y0 + podY, h * 0.18, 5, 4, 12, CITY_CONCRETE);
      skPrism(S, x, z, y0 + podY, 5, 10, 18, 16, 0x5a5e64);
      skPrism(S, x, z, y0 + podY + 5, 9, 18, 18, 16, 0x3c4854);
      skPrism(S, x, z, y0 + podY + 14, 4, 18, 9, 16, 0x5a5e64);
      skPrism(S, x, z, y0 + podY + h * 0.18, h * 0.2, 2.2, 0.6, 6, 0x9a9ca0);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        lights.push(x + Math.cos(a) * 18.5, y0 + podY + 9, z + Math.sin(a) * 18.5, 1, 0.85, 0.6);
      }
      lights.push(x, y0 + h, z, 1, 0.1, 0.05);
      lights.push(x, y0 + podY + h * 0.18, z, 1, 0.1, 0.05);
      break;
    }
    default:
      break;
  }
}
