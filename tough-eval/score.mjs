// SPDX-License-Identifier: GPL-3.0-or-later
// Exact scoring of tough-eval runs, and the check that the eval discriminates. No judge model: we know what was
// planted and where.
//   flag      = a finding with status "attention" and any decision other than "accept"
//   caught    = a flag on a planted paragraph (by paragraphId or a verified quote from it)        -> "located"
//               ... that also cites one of the plant's playbook rules                              -> "caught" (headline)
//   false alarm = a flag citing a playbook rule on a paragraph with no planted deviation, or on a benign edit
//   fixed     = caught, and the proposed wording for each planted paragraph restores what the plant changed (the
//               original wording, word for word or with 85% of its words for long passages) and drops what it added;
//               for an inserted clause, a proposal to delete it, or (v2, from 17 October 2026) wording for that paragraph
//               that passes its acceptCheck, the rule's preferred or acceptable position (v2/inserted-checks.json)
//   all-pass  = an agreement where every deviation is caught and fixed, nothing is a false alarm, no benign edit is
//               flagged, and no flag quotes words the agreement does not contain or cites a playbook entry that does not
//               exist (the strict, Harvey LAB-style measure, hallucination-gated: one slip fails the agreement;
//               "allPassUngated" is the same without the gate)
//   hallucination gate = a flag's evidence quote not found in the agreement (review.js marks it verified:false), or a rule
//               ID not in the playbook (review.js lists them in unknownRuleIds). These are the hallucinations this task
//               can detect exactly, without a judge; misstatements in the reasoning are not checked and are sampled by
//               hand in the error analysis instead
//   failed    = a review that did not come back usable (malformed output, provider error) counts as an agreement in
//               which nothing was found: every deviation missed, all-pass false. A lawyer waiting on it got nothing.
//               "reliability" = usable reviews / attempted. (Decision 148; before 14 Oct failed reviews were excluded.)
//   excess    = lightest touch: words a compliant fix changes beyond those needed to undo the plant (word-level diff
//               against the clean agreement); "surgical" = excess of 5 words or fewer
// v2 suites (v2a, v2h and their fixtures; BENCHMARK-V2.md 3.1, 11.3): the suite is taken from the run's manifest (or
// --suite); variants are read from each variant's `file`; a fix is scored by its check (`complies`) wherever the plant has
// checks; a benign edit is "flagged" by a flag that sits on it (by paragraph id or verified quote); and the gate also
// counts a flag on a paragraph id that is not in the document (`anchored: false`, an invented paragraph, counted from
// v2 onwards). Plants and agreements carry author, side, document, family and status, and each agreement its errorClass
// and attempts (v2/retry-policy.mjs), for v2/profile.mjs. The v1 suite is scored exactly as before.
// Every agreement also lists its hallucination instances (variant, paragraph, quote or rule id), on every suite.
// Fixes of 17 October 2026 (v2 suites other than the preliminary snapshot): quotes re-checked after typographic
// normalisation (reverifyQuotes; counted per agreement as quotesNormalised); secondary targets (the NDA Cover Page lines a
// Standard Terms plant makes untrue) are neither false alarms nor benign flags (secondaryFlags counts them).
// Usage: node tough-eval/score.mjs [--suite <name>] <runDir> [<runDir> ...]   (several runs: adds the per-plant matrix and spreads)
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSuite, isMarkup, isV2, suiteOfRun, isPrelimSuite } from './suite.mjs';
import { attemptsFor, classOf } from './v2/retry-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = new Map(); export const suiteNamed = name => suites.get(name) || suites.set(name, loadSuite(name)).get(name);
const flag = f => f.status === 'attention' && f.decision !== 'accept';
const norm = t => String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const words = t => norm(t).match(/[a-z0-9%£$.]+/g) || [];
function restores(text, fix) {
  if (fix.inserted) return false;
  const t = norm(text), r = norm(fix.restore), planted = norm(fix.planted);
  if (planted && !r.includes(planted) && t.includes(planted)) return false;
  if (!r) return true;
  if (t.includes(r)) return true;
  if (r.length < 80) return false;
  const have = new Set(words(text)), need = words(fix.restore);
  return need.filter(w => have.has(w)).length / need.length >= 0.85;
}
// A fix complies when the proposed wording meets the plant's check, written from the playbook's acceptable positions:
// phrases it must contain or must not contain, and numeric limits (e.g. a cap of at least 1x). Verbatim restoration of the
// original wording is reported separately ("restored") because acceptable alternatives are legitimate fixes.
export function complies(text, check) {
  const t = String(text || ''); const has = rx => new RegExp(rx, 'i').test(t);
  if (check.allowIf && has(check.allowIf)) return true;
  if ((check.forbid || []).some(has)) return false;
  if (!(check.require || []).every(has)) return false;
  if (check.num) { const m = t.match(new RegExp(check.num, 'i')); if (!m) return false; const n = parseFloat(m[1]); if (check.min !== undefined && n < check.min) return false; if (check.max !== undefined && n > check.max) return false; }
  return true;
}
function compliantFix(flags, plant) {
  return (plant.fixes || []).every(fix => flags.some(f => {
    if (f.paragraphId !== fix.paragraph) return false;
    const text = f.proposedText ?? f.suggestedText;
    if (fix.inserted && (f.deletion === true || text === '')) return true;
    // An inserted clause brought to the playbook's acceptable wording (v2/inserted-checks.json, 17 October 2026).
    if (fix.inserted && fix.acceptCheck) return typeof text === 'string' && text.trim() ? complies(text, fix.acceptCheck) : false;
    return typeof text === 'string' && text.trim() && fix.check ? complies(text, fix.check) : false;
  }));
}
function fixed(flags, plant) {
  return (plant.fixes || []).every(fix => flags.some(f => (f.paragraphId === fix.paragraph) && (fix.inserted ? (f.deletion === true || f.proposedText === '' || f.suggestedText === '') : typeof (f.proposedText ?? f.suggestedText) === 'string' && restores(f.proposedText ?? f.suggestedText, fix))));
}
// Words changed between two texts (insertions plus deletions), from a word-level longest common subsequence.
function wordEdits(a, b) {
  const x = words(a), y = words(b); const prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) { let diag = 0; for (let j = 1; j <= y.length; j++) { const up = prev[j]; prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]); diag = up; } }
  return x.length + y.length - 2 * prev[y.length];
}
function excessWords(flags, plant, current, base) {
  let total = null;
  for (const fix of plant.fixes || []) {
    if (fix.inserted || !base.has(fix.paragraph)) continue;
    const f = flags.find(x => x.paragraphId === fix.paragraph && typeof (x.proposedText ?? x.suggestedText) === 'string' && (x.proposedText ?? x.suggestedText).trim());
    if (!f) continue;
    const now = current.get(fix.paragraph) ?? '', needed = wordEdits(now, base.get(fix.paragraph)), made = wordEdits(now, f.proposedText ?? f.suggestedText);
    total = (total ?? 0) + Math.max(0, made - needed);
  }
  return total;
}
const touches = (f, ids) => ids.includes(f.paragraphId) || (f.evidence || []).some(e => e.verified && ids.includes(e.paragraphId));
// The eval's own quote check (fix 5, 17 October 2026): review.js verifies a quote as an exact substring, so a quote that
// differs from the document only in typography (curly against straight quotes and apostrophes, the dash characters,
// runs of whitespace or non-breaking spaces) came back verified:false and counted as invented. On v2 suites such a quote
// is re-checked against the cited paragraph of the variant (any paragraph when none is cited) after `typo`, and counts as
// verified when found; each one is counted in the agreement's `quotesNormalised`. Nothing else is relaxed (case, words,
// ellipses).
export const typo = t => String(t ?? '').replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
  .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-').replace(/[\s\u00A0\u2007\u2009\u202F]+/g, ' ').trim();
export function reverifyQuotes(flags, paragraphs) {
  let n = 0; const norm = new Map([...paragraphs].map(([id, t]) => [id, typo(t)]));
  for (const f of flags) for (const e of f.evidence || []) {
    const q = typo(e.quote); if (e.verified !== false || !q) continue;
    const hay = e.paragraphId && norm.has(e.paragraphId) ? [norm.get(e.paragraphId)] : e.paragraphId ? [] : [...norm.values()];
    if (hay.some(t => t.includes(q))) { e.verified = true; e.verifiedBy = 'tough-eval typography normalisation'; n++; }
  }
  return n;
}
// The Cover Page consequence (fix 2, 17 October 2026): a plant that edits the attached Standard Terms of the NDA makes the
// Cover Page lines "Changes to Standard Terms: None" (p10) and "Neither party has changed the Standard Terms" (p12)
// untrue, and a reviewer who says so is right. Such plants carry `secondaryTargets` (v2/lib/store.mjs plantOf): a flag
// sitting on a secondary target is neither a false alarm nor a flag on a benign edit, and it does not locate or catch.
const onSecondary = (f, ids) => ids.length > 0 && ids.includes(f.paragraphId);

export function scoreRun(runDir, { suite: suiteName = null } = {}) {
  const meta = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  const sname = suiteName || suiteOfRun(meta); const suite = suiteNamed(sname); const v2 = isV2(sname);
  const plants = []; const docs = []; let failed = 0, stale = 0;
  const ranWith = Object.fromEntries((meta.variants || []).map(v => [v.id, v.sha256]));
  for (const v of suite.variants) {
    const file = path.join(runDir, 'results', `${v.id}.json`); if (!existsSync(file)) continue;
    if (ranWith[v.id] && ranWith[v.id] !== v.sha256) { stale++; continue; } // the variant changed after this run: not comparable
    const r = JSON.parse(readFileSync(file, 'utf8')); if (!r.ok) failed++;
    const flags = r.ok ? r.findings.filter(flag) : []; // a failed review found nothing
    const current = new Map(JSON.parse(readFileSync(path.join(here, v.file), 'utf8')).paragraphs.map(p => [p.id, p.text]));
    const quotesNormalised = v2 && !isPrelimSuite(sname) ? reverifyQuotes(flags, current) : 0; // the preliminary item set is scored as it was
    const secondary = v2 ? [...new Set(v.plants.flatMap(p => p.secondaryTargets || []))] : [];
    const unverifiable = flags.filter(f => (f.evidence || []).some(e => e.verified === false && String(e.quote || '').trim())).length;
    const unknownRules = flags.filter(f => (f.unknownRuleIds || []).length).length; // cites a playbook entry that does not exist
    const unanchored = flags.filter(f => f.anchored === false).length; // names a paragraph the document does not have
    const hallucinations = flags.flatMap(f => [...(f.evidence || []).filter(e => e.verified === false && String(e.quote || '').trim()).map(e => ({ variant: v.id, paragraphId: f.paragraphId, kind: 'quote', value: e.quote })),
      ...(f.unknownRuleIds || []).map(id => ({ variant: v.id, paragraphId: f.paragraphId, kind: 'rule', value: id })), ...(v2 && f.anchored === false ? [{ variant: v.id, paragraphId: f.paragraphId, kind: 'paragraph', value: f.paragraphId }] : [])]);
    const deviationTargets = v.plants.filter(p => p.kind === 'deviation').flatMap(p => p.targets);
    for (const p of v.plants) {
      const on = flags.filter(f => p.kind === 'benign' && !v2 ? p.targets.includes(f.paragraphId) : touches(f, p.targets) && !(p.kind === 'benign' && onSecondary(f, secondary)));
      const located = on.length > 0, caught = on.some(f => (f.ruleIds || []).some(id => p.rules.includes(id)));
      const byCheck = p.fixes && p.fixes.every(f => f.check || (v2 && f.inserted));
      plants.push({ variant: v.id, plant: p.id, kind: p.kind, level: p.level, multi: v.plants.length > 1, markup: isMarkup(v.id), bundle: v.base !== 'base.json', located, caught, flagged: located, restored: p.fixes ? caught && fixed(flags, p) : null, fixed: byCheck ? caught && compliantFix(flags, p) : (p.fixes ? caught && fixed(flags, p) : null),
        ...(v2 ? { family: p.family ?? null, rule: p.rules[0], author: v.itemAuthor || v.author || null, side: v.side || null, document: v.document || null, status: v.status || null, ...(v.scenario ? { scenario: v.id, itemId: v.itemId } : {}) } : {}) });
      const last = plants[plants.length - 1]; last.excess = p.kind === 'deviation' && last.fixed ? excessWords(flags, p, current, suite.baseText(v.base)) : null;
    }
    const benignTargets = v.plants.filter(p => p.kind === 'benign').flatMap(p => p.targets);
    const falseAlarms = flags.filter(f => (f.ruleIds || []).length && !touches(f, deviationTargets) && !(benignTargets.length && touches(f, benignTargets)) && !onSecondary(f, secondary));
    const secondaryFlags = flags.filter(f => onSecondary(f, secondary) && !touches(f, deviationTargets)).length;
    const mine = plants.filter(p => p.variant === v.id);
    const allPassUngated = r.ok && mine.every(p => p.kind === 'benign' ? !p.flagged : p.caught && p.fixed !== false) && falseAlarms.length === 0;
    const allPass = allPassUngated && unverifiable === 0 && unknownRules === 0 && (!v2 || unanchored === 0);
    docs.push({ variant: v.id, ok: !!r.ok, allPass, allPassUngated, unverifiable, unknownRules, ...(v2 ? { unanchored, quotesNormalised, secondaryFlags } : {}), hallucinations, errorClass: classOf(r), attempts: attemptsFor(runDir, v.id),
      ...(v2 ? { markup: !!v.markup, author: v.author || null, side: v.side || null, document: v.document || null, status: v.status || null, agentic: !!r.agentic, toolCalls: Array.isArray(r.tools) ? r.tools.length : (r.model?.toolCalls ?? null), servedModel: r.servedModel ?? null } : {}), findings: r.ok ? r.findings.length : 0, flags: flags.length, falseAlarms: falseAlarms.length, falseAlarmRules: falseAlarms.flatMap(f => f.ruleIds), falseAlarmParagraphs: falseAlarms.map(f => f.paragraphId), ms: r.ms, cost: r.model?.usage?.total_cost_usd ?? r.model?.costUsd ?? null });
  }
  for (const p of plants) if (typeof p.excess === 'number') p.surgicalFlag = p.excess <= 5;
  const dev = plants.filter(p => p.kind === 'deviation'), ben = plants.filter(p => p.kind === 'benign');
  const rate = (xs, k) => xs.length ? +(xs.filter(x => x[k]).length / xs.length).toFixed(3) : null;
  const byLevel = Object.fromEntries(['easy', 'medium', 'hard'].map(l => [l, rate(dev.filter(p => p.level === l), 'caught')]));
  const clean = docs.find(d => d.variant === 'C00');
  const usable = docs.filter(d => d.ok);
  const summary = { run: path.basename(runDir), suite: sname, setup: meta.setup ?? null, test: meta.test ?? null, model: meta.model, effort: meta.effort, scored: docs.length, usable: usable.length, failed, stale,
    reliability: docs.length ? +(usable.length / docs.length).toFixed(3) : null,
    // Agreements with at least one quote not found in the document or a rule that is not in the playbook (the
    // hallucination gate), over usable reviews.
    hallucinated: usable.length ? +(usable.filter(d => d.unverifiable > 0 || d.unknownRules > 0 || d.unanchored > 0).length / usable.length).toFixed(3) : null,
    allPassUngated: rate(docs, 'allPassUngated'),
    caught: rate(dev, 'caught'), located: rate(dev, 'located'), restored: dev.some(p => p.restored !== null) ? rate(dev, 'restored') : null, fixed: dev.some(p => p.fixed !== null) ? rate(dev, 'fixed') : null, byLevel, markupCaught: rate(dev.filter(p => p.markup), 'caught'), markupFixed: dev.some(p => p.markup && p.fixed !== null) ? rate(dev.filter(p => p.markup), 'fixed') : null, multiCaught: rate(dev.filter(p => p.multi), 'caught'), singleCaught: rate(dev.filter(p => !p.multi), 'caught'),
    benignFlagged: rate(ben, 'flagged'), allPass: rate(docs, 'allPass'),
    surgical: dev.some(p => p.excess !== null && p.excess !== undefined) ? rate(dev.filter(p => typeof p.excess === 'number'), 'surgicalFlag') : null,
    medianExcessWords: (() => { const e = dev.map(p => p.excess).filter(x => typeof x === 'number').sort((a, b) => a - b); return e.length ? e[Math.floor(e.length / 2)] : null; })(), falseAlarmsPerDoc: usable.length ? +(usable.reduce((n, d) => n + d.falseAlarms, 0) / usable.length).toFixed(2) : null, cleanFalseAlarms: clean ? clean.falseAlarms : null, bundleCleanFalseAlarms: docs.find(d => d.variant === 'B00')?.falseAlarms ?? null,
    // Long bundle: annex plants, and the agreement plants that also run inside the bundle (same plant, short and long).
    bundleCaught: rate(dev.filter(p => p.bundle), 'caught'), bundleFixed: dev.some(p => p.bundle && p.fixed !== null) ? rate(dev.filter(p => p.bundle), 'fixed') : null,
    lengthPaired: (() => { const long = dev.filter(p => /^BL/.test(p.variant)); const short = long.map(l => dev.find(p => p.variant === l.plant && p.plant === l.plant)).filter(Boolean);
      return long.length && short.length ? { pairs: short.length, shortFixed: rate(short, 'fixed'), longFixed: rate(long.filter(l => short.some(s => s.plant === l.plant)), 'fixed') } : null; })(),
    medianSeconds: usable.length ? Math.round(usable.map(d => d.ms).sort((a, b) => a - b)[Math.floor(usable.length / 2)] / 1000) : null };
  return { summary, plants, docs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const si = argv.indexOf('--suite'); const forced = si >= 0 ? argv.splice(si, 2)[1] : null;
  const runs = argv.map(d => path.resolve(d)); if (!runs.length) { console.error('Usage: node tough-eval/score.mjs [--suite <name>] <runDir> ...'); process.exit(2); }
  const scored = runs.map(d => scoreRun(d, { suite: forced }));
  for (const s of scored) writeFileSync(path.join(runs[scored.indexOf(s)], 'score.json'), JSON.stringify(s, null, 1));
  console.table(scored.map(s => ({ run: s.summary.run.slice(20), caught: s.summary.caught, fixed: s.summary.fixed, restored: s.summary.restored, mkCaught: s.summary.markupCaught, mkFixed: s.summary.markupFixed, located: s.summary.located, easy: s.summary.byLevel.easy, medium: s.summary.byLevel.medium, hard: s.summary.byLevel.hard, multi: s.summary.multiCaught, benignFlagged: s.summary.benignFlagged, allPass: s.summary.allPass, ungated: s.summary.allPassUngated, halluc: s.summary.hallucinated, surgical: s.summary.surgical, bundle: s.summary.bundleCaught, FA_doc: s.summary.falseAlarmsPerDoc, FA_clean: s.summary.cleanFalseAlarms, n: s.summary.scored, failed: s.summary.failed, rel: s.summary.reliability, stale: s.summary.stale, sec: s.summary.medianSeconds })));
  if (scored.length > 1) {
    // Item analysis: which plants separate the runs, and which every run passes or fails (no information).
    const keys = [...new Set(scored.flatMap(s => s.plants.map(p => `${p.variant}/${p.plant}`)))];
    const rows = keys.map(k => { const row = { item: k }; let n = 0, c = 0; for (const s of scored) { const p = s.plants.find(x => `${x.variant}/${x.plant}` === k); const v = p ? (p.kind === 'benign' ? (p.flagged ? 'FA' : '.') : (p.caught ? 'Y' : p.located ? 'l' : '-')) : ' '; row[s.summary.run.slice(20, 44)] = v; if (p && p.kind !== 'benign') { n++; if (p.caught) c++; } } row.rate = n ? +(c / n).toFixed(2) : ''; return row; });
    console.table(rows);
    const dev = rows.filter(r => r.rate !== '');
    console.log(`items caught by every run: ${dev.filter(r => r.rate === 1).length}; by no run: ${dev.filter(r => r.rate === 0).length}; discriminating: ${dev.filter(r => r.rate > 0 && r.rate < 1).length} of ${dev.length}`);
  }
}
