// 09b-aircraft-visual.js — 飛ばす機体の見た目
//
// 見た目は2通り。
//   1. Builder（index.html）で作った機体。IndexedDBに入っているGLBと部品定義を読む。
//      同じオリジンなので、保存し直さなくてもそのまま出てくる。
//   2. Builderで何も作っていない場合の内蔵機。板と箱で組んだ練習機。
//      flight.html だけを開いた人がいきなり飛べるように用意してある。
//
// どちらも 09-aircraft.js が同じ書式の定義として受け取るので、
// 飛行モデルの作りかたは1本で済む。ここが面倒を見るのは表示だけ。
//
// 階層は aircraftGroup（＝機体座標そのもの。物理の姿勢がここに入る）
//   └ orientGroup（09-aircraft.js が求めた向きの補正。モデルの前後を標準に合わせる）
//       └ modelRoot（重心が原点に来るように戻す）
//           └ modelXform（Builderの root.rotation / root.scale）
//               └ GLBのメッシュ、または内蔵機の形／Builderで置いた航行灯
//
// **modelXform は Builder の `State.model.root` と同じ役割**で、メッシュもパーツ由来の
// 灯火もその下に入る。Builderでは機体全体を回すとメッシュもパーツも一緒に回るので、
// こちらでも同じ形にしないと食い違う。実際、以前はメッシュにだけ root.rotation を
// 掛けていて、前後を反転させた機体は「物理は反転しているのに見た目は元のまま」だった。

const AIRCRAFT_DB_NAME = 'flightSimDB';
const AIRCRAFT_STORE_CONFIGS = 'configs';
const AIRCRAFT_STORE_META = 'meta';

// --- Builderの保存を読む ------------------------------------------------------

function openBuilderDB() {
  return new Promise((resolve, reject) => {
    // Builder側が作ったDBをそのまま開く。まだ無ければ onupgradeneeded で空のまま作られる。
    const req = indexedDB.open(AIRCRAFT_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(AIRCRAFT_STORE_CONFIGS)) db.createObjectStore(AIRCRAFT_STORE_CONFIGS, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(AIRCRAFT_STORE_META)) db.createObjectStore(AIRCRAFT_STORE_META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
function idbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

// Builderで最後に触っていた機体を取ってくる。無ければ null。
async function loadBuilderAircraftConfigs() {
  try {
    const db = await openBuilderDB();
    const all = await idbGetAll(db, AIRCRAFT_STORE_CONFIGS);
    const meta = await idbGet(db, AIRCRAFT_STORE_META, 'lastConfigName');
    const lastName = meta ? meta.value : null;
    // 翼が1枚も無い機体は飛ばせないので候補から外す
    const usable = all.filter((c) => (c.parts || []).some((p) => p.type === 'wing'));
    usable.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    const last = usable.find((c) => c.name === lastName);
    return { list: usable, preferred: last || usable[0] || null };
  } catch (err) {
    console.warn('Builderの機体を読めませんでした:', err);
    return { list: [], preferred: null };
  }
}

// --- 内蔵機の形 ---------------------------------------------------------------

function buildBuiltinAircraftMesh() {
  const group = new THREE.Group();
  const paint = (color, opts) => new THREE.MeshStandardMaterial(
    Object.assign({ color, roughness: 0.55, metalness: 0.1 }, opts || {}));

  const body = paint(0xdfe4ea);
  const trim = paint(0x2f6fb5);
  const dark = paint(0x2a2f36);

  // 胴体。前が細く後ろが絞れた紡錘。円柱を3本つないで作る。
  const fuse = new THREE.Group();
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.58, 1.5, 16), body);
  nose.rotation.x = Math.PI / 2; nose.position.z = -2.15;
  const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.55, 2.6, 16), body);
  mid.rotation.x = Math.PI / 2; mid.position.z = -0.1;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.16, 3.2, 16), body);
  tail.rotation.x = Math.PI / 2; tail.position.z = 2.8;
  fuse.add(nose, mid, tail);
  fuse.position.y = 1.25;
  group.add(fuse);

  // 風防
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.52, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshStandardMaterial({ color: 0x8fc4e8, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.55 })
  );
  canopy.position.set(0, 1.75, -0.55);
  canopy.scale.set(1, 0.85, 1.7);
  group.add(canopy);

  // 主翼（高翼）。左右を1枚の板で通す。
  const wing = new THREE.Mesh(new THREE.BoxGeometry(11.0, 0.14, 1.55), body);
  wing.position.set(0, 1.95, 0.05);
  wing.rotation.x = THREE.MathUtils.degToRad(-2); // 取付角ぶんだけ前縁を上げる
  group.add(wing);
  // 支柱
  for (const sx of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.3, 8), dark);
    strut.position.set(sx * 1.75, 1.35, 0.2);
    strut.rotation.z = sx * THREE.MathUtils.degToRad(38);
    group.add(strut);
  }

  // 尾翼
  const htail = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.10, 0.95), body);
  htail.position.set(0, 1.25, 4.35);
  group.add(htail);
  const vtail = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.45, 1.20), trim);
  vtail.position.set(0, 2.05, 4.20);
  group.add(vtail);

  // エンジンとプロペラ
  const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 16), trim);
  cowl.rotation.x = Math.PI / 2; cowl.position.set(0, 1.25, -2.75);
  group.add(cowl);
  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.9, 0.05), dark);
  prop.position.set(0, 1.25, -3.02);
  group.add(prop);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 24),
    new THREE.MeshBasicMaterial({ color: 0xd8dee6, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
  );
  disc.position.set(0, 1.25, -3.05);
  group.add(disc);

  // 帯
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 5.6), trim);
  stripe.position.set(0, 1.05, 0.4);
  group.add(stripe);

  group.userData.propeller = prop;
  group.userData.propDisc = disc;
  return group;
}

// 内蔵機の脚（前脚＋主脚）。格納しないので固定脚として作る。
function buildBuiltinGear() {
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9 });
  const legs = new THREE.Group();
  const leg = (x, z, len, r) => {
    const g = new THREE.Group();
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len, 8), dark);
    strut.position.y = len / 2;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.42, 8, 14), rubber);
    wheel.rotation.y = Math.PI / 2;
    g.add(strut, wheel);
    g.position.set(x, 0, z);
    return g;
  };
  legs.add(leg(0, -1.35, 1.05, 0.20));
  legs.add(leg(-1.30, 0.35, 1.05, 0.24));
  legs.add(leg(1.30, 0.35, 1.05, 0.24));
  return legs;
}

// --- 機体を組み立てる ---------------------------------------------------------

// GLBのバイト列からシーンを作る（Builderと同じ GLTFLoader を使う）
function parseAircraftGLB(buffer) {
  return new Promise((resolve, reject) => {
    if (typeof THREE.GLTFLoader !== 'function') { reject(new Error('GLTFLoader がありません')); return; }
    new THREE.GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene), reject);
  });
}

// 飛行モデル（09-aircraft.js）と、それに対応する見た目をまとめて作る
// cgOverride を渡すと、その重心で飛行モデルと見た目を組む
// （飛行中に重心を動かせるようにするため。渡さなければ config のとおり）
async function createAircraft(config, cgOverride) {
  const cg = cgOverride || config.cg || { x: 0, y: 0, z: 0 };
  const model = buildAircraftModel(cgOverride ? Object.assign({}, config, { cg }) : config);

  const group = new THREE.Group();          // 機体座標。物理の位置と姿勢がここに入る
  group.name = 'aircraft';

  // 09-aircraft.js が機首を-Zに揃えるために掛けた回転を、見た目にも同じだけ掛ける。
  // こうしないと物理と見た目の向きが食い違う。
  const orient = new THREE.Group();
  orient.quaternion.copy(model.qFix);
  group.add(orient);

  // 重心が原点に来るように、モデル全体を重心ぶん戻す。
  // ここで引くのは**機体まるごとの回転を掛けたあとの重心**（model.cgModel）。
  // 回す前の値を引くと、機体を回した機体だけ重心の位置がずれる。
  const cgModel = model.cgModel || acVec(cg);
  const modelRoot = new THREE.Group();
  modelRoot.position.set(-cgModel.x, -cgModel.y, -cgModel.z);
  orient.add(modelRoot);

  // Builderの `State.model.root` にあたる入れ物。メッシュもパーツ由来の航行灯も
  // ここの子にする——Builderで機体全体を回したとき、両方が一緒に回るのと同じ形にする。
  const modelXform = new THREE.Group();
  const t = config.modelTransform;
  if (t) {
    if (t.rotation) modelXform.rotation.set(t.rotation.x || 0, t.rotation.y || 0, t.rotation.z || 0);
    if (t.scale) modelXform.scale.set(t.scale.x || 1, t.scale.y || 1, t.scale.z || 1);
  }
  modelRoot.add(modelXform);

  let visual = null;
  let source = 'builtin';
  if (config.modelBuffer) {
    try {
      visual = await parseAircraftGLB(config.modelBuffer);
      source = 'builder';
      const off = config.modelMeshOffset;
      if (off) visual.position.set(off.x || 0, off.y || 0, off.z || 0);
      visual.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    } catch (err) {
      console.warn('機体のモデルを読めなかったので内蔵機で代用します:', err);
      visual = null;
    }
  }
  if (!visual) {
    visual = buildBuiltinAircraftMesh();
    visual.add(buildBuiltinGear());
  }
  modelXform.add(visual);

  // 航行灯。Builderの定義があればその位置に、無ければ翼端と尾に置く。
  const lights = buildAircraftLights(config, model, modelXform, group);

  // 着陸灯が照らす地面。機体の傾きを持ち込みたくないので group の子にしつつ、
  // 毎フレーム「世界で水平・地面のすぐ上」になるように置き直す（機体と一緒に
  // 捨てられるので、後始末を別に書かなくて済む）。
  const landingPool = buildLandingPool();
  group.add(landingPool);

  // 排気と炎（エンジンの種別ごと）。機体座標のまま置けるので group の子。
  const plumes = buildEnginePlumes(model, group);

  // 飛行機雲。**ワールドに置き去りにする**ものなので機体の子にはできない。
  // 機体と一緒に片付けられるよう、入れ物だけここで作って呼び出し側が
  // シーンに足す（12-flight-mode.js）。
  const contrail = buildContrail(model);

  return {
    model, group, orient, modelRoot, modelXform, visual, lights, landingPool,
    plumes, contrail, fx: contrail.group,
    source,
    name: config.name || (source === 'builder' ? '機体' : '内蔵の練習機'),
    propeller: visual.userData ? visual.userData.propeller : null,
    propDisc: visual.userData ? visual.userData.propDisc : null,
    propAngle: 0,
  };
}

// 航行灯（左舷赤・右舷緑・尾白・ビーコン・ストロボ）
//
// Builderで置いた灯りは**パーツの座標のまま**なので、メッシュと同じ入れ物
// （機体まるごとの回転がかかる modelXform）へ入れる。
// 定義が無い機体に付ける代わりの灯りは「左翼端・右翼端・尾」という**機体基準**の
// 置き方なので、向きを直したあとの機体座標（bodyParent、機首が-Z・重心が原点）へ入れる。
// 同じ入れ物に混ぜると、前後を反転させた機体で尾灯が機首に付く。
function buildAircraftLights(config, model, modelParent, bodyParent) {
  const defs = (config.parts || []).filter((p) => p.type === 'light');
  const out = [];
  const mk = (parent, kind, x, y, z) => {
    const info = LIGHT_KINDS_FALLBACK[kind] || LIGHT_KINDS_FALLBACK.nav_white_tail;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 8),
      new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 1, fog: false })
    );
    mesh.position.set(x, y, z);
    mesh.renderOrder = 4;
    parent.add(mesh);
    // **にじみ（ブルーム）**。空港の灯火と同じ考え方で、画面ぜんぶの後処理では
    // なく「光らせたいものにだけ薄い光の玉を重ねる」（04b-airport.js の
    // AIRPORT_GLOW_SCALE の説明を参照）。カメラのほうを向き続ける板なので、
    // どの角度から見ても丸いにじみになる。
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      color: info.color, map: navLightGlowTexture(), transparent: true,
      opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    glow.scale.setScalar(NAV_LIGHT_GLOW_SIZE);
    glow.position.copy(mesh.position);
    glow.renderOrder = 3;
    parent.add(glow);
    out.push({ mesh, glow, kind, blink: info.blink });
  };

  if (defs.length) {
    for (const d of defs) {
      mk(modelParent, (d.props && d.props.kind) || 'nav_white_tail',
        d.position.x, d.position.y, d.position.z);
    }
  } else {
    // **定義が無い機体は、機体の形から置く**。
    // 以前は「翼幅の半分だけ左右へ、高さ0.9m、尾は z=4.9m」という内蔵の練習機の
    // 寸法を決め打ちしていたので、他の機体では灯りが翼の途中や胴体の中、
    // ときには機体の外の何もない空間に浮いていた。実際の翼端・機首・尾の座標を
    // 空力モデル（model.surfaces）から取って置く。
    const g = aircraftLightAnchors(model);
    mk(bodyParent, 'nav_red', g.leftTip.x, g.leftTip.y, g.leftTip.z);
    mk(bodyParent, 'nav_green', g.rightTip.x, g.rightTip.y, g.rightTip.z);
    mk(bodyParent, 'strobe', g.leftTip.x, g.leftTip.y, g.leftTip.z + g.unit * 0.1);
    mk(bodyParent, 'strobe', g.rightTip.x, g.rightTip.y, g.rightTip.z + g.unit * 0.1);
    mk(bodyParent, 'nav_white_tail', g.tail.x, g.tail.y, g.tail.z);
    // ビーコン（赤い回転灯）は上下に1つずつ。実機も胴体の背と腹に付く。
    mk(bodyParent, 'beacon', 0, g.top, g.mid);
    mk(bodyParent, 'beacon', 0, g.bottom, g.mid);
    // 着陸灯。機首まわりの少し下から前を照らす。
    mk(bodyParent, 'landing', 0, g.landing.y, g.landing.z);
  }
  return out;
}

// 灯りを置く場所を、機体の形から求める（機体座標：重心が原点・機首が-Z・上が+Y）。
function aircraftLightAnchors(model) {
  const tipOf = (s, sign) => s.center.clone().addScaledVector(s.spanA, sign * s.span / 2);
  let leftTip = null, rightTip = null, tail = null, nose = null;
  let top = -Infinity, bottom = Infinity;
  const mains = model.surfaces.filter((s) => s.role === 'main');
  const wings = mains.length ? mains : model.surfaces;
  for (const s of wings) {
    for (const sign of [1, -1]) {
      const p = tipOf(s, sign);
      if (!leftTip || p.x < leftTip.x) leftTip = p;
      if (!rightTip || p.x > rightTip.x) rightTip = p;
    }
  }
  // 機首・尾・背・腹は、翼の**四隅**（翼幅方向と翼弦方向の両端）と、
  // エンジン・接地点まで見る。翼幅方向の端だけだと前縁・後縁を見落とすので、
  // 内蔵の練習機では「機首」が胴体の真ん中あたりに出ていた。
  const corner = (s, sSign, cSign) => s.center.clone()
    .addScaledVector(s.spanA, sSign * s.span / 2)
    .addScaledVector(s.fwd, cSign * s.chord / 2);
  const scan = (p, useY) => {
    if (!tail || p.z > tail.z) tail = p;
    if (!nose || p.z < nose.z) nose = p;
    if (!useY) return;
    if (p.y > top) top = p.y;
    if (p.y < bottom) bottom = p.y;
  };
  for (const s of model.surfaces) {
    for (const sSign of [1, -1]) for (const cSign of [1, -1]) scan(corner(s, sSign, cSign), true);
  }
  for (const e of (model.engines || [])) scan(e.position.clone(), true);
  // 接地点は前後の端としてだけ見る。高さまで見ると、車輪の**接地面**が機体の
  // 腹ということになり、ビーコンも着陸灯も地面すれすれに埋まってしまう。
  for (const c of (model.contacts || [])) scan(c.position.clone(), false);
  const unit = Math.max(model.wingSpan, 2);
  if (!leftTip) leftTip = new THREE.Vector3(-unit / 2, 0, 0);
  if (!rightTip) rightTip = new THREE.Vector3(unit / 2, 0, 0);
  if (!tail) tail = new THREE.Vector3(0, 0, unit * 0.4);
  if (!nose) nose = new THREE.Vector3(0, 0, -unit * 0.4);
  if (!(top > -Infinity)) top = unit * 0.1;
  if (!(bottom < Infinity)) bottom = -unit * 0.1;
  // 胴体の背と腹。翼の面だけだと薄っぺらいので、車輪の高さぶんも見る。
  const gear = model.gearHeight || unit * 0.1;
  return {
    leftTip, rightTip, tail, nose, unit,
    top: Math.max(top, unit * 0.04) + unit * 0.01,
    bottom: Math.min(bottom, -gear * 0.35),
    mid: (nose.z + tail.z) / 2,
    // 着陸灯は機首より少し後ろ・少し下（機首そのものに置くと、機体の中に埋まる）
    landing: { y: Math.min(bottom, -gear * 0.25), z: nose.z + unit * 0.06 },
  };
}

// --- 着陸灯 -------------------------------------------------------------------
//
// **なぜ THREE.SpotLight を使わないか**。
// three.js の MeshLambertMaterial は**頂点ごと**に明るさを計算する（Gouraud）。
// 地形も滑走路も広い面を粗い頂点で張っているので、面の真ん中にスポットライトの
// 円錐を当てても、どの頂点も円錐の外にいて明るさは 0 のまま——実際に試すと、
// 強さを 3.2 から 300 へ上げても夜の滑走路は 1 ピクセルも変わらなかった。
// そこで「光が当たった地面」を**地面に貼る板**として描く。加算合成なので、
// 頂点の粗さと関係なく、狙ったところがちゃんと明るくなる。
const LANDING_POOL_DOWN_RAD = 0.19;     // 伏せ角およそ11°
const LANDING_POOL_HALF_RAD = 0.16;     // 光の広がり（半角およそ9°）
const LANDING_POOL_FAR_RAD = 0.011;     // 光が届く下限の角度（これで奥行きが決まる）
const LANDING_POOL_MAX_M = 600;         // どんなに低くてもここまで（見た目の上限）
const LANDING_POOL_FADE_FROM_M = 110;   // 対地これより高いと薄れはじめ
const LANDING_POOL_FADE_TO_M = 210;     // ここまで上がると地面には届かない
const LANDING_POOL_OPACITY = 0.85;
// 地面から浮かせる高さ。舗装は地形の上 1.0m、標示は 1.4m に敷いてある
// （04b-airport.js の RUNWAY_SURFACE_Y / RUNWAY_MARK_Y）ので、地形の高さ＋60cm
// では**滑走路の下に潜って一切見えなかった**。標示より上、灯火(2.2m)より下に置く。
const LANDING_POOL_LIFT_M = 1.8;

let _landingPoolTexture = null;
function landingPoolTexture() {
  if (_landingPoolTexture) return _landingPoolTexture;
  const W = 64, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let j = 0; j < H; j++) {
    const t = j / (H - 1);                    // 0=手前 1=奥
    const halfW = 0.18 + 0.82 * t;            // 奥ほど広がる
    const bright = Math.pow(1 - t, 1.4);      // 奥ほど暗い
    const nearFade = Math.min(1, t * 6);      // 手前の切れ目もぼかす
    for (let i = 0; i < W; i++) {
      const u = (i / (W - 1)) * 2 - 1;
      const r = Math.abs(u) / halfW;
      const a = r < 1 ? Math.pow(1 - r * r, 1.5) * bright * nearFade : 0;
      const o = (j * W + i) * 4;
      img.data[o] = 255; img.data[o + 1] = 245; img.data[o + 2] = 216;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  _landingPoolTexture = new THREE.CanvasTexture(canvas);
  return _landingPoolTexture;
}

function buildLandingPool() {
  // 板は XZ 平面に寝かせる。ジオメトリの +Y が -Z（機首の向き）へ向くので、
  // テクスチャの v=1（奥）がそのまま前方になる。
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: landingPoolTexture(), transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    side: THREE.DoubleSide,
    // 滑走路の舗装・標示と同じく、手前へ少し引っぱっておく（04b-airport.js）。
    // このシーンは logarithmicDepthBuffer なので polygonOffset はほぼ効かない。
    // 実際に重なりを避けているのは LANDING_POOL_LIFT_M の高さのほう。
    polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
  }));
  mesh.renderOrder = 2;
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}

const _poolFwd = new THREE.Vector3();
const _poolPos = new THREE.Vector3();

// 着陸灯が照らす地面を、機体の前の地面に描く
function updateLandingLightPool(ac, controls, state) {
  const pool = ac.landingPool;
  if (!pool) return;
  const hasLanding = ac.lights.some((l) => l.kind === 'landing');
  if (!hasLanding || !controls.landingLight) { pool.visible = false; return; }

  // 明るい昼は、実機でも着陸灯の光は地面に見えない。太陽の強さで薄める。
  const sun = EnvState.sunLight ? EnvState.sunLight.intensity / 1.5 : 1;
  const dark = THREE.MathUtils.clamp(1 - sun * 1.6, 0, 1);
  if (dark <= 0.01) { pool.visible = false; return; }

  // 機首の向き（水平成分）
  _poolFwd.set(0, 0, -1).applyQuaternion(ac.group.quaternion);
  _poolFwd.y = 0;
  if (_poolFwd.lengthSq() < 1e-6) { pool.visible = false; return; }
  _poolFwd.normalize();

  const px = state.position.x, pz = state.position.z;
  const gh = typeof flightGroundHeightAt === 'function' ? flightGroundHeightAt(px, pz) : 0;
  // 灯りの高さ。接地していても胴体の下面ぶんは浮いているので、下限を置く。
  const h = Math.max(state.position.y - gh, 1.5);
  const near = h / Math.tan(LANDING_POOL_DOWN_RAD + LANDING_POOL_HALF_RAD);
  const far = Math.min(h / Math.tan(LANDING_POOL_FAR_RAD), LANDING_POOL_MAX_M);
  if (near >= far) { pool.visible = false; return; }

  // 高く上がるほど地面の光は薄くなる（光が広がりきって、見えなくなる）
  const fade = 1 - THREE.MathUtils.smoothstep(h, LANDING_POOL_FADE_FROM_M, LANDING_POOL_FADE_TO_M);
  if (fade <= 0.01) { pool.visible = false; return; }

  const mid = (near + far) / 2;
  const cx = px + _poolFwd.x * mid;
  const cz = pz + _poolFwd.z * mid;
  const cy = (typeof flightGroundHeightAt === 'function' ? flightGroundHeightAt(cx, cz) : 0)
    + LANDING_POOL_LIFT_M;

  pool.visible = true;
  pool.scale.set(far * Math.tan(LANDING_POOL_HALF_RAD) * 2.2, 1, far - near);
  _poolPos.set(cx, cy, cz);
  pool.position.copy(ac.group.worldToLocal(_poolPos));
  // 板は水平のまま、機首の向きだけに合わせる（機体の傾きは持ち込まない）
  pool.quaternion.copy(ac.group.quaternion).invert();
  pool.rotateY(Math.atan2(_poolFwd.x, _poolFwd.z) + Math.PI);
  pool.material.opacity = LANDING_POOL_OPACITY * dark * fade;
}

// --- エンジンの排気と炎 -------------------------------------------------------
//
// エンジンの種別（09-aircraft.js の ENGINE_KINDS）ごとに、出るものが違う。
//   プロペラ … 何も出ない（回る羽根だけ）
//   ジェット … うっすらした排気。出力を上げると少し伸びる
//   AB付き   … 出力9割から上でオレンジの炎。全開でいちばん長い
//   ロケット … 出力に比例した白い炎。いつでも出る
//
// 炎は「根元が太く、後ろへ細くなる円錐」を2枚（芯＋にじみ）重ねて作る。
// 加算合成なので、昼は空に溶け、夜ははっきり光る。
const PLUME_LOOK = {
  // len/rad はエンジン半径に対する倍率、color は芯の色
  prop:   null,
  jet:    { len: 3.0, rad: 0.9, core: 0xbfd4ff, halo: 0x6f86a8, alpha: 0.16, idle: 0.25 },
  jet_ab: { len: 3.0, rad: 0.9, core: 0xbfd4ff, halo: 0x6f86a8, alpha: 0.16, idle: 0.25 },
  rocket: { len: 10.0, rad: 1.25, core: 0xfff6e0, halo: 0xffa33c, alpha: 0.50, idle: 0 },
};
// アフターバーナーの炎（AB付きジェットが9割より上で出す）
const PLUME_AB = { len: 9.0, rad: 1.15, core: 0xfff0d0, halo: 0xff7a2a, alpha: 0.60 };
// 炎のゆらぎ（長さの振れ幅と、1秒あたりの速さ）
const PLUME_FLICKER = 0.14;
const PLUME_FLICKER_HZ = 17;

// 根元が原点、+Y の向きに伸びる円錐。先を細く尖らせておく。
function plumeCone(color, opacity) {
  const geo = new THREE.ConeGeometry(1, 1, 14, 1, true);
  geo.translate(0, 0.5, 0);   // 底面を原点に
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  }));
  mesh.renderOrder = 3;
  mesh.visible = false;
  return mesh;
}

const _plumeDir = new THREE.Vector3();
const _plumeUp = new THREE.Vector3(0, 1, 0);

function buildEnginePlumes(model, parent) {
  const out = [];
  const engines = model.engines || [];
  if (!engines.length) return out;
  const unit = Math.max(model.wingSpan, 2);
  const biggest = Math.max(...engines.map((e) => e.thrustN), 1);
  for (const e of engines) {
    const look = PLUME_LOOK[e.kind];
    if (!look) continue;                       // プロペラは何も出さない
    // ノズルの太さ。推力がいちばん大きいエンジンで翼幅の1割、小さいものは控えめに。
    const r = Math.max(unit * 0.10 * Math.sqrt(e.thrustN / biggest), unit * 0.02);
    // 排気は推力と逆向きに出る
    const dir = _plumeDir.copy(e.axis).negate().normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(_plumeUp, dir);
    const entry = { engine: e, look, radius: r, cones: [] };
    const mk = (color, alpha, radScale) => {
      const c = plumeCone(color, alpha);
      c.position.copy(e.position).addScaledVector(dir, r * 0.3);
      c.quaternion.copy(quat);
      c.userData.radScale = radScale;
      parent.add(c);
      entry.cones.push(c);
      return c;
    };
    entry.halo = mk(look.halo, look.alpha * 0.55, 1.55);
    entry.core = mk(look.core, look.alpha, 1.0);
    if (e.kind === 'jet_ab') {
      entry.abHalo = mk(PLUME_AB.halo, PLUME_AB.alpha * 0.5, 1.5);
      entry.abCore = mk(PLUME_AB.core, PLUME_AB.alpha, 0.85);
      entry.cones.push(entry.abHalo, entry.abCore);
    }
    out.push(entry);
  }
  return out;
}

function updateEnginePlumes(ac, controls, state, elapsed) {
  const plumes = ac.plumes;
  if (!plumes || !plumes.length) return;
  const flicker = 1 + PLUME_FLICKER * Math.sin(elapsed * PLUME_FLICKER_HZ * Math.PI * 2);
  for (const p of plumes) {
    const e = p.engine;
    const off = typeof engineGroupOff === 'function' && engineGroupOff(controls, e.group);
    const lever = off ? 0 : (e.lift ? (controls.vtolThrottle || 0) : controls.throttle);
    const ab = (e.kind === 'jet_ab' && typeof engineAfterburner === 'function')
      ? engineAfterburner(lever) : 0;
    // ふだんの排気。ジェットはアイドルでも少し出る。
    const base = p.look.idle + (1 - p.look.idle) * lever;
    const on = lever > 0.005 || (p.look.idle > 0 && !off);
    const len = p.radius * p.look.len * base * flicker;
    for (const c of [p.halo, p.core]) {
      c.visible = on && len > 1e-3;
      c.scale.set(p.radius * c.userData.radScale, len, p.radius * c.userData.radScale);
    }
    if (p.abCore) {
      const abLen = p.radius * PLUME_AB.len * ab * flicker;
      for (const c of [p.abHalo, p.abCore]) {
        c.visible = ab > 0.01;
        c.scale.set(p.radius * c.userData.radScale, abLen, p.radius * c.userData.radScale);
      }
    }
  }
}

// --- 飛行機雲 -----------------------------------------------------------------
//
// 実機の飛行機雲は2通りの出かたをする。
//   (1) エンジンの排気。**気温が-40℃を下回るくらい高いところ**でだけ、
//       排気の水蒸気が凍って白く残る。だいたい高度8km以上。
//       湿っているほど濃く、長く残る。
//   (2) 翼端の渦。渦の中は気圧が下がって温度も下がるので、**低いところでも
//       空気が湿っていて、強く引き起こしたとき**に白い筋が出る（航空祭でよく見るあれ）。
// 両方とも「点を置いていって、古いものから消す」だけで作る。ワールドに
// 置き去りにするので、機体の子ではなくシーン直下（ac.fx）に入れる。
const CONTRAIL_ALT_FROM_M = 7000;    // ここから出はじめ
const CONTRAIL_ALT_FULL_M = 9500;    // ここで濃さが頭打ち
const CONTRAIL_WET_MIN = 0.10;       // これ以下の乾いた空では出ない
const CONTRAIL_LIFE_S = 16;          // 消えるまで（最長）
const CONTRAIL_PER_EMIT = 300;       // 1か所あたりの点の数
const CONTRAIL_SIZE_SPAN = 2.2;      // 点の大きさ（翼幅に対する倍率）
const CONTRAIL_MAX_ALPHA = 0.55;
// 点は**時間ではなく距離**で置く。時間で置くと、速い機体では点と点が離れて
// 破線になり（実際そうなった）、遅い機体では同じ場所に積み重なって無駄になる。
// 間隔は点の直径に対する割合で決める——重なっていないと筋に見えない。
const CONTRAIL_STEP_MIN_FRAC = 0.25;
const CONTRAIL_STEP_MAX_FRAC = 0.32;
// 翼端の渦。湿っていて、これ以上の荷重を掛けたときだけ出る。
const CONTRAIL_VORTEX_WET = 0.55;
const CONTRAIL_VORTEX_G = 1.5;

let _contrailTexture = null;
function contrailTexture() {
  if (_contrailTexture) return _contrailTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // 中心から半分くらいまではほぼ同じ濃さにして、粒が粒に見えないようにする
  g.addColorStop(0, 'rgba(255,255,255,0.70)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.52)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _contrailTexture = new THREE.CanvasTexture(canvas);
  return _contrailTexture;
}

// 飛行機雲の出どころ。エンジンのノズルと、左右の翼端。
function contrailEmitters(model) {
  const out = [];
  for (const e of (model.engines || [])) {
    if (e.lift) continue;                      // 上向きのリフトエンジンは筋にならない
    out.push({ kind: 'engine', engine: e, local: e.position.clone() });
  }
  const g = aircraftLightAnchors(model);
  out.push({ kind: 'vortex', local: g.leftTip.clone() });
  out.push({ kind: 'vortex', local: g.rightTip.clone() });
  return out;
}

function buildContrail(model) {
  const emitters = contrailEmitters(model);
  const total = emitters.length * CONTRAIL_PER_EMIT;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const age = new Float32Array(total).fill(Infinity);
  const strength = new Float32Array(total);   // 置いたときの濃さ（0〜1）
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // 点はワールド中を飛び回るので、視界外判定は自前では持たない
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    size: Math.max(model.wingSpan, 2) * CONTRAIL_SIZE_SPAN,
    map: contrailTexture(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: true,
    fog: false,
  }));
  points.frustumCulled = false;
  points.renderOrder = 1;
  points.visible = false;
  const group = new THREE.Group();
  group.name = 'aircraft-contrail';
  group.add(points);
  return { group, points, emitters, age, strength,
    cursor: new Int32Array(emitters.length), dist: 0, life: CONTRAIL_LIFE_S };
}

const _ctWorld = new THREE.Vector3();

function updateContrail(ac, controls, state, dt) {
  const ct = ac.contrail;
  if (!ct) return;
  const geo = ct.points.geometry;
  const pos = geo.attributes.position.array;
  const col = geo.attributes.color.array;

  // 出るかどうか。高いところの排気雲と、湿った空での翼端渦。
  const wet = (EnvState.weather && EnvState.weather.current)
    ? EnvState.weather.current.wetness : 0.3;
  const altF = THREE.MathUtils.smoothstep(state.altitudeM, CONTRAIL_ALT_FROM_M, CONTRAIL_ALT_FULL_M);
  const wetF = THREE.MathUtils.clamp((wet - CONTRAIL_WET_MIN) / (1 - CONTRAIL_WET_MIN), 0, 1);
  const engineF = altF * (0.35 + 0.65 * wetF) * THREE.MathUtils.clamp(controls.throttle * 2, 0, 1);
  const vortexF = Math.max(
    altF * wetF,
    THREE.MathUtils.clamp((wet - CONTRAIL_VORTEX_WET) / 0.35, 0, 1)
      * THREE.MathUtils.clamp(((state.loadFactor || 1) - CONTRAIL_VORTEX_G) / 1.2, 0, 1));

  // 点を置く間隔（距離）。速いほど広げるが、点の直径より広げると破線になる。
  const size = ct.points.material.size;
  const want = state.airspeed * CONTRAIL_LIFE_S / (CONTRAIL_PER_EMIT - 2);
  const step = THREE.MathUtils.clamp(want,
    size * CONTRAIL_STEP_MIN_FRAC, size * CONTRAIL_STEP_MAX_FRAC);
  // このバッファで保てる時間。速すぎて筋が一周してしまうときは、
  // 先に薄くしておく（でないと尻尾が濃いまま、ぷつりと消える）。
  ct.life = Math.min(CONTRAIL_LIFE_S,
    (CONTRAIL_PER_EMIT - 2) * step / Math.max(state.airspeed, 1));
  ct.dist += state.airspeed * dt;
  const spawn = ct.dist >= step && state.airspeed > 20;
  if (spawn) ct.dist -= step;   // 0に戻すと、間隔が1フレームぶんの距離に丸まる
  for (let i = 0; i < ct.emitters.length; i++) {
    const em = ct.emitters[i];
    const strength = em.kind === 'engine' ? engineF : vortexF;
    if (em.kind === 'engine' && em.engine
      && typeof engineGroupOff === 'function' && engineGroupOff(controls, em.engine.group)) continue;
    if (!spawn || strength <= 0.02) continue;
    const slot = i * CONTRAIL_PER_EMIT + ct.cursor[i];
    ct.cursor[i] = (ct.cursor[i] + 1) % CONTRAIL_PER_EMIT;
    _ctWorld.copy(em.local).applyQuaternion(ac.group.quaternion).add(ac.group.position);
    pos[slot * 3] = _ctWorld.x; pos[slot * 3 + 1] = _ctWorld.y; pos[slot * 3 + 2] = _ctWorld.z;
    ct.age[slot] = 0;
    ct.strength[slot] = strength;
  }

  // 古いものを薄くして消す
  let live = 0;
  const life = ct.life;
  for (let s = 0; s < ct.age.length; s++) {
    const a = ct.age[s];
    if (!(a < life)) {
      if (col[s * 3] !== 0) col[s * 3] = col[s * 3 + 1] = col[s * 3 + 2] = 0;
      continue;
    }
    const na = a + dt;
    ct.age[s] = na;
    if (na >= life) {
      col[s * 3] = col[s * 3 + 1] = col[s * 3 + 2] = 0;
      continue;
    }
    // 出たてはすぐ濃くなり、そのあとゆっくり薄れて消える
    const t = na / life;
    const fade = Math.min(t * 12, 1) * (1 - t) * (1 - t);
    const v = ct.strength[s] * CONTRAIL_MAX_ALPHA * fade;
    col[s * 3] = col[s * 3 + 1] = col[s * 3 + 2] = v;
    live++;
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
  ct.points.visible = live > 0;
}

// 航行灯のにじみ。玉の直径(m)と、芯に対する濃さ。
const NAV_LIGHT_GLOW_SIZE = 1.6;
const NAV_LIGHT_GLOW_OPACITY = 0.5;
let _navGlowTexture = null;
function navLightGlowTexture() {
  if (_navGlowTexture) return _navGlowTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _navGlowTexture = new THREE.CanvasTexture(canvas);
  return _navGlowTexture;
}

// Builderの LIGHT_KINDS はこのページには無いので、必要なぶんだけ持つ
const LIGHT_KINDS_FALLBACK = {
  nav_red: { color: 0xff3b3b, blink: 'steady' },
  nav_green: { color: 0x3bff6a, blink: 'steady' },
  nav_white_tail: { color: 0xffffff, blink: 'steady' },
  beacon: { color: 0xff2020, blink: 'pulse' },
  strobe: { color: 0xffffff, blink: 'strobe' },
  landing: { color: 0xfff6dd, blink: 'steady' },
};

// --- 毎フレームの見た目の更新 -------------------------------------------------

// プロペラを回し、航行灯を点滅させる
function updateAircraftVisual(ac, controls, state, dt, elapsed) {
  if (!ac) return;

  // プロペラ。速いと1枚の円盤に見えるので、回転を止めて半透明の円で置き換える。
  if (ac.propeller) {
    const rpm = controls.throttle * 2400 + (controls.throttle > 0.01 ? 600 : 0);
    ac.propAngle += (rpm / 60) * Math.PI * 2 * dt;
    ac.propeller.rotation.z = ac.propAngle;
    const blur = THREE.MathUtils.clamp(controls.throttle * 3, 0, 1);
    ac.propeller.material.opacity = 1 - blur * 0.85;
    ac.propeller.material.transparent = blur > 0.01;
    if (ac.propDisc) ac.propDisc.material.opacity = blur * 0.22;
  }

  // 航行灯。夜だけ光らせるのではなく、灯火は昼でも点いているものとして扱う。
  for (const l of ac.lights) {
    let on = 1;
    if (l.blink === 'strobe') on = (elapsed % 1.4) < 0.06 ? 1 : 0.02;
    else if (l.blink === 'pulse') on = 0.25 + 0.75 * Math.pow(Math.max(Math.sin(elapsed * 2.2), 0), 6);
    // 着陸灯は別扱い。消しているときは玉も暗くする。
    if (l.kind === 'landing') on = controls.landingLight ? 1 : 0.05;
    l.mesh.material.opacity = on;
    if (l.glow) l.glow.material.opacity = on * NAV_LIGHT_GLOW_OPACITY;
  }

  updateLandingLightPool(ac, controls, state);
  updateEnginePlumes(ac, controls, state, elapsed);
  updateContrail(ac, controls, state, dt);
}
