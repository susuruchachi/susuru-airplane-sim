// 06-env-ui.js — 右パネルの操作UI（世界・時刻・雲・風・空港・高度）

let _envScrubbingTime = false;

function setupEnvUI() {
  const timeSlider = document.getElementById('envTimeSlider');
  const timeReadout = document.getElementById('envTimeReadout');
  const btnToggle = document.getElementById('envBtnToggleTime');
  const cycleInput = document.getElementById('envCycleMinutes');
  const cloudSlider = document.getElementById('envCloudCoverage');
  const cloudReadout = document.getElementById('envCloudCoverageReadout');
  const windSpeedSlider = document.getElementById('envWindSpeed');
  const windSpeedReadout = document.getElementById('envWindSpeedReadout');
  const windDirSlider = document.getElementById('envWindDirection');
  const windDirReadout = document.getElementById('envWindDirectionReadout');
  const altitudeSlider = document.getElementById('envAltitude');
  const altitudeReadout = document.getElementById('envAltitudeReadout');
  const btnReset = document.getElementById('envBtnReset');

  timeSlider.addEventListener('pointerdown', () => { _envScrubbingTime = true; });
  window.addEventListener('pointerup', () => { _envScrubbingTime = false; });
  timeSlider.addEventListener('input', () => {
    EnvState.time.hours = parseFloat(timeSlider.value);
    timeReadout.textContent = formatHoursAsClock(EnvState.time.hours);
  });

  btnToggle.addEventListener('click', () => {
    EnvState.time.paused = !EnvState.time.paused;
    btnToggle.textContent = EnvState.time.paused ? '▶ 再生' : '❚❚ 一時停止';
    btnToggle.classList.toggle('active', EnvState.time.paused);
  });

  cycleInput.addEventListener('change', () => {
    const v = parseFloat(cycleInput.value);
    EnvState.time.cycleMinutes = Number.isFinite(v) && v > 0 ? v : 15;
    cycleInput.value = EnvState.time.cycleMinutes;
  });

  cloudSlider.addEventListener('input', () => {
    EnvState.env.cloudCoverage = parseFloat(cloudSlider.value) / 100;
    cloudReadout.textContent = cloudSlider.value + '%';
    applyCloudCoverage();
  });

  windSpeedSlider.addEventListener('input', () => {
    EnvState.env.windSpeedKmh = parseFloat(windSpeedSlider.value);
    windSpeedReadout.textContent = windSpeedSlider.value + ' km/h';
  });

  windDirSlider.addEventListener('input', () => {
    EnvState.env.windDirectionDeg = parseFloat(windDirSlider.value);
    windDirReadout.textContent = windDirSlider.value + '°';
  });

  altitudeSlider.addEventListener('input', () => {
    EnvState.env.previewAltitudeM = parseFloat(altitudeSlider.value);
    altitudeReadout.textContent = altitudeSlider.value + ' m';
  });

  setupWorldUI();
  setupAirportUI();

  btnReset.addEventListener('click', () => {
    EnvState.time.hours = 9;
    EnvState.time.cycleMinutes = 15;
    EnvState.time.paused = false;
    EnvState.env.cloudCoverage = 0.45;
    EnvState.env.windSpeedKmh = 20;
    EnvState.env.windDirectionDeg = 90;
    EnvState.env.previewAltitudeM = 0;
    setLabelsVisible(true);
    setTreesVisible(true);
    resetSelectedAirport();
    applyCloudCoverage();
    syncEnvUIToState();
  });

  setupStorageUI();
  syncEnvUIToState();
}

// EnvState の中身をUIの各コントロールへ流し込む。
// 起動時・「初期値に戻す」・設定ファイルの読み込み後に呼ぶ（3か所で同じ処理を書かないため）。
function syncEnvUIToState() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  const text = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

  set('envTimeSlider', EnvState.time.hours);
  text('envTimeReadout', formatHoursAsClock(EnvState.time.hours));
  set('envCycleMinutes', EnvState.time.cycleMinutes);
  const btnToggle = document.getElementById('envBtnToggleTime');
  btnToggle.textContent = EnvState.time.paused ? '▶ 再生' : '❚❚ 一時停止';
  btnToggle.classList.toggle('active', EnvState.time.paused);

  set('envCloudCoverage', Math.round(EnvState.env.cloudCoverage * 100));
  text('envCloudCoverageReadout', Math.round(EnvState.env.cloudCoverage * 100) + '%');
  set('envWindSpeed', EnvState.env.windSpeedKmh);
  text('envWindSpeedReadout', EnvState.env.windSpeedKmh + ' km/h');
  set('envWindDirection', EnvState.env.windDirectionDeg);
  text('envWindDirectionReadout', EnvState.env.windDirectionDeg + '°');
  set('envAltitude', EnvState.env.previewAltitudeM);
  text('envAltitudeReadout', EnvState.env.previewAltitudeM + ' m');

  document.getElementById('envShowLabels').checked = EnvState.env.labelsVisible !== false;
  document.getElementById('envShowTrees').checked = EnvState.env.treesVisible !== false;

  syncAirportUIToSelection();
}

// --- 保存と読み込み ---------------------------------------------------------

function setupStorageUI() {
  const fileInput = document.getElementById('envImportFile');
  document.getElementById('envBtnExport').addEventListener('click', exportEnvJSON);
  document.getElementById('envBtnImport').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) importEnvJSONFile(fileInput.files[0]);
    fileInput.value = '';
  });
  document.getElementById('envBtnClearStorage').addEventListener('click', () => {
    clearEnvStorage();
    syncEnvUIToState();
  });
}

// --- 世界セクション（ミニマップ・現在地・ラベル） ---------------------------

function setupWorldUI() {
  const showLabels = document.getElementById('envShowLabels');
  showLabels.checked = EnvState.env.labelsVisible !== false;
  showLabels.addEventListener('change', () => setLabelsVisible(showLabels.checked));

  const showTrees = document.getElementById('envShowTrees');
  showTrees.checked = EnvState.env.treesVisible !== false;
  showTrees.addEventListener('change', () => setTreesVisible(showTrees.checked));

  setupMinimapUI();
}

// カメラが見ている地点がどこかを表示する。毎フレームDOMを触ると重いので5回/秒に間引く。
let _envWorldReadoutAt = 0;

function updateEnvWorldReadout() {
  const now = performance.now();
  if (now - _envWorldReadoutAt < 200) return;
  _envWorldReadoutAt = now;

  const t = EnvState.orbitControls.target;
  const regionEl = document.getElementById('envRegionReadout');
  if (!regionEl) return;

  const h = worldHeightAt(t.x, t.z);
  const region = worldRegionAt(t.x, t.z);

  if (h <= 0) {
    regionEl.textContent = region && region.distanceM < 260000
      ? `${region.country.name}沖` : '外洋';
  } else if (region && region.distanceM < region.city.urbanR) {
    regionEl.textContent = `${region.country.name} ${region.city.name}`;
  } else if (region && region.distanceM < 300000) {
    regionEl.textContent = region.country.name;
  } else {
    regionEl.textContent = '無人の地';
  }

  document.getElementById('envGroundReadout').textContent = h > 0
    ? Math.round(h).toLocaleString() + ' m'
    : '海面下 ' + Math.round(-h).toLocaleString() + ' m';

  const near = worldNearestAirport(t.x, t.z);
  document.getElementById('envNearestReadout').textContent = near.airport
    ? `${near.airport.id} / ${(near.distanceM / 1000).toFixed(0)} km` : '--';
}

// --- 空港セクション ---------------------------------------------------------
//
// 操作対象はセレクトで選んだ1空港。マップ上の位置と標高は固定で、ここでは変えられない
// （地形がその標高へならされているため。位置を動かすなら js/env/03b-world.js 側を直す）。
// 滑走路の長さ・幅はジオメトリの作り直しが要るので、ドラッグ中に毎フレーム再生成しないよう
// change（指を離した時）で反映する。方位は回転と端の数字の描き直しだけで済むので input で追従。

function setupAirportUI() {
  const select = document.getElementById('envAirportSelect');
  const btnToggle = document.getElementById('envBtnToggleAirport');
  const btnFocus = document.getElementById('envBtnFocusAirport');
  const btnNearest = document.getElementById('envBtnNearestAirport');
  const headingSlider = document.getElementById('envRunwayHeading');
  const lengthSlider = document.getElementById('envRunwayLength');
  const lengthReadout = document.getElementById('envRunwayLengthReadout');
  const widthSlider = document.getElementById('envRunwayWidth');
  const widthReadout = document.getElementById('envRunwayWidthReadout');
  const lightsSelect = document.getElementById('envAirportLights');

  // 82空港あるので国ごとにまとめる
  for (const country of WORLD_COUNTRIES) {
    const list = WORLD_AIRPORTS.filter((a) => a.country === country.id);
    if (!list.length) continue;
    const group = document.createElement('optgroup');
    group.label = country.name;
    for (const a of list) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.id}  ${a.name}`;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }

  select.addEventListener('change', () => {
    EnvState.selectedAirportId = select.value;
    syncAirportUIToSelection();
    focusCameraOnAirport();
  });

  btnNearest.addEventListener('click', () => {
    const t = EnvState.orbitControls.target;
    const near = worldNearestAirport(t.x, t.z);
    if (!near.airport) return;
    EnvState.selectedAirportId = near.airport.id;
    syncAirportUIToSelection();
    focusCameraOnAirport();
  });

  btnToggle.addEventListener('click', () => {
    const st = selectedAirportSettings();
    st.visible = !st.visible;
    const entry = EnvState.builtAirports.get(EnvState.selectedAirportId);
    if (entry) entry.group.visible = st.visible;
    btnToggle.textContent = st.visible ? '空港を隠す' : '空港を表示';
    onAirportSettingsChanged();
  });

  btnFocus.addEventListener('click', focusCameraOnAirport);

  headingSlider.addEventListener('input', () => {
    selectedAirportSettings().headingDeg = parseFloat(headingSlider.value);
    applyAirportHeading();
    refreshRunwayNumbers();
    refreshHeadingLabels();
  });
  headingSlider.addEventListener('change', onAirportSettingsChanged);

  lengthSlider.addEventListener('input', () => {
    lengthReadout.textContent = lengthSlider.value + ' m';
  });
  lengthSlider.addEventListener('change', () => {
    selectedAirportSettings().runwayLengthM = parseFloat(lengthSlider.value);
    rebuildSelectedAirport();
    onAirportSettingsChanged();
  });

  widthSlider.addEventListener('input', () => {
    widthReadout.textContent = widthSlider.value + ' m';
  });
  widthSlider.addEventListener('change', () => {
    selectedAirportSettings().runwayWidthM = parseFloat(widthSlider.value);
    rebuildSelectedAirport();
    onAirportSettingsChanged();
  });

  lightsSelect.addEventListener('change', () => {
    selectedAirportSettings().lightsMode = lightsSelect.value;
    onAirportSettingsChanged();
  });

  syncAirportUIToSelection();
}

// 選択中の空港をマップ定義（WORLD_AIRPORTS）の値へ戻す
function resetSelectedAirport() {
  const def = selectedAirportDef();
  if (!def) return;
  delete EnvState.airportSettings[def.id];
  getAirportSettings(def.id);
  rebuildSelectedAirport();
  applyAirportHeading();
  syncAirportUIToSelection();
  onAirportSettingsChanged();
}

// 方位の読み出しと滑走路の呼称（例:09/27）を書き直す
function refreshHeadingLabels() {
  const st = selectedAirportSettings();
  if (!st) return;
  document.getElementById('envRunwayHeadingReadout').textContent =
    String(Math.round(st.headingDeg)).padStart(3, '0') + '°';
  const { near, far } = runwayDesignators(st.headingDeg);
  document.getElementById('envAirportDesignatorReadout').textContent = `${near}/${far}`;
}

// 選択中の空港の値をUI一式へ反映する（空港を切り替えたとき・初期値に戻したとき）
function syncAirportUIToSelection() {
  const def = selectedAirportDef();
  const st = selectedAirportSettings();
  if (!def || !st) return;

  document.getElementById('envAirportSelect').value = def.id;
  document.getElementById('envRunwayHeading').value = st.headingDeg;

  // 地形をならしてある範囲からはみ出さないよう、長さの上限は空港ごとに変える
  const lengthSlider = document.getElementById('envRunwayLength');
  lengthSlider.min = 800;
  lengthSlider.max = def.maxRunwayLengthM;
  lengthSlider.value = st.runwayLengthM;
  document.getElementById('envRunwayLengthReadout').textContent = st.runwayLengthM + ' m';

  document.getElementById('envRunwayWidth').value = st.runwayWidthM;
  document.getElementById('envRunwayWidthReadout').textContent = st.runwayWidthM + ' m';
  document.getElementById('envAirportLights').value = st.lightsMode;
  document.getElementById('envBtnToggleAirport').textContent = st.visible ? '空港を隠す' : '空港を表示';

  const country = worldCountryById(def.country);
  const city = worldCityById(def.city);
  document.getElementById('envAirportInfoReadout').textContent =
    `${country ? country.name : '?'}${city ? ' / ' + city.name : ''} / 標高 ${def.elevationM.toLocaleString()}m`;

  refreshHeadingLabels();
}

// 空港の設定が変わったときの後始末（保存は 08-env-storage.js が引き受ける）
function onAirportSettingsChanged() {
  if (typeof saveAirportSettings === 'function') saveAirportSettings();
}

// 毎フレーム、現在時刻の表示とスライダー位置を更新する（ドラッグ中は上書きしない）
function updateEnvTimeReadout(elevationDeg) {
  const timeReadout = document.getElementById('envTimeReadout');
  const timeSlider = document.getElementById('envTimeSlider');
  const elevationReadout = document.getElementById('envSunElevationReadout');
  if (timeReadout) timeReadout.textContent = formatHoursAsClock(EnvState.time.hours);
  if (timeSlider && !_envScrubbingTime) timeSlider.value = EnvState.time.hours;
  if (elevationReadout && typeof elevationDeg === 'number') {
    elevationReadout.textContent = elevationDeg.toFixed(1) + '°';
  }
}
