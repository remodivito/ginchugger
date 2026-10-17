// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's live progress (Ask C, 17 Oct 2026) on real server processes with the store in its in-memory mode: /api/ask with
// `stream: true` answers in NDJSON, one step per store lookup as the model makes it, then the answer. The model is a
// recorded run with its tool calls (replay), or the stub Claude CLI (tests/fixtures/agentic/claude-stub.mjs), which
// calls the store tools through the real MCP child and tools listener. Stop: the client going away kills the CLI child.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/record/helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const STUB = fileURLToPath(new URL('./fixtures/agentic/claude-stub.mjs', import.meta.url));
const servers = [];
function start(env) {
  const state = tempDir('ask-stream-');
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '', REVIEW_TRACE_DIR: '', GCL_STORE: 'fake', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  if (process.env.DEBUG_ASK) child.stderr.on('data', d => process.stderr.write(d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server did not start')), 15000);
    child.stdout.on('data', d => { const m = /ready at https?:\/\/localhost:(\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}`)); });
  });
}
after(() => servers.forEach(c => c.kill()));
const json = async (base, method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const FILES = ['helix-brightwater-nda-v1.docx', 'helix-brightwater-nda-v2-bw-markup.docx', 'helix-brightwater-nda-v3-helix-counter.docx'];
const read = f => readFileSync(path.join(root, 'data/fixtures/history', f));

/** Three Brightwater NDAs in the store (v1 signed); returns the store ids and v3 as the pane sends it. */
async function storeSet(base) {
  for (let i = 0; i < 50 && (await json(base, 'GET', '/api/v2/store/status')).body.state !== 'ready'; i++) await new Promise(r => setTimeout(r, 100));
  const ids = {};
  for (const f of FILES) {
    const form = new FormData(); form.append('file', new Blob([read(f)]), f);
    const d = (await (await fetch(`${base}/api/v2/store/pane/open`, { method: 'POST', body: form })).json()).document;
    await json(base, 'POST', `/api/v2/store/documents/${d.id}/done`, { counterparty: 'Brightwater Analytics Ltd', type: 'NDA', tags: f.includes('v1') ? ['signed'] : [] });
    ids[f] = d.id;
  }
  const form = new FormData(); form.append('file', new Blob([read(FILES[2])]), FILES[2]);
  const document = await (await fetch(`${base}/api/documents/import`, { method: 'POST', body: form })).json();
  return { ids, document };
}
/** The NDJSON lines of a streamed answer, parsed. */
async function streamed(base, body, { signal } = {}) {
  const r = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/x-ndjson/);
  return (await r.text()).split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const question = 'What did we accept from Brightwater before?';

test('a recorded run with tool calls: each lookup is a step as it starts and ends, then the answer with titled sources', async () => {
  const dir = tempDir('ask-replay-');
  const base = await start({ REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: dir });
  const { ids, document } = await storeSet(base);
  const v1 = ids[FILES[0]];
  writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify({ answer: '**Three years.**\n\n- signed in v1', evidence: [], sources: [{ documentId: v1, quote: 'not in the text', note: 'v1' }], ruleIds: [], limits: [] }));
  writeFileSync(path.join(dir, 'ask.tools.jsonl'), [
    { name: 'get_counterparty_overview', args: {}, result: { counterparty: 'Brightwater Analytics Ltd', documentCount: 3, types: [{ type: 'NDA', documents: [{ documentId: v1, title: 'Helix NDA v1 (signed)' }] }] } },
    { name: 'read_document', args: { documentId: v1 }, result: { document: { documentId: v1, title: 'Helix NDA v1 (signed)' }, paragraphs: [] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  const lines = await streamed(base, { document, question, playbookId: 'nda', storeDocumentId: ids[FILES[2]] });
  const steps = lines.filter(l => l.type === 'step').map(l => `${l.step.state}:${l.step.text}`);
  assert.deepEqual(steps, [
    'active:Reading this draft', 'done:Read this draft',
    'active:Searching Brightwater Analytics Ltd’s documents', 'done:Searched Brightwater Analytics Ltd’s documents · 3 found',
    'active:Reading Helix NDA v1 (signed)', 'done:Read Helix NDA v1 (signed)',
  ]);
  const answer = lines.at(-1);
  assert.equal(answer.type, 'answer');
  assert.equal(answer.answer.answer, '**Three years.**\n\n- signed in v1');
  assert.equal(answer.answer.sources[0].documentId, v1); assert.equal(answer.answer.sources[0].verified, false);
  assert.equal(answer.answer.sources[0].title, 'helix-brightwater-nda-v1', 'the title is the store\'s, read for the list');
  assert.match(answer.answer.sources[0].date, /^\d{4}-\d{2}-\d{2}$/);
  // Without `stream` the route answers with one JSON body, as before.
  const plain = await json(base, 'POST', '/api/ask', { document, question, playbookId: 'nda', storeDocumentId: ids[FILES[2]] });
  assert.equal(plain.status, 200); assert.equal(plain.body.answer, '**Three years.**\n\n- signed in v1');
});

test('without tool calling the counterparty\'s documents are read as one step; a failed call ends the stream with an error line', async () => {
  const dir = tempDir('ask-replay-');
  const base = await start({ REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: dir, REVIEW_TOOLS_SUPPORTED: 'false' });
  const { ids, document } = await storeSet(base);
  writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify({ answer: 'From v1.', evidence: [], ruleIds: [], limits: [] }));
  const lines = await streamed(base, { document, question, playbookId: 'nda', storeDocumentId: ids[FILES[2]] });
  assert.deepEqual(lines.filter(l => l.type === 'step').map(l => `${l.step.state}:${l.step.text}`), [
    'active:Reading Brightwater Analytics Ltd’s documents', 'done:Read Brightwater Analytics Ltd’s documents · 2 found',
    'active:Reading this draft', 'done:Read this draft',
  ]);
  assert.equal(lines.at(-1).answer.answer, 'From v1.');
  writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify({ answer: '' }));
  const failed = await streamed(base, { document, question, playbookId: 'nda' });
  assert.deepEqual(failed.at(-1), { type: 'error', error: 'No answer came back. Ask again.' });
  // A bad request is refused before any streaming, as before.
  const bad = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document, question: '', stream: true }) });
  assert.equal(bad.status, 400);
});

test('the Claude CLI: lookups through the MCP child and the tools listener stream as they happen; Stop kills the CLI', async () => {
  const pidFile = path.join(tempDir('ask-stub-'), 'pid');
  const base = await start({ REVIEW_EXECUTOR: 'claude', CLAUDE_BIN: STUB, STUB_MODE: 'ask' });
  const { ids, document } = await storeSet(base);
  const lines = await streamed(base, { document, question, playbookId: 'nda', storeDocumentId: ids[FILES[2]] });
  const steps = lines.filter(l => l.type === 'step').map(l => `${l.step.state}:${l.step.text}`);
  assert.deepEqual(steps.slice(0, 4), ['active:Reading this draft', 'done:Read this draft', 'active:Searching Brightwater Analytics Ltd’s documents', 'done:Searched Brightwater Analytics Ltd’s documents · 3 found']);
  assert.match(steps[4], /^active:Reading helix-brightwater-nda-v/); assert.match(steps[5], /^done:Read helix-brightwater-nda-v/);
  const answer = lines.at(-1).answer;
  assert.match(answer.answer, /^\*\*Yes\.\*\*/); assert.equal(answer.sources[0].verified, true); assert.match(answer.sources[0].title, /^helix-brightwater-nda-v/);

  // Stop: a CLI that never answers is killed when the client goes away.
  const hanging = await start({ REVIEW_EXECUTOR: 'claude', CLAUDE_BIN: STUB, STUB_MODE: 'ask-hang', STUB_PID_FILE: pidFile });
  const set = await storeSet(hanging);
  const controller = new AbortController();
  const r = await fetch(`${hanging}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: set.document, question, playbookId: 'nda', storeDocumentId: set.ids[FILES[2]], stream: true }), signal: controller.signal });
  const reader = r.body.getReader(); let seen = '';
  while (!seen.includes('Searched')) seen += new TextDecoder().decode((await reader.read()).value);
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise(res => setTimeout(res, 100));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true);
  controller.abort();
  for (let i = 0; i < 50 && alive(); i++) await new Promise(res => setTimeout(res, 100));
  assert.equal(alive(), false, 'the CLI child was killed');
  assert.equal((await json(hanging, 'GET', '/api/status')).status, 200, 'the server carries on');
});

/** A streamed answer read line by line with the time each line arrived (ms from the request). */
async function timedLines(base, body) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }) });
  const reader = r.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const out = [];
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const parts = buffer.split('\n'); buffer = done ? '' : parts.pop();
    for (const l of parts) if (l.trim()) out.push({ at: Date.now() - t0, line: JSON.parse(l) });
    if (done) return out;
  }
}

test('the Claude CLI\'s single call (no store document) does not block the server: steps arrive at once, progress can be polled, other requests are served', async () => {
  const base = await start({ REVIEW_EXECUTOR: 'claude', CLAUDE_BIN: STUB, STUB_MODE: 'single-slow', STUB_DELAY_MS: '1500' });
  const { document } = await storeSet(base);
  const askId = 'test-ask-0001';
  const pending = timedLines(base, { document, question, playbookId: 'nda', askId });
  await new Promise(r => setTimeout(r, 600));
  const t = Date.now(); const status = await json(base, 'GET', '/api/status');
  assert.equal(status.status, 200); assert.ok(Date.now() - t < 500, 'the server answers while the model works');
  const polled = await json(base, 'GET', `/api/ask/progress/${askId}`);
  assert.deepEqual(polled.body, { steps: [{ id: 'draft', text: 'Reading this draft', state: 'active' }], done: false });
  const lines = await pending;
  assert.equal(lines[0].line.type, 'start'); assert.equal(lines[0].line.askId, askId);
  const first = lines.find(l => l.line.type === 'step'); const answer = lines.at(-1);
  assert.equal(answer.line.type, 'answer');
  assert.ok(answer.at - first.at > 1000, `the first step came ${answer.at - first.at} ms before the answer`);
  assert.equal(answer.line.answer.answer, '**Two changes.**\n- payment\n- cap', 'the JSON object is found inside a fenced block');
  const after = await json(base, 'GET', `/api/ask/progress/${askId}`);
  assert.equal(after.body.done, true); assert.equal(after.body.steps[0].state, 'done');
  assert.deepEqual((await json(base, 'GET', '/api/ask/progress/unknown-id-1')).body, { steps: [], done: false });
});

test('a reply in prose is asked for again once; still prose, it is shown with a plain line that its sources could not be checked', async () => {
  const argsFile = path.join(tempDir('ask-args-'), 'args.jsonl');
  const once = await start({ REVIEW_EXECUTOR: 'claude', CLAUDE_BIN: STUB, STUB_MODE: 'single-prose-once', STUB_ARGS_FILE: argsFile });
  const { document } = await storeSet(once);
  const fixed = (await streamed(once, { document, question: 'What did they change in this draft?', playbookId: 'nda' })).at(-1);
  assert.equal(fixed.type, 'answer'); assert.equal(fixed.answer.answer, '**Two changes.**\n- payment\n- cap');
  assert.equal(fixed.answer.unchecked, undefined); assert.equal(fixed.answer.model.retried, true);
  const sent = readFileSync(argsFile, 'utf8').trim().split('\n').length;
  assert.equal(sent, 2, 'one retry, not more');
  assert.match(readFileSync(argsFile, 'utf8'), /Return only the JSON object described/);

  const prose = await start({ REVIEW_EXECUTOR: 'claude', CLAUDE_BIN: STUB, STUB_MODE: 'single-prose' });
  const set = await storeSet(prose);
  const shown = (await streamed(prose, { document: set.document, question: 'What did they change in this draft?', playbookId: 'nda' })).at(-1);
  assert.equal(shown.type, 'answer');
  assert.equal(shown.answer.answer, '### What changed\n- **Payment** moves to 90 days.\n- The cap drops to 3%.');
  assert.equal(shown.answer.unchecked, true); assert.deepEqual(shown.answer.evidence, []);
  assert.ok(!shown.answer.limits.some(l => /No passage of the agreement/.test(l)));
});

test('with the store tools: a prose reply is corrected by a second call; a failing CLI is reported in plain words', async () => {
  const base = await start({ REVIEW_EXECUTOR: 'claude', CLAUDE_BIN: STUB, STUB_MODE: 'ask-prose-once' });
  const { ids, document } = await storeSet(base);
  const lines = await streamed(base, { document, question, playbookId: 'nda', storeDocumentId: ids[FILES[2]] });
  const answer = lines.at(-1);
  assert.equal(answer.type, 'answer'); assert.match(answer.answer.answer, /^\*\*Yes\.\*\*/); assert.equal(answer.answer.sources[0].verified, true);
  assert.equal(answer.answer.model.retried, true);
  assert.equal(answer.answer.toolCalls.length, 4, 'both attempts\' lookups are kept');

  const failing = await start({ REVIEW_EXECUTOR: 'claude', CLAUDE_BIN: STUB, STUB_MODE: 'exit-error' });
  const set = await storeSet(failing);
  const failed = (await streamed(failing, { document: set.document, question, playbookId: 'nda', storeDocumentId: set.ids[FILES[2]] })).at(-1);
  assert.deepEqual(failed, { type: 'error', error: 'The question could not be answered. Ask again.' });
});
