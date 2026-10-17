// SPDX-License-Identifier: GPL-3.0-or-later
// Layer C scoring (BENCHMARK-V2.md sections 3.3, 7, 16 and P19), from recorded judgements, with no model call.
// Per criterion: the panel's verdict (panel.mjs `combine`); a failed review (no usable output after the retry policy)
// fails every criterion of its task, as section 3 scores failures (worst case), and is not judged.
// Reported, in the section 16 shape (results/v2/C/<setup>.json, format as 11.6):
//   passes        raw pass counts: overall, per criterion, per task, per kind ('change' and 'keep' apart, because an
//                 empty output passes every 'keep' criterion), per class (U, A); no interval (3.3, E-41);
//   agreement     pairwise judge agreement as a count (criteria where both panel judges gave a usable verdict and
//                 agreed, of those where both gave one); no kappa (section 7 and E-41: about 22 criteria over three
//                 documents support neither);
//   tiebreaks     the number and the list of criteria the tiebreaker decided, with every vote and reason, for reading;
//   undecided     criteria with no two concordant votes (counted as not passed, listed);
//   failures      reviews that failed (tasks) and judgements that failed;
//   diagnostic    the cluster bootstrap over tasks (section 3.5: 4,000 resamples, seed 20261010, stats.mjs), computed
//                 for completeness and marked not for reporting, because three clusters cannot support an interval.
// Usage: node tough-eval/v2/layer-c/score.mjs [--out <dir>] [--check] <runDir> ...   (also: --control prints validity)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, EVAL } from './import.mjs';
import { combine, assign, familyOf, JUDGES } from './panel.mjs';
import { RESULTS, readJudgement } from './judge.mjs';
import { clusteredRate, proportion } from '../stats.mjs';
import { setupOf } from '../profile.mjs';
import { classOf, isProviderFailure, completion } from '../retry-policy.mjs';

const count = xs => ({ x: xs.filter(i => i.pass === 1).length, n: xs.length });
const groupBy = (xs, k) => xs.reduce((m, x) => { (m[x[k]] ||= []).push(x); return m; }, {});

/**
 * Score one output from its judgements. `reviews`: { taskId: result | null } (null: no result file); `judgementsOf(task,
 * criterion, judge)` returns a record or undefined; `panel` from panel.json. Returns the items and the profile.
 */
export function scoreOutput({ tasks, reviews, panel, judgementsOf }) {
  const items = [];
  for (const t of tasks) {
    const r = reviews[t.id]; const usable = !!(r && r.ok);
    for (const c of t.criteria) {
      const base = { id: c.id, task: t.id, rubricId: c.rubricId, kind: c.kind, class: c.class, weight: c.attorney.weight };
      if (!usable) { items.push({ ...base, pass: 0, decidedBy: 'failed-review', agreed: null, votes: {} }); continue; }
      const js = Object.fromEntries([...panel.judges, panel.tiebreak].map(j => [j, judgementsOf(t.id, c.id, j)]).filter(([, v]) => v !== undefined));
      const v = combine(panel, js);
      items.push({ ...base, pass: v.pass === true ? 1 : 0, decided: v.pass !== null, decidedBy: v.decidedBy, agreed: v.agreed, votes: v.votes,
        reasons: Object.fromEntries(Object.entries(js).map(([j, x]) => [j, x.ok ? x.reason : `no judgement: ${x.errorClass}`])) });
    }
  }
  const judgedItems = items.filter(i => i.decidedBy !== 'failed-review');
  const bothVoted = judgedItems.filter(i => i.agreed !== null);
  const reviewsAll = tasks.map(t => ({ variant: t.id, ok: !!(reviews[t.id] && reviews[t.id].ok), errorClass: reviews[t.id] ? classOf(reviews[t.id]) : 'transport' }));
  const clusters = Object.values(groupBy(items, 'task')).map(xs => ({ x: xs.filter(i => i.pass === 1).length, n: xs.length }));
  const profile = {
    passes: { ...count(items), byKind: Object.fromEntries(Object.entries(groupBy(items, 'kind')).sort().map(([k, xs]) => [k, count(xs)])), byClass: Object.fromEntries(Object.entries(groupBy(items, 'class')).sort().map(([k, xs]) => [k, count(xs)])),
      byTask: Object.fromEntries(Object.entries(groupBy(items, 'task')).map(([k, xs]) => [k, count(xs)])), interval: null, note: 'raw counts; no interval (section 3.3)' },
    agreement: { agreed: bothVoted.filter(i => i.agreed).length, of: bothVoted.length, disagreed: bothVoted.filter(i => !i.agreed).map(i => i.id), panelIncomplete: judgedItems.filter(i => i.agreed === null).map(i => i.id), kappa: null, note: 'a count; no kappa (section 7)' },
    tiebreaks: { count: items.filter(i => i.decidedBy === 'tiebreak').length, criteria: items.filter(i => i.decidedBy === 'tiebreak').map(i => ({ id: i.id, pass: i.pass, votes: i.votes, reasons: i.reasons })) },
    undecided: items.filter(i => i.decidedBy === 'undecided').map(i => ({ id: i.id, votes: i.votes, reasons: i.reasons })),
    failures: { reviews: { ...proportion(reviewsAll.filter(r => !r.ok).length, reviewsAll.length), provider: reviewsAll.filter(r => !r.ok && isProviderFailure(r.errorClass)).length, failed: reviewsAll.filter(r => !r.ok).map(r => ({ id: r.variant, errorClass: r.errorClass })) },
      judgements: judgedItems.reduce((a, i) => a + Object.values(i.votes).filter(v => v === null).length, 0) },
    diagnostic: { clusteredPassRate: clusteredRate(clusters), reported: false, note: 'cluster bootstrap over the three tasks (section 3.5), for completeness only: three clusters cannot support an interval (sections 3.3 and 7)' },
  };
  return { items, profile, completion: completion(reviewsAll) };
}

/** The section 16 profile of one layer C run, from its results and the recorded judgements. */
export function profileC(runDir, { tasks = loadTasks().tasks, root = path.join(RESULTS, 'judgements') } = {}) {
  const meta = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); const dir = path.join(root, path.basename(runDir));
  const panelFile = path.join(dir, 'panel.json'); const panel = existsSync(panelFile) ? JSON.parse(readFileSync(panelFile, 'utf8')) : { ...assign(familyOf(meta.model)), unjudged: true };
  const reviews = Object.fromEntries(tasks.map(t => { const f = path.join(runDir, 'results', `C-${t.id}.json`); return [t.id, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null]; }));
  const s = scoreOutput({ tasks, reviews, panel, judgementsOf: (t, c, j) => readJudgement(dir, t, c, j) });
  const prompt = meta.reviewPrompt ? path.basename(meta.reviewPrompt, '.md') : 'product';
  return { setup: setupOf(meta), model: meta.model ?? null, servedModel: [...new Set(Object.values(reviews).map(r => r?.servedModel).filter(Boolean))].join(', ') || null, prompt, executor: meta.executor ?? null, effort: meta.effort ?? null, layer: 'C',
    run: path.basename(runDir), frozenTag: meta.frozenTag ?? null, test: meta.test ?? false, window: { from: meta.startedAt ?? null, to: meta.finishedAt ?? null },
    panel: { judges: panel.judges, tiebreak: panel.tiebreak, replaced: panel.replaced || [], models: Object.fromEntries([...panel.judges, panel.tiebreak].map(j => [j, JUDGES[j].model])), ...(panel.unjudged ? { unjudged: true } : {}) },
    completion: s.completion, notCompleted: s.completion.notCompleted, profile: s.profile, items: s.items };
}

/** The profile as lines, for the console. */
export function profileLinesC(p) {
  const pr = p.profile; const k = pr.passes.byKind;
  return [`${p.setup}, layer C (judges ${p.panel.judges.join(' + ')}, tiebreak ${p.panel.tiebreak})${p.notCompleted ? ' — NOT COMPLETED' : ''}`,
    `  passes ${pr.passes.x}/${pr.passes.n} criteria (change ${k.change?.x ?? 0}/${k.change?.n ?? 0}, keep ${k.keep?.x ?? 0}/${k.keep?.n ?? 0}); by task ${Object.entries(pr.passes.byTask).map(([t, c]) => `${t.replace('redline-', '')} ${c.x}/${c.n}`).join(', ')}`,
    `  judges agreed on ${pr.agreement.agreed} of ${pr.agreement.of}; tiebreaks ${pr.tiebreaks.count}${pr.tiebreaks.count ? ' (' + pr.tiebreaks.criteria.map(c => c.id).join(', ') + ')' : ''}; undecided ${pr.undecided.length}`,
    `  failed reviews ${pr.failures.reviews.x}/${pr.failures.reviews.n}; failed judgements ${pr.failures.judgements}`];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const take = k => { const i = argv.indexOf(`--${k}`); if (i < 0) return null; const v = k === 'check' || k === 'control' ? true : argv[i + 1]; argv.splice(i, v === true ? 1 : 2); return v; };
  const out = path.resolve(take('out') || RESULTS); const check = !!take('check');
  if (take('control')) { const f = path.join(RESULTS, 'validity.json'); if (!existsSync(f)) { console.log('no validity.json yet'); process.exit(1); } const v = JSON.parse(readFileSync(f, 'utf8')); for (const [k, j] of Object.entries(v.judges)) console.log(`${k}: ${j.ok ? 'passes' : 'FAILS'} (${j.wrong.length} wrong, ${j.missing.length} missing)`); console.log(`criterion failures: ${v.criterionFailures.length}`); process.exit(0); }
  let differ = 0;
  for (const d of argv) {
    const p = profileC(path.resolve(d)); const file = path.join(out, `${p.setup}.json`); const text = JSON.stringify(p, null, 1) + '\n';
    if (check) { if (!existsSync(file) || readFileSync(file, 'utf8') !== text) { differ++; console.log(`DIFFERS ${path.relative(EVAL, file)}`); } } else { mkdirSync(out, { recursive: true }); writeFileSync(file, text); }
    console.log(profileLinesC(p).join('\n'));
  }
  if (check) process.exitCode = differ ? 1 : 0;
}
