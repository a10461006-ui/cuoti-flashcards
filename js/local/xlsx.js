// 讀寫 .xlsx：只取儲存格文字（不需要公式、格式）
import { unzip, zipStore } from './zip.js';

const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');
const byTag = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const ATTR_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellText(c, shared) {
  const type = c.getAttribute('t');
  const v = byTag(c, 'v')[0]?.textContent ?? '';
  if (type === 's') return shared[Number(v)] ?? '';
  if (type === 'inlineStr') return byTag(c, 't').map((t) => t.textContent).join('');
  if (type === 'b') return v === '1' ? 'True' : 'False';
  if (type === 'str' || type === 'e') return v;
  // 數字：整數去掉 .0（和 Python 版一致）
  if (/^-?\d+\.0+$/.test(v)) return v.replace(/\.0+$/, '');
  return v;
}

/** 回傳 [{ name, rows: string[][] }]，rows 的索引 = Excel 列號 - 1（空白列補空陣列） */
export async function readXlsx(buffer) {
  const zip = await unzip(buffer);
  if (!zip.has('xl/workbook.xml')) throw new Error('這不是 Excel（.xlsx）檔案');
  const wb = parseXml(await zip.text('xl/workbook.xml'));
  const rels = parseXml((await zip.text('xl/_rels/workbook.xml.rels')) || '<Relationships/>');
  const targets = new Map(byTag(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));

  const shared = [];
  const sst = await zip.text('xl/sharedStrings.xml');
  if (sst) {
    for (const si of byTag(parseXml(sst), 'si')) {
      // 只取一般文字，略過日文注音 <rPh>
      shared.push(byTag(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));
    }
  }

  const sheets = [];
  for (const s of byTag(wb, 'sheet')) {
    const rid = s.getAttributeNS(ATTR_R, 'id') || s.getAttribute('r:id');
    let target = targets.get(rid) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = await zip.text(target);
    if (!xml) continue;
    const rows = [];
    for (const row of byTag(parseXml(xml), 'row')) {
      const r = Number(row.getAttribute('r')) || rows.length + 1;
      const cells = [];
      for (const c of byTag(row, 'c')) {
        const ref = c.getAttribute('r');
        const idx = ref ? colIndex(ref) : cells.length;
        while (cells.length < idx) cells.push('');
        cells[idx] = cellText(c, shared);
      }
      while (rows.length < r - 1) rows.push([]);
      rows[r - 1] = cells;
    }
    sheets.push({ name: s.getAttribute('name') || `工作表${sheets.length + 1}`, rows });
  }
  return sheets;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 產生只有一個工作表、全部是文字的 .xlsx */
export function writeXlsx(sheetName, rows, widths = []) {
  const colName = (i) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v === '' ? '' :
    `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`)).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const files = [
    { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${sheetRows}</sheetData></worksheet>` },
  ];
  return zipStore(files);
}
