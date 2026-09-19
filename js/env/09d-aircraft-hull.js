// 09d-aircraft-hull.js — モデルの形そのものから、機体の当たり判定点を作る
//
// **いままでの接地判定は、脚（Builderで置いた点）しか見ていなかった。** 山や崖に
// まっすぐ突っ込んでも、主翼や胴体・尾翼が地面に触れても、脚が地面に届かない限り
// すり抜けていた。実際の墜落はむしろこっち（脚を出し忘れた不時着・翼端を擦る・
// 山腹への激突）のほうが多い。
//
// 翼の4頂点やエンジン位置のような「Builderの抽象的な部品定義」からではなく、
// **読み込んだGLB（内蔵機なら組み立てたメッシュ）そのものの頂点**から当たり判定点を
// 作る——ノーズの形も、尾翼の張り出しも、ポッドの位置も、モデルが持っている形が
// そのまま使われる。
//
// ---- 脚をどう除く必要があるか ------------------------------------------------
//
// モデルの頂点をそのまま使うと、**脚・車輪の頂点がいちばん低いところに来る**。
// 脚は最初からそこに接地する設計なので、それを当たり判定に含めると、ふつうの
// 着陸のたびに「機体が地面に当たった」ことになってしまう（脚のばね物理と
// 二重に判定してしまう）。
//
// 脚の高さ（重心から接地点までの深さ＝ `model.gearHeight`）を基準に、
// **重心に近い側 `HULL_GEAR_EXCLUDE_FRAC` の割合だけを「脚」とみなして除く**。
// 固定の距離（例えば0.15m）ではなく比率にしたのは、小型機と旅客機で脚の長さが
// 1桁以上違うため——固定値だと小型機では機体の半分近くを消してしまい、
// 旅客機では脚のごく一部しか除けない。
const HULL_GEAR_EXCLUDE_FRAC = 0.35;

// 頂点の塊を、モデルの形なりに包む多面体（26方向の k-DOP）に落とし込む。
// 全頂点をそのまま毎フレーム調べるのは重すぎるので、**代表的な26方向それぞれで
// いちばん外側にある頂点**だけを残す。立方体の6面＋12辺＋8頂点の向き。
// 凸包そのものではないが、翼端・機首・尾部・ポッドのような「出っ張り」は
// たいていどれかの方向の最外点として拾える。
const HULL_KDOP_DIRS = (() => {
  const dirs = [];
  const push = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z);
    if (v.lengthSq() < 1e-9) return;
    dirs.push(v.normalize());
  };
  // 6面
  push(1, 0, 0); push(-1, 0, 0); push(0, 1, 0); push(0, -1, 0); push(0, 0, 1); push(0, 0, -1);
  // 12辺
  for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
    push(s1, s2, 0); push(s1, 0, s2); push(0, s1, s2);
  }
  // 8頂点
  for (const s1 of [1, -1]) for (const s2 of [1, -1]) for (const s3 of [1, -1]) push(s1, s2, s3);
  return dirs;
})();

// メッシュの全頂点を見るのは機体1機の組み立てに1回だけ（CGをずらしたときは
// shiftAircraftHull で頂点をそのまま平行移動するので、ここは呼び直さない）。
// それでも数万頂点のモデルは重いので、上限を決めて間引く（09c-aircraft-bones.js の
// BONE_MAX_SAMPLE と同じ考え方）。
const HULL_MAX_POOL = 20000;

// group はワールド＝機体座標（重心が原点・機首が-Z）になっている入れ物
// （09b-aircraft-visual.js の createAircraft 参照）。visual は実際のメッシュ
// （読み込んだGLB、または内蔵機の組み立てメッシュ）。model は 09-aircraft.js が
// 作った飛行モデル（脚の深さ gearHeight を読むのに使う）。
function buildAircraftHull(group, visual, model) {
  if (!group || !visual || typeof THREE === 'undefined') return null;
  group.updateMatrixWorld(true);

  const pool = [];
  const v = new THREE.Vector3();
  visual.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    // スキンの変形前（バインドポーズ）の頂点をそのまま使う。舵面が振れるたびに
    // 当たり判定の形が変わるのは望ましくない——機体の「素の形」を包めば十分。
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pool.push(v.clone());
      if (pool.length >= HULL_MAX_POOL) return;
    }
  });
  if (!pool.length) return null;

  // 脚の頂点を除く（上の説明を参照）。重心からの深さで切る。
  const gearHeight = Math.max(model && model.gearHeight || 0, 0);
  const excludeBelowY = -gearHeight * (1 - HULL_GEAR_EXCLUDE_FRAC);
  const body = pool.filter((p) => p.y >= excludeBelowY);
  const source = body.length ? body : pool;   // 全部脚扱いになってしまったら諦めて全頂点を使う

  const seen = new Map();   // 同じ頂点を複数方向が選ぶことがあるので間引く
  for (const dir of HULL_KDOP_DIRS) {
    let best = null, bestDot = -Infinity;
    for (const p of source) {
      const d = p.dot(dir);
      if (d > bestDot) { bestDot = d; best = p; }
    }
    if (!best) continue;
    const key = `${best.x.toFixed(3)},${best.y.toFixed(3)},${best.z.toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, best.clone());
  }

  const points = Array.from(seen.values());
  if (!points.length) return null;
  const radius = Math.max(...points.map((p) => p.length()), 0.1);
  const cgModel = (model && model.cgModel) ? model.cgModel.clone() : new THREE.Vector3();
  return { points, radius, cgModel };
}

// 重心をトリムでずらしたとき（12-flight-mode.js の applyCgOffset）に呼ぶ。
// メッシュを読み直さず、いま持っている点をそのまま平行移動するだけで済ませる
// （毎フレーム動くスライダーで数万頂点を数え直すと引っかかるため）。
function shiftAircraftHull(hull, newCgModel) {
  if (!hull || !hull.points.length || !newCgModel) return;
  const delta = new THREE.Vector3().subVectors(hull.cgModel, newCgModel);
  if (delta.lengthSq() < 1e-12) return;
  for (const p of hull.points) p.add(delta);
  hull.cgModel.copy(newCgModel);
  hull.radius = Math.max(...hull.points.map((p) => p.length()), 0.1);
}
