// 全域狀態：登入使用者、本機偏好（字體、主題、上次的練習設定）
import { api } from './api.js';

export const state = {
  user: null,
  subjects: null, // 快取，新增/修改題目後清掉
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ }
}

export const prefs = {
  get fontScale() { return read('fc.fontScale', 1); },
  set fontScale(v) {
    write('fc.fontScale', v);
    document.documentElement.style.setProperty('--fs-scale', String(v));
  },
  get theme() {
    try { return localStorage.getItem('fc.theme') || 'auto'; } catch { return 'auto'; }
  },
  set theme(v) {
    try { localStorage.setItem('fc.theme', v); } catch { /* 忽略 */ }
    if (v === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
  },
  get practice() { return read('fc.practice', { mode: 'random', subjectIds: [], limit: 20, weakFirst: true }); },
  set practice(v) { write('fc.practice', v); },
};

export async function loadSubjects(force = false) {
  if (!state.subjects || force) state.subjects = await api.get('/api/subjects');
  return state.subjects;
}

export function invalidateSubjects() { state.subjects = null; }

export function userSettings() {
  return state.user?.settings || { newPerDay: 20, shuffleOptions: true };
}
