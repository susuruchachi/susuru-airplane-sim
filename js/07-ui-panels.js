// 07-ui-panels.js — 左：パーツ一覧 / 右：インスペクター（種別ごとのプロパティフォーム）

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
    row.innerHTML = `
      <span class="dot" style="background:${PART_TYPE_COLORS[part.type]}"></span>
      <span class="label">${escapeHtml(part.name)}</span>
      <span class="type">${PART_TYPE_LABELS[part.type]}</span>
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
  const wings = State.parts.filter(p => p.type === 'wing');
  const hasLeftRight = wings.some(w => w.props.side === 'left') && wings.some(w => w.props.side === 'right');

  el.innerHTML = `
    <div class="section-title">プロパティ — 重心（原点）</div>
    <div class="hint" style="margin-bottom:14px;">機体の重心位置です。飛行モデルの基準点として使われます。ギズモは移動のみ操作できます。</div>

    <div class="subgroup-title">位置（m）</div>
    <div class="row3">
      ${xyzFieldsHtml('cg', State.cg.position)}
    </div>

    <div class="divider"></div>
    <div class="subgroup-title">主翼から決定</div>
    <div class="hint" style="margin-bottom:8px;">左翼・右翼として登録された主翼のX位置から、左右対称の中心をXに反映します（Y・Zは変更しません）。</div>
    <button class="btn-danger-outline" id="btnCgFromWings" style="color:var(--accent);border-color:var(--accent-dim);">
      主翼から決定
    </button>
    ${!hasLeftRight ? '<div class="hint" style="color:var(--warn);margin-top:8px;">左翼・右翼それぞれ1つ以上必要です</div>' : ''}
  `;

  bindXyzFields('cg', State.cg.position, () => applyCgToGizmo());

  document.getElementById('btnCgFromWings').addEventListener('click', () => setCgFromWings());
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
        <label>回転軸（プロペラ/ファン）</label>
        <select id="fSpinAxis">
          <option value="x" ${part.props.spinAxis === 'x' ? 'selected' : ''}>X軸</option>
          <option value="y" ${part.props.spinAxis === 'y' ? 'selected' : ''}>Y軸</option>
          <option value="z" ${part.props.spinAxis === 'z' ? 'selected' : ''}>Z軸（前後方向・推奨）</option>
        </select>
      </div>
      <div class="hint">位置は推力の作用点（機体重心からのオフセット）として飛行モデルに使用されます。</div>
    `;
    document.getElementById('fThrust').addEventListener('change', (e) => {
      part.props.thrustKgf = parseFloat(e.target.value) || 0;
    });
    document.getElementById('fSpinAxis').addEventListener('change', (e) => {
      part.props.spinAxis = e.target.value;
    });

  } else if (part.type === 'wing') {
    container.innerHTML = `
      <div class="subgroup-title">主翼設定</div>
      <div class="field">
        <label>翼幅の目安（m）</label>
        <input type="text" inputmode="decimal" id="fSpan" value="${part.props.span}">
      </div>
      <div class="field">
        <label>左右位置</label>
        <select id="fSide">
          <option value="left" ${part.props.side === 'left' ? 'selected' : ''}>左翼</option>
          <option value="right" ${part.props.side === 'right' ? 'selected' : ''}>右翼</option>
          <option value="center" ${part.props.side === 'center' ? 'selected' : ''}>中央（尾翼など）</option>
        </select>
      </div>
      <div class="hint">可動翼面（エルロン等）を追加するときの「所属する主翼」として選択できます。</div>
    `;
    document.getElementById('fSpan').addEventListener('change', (e) => {
      part.props.span = parseFloat(e.target.value) || 0;
    });
    document.getElementById('fSide').addEventListener('change', (e) => {
      part.props.side = e.target.value;
    });

  } else if (part.type === 'control_surface') {
    const wingOptions = State.parts.filter(p => p.type === 'wing');
    container.innerHTML = `
      <div class="subgroup-title">可動翼面の設定</div>
      <div class="field">
        <label>種類</label>
        <select id="fKind">
          ${CONTROL_SURFACE_KINDS.map(k => `<option value="${k.value}" ${part.props.kind === k.value ? 'selected' : ''}>${k.label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>可動軸（ローカル座標）</label>
        <select id="fHingeAxis">
          <option value="x" ${part.props.hingeAxis === 'x' ? 'selected' : ''}>X軸</option>
          <option value="y" ${part.props.hingeAxis === 'y' ? 'selected' : ''}>Y軸</option>
          <option value="z" ${part.props.hingeAxis === 'z' ? 'selected' : ''}>Z軸</option>
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
        <label>所属する主翼（任意）</label>
        <select id="fParentWing">
          <option value="">未設定</option>
          ${wingOptions.map(w => `<option value="${w.id}" ${part.props.parentWingId === w.id ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')}
        </select>
      </div>
      <div class="hint">可動軸はこのパーツのローカル座標系での回転軸です。ギズモを「回転」モードにして向きを確認できます。</div>
    `;
    document.getElementById('fKind').addEventListener('change', (e) => { part.props.kind = e.target.value; });
    document.getElementById('fHingeAxis').addEventListener('change', (e) => { part.props.hingeAxis = e.target.value; });
    document.getElementById('fMinDeg').addEventListener('change', (e) => { part.props.minDeg = parseFloat(e.target.value) || 0; });
    document.getElementById('fMaxDeg').addEventListener('change', (e) => { part.props.maxDeg = parseFloat(e.target.value) || 0; });
    document.getElementById('fParentWing').addEventListener('change', (e) => { part.props.parentWingId = e.target.value || null; });

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
    `;
    document.getElementById('fLightKind').addEventListener('change', (e) => {
      const kindDef = LIGHT_KINDS.find(k => k.value === e.target.value);
      part.props.kind = kindDef.value;
      part.props.color = kindDef.color;
      part.props.blink = kindDef.blink;
      updatePartGizmoColor(part);
      renderInspector();
    });
    document.getElementById('fBlink').addEventListener('change', (e) => { part.props.blink = e.target.value; });
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
  if (!isMobileLayout()) return;
  const el = document.getElementById(side === 'left' ? 'left' : 'right');
  const other = document.getElementById(side === 'left' ? 'right' : 'left');
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
  document.getElementById('btnTogglePartsDrawer').addEventListener('click', () => {
    const left = document.getElementById('left');
    if (left.classList.contains('drawer-open')) closeDrawers();
    else openDrawer('left');
  });
  document.getElementById('btnToggleInspectorDrawer').addEventListener('click', () => {
    const right = document.getElementById('right');
    if (right.classList.contains('drawer-open')) closeDrawers();
    else openDrawer('right');
  });
  document.getElementById('btnCloseLeft').addEventListener('click', closeDrawers);
  document.getElementById('btnCloseRight').addEventListener('click', closeDrawers);
  document.getElementById('drawerOverlay').addEventListener('click', closeDrawers);

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
