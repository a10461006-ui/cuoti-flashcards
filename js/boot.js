// 啟動前置作業（一般 script，刻意用最舊的 JavaScript 寫法，任何瀏覽器都能執行）：
// 1. 在畫面繪製前套用主題與字體大小，避免閃爍（CSP 不允許 inline script，所以獨立成檔）
// 2. 萬一 App 的程式在這個瀏覽器載入失敗（太舊、或暫存了壞掉的舊檔），顯示說明與「清除暫存並重新載入」，
//    不會只剩一片空白或一直轉圈。清除暫存不會刪除使用者的題目與紀錄。
(function () {
  try {
    var theme = localStorage.getItem('fc.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    var scale = parseFloat(localStorage.getItem('fc.fontScale'));
    if (scale >= 0.8 && scale <= 1.6) document.documentElement.style.setProperty('--fs-scale', String(scale));
  } catch (e) { /* 私密瀏覽等情況無法存取 localStorage，使用預設值 */ }

  var errors = [];
  function note(msg) {
    if (msg && errors.length < 5) errors.push(String(msg).slice(0, 200));
  }
  window.addEventListener('error', function (e) {
    var where = e && e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + (e.lineno || 0) + ')' : '';
    note((e && e.message ? e.message : '載入錯誤') + where);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    note(r && r.message ? r.message : r);
  });

  // 清除 Service Worker 與快取的舊檔案後重新載入（IndexedDB 裡的題目不會動）
  function resetAndReload() {
    var tasks = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        tasks.push(navigator.serviceWorker.getRegistrations().then(function (list) {
          return Promise.all(list.map(function (r) { return r.unregister(); }));
        }));
      }
    } catch (e) { /* 忽略 */ }
    try {
      if (window.caches && caches.keys) {
        tasks.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches['delete'](k); }));
        }));
      }
    } catch (e) { /* 忽略 */ }
    var go = function () { location.reload(); };
    if (window.Promise && tasks.length) Promise.all(tasks).then(go, go);
    else go();
  }
  window.fcResetAndReload = resetAndReload;

  function el(tag, text, style) {
    var node = document.createElement(tag);
    if (text) node.appendChild(document.createTextNode(text));
    if (style) node.setAttribute('style', style);
    return node;
  }

  function showHelp(kind) {
    if (window.__fcStarted || document.getElementById('fc-boot-help')) return;
    var box = el('div', '', 'max-width:520px;margin:40px auto;padding:24px 20px;font:16px/1.7 -apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;color:#17181a;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.12)');
    box.id = 'fc-boot-help';
    var title = kind === 'old' ? '這個瀏覽器版本太舊，無法開啟錯題閃卡'
      : kind === 'slow' ? '錯題閃卡載入得比較久' : '錯題閃卡無法在這個瀏覽器開啟';
    box.appendChild(el('h2', title, 'margin:0 0 10px;font-size:20px'));
    box.appendChild(el('p', kind === 'slow' ? '可能是網路比較慢，或暫存了舊版的檔案。可以試試：' : '請依序試試：', 'margin:0 0 8px'));
    var list = el('ol', '', 'margin:0 0 14px;padding-left:22px');
    list.appendChild(el('li', '按下面的「清除暫存並重新載入」（不會刪除你的題目）'));
    list.appendChild(el('li', '更新手機或電腦的系統（Safari 會跟著更新），或改用最新版的 Chrome、Edge、Firefox'));
    list.appendChild(el('li', '不要在 LINE、Facebook 裡開啟，改用手機的瀏覽器開啟網址'));
    box.appendChild(list);
    var btn = el('button', '清除暫存並重新載入', 'font:inherit;font-weight:700;padding:10px 18px;margin:0 8px 8px 0;border:0;border-radius:10px;background:#256abf;color:#fff');
    btn.onclick = resetAndReload;
    var again = el('button', '重新整理', 'font:inherit;padding:10px 18px;margin:0 8px 8px 0;border:1px solid #cfccc3;border-radius:10px;background:#fff;color:#17181a');
    again.onclick = function () { location.reload(); };
    box.appendChild(btn);
    box.appendChild(again);
    if (errors.length) box.appendChild(el('p', '錯誤訊息（回報問題時可以截圖）：' + errors.join('；'), 'margin:12px 0 0;font-size:13px;color:#50535a;word-break:break-all'));
    box.appendChild(el('p', '瀏覽器：' + navigator.userAgent, 'margin:6px 0 0;font-size:12px;color:#83868d;word-break:break-all'));
    var host = document.getElementById('app') || document.body;
    if (host) {
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(box);
    }
  }

  // 不支援 ES 模組的瀏覽器（例如 IE、很舊的 Safari）完全跑不了 App 的程式 → 直接說明
  if (!('noModule' in document.createElement('script'))) {
    document.addEventListener('DOMContentLoaded', function () { showHelp('old'); });
    return;
  }
  // 有錯誤、而且幾秒後 App 還沒啟動 → 顯示說明；完全沒錯誤但 25 秒還沒好 → 可能網路慢或舊檔
  setTimeout(function () { if (errors.length) showHelp('error'); }, 5000);
  setTimeout(function () { showHelp(errors.length ? 'error' : 'slow'); }, 25000);
})();
