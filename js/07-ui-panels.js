// 07-ui-panels.js — 左：パーツ一覧 / 右：インスペクター（種別ごとのプロパティフォーム）

// 機体全体の設定：向き（root.rotation）・大きさ（root.scale）・重量・最高速度
// root.rotation/scaleがそのまま真の値（このUIはそれを度数などの読みやすい形で読み書きするだけ）
function renderModelSettingsPanel() {
  const container = document.getElementById('modelSettings');
  if (!State.model.root) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'block';

  const root = State.model.root;
  const rotDeg = {
    x: THREE.MathUtils.radToDeg(root.rotation.x),
    y: THREE.MathUtils.radToDeg(root.rotation.y),
    z: THREE.MathUtils.radToDeg(root.rotation.z),
  };
  const scl = root.scale;
  const boneCandidates = typeof listBoneAxisCandidates === 'function' ? listBoneAxisCandidates(root) : [];

  container.innerHTML = `
    <div class="subgroup-title">原点の調整</div>
    <div class="field">
      <label>左右（翼幅）方向の軸</label>
      <select id="fLateralAxis">
        <option value="x">X軸</option>
        <option value="y">Y軸</option>
        <option value="z">Z軸</option>
      </select>
    </div>
    <button class="btn-danger-outline" id="btnCenterModelOnAxis" style="color:var(--accent);border-color:var(--accent-dim);margin-top:0;">
      原点をこの軸の中心に揃える
    </button>
    <div class="hint">選んだ軸方向の中心が原点に来るよう、機体本体だけを移動します。モデルの向きが90度ずれている場合は、実際に翼が伸びている軸を選んでください。</div>
    <div class="hint" id="modelSizeReadout" style="font-family:var(--mono);"></div>

    <div class="subgroup-title">機体の向き（度）</div>
    <div class="row3">
      ${xyzFieldsHtml('modelRot', rotDeg)}
    </div>
    <div class="hint" style="margin-top:4px;">エンジンなど配置済みのパーツは、機体の向きの変更に自動で追従します。</div>

    <div class="subgroup-title">機体の大きさ（倍率）</div>
    <div class="row3">
      ${xyzFieldsHtml('modelScl', { x: scl.x, y: scl.y, z: scl.z })}
    </div>
    <div class="toggle-row" style="margin-top:2px;">
      <label>XYZ均等に拡縮</label>
      <label class="switch">
        <input type="checkbox" id="fUniformScale" checked>
        <span class="slider-toggle"></span>
      </label>
    </div>

    <div class="subgroup-title">重量・性能</div>
    <div class="field">
      <label>総重量（kg）</label>
      <input type="text" inputmode="decimal" id="fWeightKg" value="${State.model.weightKg}">
    </div>
    <div class="field">
      <label>最高速度</label>
      <div style="display:flex;gap:6px;">
        <input type="text" inputmode="decimal" id="fMaxSpeedValue" value="${State.model.maxSpeedValue}" style="flex:1;">
        <select id="fMaxSpeedUnit" style="flex:0 0 auto;width:90px;">
          <option value="kt" ${State.model.maxSpeedUnit === 'kt' ? 'selected' : ''}>ノット</option>
          <option value="mach" ${State.model.maxSpeedUnit === 'mach' ? 'selected' : ''}>マッハ</option>
        </select>
      </div>
    </div>
    <div class="hint" id="maxSpeedConverted"></div>

    ${boneAxisSectionHtml(boneCandidates)}

    ${typeof engineFleetPanelHtml === 'function' ? engineFleetPanelHtml() : ''}
  `;

  // 軸選択の初期値を推定値にし、各軸の実寸も表示して判断材料にする
  const lateralSelect = document.getElementById('fLateralAxis');
  const guessedAxis = guessLateralAxis();
  lateralSelect.value = guessedAxis;
  const meshBox = computeModelMeshBoundingBox();
  if (meshBox) {
    const s = meshBox.getSize(new THREE.Vector3());
    document.getElementById('modelSizeReadout').textContent =
      `寸法 X ${s.x.toFixed(1)} / Y ${s.y.toFixed(1)} / Z ${s.z.toFixed(1)}（推定: 左右は${guessedAxis.toUpperCase()}軸）`;
  }

  container.querySelectorAll('.fBoneAxis').forEach((sel) => {
    const name = sel.dataset.bone;
    sel.value = State.model.boneAxisOverrides[name] || '';
    sel.addEventListener('change', () => {
      if (sel.value) State.model.boneAxisOverrides[name] = sel.value;
      else delete State.model.boneAxisOverrides[name];
    });
  });

  document.getElementById('btnCenterModelOnAxis').addEventListener('click', () => {
    // パーツは動かさないため、既に配置済みの場合は相対位置がずれる旨を確認する
    if (State.parts.length > 0) {
      const ok = confirm(
        '機体本体だけを移動します。配置済みのパーツ（エンジン・翼など）はその場に残るため、機体との相対位置がずれます。\n\n続けますか？'
      );
      if (!ok) return;
    }
    const axis = document.getElementById('fLateralAxis').value;
    const result = centerModelOnAxis(axis);
    if (!result) {
      showToast('機体の位置を計算できませんでした', true);
      return;
    }
    if (Math.abs(result.shift) < 0.0005) {
      showToast(`すでに原点が${axis.toUpperCase()}軸の中心にあります`);
      return;
    }
    renderModelSettingsPanel(); // 寸法表示を更新
    showToast(`機体を ${axis.toUpperCase()}方向に ${result.shift.toFixed(3)} 移動し、原点を中心に揃えました`);
  });

  bindXyzFields('modelRot', rotDeg, () => {
    root.rotation.set(
      THREE.MathUtils.degToRad(rotDeg.x),
      THREE.MathUtils.degToRad(rotDeg.y),
      THREE.MathUtils.degToRad(rotDeg.z)
    );
  });

  const uniformCheckbox = document.getElementById('fUniformScale');
  ['x', 'y', 'z'].forEach(axis => {
    const input = document.getElementById(`f_modelScl_${axis}`);
    input.addEventListener('change', () => {
      let v = parseFloat(input.value);
      if (isNaN(v) || v <= 0) v = 0.01;
      if (uniformCheckbox.checked) {
        root.scale.set(v, v, v);
        ['x', 'y', 'z'].forEach(a => {
          document.getElementById(`f_modelScl_${a}`).value = v.toFixed(3);
        });
      } else {
        root.scale[axis] = v;
      }
    });
  });

  document.getElementById('fWeightKg').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    State.model.weightKg = isNaN(v) ? State.model.weightKg : Math.max(v, 0);
    e.target.value = State.model.weightKg;
  });

  const speedValueInput = document.getElementById('fMaxSpeedValue');
  const speedUnitSelect = document.getElementById('fMaxSpeedUnit');
  const updateSpeedReadout = () => {
    document.getElementById('maxSpeedConverted').textContent = formatConvertedSpeed(State.model.maxSpeedValue, State.model.maxSpeedUnit);
  };
  speedValueInput.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    State.model.maxSpeedValue = isNaN(v) ? State.model.maxSpeedValue : Math.max(v, 0);
    e.target.value = State.model.maxSpeedValue;
    updateSpeedReadout();
  });
  speedUnitSelect.addEventListener('change', (e) => {
    State.model.maxSpeedUnit = e.target.value;
    updateSpeedReadout();
  });
  updateSpeedReadout();

  if (typeof bindEngineFleetPanel === 'function') bindEngineFleetPanel();
}

// GLBのボーンで動く舵（09c-aircraft-bones.js が検出した候補）の、回転軸の手動指定欄。
// 候補が無い機体（ボーンの無いモデル・内蔵機）では何も出さない
const BONE_ROLE_LABELS = { flap: 'フラップ', spoiler: 'スポイラー／エアブレーキ', attitude: '姿勢の舵（ピッチ/ロール/ヨー）' };
const BONE_AXIS_LABELS = { x: 'X軸', y: 'Y軸', z: 'Z軸' };
function boneAxisSectionHtml(candidates) {
  if (!candidates || !candidates.length) return '';
  const rows = candidates.map((c) => `
    <div class="field">
      <label>${escapeHtml(c.name)}<span style="color:var(--text-dim);"> ・ ${BONE_ROLE_LABELS[c.role] || c.role}</span></label>
      <select class="fBoneAxis" data-bone="${escapeHtml(c.name)}">
        <option value="">自動判定${c.autoAxis ? `（いまは${BONE_AXIS_LABELS[c.autoAxis]}）` : '（決められず）'}</option>
        <option value="x">X軸に固定</option>
        <option value="y">Y軸に固定</option>
        <option value="z">Z軸に固定</option>
      </select>
    </div>
  `).join('');
  return `
    <div class="subgroup-title">舵のボーン（回転軸の指定）</div>
    <div class="hint" style="margin-bottom:8px;">GLBに仕込まれたボーンで動く舵面の一覧です。ふだんは板の形と試し動作から回転軸を自動で決めますが、輪郭が歪む・変な向きに振れるなど自動判定が合わないときは、ここでボーンのローカルX/Y/Z軸を指定して固定できます。</div>
    ${rows}
  `;
}

// 入力された最高速度を、もう片方の単位に目安換算して表示する（音速は高度により変わるため海面高度の目安値を使用）
const SOUND_SPEED_KT_AT_SEA_LEVEL = 661.5; // 海面高度・標準大気での音速（ノット）の目安値
function formatConvertedSpeed(value, unit) {
  if (unit === 'kt') {
    const mach = value / SOUND_SPEED_KT_AT_SEA_LEVEL;
    return `約 マッハ${mach.toFixed(2)}（海面高度目安）`;
  } else {
    const kt = value * SOUND_SPEED_KT_AT_SEA_LEVEL;
    return `約 ${Math.round(kt).toLocaleString()} kt（海面高度目安）`;
  }
}

function renderPartList() {
  const listEl = document.getElementById('partList');
  listEl.innerHTML = '';

  // 重心（CG）行 — モデル読込後は常時表示、削除不可
  if (State.model.root) {
    const cgRow = document.createElement('div');
    cgRow.className = 'part-row' + (State.cg.selected ? ' selected' : '');
    cgRow.style.borderBottom = '1px solid var(--line)';
    cgRow.style.marginBottom = '6px';
    cgRow.style.paddingBottom = '10px';
    cgRow.innerHTML = `
      <span class="dot" style="background:#ffd23f"></span>
      <span class="label">重心（原点）</span>
      <span class="type">CG</span>
    `;
    cgRow.addEventListener('click', () => { selectPart(null); selectCg(); });
    listEl.appendChild(cgRow);
  }

  if (State.parts.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty';
    emptyDiv.innerHTML = 'まだパーツがありません。<br>上のボタンでモデル上に配置してください。';
    listEl.appendChild(emptyDiv);
    return;
  }
  for (const part of State.parts) {
    const row = document.createElement('div');
    row.className = 'part-row' + (part.id === State.selectedPartId ? ' selected' : '');
    const typeLabel = part.type === 'wing'
      ? (WING_ROLES.find(r => r.value === part.props.role)?.label || PART_TYPE_LABELS.wing)
      : PART_TYPE_LABELS[part.type];
    row.innerHTML = `
      <span class="dot" style="background:${PART_TYPE_COLORS[part.type]}"></span>
      <span class="label">${escapeHtml(part.name)}</span>
      <span class="type">${typeLabel}</span>
      <span class="del" title="削除">✕</span>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) return;
      selectPart(part.id);
    });
    row.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      removePart(part.id);
    });
    listEl.appendChild(row);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderCgInspector(el) {
  const mainWings = State.parts.filter(p => p.type === 'wing' && p.props.role === 'main');
  const hasLeftRight = mainWings.some(w => w.props.side === 'left') && mainWings.some(w => w.props.side === 'right');
  const hasRotor = typeof cgRotorEngines === 'function' && cgRotorEngines().length > 0;

  el.innerHTML = `
    <div class="section-title">プロパティ — 重心（原点）</div>
    <div class="hint" style="margin-bottom:14px;">機体の重心位置です。飛行モデルの基準点として使われます。ギズモは移動のみ操作できます。</div>

    <div class="subgroup-title">位置（m）</div>
    <div class="row3">
      ${xyzFieldsHtml('cg', State.cg.position)}
    </div>

    <div class="divider"></div>
    <div class="subgroup-title">主翼から決定</div>
    <div class="hint" style="margin-bottom:8px;">主翼の空力中心（前縁から1/4翼弦）へ重心を合わせます。X＝左右主翼の中心線、Z＝前後、Y＝主翼の面の高さ。前後がずれていると飛ばしたときに勝手に機首が上がり下がりします。</div>
    <button class="btn-danger-outline" id="btnCgFromWings" style="color:var(--accent);border-color:var(--accent-dim);">
      主翼から決定
    </button>
    ${!hasLeftRight ? '<div class="hint" style="color:var(--warn);margin-top:8px;">左翼・右翼それぞれ1つ以上必要です</div>' : ''}
    ${hasRotor ? `
    <div class="divider"></div>
    <div class="subgroup-title">ローターから決定（ヘリ）</div>
    <div class="hint" style="margin-bottom:8px;">ヘリは主翼を持たないので、重心をローターの回転軸の真下へ合わせます。X・Z＝ローターの真下、Y＝ローターより下（上にあればローターの直径の2割だけ下）。軸からずれていると、ローターの推力で機体が傾いて姿勢を保てません。</div>
    <button class="btn-danger-outline" id="btnCgFromRotors" style="color:var(--accent);border-color:var(--accent-dim);">
      ローターから決定
    </button>` : ''}
    ${typeof pbBalancePanelHtml === 'function' ? pbBalancePanelHtml() : ''}
  `;

  bindXyzFields('cg', State.cg.position, () => applyCgToGizmo());

  document.getElementById('btnCgFromWings').addEventListener('click', () => setCgFromWings());
  const btnRotor = document.getElementById('btnCgFromRotors');
  if (btnRotor) btnRotor.addEventListener('click', () => setCgFromRotors());
  const btnPb = document.getElementById('btnPitchBalance');
  if (btnPb) btnPb.addEventListener('click', () => balancePitchTrim());
}

function renderInspector() {
  const el = document.getElementById('inspector');

  if (State.cg.selected) {
    renderCgInspector(el);
    return;
  }

  const part = getSelectedPart();
  if (!part) {
    el.innerHTML = `
      <div class="section-title">プロパティ</div>
      <div class="empty">左のパーツ一覧、またはビューポート内のパーツをクリックして選択してください。</div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="section-title">プロパティ — ${PART_TYPE_LABELS[part.type]}</div>

    <div class="field">
      <label>名前</label>
      <input type="text" id="fName" value="${escapeHtml(part.name)}">
    </div>

    <div class="subgroup-title">位置（m）</div>
    <div class="row3">
      ${xyzFieldsHtml('pos', part.position)}
    </div>

    <div class="subgroup-title" style="margin-top:14px;">回転（度）</div>
    <div class="row3">
      ${xyzFieldsHtml('rot', part.rotation)}
    </div>

    <div class="subgroup-title" style="margin-top:14px;">スケール</div>
    <div class="row3">
      ${xyzFieldsHtml('scl', part.scale)}
    </div>

    <div class="divider"></div>
    <div id="typeSpecificFields"></div>

    ${PART_PROXY_TYPES.includes(part.type) ? `
    <div class="divider"></div>
    <div class="toggle-row">
      <label>飛行画面でも仮モデルを出す</label>
      <label class="switch">
        <input type="checkbox" id="fProxyInFlight" ${part.props.proxyInFlight ? 'checked' : ''}>
        <span class="slider-toggle"></span>
      </label>
    </div>
    <div class="hint">この画面に出ている仮の形（${part.type === 'landing_gear' ? '銀色の脚' : part.type === 'engine' ? 'エンジンの筒' : part.type === 'wing' ? '翼の板' : '舵面の板'}）を、飛行画面の機体にも出します。機体のモデルにこの部品が作り込まれていないときに使ってください。${part.type === 'landing_gear' ? '脚の上げ下げ（G）で格納・展開します。' : part.type === 'control_surface' ? '操縦に合わせて動きます。' : ''}見た目だけで、飛び方は変わりません。</div>
    ` : ''}

    <div class="divider"></div>
    <button class="btn-danger-outline" id="btnDeletePart">このパーツを削除</button>
  `;

  document.getElementById('fName').addEventListener('input', (e) => {
    part.name = e.target.value;
    renderPartList();
  });

  bindXyzFields('pos', part.position, () => applyPartToGizmo(part));
  bindXyzFields('rot', part.rotation, () => applyPartToGizmo(part));
  bindXyzFields('scl', part.scale, () => applyPartToGizmo(part));

  renderTypeSpecificFields(part);

  const proxyBox = document.getElementById('fProxyInFlight');
  if (proxyBox) proxyBox.addEventListener('change', (e) => { part.props.proxyInFlight = e.target.checked; });

  document.getElementById('btnDeletePart').addEventListener('click', () => removePart(part.id));
}

function xyzFieldsHtml(prefix, vec) {
  return ['x', 'y', 'z'].map(axis => `
    <div class="num-field">
      <span class="axis-label ${axis}">${axis.toUpperCase()}</span>
      <input type="number" step="0.05" id="f_${prefix}_${axis}" value="${vec[axis].toFixed(3)}">
    </div>
  `).join('');
}

function bindXyzFields(prefix, vec, onChange) {
  ['x', 'y', 'z'].forEach(axis => {
    const input = document.getElementById(`f_${prefix}_${axis}`);
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      vec[axis] = isNaN(v) ? 0 : v;
      onChange();
    });
  });
}

// ギズモドラッグ中に数値だけ即時反映（フォーム全体は再描画しない＝入力フォーカスを奪わない）
// isCg=true の場合、part引数は無視してState.cg.positionのcg_x/y/z欄を更新する
function updateInspectorNumbersOnly(part, isCg) {
  if (isCg) {
    ['x', 'y', 'z'].forEach(axis => {
      const input = document.getElementById(`f_cg_${axis}`);
      if (input && document.activeElement !== input) {
        input.value = State.cg.position[axis].toFixed(3);
      }
    });
    return;
  }
  if (State.selectedCornerKey && part.props.corners) {
    const c = part.props.corners[State.selectedCornerKey];
    ['x', 'y', 'z'].forEach(axis => {
      const input = document.getElementById(`f_corner_${axis}`);
      if (input && document.activeElement !== input) {
        input.value = c[axis].toFixed(3);
      }
    });
    return;
  }
  ['pos', 'rot', 'scl'].forEach(prefix => {
    const vec = prefix === 'pos' ? part.position : prefix === 'rot' ? part.rotation : part.scale;
    ['x', 'y', 'z'].forEach(axis => {
      const input = document.getElementById(`f_${prefix}_${axis}`);
      if (input && document.activeElement !== input) {
        input.value = vec[axis].toFixed(3);
      }
    });
  });
}

function renderTypeSpecificFields(part) {
  const container = document.getElementById('typeSpecificFields');
  if (part.type === 'engine') {
    container.innerHTML = `
      <div class="subgroup-title">エンジン設定</div>
      <div class="field">
        <label>最大推力（kgf）</label>
        <input type="text" inputmode="decimal" id="fThrust" value="${part.props.thrustKgf}">
      </div>
      <div class="field">
        <label>種別</label>
        <select id="fEngineKind">
          <option value="prop" ${(part.props.engineKind || 'prop') === 'prop' ? 'selected' : ''}>プロペラ</option>
          <option value="jet" ${part.props.engineKind === 'jet' ? 'selected' : ''}>ジェット</option>
          <option value="jet_ab" ${part.props.engineKind === 'jet_ab' ? 'selected' : ''}>ジェット（アフターバーナー付き）</option>
          <option value="rocket" ${part.props.engineKind === 'rocket' ? 'selected' : ''}>ロケット</option>
          <option value="rotor" ${part.props.engineKind === 'rotor' ? 'selected' : ''}>ヘリのローター</option>
        </select>
      </div>
      ${part.props.engineKind === 'rotor' ? `
      <div class="field">
        <label>ローターの直径（m／0で自動）</label>
        <input type="text" inputmode="decimal" id="fRotorDiameter" value="${part.props.rotorDiameter || 0}">
      </div>
      <div class="hint"><b>ヘリコプター</b>になります。回転軸は上向き（Y軸）に固定し、推力は機体を浮かせる力（ヘリの機体の重さの1.2〜1.5倍が目安）。飛行画面では、出力レバー（Shift/Ctrl）がコレクティブ、操縦桿は機体の傾きの指示（放すと水平に戻る）、ラダーは向きを変える速さになります。前へ進むのは機首を下げて回転面ごと推力を前へ倒すからで、前へ進むエンジンは要りません。直径は地面効果（ローターの半径より低いと効きが増す）と、仮モデルの羽根の長さに使います。0なら推力から見積もります。</div>
      ` : ''}
      <div class="hint">プロペラは速度が上がるほど推力が落ち、空気が薄いと弱ります。ジェットは速度による落ちがゆるく、薄い空気にもプロペラより強い。アフターバーナー付きは出力レバーを9割より上げたときだけ推力が5割増しになり、炎を吹きます。ロケットは空気を使わないので、速度にも高度にもまったく左右されません。<br>見た目は、プロペラは何も出さず、ジェットはノズル後方の<b>陽炎</b>だけ（炎は出ません）。アフターバーナー付きは9割から上で炎、ロケットは炎と煙を吹きます。</div>
      <div class="field">
        <label>ノズルの直径（m／0で自動）</label>
        <input type="text" inputmode="decimal" id="fPlumeWidth" value="${part.props.plumeWidth || 0}">
      </div>
      <div class="hint">ここで決めた太さの筒が画面のエンジンの形になり、飛行中の炎・排気もこの太さで出ます。<b>機体モデルのエンジンの大きさに合わせてください</b>。0なら推力から自動（いまは約 ${engineNozzleDiameter(Object.assign({}, part.props, { plumeWidth: 0 })).toFixed(2)} m。実機のノズルは推力の平方根におよそ比例するので、それに合わせています）。<br>筒の<b>太いほうの円が噴射口</b>で、その向きがそのまま噴射の向きです。</div>
      ${part.props.engineKind === 'prop' ? '' : `
      <div class="field">
        <label>炎・排気の長さ（倍率）</label>
        <input type="text" inputmode="decimal" id="fPlumeLength" value="${part.props.plumeLength === undefined ? 1 : part.props.plumeLength}">
      </div>
      `}
      <div class="field">
        <label>回転軸（プロペラ/ファン）</label>
        <select id="fSpinAxis">
          <option value="x" ${part.props.spinAxis === 'x' ? 'selected' : ''}>X軸</option>
          <option value="y" ${part.props.spinAxis === 'y' ? 'selected' : ''}>Y軸</option>
          <option value="z" ${part.props.spinAxis === 'z' ? 'selected' : ''}>Z軸（前後方向・推奨）</option>
        </select>
      </div>
      <div class="hint">位置は推力の作用点（機体重心からのオフセット）として飛行モデルに使用されます。</div>
      <div class="toggle-row" style="margin-top:6px;">
        <label>逆噴射なし</label>
        <label class="switch">
          <input type="checkbox" id="fNoReverse" ${part.props.noReverse ? 'checked' : ''}>
          <span class="slider-toggle"></span>
        </label>
      </div>
      <div class="hint">着陸滑走で推力を後ろ向きに使えるかどうか。ジェットは排気を前へ振り向け、可変ピッチのターボプロップは羽根を裏返して逆推力を出せますが、固定ピッチのプロペラ機（レシプロ機など）はできません。オンにすると、この機体は着陸で逆噴射を使わずブレーキとスポイラーだけで止まります。上向き（Y軸）のリフトエンジンは、そもそも逆噴射しません。</div>
      <div class="divider"></div>
      ${part.props.spinAxis === 'y' ? `
      <div class="subgroup-title">エンジングループ</div>
      <div class="hint">上向き（Y軸）のリフトエンジンはグループに入りません。浮くための力なので、飛行中に数字キーで止められないようにしてあります。</div>
      ` : `
      <div class="subgroup-title">エンジングループ</div>
      <div class="field">
        <label>グループ</label>
        <select id="fEngineGroup">
          ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${(part.props.engineGroup || 1) === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>このグループの最高速度</label>
        <div style="display:flex;gap:6px;">
          <input type="text" inputmode="decimal" id="fGroupVmax" value="${part.props.groupMaxSpeedValue || 0}" style="flex:1;">
          <select id="fGroupVmaxUnit" style="flex:0 0 80px;">
            <option value="mach" ${(part.props.groupMaxSpeedUnit || 'mach') === 'mach' ? 'selected' : ''}>マッハ</option>
            <option value="kt" ${part.props.groupMaxSpeedUnit === 'kt' ? 'selected' : ''}>kt</option>
          </select>
        </div>
      </div>
      <div class="hint">飛行中、数字キー<b>1〜4</b>でグループごとに止められます。最高速度は「そのグループのエンジンが推力を出せる上限の速度」で、0なら機体全体の最高速度をそのまま使います。たとえばロケットのグループだけマッハ21、ほかをマッハ5にしておくと、ロケットを止めているあいだはマッハ5で頭打ちになります。同じグループのエンジンに違う値を入れたときは、いちばん大きい値を使います。機体設定パネルの「エンジン出力」から、グループごとにその速度ぶんの推力を入れられます。</div>
      `}
      <div class="divider"></div>
      <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
      ${part.props.spinAxis === 'y' ? vtolBalancePanelHtml() : ''}
    `;
    document.getElementById('fThrust').addEventListener('change', (e) => {
      part.props.thrustKgf = parseFloat(e.target.value) || 0;
      // 直径が「自動」なら推力から決まるので、形も作り直す
      if (!(part.props.plumeWidth > 0)) updateEngineGizmoShape(part);
      renderInspector();
      renderModelSettingsPanel();
    });
    document.getElementById('fSpinAxis').addEventListener('change', (e) => {
      part.props.spinAxis = e.target.value;
      // 筒の向き（＝噴射の向き）を合わせ直す
      updateEngineGizmoShape(part);
      // 回転軸を変えると、出す欄が変わる（リフトエンジンにはグループの欄が無く、
      // 代わりに前後バランスの欄が出る）。選び直さないと切り替わらなかった。
      renderInspector();
      renderModelSettingsPanel();
    });
    document.getElementById('fNoReverse').addEventListener('change', (e) => {
      part.props.noReverse = e.target.checked;
    });
    document.getElementById('fEngineKind').addEventListener('change', (e) => {
      part.props.engineKind = e.target.value;
      // ヘリのローターは上向きの回転軸でしか意味がない
      if (e.target.value === 'rotor' && part.props.spinAxis !== 'y') {
        part.props.spinAxis = 'y';
        updateEngineGizmoShape(part);
      }
      // プロペラには炎の欄が要らない（出ないので）。出し入れのために描き直す。
      renderInspector();
    });
    const elRd = document.getElementById('fRotorDiameter');
    if (elRd) elRd.addEventListener('change', (e) => {
      part.props.rotorDiameter = Math.max(parseFloat(e.target.value) || 0, 0);
    });
    const elPw = document.getElementById('fPlumeWidth');
    if (elPw) elPw.addEventListener('change', (e) => {
      part.props.plumeWidth = Math.max(parseFloat(e.target.value) || 0, 0);
      updateEngineGizmoShape(part);
      renderInspector();
    });
    const elPl = document.getElementById('fPlumeLength');
    if (elPl) elPl.addEventListener('change', (e) => {
      part.props.plumeLength = Math.max(parseFloat(e.target.value) || 0, 0);
    });
    // グループの欄はリフトエンジン（回転軸Y）では出さないので、無いことがある
    const elGroup = document.getElementById('fEngineGroup');
    if (elGroup) elGroup.addEventListener('change', (e) => {
      part.props.engineGroup = parseInt(e.target.value, 10) || 1;
    });
    const elVmax = document.getElementById('fGroupVmax');
    if (elVmax) elVmax.addEventListener('change', (e) => {
      part.props.groupMaxSpeedValue = Math.max(parseFloat(e.target.value) || 0, 0);
    });
    const elVmaxUnit = document.getElementById('fGroupVmaxUnit');
    if (elVmaxUnit) elVmaxUnit.addEventListener('change', (e) => {
      part.props.groupMaxSpeedUnit = e.target.value;
    });
    document.getElementById('btnMirrorPart').addEventListener('click', () => mirrorPart(part.id));
    const vtolBtn = document.getElementById('btnVtolBalance');
    if (vtolBtn) vtolBtn.addEventListener('click', () => balanceVtolThrust());

  } else if (part.type === 'wing') {
    const center = wingCornersCenter(part.props.corners);
    container.innerHTML = `
      <div class="subgroup-title">主翼／尾翼の設定</div>
      <div class="field">
        <label>役割</label>
        <select id="fRole">
          ${WING_ROLES.map(r => `<option value="${r.value}" ${part.props.role === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>翼幅の目安（m）</label>
        <input type="text" inputmode="decimal" id="fSpan" value="${part.props.span}">
      </div>
      <div class="field" id="fSideField" style="${part.props.role === 'vtail' ? 'display:none;' : ''}">
        <label>左右位置</label>
        <select id="fSide">
          <option value="left" ${part.props.side === 'left' ? 'selected' : ''}>左</option>
          <option value="right" ${part.props.side === 'right' ? 'selected' : ''}>右</option>
          <option value="center" ${part.props.side === 'center' ? 'selected' : ''}>中央</option>
        </select>
      </div>
      <div class="hint">可動翼面（エルロン等）を追加するときの「所属する主翼」として選択できます。垂直尾翼は通常1つで中央配置のため左右位置は表示されません。</div>

      <div class="divider"></div>
      <div class="subgroup-title">4頂点でモデルの羽根形状に合わせる</div>
      <div class="hint" style="margin-bottom:10px;">ビューポート上の黄色い点をドラッグするか、下のボタンで頂点を選んで数値入力できます。4頂点の中心（赤い点）が自動計算され、${part.props.role === 'main' ? '揚力の発生する中心位置' : '基準位置'}として扱われます。</div>
      <div id="cornerButtonsRow" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;"></div>
      <div id="cornerFieldsArea"></div>

      <div class="field" style="margin-top:4px;">
        <label>${part.props.role === 'main' ? '揚力中心（自動計算・参考値）' : '4頂点の中心（自動計算・参考値）'}</label>
        <div class="hint" style="font-family:var(--mono);margin-top:0;">X ${center.x.toFixed(3)}　Y ${center.y.toFixed(3)}　Z ${center.z.toFixed(3)}</div>
      </div>

      <div class="divider"></div>
      <div class="subgroup-title">可動翼面</div>
      <button class="btn-danger-outline" id="btnAddControlSurfaceToWing" style="color:var(--accent);border-color:var(--accent-dim);">
        ＋ この翼に可動翼面を追加（後縁1/4に自動配置）
      </button>
      <div class="hint">${part.props.role === 'vtail' ? 'ラダー' : part.props.role === 'htail' ? 'エレベーター' : 'エルロン'}として追加され、この翼の後縁側1/4の位置に自動配置されます。種類・位置は追加後に右パネルで変更できます。</div>

      ${canMirrorPart(part) ? `
        <div class="divider"></div>
        <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
      ` : ''}
    `;
    document.getElementById('fRole').addEventListener('change', (e) => {
      part.props.role = e.target.value;
      if (part.props.role === 'vtail') part.props.side = 'center';
      else if (part.props.side === 'center') part.props.side = 'left';
      part.props.corners = defaultWingCorners(part.props.role); // 役割が変わると頂点の意味も変わるため初期形状にリセット
      onWingCornerChanged(part);
      renderInspector();
      showToast('役割の変更に伴い、4頂点の位置をリセットしました');
    });
    document.getElementById('fSpan').addEventListener('change', (e) => {
      part.props.span = parseFloat(e.target.value) || 0;
    });
    const sideSelect = document.getElementById('fSide');
    if (sideSelect) {
      sideSelect.addEventListener('change', (e) => { part.props.side = e.target.value; });
    }

    renderWingCornerButtons(part);

    document.getElementById('btnAddControlSurfaceToWing').addEventListener('click', () => {
      const cs = addControlSurfaceToWing(part);
      if (cs) {
        renderInspector(); // kind/position等をaddPart後に書き換えているため、画面に反映するため再描画
        renderPartList();  // 名前もaddPart後に書き換えているため、左パネルの一覧も更新する
        showToast(`「${cs.name}」を「${part.name}」の後縁1/4に追加しました`);
      }
    });

    const btnMirror = document.getElementById('btnMirrorPart');
    if (btnMirror) btnMirror.addEventListener('click', () => mirrorPart(part.id));

  } else if (part.type === 'control_surface') {
    const wingOptions = State.parts.filter(p => p.type === 'wing');
    const attachedWing = controlSurfaceParentWing(part);
    const pct = (v) => Math.round(v * 100);
    const shape = attachedWing ? csResolveShape(part.props, attachedWing.props.corners) : null;
    container.innerHTML = `
      <div class="subgroup-title">可動翼面の設定</div>
      <div class="field">
        <label>種類</label>
        <select id="fKind">
          ${CONTROL_SURFACE_KINDS.map(k => `<option value="${k.value}" ${part.props.kind === k.value ? 'selected' : ''}>${k.label}</option>`).join('')}
        </select>
      </div>
      <div class="row3" style="grid-template-columns:1fr 1fr;">
        <div class="num-field">
          <span class="axis-label">最小角(°)</span>
          <input type="number" step="1" id="fMinDeg" value="${part.props.minDeg}">
        </div>
        <div class="num-field">
          <span class="axis-label">最大角(°)</span>
          <input type="number" step="1" id="fMaxDeg" value="${part.props.maxDeg}">
        </div>
      </div>
      <div class="field" style="margin-top:12px;">
        <label>所属する主翼／尾翼</label>
        <select id="fParentWing">
          <option value="">未設定</option>
          ${wingOptions.map(w => `<option value="${w.id}" ${part.props.parentWingId === w.id ? 'selected' : ''}>${escapeHtml(w.name)}（${WING_ROLES.find(r => r.value === w.props.role)?.label || '主翼'}）</option>`).join('')}
        </select>
      </div>
      ${attachedWing ? `
      <div class="divider"></div>
      <div class="subgroup-title">大きさ（翼から切り取る）</div>
      <div class="field">
        <label>翼幅方向の範囲（0=付け根 〜 1=翼端）</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="hint" style="margin:0;min-width:36px;">始まり</span>
          <input type="range" id="fSpanFrom" min="0" max="1" step="0.01" value="${shape.spanFrom}" style="flex:1;">
          <span class="hint" id="spanFromReadout" style="margin:0;min-width:38px;text-align:right;">${pct(shape.spanFrom)}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="hint" style="margin:0;min-width:36px;">終わり</span>
          <input type="range" id="fSpanTo" min="0" max="1" step="0.01" value="${shape.spanTo}" style="flex:1;">
          <span class="hint" id="spanToReadout" style="margin:0;min-width:38px;text-align:right;">${pct(shape.spanTo)}%</span>
        </div>
      </div>
      <div class="field">
        <label>翼弦の割合（後縁から）</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="range" id="fChordFrac" min="${CS_CHORD_MIN}" max="${CS_CHORD_MAX}" step="0.01" value="${shape.chordFrac}" style="flex:1;">
          <span class="hint" id="chordFracReadout" style="margin:0;min-width:38px;text-align:right;">${pct(shape.chordFrac)}%</span>
        </div>
      </div>
      <div class="hint" id="csAreaReadout"></div>
      <button class="btn-danger-outline" id="btnCsKindShape" style="color:var(--accent);border-color:var(--accent-dim);">この種類の標準の大きさにする</button>
      <div class="hint">舵面は「${escapeHtml(attachedWing.name)}」の後ろ側を切り取った板で、<b>前の辺が蝶番（回転軸）</b>です。位置と向きは翼から決まり、翼の頂点や翼を動かすとついてきます。舵の効きは切り取った大きさ（覆う範囲と翼弦の割合）で決まります。翼の面積は舵面を含めた全体で、舵を切ったときに揚力が変わるのは舵面が覆う範囲だけです。</div>
      ` : `
      <div class="field">
        <label>可動軸（ローカル座標）</label>
        <select id="fHingeAxis">
          <option value="x" ${part.props.hingeAxis === 'x' ? 'selected' : ''}>X軸</option>
          <option value="y" ${part.props.hingeAxis === 'y' ? 'selected' : ''}>Y軸</option>
          <option value="z" ${part.props.hingeAxis === 'z' ? 'selected' : ''}>Z軸</option>
        </select>
      </div>
      <div class="hint">「所属する主翼／尾翼」を選ぶと、その翼の後ろ側を切り取った板になり、大きさ（翼幅の範囲と翼弦の割合）を決められます。未設定のままだと、いちばん近い翼に付いたものとして扱い、効きは種類ごとの標準の大きさになります。</div>
      `}

      <div class="divider"></div>
      <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
    `;
    const refreshAreaReadout = () => {
      const el = document.getElementById('csAreaReadout');
      const a = controlSurfaceAreas(part);
      if (!el || !a) return;
      el.innerHTML = `舵面 <b>${a.panelM2.toFixed(1)} m²</b> ／ 翼 ${a.wingM2.toFixed(1)} m²（固定部 ${(a.wingM2 - a.panelM2).toFixed(1)} m²）`
        + `・覆う範囲 ${Math.round(a.stripFrac * 100)}%・効き τ=${a.tau.toFixed(2)}`
        + `（舵を1°切ると、覆う範囲の翼が${a.tau.toFixed(2)}°迎角を増したのと同じ）`;
    };
    refreshAreaReadout();
    const isKindDefault = (kind) => {
      const d = CS_KIND_SHAPE[kind];
      return d && Math.abs(part.props.spanFrom - d.spanFrom) < 0.005 && Math.abs(part.props.spanTo - d.spanTo) < 0.005
        && Math.abs(part.props.chordFrac - d.chordFrac) < 0.005;
    };
    const applyKindShape = (kind) => {
      const d = CS_KIND_SHAPE[kind] || CS_KIND_SHAPE.aileron;
      part.props.spanFrom = d.spanFrom; part.props.spanTo = d.spanTo; part.props.chordFrac = d.chordFrac;
    };
    document.getElementById('fKind').addEventListener('change', (e) => {
      // 大きさがまだ「前の種類の標準」のままなら、新しい種類の標準に合わせる（調整済みの大きさは尊重する）
      const wasDefault = isKindDefault(part.props.kind);
      part.props.kind = e.target.value;
      if (wasDefault) applyKindShape(part.props.kind);
      syncControlSurfaceToWing(part);
      renderInspector();
    });
    const hingeSel = document.getElementById('fHingeAxis');
    if (hingeSel) hingeSel.addEventListener('change', (e) => { part.props.hingeAxis = e.target.value; });
    document.getElementById('fMinDeg').addEventListener('change', (e) => { part.props.minDeg = parseFloat(e.target.value) || 0; });
    document.getElementById('fMaxDeg').addEventListener('change', (e) => { part.props.maxDeg = parseFloat(e.target.value) || 0; });
    document.getElementById('fParentWing').addEventListener('change', (e) => {
      part.props.parentWingId = e.target.value || null;
      if (part.props.parentWingId && !Number.isFinite(part.props.spanFrom)) applyKindShape(part.props.kind);
      syncControlSurfaceToWing(part);
      renderInspector();
    });
    const bindShapeSlider = (id, readoutId, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (e) => {
        let v = parseFloat(e.target.value);
        // 範囲は少なくとも2%の幅を残す（幅0の舵面は効かないうえ、形が作れない）
        if (key === 'spanFrom') v = Math.min(v, part.props.spanTo - 0.02);
        if (key === 'spanTo') v = Math.max(v, part.props.spanFrom + 0.02);
        v = Math.min(Math.max(v, key === 'chordFrac' ? CS_CHORD_MIN : 0), key === 'chordFrac' ? CS_CHORD_MAX : 1);
        part.props[key] = v;
        e.target.value = v;
        document.getElementById(readoutId).textContent = Math.round(v * 100) + '%';
        syncControlSurfaceToWing(part);
        refreshAreaReadout();
      });
    };
    bindShapeSlider('fSpanFrom', 'spanFromReadout', 'spanFrom');
    bindShapeSlider('fSpanTo', 'spanToReadout', 'spanTo');
    bindShapeSlider('fChordFrac', 'chordFracReadout', 'chordFrac');
    const btnKindShape = document.getElementById('btnCsKindShape');
    if (btnKindShape) btnKindShape.addEventListener('click', () => {
      applyKindShape(part.props.kind);
      syncControlSurfaceToWing(part);
      renderInspector();
    });
    document.getElementById('btnMirrorPart').addEventListener('click', () => mirrorPart(part.id));

  } else if (part.type === 'light') {
    container.innerHTML = `
      <div class="subgroup-title">航行灯の設定</div>
      <div class="field">
        <label>種類</label>
        <select id="fLightKind">
          ${LIGHT_KINDS.map(k => `<option value="${k.value}" ${part.props.kind === k.value ? 'selected' : ''}>${k.label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>点灯パターン</label>
        <select id="fBlink">
          <option value="steady" ${part.props.blink === 'steady' ? 'selected' : ''}>常灯</option>
          <option value="pulse" ${part.props.blink === 'pulse' ? 'selected' : ''}>ゆっくり点滅（ビーコン）</option>
          <option value="strobe" ${part.props.blink === 'strobe' ? 'selected' : ''}>高速閃光（ストロボ）</option>
        </select>
      </div>
      <div class="hint">種類を選ぶと色と点灯パターンの初期値が自動設定されます（後から個別に変更可）。</div>
      ${part.props.kind === 'landing' ? `
      <div class="divider"></div>
      <div class="subgroup-title">照らす向きと広がり</div>
      <div class="field">
        <label>伏せ角（°）</label>
        <input type="number" id="fBeamDown" step="1" value="${lightBeamDownDeg(part.props)}">
      </div>
      <div class="field">
        <label>広がり・半角（°）</label>
        <input type="number" id="fBeamSpread" step="1" min="1" max="60" value="${lightBeamSpreadDeg(part.props)}">
      </div>
      <div class="field">
        <label>届く距離（m）</label>
        <input type="number" id="fBeamRange" step="50" min="20" value="${lightBeamRangeM(part.props)}">
      </div>
      <div class="hint">まっすぐ前から何度下を向くかが「伏せ角」です。
        <b>パーツの回転（Eキー）はこれに上乗せされます</b>——左右へ振りたいときは
        ギズモでY軸に回してください。円錐のギズモが、実際に照らす向きと広がりを表します。</div>
      ` : ''}
      <div class="divider"></div>
      <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
    `;
    document.getElementById('fLightKind').addEventListener('change', (e) => {
      const kindDef = LIGHT_KINDS.find(k => k.value === e.target.value);
      part.props.kind = kindDef.value;
      part.props.color = kindDef.color;
      part.props.blink = kindDef.blink;
      updatePartGizmoColor(part);
      updateLightGizmoShape(part);   // 着陸灯は円錐、それ以外は玉
      renderInspector();
    });
    document.getElementById('fBlink').addEventListener('change', (e) => { part.props.blink = e.target.value; });
    if (part.props.kind === 'landing') {
      const beam = (id, key, min, max) => {
        document.getElementById(id).addEventListener('change', (e) => {
          const v = parseFloat(e.target.value);
          if (!isFinite(v)) { e.target.value = part.props[key]; return; }
          part.props[key] = Math.min(Math.max(v, min), max);
          e.target.value = part.props[key];
          updateLightGizmoShape(part);
        });
      };
      beam('fBeamDown', 'beamDownDeg', -80, 80);
      beam('fBeamSpread', 'beamSpreadDeg', 1, 60);
      beam('fBeamRange', 'beamRangeM', 20, 20000);
    }
    document.getElementById('btnMirrorPart').addEventListener('click', () => mirrorPart(part.id));

  } else if (part.type === 'landing_gear') {
    renderLandingGearFields(container, part);

  } else if (part.type === 'viewpoint') {
    container.innerHTML = `
      <div class="subgroup-title">コックピット視点</div>
      <div class="hint">飛行画面の「コックピット」視点で、ここが目の位置になります。
        上の「位置」をギズモか数値で動かして、操縦席に合わせてください。
        「回転」は視線の向きです（0なら真っ直ぐ前。X を下げると見下ろし、
        Y を回すと横向きの席になります）。</div>
      <div class="hint">置いていない機体は、これまでどおり機体の大きさから
        見積もった位置（重心の少し前・少し上）を使います。1機に1つで足ります。</div>
      <div class="divider"></div>
      <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
    `;
    document.getElementById('btnMirrorPart').addEventListener('click', () => mirrorPart(part.id));
  }
}

// 着陸脚：取付位置・関節（折りたたみ角度）・伸縮節（シリンダー式伸縮）・展開/格納テストスライダー
function renderLandingGearFields(container, part) {
  const jointsHtml = part.props.joints.map((j, i) => `
    <div class="joint-strut-row" data-kind="joint" data-id="${j.id}">
      <div class="joint-strut-head">
        <span>関節 ${i + 1}</span>
        <span class="del" data-action="removeJoint" data-id="${j.id}" title="削除">✕</span>
      </div>
      <div class="field">
        <label>名前</label>
        <input type="text" data-field="label" data-id="${j.id}" value="${escapeHtml(j.label)}">
      </div>
      <div class="field">
        <label>回転軸（ローカル座標）</label>
        <select data-field="axis" data-id="${j.id}">
          <option value="x" ${j.axis === 'x' ? 'selected' : ''}>X軸</option>
          <option value="y" ${j.axis === 'y' ? 'selected' : ''}>Y軸</option>
          <option value="z" ${j.axis === 'z' ? 'selected' : ''}>Z軸</option>
        </select>
      </div>
      <div class="row3" style="grid-template-columns:1fr 1fr;">
        <div class="num-field">
          <span class="axis-label">格納側角度(°)</span>
          <input type="number" step="1" data-field="minDeg" data-id="${j.id}" value="${j.minDeg}">
        </div>
        <div class="num-field">
          <span class="axis-label">展開側角度(°)</span>
          <input type="number" step="1" data-field="maxDeg" data-id="${j.id}" value="${j.maxDeg}">
        </div>
      </div>
    </div>
  `).join('');

  const strutsHtml = part.props.struts.map((s, i) => `
    <div class="joint-strut-row" data-kind="strut" data-id="${s.id}">
      <div class="joint-strut-head">
        <span>伸縮節 ${i + 1}</span>
        <span class="del" data-action="removeStrut" data-id="${s.id}" title="削除">✕</span>
      </div>
      <div class="field">
        <label>名前</label>
        <input type="text" data-field="label" data-id="${s.id}" value="${escapeHtml(s.label)}">
      </div>
      <div class="row3" style="grid-template-columns:1fr 1fr;">
        <div class="num-field">
          <span class="axis-label">格納側長さ(m)</span>
          <input type="number" step="0.05" data-field="minLength" data-id="${s.id}" value="${s.minLength}">
        </div>
        <div class="num-field">
          <span class="axis-label">展開側長さ(m)</span>
          <input type="number" step="0.05" data-field="maxLength" data-id="${s.id}" value="${s.maxLength}">
        </div>
      </div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="subgroup-title">着陸脚の設定</div>
    <div class="field">
      <label>取付位置</label>
      <select id="fGearPosition">
        ${LANDING_GEAR_POSITIONS.map(p => `<option value="${p.value}" ${part.props.gearPosition === p.value ? 'selected' : ''}>${p.label}</option>`).join('')}
      </select>
    </div>

    <div class="divider"></div>
    <div class="subgroup-title">展開／格納テスト</div>
    <div class="field">
      <label>格納 ← → 展開（プレビュー）</label>
      <input type="range" id="fDeployState" min="0" max="1" step="0.01" value="${part.props.deployState}" style="width:100%;">
    </div>
    <div class="hint" id="deployStateReadout" style="margin-top:-4px;">${(part.props.deployState * 100).toFixed(0)}% 展開</div>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button class="btn-danger-outline" id="btnDeployFull" style="color:var(--ok);border-color:#1f4a35;flex:1;">全展開</button>
      <button class="btn-danger-outline" id="btnDeployZero" style="color:var(--text-dim);flex:1;">全格納</button>
    </div>
    <div class="hint" style="margin-top:8px;">「格納側」「展開側」の角度・長さは、上のスライダーが0（格納側）〜1（展開側）で線形に補間されます。実際の格納方向がスライダーと逆に感じる場合は、下の反転スイッチをオンにしてください。</div>
    <div class="toggle-row" style="margin-top:6px;">
      <label>スライダー0＝格納として扱う</label>
      <label class="switch">
        <input type="checkbox" id="fRetractedAtZero" ${part.props.retractedAtZero ? 'checked' : ''}>
        <span class="slider-toggle"></span>
      </label>
    </div>
    <button class="btn-danger-outline" id="btnFitToGround" style="color:var(--accent);border-color:var(--accent-dim);margin-top:2px;">全展開時に地面へ届く長さへ自動調整</button>
    <div class="hint">現在の取付位置・関節の角度をもとに、地面に一番近い伸縮節の「展開側の長さ」を逆算して合わせます。</div>

    <div class="divider"></div>
    <div class="subgroup-title">関節（折りたたみ軸）</div>
    <div id="jointsList">${jointsHtml || '<div class="hint">まだ関節がありません。</div>'}</div>
    <button class="btn-danger-outline" id="btnAddJoint" style="color:var(--accent);border-color:var(--accent-dim);margin-top:6px;">＋ 関節を追加</button>

    <div class="divider"></div>
    <div class="subgroup-title">伸縮節（シリンダー式）</div>
    <div id="strutsList">${strutsHtml || '<div class="hint">まだ伸縮節がありません。</div>'}</div>
    <button class="btn-danger-outline" id="btnAddStrut" style="color:var(--accent);border-color:var(--accent-dim);margin-top:6px;">＋ 伸縮節を追加</button>

    <div class="hint" style="margin-top:10px;">関節と伸縮節は、追加した順に基点から先端へ交互につながります（関節→伸縮節→関節…）。並び順を変えたい場合は一度削除して追加し直してください。</div>

    <div class="divider"></div>
    <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
  `;

  document.getElementById('fGearPosition').addEventListener('change', (e) => {
    part.props.gearPosition = e.target.value;
  });

  const deploySlider = document.getElementById('fDeployState');
  deploySlider.addEventListener('input', (e) => {
    part.props.deployState = parseFloat(e.target.value);
    document.getElementById('deployStateReadout').textContent = `${(part.props.deployState * 100).toFixed(0)}% 展開`;
    applyDeployStateToGear(part);
  });
  document.getElementById('btnDeployFull').addEventListener('click', () => {
    part.props.deployState = 1;
    deploySlider.value = 1;
    document.getElementById('deployStateReadout').textContent = '100% 展開';
    applyDeployStateToGear(part);
  });
  document.getElementById('btnDeployZero').addEventListener('click', () => {
    part.props.deployState = 0;
    deploySlider.value = 0;
    document.getElementById('deployStateReadout').textContent = '0% 展開';
    applyDeployStateToGear(part);
  });
  document.getElementById('fRetractedAtZero').addEventListener('change', (e) => {
    part.props.retractedAtZero = e.target.checked;
    applyDeployStateToGear(part);
  });
  document.getElementById('btnFitToGround').addEventListener('click', () => {
    fitGearToGround(part);
    renderInspector();
  });

  container.querySelectorAll('[data-kind="joint"] [data-field]').forEach(input => {
    input.addEventListener('change', (e) => {
      const jointId = e.target.dataset.id;
      const field = e.target.dataset.field;
      const joint = part.props.joints.find(j => j.id === jointId);
      if (!joint) return;
      if (field === 'label') joint.label = e.target.value;
      else if (field === 'axis') joint.axis = e.target.value;
      else joint[field] = parseFloat(e.target.value) || 0;
      applyDeployStateToGear(part);
    });
  });
  container.querySelectorAll('[data-kind="strut"] [data-field]').forEach(input => {
    input.addEventListener('change', (e) => {
      const strutId = e.target.dataset.id;
      const field = e.target.dataset.field;
      const strut = part.props.struts.find(s => s.id === strutId);
      if (!strut) return;
      if (field === 'label') strut.label = e.target.value;
      else strut[field] = parseFloat(e.target.value) || 0;
      applyDeployStateToGear(part);
    });
  });
  container.querySelectorAll('[data-action="removeJoint"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      part.props.joints = part.props.joints.filter(j => j.id !== e.target.dataset.id);
      rebuildLandingGearGizmo(part);
      renderInspector();
    });
  });
  container.querySelectorAll('[data-action="removeStrut"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      part.props.struts = part.props.struts.filter(s => s.id !== e.target.dataset.id);
      rebuildLandingGearGizmo(part);
      renderInspector();
    });
  });

  document.getElementById('btnAddJoint').addEventListener('click', () => {
    part.props.joints.push({ id: genJointId(), axis: 'x', minDeg: -90, maxDeg: 0, label: `関節 ${part.props.joints.length + 1}` });
    rebuildLandingGearGizmo(part);
    renderInspector();
  });
  document.getElementById('btnAddStrut').addEventListener('click', () => {
    part.props.struts.push({ id: genStrutId(), axis: 'y', minLength: 0.3, maxLength: 0.7, label: `伸縮節 ${part.props.struts.length + 1}` });
    rebuildLandingGearGizmo(part);
    renderInspector();
  });

  document.getElementById('btnMirrorPart').addEventListener('click', () => mirrorPart(part.id));
}

// 翼の4頂点：選択ボタン一式＋選択中頂点のXYZ数値入力欄
function renderWingCornerButtons(part) {
  const buttonsRow = document.getElementById('cornerButtonsRow');
  const fieldsArea = document.getElementById('cornerFieldsArea');
  if (!buttonsRow || !fieldsArea) return;

  buttonsRow.innerHTML = WING_CORNER_KEYS.map(key => {
    const isSelected = State.selectedCornerKey === key;
    return `<button class="btn-danger-outline" data-corner="${key}" style="
      color:${isSelected ? '#04121e' : 'var(--accent)'};
      background:${isSelected ? 'var(--accent)' : 'transparent'};
      border-color:var(--accent-dim);font-size:11.5px;padding:7px 6px;
    ">${wingCornerLabel(part.props.role, key)}</button>`;
  }).join('');

  buttonsRow.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      selectWingCorner(part, btn.dataset.corner);
      renderInspector();
    });
  });

  if (State.selectedCornerKey && part.props.corners[State.selectedCornerKey]) {
    const key = State.selectedCornerKey;
    const c = part.props.corners[key];
    fieldsArea.innerHTML = `
      <div class="subgroup-title" style="font-size:11.5px;color:var(--text-dim);">選択中：${wingCornerLabel(part.props.role, key)}（パーツ基準のローカル座標, m）</div>
      <div class="row3">${xyzFieldsHtml('corner', c)}</div>
    `;
    bindXyzFields('corner', c, () => {
      const handle = part.cornerHandleMeshes ? part.cornerHandleMeshes[key] : null;
      if (handle) handle.position.set(c.x, c.y, c.z);
      onWingCornerChanged(part);
    });
  } else {
    fieldsArea.innerHTML = `<div class="hint">上のボタンで頂点を選ぶと、ここに座標を数値入力できます。</div>`;
  }
}

function updatePartGizmoColor(part) {
  if (part.type === 'light' && part.gizmo) {
    const c = new THREE.Color(part.props.color);
    part.gizmo.material.color = c;
    part.gizmo.material.emissive = c;
  }
}

function setupPartTypeButtons() {
  document.querySelectorAll('#partTypeButtons button').forEach(btn => {
    btn.addEventListener('click', () => {
      addPart(btn.dataset.type);
      if (isMobileLayout()) closeDrawers(); // 配置後は3Dビューでギズモ操作させる
    });
  });
}

// ---- モバイル用ドロワー（左：パーツ一覧／右：インスペクター） ----
const MOBILE_BREAKPOINT = 860;

function isMobileLayout() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

function openDrawer(side) {
  if (!isMobileLayout()) {
    console.warn('openDrawer: モバイルレイアウト判定がfalseのため何もしません（幅=' + window.innerWidth + '）');
    if (typeof showToast === 'function') {
      showToast('画面幅の判定によりパネルを開けませんでした（幅=' + window.innerWidth + 'px）', true);
    }
    return;
  }
  const el = document.getElementById(side === 'left' ? 'left' : 'right');
  const other = document.getElementById(side === 'left' ? 'right' : 'left');
  if (!el || !other) {
    console.error('openDrawer: 対象要素が見つかりません', side);
    return;
  }
  other.classList.remove('drawer-open');
  el.classList.add('drawer-open');
  document.getElementById('drawerOverlay').classList.add('show');
}

function closeDrawers() {
  document.getElementById('left').classList.remove('drawer-open');
  document.getElementById('right').classList.remove('drawer-open');
  document.getElementById('drawerOverlay').classList.remove('show');
}

function setupMobileDrawers() {
  const btnParts = document.getElementById('btnTogglePartsDrawer');
  const btnInspector = document.getElementById('btnToggleInspectorDrawer');
  const btnCloseLeft = document.getElementById('btnCloseLeft');
  const btnCloseRight = document.getElementById('btnCloseRight');
  const overlay = document.getElementById('drawerOverlay');

  if (!btnParts || !btnInspector || !btnCloseLeft || !btnCloseRight || !overlay) {
    console.error('ドロワー要素が見つかりません', { btnParts, btnInspector, btnCloseLeft, btnCloseRight, overlay });
    return;
  }

  btnParts.addEventListener('click', () => {
    const left = document.getElementById('left');
    if (left.classList.contains('drawer-open')) closeDrawers();
    else openDrawer('left');
  });
  btnInspector.addEventListener('click', () => {
    const right = document.getElementById('right');
    if (right.classList.contains('drawer-open')) closeDrawers();
    else openDrawer('right');
  });
  btnCloseLeft.addEventListener('click', closeDrawers);
  btnCloseRight.addEventListener('click', closeDrawers);
  overlay.addEventListener('click', closeDrawers);

  // 画面回転・リサイズでデスクトップ幅に戻ったらドロワー状態をリセット
  window.addEventListener('resize', () => {
    if (!isMobileLayout()) closeDrawers();
  });
}

let toastTimer = null;
function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? '#5a2a2a' : 'var(--line)';
  el.style.color = isError ? '#ff9a9a' : 'var(--text)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
