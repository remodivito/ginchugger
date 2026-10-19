// HTML for the README charts, drawn from data.json. render.mjs screenshots each one in a light and a dark theme.
// Icons: Lucide (ISC). Provider logos: LobeHub icons (MIT); the logos are their owners' trademarks, used to identify models.

export const THEMES = {
  light: { card: '#ffffff', line: '#E4E7E3', grid: '#F0F2EF', track: '#F3F5F2', ink: '#16181A', muted: '#5C636A', accent: '#2F5A3C', anthropic: '#B8583A', deepseek: '#4D6BFE', zai: '#22262B', mistral: '#D9952E', heatLo: '#EEF4EF', heatHi: '#1F4A2C', heatInk: ['#16181A', '#FFFFFF'], ring: '#B8583A' },
  dark: { card: '#0F141A', line: '#262C33', grid: '#1A2027', track: '#161C23', ink: '#E8EAED', muted: '#9AA3AD', accent: '#86BC95', anthropic: '#E08A68', deepseek: '#7895F2', zai: '#C9CED6', mistral: '#E9B25A', heatLo: '#18221C', heatHi: '#8FD1A1', heatInk: ['#E8EAED', '#0D1117'], ring: '#E9B25A' },
};

const ICON = {
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  scale: '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  listChecks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  penLine: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  bookCheck: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="m9 9.5 2 2 4-4"/>',
  fileDiff: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
};
export const icon = (name, size, color = 'var(--accent)') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const LOGO = {
  anthropic: '<path fill="var(--anthropic)" fill-rule="evenodd" d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/>',
  zai: '<path fill="var(--zai)" fill-rule="evenodd" d="M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z"/>',
  mistral: '<path d="M3.428 3.4h3.429v3.428H3.428V3.4zm13.714 0h3.43v3.428h-3.43V3.4z" fill="gold"/><path d="M3.428 6.828h6.857v3.429H3.429V6.828zm10.286 0h6.857v3.429h-6.857V6.828z" fill="#FFAF00"/><path d="M3.428 10.258h17.144v3.428H3.428v-3.428z" fill="#FF8205"/><path d="M3.428 13.686h3.429v3.428H3.428v-3.428zm6.858 0h3.429v3.428h-3.429v-3.428zm6.856 0h3.43v3.428h-3.43v-3.428z" fill="#FA500F"/><path d="M0 17.114h10.286v3.429H0v-3.429zm13.714 0H24v3.429H13.714v-3.429z" fill="#E10500"/>',
  deepseek: '<path fill="var(--deepseek)" d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"/>',
};
export const logo = (provider, size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="flex:none">${LOGO[provider]}</svg>`;
const logoAt = (provider, cx, cy, size) => `<svg x="${(cx - size / 2).toFixed(1)}" y="${(cy - size / 2).toFixed(1)}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${LOGO[provider]}</svg>`;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = x => `${Math.round(x)}%`;
// Wilson score interval, 95%.
export function wilson(k, n, z = 1.96) {
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [100 * (c - h), 100 * (c + h)];
}

export function page(theme, fontsCss, body) {
  const t = THEMES[theme];
  const vars = Object.entries(t).filter(([, v]) => typeof v === 'string').map(([k, v]) => `--${k}:${v}`).join(';');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontsCss}
html,body{margin:0;background:transparent}
body{${vars};font-family:Geist,system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
.card{width:1200px;box-sizing:border-box;border:1px solid var(--line);border-radius:16px;background:var(--card);padding:52px 56px 34px;display:flex;flex-direction:column;gap:40px}
.head{display:flex;justify-content:space-between;align-items:center}
.title{display:flex;align-items:center;gap:16px}
h2{margin:0;font-family:Newsreader,Georgia,serif;font-weight:400;font-size:44px;line-height:1.1;letter-spacing:-0.01em}
.mark{font-size:17px;color:var(--muted);display:flex;align-items:center;gap:7px}
.mark b{font-family:Newsreader,Georgia,serif;font-weight:400;font-size:24px;color:var(--accent)}
.foot{font-size:16px;line-height:1.5;color:var(--muted)}
</style></head><body>${body}</body></html>`;
}
const head = (iconName, title) => `<div class="head"><div class="title">${icon(iconName, 34)}<h2>${esc(title)}</h2></div><div class="mark"><b>¶</b>GinBench</div></div>`;

// A scatter of setups: point = ring with the provider's logo, line = interval.
function scatter({ title, iconName, xLabel, yLabel, x, y, points, foot }) {
  const L = 92, R = 1064, T = 26, B = 440, W = 1088, H = 540;
  const lin = (v, [a, b], lo, hi) => lo + (v - a) / (b - a) * (hi - lo);
  const X = v => x.log ? lin(Math.log10(v), x.domain.map(Math.log10), L, R) : lin(v, x.domain, L, R);
  const Y = v => lin(v, y.domain, B, T);
  const g = [];
  for (const [v] of y.ticks) g.push(`<line x1="${L}" y1="${Y(v)}" x2="${R}" y2="${Y(v)}" stroke="var(--grid)"/>`);
  g.push(`<line x1="${L}" y1="${B + 12}" x2="${R}" y2="${B + 12}" stroke="var(--line)" stroke-width="1.5"/>`);
  for (const [v, l] of y.ticks) g.push(`<text x="${L - 16}" y="${Y(v) + 6}" text-anchor="end" fill="var(--muted)" font-size="17">${l}</text>`);
  for (const [v, l] of x.ticks) g.push(`<text x="${X(v)}" y="${B + 42}" text-anchor="middle" fill="var(--muted)" font-size="17">${l}</text>`);
  g.push(`<text x="${(L + R) / 2}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="17">${esc(xLabel)}</text>`);
  g.push(`<text transform="translate(16 ${(T + B) / 2}) rotate(-90)" text-anchor="middle" fill="var(--muted)" font-size="17">${esc(yLabel)}</text>`);
  const marks = [], labels = [];
  for (const p of points) {
    const s = p.setup, color = `var(--${s.provider})`;
    const off = p.x > x.domain[1];
    const cx = (off ? R : X(p.x)) + (p.dx ?? 0), cy = Y(p.y);
    if (p.lo != null) marks.push(`<line x1="${cx}" y1="${Y(p.lo)}" x2="${cx}" y2="${Y(p.hi)}" stroke="${color}" stroke-width="2"/>`);
    const dash = s.kind === 'variant' ? ' stroke-dasharray="4 3"' : s.kind === 'plain' ? ' stroke-dasharray="1.5 3.5" stroke-linecap="round"' : '';
    marks.push(`<circle cx="${cx}" cy="${cy}" r="13" fill="var(--card)" stroke="${color}" stroke-width="2"${dash}/>${logoAt(s.provider, cx, cy, 15)}`);
    const side = off ? 'left' : p.side ?? 'right';
    const lx = side === 'right' ? cx + 24 : cx - 24;
    const tag = off ? ` · ${p.offLabel} →` : s.tag ? ` ${s.tag}` : '';
    labels.push(`<text x="${lx}" y="${cy + 7 + (p.dy ?? 0)}" text-anchor="${side === 'right' ? 'start' : 'end'}" font-size="19" font-weight="500" fill="var(--ink)">${esc(s.name)}<tspan font-weight="400" fill="var(--muted)">${esc(tag)}</tspan></text>`);
  }
  return `<div class="card" id="chart">${head(iconName, title)}
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="overflow:visible;font-family:Geist,system-ui,sans-serif">${g.join('')}${marks.join('')}${labels.join('')}</svg>
<div class="foot">${foot}</div></div>`;
}

const byId = data => Object.fromEntries(data.setups.map(s => [s.id, s]));

export function fullyRightByCost(data) {
  const side = { 'deepseek-v4-flash-product': 'left', 'glm-5.3-flash-product': 'left', 'opus-5.5-plain': 'left' };
  const dy = { 'glm-5.3-flash-product': 30 };
  return scatter({
    title: 'Fully right, by cost', iconName: 'circleCheck',
    xLabel: 'Cost per review, log scale ↓', yLabel: 'Agreements fully right ↑',
    x: { log: true, domain: [0.003, 0.5], ticks: [[0.005, '$0.005'], [0.01, '$0.01'], [0.03, '$0.03'], [0.1, '$0.10'], [0.3, '$0.30']] },
    y: { domain: [0, 100], ticks: [[0, '0%'], [25, '25%'], [50, '50%'], [75, '75%'], [100, '100%']] },
    points: data.setups.map(s => { const [lo, hi] = wilson(...s.allPass); return { setup: s, x: s.costUsd, y: 100 * s.allPass[0] / s.allPass[1], lo, hi, side: side[s.id], dy: dy[s.id], dx: s.kind === 'variant' ? 16 : 0 }; }),
    foot: `Frozen layer A · ${data.agreements} agreements · lines are 95% intervals · open-model costs are estimates · dashed ring: declared variant with a 131k output limit`,
  });
}

export function caughtVsFalseAlarms(data) {
  const side = { 'opus-5.5-product': 'left' };
  const n = data.deviations;
  return scatter({
    title: 'Caught, against false alarms', iconName: 'scale',
    xLabel: 'False alarms per agreement ↓', yLabel: 'Planted deviations caught ↑',
    x: { domain: [-0.01, 0.2], ticks: [[0, '0'], [0.05, '0.05'], [0.1, '0.10'], [0.15, '0.15'], [0.2, '0.20']] },
    y: { domain: [0, 104], ticks: [[0, '0%'], [25, '25%'], [50, '50%'], [75, '75%'], [100, '100%']] },
    points: data.setups.map(s => ({ setup: s, x: s.falseAlarms, y: 100 * (n - s.misses) / n, lo: 100 - s.missUpper, hi: 100 * (n - s.misses) / n, side: side[s.id], offLabel: `${s.falseAlarms.toFixed(2)}, off scale` })),
    foot: `Frozen layer A · ${n} planted deviations · lines run to the one-sided 95% lower bound · dashed ring: declared variant with a 131k output limit`,
  });
}

const fills = s => {
  const c = `var(--${s.provider})`;
  if (s.kind === 'plain') return `background:repeating-linear-gradient(135deg,${c} 0 2px,transparent 2px 6px);border:1.5px solid ${c}`;
  if (s.kind === 'variant') return `background:transparent;border:1.5px dashed ${c}`;
  return `background:${c}`;
};
const nameCell = (s, size = 20) => `<div style="display:flex;align-items:center;gap:12px">${logo(s.provider, size)}<span style="font-size:20px;font-weight:500;white-space:nowrap">${esc(s.name)}<span style="color:var(--muted);font-weight:400">${s.tag ? ' ' + esc(s.tag) : ''}</span></span></div>`;

export function scorecard(data) {
  const n = data.deviations;
  const cols = [
    ['crosshair', 'Caught ↑', s => ({ w: 100 * (n - s.misses) / n, lb: 100 - s.missUpper, label: `${n - s.misses} of ${n}` })],
    ['bell', 'False alarms ↓', s => ({ w: Math.min(100, s.falseAlarms / 0.2 * 100), label: s.falseAlarms > 0.2 ? `${s.falseAlarms.toFixed(2)} ›` : s.falseAlarms.toFixed(2) })],
    ['quote', 'Invented quotes ↓', s => ({ w: Math.min(100, s.invented[0] / s.invented[1] / 0.2 * 100), label: String(s.invented[0]) })],
    ['circleCheck', 'Fully right ↑', s => ({ w: 100 * s.allPass[0] / s.allPass[1], label: pct(100 * s.allPass[0] / s.allPass[1]) })],
  ];
  const headRow = `<div></div>` + cols.map(([ic, t]) => `<div style="display:flex;align-items:center;gap:9px;padding-bottom:16px;font-size:17px;font-weight:600;white-space:nowrap">${icon(ic, 20)}${t}</div>`).join('');
  const rows = data.setups.map(s => `<div style="height:66px;display:flex;align-items:center;border-top:1px solid var(--grid)">${nameCell(s)}</div>` + cols.map(([, , f]) => {
    const v = f(s);
    const lb = v.lb != null ? `<div style="position:absolute;top:22px;height:2px;left:${v.lb}%;width:${v.w - v.lb}%;background:var(--${s.provider});opacity:.85"></div>` : '';
    return `<div style="height:66px;display:flex;align-items:center;gap:12px;border-top:1px solid var(--grid)"><div style="position:relative;flex:none;width:100px;height:16px;background:var(--track);border-radius:3px"><div style="position:absolute;left:0;top:0;bottom:0;width:${v.w}%;min-width:2px;box-sizing:border-box;border-radius:3px;${fills(s)}"></div>${lb}</div><div style="font-size:17px;font-variant-numeric:tabular-nums;white-space:nowrap">${v.label}</div></div>`;
  }).join('')).join('');
  return `<div class="card" id="chart">${head('listChecks', 'Scorecard')}
<div style="display:grid;grid-template-columns:244px repeat(4,minmax(0,1fr));column-gap:20px">${headRow}${rows}</div>
<div class="foot">Frozen layer A · hatched: plain prompt · dashed: declared variant, 131k output limit · line under caught: 95% lower bound · false alarms drawn to 0.20, invented quotes to 20% of reviews</div></div>`;
}

export function costAndTime(data) {
  const card = (iconName, title, rows, max, fmt) => {
    const sorted = [...rows].sort((a, b) => a.v - b.v);
    const bars = sorted.map(({ s, v }) => `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;height:100%"><div style="font-size:17px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap">${fmt(v)}</div><div style="width:44px;height:${Math.max(2, Math.round(v / max * 300))}px;box-sizing:border-box;border-radius:4px 4px 0 0;${fills(s)}"></div></div>`).join('');
    const names = sorted.map(({ s }) => `<div style="display:flex;flex-direction:column;align-items:center;gap:7px;text-align:center">${logo(s.provider, 20)}<div style="font-size:14.5px;line-height:1.3">${esc(s.name)}${s.tag ? `<br><span style="color:var(--muted)">${esc(s.tag)}</span>` : ''}</div></div>`).join('');
    return `<div style="flex:1;border:1px solid var(--line);border-radius:16px;background:var(--card);padding:44px 34px 26px;display:flex;flex-direction:column;gap:30px">
<div class="title">${icon(iconName, 30)}<h2 style="font-size:36px">${title}</h2></div>
<div style="height:350px;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));align-items:end;gap:10px;border-bottom:1px solid var(--line)">${bars}</div>
<div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-top:-14px">${names}</div></div>`;
  };
  const S = data.setups;
  return `<div id="chart" style="width:1200px;display:flex;flex-direction:column;gap:14px">
<div style="display:flex;gap:16px">${card('coins', 'Cost per review ↓', S.map(s => ({ s, v: s.costUsd })), 0.34, v => '$' + (v < 0.1 ? v.toFixed(3) : v.toFixed(2)))}${card('timer', 'Time per review ↓', S.map(s => ({ s, v: s.seconds })), 420, v => `${v} s`)}</div>
<div class="foot" style="padding:0 8px">Medians over 78 reviews · open-model costs are estimates (tokens × Munito's listed prices); Opus costs are the API-equivalent figures Claude Code reports · time includes queueing at the host</div></div>`;
}

export function ownItems(data, theme) {
  const t = THEMES[theme], S = byId(data);
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, k) => `rgb(${hex(a).map((x, i) => Math.round(x + (hex(b)[i] - x) * k)).join(',')})`;
  const authors = data.byAuthor.authors;
  const headRow = `<div></div>` + authors.map(([, l]) => `<div style="font-size:18px;font-weight:600;padding:0 0 10px 6px">${l}</div>`).join('') + `<div style="font-size:18px;font-weight:600;padding:0 0 10px 20px">Advantage on own items</div>`;
  const rows = data.byAuthor.rows.map(r => {
    const s = S[r.id];
    const cells = r.allPass.map((v, i) => {
      const k = Math.max(0, Math.min(1, (v - 0.6) / 0.35));
      const own = authors[i][0] === r.own;
      return `<div style="height:64px;box-sizing:border-box;border-radius:7px;background:${mix(t.heatLo, t.heatHi, k)};color:${t.heatInk[k > 0.5 ? 1 : 0]};${own ? `border:3px solid ${t.ring};` : ''}display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:500;font-variant-numeric:tabular-nums">${pct(100 * v)}</div>`;
    }).join('');
    const adv = r.advantage == null ? `<div style="font-size:19px;color:var(--muted)">—</div>`
      : `<div style="font-size:19px;font-weight:500">${r.verdict === 'detected' ? `+${Math.round(100 * r.advantage)} points` : 'None detected'}</div><div style="font-size:15px;color:var(--muted)">[${r.interval.map(x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(Math.round(100 * x * 10) / 10)).join(', ')}]</div>`;
    return `<div style="height:64px;display:flex;align-items:center">${nameCell(s)}</div>${cells}<div style="height:64px;display:flex;flex-direction:column;justify-content:center;gap:2px;padding-left:20px">${adv}</div>`;
  }).join('');
  return `<div class="card" id="chart">${head('penLine', 'Does a model favour its own items?')}
<div style="display:grid;grid-template-columns:262px repeat(3,minmax(0,1fr)) 290px;gap:7px">${headRow}${rows}</div>
<div class="foot">Agreements fully right, by which model wrote the item · own items outlined · brackets: 95% interval, in points · “none detected” rules out only gaps above about 15–18 points · GLM's figure uses a reduced item set</div></div>`;
}

export function wordmark() {
  return `<div id="chart" style="display:inline-flex;align-items:baseline;gap:16px;padding:8px 12px"><span style="font-family:Newsreader,Georgia,serif;font-size:96px;line-height:1;color:var(--accent)">¶</span><span style="font-family:Newsreader,Georgia,serif;font-size:96px;line-height:1;letter-spacing:-0.02em;color:var(--ink)">GinChugger</span></div>`;
}

export function features(shots) {
  const f = (iconName, title, text, src, pos, size) => `<div style="flex:1;border:1px solid var(--line);border-radius:16px;background:var(--card);overflow:hidden;display:flex;flex-direction:column">
<div style="height:230px;background:url('${src}') ${pos} / ${size} auto no-repeat;border-bottom:1px solid var(--line)"></div>
<div style="padding:24px 26px 28px;display:flex;flex-direction:column;gap:10px"><div style="display:flex;align-items:center;gap:11px;font-size:23px;font-weight:600">${icon(iconName, 25)}${title}</div><div style="font-size:18px;line-height:1.5;color:var(--muted)">${text}</div></div></div>`;
  return `<div id="chart" style="width:1200px;display:flex;gap:18px">
${f('bookCheck', 'Your playbook', 'Preferred position, fallback and hard line for each rule. Every finding quotes the clause it rests on.', shots.playbook, '47% 3%', '200%')}
${f('fileDiff', 'Tracked changes', 'Wording lands in Word under your name, one point at a time. Nothing is applied for you.', shots.review, '40.6% 46%', '200%')}
${f('archive', "Your team's documents", 'One store, built on Paperless-ngx. Reviews cite past deals word for word.', shots.document, '100% 28%', '260%')}</div>`;
}

export function framedShot(src) {
  return `<div id="chart" style="display:inline-block;padding:2px"><img src="${src}" width="1440" height="900" style="display:block;border:1px solid #d1d9e0;border-radius:14px"></div>`;
}
