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
  if (starts(0xff, 0xd8, 0xff) || starts(0x89, 0x50, 0x4e, 0x47) || /\.(jpe?g|png|heic|webp)$/.test(name)) {
    throw new Error('目前還不支援照片／圖片辨識（OCR），請上傳文字版 PDF、Word，或直接貼上文字');
  }
  return { text: decodeText(buffer), warnings: [] };
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
    return { text: div.value, warnings: [] };
  }
  if (zip.has('xl/workbook.xml')) {
    const sheets = await readXlsx(buffer);
    const lines = [];
    for (const s of sheets) for (const row of s.rows) if (row && row.some((c) => String(c).trim())) lines.push(row.join('\t'));
    return { text: lines.join('\n'), warnings: [] };
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
      return { lib, cmaps: new URL('cmaps/', base).href };
    });
  }
  return pdfjsPromise;
}

/** 依座標把文字片段組回一行一行（同一列的表格儲存格會在同一行） */
function pageLines(items) {
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
    return out;
  }).join('\n');
}

async function pdfText(buffer) {
  const { lib, cmaps } = await loadPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(buffer), cMapUrl: cmaps, cMapPacked: true, isEvalSupported: false, disableFontFace: true });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    task.destroy?.();
    if (err?.name === 'PasswordException') throw new Error('這個 PDF 有密碼保護，無法讀取');
    throw new Error('無法開啟這個 PDF 檔');
  }
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      pages.push(pageLines((await page.getTextContent()).items));
    }
  } finally {
    // pdf.js 新版由 loadingTask 負責釋放資源
    await (task.destroy ? task.destroy() : doc.destroy?.());
  }
  const text = pages.join('\n');
  const warnings = [];
  if (text.replace(/\s/g, '').length < 30 * Math.max(1, pages.length)) {
    warnings.push('這份 PDF 幾乎沒有可擷取的文字，可能是掃描的圖片檔。請改用文字版 PDF，或把題目文字複製貼上。');
  }
  return { text, warnings };
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
const LONE_NUM = /^\s*(\d{1,3})\s*[.、．]?\s*$/;
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
    if (!m) return;
    const num = Number(m[2] || m[3]);
    if (!num || UNIT_AFTER.test(hw.slice(m[0].length).trim())) return;
    cands.push({ idx, num, answer: (m[1] || '').toUpperCase(), col: m[0].length });
  });
  if (!cands.length) return [];
  const best = new Array(cands.length).fill(1);
  const prev = new Array(cands.length).fill(-1);
  const seenByNum = new Map();
  cands.forEach((c, i) => {
    let top = 1;
    let topPrev = -1;
    for (let gap = 1; gap <= MAX_GAP; gap += 1) {
      for (const j of seenByNum.get(c.num - gap) || []) {
        const score = best[j] + 1 - 0.01 * (gap - 1);
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
    };
  });

  for (const p of passages) {
    for (const q of questions) if (q.number >= p.from && q.number <= p.to) q.stem = `【題組】${p.text}\n\n${q.stem}`;
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
  const nm = t.match(/備\s*註/);
  if (nm) { body = t.slice(0, nm.index); notesPart = t.slice(nm.index + nm[0].length); }

  let raw = new Map();
  let method = '';
  // 1) 考選部表格：題號列 第1題 第2題…，答案列 C A …
  if (/第\s*\d{1,3}\s*題/.test(body) && /答\s*案/.test(body)) {
    const queue = [];
    let active = false;
    const tokenRe = new RegExp(`第\\s*(\\d{1,3})\\s*題|(答\\s*案)|(${CELL})(?![A-Za-z])`, 'g');
    for (const m of body.matchAll(tokenRe)) {
      if (m[1]) { queue.push(Number(m[1])); active = false; } else if (m[2]) active = true;
      else if (active && queue.length && !prevIs(body, m.index, /[A-Za-z]/)) raw.set(queue.shift(), m[3]);
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

export function buildPaper(questionsText, answersText = '', filename = '') {
  const meta = detectMeta(questionsText, filename);
  const parsed = parseQuestions(questionsText);
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
    return { ...q, answer: keys.includes(answer) ? answer : '', status, statusNote: note };
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
    stats: { total: out.length, ok: count('ok'), review: count('review'), incomplete: count('incomplete'), answers: key.count, answerMethod: key.method },
  };
}
