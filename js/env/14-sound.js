// 14-sound.js — 音。エンジン各種の音を、機体の状態から**その場で合成して**鳴らす。
//
// **なぜ音のファイルを持たないか。**
// このページはビルド無し・CDNが落ちても動くように作ってあり、音源ファイルを置くと
// 「エンジン種別×出力×距離」のぶんだけ用意して読み込むことになる。地形もテクスチャも
// その場で作っているのと同じやり方で、音も Web Audio の発振器と雑音から組み立てる。
// 出力レバーや距離に合わせて連続して変わるので、繋ぎ目も無い。
//
// **ブラウザは、人が触るまで音を出せない**（自動再生の制限）。だから AudioContext は
// 起動時ではなく、最初のクリック／キー入力／「飛ぶ」ボタンで作る（soundEnsure）。
//
// **音の作りは OfflineAudioContext でも組めるように書いてある**（buildEngineVoice が
// EnvState を見ない）。tools 側から「この種別・この出力で、どの帯域にどれだけ
// 音が出るか」を実際にレンダリングして測れる。

// 全体の音量（0〜1）。既定はやや控えめ。
const SOUND_VOLUME_DEFAULT = 0.7;
// 距離の基準(m)。ここまでは音量がほぼ落ちない。実機の感覚に合わせて、
// 追従視点（機体から数十m）でしっかり聞こえ、1kmでははっきり遠くなるように。
const SOUND_REF_M = 30;
// 空気は高い音から先に吸うので、遠いほど低い音だけが残る。
const SOUND_AIR_NEAR_HZ = 17000;  // 目の前のときに通す高さ
const SOUND_AIR_FAR_HZ = 300;     // どんなに遠くても残る低い音
const SOUND_AIR_SPAN_M = 450;     // この距離ごとに e 分の1に減る
// 音速(m/s)。ドップラーに使う。
const SOUND_SPEED_MPS = 340;
// ドップラーの効きの上限（行き過ぎると音痴になる）
const SOUND_DOPPLER_MIN = 0.55;
const SOUND_DOPPLER_MAX = 1.9;
// **ドップラーの「耳の速さ」は、カメラの見かけの動きから作ってはいけない。**
//
// 最初は「機体の速度 − カメラの速度」で出していた。式は正しいのだが、カメラの速度を
// 毎フレームの位置の引き算で作っていたので、**スワイプで視点を回しただけで耳が秒速
// 数百mで飛んでいることになり**、音程がグワグワ揺れた——実測（ジェット機を等速で
// 飛ばしたまま1秒で半周スワイプ）で **2.91半音**。機体の速度は1ノットも変わっていない。
// ジェットで特に目立つのは、ファンのキーンが**純音**だから（雑音には音程が無いので
// 揺れても分からない。ロケットやプロペラで気にならなかったのはそのため）。
//
// ここから2回まわり道をした。
//   1) カメラの速度をやめて機体の速度だけにした → 離れた視点で **14.05半音**と悪化。
//      半周まわるあいだに視線の向きが速度ベクトルをまたぐので、近づく成分が
//      +160から-160まで振れてしまう。
//   2) 距離そのものの変化率にした → スワイプは0.32半音まで直ったが、
//      **ズームすると距離が変わるので音程が動いた**（指で寄っただけなのに）。
//
// 答えは「**カメラが何に繋がれているか**」を見ること。見かけの動きではなく、
// 耳が乗っている乗り物の速度を使う——ゲームの音で普通に使われる考え方。
//   追従・機体固定・コックピット・周回 … カメラは機体に繋がれている（周回も
//      毎フレーム機体を中心に置き直している）。耳は機体と一緒に飛んでいるので
//      相対速度は0 → ドップラーは1。同乗していれば自分のエンジンの音程は変わらない。
//   自由                            … カメラは世界に置いてある。耳は止まっている
//      ので、機体の速度の視線方向の成分がそのままドップラーになる。
// どちらにも「指で動かしたぶん」は入らないので、**スワイプもズームも効かない**。
const SOUND_DOPPLER_TAU = 0.25;   // 距離の変化率を均す時定数（コマ間の荒れを取る）
// ドップラー比が1秒で変われる量。真横を通り過ぎる瞬間に比が裏返るので、
// これが無いと段差が「プツッ」と聞こえる。
const SOUND_DOPPLER_SLEW = 1.2;
// パラメータを動かすときの追従の速さ（秒）。小さいとプツプツ鳴る。
const SOUND_SMOOTH_S = 0.05;
// 雑音のもと。1秒だと繰り返しの周期が耳につくので少し長く取る。
const SOUND_NOISE_S = 2.7;

// --- 雑音のもと ---------------------------------------------------------------
//
// 白色雑音をそのまま使うと高い音ばかりのシャーという音になる。エンジンの音は
// 低いほうが強いので、**1/f に近い雑音（ピンクノイズ）**を作っておく。
// Voss-McCartney ではなく、白色雑音に一次のローパスを何段か掛ける簡易版。
// 段ごとに時定数を変えると、だいたい -3dB/oct に乗る。
function soundBuildNoiseBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * SOUND_NOISE_S);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // 時定数の違う一次ローパスを6段ぶん足し合わせる（1/f 近似）
  const k = [0.99886, 0.99332, 0.96900, 0.86650, 0.55000, 0.00000];
  const w = [0.0555179, 0.0750759, 0.1538520, 0.3104856, 0.5329522, -0.0168980];
  const s = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    let sum = 0;
    for (let j = 0; j < 6; j++) {
      s[j] = k[j] * s[j] + white * w[j];
      sum += s[j];
    }
    d[i] = sum * 0.22 + white * 0.03;
  }
  // 端を繋いでループの継ぎ目を消す（ここが鳴ると「プツ」と聞こえる）
  const fade = Math.floor(ctx.sampleRate * 0.02);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * t + d[len - fade + i] * (1 - t);
  }
  return buf;
}

// --- エンジンの音 -------------------------------------------------------------
//
// 種別ごとに「何が鳴っているか」が違うので、作りも変える。数字は実機の音の
// 成り立ちに合わせてある。
//
//   プロペラ … いちばん強いのは**羽根が空気を叩く音**（翼通過周波数）。
//              回転数 ÷ 60 × 羽根の枚数。セスナで2,400rpm・2枚＝80Hz、
//              アイドルの700rpmで23Hz。だから出力で25〜95Hzを行き来する。
//              倍音が多い鋸波を、基音の4倍あたりで切って使う。
//   ジェット  … 低い「ゴー」（排気が空気と混ざる雑音。300〜500Hzが山）と、
//              高い「キーン」（ファンの翼通過音。大型機で1kHz前後＋その倍音）。
//              **キーンは純音ではない。** 実機のファン音は、翼通過の基音と
//              その倍音に、同じ高さの狭い帯域の雑音（羽根の間の流れの乱れ）が
//              乗った「かすれた」音。三角波を1本だけ鳴らすと、それはもう
//              笛（ピー）であってジェットではない——実測で、山のするどさ
//              （いちばん高い点÷まわりの中央値）が**8,586倍**だった
//              （ロケットの広い帯域は2倍）。倍音と狭帯域雑音を足して、
//              山をなだらかにする。
//   AB付き    … ジェットに、点いたときだけ**腹に来る低い唸り**を足す。
//   ロケット  … ほとんど低い雑音。150Hz以下が主で、上のほうに「バチバチ」が乗る。
const SOUND_ENGINE_LOOK = {
  prop: {
    // 翼通過周波数（アイドル〜全開）
    toneFrom: 25, toneTo: 95, toneType: 'sawtooth', toneGain: 0.55,
    // 鋸波を切る高さ（基音の何倍か）
    toneCutMul: 4.5,
    // 風を切る雑音
    noiseHz: 700, noiseQ: 0.6, noiseGain: 0.16,
    whineFrom: 0, whineTo: 0, whineGain: 0,
    rumbleGain: 0, level: 0.62,
  },
  jet: {
    toneFrom: 0, toneTo: 0, toneType: 'sine', toneGain: 0,
    toneCutMul: 4,
    noiseHz: 340, noiseQ: 0.7, noiseGain: 0.75,
    // キーン（翼通過の基音・倍音・同じ高さのかすれ）
    whineFrom: 700, whineTo: 3000,
    whineGain: 0.016,    // 基音の純音ぶん（小さく。これを上げると笛になる）
    whineHarm: 0.55,     // 倍音ぶん（基音に対する割合）
    whineRasp: 0.7,      // 同じ高さの狭い帯域の雑音（かすれ）
    whineRaspQ: 7,       // 狭いほど音程がはっきりする（広げるとかすれが増える）
    rumbleGain: 0, level: 1.0,
  },
  jet_ab: {
    toneFrom: 0, toneTo: 0, toneType: 'sine', toneGain: 0,
    toneCutMul: 4,
    noiseHz: 300, noiseQ: 0.7, noiseGain: 0.85,
    whineFrom: 700, whineTo: 3200,
    whineGain: 0.016, whineHarm: 0.55, whineRasp: 0.7, whineRaspQ: 7,
    rumbleGain: 0.7, level: 1.0,
  },
  rocket: {
    toneFrom: 0, toneTo: 0, toneType: 'sine', toneGain: 0,
    toneCutMul: 4,
    noiseHz: 150, noiseQ: 0.45, noiseGain: 1.15,
    whineFrom: 0, whineTo: 0, whineGain: 0,
    rumbleGain: 0.8, level: 0.95,
  },
};
// AB・ロケットの「腹に来る低い唸り」を通す高さ
const SOUND_RUMBLE_HZ = 120;
// **聞こえない超低音は切る。** ピンクノイズは低いほうほど強いので、そのまま
// ローパスに通すと20Hz付近に山ができる。実測（ロケット全開をFFTで見て）で
// エネルギーの山が22Hzに立ち、波形の尖頭が2.48——**1.0を大きく超えて割れて**
// いた。人が聞けるのは20Hzあたりからで、スマホやノートのスピーカーは
// 100Hz以下をほとんど鳴らせない。鳴らないところに音量を使うだけ損なので切る。
const SOUND_SUBSONIC_HZ = 45;

// エンジン1種別ぶんの音を組む。
// **EnvState を見ない**ので、OfflineAudioContext でも同じものが組める（測るときに使う）。
//   ctx       … AudioContext または OfflineAudioContext
//   dest      … 繋ぎ先（マスターの GainNode など）
//   kind      … 'prop' | 'jet' | 'jet_ab' | 'rocket'
//   noiseBuf  … soundBuildNoiseBuffer の返り値（使い回す）
function buildEngineVoice(ctx, dest, kind, noiseBuf) {
  const look = SOUND_ENGINE_LOOK[kind] || SOUND_ENGINE_LOOK.jet;
  // 音の大きさは**2段に分けて**持つ。
  //   body … 出力レバーぶん（エンジンがどれだけ吹いているか）
  //   out  … 距離ぶん（どれだけ遠いか・何基あるか）
  // 1つの gain に両方を掛けると、片方を更新するたびにもう片方を読み直すことになり、
  // setTargetAtTime の途中の値を拾って音量がふらつく。
  const body = ctx.createGain();
  body.gain.value = 0;
  // 聞こえない超低音を落とす（SOUND_SUBSONIC_HZ の説明）
  const sub = ctx.createBiquadFilter();
  sub.type = 'highpass';
  sub.frequency.value = SOUND_SUBSONIC_HZ;
  sub.Q.value = 0.7;
  // 遠くなるほど高い音が減る（空気の吸収）
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = SOUND_AIR_NEAR_HZ;
  const out = ctx.createGain();
  out.gain.value = 1;
  body.connect(sub).connect(air).connect(out).connect(dest);

  const parts = {};

  // 羽根が空気を叩く音（プロペラ）
  if (look.toneGain > 0) {
    const osc = ctx.createOscillator();
    osc.type = look.toneType;
    osc.frequency.value = look.toneFrom;
    const cut = ctx.createBiquadFilter();
    cut.type = 'lowpass';
    cut.frequency.value = look.toneFrom * look.toneCutMul;
    cut.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = look.toneGain;
    osc.connect(cut).connect(g).connect(body);
    parts.tone = { osc, cut, gain: g };
  }

  // 排気や風の雑音
  if (look.noiseGain > 0) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = look.noiseHz;
    bp.Q.value = look.noiseQ;
    const g = ctx.createGain();
    g.gain.value = look.noiseGain;
    src.connect(bp).connect(g).connect(body);
    parts.noise = { src, bp, gain: g };
  }

  // ファンのキーン（ジェット）。基音＋倍音＋同じ高さのかすれ（狭帯域の雑音）。
  // 三角波1本では笛になってしまう（SOUND_ENGINE_LOOK の説明を参照）。
  if (look.whineGain > 0) {
    const oscs = [];
    const rasps = [];
    // 基音と、その2倍・3倍。倍音は上へ行くほど弱く。
    for (let h = 1; h <= 3; h++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = look.whineFrom * h;
      const g = ctx.createGain();
      g.gain.value = look.whineGain * (h === 1 ? 1 : Math.pow(look.whineHarm || 0, h - 1));
      osc.connect(g).connect(body);
      oscs.push({ osc, gain: g, mul: h, base: g.gain.value });
    }
    // かすれ。同じ高さに狭い帯域の雑音を重ねると、純音が「息の混じった音」になる。
    if (look.whineRasp > 0) {
      for (let h = 1; h <= 2; h++) {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf; src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = look.whineFrom * h;
        bp.Q.value = look.whineRaspQ || 10;
        const g = ctx.createGain();
        g.gain.value = look.whineRasp * (h === 1 ? 1 : 0.6);
        src.connect(bp).connect(g).connect(body);
        rasps.push({ src, bp, gain: g, mul: h, base: g.gain.value });
      }
    }
    parts.whine = { oscs, rasps };
  }

  // 腹に来る低い唸り（AB・ロケット）
  if (look.rumbleGain > 0) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = SOUND_RUMBLE_HZ;
    lp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(lp).connect(g).connect(body);
    parts.rumble = { src, lp, gain: g, max: look.rumbleGain };
  }

  const voice = {
    kind, look, body, sub, air, out, parts,
    // 何基ぶんか（同じ種別のエンジンの数で音量が増える）
    countGain: 1,
    doppler: 1,
    started: false,
    // いま出ている出力（0〜1）と、アフターバーナーの点き具合（0〜1）
    setPower(lever, ab, when, smooth) {
      const t = when === undefined ? ctx.currentTime : when;
      const tau = smooth === undefined ? SOUND_SMOOTH_S : smooth;
      const p = Math.max(Math.min(lever, 1), 0);
      const a = Math.max(Math.min(ab || 0, 1), 0);
      // 出力が上がるほど大きく。0では完全に消す（止めたエンジンは鳴らない）。
      const lv = p <= 0.004 ? 0 : look.level * (0.12 + 0.88 * p);
      soundRamp(body.gain, lv, t, tau);
      if (parts.tone) {
        const hz = (look.toneFrom + (look.toneTo - look.toneFrom) * p) * voice.doppler;
        soundRamp(parts.tone.osc.frequency, hz, t, tau);
        soundRamp(parts.tone.cut.frequency, hz * look.toneCutMul, t, tau);
      }
      if (parts.noise) {
        soundRamp(parts.noise.bp.frequency, look.noiseHz * voice.doppler, t, tau);
        // 絞ったときは雑音も少し狭くする（アイドルのジェットは「シュー」に寄る）
        soundRamp(parts.noise.gain.gain, look.noiseGain * (0.45 + 0.55 * p), t, tau);
      }
      if (parts.whine) {
        const hz = (look.whineFrom + (look.whineTo - look.whineFrom) * p) * voice.doppler;
        const amt = 0.2 + 0.8 * p;
        for (const o of parts.whine.oscs) {
          soundRamp(o.osc.frequency, hz * o.mul, t, tau);
          soundRamp(o.gain.gain, o.base * amt, t, tau);
        }
        for (const r of parts.whine.rasps) {
          soundRamp(r.bp.frequency, hz * r.mul, t, tau);
          soundRamp(r.gain.gain, r.base * amt, t, tau);
        }
      }
      if (parts.rumble) {
        // ロケットは出力そのまま、AB付きは点いたぶんだけ
        const amt = kind === 'rocket' ? p : a;
        soundRamp(parts.rumble.gain.gain, parts.rumble.max * amt, t, tau);
        soundRamp(parts.rumble.lp.frequency, SOUND_RUMBLE_HZ * voice.doppler, t, tau);
      }
    },
    // 音源までの距離(m)。遠いほど小さく、高い音から先に減る。
    setDistance(distM, when, smooth) {
      const t = when === undefined ? ctx.currentTime : when;
      const tau = smooth === undefined ? SOUND_SMOOTH_S : smooth;
      const d = Math.max(distM, 0);
      soundRamp(air.frequency,
        SOUND_AIR_FAR_HZ + (SOUND_AIR_NEAR_HZ - SOUND_AIR_FAR_HZ) * Math.exp(-d / SOUND_AIR_SPAN_M),
        t, tau);
      const g = soundDistanceGain(d) * voice.countGain;
      soundRamp(out.gain, g, t, tau);
      return g;
    },
    // ドップラー比（1＝そのまま、>1＝近づいて高く）。次の setPower で効く。
    setDoppler(ratio) {
      voice.doppler = Math.max(Math.min(ratio, SOUND_DOPPLER_MAX), SOUND_DOPPLER_MIN);
    },
    start(when) {
      if (voice.started) return;
      voice.started = true;
      const t = when === undefined ? ctx.currentTime : when;
      if (parts.tone) parts.tone.osc.start(t);
      if (parts.whine) {
        for (const o of parts.whine.oscs) o.osc.start(t);
        for (const r of parts.whine.rasps) r.src.start(t);
      }
      if (parts.noise) parts.noise.src.start(t);
      if (parts.rumble) parts.rumble.src.start(t);
    },
    stop(when) {
      const t = when === undefined ? ctx.currentTime : when;
      if (parts.tone) parts.tone.osc.stop(t);
      if (parts.whine) {
        for (const o of parts.whine.oscs) o.osc.stop(t);
        for (const r of parts.whine.rasps) r.src.stop(t);
      }
      if (parts.noise) parts.noise.src.stop(t);
      if (parts.rumble) parts.rumble.src.stop(t);
    },
  };
  return voice;
}

// --- 風切音 ---------------------------------------------------------------
//
// エンジンを全部止めても（グライダーやアイドル降下でも）、空気を切って飛んでいる
// 音は残る。実機のそれは風防・胴体まわりの乱流音で、**強さは動圧（0.5・ρ・v²）に
// 比例する**——速いほど、そして空気が濃い（低空の）ほど強い。同じ対気速度でも
// 高空では薄い空気のぶん静かになる、というところまでちゃんと効かせる。
const SOUND_WIND_REF_MPS = 170;     // この対気速度・海面高度で「1.0」になるよう合わせる基準
const SOUND_WIND_REF_Q = 0.5 * 1.225 * SOUND_WIND_REF_MPS * SOUND_WIND_REF_MPS;
const SOUND_WIND_GAIN = 0.62;
// 動圧の比をそのまま音量に使うと、低速でも唐突に大きくなる（動圧は速さの2乗な
// ので、比自体はすでに緩やかに立ち上がるが、耳の感じ方に合わせてもう一段
// 圧縮する）。平方根寄りのべきにすると、離陸滑走のあたりから自然に育つ。
const SOUND_WIND_GAIN_POW = 0.62;
const SOUND_WIND_HZ_FROM = 260;     // 遅いときの、こもった風切り
const SOUND_WIND_HZ_TO = 2600;      // 速いときの、鋭いヒューという音
const SOUND_WIND_Q = 0.55;          // 帯域の広さ（狭いと笛に近づく。風なので広く保つ）

// **EnvState を見ない**（buildEngineVoice と同じ理由。オフラインで測れるように）。
function buildWindVoice(ctx, dest, noiseBuf) {
  const body = ctx.createGain();
  body.gain.value = 0;
  const sub = ctx.createBiquadFilter();
  sub.type = 'highpass';
  sub.frequency.value = 70;      // 風切音に地響きのような低さは無い
  sub.Q.value = 0.6;
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = SOUND_AIR_NEAR_HZ;
  const out = ctx.createGain();
  out.gain.value = 1;
  body.connect(sub).connect(air).connect(out).connect(dest);

  const src = ctx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = SOUND_WIND_HZ_FROM;
  bp.Q.value = SOUND_WIND_Q;
  src.connect(bp).connect(body);

  const voice = {
    kind: 'wind', body, sub, air, out, bp, src,
    doppler: 1, started: false,
    // qNorm ＝ 動圧 ÷ SOUND_WIND_REF_Q（基準の動圧に対する比）
    setSpeed(qNorm, when, smooth) {
      const t = when === undefined ? ctx.currentTime : when;
      const tau = smooth === undefined ? SOUND_SMOOTH_S : smooth;
      const p = THREE.MathUtils.clamp(qNorm, 0, 4);
      const lv = SOUND_WIND_GAIN * Math.pow(p, SOUND_WIND_GAIN_POW);
      soundRamp(body.gain, lv, t, tau);
      const hz = (SOUND_WIND_HZ_FROM + (SOUND_WIND_HZ_TO - SOUND_WIND_HZ_FROM) * Math.min(p, 1.6))
        * voice.doppler;
      soundRamp(bp.frequency, hz, t, tau);
    },
    setDistance(distM, when, smooth) {
      const t = when === undefined ? ctx.currentTime : when;
      const tau = smooth === undefined ? SOUND_SMOOTH_S : smooth;
      const d = Math.max(distM, 0);
      soundRamp(air.frequency,
        SOUND_AIR_FAR_HZ + (SOUND_AIR_NEAR_HZ - SOUND_AIR_FAR_HZ) * Math.exp(-d / SOUND_AIR_SPAN_M),
        t, tau);
      const g = soundDistanceGain(d);
      soundRamp(out.gain, g, t, tau);
      return g;
    },
    setDoppler(ratio) {
      voice.doppler = Math.max(Math.min(ratio, SOUND_DOPPLER_MAX), SOUND_DOPPLER_MIN);
    },
    start(when) {
      if (voice.started) return;
      voice.started = true;
      src.start(when === undefined ? ctx.currentTime : when);
    },
    stop(when) { src.stop(when === undefined ? ctx.currentTime : when); },
  };
  return voice;
}

// 距離による音量の落ち方の「形」。1/(1+d/基準) ——「倍の距離で半分」より緩く、
// 近くでは頭打ちになる（目の前で無限に大きくならない）。基準を変えれば、
// エンジン（数十m）から雷鳴（数km）まで同じ形で使い回せる。
function soundFalloff(distM, refM) {
  return refM / (refM + Math.max(distM, 0));
}

function soundDistanceGain(distM) {
  return soundFalloff(distM, SOUND_REF_M);
}

// パラメータをなめらかに動かす。**値を直接代入してはいけない**——
// 代入すると次のブロックの頭で階段状に飛び、「プツプツ」と鳴る。
function soundRamp(param, value, when, tau) {
  if (!isFinite(value)) return;
  if (tau > 0) param.setTargetAtTime(value, when, tau);
  else param.setValueAtTime(value, when);
}

// マスター（音量つまみ＋リミッター）を組む。
// **リミッターは必ず要る。** エンジンは何基でも積めるので、音は足し算で
// いくらでも大きくなる。1.0を超えたぶんはそのまま歪むので、最後に潰す。
// DynamicsCompressorNode を、比を大きく・閾値を高くしてリミッターとして使う。
function soundBuildMaster(ctx, dest, volume) {
  const gain = ctx.createGain();
  gain.gain.value = volume === undefined ? SOUND_VOLUME_DEFAULT : volume;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;   // ここから上を潰す
  limiter.knee.value = 3;
  limiter.ratio.value = 20;       // ほぼ頭打ち
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  gain.connect(limiter).connect(dest || ctx.destination);
  return { gain, limiter, input: gain };
}

// --- 衝撃波の音（ソニックブーム）---------------------------------------------
//
// 実機の記録に近い形：**立ち上がりはほぼ一瞬**（衝撃波そのものなので）、
// そこから周波数がすっと下がりながら1秒足らずで消える。**一発だけの使い捨て**
// なので、エンジンの音のように保持しておく必要はない（stop() を予約すれば
// 勝手に片付く）。distGain（0〜1）で大きさを、whenSeconds で鳴らす時刻を決める
// ——「いつ鳴らすか」を決めるほう（soundUpdateBoom）は下にある。
const SOUND_BOOM_GAIN = 1.1;
const SOUND_BOOM_HZ_FROM = 1500;
const SOUND_BOOM_HZ_TO = 55;
const SOUND_BOOM_SWEEP_S = 0.30;
const SOUND_BOOM_TAIL_S = 0.55;
// 自由視点（世界に立っている観測者）で円錐がちょうど届いたときの、距離ぶんの落ち方の基準。
const SOUND_BOOM_REF_M = 700;

function soundPlayBoom(ctx, dest, noiseBuf, whenSeconds, distGain) {
  if (!ctx || distGain < 0.004) return null;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'lowpass';
  bp.frequency.setValueAtTime(SOUND_BOOM_HZ_FROM, whenSeconds);
  bp.frequency.exponentialRampToValueAtTime(SOUND_BOOM_HZ_TO, whenSeconds + SOUND_BOOM_SWEEP_S);
  bp.Q.value = 0.8;
  const g = ctx.createGain();
  const peak = SOUND_BOOM_GAIN * distGain;
  g.gain.setValueAtTime(0.0001, whenSeconds);
  g.gain.linearRampToValueAtTime(peak, whenSeconds + 0.004);   // 4msでほぼ最大
  g.gain.exponentialRampToValueAtTime(Math.max(peak * 0.002, 1e-4), whenSeconds + SOUND_BOOM_TAIL_S);
  src.connect(bp).connect(g).connect(dest);
  src.start(whenSeconds);
  src.stop(whenSeconds + SOUND_BOOM_TAIL_S + 0.1);
  return { src, bp, gain: g };
}

// --- 雨と雷 ------------------------------------------------------------------
//
// 機体とは無関係に、いつも天候の「今の値」（05b-weather.js の
// EnvState.weather.current）から鳴らす。雨はサラサラ〜ザーザーという広帯域の
// 雑音、雪はほぼ無音（実際、雪が降る音はほとんど聞こえない）。
const SOUND_RAIN_GAIN = 0.9;
const SOUND_RAIN_HZ_FROM = 900;   // 小雨。こもった音
const SOUND_RAIN_HZ_TO = 4200;    // 土砂降り。シャーというにじんだ高音
const SOUND_RAIN_Q = 0.5;

function buildRainVoice(ctx, dest, noiseBuf) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = SOUND_RAIN_HZ_FROM;
  bp.Q.value = SOUND_RAIN_Q;
  const g = ctx.createGain();
  g.gain.value = 0;
  src.connect(bp).connect(g).connect(dest);
  src.start();
  return {
    src, bp, gain: g,
    // amt ＝ 降水の強さ（0〜1）。雪や、降っていないときは0を渡す。
    setIntensity(amt, when, smooth) {
      const t = when === undefined ? ctx.currentTime : when;
      const tau = smooth === undefined ? 0.6 : smooth;   // 天候の移り変わりに合わせてゆっくり
      const p = THREE.MathUtils.clamp(amt, 0, 1);
      soundRamp(g.gain, SOUND_RAIN_GAIN * p, t, tau);
      soundRamp(bp.frequency, SOUND_RAIN_HZ_FROM + (SOUND_RAIN_HZ_TO - SOUND_RAIN_HZ_FROM) * p, t, tau);
    },
  };
}

const SOUND_THUNDER_MIN_M = 400;
const SOUND_THUNDER_MAX_M = 11000;
const SOUND_THUNDER_REF_M = 900;
const SOUND_THUNDER_GAIN = 2.2;
const SOUND_THUNDER_HZ_NEAR = 2600;   // すぐそばの、バリッという高い成分
const SOUND_THUNDER_HZ_FAR = 45;      // 遠くの、ゴロゴロという低い唸りだけ
const SOUND_THUNDER_HZ_SPAN_M = 3200;

// 雷鳴を1発ぶん鳴らす。**近いほど鋭い1回のクラック、遠いほど長く低い
// ゴロゴロ**になる——音の高い成分ほど空気に先に吸われるので、稲妻という
// 同じ音源が、届く距離によって別の楽器のように変わる（エンジン音の空気の
// 吸収と同じ考え方。SOUND_AIR_SPAN_M の説明を参照。雷はけた違いに遠くまで
// 届くので、ここだけ距離の基準を3.2kmに広げてある）。
function soundPlayThunder(ctx, dest, noiseBuf, whenSeconds, distM) {
  if (!ctx) return null;
  const gain0 = soundFalloff(distM, SOUND_THUNDER_REF_M) * SOUND_THUNDER_GAIN;
  if (gain0 < 0.01) return null;
  const cutHz = SOUND_THUNDER_HZ_FAR
    + (SOUND_THUNDER_HZ_NEAR - SOUND_THUNDER_HZ_FAR) * Math.exp(-distM / SOUND_THUNDER_HZ_SPAN_M);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = cutHz; lp.Q.value = 0.6;
  const out = ctx.createGain(); out.gain.value = gain0;
  lp.connect(out).connect(dest);

  // 遠いほど長く転がる（音源の長さ・地形やほかの雲での反射がぶんぶん重なる
  // ぶん）。何回かの「ゴロッ」に分けて鳴らし、最初の一発だけ近いときに鋭くする。
  const totalDur = Math.min(0.6 + distM / 1100, 11);
  const claps = distM < 1500 ? 2 : (3 + Math.floor(distM / 3800));
  const nodes = [];
  for (let i = 0; i < claps; i++) {
    const t0 = whenSeconds + (i === 0 ? 0 : (0.12 + Math.random() * 0.45) * totalDur * (i / claps));
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = cutHz * (i === 0 ? 1.5 : 0.65);
    const g = ctx.createGain();
    const peak = i === 0 ? 1.0 : 0.4 + Math.random() * 0.35;
    const attack = (i === 0 && distM < 2500) ? 0.015 : 0.18;
    const decay = Math.max(totalDur / claps * 1.3, 0.4);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(peak * 0.003, 1e-4), t0 + attack + decay);
    src.connect(bp).connect(g).connect(lp);
    src.start(t0);
    src.stop(t0 + attack + decay + 0.1);
    nodes.push({ src, bp, gain: g });
  }
  return { lp, out, claps: nodes, cutHz, totalDur };
}

// --- 生の音（飛行中に鳴らすほう）---------------------------------------------

function soundState() {
  if (!EnvState.sound) {
    EnvState.sound = {
      ctx: null, master: null, noiseBuf: null,
      enabled: true, volume: SOUND_VOLUME_DEFAULT,
      voices: null, forAircraft: null,
      wind: null, rain: null, boom: null, prevFlash: undefined,
      blocked: false,
    };
  }
  return EnvState.sound;
}

// AudioContext を用意する。**人が触ったあとでしか作れない**ので、
// クリック・キー入力・「飛ぶ」ボタンから呼ぶ。二度目以降は何もしない。
function soundEnsure() {
  const s = soundState();
  if (s.ctx) {
    // タブを離れると止まることがあるので、戻ってきたら起こす
    if (s.ctx.state === 'suspended' && s.enabled) s.ctx.resume();
    return s.ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { s.blocked = true; return null; }
  try {
    s.ctx = new AC();
  } catch (err) {
    console.warn('音を鳴らせませんでした:', err);
    s.blocked = true;
    return null;
  }
  const m = soundBuildMaster(s.ctx, s.ctx.destination, s.enabled ? s.volume : 0);
  s.master = m.gain;
  s.limiter = m.limiter;
  s.noiseBuf = soundBuildNoiseBuffer(s.ctx);
  // 風切音と雨は機体の種類に関係ないので、ここで一度だけ組む
  // （エンジンの音のように機体ごとに作り直す必要がない）。
  s.wind = buildWindVoice(s.ctx, s.master, s.noiseBuf);
  s.wind.start();
  s.rain = buildRainVoice(s.ctx, s.master, s.noiseBuf);
  if (s.ctx.state === 'suspended') s.ctx.resume();
  return s.ctx;
}

function soundSetEnabled(on) {
  const s = soundState();
  s.enabled = !!on;
  if (s.enabled) soundEnsure();
  if (s.master) soundRamp(s.master.gain, s.enabled ? s.volume : 0, s.ctx.currentTime, 0.05);
  if (s.ctx && !s.enabled) { /* 止めはしない。音量0で待つほうが復帰が速い */ }
}

function soundSetVolume(v) {
  const s = soundState();
  s.volume = Math.max(Math.min(v, 1), 0);
  if (s.master && s.enabled) soundRamp(s.master.gain, s.volume, s.ctx.currentTime, 0.05);
}

// その機体に要る音を組む。**エンジン1基ごとではなく種別ごとに1つ**にする。
// 同じ種別のエンジンは同じ音を出すので、基数ぶん重ねても音量が上がるだけで
// 音色は変わらない（8基の機体で8本鳴らすのは無駄）。位置はその種別の
// エンジンの真ん中を使い、音量は「出ている出力の合計」で決める。
function soundAttachAircraft(ac) {
  const s = soundState();
  if (!s.ctx || !ac) return;
  soundDetachAircraft();
  const kinds = new Map();
  for (const e of (ac.model.engines || [])) {
    const k = SOUND_ENGINE_LOOK[e.kind] ? e.kind : 'jet';
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k).push(e);
  }
  s.voices = [];
  for (const [kind, engines] of kinds) {
    const voice = buildEngineVoice(s.ctx, s.master, kind, s.noiseBuf);
    voice.engines = engines;
    voice.center = new THREE.Vector3();
    voice.world = new THREE.Vector3();
    // 同じ種別が何基あるかで音量が増える。基数に比例させると4発で4倍になって
    // 割れるので、対数で効かせる（耳も音の足し算を対数で聞く）。
    voice.countGain = Math.min(1 + Math.log2(Math.max(engines.length, 1)) * 0.35, 2.2);
    voice.start();
    s.voices.push(voice);
  }
  s.forAircraft = ac;
}

function soundDetachAircraft() {
  const s = soundState();
  if (!s.voices) return;
  const t = s.ctx ? s.ctx.currentTime : 0;
  for (const v of s.voices) {
    soundRamp(v.body.gain, 0, t, 0.02);
    try { v.stop(t + 0.1); } catch (err) { /* すでに止まっていた */ }
  }
  s.voices = null;
  s.forAircraft = null;
}

const _sndPos = new THREE.Vector3();
const _sndToEar = new THREE.Vector3();

// **機体に固定された点音源**（エンジン・風切音）が共通して要る処理。
// ドップラー（SOUND_DOPPLER_TAU のすぐ上の説明）と、距離ぶんの音量・高音の
// 減りをまとめて音源へ適用する。エンジンと風切音はどちらもここを通すので、
// 「耳がどう動いているか」の扱いが2か所でずれる心配がない。
function soundApplyMotion(voice, worldPos, cam, f, earFollows, dt, now) {
  const dist = _sndPos.copy(worldPos).sub(cam).length();
  let raw = 0;
  if (!earFollows) {
    _sndToEar.copy(cam).sub(worldPos);
    const len = _sndToEar.length();
    if (len > 1e-3) raw = f.state.velocity.dot(_sndToEar) / len;
  }
  if (dt <= 1e-4) voice.closing = raw;
  else {
    const k = 1 - Math.exp(-dt / SOUND_DOPPLER_TAU);
    voice.closing = (voice.closing || 0) + (raw - (voice.closing || 0)) * k;
  }
  const want = SOUND_SPEED_MPS / Math.max(SOUND_SPEED_MPS - voice.closing, 40);
  const step = SOUND_DOPPLER_SLEW * Math.max(dt, 1e-3);
  voice.setDoppler(THREE.MathUtils.clamp(want, voice.doppler - step, voice.doppler + step));
  voice.setDistance(dist, now);
  return dist;
}

const _boomV = new THREE.Vector3();

// **音速をまたいだ瞬間**ではなく、**衝撃波の円錐が実際に耳へ届いた瞬間**に
// 鳴らす。超音速機の後ろには、進行方向を軸にした円錐状の衝撃波面
// （半頂角 μ = asin(1/マッハ数)）が引きずられていて、地上のある1点はその
// 面が通り過ぎたときに初めて「バーン」を聞く——機体が音速を超えた瞬間では
// ない（実機の記録でも、超音速機が頭上を通過してからしばらくして届く）。
//
//   耳が機体に付いている（追従・機体固定・コックピット・周回）… 同乗して
//     いるので、円錐は最初からずっと耳の位置を含んでいる。音速を超えた
//     瞬間に1回だけ鳴らす（09b-aircraft-visual.js の衝撃波の見た目と同じ
//     合図＝machCrossCount）。
//   耳が世界に置いてある（自由視点）… 実際に「円錐の中に入ったか」を
//     角度で判定する。実測（直線・等速・水平飛行、観測者は飛行経路の
//     真下）で、届く時刻は教科書どおりの式
//       t = 高度 × √(マッハ数²−1) ÷ (マッハ数 × 音速)
//     とぴたり一致した（CHANGELOG参照）。
function soundUpdateBoom(f, cam, earFollows, now) {
  const s = soundState();
  if (!s.boom) s.boom = { inside: false, cross: 0 };
  const b = s.boom;
  const mach = f.state.mach || 0;
  const cross = f.state.machCrossCount || 0;

  if (earFollows) {
    if (cross !== b.cross) {
      b.cross = cross;
      if (mach >= 1) soundPlayBoom(s.ctx, s.master, s.noiseBuf, now, 1);
    }
    b.inside = false;   // 世界固定の判定は、視点を戻したときのために伏せておく
    return;
  }
  b.cross = cross;       // 視点を戻したとき二重に鳴らないよう、ここでも追従させておく
  if (mach <= 1.001) { b.inside = false; return; }

  const v = f.state.velocity;
  const speed = v.length();
  if (speed < 1) return;
  const acPos = f.aircraft.group.position;
  const mu = Math.asin(THREE.MathUtils.clamp(1 / mach, -1, 1));
  _boomV.copy(v).multiplyScalar(1 / speed);             // 進行方向の単位ベクトル
  _sndToEar.copy(cam).sub(acPos);                        // 機体 → 耳
  const len = _sndToEar.length();
  if (len < 1e-3) return;
  const cosAngle = -_sndToEar.dot(_boomV) / len;         // 後方（−進行方向）との近さ
  const inside = cosAngle > Math.cos(mu);
  if (inside && !b.inside) {
    soundPlayBoom(s.ctx, s.master, s.noiseBuf, now, soundFalloff(len, SOUND_BOOM_REF_M));
  }
  b.inside = inside;
}

// 雨と雷。機体の有無・視点の種類に関係なく、天候の「今の値」だけで決める。
function soundUpdateWeatherAmbience(now) {
  const s = soundState();
  const w = EnvState.weather;
  if (!w) return;

  if (s.rain && w.current) {
    const amt = w.current.precipIsSnow > 0.5 ? 0 : (w.current.precipRate || 0);
    s.rain.setIntensity(amt, now);
  }

  // 稲光（flash）が立ち上がった瞬間を「新しい雷」とみなし、落ちた場所までの
  // 距離を決めて、音が届くだけの時間を空けてから鳴らす——
  // 「ピカッと光ってから何秒でゴロゴロ」が、そのまま距離÷音速で出る。
  const flash = w.flash || 0;
  if (s.prevFlash === undefined) s.prevFlash = flash;
  if (flash > 0.9 && s.prevFlash <= 0.9) {
    const distM = SOUND_THUNDER_MIN_M
      + (SOUND_THUNDER_MAX_M - SOUND_THUNDER_MIN_M) * Math.pow(Math.random(), 2);
    soundPlayThunder(s.ctx, s.master, s.noiseBuf, now + distM / SOUND_SPEED_MPS, distM);
  }
  s.prevFlash = flash;
}

// 毎フレーム。機体の状態から音を更新する（02-env-scene.js の animateEnv から）。
function updateSound(dt) {
  const s = soundState();
  if (!s.ctx || !s.enabled) return;
  const now = s.ctx.currentTime;
  // **雨と雷は機体と無関係。** 天候は「飛ぶ」を押す前から動いている
  // （updateWeather は環境プレビューの間ずっと呼ばれる）ので、音もそれに
  // 合わせて機体の有無を問わず更新する。
  soundUpdateWeatherAmbience(now);

  const f = EnvState.flight;
  if (!f || !f.active || !f.aircraft) { soundSilence(); return; }
  // **音を組むのはここ。** 「まだ組んでいないから何もしない」と書くと、
  // 誰も組まないので永久に鳴らない（実際そうなっていた）。機体が変わったときも
  // ここで組み直す。組んだ直後のフレームは値が入っていないので、そのまま続ける。
  if (!s.voices || s.forAircraft !== f.aircraft) soundAttachAircraft(f.aircraft);
  if (!s.voices) return;
  // **ここでエンジンが0本でも return してはいけない。** 風切音とソニックブームは
  // グライダーのようなエンジンの無い機体でも鳴る（音速に近い滑空はまず無いにせよ、
  // 少なくとも風切音は要る）。エンジンの声が無いだけで下のコードは素通りする。

  const cam = EnvState.camera.position;
  // 耳は機体に乗っているか（自由視点だけが世界に置いてある）
  const earFollows = f.cameraMode !== 'free';
  const model = f.aircraft.model;
  const q = f.aircraft.group.quaternion;
  const origin = f.aircraft.group.position;

  for (const v of s.voices) {
    // その種別のエンジンの真ん中（ワールド）
    v.center.set(0, 0, 0);
    let lever = 0, ab = 0, n = 0;
    for (const e of v.engines) {
      v.center.add(e.position);
      n++;
      const off = typeof engineGroupOff === 'function' && engineGroupOff(f.controls, e.group);
      const lv = off ? 0
        : (typeof engineDeliveredLever === 'function'
          ? engineDeliveredLever(model, f.state, f.controls, e) : 0);
      lever = Math.max(lever, lv);
      if (e.kind === 'jet_ab') {
        ab = Math.max(ab, THREE.MathUtils.clamp(
          (lv - ENGINE_AB_FROM) / Math.max(ENGINE_AB_FULL - ENGINE_AB_FROM, 1e-3), 0, 1));
      }
    }
    if (n > 0) v.center.multiplyScalar(1 / n);
    v.world.copy(v.center).applyQuaternion(q).add(origin);

    soundApplyMotion(v, v.world, cam, f, earFollows, dt, now);
    v.setPower(lever, ab, now);
  }

  // **風切音。** 機体の中心に固定された、もう1つの点音源として扱う
  // （ドップラー・距離の計算はエンジンとまったく同じ soundApplyMotion を通す）。
  if (s.wind) {
    soundApplyMotion(s.wind, origin, cam, f, earFollows, dt, now);
    const rho = typeof airDensityAt === 'function' ? airDensityAt(f.state.altitudeM || 0) : FLIGHT_RHO0;
    const dynQ = 0.5 * rho * (f.state.airspeed || 0) * (f.state.airspeed || 0);
    s.wind.setSpeed(dynQ / SOUND_WIND_REF_Q, now);
  }

  soundUpdateBoom(f, cam, earFollows, now);
}

function soundSilence() {
  const s = soundState();
  if (!s.ctx) return;
  const now = s.ctx.currentTime;
  if (s.voices) for (const v of s.voices) soundRamp(v.body.gain, 0, now, 0.08);
  if (s.wind) soundRamp(s.wind.body.gain, 0, now, 0.08);
}

// 最初の操作で音を起こす。ページのどこを触っても効くように1回だけ仕掛ける。
function setupSoundUnlock() {
  const wake = () => {
    if (soundState().enabled) soundEnsure();
  };
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake, { passive: true });
  window.addEventListener('touchstart', wake, { passive: true });
}

// **測り方**は tools/verify-sound.js ではなくブラウザ側で行う。Web Audio は
// Node に無いので、OfflineAudioContext で実際にレンダリングして波形を測る
// （scratchpad の音のハーネスを参照）。buildEngineVoice が EnvState を見ないのは
// そのためで、同じ関数をオフラインの ctx に渡せば同じ音が組める。
