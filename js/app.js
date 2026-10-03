// 進入點：路由、底部分頁列、首次設定／登入檢查
import { api, flushPending, MODE, onUnauthorized } from './api.js';
import { retryPendingRegistration } from './google.js';
import { state } from './store.js';
import { clear, h, icon, spinner } from './ui.js';

const routes = [
  { path: /^\/?$/, view: () => import('./views/home.js'), tab: 'home' },
  { path: /^\/practice$/, view: () => import('./views/practice.js'), bare: true },
  { path: /^\/bank$/, view: () => import('./views/bank.js'), tab: 'bank' },
  { path: /^\/q\/(\d+)$/, view: () => import('./views/question.js'), tab: 'bank' },
  { path: /^\/new$/, view: () => import('./views/editor.js'), bare: true },
  { path: /^\/edit\/(\d+)$/, view: () => import('./views/editor.js'), bare: true },
  { path: /^\/import$/, view: () => import('./views/import.js'), tab: 'bank' },
  { path: /^\/add$/, view: () => import('./views/add.js'), tab: 'add' },
  { path: /^\/papers$/, view: () => import('./views/papers.js'), tab: 'bank' },
  { path: /^\/papers\/upload$/, view: () => import('./views/paper_upload.js'), bare: true },
  { path: /^\/paper\/(\d+)$/, view: () => import('./views/paper.js'), tab: 'bank' },
  { path: /^\/stats$/, view: () => import('./views/stats.js'), tab: 'stats' },
  { path: /^\/settings$/, view: () => import('./views/settings.js'), tab: 'settings' },
  { path: /^\/login$/, view: () => import('./views/login.js'), bare: true, public: true },
  { path: /^\/setup$/, view: () => import('./views/setup.js'), bare: true, public: true },
];

const TABS = [
  { id: 'home', href: '#/', label: '首頁', icon: 'home' },
  { id: 'bank', href: '#/bank', label: '題庫', icon: 'layers' },
  { id: 'add', href: '#/add', label: '新增', icon: 'plus' },
  { id: 'stats', href: '#/stats', label: '統計', icon: 'chart' },
  { id: 'settings', href: '#/settings', label: '設定', icon: 'sliders' },
];

const root = document.getElementById('app');
const tabbar = document.getElementById('tabbar');
let cleanup = null;
let renderToken = 0;

export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (replace) {
    history.replaceState(null, '', target);
    render();
  } else if (location.hash === target) {
    render();
  } else {
    location.hash = target;
  }
}

/** 返回上一頁；如果是直接開啟此頁（沒有上一頁）就前往 fallback */
export function goBack(fallback = '#/') {
  if (history.state?.fromApp) history.back();
  else navigate(fallback, { replace: true });
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}

function renderTabbar(active) {
  clear(tabbar, h('div', { class: 'inner' }, TABS.map((t) => h('a', {
    href: t.href,
    class: `tab ${t.id === 'add' ? 'add' : ''} ${t.id === active ? 'active' : ''}`,
    'aria-current': t.id === active ? 'page' : null,
  }, t.id === 'add' ? h('span', { class: 'bubble' }, icon(t.icon)) : icon(t.icon), t.label))));
}

async function render() {
  const token = ++renderToken;
  const { path, query } = parseHash();
  const route = routes.find((r) => r.path.test(path)) || routes[0];
  const params = path.match(route.path)?.slice(1) ?? [];

  if (MODE === 'local') {
    // 本機模式：沒有登入，第一次使用先跑設定精靈
    if (!state.user?.setupDone && path !== '/setup') {
      navigate('#/setup', { replace: true });
      return;
    }
  } else if (!route.public && !state.user) {
    navigate('#/login', { replace: true });
    return;
  }
  if (cleanup) { try { cleanup(); } catch { /* 忽略 */ } cleanup = null; }

  tabbar.hidden = Boolean(route.bare);
  if (!route.bare) renderTabbar(route.tab);
  clear(root, spinner());

  const mod = await route.view();
  if (token !== renderToken) return; // 期間又切換了頁面
  const container = h('div', { class: 'screen' });
  clear(root, container);
  window.scrollTo(0, 0);
  try {
    cleanup = (await mod.render({ root: container, params, query })) || null;
  } catch (err) {
    console.error(err);
    if (token === renderToken && err?.status !== 401) {
      clear(container, h('div', { class: 'page' }, h('div', { class: 'empty' },
        h('h3', null, '頁面載入失敗'), h('p', null, err?.message || '請稍後再試'),
        h('button', { class: 'btn btn-primary', onclick: () => render() }, '重新整理'))));
    }
  }
}

onUnauthorized(() => {
  state.user = null;
  if (parseHash().path !== '/login') navigate('#/login', { replace: true });
});

// 「安裝到主畫面」：Android／電腦版 Chrome、Edge 會先發出這個事件，留著給設定頁的按鈕使用
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
});

async function boot() {
  try {
    state.user = await api.get('/api/auth/me', { allow401: true });
  } catch (err) {
    state.user = null;
    if (MODE === 'local') {
      clear(root, h('div', { class: 'page' }, h('div', { class: 'empty' },
        h('h3', null, '無法開啟本機資料'), h('p', null, err?.message || '請重新整理'),
        h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, '重新整理'))));
      return;
    }
  }
  window.addEventListener('hashchange', () => {
    history.replaceState({ ...(history.state || {}), fromApp: true }, '');
    render();
  });
  await render();
  if (MODE === 'server') {
    window.addEventListener('online', flushPending);
    if (state.user) flushPending();
  } else {
    retryPendingRegistration();
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
