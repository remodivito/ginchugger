// SPDX-License-Identifier: GPL-3.0-or-later
// The authoring spec's rules for one item, as code (AUTHORING-SPEC.md "Rules for the fields"; BENCHMARK-V2.md P5):
// applying an item's edits to the clean text, checking its fields, its fix and check, and the batch quotas. Pure
// functions over plain data, so apply.mjs, the markups and the tests share them.
export const KINDS = ['deviation', 'benign'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];
export const FAMILIES = ['value', 'wording', 'deletion', 'insertion-omission', 'definition-crossclause', 'near-threshold'];
export const QUOTA = { items: 12, deviations: 8, benign: 4, easy: 2, medium: 3, hard: 3, benignNearThreshold: 2, maxPerRule: 2 };

/** The scorer's compliance test, copied from score.mjs `complies` (not exported there); keep the two identical. */
export function complies(text, check) {
  const t = String(text || ''); const has = rx => new RegExp(rx, 'i').test(t);
  if (check.allowIf && has(check.allowIf)) return true;
  if ((check.forbid || []).some(has)) return false;
  if (!(check.require || []).every(has)) return false;
  if (check.num) { const m = t.match(new RegExp(check.num, 'i')); if (!m) return false; const n = parseFloat(m[1]); if (check.min !== undefined && n < check.min) return false; if (check.max !== undefined && n > check.max) return false; }
  return true;
}

const occurrences = (hay, needle) => { if (!needle) return 0; let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };

/**
 * Apply edits to a document's paragraphs (array of {id, text}). Each edit either names a clean paragraph and a `find`
 * that occurs exactly once in that paragraph's clean text, or inserts a new paragraph (`"paragraph": "after:p41"`,
 * empty `find`), which gets id p41a (p41b for a second insertion after the same paragraph, counting insertions already
 * present). `clean` is a Map of the clean texts by id (the uniqueness rule is about the clean paragraph).
 * Returns { paragraphs, targets, inserted, errors } without mutating its input.
 */
export function applyEdits(paragraphs, edits, clean) {
  const out = paragraphs.map(p => ({ ...p })); const errors = [], targets = [], inserted = [];
  if (!Array.isArray(edits) || !edits.length) return { paragraphs: out, targets, inserted, errors: ['no edits'] };
  edits.forEach((e, k) => {
    const where = `edit ${k + 1}`;
    if (!e || typeof e.paragraph !== 'string' || typeof e.replace !== 'string' || (e.find !== undefined && typeof e.find !== 'string')) { errors.push(`${where}: needs paragraph, find and replace as strings`); return; }
    const after = e.paragraph.match(/^after:(p\d+[a-z]?|a\d+[a-z]?)$/);
    if (after) {
      const anchor = after[1];
      if (!clean.has(anchor)) { errors.push(`${where}: ${e.paragraph} names no paragraph of the clean document`); return; }
      if (e.find) { errors.push(`${where}: an insertion takes an empty find`); return; }
      if (!e.replace.trim()) { errors.push(`${where}: the inserted paragraph is empty`); return; }
      let at = out.findIndex(p => p.id === anchor); let suffix = 'a';
      while (out[at + 1] && out[at + 1].id === anchor + suffix) { at++; suffix = String.fromCharCode(suffix.charCodeAt(0) + 1); }
      const id = anchor + suffix; out.splice(at + 1, 0, { id, text: e.replace.trim() }); targets.push(id); inserted.push(id); return;
    }
    if (!clean.has(e.paragraph)) { errors.push(`${where}: ${e.paragraph} is not a paragraph of the clean document`); return; }
    const find = e.find ?? '';
    if (!find) { errors.push(`${where}: find is empty (only an insertion takes an empty find)`); return; }
    const n = occurrences(clean.get(e.paragraph), find);
    if (n === 0) { errors.push(`${where}: find not found verbatim in clean ${e.paragraph}`); return; }
    if (n > 1) { errors.push(`${where}: find occurs ${n} times in clean ${e.paragraph}; it must be unique`); return; }
    if (find === e.replace) { errors.push(`${where}: replace equals find (no change)`); return; }
    const p = out.find(x => x.id === e.paragraph);
    if (!p.text.includes(find)) { errors.push(`${where}: find no longer present in ${e.paragraph} after the item's earlier edits`); return; }
    p.text = p.text.replace(find, () => e.replace);
    if (!targets.includes(p.id)) targets.push(p.id);
  });
  return { paragraphs: out, targets, inserted, errors };
}

function checkErrors(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return ['check missing'];
  const errs = [];
  for (const k of ['require', 'forbid']) if (check[k] !== undefined && !(Array.isArray(check[k]) && check[k].every(x => typeof x === 'string' && x))) errs.push(`check.${k} must be an array of regex strings`);
  if (check.num !== undefined && typeof check.num !== 'string') errs.push('check.num must be a regex string');
  for (const k of ['min', 'max']) if (check[k] !== undefined && typeof check[k] !== 'number') errs.push(`check.${k} must be a number`);
  if (!(check.require || []).length && !(check.forbid || []).length && !check.num) errs.push('check has no require, forbid or num');
  for (const rx of [...(check.require || []), ...(check.forbid || []), ...(check.num ? [check.num] : []), ...(check.allowIf ? [check.allowIf] : [])]) {
    try { new RegExp(rx, 'i'); } catch (e) { errs.push(`invalid regex ${JSON.stringify(rx)}: ${e.message}`); }
  }
  if (check.num && !errs.length) { const groups = new RegExp(check.num + '|').exec('').length - 1; if (groups < 1) errs.push('check.num needs one capture group'); }
  return errs;
}

/**
 * Validate one item against the clean document and the playbook. Returns { errors, warnings, applied } where applied
 * holds the variant paragraphs, the targets and the manifest plant when there are no errors. `ctx`: { doc (clean
 * document), ruleIds (Set) }.
 */
export function validateItem(item, ctx) {
  const errors = [], warnings = [];
  const clean = new Map(ctx.doc.paragraphs.map(p => [p.id, p.text]));
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { errors: ['not a JSON object'], warnings };
  if (!KINDS.includes(item.kind)) errors.push(`kind must be deviation or benign, not ${JSON.stringify(item.kind)}`);
  if (!FAMILIES.includes(item.family)) errors.push(`family must be one of ${FAMILIES.join(', ')}, not ${JSON.stringify(item.family)}`);
  if (item.kind === 'deviation' && !DIFFICULTIES.includes(item.difficulty)) errors.push(`a deviation's difficulty must be easy, medium or hard, not ${JSON.stringify(item.difficulty)}`);
  if (item.kind === 'benign' && item.difficulty !== 'n/a') warnings.push(`benign difficulty ${JSON.stringify(item.difficulty)} read as n/a`);
  if (typeof item.rule !== 'string' || !ctx.ruleIds.has(item.rule)) errors.push(`rule ${JSON.stringify(item.rule)} is not in the playbook`);
  if (typeof item.rationale !== 'string' || !item.rationale.trim()) warnings.push('rationale missing');
  const a = applyEdits(ctx.doc.paragraphs, item.edits, clean); errors.push(...a.errors);
  const planted = new Map(a.paragraphs.map(p => [p.id, p.text]));
  const fixes = [];
  if (item.kind === 'deviation' && !a.errors.length) {
    if (!Array.isArray(item.fixes) || !item.fixes.length) errors.push('a deviation needs at least one fix');
    for (const [k, f] of (item.fixes || []).entries()) {
      const where = `fix ${k + 1}`;
      if (!f || typeof f.paragraph !== 'string') { errors.push(`${where}: names no paragraph`); continue; }
      if (!a.targets.includes(f.paragraph)) { errors.push(`${where}: ${f.paragraph} is not a paragraph this item edits or inserts (${a.targets.join(', ')})`); continue; }
      const isInserted = a.inserted.includes(f.paragraph);
      if (isInserted) {
        if (f.inserted !== true) { errors.push(`${where}: ${f.paragraph} is an inserted paragraph; its fix is "inserted": true with an empty referenceText`); continue; }
        if (f.referenceText) warnings.push(`${where}: referenceText of an inserted paragraph ignored (the fix is its deletion)`);
        fixes.push({ paragraph: f.paragraph, restore: '', planted: planted.get(f.paragraph), referenceText: '', inserted: true, check: null }); continue;
      }
      if (f.inserted === true) { errors.push(`${where}: "inserted": true on ${f.paragraph}, which is not an inserted paragraph`); continue; }
      if (typeof f.referenceText !== 'string' || !f.referenceText.trim()) { errors.push(`${where}: referenceText missing`); continue; }
      const ce = checkErrors(f.check); if (ce.length) { errors.push(...ce.map(x => `${where}: ${x}`)); continue; }
      if (!complies(f.referenceText, f.check)) errors.push(`${where}: the check fails on its own referenceText`);
      if (complies(planted.get(f.paragraph), f.check)) errors.push(`${where}: the check passes on the planted text of ${f.paragraph}`);
      if (!complies(clean.get(f.paragraph), f.check)) errors.push(`${where}: the check fails on the clean text of ${f.paragraph} (P5: the clean form meets the acceptable position)`);
      fixes.push({ paragraph: f.paragraph, restore: clean.get(f.paragraph), planted: planted.get(f.paragraph), referenceText: f.referenceText, inserted: false, check: f.check });
    }
  }
  if (item.kind === 'benign' && Array.isArray(item.fixes) && item.fixes.length) warnings.push('fixes on a benign item ignored');
  if (errors.length) return { errors, warnings };
  return { errors, warnings, applied: { paragraphs: a.paragraphs, targets: a.targets, inserted: a.inserted, fixes } };
}

/**
 * The Cover Page lines an NDA plant makes untrue (fix 2, 17 October 2026): the Common Paper Mutual NDA's Cover Page says
 * "Changes to Standard Terms: None." and "Neither party has changed the Standard Terms", so any item that edits or inserts
 * into the attached Standard Terms (a paragraph after the "Standard Terms" heading) makes those two lines untrue. Returns
 * the ids of those lines (secondary targets for score.mjs) or []. `doc` is the clean document.
 */
export const COVER_PAGE_LINES = [/^Changes to Standard Terms:\s*None\.?$/i, /^Neither party has changed the Standard Terms/i];
export function coverPageSecondary(item, doc) {
  const ps = doc?.paragraphs || []; const head = ps.findIndex(p => /^Standard Terms$/.test(String(p.text).trim()));
  const lines = ps.filter(p => COVER_PAGE_LINES.some(rx => rx.test(String(p.text).trim()))).map(p => p.id);
  if (head < 0 || !lines.length) return [];
  const at = id => ps.findIndex(p => p.id === id);
  return touched(item).some(id => at(id) > head) ? lines : [];
}

/** Paragraphs an item touches, for overlap tests: edited ids and the anchors of insertions. */
export const touched = item => [...new Set((item.edits || []).map(e => String(e.paragraph).replace(/^after:/, '')))];

/**
 * Batch quotas over the items that passed validation (`entries`: [{ index, item }], index 0-based in batch order).
 * Returns { overuse: [{ rule, indexes, excess }], missingFamilies, counts, warnings }. Excess items are the third and
 * later uses of a rule in batch order.
 */
export function checkQuotas(entries) {
  const byRule = new Map();
  for (const e of entries) { const r = e.item.rule; byRule.set(r, [...(byRule.get(r) || []), e.index]); }
  const overuse = [...byRule].filter(([, ix]) => ix.length > QUOTA.maxPerRule).map(([rule, indexes]) => ({ rule, indexes, excess: indexes.slice(QUOTA.maxPerRule) }));
  const fams = new Set(entries.map(e => e.item.family));
  const missingFamilies = FAMILIES.filter(f => !fams.has(f));
  const dev = entries.filter(e => e.item.kind === 'deviation'), ben = entries.filter(e => e.item.kind === 'benign');
  const counts = { items: entries.length, deviations: dev.length, benign: ben.length, easy: dev.filter(e => e.item.difficulty === 'easy').length, medium: dev.filter(e => e.item.difficulty === 'medium').length, hard: dev.filter(e => e.item.difficulty === 'hard').length, benignNearThreshold: ben.filter(e => e.item.family === 'near-threshold').length };
  const warnings = [];
  for (const k of ['items', 'deviations', 'benign', 'easy', 'medium', 'hard']) if (counts[k] !== QUOTA[k]) warnings.push(`${k}: ${counts[k]} (spec ${QUOTA[k]})`);
  if (counts.benignNearThreshold < QUOTA.benignNearThreshold) warnings.push(`benign near-threshold: ${counts.benignNearThreshold} (spec at least ${QUOTA.benignNearThreshold})`);
  return { overuse, missingFamilies, counts, warnings };
}

/** Items to name when asking for a missing family: the later items of the most represented family (never a lone one). */
export function familyReplacementCandidates(entries) {
  const byFam = new Map(); for (const e of entries) byFam.set(e.item.family, [...(byFam.get(e.item.family) || []), e.index]);
  const ranked = [...byFam.values()].filter(ix => ix.length > 1).sort((a, b) => b.length - a.length);
  return ranked.length ? ranked[0].slice(1) : [];
}
