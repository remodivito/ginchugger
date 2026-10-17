// SPDX-License-Identifier: GPL-3.0-or-later
// The local app's /api/v2 after decision 190 (product v2 spec 6.2): the record serves playbooks, clause types, actors
// and the admin routes; documents are the store's (/api/v2/store). Every matter, round, file, inbox, trash, notes,
// activity, register, search and tools route of the record is gone, and so are the folder-store and demo routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/record/helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = tempDir('http-state-');
let base, child, out = '';

function start() {
  out = '';
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, OPENAI_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '', REVIEW_EXECUTOR: 'refuse-live', REVIEW_TRACE_DIR: '', GCL_STORE: 'fake' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server did not start')), 15000);
    child.stdout.on('data', d => { out += String(d); const m = /ready at https?:\/\/localhost:(\d+)/.exec(out); if (m) { base = `http://127.0.0.1:${m[1]}`; clearTimeout(timer); resolve(); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}`)); });
  });
}

before(start);
after(() => child?.kill());
const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test('the record serves playbooks, clause types and actors; the pid file names the app; no files folder is made', async () => {
  const pbs = await get('/api/v2/playbooks');
  assert.equal(pbs.status, 200); assert.ok(pbs.body.some(p => p.id === 'nda'));
  assert.equal((await get('/api/v2/clause-types')).body.format, 'ginchugger-clause-types/1');
  assert.equal((await get('/api/v2/actors')).status, 200);
  assert.ok(existsSync(path.join(state, 'record.sqlite')));
  assert.equal(existsSync(path.join(state, 'files')), false);
  assert.ok(readFileSync(path.join(state, 'server.pid'), 'utf8').trim() === String(child.pid));
  const s = await get('/api/v2/admin/status');
  assert.equal(s.body.store.state, 'ready', 'the solo status names the store');
});

test('decision 190: the record\'s document routes, the folder-store routes and the demo routes are gone', async () => {
  for (const [method, p] of [['GET', '/api/v2/matters'], ['POST', '/api/v2/matters'], ['GET', '/api/v2/matters/m/rounds/1'], ['GET', '/api/v2/counterparties'], ['POST', '/api/v2/files'], ['GET', '/api/v2/inbox'], ['GET', '/api/v2/trash'], ['GET', '/api/v2/register'], ['GET', '/api/v2/search?q=x'], ['GET', '/api/v2/tools/search?query=x'], ['GET', '/api/v2/standard-forms'], ['GET', '/api/v2/tombstones'], ['GET', '/api/v2/activity'], ['POST', '/api/fixtures/history/load'], ['GET', '/api/fixtures/history/helix-brightwater-nda-v1.docx'], ['GET', '/api/matters']]) {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
  }
  assert.equal((await get('/api/v2/nothing-here')).body.error.code, 'not_found');
});
