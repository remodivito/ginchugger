// SPDX-License-Identifier: GPL-3.0-or-later
// Recorded model outputs for the dry run: for every variant of a suite, a folder <out>/<variant id>/ holding
// review.raw.txt (a synthetic reviewer's answer in the model's own JSON shape) and, for layer H, review.tools.jsonl (one
// recorded tool call), so `run.mjs --executor replay --replay-dir <out>` drives the product's whole review path
// (validation, quote checks, the agentic path over the seeded document store, store-citation checks, traces) with no model.
// Reviewers: oracle (right on everything), partial (the oracle missing every other deviation), own:<author> (the
// oracle on that author's items and markups, silent elsewhere: a self-advantage for by-author.mjs to find), sycophant (layer H:
// accepts the concession, follows the injection, cites another counterparty's document as this one's), malformed (not
// JSON: exercises the retry policy). Only for the synthetic fixture and the dry run.
// Usage: node tough-eval/v2/fixtures/write-replay.mjs --suite v2a-fixture|v2h-fixture --reviewer <name> --out <dir>
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSuite } from '../../suite.mjs';
import { syntheticH } from '../score-h.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const TE = path.resolve(here, '../..');
const argv = process.argv.slice(2); const opt = k => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : argv[i + 1]; };
const suiteName = opt('suite'), reviewer = opt('reviewer'), out = path.resolve(opt('out'));
const suite = loadSuite(suiteName); const H = suiteName.startsWith('v2h');
const textOf = v => new Map(JSON.parse(readFileSync(path.join(TE, v.file), 'utf8')).paragraphs.map(p => [p.id, p.text]));
// The model's answer shape (prompts/review.md): evidence quotes are exact text of the current document.
const asRaw = (v, findings) => { const t = textOf(v); return { findings: findings.map(f => ({ title: f.title || 'Departure from the playbook', explanation: f.explanation || 'Departs from the playbook.', ...f, evidence: [{ paragraphId: f.paragraphId, quote: (t.get(f.paragraphId) || '').slice(0, 60) }] })), limits: [] }; };
const oracleA = v => v.plants.filter(p => p.kind === 'deviation').flatMap(p => p.targets.map(t => { const fix = (p.fixes || []).find(f => f.paragraph === t);
  return { paragraphId: t, status: 'attention', decision: 'counter', ruleIds: [p.rules[0]], ...(fix?.inserted ? { proposedText: '' } : { proposedText: suite.baseText(v.base).get(t) }) }; }));
const hArms = H ? syntheticH(suiteName) : null;
let n = 0;
for (const v of suite.variants) {
  const dir = path.join(out, v.id); mkdirSync(dir, { recursive: true }); n++;
  if (reviewer === 'malformed') { writeFileSync(path.join(dir, 'review.raw.txt'), 'I could not produce JSON this time.'); continue; }
  let findings;
  if (H) findings = await (hArms[reviewer] || hArms.oracle)(v);
  else if (reviewer === 'partial') findings = oracleA(v).filter((_, i) => i % 2 === 1);
  else if (reviewer.startsWith('own:')) findings = v.author === reviewer.slice(4) || v.markup ? oracleA(v) : []; // catches only one author's items
  else findings = oracleA(v);
  // Store citations travel in the raw answer exactly as a model writes them; review.js verifies them against the store.
  writeFileSync(path.join(dir, 'review.raw.txt'), JSON.stringify(asRaw(v, findings)));
  writeFileSync(path.join(dir, 'review.tools.jsonl'), JSON.stringify({ n: 1, name: 'get_counterparty_overview', args: {}, bytes: 40, result: { notice: 'recorded for the dry run' } }) + '\n');
}
console.log(`${n} recordings (${reviewer}) for ${suiteName} in ${out}`);
