// 09c-aircraft-bones.js — GLBのボーンで舵面を動かす
//
// Blenderなどで舵にボーンを仕込んだ機体を読み込んだとき、操縦に合わせて
// エルロン・エレベーター・ラダー・フラップ・スポイラーが実際に動くようにする。
// **見た目だけ**で、飛び方はこれまでどおりBuilderで置いたパーツが決める
// （ボーンが無い機体・内蔵機では何も起きない）。
//
// ---- 「どのボーンをどう回すか」を名前で決めてはいけない ----------------------
//
// ボーン名はモデルを作る人の自由で、日本語のことも英語のこともあり、
// 「右上」「左下」のように**位置しか言っていない**ことも多い。実際このプロジェクトで
// 使っているサンダーバード1号のモデルでは、尾部の8枚が右上／右下／左上／左下としか
// 名前が付いておらず、親の名前（エレベーター／ラダー）も実際の働きと合っていない。
// 名前で決めると、ラダーの指示でピッチ用の板が動くことになる。
//
// そこで**形と動きから決める**。ボーンを試しに20°回してみて、
//   ・その骨が動かす頂点の塊（板）がどっちを向いているか
//   ・回したとき板がどっちへ振れるか
// を実際に測り、そこから「この板を振ると機体にどんなモーメントが出るか」を計算して、
// ピッチ・ロール・ヨーのどれにどれだけ効く舵なのかを決める。こうすると、
// ふつうの尾翼でも、V字尾翼でも、斜めに付いた板でも、同じ計算のまま正しく混ざる。
//
// ---- 測るときの落とし穴（実際にはまった）------------------------------------
//
// 頂点属性(position)の値を「動かす前の位置」として使ってはいけない。**ファイルに
// 保存された姿勢がバインドポーズと違う**ことがあり、そのときスキニング後の位置は
// 属性の値と一致しない。サンダーバード1号の尾部は親に scale -1 が掛かっていて、
// 実測で**最大12.5**（機体の全長34.9に対して1/3）もずれていた。この状態で
// 「属性の位置」を基準に差を取ると、20°回しただけで板が12も動いたことになり、
// ヒンジ軸の判定がめちゃくちゃになる。基準も**スキニングを通した位置**
// （SkinnedMesh.boneTransform）で取ること。
const BONE_TEST_DEG = 20;        // 軸を見つけるための試し回転
const BONE_MIN_VERTS = 12;       // これ未満しか動かさない骨は相手にしない
const BONE_MAX_SAMPLE = 400;     // 1ボーンあたりに見る頂点の数（重い機体でも一定）
// 見つけた舵のうち、**1枚だけ飛び抜けて大きい**ものは外す。1本の骨が離れた複数の
// 板をまとめて動かしている（リグの付け間違い）ことが多く、舵として振ると板が
// 胴体から生えたまま大きく振り回されて見えるため。サンダーバード1号のモデルでは、
// 尾部の1本が左の2枚（12離れている）を同時に動かしていて、長さが他の舵の4.1倍
// （13.3に対して中央値3.2）、同じ角度での振れ幅も3.7倍あった。
const BONE_SIZE_OUTLIER = 3.0;
const BONE_PLATE_RATIO = 0.45;   // 厚み÷長さ。これより厚いと板ではない（胴体など）
const BONE_SCORE_MIN = 0.5;      // ヒンジらしさ（そろい具合×面に垂直な割合）の下限
// その舵がいちばん得意な軸に対して、この割合に届かない軸は担当しない。
// V字尾翼のように本当に2軸へ効く舵は、どちらの軸でも自分が最上位（1.00）なので残る。
// 0.6にすると、実測でサンダーバード1号の斜めに付いた尾部の板1枚がロールも拾って
// しまい（ロール0.21）、ロール操作で尾の1枚だけが6°動く左右非対称な絵になった。
const BONE_MIX_KEEP = 0.7;
// **その軸をいちばん強く握っている舵**と比べて、これに満たない舵はその軸を担当しない。
// 実機でエルロンをピッチに使わないのは、同じ機体にもっとピッチの効く舵（エレベーター）
// があるからで、エルロン自身にピッチの効きが無いからではない——実測でも、
// サンダーバード1号のエルロン1枚はロール(6.9)よりピッチ(9.5)の腕のほうが長く、
// 舵単体で見るとピッチ優勢に出てしまう。尾部の舵と比べると1/5しかないので、これで落ちる。
const BONE_AXIS_SHARE = 0.35;
const BONE_CONTROL_DEG = 28;     // 舵面の振れ幅（AERO_DEFAULTS.controlMaxDeg と同じ）
const BONE_FLAP_DEG = 30;        // ＝ AERO_DEFAULTS.flapMaxDeg
const BONE_SPOILER_DEG = 55;     // 立てる板は大きく開く
const BONE_SMOOTH_S = 0.08;      // 舵が動く速さ（実機の舵も一瞬では動かない）
// **見た目の更新を、このぶん動くまで我慢する。** 天候の突風はなめらかに揺れ続ける
// （05b-weather.js の w.gust）ので、巡航中でも自動操縦の舵はフレームごとに
// ほんのわずかずつ動き続ける——実測で最大0.075°/フレーム、これを毎フレーム
// そのままボーンに反映すると、舵の輪郭が常に細かく震えて見える（実際そう見えた）。
// 内部の角度（b.angle）は毎フレーム続けて動かすが、**実際にメッシュへ反映するのは
// 前回の見た目からこのしきい値ぶん動いたときだけ**にする。実測で、しきい値0.1°で
// 更新する頻度が100%→1.1%まで落ち、1回あたりの動きは0.13°程度（見えない）に収まった。
// 本物の操縦（フル舵）はこの何十倍も大きく動くので反応の遅れは感じない。
const BONE_DEADBAND_RAD = THREE.MathUtils.degToRad(0.12);
// 名前で分かるのは「操縦桿で動かす舵ではないもの」だけ。フラップとスポイラーは
// 別のレバーだし、脚と可変翼は舵ではない。それ以外は形と動きから決める。
const GEAR_WORDS = ['着陸脚', '脚', 'gear', 'landing', 'ギア'];
const BONE_WORDS = {
  flap: ['フラップ', 'flap'],
  spoiler: ['スポイラー', 'エアブレーキ', 'spoiler', 'airbrake', 'speedbrake'],
  skip: [...GEAR_WORDS, '可変翼', 'sweep', 'swing'],
};

const _boneV = new THREE.Vector3();
const _boneV2 = new THREE.Vector3();
const _boneQ = new THREE.Quaternion();

function boneRoleFromName(name) {
  const s = String(name || '').toLowerCase();
  for (const w of BONE_WORDS.skip) if (s.indexOf(w.toLowerCase()) >= 0) return 'skip';
  for (const w of BONE_WORDS.spoiler) if (s.indexOf(w.toLowerCase()) >= 0) return 'spoiler';
  for (const w of BONE_WORDS.flap) if (s.indexOf(w.toLowerCase()) >= 0) return 'flap';
  return null;
}

// 主成分（点の塊がいちばん長い向き／いちばん薄い向き）。冪乗法で3本求める。
function bonePrincipalAxes(points, center) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of points) {
    const d = [q.x - center.x, q.y - center.y, q.z - center.z];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += d[a] * d[b];
  }
  const mul = (m, v) => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
  const norm = (v) => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
  const power = (m, seed) => { let v = norm(seed); for (let i = 0; i < 120; i++) v = norm(mul(m, v)); return v; };
  const deflate = (m, v) => {
    const l = mul(m, v);
    const lam = l[0] * v[0] + l[1] * v[1] + l[2] * v[2];
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) o[a][b] = m[a][b] - lam * v[a] * v[b];
    return o;
  };
  const a1 = power(M, [1, 0.31, 0.17]);
  const M2 = deflate(M, a1);
  const a2 = power(M2, [0.13, 1, 0.29]);
  const M3 = deflate(M2, a2);
  const a3 = power(M3, [0.19, 0.23, 1]);
  return [new THREE.Vector3(...a1), new THREE.Vector3(...a2), new THREE.Vector3(...a3)];
}

// 軸方向の広がり
function boneSpread(points, center, axis) {
  let lo = Infinity, hi = -Infinity;
  for (const q of points) {
    const t = _boneV.copy(q).sub(center).dot(axis);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo;
}

// そのボーンが主に動かす頂点を集める（重み0.5超え＝その骨の持ち物とみなす）
function collectBoneClouds(root) {
  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  const clouds = new Map();
  const comp = (a, i, k) => (k === 0 ? a.getX(i) : k === 1 ? a.getY(i) : k === 2 ? a.getZ(i) : a.getW(i));
  for (const mesh of skinned) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (!pos || !si || !sw || !mesh.skeleton) continue;
    // 脚のメッシュの骨は舵ではない（isGearSkinnedMesh の説明を参照）
    if (isGearSkinnedMesh(mesh)) continue;
    const step = Math.max(1, Math.floor(pos.count / 2000));
    for (let i = 0; i < pos.count; i += step) {
      for (let k = 0; k < 4; k++) {
        if (comp(sw, i, k) <= 0.5) continue;
        const bone = mesh.skeleton.bones[comp(si, i, k)];
        if (!bone) continue;
        let e = clouds.get(bone.uuid);
        if (!e) { e = { bone, items: [] }; clouds.set(bone.uuid, e); }
        if (e.items.length < BONE_MAX_SAMPLE) e.items.push({ mesh, idx: i });
      }
    }
  }
  return { skinned, clouds };
}

// スキニングを通した、いまの姿勢での頂点の位置（ワールド）
function boneSkinnedPoint(item, target) {
  item.mesh.boneTransform(item.idx, target);
  return target.applyMatrix4(item.mesh.matrixWorld);
}

// そのボーンが「舵の板」として相手にできる形かどうかを判定する（頂点数・親子関係・
// 名前での除外・板らしさ）。一覧表示（Builder）と本番の組み立て（buildAircraftBones）の
// 両方から使う共通の絞り込み
function bonePlateInfo(bone, items) {
  if (items.length < BONE_MIN_VERTS) return null;
  // 子ボーンを持つ骨は、舵ではなく「枝の付け根」（翼の付け根・脚の親など）
  if (bone.children.some((o) => o.isBone)) return null;
  if (boneRoleFromName(bone.name) === 'skip') return null;

  const base = items.map((it) => boneSkinnedPoint(it, new THREE.Vector3()));
  const center = new THREE.Vector3();
  for (const q of base) center.add(q);
  center.multiplyScalar(1 / base.length);
  const [a1, , a3] = bonePrincipalAxes(base, center);
  const long = boneSpread(base, center, a1);
  const thick = boneSpread(base, center, a3);
  if (long <= 1e-4) return null;
  if (thick / long > BONE_PLATE_RATIO) return null;   // 板ではない
  return { base, center, a3, long };
}

// ボーンを1本ずつ試しに回して、いちばんヒンジらしい軸を選ぶ。
// forcedAxisIdx（0=X/1=Y/2=Z）を渡すと、その軸しか試さず、ヒンジらしさの
// 下限（BONE_SCORE_MIN）も無視する——ユーザーが手動で軸を指定した場合に使う
const BONE_TEST_AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
function pickBoneHingeAxis(bone, items, base, a3, forcedAxisIdx) {
  const rest = bone.quaternion.clone();
  let best = null;
  for (let ai = 0; ai < 3; ai++) {
    if (forcedAxisIdx !== undefined && forcedAxisIdx !== null && forcedAxisIdx >= 0 && ai !== forcedAxisIdx) continue;
    bone.quaternion.copy(rest).multiply(
      _boneQ.setFromAxisAngle(BONE_TEST_AXES[ai], THREE.MathUtils.degToRad(BONE_TEST_DEG)));
    bone.updateMatrixWorld(true);
    const mean = new THREE.Vector3();
    let total = 0, perp = 0;
    for (let i = 0; i < items.length; i++) {
      const d = boneSkinnedPoint(items[i], _boneV2).sub(base[i]);
      const L = d.length();
      total += L;
      perp += Math.abs(d.dot(a3));
      mean.add(d);
    }
    mean.multiplyScalar(1 / items.length);
    const avg = total / items.length;
    // そろい具合：板ぜんぶが同じ向きへ動いているか（ねじれだと0に近い）
    const coherence = mean.length() / Math.max(avg, 1e-9);
    // 面に垂直な割合：板が自分の面から出る向きに振れているか（面内の滑りは0）
    const perpRatio = perp / Math.max(total, 1e-9);
    const score = coherence * perpRatio;
    const forced = forcedAxisIdx !== undefined && forcedAxisIdx !== null && forcedAxisIdx >= 0;
    // 同じくらいヒンジらしい軸が2本あることがある（骨の向き次第）。
    // そのときは**大きく振れるほう**が本物のヒンジ。軸を指定されている場合は
    // ヒンジらしさを問わず、その軸をそのまま使う
    if ((score >= BONE_SCORE_MIN || forced) && (!best || avg > best.avg)) {
      best = { axis: BONE_TEST_AXES[ai].clone(), axisIdx: ai, dir: mean.clone(), avg, score };
    }
    bone.quaternion.copy(rest);
  }
  bone.updateMatrixWorld(true);
  return best;
}

// Builderの設定画面に出す、候補になる骨の一覧（名前・役割・自動判定した軸）。
// root はBuilderで読み込んだモデルそのもの（世界座標が小さいBuilderのシーン内なので、
// localizeSkeletonsは不要——それはワールドが広大な飛行側だけの精度対策）
const BONE_AXIS_NAMES = ['x', 'y', 'z'];
function listBoneAxisCandidates(root) {
  if (!root || typeof THREE === 'undefined') return [];
  const { skinned, clouds } = collectBoneClouds(root);
  if (!skinned.length) return [];
  root.updateMatrixWorld(true);
  const out = [];
  for (const e of clouds.values()) {
    const bone = e.bone, items = e.items;
    const plate = bonePlateInfo(bone, items);
    if (!plate) continue;
    const named = boneRoleFromName(bone.name);
    const best = pickBoneHingeAxis(bone, items, plate.base, plate.a3, -1);
    out.push({
      name: bone.name,
      role: named || 'attitude',
      autoAxis: best ? BONE_AXIS_NAMES[best.axisIdx] : null,
    });
  }
  return out;
}

// --- スキニングの精度を守る（これをやらないと輪郭が歪む）---------------------
//
// **スキンの計算はワールド座標のまま float32 で行われる。** three.js は
// 「ボーンのワールド行列 × 逆バインド行列」を Float32Array に詰めてシェーダーへ
// 渡し、頂点をいったんワールド座標へ運んでから戻す。この世界は一辺3000kmあるので
// 機体のワールド座標は数十万に達する——float32 の刻み幅は座標53,000で約0.006、
// 60万で0.07になる。実測（シェーダーと同じ float32 で計算し直して比べた）で、
// 頂点のずれは原点で0、x=53,073で2mm、x=600,000で3.1cm、x=1,400,000で6.4cm。
// 翼の縁や細い塗り分けの線がはっきり歪み、しかも機体が動くと丸め方が変わるので
// 輪郭がゆらゆら動いて見える。
//
// **ボーンが付いていないメッシュで起きないのはなぜか。** そちらは
// modelViewMatrix を CPU（倍精度）で「カメラからの相対」に直してから渡すので、
// 大きな数がシェーダーに入らない。スキンだけが素通りしている。
//
// 直し方は、ボーンを機体の入れ物（ワールドに置かれている）から外し、
// **モデルのローカル座標のままの入れ物**へ移すこと。シェーダーに入る数が
// 機体の大きさ（数十m）で収まる。機体のワールド位置はこれまでどおり
// modelViewMatrix 側で掛かるので、見え方は変わらない。
//
// 式で書くと、three.js のスキンは
//   頂点 = メッシュのワールド行列 × 逆バインド × Σ(重み × ボーン行列) × バインド × p
// で、既定（bindMode='attached'）では逆バインド＝メッシュのワールド行列の逆
// なので、メッシュ側の行列が打ち消し合う。ボーンをローカルへ移したら、
// 代わりに**モデルの中でのメッシュの位置**で打ち消すように置き換える
// （bindMode='detached' にして、バインド行列と逆バインド行列を自分で入れ、
// そのぶんを逆バインドボーン行列側から抜く）。
function localizeSkeletons(visual) {
  const skinned = [];
  visual.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) return null;
  // 二度掛けると逆バインド行列を二重に直してしまうので、一度やった機体は素通りする
  if (skinned[0].userData.boneLocalized) return null;

  visual.updateMatrixWorld(true);
  const invVisual = new THREE.Matrix4().copy(visual.matrixWorld).invert();

  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;   // 単位行列のまま動かさない

  // 骨の根（親が骨でないもの）を、元の親の姿勢を写した箱ごと移す
  const roots = new Set();
  for (const m of skinned) {
    for (const b of m.skeleton.bones) {
      let r = b;
      while (r && r.parent && r.parent.isBone) r = r.parent;
      if (r) roots.add(r);
    }
  }
  for (const rb of roots) {
    const proxy = new THREE.Object3D();
    proxy.matrixAutoUpdate = false;
    if (rb.parent) proxy.matrix.multiplyMatrices(invVisual, rb.parent.matrixWorld);
    holder.add(proxy);
    proxy.add(rb);
  }

  for (const m of skinned) {
    const local = new THREE.Matrix4().multiplyMatrices(invVisual, m.matrixWorld);
    const localInv = new THREE.Matrix4().copy(local).invert();
    // 逆バインドボーン行列は**メッシュごとに別物**（GLTFLoaderがメッシュごとに
    // Skeleton を作っている）ので、ここで書き換えて差し支えない。
    for (const bi of m.skeleton.boneInverses) bi.multiply(localInv);
    m.bindMatrix.copy(local);
    m.bindMatrixInverse.copy(localInv);
    m.bindMode = 'detached';
    m.userData.boneLocalized = true;
    // スキンは境界球をバインドポーズで持っているので、舵を振ると画面外判定が
    // ずれて消えることがある。枚数は知れているので切らない。
    m.frustumCulled = false;
  }
  holder.updateMatrixWorld(true);
  return holder;
}

// ボーンを1本ずつ試しに回して、ヒンジ軸と振れる向きを決める。
// root は機体の入れ物（この時点でワールド＝機体座標：重心が原点・機首が-Z）、
// visual は読み込んだGLBそのもの（localizeSkeletons の基準にする）。
// overrides は Builder の設定画面で手動指定した軸（{ ボーン名: 'x'|'y'|'z' }）。
// 指定があれば自動判定を飛ばしてその軸をそのまま使う
function buildAircraftBones(root, visual, overrides) {
  if (!root || typeof THREE === 'undefined') return [];
  const { skinned, clouds } = collectBoneClouds(root);
  if (!skinned.length) return [];
  // **先に骨をローカルへ移す**（localizeSkeletons の説明を参照）。以降、骨を
  // 回したあとは root ではなくその骨自身の行列を作り直せばいい。
  const holder = localizeSkeletons(visual || root);

  const out = [];
  for (const e of clouds.values()) {
    const bone = e.bone, items = e.items;
    const plate = bonePlateInfo(bone, items);
    if (!plate) continue;
    const named = boneRoleFromName(bone.name);
    const { base, center, a3, long } = plate;
    const rest = bone.quaternion.clone();

    const forcedKey = overrides && overrides[bone.name];
    const forcedAxisIdx = forcedKey === 'x' ? 0 : forcedKey === 'y' ? 1 : forcedKey === 'z' ? 2 : -1;
    const best = pickBoneHingeAxis(bone, items, base, a3, forcedAxisIdx);
    if (!best || best.dir.lengthSq() < 1e-12) continue;

    const dir = best.dir.clone().normalize();   // +BONE_TEST_DEG で板が振れる向き
    const entry = {
      bone, rest, axis: best.axis, name: bone.name,
      role: named || 'attitude',
      center: center.clone(), dir, size: long,
      angle: 0, target: 0, appliedAngle: 0,
      gain: { pitch: 0, roll: 0, yaw: 0, flap: 0, spoiler: 0 },
      maxRad: THREE.MathUtils.degToRad(BONE_CONTROL_DEG),
    };

    if (named === 'flap') {
      // フラップは下がる向きへ
      entry.gain.flap = dir.y < 0 ? 1 : -1;
      entry.maxRad = THREE.MathUtils.degToRad(BONE_FLAP_DEG);
    } else if (named === 'spoiler') {
      // スポイラーは立つ（上がる）向きへ
      entry.gain.spoiler = dir.y > 0 ? 1 : -1;
      entry.maxRad = THREE.MathUtils.degToRad(BONE_SPOILER_DEG);
    } else {
      // 板を振ると、空気は板が動いた**逆向き**に機体を押す。その力が重心
      // （ここでは原点）まわりに作るモーメントで、ピッチ・ロール・ヨーの
      // どれに効く舵なのかが決まる。
      const force = dir.clone().multiplyScalar(-1);
      const moment = new THREE.Vector3().crossVectors(center, force);
      // 機体座標は 機首-Z / 上+Y / 右+X。
      //   機首上げ ＝ +X まわり      → +moment.x
      //   右ロール ＝ 機首(-Z)まわり → -moment.z
      //   機首右   ＝ -Y まわり      → -moment.y
      // 強さも残しておく（機体ぜんぶを見比べて、どの舵がどの軸を担当するか決める）
      const mix = new THREE.Vector3(moment.x, -moment.z, -moment.y);
      if (mix.lengthSq() < 1e-12) continue;
      entry.authority = mix;
    }
    out.push(entry);
  }

  // 大きさが飛び抜けている舵を外す（上の BONE_SIZE_OUTLIER の説明を参照）
  let kept = out;
  if (out.length >= 3) {
    const sizes = out.map((b) => b.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    kept = out.filter((b) => b.size <= median * BONE_SIZE_OUTLIER);
  }

  // 操縦桿で動かす舵は、機体ぜんぶを見比べてから担当を決める。
  // 「その軸をいちばん強く握っている舵」の BONE_AXIS_SHARE 未満しか効かない舵は、
  // その軸を担当しない（BONE_AXIS_SHARE の説明を参照）。
  const peak = { x: 0, y: 0, z: 0 };
  for (const b of kept) {
    if (!b.authority) continue;
    peak.x = Math.max(peak.x, Math.abs(b.authority.x));
    peak.y = Math.max(peak.y, Math.abs(b.authority.y));
    peak.z = Math.max(peak.z, Math.abs(b.authority.z));
  }
  for (const b of kept) {
    const a = b.authority;
    if (!a) continue;
    // その軸のいちばん強い舵に対する「順位」。自分がいちばん得意な軸を基準にして、
    // それに並ぶ軸だけを担当する。
    //   ・エルロン … ロールでは1位(1.00)、ピッチでは尾翼に負ける(0.48) → ロールだけ
    //   ・尾部の板 … ピッチで1位／ヨーで1位 → それぞれ専任
    //   ・V字尾翼 … ピッチもヨーも自分が1位 → 両方を担当して混ざる（狙いどおり）
    //   ・尾翼を持たない全翼機のエレボン … ピッチもロールも1位 → 両方を担当する
    const rank = new THREE.Vector3(
      Math.abs(a.x) / Math.max(peak.x, 1e-9),
      Math.abs(a.y) / Math.max(peak.y, 1e-9),
      Math.abs(a.z) / Math.max(peak.z, 1e-9));
    const top = Math.max(rank.x, rank.y, rank.z);
    if (top < BONE_AXIS_SHARE) continue;   // どの軸でも脇役。動かさない
    const mix = new THREE.Vector3(
      rank.x >= BONE_MIX_KEEP * top ? a.x : 0,
      rank.y >= BONE_MIX_KEEP * top ? a.y : 0,
      rank.z >= BONE_MIX_KEEP * top ? a.z : 0);
    if (mix.lengthSq() < 1e-12) continue;
    mix.normalize();
    b.gain.pitch = mix.x;
    b.gain.roll = mix.y;
    b.gain.yaw = mix.z;
  }

  return kept;
}

// 毎フレーム。操縦の値から舵角を決めて、ボーンを回す。
function updateAircraftBones(ac, controls, dt) {
  const bones = ac && ac.bones;
  if (!bones || !bones.length) return;
  const k = dt > 0 ? 1 - Math.exp(-dt / BONE_SMOOTH_S) : 1;
  const pitch = THREE.MathUtils.clamp(controls.pitch || 0, -1, 1);
  const roll = THREE.MathUtils.clamp(controls.roll || 0, -1, 1);
  const yaw = THREE.MathUtils.clamp(controls.yaw || 0, -1, 1);
  const flap = THREE.MathUtils.clamp(controls.flap || 0, 0, 1);
  const spoiler = THREE.MathUtils.clamp(controls.spoiler || 0, 0, 1);
  for (const b of bones) {
    const g = b.gain;
    const cmd = THREE.MathUtils.clamp(
      g.pitch * pitch + g.roll * roll + g.yaw * yaw + g.flap * flap + g.spoiler * spoiler, -1, 1);
    b.target = cmd * b.maxRad;
    b.angle += (b.target - b.angle) * k;
    // 実際にメッシュへ反映するのは、前回の見た目からしきい値ぶん動いたときだけ
    // （BONE_DEADBAND_RAD の説明を参照）。内部の角度は毎フレーム動かし続けるので、
    // 大きな入力が来たときの反応は遅れない。
    if (Math.abs(b.angle - b.appliedAngle) >= BONE_DEADBAND_RAD) {
      b.appliedAngle = b.angle;
      b.bone.quaternion.copy(b.rest).multiply(_boneQ.setFromAxisAngle(b.axis, b.angle));
      // 骨はもう機体の入れ物の中にいない（localizeSkeletons を参照）ので、
      // レンダラーの `scene.updateMatrixWorld()` は届かない。動かした骨だけ
      // 自分で作り直す。親（箱）はずっと同じなので、これで足りる。
      b.bone.updateMatrixWorld(true);
    }
  }
}

// ---- 脚のボーンとシェイプキーで脚を出し入れする ------------------------------
//
// 脚をしまう動きをモデルに仕込んでおくと、脚の上げ下げ（G）に合わせて実際に格納する。
// 仕込み方は「脚の付け根に**名前に脚／ギア／gear が入ったボーン**を置き、それを回すと
// 脚が胴体へ畳まれる」＋（あれば）「脚を縮める**シェイプキー**」。ボーンの子（車輪や
// 支柱の骨）はそのまま付いてくる。見た目だけで、飛び方（脚の抗力・接地）は
// これまでどおりBuilderで置いた脚のパーツが決める。
//
// **どの軸へ何度回すとしまえるのかは、形から測って決める。** ボーンのローカル軸は
// モデルの作り方次第で、同じノーズギアでも前へ畳むならZ軸、横へならX軸……と決まらない。
// そこで ±90° を X/Y/Z の6通り試し、しまった脚の頂点のうち**胴体の下面より上
// （かつ上面より下）に隠れる割合**がいちばん多い向きを選ぶ（角度もそのあと詰める。
// scoreGearRetraction）。横へ振ると胴体の外へ
// 飛び出し、下へ振ると下面から突き出すので、この割合がはっきり下がる。
// 前へ畳んでも後ろへ畳んでも同じだけ隠れる（実測で Boeing 747 のノーズギアは
// Z軸 ±90° の両方が100%）ので、そのときは**前へ畳むほう**を選ぶ。実機の旅客機の
// ノーズギアは前へ畳む（油圧が抜けても風と重さで出てくるように）。
// Builderの設定画面で軸と角度を手で決めることもできる（modelGearBones）。
const GEAR_MORPH_RETRACT = ['格納', '収納', 'retract'];
const GEAR_MORPH_EXTEND = ['展開', 'extend', 'deploy'];
// 頂点のこの割合以上が脚の骨（とその子）で動くメッシュは「脚のメッシュ」。
// そのメッシュに入っている骨（扉など、脚の骨の子でないものも含む）は舵として扱わない。
// 実際、Boeing 747 のモデルではノーズギアのメッシュにある「ボーン001」「ボーン002」が
// 形だけ見ると板なので、舵として拾われてピッチ操作で脚の一部が振れていた。
// 割合で見るのは、機体まるごと1つのアーマチュアで作ったモデル（全メッシュの骨一覧に
// 脚の骨が入る）で、胴体や翼まで脚扱いしないため。
const GEAR_MESH_SHARE = 0.25;
const GEAR_RIG_S = 4;              // 出し切る／しまい切るまでの秒数（＝ PART_PROXY_GEAR_S）
const GEAR_DEFAULT_DEG = 90;       // 自動判定で試す角度
const GEAR_SAMPLE = 600;           // 1本の脚で見る頂点の数
const GEAR_AXIS_NAMES = ['x', 'y', 'z'];

function nameHasAnyWord(name, words) {
  const s = String(name || '').toLowerCase();
  for (const w of words) if (s.indexOf(w.toLowerCase()) >= 0) return true;
  return false;
}
function isGearBoneName(name) { return nameHasAnyWord(name, GEAR_WORDS); }

// 骨そのもの、または親をたどって脚の骨があれば、脚の一部
function boneInGearTree(bone) {
  for (let b = bone; b && b.isBone; b = b.parent) if (isGearBoneName(b.name)) return true;
  return false;
}

// その頂点をいちばん強く握っている骨（の番号）
function dominantSkinIndex(si, sw, i) {
  let best = si.getX(i), bw = sw.getX(i);
  if (sw.getY(i) > bw) { bw = sw.getY(i); best = si.getY(i); }
  if (sw.getZ(i) > bw) { bw = sw.getZ(i); best = si.getZ(i); }
  if (sw.getW(i) > bw) { bw = sw.getW(i); best = si.getW(i); }
  return best;
}

function isGearSkinnedMesh(mesh) {
  if (mesh.userData.gearMeshShare === undefined) {
    let share = 0;
    const geo = mesh.geometry;
    const si = geo && geo.attributes.skinIndex, sw = geo && geo.attributes.skinWeight;
    const bones = mesh.skeleton && mesh.skeleton.bones;
    if (si && sw && bones && bones.some(boneInGearTree)) {
      const inTree = bones.map(boneInGearTree);
      const step = Math.max(1, Math.floor(si.count / 4000));
      let n = 0, hit = 0;
      for (let i = 0; i < si.count; i += step) {
        n++;
        if (inTree[dominantSkinIndex(si, sw, i)]) hit++;
      }
      share = n ? hit / n : 0;
    }
    mesh.userData.gearMeshShare = share;
  }
  return mesh.userData.gearMeshShare >= GEAR_MESH_SHARE;
}

// シェイプキーを反映した、スキニング後のワールド位置。three.js の boneTransform は
// シェイプキーを見ないので自前で計算する（中身は boneTransform と同じ）。
// morphs は [{ index, w }]（そのメッシュのシェイプキーの番号と強さ）
const _gsBase = new THREE.Vector3();
const _gsTmp = new THREE.Vector3();
const _gsM = new THREE.Matrix4();
function gearSkinnedPoint(mesh, i, morphs, target) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  _gsBase.fromBufferAttribute(pos, i);
  const mp = geo.morphAttributes && geo.morphAttributes.position;
  if (mp && morphs) {
    for (const m of morphs) {
      if (!m.w || !mp[m.index]) continue;
      _gsTmp.fromBufferAttribute(mp[m.index], i);
      if (!geo.morphTargetsRelative) _gsTmp.x -= pos.getX(i), _gsTmp.y -= pos.getY(i), _gsTmp.z -= pos.getZ(i);
      _gsBase.addScaledVector(_gsTmp, m.w);
    }
  }
  if (!mesh.isSkinnedMesh) return target.copy(_gsBase).applyMatrix4(mesh.matrixWorld);
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const bones = mesh.skeleton.bones, inv = mesh.skeleton.boneInverses;
  _gsBase.applyMatrix4(mesh.bindMatrix);
  target.set(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    const w = k === 0 ? sw.getX(i) : k === 1 ? sw.getY(i) : k === 2 ? sw.getZ(i) : sw.getW(i);
    if (!w) continue;
    const bi = k === 0 ? si.getX(i) : k === 1 ? si.getY(i) : k === 2 ? si.getZ(i) : si.getW(i);
    _gsM.multiplyMatrices(bones[bi].matrixWorld, inv[bi]);
    target.addScaledVector(_gsTmp.copy(_gsBase).applyMatrix4(_gsM), w);
  }
  return target.applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
}

// 脚の周りの「胴体の厚み」の地図。上から見た升目ごとに、脚以外のメッシュの
// いちばん低い面（下面）と高い面（上面）の高さを覚える。上は+Y（Builderも飛行側も同じ）。
// **頂点ではなく三角形で塗る。** 胴体は大きな三角形でできていて、升目の中に頂点が
// 1つも無いことがふつうにある（Boeing 747 の胴体下面で、0.1m角の升目のほとんどが空だった）。
// 頂点だけで作ると、その升目では脚が「どこにも隠れていない」ことになる
function gearHullMap(meshes, bounds, cell) {
  const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
  const nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
  const lo = new Float32Array(nx * nz).fill(Infinity);
  const hi = new Float32Array(nx * nz).fill(-Infinity);
  const p = new THREE.Vector3();
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index;
    // いまの姿勢でのワールド位置（スキンは骨を通す）
    const w = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      if (mesh.isSkinnedMesh) { mesh.boneTransform(i, p); p.applyMatrix4(mesh.matrixWorld); }
      else p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      w[i * 3] = p.x; w[i * 3 + 1] = p.y; w[i * 3 + 2] = p.z;
    }
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const ax = w[a * 3], ay = w[a * 3 + 1], az = w[a * 3 + 2];
      const bx = w[b * 3], by = w[b * 3 + 1], bz = w[b * 3 + 2];
      const cx = w[c * 3], cy = w[c * 3 + 1], cz = w[c * 3 + 2];
      const x0 = Math.floor((Math.min(ax, bx, cx) - bounds.minX) / cell), x1 = Math.floor((Math.max(ax, bx, cx) - bounds.minX) / cell);
      const z0 = Math.floor((Math.min(az, bz, cz) - bounds.minZ) / cell), z1 = Math.floor((Math.max(az, bz, cz) - bounds.minZ) / cell);
      if (x1 < 0 || z1 < 0 || x0 >= nx || z0 >= nz) continue;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const mark = (k, y) => { if (y < lo[k]) lo[k] = y; if (y > hi[k]) hi[k] = y; };
      if (Math.abs(det) < 1e-12) {
        // 真上から見て線になる（垂直な）三角形は、頂点の高さだけ入れる
        for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
          const ix = Math.floor((x - bounds.minX) / cell), iz = Math.floor((z - bounds.minZ) / cell);
          if (ix >= 0 && iz >= 0 && ix < nx && iz < nz) mark(iz * nx + ix, y);
        }
        continue;
      }
      for (let iz = Math.max(z0, 0); iz <= Math.min(z1, nz - 1); iz++) {
        const pz = bounds.minZ + (iz + 0.5) * cell;
        for (let ix = Math.max(x0, 0); ix <= Math.min(x1, nx - 1); ix++) {
          const px = bounds.minX + (ix + 0.5) * cell;
          const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
          const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          mark(iz * nx + ix, l1 * ay + l2 * by + l3 * cy);
        }
      }
    }
  }
  return {
    // その点が胴体（翼）の厚みの中に隠れているか
    hidden(q, tol) {
      const ix = Math.floor((q.x - bounds.minX) / cell), iz = Math.floor((q.z - bounds.minZ) / cell);
      if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return false;
      const k = iz * nx + ix;
      return q.y >= lo[k] - tol && q.y <= hi[k] + tol;
    },
    // 下面からどれだけ下に突き出しているか（隠れていれば0、升目に何も無ければ null）
    below(q) {
      const ix = Math.floor((q.x - bounds.minX) / cell), iz = Math.floor((q.z - bounds.minZ) / cell);
      if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return null;
      const k = iz * nx + ix;
      return lo[k] === Infinity ? null : Math.max(lo[k] - q.y, 0);
    },
  };
}

// 脚の骨を回して、いちばんよく隠れる向きと角度を選ぶ。
//   1) ±90° を X/Y/Z の6通り試して、軸と回す向きを決める
//   2) その軸・向きのまま角度を GEAR_SCAN_DEG の範囲で刻んで、いちばん隠れる角度にする
//      （同じだけ隠れるなら90°にいちばん近いもの）
// 2) が要るのは、ちょうど90°で収まるとは限らないから。実測で Boeing 747 の
// ノーズギアは、90°では車輪の下が胴体から0.21m はみ出し（脚の頂点の0.5%）、
// 95°で全部隠れた。
const GEAR_SCAN_DEG = [45, 150, 5];   // 角度を刻む範囲（下限・上限・刻み）
function scoreGearRetraction(gear, hullMeshes, noseDir) {
  const { bone, items, morphsByMesh } = gear;
  // 「展開」のシェイプキーは出した姿勢で1、「格納」は しまった姿勢で1
  const morphsAt = (mesh, r) => (morphsByMesh.get(mesh) || []).map((m) => ({ index: m.index, w: m.extend ? 1 - r : r }));
  const down = items.map((it) => gearSkinnedPoint(it.mesh, it.idx, morphsAt(it.mesh, 0), new THREE.Vector3()));
  const box = new THREE.Box3().setFromPoints(down);
  const size = box.getSize(new THREE.Vector3());
  const L = Math.max(size.x, size.y, size.z, 1e-3);
  const bounds = { minX: box.min.x - 1.5 * L, maxX: box.max.x + 1.5 * L, minZ: box.min.z - 1.5 * L, maxZ: box.max.z + 1.5 * L };
  const map = gearHullMap(hullMeshes, bounds, L / 20);
  const tol = L * 0.01;
  const rest = bone.quaternion.clone();
  const q = new THREE.Vector3();
  const measure = (ai, deg) => {
    bone.quaternion.copy(rest).multiply(_boneQ.setFromAxisAngle(BONE_TEST_AXES[ai], THREE.MathUtils.degToRad(deg)));
    bone.updateMatrixWorld(true);
    let hid = 0, minY = Infinity, fwd = 0;
    for (let k = 0; k < items.length; k++) {
      gearSkinnedPoint(items[k].mesh, items[k].idx, morphsAt(items[k].mesh, 1), q);
      if (map.hidden(q, tol)) hid++;
      if (q.y < minY) minY = q.y;
      if (noseDir) fwd += _boneV.copy(q).sub(down[k]).dot(noseDir);
    }
    return {
      axis: GEAR_AXIS_NAMES[ai], deg, hidden: hid / items.length,
      rise: (minY - box.min.y) / L,             // いちばん下の点が上がった量（脚の長さ比）
      forward: fwd / items.length / L,          // 前へ動いた量（脚の長さ比）
    };
  };
  const tries = [];
  for (let ai = 0; ai < 3; ai++) for (const sgn of [1, -1]) tries.push(measure(ai, sgn * GEAR_DEFAULT_DEG));
  // 隠れる割合がいちばん多い向き。同じくらい（2%以内）なら前へ畳むほう、
  // 機首の向きを渡されていなければ下の点がより上がるほう
  const top = Math.max(...tries.map((t) => t.hidden));
  const tie = (t) => t.hidden >= top - 0.02;
  tries.sort((a, b) => {
    if (tie(a) !== tie(b)) return tie(a) ? -1 : 1;
    if (!tie(a)) return b.hidden - a.hidden;
    return noseDir ? b.forward - a.forward : b.rise - a.rise;
  });
  // 角度を詰める
  const first = tries[0];
  const ai = GEAR_AXIS_NAMES.indexOf(first.axis), sgn = Math.sign(first.deg);
  const scan = [];
  for (let d = GEAR_SCAN_DEG[0]; d <= GEAR_SCAN_DEG[1]; d += GEAR_SCAN_DEG[2]) scan.push(measure(ai, sgn * d));
  const scanTop = Math.max(...scan.map((t) => t.hidden));
  let best = null;
  for (const t of scan) {
    // 1点でもはみ出す角度は採らない（はみ出すのはたいてい車輪の下の縁で、
    // 見る頂点600のうち1〜2点でも、実際に0.2mほど胴体の外に見える）
    if (t.hidden < scanTop) continue;
    if (!best || Math.abs(Math.abs(t.deg) - GEAR_DEFAULT_DEG) < Math.abs(Math.abs(best.deg) - GEAR_DEFAULT_DEG)) best = t;
  }
  bone.quaternion.copy(rest);
  bone.updateMatrixWorld(true);
  return { tries, scan, best: best || first };
}

// 脚の骨とシェイプキーを拾って、出し入れの仕掛けを作る。
// meshRoots … モデルのメッシュが入っている入れ物の一覧（Builderのギズモや飛行側の灯りを
//             胴体の厚みの地図に混ぜないため、モデルそのものだけを渡す）
// settings  … Builderで手で決めた向き { ボーン名: { axis: 'x'|'y'|'z'|'off', deg } }
// noseDir   … 機首の向き（ワールド）。分からなければ null
// 行列はこの時点のワールドで測る（上が+Yであればよい）
function buildAircraftGearRig(meshRoots, settings, noseDir) {
  if (typeof THREE === 'undefined' || !meshRoots) return null;
  const meshes = [];
  for (const r of meshRoots) if (r) r.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  for (const r of meshRoots) if (r) r.updateMatrixWorld(true);

  // 脚の骨：名前に脚の言葉が入っていて、親に脚の骨が無いもの（子の骨は付いてくるだけ）
  const gearBones = [];
  for (const m of meshes) {
    if (!m.isSkinnedMesh || !m.skeleton) continue;
    for (const b of m.skeleton.bones) {
      if (!isGearBoneName(b.name) || gearBones.indexOf(b) >= 0) continue;
      let p = b.parent, nested = false;
      for (; p && p.isBone; p = p.parent) if (isGearBoneName(p.name)) nested = true;
      if (!nested) gearBones.push(b);
    }
  }

  // 脚のシェイプキー：名前に脚の言葉か「格納／展開」が入ったもの
  const morphs = [];
  const morphsByMesh = new Map();
  for (const m of meshes) {
    const dict = m.morphTargetDictionary;
    if (!dict || !m.morphTargetInfluences) continue;
    for (const name of Object.keys(dict)) {
      const extend = nameHasAnyWord(name, GEAR_MORPH_EXTEND);
      if (!extend && !nameHasAnyWord(name, GEAR_WORDS) && !nameHasAnyWord(name, GEAR_MORPH_RETRACT)) continue;
      const e = { mesh: m, index: dict[name], name, extend };
      morphs.push(e);
      if (!morphsByMesh.has(m)) morphsByMesh.set(m, []);
      morphsByMesh.get(m).push(e);
    }
  }
  if (!gearBones.length && !morphs.length) return null;

  const hullMeshes = meshes.filter((m) => !(m.isSkinnedMesh && isGearSkinnedMesh(m)));
  const gears = [];
  for (const bone of gearBones) {
    // その脚の骨（と子）が主に動かす頂点
    const tree = new Set();
    bone.traverse((o) => { if (o.isBone) tree.add(o); });
    const items = [];
    for (const m of meshes) {
      if (!m.isSkinnedMesh || !m.skeleton) continue;
      const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
      if (!si || !sw) continue;
      const inTree = m.skeleton.bones.map((b) => tree.has(b));
      if (!inTree.some(Boolean)) continue;
      for (let i = 0; i < si.count; i++) if (inTree[dominantSkinIndex(si, sw, i)]) items.push({ mesh: m, idx: i });
    }
    if (!items.length) continue;
    const step = items.length / GEAR_SAMPLE;
    const sample = step > 1 ? Array.from({ length: GEAR_SAMPLE }, (_, k) => items[Math.floor(k * step)]) : items;
    const gear = { bone, name: bone.name, rest: bone.quaternion.clone(), items: sample, morphsByMesh };
    const scored = scoreGearRetraction(gear, hullMeshes, noseDir || null);
    gear.tries = scored.tries;
    gear.scan = scored.scan;
    gear.auto = scored.best;
    const s = settings && settings[bone.name];
    const manual = s && (s.axis === 'off' || GEAR_AXIS_NAMES.indexOf(s.axis) >= 0);
    const axisName = manual ? s.axis : gear.auto.axis;
    const deg = manual && Number.isFinite(Number(s.deg)) ? Number(s.deg) : gear.auto.deg;
    gear.axisName = axisName;
    gear.deg = axisName === 'off' ? 0 : deg;
    gear.axis = axisName === 'off' ? BONE_TEST_AXES[0].clone() : BONE_TEST_AXES[GEAR_AXIS_NAMES.indexOf(axisName)].clone();
    gear.rad = THREE.MathUtils.degToRad(gear.deg);
    delete gear.items;   // 測り終わったら要らない
    delete gear.morphsByMesh;
    gears.push(gear);
  }
  return { gears, morphs, t: null, appliedR: null };
}

// 格納の進み具合 r（0＝出ている／1＝しまった）の姿勢にする。
// 先に脚を縮め（シェイプキー）、縮みきる前から回し始める
function applyGearRigPose(rig, r) {
  if (!rig) return;
  const morphW = THREE.MathUtils.smoothstep(r, 0, 0.4);
  const rotW = THREE.MathUtils.smoothstep(r, 0.15, 1);
  for (const g of rig.gears) {
    g.bone.quaternion.copy(g.rest).multiply(_boneQ.setFromAxisAngle(g.axis, g.rad * rotW));
    // 飛行側では骨がシーンの外（localizeSkeletons の入れ物）にいるので自分で作り直す
    g.bone.updateMatrixWorld(true);
  }
  for (const m of rig.morphs) m.mesh.morphTargetInfluences[m.index] = m.extend ? 1 - morphW : morphW;
  rig.appliedR = r;
}

// 毎フレーム。脚の上げ下げに合わせて GEAR_RIG_S 秒かけて出し入れする。
// 最初の1回は今の状態へ一気に合わせる（空中から始めたとき脚をしまうところから見せない）
function updateAircraftGearRig(ac, controls, dt) {
  const rig = ac && ac.gearRig;
  if (!rig) return;
  const want = controls.gearDown ? 1 : 0;
  if (rig.t === null) rig.t = want;
  else {
    const step = dt / GEAR_RIG_S;
    rig.t += THREE.MathUtils.clamp(want - rig.t, -step, step);
  }
  const r = 1 - rig.t;
  if (r !== rig.appliedR) applyGearRigPose(rig, r);
}
