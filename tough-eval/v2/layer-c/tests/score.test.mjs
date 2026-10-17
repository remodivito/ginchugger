// SPDX-License-Identifier: GPL-3.0-or-later
// Scoring and the bootstrap on synthetic judgements; the judge's retry and parse rules with a stubbed call; and the
// whole path offline: replayed reviews through review-one.mjs, rendering, a stubbed panel, the section 16 profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreOutput, profileC } from '../score.mjs';
import { assign } from '../panel.mjs';
import { clusteredRate } from '../../stats.mjs';
import { judgeOnce, parseVerdict, judgeRun, control, readJudgement } from '../judge.mjs';
import { loadTasks } from '../import.mjs';
import { createRun, runReviews } from '../run.mjs';
import { writeReplay } from '../fixtures/write-replay.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'layer-c-score-'));
const TASKS = [
  { id: 'T1', criteria: [{ id: 'A1', rubricId: 'r1', kind: 'change', class: 'A', attorney: { weight: 5 } }, { id: 'A2', rubricId: 'r2', kind: 'keep', class: 'U', attorney: { weight: 3 } }, { id: 'A3', rubricId: 'r3', kind: 'change', class: 'U', attorney: { weight: 9 } }] },
  { id: 'T2', criteria: [{ id: 'B1', rubricId: 'r4', kind: 'keep', class: 'A', attorney: { weight: 7 } }] },
  { id: 'T3', criteria: [{ id: 'C1', rubricId: 'r5', kind: 'change', class: 'A', attorney: { weight: 8 } }, { id: 'C2', rubricId: 'r6', kind: 'keep', class: 'U', attorney: { weight: 6 } }] },
];
const J = (pass, reason = 'r') => ({ ok: true, pass, reason });
const panel = assign('anthropic');

test('scoring synthetic judgements: raw counts, agreement as a count, tiebreak list, undecided, failed review', () => {
  const judgements = {
    'T1/A1': { glm: J(true), deepseek: J(true) },                         // agreed pass
    'T1/A2': { glm: J(true), deepseek: J(false), qwen: J(false, 'q') },   // tiebreak: fail
    'T1/A3': { glm: { ok: false, pass: null, errorClass: 'malformed' }, deepseek: J(true), qwen: J(true) }, // panel incomplete, tiebreak pass
    'T2/B1': { glm: J(true), deepseek: J(false) },                        // undecided (no tiebreak recorded)
  };
  const reviews = { T1: { ok: true }, T2: { ok: true }, T3: { ok: false, error: 'malformed', errorClass: 'malformed' } };
  const s = scoreOutput({ tasks: TASKS, reviews, panel, judgementsOf: (t, c, j) => judgements[`${t}/${c}`]?.[j] });
  const by = Object.fromEntries(s.items.map(i => [i.id, i]));
  assert.deepEqual(Object.fromEntries(s.items.map(i => [i.id, [i.pass, i.decidedBy]])), { A1: [1, 'panel'], A2: [0, 'tiebreak'], A3: [1, 'tiebreak'], B1: [0, 'undecided'], C1: [0, 'failed-review'], C2: [0, 'failed-review'] });
  const p = s.profile;
  assert.deepEqual([p.passes.x, p.passes.n], [2, 6]);
  assert.deepEqual(p.passes.byKind, { change: { x: 2, n: 3 }, keep: { x: 0, n: 3 } });
  assert.deepEqual(p.passes.byTask, { T1: { x: 2, n: 3 }, T2: { x: 0, n: 1 }, T3: { x: 0, n: 2 } });
  assert.deepEqual([p.agreement.agreed, p.agreement.of, p.agreement.disagreed, p.agreement.panelIncomplete], [1, 3, ['A2', 'B1'], ['A3']]);
  assert.equal(p.agreement.kappa, null);
  assert.deepEqual(p.tiebreaks.criteria.map(c => c.id), ['A2', 'A3']); assert.equal(p.tiebreaks.criteria[0].reasons.qwen, 'q');
  assert.deepEqual(p.undecided.map(u => u.id), ['B1']);
  assert.deepEqual([p.failures.reviews.x, p.failures.reviews.n, p.failures.judgements], [1, 3, 1]);
  assert.equal(by.A2.votes.qwen, false);
  assert.equal(p.passes.interval, null, 'no interval on the reported counts');
});

test('the diagnostic cluster bootstrap is over tasks, seeded, and matches stats.mjs', () => {
  const reviews = { T1: { ok: true }, T2: { ok: true }, T3: { ok: true } };
  const all = (t, c, j) => J(c !== 'B1');
  const a = scoreOutput({ tasks: TASKS, reviews, panel, judgementsOf: all }), b = scoreOutput({ tasks: TASKS, reviews, panel, judgementsOf: all });
  assert.deepEqual(a.profile.diagnostic, b.profile.diagnostic);
  assert.equal(a.profile.diagnostic.reported, false);
  assert.deepEqual(a.profile.diagnostic.clusteredPassRate, clusteredRate([{ x: 3, n: 3 }, { x: 0, n: 1 }, { x: 2, n: 2 }]));
  assert.equal(a.profile.diagnostic.clusteredPassRate.clusters, 3); assert.equal(a.profile.diagnostic.clusteredPassRate.rate, 0.8333);
  const ci = a.profile.diagnostic.clusteredPassRate.ci95; assert.ok(ci[0] <= 0.8333 && ci[1] >= 0.8333);
});

test('verdict parsing', () => {
  assert.deepEqual(parseVerdict('{"pass": true, "reason": "ok"}'), { pass: true, reason: 'ok' });
  assert.deepEqual(parseVerdict('<think>{"pass": true}</think>\n```json\n{"pass": "FAIL", "reason": "no edit at p-1"}\n```'), { pass: false, reason: 'no edit at p-1' });
  assert.throws(() => parseVerdict(''), /empty answer/); assert.throws(() => parseVerdict('{"verdict": "PASS"}'), /no JSON object with "pass"/); assert.throws(() => parseVerdict('{"pass": "maybe"}'), /"pass" is/);
});

test('judge retries: malformed counts (three attempts); transport waits do not; failures are recorded', async () => {
  let n = 0; const flaky = async () => (++n === 1 ? { raw: 'no json', meta: {} } : { raw: '{"pass": false, "reason": "x"}', meta: { finishReason: 'stop' } });
  const r = await judgeOnce({ judge: 'glm', system: 's', user: 'u', call: flaky }); assert.deepEqual([r.ok, r.pass, r.attempts.length], [true, false, 2]);
  const budget = async () => { throw Error('Live provider did not return bounded valid JSON (finish reason: length).'); };
  const f = await judgeOnce({ judge: 'deepseek', system: 's', user: 'u', call: budget });
  assert.deepEqual([f.ok, f.errorClass, f.attempts.length], [false, 'malformed', 3]);
  let waits = 0; let m = 0; const busy = async () => { if (++m <= 2) throw Error('Live provider returned HTTP 503.'); return { raw: '{"pass": true}', meta: {} }; };
  const t = await judgeOnce({ judge: 'qwen', system: 's', user: 'u', call: busy, sleep: async () => { waits++; } });
  assert.deepEqual([t.ok, waits, t.attempts.filter(a => a.errorClass === 'transport').length], [true, 2, 2]);
  const down = await judgeOnce({ judge: 'qwen', system: 's', user: 'u', call: async () => { throw Error('fetch failed'); }, transportRetries: 1, sleep: async () => {} });
  assert.deepEqual([down.ok, down.errorClass, down.attempts.length], [false, 'transport', 2]);
});

test('offline end to end: replayed reviews → render → stubbed panel (control first) → profile', async () => {
  const tasks = loadTasks().tasks; const root = tmp(); const replay = path.join(root, 'replay'); writeReplay(replay, 'oracle', tasks);
  const runDir = createRun({ name: 'oracle-test', setup: 'oracle-test', model: 'claude-opus-5-5', executor: 'replay', replayDir: replay, runsRoot: path.join(root, 'runs') });
  await runReviews(runDir, { log: () => {} });
  for (const t of tasks) { const r = JSON.parse(readFileSync(path.join(runDir, 'results', `C-${t.id}.json`), 'utf8')); assert.equal(r.ok, true, `${t.id}: ${r.error}`); }
  const m = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); assert.equal(m.suiteName, 'v2c'); assert.equal(m.test, false); assert.ok(m.layerCTasksSha256 && m.judgePromptSha256);
  // A stub judge: passes a change criterion when the rendered output proposes something, a keep criterion always,
  // and the GLM stub disagrees on one criterion so the tiebreaker is exercised. Records who was asked.
  const asked = []; const call = async ({ judge, user }) => { const cid = user.match(/CRITERION[^\n]*/)[0]; asked.push(judge);
    const proposes = /PROPOSED/.test(user.split('OUTPUT TO GRADE')[1]); const keep = /stays|leaves in place/.test(cid);
    const pass = judge === 'glm' && /Derivative Work/.test(cid) ? false : keep || proposes; return { raw: JSON.stringify({ pass, reason: 'stub' }), meta: { finishReason: 'stop' } }; };
  const results = path.join(root, 'results');
  const v = await control({ tasks, judges: ['opus', 'glm', 'deepseek', 'qwen'], call, dir: path.join(results, 'control'), concurrency: 4 });
  assert.ok(existsSync(path.join(results, 'validity.json')));
  assert.equal(v.judges.glm.ok, false, 'the disagreeing stub fails the control on the golden');
  const before = asked.length;
  const r = await judgeRun({ runDir, tasks, call, validityFile: path.join(results, 'validity.json'), root: path.join(results, 'judgements'), concurrency: 4 });
  assert.deepEqual([r.panel.judges, r.panel.tiebreak], [['deepseek', 'qwen'], 'mistral'], 'Claude contestant; GLM replaced after failing the control');
  assert.ok(!asked.slice(before).includes('opus') && asked.length > before, 'an Anthropic contestant is never judged by Opus');
  const dir = path.join(results, 'judgements', path.basename(runDir));
  const rendered = readFileSync(path.join(dir, 'redline-s3-t4-g02a.rendered.txt'), 'utf8'); assert.ok(!rendered.includes('oracle') && !rendered.includes(path.basename(runDir)) && !rendered.includes('opus'));
  const rec = readJudgement(dir, 'redline-s3-t4-g02a', 'C-s3-04', 'deepseek'); assert.equal(rec.model, 'deepseek-ai/deepseek-v4-flash'); assert.ok(rec.promptSha256 && rec.raw);
  const p = profileC(runDir, { tasks, root: path.join(results, 'judgements') });
  assert.equal(p.layer, 'C'); assert.equal(p.setup, 'oracle-test'); assert.deepEqual([p.profile.passes.x, p.profile.passes.n], [22, 22]);
  assert.equal(p.items.length, 22); assert.equal(p.profile.tiebreaks.count, 0);
});
