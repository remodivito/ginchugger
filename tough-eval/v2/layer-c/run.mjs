// SPDX-License-Identifier: GPL-3.0-or-later
// Runs one setup on layer C (BENCHMARK-V2.md section 7: "the reviewer runs through the product as usual, one run per
// setup"). Each task's document is reviewed against its positions source by tough-eval/review-one.mjs, unchanged
// (the product's reviewDocument, third-party mode, canary stripped, the side-parameterised prompt filled from the
// playbook's `party`), under the fixed retry policy (P16, v2/retry-policy.mjs). The manifest follows run.mjs's
// (11.5): suiteName "v2c", hashes of the documents, playbooks, prompt, layer-c-tasks.json and the judge prompt, model,
// effort, executor, frozen tag and `test`. Run directories are tough-eval/runs/<time>Z-v2c-<name>, never overwritten;
// a run is resumable with --resume. profile.mjs ignores v2c runs; layer-c/score.mjs profiles them.
// Usage: node tough-eval/v2/layer-c/run.mjs --name <name> --setup <published name> --model <id> [--effort medium]
//   [--review-prompt tough-eval/arms/plain.md] [--executor claude|openai|agy|replay] [--base-url <url> --key-env <VAR>]
//   [--max-output-tokens 64000] [--replay-dir <dir>] [--tasks t1,t2] [--concurrency 1] [--test] [--retry-policy]
//   [--window-end <ISO>] [--transport-wait-ms <ms>] [--resume <runDir>]
//   --test refuses to start unless HEAD is the commit the tag bench-v2.0 names and every file in v2/frozen.json
//   hashes as recorded (v2/check-frozen.mjs); a run without it is test: false.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, HERE, EVAL, TASKS_FILE } from './import.mjs';
import { PROMPT_FILE } from './judge.mjs';
import { attemptsFor, nextStep, classOf, isProviderFailure, resultFiles, TRANSPORT_WAIT_MS, WINDOW_CLOSED } from '../retry-policy.mjs';
import { checkFrozen, frozenChoiceProblems } from '../check-frozen.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
export const variantId = task => `C-${task.id}`;

/** The environment review-one.mjs needs for one review (as run.mjs sets it). */
export function reviewEnv(manifest, runDir, task, providerEnv = {}) {
  return { ...process.env, ...providerEnv, REVIEW_EXECUTOR: manifest.executor === 'replay' ? 'replay' : manifest.executor, REVIEW_MODEL: manifest.model, REVIEW_EFFORT: manifest.effort,
    ...(manifest.reviewPrompt ? { REVIEW_PROMPT: path.join(EVAL, manifest.reviewPrompt) } : {}), ...(manifest.maxOutputTokens ? { REVIEW_MAX_OUTPUT_TOKENS: String(manifest.maxOutputTokens) } : {}),
    REVIEW_TRACE_DIR: path.join(runDir, 'traces', variantId(task)), TOUGH_EVAL_CONTROL: '', REVIEW_ARM: '', TOUGH_EVAL_AGENTIC: '',
    ...(manifest.executor === 'replay' ? { REVIEW_REPLAY_DIR: path.join(manifest.replayDir, variantId(task)) } : {}) };
}

/** Create a run directory and its manifest. */
export function createRun({ name, setup = null, model, effort = 'medium', executor = 'claude', reviewPrompt = null, baseUrl = null, keyEnv = null, maxOutputTokens = null, replayDir = null, taskIds = null, test = false, retryPolicy = false, windowEnd = null, transportWait = TRANSPORT_WAIT_MS, runsRoot = path.join(EVAL, 'runs'), tasksFile = path.join(HERE, TASKS_FILE) }) {
  const frozen = checkFrozen({ requireTag: test });
  if (test && frozen.data?.layers && !frozen.data.layers.includes('C')) throw Error(`--test refused: frozen.json freezes layer(s) ${frozen.data.layers.join(', ')}, not layer C`);
  if (test && !frozen.ok) throw Error(`--test refused: ${frozen.problems.slice(0, 8).join('; ')}`);
  // The frozen prompt choice per non-Claude setup binds a test run, as in run.mjs (check-frozen.mjs frozenChoiceProblems).
  if (test && frozen.data) { const bad = frozenChoiceProblems(frozen.data, { setup, model, executor, reviewPrompt }); if (bad.length) throw Error(`--test refused: ${bad.join('; ')}`); }
  const all = loadTasks(tasksFile).tasks; const tasks = all.filter(t => !taskIds || taskIds.includes(t.id)); if (!tasks.length) throw Error('no tasks selected');
  const runDir = path.join(runsRoot, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z-v2c-${name}`);
  if (existsSync(runDir)) throw Error(`${runDir} exists; run directories are never overwritten`);
  mkdirSync(path.join(runDir, 'results'), { recursive: true });
  let commit = null; try { commit = execSync('git rev-parse HEAD', { cwd: EVAL, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a repo */ }
  const prompt = readFileSync(reviewPrompt ? path.resolve(reviewPrompt) : path.join(EVAL, '../contract-review/prompts/review.md'));
  let cliVersion = null; if (executor === 'claude') { try { cliVersion = execSync('claude --version', { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not installed */ } }
  if (executor === 'agy') { try { cliVersion = 'agy ' + execSync(`${process.env.AGY_BIN || 'agy'} --version`, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not installed */ } }
  const manifest = { startedAt: new Date().toISOString(), suiteName: 'v2c', suite: 'v2c-1', layer: 'C', setup, frozenTag: frozen.tag, frozenSha256: frozen.frozenSha256, test: test && frozen.ok && executor !== 'replay', ...(test ? { frozenCheck: frozen.ok ? 'passed' : 'failed' } : {}), ...(test && executor === 'replay' ? { dryRun: true } : {}), ...(frozen.ok ? {} : { frozenProblems: frozen.problems.slice(0, 20) }),
    agentic: false, cliVersion, ...(retryPolicy || test ? { retryPolicy: { maxAttempts: 3, transportWaitMs: transportWait, windowEnd: (windowEnd ? new Date(windowEnd) : new Date(Date.now() + 14 * 86_400_000)).toISOString() } } : {}),
    ...(reviewPrompt ? { reviewPrompt: path.relative(EVAL, path.resolve(reviewPrompt)) } : {}), executor, ...(executor === 'openai' ? { baseUrl, keyEnv, effortApplies: false, maxOutputTokens: maxOutputTokens || 64000 } : {}), ...(executor === 'agy' ? { effortApplies: false, effortInModelId: (String(model).match(/-(low|medium|high)$/) || [])[1] || null, systemPromptInUserTurn: true } : {}), ...(executor === 'replay' ? { replayDir: path.resolve(replayDir) } : {}),
    model, effort, control: null, arm: null, reviewMode: 'third-party', reviewPromptSha256: sha(prompt), commit,
    layerCTasksSha256: sha(readFileSync(tasksFile)), judgePromptSha256: sha(readFileSync(PROMPT_FILE)),
    playbooks: Object.fromEntries(tasks.map(t => [t.playbook, sha(readFileSync(path.join(EVAL, t.playbook)))])),
    variants: tasks.map(t => ({ id: variantId(t), task: t.id, file: t.document, sha256: sha(readFileSync(path.join(EVAL, t.document))), playbook: t.playbook })) };
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return runDir;
}

function keyFor(manifest) {
  let key = process.env[manifest.keyEnv]; const dotenv = path.join(EVAL, '../contract-review/.env');
  if (!key && existsSync(dotenv)) for (const line of readFileSync(dotenv, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1] === manifest.keyEnv) key = m[2].trim().replace(/^['"]|['"]$/g, ''); }
  if (!key) throw Error(`${manifest.keyEnv} is not set in the environment or contract-review/.env`); return key;
}

/** Review every task of a run that has no result yet, under the run's retry policy. */
export async function runReviews(runDir, { concurrency = 1, log = console.log, reviewOne = path.join(EVAL, 'review-one.mjs') } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); const tasks = loadTasks().tasks;
  const providerEnv = manifest.executor === 'openai' ? { OPENAI_API_KEY: keyFor(manifest), OPENAI_BASE_URL: manifest.baseUrl } : {};
  const done = new Set(readdirSync(path.join(runDir, 'results')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
  const queue = manifest.variants.filter(v => !done.has(v.id)).map(v => tasks.find(t => t.id === v.task));
  const policy = manifest.retryPolicy || null; const windowOver = () => policy && Date.now() >= Date.parse(policy.windowEnd);
  const resultPath = t => path.join(runDir, 'results', `${variantId(t)}.json`);
  const spawnReview = t => new Promise(resolve => {
    const started = Date.now(); const child = spawn(process.execPath, [reviewOne, path.join(EVAL, t.document), resultPath(t), 'live', path.join(EVAL, t.playbook)], { env: reviewEnv(manifest, runDir, t, providerEnv), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', d => { err += d; }); child.on('close', code => { log(`${variantId(t)} ${code === 0 ? 'ok' : 'FAILED'} ${Math.round((Date.now() - started) / 1000)}s${code ? ' ' + err.split('\n')[0] : ''}`); resolve(); });
  });
  const setAside = t => { const dir = path.join(runDir, 'results-failed'); mkdirSync(dir, { recursive: true }); renameSync(resultPath(t), path.join(dir, `${variantId(t)}-${Date.now()}.json`)); };
  const later = [];
  const one = async t => {
    for (;;) {
      if (policy && windowOver()) { writeFileSync(resultPath(t), JSON.stringify({ ok: false, ms: 0, error: WINDOW_CLOSED, errorClass: 'transport', attempts: attemptsFor(runDir, variantId(t)) }, null, 1)); return; }
      await spawnReview(t); if (!existsSync(resultPath(t))) return;
      const r = JSON.parse(readFileSync(resultPath(t), 'utf8')); const attempts = attemptsFor(runDir, variantId(t));
      const step = policy ? nextStep(r, attempts, { windowClosed: windowOver() }) : 'done';
      if (step === 'done') { writeFileSync(resultPath(t), JSON.stringify({ ...r, attempts }, null, 1)); return; }
      setAside(t); if (step === 'retry-later') { later.push({ t, at: Date.now() + (policy.transportWaitMs ?? TRANSPORT_WAIT_MS) }); return; }
    }
  };
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      if (queue.length) { await one(queue.shift()); continue; } if (!later.length) return;
      later.sort((a, b) => a.at - b.at); const wait = later[0].at - Date.now(); if (wait > 0) { await new Promise(r => setTimeout(r, Math.min(wait, 60_000))); continue; }
      queue.push(later.shift().t);
    }
  });
  await Promise.all(workers);
  const m = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); m.finishedAt = new Date().toISOString(); writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(m, null, 1));
  return runDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
  let runDir = arg('resume') ? path.resolve(arg('resume')) : null;
  if (!runDir) {
    const executor = arg('executor', 'claude'); if (!['claude', 'openai', 'agy', 'replay'].includes(executor)) throw Error('--executor is claude, openai, agy or replay');
    if (executor === 'openai' && !arg('base-url')) throw Error('--executor openai needs --base-url and --key-env');
    if (executor === 'replay' && !arg('replay-dir')) throw Error('--executor replay needs --replay-dir <dir> holding C-<task>/review.raw.txt');
    runDir = createRun({ name: arg('name', String(arg('model', 'model')).replace(/[^A-Za-z0-9.-]+/g, '-')), setup: arg('setup'), model: arg('model', 'claude-opus-5-5'), effort: arg('effort', 'medium'), executor, reviewPrompt: arg('review-prompt'),
      baseUrl: arg('base-url'), keyEnv: arg('key-env', 'OPENAI_API_KEY'), maxOutputTokens: arg('max-output-tokens') ? Number(arg('max-output-tokens')) : null, replayDir: arg('replay-dir'),
      taskIds: arg('tasks') ? String(arg('tasks')).split(',') : null, test: !!arg('test'), retryPolicy: !!arg('retry-policy'), windowEnd: arg('window-end'), transportWait: Number(arg('transport-wait-ms', TRANSPORT_WAIT_MS)) });
  }
  console.log(runDir);
  await runReviews(runDir, { concurrency: Number(arg('concurrency', 1)) });
  console.log('done', runDir);
}
