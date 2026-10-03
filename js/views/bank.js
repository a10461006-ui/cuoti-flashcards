import { api } from '../api.js';
import { navigate } from '../app.js';
import { loadSubjects } from '../store.js';
import { clear, debounce, formatDue, h, icon, iconButton, showError, spinner, topbar } from '../ui.js';
import { bankNav } from './papers.js';

const PAGE = 30;
const STATUS_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'review', label: '需確認' },
  { id: 'incomplete', label: '不完整' },
  { id: 'wrong', label: '最近答錯' },
  { id: 'starred', label: '收藏' },
];

export async function render({ root, query }) {
  const [subjects, papers] = await Promise.all([loadSubjects(true), api.get('/api/papers')]);
  const f = {
    subject: query.subject ? Number(query.subject) : null,
    paper: query.paper ? Number(query.paper) : null,
    filter: query.status || (query.wrong ? 'wrong' : query.starred ? 'starred' : 'all'),
    q: query.q || '',
  };

  const syncUrl = () => {
    const p = new URLSearchParams();
    if (f.subject) p.set('subject', f.subject);
    if (f.paper) p.set('paper', f.paper);
    if (f.filter !== 'all') p.set('status', f.filter);
    if (f.q) p.set('q', f.q);
    history.replaceState(history.state, '', `#/bank${p.toString() ? `?${p}` : ''}`);
  };
  const paperFilter = h('div');
  const drawPaperFilter = () => {
    const paper = papers.find((x) => x.id === f.paper);
    clear(paperFilter, paper ? h('div', { class: 'chips', style: { marginTop: '8px' } },
      h('button', { class: 'chip on', onclick: () => { f.paper = null; reload(); }, 'aria-label': '取消考古題篩選' },
        icon('file'), paper.title, icon('x'))) : null);
  };

  const search = h('input', {
    class: 'input', type: 'search', placeholder: '搜尋題目、選項、筆記…', value: f.q, enterkeyhint: 'search',
    'aria-label': '搜尋題目',
  });
  const subjectChips = h('div', { class: 'chips scroll' });
  const statusChips = h('div', { class: 'chips scroll' });
  const listHost = h('div');
  const countText = h('div', { class: 'small muted', style: { margin: '14px 4px 8px' } });

  clear(root,
    topbar({
      title: '題庫',
      actions: [iconButton('plus', '新增題目或上傳考古題', () => navigate('#/add'))],
    }),
    h('main', { class: 'page' },
      bankNav('bank'),
      h('div', { class: 'searchbox' }, icon('search'), search),
      paperFilter,
      h('div', { style: { height: '12px' } }),
      subjectChips,
      h('div', { style: { height: '8px' } }),
      statusChips,
      countText,
      listHost,
    ),
  );

  const drawSubjects = () => clear(subjectChips,
    h('button', { class: `chip ${f.subject ? '' : 'on'}`, onclick: () => { f.subject = null; reload(); } }, '全部科目'),
    subjects.map((s) => h('button', {
      class: `chip ${f.subject === s.id ? 'on' : ''}`, onclick: () => { f.subject = s.id; reload(); },
    }, s.name, h('span', { class: 'n' }, s.total))),
  );

  const drawStatus = (counts) => clear(statusChips, STATUS_FILTERS.map((s) => {
    const n = counts ? counts[s.id] : null;
    if ((s.id === 'review' || s.id === 'incomplete') && !n && f.filter !== s.id) return null;
    return h('button', {
      class: `chip ${f.filter === s.id ? 'on' : ''} ${s.id === 'review' && n ? 'warn' : ''}`,
      onclick: () => { f.filter = s.id; reload(); },
    }, s.label, n != null ? h('span', { class: 'n' }, n) : null);
  }));

  let offset = 0;
  let loading = false;
  let token = 0;

  async function reload() {
    syncUrl();
    drawSubjects();
    drawPaperFilter();
    offset = 0;
    clear(listHost, spinner());
    await loadMore(true);
  }

  async function loadMore(fresh = false) {
    if (loading && !fresh) return;
    loading = true;
    const my = ++token;
    const p = new URLSearchParams({ offset, limit: PAGE });
    if (f.subject) p.set('subject_id', f.subject);
    if (f.paper) { p.set('paper_id', f.paper); p.set('sort', 'number'); }
    if (f.q) p.set('q', f.q);
    if (f.filter === 'review' || f.filter === 'incomplete') p.set('status', f.filter);
    if (f.filter === 'wrong') { p.set('wrong', 'true'); p.set('sort', 'wrong'); }
    if (f.filter === 'starred') p.set('starred', 'true');
    try {
      const data = await api.get(`/api/questions?${p}`);
      if (my !== token) return;
      drawStatus(data.counts);
      countText.textContent = `共 ${data.total} 題`;
      if (fresh) clear(listHost);
      listHost.querySelector('.more-wrap')?.remove();
      let list = listHost.querySelector('.list');
      if (!list) {
        if (!data.items.length) {
          clear(listHost, emptyResult(f));
          return;
        }
        list = h('div', { class: 'list' });
        listHost.append(list);
      }
      for (const q of data.items) list.append(questionItem(q, f.subject));
      offset += data.items.length;
      if (offset < data.total) {
        listHost.append(h('div', { class: 'more-wrap' },
          h('button', { class: 'btn btn-sm', onclick: () => loadMore() }, `載入更多（還有 ${data.total - offset} 題）`)));
      }
    } catch (err) {
      showError(err);
    } finally {
      if (my === token) loading = false;
    }
  }

  search.addEventListener('input', debounce(() => { f.q = search.value.trim(); reload(); }, 300));
  await reload();
}

export function questionItem(q, hideSubject = false) {
  const c = q.card;
  const wrong = c ? c.attempts - c.correct : 0;
  return h('a', { class: 'qitem', href: `#/q/${q.id}` },
    h('div', { class: 'meta' },
      hideSubject ? null : h('span', null, q.subject),
      q.source ? h('span', null, hideSubject ? q.source : `· ${q.source}`) : null,
      q.paperId && !q.source.includes(q.paperTitle || '\u0000') ? h('span', { class: 'badge muted' }, `考古題 第 ${q.number} 題`) : null,
      q.starred ? h('span', { class: 'star', 'aria-label': '已收藏' }, icon('starFill')) : null,
      q.status === 'review' ? h('span', { class: 'badge warn' }, '需確認答案') : null,
      q.status === 'incomplete' ? h('span', { class: 'badge muted' }, '不完整') : null,
    ),
    h('div', { class: 'stem' }, q.stem || '（沒有題幹）'),
    h('div', { class: 'foot' },
      c ? h('span', { class: 'c' }, `✓ ${c.correct}`) : h('span', null, '尚未練習'),
      c && wrong ? h('span', { class: 'w' }, `✗ ${wrong}`) : null,
      c?.dueAt ? h('span', null, `下次 ${formatDue(c.dueAt)}`) : null,
    ),
  );
}

function emptyResult(f) {
  const text = f.q ? `找不到包含「${f.q}」的題目` : f.filter === 'review' ? '沒有需要確認的題目 🎉'
    : f.filter === 'incomplete' ? '沒有不完整的題目' : f.filter === 'wrong' ? '目前沒有答錯的題目'
      : f.filter === 'starred' ? '還沒有收藏的題目（練習時點 ☆ 收藏）' : '這裡還沒有題目';
  return h('div', { class: 'card empty' },
    h('div', { class: 'ill' }, icon('search')),
    h('p', null, text),
    f.filter === 'all' && !f.q ? h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), '新增題目') : null,
  );
}
