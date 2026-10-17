// SPDX-License-Identifier: GPL-3.0-or-later
// The common shape every layer C output is judged in (BENCHMARK-V2.md section 7 and P19; the spec's
// `v2/render-layer-c.mjs`). One plain-text rendering for a contestant's review, the attorneys' golden redline and the
// empty output alike, so a judge cannot tell them apart by format:
//   DOCUMENT      the task's paragraphs as the reviewer received them, in order, with the earlier rounds' tracked
//                 changes inline as {+Party: inserted+} and {-Party: deleted-} (party names only), and under any
//                 paragraph the output proposes to change, a line "PROPOSED:" showing the current text with each
//                 change as [was: …] [now: …] (word-level hunks); a proposed new paragraph is "PROPOSED NEW PARAGRAPH";
//   EXPLANATIONS  the output's explanations, one per finding or comment, each prefixed only by its paragraph id; no
//                 model names, titles, rule metadata, decisions, risk labels or timestamps.
// Normalisation: markdown emphasis, headings and code marks removed, whitespace collapsed, and any setup-identifying
// word (model, vendor, product, executor names) replaced by "[redacted]" (`leaks()` checks a rendering for them).
// Which findings count as proposals: what the product offers for Apply (score.mjs's flag: status "attention",
// decision not "accept") carrying offered wording (`suggestedText`), a deletion, or an insertion after a paragraph.

/** Words that would reveal a setup, its family or the source of an output. Checked case-insensitively, whole words. */
export const IDENTITY_TERMS = ['claude', 'opus', 'sonnet', 'haiku', 'anthropic', 'glm', 'zhipu', 'z\\.ai', 'zai-org', 'deepseek', 'qwen', 'alibaba', 'mistral', 'gpt', 'openai', 'codex', 'muse', 'llama', 'munito', 'gemini', 'ginchugger', 'trainer \\d+', 'attorney redline', 'golden redline', 'reviewing counsel', 'as an ai'];
const IDENT = new RegExp(`\\b(?:${IDENTITY_TERMS.join('|')})\\b`, 'gi');
/** The identity terms a text contains (empty when clean), ignoring any in `allowed` (terms the task document itself uses). */
export function leaks(text, allowed = new Set()) { return [...new Set((String(text).match(IDENT) || []).map(s => s.toLowerCase()))].filter(t => !allowed.has(t)); }
/** The identity terms the task document itself contains: never redacted, since they are the agreement's own words. */
export const documentTerms = document => new Set(leaks(document.paragraphs.map(p => `${p.text}\n${p.originalText ?? ''}`).join('\n')));

/** Plain text: markdown marks out, whitespace collapsed, identity words redacted (except the document's own words). */
export function plain(text, allowed = new Set()) {
  return String(text ?? '')
    .replace(/```[a-z]*\n?/gi, '').replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,;:]|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^[ \t]*[-*•][ \t]+/gm, '- ').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    .replace(IDENT, m => (allowed.has(m.toLowerCase()) ? m : '[redacted]'));
}
/** A party label from a tracked-change author ("Trainer 2 - LargeCo" → "LargeCo"); nothing else of the name is kept. */
export const partyOf = author => { const s = String(author ?? '').replace(/^.*?\s-\s/, '').trim(); return s && !/trainer/i.test(s) ? s : 'earlier round'; };

// ---- diffs -----------------------------------------------------------------------------------------------------------
const tokens = s => String(s ?? '').match(/\s+|[\p{L}\p{N}$%’'_-]+|[^\s\p{L}\p{N}]/gu) || []; // words, spaces and each punctuation mark
/** Word-level hunks between two strings: [{ same: string } | { was: string, now: string }]. */
export function wordDiff(a, b) {
  const x = tokens(a), y = tokens(b); const n = x.length, m = y.length;
  let p = 0; while (p < n && p < m && x[p] === y[p]) p++;
  let q = 0; while (q < n - p && q < m - p && x[n - 1 - q] === y[m - 1 - q]) q++;
  const xs = x.slice(p, n - q), ys = y.slice(p, m - q); const out = []; if (p) out.push({ same: x.slice(0, p).join('') });
  if (xs.length * ys.length > 4e6) out.push({ was: xs.join(''), now: ys.join('') });
  else {
    const L = Array.from({ length: xs.length + 1 }, () => new Uint32Array(ys.length + 1));
    for (let i = xs.length - 1; i >= 0; i--) for (let j = ys.length - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0, was = '', now = ''; const flush = () => { if (was || now) out.push({ was, now }); was = now = ''; };
    while (i < xs.length || j < ys.length) {
      if (i < xs.length && j < ys.length && xs[i] === ys[j] && L[i][j] === L[i + 1][j + 1] + 1) { flush(); out.push({ same: xs[i] }); i++; j++; }
      else if (i < xs.length && (j >= ys.length || L[i + 1][j] >= L[i][j + 1])) was += xs[i++];
      else now += ys[j++];
    }
    flush();
  }
  if (q) out.push({ same: x.slice(n - q).join('') });
  // merge neighbouring same-pieces and hunks separated only by whitespace
  const merged = [];
  for (const h of out) {
    const last = merged[merged.length - 1];
    if (last && 'same' in h && 'same' in last) last.same += h.same;
    else if (last && 'was' in h && merged.length >= 2 && 'same' in last && /^\s*$/.test(last.same) && 'was' in merged[merged.length - 2]) { const prev = merged[merged.length - 2]; prev.was += last.same + h.was; prev.now += last.same + h.now; merged.pop(); }
    else merged.push({ ...h });
  }
  return merged;
}
/** The current text with each change as [was: …] [now: …]. */
export function showChange(current, proposed) {
  if (!String(proposed ?? '').trim()) return `[was: ${current}] [now: (paragraph deleted)]`;
  const edge = (h, rx) => (rx.test(h.was) || rx.test(h.now) ? ' ' : '');
  return wordDiff(current, proposed).map(h => ('same' in h ? h.same : !h.was.trim() && !h.now.trim() ? h.now : `${edge(h, /^\s/)}[was: ${h.was.trim() || '(nothing)'}] [now: ${h.now.trim() || '(nothing)'}]${edge(h, /\s$/)}`)).join('').replace(/ {2,}/g, ' ');
}

/** Paragraph alignment of two versions (LCS on normalised text): pairs [{ a: index|null, b: index|null }] in order. */
export function alignParagraphs(a, b) {
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim(); const x = a.map(norm), y = b.map(norm); const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs = []; let i = 0, j = 0, ga = [], gb = [];
  // Inside a gap between identical paragraphs, pair edited paragraphs by word overlap (a monotone alignment that
  // maximises total similarity, pairs below 0.3 left unpaired as a deletion and an insertion).
  const words = s => new Set(s.toLowerCase().match(/[a-z0-9$%]+/g) || []);
  const sim = (u, v) => { const A = words(u), B = words(v); if (!A.size && !B.size) return 1; let k = 0; for (const w of A) if (B.has(w)) k++; return k / (A.size + B.size - k); };
  const flushGap = () => {
    const p = ga.length, q = gb.length; if (!p && !q) return;
    const S = Array.from({ length: p + 1 }, () => new Float64Array(q + 1));
    for (let u = p - 1; u >= 0; u--) for (let v = q - 1; v >= 0; v--) { const s0 = sim(x[ga[u]], y[gb[v]]); S[u][v] = Math.max(S[u + 1][v], S[u][v + 1], s0 >= 0.3 ? S[u + 1][v + 1] + s0 : -1); }
    let u = 0, v = 0;
    while (u < p || v < q) {
      if (u < p && v < q) { const s0 = sim(x[ga[u]], y[gb[v]]); if (s0 >= 0.3 && S[u][v] === S[u + 1][v + 1] + s0) { pairs.push({ a: ga[u++], b: gb[v++] }); continue; } }
      if (u < p && (v >= q || S[u][v] === S[u + 1][v])) pairs.push({ a: ga[u++], b: null }); else pairs.push({ a: null, b: gb[v++] });
    }
    ga = []; gb = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { flushGap(); pairs.push({ a: i++, b: j++ }); }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) gb.push(j++);
    else ga.push(i++);
  }
  flushGap(); return pairs;
}

// ---- outputs in one shape --------------------------------------------------------------------------------------------
/**
 * An output, whatever produced it: { changes: [{ paragraphId, text } | { afterParagraphId, text, inserted: true }],
 * explanations: [{ paragraphId, text }] }. `text` of a change is the paragraph as proposed ('' deletes it).
 */
export const EMPTY_OUTPUT = Object.freeze({ changes: [], explanations: [] });

/** Findings the product adds by itself (review.js attachComparison and the own-paper backstop): the same boilerplate for
 *  every setup, so they are not the output's explanations. */
export const PRODUCT_NOTES = new Set(['Amendment for contextual review', 'Amendment not assessed by model', 'Removed paragraph']);
const productNote = f => f.status === 'context' && !(f.ruleIds || []).length && PRODUCT_NOTES.has(f.title);
/** A contestant's review result (results/<task>.json) as an output. A failed review has no output (null). */
export function outputFromReview(result, document) {
  if (!result || !result.ok) return null;
  const ids = new Set(document.paragraphs.map(p => p.id)); const changes = [], explanations = [];
  for (const f of result.findings || []) {
    const flag = f.status === 'attention' && f.decision !== 'accept';
    if (flag && ids.has(f.paragraphId) && (typeof f.suggestedText === 'string' || f.deletion === true)) changes.push({ paragraphId: f.paragraphId, text: f.deletion === true ? '' : f.suggestedText });
    if (flag) for (const x of f.insertAfter || []) if (x && x.anchored !== false && ids.has(x.afterParagraphId) && String(x.text || '').trim()) changes.push({ afterParagraphId: x.afterParagraphId, text: x.text, inserted: true });
    if (!productNote(f) && typeof f.explanation === 'string' && f.explanation.trim()) explanations.push({ paragraphId: ids.has(f.paragraphId) ? f.paragraphId : null, text: f.explanation });
  }
  return { changes, explanations };
}

/** The attorneys' golden redline as an output: its final text aligned to the task document, and its new comments. */
export function outputFromGolden(golden, document) {
  if (!golden || golden.source === 'none') return { changes: [], explanations: (golden?.explanations || []).map(e => ({ ...e })) };
  return { changes: golden.changes.map(c => ({ ...c })), explanations: golden.explanations.map(e => ({ ...e })) };
}

/** Build the golden from the attorney redline read with docx.mjs, against the task document (contract.docx read). */
export function goldenFrom(contract, attorney, { source }) {
  const pairs = alignParagraphs(contract.paragraphs.map(p => p.text), attorney.paragraphs.map(p => p.text));
  const changes = []; let lastA = null; const bToA = new Map();
  for (const { a, b } of pairs) {
    if (a !== null) { lastA = a; if (b !== null) bToA.set(b, a); }
    if (a !== null && b !== null && contract.paragraphs[a].text !== attorney.paragraphs[b].text) changes.push({ paragraphId: contract.paragraphs[a].id, text: attorney.paragraphs[b].text });
    else if (a !== null && b === null && contract.paragraphs[a].text.trim()) changes.push({ paragraphId: contract.paragraphs[a].id, text: '' });
    else if (a === null && b !== null && attorney.paragraphs[b].text.trim()) { changes.push({ afterParagraphId: lastA === null ? contract.paragraphs[0].id : contract.paragraphs[lastA].id, text: attorney.paragraphs[b].text, inserted: true }); }
  }
  const before = new Set(contract.comments.map(c => `${c.author}\u0000${c.text}`));
  const bIndex = new Map(attorney.paragraphs.map((p, i) => [p.id, i]));
  const explanations = attorney.comments.filter(c => !before.has(`${c.author}\u0000${c.text}`) && c.text.trim()).map(c => {
    const b = c.paragraphId ? bIndex.get(c.paragraphId) : undefined; const a = b !== undefined ? bToA.get(b) : undefined;
    return { paragraphId: a !== undefined ? contract.paragraphs[a].id : null, text: c.text };
  });
  return { source, changes, explanations };
}

/** The rendered text a judge reads. `markup` is the task's { paragraphId: segments } of earlier tracked changes. */
export function render(document, markup, output) {
  const keep = documentTerms(document);
  const lines = ['DOCUMENT', 'The agreement as the reviewer received it. Tracked changes from earlier rounds appear inline as {+Party: inserted text+} and {-Party: deleted text-}. Under each paragraph the output proposes to change, PROPOSED shows the paragraph with each proposed change as [was: …] [now: …].', ''];
  const byPara = new Map(), after = new Map();
  for (const c of output.changes) { if (c.inserted) (after.get(c.afterParagraphId) || after.set(c.afterParagraphId, []).get(c.afterParagraphId)).push(c.text); else byPara.set(c.paragraphId, c.text); }
  for (const p of document.paragraphs) {
    const segs = markup?.[p.id]; const body = segs ? segs.map(s => (s.kind === 'ins' ? `{+${partyOf(s.author)}: ${s.text}+}` : s.kind === 'del' ? `{-${partyOf(s.author)}: ${s.text}-}` : s.text)).join('') : p.text;
    if (!body.trim() && !byPara.has(p.id) && !after.has(p.id)) continue;
    lines.push(`[${p.id}] ${body.replace(/\s+/g, ' ').trim()}`);
    if (byPara.has(p.id)) lines.push(`  PROPOSED: ${plain(showChange(p.text.replace(/\s+/g, ' ').trim(), String(byPara.get(p.id)).replace(/\s+/g, ' ').trim()), keep)}`);
    for (const t of after.get(p.id) || []) lines.push(`  PROPOSED NEW PARAGRAPH after ${p.id}: [was: (nothing)] [now: ${plain(t, keep).replace(/\s+/g, ' ')}]`);
  }
  lines.push('', 'EXPLANATIONS');
  const ex = output.explanations.filter(e => String(e.text || '').trim());
  if (!ex.length) lines.push('(none)');
  for (const e of ex) lines.push(`${e.paragraphId ? `[${e.paragraphId}] ` : ''}${plain(e.text, keep)}`);
  if (!output.changes.length) lines.splice(3, 0, '(The output proposes no changes.)', '');
  return lines.join('\n') + '\n';
}
