import { api } from '../api.js';
import { goBack } from '../app.js';
import { invalidateSubjects } from '../store.js';
import { clear, downloadTemplate, h, icon, showError, spinner, toast, topbar } from '../ui.js';

export async function render({ root }) {
  const fileInput = h('input', {
    type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', multiple: true, hidden: true,
  });
  const results = h('div', { class: 'stack', style: { marginTop: '16px' } });
  const drop = h('label', { class: 'dropzone' },
    icon('upload'),
    h('div', { style: { fontWeight: 700 } }, '選擇 Excel 檔案（可多選）'),
    h('div', { class: 'small muted' }, '支援 .xlsx，每個檔案會成為一個科目'),
    fileInput,
  );

  clear(root,
    topbar({ title: '匯入 Excel', back: () => goBack('#/bank') }),
    h('main', { class: 'page' },
      h('div', { class: 'card' },
        h('h2', null, '訂正本格式'),
        h('p', { class: 'small', style: { margin: '0 0 10px', color: 'var(--text-2)' } },
          '工作表 A 欄用「題幹-1」「選項A」「選項B」…標示每一列，B 欄放內容，C 欄標記選項對錯（✅正確／❌錯誤、可／不可…），D–F 欄可放「我誤會的地方」「正確觀念」「本題考點」。系統會依標記與題目問法（何者正確／錯誤）自動判斷答案。'),
        h('button', { class: 'btn btn-sm', onclick: () => downloadTemplate().catch(showError) }, icon('download'), '下載範本'),
      ),
      h('div', { style: { height: '12px' } }),
      drop,
      results,
    ),
  );

  const handleFiles = (files) => {
    for (const file of files) {
      if (!/\.xlsx$/i.test(file.name)) { toast(`${file.name} 不是 .xlsx 檔`, 'bad'); continue; }
      results.prepend(fileCard(file));
    }
  };
  fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); handleFiles([...e.dataTransfer.files]); });
}

export function fileCard(file) {
  const card = h('div', { class: 'card' }, h('div', { class: 'row-flex' }, icon('file'), h('b', { class: 'grow' }, file.name)), spinner());
  preview(file, card);
  return card;
}

async function preview(file, card) {
  let data;
  try {
    data = await api.post(`/api/import/preview?filename=${encodeURIComponent(file.name)}`, file);
  } catch (err) {
    clear(card, h('div', { class: 'row-flex' }, icon('file'), h('b', { class: 'grow' }, file.name)),
      h('p', { class: 'form-error' }, err.message));
    return;
  }
  const s = data.stats;
  const subject = h('input', { class: 'input', value: data.subject, maxlength: 40, 'aria-label': '科目名稱' });
  const category = h('input', { class: 'input', placeholder: '例如：司法官、物理治療師（選填）', maxlength: 40, 'aria-label': '分類' });
  const problems = data.items.filter((i) => i.status !== 'ok');
  const fresh = s.total - s.alreadyImported;
  const btn = h('button', { class: 'btn btn-primary btn-block', disabled: !fresh }, fresh ? `匯入 ${fresh} 題` : '全部都已匯入過');

  btn.addEventListener('click', async () => {
    if (!subject.value.trim()) { toast('請輸入科目名稱', 'bad'); subject.focus(); return; }
    btn.disabled = true;
    try {
      const res = await api.post(
        `/api/import/commit?filename=${encodeURIComponent(file.name)}&subject=${encodeURIComponent(subject.value.trim())}&category=${encodeURIComponent(category.value.trim())}`,
        file,
      );
      invalidateSubjects();
      clear(card,
        h('div', { class: 'row-flex' }, icon('check'), h('b', { class: 'grow' }, `${file.name} 匯入完成`)),
        h('p', { class: 'small', style: { margin: '8px 0 12px' } },
          `新增 ${res.inserted} 題到「${subject.value.trim()}」${res.skippedDuplicates ? `，略過重複 ${res.skippedDuplicates} 題` : ''}。`),
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn btn-sm', href: `#/bank?subject=${res.subjectId}` }, '查看題目'),
          s.review ? h('a', { class: 'btn btn-sm', href: '#/bank?status=review' }, `確認答案（${s.review}）`) : null,
        ),
      );
      toast(`已匯入 ${res.inserted} 題`, 'ok');
    } catch (err) {
      showError(err);
      btn.disabled = false;
    }
  });

  clear(card,
    h('div', { class: 'row-flex' }, icon('file'), h('b', { class: 'grow' }, file.name)),
    h('div', { class: 'imp-stats' },
      h('span', { class: 'badge primary' }, `共 ${s.total} 題`),
      h('span', { class: 'badge ok' }, `可直接練習 ${s.ok}`),
      s.review ? h('span', { class: 'badge warn' }, `需確認答案 ${s.review}`) : null,
      s.incomplete ? h('span', { class: 'badge muted' }, `不完整 ${s.incomplete}`) : null,
      s.alreadyImported ? h('span', { class: 'badge muted' }, `已匯入過 ${s.alreadyImported}`) : null,
    ),
    s.skipped_blank ? h('div', { class: 'small muted', style: { marginBottom: '10px' } }, `略過 ${s.skipped_blank} 筆空白範本列${s.duplicates_in_file ? `、${s.duplicates_in_file} 筆檔案內重複題` : ''}`) : null,
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '匯入到科目'), subject),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '分類', h('span', { class: 'hint' }, '選填，用來把科目分組')), category),
    problems.length ? h('details', { class: 'fold', style: { marginBottom: '14px' } },
      h('summary', null, `需要處理的題目（${problems.length}）`),
      h('div', { class: 'body' }, h('div', { class: 'imp-list' }, problems.map((p) => h('div', { class: 'it' },
        h('div', null, h('b', null, p.source || `第 ${p.row} 列`), ' ', p.stem),
        h('div', { class: 'why' }, p.statusNote),
      )))),
    ) : null,
    btn,
  );
}
