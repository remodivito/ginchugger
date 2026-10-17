// SPDX-License-Identifier: GPL-3.0-or-later
// Paperless as a managed service (server/store/service.js, server/store/http.js; plan task 1): configuration, start-up
// through Docker, secrets written 0600, the service token, the status the UI reads, and one Paperless user and token
// per lawyer. Docker and HTTP are scripted; nothing here starts a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { storeConfig, createStoreService, usernameFor, ensureSecrets, composeEnv, COMPOSE_FILE, NO_PURGE_DELAY_DAYS, DEFAULT_PORT, ENV_FILE, TOKENS_FILE, SERVICE_USER } from '../server/store/service.js';
import { teamStore } from '../server/team-server.js';
import { readStoreSettings } from '../server/settings.js';
import { writeStoreInit, FILES as INIT_FILES } from '../server/store/compose-init.js';
import { storeRoutes } from '../server/store/http.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'gcl-store-'));
const mode600 = file => (statSync(file).mode & 0o777).toString(8);
const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A scripted Paperless at the HTTP level the service uses directly (/api/, /api/token/, /api/status/). */
function scripted({ answering = true, tokenStatus = 200 } = {}) {
  const calls = []; const st = { answering, tokenStatus, issued: 0, validTokens: new Set() };
  const fetch = async (url, init = {}) => {
    const p = new URL(url).pathname; calls.push({ path: p, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
    if (!st.answering) throw new Error('ECONNREFUSED');
    if (p === '/api/') return res({ detail: 'Authentication credentials were not provided.' }, 401);
    if (p === '/api/token/') { if (st.tokenStatus !== 200) return res({}, st.tokenStatus); const token = `tok-${++st.issued}`; st.validTokens.add(token); return res({ token }); }
    if (p === '/api/status/') return st.validTokens.has(String(init.headers?.Authorization).replace('Token ', '')) ? res({}) : res({}, 401);
    return res({}, 404);
  };
  return { fetch, calls, st };
}
/** createStore stand-in: records the token each client uses and answers the calls the service makes. */
function stubStores({ healthy = () => true, users = [] } = {}) {
  const made = [];
  const createStore = ({ url, token }) => {
    const s = {
      url, token, base: 0,
      async health() { if (!healthy()) { const e = new Error('The document store cannot be reached.'); e.code = 'store_unavailable'; throw e; } return { ok: true, version: '3.3.2', apiVersion: 10, detail: null }; },
      async ensureBaseTaxonomy() { s.base++; },
      async call(method, p, { json }) {
        if (p === '/api/users/' && method === 'POST') {
          if (users.includes(json.username)) throw new Error('The document store refused POST /api/users/ (400: username: A user with that username already exists.).');
          users.push(json.username); s.lastUser = json; return { id: users.length + 10, username: json.username };
        }
        throw new Error(`unexpected ${method} ${p}`);
      },
    };
    made.push(s); return s;
  };
  return { createStore, made, users };
}
const dockerStub = ({ available = true, up = true } = {}) => {
  const calls = [];
  return { calls, available: async () => (calls.push('available'), available ? { ok: true, version: '28' } : { ok: false, reason: 'Docker is not running.' }), up: async cfg => (calls.push(['up', cfg.port, cfg.dataDir, cfg.project]), up ? { ok: true } : { ok: false, reason: 'pull access denied' }), stop: async () => (calls.push('stop'), { ok: true }) };
};
const quiet = { log() {}, error() {} };

test('storeConfig: defaults, settings, environment overrides, refusals', () => {
  const d = tmp();
  assert.deepEqual(storeConfig({ dataDir: d, env: {} }), { mode: 'off', port: DEFAULT_PORT, url: null, dataDir: path.join(d, 'paperless-data'), project: 'gcl-store', token: null, purgeAfterDays: null });
  assert.equal(storeConfig({ dataDir: d, env: {}, defaultMode: 'managed' }).url, 'http://127.0.0.1:8011');
  const s = storeConfig({ dataDir: d, env: { GCL_STORE_PORT: '8099' }, settings: { mode: 'managed', port: 8050, dataDir: '/srv/pl' } });
  assert.deepEqual([s.mode, s.port, s.url, s.dataDir], ['managed', 8099, 'http://127.0.0.1:8099', '/srv/pl']);
  const ext = storeConfig({ dataDir: d, env: { GCL_STORE: 'external', GCL_STORE_TOKEN: 'abc' }, settings: { url: 'http://127.0.0.1:8010/' } });
  assert.deepEqual([ext.mode, ext.url, ext.token], ['external', 'http://127.0.0.1:8010', 'abc']);
  assert.throws(() => storeConfig({ dataDir: d, env: { GCL_STORE: 'cloud' } }), e => e.code === 'settings_invalid');
  assert.throws(() => storeConfig({ dataDir: d, env: {}, settings: { mode: 'managed', port: 70000 } }), e => e.code === 'settings_invalid');
});

test('the trash: Paperless never empties it unless trash.purgeAfterDays is set, on the team server or in solo (decision 188)', () => {
  const d = tmp();
  const off = composeEnv(storeConfig({ dataDir: d, env: {}, defaultMode: 'managed' }), {});
  assert.deepEqual([off.GCL_PAPERLESS_EMPTY_TRASH_CRON, off.GCL_PAPERLESS_EMPTY_TRASH_DELAY, off.GCL_PAPERLESS_PORT], ['disable', String(NO_PURGE_DELAY_DAYS), '8011']);
  const on = composeEnv(storeConfig({ dataDir: d, env: {}, defaultMode: 'managed', settings: { purgeAfterDays: 90 } }), {});
  assert.deepEqual([on.GCL_PAPERLESS_EMPTY_TRASH_CRON, on.GCL_PAPERLESS_EMPTY_TRASH_DELAY], ['0 1 * * *', '90']);
  for (const bad of [0, -5, '30', 1.5]) assert.equal(storeConfig({ dataDir: d, env: {}, settings: { purgeAfterDays: bad } }).purgeAfterDays, null);
  const team = svc => teamStore({ settings: { store: {}, trash: svc }, env: {}, dataDir: d, defaultMode: 'managed', log: quiet }).config.purgeAfterDays;
  assert.deepEqual([team({ purgeAfterDays: null }), team({ purgeAfterDays: 60 })], [null, 60]);
  // Solo: the app's own settings.json, read the same way (index.js passes readStoreSettings to storeConfig).
  const solo = settings => { const dir = tmp(); if (settings) writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings)); return composeEnv(storeConfig({ settings: readStoreSettings(dir), dataDir: dir, env: {}, defaultMode: 'managed' }), {}); };
  const cron = e => [e.GCL_PAPERLESS_EMPTY_TRASH_CRON, e.GCL_PAPERLESS_EMPTY_TRASH_DELAY];
  assert.deepEqual(cron(solo(null)), ['disable', String(NO_PURGE_DELAY_DAYS)], 'no settings file: never emptied');
  assert.deepEqual(cron(solo({ trash: { purgeAfterDays: null } })), ['disable', String(NO_PURGE_DELAY_DAYS)]);
  assert.deepEqual(cron(solo({ trash: { purgeAfterDays: 45 } })), ['0 1 * * *', '45'], 'set without any store keys');
  assert.deepEqual(cron(solo({ store: { port: 8050 }, trash: { purgeAfterDays: 14 } })), ['0 1 * * *', '14']);
  assert.deepEqual(cron(solo({ trash: { purgeAfterDays: '30' } })), ['disable', String(NO_PURGE_DELAY_DAYS)], 'not a whole number of days: off');
  // The compose file reads them, with "off" as its own default too.
  const compose = readFileSync(COMPOSE_FILE, 'utf8');
  assert.match(compose, /PAPERLESS_EMPTY_TRASH_TASK_CRON: \$\{GCL_PAPERLESS_EMPTY_TRASH_CRON:-disable\}/);
  assert.match(compose, /PAPERLESS_EMPTY_TRASH_DELAY: \$\{GCL_PAPERLESS_EMPTY_TRASH_DELAY:-36500\}/);
});

test('the team-server container\'s store (compose.yml): store-init writes the secrets once, 0600, and the trash schedule from the settings file', () => {
  const dir = path.join(tmp(), 'store'); const settingsFile = path.join(tmp(), 'settings.json');
  const read = name => readFileSync(path.join(dir, name), 'utf8');
  assert.deepEqual(writeStoreInit({ dir, settingsFile }), { purgeAfterDays: null, cron: 'disable', delay: String(NO_PURGE_DELAY_DAYS) }, 'no settings file yet (first start): off');
  const env = readFileSync(path.join(dir, ENV_FILE), 'utf8');
  assert.equal(read(INIT_FILES.secretKey), env.match(/PAPERLESS_SECRET_KEY=(\S+)/)[1]);
  assert.equal(read(INIT_FILES.adminPassword), env.match(/PAPERLESS_ADMIN_PASSWORD=(\S+)/)[1]);
  for (const f of [ENV_FILE, ...Object.values(INIT_FILES)]) assert.equal(mode600(path.join(dir, f)), '600', f);
  assert.equal((statSync(dir).mode & 0o777).toString(8), '700');
  assert.deepEqual([read(INIT_FILES.trashCron), read(INIT_FILES.trashDelay)], ['disable', '36500'], 'no trailing newline: Paperless reads the file as the value');
  const key = read(INIT_FILES.secretKey);
  writeFileSync(settingsFile, JSON.stringify({ trash: { purgeAfterDays: 30 } }));
  assert.deepEqual(writeStoreInit({ dir, settingsFile }), { purgeAfterDays: 30, cron: '0 1 * * *', delay: '30' });
  assert.deepEqual([read(INIT_FILES.trashCron), read(INIT_FILES.trashDelay), read(INIT_FILES.secretKey)], ['0 1 * * *', '30', key], 'the secrets are made once');
  writeFileSync(settingsFile, '{ not json');
  assert.equal(writeStoreInit({ dir, settingsFile }).cron, 'disable');
});

test('external with the admin password in the store\'s paperless.env (the container): signs in as the service account; without it, the token', async () => {
  const d = tmp(); const cfg = storeConfig({ dataDir: d, env: { GCL_STORE: 'external', GCL_STORE_URL: 'http://paperless-webserver:8000', GCL_STORE_DATA: path.join(d, 'store') } });
  writeStoreInit({ dir: cfg.dataDir, settingsFile: path.join(d, 'none.json') });
  const docker = dockerStub(); const http = scripted(); const stores = stubStores();
  const svc = createStoreService({ config: cfg, docker, fetch: http.fetch, createStore: stores.createStore, log: quiet, sleep: async () => {} });
  assert.deepEqual([(await svc.start()).state, docker.calls], ['ready', []], 'Docker is never used');
  const pw = readFileSync(path.join(cfg.dataDir, INIT_FILES.adminPassword), 'utf8');
  assert.deepEqual(http.calls.find(c => c.path === '/api/token/').body, { username: SERVICE_USER, password: pw });
  assert.equal(stores.made[0].token, 'tok-1');
  // No paperless.env: GCL_STORE_TOKEN, as before; nothing is written.
  const e = tmp(); const plain = storeConfig({ dataDir: e, env: { GCL_STORE: 'external', GCL_STORE_URL: 'http://x:8000', GCL_STORE_TOKEN: 'given' } });
  const s2 = stubStores();
  await createStoreService({ config: plain, docker, fetch: scripted().fetch, createStore: s2.createStore, log: quiet, sleep: async () => {} }).start();
  assert.equal(s2.made[0].token, 'given');
  assert.equal(existsSync(path.join(plain.dataDir, ENV_FILE)), false);
});

test('compose.yml: the team server with the store beside it on an internal network, Paperless not published, the same pinned images, trash off by default', () => {
  const team = readFileSync(new URL('../compose.yml', import.meta.url), 'utf8');
  const solo = readFileSync(COMPOSE_FILE, 'utf8');
  const images = text => [...text.matchAll(/^\s+image: (\S+)$/gm)].map(m => m[1]).filter(i => !i.includes('GCL_IMAGE')).sort();
  assert.deepEqual(images(team), images(solo));
  assert.deepEqual([...team.matchAll(/^\s+ports:/gm)].length, 1, 'only the team server publishes a port');
  assert.match(team, /store:\n\s+internal: true/);
  assert.match(team, /GCL_STORE: external\n\s+GCL_STORE_URL: http:\/\/paperless-webserver:8000/);
  for (const name of ['PAPERLESS_TRAIN_TASK_CRON: disable', 'PAPERLESS_EMPTY_TRASH_TASK_CRON_FILE: ', 'PAPERLESS_EMPTY_TRASH_DELAY_FILE: ', 'PAPERLESS_SECRET_KEY_FILE: ', 'PAPERLESS_ADMIN_PASSWORD_FILE: ', 'command: ["node", "server/store/compose-init.js"]']) assert.ok(team.includes(name), name);
  assert.doesNotMatch(team, /PAPERLESS_(SECRET_KEY|ADMIN_PASSWORD):/, 'no secret in the file');
});

test('off: no Docker, status off, no client', async () => {
  const docker = dockerStub();
  const svc = createStoreService({ config: storeConfig({ dataDir: tmp(), env: {} }), docker, log: quiet });
  assert.equal((await svc.start()).state, 'off');
  assert.deepEqual(docker.calls, []);
  assert.throws(() => svc.serviceClient(), e => e.status === 503 && e.code === 'store_unavailable');
});

test('managed without Docker: unavailable with the reason, and compose is never run', async () => {
  const docker = dockerStub({ available: false });
  const svc = createStoreService({ config: storeConfig({ dataDir: tmp(), env: {}, defaultMode: 'managed' }), docker, log: quiet });
  const s = await svc.start();
  assert.deepEqual([s.state, s.reason], ['unavailable', 'Docker is not running.']);
  assert.deepEqual(docker.calls, ['available']);
});

test('managed without Docker, on the no-Docker path: the built-in store stands in, says why, writes nothing to the Paperless folder', async () => {
  const d = tmp(); const docker = dockerStub({ available: false }); const logged = [];
  const svc = createStoreService({ config: storeConfig({ dataDir: d, env: {}, defaultMode: 'managed' }), docker, log: { log: m => logged.push(m), error() {} }, builtInWhenNoDocker: true });
  const s = await svc.start();
  assert.deepEqual([s.state, s.builtIn, s.url], ['ready', 'Docker is not running.', null]);
  assert.deepEqual(docker.calls, ['available'], 'compose is never run');
  assert.match(logged.join('\n'), /Document store: built-in, in memory \(Docker is not running\)\. Documents are kept until the app stops/);
  assert.deepEqual(await svc.ensureUser({ id: 'u1', name: 'P. Raman' }), { id: 'u1', username: 'p.raman', created: true });
  assert.ok(svc.getClient('u1'));
  assert.ok(!existsSync(path.join(d, 'paperless-data')), 'nothing written to the Paperless data folder (no secrets, no tokens)');
  assert.equal((await svc.check()).state, 'ready');
  assert.deepEqual(await svc.stop(), { ok: true }); assert.deepEqual(docker.calls, ['available'], 'stop does not call Docker');
  assert.equal((await svc.start()).builtIn, 'Docker is not running.', 'a second start keeps the built-in store');
});

test('managed with Docker present: the no-Docker path changes nothing', async () => {
  const d = tmp(); const docker = dockerStub(); const stores = stubStores();
  const svc = createStoreService({ config: storeConfig({ dataDir: d, env: {}, defaultMode: 'managed' }), docker, fetch: scripted().fetch, createStore: stores.createStore, log: quiet, sleep: async () => {}, builtInWhenNoDocker: true });
  const s = await svc.start();
  assert.equal(s.state, 'ready'); assert.equal(s.builtIn, undefined); assert.equal(s.url, `http://127.0.0.1:${DEFAULT_PORT}`);
  assert.deepEqual(docker.calls, ['available', ['up', DEFAULT_PORT, path.join(d, 'paperless-data'), 'gcl-store']]);
});

test('managed: compose up, secrets 0600, service token saved 0600, base tags, ready', async () => {
  const d = tmp(); const cfg = storeConfig({ dataDir: d, env: {}, defaultMode: 'managed' });
  const docker = dockerStub(); const http = scripted(); const stores = stubStores();
  const svc = createStoreService({ config: cfg, docker, fetch: http.fetch, createStore: stores.createStore, log: quiet, sleep: async () => {} });
  const s = await svc.start();
  assert.deepEqual([s.state, s.version, s.url], ['ready', '3.3.2', 'http://127.0.0.1:8011']);
  assert.deepEqual(docker.calls, ['available', ['up', 8011, cfg.dataDir, 'gcl-store']]);
  for (const sub of ['data', 'media', 'export', 'consume', 'redisdata']) assert.ok(existsSync(path.join(cfg.dataDir, sub)), sub);
  const envFile = path.join(cfg.dataDir, ENV_FILE);
  assert.equal(mode600(envFile), '600');
  const env = readFileSync(envFile, 'utf8');
  assert.match(env, new RegExp(`PAPERLESS_ADMIN_USER=${SERVICE_USER}`));
  assert.match(env, /PAPERLESS_SECRET_KEY=\S{40,}/);
  assert.match(env, /PAPERLESS_ADMIN_PASSWORD=\S{20,}/);
  const tokens = path.join(cfg.dataDir, TOKENS_FILE);
  assert.equal(mode600(tokens), '600');
  assert.deepEqual(JSON.parse(readFileSync(tokens, 'utf8')).service, { username: SERVICE_USER, token: 'tok-1' });
  assert.equal(http.calls.find(c => c.path === '/api/token/').body.username, SERVICE_USER);
  assert.equal(stores.made[0].token, 'tok-1');
  assert.equal(stores.made[0].base, 1);
  assert.equal(svc.serviceClient(), stores.made[0]);
  assert.deepEqual(ensureSecrets(cfg.dataDir).PAPERLESS_SECRET_KEY, env.match(/PAPERLESS_SECRET_KEY=(\S+)/)[1], 'secrets are made once');
});

test('a second start reuses the saved token while it still works', async () => {
  const d = tmp(); const cfg = storeConfig({ dataDir: d, env: {}, defaultMode: 'managed' }); const http = scripted();
  const opts = { config: cfg, docker: dockerStub(), fetch: http.fetch, createStore: stubStores().createStore, log: quiet, sleep: async () => {} };
  await createStoreService(opts).start();
  await createStoreService(opts).start();
  assert.equal(http.calls.filter(c => c.path === '/api/token/').length, 1);
});

test('managed: Paperless never answering, or refusing the service account, is unavailable', async () => {
  const cfg = storeConfig({ dataDir: tmp(), env: {}, defaultMode: 'managed' });
  const silent = createStoreService({ config: cfg, docker: dockerStub(), fetch: scripted({ answering: false }).fetch, createStore: stubStores().createStore, log: quiet, sleep: async () => {}, healthTimeoutMs: 0 });
  assert.deepEqual([(await silent.start()).state, silent.status().reason], ['unavailable', 'The document store did not answer.']);
  const refused = createStoreService({ config: cfg, docker: dockerStub(), fetch: scripted({ tokenStatus: 400 }).fetch, createStore: stubStores().createStore, log: quiet, sleep: async () => {} });
  assert.match((await refused.start()).reason, /refused the service account/);
  const noCompose = createStoreService({ config: cfg, docker: dockerStub({ up: false }), log: quiet });
  assert.match((await noCompose.start()).reason, /pull access denied/);
});

test('check: a store that stops answering shows unavailable, and ready again when it is back', async () => {
  let healthy = true;
  const svc = createStoreService({ config: storeConfig({ dataDir: tmp(), env: {}, defaultMode: 'managed' }), docker: dockerStub(), fetch: scripted().fetch, createStore: stubStores({ healthy: () => healthy }).createStore, log: quiet, sleep: async () => {}, checkEveryMs: 0 });
  await svc.start();
  healthy = false;
  assert.deepEqual([(await svc.check()).state, svc.status().reason], ['unavailable', 'The document store cannot be reached.']);
  assert.throws(() => svc.getClient('jane'), e => e.status === 503);
  healthy = true;
  assert.equal((await svc.check()).state, 'ready');
});

test('per-lawyer users: one Paperless superuser and token each, kept 0600; getClient acts as them or as the service', async () => {
  const d = tmp(); const cfg = storeConfig({ dataDir: d, env: {}, defaultMode: 'managed' });
  const http = scripted(); const stores = stubStores({ users: ['p.raman'] });
  const svc = createStoreService({ config: cfg, docker: dockerStub(), fetch: http.fetch, createStore: stores.createStore, log: quiet, sleep: async () => {} });
  await svc.start();
  assert.equal(svc.getClient('u-1'), svc.serviceClient(), 'no store user yet: the service account');
  const u = await svc.ensureUser({ id: 'u-1', name: 'P Raman' });
  assert.deepEqual(u, { id: 'u-1', username: 'p.raman-2', created: true }, 'a taken username gets a suffix');
  const sent = stores.made[0].lastUser;
  assert.deepEqual([sent.is_superuser, sent.is_staff, sent.first_name, sent.last_name], [true, false, 'P', 'Raman']);
  assert.equal(http.calls.at(-1).body.username, 'p.raman-2');
  const client = svc.getClient('u-1');
  assert.equal(client.token, 'tok-2');
  assert.equal(svc.getClient('u-1'), client, 'clients are kept');
  assert.deepEqual(await svc.ensureUser({ id: 'u-1', name: 'P Raman' }), { id: 'u-1', username: 'p.raman-2', created: false });
  const saved = JSON.parse(readFileSync(path.join(cfg.dataDir, TOKENS_FILE), 'utf8'));
  assert.deepEqual(saved.users['u-1'], { paperlessId: 12, username: 'p.raman-2', token: 'tok-2' });
  assert.ok(!JSON.stringify(saved).includes(sent.password), 'the password is not kept');
});

test('fake mode: ready without Docker; each lawyer is credited in the store\'s history', async () => {
  const svc = createStoreService({ config: storeConfig({ dataDir: tmp(), env: { GCL_STORE: 'fake' } }), docker: dockerStub(), log: quiet });
  assert.equal((await svc.start()).state, 'ready');
  await svc.ensureUser({ id: 'u-9', name: 'Jane Doe' });
  const d = await svc.getClient('u-9').add(Buffer.from('x'), { filename: 'a.txt' });
  assert.equal((await svc.serviceClient().history(d.id))[0].actor, 'jane.doe');
  assert.deepEqual((await svc.serviceClient().taxonomy.tags.list()).map(t => t.name), ['inbox', 'on hold', 'signed']);
});

test('usernameFor: Django-safe, readable, never empty', () => {
  assert.equal(usernameFor('Zoë O\'Brien-Smith', 'x'), 'zoe.o.brien-smith');
  assert.equal(usernameFor('jsmith', 'jsmith'), 'jsmith');
  assert.equal(usernameFor('P. Raman', 'x'), 'p.raman', 'an initial\'s dot and the space are one dot');
  assert.equal(usernameFor('!!!', 'abcdef123456'), 'user-abcdef12');
});

test('GET /api/v2/store/status answers the service status', async () => {
  const svc = createStoreService({ config: storeConfig({ dataDir: tmp(), env: { GCL_STORE: 'fake' } }), log: quiet });
  await svc.start();
  const app = express(); app.use('/api/v2/store', storeRoutes(svc));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/v2/store/status`)).json();
    assert.deepEqual({ ...body, since: undefined }, { mode: 'fake', state: 'ready', reason: null, version: 'fake', url: null, since: undefined });
  } finally { server.close(); }
});
