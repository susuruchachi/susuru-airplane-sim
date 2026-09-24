// 04b-airport.js — 空港（滑走路・誘導路・エプロン・管制塔・灯火・吹き流し）
// 既定の空港をパラメータから手続き的に生成する。外部モデル(GLB)の読込対応は今後。
//
// 座標の決めごと：
//   空港はローカル座標で「滑走路の長さ方向 = +X、幅方向 = Z」で組み立て、
//   方位（真北0°・時計回り）は空港グループ全体の rotation.y だけで表す。
//   ワールドは -Z が北、+X が東。方位θの向きは (sinθ, 0, -cosθ) なので、
//   +X をその向きに合わせる回転は rotation.y = 90° - θ になる。

// 地面の上に、整地エリア→舗装→標識の順で重ねる。
// **高さは全部地面ぴったり（y=0）。** 飛行の物理は地面の高さで接地するので、
// 以前のように舗装を1.0m・標示を1.4m浮かせると、車輪がそのぶん埋まって見えた。
// 重なりは深度のほうで解く（02-env-scene.js の applyDepthPull）。
// 灯火だけは器具の高さぶん上に置く。
const AIRFIELD_Y = 0;
const TAXIWAY_Y = 0;
const RUNWAY_SURFACE_Y = 0;
const RUNWAY_MARK_Y = 0;
const LIGHT_Y = 2.2;

// 重ね順（数字が大きいほど手前に描く）
const OFFSET_AIRFIELD = 1;
const OFFSET_PAVEMENT = 2;
const OFFSET_APRON = 3;     // エプロンは、そこへ入ってくる誘導路（色違いの舗装）より上
const OFFSET_MARKING = 4;
const OFFSET_NUMBER = 6;

// 重ね順ごとに、深度をカメラまでの距離のどれだけ手前へ引くか。
// いちばん下の整地エリアでも、粗いLODの地形が空港より上に出るぶん（24分割で最大0.75m、
// 16分割で最大4.7m。16分割になるのは空港が見える120kmの手前、およそ80kmから）を越える必要がある。
// 4.7m / 80km ≈ 6e-5 なので 8e-5 から始め、1段ごとに 2e-5 ずつ手前へ（50m先でも最大9mm）。
const DECAL_PULL_BASE = 6e-5;
const DECAL_PULL_PER_RANK = 2e-5;

// 地面に重ねる大きな板は、DECAL_CELL_M ほどの升目に割っておく。
// 1枚の大きな三角形だと、カメラのすぐ近くで奥行きの補間が三角形の大きさに比例してずれ
// （4km角で約1mm）、地面ぴったりに敷いた板が地形と前後を取り合う。
const DECAL_CELL_M = 200;
function decalPlaneGeometry(w, h) {
  return new THREE.PlaneGeometry(w, h,
    Math.max(1, Math.ceil(w / DECAL_CELL_M)), Math.max(1, Math.ceil(h / DECAL_CELL_M)));
}

// 同一平面上に重なる面が深度で喧嘩しないよう、描画順に応じた深度バイアスを与える
function applyDecalOffset(material, rank) {
  return applyDepthPull(material, DECAL_PULL_BASE + DECAL_PULL_PER_RANK * rank, rank);
}

// レンダラーが outputEncoding=sRGB で出力するぶん中間色が明るく持ち上がるので、
// 見た目の色より一段暗い値を指定する（そのままだとアスファルトが白っぽく飛ぶ）
const ASPHALT_COLOR = 0x15171a;
const CONCRETE_COLOR = 0x24262a;
const AIRFIELD_GRASS_COLOR = 0x18351f;
const MARKING_COLOR = 0xf2f2f2;
const TAXI_MARKING_COLOR = 0x9c8420;

let _lightSpriteTexture = null;

// --- 小物ヘルパー -----------------------------------------------------------

// XZ平面に水平な長方形（中心 cx,cz / X方向の長さ len / Z方向の幅 wid）を三角形2枚ぶん積む。
// 頂点の並び順は「上から見て反時計回り」にすること。逆にすると裏面扱いになり、
// MeshLambertMaterialは裏面を法線反転で照らすため、真っ黒な標識になる。
function pushRectXZ(positions, cx, cz, len, wid, y) {
  const x0 = cx - len / 2, x1 = cx + len / 2;
  const z0 = cz - wid / 2, z1 = cz + wid / 2;
  positions.push(
    x0, y, z0, x1, y, z1, x1, y, z0,
    x0, y, z0, x0, y, z1, x1, y, z1
  );
}

// 積んだ頂点配列から、上向き法線の1メッシュを作る（標識をまとめて1ドローコールにするため）
function meshFromRects(positions, color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1; // 全頂点 (0,1,0)
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  const mat = applyDecalOffset(
    new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }), OFFSET_MARKING
  );
  return new THREE.Mesh(geo, mat);
}

// 滑走路端の数字（例:"09"）を描いたテクスチャ。外部フォント画像を使わずCanvasで生成する
function buildRunwayNumberTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = '#f2f2f2';
  ctx.font = 'bold 150px "Arial Narrow", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 136);
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

// 灯火用の、中心が明るく外側へ滑らかに消える丸テクスチャ
function buildLightSpriteTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// 作り直しの前に、ぶら下がっているジオメトリ／マテリアルを解放する
function disposeAirportObject(obj) {
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    }
  });
}

// 方位から滑走路の呼称を出す（例: 90° → 手前"09" / 反対側"27"。0°は"00"ではなく"36"）
function runwayDesignators(headingDeg) {
  const num = (deg) => {
    const n = Math.round((((deg % 360) + 360) % 360) / 10);
    return String(n === 0 ? 36 : n).padStart(2, '0');
  };
  return { near: num(headingDeg), far: num(headingDeg + 180) };
}

// --- 各パーツの生成 ---------------------------------------------------------

// 滑走路まわりの整地エリア。周囲の地面と色を変えて「飛行場の敷地」に見せる
function buildAirfieldGround(L, W, span, terminalZ, terminalX, extraX) {
  // 滑走路の並び（span）とターミナル側（terminalZ）の両方が収まる大きさにする。
  // ここが足りないと、平行滑走路やターミナルが草地からはみ出して地形の上に浮く。
  const zMin = -span - W / 2 - 220;
  const zMax = terminalZ + 320;
  const depth = zMax - zMin;
  // 長さ方向も、ターミナル（と管制塔）が滑走路の端より外にあるときはそこまで広げる。
  // ターミナルは定義の最大長から位置が決まるので、UIで滑走路を縮めると端から外れる。
  const xMin = Math.min(-L / 2 - 350, (terminalX === undefined ? 0 : terminalX) - (extraX || 520));
  const xMax = L / 2 + 350;
  const mesh = new THREE.Mesh(
    decalPlaneGeometry(xMax - xMin, depth),
    applyDecalOffset(new THREE.MeshLambertMaterial({ color: AIRFIELD_GRASS_COLOR }), OFFSET_AIRFIELD)
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((xMin + xMax) / 2, AIRFIELD_Y, (zMin + zMax) / 2);
  return mesh;
}

function buildRunwaySurface(L, W) {
  const geo = decalPlaneGeometry(L, W);
  const mat = applyDecalOffset(new THREE.MeshLambertMaterial({ color: ASPHALT_COLOR }), OFFSET_PAVEMENT);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = RUNWAY_SURFACE_Y;
  return mesh;
}

// 滑走路の路面標識（センターライン・接地帯・目標点・末端の縞・側線）をまとめて1メッシュにする
function buildRunwayMarkings(L, W) {
  const p = [];
  const halfL = L / 2;
  const y = RUNWAY_MARK_Y;

  // 側線（両端を少し残した連続線）
  const edgeZ = W / 2 - 1.0;
  pushRectXZ(p, 0, edgeZ, L - 12, 0.9, y);
  pushRectXZ(p, 0, -edgeZ, L - 12, 0.9, y);

  // センターライン（30m線＋20m空白。末端の標識ゾーンは避ける）
  const clHalfSpan = halfL - 90;
  for (let x = -clHalfSpan; x <= clHalfSpan; x += 50) {
    pushRectXZ(p, x, 0, 30, 0.9, y);
  }

  [1, -1].forEach((dir) => {
    const thr = dir * halfL; // この端のしきい値位置

    // 末端の縞（ピアノキー）：1.8m幅×30m長を3.6mピッチで8本
    const stripeCenterX = thr - dir * (6 + 15);
    for (let i = 0; i < 8; i++) {
      const z = (i - 3.5) * 3.6;
      pushRectXZ(p, stripeCenterX, z, 30, 1.8, y);
    }

    // 接地帯標識（しきい値から150m・450mの位置に、中心線の左右2本ずつ）
    [150, 450].forEach((dist) => {
      if (dist + 30 > L / 2) return; // 短い滑走路では省略
      const x = thr - dir * (dist + 11);
      [5.5, 9.5].forEach((offset) => {
        pushRectXZ(p, x, offset, 22.5, 3, y);
        pushRectXZ(p, x, -offset, 22.5, 3, y);
      });
    });

    // 目標点標識（しきい値から300m。太い2本）
    if (300 + 60 < L / 2) {
      const x = thr - dir * (300 + 22.5);
      pushRectXZ(p, x, 10.5, 45, 6, y);
      pushRectXZ(p, x, -10.5, 45, 6, y);
    }
  });

  return meshFromRects(p, MARKING_COLOR);
}

// 滑走路端の数字。着陸してくる側から見て正しい向きになるよう、面内で90°回してから寝かせる
// 平行滑走路は同じ数字になるので、実際の空港と同じく L / C / R を付けて区別する
function parallelSuffix(index, count) {
  if (count < 2) return '';
  if (count === 2) return index === 0 ? 'L' : 'R';
  return ['L', 'C', 'R'][index] || '';
}

function buildRunwayNumbers(L, headingDeg, suffix) {
  const group = new THREE.Group();
  const d = runwayDesignators(headingDeg);
  // 進行方向から見て左右が入れ替わるので、反対側の端では L と R を入れ替える
  const flip = { L: 'R', R: 'L', C: 'C', '': '' };
  const near = d.near + (suffix || '');
  const far = d.far + flip[suffix || ''];
  const halfL = L / 2;

  const make = (text, x, rotZ) => {
    const mat = applyDecalOffset(new THREE.MeshLambertMaterial({
      map: buildRunwayNumberTexture(text), transparent: true, side: THREE.DoubleSide,
    }), OFFSET_NUMBER);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), mat);
    // Euler 'XYZ' は Z→Y→X の順に効くので、rotation.z で面内の向きを決めてから rotation.x で寝かせる
    mesh.rotation.set(-Math.PI / 2, 0, rotZ);
    mesh.position.set(x, RUNWAY_MARK_Y, 0);
    return mesh;
  };

  // -X端に着陸する機は +X へ進むので、数字の上方向が +X を向く（rotation.z = -90°）
  group.add(make(near, -halfL + 62, -Math.PI / 2));
  group.add(make(far, halfL - 62, Math.PI / 2));
  group.userData.isRunwayNumbers = true; // 方位変更時に描き直す対象の目印
  return group;
}

// 誘導路とエプロン。
//
// エプロンとターミナルの位置は **世界の定義（terminalLocalX / terminalLocalZ）** から取る。
// 滑走路の長さはUIで変えられるので、そこから割り出すとターミナルが動いてしまい、
// そこへ向かって引いてある道路とずれる。
//
// **誘導路は滑走路の長さに合わせて引く。** 以前はターミナルの真正面（terminalLocalX）
// から滑走路へ1本だけ出していたが、ターミナルは定義の最大長から決まる位置にあるので、
// 定義どおりの長さでも滑走路の端より30m外、長さを縮めると何百mも外で分かれていて、
// 誘導路が滑走路に着いていなかった。
// いまは実際の空港と同じく、滑走路と平行な誘導路を全長に通し、
// 両端と中央の3か所で滑走路へ出る。ターミナルへはその平行誘導路から1本入る。
// 平行滑走路があるときは、出口の3本がそのまま奥の滑走路まで横切る。
const TAXIWAY_WIDTH_M = 23;
const TAXIWAY_EXIT_INSET_M = 45;   // 出口を滑走路端からどれだけ内側に置くか

function airportTaxiLayout(L, W, def) {
  const span = airportRunwayHalfSpan(def);
  const halfL = L / 2;
  const runwayEdgeZ = span + W / 2;          // いちばんターミナル側の滑走路の縁
  const farEdgeZ = -span + W / 2;            // いちばん奥の滑走路の、ターミナル側の縁
  // エプロンはターミナルの正面に接して置く（ターミナルの奥行きは規模で違う）
  const apronZ = def.terminalLocalZ - airportBuildings(def).termD / 2 - APRON_DEPTH_M / 2;
  const apronNearZ = apronZ - APRON_DEPTH_M / 2;
  const parallelZ = (runwayEdgeZ + apronNearZ) / 2;
  const apronX = def.terminalLocalX;
  const exits = [-halfL + TAXIWAY_EXIT_INSET_M, 0, halfL - TAXIWAY_EXIT_INSET_M];
  const xMin = Math.min(exits[0], apronX), xMax = Math.max(exits[2], apronX);
  // 誘導路の区間（中心線の両端）。どれも軸に沿った直線。
  const segments = [{ x0: xMin, z0: parallelZ, x1: xMax, z1: parallelZ, kind: 'parallel' }];
  for (const x of exits) {
    segments.push({ x0: x, z0: farEdgeZ - 2, x1: x, z1: parallelZ, kind: 'exit' });
  }
  segments.push({ x0: apronX, z0: parallelZ, x1: apronX, z1: apronNearZ + 2, kind: 'apron' });
  return { span, runwayEdgeZ, farEdgeZ, apronZ, apronNearZ, parallelZ, apronX, exits, segments };
}

function buildTaxiwayAndApron(L, W, def) {
  const group = new THREE.Group();
  const lay = airportTaxiLayout(L, W, def);
  const taxiWidth = TAXIWAY_WIDTH_M;
  const hw = taxiWidth / 2;

  // 舗装：区間ごとに幅23mの帯。角が欠けないよう、両端を半幅ずつ延ばして重ねる
  const pave = [];
  for (const sg of lay.segments) {
    const cx = (sg.x0 + sg.x1) / 2, cz = (sg.z0 + sg.z1) / 2;
    if (sg.z0 === sg.z1) pushRectXZ(pave, cx, cz, Math.abs(sg.x1 - sg.x0) + taxiWidth, taxiWidth, TAXIWAY_Y);
    else pushRectXZ(pave, cx, cz, taxiWidth, Math.abs(sg.z1 - sg.z0) + taxiWidth, TAXIWAY_Y);
  }
  const paveMesh = meshFromRects(pave, ASPHALT_COLOR);
  applyDecalOffset(paveMesh.material, OFFSET_PAVEMENT);
  group.add(paveMesh);

  const apronW = airportBuildings(def).termW + 80;
  const apron = new THREE.Mesh(
    decalPlaneGeometry(apronW, APRON_DEPTH_M),
    applyDecalOffset(new THREE.MeshLambertMaterial({ color: CONCRETE_COLOR }), OFFSET_APRON)
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(lay.apronX, TAXIWAY_Y, lay.apronZ);
  group.add(apron);

  // 誘導路の黄色いセンターライン（滑走路の上には引かない）
  const onRunway = (z) => z > -lay.span - W / 2 - 1 && z < lay.runwayEdgeZ + 1;
  const p = [];
  for (const sg of lay.segments) {
    const len = Math.hypot(sg.x1 - sg.x0, sg.z1 - sg.z0);
    const horiz = sg.z0 === sg.z1;
    for (let d = 6; d < len - 6; d += 20) {
      const t = d / len;
      const x = sg.x0 + (sg.x1 - sg.x0) * t, z = sg.z0 + (sg.z1 - sg.z0) * t;
      if (!horiz && onRunway(z)) continue;
      if (horiz) pushRectXZ(p, x, z, 12, 0.9, TAXIWAY_Y);
      else pushRectXZ(p, x, z, 0.9, 12, TAXIWAY_Y); // 長さ方向がZなので幅と長さを入れ替えて置く
    }
  }
  group.add(meshFromRects(p, TAXI_MARKING_COLOR));

  // 誘導路灯（青）の位置。縁から2m外に30mおき。滑走路の上・ほかの区間の舗装の上・
  // エプロンの上に落ちる点は置かない（交差点の真ん中に灯りが立たないように）。
  const insidePave = (x, z) => {
    for (const sg of lay.segments) {
      const x0 = Math.min(sg.x0, sg.x1) - hw, x1 = Math.max(sg.x0, sg.x1) + hw;
      const z0 = Math.min(sg.z0, sg.z1) - hw, z1 = Math.max(sg.z0, sg.z1) + hw;
      if (x > x0 && x < x1 && z > z0 && z < z1) return true;
    }
    return Math.abs(x - lay.apronX) < apronW / 2 + 1
      && Math.abs(z - lay.apronZ) < APRON_DEPTH_M / 2 + 1;
  };
  const lights = [];
  for (const sg of lay.segments) {
    const len = Math.hypot(sg.x1 - sg.x0, sg.z1 - sg.z0);
    const horiz = sg.z0 === sg.z1;
    for (let d = 0; d <= len; d += 30) {
      const t = len > 0 ? d / len : 0;
      const x = sg.x0 + (sg.x1 - sg.x0) * t, z = sg.z0 + (sg.z1 - sg.z0) * t;
      for (const side of [-1, 1]) {
        const lx = horiz ? x : x + side * (hw + 2);
        const lz = horiz ? z + side * (hw + 2) : z;
        if (onRunway(lz) || insidePave(lx, lz)) continue;
        lights.push(lx, lz);
      }
    }
  }

  return {
    group, taxiX: lay.apronX, taxiWidth, apronZ: lay.apronZ, apronW,
    layout: lay, lights,
  };
}

// エプロンの奥行き
const APRON_DEPTH_M = 190;

// ターミナルと管制塔の大きさ。滑走路の本数で決める（1本＝地方空港、3本＝国際空港）。
//
// 以前は 1本で間口110m・高さ9m、3本でも間口340m・高さ17m、管制塔は35mだった。
// Boeing 747 は全長71m・全幅64m・尾翼の高さ19mあるので、ターミナルが機体2機ぶんほどの
// 小屋になり、管制塔は747の尾翼の倍もなかった（「管制塔とターミナル、機体のサイズ感に
// 対して小さすぎない？」）。実際の空港に寄せる：地方空港のターミナルは間口200m前後、
// 大きな国際空港は1棟で500〜1,000m、管制塔は地方で30〜50m・大空港で70〜120m
// （羽田116m・ヒースロー87m・フランクフルト70m）。
const AIRPORT_BUILDINGS = {
  1: { termW: 220, termD: 44, termH: 16, piers: 1, pierLen: 110, towerH: 42, cabR: 9 },
  2: { termW: 520, termD: 70, termH: 24, piers: 3, pierLen: 150, towerH: 78, cabR: 12 },
  3: { termW: 800, termD: 90, termH: 28, piers: 4, pierLen: 170, towerH: 100, cabR: 14 },
};
function airportBuildings(def) {
  return AIRPORT_BUILDINGS[Math.min(Math.max(def.runwayCount || 1, 1), 3)];
}

// ターミナル。エプロンに面した長い建物と、そこから突き出す搭乗橋（ピア）。
function buildTerminal(def, apron) {
  const group = new THREE.Group();
  const b = airportBuildings(def);
  const width = b.termW, depth = b.termD, height = b.termH;
  const z = def.terminalLocalZ;

  const shell = new THREE.MeshLambertMaterial({ color: 0x53585f });
  const glass = new THREE.MeshLambertMaterial({ color: 0x223442 });

  // 本屋
  const main = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), shell);
  main.position.set(def.terminalLocalX, height / 2, z);
  group.add(main);

  // エプロン側の全面ガラス（面を1枚重ねるだけ。箱を2つ置くより軽い）
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width - 8, height * 0.62), glass);
  face.position.set(def.terminalLocalX, height * 0.52, z - depth / 2 - 0.4);
  face.rotation.y = Math.PI;
  group.add(face);

  // 屋根の縁（ただの箱に見えないように、少し出した庇を乗せる）
  const eave = new THREE.Mesh(new THREE.BoxGeometry(width + 10, 1.6, depth + 10), new THREE.MeshLambertMaterial({ color: 0x3f444a }));
  eave.position.set(def.terminalLocalX, height + 0.8, z);
  group.add(eave);

  // 搭乗橋（ピア）。エプロンへ向かって突き出す腕。
  const piers = b.piers;
  const pierLen = b.pierLen, pierW = 18, pierH = 9;
  const legMat = new THREE.MeshLambertMaterial({ color: 0x3a3e44 });
  for (let i = 0; i < piers; i++) {
    const t = piers === 1 ? 0.5 : i / (piers - 1);
    const px = def.terminalLocalX + (t - 0.5) * (width - pierW - 60);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierW, pierH, pierLen), shell);
    pier.position.set(px, pierH / 2 + 4, z - depth / 2 - pierLen / 2);
    group.add(pier);
    // ピアの脚
    for (let k = 0; k < 3; k++) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(2.4, 4, 2.4), legMat);
      leg.position.set(px, 2, z - depth / 2 - pierLen * (0.2 + 0.3 * k));
      group.add(leg);
    }
  }

  // 車寄せ（道路が着くところ）の舗装。ターミナルの裏から、道路が着く位置の少し先まで
  const gateZ = def.gateLocalZ;
  const back = z + depth / 2;
  const fcLen = Math.max(gateZ + 30 - back, 20);
  const forecourt = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.8, fcLen),
    applyDecalOffset(new THREE.MeshLambertMaterial({ color: ASPHALT_COLOR }), OFFSET_PAVEMENT)
  );
  forecourt.rotation.x = -Math.PI / 2;
  forecourt.position.set(def.terminalLocalX, TAXIWAY_Y, back + fcLen / 2);
  group.add(forecourt);

  void apron;
  return group;
}

function buildControlTower(x, z, def) {
  const group = new THREE.Group();
  const b = def ? airportBuildings(def) : AIRPORT_BUILDINGS[1];
  const H = b.towerH, R = b.cabR;
  const cabH = Math.max(6, R * 0.75);

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.5, R * 0.7, H, 16),
    new THREE.MeshLambertMaterial({ color: 0x555a61 })
  );
  shaft.position.y = H / 2;
  group.add(shaft);

  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R * 0.82, cabH, 16),
    new THREE.MeshLambertMaterial({ color: 0x1d2b3a })
  );
  cab.position.y = H + cabH / 2;
  group.add(cab);

  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.05, R * 1.05, 1.4, 16),
    new THREE.MeshLambertMaterial({ color: 0x3d4249 })
  );
  roof.position.y = H + cabH + 0.7;
  group.add(roof);

  group.position.set(x, 0, z);
  return group;
}

// 灯火のにじみ（ブルーム）。芯の何倍の大きさで、どれだけ薄く重ねるか。
// （4.5 / 0.22 だと滑走路全体がぼんやり白く浮いて見えたので弱めた）
const AIRPORT_GLOW_SCALE = 2.8;
const AIRPORT_GLOW_OPACITY = 0.10;

// 滑走路灯・進入灯・末端灯・誘導路灯を1つのPointsにまとめる（頂点カラーで色を分ける）
function buildAirportLights(L, W, taxi, offsets) {
  const positions = [];
  const colors = [];
  const halfL = L / 2;

  const add = (x, z, hex, y = LIGHT_Y) => {
    positions.push(x, y, z);
    const c = new THREE.Color(hex);
    colors.push(c.r, c.g, c.b);
  };

  // 滑走路ごとに（平行滑走路なら本数ぶん）灯火を置く。
  // メッシュは1つにまとめる——空港1つで数百点あるので、本数ぶんPointsを作ると
  // 描画呼び出しがそのまま増える。
  for (const base of (offsets || [0])) {
    // 滑走路灯（両側の縁に60m間隔の白）
    const edgeZ = W / 2 + 2;
    for (let x = -halfL; x <= halfL + 0.1; x += 60) {
      add(x, base + edgeZ, 0xfff2cc);
      add(x, base - edgeZ, 0xfff2cc);
    }

    [1, -1].forEach((dir) => {
      const thr = dir * halfL;
      // 末端灯（外側から見ると緑、滑走路側は赤）
      for (let i = 0; i < 9; i++) {
        const z = base + (i - 4) * (W / 8);
        add(thr + dir * 2.5, z, 0x38ff7a);
        add(thr - dir * 2.5, z, 0xff3a3a);
      }
      // 進入灯（しきい値の外側300mまで、中心線上に30m間隔。150mの位置に横バー）
      for (let d = 30; d <= 300; d += 30) {
        add(thr + dir * d, base, 0xffffff);
        if (d === 150) {
          for (let i = -3; i <= 3; i++) {
            if (i !== 0) add(thr + dir * d, base + i * 4, 0xffffff);
          }
        }
      }
    });
  }

  // 誘導路灯（青）。位置は誘導路の形と一緒に buildTaxiwayAndApron が決める
  for (let i = 0; i < taxi.lights.length; i += 2) add(taxi.lights[i], taxi.lights[i + 1], 0x4aa3ff);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));

  if (!_lightSpriteTexture) _lightSpriteTexture = buildLightSpriteTexture();
  const mat = new THREE.PointsMaterial({
    size: 11, map: _lightSpriteTexture, vertexColors: true, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
  });
  const core = new THREE.Points(geo, mat);
  // 描く順番は雲底のあと、こちら側の積雲と同じ組（ENV_ORDER.clouds）。
  // 同じ組のなかは three.js が遠い順に並べるので、空港より手前の雲は灯りに重なり、
  // 向こうの雲は灯りの下になる。雲底は不透明に近いときは深度を書くので、
  // 雲の上から見下ろせば灯りは隠れる。
  // 以前は何も指定せず（0）、にじみは -1 だったので、半透明のなかで最初に描かれて、
  // 手前にあっても雲底や霞に上から塗られ、雲底の向こうにあるように見えた。
  core.renderOrder = ENV_ORDER.clouds;

  // **にじみ（ブルーム）**。画面ぜんぶに後処理を掛けるやり方（EffectComposer +
  // UnrealBloomPass）は取らない——(1) CDNから5本も追加で読むことになり、
  // このページはCDNが落ちたときの代替経路まで用意してある、(2) 明るいところが
  // 一律ににじむので、**街明かりや水面の照り返しまで光ってしまう**（欲しいのは
  // 空港の灯火と航行灯だけ）、(3) スマホで毎フレーム全画面を2回描き直す負担が重い。
  // 同じ頂点をもう一組、大きく薄く加算で重ねるだけで、灯りのまわりの
  // にじみはそれらしく出る。対象も「重ねた灯りだけ」に限れる。
  const glowMat = new THREE.PointsMaterial({
    size: 11 * AIRPORT_GLOW_SCALE, map: _lightSpriteTexture, vertexColors: true,
    sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Points(geo, glowMat);
  glow.renderOrder = ENV_ORDER.clouds; // 芯と同じ組（加算なので芯との前後は見た目に響かない）
  core.add(glow);
  core.userData.glow = glow;
  return core;
}

// 吹き流し。yaw用とpitch用のGroupを分けて、向き（風向）と垂れ具合（風速）を別々に回す
function buildWindsock(x, z) {
  const root = new THREE.Group();
  root.position.set(x, 0, z);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.35, 9, 8),
    new THREE.MeshLambertMaterial({ color: 0xb9bec4 })
  );
  pole.position.y = 4.5;
  root.add(pole);

  const yaw = new THREE.Group();
  yaw.position.y = 9;
  root.add(yaw);

  const pitch = new THREE.Group();
  yaw.add(pitch);

  // オレンジと白の5本縞。円錐台を並べて筒にする（+X方向へ伸ばす）
  const bandLen = 1.3;
  const colors = [0xff7418, 0xf5f5f5, 0xff7418, 0xf5f5f5, 0xff7418];
  let radius = 1.0;
  colors.forEach((color, i) => {
    const rTop = radius, rBottom = radius * 0.88;
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(rBottom, rTop, bandLen, 14, 1, true),
      new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })
    );
    // 円柱は+Y方向なので、-90°回して+X方向へ寝かせる
    band.rotation.z = -Math.PI / 2;
    band.position.x = bandLen * (i + 0.5);
    pitch.add(band);
    radius = rBottom;
  });

  return { root, yaw, pitch };
}

// --- 組み立てと更新 ---------------------------------------------------------

// 世界に定義されたすべての空港（js/env/03b-world.js の WORLD_AIRPORTS）を建てる。
// 位置・標高・滑走路の向きはマップ側で固定されており、地形はその標高へならされている。
// 世界に定義された空港（js/env/03b-world.js の WORLD_AIRPORTS）は82か所ある。
// 全部を建てっぱなしにすると重いので、地形と同じく **カメラの周りだけ** 建てて、
// 離れたら片付ける。滑走路の長さなどの変更は空港IDごとの設定として残るので、
// いったん圏外へ出て戻ってきても設定は失われない。
const AIRPORT_ACTIVE_RADIUS = 120000;

// 空港IDごとの設定。マップ定義からの変更ぶんだけをここに持つ（保存/読込の対象でもある）。
function getAirportSettings(id) {
  let s = EnvState.airportSettings[id];
  if (!s) {
    const def = worldAirportById(id);
    if (!def) return null;
    s = EnvState.airportSettings[id] = {
      runwayLengthM: def.runwayLengthM,
      runwayWidthM: def.runwayWidthM,
      headingDeg: def.headingDeg,
      lightsMode: 'auto',
      visible: true,
    };
  }
  return s;
}

// この設定はマップの定義から変更されているか（保存すべきか）を判定する
function airportSettingsChanged(id) {
  const def = worldAirportById(id);
  const s = EnvState.airportSettings[id];
  if (!def || !s) return false;
  return s.runwayLengthM !== def.runwayLengthM || s.runwayWidthM !== def.runwayWidthM
    || s.headingDeg !== def.headingDeg || s.lightsMode !== 'auto' || s.visible !== true;
}

function selectedAirportDef() { return worldAirportById(EnvState.selectedAirportId); }
function selectedAirportSettings() { return getAirportSettings(EnvState.selectedAirportId); }

function initAirport() {
  EnvState.airportSettings = EnvState.airportSettings || {};
  EnvState.builtAirports = new Map();
  // 起動時は原点にいちばん近い空港を選んでおく
  EnvState.selectedAirportId = worldNearestAirport(0, 0).airport.id;
  refreshAirports(true);
}

// カメラの周りにあるべき空港を揃える。選択中の空港は距離に関わらず必ず建てておく
// （UIで選んだ直後、まだカメラが着いていない間も見えるように）。
function refreshAirports() {
  if (!EnvState.builtAirports) return; // 地形の初期化のほうが先に走るため
  const cam = EnvState.camera.position;

  for (const def of WORLD_AIRPORTS) {
    const near = Math.hypot(def.x - cam.x, def.z - cam.z) < AIRPORT_ACTIVE_RADIUS;
    const wanted = near || def.id === EnvState.selectedAirportId;
    const built = EnvState.builtAirports.has(def.id);
    if (wanted && !built) buildAirportInstance(def);
    else if (!wanted && built) disposeAirportInstance(def.id);
  }
}

// 空港一式を組み立ててシーンへ入れる。
// 中身は原点まわりのローカル座標で作り、グループをワールド上の位置＋標高に置く。
function buildAirportInstance(def) {
  const st = getAirportSettings(def.id);
  const group = new THREE.Group();
  group.position.set(def.x, def.elevationM, def.z);
  EnvState.scene.add(group);

  const entry = { def, group, lights: null, windsockYaw: null, windsockPitch: null };
  EnvState.builtAirports.set(def.id, entry);
  populateAirportGroup(entry, st);
  return entry;
}

function populateAirportGroup(entry, st) {
  const group = entry.group;
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeAirportObject(child);
  }

  const L = st.runwayLengthM, W = st.runwayWidthM;
  const def = entry.def;
  const n = def.runwayCount || 1;
  const spacing = def.runwaySpacingM || 480;
  const span = airportRunwayHalfSpan(def);

  // 滑走路の中心線のローカルZ（1本なら[0]、3本なら[-480,0,480]）
  const offsets = [];
  for (let k = 0; k < n; k++) offsets.push(-span + k * spacing);

  // 草地はターミナルと管制塔（エプロンの脇）まで収まる幅に
  group.add(buildAirfieldGround(L, W, span, def.terminalLocalZ, def.terminalLocalX,
    (airportBuildings(def).termW + 80) / 2 + 200));

  offsets.forEach((off, k) => {
    const rw = new THREE.Group();
    rw.position.z = off;
    // 方位を変えたときに数字だけ描き直せるよう、どの滑走路かを覚えておく
    rw.userData.runwayIndex = k;
    rw.userData.runwayCount = n;
    rw.add(buildRunwaySurface(L, W));
    rw.add(buildRunwayMarkings(L, W));
    rw.add(buildRunwayNumbers(L, st.headingDeg, parallelSuffix(k, n)));
    group.add(rw);
  });

  const taxi = buildTaxiwayAndApron(L, W, def);
  group.add(taxi.group);
  group.add(buildTerminal(def, taxi));
  group.add(buildControlTower(taxi.taxiX - taxi.apronW / 2 - 70, taxi.apronZ - 30, def));

  entry.lights = buildAirportLights(L, W, taxi, offsets);
  group.add(entry.lights);

  const sock = buildWindsock(-L / 2 + 60, span + W / 2 + 45);
  entry.windsockYaw = sock.yaw;
  entry.windsockPitch = sock.pitch;
  group.add(sock.root);

  group.rotation.y = THREE.MathUtils.degToRad(90 - st.headingDeg);
  group.visible = st.visible;
  // 向きが変わっていればターミナルも回っているので、そこへ来る道路を引き直す
  // （設定の読込・初期化・作り直しのどの経路から来ても揃うよう、ここで呼ぶ）
  if (typeof rebuildAirportRoads === 'function') rebuildAirportRoads(def.id);
}

function disposeAirportInstance(id) {
  const entry = EnvState.builtAirports.get(id);
  if (!entry) return;
  while (entry.group.children.length > 0) {
    const child = entry.group.children[0];
    entry.group.remove(child);
    disposeAirportObject(child);
  }
  EnvState.scene.remove(entry.group);
  EnvState.builtAirports.delete(id);
}

// 選択中の空港を、いまの設定で作り直す（滑走路の長さ・幅を変えたとき）
function rebuildSelectedAirport() {
  const entry = EnvState.builtAirports.get(EnvState.selectedAirportId);
  if (entry) populateAirportGroup(entry, selectedAirportSettings());
}

// 方位はグループ全体の回転だけで表す（端の数字だけ描き直しが要る）
function applyAirportHeading() {
  const entry = EnvState.builtAirports.get(EnvState.selectedAirportId);
  if (!entry) return;
  entry.group.rotation.y = THREE.MathUtils.degToRad(90 - selectedAirportSettings().headingDeg);
  if (typeof rebuildAirportRoads === 'function') rebuildAirportRoads(EnvState.selectedAirportId);
}

// 方位を変えると滑走路の数字（26/08 など）が変わる。
// 数字は滑走路ごとのサブグループの中にあるので、**本数ぶん**入れ替える
// （グループの直下を探すだけだと、平行滑走路では1本も見つからない）。
function refreshRunwayNumbers() {
  const entry = EnvState.builtAirports.get(EnvState.selectedAirportId);
  if (!entry) return;
  const st = selectedAirportSettings();
  for (const rw of entry.group.children) {
    if (rw.userData.runwayIndex === undefined) continue;
    const old = rw.children.find((c) => c.userData.isRunwayNumbers);
    if (old) {
      rw.remove(old);
      disposeAirportObject(old);
    }
    rw.add(buildRunwayNumbers(st.runwayLengthM, st.headingDeg,
      parallelSuffix(rw.userData.runwayIndex, rw.userData.runwayCount)));
  }
}

// 昼夜に合わせて灯火を点灯/消灯する（03-sky.jsのupdateSkyForSunDirectionから呼ばれる）
function updateAirportForDaylight(dayFactor) {
  const night = 1 - THREE.MathUtils.clamp(dayFactor, 0, 1);
  for (const entry of EnvState.builtAirports.values()) {
    if (!entry.lights) continue;
    const mode = getAirportSettings(entry.def.id).lightsMode;
    const target = mode === 'on' ? 1 : (mode === 'off' ? 0 : night);
    entry.lights.material.opacity = target;
    entry.lights.visible = target > 0.01;
    const glow = entry.lights.userData.glow;
    if (glow) glow.material.opacity = target * AIRPORT_GLOW_OPACITY;
  }
}

// 吹き流しを風向へ向け、風速に応じて水平まで持ち上げる（建っている空港すべて）
function updateWindsock() {
  // 風のベクトルは04-clouds.jsと同じ定義（windDirectionDegは「風が流れていく向き」）
  const d = THREE.MathUtils.degToRad(EnvState.env.windDirectionDeg);
  // 30km/hで水平、0km/hでほぼ真下
  const windFactor = THREE.MathUtils.clamp(EnvState.env.windSpeedKmh / 30, 0, 1);
  const pitch = -(1 - windFactor) * THREE.MathUtils.degToRad(78);

  for (const entry of EnvState.builtAirports.values()) {
    if (!entry.windsockYaw) continue;
    // +X を (cos d, 0, sin d) に向ける回転は rotation.y = -d。空港ごと回っているぶんを差し引く
    entry.windsockYaw.rotation.y = -d - entry.group.rotation.y;
    entry.windsockPitch.rotation.z = pitch;
  }
}

// 選択中の空港へ視点を移す。
// 滑走路の全長が入るよう、進入方向の斜め手前から見下ろす。
function focusCameraOnAirport() {
  const def = selectedAirportDef();
  if (!def) return;
  const st = getAirportSettings(def.id);
  const L = st.runwayLengthM;

  // 滑走路の伸びる向き（方位θ）と、その直交方向
  const hd = THREE.MathUtils.degToRad(st.headingDeg);
  const fx = Math.sin(hd), fz = -Math.cos(hd);
  const sx = -fz, sz = fx;

  EnvState.orbitControls.target.set(def.x, def.elevationM, def.z);
  EnvState.camera.position.set(
    def.x - fx * L * 0.60 + sx * L * 0.22,
    def.elevationM + L * 0.17,
    def.z - fz * L * 0.60 + sz * L * 0.22
  );
  EnvState.orbitControls.update();

  // 飛んだ先の地形・街・空港はまだ無いので、その場で揃える
  // （terrainRebuildNow の中で街と空港の出し入れも行われる）
  if (typeof terrainRebuildNow === 'function') terrainRebuildNow();
}
