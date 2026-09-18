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
const BONE_WORDS = {
  flap: ['フラップ', 'flap'],
  spoiler: ['スポイラー', 'エアブレーキ', 'spoiler', 'airbrake', 'speedbrake'],
  skip: ['着陸脚', '脚', 'gear', 'landing', '可変翼', 'sweep', 'swing', 'ギア'],
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

// ボーンを1本ずつ試しに回して、ヒンジ軸と振れる向きを決める。
// root は機体の入れ物（この時点でワールド＝機体座標：重心が原点・機首が-Z）。
function buildAircraftBones(root) {
  if (!root || typeof THREE === 'undefined') return [];
  const { skinned, clouds } = collectBoneClouds(root);
  if (!skinned.length) return [];
  // スキンは境界球をバインドポーズで持っているので、舵を振ると画面外判定が
  // ずれて消えることがある。枚数は知れているので切らない。
  for (const m of skinned) m.frustumCulled = false;

  const out = [];
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  for (const e of clouds.values()) {
    const bone = e.bone, items = e.items;
    if (items.length < BONE_MIN_VERTS) continue;
    // 子ボーンを持つ骨は、舵ではなく「枝の付け根」（翼の付け根・脚の親など）
    if (bone.children.some((o) => o.isBone)) continue;
    const named = boneRoleFromName(bone.name);
    if (named === 'skip') continue;

    const base = items.map((it) => boneSkinnedPoint(it, new THREE.Vector3()));
    const center = new THREE.Vector3();
    for (const q of base) center.add(q);
    center.multiplyScalar(1 / base.length);
    const [a1, , a3] = bonePrincipalAxes(base, center);
    const long = boneSpread(base, center, a1);
    const thick = boneSpread(base, center, a3);
    if (long <= 1e-4) continue;
    if (thick / long > BONE_PLATE_RATIO) continue;   // 板ではない

    // 3つのローカル軸で試し回転して、いちばんヒンジらしい軸を選ぶ
    const rest = bone.quaternion.clone();
    let best = null;
    for (let ai = 0; ai < 3; ai++) {
      bone.quaternion.copy(rest).multiply(
        _boneQ.setFromAxisAngle(axes[ai], THREE.MathUtils.degToRad(BONE_TEST_DEG)));
      root.updateMatrixWorld(true);
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
      // 同じくらいヒンジらしい軸が2本あることがある（骨の向き次第）。
      // そのときは**大きく振れるほう**が本物のヒンジ。
      if (score >= BONE_SCORE_MIN && (!best || avg > best.avg)) {
        best = { axis: axes[ai].clone(), dir: mean.clone(), avg, score };
      }
      bone.quaternion.copy(rest);
    }
    root.updateMatrixWorld(true);
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
    }
  }
}
