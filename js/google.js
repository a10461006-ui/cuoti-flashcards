// Google 登入（Google Identity Services）與註冊登記（送到你的 Apps Script → Google 試算表）
// 設定值在 js/config.js；沒有填就自動停用，不影響本機使用。

const cfg = () => window.FC_CONFIG || {};
const PENDING_KEY = 'fc.pendingRegistration';

export const googleConfigured = () => Boolean(cfg().googleClientId);
/** Google 只允許 https 或 localhost 使用登入；區網 http 網址無法登入 */
export const googleUsable = () => googleConfigured() && window.isSecureContext;
export const googleRequired = () => googleUsable() && cfg().requireGoogleSignIn !== false;

let gisPromise = null;
function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('無法連線到 Google，請確認網路後再試')); };
      document.head.append(s);
    });
  }
  return gisPromise;
}

/** JWT 的內容（只拿來顯示名字與 Email；真正的驗證在 Apps Script 端） */
export function decodeIdToken(token) {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** 在 container 裡放「使用 Google 帳號繼續」按鈕；登入成功時呼叫 onSignedIn({ idToken, profile }) */
export async function renderGoogleButton(container, onSignedIn) {
  await loadGis();
  window.google.accounts.id.initialize({
    client_id: cfg().googleClientId,
    callback: (resp) => {
      const p = decodeIdToken(resp.credential);
      onSignedIn({ idToken: resp.credential, profile: { sub: p.sub, email: p.email, name: p.name || p.email, picture: p.picture || '' } });
    },
    ux_mode: 'popup',
    auto_select: false,
    itp_support: true,
  });
  window.google.accounts.id.renderButton(container, {
    type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', locale: 'zh-TW',
    width: Math.min(360, Math.max(220, container.clientWidth || 300)),
  });
}

/**
 * 送出註冊資料到 Apps Script。失敗（例如沒網路）時先存在本機，下次開啟 App 自動補送。
 * 用 text/plain 送出，避免瀏覽器的跨網域預檢（Apps Script 不支援）。
 */
export async function sendRegistration(payload) {
  const url = cfg().registrationUrl;
  if (!url) return { ok: false, skipped: true };
  const body = JSON.stringify({ ...payload, appVersion: cfg().appVersion || '', userAgent: navigator.userAgent.slice(0, 200) });
  try {
    const res = await fetch(url, { method: 'POST', body, redirect: 'follow' });
    const data = await res.json().catch(() => ({ ok: res.ok }));
    if (!data.ok) throw new Error(data.error || '登記失敗');
    try { localStorage.removeItem(PENDING_KEY); } catch { /* 忽略 */ }
    return { ok: true };
  } catch (err) {
    try { localStorage.setItem(PENDING_KEY, body); } catch { /* 忽略 */ }
    return { ok: false, error: err.message };
  }
}

/** App 啟動時補送之前沒送成功的註冊（Google 登入憑證約 1 小時後失效，失效就放棄） */
export async function retryPendingRegistration() {
  let body;
  try { body = localStorage.getItem(PENDING_KEY); } catch { return; }
  if (!body || !cfg().registrationUrl) return;
  try {
    const { idToken } = JSON.parse(body);
    if (decodeIdToken(idToken).exp * 1000 < Date.now()) { localStorage.removeItem(PENDING_KEY); return; }
    const res = await fetch(cfg().registrationUrl, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (data.ok) localStorage.removeItem(PENDING_KEY);
  } catch { /* 下次再試 */ }
}
