// SPDX-License-Identifier: GPL-3.0-or-later
// The trivial baselines (BENCHMARK-V2.md section 9, P21): runs with no model, scored by the same scorers, so every
// measure has its floor and its ceiling of noise.
//   silent          no findings
//   everything      every paragraph flagged under every rule, quoting the paragraph whole (so the gate passes and the
//                   cost shows up as false alarms), no proposed wording
//   local-rules     the v1 rule engine (baselines/local-rules.mjs, the product's former Sample mode)
// Each is written as an ordinary run directory (manifest with `baseline`, results/<variant>.json) on any layer:
//   A  suite v2a (or v2a-fixture): every variant;   B  ContractNLI: the test split;   H  suite v2h (or v2h-fixture).
// Findings pass through the product's own validateFindings, so quotes are verified exactly as in a review.
// Usage: node tough-eval/v2/baselines.mjs [--layers A,B,H] [--baselines silent,everything,local-rules] [--fixture] [--out <dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFindings } from '../../contract-review/server/review.js';
import { reviewLocal } from '../baselines/local-rules.mjs';
import { loadSuite } from '../suite.mjs';
import { stripCanary } from './canary.mjs';
import { checkFrozen } from './check-frozen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const TE = path.resolve(here, '..');
const sha = s => createHash('sha256').update(s).digest('hex');
export const BASELINES = {
  silent: () => ({ findings: [], limits: [] }),
  everything: ({ document, playbook }) => {
    const ids = playbook.rules.filter(r => r.enabled !== false).map(r => r.id);
    const raw = { findings: document.paragraphs.filter(p => p.text.trim()).map(p => ({ paragraphId: p.id, title: 'Flagged', status: 'attention', decision: 'counter', explanation: 'Flag-everything baseline.', evidence: [{ paragraphId: p.id, quote: p.text }], ruleIds: ids })), limits: [] };
    const v = validateFindings(raw, document, playbook); return { findings: v.findings, limits: v.limits };
  },
  'local-rules': ({ document, playbook }) => { const r = reviewLocal({ document, playbook }); return { findings: r.findings, limits: r.limits }; },
};

export function writeBaselineRun({ baseline, suiteName, outRoot, stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z' }) {
  const suite = loadSuite(suiteName);
  const split = suite.split ? JSON.parse(readFileSync(path.join(TE, suite.split), 'utf8')) : null;
  const variants = split ? suite.variants.filter(v => split.heldout.includes(v.id)) : suite.variants;
  const dir = path.join(outRoot, `${stamp}-baseline-${baseline}-${suiteName}`); if (existsSync(dir)) throw Error(`${dir} exists`);
  mkdirSync(path.join(dir, 'results'), { recursive: true });
  const frozen = checkFrozen({ requireTag: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ startedAt: new Date().toISOString(), suiteName, suite: suite.version, baseline, setup: `baseline-${baseline}`, model: `baseline:${baseline}`, effort: null, executor: 'baseline (no model)',
    frozenTag: frozen.tag, frozenSha256: frozen.frozenSha256, test: frozen.ok, reviewMode: 'third-party', variants: variants.map(v => ({ id: v.id, sha256: v.sha256, playbook: v.playbook })) }, null, 1));
  const make = BASELINES[baseline]; if (!make) throw Error(`unknown baseline ${baseline}; known: ${Object.keys(BASELINES).join(', ')}`);
  for (const v of variants) {
    const document = stripCanary(JSON.parse(readFileSync(path.join(TE, v.file), 'utf8'))); const playbook = stripCanary(JSON.parse(readFileSync(path.join(TE, v.playbook), 'utf8')));
    const t = Date.now(); const r = make({ document, playbook });
    writeFileSync(path.join(dir, 'results', `${v.id}.json`), JSON.stringify({ ok: true, ms: Date.now() - t, model: { executor: 'baseline', baseline }, errorClass: null, innerRetries: null, findings: r.findings, limits: r.limits }, null, 1));
  }
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); m.finishedAt = new Date().toISOString(); writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
  return { dir, variants: variants.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
  const fixture = !!opt('fixture'); const out = path.resolve(opt('out', path.join(TE, 'runs')));
  const suites = { A: fixture ? 'v2a-fixture' : 'v2a', B: 'contractnli', H: fixture ? 'v2h-fixture' : 'v2h' };
  for (const layer of String(opt('layers', 'A,B,H')).split(',')) for (const b of String(opt('baselines', 'silent,everything,local-rules')).split(',')) {
    try { const r = writeBaselineRun({ baseline: b, suiteName: suites[layer], outRoot: out }); console.log(`layer ${layer} ${b}: ${r.variants} reviews -> ${r.dir}`); }
    catch (e) { console.log(`layer ${layer} ${b}: not written (${e.message})`); }
  }
}
