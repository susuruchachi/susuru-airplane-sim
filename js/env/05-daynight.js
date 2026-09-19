// 05-daynight.js — 昼夜サイクルの進行と、時刻から太陽方向を計算する処理

function advanceTimeOfDay(dt) {
  const t = EnvState.time;
  if (t.paused) return;
  const cycleSeconds = Math.max(t.cycleMinutes, 0.1) * 60;
  const hoursPerSecond = 24 / cycleSeconds;
  t.hours = (t.hours + hoursPerSecond * dt) % 24;
  if (t.hours < 0) t.hours += 24;
}

// 時刻（0〜24時）から太陽の単位方向ベクトルと仰角(度)を計算する
// 実際の天文計算ではなく、日の出〜南中〜日没〜夜がなめらかに一周する簡易モデル
function computeSunDirection(hours) {
  const maxElevationDeg = 78;
  const elevationDeg = maxElevationDeg * Math.cos(((hours - 12) / 24) * Math.PI * 2);
  const azimuthDeg = ((hours - 6) / 24) * 360;

  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  return { dir, elevationDeg };
}

function updateDayNightCycle(dt) {
  advanceTimeOfDay(dt);
  const { dir, elevationDeg } = computeSunDirection(EnvState.time.hours);
  updateSkyForSunDirection(dir, elevationDeg);
  if (typeof updateEnvTimeReadout === 'function') updateEnvTimeReadout(elevationDeg);
}

function formatHoursAsClock(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
