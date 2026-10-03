// 新增／編輯題目
import { api } from '../api.js';
import { goBack, navigate } from '../app.js';
import { invalidateSubjects, loadSubjects } from '../store.js';
import { cleanInline } from '../local/textutil.js';
import {
  autoGrow, clear, confirmDialog, h, icon, iconButton, imageToDataUrl, openImage, openSheet, promptDialog, segmented, showError, toast, topbar,
} from '../ui.js';

const LETTERS = 'ABCDEFGH';
const MAX_OPTIONS = 8;
const MARK_POS = '✅正確';
const MARK_NEG = '❌錯誤';
const MAX_IMAGES = 6;

export async function render({ root, params, query }) {
  const editId = params[0] ? Number(params[0]) : null;
  const [subjects, existing] = await Promise.all([
    loadSubjects(true),
    editId ? api.get(`/api/questions/${editId}`) : null,
  ]);

  const lastSubject = Number(localStorage.getItem('fc.lastSubject')) || null;
  const blank = () => ({
    subjectId: query.subject ? Number(query.subject) : (subjects.some((s) => s.id === lastSubject) ? lastSubject : subjects[0]?.id ?? null),
    source: '', stem: '', answer: '', keypoint: '', mistake: '', concept: '', note: '', tags: [], images: [],
    options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: '', mark: '', mistake: '', concept: '', note: '' })),
  });
  const form = existing ? {
    subjectId: existing.subjectId, source: existing.source, stem: existing.stem, answer: existing.answer,
    keypoint: existing.keypoint, mistake: existing.mistake, concept: existing.concept, note: existing.note,
    tags: [...existing.tags], options: existing.options.map((o) => ({ ...o })), images: [...(existing.images || [])],
  } : blank();
  let dirty = false;
  const touch = () => { dirty = true; };

  const leave = async () => {
    if (dirty && !(await confirmDialog({ title: '放棄未儲存的修改？', ok: '放棄', danger: true }))) return;
    dirty = false;
    goBack(editId ? `#/q/${editId}` : '#/bank');
  };

  const saveBtn = h('button', { class: 'btn btn-primary btn-sm', onclick: () => save(false) }, '儲存');
  const main = h('main', { class: 'page bare' });
  clear(root, topbar({ title: editId ? '編輯題目' : '新增題目', back: leave, actions: [saveBtn] }), main);

  // 關閉分頁前提醒
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // ---- 欄位
  const subjectSelect = h('select', { class: 'select', 'aria-label': '科目' });
  const drawSubjectOptions = () => clear(subjectSelect,
    subjects.length ? null : h('option', { value: '' }, '（尚無科目）'),
    subjects.map((s) => h('option', { value: s.id, selected: s.id === form.subjectId }, s.category ? `${s.name}（${s.category}）` : s.name)),
    h('option', { value: '__new' }, '＋ 新增科目…'),
  );
  drawSubjectOptions();
  subjectSelect.addEventListener('change', async () => {
    if (subjectSelect.value === '__new') {
      const name = await promptDialog({ title: '新增科目', label: '科目名稱', placeholder: '例如：民法、神經疾病物理治療學' });
      if (name) {
        try {
          const { id } = await api.post('/api/subjects', { name });
          invalidateSubjects();
          subjects.push({ id, name, category: '', total: 0, ready: 0 });
          form.subjectId = id;
          touch();
        } catch (err) { showError(err); }
      }
      drawSubjectOptions();
    } else {
      form.subjectId = Number(subjectSelect.value);
      touch();
    }
  });

  const source = h('input', { class: 'input', value: form.source, placeholder: '例如：113 年司律第 5 題（選填）', maxlength: 200 });
  source.addEventListener('input', () => { form.source = source.value; touch(); });

  const stem = autoGrow(h('textarea', { class: 'textarea', value: form.stem, placeholder: '題目內容', rows: 3 }));
  stem.addEventListener('input', () => { form.stem = stem.value; touch(); });

  // ---- 題目附圖
  const imagesHost = h('div', { class: 'img-edit' });
  const imagePicker = (label, camera) => {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true, multiple: !camera, capture: camera ? 'environment' : null });
    input.addEventListener('change', async () => {
      const files = [...input.files].slice(0, MAX_IMAGES - form.images.length);
      input.value = '';
      for (const file of files) {
        try {
          form.images.push(await imageToDataUrl(file));
          touch();
        } catch (err) { showError(err); }
      }
      drawImages();
    });
    return h('label', { class: 'btn btn-sm' }, icon(camera ? 'camera' : 'image'), label, input);
  };
  const drawImages = () => clear(imagesHost,
    form.images.length ? h('div', { class: 'img-thumbs' }, form.images.map((img, i) => h('div', { class: 'img-thumb' },
      h('button', { type: 'button', class: 'img-open', 'aria-label': `放大第 ${i + 1} 張圖`, onclick: () => openImage(img.src) },
        h('img', { src: img.src, alt: `附圖 ${i + 1}` })),
      iconButton('x', `移除第 ${i + 1} 張圖`, () => { form.images.splice(i, 1); touch(); drawImages(); }, { class: 'icon-btn img-del' }),
    ))) : null,
    form.images.length < MAX_IMAGES ? h('div', { class: 'btn-row img-add' }, imagePicker('拍照', true), imagePicker('選擇圖片', false)) : null,
  );
  drawImages();

  const optionsHost = h('div');
  const answerHint = h('div', { class: 'answer-hint' });
  const optNotesHost = h('div');

  const drawOptions = () => {
    clear(optionsHost, form.options.map((o, i) => {
      const ta = autoGrow(h('textarea', { class: 'textarea', value: o.text, rows: 1, placeholder: `選項 ${LETTERS[i]}`, 'aria-label': `選項 ${LETTERS[i]}` }));
      ta.addEventListener('input', () => { o.text = ta.value; touch(); });
      const isAns = form.answer === o.key;
      return h('div', { class: 'opt-edit' },
        h('button', {
          type: 'button', class: `pick ${isAns ? 'on' : ''}`, 'aria-pressed': String(isAns),
          'aria-label': `設定 ${LETTERS[i]} 為正確答案`, title: '點一下設為正確答案',
          onclick: () => { form.answer = o.key; touch(); drawOptions(); },
        }, isAns ? icon('check') : LETTERS[i]),
        ta,
        form.options.length > 2 ? iconButton('x', `刪除選項 ${LETTERS[i]}`, () => {
          form.options.splice(i, 1);
          relabel();
          touch();
          drawOptions();
        }) : null,
      );
    }), form.options.length < MAX_OPTIONS ? h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => {
        form.options.push({ key: LETTERS[form.options.length], text: '', mark: '', mistake: '', concept: '', note: '' });
        touch();
        drawOptions();
        optionsHost.querySelectorAll('textarea')[form.options.length - 1]?.focus();
      },
    }, icon('plus'), '新增選項') : null);
    answerHint.className = `answer-hint ${form.answer ? '' : 'need'}`;
    answerHint.textContent = form.answer ? `正確答案：${form.answer}（點左側圓圈可更改）` : '點選項左側的圓圈，設定正確答案';
    drawOptionNotes();
  };

  // 刪除選項後重新編號，答案跟著選項走
  const relabel = () => {
    const answerOpt = form.options.find((o) => o.key === form.answer);
    form.options.forEach((o, i) => { o.key = LETTERS[i]; });
    form.answer = answerOpt ? answerOpt.key : '';
  };

  const noteArea = (obj, field, label, placeholder = '') => {
    const ta = autoGrow(h('textarea', { class: 'textarea sm', value: obj[field] || '', placeholder, rows: 2 }));
    ta.addEventListener('input', () => { obj[field] = ta.value; touch(); });
    return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), ta);
  };

  const drawOptionNotes = () => clear(optNotesHost,
    h('div', { class: 'row-flex', style: { justifyContent: 'flex-end', marginBottom: '6px' } },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: autoMark, title: '依題目問法與正確答案，自動標記每個選項敘述的對錯' }, '依答案自動標記對錯'),
    ),
    form.options.map((o, i) => h('div', { class: 'opt-note-block' },
      h('div', { class: 'head' },
        h('span', null, `選項 ${LETTERS[i]}`),
        segmented([{ value: MARK_POS, label: '✅ 正確' }, { value: MARK_NEG, label: '❌ 錯誤' }, { value: '', label: '未標記' }],
          [MARK_POS, MARK_NEG].includes(o.mark) ? o.mark : (o.mark ? o.mark : ''), (v) => { o.mark = v; touch(); }),
      ),
      o.mark && ![MARK_POS, MARK_NEG].includes(o.mark) ? h('div', { class: 'small muted', style: { marginBottom: '8px' } }, `原本的標記：${o.mark}`) : null,
      noteArea(o, 'mistake', '我誤會的地方'),
      noteArea(o, 'concept', '正確觀念'),
      noteArea(o, 'note', '考點／補充'),
    )),
  );

  function autoMark() {
    if (!form.answer) { toast('請先設定正確答案'); return; }
    const neg = stemIsNegative(form.stem);
    for (const o of form.options) {
      const isAns = o.key === form.answer;
      o.mark = (isAns !== neg) ? MARK_POS : MARK_NEG;
    }
    touch();
    drawOptionNotes();
    toast(neg ? '題目問「錯誤／不得」：答案標為錯誤，其餘標為正確' : '答案標為正確，其餘標為錯誤');
  }

  const tags = h('input', { class: 'input', value: form.tags.join('、'), placeholder: '用逗號或頓號分隔，例如：代理、無權處分' });
  tags.addEventListener('input', () => { form.tags = tags.value.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean); touch(); });

  const pasteBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => smartPaste() }, icon('clipboard'), '貼上整題自動拆解');

  const hasNotes = form.keypoint || form.mistake || form.concept || form.note || form.tags.length;
  const hasOptNotes = form.options.some((o) => o.mistake || o.concept || o.note || o.mark);

  clear(main,
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '科目'), subjectSelect),
    h('div', { class: 'field' },
      h('div', { class: 'lbl' }, h('span', null, '題目'), pasteBtn),
      stem,
    ),
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, h('span', null, '題目附圖'), h('span', { class: 'hint' }, '選填，最多 6 張')), imagesHost),
    h('div', { class: 'field' }, h('div', { class: 'lbl' }, '選項與答案'), answerHint, optionsHost),
    h('details', { class: 'fold', open: Boolean(hasNotes) || !editId },
      h('summary', null, '詳解與筆記', h('span', { class: 'hint' }, '選填')),
      h('div', { class: 'body' },
        noteArea(form, 'mistake', '我誤會的地方', '當初為什麼會選錯？'),
        noteArea(form, 'concept', '正確觀念', '正確的規定、理由或口訣'),
        noteArea(form, 'keypoint', '本題考點', '例如：民法第 168 條 共同代理'),
        noteArea(form, 'note', '補充'),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '標籤'), tags),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '出處／題號'), source),
      ),
    ),
    h('details', { class: 'fold', open: Boolean(hasOptNotes) },
      h('summary', null, '各選項的對錯與筆記', h('span', { class: 'hint' }, '選填')),
      h('div', { class: 'body' }, optNotesHost),
    ),
    h('div', { class: 'stack', style: { marginTop: '20px' } },
      h('button', { class: 'btn btn-primary btn-block btn-lg', onclick: () => save(false) }, icon('check'), '儲存'),
      editId ? null : h('button', { class: 'btn btn-block', onclick: () => save(true) }, '儲存並新增下一題'),
    ),
  );
  drawOptions();

  // ---- 動作

  function smartPaste() {
    openSheet((close) => {
      const ta = h('textarea', {
        class: 'textarea', rows: 8, autofocus: true,
        placeholder: '把整題貼在這裡，例如：\n下列敘述，何者正確？(A)…(B)…(C)…(D)…\n\n若有「答案：C」也會自動設定',
      });
      const apply = () => {
        const parsed = parseQuestionText(ta.value);
        if (!parsed.options.length) { toast('找不到 (A)(B)(C)(D) 選項標記，已只填入題目', 'bad'); }
        form.stem = parsed.stem;
        stem.value = parsed.stem;
        stem.dispatchEvent(new Event('input'));
        if (parsed.options.length) {
          form.options = parsed.options.map((o) => ({ key: o.key, text: o.text, mark: '', mistake: '', concept: '', note: '' }));
          form.answer = parsed.answer && form.options.some((o) => o.key === parsed.answer) ? parsed.answer : '';
        }
        if (parsed.source && !form.source) { form.source = parsed.source; source.value = parsed.source; }
        touch();
        drawOptions();
        close();
        toast(parsed.options.length ? `已拆出 ${parsed.options.length} 個選項${form.answer ? `，答案 ${form.answer}` : '，請點選正確答案'}` : '已填入題目');
      };
      const ocrInfo = h('div', { class: 'small muted' });
      const ocrInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
      ocrInput.addEventListener('change', async () => {
        const file = ocrInput.files[0];
        ocrInput.value = '';
        if (!file) return;
        try {
          const { recognizeImages, releaseOcr } = await import('../ocr.js');
          const text = await recognizeImages([file], (p) => {
            ocrInfo.textContent = `${p.label}${p.progress != null ? ` ${Math.round(p.progress * 100)}%` : '…'}`;
          });
          releaseOcr();
          ta.value = [ta.value.trim(), text].filter(Boolean).join('\n');
          ocrInfo.textContent = text ? '辨識完成，請檢查文字後按「拆解」' : '沒有辨識到文字，請拍清楚一點再試';
        } catch (err) {
          ocrInfo.textContent = '';
          showError(err);
        }
      });
      return h('div', null,
        h('h3', null, '貼上整題'),
        h('p', { class: 'msg small' }, '支援 (A)/(B)、（A）、A. 等選項格式。也可以拍照，用文字辨識（OCR）把題目轉成文字。'),
        ta,
        h('div', { class: 'row-flex', style: { marginTop: '8px' } },
          h('label', { class: 'btn btn-sm' }, icon('camera'), '拍照辨識文字', ocrInput), ocrInfo),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => close() }, '取消'),
          h('button', { class: 'btn btn-primary', onclick: apply }, '拆解'),
        ),
      );
    });
  }

  async function save(andNew) {
    const filled = form.options.filter((o) => o.text.trim());
    if (!form.subjectId) { toast('請先選擇或新增科目', 'bad'); subjectSelect.focus(); return; }
    if (!form.stem.trim()) { toast('請輸入題目內容', 'bad'); stem.focus(); return; }
    if (filled.length < 2) { toast('至少需要 2 個選項', 'bad'); return; }
    if (!form.answer || !filled.some((o) => o.key === form.answer)) {
      const ok = await confirmDialog({ title: '還沒設定正確答案', message: '沒有答案的題目會先放在「需確認」，不會出現在練習中。仍要儲存嗎？', ok: '仍要儲存' });
      if (!ok) return;
    }
    const body = { ...form, subjectId: form.subjectId };
    saveBtn.disabled = true;
    try {
      const saved = editId ? await api.put(`/api/questions/${editId}`, body) : await api.post('/api/questions', body);
      dirty = false;
      invalidateSubjects();
      localStorage.setItem('fc.lastSubject', String(form.subjectId));
      if (andNew) {
        toast('已儲存，繼續新增下一題', 'ok');
        navigate(`#/new?subject=${form.subjectId}&t=${Date.now()}`, { replace: true });
      } else {
        toast('已儲存', 'ok');
        if (editId) goBack(`#/q/${saved.id}`);
        else navigate(`#/q/${saved.id}`, { replace: true });
      }
    } catch (err) {
      showError(err);
    } finally {
      saveBtn.disabled = false;
    }
  }

  return () => window.removeEventListener('beforeunload', beforeUnload);
}

// ------------------------------------------------------------ 解析貼上的題目

const toHalf = (c) => (/[Ａ-Ｈａ-ｈ１-８]/.test(c) ? String.fromCharCode(c.charCodeAt(0) - 0xfee0) : c);

export function parseQuestionText(raw) {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  let answer = '';
  const ans = text.match(/(?:答案|正解|解答|Ans(?:wer)?)\s*[:：]?\s*[(（]?\s*([A-Ha-hＡ-Ｈ])\s*[)）]?/);
  if (ans) {
    answer = toHalf(ans[1]).toUpperCase();
    text = (text.slice(0, ans.index) + text.slice(ans.index + ans[0].length)).trim();
  }

  const patterns = [
    /[(（]\s*([A-Ha-hＡ-Ｈ])\s*[)）]/g,
    /(?:^|\n)\s*([A-HＡ-Ｈ])\s*[.．、:：]\s*/g,
    /[(（]\s*([1-8１-８])\s*[)）]/g,
  ];
  let seq = [];
  for (const re of patterns) {
    const found = [];
    let expect = 0;
    for (const m of text.matchAll(re)) {
      let k = toHalf(m[1]).toUpperCase();
      if (/[1-8]/.test(k)) k = LETTERS[Number(k) - 1];
      if (k === LETTERS[expect]) { found.push(m); expect += 1; }
    }
    if (found.length >= 2) { seq = found; break; }
  }

  let source = '';
  const takeNumber = (s) => {
    const m = s.match(/^\s*(\d{1,3})\s*[.、．]?\s+|^\s*(\d{1,3})\s*[.、．]\s*/);
    if (m) { source = `第 ${m[1] || m[2]} 題`; return s.slice(m[0].length); }
    return s;
  };

  if (seq.length < 2) return { stem: cleanInline(takeNumber(text)), options: [], answer, source };
  const stemText = cleanInline(takeNumber(text.slice(0, seq[0].index)));
  const options = seq.map((m, i) => ({
    key: LETTERS[i],
    text: cleanInline(text.slice(m.index + m[0].length, i + 1 < seq.length ? seq[i + 1].index : undefined)),
  }));
  return { stem: stemText, options, answer, source };
}

// 與後端 importer.stem_is_negative 相同的規則
const INTERROG = /何者|何種|何項|何人|何時|何處|哪|為何|如何|若干|多少|幾/;
const NEG_STEM = /錯誤|不正確|有誤|不符|不合|不得|不可|不能|不應|不須|不需|無須|毋須|不必|不屬|非屬|非為|何者非|為非|無效|不生|不包括|不包含|不適用|不構成|不成立|無法|不是|不予/;

export function stemIsNegative(stem) {
  const sentences = (stem || '').split('。').filter((s) => s.trim());
  const last = sentences.length ? sentences[sentences.length - 1] : (stem || '');
  const m = last.match(INTERROG);
  let tail = last;
  if (m) {
    const start = Math.max(...['，', ',', '；', ';', '：', ':'].map((c) => last.lastIndexOf(c, m.index))) + 1;
    tail = last.slice(start);
  }
  return NEG_STEM.test(tail);
}
