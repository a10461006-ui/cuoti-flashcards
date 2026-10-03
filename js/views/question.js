import { api } from '../api.js';
import { goBack, navigate } from '../app.js';
import { invalidateSubjects } from '../store.js';
import { clear, confirmDialog, formatDue, h, icon, iconButton, rich, showError, toast, topbar } from '../ui.js';
import { startPractice } from './practice.js';

export async function render({ root, params }) {
  const id = Number(params[0]);
  let q = await api.get(`/api/questions/${id}`);
  let nextReview = null; // 確認答案後，提示下一題待確認
  const main = h('main', { class: 'page' });
  const header = h('div');
  clear(root, header, main);

  const draw = () => {
    clear(header, topbar({
      title: q.subject || '題目',
      back: () => goBack('#/bank'),
      actions: [
        iconButton(q.starred ? 'starFill' : 'star', q.starred ? '取消收藏' : '收藏', toggleStar, { class: `icon-btn ${q.starred ? 'on' : ''}` }),
        iconButton('edit', '編輯', () => navigate(`#/edit/${q.id}`)),
      ],
    }));
    const confirming = q.status === 'review';
    const c = q.card;

    clear(main,
      nextReview ? h('a', { class: 'banner info', href: `#/q/${nextReview.id}`, style: { marginBottom: '14px' } }, icon('check'),
        h('div', null, h('div', { class: 't' }, '已確認！'), h('div', { class: 'd' }, `還有 ${nextReview.total} 題需要確認答案`)),
        h('span', { class: 'chev' }, icon('chevron'))) : null,
      q.status === 'review' ? h('div', { class: 'banner', style: { marginBottom: '14px' } }, icon('alert'),
        h('div', null, h('div', { class: 't' }, '請點選正確答案'), h('div', { class: 'd' }, q.statusNote || '這題的答案需要確認'))) : null,
      q.status === 'incomplete' ? h('div', { class: 'banner', style: { marginBottom: '14px' } }, icon('alert'),
        h('div', { class: 'grow' }, h('div', { class: 't' }, '題目不完整'), h('div', { class: 'd' }, q.statusNote)),
        h('a', { class: 'btn btn-sm', href: `#/edit/${q.id}` }, '補齊')) : null,
      h('div', { class: 'q-meta' },
        h('span', { class: 'badge primary' }, q.subject),
        q.source ? h('span', null, q.source) : null,
        ...q.tags.map((t) => h('span', { class: 'badge muted' }, `#${t}`)),
      ),
      q.paperId ? h('a', { class: 'paper-link', href: `#/paper/${q.paperId}` },
        icon('file'), `${q.paperTitle} · 第 ${q.number} 題`, icon('chevron')) : null,
      rich(q.stem || '（沒有題幹）', 'q-stem'),
      h('div', { class: 'opts' }, q.options.map((o) => optionView(o, q, confirming))),
      note('keypoint', '本題考點', q.keypoint),
      note('mistake', '我誤會的地方', q.mistake),
      note('concept', '正確觀念', q.concept),
      note('', '補充', q.note),
      h('div', { class: 'section-title' }, '練習紀錄'),
      h('div', { class: 'list' },
        infoRow('作答次數', c ? `${c.attempts} 次（答對 ${c.correct}、答錯 ${c.attempts - c.correct}）` : '尚未練習'),
        c ? infoRow('最近一次', c.lastResult ? '答對' : '答錯') : null,
        c?.dueAt ? infoRow('下次複習', formatDue(c.dueAt)) : null,
        infoRow('建立時間', new Date(q.createdAt).toLocaleDateString('zh-TW')),
      ),
      h('div', { class: 'stack', style: { marginTop: '18px' } },
        q.status === 'ok' ? h('button', {
          class: 'btn btn-primary btn-block',
          onclick: () => startPractice({ mode: 'ids', ids: [q.id], title: '單題練習' }).catch(showError),
        }, icon('target'), '練習這題') : null,
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn', href: `#/edit/${q.id}` }, icon('edit'), '編輯'),
          h('button', { class: 'btn btn-danger', onclick: remove }, icon('trash'), '刪除'),
        ),
      ),
    );
  };

  function optionView(o, question, confirming) {
    const isAnswer = o.key === question.answer;
    const suggested = confirming && isAnswer;
    const cls = ['opt', !confirming && isAnswer && 'is-answer', suggested && 'is-suggest'].filter(Boolean).join(' ');
    const body = h('div', { class: 'body' },
      h('div', { class: 'txt' }, o.text),
      suggested ? h('div', { class: 'mark suggest' }, '★ 系統建議的答案') : null,
      o.mark ? h('div', { class: 'mark' }, `敘述判斷：${o.mark}`) : null,
      note('mistake', '我誤會的地方', o.mistake),
      note('concept', '正確觀念', o.concept),
      note('', '考點／補充', o.note),
    );
    const key = h('span', { class: 'key' }, !confirming && isAnswer ? icon('check') : o.key);
    if (!confirming) return h('div', { class: cls }, key, body);
    return h('button', { class: cls, onclick: () => confirmAnswer(o.key), 'aria-label': `設定 ${o.key} 為正確答案` }, key, body);
  }

  async function confirmAnswer(key) {
    const ok = await confirmDialog({ title: `正確答案是 ${key}？`, message: '確認後這題就會出現在練習中。', ok: `設為 ${key}` });
    if (!ok) return;
    try {
      q = await api.patch(`/api/questions/${q.id}`, { answer: key });
      invalidateSubjects();
      toast(q.status === 'ok' ? '已確認答案，可以開始練習了' : '已設定答案', 'ok');
      const rest = await api.get('/api/questions?status=review&sort=oldest&limit=1');
      nextReview = rest.items[0] ? { id: rest.items[0].id, total: rest.total } : null;
      draw();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { showError(err); }
  }

  async function toggleStar() {
    try {
      q = await api.patch(`/api/questions/${q.id}`, { starred: !q.starred });
      toast(q.starred ? '已加入收藏' : '已取消收藏');
      draw();
    } catch (err) { showError(err); }
  }

  async function remove() {
    const ok = await confirmDialog({ title: '刪除這一題？', message: '刪除後無法復原，練習紀錄也會一併刪除。', ok: '刪除', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/questions/${q.id}`);
      invalidateSubjects();
      toast('已刪除');
      goBack('#/bank');
    } catch (err) { showError(err); }
  }

  draw();
}

function note(kind, label, text) {
  if (!text) return null;
  return h('div', { class: `note ${kind}` }, h('div', { class: 'lbl' }, label), rich(text));
}

function infoRow(label, value) {
  return h('div', { class: 'row' }, h('span', { class: 'grow muted' }, label), h('span', null, value));
}
