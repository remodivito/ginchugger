// SPDX-License-Identifier: GPL-3.0-or-later
// Playbook routes with the library (Phase 7): old callers get the NDA playbook; a review names the playbook and version
// it used; Add to playbook saves into that playbook and nowhere else; the suggestion route proposes from facts only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopProcess, removeDir } from './fixtures/cleanup.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let base; // the server takes a free port and names it, so test files can run side by side
let server, state;
before(async () => {
  state = await mkdtemp(path.join(tmpdir(), 'margin-playbooks-'));
  server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, OPENAI_API_KEY: '', OPENAI_MODEL: '', HTTPS_KEY: '', HTTPS_CERT: '', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: '', REVIEW_TRACE_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Test server did not start')), 10000);
    server.stdout.on('data', d => { const m = /ready at https?:\/\/localhost:(\d+)/.exec(String(d)); if (m) { base = `http://127.0.0.1:${m[1]}`; clearTimeout(timer); resolve(); } });
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Test server exited ${code}`)); });
  });
});
after(async () => { await stopProcess(server); await removeDir(state); });
const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const send = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
// Reviews run on the replay executor this test starts (the recorded demo); the order-form markup is one of the recorded documents.
const MARKUP = 'helix-northgate-order-form-v2-customer-markup.docx';
const markupDocument = async () => { const { importDocx } = await import('../server/docx.js'); return importDocx(readFileSync(path.join(root, 'data/fixtures/order-form', MARKUP)), MARKUP); };

test('the library lists both playbooks; no id answers for the NDA playbook as before; an unknown id is refused', async () => {
  const list = (await get('/api/playbooks')).body;
  assert.deepEqual(list.map(p => [p.id, p.version, p.appliesTo.label]), [['nda', 1, 'Mutual NDAs'], ['order-form', 1, 'Customer order forms on our paper']]);
  const plain = (await get('/api/playbook')).body; assert.equal(plain.id, 'nda'); assert.deepEqual(plain.rules.map(r => r.id), ['DUR-01', 'USE-01', 'RET-01']);
  assert.equal((await get('/api/playbook?id=order-form')).body.rules.length, 8);
  assert.equal((await get('/api/playbook?id=nope')).status, 404);
});

test('a review names the playbook and version it used; without an id it uses the NDA playbook', async () => {
  const document = await markupDocument();
  const withId = await send('POST', '/api/review', { document, playbookId: 'order-form' });
  assert.equal(withId.status, 200); assert.deepEqual(withId.body.playbook, { id: 'order-form', title: 'Order forms (demonstration)', version: 1 });
  assert.equal(withId.body.playbookSnapshot.id, 'order-form'); assert.ok(withId.body.findings.some(f => f.ruleIds.includes('CAP-01')));
  const without = await send('POST', '/api/review', { document });
  assert.equal(without.body.playbook.id, 'nda'); assert.ok(!without.body.findings.some(f => f.ruleIds.includes('CAP-01')), 'the NDA playbook has no cap entry');
  assert.equal((await send('POST', '/api/review', { document, playbookId: 'nope' })).status, 404);
});

test('Add to playbook saves into the playbook the review used and nowhere else; the next review sees it as changed', async () => {
  const review = (await send('POST', '/api/review', { document: await markupDocument(), playbookId: 'order-form' })).body;
  const target = (await get(`/api/playbook?id=${review.playbook.id}`)).body; const ndaBefore = (await get('/api/playbook')).body;
  const entry = { id: 'RULE-added', title: 'Cap carve-outs for strategic customers', topic: 'custom', guidance: 'Accept one carve-out for strategic customers.', enabled: true };
  const saved = await send('PUT', `/api/playbook?id=${review.playbook.id}`, { ...target, rules: [...target.rules, entry] });
  assert.equal(saved.status, 200); assert.equal(saved.body.id, 'order-form'); assert.equal(saved.body.version, 2); assert.ok(saved.body.rules.some(r => r.id === 'RULE-added'));
  const ndaAfter = (await get('/api/playbook')).body; assert.deepEqual(ndaAfter, ndaBefore, 'the NDA playbook is unchanged');
  assert.notEqual(saved.body.version, review.playbookVersion, 'the review is now behind its own playbook');
  // An old caller that PUTs what it read (which carries the NDA id) still edits the NDA playbook.
  const old = await send('PUT', '/api/playbook', { ...ndaAfter, rules: [...ndaAfter.rules, { ...entry, id: 'RULE-nda' }] });
  assert.equal(old.body.id, 'nda'); assert.equal((await get('/api/playbook?id=order-form')).body.version, 2);
});

test('a draft saved as a new playbook needs a name, lands beside the others and leaves them unchanged', async () => {
  const before = (await get('/api/playbooks')).body;
  const draft = { title: 'Imported', rules: [{ id: 'S-01', title: 'Payment', guidance: 'Thirty days.', sources: [{ document: 'policy-note.txt', paragraph: 'p3', quote: 'within 30 days', verified: true }] }] };
  assert.equal((await send('POST', '/api/playbooks', { draft })).status, 400);
  const made = await send('POST', '/api/playbooks', { title: 'Order forms (imported)', appliesTo: { label: 'Customer order forms', phrases: ['order form'] }, draft, origin: 'import' });
  assert.equal(made.status, 201); assert.equal(made.body.id, 'order-forms-imported'); assert.equal(made.body.rules[0].sources[0].verified, true);
  const after = (await get('/api/playbooks')).body;
  assert.deepEqual(after.slice(0, before.length), before); assert.equal(after.at(-1).id, 'order-forms-imported');
});
