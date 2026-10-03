import { api } from '../api.js';
import { clear, h, icon, pct, topbar } from '../ui.js';

const DAYS = 30;

export async function render({ root }) {
  const [s, d] = await Promise.all([api.get(`/api/stats?days=${DAYS}`), api.get('/api/dashboard')]);
  const t = s.totals;
  const activeDays = s.daily.filter((x) => x.attempts).length;
  const sum30 = s.daily.reduce((a, x) => a + x.attempts, 0);

  const chartHost = h('div', { class: 'chart' });
  let showTable = false;
  const toggle = h('button', { class: 'btn btn-ghost btn-sm', 'aria-pressed': 'false' }, '表格');
  const drawChart = () => {
    toggle.textContent = showTable ? '圖表' : '表格';
    toggle.setAttribute('aria-pressed', String(showTable));
    clear(chartHost, showTable ? dailyTable(s.daily) : null);
    if (!showTable) requestAnimationFrame(() => columnChart(chartHost, s.daily));
  };
  toggle.addEventListener('click', () => { showTable = !showTable; drawChart(); });

  clear(root,
    topbar({ title: '學習統計' }),
    h('main', { class: 'page' },
      h('div', { class: 'tiles' },
        tile('可練習題數', t.ready, t.questions > t.ready ? `另有 ${t.questions - t.ready} 題待處理` : '全部可練習'),
        tile('已練習', t.practiced, `${pct(t.practiced, t.ready)}% 的題目`),
        tile('整體正確率', t.attempts ? `${pct(t.correct, t.attempts)}%` : '—', `共作答 ${t.attempts} 次`),
        tile('已熟練', t.mastered, '複習間隔 ≥ 21 天'),
      ),

      h('div', { class: 'card', style: { marginTop: '12px' } },
        h('div', { class: 'row-flex', style: { marginBottom: '4px' } },
          h('h2', { class: 'grow', style: { margin: 0 } }, `每日作答題數（近 ${DAYS} 天）`),
          toggle,
        ),
        h('div', { class: 'small muted', style: { marginBottom: '10px' } },
          `共 ${sum30} 題 · 有練習 ${activeDays} 天 · 連續 ${s.streak} 天`),
        chartHost,
      ),

      h('div', { class: 'section-title' }, '各科熟練度'),
      h('div', { class: 'card' },
        d.subjects.length ? d.subjects.map((sub) => subjectMeter(sub)) : h('div', { class: 'muted small' }, '還沒有科目'),
        d.subjects.length ? h('div', { class: 'legend', style: { marginTop: '6px' } },
          h('span', null, h('i', { style: { background: 'var(--meter-strong)' } }), '已熟練'),
          h('span', null, h('i', { style: { background: 'var(--meter-mid)' } }), '學習中'),
          h('span', null, h('i', { style: { background: 'var(--meter-track)', boxShadow: 'inset 0 0 0 1px var(--border-strong)' } }), '未練習'),
        ) : null,
      ),

      h('div', { class: 'section-title' }, '最常答錯的題目'),
      s.hardest.length
        ? h('div', { class: 'list' }, s.hardest.map((q) => h('a', { class: 'qitem', href: `#/q/${q.id}` },
          h('div', { class: 'meta' }, h('span', null, q.subject), q.source ? h('span', null, `· ${q.source}`) : null),
          h('div', { class: 'stem' }, q.stem),
          h('div', { class: 'foot' }, h('span', { class: 'w' }, `答錯 ${q.wrong} 次`), h('span', null, `共作答 ${q.attempts} 次`)),
        )))
        : h('div', { class: 'card empty' }, h('div', { class: 'ill' }, icon('check')), h('p', null, '目前沒有答錯紀錄')),
    ),
  );
  drawChart();

  const onResize = () => { if (!showTable) columnChart(chartHost, s.daily); };
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}

function tile(label, value, desc) {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), h('div', { class: 'd' }, desc));
}

function subjectMeter(sub) {
  const learning = Math.max(0, sub.ready - sub.unseen - sub.mastered);
  const w = (n) => `${sub.ready ? (n / sub.ready) * 100 : 0}%`;
  return h('div', { style: { marginBottom: '14px' } },
    h('div', { class: 'row-flex small', style: { marginBottom: '6px' } },
      h('b', { class: 'grow', style: { fontSize: '15px' } }, sub.name),
      h('span', { class: 'muted' }, `熟練 ${sub.mastered}／${sub.ready}`),
      h('span', { class: 'muted' }, `正確率 ${sub.attempts ? `${pct(sub.correct, sub.attempts)}%` : '—'}`),
    ),
    h('div', { class: 'meter', role: 'img', 'aria-label': `${sub.name}：已熟練 ${sub.mastered}、學習中 ${learning}、未練習 ${sub.unseen}` },
      sub.mastered ? h('i', { class: 'm1', style: { width: w(sub.mastered) } }) : null,
      learning ? h('i', { class: 'm2', style: { width: w(learning) } }) : null,
    ),
  );
}

function dailyTable(daily) {
  return h('table', { class: 'data-table' },
    h('thead', null, h('tr', null, h('th', null, '日期'), h('th', null, '作答'), h('th', null, '答對'), h('th', null, '正確率'))),
    h('tbody', null, [...daily].reverse().map((x) => h('tr', null,
      h('td', null, x.date.slice(5).replace('-', '/')),
      h('td', null, x.attempts),
      h('td', null, x.correct),
      h('td', null, x.attempts ? `${pct(x.correct, x.attempts)}%` : '—'),
    ))),
  );
}

function niceMax(v) {
  if (v <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= v / 1) * pow;
  return Math.ceil(v / (step / 2)) * (step / 2);
}

// 單一系列柱狀圖：細柱、4px 圓角頂端、髮絲格線、點按顯示數值
function columnChart(host, daily) {
  const width = Math.max(260, host.clientWidth || 320);
  const height = 170;
  const pad = { l: 30, r: 6, t: 10, b: 24 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const max = niceMax(Math.max(...daily.map((x) => x.attempts), 1));
  const band = plotW / daily.length;
  const barW = Math.max(3, Math.min(24, band - 2));
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '近 30 天每日作答題數柱狀圖');
  const el = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    svg.append(n);
    return n;
  };

  for (const v of [0, max / 2, max]) {
    el('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' });
    el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, Number.isInteger(v) ? v : v.toFixed(1));
  }
  const labelIdx = [0, Math.floor(daily.length / 2), daily.length - 1];
  for (const i of labelIdx) {
    el('text', { x: pad.l + band * i + band / 2, y: height - 6, 'text-anchor': i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle', class: 'tick' },
      daily[i].date.slice(5).replace('-', '/'));
  }

  const tip = h('div', { class: 'tip', hidden: true });
  daily.forEach((d, i) => {
    const cx = pad.l + band * i + band / 2;
    if (d.attempts) {
      const top = y(d.attempts);
      const bh = pad.t + plotH - top;
      const r = Math.min(4, barW / 2, bh);
      const x0 = cx - barW / 2;
      const base = pad.t + plotH;
      el('path', {
        d: `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${base} Z`,
        fill: 'var(--series-1)',
      });
    }
    // 命中區：整個欄位高度，比柱子大
    const hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: plotH, fill: 'transparent', tabindex: 0 });
    const show = () => {
      tip.hidden = false;
      clear(tip, h('b', null, d.date.slice(5).replace('-', '/')), h('br'),
        `作答 ${d.attempts} 題`, d.attempts ? `，答對 ${d.correct}（${pct(d.correct, d.attempts)}%）` : '');
      const px = (cx / width) * host.clientWidth;
      tip.style.left = `${Math.min(Math.max(px, 70), host.clientWidth - 70)}px`;
      tip.style.top = `${(y(Math.max(d.attempts, 0)) / height) * host.clientHeight}px`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', () => { tip.hidden = true; });
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  clear(host, svg, tip);
}
