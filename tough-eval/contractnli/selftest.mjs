// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic reviewers against the gold labels, to check the scorer before any model runs: an oracle must score 1; a
// silent reviewer catches nothing; a flag-everything reviewer catches everything but raises false alarms on every
// silent-ok pair and locates nothing; a reviewer that quotes words not in the document fails all-pass on every document
// with a departure however right its flags are; a reviewer that cites the wrong paragraph locates nothing.
// Usage: node tough-eval/contractnli/selftest.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, verdictOf } from './rules.mjs';
import { scoreRun } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const split = JSON.parse(readFileSync(path.join(here, 'split.json'), 'utf8'));
const dev = manifest.variants.filter(v => split.development.includes(v.id));
const tmp = path.join(here, 'runs-selftest'); rmSync(tmp, { recursive: true, force: true });

function write(name, make) {
  const dir = path.join(tmp, name); mkdirSync(path.join(dir, 'results'), { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ model: name, effort: 'n/a', variants: dev.map(v => ({ id: v.id, sha256: v.sha256 })) }));
  for (const v of dev) {
    const doc = JSON.parse(readFileSync(path.join(here, 'variants', `${v.id}.json`), 'utf8'));
    const text = Object.fromEntries(doc.paragraphs.map(p => [p.id, p.text]));
    writeFileSync(path.join(dir, 'results', `${v.id}.json`), JSON.stringify({ ok: true, ms: 1000, findings: make(v, text) }));
  }
  return dir;
}
const finding = (rule, status, pid, quote) => ({ paragraphId: pid, status, decision: status === 'attention' ? 'reject' : 'none', ruleIds: [rule], evidence: pid ? [{ paragraphId: pid, quote, verified: true }] : [] });
const oracle = (v, text) => Object.entries(v.gold).flatMap(([rule, g]) => { const verdict = verdictOf(rule, g.choice); if (verdict === 'silent') return []; const pid = g.spans[0]; return [finding(rule, verdict === 'departs' ? 'attention' : 'within-guidance', pid, text[pid]?.slice(0, 40) || '')]; });
const runs = {
  oracle: write('oracle', oracle),
  silent: write('silent', () => []),
  everything: write('everything', (v, text) => Object.keys(RULES).map(rule => finding(rule, 'attention', 's0', text.s0?.slice(0, 20) || ''))),
  inventor: write('inventor', (v, text) => oracle(v, text).map(f => f.status === 'attention' ? { ...f, evidence: [{ paragraphId: f.paragraphId, quote: 'words that are not in the document', verified: false }] } : f)),
  misplaced: write('misplaced', (v, text) => oracle(v, text).map(f => ({ ...f, paragraphId: 's0', evidence: [{ paragraphId: 's0', quote: text.s0?.slice(0, 20) || '', verified: true }] }))),
};
const s = Object.fromEntries(Object.entries(runs).map(([k, d]) => [k, scoreRun(d).summary]));
let ok = true; const expect = (c, m) => { if (!c) { ok = false; console.error('FAIL', m); } };
const noDeparture = +(dev.filter(v => !Object.entries(v.gold).some(([r, g]) => verdictOf(r, g.choice) === 'departs')).length / dev.length).toFixed(3);
const silentOkPairs = dev.reduce((n, v) => n + Object.entries(v.gold).filter(([r, g]) => g.choice === 'NotMentioned' && RULES[r].silentOk).length, 0);
expect(s.oracle.caught === 1 && s.oracle.located === 1 && s.oracle.allPass === 1 && s.oracle.falseAlarmsPerDoc === 0 && s.oracle.agreementOnLabelled === 1, `oracle ${JSON.stringify(s.oracle)}`);
expect(s.silent.caught === 0 && s.silent.allPass === noDeparture, `silent caught ${s.silent.caught} all-pass ${s.silent.allPass} want ${noDeparture}`);
expect(s.everything.caught === 1 && s.everything.located === 0 && s.everything.allPass === 0 && Math.abs(s.everything.falseAlarmsPerDoc - silentOkPairs / dev.length) < 0.01, `everything ${JSON.stringify([s.everything.caught, s.everything.located, s.everything.allPass, s.everything.falseAlarmsPerDoc, silentOkPairs / dev.length])}`);
expect(s.inventor.caught === 1 && s.inventor.allPass === noDeparture && s.inventor.hallucinated === +(1 - noDeparture).toFixed(3), `inventor ${JSON.stringify([s.inventor.caught, s.inventor.allPass, s.inventor.hallucinated])}, want all-pass ${noDeparture}`);
expect(s.misplaced.caught === 1 && s.misplaced.located === 0 && s.misplaced.allPass === noDeparture, `misplaced ${JSON.stringify([s.misplaced.caught, s.misplaced.located, s.misplaced.allPass])}, want all-pass ${noDeparture}`);
console.table(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { caught: v.caught, located: v.located, FA_doc: v.falseAlarmsPerDoc, stricter: v.stricterPerDoc, omission: v.omissionFlagsPerDoc, agree: v.agreementOnLabelled, halluc: v.hallucinated, allPass: v.allPass }])));
rmSync(tmp, { recursive: true, force: true });
console.log(ok ? 'contractnli selftest passed' : 'contractnli selftest FAILED'); process.exit(ok ? 0 : 1);
