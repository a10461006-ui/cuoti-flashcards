// 單份考古題：作答進度、練習方式、題號格
import { api } from '../api.js';
import { goBack, navigate } from '../app.js';
import { invalidateSubjects } from '../store.js';
import { clear, confirmDialog, h, icon, iconButton, openSheet, pct, showError, toast, topbar } from '../ui.js';
import { startPractice } from './practice.js';

export async function render({ root, params }) {
  const id = Number(params[0]);
  let p = await api.get(`/api/papers/${id}`);
  const header = h('div');
  const main = h('main', { class: 'page' });
  clear(root, header, main);

  const run = async (btn, config) => {
    btn.disabled = true;
    try {
      if (!(await startPractice({ paperId: p.id, limit: 1000, title: p.title, ...config }))) btn.disabled = false;
    } catch (err) { showError(err); btn.disabled = false; }
  };

  const draw = () => {
    const qs = p.questions;
    const done = qs.filter((q) => q.lastResult != null).length;
    const correct = qs.filter((q) => q.lastResult === 1).length;
    const wrong = qs.filter((q) => q.lastResult === 0).length;
    const unseen = qs.filter((q) => q.status === 'ok' && q.lastResult == null).length;
    const firstUnseen = qs.find((q) => q.status === 'ok' && q.lastResult == null);

    clear(header, topbar({
      title: '考古題',
      back: () => goBack('#/papers'),
      actions: [iconButton('edit', '修改名稱', rename)],
    }));

    clear(main,
      h('div', { class: 'card' },
        h('h2', { style: { marginBottom: '4px' } }, p.title),
        h('div', { class: 'small muted' }, [p.subject, p.year && `${p.year} 年`, p.exam].filter(Boolean).join(' · ')),
        h('div', { class: 'sum-stats', style: { justifyContent: 'flex-start', margin: '14px 0 16px' } },
          h('div', null, h('b', null, `${done}/${p.total}`), '已作答'),
          h('div', null, h('b', null, correct), '答對'),
          h('div', null, h('b', null, wrong), '答錯'),
          h('div', null, h('b', null, done ? `${pct(correct, done)}%` : '—'), '正確率'),
        ),
        h('div', { class: 'stack' },
          firstUnseen && done
            ? h('button', { class: 'btn btn-primary btn-block btn-lg', onclick: (e) => run(e.currentTarget, { mode: 'paper', ordered: true, unseenOnly: true }) },
              icon('arrow'), `繼續作答（從第 ${firstUnseen.number} 題，剩 ${unseen} 題）`)
            : h('button', { class: 'btn btn-primary btn-block btn-lg', disabled: !p.ready, onclick: (e) => run(e.currentTarget, { mode: 'paper', ordered: true }) },
              icon('arrow'), `依序作答全部（${p.ready} 題）`),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', disabled: !p.ready, onclick: (e) => run(e.currentTarget, { mode: 'paper', ordered: false, title: `${p.title}・隨機` }) },
              icon('shuffle'), '隨機'),
            h('button', { class: 'btn', disabled: !wrong, onclick: (e) => run(e.currentTarget, { mode: 'wrong', title: `${p.title}・錯題` }) },
              icon('refresh'), `錯題（${wrong}）`),
          ),
          firstUnseen && done ? h('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => run(e.currentTarget, { mode: 'paper', ordered: true }) }, '從第 1 題重新作答') : null,
        ),
      ),

      p.pending ? h('a', { class: 'banner', href: `#/bank?paper=${p.id}&status=review`, style: { marginTop: '12px' } }, icon('alert'),
        h('div', null, h('div', { class: 't' }, `${p.pending} 題需要處理`),
          h('div', { class: 'd' }, '答案未確認或選項不完整的題目不會出現在練習中，點題號格裡的虛線格子處理')),
        h('span', { class: 'chev' }, icon('chevron'))) : null,

      h('div', { class: 'section-title' }, '題號'),
      h('div', { class: 'card' },
        h('div', { class: 'num-grid' }, qs.map((q) => {
          const state = q.status !== 'ok' ? 'warn' : q.lastResult === 1 ? 'ok' : q.lastResult === 0 ? 'bad' : '';
          const label = q.status !== 'ok' ? '待處理' : q.lastResult === 1 ? '答對' : q.lastResult === 0 ? '答錯' : '未作答';
          return h('a', { href: `#/q/${q.id}`, class: state, 'aria-label': `第 ${q.number} 題：${label}`, title: label }, q.number ?? '–');
        })),
        h('div', { class: 'legend', style: { marginTop: '12px' } },
          h('span', null, h('i', { class: 'lg-ok' }), '最近答對'),
          h('span', null, h('i', { class: 'lg-bad' }), '最近答錯'),
          h('span', null, h('i', { class: 'lg-none' }), '未作答'),
          h('span', null, h('i', { class: 'lg-warn' }), '待處理'),
        ),
      ),

      h('div', { class: 'stack', style: { marginTop: '18px' } },
        h('a', { class: 'btn btn-block', href: `#/bank?paper=${p.id}` }, icon('layers'), '以列表查看全部題目'),
        h('button', { class: 'btn btn-block btn-danger', onclick: remove }, icon('trash'), '刪除這份考古題'),
      ),
    );
  };

  function rename() {
    openSheet((close) => {
      const title = h('input', { class: 'input', value: p.title, maxlength: 80 });
      const year = h('input', { class: 'input', value: p.year, maxlength: 10, inputmode: 'numeric' });
      const exam = h('input', { class: 'input', value: p.exam, maxlength: 40 });
      const submit = async (e) => {
        e.preventDefault();
        try {
          const updated = await api.patch(`/api/papers/${p.id}`, { title: title.value.trim(), year: year.value.trim(), exam: exam.value.trim() });
          p = { ...p, ...updated };
          close();
          toast('已更新');
          draw();
        } catch (err) { showError(err); }
      };
      return h('form', { onsubmit: submit },
        h('h3', null, '修改考古題資訊'),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '名稱'), title),
        h('div', { class: 'two-col' },
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, '年度'), year),
          h('label', { class: 'field' }, h('span', { class: 'lbl' }, '考試'), exam)),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, '儲存')),
      );
    });
  }

  async function remove() {
    const ok = await confirmDialog({
      title: '刪除這份考古題？',
      message: '上傳時建立的題目與練習紀錄會一起刪除；原本就在訂正本裡、只是被連結的題目會保留。',
      ok: '刪除', danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/papers/${p.id}`);
      invalidateSubjects();
      toast('已刪除');
      navigate('#/papers', { replace: true });
    } catch (err) { showError(err); }
  }

  draw();
}
