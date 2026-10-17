// SPDX-License-Identifier: GPL-3.0-or-later
// /api/review and /api/ask on a document the store holds (plan task 10), on real server processes with the store in
// its in-memory mode and the recorded demo (replay, no model call). Agentic: the payload carries the store brief (the
// document, its counterparty, how many other and signed documents) and no history; the model reads the store through
// the tools. Single call (a setup without tools): no brief, and the review says the store was not consulted. Outside the
// store, neither. /api/review writes no review events: the pane is their one writer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/record/helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const servers = [];
function start(env) {
  const state = tempDir('review-http-'); const trace = tempDir('review-trace-');
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, OPENAI_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: '', REVIEW_TRACE_DIR: trace, GCL_STORE: 'fake', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server did not start')), 15000);
    child.stdout.on('data', d => { const m = /ready at https?:\/\/localhost:(\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${m[1]}`, trace }); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}`)); });
  });
}
after(() => servers.forEach(c => c.kill()));
const json = async (base, method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const FILES = ['helix-brightwater-nda-v1.docx', 'helix-brightwater-nda-v2-bw-markup.docx', '2026-05-19-brightwater-returns-markup.eml', 'helix-brightwater-nda-v3-helix-counter.docx'];
const read = f => readFileSync(path.join(root, 'data/fixtures/history', f));

/** The demo set's files in the store under Brightwater (one signed), then the counter-turn (v3) reviewed as the pane sends it. */
async function reviewInStore(base, extra = {}) {
  for (let i = 0; i < 50 && (await json(base, 'GET', '/api/v2/store/status')).body.state !== 'ready'; i++) await new Promise(r => setTimeout(r, 100));
  const ids = {};
  for (const f of FILES) {
    const form = new FormData(); form.append('file', new Blob([read(f)]), f);
    const d = (await (await fetch(`${base}/api/v2/store/pane/open`, { method: 'POST', body: form })).json()).document;
    await json(base, 'POST', `/api/v2/store/documents/${d.id}/done`, { counterparty: 'Brightwater Analytics Ltd', type: f.endsWith('.eml') ? 'Email' : 'NDA', tags: f.includes('v1') ? ['signed'] : [] });
    ids[f] = d.id;
  }
  const form = new FormData(); form.append('file', new Blob([read(FILES[3])]), FILES[3]);
  const document = await (await fetch(`${base}/api/documents/import`, { method: 'POST', body: form })).json();
  const id = ids[FILES[3]];
  const r = await json(base, 'POST', '/api/review', { document, playbookId: 'nda', reviewMode: 'own-paper', storeDocumentId: id, ...extra });
  const events = (await json(base, 'GET', `/api/v2/store/documents/${id}/review-events`)).body;
  return { ids, document, review: r, eventsWritten: events.length };
}

test('agentic on a store document: the payload carries the store brief and no history; outside the store neither; no events written', async () => {
  const { base, trace } = await start({});
  const { ids, document, review: r, eventsWritten } = await reviewInStore(base);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.model.agentic, true); assert.equal(r.body.model.promptFile, 'prompts/review-record.md');
  const sent = JSON.parse(readFileSync(path.join(trace, 'review.user.json'), 'utf8'));
  assert.equal(sent.history, undefined); assert.equal(sent.matter, undefined);
  assert.deepEqual(sent.store, { document: { documentId: ids[FILES[3]], title: 'helix-brightwater-nda-v3-helix-counter', type: 'NDA', date: sent.store.document.date, signed: false }, counterparty: 'Brightwater Analytics Ltd', documentsInStore: 4, otherDocumentsWithThisCounterparty: 3, signedDocumentsWithThisCounterparty: 1 });
  assert.match(readFileSync(path.join(trace, 'review.system.txt'), 'utf8'), /\*\*The document store\.\*\*/);
  assert.equal(eventsWritten, 0, '/api/review writes no events');
  const outside = await json(base, 'POST', '/api/review', { document, playbookId: 'nda', agentic: true });
  assert.equal(outside.status, 200); assert.equal(outside.body.model.agentic, false);
  const plain = JSON.parse(readFileSync(path.join(trace, 'review.user.json'), 'utf8'));
  assert.equal(plain.history, undefined); assert.equal(plain.store, undefined);
  // A document id the store does not hold: the review runs, without the store.
  const missing = await json(base, 'POST', '/api/review', { document, playbookId: 'nda', storeDocumentId: 999 });
  assert.equal(missing.status, 200); assert.equal(missing.body.model.agentic, true, 'the tools still read the store; there is just no document under review');
});

test('single call on a store document: no store brief, the store-not-consulted limit; Ask falls back to the counterparty\'s documents', async () => {
  const { base, trace } = await start({ REVIEW_TOOLS_SUPPORTED: 'false' });
  const { ids, document, review: r } = await reviewInStore(base);
  assert.equal(r.status, 200);
  assert.equal(r.body.model.agentic, false);
  assert.ok(r.body.limits.includes('Document store not consulted by the model: this setup runs the single-call review.'));
  const sent = JSON.parse(readFileSync(path.join(trace, 'review.user.json'), 'utf8'));
  assert.equal(sent.store, undefined); assert.equal(sent.history, undefined);
  // Ask: no tool calling here, so the counterparty's other documents go with the question (no recorded answer for it:
  // the replay refuses, which is enough to see what was sent).
  await json(base, 'POST', '/api/ask', { document, question: 'What did we accept from Brightwater before?', playbookId: 'nda', storeDocumentId: ids[FILES[3]] });
  const asked = JSON.parse(readFileSync(path.join(trace, 'ask.user.json'), 'utf8'));
  assert.equal(asked.counterpartyDocuments.counterparty, 'Brightwater Analytics Ltd');
  assert.deepEqual(asked.counterpartyDocuments.documents.map(d => d.documentId).sort(), [ids[FILES[0]], ids[FILES[1]], ids[FILES[2]]].sort());
  assert.equal(asked.store, undefined);
});

test('Ask with tools on a store document: the payload carries the store brief instead of the documents', async () => {
  const { base, trace } = await start({});
  const { ids, document } = await reviewInStore(base);
  await json(base, 'POST', '/api/ask', { document, question: 'What did we accept from Brightwater before?', playbookId: 'nda', storeDocumentId: ids[FILES[3]] });
  const asked = JSON.parse(readFileSync(path.join(trace, 'ask.user.json'), 'utf8'));
  assert.equal(asked.store.counterparty, 'Brightwater Analytics Ltd'); assert.equal(asked.counterpartyDocuments, undefined);
  assert.match(readFileSync(path.join(trace, 'ask.system.txt'), 'utf8'), /at most 8 calls/);
});
