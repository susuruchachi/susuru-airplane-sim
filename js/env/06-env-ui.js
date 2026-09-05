// 06-env-ui.js — 右パネルの操作UI（時刻・周期・雲量・風・高度プレビュー）

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

  timeSlider.value = EnvState.time.hours;
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

  cycleInput.value = EnvState.time.cycleMinutes;
  cycleInput.addEventListener('change', () => {
    const v = parseFloat(cycleInput.value);
    EnvState.time.cycleMinutes = Number.isFinite(v) && v > 0 ? v : 15;
    cycleInput.value = EnvState.time.cycleMinutes;
  });

  cloudSlider.value = Math.round(EnvState.env.cloudCoverage * 100);
  cloudReadout.textContent = cloudSlider.value + '%';
  cloudSlider.addEventListener('input', () => {
    EnvState.env.cloudCoverage = parseFloat(cloudSlider.value) / 100;
    cloudReadout.textContent = cloudSlider.value + '%';
    applyCloudCoverage();
  });

  windSpeedSlider.value = EnvState.env.windSpeedKmh;
  windSpeedReadout.textContent = EnvState.env.windSpeedKmh + ' km/h';
  windSpeedSlider.addEventListener('input', () => {
    EnvState.env.windSpeedKmh = parseFloat(windSpeedSlider.value);
    windSpeedReadout.textContent = windSpeedSlider.value + ' km/h';
  });

  windDirSlider.value = EnvState.env.windDirectionDeg;
  windDirReadout.textContent = EnvState.env.windDirectionDeg + '°';
  windDirSlider.addEventListener('input', () => {
    EnvState.env.windDirectionDeg = parseFloat(windDirSlider.value);
    windDirReadout.textContent = windDirSlider.value + '°';
  });

  altitudeSlider.value = EnvState.env.previewAltitudeM;
  altitudeReadout.textContent = EnvState.env.previewAltitudeM + ' m';
  altitudeSlider.addEventListener('input', () => {
    EnvState.env.previewAltitudeM = parseFloat(altitudeSlider.value);
    altitudeReadout.textContent = altitudeSlider.value + ' m';
  });

  btnReset.addEventListener('click', () => {
    EnvState.time.hours = 9;
    EnvState.time.cycleMinutes = 15;
    EnvState.time.paused = false;
    EnvState.env.cloudCoverage = 0.45;
    EnvState.env.windSpeedKmh = 20;
    EnvState.env.windDirectionDeg = 90;
    EnvState.env.previewAltitudeM = 0;
    applyCloudCoverage();
    btnToggle.textContent = '❚❚ 一時停止';
    btnToggle.classList.remove('active');
    cycleInput.value = EnvState.time.cycleMinutes;
    cloudSlider.value = 45; cloudReadout.textContent = '45%';
    windSpeedSlider.value = 20; windSpeedReadout.textContent = '20 km/h';
    windDirSlider.value = 90; windDirReadout.textContent = '90°';
    altitudeSlider.value = 0; altitudeReadout.textContent = '0 m';
  });
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
