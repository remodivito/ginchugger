// SPDX-License-Identifier: GPL-3.0-or-later
// The local app in team mode (product v2 spec 6.1, 6.2.2, 7.10, 7.11; slice S7): HTTPS only (PR-SEC-04), an untrusted
// certificate named by subject and fingerprint, RemoteRecord's 60-second cache and its invalidation, the server
// unreachable as `record_unavailable`, the version banner (PR-TEAM-07), keys in the keychain or a 0600 file
// (PR-TEAM-03), and a spawned local app joining a team, being revoked, and reviewing with the server down (PR-TEAM-06).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkServerUrl, readSettings } from '../server/settings.js';
import { openRemoteRecord, probeCertificate, redeemCode, CACHE_MS } from '../server/record/remote.js';
import { versionBanner, compareVersions } from '../shared/version.js';
import { openSecrets, secretsLoader, SERVICE, OLD_SERVICE } from '../server/secrets.js';
import { importDocx } from '../server/docx.js';
import { startTeam, CA_FILE, TLS, quiet } from './fixtures/team.js';
import { tempDir } from './fixtures/record/helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('PR-SEC-04: the local app takes an https:// server address only', () => {
  assert.throws(() => checkServerUrl('http://gcl.office.example:8443'), e => e.code === 'https_required');
  assert.throws(() => checkServerUrl('gcl.office.example'), e => e.status === 400);
  assert.equal(checkServerUrl(' https://gcl.office.example:8443/ '), 'https://gcl.office.example:8443');
  assert.throws(() => openRemoteRecord({ url: 'http://localhost:8443', key: 'k' }), e => e.code === 'https_required');
});

test('7.10: a certificate the app does not trust is refused, and the probe names its subject and SHA-256 fingerprint', async () => {
  const team = await startTeam();
  try {
    const { code } = await team.issue('Ada Admin', true);
    await assert.rejects(redeemCode(team.url, { code }), e => e.code === 'certificate_untrusted' && e.status === 503);
    const cert = await probeCertificate(team.url);
    const x = new X509Certificate(readFileSync(path.join(TLS, 'server.crt')));
    assert.deepEqual([cert.subject, cert.fingerprint256], ['CN=localhost', x.fingerprint256]);
    assert.equal((await redeemCode(team.url, { code }, { ca: team.ca })).name, 'Ada Admin'); // with IT's CA, the same code works
  } finally { await team.close(); }
});

test('6.1: reads are cached for 60 seconds by URL and revalidated by the record generation; any write clears the cache; an unreachable server is 503 record_unavailable', async () => {
  let t = 1_000_000;
  const team = await startTeam();
  const ada = await team.member('Ada Admin', true, { now: () => t });
  try {
    const n = (await ada.remote.playbooks.list()).length;
    const pb = await ada.remote.playbooks.create({ title: 'Acme terms', draft: { rules: [] } });
    assert.equal((await ada.remote.playbooks.list()).length, n + 1);
    const s0 = ada.remote.cacheStats();
    assert.equal((await ada.remote.playbooks.list()).length, n + 1);
    assert.deepEqual(ada.remote.cacheStats(), { fetched: s0.fetched, notModified: s0.notModified + 1 }, 'unchanged: answered 304 from the cache');
    await team.srv.record.playbooks.create({ title: 'Zenith terms', draft: { rules: [] } }, 'system:gcl'); // another member's write, on the server
    assert.equal((await ada.remote.playbooks.list()).length, n + 2, 'a colleague’s write shows at once');
    assert.equal(ada.remote.cacheStats().fetched, s0.fetched + 1);
    t += CACHE_MS + 1;
    assert.equal((await ada.remote.playbooks.list()).length, n + 2);
    assert.equal(ada.remote.cacheStats().fetched, s0.fetched + 2, 'after 60 seconds the entry is read again in full');
    await ada.remote.playbooks.update(pb.id, { title: 'Acme supply terms', rules: [] }, pb.changeCount);
    assert.equal((await ada.remote.playbooks.list()).find(p => p.id === pb.id).title, 'Acme supply terms', 'a write cleared the cache');
  } finally { await team.close(); }
  await assert.rejects(ada.remote.playbooks.list(), e => e.status === 503 && e.code === 'record_unavailable' && /cannot be reached/.test(e.message));
  ada.remote.close();
});

test('7.11: the banner shows on a major difference or below either minimum, with the server release link; it never blocks', () => {
  const releases = 'https://github.com/o/gin-chugger-legal/releases/tag/';
  assert.equal(versionBanner({ app: '2.0.3', server: '2.1.0', releases }), null);
  assert.deepEqual(versionBanner({ app: '2.0.3', server: '3.0.0', releases }), { text: 'Your app is 2.0.3; the team server is 3.0.0. Install the matching release.', link: `${releases}v3.0.0` });
  assert.ok(versionBanner({ app: '2.0.3', server: '2.1.0', minClientVersion: '2.1.0', releases }));
  assert.ok(versionBanner({ app: '2.1.0', server: '2.0.0', minServerVersion: '2.0.1', releases }));
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  const app = readFileSync(path.join(root, 'src/main.jsx'), 'utf8') + readFileSync(path.join(root, 'server/team-client.js'), 'utf8');
  assert.doesNotMatch(app, /autoUpdat|download\(.*release|\.dmg|\.msi/i, 'no update or download code');
});

test('PR-TEAM-03: secrets in the 0600 file when the keychain is not used; only names are listed; executor keys reach a call and leave', async () => {
  const dataDir = tempDir('secrets-');
  const s = await openSecrets({ dataDir, backend: 'file', log: quiet });
  assert.equal(s.kind, 'file'); assert.match(s.note, /keychain is not available/);
  s.set('server-key', 'k'.repeat(43)); s.set('anthropic-key', 'sk-test');
  assert.throws(() => s.set('record-signing-key', 'short'), /64 hex/);
  assert.throws(() => s.set('nope', 'x'), /Unknown secret/);
  if (process.platform !== 'win32') assert.equal(statSync(path.join(dataDir, 'secrets.json')).mode & 0o777, 0o600);
  assert.deepEqual(s.names(), ['anthropic-key']);
  const env = {}; const keys = secretsLoader(s, { env });
  assert.equal(keys.view().ANTHROPIC_API_KEY, 'sk-test'); assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const seen = await keys.with(async () => env.ANTHROPIC_API_KEY);
  assert.deepEqual([seen, env.ANTHROPIC_API_KEY], ['sk-test', undefined]);
  // The record signing key is never placed in the environment a model call (and so a spawned CLI) sees (readiness audit, 17 Oct 2026).
  s.set('record-signing-key', 'b'.repeat(64));
  assert.deepEqual(s.names(), ['anthropic-key', 'record-signing-key']);
  assert.equal(keys.view().REVIEW_RECORD_SIGNING_KEY, undefined);
  assert.equal(await keys.with(async () => env.REVIEW_RECORD_SIGNING_KEY), undefined);
  const fixed = { ANTHROPIC_API_KEY: 'from-env' }; await secretsLoader(s, { env: fixed, fixed: new Set(['ANTHROPIC_API_KEY']) }).with(async () => assert.equal(fixed.ANTHROPIC_API_KEY, 'from-env'));
  s.delete('server-key'); assert.equal(s.get('server-key'), null);
  assert.equal(SERVICE, 'GinChugger');
});

test('decision 194: a key saved under the old keychain service is read, copied to the new one, and removed with it', async () => {
  const vault = new Map(); // a fake keychain: "service|account" -> password
  class Entry {
    constructor(service, account) { this.k = `${service}|${account}`; }
    getPassword() { return vault.get(this.k) ?? null; }
    setPassword(v) { vault.set(this.k, v); }
    deletePassword() { if (!vault.delete(this.k)) throw new Error('not there'); }
  }
  assert.equal(OLD_SERVICE, 'GinChugger Legal');
  vault.set(`${OLD_SERVICE}|anthropic-key`, 'sk-old'); vault.set(`${OLD_SERVICE}|openai-key`, 'sk-stale');
  vault.set(`${SERVICE}|openai-key`, 'sk-new');
  const s = await openSecrets({ dataDir: tempDir('keychain-'), backend: 'os', log: quiet, Entry });
  assert.equal(s.kind, 'keychain');
  assert.equal(s.get('anthropic-key'), 'sk-old', 'the old service is read when the new one has nothing');
  assert.equal(vault.get(`${SERVICE}|anthropic-key`), 'sk-old', 'and the key is copied to the new service');
  assert.equal(s.get('openai-key'), 'sk-new', 'the new service wins');
  assert.equal(s.get('server-key'), null);
  assert.deepEqual(s.names(), ['anthropic-key', 'openai-key']);
  s.set('openai-key', 'sk-newer'); assert.equal(vault.has(`${OLD_SERVICE}|openai-key`), false, 'saving a key clears the old copy');
  s.delete('anthropic-key'); assert.equal(s.get('anthropic-key'), null, 'a removed key does not come back from the old service');
  assert.deepEqual([...vault.keys()], [`${SERVICE}|openai-key`]);
});

// ---- A real local app (server/index.js) joining a team server.

function startApp(state, extra = {}) {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, GCL_KEYCHAIN: 'file', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: '', REVIEW_TOOLS_SUPPORTED: 'false', REVIEW_TRACE_DIR: '', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`app did not start: ${out}`)), 20000);
    child.stderr.on('data', d => { out += d; });
    child.stdout.on('data', d => { out += d; const m = /ready at https?:\/\/localhost:(\d+)/.exec(out); if (m) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${m[1]}`, out: () => out }); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`app exited ${code}: ${out}`)); });
  });
}
const stop = c => new Promise(r => { c.removeAllListeners('exit'); c.once('exit', r); c.kill(); });
const call = async (base, p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('a local app joins with a code, works on the shared record, is signed out by an admin, and reviews with the server down', { timeout: 90_000 }, async () => {
  const team = await startTeam();
  const state = tempDir('app-state-');
  const app = await startApp(state);
  try {
    const { base } = app;
    assert.deepEqual([(await call(base, '/api/status')).body.mode, (await call(base, '/api/v2/local/team')).body.mode], ['solo', 'solo']);
    // Solo mode: the Admin page's status works; codes and people belong to a team server (PR-PAGE-03).
    const solo = await call(base, '/api/v2/admin/status');
    assert.deepEqual([solo.status, solo.body.mode, typeof solo.body.uptimeSeconds], [200, 'solo', 'number']);
    assert.deepEqual([(await call(base, '/api/v2/admin/setup-codes', 'POST', { forName: 'X' })).status, (await call(base, '/api/v2/admin/users')).status], [403, 403]);
    const http = await call(base, '/api/v2/local/sign-in', 'POST', { serverUrl: `http://localhost:${team.port}`, code: 'x', deviceName: 'mac' });
    assert.deepEqual([http.status, http.body.error.code], [400, 'https_required']);
    const ada = await team.issue('Ada Admin', true);
    const untrusted = await call(base, '/api/v2/local/sign-in', 'POST', { serverUrl: team.url, code: ada.code, deviceName: 'mac' });
    assert.deepEqual([untrusted.status, untrusted.body.error.code], [400, 'certificate_untrusted']);
    assert.match(untrusted.body.error.message, /It names CN=localhost, SHA-256 fingerprint [0-9A-F:]{95}\. Check both with IT/);
    const joined = await call(base, '/api/v2/local/sign-in', 'POST', { serverUrl: team.url, code: ada.code, deviceName: 'mac', caFile: CA_FILE });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual([joined.body.signedIn, joined.body.user.name, joined.body.user.admin, joined.body.banner, joined.body.keychain.kind], [true, 'Ada Admin', true, null, 'file']);
    const settings = readSettings(state);
    assert.deepEqual([settings.mode, settings.server.url, settings.server.caFile], ['team', team.url, CA_FILE]);
    const stored = JSON.parse(readFileSync(path.join(state, 'secrets.json'), 'utf8'))['server-key'];
    assert.ok(stored && !readFileSync(path.join(state, 'settings.json'), 'utf8').includes(stored), 'the key is in the keychain store, not the settings file');
    // The pages' routes now reach the team server; writes carry Ada's user id there.
    const pb = (await call(base, '/api/v2/playbooks', 'POST', { title: 'Northgate terms', draft: { rules: [] } })).body;
    assert.equal(team.srv.record.internal.db.prepare("SELECT actor FROM events WHERE type = 'playbook_changed' AND json_extract(payload, '$.playbookId') = ?").get(pb.id).actor, joined.body.user.userId);
    assert.ok((await call(base, '/api/v2/playbooks')).body.some(p => p.id === pb.id));
    assert.ok((await call(base, '/api/playbooks')).body.some(p => p.id === 'order-form'));
    assert.equal((await call(base, '/api/status')).body.mode, 'team');
    assert.equal((await call(base, '/api/v2/admin/status')).body.users.active, 1);
    for (const p of ['/api/status', '/api/v2/local/team', '/api/v2/local/settings', '/api/v2/local/secrets']) assert.ok(!JSON.stringify((await call(base, p)).body).includes(stored), `no key in ${p}`);
    // Revoked: the next check says so, and the record answers 401 key_revoked.
    const users = await team.srv.record.admin.listUsers();
    await team.srv.record.admin.revokeUser(users[0].id, 'system:gcl');
    const after = (await call(base, '/api/v2/local/team')).body;
    assert.deepEqual([after.signedOut, after.signedIn], [true, false]);
    assert.deepEqual([(await call(base, '/api/v2/playbooks')).status, (await call(base, '/api/v2/playbooks')).body.error.code], [401, 'key_revoked']);
    // A new code, then the server goes away: a review still runs on the playbooks last read (PR-TEAM-06).
    const again = await team.issue('Ada Admin', true);
    assert.equal((await call(base, '/api/v2/local/sign-in', 'POST', { serverUrl: team.url, code: again.code, deviceName: 'mac', caFile: CA_FILE })).body.signedIn, true);
    await team.close();
    const down = await call(base, '/api/v2/playbooks/nda/proposals'); // a read not in the 60-second cache
    assert.deepEqual([down.status, down.body.error.code, down.body.error.message], [503, 'record_unavailable', 'Record unavailable: the team server cannot be reached. Retry.']);
    const name = 'helix-brightwater-nda-v3-helix-counter.docx';
    const document = { ...(await importDocx(readFileSync(path.join(root, 'data/fixtures/history', name)), name)), id: 'demo-v3', revision: 1 };
    const review = await call(base, '/api/review', 'POST', { document, playbookId: 'nda', agentic: true });
    assert.equal(review.status, 200, JSON.stringify(review.body).slice(0, 300));
    assert.equal(review.body.playbook.id, 'nda'); assert.ok(review.body.findings.length > 0);
    assert.equal((await call(base, '/api/v2/local/team')).body.reachable, false);
    // Sign out: back to the solo record, the key gone.
    const out = (await call(base, '/api/v2/local/sign-out', 'POST')).body;
    assert.deepEqual([out.mode, out.signedIn], ['solo', false]);
    assert.equal(JSON.parse(readFileSync(path.join(state, 'secrets.json'), 'utf8'))['server-key'], undefined);
    assert.ok(Array.isArray((await call(base, '/api/v2/playbooks')).body));
  } finally { await stop(app.child); await team.close().catch(() => {}); }
});
