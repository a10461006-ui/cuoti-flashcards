// Google 雲端硬碟同步（畫面端）：授權、權杖、自動同步、同步狀態
//
// 授權用「整頁跳到 Google，再跳回 App」的方式：iPhone 加到主畫面後，彈出視窗常常回不來，整頁跳轉才可靠。
// Google 回來時網址 # 後面會帶著權杖（約 1 小時有效），App 一啟動就讀取並從網址列移除。
// 權杖有效期間，資料有變動會自動同步；過期後要使用者點一下「同步」重新取得（不需要再輸入密碼）。
import { MODE } from './api.js';
import { clear, h, icon, toast } from './ui.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_KEY = 'fc.driveToken';
const AUTH_KEY = 'fc.driveAuth';
const AUTO_DELAY = 8000;
const MIN_AUTO_GAP = 2 * 60000;
const RESUME_GAP = 3 * 60000; // 回到 App 時，距離上次同步超過 3 分鐘就再同步一次

const cfg = () => window.FC_CONFIG || {};

/** 雲端同步需要：本機引擎、Google 用戶端 ID、https（或 localhost） */
export function cloudAvailable() {
  return MODE === 'local' && Boolean(cfg().googleClientId) && window.isSecureContext && Boolean(window.crypto?.subtle);
}

// ---------------------------------------------------------------- 狀態

const status = {
  ready: false, // 讀到這台裝置的同步設定之前，畫面先不要顯示同步相關的東西
  enabled: false, email: '', lastSyncAt: null,
  phase: 'off', // off｜idle｜syncing｜needs-auth｜error
  progress: '', message: '', code: '', otherEmail: '', pending: false,
};
const listeners = new Set();

export const cloudStatus = () => status;
export function onCloudStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(patch) {
  Object.assign(status, patch);
  for (const fn of [...listeners]) { try { fn(status); } catch { /* 忽略 */ } }
}

// ---------------------------------------------------------------- 權杖

let memToken = null;
function readToken() {
  let t = memToken;
  try { t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null') || memToken; } catch { /* 用記憶體裡的 */ }
  return t && t.exp > Date.now() + 60000 ? t.token : null;
}
function saveToken(token, seconds) {
  const t = { token, exp: Date.now() + Math.max(60, seconds - 60) * 1000 };
  memToken = t;
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); } catch { /* 只放記憶體 */ }
}
function forgetToken() {
  memToken = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
}
export const hasToken = () => Boolean(readToken());

function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Google 授權完要回來的網址（必須和 Google Cloud「已授權的重新導向 URI」完全相同） */
export function redirectUri() {
  return `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
}

/**
 * 跳到 Google 授權。intent：enable（開啟同步）｜sync（重新取得權杖後同步）｜delete（刪除雲端資料）
 * selectAccount：讓使用者重新選擇帳號
 */
export function connectDrive({ intent = 'sync', back = location.hash || '#/', selectAccount = false, hint: givenHint = '' } = {}) {
  const state = randomHex(16);
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ state, intent, back, at: Date.now() }));
  } catch {
    toast('這個瀏覽器不能使用雲端同步（無法保存登入狀態）。請關閉無痕瀏覽或「封鎖所有 Cookie」', 'bad');
    return;
  }
  const params = new URLSearchParams({
    client_id: cfg().googleClientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE,
    include_granted_scopes: 'true', state,
  });
  const hint = givenHint || status.email || window.__fcGoogleEmail || '';
  if (selectAccount) params.set('prompt', 'select_account');
  else if (hint) params.set('login_hint', hint);
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/**
 * App 啟動時呼叫（路由開始前）：從 Google 回來的話，讀取權杖並立刻從網址列移除。
 * 回傳 null（不是從 Google 回來）或 { ok, intent, error }
 */
export function consumeAuthRedirect() {
  const hash = location.hash.replace(/^#/, '');
  if (!/(?:^|&)state=/.test(hash) || !/(?:^|&)(?:access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash);
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    localStorage.removeItem(AUTH_KEY);
  } catch { /* 忽略 */ }
  const back = /^#\/[^#]*$/.test(saved?.back || '') ? saved.back : '#/';
  history.replaceState(null, '', `${location.pathname}${location.search}${back}`);
  if (!saved || saved.state !== p.get('state') || Date.now() - saved.at > 30 * 60000) {
    return { ok: false, intent: saved?.intent || 'sync', error: '授權逾時或來源不符，請再試一次' };
  }
  const error = p.get('error');
  if (error) {
    return { ok: false, intent: saved.intent, error: error === 'access_denied' ? '你取消了 Google 授權，雲端同步沒有變更' : `Google 授權失敗（${error}）` };
  }
  const granted = p.get('scope');
  if (granted != null && !granted.split(/\s+/).includes(SCOPE)) {
    return { ok: false, intent: saved.intent, error: '沒有勾選「Google 雲端硬碟」權限，請再試一次，並在 Google 畫面勾選允許' };
  }
  saveToken(p.get('access_token'), Number(p.get('expires_in')) || 3600);
  return { ok: true, intent: saved.intent };
}

// ---------------------------------------------------------------- 同步

let engine = null;
const loadEngine = () => {
  engine = engine || Promise.all([import('./local/sync.js'), import('./local/gdrive.js'), import('./local/db.js')])
    .then(([sync, gdrive, db]) => ({ ...sync, ...gdrive, db }));
  return engine;
};

async function refresh() {
  const e = await loadEngine();
  await e.db.openDb();
  const s = e.syncState();
  const pending = s.enabled ? await e.hasUnsyncedChanges() : false;
  emit({
    ready: true, enabled: s.enabled, email: s.email, lastSyncAt: s.lastSyncAt, pending,
    phase: !s.enabled ? 'off' : status.phase === 'error' || status.phase === 'syncing' ? status.phase : hasToken() ? 'idle' : 'needs-auth',
  });
  return s;
}
export const refreshCloudStatus = () => (cloudAvailable() ? refresh() : Promise.resolve(null));

/** 跨分頁只讓一個同步在跑 */
const withLock = (fn) => (navigator.locks?.request ? navigator.locks.request('fc-cloud-sync', fn) : fn());

let running = null;
let again = false;
let timer = null;

/**
 * 同步一次。interactive：使用者按的（權杖過期時直接跳到 Google 重新取得）
 */
export async function syncNow({ interactive = false } = {}) {
  if (!cloudAvailable() || !status.enabled) return null;
  if (!hasToken()) {
    if (interactive) connectDrive({ intent: 'sync' });
    else emit({ phase: 'needs-auth' });
    return null;
  }
  if (running) { again = true; return running; }
  clearTimeout(timer);
  running = (async () => {
    emit({ phase: 'syncing', progress: '準備同步…', message: '', code: '' });
    try {
      const e = await loadEngine();
      const drive = e.driveClient(readToken);
      if (!(await checkAccount(e, drive))) return null;
      const res = await withLock(() => e.runSync({ drive, onProgress: (progress) => emit({ progress }) }));
      const s = e.syncState();
      emit({ phase: 'idle', progress: '', lastSyncAt: s.lastSyncAt, pending: res.pending });
      if (res.changed) window.dispatchEvent(new CustomEvent('fc:data-changed', { detail: res }));
      if (res.pending) again = true;
      return res;
    } catch (err) {
      console.error(err);
      if (err?.code === 'auth') {
        forgetToken();
        emit({ phase: 'needs-auth', progress: '' });
        if (interactive) connectDrive({ intent: 'sync' });
      } else {
        emit({ phase: 'error', progress: '', message: err?.message || '同步失敗', code: err?.code || '' });
      }
      return null;
    } finally {
      running = null;
      if (again) { again = false; scheduleSync(); }
    }
  })();
  return running;
}

/** 確認授權的 Google 帳號和這台裝置之前同步的是同一個；不同的話先停下來問使用者 */
async function checkAccount(e, drive) {
  let email = '';
  try {
    email = ((await drive.about())?.user?.emailAddress || '').toLowerCase();
  } catch (err) {
    if (err?.code === 'auth' || err?.code === 'network' || err?.code === 'api-disabled') throw err;
    return true; // 查不到帳號（權限範圍不含）就不檢查
  }
  const known = (e.syncState().email || '').toLowerCase();
  if (!known && email) {
    await e.saveSyncState({ email });
    emit({ email });
  } else if (known && email && known !== email) {
    emit({ phase: 'error', code: 'account', otherEmail: email, progress: '',
      message: `這次授權的是 ${email}，但這台裝置之前同步的是 ${known}。` });
    return false;
  }
  return true;
}

/** 資料有變動：停手幾秒後同步；自動同步最多每 2 分鐘一次（練習時每答一題就同步太耗流量） */
function scheduleSync(delay = AUTO_DELAY) {
  clearTimeout(timer);
  const last = Date.parse(status.lastSyncAt || '') || 0;
  const wait = Math.max(delay, last + MIN_AUTO_GAP - Date.now());
  timer = setTimeout(() => { if (hasToken()) syncNow(); else emit({ phase: status.enabled ? 'needs-auth' : 'off' }); }, wait);
}

/** 開啟同步（Google 授權回來之後） */
async function enable() {
  const e = await loadEngine();
  await e.enableSync('');
  emit({ enabled: true, phase: 'idle' });
}

/** 改用另一個帳號同步：這台裝置的資料會合併到新帳號的雲端 */
export async function useOtherAccount() {
  const e = await loadEngine();
  await e.saveSyncState({ email: status.otherEmail });
  emit({ email: status.otherEmail, otherEmail: '', phase: 'idle', code: '', message: '' });
  return syncNow({ interactive: true });
}

/** 關閉這台裝置的同步；deleteCloud：連雲端硬碟裡的資料一起刪除 */
export async function turnOffSync({ deleteCloud = false } = {}) {
  const e = await loadEngine();
  if (deleteCloud) {
    if (!hasToken()) { connectDrive({ intent: 'delete', back: '#/settings' }); return false; }
    await e.deleteCloudData(e.driveClient(readToken));
  }
  await e.disableSync({ forget: deleteCloud });
  forgetToken();
  emit({ enabled: false, phase: 'off', message: '', code: '', pending: false, ...(deleteCloud ? { email: '', lastSyncAt: null } : {}) });
  return true;
}

/** App 啟動後呼叫一次 */
export async function initCloud(authResult) {
  if (!cloudAvailable()) return;
  const e = await loadEngine();
  window.__fcGoogleEmail = (await e.db.openDb().then(() => e.db.mem.meta.get('profile')?.google?.email).catch(() => '')) || '';
  let s = await refresh();
  if (authResult && !authResult.ok) {
    toast(authResult.error, 'bad');
  } else if (authResult?.ok) {
    if (authResult.intent === 'delete') {
      try {
        await turnOffSync({ deleteCloud: true });
        toast('已刪除雲端硬碟裡的資料，這台裝置的資料保留', 'ok');
      } catch (err) { toast(err.message, 'bad'); }
      s = await refresh();
    } else {
      if (!s.enabled) await enable();
      const res = await syncNow();
      if (res) toast(authResult.intent === 'enable' ? `雲端同步已開啟：共 ${res.questions} 題` : '已同步', 'ok');
    }
  } else if (s.enabled && hasToken()) {
    syncNow();
  }

  e.db.onLocalChange(() => {
    if (!status.enabled) return;
    emit({ pending: true });
    if (hasToken()) scheduleSync();
    else emit({ phase: 'needs-auth' });
  });
  document.addEventListener('visibilitychange', () => {
    if (!status.enabled) return;
    if (document.visibilityState === 'visible') {
      const last = Date.parse(status.lastSyncAt || '') || 0;
      if (hasToken() && (status.pending || Date.now() - last > RESUME_GAP)) syncNow();
      else if (!hasToken()) emit({ phase: 'needs-auth' });
    } else if (status.pending && hasToken()) {
      syncNow(); // 切到背景前先把剛才的變動送上去
    }
  });
  window.addEventListener('online', () => { if (status.enabled && hasToken() && status.pending) syncNow(); });
}

/** 跟著同步狀態更新的元件：元件從畫面移除後自動停止更新 */
function live(el, paint) {
  let off = null;
  const update = (st) => {
    if (off && !el.isConnected) { off(); return; }
    paint(st);
  };
  update(status);
  off = onCloudStatus(update);
  return el;
}

/** 首頁的同步狀態按鈕 */
export function cloudChip() {
  const el = h('button', { type: 'button', class: 'cloud-chip', hidden: true });
  el.addEventListener('click', () => {
    if (status.phase === 'error') location.hash = '#/settings';
    else if (status.phase !== 'syncing') syncNow({ interactive: true });
  });
  return live(el, (st) => {
    el.hidden = !st.ready || !st.enabled;
    if (el.hidden) return;
    const [cls, ico, text] = st.phase === 'syncing' ? ['busy', 'cloud', '同步中…']
      : st.phase === 'error' ? ['bad', 'alert', '同步失敗，點此查看']
        : st.phase === 'needs-auth' ? ['need', 'refresh', st.pending ? '有變動還沒同步，點此同步' : '點此同步']
          : ['ok', 'cloud', st.pending ? '等待同步…' : `已同步 · ${agoText(st.lastSyncAt)}`];
    el.className = `cloud-chip ${cls}`;
    el.title = st.phase === 'error' ? st.message : st.email ? `Google 雲端硬碟：${st.email}` : '';
    clear(el, icon(ico), text);
  });
}

/** 首頁提示：還沒開啟同步的人，告訴他可以讓手機和電腦用同一份題庫（可以關掉） */
export function cloudTip() {
  const KEY = 'fc.cloudTipHidden';
  let hidden = false;
  try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* 忽略 */ }
  const el = h('div', { class: 'banner info', style: { marginBottom: '12px' }, hidden: true },
    icon('cloud'),
    h('a', { class: 'grow', href: '#/settings', style: { color: 'inherit', textDecoration: 'none' } },
      h('div', { class: 't' }, '手機和電腦想用同一份題庫？'),
      h('div', { class: 'd' }, '到「設定 → 雲端同步」開啟 Google 雲端硬碟同步，題目和練習紀錄就能隨身帶著走。')),
    h('button', { class: 'icon-btn', 'aria-label': '不要再顯示', onclick: () => {
      try { localStorage.setItem(KEY, '1'); } catch { /* 忽略 */ }
      el.remove();
    } }, icon('x')));
  if (hidden || !cloudAvailable()) return null;
  return live(el, (st) => { el.hidden = !st.ready || st.enabled; });
}

/** 「3 分鐘前」 */
export function agoText(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '尚未同步';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}
