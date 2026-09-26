// 03m-shadows.js — 太陽の影
//
// 太陽（EnvState.sunLight）に影を落とさせる。影を描く範囲（影の地図）は見ている場所の
// まわりだけで、そこから外は影を描かない（遠くの影は1画素より小さく、描いても見えない）。
//   ・見ている場所 … 飛んでいるときは機体、そうでなければ視点の注視点
//   ・範囲と細かさは画質で変える（SHADOW_PRESETS。「低」では影を描かない）
//   ・影を落とすのは機体・建物・家・木・港・空港の建物・橋。受けるのは地面・舗装も含めた全部
//     （地面そのものは影を落とさない。起伏の影は日の当たり方＝面の向きで十分に出ていて、
//      影の地図の範囲の縁で山の影がぷつりと切れるほうが目立つため）
//   ・夜（太陽が沈んでいる）は描かない
// 影の地図の中心は、影の地図の1画素ぶんの格子に合わせて動かす。合わせないと、機体が
// 動くたびに影の縁が1画素の中で行ったり来たりして、ちらついて見える。

// halfM は影を描く範囲（中心から±m）の上限。実際の範囲は視点から中心までの距離で決める
// （SHADOW_RANGE_K 倍、SHADOW_RANGE_MIN_M 以上）。近くで機体を見ているときは狭く細かく、
// 街を遠くから見下ろしているときは広く。固定で±700mにしていたら、2048画素で1画素0.68mになり、
// 練習機の影がぼやけた塊にしか見えなかった
const SHADOW_PRESETS = {
  high: { mapSize: 2048, halfM: 900 },
  medium: { mapSize: 1024, halfM: 600 },
  low: null,
};
const SHADOW_RANGE_K = 0.9;
const SHADOW_RANGE_MIN_M = 250;
const SHADOW_FLAG_INTERVAL_S = 0.5;   // 影を落とす・受けるの印を付け直す間隔
const SHADOW_TREE_REACH_M = 400;      // 影の範囲からこれだけ外の木のタイルまで影を落とさせる
const SHADOW_MIN_SUN = 0.05;          // 太陽の強さ（sunLight.intensity/1.5）がこれ未満なら描かない
const SHADOW_BIAS_M = 0.05;           // 影の深さのずらし（m）。面が自分の影をかぶるしま模様を消す
const SHADOW_NORMAL_BIAS_M = 0.25;    // 面の向きへのずらし（m）

let _shadowFlagAt = -Infinity;
let _shadowOn = null;
let _shadowHalf = 0;
const _shadowCenter = new THREE.Vector3();
const _shadowDir = new THREE.Vector3();
const _shadowTmp = new THREE.Vector3();
const _shadowQ = new THREE.Quaternion();

function initShadows() {
  const r = EnvState.renderer, sun = EnvState.sunLight;
  if (!r || !sun) return;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  // 光の向きは「位置 → 狙う点」。狙う点を見ている場所へ動かすので、シーンに入れておく
  EnvState.scene.add(sun.target);
  // bias は影の地図の奥行き（数km）に対する割合なので、ここでは決めず updateShadows で
  // 「SHADOW_BIAS_M メートルぶん」に直して入れる。固定の -0.0004 だと奥行き7kmで2.8mになり、
  // 地面から1.5mの練習機の影がまるごと消えていた
  sun.shadow.normalBias = SHADOW_NORMAL_BIAS_M;
  sun.castShadow = false;
}

function shadowPreset() {
  if (EnvState.env.shadowsOn === false) return null;
  return SHADOW_PRESETS[EnvState.env.quality] || null;
}

// 毎フレーム（描く直前）。影の地図を見ている場所へ合わせる
function updateShadows() {
  const sun = EnvState.sunLight;
  if (!sun || !EnvState.renderer || !EnvState.renderer.shadowMap.enabled) return;
  const preset = shadowPreset();
  const on = !!preset && sun.intensity / 1.5 >= SHADOW_MIN_SUN;
  if (on !== _shadowOn) {
    _shadowOn = on;
    sun.castShadow = on;
    _shadowFlagAt = -Infinity;
  }
  if (!on) {
    // 影を描かないときは、光の狙う点を原点に戻す（空の側は「位置＝向き×500」で光の向きを決めている）
    if (sun.target.position.lengthSq() > 0) {
      sun.target.position.set(0, 0, 0);
      sun.target.updateMatrixWorld();
      if (EnvState.sunDirection) sun.position.copy(EnvState.sunDirection).multiplyScalar(500);
    }
  } else {
    const sh = sun.shadow;
    if (sh.mapSize.x !== preset.mapSize) {
      sh.mapSize.set(preset.mapSize, preset.mapSize);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
    }
    const f = EnvState.flight;
    if (f && f.active && f.aircraft) _shadowCenter.copy(f.aircraft.group.position);
    else if (EnvState.orbitControls) _shadowCenter.copy(EnvState.orbitControls.target);
    else _shadowCenter.copy(EnvState.camera.position);
    // 範囲は視点の遠さで決め、細かく変わりすぎないよう50m刻みにする
    const camD = EnvState.camera.position.distanceTo(_shadowCenter);
    const half = Math.min(preset.halfM, Math.max(SHADOW_RANGE_MIN_M, Math.ceil(camD * SHADOW_RANGE_K / 50) * 50));
    _shadowHalf = half;
    // 影の地図の1画素の格子に合わせる（光の向きに直交する面の上で）
    _shadowDir.copy(EnvState.sunDirection || sun.position).normalize();
    _shadowQ.setFromUnitVectors(_shadowDir, new THREE.Vector3(0, 0, 1));
    const texel = (half * 2) / preset.mapSize;
    _shadowTmp.copy(_shadowCenter).applyQuaternion(_shadowQ);
    _shadowTmp.x = Math.round(_shadowTmp.x / texel) * texel;
    _shadowTmp.y = Math.round(_shadowTmp.y / texel) * texel;
    _shadowTmp.applyQuaternion(_shadowQ.invert());
    // 高く飛んでいても地面の影まで届くよう、奥行きは高さぶん伸ばす
    const reach = 3000 + Math.max(_shadowCenter.y, 0) * 1.5;
    sun.target.position.copy(_shadowTmp);
    sun.position.copy(_shadowTmp).addScaledVector(_shadowDir, reach);
    sun.target.updateMatrixWorld();
    const cam = sh.camera;
    if (cam.right !== half || cam.far !== reach * 2) {
      cam.left = -half; cam.right = half;
      cam.top = half; cam.bottom = -half;
      cam.near = 1; cam.far = reach * 2;
      cam.updateProjectionMatrix();
      sh.bias = -SHADOW_BIAS_M / (reach * 2);
    }
  }
  const now = performance.now() / 1000;
  if (now - _shadowFlagAt >= SHADOW_FLAG_INTERVAL_S) {
    _shadowFlagAt = now;
    applyShadowFlags(on, preset);
  }
}

// 影を落とす・受けるの印を付ける。作り直された物（地形のタイル・街・木のタイル）にも付くよう、定期的に見直す
function applyShadowFlags(on, preset) {
  const set = (obj, cast, recv) => {
    if (!obj) return;
    obj.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh)) return;
      const m = o.material;
      const flat = !m || m.transparent || m.depthWrite === false;
      o.castShadow = on && cast && !flat && !(m && m.polygonOffset);
      o.receiveShadow = on && recv && !flat;
    });
  };
  set(EnvState.terrainGroup, false, true);
  set(EnvState.cityGroup, true, true);
  set(EnvState.portGroup, true, true);
  set(EnvState.roadGroup, true, true);
  if (EnvState.builtAirports) for (const e of EnvState.builtAirports.values()) set(e.group || e, true, true);
  const f = EnvState.flight;
  if (f && f.aircraft) set(f.aircraft.group, true, true);
  // 木は影の範囲の近くのタイルだけ（タイルは視錐台で切っていないので、全部に落とさせると重い）
  if (EnvState.treeGroup) {
    const R = preset ? _shadowHalf + SHADOW_TREE_REACH_M : 0;
    for (const t of EnvState.treeGroup.children) {
      if (!t.isInstancedMesh) continue;
      if (t === EnvState.forestFarMesh) { t.castShadow = false; t.receiveShadow = false; continue; }
      const cx = t.position.x + TREE_TILE_SIZE / 2, cz = t.position.z + TREE_TILE_SIZE / 2;
      const near = on && Math.hypot(cx - _shadowCenter.x, cz - _shadowCenter.z) < R;
      t.castShadow = near;
      t.receiveShadow = on;
    }
  }
}
