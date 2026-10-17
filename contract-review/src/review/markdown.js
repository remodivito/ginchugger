// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's answers as a small, safe Markdown subset (Ask C, 17 Oct 2026; prompts/ask.md asks for it): paragraphs,
// **bold**, bullet and numbered lists, and short headings. Nothing else is interpreted: raw HTML, links, images and code
// stay as the literal characters the model wrote, and every piece of text reaches the page as a React text node, so the
// browser never parses model output as markup. No dependency.
// Citation chips and tables (17 Oct 2026, from Claude for Word): a marker `[¶5]` (this draft's paragraph p5, matching
// an `evidence` item) or `[doc 12]` (store document 12, matching a `sources` item) becomes a small chip that shows the
// passage or opens the document; a marker with nothing to match stays as its literal text. A simple pipe table (header,
// separator, rows; two to four columns) renders as one block per row in the pane and as a <table> where there is room.
import { createElement as h, Fragment } from 'react';

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const MAX_CHARS = 12_000;

// One marker inside brackets: ¶5 (also ¶ 5, ¶p5) or doc 12 (also doc12, Doc 12). Several may share a bracket: [¶5, ¶7].
const ONE = String.raw`(?:¶\s?p?\d{1,5}|doc\s?\d{1,9})`;
const MARKERS = new RegExp(String.raw`\[(${ONE}(?:\s*[,;]\s*${ONE})*)\]`, 'gi');
function toCite(s) {
  const m = /^¶\s?p?(\d+)$/i.exec(s.trim());
  if (m) return { kind: 'para', id: `p${Number(m[1])}`, n: Number(m[1]) };
  return { kind: 'doc', id: Number(/^doc\s?(\d+)$/i.exec(s.trim())[1]) };
}

/** Text split into plain parts and citation markers: [{ text }] | [{ text, cite: { kind: 'para', id, n } | { kind: 'doc', id } }]. */
export function parseCites(text) {
  const out = []; const s = String(text ?? ''); let at = 0, m;
  const re = new RegExp(MARKERS);
  while ((m = re.exec(s))) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    const parts = m[1].split(/\s*[,;]\s*/);
    parts.forEach((p, i) => out.push({ text: parts.length === 1 ? m[0] : `[${p.trim()}]`, cite: toCite(p), ...(i ? { sep: true } : {}) }));
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/**
 * One line's inline parts: [{ text, bold, cite? }]. Only a closed **pair** is bold; anything else is literal text.
 * Citation markers are found inside and outside bold.
 */
export function parseInline(text) {
  const out = []; const s = String(text ?? ''); const re = /\*\*(?=\S)([\s\S]*?\S)\*\*/g; let at = 0, m;
  const push = (t, bold) => { for (const p of parseCites(t)) out.push({ ...p, bold }); };
  while ((m = re.exec(s))) {
    if (m.index > at) push(s.slice(at, m.index), false);
    push(m[1], true); at = m.index + m[0].length;
  }
  if (at < s.length) push(s.slice(at), false);
  return out;
}

// ---- Tables ---------------------------------------------------------------------------------------------------------
const MAX_COLS = 4;
const isRowLine = l => /^\s*\|.*\|\s*$/.test(l);
const SEPARATOR = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/;
const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
/** A table from a run of `| … |` lines, or null when it is not a well-formed simple table (then it stays plain text). */
export function parseTable(lines) {
  if (lines.length < 3 || !SEPARATOR.test(lines[1])) return null;
  const head = cells(lines[0]), sep = cells(lines[1]);
  if (head.length < 2 || head.length > MAX_COLS || sep.length !== head.length || head.every(c => !c)) return null;
  const rows = lines.slice(2).map(cells);
  if (rows.some(r => r.length !== head.length)) return null;
  return { type: 'table', head: head.map(parseInline), rows: rows.map(r => r.map(parseInline)) };
}

/**
 * The answer's blocks: { type: 'p', lines: [inline[]] } | { type: 'h', inline } | { type: 'ul' | 'ol', items: [inline[]], start }
 * | { type: 'table', head: inline[], rows: [inline[][]] }. A paragraph keeps its single line breaks; a list item's
 * continuation line (indented, not a new item) joins the item. A malformed table's lines are a plain paragraph.
 */
export function parseMarkdown(text) {
  const blocks = []; let para = null, list = null;
  const close = () => { para = null; list = null; };
  const all = String(text ?? '').slice(0, MAX_CHARS).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
  for (let k = 0; k < all.length; k++) {
    const line = all[k];
    if (!line.trim()) { close(); continue; }
    if (isRowLine(line)) {
      let end = k; while (end < all.length && isRowLine(all[end])) end++;
      const run = all.slice(k, end), table = parseTable(run);
      close();
      blocks.push(table || { type: 'p', lines: run.map(l => l.trim()) });
      k = end - 1; continue;
    }
    const b = BULLET.exec(line), n = !b && NUMBERED.exec(line), hd = !b && !n && HEADING.exec(line);
    if (hd) { close(); if (hd[1]) blocks.push({ type: 'h', inline: parseInline(hd[1]) }); continue; }
    if (b || n) {
      const type = b ? 'ul' : 'ol';
      if (!list || list.type !== type) { para = null; list = { type, items: [], ...(n ? { start: Number(n[1]) } : {}) }; blocks.push(list); }
      list.items.push(b ? b[1] : n[2]); continue;
    }
    if (list && /^\s+/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    list = null;
    if (!para) { para = { type: 'p', lines: [] }; blocks.push(para); }
    para.lines.push(line.trim());
  }
  return blocks.map(bk => bk.type === 'p' ? { type: 'p', lines: bk.lines.map(parseInline) } : bk.type === 'h' || bk.type === 'table' ? bk : { ...bk, items: bk.items.map(parseInline) });
}

// ---- Citation targets -----------------------------------------------------------------------------------------------
/** A store document's chip label: its title, cut to a few words; `Doc 12` without one. */
export function docLabel(source) {
  const t = String(source?.title || '').replace(/\s+/g, ' ').trim();
  if (!t) return `Doc ${source?.documentId}`;
  if (t.length <= 22) return t;
  const cut = t.slice(0, 21), word = cut.replace(/[\s,.;:–-]+\S*$/, '');
  return `${word.length >= 8 ? word : cut}…`;
}
/**
 * What each marker can open: the first evidence item for a paragraph (a verified one first) when `onOpenEvidence` is
 * given, and the source for a store document unless the store said there is no such document. Anything else: null.
 */
export function citeTargets({ evidence = [], sources = [], onOpenEvidence = null } = {}) {
  const paras = new Map(), docs = new Map();
  if (onOpenEvidence) for (const e of [...(evidence || [])].sort((a, b) => (a?.verified === false) - (b?.verified === false))) if (e?.paragraphId && e.quote && !paras.has(e.paragraphId)) paras.set(e.paragraphId, e);
  for (const c of sources || []) { const id = Number(c?.documentId); if (Number.isInteger(id) && id > 0 && !docs.has(id) && c.reason !== 'No such document in the store.') docs.set(id, c); }
  return { para: id => paras.get(id) || null, doc: id => docs.get(id) || null, onOpenEvidence };
}

const Arrow = () => h('span', { className: 'cite__arrow', 'aria-hidden': 'true' }, '↗');
function chip(p, key, targets) {
  const c = p.cite;
  if (c.kind === 'para') {
    const e = targets?.para(c.id);
    if (!e) return h(Fragment, { key }, p.text);
    return h('button', { key, type: 'button', className: 'cite', 'aria-label': `Show paragraph ${c.n} in the document`, onClick: () => targets.onOpenEvidence(e) }, `¶${c.n}`, Arrow());
  }
  const s = targets?.doc(c.id);
  if (!s) return h(Fragment, { key }, p.text);
  return h('a', { key, className: 'cite', href: `#/documents/${encodeURIComponent(c.id)}`, 'aria-label': `Open ${s.title || `document ${c.id}`}` }, docLabel(s), Arrow());
}
/** Inline parts as nodes; neighbouring bold parts (a chip inside **…**) share one <strong>. */
function inline(parts, targets) {
  const out = [];
  parts.forEach((p, i) => {
    const node = h(Fragment, { key: i }, p.sep ? ' ' : null, p.cite ? chip(p, 'c', targets) : p.text);
    const last = out[out.length - 1];
    if (p.bold && last?.bold) last.nodes.push(node); else out.push({ bold: p.bold, nodes: [node] });
  });
  return out.map((g, i) => (g.bold ? h('strong', { key: i }, g.nodes) : h(Fragment, { key: i }, g.nodes)));
}

const plain = parts => parts.map(p => p.text).join('');
/** A table as a <table> (wide) and as one block per row (narrow); CSS shows one of them by the container's width. */
function table(b, key, targets) {
  return h('div', { key, className: 'mdt' },
    h('table', { className: 'mdt__table' },
      h('thead', null, h('tr', null, b.head.map((c, i) => h('th', { key: i, scope: 'col' }, inline(c, targets))))),
      h('tbody', null, b.rows.map((r, i) => h('tr', { key: i }, r.map((c, j) => (j ? h('td', { key: j }, inline(c, targets)) : h('th', { key: j, scope: 'row' }, inline(c, targets)))))))),
    h('div', { className: 'mdt__blocks' }, b.rows.map((r, i) => h('div', { key: i, className: 'mdt__row', role: 'group', 'aria-label': plain(r[0]) || `Row ${i + 1}` },
      h('p', { className: 'mdt__label' }, inline(r[0], targets)),
      h('dl', { className: 'mdt__cells' }, r.slice(1).map((c, j) => (c.length ? h(Fragment, { key: j }, h('dt', null, inline(b.head[j + 1], targets)), h('dd', null, inline(c, targets))) : null)))))));
}

/**
 * The answer rendered: text nodes, <p>, <strong>, <ul>/<ol>/<li>, a small heading, simple tables and citation chips.
 * `cites` ({ evidence, sources, onOpenEvidence }) says what the markers can open; without it every marker is plain text.
 */
export function Markdown({ text, className = 'md', cites = null }) {
  const targets = cites ? citeTargets(cites) : null;
  return h('div', { className }, parseMarkdown(text).map((b, i) => {
    if (b.type === 'h') return h('p', { key: i, className: 'md__h' }, inline(b.inline, targets));
    if (b.type === 'p') return h('p', { key: i }, b.lines.map((l, j) => h(Fragment, { key: j }, j ? h('br') : null, inline(l, targets))));
    if (b.type === 'table') return table(b, i, targets);
    return h(b.type, { key: i, ...(b.type === 'ol' && b.start && b.start !== 1 ? { start: b.start } : {}) }, b.items.map((it, j) => h('li', { key: j }, inline(it, targets))));
  }));
}
