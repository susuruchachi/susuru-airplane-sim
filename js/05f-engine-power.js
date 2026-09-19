// 05f-engine-power.js — エンジン出力の自動設定と一括調整
//
// Builderでエンジンを置いても、その推力が「設定した最高速度を出せるか」
// 「垂直離陸ぶんの力があるか」は数字を自分で計算しないと分からない。
// ここでは 09-aircraft.js の抗力・推力モデルと同じ式をBuilder側で独立に再現し
// （Builderは飛行モデルを読み込んでいないため。05e-pitch-balance.js と同じ理由）、
// 最高速度・垂直離陸それぞれに足りる推力を逆算してエンジンへ書き戻す。
// あわせて、通常／垂直それぞれのエンジンをまとめて倍率で増減できるようにする。

// 09-aircraft.js の AERO_DEFAULTS と同じ値。Builderはそちらを読み込んでいないので
// ここに複製してある——値を変えるときは両方合わせること。
const EP_AERO = {
  cd0Wing: 0.010,
  oswald: 0.80,
  fuselageCd: 1.00,
};
const EP_CLMAX = 1.5;               // 09-aircraft.js の AC_CLMAX と同じ
// 09-aircraft.js の ENGINE_KINDS と同じ値（種別ごとの推力の出かた）。
const EP_ENGINE_KINDS = {
  prop:   { decay: 0.75, rhoPow: 1.00, ab: 0 },
  jet:    { decay: 0.20, rhoPow: 0.85, ab: 0 },
  jet_ab: { decay: 0.20, rhoPow: 0.85, ab: 0.5 },
  rocket: { decay: 0.00, rhoPow: 0.00, ab: 0 },
};
const EP_RHO0 = 1.225;
// 10-flight.js の airDensityAt と同じ（20kmで頭打ちになるところまで同じにする——
// 頭打ちを無視して見積もると、飛行モデルが出す抗力より軽く見積もってしまう）。
function epAirDensityAt(altitudeM) {
  const h = Math.max(Math.min(altitudeM, 20000), -500);
  return EP_RHO0 * Math.pow(Math.max(1 - 2.2557e-5 * h, 0.05), 4.2559);
}
// **その速度なら、実際どのくらいの高さを飛ぶのか**。
// 推力を見積もるとき海面の空気で計算すると、速い機体ほど桁違いに外れる——
// 実機は速くなるほど高いところを飛ぶので、受ける動圧はどれも同じくらいに収まる
// （747 11km/250m/s で11kPa、Concorde 18km/600m/s で22kPa、SR-71 24km/980m/s で22kPa、
// X-15 30km/1500m/s で20kPa）。そこで「動圧がこの値になる高さ」を巡航高度とみなす。
// これより遅い機体（およそ330kt以下）は海面のまま＝いままでと同じ扱いになる。
const EP_CRUISE_Q_PA = 18000;
function epCruiseAltitudeFor(vMps) {
  const v = Math.max(vMps, 1);
  const rhoWant = (2 * EP_CRUISE_Q_PA) / (v * v);
  if (rhoWant >= EP_RHO0) return 0;                     // 遅い機体は海面で評価する
  // 気圧高度の式を解く: rho = rho0 * (1 - 2.2557e-5 h)^4.2559
  const h = (1 - Math.pow(rhoWant / EP_RHO0, 1 / 4.2559)) / 2.2557e-5;
  return Math.max(Math.min(h, 20000), 0);
}
// 10-flight.js の ENGINE_RATIO_MAX と同じ
const EP_RATIO_MAX = 3.0;
// エンジン1基が、その速度・高度・レバー全開で静止推力の何倍を出すか
// （10-flight.js の engineThrustScale と同じ式）。
// vMps を groupVMaxMps と同じにすれば「そのグループの最高速度ちょうど」、
// 速い速度を渡せば「速いグループに付き合っているときの出力」になる。
// 頭打ちは機体ぜんぶで1つ（＝いちばん速いグループの最高速度）なので、
// ここで評価する速度では常に効いていない扱いでよい。
function epThrustScale(part, altitudeM, vMps, groupVMaxMps) {
  const kind = EP_ENGINE_KINDS[(part.props && part.props.engineKind)] || EP_ENGINE_KINDS.prop;
  const ratio = Math.min(Math.max(vMps / Math.max(groupVMaxMps || 0, 1), 0), EP_RATIO_MAX);
  const f = Math.max(1 - kind.decay * ratio, 0.05);
  const rhoFactor = kind.rhoPow > 0
    ? Math.pow(epAirDensityAt(altitudeM) / EP_RHO0, kind.rhoPow) : 1;
  return f * rhoFactor * (1 + kind.ab);
}
// 釣り合いぎりぎりだと最高速度に漸近するだけで実際には届かない。しかも、ここでの
// 抗力はBuilderが持っている情報（主翼の面積・アスペクト比）だけから見積もった簡略値で、
// 尾翼が水平飛行のトリムで作る誘導抗力など、実際の飛行モデル（10-flight.jsの
// accumulateAeroForces）が翼1枚ずつ積み上げて出す値より小さめに出る
// （実測で2〜3割ほど）。その両方を見込んで、控えめに見積もった抗力の35%増しを狙う。
const EP_SPEED_THRUST_MARGIN = 1.35;
const EP_VTOL_TWR_TARGET = 1.3;      // 垂直離陸の目標推力重量比（1.0はぎりぎり浮くだけで上昇・姿勢制御の余力が無い）

function epMaxSpeedMps() {
  const unit = State.model.maxSpeedUnit || 'kt';
  const val = State.model.maxSpeedValue || 0;
  return unit === 'mach' ? val * 340 : val * 0.514444;
}

// 前へ進むエンジン（垂直離陸用ではない）一覧
function epForwardEngines() {
  return State.parts.filter(p => p.type === 'engine' && p.props && p.props.spinAxis !== 'y');
}

// 前へ進むエンジンをグループ（1〜4）にまとめる。
// js/env/09-aircraft.js の buildEngineGroups と同じまとめ方——グループの最高速度は
// パーツごとに持っているので、同じグループに違う値が入っていたら大きいほうを採る。
// リフトエンジン（回転軸Y）はグループに入らない。
function epForwardGroups() {
  const map = new Map();
  for (const p of epForwardEngines()) {
    const id = Math.min(Math.max(Math.round((p.props.engineGroup) || 1), 1), 4);
    let g = map.get(id);
    if (!g) { g = { id, parts: [], vMaxMps: 0, explicit: false }; map.set(id, g); }
    g.parts.push(p);
    const v = epSpeedToMps(p.props.groupMaxSpeedValue || 0, p.props.groupMaxSpeedUnit || 'mach');
    if (v > 0) { g.vMaxMps = Math.max(g.vMaxMps, v); g.explicit = true; }
  }
  const groups = [...map.values()].sort((a, b) => a.id - b.id);
  for (const g of groups) {
    if (!g.explicit) g.vMaxMps = epMaxSpeedMps();
    g.totalKgf = g.parts.reduce((s, p) => s + Math.max(p.props.thrustKgf || 0, 0), 0);
  }
  return groups;
}

function epSpeedToMps(value, unit) {
  const v = Math.max(value || 0, 0);
  return unit === 'mach' ? v * 340 : v * 0.514444;
}

function epFormatSpeed(mps) {
  const kt = Math.round(mps * 1.94384);
  return mps >= 340 ? `マッハ${(mps / 340).toFixed(1)}（${kt.toLocaleString()} kt）` : `${kt.toLocaleString()} kt`;
}

// エンジンの推力の向き（機体座標、正規化済み）。09-aircraft.js のエンジン構築と同じ式:
// spinAxisの基準軸 → パーツ自身のrotation（度）→ qFix（主翼から読んだ前後補正）の順。
function epEngineAxis(part, fixQ) {
  const spin = (part.props && part.props.spinAxis) || 'z';
  const axis = spin === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1);
  const r = part.rotation || {};
  if (r.x || r.y || r.z) {
    axis.applyEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(r.x || 0),
      THREE.MathUtils.degToRad(r.y || 0),
      THREE.MathUtils.degToRad(r.z || 0)
    ));
  }
  return axis.applyQuaternion(fixQ).normalize();
}

// 主翼（無ければ全部の翼）の面積とアスペクト比。09-aircraft.js の wingArea /
// applyGroupAspect と同じ考え方（左右をつないだ翼幅で誘導抗力を測る）。
function epWingAeroStats() {
  const groupStats = (wings) => {
    let area = 0, maxReach = 0;
    for (const w of wings) {
      const m = cgPartMatrix(w);
      const c = (w.props && w.props.corners) || {};
      const P = {};
      for (const k of WING_CORNER_KEYS) {
        const v = c[k] || { x: 0, y: 0, z: 0 };
        P[k] = new THREE.Vector3(v.x || 0, v.y || 0, v.z || 0).applyMatrix4(m);
      }
      const a = cgQuadArea(P.rootLeading, P.tipLeading, P.tipTrailing, P.rootTrailing);
      if (!(a > 1e-9)) continue;
      const root = new THREE.Vector3().addVectors(P.rootLeading, P.rootTrailing).multiplyScalar(0.5);
      const tip = new THREE.Vector3().addVectors(P.tipLeading, P.tipTrailing).multiplyScalar(0.5);
      const center = new THREE.Vector3();
      for (const k of WING_CORNER_KEYS) center.add(P[k]);
      center.multiplyScalar(0.25);
      const span = root.distanceTo(tip);
      area += a;
      maxReach = Math.max(maxReach, Math.abs(center.x) + span * 0.5);
    }
    if (area <= 1e-9) return null;
    const span = Math.max(maxReach * 2, 1);
    return { area, aspect: Math.max((span * span) / area, 0.6) };
  };

  const wings = State.parts.filter(p => p.type === 'wing' && p.props && p.props.corners);
  const main = wings.filter(w => w.props.role === 'main');
  return groupStats(main.length ? main : wings);
}

// いまの機体で、ある速度を出すのに必要な前向き推力を計算する。
//   engines … 前向きエンジン（parts を絞りたければ subset で渡す）
//   currentN … いまそのエンジンが実際に出している（機首方向へ投影した）推力の合計
//   neededN  … その速度で釣り合う（＋余裕ぶん）ために必要な合計
//
// **速度に見合った高さで評価する**（epCruiseAltitudeFor）。海面の空気で
// 計算すると速い機体ほど桁で外れる——実機は速いほど高いところを飛ぶ。
function epSpeedThrustReport(vMaxMps, subset, groupVMaxMps, helperGroups) {
  // エンジンの向き判定なので「見た目の前」（modelTransform込み）基準で求める
  // （pbNoseDirectionのworldSpace引数を参照。前後逆さに作られたモデルを
  // modelTransformで直している機体で、そのままだと前向きエンジンが
  // 無いと誤判定してしまう）。
  const noseDir = pbNoseDirection(true);
  if (!noseDir) return null;
  const wing = epWingAeroStats();
  if (!wing) return null;

  const fixQ = pbFixQuaternion(noseDir);
  const parts = subset || epForwardEngines();
  const engines = parts.map(p => ({
    part: p,
    fwd: Math.max(-epEngineAxis(p, fixQ).z, 0),
  }));
  const currentN = engines.reduce((s, e) => s + (e.part.props.thrustKgf || 0) * 9.80665 * e.fwd, 0);

  const vMax = vMaxMps !== undefined ? vMaxMps : epMaxSpeedMps();
  const altM = epCruiseAltitudeFor(vMax);
  const rho = epAirDensityAt(altM);
  const W = Math.max(State.model.weightKg, 1) * 9.80665;
  const S = wing.area;
  const q = 0.5 * rho * vMax * vMax;
  const cl = Math.min(W / Math.max(q * S, 1e-6), EP_CLMAX);
  const fuselageFrontArea = Math.max(0.022 * S, 0.15);
  const cd = EP_AERO.cd0Wing + (cl * cl) / (Math.PI * wing.aspect * EP_AERO.oswald)
    + (fuselageFrontArea * EP_AERO.fuselageCd) / S;
  // 水平・垂直尾翼の有害抗力ぶんも足す（誘導抗力は主翼に比べて小さいので無視する）。
  // 09-aircraft.js は翼1枚ずつ抗力を積み上げるので、尾翼のぶんを丸ごと落とすと
  // 実際より軽く見積もってしまう。
  const tailArea = (wingsAeroCenterByRole('htail') || { area: 0 }).area
    + (wingsAeroCenterByRole('vtail') || { area: 0 }).area;
  const drag = q * S * cd + q * tailArea * EP_AERO.cd0Wing;
  // その速度で実際に要る推力（余裕ぶんを含む）
  const targetN = drag * EP_SPEED_THRUST_MARGIN;

  // **遅いグループもいっしょに押している**ぶんを差し引く（helperGroups）。
  // 速いグループを、そのグループ1つだけで速度を出せるように積むと、
  // 「最高速度は、いちばん強いエンジンだけで出している」ことになってしまう。
  // 遅いエンジンも（自分の最高速度を超えたぶん力を落としながら）一緒に押すので、
  // その持ち分を引いた残りだけを積めばいい。
  let helpN = 0;
  for (const hg of (helperGroups || [])) {
    for (const p of hg.parts) {
      const fwd = Math.max(-epEngineAxis(p, fixQ).z, 0);
      helpN += Math.max(p.props.thrustKgf || 0, 0) * 9.80665 * fwd
        * epThrustScale(p, altM, vMax, hg.vMaxMps);
    }
  }
  // 遅いグループだけで足りていても、このグループを0にはしない（止めたときに
  // 何も残らないグループができてしまう）。最低でも1割は自分で持つ。
  const remainN = Math.max(targetN - helpN, targetN * 0.1);

  // その速度・高度で、このエンジンたちが静止推力の何倍を出せるか（種別ごとに違う）。
  // 推力の大きいエンジンの効きを重く見る。
  const ownVMax = groupVMaxMps !== undefined ? groupVMaxMps : vMax;
  let wNum = 0, wDen = 0;
  for (const e of engines) {
    const w = Math.max(e.part.props.thrustKgf || 0, 0) * e.fwd;
    wNum += (w > 0 ? w : 1e-6) * epThrustScale(e.part, altM, vMax, ownVMax);
    wDen += (w > 0 ? w : 1e-6);
  }
  const scale = wDen > 0 ? Math.max(wNum / wDen, 0.01) : 0.25;
  const neededN = remainN / scale;

  return { engines, currentN, neededN, vMax, altM, drag, scale, targetN, helpN };
}

// 推力を、いまの比率（全部ゼロなら均等割り）を保ったまま
// 「機首方向への投影の合計が neededN になる」よう解いて書き戻す。
function epApplyThrustTo(rep) {
  const totalCurrentKgf = rep.engines.reduce((s, e) => s + Math.max(e.part.props.thrustKgf || 0, 0), 0);
  const ratios = rep.engines.map(e => totalCurrentKgf > 1e-6
    ? Math.max(e.part.props.thrustKgf || 0, 0) / totalCurrentKgf
    : (e.fwd > 0.05 ? 1 : 0));
  const denomCount = ratios.filter(r => r > 0).length || 1;
  const normRatios = totalCurrentKgf > 1e-6 ? ratios : ratios.map(r => r / denomCount);

  const weighted = rep.engines.reduce((s, e, i) => s + e.fwd * normRatios[i], 0);
  if (weighted <= 1e-6) return null;
  const scaleTotalN = rep.neededN / weighted;
  for (let i = 0; i < rep.engines.length; i++) {
    const thrustN = normRatios[i] * scaleTotalN;
    rep.engines[i].part.props.thrustKgf = Math.max(Math.round(thrustN / 9.80665), 0);
  }
  return { beforeKgf: totalCurrentKgf,
    afterKgf: rep.engines.reduce((s, e) => s + (e.part.props.thrustKgf || 0), 0) };
}

// 「このグループの最高速度に必要な出力へ自動設定」
//
// **いちばん遅いグループは、そのグループだけでその速度を出せるように**積む。
// それより速いグループは、**遅いグループも一緒に押しているぶんを引いた残り**だけ
// 積む——速いグループ1つだけで出せるように積むと、「最高速度は、いちばん強い
// エンジンだけが出している」ことになってしまい、ほかのエンジンが飾りになる。
// 遅いエンジンも（自分の最高速度を超えたぶん力を落としながら）最後まで一緒に押す。
function applyEngineSpeedTargetForGroup(groupId, quiet) {
  const groups = epForwardGroups();
  const g = groups.find(x => x.id === groupId);
  if (!g) { showToast(`グループ${groupId}の前向きエンジンがありません`, true); return false; }
  // 自分より遅いグループが手伝ってくれる
  const helpers = groups.filter(x => x.id !== g.id && x.vMaxMps < g.vMaxMps);
  const rep = epSpeedThrustReport(g.vMaxMps, g.parts, g.vMaxMps, helpers);
  if (!rep) { showToast('主翼が必要です', true); return false; }
  const done = epApplyThrustTo(rep);
  if (!done) {
    showToast('エンジンが前向き（回転軸Z）を向いていません。回転軸か取付角を確かめてください', true);
    return false;
  }

  renderPartList();
  renderInspector();
  renderModelSettingsPanel();
  if (quiet) return true;
  const helpPct = rep.targetN > 0 ? Math.round(100 * Math.min(rep.helpN / rep.targetN, 1)) : 0;
  showToast(`グループ${groupId}（${g.parts.length}基）の推力を `
    + `${Math.round(done.beforeKgf).toLocaleString()} → ${Math.round(done.afterKgf).toLocaleString()} kgf にしました`
    + `（${epFormatSpeed(rep.vMax)}／高度${Math.round(rep.altM / 100) / 10}km`
    + (helpers.length ? `。遅いグループが${helpPct}%を受け持つぶんを差し引いた残り）` : '）'));
  return true;
}

// 「最高速度に必要な出力へ自動設定」——前向きエンジンのグループを全部まとめて解く。
// **遅いほうから順に**解く。速いグループは遅いグループの持ち分を引いた残りだけ
// 積むので、遅いほうが決まっていないと引き算ができない。
function applyEngineSpeedTarget() {
  const groups = epForwardGroups().slice().sort((a, b) => a.vMaxMps - b.vMaxMps);
  if (!groups.length) { showToast('前へ進むエンジン（回転軸Y以外）がありません', true); return false; }
  const many = groups.length > 1;
  const done = [];
  for (const g of groups) if (applyEngineSpeedTargetForGroup(g.id, many)) done.push(g);
  if (many && done.length) {
    showToast(`${done.length}つのグループを、遅いほうから順に設定しました`
      + `（${done.map((g) => `グループ${g.id}: ${epFormatSpeed(g.vMaxMps)}`).join(' / ')}）`);
  }
  return done.length > 0;
}

// 「垂直離陸に必要な出力へ自動設定」
// 05d-vtol-balance.js の vtolBalanceReport を使い、前後バランスで絞られた後の
// 「実際に使える」割合（usableRatio）ぶん多めに出力を積んでおく。
function applyVtolSpeedTarget() {
  if (typeof vtolBalanceReport !== 'function') return false;
  const rep = vtolBalanceReport();
  if (!rep) { showToast('上向き（回転軸Y）のエンジンがありません', true); return false; }

  const usable = Math.max(rep.usableRatio, 0.05);
  const targetTotalKgf = (Math.max(State.model.weightKg, 1) * EP_VTOL_TWR_TARGET) / usable;
  const currentTotalKgf = rep.total;

  if (currentTotalKgf > 1e-6) {
    const scale = targetTotalKgf / currentTotalKgf;
    for (const e of rep.engines) e.props.thrustKgf = Math.max(Math.round(e.props.thrustKgf * scale), 0);
  } else {
    const each = targetTotalKgf / rep.engines.length;
    for (const e of rep.engines) e.props.thrustKgf = Math.max(Math.round(each), 0);
  }

  renderPartList();
  renderInspector();
  renderModelSettingsPanel();
  showToast(`垂直推力を合計 ${Math.round(currentTotalKgf).toLocaleString()} kgf → `
    + `${Math.round(targetTotalKgf).toLocaleString()} kgf に設定しました`
    + `（目標: 使える推力で重量の${Math.round(EP_VTOL_TWR_TARGET * 100)}%）`);
  return true;
}

// 通常／垂直エンジンをまとめて倍率で増減する。
function epScaleEngines(isVtol, factor) {
  if (!(factor > 0)) { showToast('倍率は0より大きい数で指定してください', true); return false; }
  const engines = State.parts.filter(p => p.type === 'engine' && p.props
    && (isVtol ? p.props.spinAxis === 'y' : p.props.spinAxis !== 'y'));
  if (!engines.length) {
    showToast(isVtol ? '上向き（回転軸Y）のエンジンがありません' : '前へ進むエンジンがありません', true);
    return false;
  }
  for (const e of engines) e.props.thrustKgf = Math.max(Math.round((e.props.thrustKgf || 0) * factor), 0);

  renderPartList();
  renderInspector();
  renderModelSettingsPanel();
  showToast(`${isVtol ? '垂直' : '通常'}エンジン ${engines.length} 基の出力を ×${factor} 倍にしました`);
  return true;
}

// 機体設定パネルに出す、エンジン出力のまとめと操作ボタン
function engineFleetPanelHtml() {
  const forward = epForwardEngines();
  const vtol = State.parts.filter(p => p.type === 'engine' && p.props && p.props.spinAxis === 'y');
  if (!forward.length && !vtol.length) return '';

  const fwdTotal = forward.reduce((s, p) => s + Math.max(p.props.thrustKgf || 0, 0), 0);
  const vtolTotal = vtol.reduce((s, p) => s + Math.max(p.props.thrustKgf || 0, 0), 0);
  const W = Math.max(State.model.weightKg, 1);

  const groups = epForwardGroups();

  return `
    <div class="subgroup-title">エンジン出力</div>
    <div class="hint" style="line-height:1.7;">
      ${forward.length ? `通常エンジン ${forward.length} 基・合計 ${fwdTotal.toLocaleString()} kgf（推力重量比 ${(fwdTotal / W).toFixed(2)}）<br>` : ''}
      ${vtol.length ? `垂直エンジン ${vtol.length} 基・合計 ${vtolTotal.toLocaleString()} kgf（推力重量比 ${(vtolTotal / W).toFixed(2)}）` : ''}
    </div>
    ${forward.length ? `
    ${groups.map((g) => `
    <button class="btn-danger-outline" data-eng-group="${g.id}" style="color:var(--accent);border-color:var(--accent-dim);margin-top:6px;">
      グループ${g.id}を ${epFormatSpeed(g.vMaxMps)} 相応の出力へ
    </button>
    <div class="hint" style="margin-top:4px;">
      ${g.parts.length}基・合計 ${g.totalKgf.toLocaleString()} kgf
      ${g.explicit ? '' : '（このグループは最高速度を設定していないので、機体全体の最高速度を使います）'}
      ／ 巡航高度の見込み ${Math.round(epCruiseAltitudeFor(g.vMaxMps) / 100) / 10} km
    </div>
    `).join('')}
    ${groups.length > 1 ? `
    <button class="btn-danger-outline" id="btnEngineSpeedTarget" style="color:var(--accent);border-color:var(--accent-dim);margin-top:6px;">
      すべてのグループをまとめて自動設定
    </button>
    <div class="hint" style="margin-top:4px;">それぞれのグループが<b>そのグループだけで</b>設定の速度を出せるように解きます（ロケットだけでマッハ21、ほかのエンジンだけならマッハ5、という作り分けができます）。</div>
    ` : `
    <div class="hint" style="margin-top:4px;">いまのエンジン配分（比率）を保ったまま、合計出力だけを解き直します。速度に見合った高さ（速いほど高い）の空気で見積もります。</div>
    `}
    <div class="field" style="margin-top:8px;">
      <label>通常エンジンの出力を一括で倍率調整</label>
      <div style="display:flex;gap:6px;">
        <input type="text" inputmode="decimal" id="fEngineScaleFwd" placeholder="例: 1.5" style="flex:1;">
        <button class="btn-danger-outline" id="btnEngineScaleFwd" style="flex:0 0 auto;color:var(--accent);border-color:var(--accent-dim);">適用</button>
      </div>
    </div>
    ` : ''}
    ${vtol.length ? `
    <button class="btn-danger-outline" id="btnVtolSpeedTarget" style="color:var(--accent);border-color:var(--accent-dim);margin-top:10px;">
      垂直離陸に必要な出力へ自動設定
    </button>
    <div class="hint" style="margin-top:4px;">前後バランスで絞られたぶんを見込んで、重量の${Math.round(EP_VTOL_TWR_TARGET * 100)}%を実際に使えるよう合計出力を解き直します。</div>
    <div class="field" style="margin-top:8px;">
      <label>垂直エンジンの出力を一括で倍率調整</label>
      <div style="display:flex;gap:6px;">
        <input type="text" inputmode="decimal" id="fEngineScaleVtol" placeholder="例: 1.5" style="flex:1;">
        <button class="btn-danger-outline" id="btnEngineScaleVtol" style="flex:0 0 auto;color:var(--accent);border-color:var(--accent-dim);">適用</button>
      </div>
    </div>
    ` : ''}
  `;
}

function bindEngineFleetPanel() {
  const btnSpeed = document.getElementById('btnEngineSpeedTarget');
  if (btnSpeed) btnSpeed.addEventListener('click', () => applyEngineSpeedTarget());
  for (const btn of document.querySelectorAll('[data-eng-group]')) {
    const id = parseInt(btn.getAttribute('data-eng-group'), 10);
    btn.addEventListener('click', () => applyEngineSpeedTargetForGroup(id));
  }
  const btnVtol = document.getElementById('btnVtolSpeedTarget');
  if (btnVtol) btnVtol.addEventListener('click', () => applyVtolSpeedTarget());

  const btnScaleFwd = document.getElementById('btnEngineScaleFwd');
  if (btnScaleFwd) btnScaleFwd.addEventListener('click', () => {
    const v = parseFloat(document.getElementById('fEngineScaleFwd').value);
    if (!isNaN(v)) epScaleEngines(false, v);
  });
  const btnScaleVtol = document.getElementById('btnEngineScaleVtol');
  if (btnScaleVtol) btnScaleVtol.addEventListener('click', () => {
    const v = parseFloat(document.getElementById('fEngineScaleVtol').value);
    if (!isNaN(v)) epScaleEngines(true, v);
  });
}
