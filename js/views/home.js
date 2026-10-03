import { api } from '../api.js';
import { navigate } from '../app.js';
import { prefs, state } from '../store.js';
import { clear, h, icon, openSheet, pct, segmented, showError, switchInput } from '../ui.js';
import { paperCard } from './papers.js';
import { startPractice } from './practice.js';

const MODE_LABEL = { random: '隨機練習', wrong: '錯題重練', starred: '收藏題', new: '新題' };

export async function render({ root }) {
  const [d, papers] = await Promise.all([api.get('/api/dashboard'), api.get('/api/papers')]);
  const name = state.user.displayName;
  const now = new Date();
  const dateText = now.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'long' });
  const hour = now.getHours();
  const hello = hour < 5 ? '夜深了' : hour < 12 ? '早安' : hour < 18 ? '午安' : '晚安';

  const page = h('main', { class: 'page' });
  clear(root, page);

  page.append(h('div', { class: 'greet row-flex' },
    h('div', { class: 'grow' },
      h('div', { class: 'date' }, dateText),
      h('h2', null, `${hello}，${name}`),
    ),
    d.streak ? h('span', { class: 'badge warn', title: '連續練習天數' }, icon('flame'), `連續 ${d.streak} 天`) : null,
  ));

  if (!d.ready && !d.review && !d.incomplete && !papers.length) {
    page.append(emptyState());
    return;
  }

  // ---- 今日複習
  const todayTotal = d.due + d.newAvailable;
  page.append(h('section', { class: 'hero' },
    h('div', { class: 'label' }, '今日待複習'),
    h('div', { class: 'num' }, todayTotal, h('small', null, '題')),
    h('div', { class: 'sub' }, `到期 ${d.due} 題 · 新題 ${d.newAvailable} 題`),
    todayTotal
      ? h('button', { class: 'btn btn-block btn-lg', onclick: (e) => run(e.currentTarget, { mode: 'due', limit: 1000, title: '今日複習' }) },
        icon('arrow'), '開始複習')
      : h('div', { class: 'done' }, '今天的複習都完成了！可以用下面的隨機練習再多做幾題。'),
  ));

  page.append(h('div', { class: 'stat-strip' },
    stat(d.todayDone, '今天已作答'),
    stat(d.todayDone ? `${pct(d.todayCorrect, d.todayDone)}%` : '—', '今天正確率'),
    stat(d.ready, '可練習題數'),
  ));

  // ---- 待處理提醒
  if (d.review) {
    page.append(h('div', { style: { marginTop: '12px' } }, banner('alert', `${d.review} 題需要確認答案`,
      '系統無法自動判斷答案，點一下正確選項確認後才會出現在練習中', '#/bank?status=review')));
  }
  if (d.incomplete) {
    page.append(h('div', { style: { marginTop: '12px' } }, banner('edit', `${d.incomplete} 題內容不完整`,
      '只記錄了一個選項或缺少題目，補齊後即可練習', '#/bank?status=incomplete')));
  }

  // ---- 自訂練習
  page.append(h('div', { class: 'section-title' }, '自訂練習'));
  page.append(practiceBuilder(d));

  // ---- 考古題
  page.append(h('div', { class: 'section-title' },
    h('span', null, '考古題'),
    papers.length ? h('a', { href: '#/papers' }, `全部（${papers.length}）`) : null,
  ));
  page.append(papers.length
    ? h('div', { class: 'stack' }, papers.slice(0, 3).map(paperCard),
      h('a', { class: 'btn btn-ghost btn-block', href: '#/papers/upload' }, icon('upload'), '上傳新的考古題'))
    : h('a', { class: 'cta-card', href: '#/papers/upload' },
      h('span', { class: 'ico' }, icon('file')),
      h('span', { class: 'grow' },
        h('b', null, '上傳歷屆考古題'),
        h('span', { class: 'd' }, '試題＋答案（考選部 PDF、Word 或貼上文字），整份依序作答，答錯自動進入複習')),
      icon('chevron')));

  // ---- 科目
  page.append(h('div', { class: 'section-title' },
    h('span', null, '科目進度'),
    h('a', { href: '#/stats' }, '統計'),
  ));
  page.append(subjectList(d.subjects));
}

function stat(value, label) {
  return h('div', { class: 's' }, h('div', { class: 'v' }, value), h('div', { class: 'k' }, label));
}

function banner(iconName, title, desc, href) {
  return h('a', { class: 'banner', href },
    icon(iconName),
    h('div', null, h('div', { class: 't' }, title), h('div', { class: 'd' }, desc)),
    h('span', { class: 'chev' }, icon('chevron')),
  );
}

async function run(button, config) {
  if (button) button.disabled = true;
  try {
    const ok = await startPractice(config);
    if (!ok && button) button.disabled = false;
  } catch (err) {
    showError(err);
    if (button) button.disabled = false;
  }
}

function practiceBuilder(d) {
  const saved = prefs.practice;
  const known = new Set(d.subjects.map((s) => s.id));
  const cfg = { ...saved, subjectIds: (saved.subjectIds || []).filter((id) => known.has(id)) };
  const card = h('div', { class: 'card stack' });

  const countFor = (mode) => {
    const subs = cfg.subjectIds.length ? d.subjects.filter((s) => cfg.subjectIds.includes(s.id)) : d.subjects;
    if (mode === 'wrong') return subs.reduce((a, s) => a + s.wrong, 0);
    if (mode === 'new') return subs.reduce((a, s) => a + s.unseen, 0);
    if (mode === 'starred') return cfg.subjectIds.length ? null : d.starred;
    return subs.reduce((a, s) => a + s.ready, 0);
  };

  const draw = () => {
    prefs.practice = cfg;
    const chips = h('div', { class: 'chips' },
      h('button', {
        class: `chip ${cfg.subjectIds.length ? '' : 'on'}`,
        onclick: () => { cfg.subjectIds = []; draw(); },
      }, '全部科目'),
      d.subjects.filter((s) => s.ready).map((s) => h('button', {
        class: `chip ${cfg.subjectIds.includes(s.id) ? 'on' : ''}`,
        'aria-pressed': String(cfg.subjectIds.includes(s.id)),
        onclick: () => {
          cfg.subjectIds = cfg.subjectIds.includes(s.id)
            ? cfg.subjectIds.filter((x) => x !== s.id) : [...cfg.subjectIds, s.id];
          draw();
        },
      }, s.name, h('span', { class: 'n' }, s.ready))),
    );
    const modes = segmented(
      ['random', 'wrong', 'starred', 'new'].map((m) => ({ value: m, label: { random: '隨機', wrong: '錯題', starred: '收藏', new: '新題' }[m], count: m === 'random' ? null : countFor(m) })),
      cfg.mode, (v) => { cfg.mode = v; draw(); },
    );
    const limits = segmented(
      [10, 20, 50, 'all'].map((n) => ({ value: n, label: n === 'all' ? '全部' : `${n} 題` })),
      cfg.limit, (v) => { cfg.limit = v; prefs.practice = cfg; },
    );
    const available = countFor(cfg.mode);
    const start = h('button', {
      class: 'btn btn-primary btn-block btn-lg',
      disabled: available === 0,
      onclick: (e) => run(e.currentTarget, {
        mode: cfg.mode, subjectIds: cfg.subjectIds, weakFirst: cfg.weakFirst,
        limit: cfg.limit === 'all' ? 1000 : cfg.limit, title: MODE_LABEL[cfg.mode],
      }),
    }, available === 0 ? '沒有符合的題目' : '開始練習');

    clear(card,
      chips,
      modes,
      limits,
      cfg.mode === 'random' ? h('label', { class: 'row-flex' },
        h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, '錯題優先'),
          h('div', { class: 'small muted' }, '答錯過、正確率低的題目更容易被抽到')),
        switchInput(cfg.weakFirst, (v) => { cfg.weakFirst = v; prefs.practice = cfg; }, '錯題優先'),
      ) : null,
      start,
    );
  };
  draw();
  return card;
}

function subjectList(subjects) {
  const list = h('div', { class: 'list' });
  const categories = [...new Set(subjects.map((s) => s.category || ''))];
  const grouped = categories.length > 1 || categories[0];
  for (const cat of categories) {
    if (grouped) list.append(h('div', { class: 'cat-title' }, cat || '未分類'));
    for (const s of subjects.filter((x) => (x.category || '') === cat)) list.append(subjectRow(s));
  }
  if (subjects.some((s) => s.ready)) {
    list.append(h('div', { class: 'legend', style: { padding: '10px 16px 12px' } },
      h('span', null, h('i', { style: { background: 'var(--meter-strong)' } }), '已熟練'),
      h('span', null, h('i', { style: { background: 'var(--meter-mid)' } }), '學習中'),
      h('span', null, h('i', { style: { background: 'var(--meter-track)', boxShadow: 'inset 0 0 0 1px var(--border-strong)' } }), '未練習'),
    ));
  }
  return list;
}

function subjectRow(s) {
  const learning = Math.max(0, s.ready - s.unseen - s.mastered);
  const w = (n) => `${s.ready ? (n / s.ready) * 100 : 0}%`;
  const acc = s.attempts ? `${pct(s.correct, s.attempts)}%` : '—';
  return h('a', {
    class: 'subj', href: `#/bank?subject=${s.id}`,
    onclick: (e) => { e.preventDefault(); subjectActions(s); },
  },
  h('div', { class: 'top' },
    h('span', { class: 'name' }, s.name),
    h('span', { class: 'small muted' }, `${s.ready} 題`),
  ),
  h('div', { class: 'meta' },
    h('span', null, '到期 ', h('b', null, s.due)),
    h('span', null, '錯題 ', h('b', null, s.wrong)),
    h('span', null, '正確率 ', h('b', null, acc)),
    s.total > s.ready ? h('span', null, '待處理 ', h('b', null, s.total - s.ready)) : null,
  ),
  h('div', { class: 'meter', role: 'img', 'aria-label': `已熟練 ${s.mastered} 題、學習中 ${learning} 題、未練習 ${s.unseen} 題` },
    s.mastered ? h('i', { class: 'm1', style: { width: w(s.mastered) } }) : null,
    learning ? h('i', { class: 'm2', style: { width: w(learning) } }) : null,
  ));
}

function subjectActions(s) {
  openSheet((close) => {
    const go = (config) => { close(); run(null, { ...config, subjectIds: [s.id] }); };
    return h('div', null,
      h('h3', null, s.name),
      h('p', { class: 'msg small' }, `${s.ready} 題可練習 · 到期 ${s.due} · 錯題 ${s.wrong}`),
      h('div', { class: 'list' },
        actionRow('shuffle', '隨機練習 20 題', () => go({ mode: 'random', limit: 20, weakFirst: true, title: `${s.name}・隨機` }), !s.ready),
        actionRow('refresh', `只練錯題（${s.wrong}）`, () => go({ mode: 'wrong', limit: 1000, title: `${s.name}・錯題` }), !s.wrong),
        actionRow('target', `練習這科全部（${s.ready}）`, () => go({ mode: 'random', limit: 1000, weakFirst: false, title: s.name }), !s.ready),
        actionRow('layers', '查看題目', () => { close(); navigate(`#/bank?subject=${s.id}`); }),
      ),
    );
  });
}

function actionRow(iconName, label, onclick, disabled = false) {
  return h('button', { class: 'row', onclick, disabled }, icon(iconName), h('span', { class: 'grow' }, label), icon('chevron'));
}

function emptyState() {
  return h('div', { class: 'card empty' },
    h('div', { class: 'ill' }, icon('book')),
    h('h3', null, '還沒有任何題目'),
    h('p', null, '匯入你的 Excel 訂正本、上傳歷屆考古題，或手動輸入第一題錯題，就可以開始練習。'),
    h('div', { class: 'stack', style: { maxWidth: '320px', margin: '0 auto' } },
      h('a', { class: 'btn btn-primary btn-block', href: '#/import' }, icon('upload'), '匯入 Excel 訂正本'),
      h('a', { class: 'btn btn-block', href: '#/papers/upload' }, icon('file'), '上傳考古題（試題＋答案）'),
      h('a', { class: 'btn btn-block', href: '#/new' }, icon('plus'), '手動新增題目'),
    ),
  );
}
