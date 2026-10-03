// 練習畫面：作答 → 立即顯示對錯與筆記 → 下一題；答錯的題目稍後會再出現一次
import { api, newClientId, submitAnswer } from '../api.js';
import { navigate } from '../app.js';
import { prefs, userSettings } from '../store.js';
import { clear, confirmDialog, h, icon, iconButton, pct, rich, showError, toast } from '../ui.js';

const FONT_STEPS = [1, 1.15, 1.3, 0.9];
const REQUEUE_GAP = 4;
const MAX_RETRIES = 2;
const LETTERS = 'ABCDEFGH';
const ANSWER_POS_KEY = 'fc.answerPos';

// 選項內容引用其他選項代號（例如「(A)(B)均正確」「A與B」）時，重新編號會改變意思 → 整題不洗牌
const LOCK_RE = /[（(]\s*[A-H]\s*[)）]|選項\s*[A-H]|(?<![A-Za-z])[A-H]\s*(?:、|與|和|及|或|,|，)\s*[A-H](?![A-Za-z])|(?<![A-Za-z])[A-H]{2,4}(?![A-Za-z])\s*(?:均|皆|都|兩|三)|\b[A-H]\s+(?:and|or)\s+[A-H]\b/;
// 「以上皆是」這類跟位置有關的選項 → 固定在原位置，其他選項照常洗牌
const ANCHOR_RE = /以上|上述|前述|皆是|皆非|皆正確|皆錯誤|均非|all of the|none of the|above/i;

let session = null;

export async function startPractice(config) {
  const data = await api.post('/api/practice/start', {
    mode: config.mode,
    subjectIds: config.subjectIds || [],
    limit: config.limit || 20,
    weakFirst: Boolean(config.weakFirst),
    ids: config.ids || [],
    paperId: config.paperId || null,
    ordered: Boolean(config.ordered),
    unseenOnly: Boolean(config.unseenOnly),
  });
  if (!data.questions.length) {
    toast('沒有符合條件的題目');
    return false;
  }
  session = {
    config,
    title: config.title || '練習',
    queue: data.questions.map((q) => ({ q, retry: 0 })),
    pos: 0,
    answered: null,
    seen: new Map(),
    startedAt: Date.now(),
    qStartedAt: Date.now(),
    shuffle: userSettings().shuffleOptions,
    requeue: config.mode !== 'paper', // 整份考古題依序作答時不插入重考，錯題在結算頁再練
    finished: false,
    refreshId: null,
  };
  navigate('#/practice');
  return true;
}

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 記住每題上次答案出現在第幾個位置，下次洗牌時換到別的位置（跨練習保存）
function readAnswerPos() {
  try { return new Map(JSON.parse(localStorage.getItem(ANSWER_POS_KEY) || '[]')); } catch { return new Map(); }
}
function writeAnswerPos(qid, pos) {
  const map = readAnswerPos();
  map.delete(qid);
  map.set(qid, pos);
  const entries = [...map].slice(-3000);
  try { localStorage.setItem(ANSWER_POS_KEY, JSON.stringify(entries)); } catch { /* 忽略 */ }
}

/**
 * 這一次出現時的選項排列：[{...option, label: 顯示代號, orig: 原代號}]。
 * 每次出現（包含同一輪重考）都重新洗牌並重新編號 A、B、C…，答案位置盡量跟上次不同。
 */
function arrange(item) {
  if (item.view) return item.view;
  const q = item.q;
  const opts = q.options;
  const identity = () => opts.map((o) => ({ ...o, label: o.key, orig: o.key }));
  const anchored = new Set(opts.map((o, i) => (ANCHOR_RE.test(o.text) ? i : -1)).filter((i) => i >= 0));
  const free = opts.map((_, i) => i).filter((i) => !anchored.has(i));
  if (!session.shuffle || opts.length < 3 || free.length < 2 || opts.some((o) => LOCK_RE.test(o.text))) {
    item.view = identity();
    return item.view;
  }
  const last = readAnswerPos().get(q.id);
  let order = null;
  let answerPos = -1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const perm = shuffled(free);
    const candidate = opts.map((_, i) => (anchored.has(i) ? i : perm[free.indexOf(i)]));
    order = candidate;
    answerPos = candidate.findIndex((i) => opts[i].key === q.answer);
    const unchanged = candidate.every((v, i) => v === i);
    if (!unchanged && (answerPos !== last || answerPos < 0)) break;
  }
  if (answerPos >= 0) writeAnswerPos(q.id, answerPos);
  item.view = order.map((i, pos) => ({ ...opts[i], label: LETTERS[pos], orig: opts[i].key }));
  return item.view;
}

function labelOf(item, origKey) {
  return arrange(item).find((o) => o.orig === origKey)?.label ?? origKey;
}

export async function render({ root }) {
  if (!session) {
    navigate('#/', { replace: true });
    return;
  }
  if (session.refreshId) {
    // 從編輯頁回來：重新載入這題
    const id = session.refreshId;
    session.refreshId = null;
    try {
      const fresh = await api.get(`/api/questions/${id}`);
      for (const item of session.queue) {
        if (item.q.id !== id) continue;
        item.q = fresh;
        // 選項可能被改過：重新排列（已作答的這一題保留原排列，以免畫面跳動）
        if (!(session.answered && item === session.queue[session.pos])) item.view = null;
      }
    } catch (err) {
      if (err.status === 404) {
        session.queue = session.queue.filter((item, i) => item.q.id !== id || i < session.pos);
        session.answered = null;
      } else showError(err);
    }
  }

  const header = h('header', { class: 'topbar' });
  const main = h('main', { class: 'page bare' });
  const bar = h('div', { class: 'actionbar' });
  clear(root, header, main, bar);

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select, .overlay') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (session.finished) return;
    const current = session.queue[session.pos]?.q;
    if (!current) return;
    if (e.key === 'Escape') { exit(main, header, bar); return; }
    if (!session.answered) {
      const view = arrange(session.queue[session.pos]);
      let opt = null;
      if (/^[1-8]$/.test(e.key)) opt = view[Number(e.key) - 1];
      else if (/^[a-h]$/i.test(e.key)) opt = view.find((o) => o.label === e.key.toUpperCase());
      if (opt) { e.preventDefault(); choose(opt.orig, { main, header, bar }); }
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault();
      next('good', { main, header, bar });
    } else if (e.key.toLowerCase() === 'g' && session.answered.correct) {
      next('hard', { main, header, bar });
    }
  };
  document.addEventListener('keydown', onKey);

  if (session.finished) showSummary({ main, header, bar });
  else showQuestion({ main, header, bar });
  return () => document.removeEventListener('keydown', onKey);
}

// ------------------------------------------------------------ 題目

function drawHeader(header, els) {
  const item = session.queue[session.pos];
  const q = item.q;
  const done = session.pos + (session.answered ? 1 : 0);
  const total = session.queue.length;
  const starBtn = iconButton(q.starred ? 'starFill' : 'star', q.starred ? '取消收藏' : '收藏', async () => {
    try {
      const updated = await api.patch(`/api/questions/${q.id}`, { starred: !q.starred });
      for (const it of session.queue) if (it.q.id === q.id) it.q.starred = updated.starred;
      toast(updated.starred ? '已加入收藏' : '已取消收藏');
      drawHeader(header, els);
    } catch (err) { showError(err); }
  }, { class: `icon-btn ${q.starred ? 'on' : ''}` });

  const fontBtn = h('button', {
    class: 'icon-btn', 'aria-label': '調整字體大小', title: '調整字體大小',
    onclick: () => {
      const i = FONT_STEPS.indexOf(prefs.fontScale);
      prefs.fontScale = FONT_STEPS[(i + 1) % FONT_STEPS.length];
      toast(`字體 ${Math.round(prefs.fontScale * 100)}%`);
    },
  }, h('span', { class: 'aa' }, 'Aa'));

  clear(header, h('div', { class: 'inner quizbar' },
    iconButton('x', '結束練習', () => exit(els.main, header, els.bar)),
    h('div', { class: 'prog' },
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done },
        h('i', { style: { width: `${(done / total) * 100}%` } })),
      h('span', { class: 'count' }, `${Math.min(session.pos + 1, total)} / ${total}`),
    ),
    starBtn,
    fontBtn,
    iconButton('edit', '編輯這題', () => {
      session.refreshId = q.id;
      navigate(`#/edit/${q.id}`);
    }),
  ));
}

function showQuestion(els) {
  const { main, header, bar } = els;
  const item = session.queue[session.pos];
  const q = item.q;
  if (!session.answered) session.qStartedAt = Date.now();
  drawHeader(header, els);

  const card = q.card;
  const wrongTimes = card ? card.attempts - card.correct : 0;
  const meta = h('div', { class: 'q-meta' },
    h('span', { class: 'badge primary' }, q.subject),
    q.source ? h('span', null, q.source) : null,
    item.retry ? h('span', { class: 'badge warn' }, '再試一次') : null,
    !card ? h('span', { class: 'badge muted' }, '新題') : null,
    wrongTimes ? h('span', { class: 'badge bad' }, `錯過 ${wrongTimes} 次`) : null,
  );
  const opts = h('div', { class: 'opts', role: 'group', 'aria-label': '選項' });
  const resultHost = h('div');
  const explainHost = h('div', { class: 'explain' });
  clear(main, meta, rich(q.stem, 'q-stem'), opts, resultHost, explainHost);
  main.classList.toggle('answered', Boolean(session.answered));

  if (session.answered) {
    drawAnswered(item, opts, resultHost, explainHost);
  } else {
    for (const o of arrange(item)) {
      opts.append(h('button', { class: 'opt', onclick: () => choose(o.orig, els), 'aria-label': `選項 ${o.label}：${o.text}` },
        h('span', { class: 'key' }, o.label),
        h('span', { class: 'body' }, h('span', { class: 'txt' }, o.text)),
      ));
    }
  }
  drawBar(bar, els);
}

/** origKey：原本的選項代號（送到伺服器判斷對錯）；畫面上顯示的是洗牌後的代號 */
function choose(origKey, els) {
  if (session.answered) return;
  const q = session.queue[session.pos].q;
  const correct = origKey === q.answer;
  session.answered = { chosen: origKey, correct, ms: Date.now() - session.qStartedAt, clientId: newClientId() };
  if (!session.seen.has(q.id)) session.seen.set(q.id, { q, firstCorrect: correct });
  if (!correct) navigator.vibrate?.(35);
  showQuestion(els);
}

function drawAnswered(item, opts, resultHost, explainHost) {
  const q = item.q;
  const { chosen, correct } = session.answered;
  const answerLabel = labelOf(item, q.answer);
  for (const o of arrange(item)) {
    const isAnswer = o.orig === q.answer;
    const isWrong = o.orig === chosen && !correct;
    const cls = ['opt', isAnswer && 'is-answer', isWrong && 'is-wrong', !isAnswer && !isWrong && 'is-dim'].filter(Boolean).join(' ');
    opts.append(h('div', { class: cls },
      h('span', { class: 'key' }, isAnswer ? icon('check') : isWrong ? icon('x') : o.label),
      h('div', { class: 'body' },
        h('div', { class: 'txt' }, isAnswer || isWrong ? `${o.label}. ${o.text}` : o.text),
        o.orig !== o.label ? h('div', { class: 'orig' }, `原選項 ${o.orig}`) : null,
        o.mark ? h('div', { class: 'mark' }, `敘述判斷：${o.mark}`) : null,
        noteBlock('mistake', '我誤會的地方', o.mistake),
        noteBlock('concept', '正確觀念', o.concept),
        noteBlock('', '考點／補充', o.note),
      ),
    ));
  }
  clear(resultHost, h('div', { class: `result ${correct ? 'ok' : 'bad'}` },
    icon(correct ? 'check' : 'x'),
    chosen ? (correct ? '答對了！' : `答錯了，正確答案是 ${answerLabel}`) : `正確答案是 ${answerLabel}`,
    q.card?.attempts ? h('span', { class: 'sub' }, `累計 ${q.card.correct}/${q.card.attempts}`) : null,
  ));
  clear(explainHost,
    noteBlock('keypoint', '本題考點', q.keypoint),
    noteBlock('mistake', '我誤會的地方', q.mistake),
    noteBlock('concept', '正確觀念', q.concept),
    noteBlock('', '補充', q.note),
  );
}

function noteBlock(kind, label, text) {
  if (!text) return null;
  return h('div', { class: `note ${kind}` }, h('div', { class: 'lbl' }, label), rich(text));
}

function drawBar(bar, els) {
  const isLast = session.pos >= session.queue.length - 1;
  const a = session.answered;
  let buttons;
  if (!a) {
    buttons = [h('button', { class: 'btn', onclick: () => choose('', els) }, '不會，看答案')];
  } else if (a.correct) {
    buttons = [
      h('button', { class: 'btn secondary', onclick: () => next('hard', els), title: '快捷鍵 G' }, '猜對的'),
      h('button', { class: 'btn btn-primary', onclick: () => next('good', els) }, isLast ? '看結果' : '下一題', icon('arrow')),
    ];
  } else {
    buttons = [h('button', { class: 'btn btn-primary', onclick: () => next('again', els) }, isLast ? '看結果' : '下一題', icon('arrow'))];
  }
  const item = session.queue[session.pos];
  const answerLabel = labelOf(item, item.q.answer);
  clear(bar,
    a ? h('div', { class: `bar-status ${a.correct ? 'ok' : 'bad'}`, role: 'status' },
      icon(a.correct ? 'check' : 'x'),
      a.correct ? '答對了！' : a.chosen ? `答錯了，正確答案是 ${answerLabel}` : `正確答案是 ${answerLabel}`,
      h('span', { class: 'hint' }, '詳解在下方'),
    ) : null,
    h('div', { class: 'inner' }, buttons),
    h('div', { class: 'kbd-hint' }, a ? 'Enter 下一題 · G 猜對的' : '按 A–E 或 1–5 作答 · Esc 結束'),
  );
}

function record(grade) {
  const a = session.answered;
  if (!a || a.recorded) return;
  a.recorded = true;
  const q = session.queue[session.pos].q;
  submitAnswer({
    questionId: q.id, chosen: a.chosen, grade: a.correct ? grade : 'again',
    mode: session.config.mode, durationMs: a.ms, clientId: a.clientId, questionCreatedAt: q.createdAt,
  }).then((res) => {
    if (res?.card) for (const it of session?.queue || []) if (it.q.id === q.id) it.q.card = res.card;
  }).catch(showError);
}

function next(grade, els) {
  const a = session.answered;
  if (!a) return;
  record(grade);
  const item = session.queue[session.pos];
  if (!a.correct && session.requeue && item.retry < MAX_RETRIES) {
    const insertAt = Math.min(session.pos + 1 + REQUEUE_GAP, session.queue.length);
    if (insertAt - session.pos - 1 >= 2) session.queue.splice(insertAt, 0, { q: item.q, retry: item.retry + 1 });
  }
  session.answered = null;
  session.pos += 1;
  window.scrollTo({ top: 0 });
  if (session.pos >= session.queue.length) {
    session.finished = true;
    showSummary(els);
  } else {
    showQuestion(els);
  }
}

async function exit(main, header, bar) {
  if (session.finished) { navigate('#/'); return; }
  const answeredCount = session.seen.size;
  if (answeredCount) {
    const ok = await confirmDialog({
      title: '結束這次練習？', message: `已作答 ${answeredCount} 題，紀錄都已儲存。`, ok: '結束並看結果',
    });
    if (!ok) return;
    if (session.answered) record('good');
    session.finished = true;
    showSummary({ main, header, bar });
  } else {
    session = null;
    navigate('#/');
  }
}

// ------------------------------------------------------------ 結果

function showSummary({ main, header, bar }) {
  const results = [...session.seen.values()];
  const correct = results.filter((r) => r.firstCorrect).length;
  const wrong = results.filter((r) => !r.firstCorrect);
  const rate = pct(correct, results.length);
  const secs = Math.round((Date.now() - session.startedAt) / 1000);
  const timeText = secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`;
  const r = 66;
  const circ = 2 * Math.PI * r;

  clear(header, h('div', { class: 'inner' },
    iconButton('x', '關閉', () => { session = null; navigate('#/'); }),
    h('h1', null, `${session.title}・完成`),
  ));

  const ring = h('div', { class: 'ring' });
  ring.innerHTML = `<svg viewBox="0 0 156 156" aria-hidden="true">
    <circle cx="78" cy="78" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="12"/>
    <circle cx="78" cy="78" r="${r}" fill="none" stroke="var(--ok)" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${(circ * rate) / 100} ${circ}"/></svg>`;
  ring.append(h('div', { class: 'v' }, h('div', null, h('b', null, `${rate}%`), h('span', null, '第一次就答對'))));

  const again = async (config, btn) => {
    btn.disabled = true;
    try { if (!(await startPractice(config))) btn.disabled = false; } catch (err) { showError(err); btn.disabled = false; }
  };

  clear(main,
    h('div', { class: 'card center' },
      ring,
      h('div', { class: 'sum-stats' },
        h('div', null, h('b', null, correct), '答對'),
        h('div', null, h('b', null, wrong.length), '答錯'),
        h('div', null, h('b', null, timeText), '用時'),
      ),
      h('div', { class: 'stack' },
        wrong.length ? h('button', {
          class: 'btn btn-primary btn-block btn-lg',
          onclick: (e) => again({ mode: 'ids', ids: wrong.map((w) => w.q.id), title: '錯題再練' }, e.currentTarget),
        }, icon('refresh'), `錯的 ${wrong.length} 題再練一次`) : null,
        h('button', {
          class: `btn btn-block ${wrong.length ? '' : 'btn-primary btn-lg'}`,
          onclick: (e) => again(session.config, e.currentTarget),
        }, '再來一組'),
      ),
    ),
    wrong.length ? h('div', { class: 'section-title' }, '這次答錯的題目') : null,
    wrong.length ? h('div', { class: 'list' }, wrong.map(({ q }) => h('a', { class: 'qitem', href: `#/q/${q.id}` },
      h('div', { class: 'meta' }, h('span', null, q.subject), q.source ? h('span', null, `· ${q.source}`) : null),
      h('div', { class: 'stem' }, q.stem),
      // 選項每次都重新洗牌，所以這裡顯示答案內容而不是代號
      h('div', { class: 'foot' }, h('span', { class: 'c' }, `正解：${(q.options.find((o) => o.key === q.answer)?.text || '').slice(0, 40)}`)),
    ))) : null,
  );
  clear(bar, h('div', { class: 'inner' },
    h('button', { class: 'btn btn-block', onclick: () => { session = null; navigate('#/'); } }, '回首頁'),
  ));
}
