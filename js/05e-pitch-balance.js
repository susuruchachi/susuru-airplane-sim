// 05e-pitch-balance.js — 機体まるごとのピッチの釣り合いを、置きながら整える
//
// 「主翼から決定」は重心を主翼の空力中心へぴったり合わせる。これは水平尾翼を
// 持つふつうの機体には正しいが、水平尾翼を持たずエルロン（エレボン）だけで
// 飛ばす機体（デルタ翼など）では、力のかかる点が重心の真上になってしまい、
// 舵を切ってもモーメントの腕（重心からの距離）がゼロになる——実際にそういう
// 報告があり、機体がまったく操縦できなくなっていた。
//
// ここでは2段でピッチを整える。
//   1. 重心を、主翼（＋水平尾翼があればそれも）の空力中心から、ふつうの静安定
//      （翼弦の10%）ぶんだけ前へ離して置く。「前」は主翼自身の翼弦の向きから
//      決めるので、機体がどちら向きに作られていても正しく前へ動く
//      （09-aircraft.js の acOrientationFix と同じ考え方）。
//   2. それでも残るエンジン推力のずれ（推力線が重心を通らず、出力を上げるほど
//      機首を振る力になる）は、推力そのものを少し傾けて打ち消す
//      （実機のエンジン取付角と同じ考え方）。
//
// Builderは飛行モデル（09-aircraft.js）を読み込んでいないので、同じ計算を
// ここで独立に行う。engine の rotation が推力の向きに乗るのは 09-aircraft.js
// 側の対応する直しと対で、傾けたぶんは実際に飛行でも効く。

const PB_TARGET_MARGIN_MAC = 0.10; // 目標の静安定（翼弦の10%。ふつうの範囲5〜20%の真ん中）
const PB_ENGINE_TILT_MAX_DEG = 20; // エンジンを傾ける角度の上限（これ以上は見た目にも不自然）
const PB_MOMENT_OK = () => Math.max(State.model.weightKg, 1) * 0.5; // solveLevelTrimのmomentOk判定と同じ基準

// 主翼（無ければ水平尾翼、それも無ければ全部の翼）の翼弦から「前」の向きを読む。
// 上下の情報は翼弦には無いので、水平成分だけを使う——機体を傾けて作っていても
// 前後だけは正しく決まる。翼が無ければ null（決めようがない）。
//
// worldSpace（既定false）… trueにすると、機体まるごとの向き（modelTransform）も
// 掛けた「実際の見た目の前」を返す。エンジンの spinAxis は「Builderの画面に
// 見えている向き」を指す約束（09-aircraft.js と同じ）なので、エンジンの向きに
// 掛ける qFix（pbFixQuaternion経由）はこちらを使う——素の値のままだと、
// 前後逆さに作られたモデルを modelTransform で直している機体（実際に来た
// Boeing 747がそう）で、翼は正しく直っているのにエンジンの向きの基準だけ
// 逆になり、推力の向きの判定を丸ごと誤る（「前向きエンジンが無い」と
// 誤診断される）。CGの計算（wingsAeroCenterByRoleなど）はState.cg.positionが
// modelTransformを掛ける前の値として保存されるため、必ずfalse（既定）で使うこと。
function pbNoseDirection(worldSpace) {
  const wings = State.parts.filter(p => p.type === 'wing' && p.props && p.props.corners);
  const pick = wings.filter(w => w.props.role === 'main');
  const use = pick.length ? pick
    : (wings.filter(w => w.props.role === 'htail').length ? wings.filter(w => w.props.role === 'htail') : wings);
  if (!use.length) return null;

  const modelMat = worldSpace ? cgModelMatrix() : null;
  const chord = new THREE.Vector3();
  for (const w of use) {
    const m = modelMat ? new THREE.Matrix4().multiplyMatrices(modelMat, cgPartMatrix(w)) : cgPartMatrix(w);
    const c = w.props.corners || {};
    const v = (k) => { const p = c[k] || { x: 0, y: 0, z: 0 }; return new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0).applyMatrix4(m); };
    const leading = v('rootLeading').add(v('tipLeading')).multiplyScalar(0.5);
    const trailing = v('rootTrailing').add(v('tipTrailing')).multiplyScalar(0.5);
    const area = cgQuadArea(v('rootLeading'), v('tipLeading'), v('tipTrailing'), v('rootTrailing'));
    chord.addScaledVector(trailing.clone().sub(leading), area); // 前縁→後縁（＝後ろ向き）
  }
  if (chord.lengthSq() < 1e-9) return null;
  const fwd = chord.negate().normalize();
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-9) return null; // 翼弦が真上/真下を向いている（決めようがない）
  return fwd.normalize();
}

// 主翼＋水平尾翼をまとめた「中立点」（ここに重心があると静安定0%になる点）
function pbNeutralPoint() {
  const main = wingsAeroCenterByRole('main');
  if (!main) return null;
  const tail = wingsAeroCenterByRole('htail');
  if (!tail) return { point: main.point.clone(), mac: main.chordMax || main.chord };
  const totalArea = main.area + tail.area;
  const point = main.point.clone().multiplyScalar(main.area / totalArea)
    .add(tail.point.clone().multiplyScalar(tail.area / totalArea));
  return { point, mac: main.chordMax || main.chord };
}

// 09-aircraft.js の acOrientationFix と同じ、ヨーだけの向き補正。エンジンの
// モーメント（後述）はY・Z成分が絡むので、ここだけは実際に回してから計算する
// 必要がある（前後方向の静安定は射影だけで済むが、モーメントはそうはいかない）。
function pbFixQuaternion(noseDir) {
  return new THREE.Quaternion().setFromUnitVectors(noseDir, new THREE.Vector3(0, 0, -1));
}

// 前へ進む（垂直離陸用ではない）エンジン一覧。位置・推力・いまの角度を集める。
function pbForwardEngines() {
  return State.parts.filter(p => p.type === 'engine' && p.props
    && p.props.spinAxis !== 'y' && (p.props.thrustKgf || 0) > 0);
}

// 指定した重心・向き補正のもとで、エンジン推力が生むピッチモーメントを計算する。
// tiltDeltaDeg … 各エンジンのいまの rotation.x に、さらにこれだけ足して試す（bisection用）
function pbEngineMoment(engines, cgPos, fixQ, tiltDeltaDeg) {
  let total = 0;
  for (const e of engines) {
    const spin = e.props.spinAxis || 'z';
    const axis = spin === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1);
    const r = e.rotation || {};
    axis.applyEuler(new THREE.Euler(
      THREE.MathUtils.degToRad((r.x || 0) + tiltDeltaDeg),
      THREE.MathUtils.degToRad(r.y || 0),
      THREE.MathUtils.degToRad(r.z || 0)
    ));
    axis.applyQuaternion(fixQ).normalize();
    const thrustN = e.props.thrustKgf * 9.80665;
    // 位置は機体まるごとの向き（cgModelMatrix）を先に掛けてからqFix——
    // 09-aircraft.js のエンジン位置の扱いと同じ（向き=spinAxisとは違い、
    // 位置は本当にroot基準のローカル値なので、modelTransformの復元が要る）。
    const posVec = new THREE.Vector3(e.position.x || 0, e.position.y || 0, e.position.z || 0);
    const arm = posVec.sub(cgPos).applyMatrix4(cgModelMatrix()).applyQuaternion(fixQ);
    const force = axis.multiplyScalar(thrustN);
    total += arm.y * force.z - arm.z * force.y; // 09-aircraft.js の thrustPitchMoment と同じ式
  }
  return total;
}

// 単調とは限らないが、ここでは実質単調な量を挟み撃ちで解く。範囲内に解が無ければ
// いちばん惜しい端を返す（VTOLバランスのtrimBisectと同じ考え方）。
function pbBisect(f, lo, hi) {
  let a = f(lo), b = f(hi);
  if ((a < 0) === (b < 0)) return Math.abs(a) <= Math.abs(b) ? lo : hi;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if ((v < 0) === (a < 0)) { lo = mid; a = v; } else { hi = mid; b = v; }
  }
  return (lo + hi) / 2;
}

// いまの状態を見る。ピッチの釣り合いパネルが使う。
function pbBalanceReport() {
  const noseDir = pbNoseDirection();
  if (!noseDir) return null;
  const neutral = pbNeutralPoint();
  if (!neutral) return null;

  const aft = noseDir.clone().negate();
  // 中立点は重心からどれだけ後ろにあるか（＝静安定そのもの）
  const marginM = neutral.point.clone().sub(State.cg.position).dot(aft);
  const staticMarginPct = neutral.mac > 1e-6 ? (marginM / neutral.mac) * 100 : 0;

  const engines = pbForwardEngines();
  // エンジンの向き判定は「見た目の前」（modelTransform込み）基準で行う
  const fixQ = pbFixQuaternion(pbNoseDirection(true) || noseDir);
  const moment = engines.length ? pbEngineMoment(engines, State.cg.position, fixQ, 0) : 0;

  return {
    noseDir, neutral, staticMarginPct, marginM,
    engineCount: engines.length, thrustPitchMoment: moment,
    momentOk: Math.abs(moment) < PB_MOMENT_OK(),
  };
}

// 「空力バランスを整える」— 重心とエンジンの角度を、実際にモーメントを測りながら決める。
function balancePitchTrim() {
  const noseDir = pbNoseDirection();
  if (!noseDir) { showToast('主翼（無ければ水平尾翼）が必要です', true); return false; }
  const neutral = pbNeutralPoint();
  if (!neutral || neutral.mac < 1e-6) { showToast('主翼の翼弦が読めませんでした', true); return false; }

  const before = pbBalanceReport();

  // 1) 重心を、中立点から翼弦の10%ぶん前へ
  const target = neutral.point.clone().addScaledVector(noseDir, PB_TARGET_MARGIN_MAC * neutral.mac);
  State.cg.position.x = target.x;
  State.cg.position.y = target.y;
  State.cg.position.z = target.z;
  applyCgToGizmo();

  // 2) それでも残るエンジンの推力モーメントを、角度を振って打ち消す
  const engines = pbForwardEngines();
  let tiltDeg = 0;
  if (engines.length) {
    // エンジンの向き判定は「見た目の前」（modelTransform込み）基準で行う
    const fixQ = pbFixQuaternion(pbNoseDirection(true) || noseDir);
    const residual = pbEngineMoment(engines, State.cg.position, fixQ, 0);
    if (Math.abs(residual) >= PB_MOMENT_OK()) {
      tiltDeg = pbBisect(
        (d) => pbEngineMoment(engines, State.cg.position, fixQ, d),
        -PB_ENGINE_TILT_MAX_DEG, PB_ENGINE_TILT_MAX_DEG);
      for (const e of engines) {
        e.rotation = e.rotation || { x: 0, y: 0, z: 0 };
        e.rotation.x = (e.rotation.x || 0) + tiltDeg;
        if (e.gizmo) applyPartToGizmo(e);
      }
    }
  }

  if (State.cg.selected) updateInspectorNumbersOnly(null, true);
  renderPartList();
  renderInspector();

  const after = pbBalanceReport();
  const marginTxt = `静安定 ${before ? before.staticMarginPct.toFixed(0) : '?'}% → `
    + `${after.staticMarginPct.toFixed(0)}%`;
  const tiltTxt = tiltDeg !== 0
    ? `／エンジンを${tiltDeg >= 0 ? '機首上げ' : '機首下げ'}側へ${Math.abs(tiltDeg).toFixed(1)}°`
    : '';
  const stillOff = !after.momentOk
    ? '（推力のずれが大きく、エンジンを振り切っても打ち消しきれません。エンジンをもっと重心に近づけてください）'
    : '';
  showToast(`${marginTxt}${tiltTxt}${stillOff}`);
  return true;
}

// 選択中の重心パネルに出す、ピッチ釣り合いの様子
function pbBalancePanelHtml() {
  const rep = pbBalanceReport();
  if (!rep) return '';
  const warn = (t) => `<span style="color:var(--warn);">${t}</span>`;
  const good = (t) => `<span style="color:var(--ok);">${t}</span>`;
  const marginOk = rep.staticMarginPct >= 3 && rep.staticMarginPct <= 25;
  const momentTxt = rep.engineCount
    ? (rep.momentOk ? good('打ち消せています')
      : warn(`ずれています（${(Math.abs(rep.thrustPitchMoment) / 1000).toFixed(0)} kN·m）`))
    : '（前へ進むエンジンなし）';
  return `
    <div class="divider"></div>
    <div class="subgroup-title">ピッチの釣り合い</div>
    <div class="hint" style="line-height:1.7;">
      静安定 ${marginOk ? good(rep.staticMarginPct.toFixed(0) + '%') : warn(rep.staticMarginPct.toFixed(0) + '%')}
      （ふつうは5〜20%）<br>
      エンジン推力のずれ ${momentTxt}
    </div>
    <button class="btn-danger-outline" id="btnPitchBalance"
      style="color:var(--accent);border-color:var(--accent-dim);margin-top:6px;">
      空力バランスを整える
    </button>
    <div class="hint" style="margin-top:6px;">
      重心を、主翼（＋水平尾翼）の中立点から翼弦10%ぶん前へ動かし、
      残ったエンジン推力のずれは角度を振って打ち消します。
      エレベーターが効かない機体（デルタ翼のエレボンなど）はこれで直ります。
    </div>
  `;
}
