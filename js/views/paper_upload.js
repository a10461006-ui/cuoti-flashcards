// 上傳考古題：試題（檔案或貼上）＋答案（檔案或貼上）→ 即時預覽 → 建立考古題卷
import { api, MODE } from '../api.js';
import { goBack, navigate } from '../app.js';
import { invalidateSubjects, loadSubjects } from '../store.js';
import { clear, confirmDialog, debounce, figureList, h, icon, promptDialog, rich, showError, spinner, toast, topbar } from '../ui.js';

const ACCEPT = '.pdf,.docx,.txt,.xlsx,application/pdf,text/plain,image/*';
const isImage = (file) => /^image\//.test(file.type || '') || /\.(jpe?g|png|heic|heif|webp|bmp|gif)$/i.test(file.name);

export async function render({ root }) {
  const subjects = await loadSubjects(true);
  const state = {
    qText: '', aText: '', qFile: '', aFile: '', figures: [], busy: false,
    preview: null, title: '', year: '', exam: '', subject: '', touched: new Set(), expanded: new Set(),
  };
  let token = 0;

  const main = h('main', { class: 'page bare' });
  const bar = h('div', { class: 'actionbar' });
  const leave = async () => {
    if ((state.qText || state.aText) && !(await confirmDialog({ title: '放棄這次上傳？', message: '已貼上或擷取的內容不會保存。', ok: '放棄', danger: true }))) return;
    state.qText = '';
    state.aText = '';
    goBack('#/papers');
  };
  clear(root, topbar({ title: '上傳考古題', back: leave }), main, bar);

  // ---- 輸入區
  const qArea = h('textarea', { class: 'textarea mono', rows: 6, placeholder: '上傳試題檔，或把整份試題文字貼在這裡…\n\n例如：\n1 下列敘述，何者正確？\n(A)… (B)… (C)… (D)…' });
  const aArea = h('textarea', { class: 'textarea mono', rows: 3, placeholder: '上傳答案檔（例如考選部答案 PDF），或貼上答案：\n1.C 2.A 3.D …　或　CADB…\n（試題已內含答案可略過）' });
  const qInfo = h('div', { class: 'upload-info' });
  const aInfo = h('div', { class: 'upload-info' });
  const previewHost = h('div');

  const schedule = debounce(() => runPreview(), 700);
  qArea.addEventListener('input', () => { state.qText = qArea.value; schedule(); });
  aArea.addEventListener('input', () => { state.aText = aArea.value; schedule(); });

  const filePicker = (kind) => {
    const input = h('input', { type: 'file', accept: ACCEPT, hidden: true, multiple: true });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      if (files.every(isImage)) await ocrPhotos(kind, files);
      else await loadFile(kind, files.find((f) => !isImage(f)));
    });
    return h('label', { class: 'btn btn-sm' }, icon('upload'), kind === 'q' ? '選擇試題檔' : '選擇答案檔', input);
  };
  // 拍照：手機直接開相機，每拍一張就辨識一張，接在原本的文字後面
  const cameraPicker = (kind) => {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      if (files.length) await ocrPhotos(kind, files, { append: true });
    });
    return h('label', { class: 'btn btn-sm' }, icon('camera'), '拍照', input);
  };

  const areaOf = (kind) => (kind === 'q' ? qArea : aArea);
  const infoOf = (kind) => (kind === 'q' ? qInfo : aInfo);
  const setText = (kind, text, filename) => {
    areaOf(kind).value = text;
    if (kind === 'q') {
      state.qText = text;
      if (filename != null) state.qFile = filename;
    } else {
      state.aText = text;
      if (filename != null) state.aFile = filename;
    }
  };
  const fileLine = (name, area, extra = null) => h('div', { class: 'row-flex small' }, icon('file'), h('b', { class: 'grow' }, name),
    extra, h('span', { class: 'muted' }, `${area.value.length.toLocaleString()} 字`));

  async function loadFile(kind, file) {
    const info = infoOf(kind);
    clear(info, h('span', { class: 'muted' }, `正在讀取 ${file.name}…`));
    try {
      const res = await api.post(`/api/papers/extract?filename=${encodeURIComponent(file.name)}`, file);
      setText(kind, res.text.trim(), file.name);
      if (kind === 'q') state.figures = res.figures || [];
      const figs = kind === 'q' && state.figures.length ? h('span', { class: 'badge primary' }, `${state.figures.length} 張圖`) : null;
      clear(info,
        fileLine(file.name, areaOf(kind), figs),
        res.warnings.map((w) => h('div', { class: 'form-error' }, w)),
        res.scanned ? h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: () => ocrPdf(kind, file) }, icon('scan'), '用 OCR 辨識這份 PDF') : null,
        figs ? h('div', { class: 'small muted', style: { marginTop: '4px' } },
          '圖片會自動放到題目裡。文字中的 [圖1] 記號代表圖片的位置，放錯題目時，把記號移到正確的題目底下即可。') : null,
      );
      runPreview();
    } catch (err) {
      clear(info, h('div', { class: 'form-error' }, `${file.name}：${err.message}`));
    }
  }

  function ocrProgress(info, title) {
    const line = h('div', { class: 'small' }, '準備中…');
    const fill = h('i', { style: { width: '0%' } });
    clear(info, h('div', { class: 'ocr-box' },
      h('div', { class: 'row-flex small' }, icon('scan'), h('b', { class: 'grow' }, title)), line, h('div', { class: 'progress' }, fill)));
    return ({ index, total, label, progress }) => {
      line.textContent = `${total > 1 ? `第 ${index}/${total} 頁 · ` : ''}${label}${progress != null ? ` ${Math.round(progress * 100)}%` : '…'}`;
      const overall = total ? ((Math.max(0, index - 1) + (progress || 0)) / total) * 100 : 0;
      fill.style.width = `${Math.min(100, overall)}%`;
    };
  }

  async function runOcr(kind, title, job, { append = false, filename = null } = {}) {
    if (state.busy) { toast('正在辨識中，請稍候'); return; }
    state.busy = true;
    const info = infoOf(kind);
    let ocr = null;
    try {
      ocr = await import('../ocr.js');
      const { text, truncated } = await job(ocr, ocrProgress(info, title));
      const area = areaOf(kind);
      const merged = append && area.value.trim() ? `${area.value.trim()}\n${text}` : text;
      setText(kind, merged, filename);
      if (kind === 'q' && !append) state.figures = [];
      clear(info,
        fileLine(title, area),
        h('div', { class: 'banner', style: { marginTop: '8px' } }, icon('alert'), h('div', { class: 'd' },
          '文字辨識（OCR）可能有錯字，請對照原本的題目檢查，特別是題號、選項代號和數字。照片裡的圖不會自動擷取，可以在建立後到題目的編輯頁拍照加入。')),
        truncated ? h('div', { class: 'form-error' }, '只辨識了前 40 頁，其餘頁面請分開上傳。') : null,
        append ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, '還有下一頁的話，再按一次「拍照」，文字會接在後面。') : null,
      );
      runPreview();
    } catch (err) {
      clear(info, h('div', { class: 'form-error' }, err.message));
    } finally {
      state.busy = false;
      ocr?.releaseOcr();
    }
  }

  const ocrPhotos = (kind, files, { append = false } = {}) => runOcr(kind,
    files.length > 1 ? `辨識 ${files.length} 張照片` : '辨識照片',
    async (ocr, onProgress) => ({ text: await ocr.recognizeImages(files, onProgress) }),
    { append, filename: append ? null : files[0].name });
  const ocrPdf = (kind, file) => runOcr(kind, `OCR：${file.name}`, (ocr, onProgress) => ocr.recognizePdf(file, onProgress), { filename: file.name });

  clear(main,
    h('div', { class: 'banner info', style: { marginBottom: '14px' } }, icon('book'),
      h('div', null,
        h('div', { class: 't' }, '支援考選部的試題與答案 PDF（含題目圖片）'),
        h('div', { class: 'd' }, '也可以上傳 Word（.docx）、文字檔、直接貼上文字，或用手機拍照、上傳掃描檔，以文字辨識（OCR）讀取。OCR 在你的裝置上執行，照片不會上傳；第一次使用需要下載約 5.6 MB。'))),
    stepCard('1', '試題', null, [cameraPicker('q'), filePicker('q')], qInfo, qArea),
    stepCard('2', '答案', '選填', [cameraPicker('a'), filePicker('a')], aInfo, aArea),
    previewHost,
  );
  drawBar();

  // 本機模式才把圖片帶過去（伺服器版不支援圖片，不必上傳）
  const figurePayload = () => (MODE === 'local' && state.figures.length ? { figures: state.figures } : {});

  // ---- 預覽
  async function runPreview() {
    const my = ++token;
    if (!state.qText.trim()) {
      state.preview = null;
      clear(previewHost);
      drawBar();
      return;
    }
    if (!state.preview) clear(previewHost, spinner());
    try {
      const p = await api.post('/api/papers/preview', {
        questionsText: state.qText, answersText: state.aText, filename: state.qFile, ...figurePayload(),
      });
      if (my !== token) return;
      state.preview = p;
      if (!state.touched.has('title')) state.title = p.meta.title || state.qFile.replace(/\.[^.]+$/, '') || '考古題';
      if (!state.touched.has('year')) state.year = p.meta.year;
      if (!state.touched.has('exam')) state.exam = p.meta.exam;
      if (!state.touched.has('subject')) {
        const match = subjects.find((s) => s.name === p.meta.subject);
        state.subject = match ? `id:${match.id}` : `new:${p.meta.subject || '考古題'}`;
      }
      drawPreview();
    } catch (err) {
      if (my === token) clear(previewHost, h('div', { class: 'card form-error' }, err.message));
    }
    drawBar();
  }

  function drawPreview() {
    const p = state.preview;
    const s = p.stats;
    const field = (key, label, attrs = {}) => {
      const input = h('input', { class: 'input', value: state[key], ...attrs });
      input.addEventListener('input', () => { state[key] = input.value; state.touched.add(key); drawBar(); });
      return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input);
    };

    const subjectSelect = h('select', { class: 'select', 'aria-label': '科目' });
    const drawSubjectOptions = () => {
      const newName = state.subject.startsWith('new:') ? state.subject.slice(4) : (p.meta.subject || '考古題');
      clear(subjectSelect,
        h('option', { value: `new:${newName}`, selected: state.subject === `new:${newName}` }, `＋ 建立新科目「${newName}」`),
        subjects.map((x) => h('option', { value: `id:${x.id}`, selected: state.subject === `id:${x.id}` }, x.name)),
        h('option', { value: '__other' }, '＋ 其他新科目名稱…'),
      );
    };
    drawSubjectOptions();
    subjectSelect.addEventListener('change', async () => {
      if (subjectSelect.value === '__other') {
        const name = await promptDialog({ title: '新科目名稱', placeholder: '例如：綜合法學（三）、物理治療學' });
        if (name) state.subject = `new:${name}`;
      } else state.subject = subjectSelect.value;
      state.touched.add('subject');
      drawSubjectOptions();
    });

    const list = h('div', { class: 'list paper-preview' });
    for (const q of p.questions) list.append(previewRow(q));

    clear(previewHost,
      h('div', { class: 'card', style: { marginTop: '12px' } },
        h('div', { class: 'step-head' }, h('span', { class: 'step-no' }, '3'), h('b', null, '確認內容')),
        h('div', { class: 'imp-stats' },
          h('span', { class: 'badge primary' }, `解析出 ${s.total} 題`),
          h('span', { class: 'badge ok' }, `可直接練習 ${s.ok}`),
          s.review ? h('span', { class: 'badge warn' }, `需確認答案 ${s.review}`) : null,
          s.incomplete ? h('span', { class: 'badge muted' }, `選項不完整 ${s.incomplete}`) : null,
          s.linked ? h('span', { class: 'badge muted' }, `與訂正本相同 ${s.linked}`) : null,
          s.alreadyUploaded ? h('span', { class: 'badge muted' }, `已上傳過 ${s.alreadyUploaded}`) : null,
          s.withImages ? h('span', { class: 'badge primary' }, `含圖片 ${s.withImages}`) : null,
        ),
        p.warnings.length ? h('div', { class: 'stack', style: { margin: '10px 0 14px' } },
          p.warnings.map((w) => h('div', { class: 'banner' }, icon('alert'), h('div', { class: 'd' }, w)))) : null,
        s.linked ? h('p', { class: 'small muted', style: { margin: '0 0 12px' } },
          `有 ${s.linked} 題和你的訂正本一模一樣，不會重複建立，而是直接連到這份考古題（保留你的筆記與練習紀錄）。`) : null,
        field('title', '考古題名稱', { maxlength: 80, placeholder: '例如：113年 司法官第一試 綜合法學（三）' }),
        h('div', { class: 'two-col' }, field('year', '年度', { maxlength: 10, inputmode: 'numeric', placeholder: '113' }),
          field('exam', '考試', { maxlength: 40, placeholder: '司法官考試第一試' })),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '放在哪個科目'), subjectSelect),
      ),
      h('div', { class: 'section-title' }, h('span', null, `題目預覽（${s.total}）`), h('span', null, '點一下看完整內容')),
      p.questions.length ? list : h('div', { class: 'card empty' }, h('p', null, '沒有解析到題目。請確認每一題都以「題號＋空白」開頭，例如「1 下列…」或「1. 下列…」。')),
    );
  }

  function previewRow(q) {
    const open = state.expanded.has(q.number);
    const row = h('div', { class: `pv-row ${open ? 'open' : ''}` });
    const head = h('button', { class: 'pv-head', onclick: () => {
      if (state.expanded.has(q.number)) state.expanded.delete(q.number); else state.expanded.add(q.number);
      row.replaceWith(previewRow(q));
    } },
    h('span', { class: `num ${q.status}` }, q.number),
    h('span', { class: 'pv-stem' }, q.stem || '（沒有題目內容）'),
    q.images?.length ? h('span', { class: 'pv-img', title: '這題有圖片' }, icon('image')) : null,
    q.answer ? h('span', { class: 'badge ok' }, `答 ${q.answer}`) : h('span', { class: 'badge warn' }, '無答案'),
    );
    row.append(head);
    if (open) {
      row.append(h('div', { class: 'pv-body' },
        q.statusNote ? h('div', { class: 'small', style: { color: 'var(--warn)', marginBottom: '8px' } }, q.statusNote) : null,
        q.duplicate === 'notebook' ? h('div', { class: 'small muted', style: { marginBottom: '8px' } }, '與訂正本的題目相同，會直接連結') : null,
        q.duplicate === 'paper' ? h('div', { class: 'small muted', style: { marginBottom: '8px' } }, '這題已在其他考古題中，會略過') : null,
        rich(q.stem, 'pv-full'),
        figureList(q.images, 'sm'),
        h('div', { class: 'pv-opts' }, q.options.map((o) => h('div', { class: `pv-opt ${o.key === q.answer ? 'ans' : ''}` },
          h('b', null, `(${o.key})`), ' ', o.text))),
        q.concept ? h('div', { class: 'note concept' }, h('div', { class: 'lbl' }, '解析'), rich(q.concept)) : null,
      ));
    }
    return row;
  }

  function drawBar() {
    const p = state.preview;
    const creatable = p ? p.questions.filter((q) => q.duplicate !== 'paper').length : 0;
    const btn = h('button', {
      class: 'btn btn-primary btn-lg', disabled: !creatable || !state.title.trim(),
      onclick: create,
    }, icon('check'), p ? `建立考古題卷（${creatable} 題）` : '請先上傳或貼上試題');
    clear(bar, h('div', { class: 'inner' }, btn));
  }

  async function create(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    const subject = state.subject.startsWith('id:') ? { subjectId: Number(state.subject.slice(3)) } : { subjectName: state.subject.slice(4) };
    try {
      const res = await api.post('/api/papers', {
        questionsText: state.qText, answersText: state.aText, filename: state.qFile, ...figurePayload(),
        title: state.title.trim(), year: state.year.trim(), exam: state.exam.trim(), ...subject,
      });
      invalidateSubjects();
      state.qText = '';
      state.aText = '';
      toast(`已建立：新增 ${res.inserted} 題${res.linked ? `、連結 ${res.linked} 題` : ''}`, 'ok');
      navigate(`#/paper/${res.id}`, { replace: true });
    } catch (err) {
      showError(err);
      btn.disabled = false;
    }
  }
}

function stepCard(no, title, hint, pickers, info, area) {
  return h('div', { class: 'card', style: { marginTop: '12px' } },
    h('div', { class: 'step-head' },
      h('span', { class: 'step-no' }, no), h('b', { class: 'grow' }, title),
      hint ? h('span', { class: 'small muted' }, hint) : null),
    h('div', { class: 'pickers' }, pickers),
    info,
    area,
  );
}
