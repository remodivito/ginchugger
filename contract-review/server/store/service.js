// SPDX-License-Identifier: GPL-3.0-or-later
// Paperless-ngx as a managed service (tasks/paperless-store-plan.md task 1; decision 191; plan decisions 5 and 8). On
// start-up the server asks this module for the document store: in managed mode it checks Docker, runs
// `docker compose up -d` on paperless/docker-compose.yml (loopback only, data under the app's data folder), waits until
// Paperless answers, signs in the service account and makes our base tags. It never blocks the app: until the store is
// ready, and whenever it stops answering, `status()` says so and the UI shows one line.
//
// Modes (settings.json `store.mode`, or GCL_STORE): managed (default for the app's own data folder in solo mode), external
// (a Paperless we do not run: `store.url` and a token, or the admin password in <store data>/paperless.env, as the
// team-server container's compose file sets it up: server/store/compose-init.js), fake (the in-memory store, for browser tests), off (no store; the
// default for any other data folder, so tests that start the server never start Docker).
//
// Secrets never go in the repo or the settings file: the Paperless secret key and admin password are generated on first
// start into <store data>/paperless.env, and the API tokens (the service account's and one per lawyer, plan decision 5:
// Paperless's own history then names who did what) are kept in <store data>/store-tokens.json, both mode 0600.
// Docker and HTTP are injected so the unit tests need neither.
//
// The no-Docker path (`builtInWhenNoDocker`, the solo app's own store): in managed mode, when Docker is not installed or
// not running, the in-memory store stands in, so the app works without Docker. Its documents last until the app stops;
// `status().builtIn` carries the reason, the pages show one line and the log says so. Nothing is written to the
// Paperless data folder meanwhile (its tokens stay as they were). With Docker present nothing changes.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaperlessStore } from './paperless.js';
import { createFakeStore } from './fake.js';

export const MODES = ['managed', 'external', 'fake', 'off'];
export const DEFAULT_PORT = 8011;
export const DEFAULT_PROJECT = 'gcl-store';
export const DEFAULT_DATA = 'paperless-data';
export const COMPOSE_FILE = fileURLToPath(new URL('../../paperless/docker-compose.yml', import.meta.url));
export const ENV_FILE = 'paperless.env';
export const TOKENS_FILE = 'store-tokens.json';
export const SERVICE_USER = 'gcl-service';
const DATA_DIRS = ['data', 'media', 'export', 'consume', 'redisdata'];

/**
 * The store's configuration from the settings file's `store` keys and the environment (GCL_STORE, GCL_STORE_URL,
 * GCL_STORE_PORT, GCL_STORE_DATA, GCL_STORE_PROJECT). `defaultMode` is what an unset mode means here (index.js: managed
 * for the app's own data folder in solo mode, otherwise off).
 */
export function storeConfig({ settings = {}, env = process.env, dataDir, defaultMode = 'off' }) {
  const pick = (envName, key) => (typeof env[envName] === 'string' && env[envName].trim() ? env[envName].trim() : settings[key] ?? null);
  const mode = pick('GCL_STORE', 'mode') || defaultMode;
  if (!MODES.includes(mode)) throw Object.assign(new Error(`store.mode is one of: ${MODES.join(', ')}.`), { code: 'settings_invalid' });
  const port = Number(pick('GCL_STORE_PORT', 'port') || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('store.port is a port number.'), { code: 'settings_invalid' });
  const data = pick('GCL_STORE_DATA', 'dataDir') || DEFAULT_DATA;
  const url = mode === 'managed' ? `http://127.0.0.1:${port}` : (pick('GCL_STORE_URL', 'url') || '').replace(/\/+$/, '') || null;
  return { mode, port, url, dataDir: path.isAbsolute(data) ? data : path.resolve(dataDir, data), project: pick('GCL_STORE_PROJECT', 'project') || DEFAULT_PROJECT, token: typeof env.GCL_STORE_TOKEN === 'string' && env.GCL_STORE_TOKEN ? env.GCL_STORE_TOKEN : null, purgeAfterDays: purgeDays(settings.purgeAfterDays) };
}

/** trash.purgeAfterDays as a number of days, or null (off) unless it is a whole number above zero. */
export const purgeDays = v => (Number.isInteger(v) && v > 0 ? v : null);

/** Paperless's trash delay while emptying is off: 100 years, a backstop in case its schedule is ever switched on by hand. */
export const NO_PURGE_DELAY_DAYS = 36500;
/**
 * The environment `docker compose` runs with: the port and data folder, and the trash (decision 188: nothing is purged
 * automatically unless switched on). Paperless empties its trash daily at 01:00, of items older than 30 days, by
 * default; we switch that task off (PAPERLESS_EMPTY_TRASH_TASK_CRON=disable) unless `purgeAfterDays` is set
 * (trash.purgeAfterDays in the settings file, solo or team server alike), and then it empties items older than that many days.
 */
export function composeEnv({ port, dataDir, purgeAfterDays = null }, base = process.env) {
  const t = trashSchedule(purgeAfterDays);
  return { ...base, GCL_PAPERLESS_PORT: String(port), GCL_PAPERLESS_DATA: dataDir, GCL_PAPERLESS_EMPTY_TRASH_CRON: t.cron, GCL_PAPERLESS_EMPTY_TRASH_DELAY: t.delay };
}
/** Paperless's PAPERLESS_EMPTY_TRASH_TASK_CRON and PAPERLESS_EMPTY_TRASH_DELAY for trash.purgeAfterDays (null: off). */
export function trashSchedule(purgeAfterDays) {
  const days = purgeDays(purgeAfterDays);
  return { cron: days ? '0 1 * * *' : 'disable', delay: String(days || NO_PURGE_DELAY_DAYS) };
}

/** The Docker CLI, as the service uses it. Every call resolves; failures come back as { ok: false, reason }. */
export function dockerCli({ run = (cmd, args, opts) => new Promise(resolve => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }))) } = {}) {
  const compose = (cfg, args, timeout) => run('docker', ['compose', '-f', cfg.composeFile || COMPOSE_FILE, '-p', cfg.project, ...args], { env: composeEnv(cfg), timeout });
  const reason = r => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-1)[0] || `exit ${r.code}`;
  return {
    async available() {
      const r = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
      return r.code === 0 ? { ok: true, version: r.stdout.trim() } : { ok: false, reason: /not found|ENOENT/i.test(r.stderr) ? 'Docker is not installed.' : 'Docker is not running.' };
    },
    /** Pulls on first use (about 6.6 GB, several minutes), so the timeout is long. */
    async up(cfg) { const r = await compose(cfg, ['up', '-d'], 30 * 60_000); return r.code === 0 ? { ok: true } : { ok: false, reason: reason(r) }; },
    async stop(cfg) { const r = await compose(cfg, ['stop'], 120_000); return r.code === 0 ? { ok: true } : { ok: false, reason: reason(r) }; },
  };
}

function readJson(file) { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } }
function writeSecret(file, text) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', text, { mode: 0o600 }); chmodSync(file + '.tmp', 0o600); renameSync(file + '.tmp', file); }
const parseEnv = text => Object.fromEntries(String(text || '').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const secret = n => randomBytes(n).toString('base64url');

/** <store data>/paperless.env, written once (0600) with a fresh secret key and admin password; returns its values. */
export function ensureSecrets(storeDir) {
  const file = path.join(storeDir, ENV_FILE);
  if (existsSync(file)) { chmodSync(file, 0o600); return parseEnv(readFileSync(file, 'utf8')); }
  const values = { PAPERLESS_SECRET_KEY: secret(48), PAPERLESS_ADMIN_USER: SERVICE_USER, PAPERLESS_ADMIN_PASSWORD: secret(24), PAPERLESS_ADMIN_MAIL: 'store@localhost.test' };
  writeSecret(file, `# Written by GinChugger on first start. Never commit or share this file.\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  return values;
}

/** A Paperless username from a lawyer's name: letters, digits and . _ - only (Django's rules), at most 150 characters. */
export function usernameFor(name, id) {
  const base = String(name || id || 'user').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/\.{2,}/g, '.').replace(/^[.]+|[.]+$/g, '').slice(0, 140);
  return base || `user-${String(id).slice(0, 8)}`;
}

/**
 * `config`: from storeConfig. `appDataDir`: the app's data folder (for messages only). Injected: `docker` (dockerCli),
 * `fetch`, `sleep`, `now`, `createStore` (createPaperlessStore), `log`. `healthTimeoutMs`: how long to wait for
 * Paperless after `up` (first start runs its migrations: about 15 s on the spike machine).
 */
export function createStoreService({ config, docker = dockerCli(), fetch: fetchFn = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => new Date().toISOString(), createStore = createPaperlessStore, log = console, healthTimeoutMs = 5 * 60_000, pollMs = 1000, checkEveryMs = 5000, builtInWhenNoDocker = false } = {}) {
  const cfg = { ...config };
  const tokensFile = path.join(cfg.dataDir, TOKENS_FILE);
  let state = cfg.mode === 'off' ? 'off' : 'starting'; let reason = null; let version = null; let since = now(); let lastCheck = 0;
  let service = null; let fake = null; const clients = new Map(); let starting = null; let builtIn = null; let memTokens = null;
  const set = (s, r = null) => { if (s !== state || r !== reason) since = now(); state = s; reason = r; };
  const tokens = () => (memTokens || readJson(tokensFile) || { service: null, users: {} });
  const saveTokens = t => { if (memTokens) memTokens = t; else writeSecret(tokensFile, JSON.stringify(t, null, 2) + '\n'); };

  async function answering() {
    try { const r = await fetchFn(`${cfg.url}/api/`, { headers: { Accept: 'application/json; version=10' } }); return r.status < 500; } catch { return false; }
  }
  async function waitAnswering() {
    const until = Date.now() + healthTimeoutMs;
    while (Date.now() < until) { if (await answering()) return true; await sleep(pollMs); }
    return false;
  }
  /** The service account's token: the one saved, if it still works; else signed in again with the admin password. */
  async function serviceToken() {
    const t = tokens();
    // An external store is signed in to with GCL_STORE_TOKEN, else the token saved, else (the team-server container's
    // compose file: store-init writes it) the admin password in <store data>/paperless.env, if there is one.
    const envFile = path.join(cfg.dataDir, ENV_FILE);
    if (cfg.mode === 'external' && (cfg.token || !existsSync(envFile))) return cfg.token || t.service?.token || null;
    if (t.service?.token) {
      const r = await fetchFn(`${cfg.url}/api/status/`, { headers: { Authorization: `Token ${t.service.token}`, Accept: 'application/json; version=10' } }).catch(() => null);
      if (r && r.status === 200) return t.service.token;
    }
    const env = cfg.mode === 'external' ? parseEnv(readFileSync(envFile, 'utf8')) : ensureSecrets(cfg.dataDir);
    const r = await fetchFn(`${cfg.url}/api/token/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json; version=10' }, body: JSON.stringify({ username: env.PAPERLESS_ADMIN_USER, password: env.PAPERLESS_ADMIN_PASSWORD }) });
    if (r.status !== 200) throw new Error(`the store refused the service account (${r.status})`);
    const token = (await r.json()).token;
    saveTokens({ ...t, service: { username: env.PAPERLESS_ADMIN_USER, token } });
    return token;
  }

  async function startOnce() {
    if (builtIn) return status(); // the built-in store stays for this run: switching would drop its documents
    if (cfg.mode === 'off') { set('off'); return status(); }
    if (cfg.mode === 'fake') { fake = createFakeStore({ user: 'service' }); service = fake; await fake.ensureBaseTaxonomy(); version = 'fake'; set('ready'); return status(); }
    set('starting');
    if (cfg.mode === 'managed') {
      const d = await docker.available();
      if (!d.ok && builtInWhenNoDocker) {
        fake = createFakeStore({ user: 'service' }); service = fake; await fake.ensureBaseTaxonomy(); version = 'fake';
        builtIn = d.reason; memTokens = { service: null, users: {} }; set('ready');
        log.log?.(`Document store: built-in, in memory (${d.reason.replace(/\.$/, '')}). Documents are kept until the app stops; install and start Docker for the Paperless-ngx store.`);
        return status();
      }
      if (!d.ok) { set('unavailable', d.reason); return status(); }
      for (const sub of DATA_DIRS) mkdirSync(path.join(cfg.dataDir, sub), { recursive: true });
      ensureSecrets(cfg.dataDir);
      const up = await docker.up(cfg);
      if (!up.ok) { set('unavailable', `Docker could not start the store: ${up.reason}`); return status(); }
    }
    if (!cfg.url) { set('unavailable', 'No address is set for the document store (store.url).'); return status(); }
    if (!(await waitAnswering())) { set('unavailable', 'The document store did not answer.'); return status(); }
    try {
      const token = await serviceToken();
      if (!token) { set('unavailable', 'No API token for the document store.'); return status(); }
      service = createStore({ url: cfg.url, token, fetch: fetchFn });
      const h = await service.health();
      version = h.version;
      if (!h.ok) { set('unavailable', `The document store is not ready: ${h.detail}`); return status(); }
      await service.ensureBaseTaxonomy();
      clients.clear();
      set('ready'); lastCheck = Date.now();
      log.log?.(`Document store ready: Paperless-ngx ${version} at ${cfg.url}.`);
    } catch (e) { set('unavailable', e.message); }
    return status();
  }

  function status() { return { mode: cfg.mode, state, reason, version, url: cfg.mode === 'fake' || cfg.mode === 'off' || builtIn ? null : cfg.url, since, ...(builtIn ? { builtIn } : {}) }; }

  const self = {
    config: cfg,
    /** Start (or retry) the store; resolves with the status, never throws. Concurrent calls share one start. */
    start() { if (!starting) starting = startOnce().finally(() => { starting = null; }); return starting; },
    status,
    /** The status after a fresh health check (at most every `checkEveryMs`): a stopped Paperless shows as unavailable. */
    async check() {
      if (starting || cfg.mode === 'off' || cfg.mode === 'fake' || builtIn || !service) return status();
      if (Date.now() - lastCheck < checkEveryMs) return status();
      lastCheck = Date.now();
      try { const h = await service.health(); version = h.version; if (h.ok) set('ready'); else set('unavailable', `The document store is not ready: ${h.detail}`); } catch (e) { set('unavailable', e.code === 'store_unavailable' ? 'The document store cannot be reached.' : e.message); }
      return status();
    },
    async stop() { return cfg.mode === 'managed' && !builtIn ? docker.stop(cfg) : { ok: true }; },
    /** The service account's store, or a 503 when the store is not ready. */
    serviceClient() { if (state !== 'ready' || !service) throw Object.assign(new Error('The document store is unavailable.'), { status: 503, code: 'store_unavailable' }); return service; },
    /**
     * The store acting as one of our users (plan decision 5), so Paperless's history names them. Falls back to the
     * service account when that user has no Paperless user yet.
     */
    getClient(ourUserId) {
      const svc = self.serviceClient();
      if (!ourUserId) return svc;
      if (fake) { if (!clients.has(ourUserId)) clients.set(ourUserId, fake.as(tokens().users?.[ourUserId]?.username || String(ourUserId))); return clients.get(ourUserId); }
      const u = tokens().users?.[ourUserId];
      if (!u?.token) return svc;
      if (!clients.has(ourUserId)) clients.set(ourUserId, createStore({ url: cfg.url, token: u.token, fetch: fetchFn }));
      return clients.get(ourUserId);
    },
    /**
     * A Paperless user and token for one of ours ({ id, name }), made once. The user is a Paperless superuser so every
     * lawyer sees every document (we do not use Paperless's per-document permissions: spike, "What this means");
     * nobody signs in to Paperless as them: the password is random and thrown away, and only the token is kept.
     */
    async ensureUser({ id, name }) {
      if (!id) throw Object.assign(new Error('Which user?'), { status: 400, code: 'bad_request' });
      const t = tokens();
      if (t.users?.[id]?.token) return { id, username: t.users[id].username, created: false };
      const svc = self.serviceClient();
      if (fake) { const username = usernameFor(name, id); saveTokens({ ...t, users: { ...(t.users || {}), [id]: { username, token: 'fake' } } }); clients.delete(id); return { id, username, created: true }; }
      const password = secret(24); const first = String(name || '').trim();
      let made = null; const base = usernameFor(name, id);
      for (let n = 1; n <= 20 && !made; n++) {
        const username = n === 1 ? base : `${base}-${n}`;
        try {
          made = await svc.call('POST', '/api/users/', { json: { username, password, first_name: first.split(/\s+/)[0] || '', last_name: first.split(/\s+/).slice(1).join(' '), is_superuser: true, is_staff: false, is_active: true } });
        } catch (e) { if (!/username/i.test(e.message)) throw e; }
      }
      if (!made) throw Object.assign(new Error('Could not choose a store username.'), { status: 409, code: 'conflict' });
      const r = await fetchFn(`${cfg.url}/api/token/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json; version=10' }, body: JSON.stringify({ username: made.username, password }) });
      if (r.status !== 200) throw Object.assign(new Error(`The store did not issue a token for ${made.username} (${r.status}).`), { status: 503, code: 'store_unavailable' });
      const token = (await r.json()).token;
      const now2 = tokens();
      saveTokens({ ...now2, users: { ...(now2.users || {}), [id]: { paperlessId: made.id, username: made.username, token } } });
      clients.delete(id);
      return { id, username: made.username, created: true };
    },
  };
  return self;
}
