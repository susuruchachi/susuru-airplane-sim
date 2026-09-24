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
// 実際に並んでいた間隔（平均916m）の3倍の密度にした（下の buildRoadLamps を参照）
const ROAD_LAMP_SPACING_M = 300;   // 街灯の間隔
const ROAD_LAMP_Y = 9;             // 路面からの高さ
const ROAD_LAMP_SIZE = 22;
// 街灯を出す範囲。灯りは小さな点なので、道の帯より手前で切ってよい。
const ROAD_LAMP_RADIUS_BASE = 26000;
// 街の灯りと同じ強さ（03d-places.js は opacity をそのまま 0〜1 で使っている）。
// 1.0 だと点が白く飛んで高速道路というより滑走路の灯火に見えたので、少し落とす。
const ROAD_LAMP_OPACITY = 0.75;
// 街灯のにじみ。芯の何倍の大きさで、どれだけ薄く重ねるか（空港の灯火は2.8倍・0.10）。
// 黄色がかった、うっすら見える程度にする。
const ROAD_LAMP_GLOW_SCALE = 3.4;
const ROAD_LAMP_GLOW_OPACITY = 0.16;
// 夜の路面の明るさ（自己発光の色）。灯りに照らされた路面の、ほんのり暖かい色。
const ROAD_NIGHT_EMISSIVE = 0x1c160c;

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
  let acc = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    acc += Math.hypot(b.x - a.x, b.z - a.z);
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
    if (acc >= want || turn || i >= src.length - keepTail) { base.push(b); acc = 0; }
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
    verts.push({ x: base[i].x, z: base[i].z, px: m.px * m.s, pz: m.pz * m.s });
    if (i === nb - 1) break;
    const a = base[i], b = base[i + 1];
    // 区間の両端のうち細かいほうのLODで交点を取る（粗い格子線は細かい格子線に含まれる）
    const seg = Math.max(terrainLodAt(a.x, a.z), terrainLodAt(b.x, b.z));
    const step = TERRAIN_TILE_SIZE / seg;
    const d = dirs[i];
    const qx = -d.z * w, qz = d.x * w;
    ts.length = 0;
    roadGridCrossings(a.x, a.z, b.x, b.z, step, ts);
    roadGridCrossings(a.x + qx, a.z + qz, b.x + qx, b.z + qz, step, ts);
    roadGridCrossings(a.x - qx, a.z - qz, b.x - qx, b.z - qz, step, ts);
    ts.sort((u, v) => u - v);
    let last = 0;
    for (const t of ts) {
      if (t - last < 0.004 || t > 0.996) continue; // 同じ場所に重ねない
      last = t;
      verts.push({
        x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
        px: -d.z, pz: d.x,
      });
    }
  }

  const n = verts.length;
  const ox = verts[0].x, oz = verts[0].z;
  const oy = terrainSurfaceHeightAt(ox, oz);
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);

  for (let i = 0; i < n; i++) {
    const v = verts[i];
    const lx = v.x + v.px * w, lz = v.z + v.pz * w;
    const rx = v.x - v.px * w, rz = v.z - v.pz * w;
    // その場所で実際に描かれているLODに合わせて、縁ごとに高さを取る
    const yl = roadGroundY(lx, lz) + ROAD_LIFT_M;
    const yr = roadGroundY(rx, rz) + ROAD_LIFT_M;

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
  const lamps = buildRoadLamps(road, base, ox, oy, oz);
  if (lamps) EnvState.roadGroup.add(lamps);

  // 作り直しのときは、新しい帯ができてから古い帯を片付ける（一瞬道が消えないように）
  if (EnvState.builtRoads.has(road.id)) disposeRoadInstance(road.id);
  EnvState.builtRoads.set(road.id, { strip: mesh, lamps });
}

// 道に沿って街灯を置く。左右に振らず中央に1列（遠目には中央分離帯の灯りに見える）。
// 近い道にだけ出す——灯りは小さな点なので、遠くでは点が潰れて線にならず、
// 頂点だけ増えて何も見えない。
//
// **経路の頂点の上ではなく、線に沿って決まった間隔で置く。** 以前は間引いたあとの
// 頂点の上にしか置けなかったので、間隔を260mにしたつもりが、経路の頂点間隔
// （中央値878m）に引きずられて実際は平均916mおきだった。
function buildRoadLamps(road, pts, ox, oy, oz) {
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
      const y = roadGroundY(x, z) + ROAD_LAMP_Y;
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
