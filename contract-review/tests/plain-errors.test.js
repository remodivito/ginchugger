// SPDX-License-Identifier: GPL-3.0-or-later
// Raw internal errors never reach the lawyer (stress audit, 17 Oct 2026; tests/stress found each message below on screen):
// the shared guard (shared/plain-error.js) used by every server error handler and by the pane's and pages' request
// helper; a review's failure in plain words (server/ask-reply.js); the store's raw Paperless replies (server/store/http.js);
// and the review route end to end with a model that answers in prose.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { looksInternal, plainMessage } from '../shared/plain-error.js';
import { reviewErrorMessage, askErrorMessage } from '../server/ask-reply.js';
import { storeErrorMessage, storeRoutes } from '../server/store/http.js';
import { storeError } from '../server/store/index.js';

// Seen on screen by the stress harness before the fix.
const RAW = [
  'The model did not return a JSON object.',
  "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
  "Expected ',' or ']' after array element in JSON at position 1566 (line 1 column 1567)",
  'Claude CLI returned an error: API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  'Claude CLI failed (exit 1): Error: spawn ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)',
  'The document store cannot be reached (fetch failed).',
  'The document store refused GET /api/documents/?query=aaaa (400: {"query":["SearchStringInvalidOrTooLong"]}).',
  'The document store could not process it: Not consumed: {"error": "document_consumer.ConsumerError", "traceback": "File /usr/src/paperless/src/documents/consumer.py"}',
  'SearchStringInvalidOrTooLong', 'ItemNotFound', "TypeError: Cannot read properties of undefined (reading 'content')", '[object Object]', 'store_unavailable',
];
// Written for people by the app: they pass unchanged.
const PLAIN = ['Supply a document with 1–1,500 paragraphs.', 'Choose a Word .docx file, up to 10 MB.', 'Give it a title.', 'Ask a question of up to 4,000 characters.', 'Playbook not found.',
  'The model is busy or at its usage limit. Wait a moment, then ask again.', 'Document exceeds the prototype limit (250,000 characters / 2,000 paragraphs).', 'Brightwater Analytics Ltd already exists.',
  'The document store could not process it: The PDF is password protected.', 'No "Section N — Title" headings found; the mechanical importer needs numbered section headings.', 'Record unavailable. Retry.', 'GinChugger could not reach the team server.'];

test('the shared guard: every raw message the harness saw is internal; the app\'s own sentences are not', () => {
  for (const m of RAW) assert.equal(looksInternal(m), true, m);
  for (const m of PLAIN) assert.equal(looksInternal(m), false, m);
  assert.equal(plainMessage(RAW[0], 'fallback'), 'fallback');
  assert.equal(plainMessage('', 'fallback'), 'fallback');
  assert.equal(plainMessage(PLAIN[0], 'fallback'), PLAIN[0]);
});

test('a review\'s failure in plain words: unreadable replies, a busy model, a CLI that fails; the review\'s own input checks pass', () => {
  assert.equal(reviewErrorMessage(Error(RAW[0])), 'The model’s reply could not be read as a review. Review again.');
  assert.equal(reviewErrorMessage(Error(RAW[1])), 'The model’s reply could not be read as a review. Review again.');
  assert.equal(reviewErrorMessage(Error(RAW[3])), 'The model is busy or at its usage limit. Wait a moment, then review again.');
  assert.equal(reviewErrorMessage(Error(RAW[4])), 'The model could not be started on this computer. Check the review setup under Settings · Models, then review again.');
  assert.equal(reviewErrorMessage(Error('Claude CLI failed (exit 1): boom')), 'The review could not be completed. Review again.');
  assert.equal(reviewErrorMessage(Error('Supply a document with 1–1,500 paragraphs.')), 'Supply a document with 1–1,500 paragraphs.');
  assert.equal(reviewErrorMessage(Error('The recorded runs do not include "review" for this document. They cover the demonstration documents only.')), 'The recorded runs do not include "review" for this document. They cover the demonstration documents only.');
  for (const m of RAW.slice(0, 5)) { assert.equal(looksInternal(reviewErrorMessage(Error(m))), false); assert.equal(looksInternal(askErrorMessage(Error(m))), false); }
});

test('the replay executor\'s coverage line passes through Ask unchanged (readiness audit, 17 Oct 2026: the pane said "Ask again")', () => {
  const line = 'The recorded runs do not include "ask" for this document. They cover the demonstration documents only.';
  assert.equal(askErrorMessage(Error(line)), line);
  assert.equal(askErrorMessage(Error('something else entirely')), 'The question could not be answered. Ask again.');
});

test('the store\'s raw replies in plain words, by code; a plain store message passes', () => {
  assert.equal(storeErrorMessage(storeError(503, 'store_unavailable', RAW[5])), 'The document store cannot be reached. Try again in a moment.');
  assert.equal(storeErrorMessage(storeError(400, 'store_rejected', RAW[6], { upstreamStatus: 400 })), 'The document store refused that. Try again, or try different words or a different file.');
  assert.equal(storeErrorMessage(storeError(422, 'store_task_failed', RAW[7])), 'The document store could not add this file.');
  assert.equal(storeErrorMessage(storeError(422, 'store_task_failed', 'The document store could not process it: The PDF is password protected.')), 'The document store could not process it: The PDF is password protected.');
  assert.equal(storeErrorMessage(storeError(400, 'store_rejected', 'Brightwater Analytics Ltd already exists.')), 'Brightwater Analytics Ltd already exists.');
  assert.equal(storeErrorMessage(Error("TypeError: Cannot read properties of undefined (reading 'id')")), 'The document store could not do that. Try again.');
});

test('the store routes answer a raw Paperless failure with a plain sentence and log the raw one', async () => {
  const logged = [];
  const failing = { check: async () => ({ state: 'ready' }), getClient: () => ({ list: async () => { throw storeError(400, 'store_rejected', RAW[6], { upstreamStatus: 400 }); }, search: async () => { throw storeError(503, 'store_unavailable', RAW[5]); } }) };
  const app = express(); app.use('/s', storeRoutes(failing, { log: { error: m => logged.push(m) } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/s`;
    const list = await (await fetch(`${base}/documents`)).json();
    assert.equal(list.error, 'The document store refused that. Try again, or try different words or a different file.');
    const search = await fetch(`${base}/documents?q=${'a'.repeat(300)}`);
    assert.equal(search.status, 503);
    assert.equal((await search.json()).error, 'The document store cannot be reached. Try again in a moment.');
    assert.ok(logged.some(m => m.includes('fetch failed')), 'the raw message goes to the log');
  } finally { server.close(); }
});

// The route end to end: a recorded "model" that answered in prose, as the live model did in Word.
const root = fileURLToPath(new URL('../', import.meta.url));
const servers = [];
after(() => servers.forEach(c => c.kill()));
function start(env) {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: mkdtempSync(path.join(tmpdir(), 'gcl-plain-')), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', REVIEW_TRACE_DIR: '', GCL_STORE: 'off', REVIEW_TOOLS_SUPPORTED: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server did not start')), 15000);
    child.stdout.on('data', d => { const m = /ready at https?:\/\/localhost:(\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}`)); });
  });
}
test('POST /api/review with a model that answers in prose says so in plain words, as a 502, never "did not return a JSON object"', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcl-plain-replay-'));
  writeFileSync(path.join(dir, 'review.raw.txt'), '### What changed\n\n- **Payment** moves to 90 days.');
  const base = await start({ REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: dir });
  const form = new FormData(); form.append('file', new Blob([readFileSync(path.join(root, 'data/fixtures/history/helix-brightwater-nda-v3-helix-counter.docx'))]), 'v3.docx');
  const document = await (await fetch(`${base}/api/documents/import`, { method: 'POST', body: form })).json();
  const r = await fetch(`${base}/api/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document, playbookId: 'nda' }) });
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'The model’s reply could not be read as a review. Review again.' });
  // The input checks are still said as they are.
  const bad = await fetch(`${base}/api/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: { id: 'x', paragraphs: [] }, playbookId: 'nda' }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Supply a document with 1–1,500 paragraphs.');
});

test('the pane\'s own guard: a server message that shows internals, or Word\'s bare code, is never what the pane shows', async () => {
  const { plainError } = await import('../src/word.js');
  assert.equal(plainError(Object.assign(Error(RAW[0]), { status: 400 })), 'That did not work. Try again.');
  assert.equal(plainError(Object.assign(Error('Supply a document with 1–1,500 paragraphs.'), { status: 400 })), 'Supply a document with 1–1,500 paragraphs.');
  assert.equal(plainError(Object.assign(Error('SearchStringInvalidOrTooLong'), { code: 'SearchStringInvalidOrTooLong' })), 'Word could not search for that passage. Apply the wording in Word by hand.');
  assert.equal(plainError(Error('SomethingNewFromWordApi')), 'Word could not make the change. Try again, or apply it by hand.');
  assert.equal(plainError(Error("TypeError: Cannot read properties of undefined (reading 'items')")), 'Word could not make the change. Try again, or apply it by hand.');
});
