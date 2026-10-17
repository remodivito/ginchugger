// SPDX-License-Identifier: GPL-3.0-or-later
// The team server (product v2 spec 3.1, 6.2.1, 7.10, 9; slice S7): it refuses AI credentials (PR-SEC-07) and a
// missing certificate (PR-SEC-04), imports nothing that runs a model (PR-TEAM-01), signs members in with single-use
// expiring codes and revocable keys (PR-TEAM-02 to 05), keeps admin routes for admins (PR-PAGE-03, PR-SEC-05), rate
// limits redemption, writes every event with an actor (PR-TEAM-04), and serves its status page and settings file as
// section 9 says (PR-ADM-01, 02).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import Database from 'better-sqlite3';
import { createTeamServer, AI_CREDENTIAL_ENV, refusalMessage, findAiCredentials } from '../server/team-server.js';
import { readServerSettings, SERVER_DEFAULTS } from '../server/settings.js';
import { httpsRequest, redeemCode, openRemoteRecord } from '../server/record/remote.js';
import { newCode, normalizeCode, CODE_LENGTH } from '../server/record/team.js';
import { SCHEMA_VERSION } from '../server/record/schema.js';
import { startTeam, serverDataDir, cleanEnv, quiet, TLS } from './fixtures/team.js';
import { tempDir } from './fixtures/record/helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
/** The expiry of the test certificate, made at test time (tests/fixtures/test-tls.js). */
const certExpires = new Date(new X509Certificate(readFileSync(path.join(TLS, 'server.crt'))).validTo).toISOString().slice(0, 10);
const json = async (url, path, { method = 'GET', key, body, ca } = {}) => {
  const r = await httpsRequest(url + path, { method, ca, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? Buffer.from(JSON.stringify(body)) : null });
  return { status: r.status, body: r.headers['content-type']?.includes('json') ? JSON.parse(r.body.toString()) : r.body.toString() };
};
const refused = (p, code, re) => assert.rejects(p, e => e.code === code && (!re || re.test(e.message)) || assert.fail(`${e.code}: ${e.message}`));

test('PR-SEC-07: the credential list is executors.js STRIP; any credential, model setting or model CLI stops the server with the reason', async () => {
  const strip = /const STRIP = (\[[^\]]+\])/.exec(readFileSync(path.join(root, 'server/executors.js'), 'utf8'))[1];
  assert.deepEqual(AI_CREDENTIAL_ENV, JSON.parse(strip.replace(/'/g, '"')));
  for (const name of AI_CREDENTIAL_ENV) await refused(createTeamServer({ dataDir: serverDataDir(), env: cleanEnv({ [name]: 'x' }), log: quiet }), 'ai_credential_present', new RegExp(`^This is the team server\\. It makes no model calls; remove ${name} from its environment, settings or image\\.$`));
  await refused(createTeamServer({ dataDir: serverDataDir(undefined, { review: { executor: 'claude' } }), env: cleanEnv(), log: quiet }), 'ai_credential_present', /remove review\.executor \(settings file\)/);
  await refused(createTeamServer({ dataDir: serverDataDir(undefined, { anthropic: {} }), env: cleanEnv(), log: quiet }), 'ai_credential_present', /remove anthropic \(settings file\)/);
  await refused(createTeamServer({ dataDir: serverDataDir(), env: cleanEnv({ CLAUDE_BIN: '/opt/claude' }), log: quiet }), 'ai_credential_present', /CLAUDE_BIN/);
  const bin = tempDir('bin-'); writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
  await refused(createTeamServer({ dataDir: serverDataDir(), env: { PATH: bin }, log: quiet }), 'ai_credential_present', new RegExp(`the codex program \\(${path.join(bin, 'codex').replace(/[/\\.]/g, '\\$&')}\\)`));
  assert.deepEqual(findAiCredentials({ env: { PATH: tempDir('p-'), OPENAI_API_KEY: '' } }), []); // an empty variable holds nothing
  assert.equal(refusalMessage(['A', 'B']), 'This is the team server. It makes no model calls; remove A, B from its environment, settings or image.');
});

test('PR-TEAM-01: nothing the team server imports reaches executors.js, review.js or the tools listener', () => {
  const seen = new Set(); const stack = [path.join(root, 'server/team-server.js')];
  while (stack.length) {
    const file = stack.pop(); if (seen.has(file)) continue; seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) { const next = path.resolve(path.dirname(file), m[1]); if (existsSync(next)) stack.push(next); }
  }
  const names = [...seen].map(f => path.relative(root, f).split(path.sep).join('/')); // posix separators on Windows too
  for (const banned of ['server/executors.js', 'server/review.js', 'server/tools-listener.js', 'server/tool-smoke.js', 'server/secrets.js']) assert.ok(!names.includes(banned), `${banned} is imported`);
  assert.ok(names.includes('server/record/local.js') && names.includes('server/record/http.js'));
});

test('PR-SEC-04, PR-ADM-01: an empty data folder gets a settings file naming every key, and without a certificate the server does not start', async () => {
  const dataDir = tempDir('fresh-');
  await refused(createTeamServer({ dataDir, env: cleanEnv(), log: quiet }), 'tls_missing', /serves HTTPS only/);
  const written = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), Object.keys(SERVER_DEFAULTS).sort());
  assert.deepEqual([written.mode, written.codes.ttlHours, written.mail.enabled, written.log.requests, written.server.tls.certFile], ['server', 168, false, false, path.join(dataDir, 'tls', 'server.crt')]);
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ...written, mail: { ...written.mail, folderz: {} } }));
  assert.throws(() => readServerSettings(dataDir), e => e.code === 'settings_unknown_key' && /mail\.folderz/.test(e.message));
});

test('section 9.6: a data folder newer than the code stops the server with the message', async () => {
  const dataDir = serverDataDir();
  const db = new Database(path.join(dataDir, 'record.sqlite')); db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)'); db.prepare('INSERT INTO schema_version VALUES (?, ?)').run(SCHEMA_VERSION + 1, 'x'); db.close();
  await refused(createTeamServer({ dataDir, env: cleanEnv(), log: quiet }), 'schema_newer_than_code', new RegExp(`The data folder is at schema ${SCHEMA_VERSION + 1}; this release knows schema ${SCHEMA_VERSION}\\. Install the newer release or restore a backup\\.`));
});

test('codes: 26 Crockford characters over 128 bits; typed codes are normalised', () => {
  const c = newCode(Buffer.alloc(16, 0xff));
  assert.equal(c.length, CODE_LENGTH); assert.equal(c, '7' + 'Z'.repeat(25));
  assert.equal(normalizeCode('7zzz-zzzz zzzz'), '7ZZZZZZZZZZZ'); assert.equal(normalizeCode('o1Il'), '0111');
});

test('PR-TEAM-02, 03, 05: a code works once and is never retrievable; expired and revoked codes fail with one message; a revoked key gets 401 key_revoked', async () => {
  let t = Date.parse('2026-10-15T09:00:00Z');
  const team = await startTeam({ now: () => new Date(t += 10).toISOString() });
  try {
    const { url, ca } = team;
    assert.deepEqual(Object.keys((await json(url, '/api/v2/server-info', { ca })).body).sort(), ['configured', 'minClientVersion', 'mode', 'name', 'oidc', 'schemaVersion', 'version']);
    const first = await team.issue('Ada Admin', true);
    const ada = await redeemCode(url, { code: first.code.toLowerCase().replace(/(.{5})/g, '$1-'), deviceName: 'Ada’s Mac' }, { ca });
    assert.deepEqual([ada.name, ada.admin, ada.key.length], ['Ada Admin', true, 43]);
    await assert.rejects(redeemCode(url, { code: first.code, deviceName: 'x' }, { ca }), e => e.status === 400 && e.message === 'This code is not valid.');
    const late = await team.issue('Late Lou', false, 1); t += 2 * 3_600_000;
    await assert.rejects(redeemCode(url, { code: late.code }, { ca }), e => e.status === 400 && e.message === 'This code is not valid.');
    const pulled = await team.issue('Pulled Pat');
    const adaRec = openRemoteRecord({ url, key: ada.key, ca });
    await adaRec.admin.revokeCode(pulled.id);
    await assert.rejects(redeemCode(url, { code: pulled.code }, { ca }), e => e.message === 'This code is not valid.');
    await assert.rejects(redeemCode(url, { code: 'Z'.repeat(26) }, { ca }), e => e.message === 'This code is not valid.');
    // Stored as hashes only: neither code nor key appears in the database file or any listing.
    const bytes = readFileSync(path.join(team.dataDir, 'record.sqlite')).toString('latin1') + (existsSync(path.join(team.dataDir, 'record.sqlite-wal')) ? readFileSync(path.join(team.dataDir, 'record.sqlite-wal')).toString('latin1') : '');
    for (const secret of [first.code, ada.key]) assert.ok(!bytes.includes(secret));
    assert.ok((await adaRec.admin.listCodes()).every(c => !('code' in c)));
    // A second device of the same person: the code names the user, redeeming adds a key.
    const second = await adaRec.admin.issueCode(null, false, 24, null, { userId: ada.userId });
    const ada2 = await redeemCode(url, { code: second.code, deviceName: 'Ada’s PC' }, { ca });
    assert.equal(ada2.userId, ada.userId);
    const ben = await team.member('Ben Member');
    assert.equal((await ben.remote.me()).name, 'Ben Member');
    await adaRec.admin.revokeUser(ben.userId);
    await assert.rejects(ben.remote.playbooks.list(), e => e.status === 401 && e.code === 'key_revoked' && e.message === 'Signed out by an admin.');
    assert.equal((await json(url, '/api/v2/me', { ca })).body.error.code, 'unauthorized');
    assert.equal((await json(url, '/api/v2/me', { ca, key: 'not-a-key-of-this-server-at-all' })).body.error.code, 'unauthorized');
    const users = await adaRec.admin.listUsers();
    assert.deepEqual(users.map(u => [u.name, u.admin, !!u.revokedAt, u.keys.length]), [['Ada Admin', true, false, 2], ['Ben Member', false, true, 1]]);
    adaRec.close(); ben.remote.close();
  } finally { await team.close(); }
});

test('PR-PAGE-03, PR-SEC-05: admin routes are for admins; every member reads and writes the record; every event names its actor', async () => {
  const team = await startTeam();
  try {
    const ada = await team.member('Ada Admin', true); const ben = await team.member('Ben Member');
    for (const [method, p] of [['GET', '/admin/status'], ['GET', '/admin/setup-codes'], ['POST', '/admin/setup-codes'], ['GET', '/admin/users'], ['POST', `/admin/users/${ada.userId}/revoke`], ['DELETE', '/admin/setup-codes/x'], ['POST', '/admin/mail/check'], ['PUT', '/admin/retention']]) {
      const r = await json(team.url, '/api/v2' + p, { method, key: ben.key, ca: team.ca, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      assert.deepEqual([r.status, r.body.error.code], [403, 'forbidden'], `${method} ${p}`);
    }
    const ben1 = await ben.remote.playbooks.create({ title: 'Northgate terms', draft: { rules: [] } });
    const ada1 = await ada.remote.playbooks.create({ title: 'Helix terms', draft: { rules: [] } });
    await refused(ada.remote.admin.checkMailNow(), 'mail_disabled', /mail\.enabled/);
    const status = await ada.remote.admin.status();
    assert.deepEqual([status.users.active, status.mode, status.notConfigured, typeof status.uptimeSeconds, status.certificate.expiresAt.slice(0, 10), status.mail.enabled, status.store.mode], [2, 'team', [], 'number', certExpires, false, 'off']);
    const names = await ben.remote.actors();
    assert.deepEqual([names[ada.userId], names[ben.userId]], ['Ada Admin', 'Ben Member']);
    const db = team.srv.record.internal.db;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE actor IS NULL').get().n, 0);
    const byType = Object.fromEntries(db.prepare("SELECT type, actor FROM events WHERE type IN ('code_issued', 'user_joined')").all().map(r => [r.type, r.actor]));
    assert.deepEqual(byType, { code_issued: 'system:gcl', user_joined: ben.userId });
    const made = id => db.prepare("SELECT actor FROM events WHERE type = 'playbook_changed' AND json_extract(payload, '$.playbookId') = ?").get(id).actor;
    assert.deepEqual([made(ben1.id), made(ada1.id)], [ben.userId, ada.userId]);
    assert.equal((await ben.remote.playbooks.get(ada1.id)).updatedBy, ada.userId);
    ada.remote.close(); ben.remote.close();
  } finally { await team.close(); }
});

test('redeem is rate limited: 10 a minute from one address, then 429 for a minute', async () => {
  let t = Date.parse('2026-10-15T09:00:00Z');
  const team = await startTeam({ clock: () => t });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await json(team.url, '/api/v2/setup-codes/redeem', { method: 'POST', ca: team.ca, body: { code: `${i}`.repeat(26) } })).status, 400);
    const r = await json(team.url, '/api/v2/setup-codes/redeem', { method: 'POST', ca: team.ca, body: { code: 'A'.repeat(26) } });
    assert.deepEqual([r.status, r.body.error.code], [429, 'rate_limited']);
    t += 61_000;
    assert.equal((await json(team.url, '/api/v2/setup-codes/redeem', { method: 'POST', ca: team.ca, body: { code: 'B'.repeat(26) } })).status, 400);
  } finally { await team.close(); }
});

test('PR-ADM-01, 02: the status page says "Not configured" until there is an admin and a public address, then "Ready"; it shows no key or count', async () => {
  const dataDir = serverDataDir(); const s = JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')); delete s.server.publicUrl; writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(s));
  const team = await startTeam({ dataDir });
  try {
    const page = (await json(team.url, '/', { ca: team.ca })).body;
    assert.match(page, /Not configured/); assert.match(page, /server\.publicUrl is not set/); assert.match(page, /gcl admin issue-code --for &quot;&lt;name&gt;&quot; --admin/);
    assert.match(page, new RegExp(`Certificate expires</dt><dd>${certExpires}</dd>`));
    assert.equal((await json(team.url, '/api/v2/server-info', { ca: team.ca })).body.configured, false);
  } finally { await team.close(); }
  const ready = await startTeam();
  try {
    await ready.member('Ada Admin', true);
    const page = (await json(ready.url, '/', { ca: ready.ca })).body;
    assert.match(page, /<dd>Ready<\/dd>/); assert.doesNotMatch(page, /Ada|users|disk/i);
  } finally { await ready.close(); }
});

test('the status page and API refuse plaintext: an http:// request to the HTTPS port gets no record', async () => {
  const team = await startTeam();
  try {
    const r = await fetch(`http://127.0.0.1:${team.port}/api/v2/server-info`).then(x => x.status, () => 'refused');
    assert.ok(r === 'refused' || r === 400, String(r));
    assert.ok(existsSync(path.join(TLS, 'server.crt')));
  } finally { await team.close(); }
});

test('gcl admin issues, lists and revokes codes and people on the data folder; backup, wipe, restore and check bring the team record back (PR-ADM-03)', { timeout: 60_000 }, async () => {
  const { main } = await import('../bin/gcl.js');
  const { rmSync } = await import('node:fs');
  const dataDir = serverDataDir();
  const lines = []; const log = s => lines.push(s);
  const gcl = async (...args) => { lines.length = 0; const code = await main(['--data', dataDir, ...args], { log, env: {} }); return { code, out: lines.join('\n') }; };
  const first = await gcl('admin', 'issue-code', '--for', 'Ada Admin', '--admin', '--hours', '48');
  assert.equal(first.code, 0); const code = /: ([0-9A-Z]{26})$/m.exec(first.out)[1];
  assert.match(first.out, /Give this to Ada Admin in person or by a channel you trust\. It expires on .* and works once\./);
  let team = await startTeam({ dataDir });
  let snapshot;
  try {
    const ada = await redeemCode(team.url, { code, deviceName: 'mac' }, { ca: team.ca });
    const rec = openRemoteRecord({ url: team.url, key: ada.key, ca: team.ca });
    const pb = await rec.playbooks.create({ title: 'Northgate terms', draft: { rules: [] } });
    snapshot = { playbook: await rec.playbooks.get(pb.id) };
    assert.equal((await gcl('admin', 'issue-code', '--for', 'Ben Member')).code, 0);
    const codes = (await gcl('admin', 'list-codes')).out;
    assert.match(codes, /Ben Member  issued .*  expires /); assert.match(codes, /Ada Admin \(admin\)  issued .*  used /);
    const benId = /^(\S+)  Ben Member/m.exec(codes)[1];
    assert.match((await gcl('admin', 'revoke-code', benId)).out, /revoked/);
    assert.match((await gcl('admin', 'list-codes')).out, /Ben Member  issued .*  revoked/);
    const users = (await gcl('admin', 'list-users')).out;
    assert.match(users, /Ada Admin \(admin\)  active  devices: mac/);
    assert.equal((await gcl('backup', path.join(team.dataDir, '..', path.basename(dataDir) + '-backup'))).code, 0);
    assert.equal((await gcl('admin', 'revoke-user', ada.userId)).code, 0);
    await assert.rejects(rec.me(), e => e.code === 'key_revoked');
    rec.close();
  } finally { await team.close(); }
  // Restore: the database goes; the backup brings it back; gcl check passes.
  const backupDir = path.join(dataDir, '..', path.basename(dataDir) + '-backup');
  for (const f of ['record.sqlite', 'record.sqlite-wal', 'record.sqlite-shm', 'files']) rmSync(path.join(dataDir, f), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const restored = await gcl('restore', backupDir);
  assert.equal(restored.code, 0, restored.out); assert.match(restored.out, /Check passed\./);
  team = await startTeam({ dataDir });
  try {
    const again = await team.member('Ada Admin', true); // the backup predates the revocation, so a fresh code is the clean way back in
    assert.deepEqual(await again.remote.playbooks.get(snapshot.playbook.id), snapshot.playbook);
    again.remote.close();
  } finally { await team.close(); }
});

test('task 11: the team server configures the store as the local app does: the settings file\'s store keys, GCL_STORE over them, managed only from main()', async () => {
  const { teamStore } = await import('../server/team-server.js');
  assert.deepEqual(SERVER_DEFAULTS.store, { mode: null, url: null, port: null, dataDir: null, project: null });
  const dataDir = serverDataDir(undefined, { store: { mode: 'fake' } });
  const { settings } = readServerSettings(dataDir);
  assert.equal(settings.store.mode, 'fake', 'the store keys are accepted, not refused as unknown');
  const srv = await createTeamServer({ dataDir, env: cleanEnv(), log: quiet });
  try {
    for (let i = 0; i < 50 && srv.store.status().state !== 'ready'; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual([srv.store.status().mode, srv.store.status().state], ['fake', 'ready'], 'started with the server, without waiting for mail');
  } finally { await srv.close(); }
  // The environment wins over the file; an unset mode is off for createTeamServer (the tests) and managed for main().
  assert.equal(teamStore({ settings, env: { GCL_STORE: 'off' }, dataDir }).config.mode, 'off');
  assert.equal(teamStore({ settings: readServerSettings(serverDataDir()).settings, env: {}, dataDir }).config.mode, 'off');
  const managed = teamStore({ settings: readServerSettings(serverDataDir(undefined, { store: { port: 8099, project: 'gcl-team' } })).settings, env: {}, dataDir, defaultMode: 'managed' });
  assert.deepEqual([managed.config.mode, managed.config.port, managed.config.project, managed.config.url, managed.config.dataDir], ['managed', 8099, 'gcl-team', 'http://127.0.0.1:8099', path.join(dataDir, 'paperless-data')]);
  const main = readFileSync(path.join(root, 'server/team-server.js'), 'utf8');
  assert.match(main, /createTeamServer\(\{ dataDir, defaultStoreMode: 'managed' \}\)/);
});
