// 04b-airport.js — 空港（滑走路・誘導路・エプロン・管制塔・灯火・吹き流し）
// 既定の空港をパラメータから手続き的に生成する。外部モデル(GLB)の読込対応は今後。
//
// 座標の決めごと：
//   空港はローカル座標で「滑走路の長さ方向 = +X、幅方向 = Z」で組み立て、
//   方位（真北0°・時計回り）は空港グループ全体の rotation.y だけで表す。
//   ワールドは -Z が北、+X が東。方位θの向きは (sinθ, 0, -cosθ) なので、
//   +X をその向きに合わせる回転は rotation.y = 90° - θ になる。

// 地面(y=0)の上に、整地エリア→舗装→標識の順で重ねる。
// 数km先でも描き負けないよう、高さ差は「見た目に響かない範囲で大きめ」に取り、
// さらに各マテリアルへポリゴンオフセット（デカール用の深度バイアス）をかけている。
const AIRFIELD_Y = 0.4;
const TAXIWAY_Y = 0.8;
const RUNWAY_SURFACE_Y = 1.0;
const RUNWAY_MARK_Y = 1.4;
const LIGHT_Y = 2.2;

// 重ね順（数字が大きいほど手前に描く）
const OFFSET_AIRFIELD = 1;
const OFFSET_PAVEMENT = 2;
const OFFSET_MARKING = 4;
const OFFSET_NUMBER = 6;

// 同一平面上に重なる面が深度で喧嘩しないよう、描画順に応じた深度バイアスを与える
function applyDecalOffset(material, rank) {
  material.polygonOffset = true;
  material.polygonOffsetFactor = -rank;
  material.polygonOffsetUnits = -rank;
  return material;
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
function buildAirfieldGround(L, W) {
  const depth = W + 700; // 誘導路・エプロン側へ伸ばす
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(L + 700, depth),
    applyDecalOffset(new THREE.MeshLambertMaterial({ color: AIRFIELD_GRASS_COLOR }), OFFSET_AIRFIELD)
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, AIRFIELD_Y, depth / 2 - W / 2 - 60);
  return mesh;
}

function buildRunwaySurface(L, W) {
  const geo = new THREE.PlaneGeometry(L, W);
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
function buildRunwayNumbers(L, headingDeg) {
  const group = new THREE.Group();
  const { near, far } = runwayDesignators(headingDeg);
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

function buildTaxiwayAndApron(L, W) {
  const group = new THREE.Group();
  const taxiX = -L / 2 + 150;      // 誘導路が滑走路から分かれる位置
  const taxiLen = 220;             // 滑走路脇からエプロンまでの長さ
  const taxiWidth = 23;
  const taxiCenterZ = W / 2 + taxiLen / 2;

  const taxiMat = applyDecalOffset(new THREE.MeshLambertMaterial({ color: ASPHALT_COLOR }), OFFSET_PAVEMENT);
  const taxiway = new THREE.Mesh(new THREE.PlaneGeometry(taxiWidth, taxiLen), taxiMat);
  taxiway.rotation.x = -Math.PI / 2;
  taxiway.position.set(taxiX, TAXIWAY_Y, taxiCenterZ);
  group.add(taxiway);

  const apronZ = W / 2 + taxiLen + 90;
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(260, 180),
    applyDecalOffset(new THREE.MeshLambertMaterial({ color: CONCRETE_COLOR }), OFFSET_PAVEMENT)
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(taxiX + 40, TAXIWAY_Y, apronZ);
  group.add(apron);

  // 誘導路の黄色いセンターライン
  const p = [];
  for (let z = W / 2 + 6; z < W / 2 + taxiLen; z += 20) {
    pushRectXZ(p, taxiX, z, 0.9, 12, TAXIWAY_Y + 0.02); // 長さ方向がZなので幅と長さを入れ替えて置く
  }
  group.add(meshFromRects(p, TAXI_MARKING_COLOR));

  return { group, taxiX, taxiCenterZ, taxiLen, taxiWidth, apronZ };
}

function buildControlTower(x, z) {
  const group = new THREE.Group();

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(5, 6.5, 28, 16),
    new THREE.MeshLambertMaterial({ color: 0x555a61 })
  );
  shaft.position.y = 14;
  group.add(shaft);

  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 7.5, 7, 16),
    new THREE.MeshLambertMaterial({ color: 0x1d2b3a })
  );
  cab.position.y = 31;
  group.add(cab);

  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(9.5, 9.5, 1.2, 16),
    new THREE.MeshLambertMaterial({ color: 0x3d4249 })
  );
  roof.position.y = 35.2;
  group.add(roof);

  group.position.set(x, 0, z);
  return group;
}

// 滑走路灯・進入灯・末端灯・誘導路灯を1つのPointsにまとめる（頂点カラーで色を分ける）
function buildAirportLights(L, W, taxi) {
  const positions = [];
  const colors = [];
  const halfL = L / 2;

  const add = (x, z, hex, y = LIGHT_Y) => {
    positions.push(x, y, z);
    const c = new THREE.Color(hex);
    colors.push(c.r, c.g, c.b);
  };

  // 滑走路灯（両側の縁に60m間隔の白）
  const edgeZ = W / 2 + 2;
  for (let x = -halfL; x <= halfL + 0.1; x += 60) {
    add(x, edgeZ, 0xfff2cc);
    add(x, -edgeZ, 0xfff2cc);
  }

  [1, -1].forEach((dir) => {
    const thr = dir * halfL;
    // 末端灯（外側から見ると緑、滑走路側は赤）
    for (let i = 0; i < 9; i++) {
      const z = (i - 4) * (W / 8);
      add(thr + dir * 2.5, z, 0x38ff7a);
      add(thr - dir * 2.5, z, 0xff3a3a);
    }
    // 進入灯（しきい値の外側300mまで、中心線上に30m間隔。150mの位置に横バー）
    for (let d = 30; d <= 300; d += 30) {
      add(thr + dir * d, 0, 0xffffff);
      if (d === 150) {
        for (let i = -3; i <= 3; i++) {
          if (i !== 0) add(thr + dir * d, i * 4, 0xffffff);
        }
      }
    }
  });

  // 誘導路灯（青）
  for (let z = W / 2 + 10; z < W / 2 + taxi.taxiLen; z += 30) {
    add(taxi.taxiX + taxi.taxiWidth / 2 + 2, z, 0x4aa3ff);
    add(taxi.taxiX - taxi.taxiWidth / 2 - 2, z, 0x4aa3ff);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));

  if (!_lightSpriteTexture) _lightSpriteTexture = buildLightSpriteTexture();
  const mat = new THREE.PointsMaterial({
    size: 11, map: _lightSpriteTexture, vertexColors: true, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
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

  group.add(buildAirfieldGround(L, W));
  group.add(buildRunwaySurface(L, W));
  group.add(buildRunwayMarkings(L, W));
  group.add(buildRunwayNumbers(L, st.headingDeg));

  const taxi = buildTaxiwayAndApron(L, W);
  group.add(taxi.group);
  group.add(buildControlTower(taxi.taxiX - 110, taxi.apronZ - 40));

  entry.lights = buildAirportLights(L, W, taxi);
  group.add(entry.lights);

  const sock = buildWindsock(-L / 2 + 60, W / 2 + 45);
  entry.windsockYaw = sock.yaw;
  entry.windsockPitch = sock.pitch;
  group.add(sock.root);

  group.rotation.y = THREE.MathUtils.degToRad(90 - st.headingDeg);
  group.visible = st.visible;
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
}

function refreshRunwayNumbers() {
  const entry = EnvState.builtAirports.get(EnvState.selectedAirportId);
  if (!entry) return;
  const st = selectedAirportSettings();
  const old = entry.group.children.find((c) => c.userData.isRunwayNumbers);
  if (old) {
    entry.group.remove(old);
    disposeAirportObject(old);
  }
  entry.group.add(buildRunwayNumbers(st.runwayLengthM, st.headingDeg));
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
