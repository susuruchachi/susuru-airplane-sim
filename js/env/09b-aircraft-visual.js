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
//       └ modelRoot（Builderの root.rotation / root.scale）
//           └ GLBのメッシュ、または内蔵機の形
// 舵面・脚・灯火は modelRoot の下に置き、操縦に合わせて動かす。

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

  // 重心が原点に来るように、モデル全体を重心ぶん戻す
  const modelRoot = new THREE.Group();
  modelRoot.position.set(-(cg.x || 0), -(cg.y || 0), -(cg.z || 0));
  orient.add(modelRoot);

  let visual = null;
  let source = 'builtin';
  if (config.modelBuffer) {
    try {
      visual = await parseAircraftGLB(config.modelBuffer);
      source = 'builder';
      const t = config.modelTransform;
      if (t) {
        if (t.rotation) visual.rotation.set(t.rotation.x || 0, t.rotation.y || 0, t.rotation.z || 0);
        if (t.scale) visual.scale.set(t.scale.x || 1, t.scale.y || 1, t.scale.z || 1);
      }
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
  modelRoot.add(visual);

  // 航行灯。Builderの定義があればその位置に、無ければ翼端と尾に置く。
  const lights = buildAircraftLights(config, model, modelRoot);

  return {
    model, group, orient, modelRoot, visual, lights,
    source,
    name: config.name || (source === 'builder' ? '機体' : '内蔵の練習機'),
    propeller: visual.userData ? visual.userData.propeller : null,
    propDisc: visual.userData ? visual.userData.propDisc : null,
    propAngle: 0,
  };
}

// 航行灯（左舷赤・右舷緑・尾白・ビーコン・ストロボ）
function buildAircraftLights(config, model, parent) {
  const defs = (config.parts || []).filter((p) => p.type === 'light');
  const out = [];
  const mk = (kind, x, y, z) => {
    const info = LIGHT_KINDS_FALLBACK[kind] || LIGHT_KINDS_FALLBACK.nav_white_tail;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 8),
      new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 1, fog: false })
    );
    mesh.position.set(x, y, z);
    mesh.renderOrder = 4;
    parent.add(mesh);
    out.push({ mesh, kind, blink: info.blink });
  };

  if (defs.length) {
    for (const d of defs) {
      mk((d.props && d.props.kind) || 'nav_white_tail', d.position.x, d.position.y, d.position.z);
    }
  } else {
    // 定義が無い機体（内蔵機など）は翼端と尾に付ける
    const half = model.wingSpan / 2;
    const cg = model.cg;
    mk('nav_red', cg.x - half, cg.y + 0.9, cg.z + 0.05);
    mk('nav_green', cg.x + half, cg.y + 0.9, cg.z + 0.05);
    mk('nav_white_tail', cg.x, cg.y + 1.4, cg.z + 4.9);
    mk('beacon', cg.x, cg.y + 1.05, cg.z + 0.6);
    mk('strobe', cg.x - half, cg.y + 0.9, cg.z + 0.1);
    mk('strobe', cg.x + half, cg.y + 0.9, cg.z + 0.1);
  }
  return out;
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
    l.mesh.material.opacity = on;
  }
}
