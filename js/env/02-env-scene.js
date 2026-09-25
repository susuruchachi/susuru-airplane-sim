// 02-env-scene.js — レンダラー・カメラ・OrbitControls・リサイズ・描画ループ

// 同じ面に重ねて描くもの（滑走路の舗装・標示、着陸灯の照り返し）を、深度だけ手前へ引く。
//
// 対数深度バッファでは深度をフラグメントシェーダーが書くので、polygonOffset は効かない。
// そのため以前は舗装を地面の1.0m上、標示を1.4m上に浮かせて重なりを避けていたが、
// 飛行の物理は地面の高さで接地するので、車輪が舗装に1〜1.4m埋まって見えていた。
// いまは全部を地面ぴったりに敷き、深度のほうを手前へ寄せる。寄せ方は polygonOffset と同じく2つの和：
//   pull     … カメラまでの距離の pull 倍。遠くで粗いLODの地形が平らな空港より上に出るぶん
//              （最大4.7m）を抑える。50m先では1cm未満
//   slopePx  … 画面1画素ぶんの深度の変化の slopePx 倍。低い角度で見ると1画素が何mもの奥行きに
//              またがり、同じ面どうしでも補間の誤差で前後が入れ替わる（200m先を1.1°で見ると
//              地形が整地エリアを突き抜けた）。画素単位なので、面に立っている物（車輪）が
//              隠れるのも最大でその画素数ぶんだけ
//   absM     … 距離によらない数mm。大きな三角形はカメラのすぐ近くで奥行きの補間が
//              三角形の大きさに比例してずれる（4km角の整地エリアで約1mm）ので、
//              距離の倍率だけだと足元で地形に負けた
// 対数深度が使えない環境では、従来どおり polygonOffset が効く。
function applyDepthPull(material, pull, rank, slopePx, absM) {
  material.polygonOffset = true;
  material.polygonOffsetFactor = -rank;
  material.polygonOffsetUnits = -rank;
  const P = pull.toExponential(4);
  const S = (slopePx === undefined ? rank * 0.5 : slopePx).toFixed(3);
  const A = (absM === undefined ? 0.004 + rank * 0.003 : absM).toFixed(4);
  // 深度 = log2(1 + w) * logDepthBufFC / 2（three.js の logdepthbuf_fragment と同じ式）。
  // w をカメラ寄りに縮めてから深度を書き直す
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>', [
      '#include <logdepthbuf_fragment>',
      '#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )',
      '  {',
      '    float dpD = log2( vFragDepth ) * logDepthBufFC * 0.5;',
      '    float dpSlope = 0.0;',
      '  #if __VERSION__ >= 300',
      '    dpSlope = max( abs( dFdx( dpD ) ), abs( dFdy( dpD ) ) );',
      '  #endif',
      `    float dpW = max( ( vFragDepth - 1.0 ) * ( 1.0 - ${P} ) - ${A}, 0.0 );`,
      `    gl_FragDepthEXT = log2( 1.0 + dpW ) * logDepthBufFC * 0.5 - ${S} * dpSlope;`,
      '  }',
      '#endif',
    ].join('\n'));
  };
  material.customProgramCacheKey = () => `depthPull:${P}:${S}:${A}`;
  return material;
}

// 太陽・月・星を「無限遠」に描く（深度を最遠の1.0にする）。
//
// 天球はカメラに追従させて18〜24km先に置いてあるので、ふつうに深度を付けると、
// それより遠い山や雲底より**手前**になり、低い太陽や月が地面・雲底を透かして見えた。
// 深度を最遠に揃えれば、地形でも雲底でも、描かれているものの向こうにしか出ない。
// 空のドーム（THREE.Sky）も最遠に描かれ深度を書かないので、それより後に描くこと（renderOrder）。
function applyAtInfinity(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <logdepthbuf_vertex>', [
      '#include <logdepthbuf_vertex>',
      '#if !defined( USE_LOGDEPTHBUF_EXT )',
      '  gl_Position.z = gl_Position.w;',
      '#endif',
    ].join('\n'));
    shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>', [
      '#include <logdepthbuf_fragment>',
      '#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )',
      '  gl_FragDepthEXT = 1.0;',
      '#endif',
    ].join('\n'));
  };
  material.customProgramCacheKey = () => 'atInfinity';
  material.depthWrite = false;
  return material;
}

function initEnvScene() {
  const canvas = document.getElementById('envViewport');
  const centerEl = document.getElementById('envCenter');

  // 対数深度バッファ。near=5m のまま 220km 先まで描くと、通常の深度バッファでは
  // 数十km先で数十mの高低差が潰れてしまい、海面(y=0)が標高10mの島を覆い隠す。
  // 対数深度なら遠方でも精度が保たれるので、低地の島も滑走路の路面標識も破綻しない。
  EnvState.renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, logarithmicDepthBuffer: true,
  });
  EnvState.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  EnvState.renderer.setSize(centerEl.clientWidth, centerEl.clientHeight);
  EnvState.renderer.outputEncoding = THREE.sRGBEncoding;
  // 大気散乱シェーダーは1.0を超える明るさを返すため、トーンマッピング無しだと
  // 空の上部が白飛びし、地表も露出オーバーになる（Three.jsのSky公式サンプルと同じ設定）
  EnvState.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  EnvState.renderer.toneMappingExposure = 0.6;

  EnvState.scene = new THREE.Scene();

  // 対数深度バッファを使っているので near を詰めても遠方の精度が落ちない。
  // far は600km四方のマップを見渡せる距離。これ以上伸ばしても大気の霞で見えない。
  EnvState.camera = new THREE.PerspectiveCamera(
    55, centerEl.clientWidth / centerEl.clientHeight, 1, 260000
  );
  EnvState.camera.position.set(0, 60, 220);

  EnvState.orbitControls = new THREE.OrbitControls(EnvState.camera, EnvState.renderer.domElement);
  EnvState.orbitControls.enableDamping = true;
  EnvState.orbitControls.dampingFactor = 0.08;
  EnvState.orbitControls.target.set(0, 40, 0);
  EnvState.orbitControls.minDistance = 5;
  EnvState.orbitControls.maxDistance = 400000;
  EnvState.orbitControls.maxPolarAngle = Math.PI * 0.495; // 地面の下を覗き込みにくくする
  EnvState.orbitControls.update();

  EnvState.clock = new THREE.Clock();

  window.addEventListener('resize', onEnvWindowResize);
  window.addEventListener('orientationchange', () => setTimeout(onEnvWindowResize, 250));
}

function onEnvWindowResize() {
  const centerEl = document.getElementById('envCenter');
  const w = centerEl.clientWidth, h = centerEl.clientHeight;
  if (!w || !h) return;
  EnvState.camera.aspect = w / h;
  EnvState.camera.updateProjectionMatrix();
  EnvState.renderer.setSize(w, h);
}

function animateEnv() {
  requestAnimationFrame(animateEnv);
  const dt = Math.min(EnvState.clock.getDelta(), 0.1);
  EnvState.orbitControls.update();
  updateFlight(dt);     // 機体を進める。カメラも地形の読み込み基準もここで決まる
  updateWeather(dt);    // 光と霧に効くので、昼夜サイクルより先に決める
  updateDayNightCycle(dt);
  updateTerrain();      // カメラが動いたぶんだけ地形タイルのLODを入れ替える
  updateVegetation();
  updateFarForest();    // 遠くの森（木立の塊）。木より広い範囲を受け持つ
  updateRoads();        // 道路。間引きがカメラ距離で決まるので近づいたら作り直す
  updateCities();       // 街は1フレームに1つずつ建てる（1つで30〜42msかかる）
  updateSea(dt);
  updateClouds(dt);
  updateWindsock();
  updatePlaceLabels();
  updateMinimap();
  updateEnvWorldReadout();
  if (typeof updateFpsReadout === 'function') updateFpsReadout();
  if (typeof updateSound === 'function') updateSound(dt);  // 機体の状態から音を合成する
  if (typeof updateShadows === 'function') updateShadows();  // 影の地図を見ている場所へ合わせる
  EnvState.renderer.render(EnvState.scene, EnvState.camera);
}
