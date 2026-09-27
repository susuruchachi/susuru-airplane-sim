// 00-nozoom.js — ページそのものが拡大しないようにする（index.html・flight.html の両方が読む）
//
// スマホでメニューを触っていると画面が拡大してしまい、戻せなくなることがあった。
// 戻すにはピンチで縮めるしかないが、飛行画面の3D表示・操縦のボタン・地図は指の操作を
// 自前で受けている（touch-action: none）ので、そこではピンチしてもページは縮まない。
// メニューの細い隙間でピンチするしかなく、実質戻せない。拡大の入り口は3つあって、
// それぞれ塞ぐ：
//   1) 文字入力欄・選択欄に触れたときの自動拡大（iPhone は文字が16px未満の欄で必ず寄る）
//      → viewport の maximum-scale=1（HTMLの<meta>に書いてある）
//   2) ダブルタップでの拡大 → ページ全体を touch-action: pan-x pan-y にする。
//      縦横のスクロールはそのまま使え、ピンチとダブルタップの拡大だけが止まる。
//      3D表示・地図・操縦ボタンなど自前で指を受ける所は、もともと none なので変わらない
//   3) ピンチ（iPhone の Safari は user-scalable=no を無視する）→ Safari だけが出す
//      gesturestart / gesturechange を止める。地図や3D表示のピンチは pointer イベントで
//      自前に受けているので、これを止めても効く
(function () {
  const style = document.createElement('style');
  style.textContent = 'html{touch-action:pan-x pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%;}';
  (document.head || document.documentElement).appendChild(style);
  const stop = (e) => { e.preventDefault(); };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, stop, { passive: false });
  }
})();
