// SPDX-License-Identifier: GPL-3.0-or-later
// The local API's protection (readiness audits, 17 Oct 2026, security findings 1, 2, 6 and 8): another page served from
// localhost on another port cannot post to /api (Origin and Sec-Fetch-Site are checked before any route), the Host check
// takes only the three loopback names, the record signing key never reaches a CLI a review spawns and is still used to
// sign /api/review-record, and a model id cannot smuggle a flag into a CLI's arguments.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocalRequest, parseHost } from '../server/local-guard.js';
import { verifyRecord } from '../server/record.js';
import { writeReviewSettings } from '../server/settings.js';
import { stopProcess, removeDir } from './fixtures/cleanup.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const SEED = 'a'.repeat(64);
const publicKeyOf = seedHex => createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

test('parseHost reads the three loopback forms, with and without a port', () => {
  assert.deepEqual(parseHost('localhost:3000'), { name: 'localhost', port: 3000 });
  assert.deepEqual(parseHost('127.0.0.1'), { name: '127.0.0.1', port: null });
  assert.deepEqual(parseHost('[::1]:3443'), { name: '[::1]', port: 3443 });
  assert.equal(parseHost('[::1'), null);
  assert.equal(parseHost(''), null);
});

test('checkLocalRequest: Host must be loopback; Origin must be this very origin; Sec-Fetch-Site must be same-origin or none on /api', () => {
  const ok = (headers, path = '/api/status') => assert.equal(checkLocalRequest({ headers, path }), null, JSON.stringify(headers));
  const no = (headers, path = '/api/status') => assert.equal(checkLocalRequest({ headers, path })?.status, 403, JSON.stringify(headers));
  ok({ host: 'localhost:3000' }); ok({ host: '127.0.0.1:3000' }); ok({ host: '[::1]:3000' });
  no({ host: 'evil.example:3000' }); no({ host: '[fe80::1]:3000' }); no({ host: 'localhost.evil.example' }); no({});
  ok({ host: 'localhost:3000', origin: 'http://localhost:3000' });
  ok({ host: 'localhost:3443', origin: 'https://localhost:3443' });
  ok({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' });
  no({ host: 'localhost:3000', origin: 'http://localhost:8011' }, '/api/v2/store/documents'); // another local page, another port
  no({ host: 'localhost:3000', origin: 'http://127.0.0.1:3000' }); // a different origin by the browser's rules
  no({ host: 'localhost:3000', origin: 'null' }); no({ host: 'localhost:3000', origin: 'file://' }); no({ host: 'localhost:3000', origin: 'https://evil.example' });
  assert.equal(checkLocalRequest({ headers: { host: 'localhost', origin: 'http://localhost' } }), null);
  assert.equal(checkLocalRequest({ headers: { host: 'localhost', origin: 'https://localhost' }, secure: true }), null);
  ok({ host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }); ok({ host: 'localhost:3000', 'sec-fetch-site': 'none' });
  no({ host: 'localhost:3000', 'sec-fetch-site': 'same-site' }); no({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' });
  ok({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }, '/'); // the pane and the pages themselves may be opened from anywhere
  ok({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }, '/help.html');
});

// One app, started as a lawyer's would be with a signing key in the environment and the Claude route, where `claude`
// is a stand-in that records the environment it was given and fails.
let child, base, port, state, bin, envFile;
before(async () => {
  state = mkdtempSync(path.join(tmpdir(), 'gcl-local-api-'));
  bin = mkdtempSync(path.join(tmpdir(), 'gcl-claude-stub-'));
  envFile = path.join(state, 'claude-env.txt');
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nenv > "${envFile}"\necho "stub: not a model" >&2\nexit 1\n`); chmodSync(path.join(bin, 'claude'), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: '0', MARGIN_STATE_DIR: state, GCL_KEYCHAIN: 'file', GCL_STORE: 'off', REVIEW_EXECUTOR: 'claude', REVIEW_RECORD_SIGNING_KEY: SEED, REVIEW_REPLAY_DIR: '', REVIEW_TRACE_DIR: '', REVIEW_TOOLS_SUPPORTED: 'false', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '' };
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`the app did not start: ${out}`)), 20_000);
    const look = d => { out += d; const m = /ready at http:\/\/localhost:(\d+)/.exec(out); if (m) { clearTimeout(timer); port = Number(m[1]); base = `http://127.0.0.1:${port}`; resolve(); } };
    child.stdout.on('data', look); child.stderr.on('data', look);
    child.on('exit', code => { clearTimeout(timer); reject(Error(`the app exited ${code}: ${out}`)); });
  });
});
after(async () => { await stopProcess(child); await removeDir(state); await removeDir(bin); });

/** A raw request, so Host (which fetch will not let a caller set) and the other headers go exactly as written. */
const raw = (method, p, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `localhost:${port}`, ...headers } }, res => { let s = ''; res.on('data', d => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, body: s })); });
  req.on('error', reject); if (body) req.write(body); req.end();
});
const doc = { id: 'local-api-doc', revision: 1, paragraphs: [{ id: 'p1', text: 'Confidential Information must be kept secret for five years after termination of this agreement.' }] };

test('a page on another localhost port cannot post to the API: Origin and Sec-Fetch-Site are refused before any route', async () => {
  const boundary = 'xyz'; const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.docx"\r\nContent-Type: application/octet-stream\r\n\r\nnot a docx\r\n--${boundary}--\r\n`;
  const cross = await raw('POST', '/api/documents/import', { headers: { origin: 'http://localhost:8011', 'content-type': `multipart/form-data; boundary=${boundary}` }, body: multipart });
  assert.equal(cross.status, 403); assert.match(cross.body, /Cross-site requests are not allowed/);
  const sameSite = await raw('POST', '/api/documents/import', { headers: { 'sec-fetch-site': 'same-site', 'content-type': `multipart/form-data; boundary=${boundary}` }, body: multipart });
  assert.equal(sameSite.status, 403);
  assert.equal((await raw('GET', '/api/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await raw('GET', '/api/status', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await raw('GET', '/api/status', { headers: { host: '[::1]:' + port } })).status, 200);
  // The pages and the pane: same origin, as the browser sends it; a plain local client: no browser headers at all.
  assert.equal((await raw('GET', '/api/status', { headers: { origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await raw('GET', '/api/status')).status, 200);
  const r = await raw('GET', '/api/status'); assert.equal(JSON.parse(r.body).executor, 'claude');
  // The page itself may be opened from anywhere (Word loads it top-level), so Sec-Fetch-Site is not checked off /api.
  assert.equal((await raw('GET', '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200);
});

test('the record signing key is not in the environment a review hands to the Claude CLI, and still signs the record', async () => {
  const r = await raw('POST', '/api/review', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: doc, playbookId: 'nda' }) });
  assert.equal(r.status, 502, r.body); assert.match(JSON.parse(r.body).error, /could not be started|could not be completed/);
  assert.ok(existsSync(envFile), 'the stand-in claude ran');
  const seen = readFileSync(envFile, 'utf8');
  assert.doesNotMatch(seen, /REVIEW_RECORD_SIGNING_KEY/); assert.doesNotMatch(seen, new RegExp(SEED));
  assert.match(seen, /^PATH=/m); // the stand-in really got an environment
  const record = await raw('POST', '/api/review-record', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: doc, review: { findings: [] }, outcomes: {}, events: [] }) });
  assert.equal(record.status, 200, record.body);
  const out = JSON.parse(record.body);
  assert.equal(out.manifest.signature?.algorithm, 'Ed25519'); assert.equal(out.manifest.signature.publicKey, publicKeyOf(SEED));
  assert.equal(verifyRecord(out, publicKeyOf(SEED)).ok, true);
});

test('a model id that would read as a CLI flag is refused by the Settings page', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcl-model-id-'));
  assert.throws(() => writeReviewSettings(dir, { model: '--dangerously-skip-permissions' }), /starts with a letter or digit/);
  assert.throws(() => writeReviewSettings(dir, { model: 'x y' }), /letters, digits/);
  assert.equal(writeReviewSettings(dir, { model: 'zai-org/glm-5.3-flash' }).model, 'zai-org/glm-5.3-flash');
  assert.equal(writeReviewSettings(dir, { model: 'claude-opus-5-5' }).model, 'claude-opus-5-5');
});
