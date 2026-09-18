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
    whineFrom: 700, whineTo: 3000, whineGain: 0.1,
    rumbleGain: 0, level: 1.0,
  },
  jet_ab: {
    toneFrom: 0, toneTo: 0, toneType: 'sine', toneGain: 0,
    toneCutMul: 4,
    noiseHz: 300, noiseQ: 0.7, noiseGain: 0.85,
    whineFrom: 700, whineTo: 3200, whineGain: 0.1,
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

  // ファンのキーン（ジェット）
  if (look.whineGain > 0) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = look.whineFrom;
    const g = ctx.createGain();
    g.gain.value = look.whineGain;
    osc.connect(g).connect(body);
    parts.whine = { osc, gain: g };
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
        soundRamp(parts.whine.osc.frequency, hz, t, tau);
        soundRamp(parts.whine.gain.gain, look.whineGain * (0.2 + 0.8 * p), t, tau);
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
      if (parts.whine) parts.whine.osc.start(t);
      if (parts.noise) parts.noise.src.start(t);
      if (parts.rumble) parts.rumble.src.start(t);
    },
    stop(when) {
      const t = when === undefined ? ctx.currentTime : when;
      if (parts.tone) parts.tone.osc.stop(t);
      if (parts.whine) parts.whine.osc.stop(t);
      if (parts.noise) parts.noise.src.stop(t);
      if (parts.rumble) parts.rumble.src.stop(t);
    },
  };
  return voice;
}

// 距離による音量の落ち方。1/(1+d/基準) ——「倍の距離で半分」より緩く、
// 近くでは頭打ちになる（目の前で無限に大きくならない）。
function soundDistanceGain(distM) {
  return SOUND_REF_M / (SOUND_REF_M + Math.max(distM, 0));
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

// --- 生の音（飛行中に鳴らすほう）---------------------------------------------

function soundState() {
  if (!EnvState.sound) {
    EnvState.sound = {
      ctx: null, master: null, noiseBuf: null,
      enabled: true, volume: SOUND_VOLUME_DEFAULT,
      voices: null, forAircraft: null,
      camPrev: null, camVel: new THREE.Vector3(),
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
const _sndToCam = new THREE.Vector3();
const _sndRel = new THREE.Vector3();

// 毎フレーム。機体の状態から音を更新する（02-env-scene.js の animateEnv から）。
function updateSound(dt) {
  const s = soundState();
  if (!s.ctx || !s.enabled) return;
  const f = EnvState.flight;
  if (!f || !f.active || !f.aircraft) { soundSilence(); return; }
  // **音を組むのはここ。** 「まだ組んでいないから何もしない」と書くと、
  // 誰も組まないので永久に鳴らない（実際そうなっていた）。機体が変わったときも
  // ここで組み直す。組んだ直後のフレームは値が入っていないので、そのまま続ける。
  if (!s.voices || s.forAircraft !== f.aircraft) soundAttachAircraft(f.aircraft);
  if (!s.voices || !s.voices.length) return;

  const cam = EnvState.camera.position;
  // カメラの速さ（ドップラーに要る）。追従視点では機体とほぼ同じ速さになるので、
  // そのぶんドップラーは打ち消される——これは実際そのとおり（同乗していれば
  // 音の高さは変わらない）。
  if (s.camPrev && dt > 1e-4) {
    s.camVel.subVectors(cam, s.camPrev).multiplyScalar(1 / dt);
  } else {
    s.camVel.set(0, 0, 0);
  }
  if (!s.camPrev) s.camPrev = new THREE.Vector3();
  s.camPrev.copy(cam);

  const now = s.ctx.currentTime;
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

    const dist = _sndPos.copy(v.world).sub(cam).length();

    // ドップラー。音源とカメラの**近づく速さ**（視線方向の相対速度）で決まる。
    _sndToCam.copy(cam).sub(v.world);
    const len = _sndToCam.length();
    if (len > 1e-3) {
      _sndToCam.multiplyScalar(1 / len);
      _sndRel.copy(f.state.velocity).sub(s.camVel);
      // 音源がカメラへ近づく速さ（正なら近づく＝高く聞こえる）
      const closing = _sndRel.dot(_sndToCam);
      v.setDoppler(SOUND_SPEED_MPS / Math.max(SOUND_SPEED_MPS - closing, 40));
    } else {
      v.setDoppler(1);
    }

    v.setPower(lever, ab, now);
    v.setDistance(dist, now);
  }
}

function soundSilence() {
  const s = soundState();
  if (!s.ctx || !s.voices) return;
  const now = s.ctx.currentTime;
  for (const v of s.voices) soundRamp(v.body.gain, 0, now, 0.08);
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
