// 「＋新增」：選擇要手動輸入、上傳考古題，或匯入 Excel 訂正本
import { clear, h, icon, topbar } from '../ui.js';

const CHOICES = [
  {
    href: '#/new', icon: 'edit', title: '手動新增一題',
    desc: '輸入錯題與詳解。可以「貼上整題」自動拆出 (A)(B)(C)(D) 選項。',
  },
  {
    href: '#/papers/upload', icon: 'file', title: '上傳考古題（試題＋答案）',
    desc: '上傳歷屆試題 PDF／Word 與答案檔，或直接貼上文字，整份變成可練習的考古題卷。',
    badge: '新',
  },
  {
    href: '#/import', icon: 'upload', title: '匯入 Excel 訂正本',
    desc: '「題幹／選項A…」格式的訂正本，會自動判斷答案並保留你的筆記。',
  },
];

export async function render({ root }) {
  clear(root,
    topbar({ title: '新增題目' }),
    h('main', { class: 'page' },
      h('div', { class: 'stack' }, CHOICES.map((c) => h('a', { class: 'choice', href: c.href },
        h('span', { class: 'ico' }, icon(c.icon)),
        h('span', { class: 'grow' },
          h('span', { class: 't' }, c.title, c.badge ? h('span', { class: 'badge primary' }, c.badge) : null),
          h('span', { class: 'd' }, c.desc),
        ),
        icon('chevron'),
      ))),
    ),
  );
}
