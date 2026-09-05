// 04-clouds.js — 雲（ビルボードスプライトの塊を敷き詰め、風で流す）

// 600km四方のマップでは、原点まわりの数kmだけに雲を置くと空に浮いた板に見えてしまう。
// 雲原は「カメラを中心とした一定範囲」として扱い、外に出たクラスタは反対側から出てくる。
const CLOUD_MAX_CLUSTERS = 90;
const CLOUD_FIELD_HALF_SIZE = 30000; // カメラを中心とした60km四方

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
  // 数十km先からでも雲として見える大きさ（積雲1つで1〜2km規模）
  const scaleBase = 700 + Math.random() * 1100;
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
    const altitude = EnvState.cloudAltitude + (Math.random() - 0.5) * 900;
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

  // カメラを中心にラップさせるので、どこまで飛んでも雲が周囲に居続ける
  const cx = EnvState.camera.position.x, cz = EnvState.camera.position.z;
  const wrapRel = (v) => (((v + CLOUD_FIELD_HALF_SIZE) % box + box) % box) - CLOUD_FIELD_HALF_SIZE;

  EnvState.cloudClusters.forEach((c) => {
    c.driftX += vx * dt;
    c.driftZ += vz * dt;
    c.group.position.x = cx + wrapRel(c.baseX + c.driftX - cx);
    c.group.position.z = cz + wrapRel(c.baseZ + c.driftZ - cz);
  });
}

// 昼夜の光に合わせて雲の色味を変える（03-sky.jsのupdateSkyForSunDirectionから呼ばれる）
function tintClouds(dayFactor, warmth) {
  if (!EnvState.cloudClusters.length) return;
  const base = new THREE.Color(0x101828).lerp(new THREE.Color(0xffffff), dayFactor);
  base.lerp(new THREE.Color(0xffb37a), warmth * 0.4 * dayFactor);
  // ACESトーンマッピング（露出0.6）を通すと白でも灰色に沈むので、1.0を超える明るさを渡す
  base.multiplyScalar(1 + dayFactor * 0.45);
  EnvState.cloudClusters.forEach((c) => {
    c.group.children.forEach((sprite) => sprite.material.color.copy(base));
  });
}
