// 文字辨識（OCR）：用 Tesseract 在這台裝置上辨識照片或掃描檔的文字，照片不會上傳到任何地方。
// 第一次使用會下載辨識程式與繁體中文資料（約 5.6 MB），之後會存在裝置上。
import { loadBitmap } from './ui.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url);
// WebAssembly SIMD 偵測（與 wasm-feature-detect 相同的測試程式）：支援就用比較快的版本
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const MAX_SIDE = 2400;
const MIN_SIDE = 1400;

let workerPromise = null;
let report = null;

const STATUS = {
  'loading tesseract core': '載入辨識程式',
  'initializing tesseract': '準備辨識程式',
  'loading language traineddata': '下載中文辨識資料（第一次比較久）',
  'loading language traineddata (from cache)': '載入辨識資料',
  'initializing api': '準備辨識',
  'recognizing text': '辨識文字',
};

function supportsSimd() {
  try { return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_TEST); } catch { return false; }
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (typeof WebAssembly !== 'object') throw new Error('這個瀏覽器不支援文字辨識，請更新系統或改用 Chrome、Safari');
      const mod = await import(new URL('tesseract.esm.min.js', BASE).href);
      const { createWorker } = mod.default || mod;
      const worker = await createWorker('chi_tra', 1, {
        workerPath: new URL('worker.min.js', BASE).href,
        corePath: new URL(`core/tesseract-core-${supportsSimd() ? 'simd-' : ''}lstm.wasm.js`, BASE).href,
        langPath: new URL('lang', BASE).href,
        workerBlobURL: false,
        gzip: true,
        logger: (m) => report?.(m),
        errorHandler: () => {},
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      const msg = String(err?.message || err);
      throw new Error(/fetch|network|load/i.test(msg) ? '無法下載辨識資料，請確認網路連線後再試一次' : `文字辨識無法啟動：${msg}`);
    });
  }
  return workerPromise;
}

/** 辨識結束後釋放記憶體（辨識程式佔用約 100 MB） */
export async function releaseOcr() {
  const p = workerPromise;
  workerPromise = null;
  if (p) { try { await (await p).terminate(); } catch { /* 忽略 */ } }
}

/** 轉成灰階、調整到適合辨識的大小（太小看不清楚、太大很慢） */
function prepare(source) {
  const w0 = source.width || source.naturalWidth;
  const h0 = source.height || source.naturalHeight;
  const long = Math.max(w0, h0);
  const k = long > MAX_SIDE ? MAX_SIDE / long : long < MIN_SIDE ? Math.min(2, MIN_SIDE / long) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * k);
  canvas.height = Math.round(h0 * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  // 灰階＋拉開明暗（照片常偏灰），文字比較清楚
  let lo = 255;
  let hi = 0;
  const gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    gray[j] = g;
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
    const v = ((gray[j] - lo) * 255) / span;
    px[i] = v; px[i + 1] = v; px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef';
const CJK_SPACE = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g');

/**
 * 整理辨識結果：去掉中文字之間多出來的空白、空行；
 * 行首的選項代號、題號常被辨識成「B,.」「A,」「12 ,」，統一改成「B.」「12.」（後面接數字的不動，例如「41.40 歲」）
 */
export function tidyOcrText(text) {
  return String(text || '').split('\n')
    .map((line) => line.replace(CJK_SPACE, '$1').replace(/[ \t]{2,}/g, ' ').trim()
      .replace(/^([A-H])\s*[,，.．、:：;；]+\s*/, '$1.')
      .replace(/^(\d{1,3})\s*[,，.．、]+\s*(?=\D)/, '$1.'))
    .filter(Boolean)
    .join('\n');
}

/**
 * 辨識一組圖片（File、canvas 或 Image），依序合併成一份文字。
 * onProgress({ index, total, label, progress })：progress 為 0～1
 */
export async function recognizeImages(sources, onProgress = () => {}) {
  const total = sources.length;
  let index = 0;
  report = (m) => {
    const label = STATUS[m.status] || '準備辨識';
    onProgress({ index, total, label, progress: m.status === 'recognizing text' ? m.progress : null });
  };
  try {
    onProgress({ index, total, label: '載入辨識程式', progress: null });
    const worker = await getWorker();
    const pages = [];
    for (const src of sources) {
      index += 1;
      onProgress({ index, total, label: '辨識文字', progress: 0 });
      const bitmap = src instanceof Blob ? await loadBitmap(src) : src;
      const canvas = prepare(bitmap);
      if (src instanceof Blob) bitmap.close?.();
      const { data } = await worker.recognize(canvas);
      canvas.width = 0;
      pages.push(tidyOcrText(data.text));
    }
    return pages.join('\n');
  } finally {
    report = null;
  }
}

/** 掃描版 PDF：一頁一頁畫出來再辨識 */
export async function recognizePdf(blob, onProgress = () => {}) {
  const { renderPdfPages } = await import('./local/exam.js');
  const pages = [];
  let shownTotal = 0;
  onProgress({ index: 0, total: 0, label: '載入辨識程式', progress: null });
  report = (m) => onProgress({ index: pages.length + 1, total: shownTotal, label: STATUS[m.status] || '準備辨識', progress: m.status === 'recognizing text' ? m.progress : null });
  try {
    const worker = await getWorker();
    const info = await renderPdfPages(blob, async (canvas, i, total) => {
      shownTotal = total;
      onProgress({ index: i, total, label: '辨識文字', progress: 0 });
      const prepared = prepare(canvas);
      const { data } = await worker.recognize(prepared);
      prepared.width = 0;
      pages.push(tidyOcrText(data.text));
    });
    return { text: pages.join('\n'), truncated: info.truncated };
  } finally {
    report = null;
  }
}
