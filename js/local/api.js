// 本機引擎：用與伺服器版相同的 API 路徑與回應格式，資料全部存在這台裝置（IndexedDB）。
// 畫面程式只要呼叫 api.get('/api/...')，不需要知道資料在哪裡。
import { ApiError } from './errors.js';
import { all, mem, openDb, requestPersistence, write } from './db.js';
import { buildPaper, extractText } from './exam.js';
import { buildTemplate, parseWorkbook } from './importer.js';
import { GRADES, MASTERED_DAYS, newCard, schedule } from './srs.js';
import { cleanNote, contentHash, nowIso } from './textutil.js';

const MAX_OPTIONS = 8;
const MAX_IMAGES = 6;
const MAX_IMAGE_CHARS = 4_000_000; // 單張圖片（data URL）上限約 3 MB
const IMAGE_SRC = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DEFAULT_PROFILE = {
  key: 'profile', nickname: '', exam: '', newPerDay: 20, shuffleOptions: true,
  storage: 'device', setupDone: false, google: null, createdAt: null,
};

// ---------------------------------------------------------------- 路由

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

export async function handle(method, path, body) {
  await openDb();
  const url = new URL(path, 'http://local');
  const query = Object.fromEntries(url.searchParams);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = url.pathname.match(r.re);
    if (m) return r.fn({ params: m.slice(1).map(Number), query, body });
  }
  throw new ApiError(404, '找不到這個功能');
}

// ---------------------------------------------------------------- 共用

const fail = (status, message) => { throw new ApiError(status, message); };
const isReady = (q) => q.status === 'ok' && Boolean(q.answer);
const cardOf = (qid) => mem.cards.get(qid) || null;
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfToday = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const str = (v, max) => String(v ?? '').slice(0, max);

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function profile() {
  return { ...DEFAULT_PROFILE, ...(mem.meta.get('profile') || {}) };
}

async function saveProfile(changes) {
  const p = { ...profile(), ...changes, key: 'profile' };
  await write([{ op: 'put', store: 'meta', value: p }]);
  return p;
}

function userOut(p = profile()) {
  return {
    id: 1,
    username: p.google?.email || '本機使用者',
    displayName: p.nickname || p.google?.name || '同學',
    settings: { newPerDay: p.newPerDay, shuffleOptions: p.shuffleOptions },
    exam: p.exam, storage: p.storage, google: p.google, setupDone: p.setupDone, local: true,
  };
}

function cardOut(c) {
  if (!c) return null;
  return { attempts: c.attempts, correct: c.correct, lapses: c.lapses, lastResult: c.lastResult, dueAt: c.dueAt, interval: c.interval, reps: c.reps, lastAt: c.lastAt };
}

function questionOut(q) {
  const paper = q.paperId ? mem.papers.get(q.paperId) : null;
  return {
    id: q.id, subjectId: q.subjectId, subject: mem.subjects.get(q.subjectId)?.name ?? '',
    source: q.source, stem: q.stem, options: q.options, answer: q.answer, images: q.images || [],
    keypoint: q.keypoint, mistake: q.mistake, concept: q.concept, note: q.note, tags: q.tags || [],
    status: q.status, statusNote: q.statusNote, starred: Boolean(q.starred),
    createdAt: q.createdAt, updatedAt: q.updatedAt,
    paperId: q.paperId ?? null, paperTitle: paper?.title ?? null, number: q.number ?? null,
    card: cardOut(cardOf(q.id)),
  };
}

function getQuestion(id) {
  return mem.questions.get(id) || fail(404, '找不到這一題');
}

function newQuestionRecord(subjectId, q, origin = 'manual', paperId = null, number = null) {
  const now = nowIso();
  return {
    subjectId, source: q.source || '', stem: q.stem || '', options: q.options || [], answer: q.answer || '', images: q.images || [],
    keypoint: q.keypoint || '', mistake: q.mistake || '', concept: q.concept || '', note: q.note || '',
    tags: q.tags || [], status: q.status, statusNote: q.statusNote || '', starred: false,
    contentHash: q.contentHash, origin, createdAt: now, updatedAt: now, paperId, number,
  };
}

/** 刪除題目時一併刪掉它的練習紀錄 */
function deleteQuestionOps(ids) {
  const set = new Set(ids);
  const ops = [];
  for (const id of set) ops.push({ op: 'delete', store: 'questions', key: id }, { op: 'delete', store: 'cards', key: id });
  for (const r of mem.reviews.values()) if (set.has(r.questionId)) ops.push({ op: 'delete', store: 'reviews', key: r.id });
  return ops;
}

// ---------------------------------------------------------------- 個人設定

route('GET', '/api/auth/me', () => userOut());
route('GET', '/api/auth/config', () => ({ inviteRequired: false, local: true }));

route('PUT', '/api/auth/me', async ({ body }) => {
  const changes = {};
  if (body.displayName != null) changes.nickname = str(body.displayName, 40).trim();
  if (body.settings) {
    if ('newPerDay' in body.settings) changes.newPerDay = Math.max(0, Math.min(500, Number(body.settings.newPerDay) || 0));
    if ('shuffleOptions' in body.settings) changes.shuffleOptions = Boolean(body.settings.shuffleOptions);
  }
  return userOut(await saveProfile(changes));
});

/** 首次設定：建立科目、儲存偏好 */
route('POST', '/api/setup', async ({ body }) => {
  const exam = str(body.exam, 40).trim();
  const names = [...new Set((body.subjects || []).map((s) => str(s, 40).trim()).filter(Boolean))];
  for (const name of names) await getOrCreateSubject(name, exam);
  const p = await saveProfile({
    nickname: str(body.nickname, 40).trim(), exam,
    newPerDay: Math.max(0, Math.min(500, Number(body.newPerDay) || 0)),
    shuffleOptions: body.shuffleOptions !== false, storage: body.storage === 'gdrive' ? 'gdrive' : 'device',
    google: body.google || profile().google, setupDone: true, createdAt: profile().createdAt || nowIso(),
  });
  requestPersistence();
  return userOut(p);
});

route('PUT', '/api/profile/google', async ({ body }) => userOut(await saveProfile({ google: body.google || null })));
route('POST', '/api/profile/reset-setup', async () => userOut(await saveProfile({ setupDone: false })));

// ---------------------------------------------------------------- 科目

async function getOrCreateSubject(name, category = '') {
  const clean = str(name, 40).trim() || fail(400, '科目名稱不可空白');
  const found = all('subjects').find((s) => s.name === clean);
  if (found) {
    if (category.trim() && found.category !== category.trim()) {
      await write([{ op: 'put', store: 'subjects', value: { ...found, category: category.trim() } }]);
    }
    return found.id;
  }
  const order = Math.max(0, ...all('subjects').map((s) => s.sortOrder || 0)) + 1;
  const [id] = await write([{ op: 'add', store: 'subjects', value: { name: clean, category: category.trim(), sortOrder: order, createdAt: nowIso() } }]);
  return id;
}

const ownSubject = (id) => mem.subjects.get(id) || fail(404, '找不到這個科目');
const sortedSubjects = () => all('subjects').sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id);

route('GET', '/api/subjects', () => sortedSubjects().map((s) => {
  const qs = all('questions').filter((q) => q.subjectId === s.id);
  return { id: s.id, name: s.name, category: s.category || '', total: qs.length, ready: qs.filter(isReady).length };
}));

route('POST', '/api/subjects', async ({ body }) => {
  const name = str(body.name, 40).trim();
  if (all('subjects').some((s) => s.name === name)) fail(409, '已經有同名的科目');
  return { id: await getOrCreateSubject(name, body.category || '') };
});

route('PATCH', '/api/subjects/(\\d+)', async ({ params: [id], body }) => {
  const s = { ...ownSubject(id) };
  if (body.name != null) {
    const name = str(body.name, 40).trim() || fail(400, '科目名稱不可空白');
    if (all('subjects').some((x) => x.name === name && x.id !== id)) fail(409, '已經有同名的科目');
    s.name = name;
  }
  if (body.category != null) s.category = str(body.category, 40).trim();
  if (body.sortOrder != null) s.sortOrder = Number(body.sortOrder) || 0;
  await write([{ op: 'put', store: 'subjects', value: s }]);
  return { ok: true };
});

route('DELETE', '/api/subjects/(\\d+)', async ({ params: [id] }) => {
  ownSubject(id);
  const ops = deleteQuestionOps(all('questions').filter((q) => q.subjectId === id).map((q) => q.id));
  const deadPapers = new Set(all('papers').filter((p) => p.subjectId === id).map((p) => p.id));
  for (const pid of deadPapers) ops.push({ op: 'delete', store: 'papers', key: pid });
  for (const q of all('questions')) {
    if (q.subjectId !== id && deadPapers.has(q.paperId)) ops.push({ op: 'put', store: 'questions', value: { ...q, paperId: null, number: null } });
  }
  ops.push({ op: 'delete', store: 'subjects', key: id });
  await write(ops);
  return { ok: true };
});

// ---------------------------------------------------------------- 題目

/** 題目附圖：只接受 JPEG／PNG／WebP／GIF 的 data URL（不接受 SVG），最多 6 張 */
function normalizeImages(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_IMAGES) fail(400, `每題最多 ${MAX_IMAGES} 張圖片`);
  return list.map((img) => {
    const src = String(img?.src || '');
    if (src.length > MAX_IMAGE_CHARS) fail(400, '圖片太大，請換一張較小的圖片');
    if (!IMAGE_SRC.test(src)) fail(400, '圖片格式不正確，請用 JPG 或 PNG');
    const dim = (v) => Math.max(0, Math.min(20000, Math.round(Number(v) || 0)));
    return { src, w: dim(img.w), h: dim(img.h) };
  });
}

function normalizeQuestion(body) {
  const stem = str(body.stem, 20000).trim();
  const options = [];
  const keyMap = new Map();
  for (const o of body.options || []) {
    const text = str(o.text, 5000).trim();
    if (!text) continue;
    const key = String.fromCharCode(65 + options.length);
    keyMap.set(String(o.key || key).trim().toUpperCase(), key);
    options.push({
      key, text, mark: str(o.mark, 40).trim(),
      mistake: cleanNote(str(o.mistake, 10000)), concept: cleanNote(str(o.concept, 10000)), note: cleanNote(str(o.note, 10000)),
    });
  }
  if (options.length > MAX_OPTIONS) fail(400, `選項最多 ${MAX_OPTIONS} 個`);
  if (!stem && !options.length) fail(400, '題目內容不可空白');
  const answer = keyMap.get(String(body.answer || '').trim().toUpperCase()) || '';
  let status = 'ok';
  let statusNote = '';
  if (!stem) [status, statusNote] = ['incomplete', '缺少題幹，請補上題目內容'];
  else if (options.length < 2) [status, statusNote] = ['incomplete', '至少需要 2 個選項'];
  else if (!answer) [status, statusNote] = ['review', '尚未指定正確答案'];
  const tags = [...new Set((body.tags || []).map((t) => str(t, 30).trim()).filter(Boolean))].slice(0, 20);
  return {
    source: str(body.source, 200).trim(), stem, options, answer,
    keypoint: cleanNote(str(body.keypoint, 10000)), mistake: cleanNote(str(body.mistake, 10000)),
    concept: cleanNote(str(body.concept, 10000)), note: cleanNote(str(body.note, 10000)),
    tags, status, statusNote, contentHash: contentHash(stem, options.map((o) => o.text)),
    // 沒有帶 images 欄位（舊版畫面）就不動原本的圖片
    ...(Array.isArray(body.images) ? { images: normalizeImages(body.images) } : {}),
  };
}

async function resolveSubject(body) {
  if (body.subjectId) return ownSubject(Number(body.subjectId)).id;
  if (body.subjectName && String(body.subjectName).trim()) return getOrCreateSubject(body.subjectName);
  return fail(400, '請選擇科目');
}

function searchText(q) {
  return [q.stem, q.source, q.keypoint, q.mistake, q.concept, q.note, (q.tags || []).join(' '),
    ...q.options.map((o) => [o.text, o.mark, o.mistake, o.concept, o.note].join(' '))].join('\n').toLowerCase();
}

route('GET', '/api/questions', ({ query }) => {
  let base = all('questions');
  if (query.subject_id) base = base.filter((q) => q.subjectId === Number(query.subject_id));
  if (query.paper_id) base = base.filter((q) => q.paperId === Number(query.paper_id));
  if (query.q && query.q.trim()) {
    const needle = query.q.trim().toLowerCase();
    base = base.filter((q) => searchText(q).includes(needle));
  }
  const counts = {
    all: base.length,
    review: base.filter((q) => q.status === 'review').length,
    incomplete: base.filter((q) => q.status === 'incomplete').length,
    starred: base.filter((q) => q.starred).length,
    wrong: base.filter((q) => cardOf(q.id)?.lastResult === 0).length,
  };
  let list = base;
  if (query.status) list = list.filter((q) => q.status === query.status);
  if (query.starred === 'true') list = list.filter((q) => q.starred);
  if (query.wrong === 'true') list = list.filter((q) => cardOf(q.id)?.lastResult === 0);
  const wrongCount = (q) => { const c = cardOf(q.id); return c ? c.attempts - c.correct : 0; };
  const sorters = {
    recent: (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || b.id - a.id,
    oldest: (a, b) => a.id - b.id,
    wrong: (a, b) => wrongCount(b) - wrongCount(a) || b.id - a.id,
    number: (a, b) => (a.paperId || 0) - (b.paperId || 0) || (a.number || 0) - (b.number || 0) || a.id - b.id,
  };
  list = [...list].sort(sorters[query.sort] || sorters.recent);
  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
  return { items: list.slice(offset, offset + limit).map(questionOut), total: list.length, counts };
});

route('GET', '/api/questions/(\\d+)', ({ params: [id] }) => questionOut(getQuestion(id)));

route('POST', '/api/questions', async ({ body }) => {
  const subjectId = await resolveSubject(body);
  const record = newQuestionRecord(subjectId, normalizeQuestion(body));
  const [id] = await write([{ op: 'add', store: 'questions', value: record }]);
  return questionOut(mem.questions.get(id));
});

route('PUT', '/api/questions/(\\d+)', async ({ params: [id], body }) => {
  const old = getQuestion(id);
  const subjectId = await resolveSubject(body);
  const q = { ...old, ...normalizeQuestion(body), subjectId, updatedAt: nowIso() };
  await write([{ op: 'put', store: 'questions', value: q }]);
  return questionOut(q);
});

route('PATCH', '/api/questions/(\\d+)', async ({ params: [id], body }) => {
  const q = { ...getQuestion(id) };
  if (body.starred != null) q.starred = Boolean(body.starred);
  if (body.answer != null) {
    const answer = String(body.answer).trim().toUpperCase();
    if (!q.options.some((o) => o.key === answer)) fail(400, '答案必須是其中一個選項');
    q.answer = answer;
    if (q.stem && q.options.length >= 2) { q.status = 'ok'; q.statusNote = ''; }
    q.updatedAt = nowIso();
  }
  await write([{ op: 'put', store: 'questions', value: q }]);
  return questionOut(q);
});

route('DELETE', '/api/questions/(\\d+)', async ({ params: [id] }) => {
  getQuestion(id);
  await write(deleteQuestionOps([id]));
  return { ok: true };
});

// ---------------------------------------------------------------- Excel 訂正本匯入

async function parseUpload(body, filename) {
  if (!(body instanceof Blob) || !body.size) fail(400, '沒有收到檔案');
  try {
    return await parseWorkbook(await body.arrayBuffer(), filename);
  } catch (err) {
    return fail(400, err.message?.includes('瀏覽器') ? err.message : '無法讀取這個檔案，請確認是 .xlsx 格式');
  }
}

route('POST', '/api/import/preview', async ({ query, body }) => {
  const parsed = await parseUpload(body, query.filename || '');
  const hashes = new Set(all('questions').map((q) => q.contentHash));
  const items = parsed.questions.map((q) => ({
    row: q.row, source: q.source, stem: q.stem.slice(0, 140), status: q.status, statusNote: q.statusNote,
    answer: q.answer, optionCount: q.options.length, duplicate: hashes.has(q.contentHash),
  }));
  return {
    filename: query.filename || '', subject: parsed.subject, sheets: parsed.sheets,
    stats: { ...parsed.stats, alreadyImported: items.filter((i) => i.duplicate).length }, items,
  };
});

route('POST', '/api/import/commit', async ({ query, body }) => {
  const parsed = await parseUpload(body, query.filename || '');
  const subjectId = await getOrCreateSubject(query.subject || parsed.subject, query.category || '');
  const existing = new Set(all('questions').filter((q) => q.subjectId === subjectId).map((q) => q.contentHash));
  const ops = [];
  let skipped = 0;
  for (const q of parsed.questions) {
    if (existing.has(q.contentHash)) { skipped += 1; continue; }
    existing.add(q.contentHash);
    ops.push({ op: 'add', store: 'questions', value: newQuestionRecord(subjectId, q, `import:${parsed.filename}#${q.sheet}!R${q.row}`) });
  }
  await write(ops);
  return { subjectId, inserted: ops.length, skippedDuplicates: skipped };
});

route('GET', '/api/import/template', () => new Blob([buildTemplate()], {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}));

// ---------------------------------------------------------------- 備份與還原

route('GET', '/api/export', () => {
  const { google, ...prefs } = profile();
  return {
    app: 'cuoti-flashcards', version: 2, exportedAt: nowIso(), appVersion: window.FC_CONFIG?.appVersion || '',
    profile: prefs, subjects: all('subjects'), papers: all('papers'), questions: all('questions'),
    cards: all('cards'), reviews: all('reviews'),
  };
});

/** 接受本 App 的備份（version 2）或伺服器版的匯出（version 1）；會取代這台裝置上的所有題目與紀錄 */
route('POST', '/api/backup/restore', async ({ body }) => {
  let data;
  try {
    data = body instanceof Blob ? JSON.parse(await body.text()) : body;
  } catch {
    fail(400, '備份檔格式不正確');
  }
  if (!data || !Array.isArray(data.subjects) || !Array.isArray(data.questions)) fail(400, '這不是錯題閃卡的備份檔');
  const ops = ['subjects', 'papers', 'questions', 'cards', 'reviews'].map((store) => ({ op: 'clear', store }));
  if (data.version === 2) {
    for (const store of ['subjects', 'papers', 'questions', 'cards', 'reviews']) {
      for (const value of data[store] || []) ops.push({ op: 'put', store, value });
    }
  } else {
    // 伺服器版匯出：題目裡附帶練習摘要，沒有考古題卷與逐筆作答紀錄
    for (const s of data.subjects) ops.push({ op: 'put', store: 'subjects', value: { id: s.id, name: s.name, category: s.category || '', sortOrder: s.sort_order || 0, createdAt: nowIso() } });
    for (const q of data.questions) {
      const { card, subject, paperTitle, ...rest } = q;
      ops.push({ op: 'put', store: 'questions', value: { ...rest, paperId: null, number: null, contentHash: contentHash(q.stem, q.options.map((o) => o.text)), origin: 'restore' } });
      if (card) ops.push({ op: 'put', store: 'cards', value: { ...newCard(q.id), ...card, ease: 2.5, questionId: q.id } });
    }
  }
  await write(ops);
  return { ok: true, subjects: mem.subjects.size, questions: mem.questions.size };
});

route('POST', '/api/data/clear', async () => {
  await write(['subjects', 'papers', 'questions', 'cards', 'reviews'].map((store) => ({ op: 'clear', store })));
  return { ok: true };
});

// ---------------------------------------------------------------- 首頁、出題、作答、統計

function newIntroducedToday(since) {
  const first = new Map();
  for (const r of mem.reviews.values()) {
    if (!first.has(r.questionId) || r.createdAt < first.get(r.questionId)) first.set(r.questionId, r.createdAt);
  }
  return [...first.values()].filter((t) => t >= since).length;
}

function streak() {
  const days = new Set([...mem.reviews.values()].map((r) => localDate(new Date(r.createdAt))));
  if (!days.size) return 0;
  const cursor = startOfToday();
  if (!days.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (days.has(localDate(cursor))) { n += 1; cursor.setDate(cursor.getDate() - 1); }
  return n;
}

route('GET', '/api/dashboard', () => {
  const p = profile();
  const dayStart = startOfToday();
  const dayEnd = new Date(dayStart.getTime() + 86400000).toISOString();
  const questions = all('questions');
  const subjects = sortedSubjects().map((s) => {
    const qs = questions.filter((q) => q.subjectId === s.id);
    const ready = qs.filter(isReady);
    const withCard = (fn) => ready.filter((q) => fn(cardOf(q.id))).length;
    return {
      id: s.id, name: s.name, category: s.category || '',
      ready: ready.length,
      unseen: withCard((c) => !c),
      fresh: ready.filter((q) => !cardOf(q.id) && !q.paperId).length,
      due: withCard((c) => c && c.dueAt && c.dueAt < dayEnd),
      wrong: withCard((c) => c && c.lastResult === 0),
      mastered: withCard((c) => c && c.interval >= MASTERED_DAYS),
      attempts: qs.reduce((a, q) => a + (cardOf(q.id)?.attempts || 0), 0),
      correct: qs.reduce((a, q) => a + (cardOf(q.id)?.correct || 0), 0),
      total: qs.length,
    };
  });
  const sum = (k) => subjects.reduce((a, s) => a + s[k], 0);
  const since = dayStart.toISOString();
  const today = [...mem.reviews.values()].filter((r) => r.createdAt >= since);
  const quota = Math.max(0, p.newPerDay - newIntroducedToday(since));
  return {
    due: sum('due'), newAvailable: Math.min(sum('fresh'), quota), unseen: sum('unseen'), wrong: sum('wrong'),
    starred: questions.filter((q) => q.starred && isReady(q)).length, ready: sum('ready'),
    review: questions.filter((q) => q.status === 'review').length,
    incomplete: questions.filter((q) => q.status === 'incomplete').length,
    todayDone: today.length, todayCorrect: today.filter((r) => r.isCorrect).length,
    streak: streak(), subjects,
  };
});

function weightedSample(list, k) {
  const weight = (q) => {
    const c = cardOf(q.id);
    let w = 1;
    if (c?.lastResult === 0) w += 3;
    if (c?.attempts) w += (3 * (c.attempts - c.correct)) / c.attempts;
    else w += 1; // 沒做過的也優先一點
    return w;
  };
  return list.map((q) => [Math.random() ** (1 / weight(q)), q]).sort((a, b) => b[0] - a[0]).slice(0, k).map((x) => x[1]);
}

route('POST', '/api/practice/start', ({ body }) => {
  const limit = Math.min(1000, Math.max(1, Number(body.limit) || 20));
  let pool = all('questions').filter(isReady);
  if (body.subjectIds?.length) pool = pool.filter((q) => body.subjectIds.includes(q.subjectId));
  if (body.paperId) pool = pool.filter((q) => q.paperId === body.paperId);
  const unseen = (q) => !cardOf(q.id);
  let rows;
  switch (body.mode) {
    case 'paper': {
      if (!body.paperId) fail(400, '沒有指定考古題');
      rows = body.unseenOnly ? pool.filter(unseen) : pool;
      rows = body.ordered ? rows.sort((a, b) => (a.number || 0) - (b.number || 0) || a.id - b.id) : shuffleInPlace(rows);
      rows = rows.slice(0, limit);
      break;
    }
    case 'ids': {
      if (!body.ids?.length) fail(400, '沒有指定題目');
      const order = new Map(body.ids.map((id, i) => [id, i]));
      rows = pool.filter((q) => order.has(q.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
      break;
    }
    case 'due': {
      const dayStart = startOfToday();
      const dayEnd = new Date(dayStart.getTime() + 86400000).toISOString();
      const due = pool.filter((q) => { const c = cardOf(q.id); return c && c.dueAt && c.dueAt < dayEnd; })
        .sort((a, b) => cardOf(a.id).dueAt.localeCompare(cardOf(b.id).dueAt)).slice(0, limit);
      const quota = Math.max(0, profile().newPerDay - newIntroducedToday(dayStart.toISOString()));
      const fresh = shuffleInPlace(pool.filter((q) => unseen(q) && !q.paperId)).slice(0, quota);
      rows = shuffleInPlace([...due, ...fresh]);
      break;
    }
    case 'new': rows = shuffleInPlace(pool.filter(unseen)).slice(0, limit); break;
    case 'wrong': rows = shuffleInPlace(pool.filter((q) => cardOf(q.id)?.lastResult === 0)).slice(0, limit); break;
    case 'starred': rows = shuffleInPlace(pool.filter((q) => q.starred)).slice(0, limit); break;
    case 'random': rows = body.weakFirst ? weightedSample(pool, limit) : shuffleInPlace([...pool]).slice(0, limit); break;
    default: fail(400, '不支援的練習模式');
  }
  return { mode: body.mode, questions: rows.map(questionOut) };
});

route('POST', '/api/practice/answer', async ({ body }) => {
  const q = mem.questions.get(Number(body.questionId));
  if (!q || (body.questionCreatedAt && body.questionCreatedAt !== q.createdAt)) fail(404, '找不到這一題');
  if (body.clientId && [...mem.reviews.values()].some((r) => r.clientId === body.clientId)) {
    return { correct: String(body.chosen).toUpperCase() === q.answer, card: cardOut(cardOf(q.id)), duplicate: true };
  }
  const chosen = String(body.chosen || '').trim().toUpperCase();
  const correct = chosen === q.answer;
  let grade = GRADES.includes(body.grade) ? body.grade : 'good';
  if (!correct) grade = 'again';
  else if (grade === 'again') grade = 'good';
  const now = new Date();
  const card = schedule(cardOf(q.id) || newCard(q.id), grade, now);
  await write([
    { op: 'put', store: 'cards', value: card },
    { op: 'add', store: 'reviews', value: { questionId: q.id, chosen, isCorrect: correct, grade, mode: str(body.mode, 20), durationMs: body.durationMs ?? null, clientId: body.clientId || null, createdAt: now.toISOString() } },
  ]);
  return { correct, card: cardOut(card) };
});

route('GET', '/api/stats', ({ query }) => {
  const days = Math.min(365, Math.max(7, Number(query.days) || 30));
  const first = startOfToday();
  first.setDate(first.getDate() - (days - 1));
  const byDay = new Map();
  for (const r of mem.reviews.values()) {
    const d = localDate(new Date(r.createdAt));
    const e = byDay.get(d) || { attempts: 0, correct: 0 };
    e.attempts += 1;
    if (r.isCorrect) e.correct += 1;
    byDay.set(d, e);
  }
  const daily = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    const key = localDate(d);
    daily.push({ date: key, ...(byDay.get(key) || { attempts: 0, correct: 0 }) });
  }
  const questions = all('questions');
  const cards = questions.map((q) => cardOf(q.id)).filter(Boolean);
  const hardest = questions.filter((q) => { const c = cardOf(q.id); return c && c.attempts > c.correct; })
    .sort((a, b) => {
      const ca = cardOf(a.id);
      const cb = cardOf(b.id);
      return (cb.attempts - cb.correct) - (ca.attempts - ca.correct) || cb.lapses - ca.lapses || (cb.lastAt || '').localeCompare(ca.lastAt || '');
    })
    .slice(0, 10)
    .map((q) => {
      const c = cardOf(q.id);
      return { id: q.id, subject: mem.subjects.get(q.subjectId)?.name ?? '', source: q.source, stem: q.stem.slice(0, 80), attempts: c.attempts, wrong: c.attempts - c.correct };
    });
  return {
    days, daily, streak: streak(), hardest,
    totals: {
      questions: questions.length, ready: questions.filter(isReady).length,
      practiced: cards.filter((c) => c.attempts > 0).length, mastered: cards.filter((c) => c.interval >= MASTERED_DAYS).length,
      attempts: cards.reduce((a, c) => a + c.attempts, 0), correct: cards.reduce((a, c) => a + c.correct, 0),
    },
  };
});

// ---------------------------------------------------------------- 考古題卷

route('POST', '/api/papers/extract', async ({ body, query }) => {
  if (!(body instanceof Blob) || !body.size) fail(400, '沒有收到檔案');
  if (body.size > 30 * 1024 * 1024) fail(413, '檔案太大（上限 30MB）');
  try {
    return await extractText(body, query.filename || '');
  } catch (err) {
    return fail(400, err.message || '無法讀取這個檔案');
  }
});

function parsePaper(body) {
  if (!String(body.questionsText || '').trim()) fail(400, '請先上傳或貼上試題');
  const figures = Array.isArray(body.figures) ? body.figures.filter((f) => IMAGE_SRC.test(String(f?.src || '')) && String(f.src).length <= MAX_IMAGE_CHARS) : [];
  const parsed = buildPaper(String(body.questionsText), String(body.answersText || ''), String(body.filename || ''), figures);
  const existing = new Map();
  for (const q of all('questions').sort((a, b) => (a.paperId ? 1 : 0) - (b.paperId ? 1 : 0))) {
    if (!existing.has(q.contentHash)) existing.set(q.contentHash, q); // 優先對應訂正本的題目
  }
  let linked = 0;
  let dup = 0;
  for (const q of parsed.questions) {
    q.hash = contentHash(q.stem, q.options.map((o) => o.text));
    const row = existing.get(q.hash);
    q.duplicate = !row ? null : row.paperId ? 'paper' : 'notebook';
    q.existingId = row ? row.id : null;
    if (q.duplicate === 'notebook') linked += 1;
    if (q.duplicate === 'paper') dup += 1;
  }
  parsed.stats = { ...parsed.stats, linked, alreadyUploaded: dup };
  return parsed;
}

route('POST', '/api/papers/preview', ({ body }) => {
  const parsed = parsePaper(body);
  parsed.questions.forEach((q) => { delete q.hash; });
  return parsed;
});

route('POST', '/api/papers', async ({ body }) => {
  const parsed = parsePaper(body);
  if (!parsed.questions.length) fail(400, '沒有解析到任何題目，請確認試題內容');
  const subjectId = body.subjectId ? ownSubject(Number(body.subjectId)).id
    : body.subjectName && String(body.subjectName).trim() ? await getOrCreateSubject(body.subjectName) : fail(400, '請選擇科目');
  const creatable = parsed.questions.filter((q) => q.duplicate !== 'paper');
  if (!creatable.length) fail(409, '這份考古題的題目都已經上傳過了');
  const title = str(body.title, 80).trim() || fail(400, '請輸入考古題名稱');
  const [paperId] = await write([{ op: 'add', store: 'papers', value: { subjectId, title, year: str(body.year, 10).trim(), exam: str(body.exam, 40).trim(), createdAt: nowIso() } }]);
  const ops = [];
  let inserted = 0;
  let linked = 0;
  for (const q of creatable) {
    if (q.duplicate === 'notebook') {
      // 跟訂正本的題目一模一樣：直接連到這份考古題，保留原本的筆記與練習紀錄
      const old = mem.questions.get(q.existingId);
      const update = { ...old, paperId, number: q.number };
      if (q.status === 'ok' && old.status === 'review') Object.assign(update, { answer: q.answer, status: 'ok', statusNote: '', updatedAt: nowIso() });
      if (!old.images?.length && q.images.length) update.images = q.images.slice(0, MAX_IMAGES);
      ops.push({ op: 'put', store: 'questions', value: update });
      linked += 1;
      continue;
    }
    ops.push({ op: 'add', store: 'questions', value: newQuestionRecord(subjectId, {
      source: `${title} 第 ${q.number} 題`, stem: q.stem,
      options: q.options.map((o) => ({ key: o.key, text: o.text, mark: '', mistake: '', concept: '', note: '' })),
      answer: q.answer, concept: q.concept || '', status: q.status, statusNote: q.statusNote, contentHash: q.hash,
      images: q.images.slice(0, MAX_IMAGES),
    }, `paper:${paperId}`, paperId, q.number) });
    inserted += 1;
  }
  await write(ops);
  return { id: paperId, inserted, linked, skipped: parsed.questions.length - creatable.length };
});

function paperOut(p) {
  const qs = all('questions').filter((q) => q.paperId === p.id);
  const cards = qs.map((q) => cardOf(q.id)).filter(Boolean);
  const lastAt = cards.map((c) => c.lastAt).filter(Boolean).sort().pop() || null;
  return {
    id: p.id, title: p.title, year: p.year, exam: p.exam, subjectId: p.subjectId,
    subject: mem.subjects.get(p.subjectId)?.name ?? '', createdAt: p.createdAt,
    total: qs.length, ready: qs.filter(isReady).length, pending: qs.filter((q) => q.status !== 'ok').length,
    attempted: cards.filter((c) => c.attempts > 0).length,
    lastCorrect: cards.filter((c) => c.lastResult === 1).length, lastWrong: cards.filter((c) => c.lastResult === 0).length,
    lastAt,
  };
}

const ownPaper = (id) => mem.papers.get(id) || fail(404, '找不到這份考古題');

route('GET', '/api/papers', () => all('papers').map(paperOut)
  .sort((a, b) => (b.lastAt || b.createdAt).localeCompare(a.lastAt || a.createdAt)));

route('GET', '/api/papers/(\\d+)', ({ params: [id] }) => {
  const p = ownPaper(id);
  const questions = all('questions').filter((q) => q.paperId === id)
    .sort((a, b) => (a.number || 0) - (b.number || 0) || a.id - b.id)
    .map((q) => {
      const c = cardOf(q.id);
      return { id: q.id, number: q.number, stem: q.stem.slice(0, 80), status: q.status, answer: q.answer, attempts: c?.attempts || 0, correct: c?.correct || 0, lastResult: c ? c.lastResult : null };
    });
  return { ...paperOut(p), questions };
});

route('PATCH', '/api/papers/(\\d+)', async ({ params: [id], body }) => {
  const p = { ...ownPaper(id) };
  if (body.title != null) p.title = str(body.title, 80).trim() || p.title;
  if (body.year != null) p.year = str(body.year, 10).trim();
  if (body.exam != null) p.exam = str(body.exam, 40).trim();
  await write([{ op: 'put', store: 'papers', value: p }]);
  return paperOut(p);
});

route('DELETE', '/api/papers/(\\d+)', async ({ params: [id] }) => {
  ownPaper(id);
  // 上傳時新建的題目一起刪除；原本就在訂正本、只是被連結的題目保留
  const qs = all('questions').filter((q) => q.paperId === id);
  const ops = deleteQuestionOps(qs.filter((q) => q.origin === `paper:${id}`).map((q) => q.id));
  for (const q of qs) if (q.origin !== `paper:${id}`) ops.push({ op: 'put', store: 'questions', value: { ...q, paperId: null, number: null } });
  ops.push({ op: 'delete', store: 'papers', key: id });
  await write(ops);
  return { ok: true };
});
