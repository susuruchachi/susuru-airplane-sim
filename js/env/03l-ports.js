// 03l-ports.js — 港（岸壁・ガントリークレーン・コンテナ・倉庫・防波堤・灯台・船）
//
// 置き場所と向きは世界側（03b-world.js の WORLD_PORTS）が決める。ここは形だけ。
// 岸壁は岸から海の上へ突き出した床（杭の上）で、地形は均さない。
// 形は 03k-city-shapes.js の部品（skBox・skGable・skPrism）で組み、港1つを1メッシュにまとめる。
// 街と同じく、カメラの周り（PORT_ACTIVE_RADIUS_M）だけ建てて、離れたら片付ける。
//
// 港の座標：u が海岸線に沿った向き（t）、v が沖の向き（o）。v=0 が海岸、岸壁は v=-backM〜depthM。

const PORT_ACTIVE_RADIUS_M = 40000;
const PORT_CONCRETE = 0x6a6862;
const PORT_CRANE_COLORS = [0x8a2a22, 0x2e4a7a, 0x9a9690];
const PORT_BOX_COLORS = [0x8a2a22, 0x2a4a7a, 0x2f6a3a, 0x9a5a1a, 0x8a8a86, 0x5a2a5a, 0x6a6a2a, 0x7a3a2a];
const PORT_CONTAINER_H = 2.6;

function initPorts() {
  EnvState.builtPorts = new Map();
  EnvState.portGroup = new THREE.Group();
  EnvState.scene.add(EnvState.portGroup);
}

// カメラの周りの港を揃える（03d-places.js の refreshCities から呼ぶ）。港1つは5〜10msで建つので、その場で建てる
function refreshPorts() {
  if (!EnvState.builtPorts || typeof WORLD_PORTS === 'undefined') return;
  const cam = EnvState.camera.position;
  for (const p of WORLD_PORTS) {
    const d = Math.hypot(p.x - cam.x, p.z - cam.z);
    const built = EnvState.builtPorts.get(p.id);
    if (d < PORT_ACTIVE_RADIUS_M && !built) buildPortInstance(p);
    else if (d >= PORT_ACTIVE_RADIUS_M && built) disposePortInstance(p.id);
  }
}

function disposePortInstance(id) {
  const e = EnvState.builtPorts.get(id);
  if (!e) return;
  EnvState.portGroup.remove(e.mesh);
  e.mesh.geometry.dispose(); e.mesh.material.dispose();
  e.lights.geometry.dispose(); e.lights.material.dispose();
  EnvState.builtPorts.delete(id);
}

function buildPortInstance(p) {
  const S = cityShapeSink();
  const lit = [];
  const rand = worldRng(p.id);
  const ang = Math.atan2(p.tz, p.tx);             // 箱の間口（w）を海岸線に沿わせる
  const P = (u, v) => [p.tx * u + p.ox * v, p.tz * u + p.oz * v];
  const box = (u, v, y0, w, h, d, hex) => { const [x, z] = P(u, v); skBox(S, x, y0, z, w, h, d, ang, hex); };
  const light = (u, v, y, r, g, b) => { const [x, z] = P(u, v); lit.push(x, y, z, r, g, b); };
  const L = p.lengthM, D = p.depthM, B = p.backM, Y = p.deckY;

  // 1) 岸壁の床。海の中（-6m）から床の高さまで。陸へ B m 食い込ませて、岸との隙間を作らない
  box(0, (D - B) / 2, -6, L, Y + 6, D + B, PORT_CONCRETE);
  // 岸壁の縁石（沖の縁）
  box(0, D - 1, Y, L, 0.8, 2, 0x8a8880);

  // 2) ガントリークレーン。沖の縁に沿って並べる（脚4本・上の枠・海の上へ突き出すブーム・機械室）
  const nCrane = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < nCrane; i++) {
    const u = -L * 0.36 + (L * 0.72 * i) / Math.max(nCrane - 1, 1);
    const v = D - 14;
    const col = PORT_CRANE_COLORS[i % PORT_CRANE_COLORS.length];
    for (const du of [-9, 9]) for (const dv of [-10, 10]) box(u + du, v + dv, Y, 1.8, 38, 1.8, col);
    box(u, v, Y + 38, 21, 3, 23, col);
    box(u, v + 22, Y + 43, 3, 2.6, 110, col);          // ブーム（沖へ65m・陸へ35m）
    box(u, v - 6, Y + 41, 3, 16, 3, col);              // ブームを吊る塔
    box(u, v - 16, Y + 41, 9, 6, 10, 0x8a8a86);        // 機械室
    light(u, v + 77, Y + 45, 1, 0.1, 0.05);            // ブームの先の赤い灯
  }

  // 3) コンテナの山（1〜4段）
  for (let v = D * 0.24; v < D * 0.7; v += 3.4) {
    for (let u = -L * 0.44; u < L * 0.44; u += 13.4) {
      if (Math.abs((u / 60) % 1) < 0.08) continue;     // 通路
      const r = rand();
      if (r < 0.12) continue;
      const n = 1 + Math.floor(rand() * 4);
      box(u, v, Y, 12.2, PORT_CONTAINER_H * n, 2.5, PORT_BOX_COLORS[(rand() * PORT_BOX_COLORS.length) | 0]);
    }
  }

  // 4) 倉庫（陸側）。切妻の屋根
  for (let i = 0; i < 3; i++) {
    const u = -L * 0.3 + L * 0.3 * i, v = D * 0.1 - 4;
    const w = 110 + rand() * 30, d = 38 + rand() * 10, h = 12;
    box(u, v, Y - 1, w, h + 1, d, 0x7a7a74);
    const [x, z] = P(u, v);
    skGable(S, skFrame(x, z, ang), w, d, Y + h, d * 0.18, 0.5, 0x3e4a54, 0x7a7a74);
  }

  // 5) 照明塔（コンテナの上を照らす）
  for (let u = -L * 0.4; u <= L * 0.4; u += 90) {
    box(u, D * 0.72, Y, 1.2, 30, 1.2, 0x8a8a86);
    light(u, D * 0.72, Y + 31, 1, 0.9, 0.7);
    light(u, D * 0.22, Y + 20, 1, 0.9, 0.7);
  }

  // 6) 防波堤：岸壁の端から沖へ、そこから海岸線に沿って折れる。先に灯台
  const bw = [[L / 2 + 50, D - 80], [L / 2 + 50, D + 360], [L / 2 - 320, D + 360]];
  for (let k = 0; k < bw.length - 1; k++) {
    const [u0, v0] = bw[k], [u1, v1] = bw[k + 1];
    const len = Math.hypot(u1 - u0, v1 - v0), n = Math.ceil(len / 26);
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
      const along = Math.abs(u1 - u0) > Math.abs(v1 - v0);
      box(u, v, -8, along ? 27 : 14, 10.5 + rand() * 1.2, along ? 14 : 27, 0x4a4a48);
    }
  }
  {
    const [x, z] = P(bw[2][0], bw[2][1]);
    for (let k = 0; k < 4; k++) skPrism(S, x, z, 3 + k * 5.5, 5.5, 3 - k * 0.15, 2.85 - k * 0.15, 10, k % 2 ? 0xb8b8b4 : 0x8a2a22);
    skPrism(S, x, z, 25, 3, 2.2, 2.2, 10, 0x5a6a6a);
    skPrism(S, x, z, 28, 2.5, 2.4, 0, 10, 0x2e2e2e);
    lit.push(x, 27, z, 1, 1, 0.9);
  }

  // 7) 着いている船（コンテナ船と、ばら積み船）。岸壁の沖側に横付け
  const ships = [{ u: -L * 0.22, len: 200, beam: 32, kind: 'box' }, { u: L * 0.24, len: 170, beam: 28, kind: 'bulk' }];
  for (const sh of ships) {
    const v = D + sh.beam / 2 + 3;
    box(sh.u, v, -7, sh.len, 17, sh.beam, 0x1f2a3a);                   // 船体
    box(sh.u, v, 9.5, sh.len * 0.98, 0.6, sh.beam * 0.96, 0x6a2a22);   // 甲板の縁（赤）
    const sternU = sh.u - sh.len * 0.42;
    box(sternU, v, 10, 18, 16, sh.beam * 0.8, 0xb8b8b4);             // 船橋
    box(sternU - 3, v, 26, 6, 6, 3, 0x8a2a22);                        // 煙突
    light(sternU, v, 27, 1, 0.95, 0.8);
    if (sh.kind === 'box') {
      for (let u = sternU + 16; u < sh.u + sh.len * 0.45; u += 13) {
        for (let r = -2; r <= 2; r++) {
          const n = 1 + Math.floor(rand() * 4);
          box(u, v + r * 5.4, 10, 12.2, PORT_CONTAINER_H * n, 5.2, PORT_BOX_COLORS[(rand() * PORT_BOX_COLORS.length) | 0]);
        }
      }
    } else {
      for (let u = sternU + 22; u < sh.u + sh.len * 0.42; u += 22) box(u, v, 10, 15, 2, sh.beam * 0.6, 0x5a3a2a);
    }
  }

  // メッシュ
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S.p), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(S.n), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(S.c), 3));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x000000 }));
  mesh.position.set(p.x, 0, p.z);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  EnvState.portGroup.add(mesh);

  const lp = [], lc = [];
  for (let i = 0; i < lit.length; i += 6) { lp.push(lit[i], lit[i + 1], lit[i + 2]); lc.push(lit[i + 3], lit[i + 4], lit[i + 5]); }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
  lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lc), 3));
  lg.computeBoundingSphere();
  const lights = new THREE.Points(lg, new THREE.PointsMaterial({
    size: 30, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  }));
  lights.position.copy(mesh.position);
  lights.matrixAutoUpdate = false;
  lights.updateMatrix();
  EnvState.portGroup.add(lights);
  EnvState.builtPorts.set(p.id, { mesh, lights });
  if (EnvState.portDayFactor !== undefined) updatePortsForDaylight(EnvState.portDayFactor);
}

// 夜は灯りを点け、港を窓明かりぶんだけ自発光させる（街と同じ）
function updatePortsForDaylight(dayFactor) {
  EnvState.portDayFactor = dayFactor;
  if (!EnvState.builtPorts) return;
  const v = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
  for (const e of EnvState.builtPorts.values()) {
    e.lights.material.opacity = v;
    e.lights.visible = v > 0.01;
    e.mesh.material.emissive.setRGB(v * 0.06, v * 0.05, v * 0.035);
  }
}
