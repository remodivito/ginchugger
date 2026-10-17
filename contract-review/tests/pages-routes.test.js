// SPDX-License-Identifier: GPL-3.0-or-later
// Slice S6 (pages) on real server processes with the recorded demo (replay, no model call): the playbook editor writes
// the record with real `playbook_changed` kinds, who and when (PR-PAGE-02, PR-PB-01); a review reads the playbook from
// the record; the Settings page's routes (6.2.2): the review setup in settings.json, the environment overriding it, the
// agentic switch (a review of a store document reads the store through the tools; plan task 10), the tool smoke result
// (PR-MODEL-03) and the benchmark profiles (PR-MODEL-04).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { tempDir } from './fixtures/record/helpers.js';
import { localRoutes, profileFor, BENCHMARK_PROFILES } from '../server/local-routes.js';
import { readSettings } from '../server/settings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const servers = [];
function start(env = {}) {
  const state = tempDir('pages-http-');
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: '', REVIEW_TRACE_DIR: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server did not start')), 15000);
    child.stdout.on('data', d => { const m = /ready at https?:\/\/localhost:(\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${m[1]}`, state }); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}`)); });
  });
}
after(() => servers.forEach(c => c.kill()));
const call = async (base, method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const me = userInfo().username;
const MARKUP = 'helix-northgate-order-form-v2-customer-markup.docx';
const importDoc = async (base, file) => { const form = new FormData(); form.append('file', new Blob([readFileSync(path.join(root, 'data/fixtures/order-form', file))]), file); return (await fetch(`${base}/api/documents/import`, { method: 'POST', body: form })).json(); };

test('the playbook editor saves into the record: each save is a playbook_changed event with its rule, kind, who and when; a stale save is refused', async () => {
  const { base } = await start();
  const pb = (await call(base, 'GET', '/api/v2/playbooks/order-form')).body;
  assert.equal(pb.lastChange.kind, 'imported', 'the shipped playbook was copied in once');
  const edited = pb.rules.map(r => r.id === 'CAP-01' ? { ...r, guidance: `${r.guidance} Never below twelve months' fees.` } : r);
  const saved = await call(base, 'PUT', '/api/v2/playbooks/order-form', { changeCount: pb.changeCount, rules: edited });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.changeCount, saved.body.version, saved.body.updatedBy, saved.body.lastChange], [pb.changeCount + 1, pb.changeCount + 1, me, { ruleId: 'CAP-01', kind: 'edited' }]);
  assert.ok(Date.now() - Date.parse(saved.body.updatedAt) < 60_000);

  const stale = await call(base, 'PUT', '/api/v2/playbooks/order-form', { changeCount: pb.changeCount, rules: edited });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'playbook_changed']);
  assert.equal((await call(base, 'PUT', '/api/v2/playbooks/order-form', { rules: edited })).status, 400, 'the change counter is required');

  const off = await call(base, 'PUT', '/api/v2/playbooks/order-form', { changeCount: saved.body.changeCount, rules: saved.body.rules.map(r => r.id === 'CAP-01' ? { ...r, enabled: false } : r) });
  assert.deepEqual(off.body.lastChange, { ruleId: 'CAP-01', kind: 'disabled' });
  const gone = await call(base, 'PUT', '/api/v2/playbooks/order-form', { changeCount: off.body.changeCount, rules: off.body.rules.filter(r => r.id !== 'CAP-01') });
  assert.deepEqual(gone.body.lastChange, { ruleId: 'CAP-01', kind: 'removed' });
  const list = (await call(base, 'GET', '/api/v2/playbooks')).body.find(p => p.id === 'order-form');
  assert.deepEqual([list.changeCount, list.updatedBy, list.lastChange.kind], [pb.changeCount + 3, me, 'removed']);

  // A review reads the playbook from the record: the removed entry is not in it.
  const review = (await call(base, 'POST', '/api/review', { document: await importDoc(base, MARKUP), playbookId: 'order-form' })).body;
  assert.equal(review.playbookSnapshot.version, gone.body.changeCount);
  assert.ok(!review.playbookSnapshot.rules.some(r => r.id === 'CAP-01'));
  assert.equal(review.playbookSnapshot.updatedBy, undefined, 'who changed the playbook is not sent to the model');
});

test('Use this playbook on an imported draft is an imported change; a new playbook is a created change by this user', async () => {
  const { base } = await start();
  const pb = (await call(base, 'GET', '/api/v2/playbooks/nda')).body;
  const draft = { title: 'Imported from policy.docx', provenance: { method: 'mechanical heading split, no model', source: 'policy.docx' }, rules: [{ id: 'S-01', title: 'Term', guidance: 'Two years.' }] };
  const used = await call(base, 'POST', '/api/playbook/activate?id=nda', { draft });
  assert.equal(used.status, 201);
  assert.deepEqual([used.body.changeCount, used.body.lastChange, used.body.updatedBy, used.body.provenance.source], [pb.changeCount + 1, { ruleId: null, kind: 'imported' }, me, 'policy.docx']);
  const made = await call(base, 'POST', '/api/v2/playbooks', { title: 'Vendor terms', draft: { rules: [{ id: 'V-01', title: 'Cap', guidance: 'Twelve months.' }] } });
  assert.deepEqual([made.status, made.body.id, made.body.changeCount, made.body.lastChange.kind, made.body.updatedBy], [201, 'vendor-terms', 1, 'created', me]);
});

test('settings: the environment fixes the setup it names; the agentic switch is saved and turns the store tools off', async () => {
  const { base, state } = await start({ REVIEW_TOOLS_SUPPORTED: 'true', GCL_STORE: 'fake' });
  const s = (await call(base, 'GET', '/api/v2/local/settings')).body;
  assert.deepEqual([s.effective.executor, s.locked.executor, s.locked.model, s.review.agentic], ['replay', 'REVIEW_EXECUTOR', 'REVIEW_EXECUTOR', true]);
  assert.deepEqual(s.executors, ['claude', 'anthropic', 'openai', 'replay']);
  const refused = await call(base, 'PUT', '/api/v2/local/settings', { review: { executor: 'claude' } });
  assert.deepEqual([refused.status, refused.body.error.message], [400, 'review.executor is set by REVIEW_EXECUTOR in the environment.']);
  assert.equal((await call(base, 'PUT', '/api/v2/local/settings', { review: { colour: 'red' } })).status, 400);

  // With tools, a review of a document the store holds is agentic; with the switch off it is the single call.
  for (let i = 0; i < 50 && (await call(base, 'GET', '/api/v2/store/status')).body.state !== 'ready'; i++) await new Promise(r => setTimeout(r, 100));
  const form = new FormData(); form.append('file', new Blob([readFileSync(path.join(root, 'data/fixtures/order-form', MARKUP))]), MARKUP);
  const held = await (await fetch(`${base}/api/v2/store/pane/open`, { method: 'POST', body: form })).json();
  assert.ok(Number.isInteger(held.document.id));
  const document = await importDoc(base, MARKUP);
  const review = async () => (await call(base, 'POST', '/api/review', { document, playbookId: 'order-form', reviewMode: 'own-paper', storeDocumentId: held.document.id })).body;
  assert.equal((await review()).model.agentic, true);
  assert.notEqual((await call(base, 'POST', '/api/review', { document, playbookId: 'order-form', reviewMode: 'own-paper', storeDocumentId: held.document.id, agentic: false })).body.model.agentic, true, 'the benchmark\'s agentic: false');
  const saved = await call(base, 'PUT', '/api/v2/local/settings', { review: { agentic: false } });
  assert.deepEqual([saved.status, saved.body.review.agentic], [200, false]);
  assert.equal(readSettings(state).review.agentic, false);
  assert.notEqual((await review()).model.agentic, true);
});

test('settings: without an environment override the page sets the executor, model and effort the next review uses', async () => {
  const { base, state } = await start({ REVIEW_EXECUTOR: '', REVIEW_MODEL: '', REVIEW_EFFORT: '' });
  const s = (await call(base, 'GET', '/api/v2/local/settings')).body;
  assert.deepEqual([s.locked.executor, s.locked.model, s.locked.effort], [null, null, null]);
  const saved = await call(base, 'PUT', '/api/v2/local/settings', { review: { executor: 'anthropic', model: 'claude-opus-5-5', effort: 'high' } });
  assert.deepEqual([saved.body.effective.executor, saved.body.effective.model, saved.body.effective.effort], ['anthropic', 'claude-opus-5-5', 'high']);
  const status = (await call(base, 'GET', '/api/status')).body;
  assert.deepEqual([status.executor, status.model, status.effort], ['anthropic', 'claude-opus-5-5', 'high']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, 'settings.json'), 'utf8')).review, { executor: 'anthropic', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal((await call(base, 'PUT', '/api/v2/local/settings', { review: { effort: 'max' } })).status, 400);
});

test('the tool smoke result is kept for the setup it ran on, and a failed check makes that setup single call', async () => {
  const dataDir = tempDir('local-routes-'); const env = process.env;
  const saved = { ...env };
  try {
    env.REVIEW_EXECUTOR = 'anthropic'; env.REVIEW_MODEL = 'claude-sonnet-5-5'; delete env.REVIEW_TOOLS_SUPPORTED;
    let calls = 0;
    const app = express().use('/l', localRoutes({ dataDir, fixed: new Set(['REVIEW_EXECUTOR', 'REVIEW_MODEL']), runSmoke: async ({ config }) => { calls++; assert.equal(config.toolsSupported, true); return { passed: false, calledStandardForm: false, toolCalls: [], error: new Error('no tool call') }; } }));
    const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await call(base, 'POST', '/l/tool-smoke');
      assert.equal(calls, 1);
      assert.deepEqual([r.body.toolSmoke.passed, r.body.toolSmoke.executor, r.body.toolSmoke.model, r.body.toolSmoke.error, r.body.toolsSupported], [false, 'anthropic', 'claude-sonnet-5-5', 'no tool call', false]);
      assert.equal(env.REVIEW_TOOLS_SUPPORTED, 'false');
      env.REVIEW_MODEL = 'claude-opus-5-5'; // another setup: the result no longer applies
      const other = (await call(base, 'GET', '/l/settings')).body;
      assert.equal(other.toolSmoke, null);
      const bench = (await call(base, 'GET', '/l/benchmarks')).body;
      assert.equal(bench.format, 'ginchugger-benchmark-profiles/1');
    } finally { server.close(); }
  } finally { for (const k of Object.keys(env)) if (!(k in saved)) delete env[k]; Object.assign(env, saved); }
});

// The ledger and the runs sit beside the app in the working folder; the published app alone skips this check.
const LEDGER = path.join(root, '..', 'results-ledger.md');
test('benchmark profiles: every figure cites a ledger entry and runs that exist; a setup is matched by model id or is not benchmarked', { skip: !existsSync(LEDGER) && 'results-ledger.md is not beside the app' }, () => {
  const file = JSON.parse(readFileSync(BENCHMARK_PROFILES, 'utf8'));
  const ledger = readFileSync(LEDGER, 'utf8');
  for (const p of file.profiles) for (const l of p.layers) {
    assert.ok(l.ledger.length && l.ledger.every(id => ledger.includes(`## ${id} `) || ledger.includes(`## ${id}.`)), `${p.model}: ${l.ledger}`);
    assert.ok(l.caught && l.falseAlarms, `${p.model} ${l.name}`);
    for (const run of l.runs) assert.ok(existsSync(path.join(root, '..', 'tough-eval', 'runs', run)), run);
  }
  assert.equal(profileFor(file, 'claude-opus-5-5').name, 'Opus 5.5');
  assert.equal(profileFor(file, 'replay'), null);
});
