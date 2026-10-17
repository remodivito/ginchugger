// SPDX-License-Identifier: GPL-3.0-or-later
// Scores a run on the ContractNLI layer. No judge: the dataset says, per NDA and per rule, what the contract does and
// where. What these labels can support (14 Oct calibration, see README): they are yes/no hypotheses and the playbook is
// graded, so the reviewer flags many points the labels call compliant; those disagreements are reported, not scored.
// The reviewer's finding per rule: "departs" = an "attention" finding (decision not "accept") citing the rule; otherwise
// nothing ("ok": within-guidance or no finding).
//   departures caught   gold departure (rules.mjs) with a departs finding      -> recall, the headline of this layer
//   located             a caught departure whose finding sits on a gold evidence paragraph (by id or verified quote)
//   false alarms        departs where the dataset says the contract is silent AND the playbook accepts silence
//                       (silentOk rules): the one class of flag the labels can call wrong
//   stricter than label departs where the dataset says the contract complies; reported per rule, audited by hand
//   omission flags      departs where the dataset says silent on a rule the playbook wants present; reported, unscored
//   agreement           on labelled pairs (Entailment or Contradiction), the reviewer's departs/ok against the label's
//   hallucination gate  as score.mjs: an unverifiable quote or an unknown rule ID fails the document
//   all-pass            every gold departure caught and located, no false alarm, no hallucination, review usable
//   failed reviews count as nothing found; reliability = usable / attempted
//   v2 (BENCHMARK-V2.md 3.2, 14.2), additive: per NDA `unanchored` (flags on a paragraph id the NDA does not have),
//   `allPassV2` and summary `hallucinatedV2`/`allPassV2` (the gate counting an invented paragraph, as v2 does from its
//   start; the v1 figures above are unchanged), the hallucination instances, `errorClass` and `attempts`.
//   The test split is scored only with --final (`--split heldout --final`; `test` is accepted for `heldout`).
// Usage: node tough-eval/contractnli/score.mjs [--split development|heldout|test|all] [--final] <runDir> ...
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES, verdictOf } from './rules.mjs';
import { attemptsFor, classOf } from '../v2/retry-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const split = JSON.parse(readFileSync(path.join(here, 'split.json'), 'utf8'));
const byId = Object.fromEntries(manifest.variants.map(v => [v.id, v]));
const RULE_IDS = Object.keys(RULES);
const flag = f => f.status === 'attention' && f.decision !== 'accept';
const touches = (f, ids) => ids.includes(f.paragraphId) || (f.evidence || []).some(e => e.verified && ids.includes(e.paragraphId));

export function scoreRun(runDir, splitName = 'development') {
  const meta = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  if (splitName === 'test') splitName = 'heldout';
  const keep = new Set(splitName === 'all' ? [...split.development, ...split.heldout, ...split.pool] : split[splitName]);
  const ranWith = Object.fromEntries((meta.variants || []).map(v => [v.id, v.sha256]));
  const pairs = [], docs = []; let failed = 0, stale = 0;
  for (const id of Object.keys(byId).filter(id => keep.has(id))) {
    const file = path.join(runDir, 'results', `${id}.json`); if (!existsSync(file)) continue;
    if (ranWith[id] && ranWith[id] !== byId[id].sha256) { stale++; continue; }
    const r = JSON.parse(readFileSync(file, 'utf8')); if (!r.ok) failed++;
    const findings = r.ok ? r.findings : [];
    const flags = findings.filter(flag);
    const unverifiable = flags.filter(f => (f.evidence || []).some(e => e.verified === false && String(e.quote || '').trim())).length;
    const unknownRules = flags.filter(f => (f.unknownRuleIds || []).length).length;
    const unanchored = flags.filter(f => f.anchored === false).length;
    const hallucinations = flags.flatMap(f => [...(f.evidence || []).filter(e => e.verified === false && String(e.quote || '').trim()).map(e => ({ variant: id, paragraphId: f.paragraphId, kind: 'quote', value: e.quote })), ...(f.unknownRuleIds || []).map(r => ({ variant: id, paragraphId: f.paragraphId, kind: 'rule', value: r })), ...(f.anchored === false ? [{ variant: id, paragraphId: f.paragraphId, kind: 'paragraph', value: f.paragraphId }] : [])]);
    const gold = byId[id].gold;
    let caught = 0, departures = 0, unlocated = 0, fa = 0, stricter = 0, omission = 0;
    for (const rule of RULE_IDS) {
      const g = gold[rule]; if (!g) continue;
      const gv = verdictOf(rule, g.choice);
      const on = flags.filter(f => (f.ruleIds || []).includes(rule));
      const pred = on.length ? 'departs' : 'ok';
      const located = pred === 'departs' && g.spans.length ? on.some(f => touches(f, g.spans)) : null;
      let kind = null;
      if (gv === 'departs') { departures++; if (pred === 'departs') { caught++; if (!located) unlocated++; kind = 'caught'; } else kind = 'missed'; }
      else if (pred === 'departs') { if (gv === 'silent' && RULES[rule].silentOk) { fa++; kind = 'falseAlarm'; } else if (gv === 'silent') { omission++; kind = 'omission'; } else { stricter++; kind = 'stricter'; } }
      else kind = 'agreedOk';
      pairs.push({ variant: id, rule, gold: gv, goldChoice: g.choice, pred, located, kind });
    }
    docs.push({ variant: id, ok: !!r.ok, departures, caught, unlocated, falseAlarms: fa, stricter, omission, flags: flags.length, unattributed: flags.filter(f => !(f.ruleIds || []).length).length, unverifiable, unknownRules,
      allPass: !!r.ok && caught === departures && unlocated === 0 && fa === 0 && unverifiable === 0 && unknownRules === 0, unanchored, hallucinations, errorClass: classOf(r), attempts: attemptsFor(runDir, id),
      allPassV2: !!r.ok && caught === departures && unlocated === 0 && fa === 0 && unverifiable === 0 && unknownRules === 0 && unanchored === 0, ms: r.ms, cost: r.model?.usage?.total_cost_usd ?? r.model?.costUsd ?? null });
  }
  const usable = docs.filter(d => d.ok);
  const rate = (xs, f) => xs.length ? +(xs.filter(f).length / xs.length).toFixed(3) : null;
  const dep = pairs.filter(p => p.gold === 'departs'), labelled = pairs.filter(p => p.gold !== 'silent');
  const byRule = Object.fromEntries(RULE_IDS.map(r => { const xs = pairs.filter(p => p.rule === r); const d = xs.filter(p => p.gold === 'departs');
    return [r, { departures: d.length, caught: rate(d, p => p.kind === 'caught'), located: rate(d.filter(p => p.kind === 'caught'), p => p.located), stricter: xs.filter(p => p.kind === 'stricter').length, omission: xs.filter(p => p.kind === 'omission').length, falseAlarms: xs.filter(p => p.kind === 'falseAlarm').length, agreement: rate(xs.filter(p => p.gold !== 'silent'), p => (p.pred === 'departs') === (p.gold === 'departs')) }]; }));
  const summary = { run: path.basename(runDir), model: meta.model, effort: meta.effort, split: splitName, scored: docs.length, usable: usable.length, failed, stale,
    reliability: docs.length ? +(usable.length / docs.length).toFixed(3) : null,
    departures: dep.length, caught: rate(dep, p => p.kind === 'caught'), located: rate(dep.filter(p => p.kind === 'caught'), p => p.located),
    falseAlarmsPerDoc: usable.length ? +(usable.reduce((n, d) => n + d.falseAlarms, 0) / usable.length).toFixed(2) : null,
    stricterPerDoc: usable.length ? +(usable.reduce((n, d) => n + d.stricter, 0) / usable.length).toFixed(2) : null,
    omissionFlagsPerDoc: usable.length ? +(usable.reduce((n, d) => n + d.omission, 0) / usable.length).toFixed(2) : null,
    flagsPerDoc: usable.length ? +(usable.reduce((n, d) => n + d.flags, 0) / usable.length).toFixed(1) : null,
    agreementOnLabelled: rate(labelled, p => (p.pred === 'departs') === (p.gold === 'departs')),
    hallucinated: usable.length ? rate(usable, d => d.unverifiable > 0 || d.unknownRules > 0) : null,
    allPass: rate(docs, d => d.allPass), hallucinatedV2: usable.length ? rate(usable, d => d.unverifiable > 0 || d.unknownRules > 0 || d.unanchored > 0) : null, allPassV2: rate(docs, d => d.allPassV2), byRule,
    medianSeconds: usable.length ? Math.round(usable.map(d => d.ms).sort((a, b) => a - b)[Math.floor(usable.length / 2)] / 1000) : null };
  return { summary, pairs, docs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const i = argv.indexOf('--split'); let splitName = i >= 0 ? argv.splice(i, 2)[1] : 'development'; if (splitName === 'test') splitName = 'heldout';
  const fi = argv.indexOf('--final'); const final = fi >= 0; if (final) argv.splice(fi, 1);
  if (['heldout', 'all'].includes(splitName) && !final) { console.error('The test split (heldout) is scored only with --final (BENCHMARK-V2.md P17).'); process.exit(2); }
  const runs = argv.map(d => path.resolve(d)); if (!runs.length) { console.error('Usage: node tough-eval/contractnli/score.mjs [--split development|heldout|all] <runDir> ...'); process.exit(2); }
  const scored = runs.map(d => scoreRun(d, splitName));
  for (const s of scored) writeFileSync(path.join(runs[scored.indexOf(s)], `score-${splitName}.json`), JSON.stringify(s, null, 1));
  console.table(scored.map(s => ({ run: s.summary.run.slice(20), n: s.summary.scored, failed: s.summary.failed, departures: s.summary.departures, caught: s.summary.caught, located: s.summary.located, FA_doc: s.summary.falseAlarmsPerDoc, stricter_doc: s.summary.stricterPerDoc, omission_doc: s.summary.omissionFlagsPerDoc, flags_doc: s.summary.flagsPerDoc, agreeLabelled: s.summary.agreementOnLabelled, halluc: s.summary.hallucinated, allPass: s.summary.allPass, sec: s.summary.medianSeconds })));
  if (scored.length === 1) console.table(scored[0].summary.byRule);
}
