// API 呼叫：本機模式交給 js/local/api.js（資料存在這台裝置）；伺服器模式用 fetch 呼叫 Python 後端
import { ApiError } from './local/errors.js';

export { ApiError };
export const MODE = window.FC_CONFIG?.backend === 'server' ? 'server' : 'local';
const PENDING_KEY = 'fc.pendingAnswers';

let localEngine = null;
async function localRequest(method, path, body) {
  localEngine = localEngine || import('./local/api.js');
  const engine = await localEngine;
  try {
    return await engine.handle(method, path, body);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error(err);
    throw new ApiError(500, err?.message || '發生錯誤');
  }
}

let unauthorizedHandler = () => {};
export function onUnauthorized(fn) { unauthorizedHandler = fn; }

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const first = detail[0];
    const field = first?.loc?.slice(-1)[0];
    return `輸入資料有誤${field ? `（${field}）` : ''}：${first?.msg ?? ''}`;
  }
  return String(detail);
}

async function request(method, path, body, { allow401 = false } = {}) {
  if (MODE === 'local') return localRequest(method, path, body);
  const headers = {
    'X-Requested-With': 'fetch',
    'X-TZ-Offset': String(new Date().getTimezoneOffset()),
  };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body;
    headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, '無法連線到伺服器，請檢查網路');
  }
  if (res.status === 401 && !allow401) {
    unauthorizedHandler();
    throw new ApiError(401, '請先登入');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.blob();
  if (!res.ok) throw new ApiError(res.status, formatDetail(data?.detail) || `發生錯誤（${res.status}）`);
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

// ---- 作答紀錄：送不出去時存在本機，之後自動補送（伺服器以 clientId 去重）

function readPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; }
}
function writePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-500))); } catch { /* 無法存取就算了 */ }
}

export function newClientId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function submitAnswer(payload) {
  try {
    return await api.post('/api/practice/answer', payload);
  } catch (err) {
    if (err.status === 0) writePending([...readPending(), payload]);
    else if (err.status !== 404) throw err; // 題目已被刪除就不重送
    return null;
  }
}

let flushing = false;
export async function flushPending() {
  if (flushing) return;
  const list = readPending();
  if (!list.length) return;
  flushing = true;
  const remain = [];
  for (const item of list) {
    try {
      await api.post('/api/practice/answer', item);
    } catch (err) {
      if (err.status === 0 || err.status === 401) remain.push(item);
    }
  }
  writePending(remain);
  flushing = false;
}
