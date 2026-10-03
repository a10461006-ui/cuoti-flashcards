// 文字清理與重複判斷（規則與 server/importer.py 相同）
// 注意：不使用 lookbehind 正規表示式，iOS 16.3 以前的 Safari 不支援，整個 App 會載入失敗。

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])[ \\t\\u3000]+(?=[${CJK}])`, 'g');
// 英文斷行換成空白
const ASCII_BREAK = /([A-Za-z0-9,.;:!?)\]'"])[ \t]*\n[ \t]*(?=[A-Za-z([\]'"])/g;
// PDF 複製產生的句中硬換行：前後都是文字（不是句號、清單編號）才接起來
const INLINE_BREAK = new RegExp(
  `([${CJK}0-9A-Za-z，、；「『（【])[ \\t]*\\n[ \\t]*(?=[${CJK}A-Za-z，、；」』）】]|[0-9](?![0-9]*[、.．]))`, 'g');

export function newlines(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n');
}

/** 題幹、選項：去掉中文字間多餘空白與 PDF 斷行 */
export function cleanInline(s) {
  return newlines(s)
    .replace(SPACE_BETWEEN_CJK, '$1')
    .replace(ASCII_BREAK, '$1 ')
    .replace(INLINE_BREAK, '$1')
    .trim();
}

/** 筆記：保留換行，只清掉尾端空白 */
export function cleanNote(s) {
  return newlines(s).split('\n').map((line) => line.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** 全形英數字轉半形（長度不變，索引可以對照原文） */
export function halfwidth(s) {
  return String(s ?? '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 判斷重複題用：題幹＋選項（NFKC 統一全半形、去掉所有空白） */
export function contentHash(stem, optionTexts) {
  const norm = (t) => String(t ?? '').normalize('NFKC').replace(/\s+/g, '');
  const raw = [norm(stem), ...optionTexts.map(norm)].join('\u001f');
  return cyrb53(raw, 1).toString(16).padStart(14, '0') + cyrb53(raw, 2).toString(16).padStart(14, '0');
}

export function nowIso() {
  return new Date().toISOString();
}
