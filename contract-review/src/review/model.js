// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers for the E2 pane (docs/DESIGN-SYSTEM.md). No React, no DOM: tested in tests/pane-model.test.js.
import { diffArrays } from 'diff';

const STATUS_ORDER = { attention: 0, context: 1, 'within-guidance': 2 };
const byStatus = (a, b) => (STATUS_ORDER[a.status] ?? 1) - (STATUS_ORDER[b.status] ?? 1);

/**
 * Exception-led order (R5.5). `primary` is every finding on text the counterparty changed (or every finding when no
 * baseline is known), attention first, then context, then within guidance. `also` is points on text nobody changed
 * ("Also noticed"), kept apart so the lawyer can finish after the exceptions (R5.6). Sorting is stable.
 */
export function sequence(findings = []) {
  const primary = [], also = [];
  for (const f of findings) (f.untouched && f.status !== 'within-guidance' ? also : primary).push(f);
  return { primary: primary.slice().sort(byStatus), also: also.slice().sort(byStatus) };
}

/**
 * The pane's one list (decision 184): every point, worst first. Points on text the counterparty changed come before
 * points on text nobody changed at the same severity; the order is otherwise the review's own.
 */
export function worstFirst(findings = []) {
  const { primary, also } = sequence(findings);
  return [...primary, ...also].sort(byStatus);
}

/**
 * The playbook a review uses (decision 184: the pane has no picker): the first playbook, by id, whose phrases occur in
 * the document's title or its first three lines (the rule the record's inbox used before decision 190). Null when none
 * matches or there are no playbooks.
 */
export function inferPlaybook(playbooks = [], { title = '', paragraphs = [] } = {}) {
  if (!playbooks.length) return null;
  const phraseIn = (phrase, text) => new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
  const lines = [String(title || '').replace(/\.docx$/i, ''), ...paragraphs.map(p => String(p?.text || '').trim()).filter(Boolean).slice(0, 3)];
  for (const pb of [...playbooks].sort((a, b) => a.id.localeCompare(b.id))) {
    if ((pb.appliesTo?.phrases || []).some(phrase => lines.some(line => phraseIn(phrase, line)))) return pb.id;
  }
  return null; // audit finding 2: no silent NDA fallback; the pane asks the lawyer to choose
}

/** A point whose quote, or whose record citation, could not be verified (audit finding 3: its "Not verified" tag). */
export const notVerified = f => (f?.evidence || []).some(e => e && e.verified === false) || (f?.record || []).some(c => c && c.verified === false);

// The parts of a .docx the review does not read, from the importer's warnings (server/docx.js `issues`).
const UNREAD = [
  [/Headers, footers, footnotes and endnotes/, 'headers and notes'],
  [/Unsupported txbxContent/, 'text boxes'],
  [/Unsupported sdt/, 'content controls'],
  [/Unsupported (moveFrom|moveTo)/, 'moved text'],
  [/Unsupported altChunk/, 'embedded documents'],
];

/**
 * What a review did not check (audit finding 3), for the pane's one coverage line: the playbook rules no point was
 * reported on (`review.coverage` status not-assessed), the parts of the document not read (the importer's warnings,
 * on the document or in the review's limits), and the points whose quote or record citation failed verification.
 * Null when everything was checked. `rules` names the rules ([{ id, title }]).
 */
export function coverageOf(review, { doc = null, rules = [] } = {}) {
  if (!review) return null;
  const cov = Array.isArray(review.coverage) ? review.coverage : [];
  const missed = cov.filter(c => c.status === 'not-assessed');
  const warnings = [...(doc?.warnings || []), ...(review.limits || [])].map(String);
  const parts = [...new Set(UNREAD.filter(([re]) => warnings.some(w => re.test(w))).map(([, name]) => name))];
  const unverified = (review.findings || []).filter(notVerified);
  // Hidden text (security review, 17 Oct 2026): the importer's warning, or the paragraphs it marked.
  const hidden = (doc?.paragraphs || []).filter(p => p?.hidden).length || Number((warnings.map(w => /^Hidden text .* in (\d+) paragraph/.exec(w)).find(Boolean) || [])[1] || 0);
  if (!missed.length && !parts.length && !unverified.length && !hidden) return null;
  const bits = [];
  if (missed.length) bits.push(`${cov.length - missed.length} of ${cov.length} rules checked`);
  if (parts.length) bits.push(`${parts.join(', ')} not read`);
  if (hidden) bits.push(`hidden text in ${hidden} paragraph${hidden === 1 ? '' : 's'}`);
  if (unverified.length) bits.push(`${unverified.length} not verified`);
  const title = id => rules.find(r => r.id === id)?.title || id;
  return { line: bits.join(' · '), rules: missed.map(c => ({ id: c.ruleId, title: title(c.ruleId) })), parts, unverified: unverified.map(f => f.id) };
}

/**
 * Word diff on whitespace-delimited tokens, so "(7)" stays one token, then whitespace between two changes is absorbed into
 * them: "seven (7)" → "five (5)" reads as one deletion and one insertion, not four fragments.
 */
export function wordDiff(before, after) {
  const tok = s => s.match(/\s+|[^\s]+/g) || [];
  const raw = diffArrays(tok(before), tok(after)).map(c => ({ text: c.value.join(''), kind: c.added ? 'add' : c.removed ? 'del' : 'same' }));
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const between = p.kind === 'same' && !p.text.trim() && out.length && out.at(-1).kind !== 'same' && raw[i + 1] && raw[i + 1].kind !== 'same';
    if (between) {
      // absorb the space into the run of changes on both sides
      let j = out.length - 1; while (j >= 0 && out[j].kind !== 'same') j--;
      for (let k = j + 1; k < out.length; k++) out[k] = { ...out[k], text: out[k].text + p.text };
      continue;
    }
    out.push(p);
  }
  // merge neighbours of the same kind, and order each changed run as one deletion then one insertion
  const merged = [];
  for (let i = 0; i < out.length;) {
    if (out[i].kind === 'same') { merged.push(out[i++]); continue; }
    let del = '', add = '';
    while (i < out.length && out[i].kind !== 'same') { if (out[i].kind === 'del') del += out[i].text; else add += out[i].text; i++; }
    // trailing spaces belong outside the marks
    const delT = del.replace(/\s+$/, ''), addT = add.replace(/\s+$/, ''); const tail = (add || del).match(/\s+$/)?.[0] || '';
    if (delT) merged.push({ text: delT, kind: 'del' });
    if (delT && addT) merged.push({ text: ' ', kind: 'same' });
    if (addT) merged.push({ text: addT, kind: 'add' });
    if (tail) merged.push({ text: tail, kind: 'same' });
  }
  return merged;
}

const words = s => s.match(/\s*\S+\s*/g) || [];
function tailWords(text, n) { const w = words(text); return { text: w.slice(-n).join(''), cut: w.length > n }; }
function headWords(text, n) { const w = words(text); return { text: w.slice(0, n).join(''), cut: w.length > n }; }

/** Cut parts so their visible text is at most `limit` characters, at a word boundary. */
function clampParts(parts, limit) {
  const out = []; let used = 0;
  for (const p of parts) {
    if (used + p.text.length <= limit) { out.push(p); used += p.text.length; continue; }
    const room = limit - used; const cut = p.text.lastIndexOf(' ', room);
    const text = p.text.slice(0, cut > 0 ? cut : Math.max(room, 0)).trimEnd();
    if (text) out.push({ ...p, text });
    return { parts: out, truncated: true };
  }
  return { parts: out, truncated: false };
}
const visible = parts => parts.reduce((n, p) => n + p.text.trim().length, 0);

/**
 * The changed words between two versions of a paragraph, with a few words of context either side, as parts
 * [{ text, kind: 'same'|'add'|'del' }]. Long unchanged stretches between changes are shortened to "…". Returns null when
 * nothing differs. `full` keeps every part for the "Full wording" disclosure.
 */
export function diffExcerpt(before, after, { lead: leadWords = 2, trail: trailWords = 1, limit = 140 } = {}) {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null;
  const full = wordDiff(before, after);
  const changed = full.map((p, i) => (p.kind === 'same' ? -1 : i)).filter(i => i >= 0);
  if (!changed.length) return null;
  const first = changed[0], last = changed.at(-1);
  const win = [];
  let lead = false, trail = false;
  if (full[first - 1]) { const t = tailWords(full[first - 1].text, leadWords); lead = t.cut || first - 1 > 0; win.push({ text: t.text, kind: 'same' }); }
  for (let i = first; i <= last; i++) {
    const p = full[i];
    if (p.kind === 'same' && p.text.length > 60) { const h = headWords(p.text, 3), t = tailWords(p.text, 3); win.push({ text: `${h.text.trimEnd()} … ${t.text.trimStart()}`, kind: 'same' }); }
    else win.push(p);
  }
  if (full[last + 1]) { const h = headWords(full[last + 1].text, trailWords); trail = h.cut || last + 1 < full.length - 1; win.push({ text: h.text, kind: 'same' }); }
  const clamped = clampParts(win, limit);
  const t = trail || clamped.truncated;
  if (t && clamped.parts.length) { const last = clamped.parts.at(-1); clamped.parts[clamped.parts.length - 1] = { ...last, text: last.text.trimEnd() }; }
  if (lead && clamped.parts.length) clamped.parts[0] = { ...clamped.parts[0], text: clamped.parts[0].text.trimStart() };
  return { parts: clamped.parts, lead, trail: trail || clamped.truncated, truncated: clamped.truncated || win.some(p => p.text.includes(' … ')), length: visible(clamped.parts), full };
}

/** A quote shown as it stands (unchanged text, or no comparison available). */
export function quoteExcerpt(quote, { limit = 140 } = {}) {
  if (typeof quote !== 'string' || !quote.trim()) return null;
  const clamped = clampParts([{ text: quote.trim(), kind: 'same' }], limit);
  return { parts: clamped.parts, lead: false, trail: clamped.truncated, truncated: clamped.truncated, length: visible(clamped.parts), full: [{ text: quote.trim(), kind: 'same' }] };
}

/** Level-one size for a pair of excerpts: both share the size the longer one needs (docs/DESIGN-SYSTEM.md, Type). */
export function quoteSize(...excerpts) {
  const longest = Math.max(0, ...excerpts.filter(Boolean).map(e => e.length));
  return longest <= 60 ? 'l' : 'm';
}

/** The text that would go back for a finding: proposed wording when it may be applied. */
export function applicableText(f) {
  const text = f?.proposedText ?? f?.suggestedText;
  if (typeof text !== 'string' || !text.trim()) return null;
  if (f.proposalStatus === 'not-applicable') return null;
  return text;
}

/**
 * The clause heading a point sits under, from the document itself: the paragraph's own label ("Confidentiality Period:",
 * "6. Return or Destruction.") when it has one, else the nearest short heading-like paragraph above it (numbered, or
 * title case without a full stop). Null when nothing qualifies; the caller falls back to the finding's title.
 */
export function clauseHeading(paragraphs = [], paragraphId) {
  const i = paragraphs.findIndex(p => p.id === paragraphId); if (i < 0) return null;
  const headingLike = t => t && t.length <= 80 && (/^\d+(?:\.\d+)*\.?\s+\S/.test(t) || (!/[.;]$/.test(t) && /^[A-Z]/.test(t) && t.split(/\s+/).length <= 8));
  const self = String(paragraphs[i].text || '').trim();
  if (headingLike(self)) return self.replace(/[.:]$/, '');
  // A label is numbered, or in title case ("Confidentiality Period:"); "The Receiving Party shall:" is a sentence.
  const own = self.match(/^((?:\d+(?:\.\d+)*\.?\s+)?[A-Z][^.:;]{1,58}?)[.:](?:\s|$)/);
  if (own && (/^\d/.test(own[1]) || own[1].split(/\s+/).every(w => w.length < 4 || /^[A-Z(“"]/.test(w)))) return own[1].replace(/\s+/g, ' ').trim();
  for (let k = i - 1; k >= 0 && k >= i - 8; k--) {
    const t = String(paragraphs[k].text || '').trim();
    if (headingLike(t)) return t.replace(/[.:]$/, '');
  }
  return null;
}

/** The first `max` sentences of a text, within `limit` characters; what the card shows before "Reasoning". */
export function leadSentences(text, { max = 2, limit = 300 } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim(); if (!t) return '';
  const sentences = t.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [t];
  let out = '';
  for (const s of sentences.slice(0, max)) { if (out && (out + s).length > limit) break; out += s; }
  out = out.trim() || sentences[0].trim();
  return out.length > limit ? `${out.slice(0, out.lastIndexOf(' ', limit))}…` : out;
}

/** "Nkechi Okafor <n.okafor@…>" → "N. Okafor". Returns null when no display name is present. */
export function senderLabel(fromHeader) {
  const m = String(fromHeader || '').match(/^\s*"?([^"<]+?)"?\s*</);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : parts[0];
}

/**
 * The words in the document a finding is about: its evidence in its own paragraph, else its first evidence in the document.
 * Evidence from another source (the starting text, an earlier round) is never a passage here, and neither is a quote the
 * server marked as not found. Replayed (recorded) evidence carries no flag at all; Word still checks the wording before marking.
 */
export function passageFor(f) {
  const usable = (f?.evidence || []).filter(e => e && e.verified !== false && !e.source && e.quote);
  return (usable.find(e => e.paragraphId === f.paragraphId) || usable[0])?.quote || null;
}

/**
 * The smallest edit that turns `before` into `after`, for a redline a lawyer can read at a glance: the changed words
 * (`inner`) and a short run of unchanged words around them (`context`) that occurs exactly once in `before`, so Word can
 * find the place without doubt. Returns null when nothing changes. `inner` is null when the change is a pure insertion
 * or deletion, or is not unique inside its context; the caller then replaces the context as a whole.
 */
export function minimalEdit(before, after) {
  const b = String(before).split(/(\s+)/), a = String(after).split(/(\s+)/);
  let start = 0; while (start < b.length && start < a.length && b[start] === a[start]) start++;
  if (start === b.length && start === a.length) return null;
  let endB = b.length, endA = a.length; while (endB > start && endA > start && b[endB - 1] === a[endA - 1]) { endB--; endA--; }
  const inner = b.slice(start, endB).join(''), innerReplacement = a.slice(start, endA).join('');
  const occurrences = (text, q) => { if (!q) return 0; let n = 0, i = -1; while ((i = text.indexOf(q, i + 1)) >= 0) n++; return n; };
  // Widen to whole words on both sides until the run is found exactly once (tokens alternate word, space, word…).
  let s = start, e = endB; const tail = () => b.length - e;
  const widen = () => { const s0 = s, e0 = e; s = Math.max(0, s - (s % 2 ? 1 : 2)); e = Math.min(b.length, e + (e % 2 ? 2 : 1)); return s !== s0 || e !== e0; };
  let context;
  do { if (!widen()) break; context = b.slice(s, e).join(''); } while (!context.trim() || occurrences(String(before), context) !== 1);
  context = b.slice(s, e).join('');
  const contextReplacement = a.slice(s, a.length - tail()).join('');
  const usable = inner.trim() && innerReplacement.trim() && inner === inner.trim() && innerReplacement === innerReplacement.trim() && occurrences(context, inner) === 1;
  return { context, contextReplacement, inner: usable ? inner : null, innerReplacement: usable ? innerReplacement : null };
}

/**
 * Is `candidate` wording for this clause, or a remark about a choice? An option's text may be either: the model is asked
 * for wording but can write a note there instead (seen in Word, 5 Oct 2026: "Within the playbook ceiling; no escalation
 * needed" was applied over a payment clause). Wording for a clause keeps most of the clause it replaces: either half of
 * its three-word sequences are found in one of the reference texts (the clause now, the clause before their change, the
 * suggested wording), or it begins and ends as one of them does; and in either case it starts with the clause's own first word. Anything else is shown as a note and can never be applied.
 */
export function isClauseWording(candidate, references = []) {
  const words = t => String(t || '').toLowerCase().match(/[a-z0-9'’]+/g) || [];
  const c = words(candidate); if (!c.length) return false;
  const triples = w => { const out = new Set(); for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(' ')); return out; };
  const ct = triples(c);
  return references.filter(Boolean).some(ref => {
    const r = words(ref); if (!r.length) return false;
    const rt = triples(r);
    if (c[0] !== r[0]) return false; // wording starts as the clause starts; "Restore: 1. Subscription…" is an instruction with the clause attached
    if (ct.size && rt.size) { let n = 0; for (const t of ct) if (rt.has(t)) n++; if (n / Math.min(ct.size, rt.size) >= 0.5) return true; }
    let pre = 0; while (pre < c.length && pre < r.length && c[pre] === r[pre]) pre++;
    let suf = 0; while (suf < c.length - pre && suf < r.length - pre && c[c.length - 1 - suf] === r[r.length - 1 - suf]) suf++;
    return pre > 0 && (pre + suf) / Math.min(c.length, r.length) >= 0.5;
  });
}
/**
 * A position's label as the lawyer reads it. The model writes labels like "A: Counter at five years (within the DUR-01
 * ceiling)"; the letter is a list marker and the bracket is the rule's name for the tier. The label keeps the act, the
 * bracket becomes `hint` under it, and the rule id is reachable from Sources.
 */
export function positionLabel(label) {
  const raw = String(label || '').trim().replace(/^[A-Z]\s*[:.)]\s+/, '');
  const m = raw.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!m || !m[1].trim()) return { label: raw, hint: null };
  return { label: m[1].trim(), hint: m[2].trim() || null };
}

/** An option as the pane uses it: `text` only when it is wording for the clause; otherwise the model's text becomes `note`. */
export function optionReply(option, references) {
  const text = typeof option?.text === 'string' && option.text.trim() ? option.text : null;
  const { label, hint } = positionLabel(option?.label);
  return text && isClauseWording(text, references) ? { label, hint, text, note: null } : { label, hint, text: null, note: text };
}

/**
 * The same, for wording changed in more than one place: one edit per place, so Word shows each change on its own and
 * leaves the words between them alone (seen in Word, 5 Oct 2026: a changed number plus an added sentence came out as the
 * whole clause struck and retyped). Places fewer than `gap` words apart are treated as one. An addition with nothing struck
 * is an insertion after the word before it. Falls back to the single edit whenever a place cannot be found unambiguously
 * without touching its neighbour. Edits are returned last first, so applying them in order never disturbs one not yet applied.
 */
export function minimalEdits(before, after, { gap = 4 } = {}) {
  const single = minimalEdit(before, after); if (!single) return [];
  const text = String(before), b = text.split(/(\s+)/), a = String(after).split(/(\s+)/);
  const hunks = []; let bi = 0, ai = 0, cur = null;
  for (const part of diffArrays(b, a)) {
    const n = part.value.length;
    if (part.added || part.removed) { cur ||= { bs: bi, be: bi, as: ai, ae: ai }; if (part.added) { ai += n; cur.ae = ai; } else { bi += n; cur.be = bi; } }
    else { if (cur) { hunks.push(cur); cur = null; } bi += n; ai += n; }
  }
  if (cur) hunks.push(cur);
  const merged = [];
  for (const h of hunks) { const last = merged.at(-1); if (last && h.bs - last.be < gap * 2) { last.be = h.be; last.ae = h.ae; } else merged.push({ ...h }); }
  if (merged.length < 2) return [single];
  const count = q => { if (!q) return 0; let n = 0, i = -1; while ((i = text.indexOf(q, i + 1)) >= 0) n++; return n; };
  const edits = [];
  for (let k = 0; k < merged.length; k++) {
    const h = merged[k], lo = k ? merged[k - 1].be : 0, hi = k + 1 < merged.length ? merged[k + 1].bs : b.length;
    const inner = b.slice(h.bs, h.be).join(''), repl = a.slice(h.as, h.ae).join('');
    if (!inner.trim() && repl.trim()) { // an addition: anchor on the words before it
      let s = h.bs; let anchor = '';
      while (s > lo) { s -= 1; anchor = b.slice(s, h.bs).join(''); if (anchor.trim() && anchor === anchor.trimStart() && count(anchor) === 1) break; anchor = ''; }
      if (!anchor) return [single];
      edits.push({ context: anchor, contextReplacement: anchor + inner + repl, inner: null, innerReplacement: null, insertAfter: inner + repl }); continue;
    }
    let s = h.bs, e = h.be, context = '';
    for (;;) {
      context = b.slice(s, e).join('');
      if (context.trim() && context === context.trim() && count(context) === 1) break;
      const s0 = s, e0 = e; if (s > lo) s -= 1; if (e < hi) e += 1; if (s === s0 && e === e0) return [single];
    }
    const contextReplacement = b.slice(s, h.bs).join('') + repl + b.slice(h.be, e).join('');
    const usable = inner.trim() && repl.trim() && inner === inner.trim() && repl === repl.trim() && context.split(inner).length === 2;
    if (!contextReplacement.trim()) return [single];
    edits.push({ context, contextReplacement, inner: usable ? inner : null, innerReplacement: usable ? repl : null });
  }
  return edits.reverse();
}

// ---- Pane additions (product v2, slice S5) ----

/**
 * The edits one point's reply makes (7.8, PR-PANE-05): the reply in the finding's own paragraph, when it differs, and
 * each new paragraph the finding inserts (`insertAfter`, anchored) when `insertions` is true (Word only). Returned in
 * document order (`order(paragraphId)` gives a paragraph's position; a new paragraph follows its anchor). Two or more
 * edits open the confirmation card; one applies on its click.
 */
export function planEdits(f, { replyText = null, current = '', deletes = false, insertions = false, order = () => 0 } = {}) {
  const rows = [];
  const differs = deletes || (typeof replyText === 'string' && !!replyText && replyText.trim() !== String(current).trim());
  if (differs) rows.push({ key: 'replace', kind: 'replace', paragraphId: f.paragraphId, before: current, after: deletes ? '' : replyText, at: order(f.paragraphId), sub: 0 });
  if (insertions) (f.insertAfter || []).forEach((ins, i) => { if (ins.anchored !== false && ins.text?.trim()) rows.push({ key: `insert-${i}`, kind: 'insert', paragraphId: ins.afterParagraphId, before: '', after: ins.text, at: order(ins.afterParagraphId), sub: i + 1 }); });
  return rows.sort((a, b) => a.at - b.at || a.sub - b.sub);
}

/** One plain line of what changed, from a diff excerpt: the words struck and the words that replace them. */
function excerptText(before, after) {
  const e = diffExcerpt(before, after, { lead: 3, trail: 2, limit: 110 });
  if (!e) return null;
  const join = kinds => `${e.lead ? '…' : ''}${e.parts.filter(p => kinds.includes(p.kind)).map(p => p.text).join('').replace(/\s+/g, ' ').trim()}${e.trail ? '…' : ''}`;
  return { was: join(['same', 'del']), now: join(['same', 'add']) };
}

/**
 * The reply posted in a comment thread after an applied change (7.7 step 2): "Changed: <excerpt>.", at most 300
 * characters, composed by code from the text before and after (never by the model). The counterparty reads it, so it
 * names no playbook and no rule id (audit finding 9); the record's comment_replied event keeps the rule.
 */
export function commentReplyText(before, after) {
  const b = String(before ?? ''), a = String(after ?? '');
  const cut = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1)).replace(/\s+\S*$/, '')}…` : s);
  let body;
  if (!b.trim()) body = `added “${cut(a.trim(), 200)}”`;
  else if (!a.trim()) body = `deleted “${cut(b.trim(), 200)}”`;
  else { const x = excerptText(b, a); body = x ? `“${cut(x.was, 110)}” to “${cut(x.now, 110)}”` : 'wording revised'; }
  const text = `Changed: ${body}.`;
  return text.length <= 300 ? text : `${text.slice(0, 299).replace(/\s+\S*$/, '')}…`.slice(0, 300);
}

/** The unresolved comment thread on a paragraph, by Word's paragraph index; null when there is none or comments are unread. */
export function threadFor(comments, wordIndex) {
  if (!Array.isArray(comments) || !Number.isInteger(wordIndex)) return null;
  return comments.find(c => !c.resolved && c.paragraphIndex === wordIndex) || null;
}
