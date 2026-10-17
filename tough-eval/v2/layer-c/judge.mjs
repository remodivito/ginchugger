// SPDX-License-Identifier: GPL-3.0-or-later
// The layer C judge panel run (BENCHMARK-V2.md section 7 and P19; the spec's `v2/judge-c.mjs`). Every output is
// rendered to the common plain-text shape (render.mjs), checked for setup-identifying words, and judged one criterion
// at a time with the frozen prompt (prompts/judge-c.md) through the product's own executors
// (contract-review/server/executors.js: `claude -p` for Opus at medium effort, OpenAI-compatible streaming for the
// Munito judges at the provider's default with max output 64,000). Every judgement is recorded like a review: model id
// as sent (and as served where the executor reports it), prompt and message hashes, the raw output, the parsed verdict,
// attempts and errors. Recording is resumable: a usable judgement on disk is never asked again.
//   --control              the panel validity control: the golden redline and the empty output, judged by every
//                          candidate judge (default opus, glm, deepseek, qwen) on every criterion; writes
//                          results/v2/C/control/ and results/v2/C/validity.json (recomputed over every control judge on
//                          disk, so --judges glm,deepseek,qwen and later --judges opus add up; `complete` is false until
//                          every judge has answered). Run before any contestant is judged.
//   --run <runDir>         a contestant run (layer-c/run.mjs): its two other-family judges on every criterion, then
//                          the tiebreaker where they disagree or one has no usable judgement; writes
//                          results/v2/C/judgements/<run>/ (panel.json, <task>.rendered.txt, <task>/<criterion>.<judge>.json).
//   --smoke                a development check: --output golden|empty on --tasks/--criteria with --judges; writes
//                          v2/layer-c/smoke/<date>/ (not results).
// Options: --judges a,b  --tasks t1,t2  --criteria C-s1-01,…  --concurrency 2  --transport-wait-ms 60000
//          --transport-retries 4  --allow-no-validity (development only: judge a run before the control exists).
// Failed reviews are not judged: section 3 scores every criterion of a failed review as not passed (score.mjs).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, readStripped, HERE, EVAL } from './import.mjs';
import { render, outputFromReview, outputFromGolden, EMPTY_OUTPUT, leaks, documentTerms } from './render.mjs';
import { JUDGES, CONTROL_JUDGES, ORDER as ORDER_ALL, assign, familyOf, needsTiebreak, validity } from './panel.mjs';
import { classify, isProviderFailure, MAX_ATTEMPTS } from '../retry-policy.mjs';
import { canaryGuid } from '../canary.mjs';

export const RESULTS = path.join(EVAL, 'results', 'v2', 'C');
export const PROMPT_FILE = path.join(HERE, 'prompts', 'judge-c.md');
export const MUNITO_BASE = 'https://api.eu.munito.ai/inference/v1';
export const MAX_OUTPUT_TOKENS = 64000;
/** The canary line above a saved rendering (14.4: nothing published carries item text without it); never sent to a judge. */
const RENDER_STAMP = () => (canaryGuid() ? `# canary ${canaryGuid()} (this line is not part of what the judge read)\n` : '');
const sha = s => createHash('sha256').update(s).digest('hex');
const writeJson = (f, o) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(o, null, 1) + '\n'); };

// ---- outputs ---------------------------------------------------------------------------------------------------------
/** The output to judge for one task: 'golden', 'empty', or a run directory (null when the review failed or is absent). */
export function outputFor(source, task) {
  const document = readStripped(task.document);
  if (source === 'golden') return outputFromGolden(readStripped(task.golden.file), document);
  if (source === 'empty') return EMPTY_OUTPUT;
  const file = path.join(source, 'results', `C-${task.id}.json`); if (!existsSync(file)) return null;
  return outputFromReview(JSON.parse(readFileSync(file, 'utf8')), document);
}
/** The rendered text for one task's output; throws if it carries a setup-identifying word the document does not. */
export function renderedFor(task, output) {
  const document = readStripped(task.document); const markup = readStripped(task.markup).markup;
  const text = render(document, markup, output); const bad = leaks(text, documentTerms(document));
  if (bad.length) throw Error(`rendered output for ${task.id} carries identifying words: ${bad.join(', ')}`);
  return text;
}
/** The user message for one criterion: who we act for, the criterion, the attorney's wording, the rendered output. */
export function userMessage(task, criterion, rendered) {
  return [`The review was done for ${task.represented}; the counterparty is ${task.counterparty}. This is negotiation turn ${task.turn}: the agreement carries the earlier rounds' tracked changes.`, '',
    `CRITERION (grade this): ${criterion.adapted}`, '',
    `For context only, the attorney's original rubric line: "${criterion.attorney.criterion}" Attorney's justification: "${criterion.attorney.justification}"`, '',
    'OUTPUT TO GRADE', rendered].join('\n');
}

// ---- one judgement -------------------------------------------------------------------------------------------------
/** The last JSON object holding a boolean-like `pass` in a raw answer (reasoning blocks and fences ignored). */
export function parseVerdict(raw) {
  const s = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, ''); const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue; let depth = 0, inStr = false, esc = false, j = i;
    for (; j < s.length; j++) { const c = s[j]; if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) break; }
    try { const o = JSON.parse(s.slice(i, j + 1)); if (o && typeof o === 'object' && 'pass' in o) found.push(o); i = j; } catch { /* keep scanning */ }
  }
  const o = found.pop(); if (!o) throw Error(String(raw ?? '').trim() ? 'malformed: no JSON object with "pass" in the answer' : 'malformed: empty answer');
  const p = typeof o.pass === 'boolean' ? o.pass : /^(true|pass|yes)$/i.test(String(o.pass)) ? true : /^(false|fail|no)$/i.test(String(o.pass)) ? false : null;
  if (p === null) throw Error(`malformed: "pass" is ${JSON.stringify(o.pass)}`);
  return { pass: p, reason: typeof o.reason === 'string' ? o.reason.slice(0, 600) : '' };
}

function munitoKey() {
  if (process.env.MUNITO_API_KEY) return process.env.MUNITO_API_KEY;
  const env = path.join(EVAL, '../contract-review/.env'); if (!existsSync(env)) return null;
  const line = readFileSync(env, 'utf8').split('\n').find(l => l.startsWith('MUNITO_API_KEY=')); return line ? line.slice(15).trim().replace(/^["']|["']$/g, '') : null;
}
/** The default call: the product's runModel with the judge's executor. Returns { raw, meta } or throws (raw kept on parse errors). */
export async function productCall({ judge, system, user, timeoutMs = 1_800_000 }) {
  const spec = JUDGES[judge]; const { runModel } = await import('../../../contract-review/server/executors.js');
  const traceDir = mkdtempSync(path.join(os.tmpdir(), 'layer-c-judge-'));
  if (spec.executor === 'openai') { const key = munitoKey(); if (!key) throw Error('MUNITO_API_KEY is not set (environment or contract-review/.env)'); process.env.OPENAI_API_KEY = key; process.env.OPENAI_BASE_URL = MUNITO_BASE; process.env.REVIEW_MAX_OUTPUT_TOKENS = String(MAX_OUTPUT_TOKENS); }
  try {
    let error = null; try { await runModel({ system, payload: user, name: 'judge', config: { executor: spec.executor, model: spec.model, effort: spec.effort || 'medium', traceDir, replayDir: null }, timeoutMs }); } catch (e) { error = e; }
    const rawFile = path.join(traceDir, 'judge.raw.txt'), metaFile = path.join(traceDir, 'judge.meta.json');
    if (!existsSync(rawFile)) throw error || Error('no answer');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    return { raw: readFileSync(rawFile, 'utf8'), meta: { finishReason: meta.stopReason ?? null, usage: meta.usage ?? null, costUsd: meta.costUsd ?? null, servedModel: meta.servedModel ?? null, auxiliaryModels: meta.auxiliaryModels ?? [], seconds: meta.seconds ?? null } };
  } finally { rmSync(traceDir, { recursive: true, force: true }); }
}

/**
 * One judgement under the retry rules: a malformed answer counts as an attempt (at most three, P16); a transport or
 * usage-limit error waits and does not count, up to `transportRetries` waits, then the judgement is recorded as failed.
 */
export async function judgeOnce({ judge, system, user, call = productCall, transportWaitMs = 60_000, transportRetries = 4, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const spec = JUDGES[judge]; const attempts = []; let waits = 0; const started = Date.now();
  for (;;) {
    let raw = null, meta = {};
    try {
      ({ raw, meta } = await call({ judge, system, user }));
      const v = parseVerdict(raw);
      return { ok: true, pass: v.pass, reason: v.reason, raw, meta, attempts: [...attempts, { ok: true }], seconds: (Date.now() - started) / 1000 };
    } catch (e) {
      const error = String(e.message || e); const errorClass = raw === null ? classify(error) : 'malformed';
      attempts.push({ ok: false, error: error.slice(0, 500), errorClass, ...(raw !== null ? { raw: String(raw).slice(0, 4000) } : {}), finishReason: meta?.finishReason ?? null });
      if (isProviderFailure(errorClass)) { if (waits++ < transportRetries) { await sleep(transportWaitMs); continue; } }
      else if (attempts.filter(a => !isProviderFailure(a.errorClass)).length < MAX_ATTEMPTS) continue;
      return { ok: false, pass: null, reason: null, raw, meta, error, errorClass, attempts, seconds: (Date.now() - started) / 1000, executor: spec.executor };
    }
  }
}

/** The judgement record written to disk. */
export function record({ outputKey, task, criterion, judge, system, user, rendered, result }) {
  const spec = JUDGES[judge];
  return { ...(canaryGuid() ? { canary: canaryGuid() } : {}), format: 'layer-c-judgement/1', output: outputKey, task: task.id, criterion: criterion.id, kind: criterion.kind, judge, family: spec.family, executor: spec.executor, model: spec.model,
    servedModel: result.meta?.servedModel ?? null, effort: spec.executor === 'claude' ? spec.effort : 'provider default', maxOutputTokens: spec.executor === 'openai' ? MAX_OUTPUT_TOKENS : null,
    promptFile: 'tough-eval/v2/layer-c/prompts/judge-c.md', promptSha256: sha(system), userSha256: sha(user), renderedSha256: sha(rendered), at: new Date().toISOString(), seconds: result.seconds,
    ok: result.ok, pass: result.pass, reason: result.reason, ...(result.ok ? {} : { error: result.error, errorClass: result.errorClass }), finishReason: result.meta?.finishReason ?? null, usage: result.meta?.usage ?? null, costUsd: result.meta?.costUsd ?? null,
    attempts: result.attempts, raw: result.raw };
}
const hasRendering = (dir, task) => existsSync(path.join(dir, `${task}.rendered.txt`));
export const judgementPath = (dir, task, criterion, judge) => path.join(dir, task, `${criterion}.${judge}.json`);
export function readJudgement(dir, task, criterion, judge) { const f = judgementPath(dir, task, criterion, judge); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined; }

/**
 * Judge a list of { task, criterion, judge } on one output, writing each judgement under `dir`. Skips usable
 * judgements already on disk. Returns the records.
 */
export async function judgeAll({ items, outputKey, source, dir, call, concurrency = 2, transportWaitMs, transportRetries, log = console.log, tasks }) {
  const system = readFileSync(PROMPT_FILE, 'utf8'); const rendered = new Map();
  for (const t of new Set(items.map(i => i.task))) { const task = tasks.find(x => x.id === t); const out = outputFor(source, task); if (!out) continue; const text = renderedFor(task, out); rendered.set(t, text); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${t}.rendered.txt`), `${RENDER_STAMP()}${text}`); }
  const queue = items.filter(i => rendered.has(i.task) && !(readJudgement(dir, i.task, i.criterion.id, i.judge)?.ok)); const out = [];
  const worker = async () => { for (let it = queue.shift(); it; it = queue.shift()) {
    const task = tasks.find(x => x.id === it.task); const user = userMessage(task, it.criterion, rendered.get(it.task));
    const result = await judgeOnce({ judge: it.judge, system, user, call, transportWaitMs, transportRetries });
    const rec = record({ outputKey, task, criterion: it.criterion, judge: it.judge, system, user, rendered: rendered.get(it.task), result });
    writeJson(judgementPath(dir, it.task, it.criterion.id, it.judge), rec); out.push(rec);
    log(`${outputKey} ${it.criterion.id} ${it.judge}: ${rec.ok ? (rec.pass ? 'PASS' : 'FAIL') : `no judgement (${rec.errorClass}: ${String(rec.error).slice(0, 120)})`}`);
  } };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

const pickCriteria = (tasks, { taskIds, criterionIds }) => tasks.filter(t => !taskIds || taskIds.includes(t.id)).flatMap(t => t.criteria.filter(c => !criterionIds || criterionIds.includes(c.id)).map(c => ({ task: t.id, criterion: c })));

/** The control's judgements → validity.json (panel.mjs `validity`). */
export function validityFrom({ tasks, dir = path.join(RESULTS, 'control'), judges = CONTROL_JUDGES }) {
  const onDisk = Object.keys(JUDGES).filter(j => ['golden', 'empty'].some(o => tasks.some(t => existsSync(path.join(dir, o, t.id)) && readdirSync(path.join(dir, o, t.id)).some(f => f.endsWith(`.${j}.json`)))));
  judges = ORDER_ALL.filter(j => [...CONTROL_JUDGES, ...judges, ...onDisk].includes(j)); const results = [];
  for (const output of ['golden', 'empty']) for (const t of tasks) for (const c of t.criteria) for (const j of judges) {
    const r = readJudgement(path.join(dir, output), t.id, c.id, j); results.push({ output, criterion: c.id, judge: j, verdict: r && r.ok ? r.pass : null, expected: c.expect[output] });
  }
  const v = validity(results); const complete = judges.every(j => results.some(r => r.judge === j && r.verdict !== null));
  return { format: 'layer-c-validity/1', judges, complete, ...v, expected: 'golden passes every criterion; empty fails every change criterion and passes every keep criterion (criteria.mjs)', results };
}

export async function control({ tasks, judges = CONTROL_JUDGES, taskIds, criterionIds, call, concurrency, transportWaitMs, transportRetries, dir = path.join(RESULTS, 'control') }) {
  const items = pickCriteria(tasks, { taskIds, criterionIds });
  for (const output of ['golden', 'empty']) await judgeAll({ items: items.flatMap(i => judges.map(j => ({ ...i, judge: j }))), outputKey: `control-${output}`, source: output, dir: path.join(dir, output), call, concurrency, transportWaitMs, transportRetries, tasks });
  const v = validityFrom({ tasks, dir, judges }); writeJson(path.join(path.dirname(dir), 'validity.json'), v); return v;
}

/** Judge a contestant run: panel first, then the tiebreaker where needed. */
export async function judgeRun({ runDir, tasks, call, concurrency, transportWaitMs, transportRetries, allowNoValidity = false, validityFile = path.join(RESULTS, 'validity.json'), root = path.join(RESULTS, 'judgements'), taskIds, criterionIds }) {
  const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); const family = familyOf(manifest.model);
  let failedValidity = [];
  if (existsSync(validityFile)) { const v = JSON.parse(readFileSync(validityFile, 'utf8')); if (!v.complete && !allowNoValidity) throw Error('validity.json is incomplete: some control judge has no usable judgement yet (run judge.mjs --control --judges <it>)'); failedValidity = v.failed || []; }
  else if (!allowNoValidity) throw Error('results/v2/C/validity.json does not exist: run --control first (section 7: the control comes before any contestant)');
  const panel = assign(family, { failedValidity }); const dir = path.join(root, path.basename(runDir));
  writeJson(path.join(dir, 'panel.json'), { run: path.basename(runDir), contestantModel: manifest.model, contestantFamily: family, ...panel, validity: existsSync(validityFile) ? path.relative(EVAL, validityFile) : null });
  const items = pickCriteria(tasks, { taskIds, criterionIds });
  await judgeAll({ items: items.flatMap(i => panel.judges.map(j => ({ ...i, judge: j }))), outputKey: path.basename(runDir), source: runDir, dir, call, concurrency, transportWaitMs, transportRetries, tasks });
  const tie = items.filter(i => needsTiebreak(readJudgement(dir, i.task, i.criterion.id, panel.judges[0]), readJudgement(dir, i.task, i.criterion.id, panel.judges[1])) && hasRendering(dir, i.task));
  await judgeAll({ items: tie.map(i => ({ ...i, judge: panel.tiebreak })), outputKey: path.basename(runDir), source: runDir, dir, call, concurrency, transportWaitMs, transportRetries, tasks });
  return { dir, panel, tiebreaks: tie.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
  const list = k => (arg(k) ? String(arg(k)).split(',').map(s => s.trim()).filter(Boolean) : null);
  const tasks = loadTasks().tasks; const opts = { tasks, taskIds: list('tasks'), criterionIds: list('criteria'), concurrency: Number(arg('concurrency', 2)), transportWaitMs: Number(arg('transport-wait-ms', 60000)), transportRetries: Number(arg('transport-retries', 4)) };
  const judges = list('judges'); if (judges) for (const j of judges) if (!JUDGES[j]) throw Error(`unknown judge ${j}; known: ${Object.keys(JUDGES).join(', ')}`);
  if (arg('control')) {
    const v = await control({ ...opts, judges: judges || CONTROL_JUDGES });
    for (const [k, j] of Object.entries(v.judges)) console.log(`${k}: ${j.ok ? 'passes' : 'FAILS'} the control (${j.usable}/${j.items} usable; ${j.wrong.length} wrong, ${j.missing.length} missing, ${j.itemFaults.length} on items every judge missed)`);
    console.log(`criterion failures (every judge off the expected verdict): ${v.criterionFailures.length}${v.criterionFailures.length ? ' ' + v.criterionFailures.map(c => `${c.output}/${c.criterion}`).join(', ') : ''}`);
  } else if (arg('run')) {
    const r = await judgeRun({ ...opts, runDir: path.resolve(arg('run')), allowNoValidity: !!arg('allow-no-validity') });
    console.log(`judged with ${r.panel.judges.join(' + ')} (tiebreak ${r.panel.tiebreak}${r.panel.replaced.length ? `; replaced ${r.panel.replaced.map(x => `${x.judge}→${x.by}`).join(', ')}` : ''}); ${r.tiebreaks} tiebreak items; ${path.relative(process.cwd(), r.dir)}`);
  } else if (arg('smoke')) {
    const output = arg('output', 'golden'); if (!['golden', 'empty'].includes(output)) throw Error('--smoke judges --output golden or empty (a recorded run: use --run with --allow-no-validity)');
    const dir = path.join(HERE, 'smoke', new Date().toISOString().slice(0, 10), output);
    const items = pickCriteria(tasks, opts).flatMap(i => (judges || ['glm', 'deepseek', 'qwen']).map(j => ({ ...i, judge: j })));
    await judgeAll({ ...opts, items, outputKey: `smoke-${output}`, source: output, dir });
    console.log(`recorded in ${path.relative(process.cwd(), dir)}`);
  } else console.log('usage: judge.mjs --control | --run <runDir> | --smoke --output golden|empty [--tasks …] [--criteria …] [--judges …]');
}
