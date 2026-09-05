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

  container.innerHTML = `
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
  `;

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
        <label>回転軸（プロペラ/ファン）</label>
        <select id="fSpinAxis">
          <option value="x" ${part.props.spinAxis === 'x' ? 'selected' : ''}>X軸</option>
          <option value="y" ${part.props.spinAxis === 'y' ? 'selected' : ''}>Y軸</option>
          <option value="z" ${part.props.spinAxis === 'z' ? 'selected' : ''}>Z軸（前後方向・推奨）</option>
        </select>
      </div>
      <div class="hint">位置は推力の作用点（機体重心からのオフセット）として飛行モデルに使用されます。</div>
      <div class="divider"></div>
      <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
    `;
    document.getElementById('fThrust').addEventListener('change', (e) => {
      part.props.thrustKgf = parseFloat(e.target.value) || 0;
    });
    document.getElementById('fSpinAxis').addEventListener('change', (e) => {
      part.props.spinAxis = e.target.value;
    });
    document.getElementById('btnMirrorPart').addEventListener('click', () => mirrorPart(part.id));

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

    const btnMirror = document.getElementById('btnMirrorPart');
    if (btnMirror) btnMirror.addEventListener('click', () => mirrorPart(part.id));

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
        <label>所属する主翼／尾翼（任意）</label>
        <select id="fParentWing">
          <option value="">未設定</option>
          ${wingOptions.map(w => `<option value="${w.id}" ${part.props.parentWingId === w.id ? 'selected' : ''}>${escapeHtml(w.name)}（${WING_ROLES.find(r => r.value === w.props.role)?.label || '主翼'}）</option>`).join('')}
        </select>
      </div>
      <div class="hint">可動軸はこのパーツのローカル座標系での回転軸です。ギズモを「回転」モードにして向きを確認できます。</div>

      <div class="divider"></div>
      <div class="subgroup-title">翼から自動配置</div>
      <div class="field">
        <label>翼幅方向の位置（0=付け根 〜 1=翼端）</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="range" id="fSpanS" min="0" max="1" step="0.01" value="${part.props.spanS}" style="flex:1;">
          <span class="hint" id="spanSReadout" style="margin:0;min-width:38px;text-align:right;">${Math.round(part.props.spanS * 100)}%</span>
        </div>
      </div>
      <button class="btn-danger-outline" id="btnPlaceAtTrailingQuarter" style="color:var(--accent);border-color:var(--accent-dim);" ${!part.props.parentWingId ? 'disabled' : ''}>
        後縁1/4の位置に自動配置
      </button>
      <div class="hint">${part.props.parentWingId ? '選んだ主翼／尾翼の、前縁から75%（後縁側1/4）の位置・上のスライダーで指定した翼幅位置に配置します。' : '先に「所属する主翼／尾翼」を選んでください。'}</div>

      <div class="divider"></div>
      <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
    `;
    document.getElementById('fKind').addEventListener('change', (e) => {
      const oldKindDef = CONTROL_SURFACE_KINDS.find(k => k.value === part.props.kind);
      const wasAtSuggested = oldKindDef && Math.abs(part.props.spanS - oldKindDef.suggestedSpanS) < 0.001;
      part.props.kind = e.target.value;
      // 位置がまだ「前の種類の推奨値」のままなら、新しい種類の推奨値に合わせておく（ユーザーが既に調整済みの位置は尊重し変更しない）
      if (wasAtSuggested) {
        const newKindDef = CONTROL_SURFACE_KINDS.find(k => k.value === part.props.kind);
        if (newKindDef) part.props.spanS = newKindDef.suggestedSpanS;
      }
      renderInspector();
    });
    document.getElementById('fHingeAxis').addEventListener('change', (e) => { part.props.hingeAxis = e.target.value; });
    document.getElementById('fMinDeg').addEventListener('change', (e) => { part.props.minDeg = parseFloat(e.target.value) || 0; });
    document.getElementById('fMaxDeg').addEventListener('change', (e) => { part.props.maxDeg = parseFloat(e.target.value) || 0; });
    document.getElementById('fParentWing').addEventListener('change', (e) => {
      part.props.parentWingId = e.target.value || null;
      renderInspector(); // ボタンの有効/無効状態を更新するため再描画
    });
    document.getElementById('fSpanS').addEventListener('input', (e) => {
      part.props.spanS = parseFloat(e.target.value);
      document.getElementById('spanSReadout').textContent = Math.round(part.props.spanS * 100) + '%';
    });
    const btnPlace = document.getElementById('btnPlaceAtTrailingQuarter');
    if (btnPlace) {
      btnPlace.addEventListener('click', () => {
        const wingPart = State.parts.find(p => p.id === part.props.parentWingId);
        if (!wingPart) {
          showToast('所属する主翼／尾翼を選んでください', true);
          return;
        }
        placeControlSurfaceAtTrailingQuarter(part, wingPart, part.props.spanS);
        renderInspector();
        showToast(`「${wingPart.name}」の後縁1/4の位置に配置しました`);
      });
    }
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
      <div class="divider"></div>
      <button class="btn-danger-outline" id="btnMirrorPart" style="color:var(--accent);border-color:var(--accent-dim);">左右対称に複製（ミラー）</button>
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
    document.getElementById('btnMirrorPart').addEventListener('click', () => mirrorPart(part.id));

  } else if (part.type === 'landing_gear') {
    renderLandingGearFields(container, part);
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
