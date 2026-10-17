// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the scorer itself, with no model calls: synthetic runs whose right answer is known in advance.
//   oracle      flags every planted deviation, cites its rule and proposes the clean agreement's own wording (or deletes
//               an inserted clause). Must score 100% caught and fixed, no false alarms. If the clean wording fails a
//               plant's fix check, the check is wrong, not the oracle.
//   silent      returns no findings. Must score 0% caught and 0 false alarms.
//   everything  flags every paragraph citing every rule. Must catch everything, raise many false alarms, flag every
//               benign edit and pass no agreement under the strict all-pass measure.
//   restate     flags every plant with the right rule but proposes the planted wording unchanged (or keeps the inserted
//               clause). Must be caught but never fixed: a fix check that accepts the planted text cannot tell a fix
//               from no fix.
//   wrong-rule  flags the right paragraphs but cites a rule the plant does not concern. Must be located but not caught.
//   inventor    the oracle with every evidence quote replaced by words the agreement does not contain. Caught, but every
//               agreement with a deviation fails the gate (all-pass only where there was nothing to find).
//   misplaced   the oracle's flags moved to a paragraph no plant touches. Locates nothing; all-pass only where there was
//               nothing to find.
//   unanchored  the oracle plus one flag on a paragraph id the document does not have. From v2 that is an invented
//               paragraph and fails every agreement's gate; on the v1 suite it is not counted (BENCHMARK-V2.md 3.1).
// --suite v2a | v2a-fixture | v2h | v2h-fixture (default tough) scores that suite's variants (read from each `file`) and
// also runs every item's compliance check (items.json): it must pass on the reference text and on the clean paragraph
// and fail on the planted text, so every item has a working oracle before any model runs (BENCHMARK-V2.md 5.6, P5).
// Usage: node tough-eval/selftest.mjs [--suite <name>] [--keep <dir>]     (exit code 1 on any failure)
//   --keep also writes repeated synthetic runs (a reviewer that misses each deviation at random, 10% or 25% of the time,
//   three runs each) so compare.mjs can be checked for power: it should separate the two on "fixed".
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun, complies } from './score.mjs';
import { loadSuite, isV2, isPrelimSuite } from './suite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const si = process.argv.indexOf('--suite'); const suiteName = si >= 0 ? process.argv[si + 1] : 'tough'; const v2 = isV2(suiteName);
const suite = loadSuite(suiteName); const manifest = { variants: suite.variants };
const rulesOf = v => suite.playbooks[v.playbook].rules.map(r => r.id);
const byId = new Map(suite.variants.map(v => [v.id, v]));
const doc = id => JSON.parse(readFileSync(path.join(here, byId.get(id).file), 'utf8'));
const finding = (paragraphId, ruleIds, extra = {}) => ({ paragraphId, status: 'attention', decision: 'counter', ruleIds, evidence: [], ...extra });

const ARMS = {
  oracle: v => v.plants.filter(p => p.kind === 'deviation').flatMap(p => p.targets.map(t => {
    const fix = (p.fixes || []).find(f => f.paragraph === t);
    return fix?.inserted ? finding(t, [p.rules[0]], { proposedText: '', deletion: true }) : finding(t, [p.rules[0]], { proposedText: suite.baseText(v.base).get(t) ?? '' });
  })),
  silent: () => [],
  everything: v => doc(v.id).paragraphs.map(p => finding(p.id, rulesOf(v), { proposedText: p.text })),
  restate: v => { const d = new Map(doc(v.id).paragraphs.map(p => [p.id, p.text])); return v.plants.filter(p => p.kind === 'deviation').flatMap(p => p.targets.map(t => finding(t, [p.rules[0]], { proposedText: d.get(t) ?? '' }))); },
  'wrong-rule': v => v.plants.filter(p => p.kind === 'deviation').flatMap(p => p.targets.map(t => finding(t, [rulesOf(v).find(r => !p.rules.includes(r))]))),
  inventor: v => ARMS.oracle(v).map(f => ({ ...f, evidence: [{ paragraphId: f.paragraphId, quote: 'words that are not in the agreement', verified: false }] })),
  misplaced: v => { const touched = new Set(v.plants.flatMap(p => p.targets)); const away = doc(v.id).paragraphs.find(p => !touched.has(p.id)).id; return ARMS.oracle(v).map(f => ({ ...f, paragraphId: away, proposedText: undefined })); },
  unanchored: v => [...ARMS.oracle(v), finding('p9999', [], { anchored: false, title: 'a paragraph the agreement does not have' })],
  // v2 fixes of 17 October 2026. typographer: the oracle quoting each target with straight quotes and apostrophes, plain
  // hyphens and doubled spaces where the document has typographic ones, marked verified:false as review.js would; the
  // eval's normalised check must verify every one (no invented quotes). cover-page: the oracle plus a flag on every
  // secondary target (the NDA Cover Page lines a Standard Terms plant makes untrue); none is a false alarm or a benign flag.
  // accept-fixer: the oracle, but an inserted clause with an acceptCheck is rewritten to its acceptReference instead of
  // being deleted; it must still be fixed.
  typographer: v => ARMS.oracle(v).map(f => { const t = doc(v.id).paragraphs.find(p => p.id === f.paragraphId)?.text || '';
    const q = t.slice(0, 80).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/ /g, '  ');
    return { ...f, evidence: [{ paragraphId: f.paragraphId, quote: q, verified: q === t.slice(0, 80) }] }; }),
  'cover-page': v => [...ARMS.oracle(v), ...[...new Set(v.plants.flatMap(p => p.secondaryTargets || []))].map(t => finding(t, [v.plants[0].rules[0]], { title: 'Cover Page says the Standard Terms are unchanged' }))],
  'accept-fixer': v => ARMS.oracle(v).map(f => { const fix = v.plants.flatMap(p => p.fixes || []).find(x => x.paragraph === f.paragraphId && x.inserted && x.acceptCheck);
    const ref = fix && acceptRefs.get(`${v.plants.find(p => (p.fixes || []).includes(fix)).id}/${f.paragraphId}`); return ref ? { ...f, proposedText: ref, deletion: false } : f; }),
};

const acceptRefs = new Map(); try { for (const e of JSON.parse(readFileSync(path.join(here, 'v2/inserted-checks.json'), 'utf8')).checks || []) acceptRefs.set(`${e.item}/${e.paragraph}`, e.acceptReference); } catch { /* none */ }
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tough-selftest-'));
const scores = {};
for (const [arm, make] of Object.entries(ARMS)) {
  const dir = path.join(tmp, `selftest-${arm}`); mkdirSync(path.join(dir, 'results'), { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ model: `selftest-${arm}`, suiteName, effort: null, control: null, variants: manifest.variants.map(v => ({ id: v.id, sha256: v.sha256 })) }));
  for (const v of manifest.variants) writeFileSync(path.join(dir, 'results', `${v.id}.json`), JSON.stringify({ ok: true, ms: 1, findings: make(v) }));
  scores[arm] = scoreRun(dir);
}
const keepAt = process.argv.includes('--keep') ? path.resolve(process.argv[process.argv.indexOf('--keep') + 1]) : null;
if (keepAt) {
  let seed = 7; const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (const miss of [0.1, 0.25]) for (let run = 1; run <= 3; run++) {
    const dir = path.join(keepAt, `synthetic-miss${miss * 100}-run${run}`); mkdirSync(path.join(dir, 'results'), { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ model: `synthetic-miss-${miss * 100}%`, suiteName, effort: null, control: null, variants: manifest.variants.map(v => ({ id: v.id, sha256: v.sha256 })) }));
    for (const v of manifest.variants) writeFileSync(path.join(dir, 'results', `${v.id}.json`), JSON.stringify({ ok: true, ms: 1, findings: ARMS.oracle(v).filter(() => rand() >= miss) }));
  }
  console.log(`synthetic repeated runs written to ${keepAt}`);
}
rmSync(tmp, { recursive: true, force: true });

const failures = [];
const expect = (ok, what) => { if (!ok) failures.push(what); };
const s = arm => scores[arm].summary;
expect(s('oracle').caught === 1, `oracle caught ${s('oracle').caught}, want 1`);
expect(s('oracle').fixed === 1, `oracle fixed ${s('oracle').fixed}, want 1`);
const unfixable = scores.oracle.plants.filter(p => p.kind === 'deviation' && !p.fixed).map(p => `${p.variant}/${p.plant}`);
expect(!unfixable.length, `the clean agreement's own wording fails these fix checks (the check is wrong): ${[...new Set(unfixable)].join(', ')}`);
const noBenign = !manifest.variants.some(v => v.plants.some(p => p.kind === 'benign'));
expect(s('oracle').falseAlarmsPerDoc === 0 && s('oracle').benignFlagged === (noBenign ? null : 0), 'oracle raised false alarms or flagged a benign edit');
expect(s('oracle').medianExcessWords === 0, `oracle median excess words ${s('oracle').medianExcessWords}, want 0`);
expect(s('oracle').allPass === 1, `oracle all-pass ${s('oracle').allPass}, want 1`);
expect(s('silent').caught === 0 && s('silent').falseAlarmsPerDoc === 0, 'silent run scored something');
const quiet = manifest.variants.filter(v => !v.plants.some(p => p.kind === 'deviation')).length / manifest.variants.length;
expect(Math.abs(s('silent').allPass - quiet) < 0.001, `silent all-pass ${s('silent').allPass}, want ${quiet.toFixed(3)} (it passes only the agreements with nothing to find)`);
expect(s('everything').caught === 1, 'flag-everything did not catch everything');
expect(s('everything').falseAlarmsPerDoc > (v2 ? 1 : 50), `flag-everything false alarms per agreement ${s('everything').falseAlarmsPerDoc}, want > ${v2 ? 1 : 50}`);
expect(s('everything').benignFlagged === (noBenign ? null : 1), 'flag-everything did not flag every benign edit');
expect(s('everything').allPass === 0, `flag-everything all-pass ${s('everything').allPass}, want 0`);
const lax = scores.restate.plants.filter(p => p.kind === 'deviation' && p.fixed).map(p => p.plant);
expect(s('restate').caught === 1 && !lax.length, `these fix checks accept the planted wording itself: ${[...new Set(lax)].join(', ')}`);
expect(s('wrong-rule').located === 1 && s('wrong-rule').caught === 0, `wrong-rule located ${s('wrong-rule').located} caught ${s('wrong-rule').caught}, want 1 and 0`);
const withDeviation = 1 - quiet;
expect(s('inventor').caught === 1 && Math.abs(s('inventor').allPass - quiet) < 0.001 && Math.abs(s('inventor').hallucinated - withDeviation) < 0.001, `inventor caught ${s('inventor').caught} all-pass ${s('inventor').allPass} hallucinated ${s('inventor').hallucinated}, want 1, ${quiet.toFixed(3)}, ${withDeviation.toFixed(3)}`);
expect(s('misplaced').located === 0 && s('misplaced').caught === 0 && Math.abs(s('misplaced').allPass - quiet) < 0.001, `misplaced located ${s('misplaced').located} all-pass ${s('misplaced').allPass}, want 0 and ${quiet.toFixed(3)}`);
expect(s('unanchored').caught === 1 && s('unanchored').allPassUngated === 1 && s('unanchored').allPass === (v2 ? 0 : 1) && s('unanchored').hallucinated === (v2 ? 1 : 0), `unanchored all-pass ${s('unanchored').allPass} hallucinated ${s('unanchored').hallucinated}, want ${v2 ? '0 and 1 (v2 counts an invented paragraph)' : '1 and 0 (v1 does not)'}`);
expect(s('typographer').caught === 1 && (!v2 || isPrelimSuite(suiteName) || s('typographer').hallucinated === 0), `typographer hallucinated ${s('typographer').hallucinated}, want 0 (typographic quotes, dashes and spaces are normalised)`);
expect(s('cover-page').falseAlarmsPerDoc === 0 && s('cover-page').benignFlagged === (noBenign ? null : 0) && s('cover-page').allPass === 1, `cover-page false alarms ${s('cover-page').falseAlarmsPerDoc}, benign ${s('cover-page').benignFlagged}, all-pass ${s('cover-page').allPass}, want 0, 0, 1`);
expect(s('accept-fixer').fixed === 1, `accept-fixer fixed ${s('accept-fixer').fixed}, want 1 (an inserted clause brought to its acceptable wording is a fix)`);
// Every acceptCheck (v2/inserted-checks.json) fails on the planted clause and passes on its acceptReference.
if (v2) {
  let n = 0;
  for (const v of manifest.variants) for (const p of v.plants) for (const f of p.fixes || []) if (f.acceptCheck) {
    n++; const planted = doc(v.id).paragraphs.find(x => x.id === f.paragraph)?.text; const ref = acceptRefs.get(`${p.id}/${f.paragraph}`);
    expect(!complies(planted, f.acceptCheck), `${v.id}/${p.id}: acceptCheck passes on the planted clause ${f.paragraph}`);
    expect(ref && complies(ref, f.acceptCheck), `${v.id}/${p.id}: acceptCheck fails on its acceptReference`);
  }
  console.log(`inserted-clause accept checks: ${n} (over variants, markups included)`);
}
// Every item's own oracle (v2): the check passes on the reference text and on the clean paragraph, fails on the planted text.
if (v2 && suiteName.startsWith('v2h')) console.log('item checks: run under the matching v2a suite (layer H reuses its items)');
else if (v2) {
  let checked = 0;
  for (const it of (suite.items || []).filter(i => i.status !== 'dropped' && i.kind === 'deviation')) {
    const v = byId.get(it.variantId); if (!v) { failures.push(`${it.id}: no variant ${it.variantId}`); continue; }
    const base = suite.baseText(v.base); const planted = new Map(doc(v.id).paragraphs.map(p => [p.id, p.text]));
    for (const f of it.fixes || []) {
      if (f.inserted) { expect(planted.has(f.paragraph) && !base.has(f.paragraph), `${it.id}: inserted paragraph ${f.paragraph} is not new in the variant`); continue; }
      checked++;
      expect(complies(f.referenceText, f.check), `${it.id}: check fails on its reference text`);
      expect(complies(base.get(f.paragraph), f.check), `${it.id}: check fails on the clean paragraph ${f.paragraph}`);
      expect(!complies(planted.get(f.paragraph), f.check), `${it.id}: check passes on the planted text`);
    }
  }
  console.log(`item checks: ${checked} fix checks over ${(suite.items || []).filter(i => i.status !== 'dropped').length} applied items (${(suite.items || []).filter(i => i.status === 'dropped').length} dropped)`);
}

console.log(`suite ${suiteName} (${manifest.variants.length} variants)`);
console.table(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { caught: v.summary.caught, located: v.summary.located, fixed: v.summary.fixed, allPass: v.summary.allPass, ungated: v.summary.allPassUngated, halluc: v.summary.hallucinated, FA_doc: v.summary.falseAlarmsPerDoc, benignFlagged: v.summary.benignFlagged }])));
if (failures.length) { console.error('SELFTEST FAILED\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('selftest passed');
