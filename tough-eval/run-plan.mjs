// SPDX-License-Identifier: GPL-3.0-or-later
// Runs a queue of tough-eval configurations one after another, unattended, from a terminal where `claude` is signed in.
// Each step is one `run.mjs` run, found again by its name, so stopping and restarting the plan picks up where it left
// off. When a step finishes with failed reviews (usually the plan's usage limit), the failed results are removed and
// the step is retried after a wait, up to --retries times; then the plan moves on. At the end every run is scored and
// the configurations are compared (development split only).
// Usage: node tough-eval/run-plan.mjs [plan.json] [--wait-minutes 30] [--retries 6] [--dry-run]
//   plan.json (default plan.json next to this file): { "steps": [ { "name": "opus55-r1", "model": "claude-opus-5-5",
//   "effort": "medium", "variants": "agreement", "control": null, "arm": null, "concurrency": 3 }, ... ] }
import { readFileSync, readdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSuite } from './suite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const waitMinutes = Number(opt('wait-minutes', 30)), retries = Number(opt('retries', 6)), dry = !!opt('dry-run', false);
const planFile = path.resolve(argv[0] || path.join(here, 'plan.json'));
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const runsDir = path.join(here, 'runs');
const log = msg => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); if (!dry) appendFileSync(path.join(here, 'run-plan.log'), line + '\n'); };
const suite = loadSuite();
const devIds = new Set(JSON.parse(readFileSync(path.join(here, 'split.json'), 'utf8')).development);

function wanted(step) {
  const w = step.variants || 'all';
  return suite.variants.filter(v => w === 'all' || (w === 'agreement' && v.playbook === 'playbook.json') || (w === 'bundle' && v.playbook !== 'playbook.json') || (w === 'development' && devIds.has(v.id)) || String(w).split(',').includes(v.id)).map(v => v.id);
}
const findRun = name => existsSync(runsDir) ? readdirSync(runsDir).filter(d => d.endsWith(`Z-${name}`)).sort().map(d => path.join(runsDir, d)).pop() || null : null;
function status(dir, ids) {
  const res = path.join(dir, 'results'); const ok = [], failed = [];
  for (const id of ids) { const f = path.join(res, `${id}.json`); if (!existsSync(f)) continue; (JSON.parse(readFileSync(f, 'utf8')).ok ? ok : failed).push(id); }
  return { ok, failed, missing: ids.filter(id => !ok.includes(id) && !failed.includes(id)) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const step of plan.steps) {
  if (!step.name) throw Error('every step needs a name');
  const ids = wanted(step);
  for (let attempt = 0; ; attempt++) {
    const dir = findRun(step.name);
    const st = dir ? status(dir, ids) : { ok: [], failed: [], missing: ids };
    if (!st.failed.length && !st.missing.length) { log(`${step.name}: complete (${st.ok.length})`); break; }
    if (attempt > retries) { log(`${step.name}: giving up after ${retries} retries, ${st.failed.length} failed, ${st.missing.length} missing`); break; }
    if (attempt > 0) { log(`${step.name}: ${st.failed.length} failed, ${st.missing.length} missing; waiting ${waitMinutes} min before retry ${attempt}`); if (!dry) await sleep(waitMinutes * 60000); }
    if (dir && !dry) for (const id of st.failed) rmSync(path.join(dir, 'results', `${id}.json`));
    const args = [path.join(here, 'run.mjs')];
    if (dir) args.push('--resume', dir);
    else {
      args.push('--name', step.name);
      if (step.demo) args.push('--demo'); else args.push('--model', step.model, '--effort', step.effort || 'medium');
      if (step.control) args.push('--control', step.control);
      if (step.arm) args.push('--arm', step.arm);
      if (step.workerModel) args.push('--worker-model', step.workerModel);
    }
    args.push('--variants', step.variants || 'all', '--concurrency', String(step.concurrency || 3));
    log(`${step.name}: node ${args.map(a => path.relative(process.cwd(), a) || a).join(' ')}`);
    if (dry) break;
    spawnSync(process.execPath, args, { stdio: 'inherit' });
  }
}
if (dry) process.exit(0);
const dirs = plan.steps.map(s => findRun(s.name)).filter(Boolean);
if (dirs.length) {
  log(`scoring ${dirs.length} runs`);
  spawnSync(process.execPath, [path.join(here, 'score.mjs'), ...dirs], { stdio: 'inherit' });
  if (plan.reference) spawnSync(process.execPath, [path.join(here, 'compare.mjs'), '--reference', plan.reference, ...dirs], { stdio: 'inherit' });
  else spawnSync(process.execPath, [path.join(here, 'compare.mjs'), ...dirs], { stdio: 'inherit' });
}
log('plan done');
