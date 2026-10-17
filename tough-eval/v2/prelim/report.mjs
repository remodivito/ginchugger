// SPDX-License-Identifier: GPL-3.0-or-later
// The PRELIMINARY v2 report (16 to 17 October 2026): scores whatever the preliminary lanes have produced so far and
// writes tough-eval/v2/prelim/REPORT.md. No model call. Safe to run at any time, including while runs are in progress
// (a review without a result is not scored yet, and the run is marked in progress with its count).
//   Layer A (runs/*Z-prelim-A-*): the error profile of profile.mjs (miss rate on verified single deviations with the
//     one-sided 95% Clopper–Pearson upper bound in words, per side; markup plants apart; invented quotes; false alarms;
//     benign flagged; fixes; all-pass; failures), and the by-author table of by-author.mjs over the non-agentic A runs.
//   Layer B (runs/*Z-prelim-B-*): profile.mjs on the ContractNLI test split (cluster-bootstrap bound over NDAs).
//   Layer C (runs/*Z-v2c-prelim-C-*): the panel validity control, then layer-c/score.mjs pass counts per run.
//   Layer H (runs/*Z-prelim-H-*): score-h.mjs through profile.mjs, diagnostic; the 40 empty-record items paired with
//     the single-call product run on the same items.
// Every section is labelled preliminary; the deviations from the spec are copied from v2/PRELIMINARY.md.
// Usage: node tough-eval/v2/prelim/report.mjs [--out <file>] [--root <v2 workspace>] [--split heldout|development]
//          [--title <text>] [<runDir> ...]
//   With run directories, only those are scored (development check: e.g. the pre-flight runs under v2/dev/, with
//   --split development for a development-split ContractNLI run and --root for a development item store).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileA, profileB, profileH, profileLines, layerOf, setupOf, pairedRunsFor } from '../profile.mjs';
import { byAuthor, toMarkdown } from '../by-author.mjs';
import { profileC } from '../layer-c/score.mjs';
import { claudeTokens } from './gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const V2 = path.dirname(HERE); const EVAL = path.dirname(V2);
const RUNS = path.join(EVAL, 'runs'); const C_RESULTS = path.join(EVAL, 'results', 'v2', 'C');
const argv = process.argv.slice(2);
const take = k => { const i = argv.indexOf(`--${k}`); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const OUT = path.resolve(take('out') || path.join(HERE, 'REPORT.md'));
const ROOT = path.resolve(take('root') || V2); const SPLIT = take('split') || 'heldout'; const TITLE = take('title');
const j = f => JSON.parse(readFileSync(f, 'utf8'));
const pc = x => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const ci = x => (x?.ci95 && x.ci95[0] !== null && x.ci95[0] !== undefined ? ` [${pc(x.ci95[0])}, ${pc(x.ci95[1])}]` : '');
const frac = x => (x ? `${x.x}/${x.n}` : 'n/a');
const isPrelim = d => /Z-(v2c-)?prelim-/.test(path.basename(d));

function discover() {
  if (argv.length) return argv.map(d => path.resolve(d));
  return existsSync(RUNS) ? readdirSync(RUNS).map(d => path.join(RUNS, d)).filter(d => isPrelim(d) && existsSync(path.join(d, 'manifest.json'))).sort() : [];
}
function progress(dir) {
  const m = j(path.join(dir, 'manifest.json')); const r = path.join(dir, 'results');
  const have = existsSync(r) ? readdirSync(r).filter(f => f.endsWith('.json')).length : 0; const n = (m.variants || []).length;
  return { have, n, finished: !!m.finishedAt && have >= n, text: m.finishedAt && have >= n ? `complete (${have})` : `in progress: ${have}/${n} reviews` };
}
const layerOfDir = d => { const m = j(path.join(d, 'manifest.json')); return m.suiteName === 'v2c' ? 'C' : layerOf(m); };

// ---- sections ---------------------------------------------------------------------------------------------------------
function deviations() {
  const f = path.join(V2, 'PRELIMINARY.md'); if (!existsSync(f)) return ['(v2/PRELIMINARY.md is missing)'];
  const md = readFileSync(f, 'utf8'); const i = md.indexOf('## Deviations from the spec'); if (i < 0) return ['(no deviations section in v2/PRELIMINARY.md)'];
  const rest = md.slice(i).split('\n'); const end = rest.findIndex((l, k) => k > 0 && /^## /.test(l));
  return rest.slice(1, end < 0 ? undefined : end).filter((l, k, a) => !(k === 0 && !l.trim()));
}
function itemStatus() {
  const lines = []; const f = path.join(ROOT, 'items.json');
  if (!existsSync(f)) return ['No items yet (authoring in progress).'];
  const items = j(f).items; const authors = [...new Set(items.map(i => i.author))].sort();
  lines.push('| Author | applied | verified | contested | awaiting a validator | dropped | deviations verified |', '|---|---|---|---|---|---|---|');
  for (const a of authors) { const m = items.filter(i => i.author === a); const n = s => m.filter(i => i.status === s).length;
    lines.push(`| ${a} | ${m.filter(i => i.status !== 'dropped').length} | ${n('verified')} | ${n('contested')} | ${n('applied')} | ${n('dropped')} | ${m.filter(i => i.status === 'verified' && i.kind === 'deviation').length} |`); }
  const mk = path.join(ROOT, 'markups.json'); lines.push('', existsSync(mk) ? `Markups: ${j(mk).markups.length} built${j(mk).short?.length ? `; ${j(mk).short.length} author-sides short (${j(mk).short.map(s => s.id).join(', ')})` : ''}.` : 'Markups: not built yet (built once every family has verified).');
  const sm = path.join(ROOT, 'scenarios-manifest.json'); if (existsSync(sm)) { const c = j(sm).counts; lines.push(`Layer H scenarios: ${c.applied} applied (${c.verified} verified, ${c.contested} contested), ${c.dropped} dropped, ${c.pending} pending.`); } else lines.push('Layer H scenarios: none applied yet.');
  const pr = path.join(ROOT, 'playbook-read', 'points.json'); if (existsSync(pr)) { const p = j(pr); lines.push(`Playbook read (P2): ${p.points.length} points recorded (not acted on in this run)${p.failures?.length ? `; ${p.failures.length} unusable replies` : ''}.`); }
  return lines;
}
function sectionA(runs) {
  const out = []; const rows = [];
  for (const d of runs) {
    let p; try { p = profileA(d); } catch (e) { out.push(`- ${path.basename(d)}: not scorable yet (${e.message.split('\n')[0]})`); continue; }
    const pr = p.profile; const g = progress(d);
    rows.push(`| ${p.setup} | ${g.text} | ${frac(pr.miss)} = ${pc(pr.miss.rate)} | ${pr.miss.upper95 === null ? 'n/a' : pc(pr.miss.upper95)}: ${pr.miss.words} | ${Object.entries(pr.bySide).map(([s, m]) => `${s} ${m.x}/${m.n}`).join(', ')} | ${frac(pr.hallucinated)} | ${pr.falseAlarms.mean ?? 'n/a'} | ${frac(pr.benignFlagged)} | ${frac(pr.fixes.fixRate)} | ${frac(pr.allPass.singles)}; markups ${frac(pr.allPass.markups)} | ${frac(pr.failures)} |`);
    out.push('', '```', ...profileLines(p), '```');
  }
  if (!runs.length) return ['No layer A run has started (they wait for every item to be verified and the markups to be built).'];
  return ['| Setup | reviews | misses (verified single deviations) | upper bound (one-sided 95%) | by side | invented (reviews) | false alarms per agreement | benign flagged | fixed / caught | all-pass singles | failures |', '|---|---|---|---|---|---|---|---|---|---|---|', ...rows, ...out];
}
function sectionAuthor(runs) {
  const a = runs.filter(d => { const m = j(path.join(d, 'manifest.json')); return !m.agentic; });
  if (!a.length) return ['No layer A run yet.'];
  try { const t = byAuthor(a); if (!t.items) return ['No verified single items scored yet.']; return toMarkdown(t).split('\n').slice(1); } catch (e) { return [`by-author not computable yet: ${e.message.split('\n')[0]}`]; }
}
function sectionB(runs) {
  if (!runs.length) return ['No layer B run yet.'];
  const rows = [], out = [];
  for (const d of runs) {
    let p; try { p = profileB(d, { split: SPLIT }); } catch (e) { out.push(`- ${path.basename(d)}: not scorable yet (${e.message.split('\n')[0]})`); continue; }
    const pr = p.profile; const g = progress(d);
    rows.push(`| ${p.setup} | ${g.text} | ${frac(pr.miss)} = ${pc(pr.miss.rate)} | ${pr.miss.upper95 === null || pr.miss.upper95 === undefined ? 'n/a' : pc(pr.miss.upper95)}${pr.miss.words ? `: ${pr.miss.words}` : ''}${pr.miss.upperMethod ? ` (${pr.miss.upperMethod})` : ''} | ${frac(pr.located)} | ${frac(pr.hallucinated)} | ${pr.falseAlarms.mean ?? 'n/a'} | ${frac(pr.allPass)} | ${frac(pr.failures)} |`);
    out.push('', '```', ...profileLines(p), '```');
  }
  return [`Split: ${SPLIT === 'heldout' ? 'the test split (123 NDAs), its single look for each setup' : `${SPLIT} (development check, not a result)`}.`, '',
    '| Setup | reviews | misses (labelled departures) | upper bound | located | invented (NDAs) | false alarms per NDA | all-pass | failures |', '|---|---|---|---|---|---|---|---|---|', ...rows, ...out];
}
function sectionC(runs) {
  const out = []; const vf = path.join(C_RESULTS, 'validity.json');
  if (existsSync(vf)) { const v = j(vf); out.push(`Panel validity control: ${v.complete ? 'complete' : 'incomplete (some control judge has not answered yet)'}; ${Object.entries(v.judges || {}).map(([k, x]) => `${k} ${x.ok ? 'passes' : 'fails'} (${x.usable}/${x.items} usable, ${x.wrong.length} wrong)`).join('; ')}; criterion failures ${v.criterionFailures?.length ?? 0}.`); }
  else out.push('Panel validity control: not run yet.');
  if (!runs.length) return [...out, '', 'No layer C contestant run yet.'];
  out.push('', '| Setup | reviews | judges (tiebreak) | criteria passed | change criteria | keep criteria | judges agreed | tiebreaks | undecided |', '|---|---|---|---|---|---|---|---|---|');
  for (const d of runs) {
    let p; try { p = profileC(d); } catch (e) { out.push(`| ${path.basename(d)} | not scorable yet: ${e.message.split('\n')[0]} | | | | | | | |`); continue; }
    const pr = p.profile; const k = pr.passes.byKind; const g = progress(d);
    out.push(`| ${p.setup} | ${g.text} | ${p.panel.judges.join(' + ')} (${p.panel.tiebreak})${p.panel.unjudged ? ' — NOT JUDGED YET' : ''} | ${pr.passes.x}/${pr.passes.n} | ${k.change?.x ?? 0}/${k.change?.n ?? 0} | ${k.keep?.x ?? 0}/${k.keep?.n ?? 0} | ${pr.agreement.agreed}/${pr.agreement.of} | ${pr.tiebreaks.count} | ${pr.undecided.length} |`);
  }
  out.push('', 'Raw pass counts only (section 3.3): three documents support no interval. An unjudged or partly judged run counts every criterion without a verdict as not passed.');
  return out;
}
async function sectionH(hRuns, aRuns) {
  const out = [];
  if (!hRuns.length) out.push('No layer H run yet (it waits for every scenario to be applied and verified).');
  for (const d of hRuns) {
    try { const paired = pairedRunsFor(d, aRuns); const p = await profileH(d, { paired: paired.length ? paired : null }); out.push(`Run ${path.basename(d)}: ${progress(d).text}; paired with ${paired.length ? paired.map(x => path.basename(x)).join(', ') : 'no layer A run yet'}.`, '', '```', ...profileLines(p), '```'); }
    catch (e) { out.push(`- ${path.basename(d)}: not scorable yet (${e.message.split('\n')[0]})`); }
  }
  // The 40 empty-record items against the single-call product run on the same items (section 8).
  const empty = aRuns.filter(d => j(path.join(d, 'manifest.json')).agentic); const single = aRuns.filter(d => { const m = j(path.join(d, 'manifest.json')); return !m.agentic && !m.reviewPrompt; });
  for (const e of empty) {
    try {
      const pe = profileA(e); const me = j(path.join(e, 'manifest.json')); const s = single.find(d => j(path.join(d, 'manifest.json')).model === me.model);
      out.push('', `Empty-record agentic run ${path.basename(e)} (${progress(e).text}): misses ${frac(pe.profile.miss)}, false alarms per agreement ${pe.profile.falseAlarms.mean ?? 'n/a'}, all-pass singles ${frac(pe.profile.allPass.singles)}.`);
      if (s) { const ps = profileA(s); const by = new Map(ps.items.map(i => [i.id, i])); const both = pe.items.filter(i => i.kind === 'deviation' && by.has(i.id));
        const n = (a, b) => both.filter(i => i.caught === a && by.get(i.id).caught === b).length;
        out.push(`Paired with ${path.basename(s)} on ${both.length} deviation items: caught by both ${n(1, 1)}, only single-call ${n(0, 1)}, only agentic ${n(1, 0)}, neither ${n(0, 0)}.`); }
    } catch (x) { out.push(`- ${path.basename(e)}: not scorable yet (${x.message.split('\n')[0]})`); }
  }
  return out;
}
function lanes() {
  const st = path.join(HERE, 'state'); if (!existsSync(st)) return ['No lane state.'];
  const out = ['| Lane | running | steps given up | steps skipped (budget) |', '|---|---|---|---|'];
  for (const l of readdirSync(st).sort()) {
    const d = path.join(st, l); const pidf = path.join(d, 'pid'); let alive = 'no';
    if (existsSync(pidf)) { const pid = Number(readFileSync(pidf, 'utf8')); try { process.kill(pid, 0); alive = `yes (pid ${pid})`; } catch { alive = 'no (stale pid)'; } }
    const fs = readdirSync(d); out.push(`| ${l} | ${alive} | ${fs.filter(f => f.endsWith('.gaveup')).map(f => f.slice(0, -7)).join(', ') || '—'} | ${fs.filter(f => f.endsWith('.skipped')).map(f => f.slice(0, -8)).join(', ') || '—'} |`);
  }
  return out;
}

// ---- report -----------------------------------------------------------------------------------------------------------
const runs = discover(); const by = { A: [], B: [], C: [], H: [] };
for (const d of runs) { try { const l = layerOfDir(d); if (by[l]) by[l].push(d); } catch { /* no manifest */ } }
let tokens = null; try { tokens = claudeTokens(); } catch { /* none */ }
const hSection = await sectionH(by.H, by.A);
const md = [
  `# ${TITLE || 'PRELIMINARY v2 results'}`, '',
  `**PRELIMINARY — not the published benchmark result.** Generated ${new Date().toISOString()} by \`tough-eval/v2/prelim/report.mjs\` from whatever the preliminary lanes have produced so far; runs still in progress are scored on the reviews they have returned. No run here is a frozen test run (no \`bench-v2.0\` tag; every manifest says \`test: false\`). Formulas: \`BENCHMARK-V2.md\` section 3. Lanes and timings: \`prelim/STATUS.md\`.`, '',
  '## Deviations from the spec in this run', '', ...deviations(), '',
  '## Item set (layer A authoring, apply and verification)', '', ...itemStatus(), '',
  `Claude output tokens spent by the preliminary run so far: ${tokens === null ? 'n/a' : tokens.toLocaleString('en-GB')} (budget 8,000,000).`, '',
  '## Layer A: planted deviations (verified items; headline = single deviations)', '', ...sectionA(by.A.filter(d => !j(path.join(d, 'manifest.json')).agentic)), '',
  '### By author (layer A, verified single items)', '', ...sectionAuthor(by.A), '',
  '## Layer B: real NDAs (ContractNLI)', '', ...sectionB(by.B), '',
  '## Layer C: attorney fixes (RedlineBench, panel-judged)', '', ...sectionC(by.C), '',
  '## Layer H: matter history, agentic (diagnostic)', '', ...hSection, '',
  '## Lanes', '', ...lanes(), '',
];
writeFileSync(OUT, md.join('\n'));
console.log(`wrote ${path.relative(process.cwd(), OUT)}: A ${by.A.length}, B ${by.B.length}, C ${by.C.length}, H ${by.H.length} runs`);
