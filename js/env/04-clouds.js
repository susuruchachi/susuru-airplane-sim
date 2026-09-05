// 04-clouds.js — 雲（ビルボードスプライトの塊を敷き詰め、風で流す）

const CLOUD_MAX_CLUSTERS = 60;
const CLOUD_FIELD_HALF_SIZE = 3000; // この範囲の外に出たクラスタは反対側から出てくる（無限に続くように見せる）

let _cloudSpriteTexture = null;

// 外部画像を使わず、キャンバスで柔らかい円形のグラデーションテクスチャを生成する
function buildCloudSpriteTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

// 複数のスプライトをランダムに寄せ集めて、もこもこした積雲1つ分の塊を作る
function buildCloudCluster() {
  const group = new THREE.Group();
  const puffCount = 5 + Math.floor(Math.random() * 5);
  const scaleBase = 60 + Math.random() * 90;
  for (let i = 0; i < puffCount; i++) {
    const mat = new THREE.SpriteMaterial({ map: _cloudSpriteTexture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    const s = scaleBase * (0.55 + Math.random() * 0.6);
    sprite.scale.set(s * 1.6, s, 1);
    sprite.position.set(
      (Math.random() - 0.5) * scaleBase * 1.8,
      (Math.random() - 0.5) * scaleBase * 0.35,
      (Math.random() - 0.5) * scaleBase * 1.8
    );
    group.add(sprite);
  }
  return group;
}

function initClouds() {
  _cloudSpriteTexture = buildCloudSpriteTexture();
  EnvState.cloudGroup = new THREE.Group();
  EnvState.scene.add(EnvState.cloudGroup);
  EnvState.cloudClusters = [];

  for (let i = 0; i < CLOUD_MAX_CLUSTERS; i++) {
    const cluster = buildCloudCluster();
    const baseX = (Math.random() * 2 - 1) * CLOUD_FIELD_HALF_SIZE;
    const baseZ = (Math.random() * 2 - 1) * CLOUD_FIELD_HALF_SIZE;
    const altitude = EnvState.cloudAltitude + (Math.random() - 0.5) * 80;
    cluster.position.set(baseX, altitude, baseZ);
    EnvState.cloudGroup.add(cluster);
    EnvState.cloudClusters.push({ group: cluster, baseX, baseZ, driftX: 0, driftZ: 0 });
  }
  applyCloudCoverage();
}

// 雲量（0〜1）に応じて、あらかじめ用意したクラスタのうち何個を表示するか切り替える
// （雲量を変えるたびにジオメトリを作り直さずに済む）
function applyCloudCoverage() {
  const coverage = THREE.MathUtils.clamp(EnvState.env.cloudCoverage, 0, 1);
  const visibleCount = Math.round(CLOUD_MAX_CLUSTERS * coverage);
  EnvState.cloudClusters.forEach((c, i) => {
    c.group.visible = i < visibleCount;
  });
}

function updateClouds(dt) {
  if (!EnvState.cloudClusters.length) return;
  const windRad = THREE.MathUtils.degToRad(EnvState.env.windDirectionDeg);
  const speedMps = (EnvState.env.windSpeedKmh * 1000) / 3600;
  const vx = Math.cos(windRad) * speedMps;
  const vz = Math.sin(windRad) * speedMps;
  const box = CLOUD_FIELD_HALF_SIZE * 2;

  EnvState.cloudClusters.forEach((c) => {
    c.driftX += vx * dt;
    c.driftZ += vz * dt;
    const wrap = (base, drift) => (((base + drift + CLOUD_FIELD_HALF_SIZE) % box + box) % box) - CLOUD_FIELD_HALF_SIZE;
    c.group.position.x = wrap(c.baseX, c.driftX);
    c.group.position.z = wrap(c.baseZ, c.driftZ);
  });
}

// 昼夜の光に合わせて雲の色味を変える（03-sky.jsのupdateSkyForSunDirectionから呼ばれる）
function tintClouds(dayFactor, warmth) {
  if (!EnvState.cloudClusters.length) return;
  const base = new THREE.Color(0x1c2740).lerp(new THREE.Color(0xffffff), dayFactor);
  base.lerp(new THREE.Color(0xffb37a), warmth * 0.4 * dayFactor);
  EnvState.cloudClusters.forEach((c) => {
    c.group.children.forEach((sprite) => sprite.material.color.copy(base));
  });
}
