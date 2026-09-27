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
// **着陸の速さで釣り合わないなら、釣り合うところまで静安定を減らす**。静安定が大きいほど、迎角を取って
// 飛ぶとき（遅いとき）に機首上げの舵が要る。水平尾翼を持たずエレボンで機首を上げる機体では、10%だと
// 着陸の速さを舵で支えきれないことがある——送ってもらった Concorde（エレボン最大20°）は10%で、
// 進入速度（失速の1.3倍）でもトリムと昇降舵を一杯に使って釣り合わず、自動着陸が -1,445fpm で接地した。
// 飛行モデル（09-aircraft.js・10-flight.js。Builder でも読み込む）の solveLevelTrim で、失速の1.3倍
// （進入）と1.2倍（接地の手前）を**トリムだけで**釣り合わせられるか確かめる。トリムで釣り合えば、
// 昇降舵（エレボン）はまるごと引き起こしに残る。下限は飛行側で「静安定なし」と見なす線（AC_MIN_STATIC_MARGIN_PCT）。
// 「トリム6割まで」と厳しくすると、三式戦闘機（10%で進入にトリム0.75〜0.87。昇降舵が別にあって-220fpmで降りる）
// まで下げてしまった。
const PB_LANDING_SPEEDS = [1.3, 1.2];  // 失速速度の何倍で確かめるか
// 下げてよい静安定の下限（飛行側で「静安定なし」と見なす線 AC_MIN_STATIC_MARGIN_PCT と同じ）
const PB_MIN_MARGIN_MAC = (typeof AC_MIN_STATIC_MARGIN_PCT === 'number' ? AC_MIN_STATIC_MARGIN_PCT : 3) / 100;
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
  // 主翼の後ろの水平尾翼は、吹き下ろしで迎角の変化が (1 − dε/dα) 倍になるぶん軽く数える
  // （飛行の側 09-aircraft.js と同じ。csDownwashSlope）
  const noseDir = pbNoseDirection();
  const behind = noseDir ? tail.point.clone().sub(main.point).dot(noseDir) < 0 : true;
  const tailW = tail.area * (behind ? 1 - csDownwashSlope(main.aspect) : 1);
  const totalArea = main.area + tailW;
  const point = main.point.clone().multiplyScalar(main.area / totalArea)
    .add(tail.point.clone().multiplyScalar(tailW / totalArea));
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

// いまの Builder の状態を、飛行モデルに渡す設定の形にする（02-storage.js の buildCurrentRecord と同じ中身。
// 3Dモデル本体は要らない）
function pbCurrentConfig() {
  const root = State.model.root;
  return {
    parts: State.parts.map(p => ({
      id: p.id, type: p.type, name: p.name,
      position: { x: 0, y: 0, z: 0, ...p.position }, rotation: { x: 0, y: 0, z: 0, ...p.rotation },
      scale: { x: 1, y: 1, z: 1, ...p.scale },
      props: JSON.parse(JSON.stringify(p.props || {})),
    })),
    cg: { ...State.cg.position },
    modelTransform: root ? {
      rotation: { x: root.rotation.x, y: root.rotation.y, z: root.rotation.z },
      scale: { x: root.scale.x, y: root.scale.y, z: root.scale.z },
    } : null,
    modelWeightKg: State.model.weightKg,
    modelMaxSpeedValue: State.model.maxSpeedValue,
    modelMaxSpeedUnit: State.model.maxSpeedUnit,
  };
}

// 着陸の速さ（PB_LANDING_SPEEDS）で、トリムだけで水平に釣り合うか。
// 翼が足りない（その速さでは失速の手前まで迎角を取っても浮かない）のは重心では直せないので、見逃す。
// 飛行モデルが読み込まれていなければ null（確かめられない）
function pbLandingTrimCheck() {
  if (typeof buildAircraftModel !== 'function' || typeof solveLevelTrim !== 'function') return null;
  let model;
  try { model = buildAircraftModel(pbCurrentConfig()); } catch (e) { return null; }
  const stall = analyzeAircraftPerformance(model).stallMps;
  if (!(stall > 0)) return null;
  let worst = 0, ok = true;
  for (const k of PB_LANDING_SPEEDS) {
    const tr = solveLevelTrim(model, stall * k, 0);
    if (tr.ok) {
      worst = Math.max(worst, Math.abs(tr.trim));
    } else if (tr.reason !== 'wing') {
      ok = false; worst = Math.max(worst, 1);
    }
  }
  return { ok, worstTrim: worst };
}

// 重心を、中立点から翼弦の margin ぶん前へ置く
function pbPlaceCg(neutral, noseDir, margin) {
  const target = neutral.point.clone().addScaledVector(noseDir, margin * neutral.mac);
  State.cg.position.x = target.x;
  State.cg.position.y = target.y;
  State.cg.position.z = target.z;
}

// 重心を、中立点から翼弦の10%ぶん前へ。着陸の速さで舵が釣り合わなければ、
// 釣り合う範囲でいちばん大きい静安定まで下げる（挟み撃ち。静安定が小さいほど要る機首上げの舵は減る）。
// 返すのは { margin, landing }。landing.reduced は10%から下げたとき
function pbChooseMargin(neutral, noseDir) {
  let margin = PB_TARGET_MARGIN_MAC;
  pbPlaceCg(neutral, noseDir, margin);
  let landing = pbLandingTrimCheck();
  if (landing && !landing.ok) {
    // 下げて良くなるのは「機首上げの舵が足りない」ときだけ。機首下げが足りない機体は、下げるとかえって悪くなる
    pbPlaceCg(neutral, noseDir, PB_MIN_MARGIN_MAC);
    const atMin = pbLandingTrimCheck();
    if (atMin && atMin.ok) {
      let lo = PB_MIN_MARGIN_MAC, hi = PB_TARGET_MARGIN_MAC;   // lo は釣り合う、hi は釣り合わない
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        pbPlaceCg(neutral, noseDir, mid);
        if (pbLandingTrimCheck().ok) lo = mid; else hi = mid;
      }
      margin = lo;
    } else if (atMin && atMin.worstTrim < landing.worstTrim - 0.05) {
      margin = PB_MIN_MARGIN_MAC;   // 下限でも足りない：舵面を大きくしてもらうしかない（トーストで知らせる）
    }
    pbPlaceCg(neutral, noseDir, margin);
    if (margin !== PB_TARGET_MARGIN_MAC) landing = Object.assign(pbLandingTrimCheck() || {}, { reduced: true });
  }
  return { margin, landing };
}

// いまの重心で残るエンジンの推力モーメントを、角度を振って打ち消す。足した角度(°)を返す
function pbTiltEngines(noseDir) {
  const engines = pbForwardEngines();
  if (!engines.length) return 0;
  // エンジンの向き判定は「見た目の前」（modelTransform込み）基準で行う
  const fixQ = pbFixQuaternion(pbNoseDirection(true) || noseDir);
  const residual = pbEngineMoment(engines, State.cg.position, fixQ, 0);
  if (Math.abs(residual) < PB_MOMENT_OK()) return 0;
  const tiltDeg = pbBisect(
    (d) => pbEngineMoment(engines, State.cg.position, fixQ, d),
    -PB_ENGINE_TILT_MAX_DEG, PB_ENGINE_TILT_MAX_DEG);
  for (const e of engines) {
    e.rotation = e.rotation || { x: 0, y: 0, z: 0 };
    e.rotation.x = (e.rotation.x || 0) + tiltDeg;
    if (e.gizmo) applyPartToGizmo(e);
  }
  return tiltDeg;
}

// 「空力バランスを整える」— 重心とエンジンの角度を、実際にモーメントを測りながら決める。
function balancePitchTrim() {
  const noseDir = pbNoseDirection();
  if (!noseDir) { showToast('主翼（無ければ水平尾翼）が必要です', true); return false; }
  const neutral = pbNeutralPoint();
  if (!neutral || neutral.mac < 1e-6) { showToast('主翼の翼弦が読めませんでした', true); return false; }

  const before = pbBalanceReport();

  // 1) 重心を決める → 2) 残るエンジンの推力モーメントを角度で打ち消す。
  // エンジンを傾けると推力の向きが変わって着陸の速さでの釣り合いも変わるので、傾けたあとで確かめ直し、
  // 釣り合わなければ重心から選び直す（Concorde は重心を選んだあとにエンジンを2.5°傾けると、
  // 失速の1.2倍で釣り合わなくなっていた）。数回で落ち着く
  let chosen = pbChooseMargin(neutral, noseDir);
  let tiltDeg = pbTiltEngines(noseDir);
  for (let k = 0; k < 3; k++) {
    const again = pbLandingTrimCheck();
    if (!again || again.ok) break;
    chosen = pbChooseMargin(neutral, noseDir);
    tiltDeg += pbTiltEngines(noseDir);
  }
  const landing = chosen.landing;
  applyCgToGizmo();

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
  const landingTxt = landing && landing.reduced
    ? (landing.ok
      ? `（10%では着陸の速さを舵で支えきれないので、支えられる${after.staticMarginPct.toFixed(0)}%にしました）`
      : `（着陸の速さを舵で支えきれません。${after.staticMarginPct.toFixed(0)}%まで下げても足りないので、昇降舵・エレボンを大きくしてください）`)
    : '';
  showToast(`${marginTxt}${landingTxt}${tiltTxt}${stillOff}`);
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
      10%では着陸の速さを舵で支えきれない機体は、支えられるところまで静安定を下げます（下限3%）。
      エレベーターが効かない機体（デルタ翼のエレボンなど）はこれで直ります。
    </div>
  `;
}
