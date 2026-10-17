// SPDX-License-Identifier: GPL-3.0-or-later
// The review's single call through the Claude CLI does not block the server and can be stopped (17 Oct 2026; stress
// scenarios review-blocks-server and review-hang). Real server processes, the stub CLI (tests/fixtures/agentic/
// claude-stub.mjs) as the model. The request the model receives is pinned: the same flags, system prompt and stdin as
// the former blocking call and the frozen benchmark (bench-v2.0-a), so moving the call off spawnSync changed nothing
// the model sees.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/record/helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const STUB = fileURLToPath(new URL('./fixtures/agentic/claude-stub.mjs', import.meta.url));
const servers = [];
function start(env) {
  const state = tempDir('review-nb-');
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, GCL_KEYCHAIN: 'file', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '', REVIEW_TRACE_DIR: '', REVIEW_REPLAY_DIR: '', GCL_STORE: 'fake', REVIEW_EXECUTOR: 'claude', REVIEW_MODEL: 'stub-model', REVIEW_EFFORT: 'low', CLAUDE_BIN: STUB, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  if (process.env.DEBUG_REVIEW) child.stderr.on('data', d => process.stderr.write(d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server did not start')), 15000);
    child.stdout.on('data', d => { const m = /ready at https?:\/\/localhost:(\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}`)); });
  });
}
after(() => servers.forEach(c => c.kill()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FILE = 'helix-brightwater-nda-v3-helix-counter.docx';
async function imported(base) {
  const form = new FormData(); form.append('file', new Blob([readFileSync(path.join(root, 'data/fixtures/history', FILE))]), FILE);
  return (await fetch(`${base}/api/documents/import`, { method: 'POST', body: form })).json();
}
const review = (base, document, signal) => fetch(`${base}/api/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document, playbookId: 'nda' }), signal });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a slow review does not block the server: /api/status answers at once while the model works, then the review arrives', async () => {
  const base = await start({ STUB_DELAY_MS: '2000' });
  const document = await imported(base);
  const t0 = Date.now();
  const pending = review(base, document);
  await sleep(600);
  const t = Date.now(); const status = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(3000) });
  assert.equal(status.status, 200);
  assert.ok(Date.now() - t < 500, `the server answered in ${Date.now() - t} ms while the review ran`);
  const r = await pending;
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.findings)); assert.equal(body.engine, 'live-model');
  assert.ok(Date.now() - t0 >= 2000, 'the review waited for the model');
});

test('Stop: the client going away kills the CLI child; nothing is answered and the server carries on', async () => {
  const pidFile = path.join(tempDir('review-nb-pid-'), 'pid');
  const base = await start({ STUB_MODE: 'single-hang', STUB_PID_FILE: pidFile });
  const document = await imported(base);
  const controller = new AbortController();
  const pending = review(base, document, controller.signal).catch(e => e);
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(alive(pid), true, 'the CLI child is running');
  controller.abort();
  assert.equal((await pending).name, 'AbortError');
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, 'the CLI child was killed');
  assert.equal((await fetch(`${base}/api/status`)).status, 200, 'the server carries on');
});

// The single call's request as the frozen benchmark (bench-v2.0-a) and the former spawnSync call sent it.
const REVIEW_MD_SHA256 = '30fe874f506465d84d026002ceae6b91fa5e52ec7f07028006759ebe703fd370';
test('the request the model receives is unchanged: the same flags, prompts/review.md as the system prompt, the traced payload on stdin', async () => {
  const dir = tempDir('review-nb-args-'); const argsFile = path.join(dir, 'args.jsonl'); const traceDir = path.join(dir, 'trace');
  const base = await start({ STUB_ARGS_FILE: argsFile, REVIEW_TRACE_DIR: traceDir });
  const document = await imported(base);
  assert.equal((await review(base, document)).status, 200);
  const system = readFileSync(path.join(root, 'prompts/review.md'), 'utf8');
  assert.equal(createHash('sha256').update(system).digest('hex'), REVIEW_MD_SHA256, 'prompts/review.md is frozen with the benchmark');
  const sent = readFileSync(argsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, ['-p', '--model', 'stub-model', '--effort', 'low', '--system-prompt', system, '--tools', '', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--permission-prompts', 'none', '--output-format', 'json']);
  assert.equal(readFileSync(path.join(traceDir, 'review.system.txt'), 'utf8'), system);
  assert.equal(sent[0].input, readFileSync(path.join(traceDir, 'review.user.json'), 'utf8'), 'stdin is the traced payload, byte for byte');
  const payload = JSON.parse(sent[0].input);
  assert.deepEqual(Object.keys(payload), ['document', 'baseline', 'playbook', 'mode'], 'no new field reaches the model');
});
