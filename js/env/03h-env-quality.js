// 03h-env-quality.js — 画質プリセット（パフォーマンス設定）
//
// 弱い端末でもコマ落ちしにくいように、地形・植生・街・雲の「どこまで実体化するか」と
// 解像度をまとめて3段階で切り替えられるようにする。既定は「高」で、これまでの
// 挙動（固定の実体化半径・devicePixelRatioそのまま）と完全に同じにしてある——
// 何もしなければ誰にも影響しない。
//
// **地形の近くの分割数（TERRAIN_LOD_STEPS[0]）はここでは触らない。**
// terrainSurfaceHeightAt()（木・建物の設置、脚の接地、モデル形状の当たり判定が
// みんな使う「地面の高さ」）は常にこの分割数で地形メッシュを補間する前提で
// 作られている。ここを画質で変えると、見えている地面の分割と当たり判定の格子が
// 食い違い、脚や当たり判定点が地面から浮いたりめり込んだりする。だから触るのは
// 実体化する**範囲**（遠くのタイルをそもそも作らない）と**解像度**だけにする。
const ENV_QUALITY_PRESETS = {
  high: { label: '高', distance: 1.0, pixelRatioCap: 2 },
  medium: { label: '中', distance: 0.6, pixelRatioCap: 1.5 },
  low: { label: '低', distance: 0.35, pixelRatioCap: 1 },
};

function envQualityPreset() {
  return ENV_QUALITY_PRESETS[EnvState.env.quality] || ENV_QUALITY_PRESETS.high;
}

// 画質を切り替える。実体化半径が変わる各系（地形・植生・街・雲）を、
// 次にカメラが動くのを待たず、その場で作り直す。
function applyEnvQuality(tier) {
  if (!ENV_QUALITY_PRESETS[tier]) return;
  EnvState.env.quality = tier;

  if (EnvState.renderer) {
    const cap = envQualityPreset().pixelRatioCap;
    EnvState.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
  }

  if (typeof terrainRebuildNow === 'function') terrainRebuildNow();
  if (typeof refreshVegetation === 'function') refreshVegetation(true);
  if (typeof refreshFarForest === 'function') refreshFarForest();
  if (typeof refreshCities === 'function') refreshCities();
  if (typeof rebuildClouds === 'function') rebuildClouds();
}
