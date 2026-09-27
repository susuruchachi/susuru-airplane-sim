// 05d-vtol-balance.js — 垂直離着陸用エンジンの釣り合いを、置きながら見られるようにする
//
// 上向きのエンジン（spinAxis = 'y'）を何基か置いて垂直に浮かせる機体では、
// **推力の中心が重心を通っていないと、浮かせた瞬間に機首が振れる**。
// 左右はミラー複製で揃うが、前後まで重心にきっちり合わせるのは手作業だとまず無理で、
// 実際「複数エンジンのVTOLだとバランスが取れない」という声があった。
//
// 飛行側（09-aircraft.js の applyVtolTrim）は、置かれたまま飛ばせるように
// 強いほうの出力を絞って釣り合わせる。ただし絞ったぶんは使えない推力になる。
// ここでは Builder の段階で、
//   ・いま推力の中心が重心からどれだけずれているかを見せる
//   ・各エンジンの推力を解いて、位置はそのままで釣り合わせる
// の2つをやる。推力側で釣り合わせておけば、絞られるぶんが無くなって全部使える。

// 上を向いた（＝垂直離着陸に使う）エンジンだけを集める
function vtolLiftEngines() {
  return State.parts.filter((p) => p.type === 'engine'
    && p.props && p.props.spinAxis === 'y' && (p.props.thrustKgf || 0) > 0);
}

// 機首がZのどちら向きかを主翼の翼弦から読む（+1なら+Zが機首）。
// 飛行モデル（acOrientationFix）と同じ読み方をしないと、前後の言い方が逆になる。
function vtolNoseSignZ() {
  const wings = State.parts.filter((p) => p.type === 'wing' && p.props && p.props.role === 'main');
  let chordZ = 0;
  for (const w of wings) {
    const c = (w.props && w.props.corners) || {};
    const mz = (a, b) => (((a && a.z) || 0) + ((b && b.z) || 0)) / 2;
    const leading = mz(c.rootLeading, c.tipLeading);
    const trailing = mz(c.rootTrailing, c.tipTrailing);
    chordZ += trailing - leading; // 前縁→後縁（＝後ろ向き）
  }
  return chordZ > 0 ? -1 : 1;
}

// いまの釣り合いを見る。
//   offsetZ / offsetX … 推力の中心が重心からどれだけずれているか（m）
//   aheadM            … そのずれを「機首側へ何m」に直したもの（+なら機首寄り）
//   usableRatio       … 飛行側が絞らずに使える推力の割合（applyVtolTrim と同じ計算）
function vtolBalanceReport() {
  const engines = vtolLiftEngines();
  if (!engines.length) return null;

  const cg = State.cg.position;
  const total = engines.reduce((s, e) => s + e.props.thrustKgf, 0);
  const armZ = (e) => e.position.z - cg.z;
  const armX = (e) => e.position.x - cg.x;
  const offsetZ = engines.reduce((s, e) => s + e.props.thrustKgf * armZ(e), 0) / total;
  const offsetX = engines.reduce((s, e) => s + e.props.thrustKgf * armX(e), 0) / total;

  // 飛行側は前後2群に分け、モーメントの小さいほうに合わせて強いほうを絞る
  const front = engines.filter((e) => armZ(e) < -1e-6);
  const rear = engines.filter((e) => armZ(e) > 1e-6);
  let usableRatio = 1;
  if (front.length && rear.length) {
    const sumT = (a) => a.reduce((s, e) => s + e.props.thrustKgf, 0);
    const sumM = (a) => a.reduce((s, e) => s + e.props.thrustKgf * armZ(e), 0);
    const mF = Math.abs(sumM(front)), mR = sumM(rear);
    const kF = mF <= mR ? 1 : mR / mF;
    const kR = mF <= mR ? mF / mR : 1;
    usableRatio = (sumT(front) * kF + sumT(rear) * kR) / total;
  }

  const weightKg = Math.max(State.model.weightKg || 0, 1);
  return {
    engines, total, offsetZ, offsetX,
    aheadM: -offsetZ * vtolNoseSignZ(),
    weightRatio: total / weightKg,
    usableRatio,
    // 前後どちらかにしかエンジンが無ければ、推力をどういじっても釣り合わない
    canBalance: !!(front.length && rear.length) || Math.abs(offsetZ) < 0.02,
  };
}

// 3元1次連立方程式を解く（掃き出し法）。解けなければ null。
function vtolSolve3(a, b) {
  const m = [a[0].concat(b[0]), a[1].concat(b[1]), a[2].concat(b[2])];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r;
    if (Math.abs(m[piv][i]) < 1e-9) return null;
    const t = m[i]; m[i] = m[piv]; m[piv] = t;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// 位置はそのままで、各エンジンの推力を解いて釣り合わせる。
//
// 決めたいのは「いまの推力からの倍率 s_i」。守りたいのは3つ：
//   前後のモーメント = 0 / 左右のモーメント = 0 / 合計推力は今のまま
// 倍率の動かしかたは無数にあるので、**今の値からの変化がいちばん小さい**ものを選ぶ
// （ユーザーが決めた配分をなるべく残したいので）。
// これは Σ(s_i-1)² を最小化する等式制約つき最小二乗で、u = Aᵀ(AAᵀ)⁻¹b で閉じた形で解ける。
function balanceVtolThrust() {
  const rep = vtolBalanceReport();
  if (!rep) { showToast('上向き（回転軸Y）のエンジンがありません', true); return false; }
  const { engines } = rep;
  if (engines.length < 2) { showToast('垂直用のエンジンが1基だけでは釣り合わせられません', true); return false; }

  const cg = State.cg.position;
  const T = engines.map((e) => e.props.thrustKgf);
  const az = engines.map((e) => e.position.z - cg.z);
  const ax = engines.map((e) => e.position.x - cg.x);
  const total = T.reduce((s, v) => s + v, 0);

  // A（3×N）… 各行が守りたい量。b … いまの値からの差
  const rows = [
    T.map((t, i) => t * az[i]),
    T.map((t, i) => t * ax[i]),
    T.slice(),
  ];
  const cur = rows.map((r) => r.reduce((s, v) => s + v, 0));
  const b = [-cur[0], -cur[1], total - cur[2]];

  // AAᵀ（3×3）
  const g = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
    rows[i].reduce((s, _, k) => s + rows[i][k] * rows[j][k], 0)));
  const lam = vtolSolve3(g, b.map((v) => [v]));
  if (!lam) {
    showToast('この配置では推力だけで釣り合わせられません。前後どちらかへエンジンを足してください', true);
    return false;
  }

  const scale = T.map((_, k) => 1 + lam[0] * rows[0][k] + lam[1] * rows[1][k] + lam[2] * rows[2][k]);
  if (scale.some((s) => !(s > 0.02))) {
    showToast('この配置では推力だけで釣り合わせられません（どれかがゼロ以下になります）。'
      + 'エンジンを重心の反対側にも置いてください', true);
    return false;
  }

  for (let i = 0; i < engines.length; i++) {
    engines[i].props.thrustKgf = Math.round(T[i] * scale[i]);
  }
  renderInspector();
  const after = vtolBalanceReport();
  showToast(`垂直エンジンの推力を釣り合わせました（前後のずれ ${rep.aheadM.toFixed(2)}m → `
    + `${after.aheadM.toFixed(2)}m、使える推力 ${Math.round(rep.usableRatio * 100)}% → `
    + `${Math.round(after.usableRatio * 100)}%）`);
  return true;
}

// 選択中のエンジンのインスペクターに出す、釣り合いの様子
function vtolBalancePanelHtml() {
  const rep = vtolBalanceReport();
  if (!rep) return '';
  const n = rep.engines.length;
  const ahead = rep.aheadM;
  const dir = Math.abs(ahead) < 0.02 ? '' : (ahead > 0 ? '機首側へ' : '尾側へ');
  const okZ = Math.abs(ahead) < 0.05;
  const okX = Math.abs(rep.offsetX) < 0.05;
  const warn = (t) => `<span style="color:var(--warn);">${t}</span>`;
  const good = (t) => `<span style="color:var(--ok);">${t}</span>`;
  return `
    <div class="divider"></div>
    <div class="subgroup-title">垂直離着陸の釣り合い（上向きエンジン ${n} 基）</div>
    <div class="hint" style="line-height:1.7;">
      合計推力 <b>${rep.total.toLocaleString()}</b> kgf（重量の ${rep.weightRatio.toFixed(2)} 倍）<br>
      前後のずれ ${okZ ? good('重心の真上') : warn(dir + Math.abs(ahead).toFixed(2) + ' m')}<br>
      左右のずれ ${okX ? good('中心線の上') : warn(Math.abs(rep.offsetX).toFixed(2) + ' m')}<br>
      使える推力 ${rep.usableRatio > 0.98 ? good('100%') : warn(Math.round(rep.usableRatio * 100) + '%（ずれたぶん飛行中に絞られます）')}
    </div>
    <button class="btn-danger-outline" id="btnVtolBalance"
      style="color:var(--accent);border-color:var(--accent-dim);margin-top:6px;">
      推力を釣り合わせる
    </button>
    <div class="hint" style="margin-top:6px;">位置はそのままで、各エンジンの推力を解き直して重心の真上に揃えます。合計推力は変わりません。</div>
  `;
}
