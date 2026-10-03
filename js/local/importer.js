// 解析「訂正本」Excel（與 server/importer.py 相同規則）
//   題幹-3 | 題目 | (備註) | 我誤會的地方 | 正確觀念 | 本題考點
//   選項A  | 內容 | ✅正確／❌錯誤／可／不可… | 我誤會的地方 | 正確觀念 | 補充
import { cleanInline, cleanNote, contentHash } from './textutil.js';
import { readXlsx, writeXlsx } from './xlsx.js';

// ---------------------------------------------------------------- 答案推定

const EXPLICIT = /正解|答案|解答/;
const NEG_MARK = /[❌✗✘×xX]|錯|不|無|否|非|沒/;
const POS_MARK = /[✅✔✓○◯oO]|正確|對|可|需|要|是|屬|生效|有效|得|合法|符合|成立|適用/;
const INTERROG = /何者|何種|何項|何人|何時|何處|哪|為何|如何|若干|多少|幾/;
const NEG_STEM = /錯誤|不正確|有誤|不符|不合|不得|不可|不能|不應|不須|不需|無須|毋須|不必|不屬|非屬|非為|何者非|為非|無效|不生|不包括|不包含|不適用|不構成|不成立|無法|不是|不予/;

/** true＝肯定（正確/可/需要…），false＝否定（錯誤/不可/無須…），null＝未標記 */
export function markPolarity(mark) {
  let core = String(mark || '').trim().split(/[（(]/)[0];
  core = core.replace(/正解|答案|解答/g, '').trim();
  if (!core) return null;
  if (NEG_MARK.test(core)) return false;
  if (POS_MARK.test(core)) return true;
  return null;
}

/** 題目是否在問「錯誤／不得／無須…」的那一個（只看最後一句的提問部分） */
export function stemIsNegative(stem) {
  const sentences = String(stem || '').split('。').filter((s) => s.trim());
  const last = sentences.length ? sentences[sentences.length - 1] : String(stem || '');
  const m = last.match(INTERROG);
  let tail = last;
  if (m) {
    const start = Math.max(...['，', ',', '；', ';', '：', ':'].map((c) => last.lastIndexOf(c, m.index))) + 1;
    tail = last.slice(start);
  }
  return NEG_STEM.test(tail);
}

/** 回傳 [答案代號, 狀態 ok/review, 說明] */
export function inferAnswer(stem, options) {
  const keys = options.map((o) => o.key);
  const pols = options.map((o) => markPolarity(o.mark));
  const neg = stemIsNegative(stem);
  const target = !neg;
  const asked = neg ? '何者錯誤／不得' : '何者正確';
  const n = options.length;

  const explicit = options.filter((o) => EXPLICIT.test(o.mark || '')).map((o) => o.key);
  if (explicit.length === 1) return [explicit[0], 'ok', ''];

  const marked = pols.filter((p) => p !== null);
  // 全部都有標記、且只有一個跟其他不同 → 那個就是答案（不論標記習慣）
  if (n >= 3 && marked.length === n) {
    const nPos = pols.filter((p) => p === true).length;
    if (nPos === 1 || n - nPos === 1) {
      const odd = nPos === 1;
      const key = keys[pols.indexOf(odd)];
      if (odd === target) return [key, 'ok', ''];
      return [key, 'review', `選項標記與題目問法（${asked}）不一致，系統建議答案為 ${key}，請確認`];
    }
  }
  const matches = keys.filter((_, i) => pols[i] === target);
  if (matches.length === 1) return [matches[0], 'ok', ''];
  if (!matches.length) {
    const blanks = keys.filter((_, i) => pols[i] === null);
    if (blanks.length === 1 && marked.length === n - 1) return [blanks[0], 'ok', ''];
  }
  if (matches.length > 1) return ['', 'review', `有 ${matches.length} 個選項符合題目問法（${matches.join('、')}），請指定正確答案`];
  if (!marked.length) return ['', 'review', '選項都沒有標記正確與否，請指定正確答案'];
  return ['', 'review', '無法從選項標記判斷答案，請指定正確答案'];
}

// ---------------------------------------------------------------- 解析

const LABEL_STEM = /^\s*題幹/;
const LABEL_OPT = /^\s*選項\s*([A-Za-zＡ-Ｚａ-ｚ])?/;
const HEADER_ALIASES = {
  label: ['題幹/選項', '題幹／選項', '題號', '類型'],
  content: ['內容', '題目內容'],
  mark: ['實際正確與否', '正確與否', '判斷', '對錯'],
  mistake: ['我誤會的地方', '誤會的地方', '錯誤原因', '我的錯誤'],
  concept: ['正確法律概念', '正確觀念', '正確概念', '解析', '詳解'],
  keypoint: ['本題考點分類', '本題考點', '考點分類', '考點'],
};
const DEFAULT_COLS = { label: 0, content: 1, mark: 2, mistake: 3, concept: 4, keypoint: 5 };

function detectColumns(rows) {
  for (const row of rows.slice(0, 5)) {
    const cols = {};
    (row || []).forEach((v, i) => {
      const text = String(v || '').trim();
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (!(field in cols) && aliases.includes(text)) cols[field] = i;
      }
    });
    if ('content' in cols && Object.keys(cols).length >= 3) return { ...DEFAULT_COLS, ...cols };
  }
  return { ...DEFAULT_COLS };
}

const fullWidthUpper = (ch) => (/[Ａ-Ｚａ-ｚ]/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) - 0xfee0) : ch).toUpperCase();

function parseSheet(rows, sheetName) {
  const cols = detectColumns(rows);
  const mapped = new Set(Object.values(cols));
  const get = (row, f) => String(row[cols[f]] ?? '');
  const extras = (row) => row.map((v) => String(v ?? '')).filter((v, i) => !mapped.has(i) && v.trim());

  const questions = [];
  let cur = null;
  rows.forEach((row = [], i) => {
    const label = get(row, 'label').trim();
    if (HEADER_ALIASES.label.includes(label)) return;
    if (LABEL_STEM.test(label)) {
      const stemExtra = [get(row, 'mark'), ...extras(row)];
      cur = {
        source: label.replace(/\s+/g, ' ').trim(),
        stem: cleanInline(get(row, 'content')),
        keypoint: cleanNote(get(row, 'keypoint')),
        mistake: cleanNote(get(row, 'mistake')),
        concept: cleanNote(get(row, 'concept')),
        note: cleanNote(stemExtra.filter((v) => v.trim()).join('\n\n')),
        options: [],
        row: i + 1,
        sheet: sheetName,
      };
      questions.push(cur);
      return;
    }
    const m = cur && label.match(LABEL_OPT);
    if (m) {
      const letter = m[1] ? fullWidthUpper(m[1]) : String.fromCharCode(65 + cur.options.length);
      cur.options.push({
        key: letter,
        text: cleanInline(get(row, 'content')),
        mark: get(row, 'mark').trim(),
        mistake: cleanNote(get(row, 'mistake')),
        concept: cleanNote(get(row, 'concept')),
        note: cleanNote([get(row, 'keypoint'), ...extras(row)].join('\n\n')),
      });
    }
  });
  return questions;
}

function finalize(q) {
  q.options = q.options.filter((o) => o.text || o.mark || o.mistake || o.concept);
  const hasNotes = q.keypoint || q.mistake || q.concept || q.note;
  if (!q.stem && !q.options.length && !hasNotes) return null;
  if (!q.options.some((o) => o.text)) return null; // 書籤或筆記，不是題目

  const seen = new Set();
  q.options.forEach((o, i) => {
    if (!o.key || seen.has(o.key)) o.key = String.fromCharCode(65 + i);
    seen.add(o.key);
  });

  let [answer, status, note] = inferAnswer(q.stem, q.options);
  if (!q.stem) {
    status = 'incomplete';
    note = '缺少題幹，請補上題目內容';
  } else if (q.options.filter((o) => o.text).length < 2) {
    status = 'incomplete';
    note = `只記錄了 ${q.options.length} 個選項，請補齊其他選項`;
  }
  Object.assign(q, { answer, status, statusNote: note, contentHash: contentHash(q.stem, q.options.map((o) => o.text)) });
  return q;
}

/** 解析整個活頁簿：只處理 A 欄有「題幹」標籤的工作表 */
export async function parseWorkbook(buffer, filename = '') {
  const sheets = await readXlsx(buffer);
  const used = [];
  let raw = [];
  for (const s of sheets) {
    if (!s.rows.some((row) => row && LABEL_STEM.test(String(row[0] || '')))) continue;
    used.push(s.name);
    raw = raw.concat(parseSheet(s.rows, s.name));
  }
  const questions = [];
  const seen = new Set();
  let skippedBlank = 0;
  let duplicates = 0;
  for (const item of raw) {
    const q = finalize(item);
    if (!q) { skippedBlank += 1; continue; }
    if (seen.has(q.contentHash)) { duplicates += 1; continue; }
    seen.add(q.contentHash);
    questions.push(q);
  }
  const count = (s) => questions.filter((q) => q.status === s).length;
  return {
    filename,
    subject: filename.replace(/\.[^.]+$/, '').trim(),
    sheets: used,
    questions,
    stats: {
      total: questions.length, ok: count('ok'), review: count('review'), incomplete: count('incomplete'),
      skipped_blank: skippedBlank, duplicates_in_file: duplicates,
    },
  };
}

export function buildTemplate() {
  return writeXlsx('題目練習與訂正', [
    ['題幹/選項', '內容', '實際正確與否', '我誤會的地方', '正確觀念', '本題考點'],
    ['題幹-1', '下列敘述，何者正確？', '', '（題目層級的誤會，可留白）', '（題目層級的正確觀念）', '（本題考點）'],
    ['選項A', '選項 A 的內容', '❌錯誤', '我以為…', '正確應為…', ''],
    ['選項B', '選項 B 的內容', '✅正確', '', '', ''],
    ['選項C', '選項 C 的內容', '❌錯誤', '', '', ''],
    ['選項D', '選項 D 的內容', '❌錯誤', '', '', ''],
  ], [12, 60, 14, 30, 40, 20]);
}
