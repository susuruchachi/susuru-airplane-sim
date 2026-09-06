// 05d-vtol-system.js — 垂直離着陸（VTOL）用リフトエンジンの前後バランス調整
//
// 【座標系の規約】06-gizmo.js の軸方向ビューと同じ。
//   -Z = 機首方向 / +Z = 機尾方向 / +X = 右舷 / +Y = 上
//
// 【「リフトエンジン」の定義】
//   回転軸（props.spinAxis）が 'y' のエンジン＝ファンが水平に回る＝推力が上向き、
//   すなわち垂直離着陸用のエンジンとして扱う。既存のデータ形式をそのまま使うので、
//   保存済みの機体設定を読み込み直す必要はない。
//
// 【この機能が解決する問題】
//   垂直離陸中の機体は、リフトエンジンの推力の合力が重心の真上を通っていないと
//   前後に傾いてしまう。つまり「推力で重み付けしたZの平均（＝推力重心）」を
//   重心のZに合わせる必要がある。ところが従来のUIでは
//     ・位置の入力欄が step=0.05 の数値欄しかなく、数十mある機体では
//       スピナーで前後に動かすのが現実的でない
//     ・左右のエンジンはミラーで複製した「別々のパーツ」なので、
//       片方を動かすともう片方が取り残される（毎回2回同じ編集が要る）
//     ・そもそも今どれだけズレているのかを知る手段が無い
//   ため、前後位置合わせが手作業の当てずっぽうになっていた。

// 左右ミラーの相方とみなす位置の許容差（機体サイズに対する相対値）
const VTOL_MIRROR_EPS_REL = 0.002;
// 「左右対称に揃える」候補として拾う緩い許容差（機体サイズに対する相対値）
const VTOL_LOOSE_EPS_REL = 0.08;

function isLiftEngine(part) {
  return !!part && part.type === 'engine' && !!part.props && part.props.spinAxis === 'y';
}

function getLiftEngines() {
  return State.parts.filter(isLiftEngine);
}

// 位置の一致判定に使う許容差。機体の大きさに比例させる
// （小さな模型でも数十mの輸送機でも同じ感覚で効くようにするため）
function vtolMirrorEps() {
  return Math.max((State.model.boundingRadius || 1) * VTOL_MIRROR_EPS_REL, 1e-4);
}

// 厳密な左右ミラーの相方を探す。
// 「X が符号反転で一致し、Y・Z が一致するエンジン」だけを相方とみなす。
// ここを緩くすると前側エンジンと後ろ側エンジンを取り違えて連動させてしまうため、
// 自動連動の判定にはこの厳密版だけを使う。
function findMirrorTwinEngine(part) {
  if (!part || part.type !== 'engine') return null;
  const eps = vtolMirrorEps();
  if (Math.abs(part.position.x) < eps) return null; // 中心線上のエンジンに相方はいない
  return State.parts.find(p =>
    p.id !== part.id &&
    p.type === 'engine' &&
    (p.props.spinAxis || null) === (part.props.spinAxis || null) &&
    Math.abs(p.position.x + part.position.x) < eps &&
    Math.abs(p.position.y - part.position.y) < eps &&
    Math.abs(p.position.z - part.position.z) < eps
  ) || null;
}

// 「相方だったはずだが、片方だけ動かしてしまってズレている」エンジンを緩い条件で探す。
// 厳密版で見つからなかったときだけ使い、自動連動はせず「左右対称に揃える」の
// 提案としてUIに出す（勝手に動かすと、意図的な非対称配置を壊してしまうため）。
function findLooseMirrorCandidateEngine(part) {
  if (!part || part.type !== 'engine') return null;
  const eps = vtolMirrorEps();
  if (Math.abs(part.position.x) < eps) return null;
  const loose = Math.max((State.model.boundingRadius || 1) * VTOL_LOOSE_EPS_REL, 0.05);

  let best = null, bestDist = Infinity;
  for (const p of State.parts) {
    if (p.id === part.id || p.type !== 'engine') continue;
    if ((p.props.spinAxis || null) !== (part.props.spinAxis || null)) continue;
    if (Math.sign(p.position.x) === Math.sign(part.position.x)) continue; // 反対の舷にあること
    const dx = Math.abs(p.position.x + part.position.x);
    const dy = Math.abs(p.position.y - part.position.y);
    const dz = Math.abs(p.position.z - part.position.z);
    if (dx > loose || dy > loose || dz > loose) continue;
    const dist = dx + dy + dz;
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best;
}

// 相方に「鏡像の姿勢」を書き込む。反転規則は mirrorPart() と同じ
// （X位置は符号反転、X軸まわりの回転はそのまま、Y・Z軸まわりの回転は符号反転）。
function applyMirrorToTwin(src, twin) {
  if (!src || !twin) return;
  twin.position.x = -src.position.x;
  twin.position.y = src.position.y;
  twin.position.z = src.position.z;
  twin.rotation.x = src.rotation.x;
  twin.rotation.y = -src.rotation.y;
  twin.rotation.z = -src.rotation.z;
  twin.scale.x = src.scale.x;
  twin.scale.y = src.scale.y;
  twin.scale.z = src.scale.z;
  applyPartToGizmo(twin);
}

// ミラー連動が有効で、かつ相方がいるなら相方も一緒に動かす。
// 位置を書き換える全経路（数値欄・前後スライダー・ギズモのドラッグ）から呼ぶ。
function syncMirrorTwinIfLinked(part) {
  if (!State.mirrorLinkEnabled) return null;
  if (!part || part.type !== 'engine') return null;
  const twin = findMirrorTwinEngineBefore(part);
  if (!twin) return null;
  applyMirrorToTwin(part, twin);
  return twin;
}

// 【重要】連動対象の相方は「動かす前の位置」で判定しないといけない。
// 動かした後の位置で findMirrorTwinEngine() を呼ぶと、すでに相方とはズレているので
// 見つからず、連動が1回目の移動で切れてしまう。そこで選択時に相方を覚えておき
// （rememberMirrorTwin）、移動中はそのIDを使い続ける。
function findMirrorTwinEngineBefore(part) {
  const remembered = State.mirrorTwinCache;
  if (remembered && remembered.partId === part.id) {
    return State.parts.find(p => p.id === remembered.twinId) || null;
  }
  return findMirrorTwinEngine(part);
}

// パーツ選択時に呼び、そのパーツの相方を覚えておく
function rememberMirrorTwin(part) {
  if (!part || part.type !== 'engine') { State.mirrorTwinCache = null; return null; }
  const twin = findMirrorTwinEngine(part);
  State.mirrorTwinCache = twin ? { partId: part.id, twinId: twin.id } : null;
  return twin;
}

// ─────────────────────────────────────────
//  バランス計算
// ─────────────────────────────────────────
// リフトエンジン全体の推力重心（前後方向）と、重心とのズレを求める。
//   centroidZ : 推力で重み付けしたZの平均。ここが合力の作用線の位置になる
//   offsetZ   : centroidZ - 重心Z。正なら推力中心が重心より後ろ（＝機首下げ方向）
//   pitchMomentKgfM : 重心まわりのピッチングモーメント[kgf·m]
//   hoverRatio: 合計推力 / 機体重量。1.0未満だと自重を支えられず浮かない
function computeVtolBalance() {
  const engines = getLiftEngines();
  const cgZ = State.cg.position.z;

  let totalThrust = 0, momentSum = 0;
  for (const e of engines) {
    const th = Math.max(0, Number(e.props.thrustKgf) || 0);
    totalThrust += th;
    momentSum += th * e.position.z;
  }

  const centroidZ = totalThrust > 0 ? momentSum / totalThrust : null;
  const offsetZ = centroidZ === null ? null : centroidZ - cgZ;
  const weightKg = Math.max(0, Number(State.model.weightKg) || 0);

  return {
    engines,
    count: engines.length,
    totalThrust,
    centroidZ,
    cgZ,
    offsetZ,
    pitchMomentKgfM: offsetZ === null ? null : totalThrust * offsetZ,
    weightKg,
    hoverRatio: weightKg > 0 && totalThrust > 0 ? totalThrust / weightKg : null,
  };
}

// 「釣り合っている」とみなすズレの閾値[m]。機体サイズに比例させる
function vtolBalanceTolerance() {
  return Math.max((State.model.boundingRadius || 1) * 0.005, 0.01);
}

// 指定したエンジン（と、その左右の相方）だけを前後に動かして全体を釣り合わせるための
// Z座標を解く。
//   釣り合い条件: (他エンジンのモーメント + このペアの推力 * z) / 合計推力 = 重心Z
//   → z = (重心Z * 合計推力 - 他エンジンのモーメント) / このペアの推力
// このペアの推力が0なら（推力0のエンジン）どこに置いても釣り合いに寄与しないので解無し。
function solveBalanceZForEnginePair(part) {
  if (!isLiftEngine(part)) return null;

  const twin = findMirrorTwinEngineBefore(part);
  const group = twin ? [part, twin] : [part];
  const groupIds = new Set(group.map(p => p.id));

  let groupThrust = 0;
  for (const p of group) groupThrust += Math.max(0, Number(p.props.thrustKgf) || 0);
  if (groupThrust <= 0) return null;

  let restThrust = 0, restMoment = 0;
  for (const e of getLiftEngines()) {
    if (groupIds.has(e.id)) continue;
    const th = Math.max(0, Number(e.props.thrustKgf) || 0);
    restThrust += th;
    restMoment += th * e.position.z;
  }

  const totalThrust = restThrust + groupThrust;
  return (State.cg.position.z * totalThrust - restMoment) / groupThrust;
}

// エンジン（と相方）のZ座標だけを設定する
function setEnginePairZ(part, z) {
  const twin = findMirrorTwinEngineBefore(part);
  part.position.z = z;
  applyPartToGizmo(part);
  if (twin) { twin.position.z = z; applyPartToGizmo(twin); }
  return twin;
}

// 選択中のエンジンペアを動かして全体を釣り合わせる
function balanceVtolWithSelectedPair(partId) {
  const part = State.parts.find(p => p.id === partId);
  if (!isLiftEngine(part)) return false;

  const z = solveBalanceZForEnginePair(part);
  if (z === null || !isFinite(z)) {
    showToast('このエンジンの推力が0のため、前後位置では釣り合わせられません', true);
    return false;
  }

  const range = modelZRange();
  const twin = setEnginePairZ(part, z);

  const movedLabel = twin ? `「${part.name}」と相方の2基` : `「${part.name}」`;
  if (range && (z < range.min || z > range.max)) {
    showToast(`${movedLabel}を Z = ${z.toFixed(3)} へ移動しました（機体の外側です。推力配分の見直しを検討してください）`, true);
  } else {
    showToast(`${movedLabel}を Z = ${z.toFixed(3)} へ移動し、推力重心を重心に合わせました`);
  }
  return true;
}

// 全リフトエンジンをまとめて前後に平行移動し、推力重心を重心に合わせる。
// 前後の間隔（配置の広がり）は保ったまま、ズレの分だけ全体をスライドさせる。
function balanceVtolByShiftingAll() {
  const b = computeVtolBalance();
  if (b.count === 0 || b.offsetZ === null) {
    showToast('リフトエンジン（回転軸Y）が配置されていません', true);
    return false;
  }
  if (Math.abs(b.offsetZ) < 1e-6) {
    showToast('すでに釣り合っています');
    return false;
  }

  const shift = -b.offsetZ;
  for (const e of b.engines) {
    e.position.z += shift;
    applyPartToGizmo(e);
  }
  showToast(`リフトエンジン${b.count}基を前後に ${shift >= 0 ? '+' : ''}${shift.toFixed(3)} m 動かし、推力重心を重心に合わせました`);
  return true;
}

// ズレているエンジンを相方の鏡像位置へ揃える
function symmetrizeEnginePair(partId) {
  const part = State.parts.find(p => p.id === partId);
  if (!part) return false;
  const cand = findLooseMirrorCandidateEngine(part);
  if (!cand) {
    showToast('左右対称に揃えられる相手のエンジンが見つかりません', true);
    return false;
  }
  applyMirrorToTwin(part, cand);
  State.mirrorTwinCache = { partId: part.id, twinId: cand.id };
  showToast(`「${cand.name}」を「${part.name}」の鏡像位置に揃えました`);
  return true;
}

// ─────────────────────────────────────────
//  前後スライダーの範囲
// ─────────────────────────────────────────
// 機体本体メッシュの前後方向の範囲を、パーツ座標系（model.rootのローカル座標系）で返す。
// computeModelMeshBoundingBox() はワールド基準のbboxを返すため、rootに回転・拡縮が
// かかっている場合はそのままではパーツのposition.zと比較できない。rootの逆行列を
// 通してローカル座標系に直す。
// 既に配置済みのパーツが機体の外に出ている場合もスライダーで掴めるよう、
// パーツのZも範囲に含めたうえで少し余裕を持たせる。
function modelZRange() {
  let min = Infinity, max = -Infinity;

  if (State.model.root) {
    const box = (typeof computeModelMeshBoundingBox === 'function') ? computeModelMeshBoundingBox() : null;
    if (box && !box.isEmpty()) {
      State.model.root.updateMatrixWorld(true);
      const localBox = box.clone().applyMatrix4(new THREE.Matrix4().copy(State.model.root.matrixWorld).invert());
      min = Math.min(min, localBox.min.z);
      max = Math.max(max, localBox.max.z);
    }
  }

  for (const p of State.parts) {
    min = Math.min(min, p.position.z);
    max = Math.max(max, p.position.z);
  }
  min = Math.min(min, State.cg.position.z);
  max = Math.max(max, State.cg.position.z);

  if (!isFinite(min) || !isFinite(max)) return null;

  const span = Math.max(max - min, 1);
  const pad = span * 0.15; // 現在の端よりさらに外へも動かせるように余白を足す
  return { min: min - pad, max: max + pad };
}

// スライダーの刻み幅。機体サイズに応じて、全長を約2000分割する程度の細かさにする
// （数十mの機体でも、1pxのドラッグで不自然に飛ばない粒度）
function modelZStep() {
  const range = modelZRange();
  if (!range) return 0.01;
  const step = (range.max - range.min) / 2000;
  // 0.001 / 0.002 / 0.005 / 0.01 ... という「きりのよい」刻みに丸める
  const exp = Math.floor(Math.log10(step));
  const base = Math.pow(10, exp);
  const mant = step / base;
  const snapped = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10;
  return Math.max(snapped * base, 0.001);
}
