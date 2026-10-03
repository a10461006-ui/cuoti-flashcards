// DOM 小工具、圖示、對話框、文字格式化

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'selected', 'disabled', 'open', 'indeterminate'].includes(k)) el[k] = v;
    else if (k === 'html') el.innerHTML = v; // 只用於已跳脫的內容（richText）
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---- 圖示（24×24 線條）

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5" opacity=".55"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  starFill: '<path fill="currentColor" d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  flame: '<path d="M12 3c.5 3 4.5 5 4.5 10a4.5 4.5 0 0 1-9 0c0-2.2 1-3.6 2.2-4.6.1 1.6.8 2.8 2 3.1C11 9.5 10.6 6 12 3z"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  clipboard: '<path d="M9 4h6v3H9z"/><path d="M9 5.5H6.5V21h11V5.5H15"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.4 5.7"/><path d="M20 4v7h-7"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  shuffle: '<path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${cls}">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

// ---- 筆記文字：跳脫 HTML 後，支援 **粗體** 與【重點】標示

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function richHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/【([^【】\n]{1,40})】/g, '<mark class="kw">【$1】</mark>');
}

export function rich(text, cls = '') {
  return h('div', { class: `rich ${cls}`.trim(), html: richHtml(text) });
}

// ---- toast

export function toast(message, type = '') {
  const wrap = document.getElementById('toasts');
  const el = h('div', { class: `toast ${type}` }, message);
  wrap.append(el);
  setTimeout(() => el.remove(), type === 'bad' ? 4200 : 2600);
}

export function showError(err) {
  if (err?.status === 401) return;
  toast(err?.message || '發生錯誤', 'bad');
}

// ---- bottom sheet / 對話框

export function openSheet(build, { onClose } = {}) {
  const prevFocus = document.activeElement;
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }));
  const overlay = h('div', { class: 'overlay' }, sheet);
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
    onClose?.(value);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(undefined); }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(undefined); });
  document.addEventListener('keydown', onKey, true);
  append(sheet, [build(close)]);
  document.body.append(overlay);
  setTimeout(() => sheet.querySelector('[autofocus], input, textarea, button.btn-primary')?.focus(), 30);
  return close;
}

export function confirmDialog({ title, message = '', ok = '確定', cancel = '取消', danger = false }) {
  return new Promise((resolve) => {
    openSheet((close) => h('div', null,
      h('h3', null, title),
      message ? h('p', { class: 'msg' }, message) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => close(false) }, cancel),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => close(true) }, ok),
      ),
    ), { onClose: (v) => resolve(Boolean(v)) });
  });
}

export function promptDialog({ title, label = '', value = '', placeholder = '', ok = '確定', maxlength = 40 }) {
  return new Promise((resolve) => {
    openSheet((close) => {
      const input = h('input', { class: 'input', value, placeholder, maxlength, autofocus: true });
      const submit = (e) => { e.preventDefault(); close(input.value.trim() || null); };
      return h('form', { onsubmit: submit },
        h('h3', null, title),
        h('label', { class: 'field' }, label ? h('span', { class: 'lbl' }, label) : null, input),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, '取消'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, ok),
        ),
      );
    }, { onClose: (v) => resolve(v ?? null) });
  });
}

// ---- 題目附圖

/** 題目附圖：點一下全螢幕放大 */
export function figureList(images, cls = '') {
  if (!images?.length) return null;
  return h('div', { class: `q-figs ${cls}`.trim() }, images.map((img, i) => h('button', {
    type: 'button', class: 'q-fig', 'aria-label': `放大第 ${i + 1} 張圖`, onclick: () => openImage(img.src),
  }, h('img', { src: img.src, alt: `題目附圖 ${i + 1}`, width: img.w || null, height: img.h || null, loading: 'lazy', decoding: 'async' }))));
}

/** 全螢幕看圖：可以捲動，「放大」切換兩倍寬，手機也可以兩指縮放 */
export function openImage(src) {
  const prevFocus = document.activeElement;
  const zoomBtn = h('button', { class: 'btn btn-sm' }, '放大');
  const closeBtn = h('button', { class: 'btn btn-sm' }, icon('x'), '關閉');
  const view = h('div', { class: 'img-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '圖片放大檢視' },
    h('div', { class: 'img-scroll' }, h('img', { src, alt: '題目附圖（放大）' })),
    h('div', { class: 'img-tools' }, zoomBtn, closeBtn));
  const close = () => {
    view.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    e.stopPropagation(); // 看圖時不要觸發練習頁的鍵盤快捷鍵
    if (e.key === 'Escape') close();
  };
  zoomBtn.addEventListener('click', () => {
    const on = view.classList.toggle('zoomed');
    zoomBtn.textContent = on ? '縮小' : '放大';
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(view);
  closeBtn.focus();
}

/** 讀取照片（會依照片的方向資訊轉正）；舊版瀏覽器改用 <img> 解碼 */
export async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error('無法讀取這張圖片，請改用 JPG 或 PNG');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** 照片 → 縮小後的 JPEG（題目附圖用，避免佔太多空間） */
export async function imageToDataUrl(file, maxSide = 1600) {
  const bitmap = await loadBitmap(file);
  const w0 = bitmap.width || bitmap.naturalWidth;
  const h0 = bitmap.height || bitmap.naturalHeight;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * k));
  canvas.height = Math.max(1, Math.round(h0 * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const out = { src: canvas.toDataURL('image/jpeg', 0.85), w: canvas.width, h: canvas.height };
  canvas.width = 0;
  return out;
}

// ---- 版面

export function topbar({ title, back, actions = [] } = {}) {
  return h('header', { class: 'topbar' },
    h('div', { class: 'inner' },
      back ? h('button', { class: 'icon-btn', 'aria-label': '返回', onclick: back }, icon('back')) : null,
      h('h1', null, title),
      ...actions,
    ),
  );
}

export function iconButton(name, label, onclick, extra = {}) {
  return h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick, ...extra }, icon(name));
}

export function spinner() { return h('div', { class: 'spinner', role: 'progressbar', 'aria-label': '載入中' }); }

export function switchInput(checked, onchange, label) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onchange(e.target.checked) });
  return h('label', { class: 'switch' }, input, h('span'));
}

export function segmented(options, value, onchange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  const render = (current) => clear(wrap, options.map((o) => h('button', {
    type: 'button', class: o.value === current ? 'on' : '', role: 'radio', 'aria-checked': String(o.value === current),
    onclick: () => { render(o.value); onchange(o.value); },
  }, o.label, o.count != null ? h('span', { class: 'n' }, o.count) : null)));
  render(value);
  return wrap;
}

// ---- 格式

export function formatDue(dueAt) {
  if (!dueAt) return '';
  const diff = new Date(dueAt).getTime() - Date.now();
  const days = diff / 86400000;
  if (diff <= 0) return '已到期';
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分鐘後`;
  if (days < 1) return `${Math.round(diff / 3600000)} 小時後`;
  if (days < 30) return `${Math.round(days)} 天後`;
  return `${Math.round(days / 30)} 個月後`;
}

export function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

/** 讓使用者下載一個檔案（備份、範本） */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function downloadTemplate() {
  const { api } = await import('./api.js');
  downloadBlob(await api.get('/api/import/template'), '錯題匯入範本.xlsx');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function autoGrow(textarea) {
  const fit = () => { textarea.style.height = 'auto'; textarea.style.height = `${textarea.scrollHeight + 2}px`; };
  textarea.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return textarea;
}
