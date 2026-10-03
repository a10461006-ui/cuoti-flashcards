// 考古題（歷屆試題）解析：PDF／Word／Excel／純文字 → 題目與答案（與 server/exam_parser.py 相同規則）
// 題號切分用「最長遞增鏈」：注意事項裡的「1.本試題…」或題目中剛好在行首的數字不會誤切。
import { cleanInline, cleanNote, halfwidth } from './textutil.js';
import { readXlsx } from './xlsx.js';
import { unzip } from './zip.js';

// ---------------------------------------------------------------- 檔案 → 文字

export async function extractText(blob, filename = '') {
  const name = filename.toLowerCase();
  const buffer = await blob.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, 8));
  const starts = (...sig) => sig.every((b, i) => head[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return pdfText(buffer);
  if (starts(0x50, 0x4b)) return zipText(buffer);
  if (name.endsWith('.doc') || starts(0xd0, 0xcf, 0x11, 0xe0)) {
    throw new Error('不支援舊版 Word（.doc），請另存成 .docx 或 PDF 再上傳');
  }
  if (isImageFile(blob, filename)) {
    throw new Error('照片或圖片請用「拍照／圖片辨識」讀取文字');
  }
  return { text: decodeText(buffer), warnings: [], figures: [] };
}

export function isImageFile(blob, filename = '') {
  return /^image\//.test(blob.type || '') || /\.(jpe?g|png|heic|heif|webp|bmp|gif)$/i.test(filename);
}

function decodeText(buffer) {
  const b = new Uint8Array(buffer);
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
    return new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(buffer);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    try { return new TextDecoder('big5').decode(buffer); } catch { return new TextDecoder().decode(buffer); }
  }
}

async function zipText(buffer) {
  const zip = await unzip(buffer);
  if (zip.has('word/document.xml')) {
    let xml = await zip.text('word/document.xml');
    xml = xml.replace(/<w:tab\/>|<\/w:tc>/g, '\t').replace(/<w:br[^>]*\/>|<\/w:p>|<\/w:tr>/g, '\n');
    const text = xml.replace(/<[^>]+>/g, '');
    const div = document.createElement('textarea');
    div.innerHTML = text; // 還原 &amp; 等字元（textarea 不會執行任何內容）
    return { text: div.value, warnings: [], figures: [] };
  }
  if (zip.has('xl/workbook.xml')) {
    const sheets = await readXlsx(buffer);
    const lines = [];
    for (const s of sheets) for (const row of s.rows) if (row && row.some((c) => String(c).trim())) lines.push(row.join('\t'));
    return { text: lines.join('\n'), warnings: [], figures: [] };
  }
  throw new Error('無法讀取這個檔案，請上傳 PDF、Word（.docx）或文字檔');
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    const base = new URL('../../vendor/pdfjs/', import.meta.url);
    // 原檔名是 .mjs，改成 .js 是為了讓任何網站主機都用正確的檔案類型提供
    pdfjsPromise = import(new URL('pdf.min.js', base).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', base).href;
      return { lib, cmaps: new URL('cmaps/', base).href, wasm: new URL('wasm/', base).href };
    });
  }
  return pdfjsPromise;
}

/**
 * 依座標把文字片段組回一行一行（同一列的表格儲存格會在同一行）。
 * 回傳每一行的文字與在頁面上的位置（左上角為原點，單位是 PDF 點）。
 */
function pageLines(items, vp) {
  const parts = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height || 10, s: it.str }));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of parts) {
    const line = lines.find((l) => Math.abs(l.y - p.y) <= Math.max(2, Math.min(l.h, p.h) * 0.5));
    if (line) line.items.push(p);
    else lines.push({ y: p.y, h: p.h, items: [p] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    for (const it of l.items) {
      if (end !== null && it.x - end > it.h * 0.25) out += ' ';
      out += it.s;
      end = it.x + it.w;
    }
    const [x0, base] = vp.convertToViewportPoint(l.items[0].x, l.y);
    const [x1] = vp.convertToViewportPoint(end, l.y);
    return { text: out, top: base - l.h, bottom: base, x0: Math.min(x0, x1), x1: Math.max(x0, x1) };
  });
}

// ---------------------------------------------------------------- PDF 圖片

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const IDENTITY = [1, 0, 0, 1, 0, 0];

/** 找出頁面上每張圖片的位置（左上角為原點），把上下相連的圖片（試題常把一張圖切成好幾條）合併成一張 */
async function figureBoxes(page, lib, vp) {
  const { OPS } = lib;
  const { fnArray, argsArray } = await page.getOperatorList();
  const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup].filter((x) => x != null));
  let ctm = IDENTITY;
  const stack = [];
  const boxes = [];
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || IDENTITY;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || IDENTITY;
    else if (images.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => vp.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      if (box.x1 - box.x0 >= 4 && box.y1 - box.y0 >= 2) boxes.push(box);
    }
  }
  // 合併重疊或上下左右緊鄰（6 點以內）的圖片
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i += 1) {
      for (let j = i + 1; j < boxes.length && !merged; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > -6 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > -6) {
          boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          boxes.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  const pageArea = vp.width * vp.height;
  const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
  return boxes
    .map((b) => ({ x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(vp.width, b.x1), y1: Math.min(vp.height, b.y1) }))
    // 太小的（裝飾線、圖示）和幾乎整頁的（掃描檔、背景）都不算題目附圖
    .filter((b) => b.x1 - b.x0 >= 24 && b.y1 - b.y0 >= 16 && area(b) >= 900 && area(b) < pageArea * 0.6)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

const FIG_SCALE = 2;
const FIG_MAX_WIDTH = 1400;

/** 把頁面畫出來，裁切每張圖，轉成 JPEG（data URL） */
async function renderFigures(page, boxes) {
  const vp = page.getViewport({ scale: FIG_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise; // print：不等畫面更新，App 在背景也會繼續
  const out = boxes.map((b) => {
    const pad = 3;
    const sx = Math.max(0, Math.floor((b.x0 - pad) * FIG_SCALE));
    const sy = Math.max(0, Math.floor((b.y0 - pad) * FIG_SCALE));
    const sw = Math.min(canvas.width - sx, Math.ceil((b.x1 - b.x0 + pad * 2) * FIG_SCALE));
    const sh = Math.min(canvas.height - sy, Math.ceil((b.y1 - b.y0 + pad * 2) * FIG_SCALE));
    const k = Math.min(1, FIG_MAX_WIDTH / sw);
    const crop = document.createElement('canvas');
    crop.width = Math.round(sw * k);
    crop.height = Math.round(sh * k);
    crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    const src = crop.toDataURL('image/jpeg', 0.85);
    crop.width = 0;
    return { src, w: Math.round(sw * k), h: Math.round(sh * k) };
  });
  canvas.width = 0; // 釋放記憶體（iOS 對畫布總量有限制）
  return out;
}

/** 把圖片記號 [圖N] 放進文字：放在圖片中線之後的第一行前面；位在圖片裡的文字（圖上的標籤）移除 */
function placeFigures(lines, boxes, firstId) {
  const inside = (ln, b) => {
    const cy = (ln.top + ln.bottom) / 2;
    return cy > b.y0 && cy < b.y1 && ln.x0 >= b.x0 - 4 && ln.x1 <= b.x1 + 4;
  };
  const kept = lines.filter((ln) => !boxes.some((b) => inside(ln, b)));
  const out = [];
  let k = 0;
  for (const ln of kept) {
    while (k < boxes.length && (boxes[k].y0 + boxes[k].y1) / 2 < (ln.top + ln.bottom) / 2) {
      out.push(`[圖${firstId + k}]`);
      k += 1;
    }
    out.push(ln.text);
  }
  for (; k < boxes.length; k += 1) out.push(`[圖${firstId + k}]`);
  return out;
}

const MAX_FIGURES = 80;

async function openPdf(buffer) {
  const { lib, cmaps, wasm } = await loadPdfjs();
  // wasmUrl：JPEG 2000、JBIG2 圖片的解碼器（考選部試題的照片常是 JPEG 2000）
  const task = lib.getDocument({ data: new Uint8Array(buffer), cMapUrl: cmaps, cMapPacked: true, wasmUrl: wasm, isEvalSupported: false, disableFontFace: true });
  try {
    return { lib, task, doc: await task.promise };
  } catch (err) {
    task.destroy?.();
    if (err?.name === 'PasswordException') throw new Error('這個 PDF 有密碼保護，無法讀取');
    throw new Error('無法開啟這個 PDF 檔');
  }
}

async function pdfText(buffer) {
  const { lib, task, doc } = await openPdf(buffer);
  const pages = [];
  const figures = [];
  let figureError = false;
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const lines = pageLines((await page.getTextContent()).items, vp);
      let boxes = [];
      if (figures.length < MAX_FIGURES) {
        try {
          boxes = (await figureBoxes(page, lib, vp)).slice(0, MAX_FIGURES - figures.length);
          if (boxes.length) {
            const crops = await renderFigures(page, boxes);
            crops.forEach((f) => figures.push({ ...f, id: figures.length + 1, page: i }));
          }
        } catch {
          boxes = [];
          figureError = true;
        }
      }
      const firstId = figures.length - boxes.length + 1;
      pages.push((boxes.length ? placeFigures(lines, boxes, firstId) : lines.map((l) => l.text)).join('\n'));
    }
  } finally {
    // pdf.js 新版由 loadingTask 負責釋放資源
    await (task.destroy ? task.destroy() : doc.destroy?.());
  }
  const text = pages.join('\n');
  const warnings = [];
  const scanned = text.replace(/\[圖\d+\]|\s/g, '').length < 30 * Math.max(1, pages.length);
  if (scanned) warnings.push('這份 PDF 幾乎沒有可擷取的文字，可能是掃描檔。可以按「用 OCR 辨識這份 PDF」改用文字辨識。');
  if (figureError) warnings.push('有些圖片無法擷取，可以在題目的編輯頁自行加入圖片。');
  return { text, warnings, figures: scanned ? [] : figures, scanned };
}

/** 掃描版 PDF：一頁一頁畫成圖片交給 OCR（每頁處理完才畫下一頁，避免佔用太多記憶體） */
export async function renderPdfPages(blob, onPage, { maxPages = 40, width = 2000 } = {}) {
  const { task, doc } = await openPdf(await blob.arrayBuffer());
  try {
    const total = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= total; i += 1) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(4, width / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise; // print：不等畫面更新，App 在背景也會繼續
      await onPage(canvas, i, total);
      canvas.width = 0;
    }
    return { pages: total, truncated: doc.numPages > maxPages };
  } finally {
    await (task.destroy ? task.destroy() : doc.destroy?.());
  }
}

// ---------------------------------------------------------------- 試卷資訊

export function detectMeta(text, filename = '') {
  const head = halfwidth(text.slice(0, 3000));
  const meta = { year: '', exam: '', subject: '', category: '', title: '' };
  let m = head.match(/(\d{2,3})\s*年/);
  if (m) meta.year = m[1];
  m = head.match(/考試名稱\s*[:：]\s*([^\n]+)/);
  let exam = m ? m[1] : (head.match(/^[^\n]*考試(?!時間)[^\n]*$/m) || [''])[0];
  exam = exam.trim().replace(/^\d{2,3}\s*年(度)?/, '').replace(/試題\s*$/, '');
  for (const noise of ['公務人員特種考試', '專門職業及技術人員', '公務人員']) exam = exam.split(noise).join('');
  meta.exam = exam.trim().slice(0, 40);
  m = head.match(/類\s*科(?:名稱)?\s*[:：]\s*([^\n]+)/);
  if (m) meta.category = m[1].split(/\s{2,}|科\s*目/)[0].trim().slice(0, 30);
  // 考選部「專技高考」的考試名稱是一長串合辦的類科，改用「第幾次＋類科」比較好認
  if (meta.category && (/[、,，]/.test(meta.exam) || meta.exam.length > 20)) {
    const round = (head.match(/第\s*([一二三四五六])\s*次/) || [])[1];
    meta.exam = [round ? `第${round}次` : '', meta.category].filter(Boolean).join(' ');
  }
  m = head.match(/科\s*目(?:名稱)?\s*[:：]\s*([^\n]+)/);
  if (m) {
    const subject = m[1].replace(/[（(]\s*(?:包括|含).*$/, '').split(/\s{2,}|考試時間|座號|代號/)[0];
    meta.subject = subject.trim().slice(0, 40);
  }
  meta.title = [meta.year ? `${meta.year}年` : '', meta.exam, meta.subject].filter(Boolean).join(' ').trim()
    || filename.replace(/\.[^.]+$/, '');
  return meta;
}

// ---------------------------------------------------------------- 題目切分

const PAGE_NOISE = /代\s*號\s*[:：]|頁\s*次\s*[:：]|^\s*座\s*號|背面尚有|請接背面|請翻[頁面]|^\s*[-－–—]?\s*\d+\s*[-－–—]\s*\d*\s*[-－–—]?\s*$|^\s*第\s*\d+\s*頁|共\s*\d+\s*頁|全\s*[一二三四五六七八九十\d]+\s*[頁張]/;
const CAND = /^\s*(?:[（(]\s*([A-E])\s*[)）]\s*(\d{1,3})\s*[.、．:：](?!\d)|(\d{1,3})(?:\s*[.、．:：](?!\d)|\s+))\s*(?=\S)/;
const UNIT_AFTER = /^(?:個月|年內|年以|年後|年度|日內|日起|日前|日後|天|萬|億|元|%|％|歲|倍|小時|分鐘)/;
// 題號後面直接接數字，例如「41.40 歲的張先生」：和小數「3.5 公分」分不出來，只當作備選（分數較低）
const CAND_DIGIT = /^\s*(\d{1,3})[.．](?=\d)/;
const DIGIT_PENALTY = 0.3;
const LONE_NUM = /^\s*(\d{1,3})\s*[.、．]?\s*$/;
const FIG_MARK = /\[圖\s*(\d{1,3})\]/g;
// 題組：「…結果如圖所示。請依序回答下列 3 題。」
const GROUP = /請\s*(?:依序|依照順序|依下列|依上述)?\s*(?:回答|作答)\s*(?:下列|以下|後續|接下來)?\s*(?:的)?\s*(\d{1,2}|[二三四五六七八九])\s*題[。：:，,]?/;
const CN_NUM = { 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const FOLLOW_UP = /^\s*(?:承上題?|接續上題|延續上題)[，,、：:\s]*/;
const MAX_GAP = 5;
const INLINE_ANS = /(?:[【[]\s*(?:答案|正解|解答)\s*[】\]]|(?:答案|正解|解答|答|Ans(?:wer)?)\s*[:：])\s*[（(]?\s*([A-E])(?![A-Za-z])/i;
const EXPLAIN = /[【[]\s*(?:解析|詳解|解說|說明)\s*[】\]]|(?:解析|詳解|解說)\s*[:：]/;
const PASSAGE = /[^。\n]{0,30}?回答\s*第\s*(\d{1,3})\s*題?\s*(?:至|到|~|～|-|－)\s*第?\s*(\d{1,3})\s*題/;
const OPT_PAREN = /[（(]\s*([A-H])\s*[)）]/g;
const OPT_LINE = /(?:^|\n)\s*([A-H])\s*[.．、:：]\s*/g;

function cleanLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter((ln) => !PAGE_NOISE.test(halfwidth(ln)));
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (LONE_NUM.test(halfwidth(lines[i])) && i + 1 < lines.length && lines[i + 1].trim() && !CAND.test(halfwidth(lines[i + 1]))) {
      out.push(`${lines[i].trim().replace(/[.、．]+$/, '')} ${lines[i + 1].trim()}`);
      i += 1;
    } else {
      out.push(lines[i]);
    }
  }
  return out;
}

function questionChain(lines) {
  const cands = [];
  lines.forEach((line, idx) => {
    const hw = halfwidth(line);
    const m = hw.match(CAND);
    if (m) {
      const num = Number(m[2] || m[3]);
      if (!num || UNIT_AFTER.test(hw.slice(m[0].length).trim())) return;
      cands.push({ idx, num, answer: (m[1] || '').toUpperCase(), col: m[0].length, penalty: 0 });
      return;
    }
    const d = hw.match(CAND_DIGIT);
    if (d && Number(d[1])) cands.push({ idx, num: Number(d[1]), answer: '', col: d[0].length, penalty: DIGIT_PENALTY });
  });
  if (!cands.length) return [];
  const best = new Array(cands.length).fill(1);
  const prev = new Array(cands.length).fill(-1);
  const seenByNum = new Map();
  cands.forEach((c, i) => {
    let top = 1 - c.penalty;
    let topPrev = -1;
    for (let gap = 1; gap <= MAX_GAP; gap += 1) {
      for (const j of seenByNum.get(c.num - gap) || []) {
        const score = best[j] + 1 - c.penalty - 0.01 * (gap - 1);
        if (score >= top) { top = score; topPrev = j; } // 同分時取比較後面的那一行
      }
    }
    best[i] = top;
    prev[i] = topPrev;
    if (!seenByNum.has(c.num)) seenByNum.set(c.num, []);
    seenByNum.get(c.num).push(i);
  });
  let end = 0;
  for (let i = 1; i < cands.length; i += 1) if (best[i] >= best[end]) end = i;
  const chain = [];
  while (end !== -1) { chain.push(cands[end]); end = prev[end]; }
  return chain.reverse();
}

function splitOptions(text) {
  const hw = halfwidth(text);
  for (const pattern of [OPT_PAREN, OPT_LINE]) {
    const marks = [...hw.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length, key: m[1] }));
    let best = [];
    let fullRuns = 0;
    marks.forEach((mk, i) => {
      if (mk.key !== 'A') return;
      const run = [mk];
      let expect = 'B';
      for (const next of marks.slice(i + 1)) {
        if (next.key === expect) { run.push(next); expect = String.fromCharCode(expect.charCodeAt(0) + 1); }
      }
      if (run.length >= 4) fullRuns += 1;
      if (run.length >= best.length) best = run; // 同長度取後面的（題幹中引用 (A) 的情況）
    });
    if (best.length >= 2) {
      const stem = text.slice(0, best[0].start);
      const options = best.map((mk, i) => [mk.key, text.slice(mk.end, i + 1 < best.length ? best[i + 1].start : undefined)]);
      return { stem, options, merged: fullRuns > 1 };
    }
  }
  return { stem: text, options: [], merged: false };
}

export function parseQuestions(text) {
  const lines = cleanLines(text);
  const chain = questionChain(lines);
  const warnings = [];
  const passages = [];

  const findPassage = (fragment) => {
    const m = halfwidth(fragment).match(PASSAGE);
    if (!m) return [fragment, null];
    const intro = fragment.slice(m.index, m.index + m[0].length);
    const body = fragment.slice(m.index + m[0].length).replace(/^[：:，,\s]+/, '');
    return [fragment.slice(0, m.index), { from: Number(m[1]), to: Number(m[2]), text: `${cleanInline(intro)}\n${cleanInline(body)}`.trim() }];
  };

  const preamble = (chain.length ? lines.slice(0, chain[0].idx) : lines).join('\n');
  if (chain.length) {
    const [, p] = findPassage(preamble);
    if (p) passages.push(p);
  }

  const questions = chain.map((c, k) => {
    const end = k + 1 < chain.length ? chain[k + 1].idx : lines.length;
    let block = [lines[c.idx].slice(c.col), ...lines.slice(c.idx + 1, end)].join('\n');
    const figures = [...block.matchAll(FIG_MARK)].map((x) => Number(x[1]));
    block = block.replace(FIG_MARK, '');
    let concept = '';
    let m = halfwidth(block).match(EXPLAIN);
    if (m) {
      concept = cleanNote(block.slice(m.index + m[0].length));
      block = block.slice(0, m.index);
    }
    let answer = c.answer;
    m = halfwidth(block).match(INLINE_ANS);
    if (m) {
      answer = answer || m[1].toUpperCase();
      block = block.slice(0, m.index) + block.slice(m.index + m[0].length);
    }
    let { stem, options, merged } = splitOptions(block);
    if (options.length) {
      const last = options[options.length - 1];
      const [rest, p] = findPassage(last[1]);
      last[1] = rest;
      if (p) passages.push(p);
    } else {
      const [rest, p] = findPassage(stem);
      stem = rest;
      if (p) passages.push(p);
    }
    if (merged) warnings.push(`第 ${c.num} 題的內容可能混入了下一題，請檢查題號是否被辨識`);
    return {
      number: c.num,
      stem: cleanInline(stem),
      options: options.map(([key, t]) => ({ key, text: cleanInline(t) })),
      inlineAnswer: answer,
      concept,
      figures,
    };
  });

  // 題組（醫事類）：「…如圖所示。請依序回答下列 3 題。此檢查項目為何？」→ 前半段與圖片給這 3 題共用
  for (const q of questions) {
    const m = halfwidth(q.stem).match(GROUP);
    if (!m) continue;
    const count = CN_NUM[m[1]] || Number(m[1]);
    const intro = q.stem.slice(0, m.index + m[0].length).trim();
    const rest = q.stem.slice(m.index + m[0].length).replace(/^[\s：:，,。]+/, '');
    if (count < 2 || !intro || !rest) continue;
    passages.push({ from: q.number, to: q.number + count - 1, text: intro, figures: q.figures });
    q.stem = rest;
  }
  for (const p of passages) {
    for (const q of questions) {
      if (q.number < p.from || q.number > p.to) continue;
      q.stem = `【題組】${p.text}\n\n${q.stem}`;
      if (p.figures?.length) q.figures = [...new Set([...p.figures, ...q.figures])];
    }
  }
  // 承上題：把上一題的題目（和圖片）帶進來，隨機練習時才看得懂
  const byNumber = new Map(questions.map((q) => [q.number, q]));
  for (const q of questions) {
    const prev = byNumber.get(q.number - 1);
    if (!prev || !FOLLOW_UP.test(q.stem) || q.stem.startsWith('【')) continue;
    q.stem = `【承上題】${prev.stem}\n\n${q.stem}`;
    if (!q.figures.length) q.figures = [...prev.figures];
  }
  const missing = [];
  for (let i = 1; i < questions.length; i += 1) {
    for (let n = questions[i - 1].number + 1; n < questions[i].number; n += 1) missing.push(n);
  }
  if (missing.length) {
    const shown = missing.slice(0, 10).join('、') + (missing.length > 10 ? '…' : '');
    warnings.push(`沒有辨識到第 ${shown} 題，可能和前一題黏在一起。可以在擷取的文字中把題號放到新的一行後重新解析。`);
  }
  return { questions, warnings, preamble };
}

// ---------------------------------------------------------------- 答案

const CELL = '[A-E](?:\\s*(?:或|、|,|/|&)\\s*[A-E])*|[#*×]';
const letters = (s) => String(s).match(/[A-E]/g) || [];
/** 等同 Python 的 (?<![...])：檢查比對位置前一個字元，但不吃掉它 */
const prevIs = (str, index, re) => index > 0 && re.test(str[index - 1]);

export function parseAnswers(text) {
  const t = halfwidth(text || '').replace(/＃/g, '#').replace(/＊/g, '*');
  let body = t;
  let notesPart = '';
  // 備註欄：優先找「備註：」（開頭說明常有「更正內容詳備註」，不能從那裡切）；沒有冒號才用最後一個「備註」
  const nm = t.match(/備\s*註\s*[:：]/) || [...t.matchAll(/備\s*註/g)].pop();
  if (nm) { body = t.slice(0, nm.index); notesPart = t.slice(nm.index + nm[0].length); }

  let raw = new Map();
  let method = '';
  // 1) 考選部表格：題號列「第1題 第2題…」或「題序／題號 01 02 …」，下一列「答案 C A …」
  if ((/第\s*\d{1,3}\s*題/.test(body) || /題\s*[序號]/.test(body)) && /答\s*案/.test(body)) {
    const queue = [];
    let active = false;
    let numberRow = false;
    const tokenRe = new RegExp(`第\\s*(\\d{1,3})\\s*題|(題\\s*[序號])|(答\\s*案)|(\\d{1,3})|(${CELL})(?![A-Za-z])`, 'g');
    for (const m of body.matchAll(tokenRe)) {
      if (m[1]) { queue.push(Number(m[1])); active = false; numberRow = false; } else if (m[2]) { numberRow = true; active = false; }
      else if (m[3]) { active = true; numberRow = false; }
      else if (m[4]) { if (numberRow) queue.push(Number(m[4])); }
      else if (active && queue.length && !prevIs(body, m.index, /[A-Za-z]/)) raw.set(queue.shift(), m[5]);
    }
    if (raw.size) method = 'table';
  }
  // 2) 「1.C 2.A」「1(C)」
  const pairs = new Map();
  for (const m of body.matchAll(/(\d{1,3})\s*[.、:：)）-]?\s*[（(]?\s*([A-E](?:\s*或\s*[A-E])*)\s*[)）]?(?![A-Za-z])/g)) {
    if (prevIs(body, m.index, /[\d.]/)) continue;
    const n = Number(m[1]);
    if (!pairs.has(n)) pairs.set(n, m[2]);
  }
  if (pairs.size > raw.size) { raw = pairs; method = 'pairs'; }
  // 3) 純字母串「CADB…」或「C A D B」
  if (!raw.size && /^[\sA-E,，、.;；|/]*$/.test(body.trim()) && /[A-E]/.test(body)) {
    letters(body).forEach((ch, i) => raw.set(i + 1, ch));
    method = 'sequence';
  }

  const answers = new Map();
  const multi = new Map();
  const free = new Set();
  const flagged = new Set();
  for (const [num, token] of raw) {
    const ls = letters(token);
    if (ls.length === 1) answers.set(num, ls[0]);
    else if (ls.length > 1) multi.set(num, ls);
    else flagged.add(num); // 「#」：答案有更正，見備註
  }
  for (const m of notesPart.matchAll(/第\s*(\d{1,3})\s*題([^第]*)/g)) {
    const num = Number(m[1]);
    const desc = m[2];
    const fix = desc.match(/更正為\s*[（(]?\s*([A-E](?:\s*(?:或|、|,)\s*[（(]?\s*[A-E])*)/);
    if (fix) {
      const ls = letters(fix[1]);
      if (ls.length === 1) { answers.set(num, ls[0]); multi.delete(num); } else multi.set(num, ls);
      flagged.delete(num);
    } else if (/一律給分|送分/.test(desc)) {
      free.add(num);
      flagged.delete(num);
    } else if (desc.includes('給分')) {
      const found = [...`${desc} `.matchAll(/[（(]?\s*([A-E])\s*[)）]?\s*(?=或|、|,|者|均)/g)].map((x) => x[1]);
      if (found.length) {
        const all = [...new Set([...found, ...(desc.includes('或') ? letters(desc.slice(desc.lastIndexOf('或'))) : [])])].sort();
        if (all.length > 1) { multi.set(num, all); flagged.delete(num); }
      }
    }
  }
  return { answers, multi, free, flagged, method, count: raw.size };
}

// ---------------------------------------------------------------- 合併

/** figures：extractText 擷取的圖片 [{ id, src, w, h }]，依文字中的 [圖N] 記號放到題目裡 */
export function buildPaper(questionsText, answersText = '', filename = '', figures = []) {
  const meta = detectMeta(questionsText, filename);
  const parsed = parseQuestions(questionsText);
  const figureById = new Map((figures || []).map((f) => [Number(f.id), f]));
  const key = answersText.trim() ? parseAnswers(answersText)
    : { answers: new Map(), multi: new Map(), free: new Set(), flagged: new Set(), method: '', count: 0 };
  const warnings = [...parsed.warnings];

  const out = parsed.questions.map((q) => {
    const n = q.number;
    const keys = q.options.map((o) => o.key);
    let answer = q.inlineAnswer || key.answers.get(n) || '';
    let status = 'ok';
    let note = '';
    if (!q.stem) { status = 'incomplete'; note = '缺少題目內容'; } else if (keys.length < 2) {
      status = 'incomplete'; note = '無法辨識選項 (A)(B)(C)(D)，請手動補齊';
    } else if (key.free.has(n)) {
      status = 'review'; note = '官方公告本題一律給分，請自行決定要練習的答案'; answer = '';
    } else if (key.multi.has(n)) {
      const ls = key.multi.get(n);
      status = 'review'; note = `官方答案：${ls.join('、')} 均給分，請選一個作為練習答案`; answer = ls[0];
    } else if (key.flagged.has(n)) {
      status = 'review'; note = '官方答案有更正，請參考答案檔的備註後確認';
    } else if (!answer) {
      status = 'review'; note = '沒有對應的答案，請點選正確答案';
    } else if (!keys.includes(answer)) {
      status = 'review'; note = `答案「${answer}」不在選項中，請確認`; answer = '';
    }
    const { figures: ids, ...rest } = q;
    const images = ids.map((id) => figureById.get(id)).filter(Boolean).map((f) => ({ src: f.src, w: f.w, h: f.h }));
    if (status === 'ok' && !images.length && /如圖|下圖|圖示|圖中|附圖|如下圖|上圖/.test(q.stem)) {
      status = 'review';
      note = '題目提到圖片，但沒有擷取到，請到編輯頁加入圖片';
    }
    return { ...rest, images, answer: keys.includes(answer) ? answer : '', status, statusNote: note };
  });

  if (answersText.trim() && !key.count) {
    warnings.push('答案檔沒有辨識到任何答案，請確認格式（例如：1.C 2.A，或考選部的答案 PDF）');
  } else if (key.count) {
    const nums = new Set(out.map((q) => q.number));
    const extra = [...key.answers.keys()].filter((n) => !nums.has(n));
    if (out.length && extra.length && extra.length > nums.size * 0.2) {
      warnings.push(`答案檔有 ${key.count} 題，但只解析到 ${out.length} 題題目，請確認試題與答案是否為同一份`);
    }
  }
  if (!answersText.trim() && out.length && !parsed.questions.some((q) => q.inlineAnswer)) {
    warnings.push('還沒有提供答案：可以上傳答案檔或貼上答案，或之後再一題一題確認');
  }
  const count = (s) => out.filter((q) => q.status === s).length;
  return {
    meta,
    questions: out,
    warnings,
    stats: {
      total: out.length, ok: count('ok'), review: count('review'), incomplete: count('incomplete'),
      answers: key.count, answerMethod: key.method, withImages: out.filter((q) => q.images.length).length,
    },
  };
}
