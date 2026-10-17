// SPDX-License-Identifier: GPL-3.0-or-later
// Compares configurations across repeated runs, with the noise measured. A configuration is model + effort + control
// (+ arm, when a run's manifest names one); give it several run directories and it is scored as repeats.
//
// Per configuration (mean ± standard deviation across its runs):
//   caught, fixed, all-pass (strict per agreement, hallucination-gated; failed reviews count as agreements with nothing
//   found, see score.mjs), its worst run ("allPass min": a lawyer meets the bad run too), agreements with an
//   unverifiable quote, reviews that failed, false alarms per agreement, benign edits flagged, surgical fixes
//   pass^k   deviations caught and fixed in every run (consistency; Anthropic's agent-evals guide)
//   pass@k   deviations caught and fixed in at least one run
// Paired comparison of each configuration against the reference (default: the first):
//   per agreement, average each measure over the configuration's runs; bootstrap the difference by resampling whole
//   agreements (plants in one markup are not independent), 4,000 resamples, 95% interval. A difference "separates" only
//   if the interval excludes zero AND it exceeds the run-to-run spread of the reference.
// v2 (BENCHMARK-V2.md 11.3, 15): --suite v2a|v2a-fixture (or the suite in the runs' manifests) has no split: every
//   variant is test and is scored only with --final. The paired comparison gains `caught` (the miss rate's complement).
//   With one run per configuration (the test set) "separates" means only that the interval excludes zero. Each
//   configuration's error profile (v2/profile.mjs: miss rate with its one-sided 95% upper bound in words, and the rest of
//   section 16) is printed for v2 suites, or with --profile. A configuration also includes --setup, agentic and executor.
// Usage: node tough-eval/compare.mjs [--suite <name>] [--split development|heldout|all] [--final] [--profile] [--reference <config>] <runDir> ...
//   The held-out variants are scored only with --final, which is meant to be used once, for the final comparison.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scoreRun } from './score.mjs';
import { loadSuite, isV2, suiteOfRun } from './suite.mjs';
import { profileA, profileLines } from './v2/profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
// Flags (--final, --profile) take no value: before 15 Oct `--final <runDir>` swallowed the first run directory.
const opt = (k, flag = false) => { const i = argv.indexOf(`--${k}`); if (i < 0) return null; if (flag) { argv.splice(i, 1); return true; } const v = argv[i + 1]; argv.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const suiteArg = opt('suite'); let splitName = opt('split') || null; const final = !!opt('final', true); const reference = opt('reference'); const showProfile = !!opt('profile', true);
const runs = argv.map(d => path.resolve(d)).filter(d => existsSync(path.join(d, 'manifest.json')));
if (!runs.length) { console.error('Usage: node tough-eval/compare.mjs [--suite <name>] [--split development|heldout|all] [--final] [--profile] [--reference <config>] <runDir> ...'); process.exit(2); }
const suiteName = suiteArg || suiteOfRun(JSON.parse(readFileSync(path.join(runs[0], 'manifest.json'), 'utf8'))); const v2 = isV2(suiteName);
if (v2) splitName = 'all'; else splitName ||= 'development';
if (splitName === 'heldout' || splitName === 'all') { if (!final) { console.error(v2 ? `Suite ${suiteName} is all test items: scored only with --final.` : 'The held-out variants are scored only with --final (once, for the final comparison).'); process.exit(2); } }
const splitFile = v2 ? null : path.join(here, 'split.json');
const split = v2 ? null : JSON.parse(readFileSync(splitFile, 'utf8'));
const keep = new Set(v2 ? loadSuite(suiteName).variants.map(v => v.id) : splitName === 'heldout' ? split.heldout : splitName === 'all' ? [...split.heldout, ...split.development] : split.development);

// Score each run on the chosen split only.
const configs = new Map();
for (const dir of runs) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const key = [meta.setup, meta.model, meta.effort, meta.executor === 'replay' ? 'replay' : null, meta.arm ? meta.arm + (meta.workerModel ? `+${meta.workerModel}` : '') : meta.agentic ? `agentic (${meta.agenticRecord || 'record'})` : 'single-call', meta.reviewPrompt ? `prompt:${path.basename(meta.reviewPrompt, '.md')}` : null, meta.playbookOverride ? `playbook:${path.basename(meta.playbookOverride, '.json')}` : null, meta.control].filter(Boolean).join(' / ');
  const s = scoreRun(dir, { suite: suiteName });
  const plants = s.plants.filter(p => keep.has(p.variant)), docs = s.docs.filter(d => keep.has(d.variant));
  if (!configs.has(key)) configs.set(key, []);
  configs.get(key).push({ dir, plants, docs });
}

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sd = xs => xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)) : null;
const ok = p => p.caught && p.fixed !== false;
// Per-run measures from that run's plants and agreements.
function measures(run) {
  const dev = run.plants.filter(p => p.kind === 'deviation'), ben = run.plants.filter(p => p.kind === 'benign');
  const frac = (xs, f) => xs.length ? xs.filter(f).length / xs.length : null;
  const ex = dev.filter(p => typeof p.excess === 'number');
  const usable = run.docs.filter(d => d.ok);
  return {
    caught: frac(dev, p => p.caught), fixed: frac(dev, ok), allPass: frac(run.docs, d => d.allPass),
    hallucinated: frac(usable, d => d.unverifiable > 0 || d.unknownRules > 0), failed: frac(run.docs, d => !d.ok),
    falseAlarms: usable.length ? mean(usable.map(d => d.falseAlarms)) : null, benignFlagged: frac(ben, p => p.flagged),
    surgical: ex.length ? frac(ex, p => p.excess <= 5) : null,
  };
}
const METRICS = ['caught', 'fixed', 'allPass', 'hallucinated', 'failed', 'falseAlarms', 'benignFlagged', 'surgical'];
const fmt = (m, s) => m === null ? '' : `${m.toFixed(3)}${s !== null && s !== undefined ? ` ±${s.toFixed(3)}` : ''}`;

const table = {};
for (const [key, rs] of configs) {
  const ms = rs.map(measures); const row = { runs: rs.length };
  for (const k of METRICS) { const xs = ms.map(m => m[k]).filter(x => x !== null); row[k] = fmt(mean(xs), sd(xs)); if (k === 'allPass') row['allPass min'] = xs.length > 1 ? Math.min(...xs).toFixed(3) : ''; }
  // Consistency over the deviation items every run of this configuration scored.
  const items = new Map();
  for (const r of rs) for (const p of r.plants.filter(p => p.kind === 'deviation')) { const id = `${p.variant}/${p.plant}`; (items.get(id) || items.set(id, []).get(id)).push(ok(p)); }
  const full = [...items.values()].filter(v => v.length === rs.length);
  row['pass^k'] = full.length ? (full.filter(v => v.every(Boolean)).length / full.length).toFixed(3) : '';
  row['pass@k'] = full.length ? (full.filter(v => v.some(Boolean)).length / full.length).toFixed(3) : '';
  row.agreements = rs[0].docs.length;
  table[key] = row;
}
console.log(v2 ? `suite: ${suiteName} (${keep.size} variants, all test)` : `split: ${splitName} (${keep.size} variants; split.json sha256 ${createHash('sha256').update(readFileSync(splitFile)).digest('hex').slice(0, 12)})`);
console.table(table);

// Paired, agreement-clustered bootstrap of each configuration against the reference.
const keys = [...configs.keys()]; const ref = reference && configs.has(reference) ? reference : keys[0];
if (keys.length > 1) {
  // Per agreement, per configuration: deviations fixed (count), deviations (count), false alarms, all-pass; averaged over runs.
  const perDoc = key => { const out = new Map(); const rs = configs.get(key);
    for (const r of rs) for (const d of r.docs) {
      const dev = r.plants.filter(p => p.variant === d.variant && p.kind === 'deviation');
      const o = out.get(d.variant) || { caught: 0, fixed: 0, n: dev.length, fa: 0, pass: 0, k: 0 };
      o.caught += dev.filter(p => p.caught).length; o.fixed += dev.filter(ok).length; o.fa += d.falseAlarms; o.pass += d.allPass ? 1 : 0; o.k++; out.set(d.variant, o);
    }
    for (const o of out.values()) { o.caught /= o.k; o.fixed /= o.k; o.fa /= o.k; o.pass /= o.k; }
    return out; };
  const A = perDoc(ref);
  let seed = 20261010; const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const refSpread = Object.fromEntries(['caught', 'fixed', 'falseAlarms', 'allPass'].map(k => [k, sd(configs.get(ref).map(measures).map(m => m[k]).filter(x => x !== null))]));
  const rows = {};
  for (const key of keys.filter(k => k !== ref)) {
    const B = perDoc(key); const shared = [...A.keys()].filter(v => B.has(v));
    const stat = sample => { let ca = 0, cb = 0, fa = 0, fb = 0, n = 0, faA = 0, faB = 0, pa = 0, pb = 0;
      for (const v of sample) { const a = A.get(v), b = B.get(v); ca += a.caught; cb += b.caught; fa += a.fixed; fb += b.fixed; n += a.n; faA += a.fa; faB += b.fa; pa += a.pass; pb += b.pass; }
      return { caught: n ? (cb - ca) / n : 0, fixed: n ? (fb - fa) / n : 0, falseAlarms: (faB - faA) / sample.length, allPass: (pb - pa) / sample.length }; };
    const point = stat(shared); const boots = { caught: [], fixed: [], falseAlarms: [], allPass: [] };
    for (let i = 0; i < 4000; i++) { const s = shared.map(() => shared[Math.floor(rand() * shared.length)]); const b = stat(s); for (const k in boots) boots[k].push(b[k]); }
    const row = { agreements: shared.length };
    for (const k of Object.keys(boots)) {
      const xs = boots[k].sort((a, b) => a - b); const lo = xs[Math.floor(0.025 * xs.length)], hi = xs[Math.floor(0.975 * xs.length)];
      const separates = (lo > 0 || hi < 0) && (refSpread[k] === null || Math.abs(point[k]) > refSpread[k]);
      row[`Δ${k}`] = `${point[k] >= 0 ? '+' : ''}${point[k].toFixed(3)} [${lo.toFixed(3)}, ${hi.toFixed(3)}]${separates ? ' *' : ''}`;
    }
    rows[key] = row;
  }
  console.log(`\npaired against: ${ref}   (Δ = configuration minus reference; [95% bootstrap over agreements]; * = separates: interval excludes 0 and the difference exceeds the reference's run-to-run spread${Object.values(refSpread).every(x => x === null) ? ' — not measured, the reference has one run' : ''})`);
  console.table(rows);
}

// The error profile of each configuration (section 16), from its first run (the test set has one run per setup).
if (v2 || showProfile) {
  console.log('\nerror profile (95% intervals; the miss rate\'s bound is the one-sided upper limit, stated in words):');
  for (const [key, rs] of configs) { const p = profileA(rs[0].dir); console.log(['', `[${key}]${rs.length > 1 ? ` (first of ${rs.length} runs)` : ''}`, ...profileLines(p)].join('\n')); }
}
