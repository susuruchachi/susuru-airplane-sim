// 03i-roads.js — 街と街・街と空港を結ぶ道路
//
// 経路は js/env/03b-world.js が持っている（WORLD_ROADS）。傾斜と水にコストを付けた
// A* で、山と川をよけて引いてある。ここはそれを見て地形の上に帯を敷くだけ。
//
// **地形は刻まない。** 道路の幅は26mで、いちばん細かいLODでも地形の頂点間隔は312m。
// 刻んでも再現できないので、滑走路の路面標識と同じく、地形メッシュの上に
// デカールとして重ねる。高さは terrainSurfaceHeightAtLod で「実際に描かれている
// メッシュの高さ」から取る——worldHeightAt の値を使うと、地形が格子点の間を
// 三角形で結んでいるぶんだけ道が浮いたり地面に潜ったりする。

// 道は100km以上に伸びるので、川と同じく経路の点との最短距離で出し入れを決める。
// 幅26mは10kmで2.3px、30kmで0.8pxなので、それより遠くは出しても見えない。
const ROAD_ACTIVE_RADIUS_BASE = 55000;
const ROAD_ACTIVE_RADIUS_MIN = 18000;
// 地形メッシュの折れ面より少しだけ上に浮かせる。深度バイアスだけだと、
// 遠方の粗いLODで地形が道を突き抜けて、道がまだらに途切れる。
const ROAD_LIFT_M = 1.2;
// 経路の点をそのまま頂点にすると、遠くの道まで細かい帯になって頂点が増える。
// 距離に応じて間引く。
const ROAD_STEP_NEAR_M = 400;
const ROAD_STEP_FAR_M = 2000;
// 向きがこれだけ変わる点は、間引かずに残す（角を斜めに切らないように）
const ROAD_KEEP_TURN_DEG = 12;

// --- 街灯 -------------------------------------------------------------------
// 夜に道路が消えると、街と街のあいだが真っ暗になって世界が途切れて見える。
// 建物を置くと重いので、街と同じ「加算で重ねる点」で灯りだけ出す。
// 明るさは街明かりに合わせる（道路灯だけ目立つと高速道路の絵にならない）。
// 実際に並んでいた間隔（平均916m）の3倍の密度にしたあと、「道路を街と同じくらいに
// 見えるように明るく」で、もう一段詰めて濃くした（数字は下の説明）。
const ROAD_LAMP_SPACING_M = 200;   // 街灯の間隔
const ROAD_LAMP_Y = 9;             // 路面からの高さ
const ROAD_LAMP_SIZE = 26;         // 街の灯り（03d-places.js）と同じ大きさ
// 街灯を出す範囲。道の帯と同じところまで出す（26kmで切っていたので、上空から
// 見下ろすと遠くの道が暗い地面に溶けていた）。
const ROAD_LAMP_RADIUS_BASE = 55000;
// 街の灯りと同じ強さ（03d-places.js は opacity をそのまま 0〜1 で使っている）。
const ROAD_LAMP_OPACITY = 1.0;
// 街灯のにじみ。芯の何倍の大きさで、どれだけ薄く重ねるか（空港の灯火は2.8倍・0.10）。
const ROAD_LAMP_GLOW_SCALE = 3.4;
const ROAD_LAMP_GLOW_OPACITY = 0.22;
// 夜の路面の明るさ（自己発光の色）。灯りに照らされた路面の、暖かい色。
// 遠くでは街灯の点が1画素より小さくなって消えるので、**路面そのものが光る線**として
// 見えないと、上空からは道が地面に溶ける（ROAD_LAMP_* の説明の実測を参照）。
const ROAD_NIGHT_EMISSIVE = 0x5a4424;

// --- 橋 ---------------------------------------------------------------------
// 位置と高さは世界側（03b-world.js の worldRoadBridges）が決める。ここは形だけ。
const ROAD_STEP_BRIDGE_M = 60;       // 橋の中の頂点の間隔（間引かない）
const BRIDGE_DECK_THICK_M = 2.2;     // 桁の厚み
const BRIDGE_PARAPET_H_M = 1.1;      // 欄干の高さ
const BRIDGE_PIER_SPACING_M = 48;    // 橋脚の間隔
const BRIDGE_PIER_LEN_M = 3;         // 橋脚の厚み（道に沿った向き）
const BRIDGE_COLOR = 0x6f6b64;       // コンクリート

// 経路に沿った距離 s が、どれかの橋（取付け部を含む）から margin 以内か
function roadOnBridge(road, s, margin) {
  if (!road.bridges) return false;
  for (const b of road.bridges) if (s >= b.s0 - margin && s <= b.s3 + margin) return true;
  return false;
}

// 橋の構造（桁の厚み・欄干・橋脚・取付け部の擁壁）を1つのメッシュにまとめる。
// 路面そのものは道の帯がそのまま橋の上を通る。
//   rows … 道の帯の断面の列（中心・左右の縁・その高さ・縁の地面の高さ・距離 s）
function buildBridgeStructure(rows, bridges, ox, oy, oz) {
  const pos = [];
  const quad = (a, b, c, d) => {
    pos.push(a[0] - ox, a[1] - oy, a[2] - oz, b[0] - ox, b[1] - oy, b[2] - oz, c[0] - ox, c[1] - oy, c[2] - oz);
    pos.push(a[0] - ox, a[1] - oy, a[2] - oz, c[0] - ox, c[1] - oy, c[2] - oz, d[0] - ox, d[1] - oy, d[2] - oz);
  };
  const deckOf = (s) => {
    for (const b of bridges) if (s >= b.s1 - 0.01 && s <= b.s2 + 0.01) return b;
    return null;
  };
  const elevated = (r) => r.prof > Math.min(r.gl, r.gr) + ROAD_LIFT_M + 0.3;

  let pierNext = null;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    const sm = (a.s + b.s) / 2;
    // 材質は両面（DoubleSide）なので、面の向きはそろえなくてよい
    const deck = deckOf(sm);
    const up = deck || (elevated(a) || elevated(b));
    if (!up) continue;
    const AL = [a.lx, a.yl, a.lz], AR = [a.rx, a.yr, a.rz], BL = [b.lx, b.yl, b.lz], BR = [b.rx, b.yr, b.rz];
    // 欄干（両側）
    const H = BRIDGE_PARAPET_H_M;
    quad(AL, BL, [b.lx, b.yl + H, b.lz], [a.lx, a.yl + H, a.lz]);
    quad(AR, BR, [b.rx, b.yr + H, b.rz], [a.rx, a.yr + H, a.rz]);
    if (deck) {
      // 桁：側面2枚と裏面
      const T = BRIDGE_DECK_THICK_M;
      const aL = [a.lx, a.yl - T, a.lz], aR = [a.rx, a.yr - T, a.rz];
      const bL = [b.lx, b.yl - T, b.lz], bR = [b.rx, b.yr - T, b.rz];
      quad(AL, BL, bL, aL);
      quad(AR, BR, bR, aR);
      quad(aL, bL, bR, aR);
      // 橋脚：桁の下から地面（川底）まで。水際の外（陸の上）にも同じ間隔で立てる
      if (pierNext === null || pierNext < a.s - BRIDGE_PIER_SPACING_M) pierNext = deck.s1 + BRIDGE_PIER_SPACING_M * 0.5;
      while (pierNext >= a.s && pierNext < b.s) {
        const t = (pierNext - a.s) / ((b.s - a.s) || 1);
        const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
        const top = (a.yl + a.yr) / 2 + ((b.yl + b.yr) / 2 - (a.yl + a.yr) / 2) * t - T;
        const bottom = worldHeightAt(cx, cz) - 2;
        if (top - bottom > 1) {
          // 道の向きと横向き
          let dx = b.x - a.x, dz = b.z - a.z;
          const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
          const hw = Math.hypot(a.lx - a.rx, a.lz - a.rz) * 0.32; // 桁の幅の6割強
          const hl = BRIDGE_PIER_LEN_M / 2;
          const px = -dz, pz = dx;
          const c = (u, v, y) => [cx + dx * u + px * v, y, cz + dz * u + pz * v];
          const corners = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]];
          for (let k = 0; k < 4; k++) {
            const [u0, v0] = corners[k], [u1, v1] = corners[(k + 1) % 4];
            quad(c(u0, v0, bottom), c(u1, v1, bottom), c(u1, v1, top), c(u0, v0, top));
          }
        }
        pierNext += BRIDGE_PIER_SPACING_M;
      }
    } else {
      // 取付け部（盛土）の擁壁：路面の縁から地面まで
      quad(AL, BL, [b.lx, b.gl - 1, b.lz], [a.lx, a.gl - 1, a.lz]);
      quad(AR, BR, [b.rx, b.gr - 1, b.rz], [a.rx, a.gr - 1, a.rz]);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  // 街（03d-places.js）が道路より先に作られることもあるので、材質はここで用意する
  if (!EnvState.bridgeMaterial) {
    EnvState.bridgeMaterial = new THREE.MeshLambertMaterial({ color: BRIDGE_COLOR, side: THREE.DoubleSide });
  }
  const mesh = new THREE.Mesh(geo, EnvState.bridgeMaterial);
  mesh.position.set(ox, oy, oz);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

// --- 道沿いの家 ---------------------------------------------------------------
//
// 街と街のあいだが、道が1本通っているだけの無人の野原に見えないよう、道沿いに家を建てる。
// 実際の街道と同じく、家は**村のまとまり**になって並び、そのあいだはぽつぽつと農家があるだけ。
//   村 … 道に沿ったなめらかなノイズが高いところ。道の両側に HOUSE_STEP_M おきに高い確率で
//   郊外 … 街の市街地のすぐ外。村と同じくらい建つ
//   ほか … まれに1軒
// 置き場所は道の経路（間引く前の点）とハッシュだけで決まるので、何度作り直しても同じ家が同じ所に建つ。
// 水の上・橋のたもと・空港・ほかの道の上・急な斜面・街の市街地（街の建物がある）には建てない。
const HOUSE_RADIUS_M = 14000;        // カメラからこれより遠い家は建てない（家は小さい）
const HOUSE_STEP_M = 40;             // 道に沿って家を置く候補の間隔
const HOUSE_SETBACK_M = 8;           // 道の縁から家までの最低の距離
const HOUSE_VILLAGE_P = 0.7;         // 村・郊外で1候補に家が建つ確率
const HOUSE_SCATTER_P = 0.025;       // 村の外で建つ確率
const HOUSE_VILLAGE_NOISE = 0.64;    // 道に沿ったノイズがこれより高いところが村
const HOUSE_VILLAGE_SCALE_M = 1400;  // 村の長さのめやす
const HOUSE_SUBURB_M = 2500;         // 市街地の外のこの距離までは郊外
const HOUSE_MAX_TILT_M = 2.5;        // 間口の四隅の高さの差がこれを超える斜面には建てない
const HOUSE_LIGHT_OPACITY = 0.85;
const HOUSE_WALL_COLORS = [0xb9b1a4, 0xc4bca9, 0xa9a397, 0xbdb3a0, 0x9f998d];
const HOUSE_ROOF_COLORS = [0x8a4632, 0x6e3a2c, 0x55504a, 0x5d544a, 0x9a5a38];

function buildRoadHouses(road, src, ox, oy, oz) {
  if (!_roadHouseReady()) return null;
  const cam = EnvState.camera.position;
  const R2 = HOUSE_RADIUS_M * HOUSE_RADIUS_M;
  const seed = _roadHash(road.id);
  const pos = [], nrm = [], col = [], lights = [];

  let s = 0, next = HOUSE_STEP_M * 0.5, k = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-3) continue;
    const dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
    for (; next <= s + L; next += HOUSE_STEP_M, k++) {
      const t = (next - s) / L;
      const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
      if ((cx - cam.x) * (cx - cam.x) + (cz - cam.z) * (cz - cam.z) > R2) continue;
      if (roadOnBridge(road, next, 120)) continue;
      const p = _roadHouseChance(road, next, seed, cx, cz);
      if (p <= 0) continue;
      for (const side of [1, -1]) {
        const h1 = worldHash2i(seed + k, side > 0 ? 17 : 41);
        if (h1 >= p) continue;
        const h2 = worldHash2i(seed + k, side > 0 ? 53 : 71);
        const h3 = worldHash2i(seed + k, side > 0 ? 89 : 97);
        const h4 = worldHash2i(seed + k, side > 0 ? 101 : 113);
        const w = 8 + h2 * 6;          // 間口（道に沿った向き）
        const d = 7 + h3 * 5;          // 奥行き
        const wallH = 4.5 + h4 * 2.5;
        const roofH = 2.4 + h2 * 1.4;
        const off = road.halfWidth + HOUSE_SETBACK_M + d / 2 + h3 * 14;
        const along = (h4 - 0.5) * 20;
        const hx = cx + dx * along - dz * off * side;
        const hz = cz + dz * along + dx * off * side;
        const placed = _roadHousePlace(hx, hz, dx, dz, w, d);
        if (placed === null) continue;
        const wall = HOUSE_WALL_COLORS[(h2 * HOUSE_WALL_COLORS.length) | 0];
        const roof = HOUSE_ROOF_COLORS[(h3 * HOUSE_ROOF_COLORS.length) | 0];
        _pushHouse(pos, nrm, col, hx - ox, placed - oy, hz - oz, dx, dz, w, d, wallH, roofH, wall, roof);
        if (h1 < p * 0.6) {
          // 窓の灯り（道の側の壁の前に1つ）
          lights.push(hx - ox + dz * side * (d / 2 + 0.6), placed - oy + 2.6, hz - oz - dx * side * (d / 2 + 0.6));
        }
      }
    }
    s += L;
  }
  if (!pos.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.computeBoundingSphere();
  if (!EnvState.houseMaterial) {
    EnvState.houseMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    EnvState.houseLightMaterial = new THREE.PointsMaterial({
      size: 14, map: _roadLampTexture, sizeAttenuation: true, color: 0xffcf8a,
      transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    if (EnvState.roadDayFactor !== undefined) updateRoadsForDaylight(EnvState.roadDayFactor);
  }
  const mesh = new THREE.Mesh(geo, EnvState.houseMaterial);
  mesh.position.set(ox, oy, oz);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  if (lights.length) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lights), 3));
    lg.computeBoundingSphere();
    const pts = new THREE.Points(lg, EnvState.houseLightMaterial);
    pts.renderOrder = ENV_ORDER.light;
    pts.matrixAutoUpdate = false;
    mesh.add(pts);
  }
  return mesh;
}

function _roadHouseReady() {
  return typeof worldHash2i === 'function' && typeof worldRoadEdgeDistance === 'function';
}

function _roadHash(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 1000003;
}

// 経路に沿った距離 s のところに家が建つ確率（村・郊外・それ以外）。市街地の中は0
function _roadHouseChance(road, s, seed, x, z) {
  let suburb = false;
  for (const c of WORLD_CITIES) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < c.builtRadiusM) return 0;                     // 街の建物がある
    if (d < c.builtRadiusM + HOUSE_SUBURB_M) suburb = true;
  }
  if (suburb) return HOUSE_VILLAGE_P;
  const v = worldValueNoise(s / HOUSE_VILLAGE_SCALE_M + (seed % 997) * 0.37, (seed % 131) * 1.7);
  return v > HOUSE_VILLAGE_NOISE ? HOUSE_VILLAGE_P : HOUSE_SCATTER_P;
}

// 家を建てられるなら土台の高さ（描かれている地面の、四隅のうち低いところ）を返す。だめなら null
function _roadHousePlace(x, z, dx, dz, w, d) {
  // ほかの道・同じ道の上にかからない（カーブの内側に置いた家が道にかかる）
  if (worldRoadEdgeDistance(x, z) < Math.max(w, d) * 0.6 + 4) return null;
  if (typeof worldAirportRoadBlock === 'function' && worldAirportRoadBlock(x, z, 250)) return null;
  const near = worldNearestAirport(x, z);
  if (near && near.airport && near.distanceM < near.airport.flatInnerR) return null;
  let lo = Infinity, hi = -Infinity;
  const hw = w / 2, hd = d / 2;
  for (const [u, v] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, 0]]) {
    const px = x + dx * u - dz * v, pz = z + dz * u + dx * v;
    const g = roadGroundY(px, pz);
    if (g <= 0.5) return null;                              // 海
    const wtr = worldWaterSurfaceAt(px, pz);
    if (wtr !== null && wtr > g - 0.3) return null;         // 川・湖
    lo = Math.min(lo, g); hi = Math.max(hi, g);
  }
  if (hi - lo > HOUSE_MAX_TILT_M) return null;
  return lo - 0.8; // 斜面で浮かないよう、低いほうの角より少し埋める
}

// 家1軒（箱の壁＋切妻屋根）。棟は道に沿った向き（dx, dz）。底面は描かない。
function _pushHouse(pos, nrm, col, x, y, z, dx, dz, w, d, wallH, roofH, wallHex, roofHex) {
  const px = -dz, pz = dx; // 奥行きの向き
  const P = (u, v, h) => [x + dx * u + px * v, y + h, z + dz * u + pz * v];
  const hw = w / 2, hd = d / 2;
  const top = wallH + 0.8; // 土台を埋めたぶん
  const tri = (a, b, c, hex, shade) => {
    const r = ((hex >> 16) & 255) / 255 * shade, g = ((hex >> 8) & 255) / 255 * shade, bl = (hex & 255) / 255 * shade;
    // 面の法線（外向きになるよう、呼ぶ側で反時計回りに並べる）
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    for (const q of [a, b, c]) { pos.push(q[0], q[1], q[2]); nrm.push(nx, ny, nz); col.push(r, g, bl); }
  };
  const quad = (a, b, c, e, hex, shade) => { tri(a, b, c, hex, shade); tri(a, c, e, hex, shade); };
  const A = P(-hw, -hd, 0), B = P(hw, -hd, 0), C = P(hw, hd, 0), D = P(-hw, hd, 0);
  const A2 = P(-hw, -hd, top), B2 = P(hw, -hd, top), C2 = P(hw, hd, top), D2 = P(-hw, hd, top);
  // 壁4面（外から見て反時計回り）
  quad(A, B, B2, A2, wallHex, 0.92);
  quad(B, C, C2, B2, wallHex, 0.8);
  quad(C, D, D2, C2, wallHex, 0.92);
  quad(D, A, A2, D2, wallHex, 0.8);
  // 屋根：棟は道に沿う。軒を少し出す
  const eave = 0.6;
  const R1 = P(-hw - eave, 0, top + roofH), R2 = P(hw + eave, 0, top + roofH);
  const e1 = P(-hw - eave, -hd - eave, top - 0.4), e2 = P(hw + eave, -hd - eave, top - 0.4);
  const e3 = P(hw + eave, hd + eave, top - 0.4), e4 = P(-hw - eave, hd + eave, top - 0.4);
  quad(e1, e2, R2, R1, roofHex, 1.0);
  quad(e3, e4, R1, R2, roofHex, 0.85);
  // 妻壁（三角）
  tri(P(hw, -hd, top), P(hw, hd, top), P(hw, 0, top + roofH - 0.2), wallHex, 0.8);
  tri(P(-hw, hd, top), P(-hw, -hd, top), P(-hw, 0, top + roofH - 0.2), wallHex, 0.8);
}

function roadActiveRadius() {
  // 03h-env-quality.js はこのファイルより後に読まれるので、呼ばれる時点では
  // 必ずあるが、念のため（他の実体化半径と同じ書き方）
  const scale = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.max(ROAD_ACTIVE_RADIUS_BASE * scale, ROAD_ACTIVE_RADIUS_MIN);
}

function initRoads() {
  EnvState.roadGroup = new THREE.Group();
  EnvState.scene.add(EnvState.roadGroup);
  EnvState.builtRoads = new Map();

  // 舗装の色。地表より暗く、けれど影に沈まない程度に。
  EnvState.roadMaterial = new THREE.MeshLambertMaterial({
    color: 0x2b2926, vertexColors: false,
  });
  EnvState.roadMaterial.polygonOffset = true;
  EnvState.roadMaterial.polygonOffsetFactor = -6;
  EnvState.roadMaterial.polygonOffsetUnits = -6;

  // 街灯。道どうしで共有する（道の出し入れのたびに作り直さない）。
  // 街の灯り（03d-places.js）と同じ加算合成で、昼は opacity 0 にして消す。
  if (!_roadLampTexture) _roadLampTexture = buildRoadLampTexture();
  EnvState.roadLampMaterial = new THREE.PointsMaterial({
    size: ROAD_LAMP_SIZE, map: _roadLampTexture, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true,
    color: 0xffd9a0,
  });
  EnvState.roadLampGlowMaterial = new THREE.PointsMaterial({
    size: ROAD_LAMP_SIZE * ROAD_LAMP_GLOW_SCALE, map: _roadLampTexture, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true,
    color: 0xffc56a,
  });

  refreshRoads();
}

// 街灯の点の絵（中心が明るく外へ向かって消える円）。街の灯りと同じ作り。
let _roadLampTexture = null;
function buildRoadLampTexture() {
  const size = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,225,180,0.55)');
  grad.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function roadLampRadius() {
  const scale = typeof envQualityPreset === 'function' ? envQualityPreset().distance : 1;
  return Math.max(ROAD_LAMP_RADIUS_BASE * scale, 9000);
}

function refreshRoads() {
  if (!EnvState.builtRoads) return;
  const cam = EnvState.camera.position;
  const R = roadActiveRadius();

  for (const road of WORLD_ROADS) {
    const near = roadNearCamera(road, cam, R);
    const built = EnvState.builtRoads.has(road.id);
    if (near && !built) buildRoadInstance(road);
    else if (!near && built) disposeRoadInstance(road.id);
  }
}

function roadNearCamera(road, cam, R) {
  const r2 = (R + 8000) * (R + 8000);
  for (let i = 0; i < road.points.length; i += 2) {
    const p = road.points[i];
    const dx = p.x - cam.x, dz = p.z - cam.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

function disposeRoadInstance(id) {
  const e = EnvState.builtRoads.get(id);
  if (!e) return;
  EnvState.roadGroup.remove(e.strip);
  e.strip.geometry.dispose();
  if (e.lamps) {
    EnvState.roadGroup.remove(e.lamps);
    e.lamps.geometry.dispose();   // マテリアルは道で共有しているので dispose しない
  }
  if (e.bridge) {
    EnvState.roadGroup.remove(e.bridge);
    e.bridge.geometry.dispose();
  }
  if (e.houses) {
    EnvState.roadGroup.remove(e.houses);
    e.houses.geometry.dispose();
    for (const c of e.houses.children) c.geometry.dispose(); // 窓の灯り
  }
  EnvState.builtRoads.delete(id);
}

// 滑走路の向きをUIで変えた空港は、ターミナルも一緒に回る（04b-airport.js は空港全体を
// 1つのグループとして回している）。世界側の経路は定義の向きで引いてあるので、
// そのままだと道路が元の車寄せ——回ったあとは草地や滑走路の脇——に着いてしまう。
// **空港のまわりへ入る手前で経路を切り、空港を中心にした円弧で回り込んでから、
// 今の向きの取り付き点→車寄せへまっすぐ入れる。** 円弧の半径は取り付き点までの
// 距離（約3.5km）で、舗装のある範囲（滑走路の半分＋450m 程度）より必ず外を通る。
// 向きを変えていない空港は、世界側の経路をそのまま使う（検証ツールが見ているのと同じ形）。
const ROAD_RETURN_ARC_STEP_M = 300;
function roadRoutePoints(road) {
  if (!road.airportId || !EnvState.airportSettings) return road.points;
  const a = worldAirportById(road.airportId);
  const st = a && EnvState.airportSettings[a.id];
  if (!st || Math.abs(st.headingDeg - a.headingDeg) < 0.01) return road.points;

  const cur = Object.assign({}, a, { headingDeg: st.headingDeg });
  const via = airportLocalToWorld(cur, a.terminalLocalX, a.gateLocalZ + ROAD_AIRPORT_APPROACH_M);
  const gate = worldAirportGateAt(cur);
  const src = road.points;
  const r = Math.hypot(via.x - a.x, via.z - a.z);

  // 空港のまわり（半径 r より少し外）へ入る手前の点まで元の経路を使う
  let cut = src.length - 2;
  while (cut > 0 && Math.hypot(src[cut].x - a.x, src[cut].z - a.z) < r + 600) cut--;
  const out = src.slice(0, cut + 1);
  const p = src[cut];
  const a0 = Math.atan2(p.z - a.z, p.x - a.x);
  const a1 = Math.atan2(via.z - a.z, via.x - a.x);
  let da = a1 - a0;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil((Math.abs(da) * r) / ROAD_RETURN_ARC_STEP_M));
  for (let k = 0; k <= steps; k++) {
    const t = a0 + (da * k) / steps;
    out.push({ x: a.x + Math.cos(t) * r, z: a.z + Math.sin(t) * r });
  }
  out.push(gate);
  return out;
}

// 描かれている地形メッシュの高さ（terrainSurfaceHeightAtLod と同じ式）。
// 道の頂点は地形の格子線の上に並ぶので、隣どうしで同じ格子点の高さを何度も引く。
// 格子点の高さを覚えておくと、worldHeightAt を呼ぶ回数が数分の一になる
// （地形は時間で変わらないので、覚えた値はずっと正しい。増えすぎたら捨てる）。
const _roadHeightCache = new Map();
function roadVertexHeight(i, j, step) {
  const key = step * 1e12 + (i + 50000) * 100000 + (j + 50000);
  let h = _roadHeightCache.get(key);
  if (h === undefined) {
    if (_roadHeightCache.size > 400000) _roadHeightCache.clear();
    h = worldHeightAt(i * step, j * step);
    _roadHeightCache.set(key, h);
  }
  return h;
}
function roadGroundY(x, z) {
  const step = TERRAIN_TILE_SIZE / terrainLodAt(x, z);
  const i = Math.floor(x / step), j = Math.floor(z / step);
  const tu = x / step - i, tv = z / step - j;
  const h00 = roadVertexHeight(i, j, step);
  const h10 = roadVertexHeight(i + 1, j, step);
  const h01 = roadVertexHeight(i, j + 1, step);
  if (tu + tv <= 1) return h00 + (h10 - h00) * tu + (h01 - h00) * tv;
  const h11 = roadVertexHeight(i + 1, j + 1, step);
  return h11 + (h01 - h11) * (1 - tu) + (h10 - h11) * (1 - tv);
}

// 線分 a→b が地形メッシュの三角形の辺（x・z の格子線と、tu+tv=1 の斜めの線）を
// 横切る位置を 0〜1 の媒介変数で返す。
function roadGridCrossings(ax, az, bx, bz, step, out) {
  const cross = (u0, u1) => {
    // u = 格子線の番号を連続値にしたもの。整数をまたぐところが交点
    if (u0 === u1) return;
    const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
    for (let k = Math.floor(lo) + 1; k < hi; k++) out.push((k - u0) / (u1 - u0));
  };
  cross(ax / step, bx / step);
  cross(az / step, bz / step);
  cross((ax + az) / step, (bx + bz) / step);
}

// 経路に沿って左右へ幅を振り、帯状のメッシュにする（川の水面と同じ作り）。
//
// **地形の三角形の辺ごとに頂点を足す。** 地形は約310m間隔の格子を三角形で張った
// 折れ面で、道の頂点を400m間隔に置くと、そのあいだにある地形の頂点（尾根側に
// 折れた所）を道が弦で素通りして、わずかな起伏でも道が地面に潜っていた。
// 道の中心線と左右の縁が格子線を横切る位置すべてに頂点を置けば、帯は地形と同じ
// 折れ面の上に乗る（あとは ROAD_LIFT_M 浮かせるだけで潜らない）。
// 左右の縁は **それぞれの位置で** 高さを取る——中心の高さを縁にも使うと、
// 横に傾いた斜面で山側の縁が地面に埋まる。
function buildRoadInstance(road) {
  const cam = EnvState.camera.position;
  const src = roadRoutePoints(road);

  // カメラからの距離で間引く。近い所は細かく、遠い所は粗く。
  //
  // **曲がり角は間引かない。** 距離だけで間引くと角の点が飛ばされ、帯が角を斜めに
  // 切ってしまう。特に空港の支線は、取り付き点で車寄せへ向かって曲がるので、
  // その点が飛ぶと帯は車寄せへ斜めに入り、実際の経路（と、その上の街灯）から
  // 最大289mずれていた（「道路と街灯の位置がずれている、とくに空港の車寄せ」）。
  // 向きが ROAD_KEEP_TURN_DEG 以上変わる点と、支線の最後の2点（取り付き点と
  // 車寄せ）は必ず残す。
  const keepTail = road.airportId ? 2 : 1;
  const base = [src[0]];
  // 経路に沿った距離（橋の位置はこれで持っている。03b-world.js の worldRoadBridges）
  const baseS = [0];
  let acc = 0, sAll = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    acc += Math.hypot(b.x - a.x, b.z - a.z);
    sAll += Math.hypot(b.x - a.x, b.z - a.z);
    const d = Math.hypot(b.x - cam.x, b.z - cam.z);
    const want = d < 12000 ? ROAD_STEP_NEAR_M
      : ROAD_STEP_NEAR_M + (ROAD_STEP_FAR_M - ROAD_STEP_NEAR_M)
        * Math.min(1, (d - 12000) / 30000);
    let turn = false;
    if (i < src.length - 1) {
      const last = base[base.length - 1], c = src[i + 1];
      const h1 = Math.atan2(b.x - last.x, b.z - last.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
      let dh = Math.abs(h2 - h1) * 180 / Math.PI;
      if (dh > 180) dh = 360 - dh;
      turn = dh >= ROAD_KEEP_TURN_DEG;
    }
    // 橋の中は間引かない（桁が弦で川岸をかすめないように）
    const onBridge = roadOnBridge(road, sAll, 300);
    if (acc >= want || turn || i >= src.length - keepTail || (onBridge && acc >= ROAD_STEP_BRIDGE_M)) {
      base.push(b); baseS.push(sAll); acc = 0;
    }
  }
  const nb = base.length;
  if (nb < 2) return;
  const w = road.halfWidth;

  // 元の頂点の向き（角の二等分線）と、角で幅が細らないための倍率。
  // 前後の区間の向きの平均を取るだけだと、曲がった角では帯の幅が cos(曲がり角/2) 倍に
  // 細る（90°で0.71倍）。その逆数を掛けて幅を保つ。折り返しに近い角で縁が
  // 遠くへ飛ばないよう、倍率は2.5で止める。
  const dirs = [];
  for (let i = 0; i < nb - 1; i++) {
    const dx = base[i + 1].x - base[i].x, dz = base[i + 1].z - base[i].z;
    const l = Math.hypot(dx, dz) || 1;
    dirs.push({ x: dx / l, z: dz / l });
  }
  const miter = (i) => {
    const d1 = dirs[Math.max(i - 1, 0)], d2 = dirs[Math.min(i, nb - 2)];
    let tx = d1.x + d2.x, tz = d1.z + d2.z;
    const l = Math.hypot(tx, tz);
    if (l < 1e-6) { tx = d1.x; tz = d1.z; } else { tx /= l; tz /= l; }
    const cosHalf = Math.max(tx * d1.x + tz * d1.z, 0.4);
    return { px: -tz, pz: tx, s: 1 / cosHalf };
  };

  // 頂点列：元の頂点＋区間ごとに格子線との交点
  const verts = [];
  const ts = [];
  for (let i = 0; i < nb; i++) {
    const m = miter(i);
    verts.push({ x: base[i].x, z: base[i].z, px: m.px * m.s, pz: m.pz * m.s, s: baseS[i] });
    if (i === nb - 1) break;
    const a = base[i], b = base[i + 1];
    const sa = baseS[i], sb = baseS[i + 1];
    // 区間の両端のうち細かいほうのLODで交点を取る（粗い格子線は細かい格子線に含まれる）
    const seg = Math.max(terrainLodAt(a.x, a.z), terrainLodAt(b.x, b.z));
    const step = TERRAIN_TILE_SIZE / seg;
    const d = dirs[i];
    const qx = -d.z * w, qz = d.x * w;
    ts.length = 0;
    roadGridCrossings(a.x, a.z, b.x, b.z, step, ts);
    roadGridCrossings(a.x + qx, a.z + qz, b.x + qx, b.z + qz, step, ts);
    roadGridCrossings(a.x - qx, a.z - qz, b.x - qx, b.z - qz, step, ts);
    // 橋の取付け部の始まり・桁の両端にも頂点を置く（高さの折れ目がちょうどそこに来るように）
    if (road.bridges) {
      for (const br of road.bridges) {
        for (const sv of [br.s0, br.s1, br.s2, br.s3]) {
          if (sv > sa && sv < sb) ts.push((sv - sa) / (sb - sa));
        }
      }
    }
    ts.sort((u, v) => u - v);
    let last = 0;
    for (const t of ts) {
      if (t - last < 0.004 || t > 0.996) continue; // 同じ場所に重ねない
      last = t;
      verts.push({
        x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
        px: -d.z, pz: d.x, s: sa + (sb - sa) * t,
      });
    }
  }

  const n = verts.length;
  const ox = verts[0].x, oz = verts[0].z;
  const oy = terrainSurfaceHeightAt(ox, oz);
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);

  const rows = road.bridges && road.bridges.length ? [] : null;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    const lx = v.x + v.px * w, lz = v.z + v.pz * w;
    const rx = v.x - v.px * w, rz = v.z - v.pz * w;
    // その場所で実際に描かれているLODに合わせて、縁ごとに高さを取る。
    // 橋と取付け部では、橋の高さの形（worldBridgeProfileY）のほうが高ければそちら。
    const gl = roadGroundY(lx, lz), gr = roadGroundY(rx, rz);
    const prof = rows ? worldBridgeProfileY(road.bridges, v.s) : -Infinity;
    const yl = Math.max(gl + ROAD_LIFT_M, prof);
    const yr = Math.max(gr + ROAD_LIFT_M, prof);
    if (rows) rows.push({ x: v.x, z: v.z, lx, lz, rx, rz, yl, yr, gl, gr, s: v.s, prof });

    const li = i * 6, ri = i * 6 + 3;
    positions[li] = lx - ox; positions[li + 1] = yl - oy; positions[li + 2] = lz - oz;
    positions[ri] = rx - ox; positions[ri + 1] = yr - oy; positions[ri + 2] = rz - oz;
    normals[li + 1] = 1; normals[ri + 1] = 1;
  }

  const indices = new Uint32Array((n - 1) * 6);
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices[k++] = a; indices[k++] = c; indices[k++] = b;
    indices[k++] = b; indices[k++] = c; indices[k++] = d;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();

  // 不透明なので renderOrder は要らない（半透明の並び順とは別のリストで描かれる）。
  // 地形との重なりは、上の深度バイアスと ROAD_LIFT_M で処理する。
  const mesh = new THREE.Mesh(geo, EnvState.roadMaterial);
  mesh.position.set(ox, oy, oz);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  EnvState.roadGroup.add(mesh);

  // 街灯は**帯と同じ折れ線（間引いたあと）の上**に置く。間引く前の経路に置いていたので、
  // 帯が弦で結んだカーブでは、街灯だけ道の外に立っていた。
  const lamps = buildRoadLamps(road, base, baseS, ox, oy, oz);
  if (lamps) EnvState.roadGroup.add(lamps);

  const bridge = rows ? buildBridgeStructure(rows, road.bridges, ox, oy, oz) : null;
  if (bridge) EnvState.roadGroup.add(bridge);

  const houses = buildRoadHouses(road, src, ox, oy, oz);
  if (houses) EnvState.roadGroup.add(houses);

  // 作り直しのときは、新しい帯ができてから古い帯を片付ける（一瞬道が消えないように）
  if (EnvState.builtRoads.has(road.id)) disposeRoadInstance(road.id);
  EnvState.builtRoads.set(road.id, { strip: mesh, lamps, bridge, houses });
}

// 道に沿って街灯を置く。左右に振らず中央に1列（遠目には中央分離帯の灯りに見える）。
// 近い道にだけ出す——灯りは小さな点なので、遠くでは点が潰れて線にならず、
// 頂点だけ増えて何も見えない。
//
// **経路の頂点の上ではなく、線に沿って決まった間隔で置く。** 以前は間引いたあとの
// 頂点の上にしか置けなかったので、間隔を260mにしたつもりが、経路の頂点間隔
// （中央値878m）に引きずられて実際は平均916mおきだった。
function buildRoadLamps(road, pts, ptsS, ox, oy, oz) {
  const cam = EnvState.camera.position;
  const R = roadLampRadius();
  const positions = [];
  let next = 0; // 次の灯りまでの残り距離（始点にも1つ置く）
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    let s = next;
    for (; s <= d; s += ROAD_LAMP_SPACING_M) {
      const t = d > 0 ? s / d : 0;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      if (Math.hypot(x - cam.x, z - cam.z) > R) continue;
      // 橋の上では桁の上に立てる（地面の高さのままだと川面すれすれに灯りが浮く）
      const prof = worldBridgeProfileY(road.bridges, ptsS[i - 1] + (ptsS[i] - ptsS[i - 1]) * t);
      const y = Math.max(roadGroundY(x, z), prof - ROAD_LIFT_M) + ROAD_LAMP_Y;
      positions.push(x - ox, y - oy, z - oz);
    }
    next = s - d;
  }
  if (!positions.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.computeBoundingSphere();
  const core = new THREE.Points(geo, EnvState.roadLampMaterial);
  core.position.set(ox, oy, oz);
  core.matrixAutoUpdate = false;
  core.updateMatrix();
  // にじみ（空港の灯火と同じ作り：同じ頂点を大きく薄く重ねる）。
  // 黄色がかった、ほんのり見える程度にとどめる。
  const glow = new THREE.Points(geo, EnvState.roadLampGlowMaterial);
  glow.renderOrder = -1;
  glow.matrixAutoUpdate = false;
  core.add(glow);
  return core;
}

// 夜になったら道の街灯を点ける。明るさは街の灯りに合わせる
// （03d-places.js の updatePlacesForDaylight と同じ dayFactor を受け取る）。
// 路面もほんのり明るくする——灯りの点だけだと、夜の道は点の列に見えて
// 「道路が照らされている」感じが出ない。
function updateRoadsForDaylight(dayFactor) {
  if (!EnvState.roadLampMaterial) return;
  EnvState.roadDayFactor = dayFactor;
  const v = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
  EnvState.roadLampMaterial.opacity = v * ROAD_LAMP_OPACITY;
  EnvState.roadLampGlowMaterial.opacity = v * ROAD_LAMP_GLOW_OPACITY;
  EnvState.roadMaterial.emissive.setHex(ROAD_NIGHT_EMISSIVE).multiplyScalar(v);
  if (EnvState.houseLightMaterial) EnvState.houseLightMaterial.opacity = v * HOUSE_LIGHT_OPACITY;
  if (EnvState.roadGroup) {
    for (const e of EnvState.builtRoads.values()) {
      if (e.lamps) e.lamps.visible = v > 0.01;
    }
  }
}

// 滑走路の向きを変えた空港の支線を引き直す（04b-airport.js から呼ばれる）
function rebuildAirportRoads(airportId) {
  if (!EnvState.builtRoads) return;
  for (const road of WORLD_ROADS) {
    if (road.airportId !== airportId || !EnvState.builtRoads.has(road.id)) continue;
    disposeRoadInstance(road.id);
    buildRoadInstance(road);
  }
  // 作り直した街灯にも、いまの昼夜の明るさ（visible）を入れ直す
  if (EnvState.roadDayFactor !== undefined) updateRoadsForDaylight(EnvState.roadDayFactor);
}

// カメラが動いたら、出し入れと間引きをやり直す。
// 間引きがカメラ距離で決まるので、川や地形と違って「近づいたら作り直す」も要る。
//
// 作り直しは **1フレームにまとめてやらず、数ミリ秒ずつ順番に** 行う。
// 道は地形の三角形に沿わせて頂点を置くので、周りの道をいっせいに作り直すと
// 数十msかかり、そのフレームだけ止まって見える。古い帯は新しい帯ができるまで残す。
const ROAD_REBUILD_DIST_M = 6000;
const ROAD_BUILD_BUDGET_MS = 4;
let _roadLastCam = null;
let _roadLastTerrainCheck = null;
let _roadQueue = [];

function updateRoads() {
  if (!EnvState.builtRoads) return;
  const cam = EnvState.camera.position;

  // 積んである作り直しを、時間の許すぶんだけ進める（最低1本）
  if (_roadQueue.length) {
    const t0 = performance.now();
    while (_roadQueue.length) {
      buildRoadInstance(_roadQueue.shift());
      if (performance.now() - t0 > ROAD_BUILD_BUDGET_MS) break;
    }
    if (!_roadQueue.length && EnvState.roadDayFactor !== undefined) {
      updateRoadsForDaylight(EnvState.roadDayFactor);
    }
  }

  // 地形のLODが見直されたら（terrainLodAt の基準が変わったら）道も高さを取り直す。
  // そうしないと、タイルが細かく作り直されたあと道だけ古い粗さの高さに乗っていて、
  // 尾根で潜り谷で浮く。
  const terrainMoved = typeof _terrainLastCheck !== 'undefined'
    && _terrainLastCheck !== _roadLastTerrainCheck;
  if (_roadLastCam && !terrainMoved) {
    const d = Math.hypot(cam.x - _roadLastCam.x, cam.z - _roadLastCam.z);
    if (d < ROAD_REBUILD_DIST_M) return;
  }
  _roadLastCam = { x: cam.x, z: cam.z };
  if (typeof _terrainLastCheck !== 'undefined') _roadLastTerrainCheck = _terrainLastCheck;

  // 圏外は片付け、圏内は（出ていても出ていなくても）作り直しの列へ。
  // 近い道から作る。
  const R = roadActiveRadius();
  const want = [];
  for (const road of WORLD_ROADS) {
    if (roadNearCamera(road, cam, R)) want.push(road);
    else if (EnvState.builtRoads.has(road.id)) disposeRoadInstance(road.id);
  }
  const distOf = (road) => {
    let m = Infinity;
    for (let i = 0; i < road.points.length; i += 2) {
      const q = road.points[i];
      m = Math.min(m, (q.x - cam.x) * (q.x - cam.x) + (q.z - cam.z) * (q.z - cam.z));
    }
    return m;
  };
  _roadQueue = want.map((r) => [distOf(r), r]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

function setRoadsVisible(visible) {
  if (EnvState.roadGroup) EnvState.roadGroup.visible = visible;
}
