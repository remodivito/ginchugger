// SPDX-License-Identifier: GPL-3.0-or-later
// Runs one configuration of the reviewer over the tough-eval variants. The manifest (hashes of the variants, the
// playbook, the review prompt and the code, plus model, effort and executor) is written before any review starts;
// run directories are never overwritten. Resumable: variants that already have a result are skipped.
// Must be launched from a terminal where `claude` is signed in.
// Usage: node tough-eval/run.mjs --name opus-medium --model claude-opus-5-5 --effort medium [--variants P01,P02|all|agreement|bundle|development] [--concurrency 4] [--demo] [--control <name>] [--arm decomposed|decomposed-raw|decomposed-agent|decomposed-agent-raw|hybrid|agent|agent-hybrid] [--worker-model <model>] [--resume <runDir>] [--executor openai --base-url <url> --key-env <VAR>] [--executor agy --model gemini-3.8-flash-high]
// v2 (BENCHMARK-V2.md 11.5, 11.7, 14): [--suite v2a|v2h|v2a-fixture|v2h-fixture] [--setup <name>] [--test]
//   [--agentic empty] [--executor replay --replay-dir <dir>] [--retry-policy] [--window-end <ISO>] [--transport-wait-ms <ms>]
//   --test       refuses to start unless HEAD is the commit tag bench-v2.0 names and every file in v2/frozen.json hashes
//                as recorded (v2/check-frozen.mjs); the manifest says test: true. Any run without it says test: false, and so
//                does a dry run (--demo or --executor replay) with it: frozenCheck: passed, dryRun: true.
//   --setup      the setup's name as published (e.g. opus-5.5-product); recorded and used by profile.mjs.
//   v2h          runs each scenario's current document agentically over its seeded document store (v2/seed-record.mjs).
//   --agentic empty  the agentic review over a store holding only the current document (the 40 empty-record items:
//                --variants empty-record).
//   --executor replay  plays recorded raw outputs, <replay-dir>/<variant id>/review.raw.txt (and review.tools.jsonl),
//                through the product's replay executor: the dry run and the offline reproduction, no model call.
//   --retry-policy  the fixed policy of P16 (on with --test): malformed output retried at once up to three attempts;
//                transport and usage-limit errors retried every 15 minutes until --window-end (default: 14 days on).
//   --stagger-ms <ms>  start the concurrent workers <ms> apart (default 0).
//   --variants also takes: test|heldout (ContractNLI test split), empty-record (40 by hash), arm-c (10 by hash),
//                verified, singles.
// --control runs a deliberately degraded configuration (see controls.mjs) to check that the eval scores it lower.
// --arm runs a decomposed review (tough-eval/arms/review-decomposed.mjs) instead of the single call; each review then
// runs up to REVIEW_CONCURRENCY (default 4) rule workers at once, on top of --concurrency reviews.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CONTROLS } from './controls.mjs';
import { ARMS, ARM_PROMPT_DIR } from './arms/review-decomposed.mjs';
import { loadSuite, isV2 } from './suite.mjs';
import { attemptsFor, nextStep, classOf, isProviderFailure, resultFiles, TRANSPORT_WAIT_MS, WINDOW_CLOSED } from './v2/retry-policy.mjs';
import { checkFrozen, frozenChoiceProblems, FROZEN_PATH, layerOfSuite } from './v2/check-frozen.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const sha = s => createHash('sha256').update(s).digest('hex');

// --suite tough (default) | contractnli: which variant set and playbook to run (see suite.mjs).
const suiteName = arg('suite', 'tough'); const suite = loadSuite(suiteName);
// --review-prompt <file>: replace the product's review prompt with another (review.js honours REVIEW_PROMPT). Arm B
// ("plain": the model, the document and the playbook, none of the product's method) lives in arms/plain.md. The file
// and its hash go in the manifest, and compare.mjs treats the prompt as part of the configuration.
// --playbook <file>: review every variant against this playbook instead of its own (the vendor-side pass over the
// planted suite, 14 Oct); recorded in the manifest and part of the configuration in compare.mjs.
const playbookArg = arg('playbook'); if (playbookArg && !existsSync(path.join(here, playbookArg))) throw Error(`--playbook ${playbookArg} not found (path relative to tough-eval)`);
const reviewPromptArg = arg('review-prompt'); if (reviewPromptArg && !existsSync(path.resolve(reviewPromptArg))) throw Error(`--review-prompt ${reviewPromptArg} not found`);
const splitFile = suite.split ? JSON.parse(readFileSync(path.join(here, suite.split), 'utf8')) : { development: [], heldout: [] };
const devIds = new Set(splitFile.development); const testIds = new Set(splitFile.heldout || []);
const demo = !!arg('demo');
const model = demo ? 'sample-mode' : arg('model', 'claude-opus-5-5'); const effort = arg('effort', 'medium');
const arm = arg('arm'); if (arm && (demo || !ARMS.includes(arm))) throw Error(demo ? '--arm needs a live model' : `unknown arm ${arm}; known: ${ARMS.join(', ')}`);
const workerModel = arg('worker-model'); if (workerModel && !['hybrid', 'agent-hybrid'].includes(arm)) throw Error('--worker-model is for --arm hybrid or agent-hybrid');
const control = arg('control'); if (control && !CONTROLS[control]) throw Error(`unknown control ${control}; known: ${Object.keys(CONTROLS).join(', ')}`);
// --executor openai runs through an OpenAI-compatible endpoint (e.g. an open-model host): --base-url names it and
// --key-env names the variable holding its key, read from the environment or contract-review/.env and never written down.
// --max-output-tokens (openai only) defaults to 64000, the cap every Munito run has used since R22 and layer C's; at the
// executor's own 16000 GLM-5.3 Flash stops at the limit on a ten-paragraph agreement (pre-flight, 15 October).
// --executor muse runs through the Muse Code CLI under its own login (models muse-wonder-1.0, muse-spark-1.3; Wonder Full is Power and Maximum plans only); codex likewise.
// --executor agy runs through Google's Antigravity CLI under its own sign-in (gemini-3.8-flash-high|medium|low: the effort is
// part of the model id, so --effort does not apply); it has no system-prompt flag, so the system prompt travels in the user
// turn (manifest: systemPromptInUserTurn). Single call only (16 Oct, the Gemini lane of the preliminary run).
const executorArg = arg('executor', 'claude'); if (!['claude', 'openai', 'muse', 'codex', 'agy', 'replay'].includes(executorArg)) throw Error('--executor is claude, openai, muse, codex, agy or replay');
const replayDirArg = arg('replay-dir'); if (executorArg === 'replay' && (demo || !replayDirArg || !existsSync(path.resolve(replayDirArg)))) throw Error('--executor replay needs --replay-dir <dir> holding <variant>/review.raw.txt');
const agenticArg = arg('agentic'); if (agenticArg && agenticArg !== 'empty') throw Error('--agentic takes `empty` (layer H runs use --suite v2h)');
const agenticMode = suiteName.startsWith('v2h') ? 'scenario' : agenticArg ? 'empty' : null;
if (executorArg === 'agy' && (demo || arm || agenticArg || suiteName.startsWith('v2h'))) throw Error('--executor agy is a live single call: no --demo, --arm or agentic review');
if (agenticMode && demo) console.warn('note: --demo runs the v1 rule engine, which reads no record; the run is marked agentic: false');
const testRun = !!arg('test'); const retryPolicy = testRun || !!arg('retry-policy');
const windowEnd = new Date(arg('window-end', new Date(Date.now() + 14 * 86_400_000).toISOString())); if (Number.isNaN(+windowEnd)) throw Error('--window-end is an ISO date');
const transportWait = Number(arg('transport-wait-ms', TRANSPORT_WAIT_MS));
const frozen = checkFrozen({ requireTag: testRun });
// A frozen.json that freezes some layers only (layers: ["A"]) binds no test run on another layer's suite.
if (testRun && frozen.data?.layers && !frozen.data.layers.includes(layerOfSuite(suiteName))) throw Error(`--test refused: ${path.relative(here, FROZEN_PATH)} freezes layer(s) ${frozen.data.layers.join(', ')}, not suite ${suiteName}`);
if (testRun && !frozen.ok) throw Error(`--test refused: ${frozen.problems.slice(0, 8).join('; ')}${frozen.problems.length > 8 ? ` (and ${frozen.problems.length - 8} more)` : ''}`);
// The frozen per-setup choices (promptPerSetup, toolsSupported) bind a test run: a mismatch refuses it (check-frozen.mjs).
if (testRun && frozen.data) { const bad = frozenChoiceProblems(frozen.data, { setup: arg('setup'), model, executor: demo ? 'demo' : executorArg, reviewPrompt: reviewPromptArg, agentic: !!agenticMode }); if (bad.length) throw Error(`--test refused: ${bad.join('; ')}`); }
// A dry run (--demo: the rule engine; --executor replay: recorded outputs) may check the tag but is never a test run, so
// profile.mjs and replicate.sh cannot mistake it for a published setup (pre-flight, 15 October).
const dryRun = demo || executorArg === 'replay';
const hashOf = (...xs) => sha(xs.join('\u0000'));
const baseUrlArg = arg('base-url'); const keyEnvArg = arg('key-env', 'OPENAI_API_KEY');
if (executorArg === 'openai' && (demo || !baseUrlArg)) throw Error('--executor openai needs --base-url and a live model');
const wanted = arg('variants', 'all'); const concurrency = Number(arg('concurrency', 4));
// --variants all | agreement | bundle | a comma-separated list of ids
// v2 draws by hash (BENCHMARK-V2.md 8, 10): the 40 verified single items with the lowest sha256("v2-empty-record:" + id);
// arm C's ten verified single CSA customer-side items with the lowest sha256("v2-arm-c:" + id).
const singlesVerified = suite.variants.filter(v => !v.markup && v.status === 'verified');
const drawn = (pool, salt, k) => new Set(pool.map(v => [sha(salt + v.id), v.id]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, k).map(x => x[1]));
const draws = { 'empty-record': () => drawn(singlesVerified, 'v2-empty-record:', 40), 'arm-c': () => drawn(singlesVerified.filter(v => v.document === 'csa' && v.side === 'customer'), 'v2-arm-c:', 10) };
const drawnIds = draws[wanted] ? draws[wanted]() : null;
const variants = suite.variants.filter(v => wanted === 'all' || (wanted === 'agreement' && v.playbook === 'playbook.json') || (wanted === 'bundle' && v.playbook !== 'playbook.json') || (wanted === 'development' && devIds.has(v.id)) || (['test', 'heldout'].includes(wanted) && testIds.has(v.id))
  || (drawnIds && drawnIds.has(v.id)) || (wanted === 'verified' && v.status === 'verified') || (wanted === 'singles' && !v.markup && v.status) || String(wanted).split(',').includes(v.id));
if (!variants.length) throw Error(`--variants ${wanted} selects nothing in suite ${suiteName}`);
let runDir = arg('resume');
if (!runDir) {
  runDir = path.join(here, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z-${arg('name', model)}`);
  if (existsSync(runDir)) throw Error(`${runDir} exists; run directories are never overwritten`);
  mkdirSync(path.join(runDir, 'results'), { recursive: true });
  let commit = null; try { commit = execSync('git rev-parse HEAD', { cwd: here }).toString().trim(); } catch { /* not a repo */ }
  const prompt = readFileSync(reviewPromptArg ? path.resolve(reviewPromptArg) : path.join(here, '../contract-review/prompts/review.md'), 'utf8');
  const agenticFields = agenticMode && !demo ? { agentic: true, agenticRecord: agenticMode, agenticStore: 'ginchugger-store-seed/1', reviewRecordPromptSha256: sha(readFileSync(path.join(here, '../contract-review/prompts/review-record.md'))), toolSchemasSha256: sha(readFileSync(path.join(here, '../contract-review/server/store/tool-schemas.json'))) } : { agentic: false };
  let cliVersion = null; if (!demo && executorArg === 'claude') { try { cliVersion = execSync('claude --version', { encoding: 'utf8', timeout: 20000 }).trim(); } catch { /* not installed */ } }
  if (executorArg === 'agy') { try { cliVersion = 'agy ' + execSync(`${process.env.AGY_BIN || 'agy'} --version`, { encoding: 'utf8', timeout: 20000 }).trim(); } catch { /* not installed */ } }
  const agyFields = executorArg === 'agy' ? { effortApplies: false, effortInModelId: (String(model).match(/-(low|medium|high)$/) || [])[1] || null, systemPromptInUserTurn: true, agyInvocation: 'print mode, stream-json in and out, --sandbox, --disable-slash-commands, fresh empty working directory' } : {};
  const v2Fields = { setup: arg('setup') || null, frozenTag: frozen.tag, frozenSha256: frozen.frozenSha256, test: testRun && frozen.ok && !dryRun, ...(testRun ? { frozenCheck: frozen.ok ? 'passed' : 'failed' } : {}), ...(testRun && dryRun ? { dryRun: true } : {}), ...(frozen.ok ? {} : { frozenProblems: frozen.problems.slice(0, 20) }), ...agenticFields, cliVersion,
    ...(retryPolicy ? { retryPolicy: { maxAttempts: 3, transportWaitMs: transportWait, windowEnd: windowEnd.toISOString() } } : {}), ...(executorArg === 'replay' ? { replayDir: path.resolve(replayDirArg) } : {}) };
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    startedAt: new Date().toISOString(), suiteName: suite.name, suite: suite.version, ...v2Fields, ...(reviewPromptArg ? { reviewPrompt: path.relative(here, path.resolve(reviewPromptArg)) } : {}), ...(playbookArg ? { playbookOverride: playbookArg, playbookOverrideSha256: sha(readFileSync(path.join(here, playbookArg))) } : {}), executor: demo ? 'sample-mode (local rules)' : executorArg, ...(executorArg === 'openai' ? { baseUrl: baseUrlArg, keyEnv: keyEnvArg, effortApplies: false, maxOutputTokens: Number(arg('max-output-tokens', 64000)) } : {}), ...agyFields, model, effort,
    control: control || null, arm: arm || null, ...(workerModel ? { workerModel } : {}), ...(arm ? { armPromptsSha256: Object.fromEntries(['review-rule', 'review-rule-agent', 'review-agent', 'sweep', 'consolidate'].map(n => [n, sha(readFileSync(path.join(ARM_PROMPT_DIR, `${n}.md`)))])),
      armConcurrency: Number(process.env.REVIEW_CONCURRENCY || 4), agentTurns: Number(process.env.REVIEW_AGENT_TURNS || 8) } : {}), reviewMode: 'third-party', reviewPromptSha256: sha(prompt), playbookSha256: Object.values(suite.playbooks)[0].sha256, playbooks: Object.fromEntries(Object.values(suite.playbooks).map(p => [p.file, p.sha256])), commit,
    variants: variants.map(v => ({ id: v.id, sha256: v.sha256, playbook: v.playbook, ...(v.scenario ? { scenario: v.scenario } : {}) })),
  }, null, 1));
}
const runManifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
const { control: runControl, arm: runArm = null, workerModel: runWorker = null } = runManifest;
const runExecutor = ['openai', 'muse', 'codex', 'agy', 'replay'].includes(runManifest.executor) ? runManifest.executor : 'claude';
let providerEnv = {};
if (runExecutor === 'openai') {
  let key = process.env[runManifest.keyEnv];
  const dotenv = path.join(here, '../contract-review/.env');
  if (!key && existsSync(dotenv)) for (const line of readFileSync(dotenv, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1] === runManifest.keyEnv) key = m[2].trim().replace(/^['"]|['"]$/g, ''); }
  if (!key) throw Error(`${runManifest.keyEnv} is not set in the environment or contract-review/.env`);
  providerEnv = { OPENAI_API_KEY: key, OPENAI_BASE_URL: runManifest.baseUrl };
}
// --retry-failed moves failed results aside (results-failed/, kept for the record) so those variants run again.
if (arg('retry-failed')) {
  const failedDir = path.join(runDir, 'results-failed'); mkdirSync(failedDir, { recursive: true });
  for (const f of readdirSync(path.join(runDir, 'results')).filter(f => f.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(path.join(runDir, 'results', f), 'utf8'));
    if (!r.ok) renameSync(path.join(runDir, 'results', f), path.join(failedDir, f.replace(/\.json$/, `-${Date.now()}.json`)));
  }
}
const done = new Set(readdirSync(path.join(runDir, 'results')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
const queue = variants.filter(v => !done.has(v.id));
// A resumed run that adds variants its manifest does not list (e.g. a run made before the bundle existed) records them,
// with when and at which commit, so the scorer's stale check covers them and the provenance stays visible.
const listed = new Set((runManifest.variants || []).map(v => v.id)); const added = queue.filter(v => !listed.has(v.id));
if (added.length) {
  let commit = null; try { commit = execSync('git rev-parse HEAD', { cwd: here }).toString().trim(); } catch { /* not a repo */ }
  runManifest.variants = [...(runManifest.variants || []), ...added.map(v => ({ id: v.id, sha256: v.sha256, playbook: v.playbook }))];
  runManifest.playbooks = { ...(runManifest.playbooks || {}), ...Object.fromEntries(Object.values(suite.playbooks).map(p => [p.file, p.sha256])) };
  (runManifest.resumes = runManifest.resumes || []).push({ at: new Date().toISOString(), commit, suite: suite.version, added: added.map(v => v.id) });
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(runManifest, null, 1));
}
console.log(`${runDir}\n${queue.length} to run (${done.size} done), ${model} ${effort}${runControl ? ', control ' + runControl : ''}${runArm ? ', arm ' + runArm : ''}, concurrency ${concurrency}`);

function spawnReview(v) {
  return new Promise(resolve => {
    const agenticEnv = runManifest.agentic ? { TOUGH_EVAL_AGENTIC: runManifest.agenticRecord === 'empty' ? 'empty' : path.join(here, v.scenario), TOUGH_EVAL_DOCUMENT: v.document || '', TOUGH_EVAL_SIDE: v.side || '' } : {};
    const env = { ...process.env, ...providerEnv, REVIEW_EXECUTOR: runExecutor, REVIEW_MODEL: model, REVIEW_EFFORT: effort, ...(runManifest.reviewPrompt ? { REVIEW_PROMPT: path.join(here, runManifest.reviewPrompt) } : {}), ...(runManifest.maxOutputTokens ? { REVIEW_MAX_OUTPUT_TOKENS: String(runManifest.maxOutputTokens) } : {}), REVIEW_TRACE_DIR: path.join(runDir, 'traces', v.id), TOUGH_EVAL_CONTROL: runControl || '', REVIEW_ARM: runArm || '', ...(runWorker ? { REVIEW_WORKER_MODEL: runWorker } : {}),
      ...(runExecutor === 'replay' ? { REVIEW_REPLAY_DIR: path.join(runManifest.replayDir, v.id) } : {}), ...agenticEnv };
    const t = Date.now();
    const child = spawn(process.execPath, [path.join(here, 'review-one.mjs'), path.join(here, v.file), path.join(runDir, 'results', `${v.id}.json`), demo ? 'demo' : 'live', path.join(here, runManifest.playbookOverride || v.playbook)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', d => { err += d; });
    child.on('close', code => { console.log(`${v.id} ${code === 0 ? 'ok' : 'FAILED'} ${Math.round((Date.now() - t) / 1000)}s${code ? ' ' + err.split('\n')[0] : ''}`); resolve(); });
  });
}
const resultPath = v => path.join(runDir, 'results', `${v.id}.json`);
const readResult = v => { try { return JSON.parse(readFileSync(resultPath(v), 'utf8')); } catch { return { ok: false, error: 'no result written', errorClass: 'malformed' }; } };
const writeResult = (v, r) => writeFileSync(resultPath(v), JSON.stringify(r, null, 1));
const setAside = v => { const dir = path.join(runDir, 'results-failed'); mkdirSync(dir, { recursive: true }); renameSync(resultPath(v), path.join(dir, `${v.id}-${Date.now()}.json`)); };
const runPolicy = runManifest.retryPolicy || null;
const windowOver = () => runPolicy && Date.now() >= Date.parse(runPolicy.windowEnd);
const later = []; // provider failures waiting out TRANSPORT_WAIT_MS: { v, at }
// One review under the retry policy (P16): returns when the variant is done or has been put back to wait.
async function one(v) {
  for (;;) {
    if (runPolicy && windowOver()) { closeWindow(v); return; }
    await spawnReview(v);
    if (!runPolicy && !existsSync(resultPath(v))) return; // as before: no result, so a resumed run tries it again
    const r = readResult(v); const attempts = attemptsFor(runDir, v.id);
    const step = runPolicy ? nextStep(r, attempts, { windowClosed: windowOver() }) : 'done';
    if (step === 'done') { if (runPolicy && !r.ok && isProviderFailure(classOf(r)) && windowOver()) { closeWindow(v, r); return; } writeResult(v, { ...r, attempts }); return; }
    setAside(v);
    if (step === 'retry-later') { later.push({ v, at: Date.now() + (runPolicy.transportWaitMs ?? TRANSPORT_WAIT_MS) }); return; }
  }
}
// A review still in provider failure when the window closes is failed with "window closed" (P16).
function closeWindow(v, last = null) {
  if (last && existsSync(resultPath(v))) setAside(v);
  const prior = resultFiles(runDir, v.id).filter(f => f.includes('results-failed')).sort().pop();
  const lastError = last?.error ?? (prior ? JSON.parse(readFileSync(prior, 'utf8')).error ?? null : null);
  writeResult(v, { ok: false, ms: 0, error: WINDOW_CLOSED, errorClass: 'transport', ...(lastError ? { lastError } : {}), attempts: attemptsFor(runDir, v.id) });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// --stagger-ms <ms>: worker k starts k x ms after the first, so a CLI executor is not started several times at once
// (the Claude CLI's sign-in refresh, 17 October 2026). Default 0: all at once, as before.
const staggerMs = Number(arg('stagger-ms', 0)) || 0;
const workers = Array.from({ length: Math.max(1, concurrency) }, async (_, k) => {
  if (staggerMs && k) await sleep(k * staggerMs);
  for (;;) {
    if (queue.length) { await one(queue.shift()); continue; }
    if (!later.length) return;
    later.sort((a, b) => a.at - b.at); const next = later[0];
    const wait = Math.min(next.at, runPolicy ? Date.parse(runPolicy.windowEnd) : next.at) - Date.now();
    if (wait > 0) { await sleep(Math.min(wait, 60_000)); continue; }
    later.shift(); queue.push(next.v);
  }
});
await Promise.all(workers);
// When the queue empties, the manifest records it (the end of the run's window for profile.mjs; a resumed run moves it).
{ const m = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); m.finishedAt = new Date().toISOString(); writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(m, null, 1)); }
console.log('done', runDir);
