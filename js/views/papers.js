// 考古題卷列表
import { api } from '../api.js';
import { navigate } from '../app.js';
import { clear, h, icon, iconButton, pct, topbar } from '../ui.js';

export async function render({ root }) {
  const papers = await api.get('/api/papers');
  clear(root,
    topbar({ title: '題庫', actions: [iconButton('upload', '上傳考古題', () => navigate('#/papers/upload'))] }),
    h('main', { class: 'page' },
      bankNav('papers'),
      papers.length
        ? h('div', { class: 'stack' }, papers.map(paperCard))
        : h('div', { class: 'card empty' },
          h('div', { class: 'ill' }, icon('file')),
          h('h3', null, '還沒有考古題'),
          h('p', null, '上傳歷屆試題與答案（考選部 PDF、Word 或貼上文字），就能整份依序作答，答錯的題目會自動進入複習。'),
          h('a', { class: 'btn btn-primary', href: '#/papers/upload' }, icon('upload'), '上傳考古題')),
    ),
  );
}

/** 題庫頁上方切換：題目／考古題卷 */
export function bankNav(active) {
  return h('nav', { class: 'seg seg-nav', 'aria-label': '題庫分類' },
    h('a', { href: '#/bank', class: active === 'bank' ? 'on' : '', 'aria-current': active === 'bank' ? 'page' : null }, '全部題目'),
    h('a', { href: '#/papers', class: active === 'papers' ? 'on' : '', 'aria-current': active === 'papers' ? 'page' : null }, '考古題卷'),
  );
}

export function paperCard(p) {
  const done = p.lastCorrect + p.lastWrong;
  const w = (n) => `${p.total ? (n / p.total) * 100 : 0}%`;
  return h('a', { class: 'card paper-card', href: `#/paper/${p.id}` },
    h('div', { class: 'row-flex' },
      icon('file'),
      h('div', { class: 'grow' },
        h('div', { class: 'pc-title' }, p.title),
        h('div', { class: 'small muted' }, `${p.subject} · ${p.total} 題${p.pending ? ` · 待處理 ${p.pending}` : ''}`),
      ),
      icon('chevron'),
    ),
    h('div', { class: 'meter result-meter', role: 'img', 'aria-label': `答對 ${p.lastCorrect} 題、答錯 ${p.lastWrong} 題、未作答 ${p.total - done} 題` },
      p.lastCorrect ? h('i', { class: 'ok', style: { width: w(p.lastCorrect) } }) : null,
      p.lastWrong ? h('i', { class: 'bad', style: { width: w(p.lastWrong) } }) : null,
    ),
    h('div', { class: 'small muted pc-foot' },
      done ? `已作答 ${done}/${p.total} · 最近一次答對 ${pct(p.lastCorrect, done)}%` : '尚未作答'),
  );
}
