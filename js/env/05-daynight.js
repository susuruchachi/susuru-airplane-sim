// 05-daynight.js — 昼夜サイクルの進行と、時刻から太陽・月の方向を計算する処理

// 朔望月（新月から次の新月まで）の長さ(日)
const MOON_SYNODIC_DAYS = 29.530589;

function wrapMoonAge(days) {
  const d = days % MOON_SYNODIC_DAYS;
  return d < 0 ? d + MOON_SYNODIC_DAYS : d;
}

function advanceTimeOfDay(dt) {
  const t = EnvState.time;
  if (t.paused) return;
  const cycleSeconds = Math.max(t.cycleMinutes, 0.1) * 60;
  const hoursPerSecond = 24 / cycleSeconds;
  const dHours = hoursPerSecond * dt;
  t.hours = (t.hours + dHours) % 24;
  if (t.hours < 0) t.hours += 24;
  // 月齢は時刻と一緒に進む（24時間で1日）
  t.moonAgeDays = wrapMoonAge((t.moonAgeDays || 0) + dHours / 24);
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

// 月の方向。月は太陽と同じ道を、**月齢ぶん遅れて**通る——1日に約50分（24時間÷29.5日）ずつ
// 月の出が遅れていくのと同じこと。新月（月齢0）は太陽と一緒に昇り沈み（昼の空にあって見えない）、
// 上弦（7.4）は昼に昇って夕方に南中、満月（14.8）は日没に昇って真夜中に南中、下弦（22.1）は真夜中に昇る。
function computeMoonDirection(hours, ageDays) {
  return computeSunDirection(hours - (ageDays / MOON_SYNODIC_DAYS) * 24);
}

// 月齢から満ち欠けの様子を出す。
//   illuminated … 光って見える面の割合（0＝新月〜1＝満月）
//   brightness … 満月を1とした明るさ。欠けると割合以上に暗くなる（半月で満月の1割ほど。
//                 月面の凹凸の影と、満月のときだけ強く光り返す「衝効果」のため）。
//                 月の等級の位相則 Δm = 0.026|φ| + 4×10⁻⁹φ⁴（φ＝位相角°、満月で0）から出す
function moonPhaseInfo(ageDays) {
  const age = wrapMoonAge(ageDays);
  const elongation = (age / MOON_SYNODIC_DAYS) * 360;          // 太陽からの離角（新月0°・満月180°）
  const illuminated = (1 - Math.cos(THREE.MathUtils.degToRad(elongation))) / 2;
  const phaseAngle = Math.abs(180 - elongation);                // 位相角（満月0°・新月180°）
  const dMag = 0.026 * phaseAngle + 4e-9 * Math.pow(phaseAngle, 4);
  const brightness = Math.pow(10, -0.4 * dMag);
  return { age, illuminated, brightness, name: moonPhaseName(age) };
}

// 月齢の呼び名（月齢の区切りは目安）
const MOON_PHASE_NAMES = [
  [1, '新月'], [4, '三日月'], [5.9, '夕月'], [8.9, '上弦の月'], [11.8, '十日夜の月'], [13.8, '十三夜の月'],
  [15.8, '満月'], [16.8, '十六夜の月'], [20.6, '寝待月'], [23.6, '下弦の月'], [28.5, '有明月'], [Infinity, '新月'],
];
function moonPhaseName(age) {
  for (const [until, name] of MOON_PHASE_NAMES) if (age < until) return name;
  return '新月';
}

function updateDayNightCycle(dt) {
  advanceTimeOfDay(dt);
  const { dir, elevationDeg } = computeSunDirection(EnvState.time.hours);
  const moon = computeMoonDirection(EnvState.time.hours, EnvState.time.moonAgeDays || 0);
  updateSkyForSunDirection(dir, elevationDeg, moon);
  if (typeof updateEnvTimeReadout === 'function') updateEnvTimeReadout(elevationDeg);
}

function formatHoursAsClock(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
