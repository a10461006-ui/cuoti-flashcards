// 雲端同步：把這台裝置的資料和 Google 雲端硬碟裡的資料合併，兩邊變成一樣。
//
// 雲端的 sync.json 是整份題庫的「快照」，彼此的關聯用 uid（跨裝置共用的編號）表示；圖片另外存成 img-<雜湊> 檔，
// 只上傳雲端還沒有的圖片。合併規則：
// - 同一筆資料兩邊都有改：以 mtime（最後修改時間）比較新的為準
// - 被刪除的資料：留有刪除紀錄（tombstone），比刪除時間舊的版本就一起刪掉；刪除後又修改過的保留
// - 兩台裝置各自建立的同名科目、同一科裡內容相同的題目（例如兩邊都匯入同一本訂正本）：合併成一份，
//   筆記、考古題連結、練習紀錄都保留
// - 練習紀錄（reviews）兩邊合在一起；兩邊都練過同一題時，用合併後的紀錄重新計算複習排程
import { all, localChanges, mem, newUid, openDb, write } from './db.js';
import { newCard, schedule } from './srs.js';
import { nowIso } from './textutil.js';

const FORMAT = 1;
export const SYNC_FILE = 'sync.json';
export const IMG_PREFIX = 'img-';
const TOMBSTONE_KEEP_MS = 180 * 86400000;
const IMAGE_GC_MS = 2 * 86400000; // 沒用到的圖片放兩天再刪（避免刪到其他裝置剛上傳、還沒存進快照的圖片）
const PREF_KEYS = ['nickname', 'exam', 'newPerDay', 'shuffleOptions'];
const NOTE_FIELDS = ['source', 'keypoint', 'mistake', 'concept', 'note'];
const IMAGE_SRC = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

// ---------------------------------------------------------------- 同步狀態（存在 meta 的 sync）

const DEFAULT_STATE = { key: 'sync', enabled: false, tracking: false, email: '', lastSyncAt: null, fileId: null };

export function syncState() {
  return { ...DEFAULT_STATE, ...(mem.meta.get('sync') || {}), key: 'sync' };
}

export async function saveSyncState(changes) {
  await openDb();
  const value = { ...syncState(), ...changes, key: 'sync' };
  await write([{ op: 'put', store: 'meta', value }], { sync: true });
  return value;
}

async function setStorage(storage) {
  const p = mem.meta.get('profile');
  if (p && p.storage !== storage) await write([{ op: 'put', store: 'meta', value: { ...p, storage } }], { sync: true });
}

/** 開啟同步：從這一刻起刪除資料會留下刪除紀錄 */
export async function enableSync(email) {
  const s = await saveSyncState({ enabled: true, tracking: true, email: email || syncState().email || '' });
  await setStorage('gdrive');
  return s;
}

/** 關閉這台裝置的同步（資料留在這台裝置，雲端的資料也不動） */
export async function disableSync({ forget = false } = {}) {
  const s = await saveSyncState({ enabled: false, ...(forget ? { lastSyncAt: null, fileId: null, email: '' } : {}) });
  await setStorage('device');
  return s;
}

const mt = (r) => (typeof r?.mtime === 'number' ? r.mtime : Date.parse(r?.updatedAt || r?.createdAt || r?.lastAt || '') || 0);

// 這次開啟 App 後，上次同步成功時的變動計數（和 mtime 一起判斷，避免時間相同或時鐘被調整時漏傳）
let syncedSeq = null;

/**
 * 上次同步之後，這台裝置有沒有改過資料（重新開啟 App 時用來提醒「還沒同步」）
 * 時間一樣（同一毫秒）也當成還沒同步：多傳一次沒關係，漏傳才麻煩
 */
export async function hasUnsyncedChanges() {
  await openDb();
  if (syncedSeq !== null && localChanges() !== syncedSeq) return true;
  const since = Date.parse(syncState().lastSyncAt || '') || 0;
  if (!since) return true;
  if ((mem.meta.get('profile')?.prefsMtime || 0) >= since) return true;
  for (const store of ['subjects', 'papers', 'questions', 'cards', 'reviews']) {
    for (const r of mem[store].values()) if (mt(r) >= since) return true;
  }
  return all('tombstones').some((t) => t.at >= since);
}

// ---------------------------------------------------------------- 快照

const refCache = new Map(); // 圖片 data URL → 雜湊

async function refOf(src) {
  let ref = refCache.get(src);
  if (!ref) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src)));
    ref = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    refCache.set(src, ref);
  }
  return ref;
}

export function emptySnapshot() {
  return { app: 'cuoti-flashcards', kind: 'sync', format: FORMAT, prefs: null, subjects: [], papers: [], questions: [], cards: [], reviews: [], tombstones: [] };
}

function normalizeSnapshot(data) {
  const out = emptySnapshot();
  for (const key of ['subjects', 'papers', 'questions', 'cards', 'reviews', 'tombstones']) {
    out[key] = (Array.isArray(data[key]) ? data[key] : []).filter((r) => r && (key === 'cards' ? r.q : r.uid));
  }
  out.prefs = data.prefs && typeof data.prefs === 'object' ? data.prefs : null;
  out.format = Number(data.format) || FORMAT;
  for (const q of out.questions) q.images = Array.isArray(q.images) ? q.images.filter((i) => i?.ref) : [];
  return out;
}

/** 舊資料沒有 uid：第一次同步前補上（不改 mtime） */
async function ensureUids() {
  const ops = [];
  for (const store of ['subjects', 'papers', 'questions', 'reviews']) {
    for (const r of mem[store].values()) if (!r.uid) ops.push({ op: 'put', store, value: { ...r, uid: newUid() } });
  }
  if (ops.length) await write(ops, { sync: true });
}

/** 這台裝置的資料 → 快照（關聯改用 uid）；images：雜湊 → 圖片 */
export async function localSnapshot() {
  await openDb();
  const images = new Map();
  const uidOf = { subjects: new Map(), papers: new Map(), questions: new Map() };
  for (const store of Object.keys(uidOf)) for (const r of mem[store].values()) uidOf[store].set(r.id, r.uid);
  const p = mem.meta.get('profile') || {};
  const snap = emptySnapshot();
  snap.prefs = p.setupDone ? { nickname: p.nickname || '', exam: p.exam || '', newPerDay: p.newPerDay ?? 20, shuffleOptions: p.shuffleOptions !== false, mtime: p.prefsMtime || 0 } : null;
  snap.subjects = all('subjects').map((s) => ({ uid: s.uid, name: s.name, category: s.category || '', sortOrder: s.sortOrder || 0, createdAt: s.createdAt || null, mtime: mt(s) }));
  snap.papers = all('papers').map((x) => ({
    uid: x.uid, subject: uidOf.subjects.get(x.subjectId) || null, title: x.title, year: x.year || '', exam: x.exam || '', createdAt: x.createdAt || null, mtime: mt(x),
  }));
  for (const q of mem.questions.values()) {
    const { id, subjectId, paperId, images: imgs, origin, ...rest } = q;
    const refs = [];
    for (const img of imgs || []) {
      if (!img?.src) continue;
      const ref = await refOf(img.src);
      images.set(ref, img.src);
      refs.push({ ref, w: img.w || 0, h: img.h || 0 });
    }
    const fromPaper = /^paper:(\d+)$/.exec(origin || '');
    snap.questions.push({
      ...rest, uid: q.uid, subject: uidOf.subjects.get(subjectId) || null, paper: paperId ? uidOf.papers.get(paperId) || null : null,
      images: refs, origin: fromPaper ? `paperuid:${uidOf.papers.get(Number(fromPaper[1])) || ''}` : origin || '', mtime: mt(q),
    });
  }
  for (const c of mem.cards.values()) {
    const q = uidOf.questions.get(c.questionId);
    if (!q) continue;
    const { questionId, ...rest } = c;
    snap.cards.push({ ...rest, q, mtime: mt(c) });
  }
  for (const r of mem.reviews.values()) {
    const q = uidOf.questions.get(r.questionId);
    if (!q) continue;
    const { id, questionId, ...rest } = r;
    snap.reviews.push({ ...rest, uid: r.uid, q, mtime: mt(r) });
  }
  snap.tombstones = all('tombstones').map((t) => ({ uid: t.uid, store: t.store, at: t.at }));
  return { snap, images };
}

// ---------------------------------------------------------------- 合併（不碰資料庫，可以單獨測試）

const stable = (r) => JSON.stringify(r);
/** 同一筆資料的兩個版本：mtime 新的贏；一樣新就用內容決定（每台裝置算出來的結果才會一樣） */
const pick = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  if (a.mtime !== b.mtime) return a.mtime > b.mtime ? a : b;
  return stable(a) >= stable(b) ? a : b;
};
const byUid = (a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

export function merge(L, R, { preferRemotePrefs = false, now = Date.now() } = {}) {
  L = L || emptySnapshot();
  R = R || emptySnapshot();
  const tomb = new Map();
  for (const t of [...L.tombstones, ...R.tombstones]) {
    const old = tomb.get(t.uid);
    if (!old || t.at > old.at) tomb.set(t.uid, { uid: t.uid, store: t.store, at: t.at });
  }
  const union = (key) => {
    const map = new Map();
    for (const r of L[key]) map.set(r.uid, r);
    for (const r of R[key]) map.set(r.uid, pick(map.get(r.uid), r));
    return map;
  };
  const subjects = union('subjects');
  const papers = union('papers');
  const questions = union('questions');
  const everySubject = new Map(subjects);

  // 套用刪除紀錄：比刪除時間舊的版本刪掉；刪除之後又改過的保留（刪除紀錄作廢）
  for (const map of [subjects, papers, questions]) {
    for (const [uid, r] of map) {
      const t = tomb.get(uid);
      if (!t) continue;
      if (t.at >= r.mtime) map.delete(uid);
      else tomb.delete(uid);
    }
  }

  // 題目還在、科目卻被另一台刪掉了（例如離線時新增的題目）：把科目救回來，不讓題目消失
  for (const q of questions.values()) {
    if (q.subject && !subjects.has(q.subject) && everySubject.has(q.subject)) {
      subjects.set(q.subject, everySubject.get(q.subject));
      tomb.delete(q.subject);
    }
  }
  for (const [uid, q] of questions) if (!subjects.has(q.subject)) questions.delete(uid);

  // 重複的資料合併成一份：保留 uid 最小的那一筆，其他的記為已刪除
  const alias = new Map();
  const resolve = (u) => { let x = u; while (x && alias.has(x)) x = alias.get(x); return x; };
  const collapse = (map, store, keyOf, combine = (winner) => winner) => {
    const groups = new Map();
    for (const r of map.values()) {
      const k = keyOf(r);
      if (k == null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort(byUid);
      const keep = list[0].uid;
      const winner = list.reduce((a, b) => pick(a, b));
      for (const r of list.slice(1)) {
        alias.set(r.uid, keep);
        map.delete(r.uid);
        tomb.set(r.uid, { uid: r.uid, store, at: Math.max(now, r.mtime + 1) });
      }
      map.set(keep, { ...combine(winner, list), uid: keep, mtime: Math.max(...list.map((r) => r.mtime)) });
    }
  };

  collapse(subjects, 'subjects', (s) => s.name);
  for (const [uid, p] of papers) {
    const subject = resolve(p.subject);
    if (!subjects.has(subject)) papers.delete(uid);
    else if (subject !== p.subject) papers.set(uid, { ...p, subject });
  }
  collapse(papers, 'papers', (p) => `${p.subject}\u0000${p.title}\u0000${p.year}`);

  const relink = (q) => {
    const subject = resolve(q.subject);
    let paper = q.paper ? resolve(q.paper) : null;
    let number = q.number ?? null;
    if (paper && !papers.has(paper)) { paper = null; number = null; }
    const fromPaper = /^paperuid:(.*)$/.exec(q.origin || '');
    const origin = fromPaper ? `paperuid:${resolve(fromPaper[1])}` : q.origin;
    return subject === q.subject && paper === q.paper && origin === q.origin ? q : { ...q, subject, paper, number, origin };
  };
  for (const [uid, q] of questions) questions.set(uid, relink(q));
  collapse(questions, 'questions', (q) => (q.contentHash ? `${q.subject}\u0000${q.contentHash}` : null), (winner, list) => {
    const out = { ...winner };
    for (const r of list) {
      if (!out.paper && r.paper) { out.paper = r.paper; out.number = r.number; }
      for (const f of NOTE_FIELDS) if (!out[f] && r[f]) out[f] = r[f];
      if (!out.images?.length && r.images?.length) out.images = r.images;
      if (!out.answer && r.answer) Object.assign(out, { answer: r.answer, status: r.status, statusNote: r.statusNote });
      if (r.starred) out.starred = true;
    }
    return out;
  });

  // 練習紀錄：兩邊合在一起
  const reviews = new Map();
  for (const r of [...L.reviews, ...R.reviews]) {
    if (reviews.has(r.uid)) continue;
    const q = resolve(r.q);
    if (questions.has(q)) reviews.set(r.uid, q === r.q ? r : { ...r, q });
  }
  const reviewsOf = new Map();
  for (const r of reviews.values()) {
    if (!reviewsOf.has(r.q)) reviewsOf.set(r.q, []);
    reviewsOf.get(r.q).push(r);
  }
  // 每一份練習排程（card）各自知道的紀錄數，用來判斷能不能重算
  const ownCount = (snap) => {
    const m = new Map();
    for (const r of snap.reviews) m.set(r.q, (m.get(r.q) || 0) + 1);
    return m;
  };
  const counts = [ownCount(L), ownCount(R)];
  const candidates = new Map();
  [L.cards, R.cards].forEach((list, side) => {
    for (const c of list) {
      const q = resolve(c.q);
      if (!questions.has(q)) continue;
      if (!candidates.has(q)) candidates.set(q, []);
      candidates.get(q).push({ card: c, known: counts[side].get(c.q) || 0 });
    }
  });
  const cards = [];
  for (const [q, list] of candidates) {
    const uniq = list.filter((x, i) => list.findIndex((y) => stable(y.card) === stable(x.card)) === i);
    let card;
    const merged = reviewsOf.get(q) || [];
    const complete = uniq.every((x) => x.card.attempts === x.known);
    if (uniq.length > 1 && complete && merged.length > Math.max(...uniq.map((x) => x.card.attempts))) {
      // 兩台都練過這題：照時間順序重算一次排程
      card = { ...newCard(0) };
      for (const r of [...merged].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))) {
        const grade = r.isCorrect ? (r.grade && r.grade !== 'again' ? r.grade : 'good') : 'again';
        card = schedule(card, grade, new Date(r.createdAt));
      }
      delete card.questionId;
      card.mtime = Math.max(...uniq.map((x) => x.card.mtime || 0));
    } else {
      card = uniq.map((x) => x.card).reduce((a, b) => {
        const ka = `${a.lastAt || ''}\u0000${String(a.attempts || 0).padStart(8, '0')}`;
        const kb = `${b.lastAt || ''}\u0000${String(b.attempts || 0).padStart(8, '0')}`;
        return ka !== kb ? (ka > kb ? a : b) : pick(a, b);
      });
    }
    cards.push({ ...card, q });
  }

  let prefs = L.prefs;
  if (R.prefs && (!prefs || (preferRemotePrefs && R.prefs.mtime) || (R.prefs.mtime || 0) > (prefs.mtime || 0))) prefs = R.prefs;

  const tombstones = [...tomb.values()].filter((t) => now - t.at < TOMBSTONE_KEEP_MS).sort(byUid);
  return {
    app: 'cuoti-flashcards', kind: 'sync', format: FORMAT, prefs,
    subjects: [...subjects.values()].sort(byUid),
    papers: [...papers.values()].sort(byUid),
    questions: [...questions.values()].sort(byUid),
    cards: cards.sort((a, b) => (a.q < b.q ? -1 : 1)),
    reviews: [...reviews.values()].sort(byUid),
    tombstones,
  };
}

// ---------------------------------------------------------------- 把合併結果寫回這台裝置

const differs = (cur, value) => Object.keys(value).some((k) => stable(cur[k]) !== stable(value[k]));

/**
 * seen：快照當下每筆資料的 mtime。同步期間使用者又改過（或新增）的資料不覆蓋、不刪除，留給下一次同步。
 */
async function applySnapshot(M, images, seen) {
  let changed = 0;
  const localByUid = (store) => new Map(all(store).filter((r) => r.uid).map((r) => [r.uid, r]));
  const untouched = (store, cur, key = cur.uid) => seen.get(`${store}:${key}`) === mt(cur);
  const run = async (ops) => { if (ops.length) { await write(ops, { sync: true }); changed += ops.length; } };

  // 1. 科目
  let local = localByUid('subjects');
  await run(M.subjects.flatMap((s) => {
    const value = { name: s.name, category: s.category || '', sortOrder: s.sortOrder || 0, createdAt: s.createdAt, uid: s.uid, mtime: s.mtime };
    const cur = local.get(s.uid);
    if (!cur) return [{ op: 'add', store: 'subjects', value }];
    return untouched('subjects', cur) && differs(cur, value) ? [{ op: 'put', store: 'subjects', value: { ...cur, ...value } }] : [];
  }));
  const subjectId = new Map(all('subjects').filter((s) => s.uid).map((s) => [s.uid, s.id]));

  // 2. 考古題卷
  local = localByUid('papers');
  await run(M.papers.flatMap((p) => {
    const sid = subjectId.get(p.subject);
    if (!sid) return [];
    const value = { subjectId: sid, title: p.title, year: p.year || '', exam: p.exam || '', createdAt: p.createdAt, uid: p.uid, mtime: p.mtime };
    const cur = local.get(p.uid);
    if (!cur) return [{ op: 'add', store: 'papers', value }];
    return untouched('papers', cur) && differs(cur, value) ? [{ op: 'put', store: 'papers', value: { ...cur, ...value } }] : [];
  }));
  const paperId = new Map(all('papers').filter((p) => p.uid).map((p) => [p.uid, p.id]));

  // 3. 題目
  local = localByUid('questions');
  await run(M.questions.flatMap((q) => {
    const { uid, subject, paper, images: refs, origin, mtime, ...rest } = q;
    const sid = subjectId.get(subject);
    if (!sid) return [];
    const fromPaper = /^paperuid:(.*)$/.exec(origin || '');
    const value = {
      ...rest, uid, mtime, subjectId: sid, paperId: (paper && paperId.get(paper)) || null,
      origin: fromPaper ? (paperId.has(fromPaper[1]) ? `paper:${paperId.get(fromPaper[1])}` : origin) : origin || '',
    };
    if (!value.paperId) value.number = null;
    const cur = local.get(uid);
    if (cur && !untouched('questions', cur)) return [];
    const curRefs = (cur?.images || []).map((i) => refCache.get(i.src) || '');
    const sameImages = cur && curRefs.length === refs.length && refs.every((r, i) => r.ref === curRefs[i] && cur.images[i].w === r.w && cur.images[i].h === r.h);
    if (!cur || !sameImages) value.images = refs.map((r) => ({ src: images.get(r.ref), w: r.w, h: r.h })).filter((i) => i.src);
    if (!cur) return [{ op: 'add', store: 'questions', value }];
    return differs(cur, value) ? [{ op: 'put', store: 'questions', value: { ...cur, ...value } }] : [];
  }));
  const questionId = new Map(all('questions').filter((q) => q.uid).map((q) => [q.uid, q.id]));

  // 4. 練習排程、練習紀錄、刪除、刪除紀錄（同一個交易）
  const ops = [];
  const keepQ = new Set(M.questions.map((q) => q.uid));
  for (const c of M.cards) {
    const qid = questionId.get(c.q);
    if (!qid) continue;
    const { q, ...rest } = c;
    const value = { ...rest, questionId: qid };
    const cur = mem.cards.get(qid);
    if (!cur || (untouched('cards', cur, c.q) && differs(cur, value))) ops.push({ op: 'put', store: 'cards', value: cur ? { ...cur, ...value } : value });
  }
  const localReviews = localByUid('reviews');
  const keepR = new Set();
  const handledR = new Set();
  for (const r of M.reviews) {
    const qid = questionId.get(r.q);
    if (!qid) continue;
    keepR.add(r.uid);
    const cur = localReviews.get(r.uid);
    const { q, ...rest } = r;
    if (!cur) ops.push({ op: 'add', store: 'reviews', value: { ...rest, questionId: qid } });
    else if (cur.questionId !== qid) {
      // 重複的題目合併後，練習紀錄改掛到保留的那一題
      ops.push({ op: 'put', store: 'reviews', value: { ...cur, questionId: qid } });
      handledR.add(cur.id);
    }
  }
  const dropQ = new Set();
  for (const q of all('questions')) {
    if (q.uid && !keepQ.has(q.uid) && untouched('questions', q)) {
      dropQ.add(q.id);
      ops.push({ op: 'delete', store: 'questions', key: q.id }, { op: 'delete', store: 'cards', key: q.id });
    }
  }
  for (const r of all('reviews')) {
    if (handledR.has(r.id)) continue;
    const gone = r.uid && !keepR.has(r.uid) && untouched('reviews', r);
    if (gone || dropQ.has(r.questionId)) ops.push({ op: 'delete', store: 'reviews', key: r.id });
  }
  const liveQ = all('questions').filter((q) => !dropQ.has(q.id));
  const keepP = new Set(M.papers.map((p) => p.uid));
  for (const p of all('papers')) {
    if (!p.uid || keepP.has(p.uid) || !untouched('papers', p)) continue;
    ops.push({ op: 'delete', store: 'papers', key: p.id });
    for (const q of liveQ) if (q.paperId === p.id) ops.push({ op: 'put', store: 'questions', value: { ...q, paperId: null, number: null } });
  }
  const keepS = new Set(M.subjects.map((s) => s.uid));
  for (const s of all('subjects')) {
    // 還有題目在這個科目（例如同步期間剛新增的）：先不要刪，下次同步再處理
    if (s.uid && !keepS.has(s.uid) && untouched('subjects', s) && !liveQ.some((q) => q.subjectId === s.id)) {
      ops.push({ op: 'delete', store: 'subjects', key: s.id });
    }
  }
  const keepT = new Set(M.tombstones.map((t) => t.uid));
  for (const t of M.tombstones) {
    const cur = mem.tombstones.get(t.uid);
    if (!cur || cur.at !== t.at) ops.push({ op: 'put', store: 'tombstones', value: t });
  }
  for (const t of all('tombstones')) if (!keepT.has(t.uid) && seen.get(`tombstones:${t.uid}`) === t.at) ops.push({ op: 'delete', store: 'tombstones', key: t.uid });
  await run(ops);

  // 5. 個人設定（暱稱、考試、每日新題數、洗牌）
  const p = mem.meta.get('profile');
  if (M.prefs && p && (p.prefsMtime || 0) === seen.get('prefs') && PREF_KEYS.some((k) => stable(p[k]) !== stable(M.prefs[k]))) {
    const value = { ...p, prefsMtime: M.prefs.mtime || 0 };
    for (const k of PREF_KEYS) if (M.prefs[k] != null) value[k] = M.prefs[k];
    await run([{ op: 'put', store: 'meta', value }]);
  }
  return changed;
}

function seenMap(L) {
  const seen = new Map();
  for (const store of ['subjects', 'papers', 'questions', 'reviews']) for (const r of L[store]) seen.set(`${store}:${r.uid}`, r.mtime);
  for (const c of L.cards) seen.set(`cards:${c.q}`, c.mtime);
  for (const t of L.tombstones) seen.set(`tombstones:${t.uid}`, t.at);
  seen.set('prefs', mem.meta.get('profile')?.prefsMtime || 0);
  return seen;
}

// ---------------------------------------------------------------- 壓縮

async function encodeSnapshot(snap) {
  const json = JSON.stringify(snap);
  if (typeof CompressionStream === 'function' && typeof Blob.prototype.stream === 'function') {
    try {
      const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      return new Blob([buf], { type: 'application/gzip' });
    } catch { /* 改存未壓縮 */ }
  }
  return new Blob([json], { type: 'application/json' });
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'function' && typeof Blob.prototype.stream === 'function' && !window.FC_FORCE_JS_INFLATE) {
    try {
      return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    } catch { /* 改用純 JavaScript */ }
  }
  const { inflateRawSync } = await import('./inflate.js');
  const flags = bytes[3];
  let p = 10;
  if (flags & 4) p += 2 + (bytes[p] | (bytes[p + 1] << 8));
  if (flags & 8) while (bytes[p++]) { /* 檔名 */ }
  if (flags & 16) while (bytes[p++]) { /* 註解 */ }
  if (flags & 2) p += 2;
  const n = bytes.length;
  const size = (bytes[n - 4] | (bytes[n - 3] << 8) | (bytes[n - 2] << 16) | (bytes[n - 1] << 24)) >>> 0;
  return inflateRawSync(bytes.subarray(p, n - 8), size);
}

export async function decodeSnapshot(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('雲端的同步檔無法讀取');
  }
  if (data?.app !== 'cuoti-flashcards' || data.kind !== 'sync') throw new Error('雲端的同步檔格式不正確');
  return normalizeSnapshot(data);
}

export { encodeSnapshot };

// ---------------------------------------------------------------- 同步一次

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i], i);
    }
  }));
}

/**
 * drive：gdrive.js 的 driveClient（測試時可換成假的）
 * 回傳 { changed：這台裝置更新了幾筆, pending：同步期間又有新的變動, uploaded, downloaded }
 */
export async function runSync({ drive, onProgress = () => {} }) {
  await openDb();
  const firstSync = !syncState().lastSyncAt;
  const startSeq = localChanges();
  let changed = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    onProgress('正在讀取雲端資料…');
    // 以「開始同步的時間」當作上次同步時間：同步進行中又改的資料，下一次同步才會被當成還沒上傳
    const startedAt = nowIso();
    const files = await drive.listAll();
    const syncFiles = files.filter((f) => f.name === SYNC_FILE).sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
    const imgFiles = new Map(files.filter((f) => f.name.startsWith(IMG_PREFIX)).map((f) => [f.name.slice(IMG_PREFIX.length), f]));
    const known = syncState();
    const target = syncFiles[0];
    // 雲端的檔案就是這台上次上傳的版本：不用再下載（省流量）；這台也沒改過的話就不用做任何事
    const remoteUnchanged = Boolean(target) && syncFiles.length === 1 && known.fileId === target.id
      && known.remoteVersion != null && String(known.remoteVersion) === String(target.version);
    const localDirty = await hasUnsyncedChanges();
    if (remoteUnchanged && !localDirty) {
      await saveSyncState({ lastSyncAt: startedAt });
      syncedSeq = startSeq;
      return { changed, pending: localChanges() !== startSeq, uploaded: 0, downloaded: 0, questions: mem.questions.size, skipped: true };
    }
    let R = null;
    if (!remoteUnchanged) {
      for (const f of syncFiles) {
        const snap = await decodeSnapshot(await drive.download(f.id));
        if (snap.format > FORMAT) throw new Error('雲端的資料是用比較新的 App 版本存的，請先更新 App（往下拉重新整理，或按「清除暫存並重新載入」）');
        R = R ? merge(R, snap) : snap;
      }
    }

    await ensureUids();
    const { snap: L, images } = await localSnapshot();
    const seen = seenMap(L);
    const M = merge(L, R, { preferRemotePrefs: firstSync });

    // 圖片：雲端缺的上傳、這台缺的下載
    const needed = new Set(M.questions.flatMap((q) => q.images.map((i) => i.ref)));
    const toDownload = [...needed].filter((ref) => !images.has(ref) && imgFiles.has(ref));
    const toUpload = [...needed].filter((ref) => images.has(ref) && !imgFiles.has(ref));
    let done = 0;
    await pool(toDownload, 4, async (ref) => {
      const src = (await drive.downloadText(imgFiles.get(ref).id)).trim();
      if (IMAGE_SRC.test(src)) {
        images.set(ref, src);
        refCache.set(src, ref);
      }
      done += 1;
      onProgress(`正在下載圖片 ${done}/${toDownload.length}…`);
    });
    done = 0;
    await pool(toUpload, 4, async (ref) => {
      const f = await drive.create(`${IMG_PREFIX}${ref}`, new Blob([images.get(ref)], { type: 'text/plain' }));
      imgFiles.set(ref, f);
      done += 1;
      onProgress(`正在上傳圖片 ${done}/${toUpload.length}…`);
    });

    onProgress('正在更新這台裝置…');
    changed += await applySnapshot(M, images, seen);

    // 雲端的內容已經和合併結果一樣（這台沒有新東西）：不用上傳
    const dataOf = (s) => stable(['prefs', 'subjects', 'papers', 'questions', 'cards', 'reviews', 'tombstones'].map((k) => s[k]));
    if (R && syncFiles.length === 1 && !localDirty && dataOf(M) === dataOf(R)) {
      await saveSyncState({ lastSyncAt: startedAt, fileId: target.id, remoteVersion: target.version });
      syncedSeq = startSeq;
      return { changed, pending: localChanges() !== startSeq, uploaded: toUpload.length, downloaded: toDownload.length, questions: M.questions.length };
    }
    // 上傳前確認這段時間沒有其他裝置也上傳了（有的話重新合併一次）
    if (target) {
      const latest = await drive.getMeta(target.id);
      if (String(latest?.version) !== String(target.version)) continue;
    }
    onProgress('正在上傳到雲端…');
    const body = await encodeSnapshot({ ...M, savedAt: nowIso(), appVersion: window.FC_CONFIG?.appVersion || '' });
    const saved = target ? await drive.update(target.id, body) : await drive.create(SYNC_FILE, body);
    for (const f of syncFiles.slice(1)) await drive.remove(f.id).catch(() => {});
    const cutoff = Date.now() - IMAGE_GC_MS;
    for (const [ref, f] of imgFiles) {
      if (!needed.has(ref) && Date.parse(f.modifiedTime || '') < cutoff) await drive.remove(f.id).catch(() => {});
    }
    await saveSyncState({ lastSyncAt: startedAt, fileId: saved?.id || target?.id || null, remoteVersion: saved?.version ?? null });
    syncedSeq = startSeq;
    return { changed, pending: localChanges() !== startSeq, uploaded: toUpload.length, downloaded: toDownload.length, questions: M.questions.length };
  }
  throw new Error('其他裝置也正在同步，請稍後再試一次');
}

/** 刪除雲端硬碟裡錯題閃卡的所有資料 */
export async function deleteCloudData(drive) {
  const files = await drive.listAll();
  await pool(files, 4, (f) => drive.remove(f.id).catch(() => {}));
  return files.length;
}
