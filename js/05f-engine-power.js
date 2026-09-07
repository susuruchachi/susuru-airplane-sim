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
  propDecay: 0.75, // 最高速度での静止推力に対する低下率（analyzeAircraftPerformanceのpropFactorと同じ）
};
const EP_CLMAX = 1.5;               // 09-aircraft.js の AC_CLMAX と同じ
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

// いまの機体で、設定した最高速度を出すのに必要な前向き推力を計算する。
//   currentN … いま前向きエンジンが実際に出している（機首方向へ投影した）推力の合計
//   neededN  … 最高速度で釣り合う（＋余裕ぶん）ために必要な合計
function epSpeedThrustReport() {
  const noseDir = pbNoseDirection();
  if (!noseDir) return null;
  const wing = epWingAeroStats();
  if (!wing) return null;

  const fixQ = pbFixQuaternion(noseDir);
  const engines = epForwardEngines().map(p => ({
    part: p,
    fwd: Math.max(-epEngineAxis(p, fixQ).z, 0),
  }));
  const currentN = engines.reduce((s, e) => s + (e.part.props.thrustKgf || 0) * 9.80665 * e.fwd, 0);

  const vMax = epMaxSpeedMps();
  const W = Math.max(State.model.weightKg, 1) * 9.80665;
  const S = wing.area;
  const rho = 1.225;
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
  // ちょうどvMaxで評価しているので speedRatio は常に1（analyzeAircraftPerformanceのpropFactorと同じ式）
  const propFactor = Math.max(1 - EP_AERO.propDecay, 0.05);
  const neededN = (drag / propFactor) * EP_SPEED_THRUST_MARGIN;

  return { engines, currentN, neededN, vMax, drag };
}

// 「最高速度に必要な出力へ自動設定」
// 各エンジンのいまの比率（全部ゼロなら均等割り）を保ったまま、機首方向への
// 投影の合計が neededN に一致するよう、全体の大きさだけを解く。
function applyEngineSpeedTarget() {
  const rep = epSpeedThrustReport();
  if (!rep) { showToast('主翼が必要です', true); return false; }
  if (!rep.engines.length) { showToast('前へ進むエンジン（回転軸Y以外）がありません', true); return false; }

  const totalCurrentKgf = rep.engines.reduce((s, e) => s + Math.max(e.part.props.thrustKgf || 0, 0), 0);
  const ratios = rep.engines.map(e => totalCurrentKgf > 1e-6
    ? Math.max(e.part.props.thrustKgf || 0, 0) / totalCurrentKgf
    : (e.fwd > 0.05 ? 1 : 0));
  const denomCount = ratios.filter(r => r > 0).length || 1;
  const normRatios = totalCurrentKgf > 1e-6 ? ratios : ratios.map(r => r / denomCount);

  const weighted = rep.engines.reduce((s, e, i) => s + e.fwd * normRatios[i], 0);
  if (weighted <= 1e-6) {
    showToast('エンジンが前向き（回転軸Z）を向いていません。回転軸か取付角を確かめてください', true);
    return false;
  }
  const scaleTotalN = rep.neededN / weighted;

  for (let i = 0; i < rep.engines.length; i++) {
    const thrustN = normRatios[i] * scaleTotalN;
    rep.engines[i].part.props.thrustKgf = Math.max(Math.round(thrustN / 9.80665), 0);
  }

  renderPartList();
  renderInspector();
  renderModelSettingsPanel();
  const kt = Math.round(rep.vMax * 1.94384);
  showToast(`前向き推力を合計 ${Math.round(totalCurrentKgf).toLocaleString()} kgf → `
    + `${Math.round(rep.neededN / 9.80665).toLocaleString()} kgf に設定しました`
    + `（目標: ${kt} kt で巡航できる余裕ぶんを含む）`);
  return true;
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

  return `
    <div class="subgroup-title">エンジン出力</div>
    <div class="hint" style="line-height:1.7;">
      ${forward.length ? `通常エンジン ${forward.length} 基・合計 ${fwdTotal.toLocaleString()} kgf（推力重量比 ${(fwdTotal / W).toFixed(2)}）<br>` : ''}
      ${vtol.length ? `垂直エンジン ${vtol.length} 基・合計 ${vtolTotal.toLocaleString()} kgf（推力重量比 ${(vtolTotal / W).toFixed(2)}）` : ''}
    </div>
    ${forward.length ? `
    <button class="btn-danger-outline" id="btnEngineSpeedTarget" style="color:var(--accent);border-color:var(--accent-dim);margin-top:6px;">
      最高速度に必要な出力へ自動設定
    </button>
    <div class="hint" style="margin-top:4px;">上で設定した最高速度まで出せるよう、いまのエンジン配分（比率）を保ったまま合計出力を解き直します。</div>
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
