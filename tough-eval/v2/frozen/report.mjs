// SPDX-License-Identifier: GPL-3.0-or-later
// The FROZEN layer A report (17 October 2026, tag bench-v2.0-a): scores the runs/*Z-frozen-A-* runs only, apart from the
// preliminary runs (prelim/report.mjs reads runs/*Z-prelim-* and never these), and writes v2/frozen/REPORT.md. No model
// call; safe while runs are in progress (a review without a result is not scored yet). Each run is marked test: true
// (started with run.mjs --test against the tag) or not; only test runs are frozen results.
// Columns as prelim/report.mjs layer A (profile.mjs, BENCHMARK-V2.md 3.1), plus the counts the 17 October fixes add:
// flags on the Cover Page secondary targets (not false alarms) and quotes verified only after typographic normalisation.
// Usage: node tough-eval/v2/frozen/report.mjs [--out <file>] [<runDir> ...]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileA, profileLines } from '../profile.mjs';
import { byAuthor, toMarkdown } from '../by-author.mjs';
import { scoreRun } from '../../score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const EVAL = path.resolve(HERE, '../..'); const RUNS = path.join(EVAL, 'runs');
const argv = process.argv.slice(2); const oi = argv.indexOf('--out'); const OUT = path.resolve(oi >= 0 ? argv.splice(oi, 2)[1] : path.join(HERE, 'REPORT.md'));
const j = f => JSON.parse(readFileSync(f, 'utf8'));
export const isFrozenA = d => /Z-frozen-A-/.test(path.basename(d));
const pc = x => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const frac = x => (x ? `${x.x}/${x.n}` : 'n/a');
function progress(d) {
  const m = j(path.join(d, 'manifest.json')); const r = path.join(d, 'results'); const have = existsSync(r) ? readdirSync(r).filter(f => f.endsWith('.json')).length : 0; const n = (m.variants || []).length;
  return m.finishedAt && have >= n ? `complete (${have})` : `in progress: ${have}/${n}`;
}
const runs = argv.length ? argv.map(d => path.resolve(d)) : existsSync(RUNS) ? readdirSync(RUNS).map(d => path.join(RUNS, d)).filter(d => isFrozenA(d) && existsSync(path.join(d, 'manifest.json'))).sort() : [];
const rows = [], details = [];
for (const d of runs) {
  const m = j(path.join(d, 'manifest.json'));
  let p, s; try { p = profileA(d); s = scoreRun(d); } catch (e) { rows.push(`| ${path.basename(d)} | not scorable yet: ${e.message.split('\n')[0]} |||||||||||||`); continue; }
  const pr = p.profile; const extra = s.docs.reduce((a, x) => ({ sec: a.sec + (x.secondaryFlags || 0), q: a.q + (x.quotesNormalised || 0) }), { sec: 0, q: 0 });
  rows.push(`| ${p.setup} | ${m.test ? 'yes' : 'NO'} (${m.frozenTag ?? 'no tag'}) | ${progress(d)} | ${frac(pr.miss)} = ${pc(pr.miss.rate)} | ${pr.miss.upper95 === null ? 'n/a' : pc(pr.miss.upper95)}: ${pr.miss.words} | ${Object.entries(pr.bySide).map(([k, v]) => `${k} ${v.x}/${v.n}`).join(', ')} | ${frac(pr.hallucinated)} | ${pr.falseAlarms.mean ?? 'n/a'} | ${frac(pr.benignFlagged)} | ${frac(pr.fixes.fixRate)} | ${frac(pr.allPass.singles)}; markups ${frac(pr.allPass.markups)} | ${frac(pr.failures)} | ${extra.sec} | ${extra.q} |`);
  details.push('', `### ${p.setup} (${path.basename(d)})`, '', '```', ...profileLines(p), '```');
}
let author = ['No frozen layer A run yet.'];
const single = runs.filter(d => !j(path.join(d, 'manifest.json')).agentic);
if (single.length) { try { const t = byAuthor(single); author = t.items ? toMarkdown(t).split('\n').slice(1) : ['No verified single items scored yet.']; } catch (e) { author = [`by-author not computable yet: ${e.message.split('\n')[0]}`]; } }
const md = ['# FROZEN layer A results (bench-v2.0-a)', '',
  `Generated ${new Date().toISOString()} by \`tough-eval/v2/frozen/report.mjs\` from the \`runs/*Z-frozen-A-*\` runs only; the preliminary runs are reported apart in \`prelim/REPORT.md\`. A run is a frozen result only if its manifest says \`test: true\` (started with \`run.mjs --test\` at the tag). Formulas: \`BENCHMARK-V2.md\` section 3.1, as amended on 17 October 2026 (\`v2/LAYER-A-FIXES.md\`).`, '',
  '| Setup | test run | reviews | misses (verified single deviations) | upper bound (one-sided 95%) | by side | invented (reviews) | false alarms per agreement | benign flagged | fixed / caught | all-pass singles | failures | Cover Page flags (not false alarms) | quotes verified after normalisation |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...(rows.length ? rows : ['| no frozen-A run yet |||||||||||||']), ...details, '',
  '## By author (verified single items)', '', ...author, ''];
writeFileSync(OUT, md.join('\n'));
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${runs.length} frozen-A run(s)`);
