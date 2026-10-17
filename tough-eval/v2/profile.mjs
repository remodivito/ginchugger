// SPDX-License-Identifier: GPL-3.0-or-later
// The error profile of every setup (BENCHMARK-V2.md sections 3 and 16, P17), from the committed runs, with no model
// call. One file per layer and setup, results/v2/<layer>/<setup>.json (format 11.6), and a plain table.
//   Layer A (v2a runs, score.mjs): miss rate over the single deviation items with its one-sided 95% Clopper–Pearson
//     upper bound in words, per side, author, plant family, difficulty, rule and document; markup plants apart, with a
//     cluster bootstrap over markups; invented quotes, rules and paragraphs (every instance listed); false alarms per
//     agreement; benign edits flagged; fixes and surgical fixes; all-pass (singles, markups, together); failures and
//     attempts; median seconds and cost. The headline is the verified items; `allItems` repeats it on every applied
//     item (contested included) and the contested items are listed.
//   Layer B (ContractNLI test split, contractnli/score.mjs): miss rate over labelled departures with the cluster
//     bootstrap over NDAs (95th percentile as the bound, Clopper–Pearson when nothing is missed), located, invented
//     quotes (v2 gate), false alarms per NDA, all-pass, failures.
//   Layer H (v2h runs, score-h.mjs): miss rate on the current items (diagnostic), unverifiable citations, precedent
//     cited, concession misses, misattributions (all, and on wrong-counterparty scenarios), injections followed, tools.
// Provider failures (14.2): above 10% of a layer's items, the layer is "not completed" and measured over what completed.
// Usage: node tough-eval/v2/profile.mjs [--out <dir>] [--check] [--paired <v2a run>] [--list A|B|H] [<runDir> ...]
//   --list prints the selected runs of one layer (replicate.sh uses it). A layer H run is paired by default with the
//   same model's layer A runs among those selected (pairedRunsFor).
//   no run dirs: every run under tough-eval/runs whose manifest says test: true, and every trivial baseline run.
//   --check: compare with the files already in --out instead of writing; exit 1 on any difference (replicate.sh).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun } from '../score.mjs';
import { scoreRun as scoreCnli } from '../contractnli/score.mjs';
import { scoreH } from './score-h.mjs';
import { suiteOfRun } from '../suite.mjs';
import { proportion, missRate, clusteredRate, meanWithInterval, median } from './stats.mjs';
import { completion, isProviderFailure } from './retry-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const TE = path.resolve(here, '..');
export const DEFAULT_OUT = path.join(TE, 'results', 'v2');
const groupBy = (xs, k) => xs.reduce((m, x) => { const key = typeof k === 'function' ? k(x) : x[k]; (m[key ?? 'none'] ||= []).push(x); return m; }, {});
const byGroup = (plants, k) => Object.fromEntries(Object.entries(groupBy(plants, k)).sort().map(([g, xs]) => [g, missRate(xs.filter(p => !p.caught).length, xs.length)]));

export const layerOf = meta => { const s = suiteOfRun(meta); return s === 'contractnli' ? 'B' : s.startsWith('v2h') ? 'H' : s.startsWith('v2a') ? 'A' : null; };
export function setupOf(meta) {
  if (meta.setup) return meta.setup;
  if (meta.baseline) return `baseline-${meta.baseline}`;
  const prompt = meta.reviewPrompt ? path.basename(meta.reviewPrompt, '.md') : 'product';
  return [meta.model, meta.effort, prompt, meta.agentic ? 'agentic' : null, meta.control].filter(Boolean).join('-').replace(/[^A-Za-z0-9.+-]+/g, '-');
}
const promptOf = meta => (meta.baseline ? null : meta.reviewPrompt ? path.basename(meta.reviewPrompt, '.md') : 'product') + (meta.agentic ? '+record' : '');
function header(meta, dir, layer) {
  return { setup: setupOf(meta), model: meta.model ?? null, servedModel: null, prompt: meta.baseline ? null : promptOf(meta), executor: meta.executor ?? null, effort: meta.effort ?? null, layer, run: path.basename(dir),
    frozenTag: meta.frozenTag ?? null, test: meta.test ?? false, ...(meta.baseline ? { baseline: meta.baseline } : {}), window: { from: meta.startedAt ?? null, to: meta.finishedAt ?? null } };
}
const served = docs => { const s = [...new Set(docs.map(d => d.servedModel).filter(Boolean))]; return s.length ? s.join(', ') : null; };
/** The served model ids a run's results record (contractnli/score.mjs does not carry them into its docs). */
const servedInRun = dir => { const r = path.join(dir, 'results'); if (!existsSync(r)) return null; return served(readdirSync(r).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(readFileSync(path.join(r, f), 'utf8')); } catch { return {}; } })); };

// ---- Layer A --------------------------------------------------------------------------------------------------------
function measuresA(plants, docs) {
  const usable = docs.filter(d => d.ok); const single = d => !d.markup;
  const dev = plants.filter(p => p.kind === 'deviation'); const devS = dev.filter(p => !p.markup), devM = dev.filter(p => p.markup);
  const benS = plants.filter(p => p.kind === 'benign' && !p.markup);
  const halluc = d => d.unverifiable > 0 || d.unknownRules > 0 || d.unanchored > 0;
  const caught = devS.filter(p => p.caught), fixed = caught.filter(p => p.fixed);
  const withExcess = fixed.filter(p => typeof p.excess === 'number');
  const markupClusters = Object.values(groupBy(devM, 'variant')).map(xs => ({ x: xs.filter(p => !p.caught).length, n: xs.length }));
  return {
    miss: missRate(devS.filter(p => !p.caught).length, devS.length),
    bySide: byGroup(devS, 'side'), byAuthor: byGroup(devS, 'author'), byFamily: byGroup(devS, 'family'), byDifficulty: byGroup(devS, 'level'), byRule: byGroup(devS, 'rule'), byDocument: byGroup(devS, 'document'),
    markupMiss: markupClusters.length ? clusteredRate(markupClusters, { miss: true }) : null,
    located: proportion(devS.filter(p => p.located).length, devS.length),
    hallucinated: { ...proportion(usable.filter(halluc).length, usable.length), instances: usable.flatMap(d => d.hallucinations || []) },
    falseAlarms: meanWithInterval(usable.map(d => d.falseAlarms)),
    benignFlagged: proportion(benS.filter(p => p.flagged).length, benS.length),
    fixes: { fixRate: proportion(fixed.length, caught.length), surgical: proportion(withExcess.filter(p => p.excess <= 5).length, withExcess.length) },
    allPass: { singles: proportion(docs.filter(single).filter(d => d.allPass).length, docs.filter(single).length), markups: proportion(docs.filter(d => d.markup && d.allPass).length, docs.filter(d => d.markup).length), together: proportion(docs.filter(d => d.allPass).length, docs.length) },
    failures: { ...proportion(docs.filter(d => !d.ok).length, docs.length), provider: docs.filter(d => isProviderFailure(d.errorClass)).length, malformed: docs.filter(d => !d.ok && !isProviderFailure(d.errorClass)).length, failed: docs.filter(d => !d.ok).map(d => ({ id: d.variant, errorClass: d.errorClass })),
      attempts: { mean: docs.length ? +(docs.reduce((a, d) => a + (d.attempts || 0), 0) / docs.length).toFixed(3) : null, max: Math.max(0, ...docs.map(d => d.attempts || 0)), histogram: groupCount(docs.map(d => d.attempts || 0)) } },
    costTime: { medianSeconds: usable.length ? Math.round(median(usable.map(d => d.ms)) / 1000) : null, medianCostUsd: median(usable.map(d => d.cost)) },
  };
}
const groupCount = xs => xs.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {});
/** The not-completed rule: provider failures above 10% exclude those agreements and mark the layer. */
function applyCompletion(plants, docs) {
  const c = completion(docs); if (!c.notCompleted) return { plants, docs, completion: c };
  const gone = new Set(docs.filter(d => isProviderFailure(d.errorClass)).map(d => d.variant));
  return { plants: plants.filter(p => !gone.has(p.variant)), docs: docs.filter(d => !gone.has(d.variant)), completion: { ...c, excluded: [...gone] } };
}
export function profileA(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); const s = scoreRun(dir);
  const pick = st => ({ plants: s.plants.filter(p => st.includes(p.status ?? 'verified')), docs: s.docs.filter(d => st.includes(d.status ?? 'verified')) }); // v1 has no status
  const head = applyCompletion(...Object.values(pick(['verified']))); const all = applyCompletion(...Object.values(pick(['verified', 'contested'])));
  return { ...header(meta, dir, 'A'), servedModel: served(s.docs), completion: head.completion, notCompleted: head.completion.notCompleted,
    profile: measuresA(head.plants, head.docs), allItems: measuresA(all.plants, all.docs), contested: [...new Set(s.plants.filter(p => p.status === 'contested').map(p => p.plant))],
    items: s.plants.filter(p => !p.markup).map(p => ({ id: p.plant, author: p.author, side: p.side, document: p.document, family: p.family, kind: p.kind, status: p.status, located: +p.located, caught: +p.caught, fixed: p.fixed === null ? null : +!!p.fixed, surgical: typeof p.excess === 'number' ? +(p.excess <= 5) : null, ...(p.kind === 'benign' ? { flagged: +p.flagged } : {}) })),
    markupPlants: s.plants.filter(p => p.markup).map(p => ({ markup: p.variant, id: p.plant, kind: p.kind, caught: +p.caught, fixed: p.fixed === null ? null : +!!p.fixed })),
    agreements: s.docs.map(d => ({ id: d.variant, usable: d.ok, allPass: d.allPass, falseAlarms: d.falseAlarms, hallucinated: d.unverifiable > 0 || d.unknownRules > 0 || d.unanchored > 0, errorClass: d.errorClass, attempts: d.attempts, cost: d.cost, seconds: d.ms === undefined ? null : Math.round(d.ms / 1000) })) };
}

// ---- Layer B --------------------------------------------------------------------------------------------------------
// `split` is the test split ('heldout') for every published profile; prelim/report.mjs passes 'development' only to
// check itself on the development runs.
export function profileB(dir, { split = 'heldout' } = {}) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); const s = scoreCnli(dir, split);
  const c = completion(s.docs); const gone = c.notCompleted ? new Set(s.docs.filter(d => isProviderFailure(d.errorClass)).map(d => d.variant)) : new Set();
  const docs = s.docs.filter(d => !gone.has(d.variant)); const pairs = s.pairs.filter(p => !gone.has(p.variant)); const usable = docs.filter(d => d.ok);
  const dep = pairs.filter(p => p.gold === 'departs'); const byDoc = groupBy(dep, 'variant');
  let expected = null; const fz = path.join(here, 'frozen.json'); if (existsSync(fz)) expected = JSON.parse(readFileSync(fz, 'utf8')).layerBTest?.labelledDepartures ?? null;
  return { ...header(meta, dir, 'B'), servedModel: servedInRun(dir), completion: c, notCompleted: c.notCompleted,
    profile: {
      miss: { ...clusteredRate(Object.values(byDoc).map(xs => ({ x: xs.filter(p => p.kind !== 'caught').length, n: xs.length })), { miss: true }), expectedN: expected },
      located: clusteredRate(Object.values(byDoc).map(xs => ({ x: xs.filter(p => p.kind === 'caught' && p.located).length, n: xs.filter(p => p.kind === 'caught').length }))),
      hallucinated: { ...proportion(usable.filter(d => d.unverifiable > 0 || d.unknownRules > 0 || d.unanchored > 0).length, usable.length), instances: usable.flatMap(d => d.hallucinations || []) },
      falseAlarms: meanWithInterval(usable.map(d => d.falseAlarms)), stricterPerNda: s.summary.stricterPerDoc, omissionFlagsPerNda: s.summary.omissionFlagsPerDoc,
      allPass: proportion(docs.filter(d => d.allPassV2).length, docs.length),
      failures: { ...proportion(docs.filter(d => !d.ok).length, docs.length), provider: docs.filter(d => isProviderFailure(d.errorClass)).length, failed: docs.filter(d => !d.ok).map(d => ({ id: d.variant, errorClass: d.errorClass })) },
      byRule: s.summary.byRule, costTime: { medianSeconds: s.summary.medianSeconds, medianCostUsd: median(usable.map(d => d.cost)) } },
    items: pairs.filter(p => p.gold === 'departs').map(p => ({ id: `${p.variant}/${p.rule}`, nda: p.variant, rule: p.rule, caught: +(p.kind === 'caught'), located: p.located === null ? null : +p.located })),
    agreements: s.docs.map(d => ({ id: d.variant, usable: d.ok, allPass: d.allPassV2, falseAlarms: d.falseAlarms, hallucinated: d.unverifiable > 0 || d.unknownRules > 0 || d.unanchored > 0, errorClass: d.errorClass, attempts: d.attempts, cost: d.cost, seconds: d.ms === undefined ? null : Math.round(d.ms / 1000) })) };
}

// ---- Layer H --------------------------------------------------------------------------------------------------------
export async function profileH(dir, { paired = null } = {}) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); const h = await scoreH(dir, { paired });
  const sc = h.scenarios; const k = kind => sc.filter(s => s.kind === kind);
  const inj = k('injection'); const det = inj.filter(s => s.injectionFollowed !== null);
  return { ...header(meta, dir, 'H'), servedModel: served(h.layerA.docs), diagnostic: true, completion: completion(h.layerA.docs), paired: h.summary.paired,
    profile: {
      miss: { ...missRate(sc.filter(s => !s.caught).length, sc.length), note: 'diagnostic: n is small' },
      citationsUnverifiable: { count: sc.reduce((a, s) => a + s.unverifiableCitations.length, 0), scenarios: proportion(sc.filter(s => !s.citationVerifiable).length, sc.length), instances: sc.flatMap(s => s.unverifiableCitations.map(c => ({ scenario: s.scenario, ...c }))) },
      precedentCited: proportion(k('relevant-precedent').filter(s => s.precedentCited).length, k('relevant-precedent').length),
      concessionMiss: proportion(k('concession').filter(s => s.concessionMiss).length, k('concession').length), justifiedByPrecedent: k('concession').filter(s => s.justifiedByPrecedent).length,
      misattribution: { all: proportion(sc.filter(s => s.misattribution).length, sc.length), wrongCounterparty: proportion(k('wrong-counterparty').filter(s => s.misattribution).length, k('wrong-counterparty').length) },
      injectionsFollowed: { ...proportion(det.filter(s => s.injectionFollowed).length, det.length), undetermined: inj.length - det.length, ofInjections: inj.length },
      allPass: proportion(sc.filter(s => s.allPass).length, sc.length),
      failures: { ...proportion(sc.filter(s => !s.ok).length, sc.length), provider: sc.filter(s => isProviderFailure(s.errorClass)).length, failed: sc.filter(s => !s.ok).map(s => ({ id: s.scenario, errorClass: s.errorClass })) },
      toolCalls: { total: sc.reduce((a, s) => a + s.toolCalls, 0), median: median(sc.map(s => s.toolCalls)), none: sc.filter(s => s.toolCalls === 0).length },
      byAuthor: Object.fromEntries(Object.entries(groupBy(sc, 'author')).sort().map(([a, xs]) => [a, missRate(xs.filter(s => !s.caught).length, xs.length)])) },
    items: sc.map(s => ({ id: s.scenario, kind: s.kind, author: s.author, itemId: s.itemId, caught: +s.caught, citationVerifiable: +s.citationVerifiable, ...(s.precedentCited !== undefined ? { precedentCited: +s.precedentCited } : {}), ...(s.concessionMiss !== undefined ? { concessionMiss: +s.concessionMiss } : {}), misattribution: +s.misattribution, ...(s.injectionFollowed !== undefined ? { injectionFollowed: s.injectionFollowed === null ? null : +s.injectionFollowed } : {}), toolCalls: s.toolCalls })) };
}

/** The profile as sentences, in the order of section 16. */
export function profileLines(p) {
  const pr = p.profile; const pc = x => (x?.rate === null || x?.rate === undefined ? 'n/a' : `${(100 * x.rate).toFixed(1)}%`); const ci = x => (x?.ci95 && x.ci95[0] !== null ? ` [${(100 * x.ci95[0]).toFixed(1)}, ${(100 * x.ci95[1]).toFixed(1)}]` : '');
  const lines = [`${p.setup}, layer ${p.layer}${p.diagnostic ? ' (diagnostic)' : ''}${p.notCompleted ? ' — NOT COMPLETED: ' + p.completion.providerFailures + ' provider failures of ' + p.completion.items : ''}`];
  lines.push(`  1. misses ${pr.miss.x}/${pr.miss.n} = ${pc(pr.miss)}${ci(pr.miss)}; upper bound ${pr.miss.upper95 === null ? 'n/a' : (100 * pr.miss.upper95).toFixed(1) + '%'} (${pr.miss.upperMethod || 'clopper-pearson one-sided'}): ${pr.miss.words}`);
  if (pr.bySide) for (const [side, m] of Object.entries(pr.bySide)) lines.push(`     ${side}: ${m.x}/${m.n}, ${m.words}`);
  if (pr.markupMiss) lines.push(`     markup plants (apart from the headline): ${pr.markupMiss.x}/${pr.markupMiss.n}, ${pr.markupMiss.words} [${pr.markupMiss.upperMethod}]`);
  if (pr.hallucinated) lines.push(`  2. invented quotes, rules or paragraphs: ${pr.hallucinated.x}/${pr.hallucinated.n} reviews = ${pc(pr.hallucinated)}${ci(pr.hallucinated)}; ${pr.hallucinated.instances.length} instances`);
  if (pr.falseAlarms) lines.push(`  3. false alarms per ${p.layer === 'B' ? 'NDA' : 'agreement'}: ${pr.falseAlarms.mean} [${pr.falseAlarms.ci95.join(', ')}]${pr.benignFlagged ? `; benign edits flagged ${pr.benignFlagged.x}/${pr.benignFlagged.n}` : ''}`);
  if (pr.fixes) lines.push(`  4. fixes: ${pr.fixes.fixRate.x}/${pr.fixes.fixRate.n} caught deviations fixed = ${pc(pr.fixes.fixRate)}${ci(pr.fixes.fixRate)}; surgical ${pr.fixes.surgical.x}/${pr.fixes.surgical.n}`);
  if (pr.allPass) lines.push(`  5. all-pass: ${pr.allPass.singles ? `singles ${pc(pr.allPass.singles)}${ci(pr.allPass.singles)}, markups ${pc(pr.allPass.markups)}, together ${pc(pr.allPass.together)}` : `${pr.allPass.x}/${pr.allPass.n} = ${pc(pr.allPass)}${ci(pr.allPass)}`}`);
  if (pr.failures) lines.push(`  6. failures: ${pr.failures.x}/${pr.failures.n} (${pr.failures.provider} provider)${pr.failures.attempts ? `; attempts mean ${pr.failures.attempts.mean}, max ${pr.failures.attempts.max}` : ''}`);
  if (p.layer === 'H') lines.push(`  7. citations unverifiable ${pr.citationsUnverifiable.count}; precedent cited ${pr.precedentCited.x}/${pr.precedentCited.n}; concession misses ${pr.concessionMiss.x}/${pr.concessionMiss.n}; misattributions ${pr.misattribution.all.x}/${pr.misattribution.all.n}; injections followed ${pr.injectionsFollowed.x}/${pr.injectionsFollowed.n}${pr.injectionsFollowed.undetermined ? ` (${pr.injectionsFollowed.undetermined} undetermined: no paired run)` : ''}; tool calls ${pr.toolCalls.total}`);
  if (pr.costTime) lines.push(`  8. median ${pr.costTime.medianSeconds ?? 'n/a'} s per review, cost ${pr.costTime.medianCostUsd ?? 'n/a'}`);
  return lines;
}

export function defaultRuns() {
  const root = path.join(TE, 'runs'); if (!existsSync(root)) return [];
  return readdirSync(root).map(d => path.join(root, d)).filter(d => existsSync(path.join(d, 'manifest.json'))).filter(d => { const m = JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8')); return layerOf(m) && (m.test === true || m.baseline); }).sort();
}
/**
 * The layer A run a layer H run is paired with for suppress-type injections (3.4): the same model's empty-record agentic
 * run when it holds the item, else the same model's single-call run. Returns the candidate dirs in that order.
 */
export function pairedRunsFor(hDir, runs) {
  const h = JSON.parse(readFileSync(path.join(hDir, 'manifest.json'), 'utf8'));
  const a = runs.filter(d => d !== hDir).map(d => ({ d, m: JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8')) })).filter(x => layerOf(x.m) === 'A' && !x.m.baseline && x.m.model === h.model && (x.m.suiteName || '').replace(/^v2a/, '') === (h.suiteName || '').replace(/^v2h/, ''));
  a.sort((x, y) => (path.basename(x.d) < path.basename(y.d) ? -1 : 1)); // deterministic whatever order the runs were given in
  return [...a.filter(x => x.m.agentic), ...a.filter(x => !x.m.agentic)].map(x => x.d);
}
export async function profileRun(dir, opts = {}) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); const layer = layerOf(meta);
  const paired = opts.paired ?? (layer === 'H' && opts.runs ? pairedRunsFor(dir, opts.runs) : null);
  return layer === 'A' ? profileA(dir) : layer === 'B' ? profileB(dir) : layer === 'H' ? await profileH(dir, { paired: paired && paired.length ? paired : null }) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const FLAGS = ["check"]; // flags take no value (else `--check <runDir>` would swallow the run)
  const take = k => { const i = argv.indexOf(`--${k}`); if (i < 0) return null; if (FLAGS.includes(k)) { argv.splice(i, 1); return true; } const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; argv.splice(i, v === true ? 1 : 2); return v; };
  const out = path.resolve(take('out') || DEFAULT_OUT); const check = !!take('check'); const paired = take('paired');
  const list = take('list');
  const runs = argv.length ? argv.map(d => path.resolve(d)) : defaultRuns();
  if (list) { for (const d of runs) if (layerOf(JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8'))) === list) console.log(d); process.exit(0); }
  if (!runs.length) { console.log('no test runs or baseline runs to profile'); process.exit(0); }
  let differ = 0;
  for (const dir of runs) {
    const p = await profileRun(dir, { paired: paired ? [path.resolve(paired)] : null, runs }); if (!p) { console.log(`skipped ${path.basename(dir)} (not a v2 layer)`); continue; }
    const file = path.join(out, p.layer, `${p.setup}.json`); const text = JSON.stringify(p, null, 1) + '\n';
    if (check) { const same = existsSync(file) && readFileSync(file, 'utf8') === text; if (!same) { differ++; console.log(`DIFFERS ${path.relative(TE, file)}`); } }
    else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
    console.log(profileLines(p).join('\n'));
  }
  if (check) { console.log(differ ? `${differ} profile file(s) differ` : 'profiles reproduced'); process.exitCode = differ ? 1 : 0; }
}
