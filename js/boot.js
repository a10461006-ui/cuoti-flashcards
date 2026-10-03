// 在畫面繪製前套用主題與字體大小，避免閃爍（CSP 不允許 inline script，所以獨立成檔）
(function () {
  try {
    var theme = localStorage.getItem('fc.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    var scale = parseFloat(localStorage.getItem('fc.fontScale'));
    if (scale >= 0.8 && scale <= 1.6) document.documentElement.style.setProperty('--fs-scale', String(scale));
  } catch (e) { /* 私密瀏覽等情況無法存取 localStorage，使用預設值 */ }
})();
