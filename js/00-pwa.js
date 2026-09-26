// 00-pwa.js — ホーム画面に追加して「アプリ」として全画面で開けるようにする（index.html・flight.html の両方が読む）
//
//   ・サービスワーカー（sw.js）を登録する。Android の Chrome はこれとマニフェスト（manifest.webmanifest）が
//     揃うと「アプリをインストール」を出し、ホーム画面のアイコンから全画面（display: fullscreen）で開く
//   ・上の帯に「📲 アプリにする」を出す。Chrome が入れられると知らせてきたとき（beforeinstallprompt）はそれを開く。
//     iPhone・iPad の Safari は知らせてこないので、「共有 → ホーム画面に追加」の手順を出す
//   ・「⛶ 全画面」… ブラウザのまま全画面にする（Fullscreen API が使えるときだけ出す）
//   ・アプリとして開いているとき（display-mode が standalone / fullscreen）は、どちらのボタンも出さない

(function () {
  const standalone = () => (window.matchMedia && (matchMedia('(display-mode: fullscreen)').matches
    || matchMedia('(display-mode: standalone)').matches)) || navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS はデスクトップと名乗る

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 登録できなくても普通に動く */ });
    });
  }

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    updateButtons();
  });
  window.addEventListener('appinstalled', () => { deferred = null; updateButtons(); });

  function fullscreenApi() {
    const el = document.documentElement;
    return el.requestFullscreen ? 'std' : (el.webkitRequestFullscreen ? 'webkit' : null);
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function toggleFullscreen() {
    const el = document.documentElement;
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (fullscreenApi() === 'std') {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    } else if (fullscreenApi() === 'webkit') {
      el.webkitRequestFullscreen();
    }
  }

  let installBtn = null, fsBtn = null, iosTip = null;
  function makeButtons() {
    const bar = document.getElementById('topbar');
    if (!bar) return;
    // 狭い画面では絵文字だけにする（上の帯に収まるように）
    const css = document.createElement('style');
    css.textContent = '.pwa-short{display:none;} @media (max-width:760px){.pwa-full{display:none;} .pwa-short{display:inline;}}';
    document.head.appendChild(css);
    const anchor = bar.querySelector('.spacer');
    const place = (el) => (anchor && anchor.nextSibling ? bar.insertBefore(el, anchor.nextSibling) : bar.appendChild(el));

    fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.id = 'pwaBtnFullscreen';
    fsBtn.title = 'ブラウザのまま全画面にする（もう一度押すと戻る）';
    fsBtn.addEventListener('click', () => { toggleFullscreen(); fsBtn.blur(); });
    place(fsBtn);

    installBtn = document.createElement('button');
    installBtn.type = 'button';
    installBtn.id = 'pwaBtnInstall';
    installBtn.innerHTML = '<span class="pwa-full">📲 アプリにする</span><span class="pwa-short">📲</span>';
    installBtn.title = 'ホーム画面に追加して、アプリのように全画面で開けるようにする';
    installBtn.addEventListener('click', async () => {
      installBtn.blur();
      if (deferred) {
        deferred.prompt();
        try { await deferred.userChoice; } catch (err) { /* 閉じられても何もしない */ }
        deferred = null;
        updateButtons();
      } else {
        showTip();
      }
    });
    place(installBtn);

    document.addEventListener('fullscreenchange', updateButtons);
    document.addEventListener('webkitfullscreenchange', updateButtons);
    updateButtons();
  }

  // 手順の吹き出し（Chrome が入れられると知らせてこないとき）
  function showTip() {
    if (iosTip) { iosTip.remove(); iosTip = null; return; }
    iosTip = document.createElement('div');
    iosTip.id = 'pwaTip';
    iosTip.innerHTML = isIOS
      ? '<b>ホーム画面に追加する方法（Safari）</b><br>1. 画面上の <b>共有ボタン</b>（□に↑）を押す<br>'
        + '2. <b>「ホーム画面に追加」</b>を選ぶ<br>3. ホーム画面のアイコンから開くと、アプリのように全画面で開きます'
      : '<b>ホーム画面に追加する方法</b><br>ブラウザのメニュー（︙）から <b>「アプリをインストール」</b>'
        + 'または <b>「ホーム画面に追加」</b>を選んでください。<br>ホーム画面のアイコンから開くと全画面で開きます。';
    Object.assign(iosTip.style, {
      position: 'fixed', top: '56px', right: '12px', zIndex: 10000, maxWidth: '320px',
      background: '#121a24', color: '#dbe7f3', border: '1px solid #2f6fb5', borderRadius: '8px',
      padding: '12px 14px', fontSize: '13px', lineHeight: '1.6', boxShadow: '0 6px 24px rgba(0,0,0,.5)',
    });
    iosTip.addEventListener('click', () => { iosTip.remove(); iosTip = null; });
    document.body.appendChild(iosTip);
  }

  function updateButtons() {
    const app = standalone();
    if (installBtn) installBtn.style.display = app ? 'none' : '';
    if (fsBtn) {
      // アプリとして開いているとき・全画面にできないブラウザ（iPhone の Safari など）では出さない
      fsBtn.style.display = app || !fullscreenApi() ? 'none' : '';
      fsBtn.innerHTML = isFullscreen() ? '<span class="pwa-full">⛶ 全画面を戻す</span><span class="pwa-short">⛶</span>'
        : '<span class="pwa-full">⛶ 全画面</span><span class="pwa-short">⛶</span>';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', makeButtons);
  else makeButtons();
})();
