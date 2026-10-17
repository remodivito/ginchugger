#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The team server (product v2 spec 3.1, `mode: server`, slice S7): one process in one container, one data folder, one
// settings file. It holds the shared record (LocalRecord over SQLite in the data folder) and serves it as /api/v2 over
// HTTPS to the lawyers' local apps; it signs members in with setup codes and keys; it runs no executor, imports nothing
// that does (PR-TEAM-01), and refuses to start when an AI credential, a model setting or a model CLI is present
// (PR-SEC-07). Without a certificate it does not start: there is no plaintext fallback (PR-SEC-04). With mail.enabled
// it polls the one shared mailbox (server/mail/consumer.js, slice S8) and writes what it captures to the document store.
// The store is configured as in the local app (decision 191; plan task 11): the settings file's `store` keys, with the
// GCL_STORE_* variables over them; unset, it is Paperless managed on this machine when the server runs from its own data
// folder (GCL_DATA_DIR or /data), and off otherwise (the tests). OpenID Connect is a documented seam only
// (server/record/identity.js, decision 167).
//
//   node server/team-server.js [--data <dir>]      (GCL_DATA_DIR, default /data)
import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { X509Certificate, randomBytes } from 'node:crypto';
import path from 'node:path';
import { openLocalRecord } from './record/local.js';
import { recordRoutes } from './record/http.js';
import { importPlaybooks } from './record/legacy.js';
import { pidFile } from './record/admin.js';
import { createMailConsumer } from './mail/consumer.js';
import { rateLimiter, normalizeCode } from './record/team.js';
import { bearerIdentity } from './record/identity.js';
import { readServerSettings, writeDefaultServerSettings } from './settings.js';
import { storeConfig, createStoreService } from './store/service.js';
import { storeRoutes } from './store/http.js';
import { storeReadRoutes } from './store/remote.js';
import { openReviewHistory } from './store/review-history.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const NAME = 'GinChugger team server';
/** executors.js's STRIP list (PR-SEC-07), repeated here because the server must not import executors.js (PR-TEAM-01); a test keeps the two equal. */
export const AI_CREDENTIAL_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
/** The model CLIs an executor would run, and the variables that would name another copy of them. */
export const MODEL_BINARIES = ['claude', 'codex', 'muse', 'agy'];
export const MODEL_BINARY_ENV = ['CLAUDE_BIN', 'CODEX_BIN', 'MUSE_BIN', 'AGY_BIN'];
const fail = (code, message) => Object.assign(new Error(message), { code });

/** What PR-SEC-07 refuses: credential variables, model settings in the file, a model CLI on PATH or named by a variable. */
export function findAiCredentials({ env = process.env, forbidden = [], platform = process.platform } = {}) {
  const found = [];
  for (const k of AI_CREDENTIAL_ENV) if (typeof env[k] === 'string' && env[k] !== '') found.push(k);
  for (const k of MODEL_BINARY_ENV) if (typeof env[k] === 'string' && env[k] !== '') found.push(k);
  for (const k of forbidden) found.push(`${k} (settings file)`);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const bin of MODEL_BINARIES) for (const ext of exts) {
      const file = path.join(dir, bin + ext);
      try { if (statSync(file).isFile()) found.push(`the ${bin} program (${file})`); } catch { /* not there */ }
    }
  }
  return [...new Set(found)];
}
export const refusalMessage = found => `This is the team server. It makes no model calls; remove ${found.join(', ')} from its environment, settings or image.`;

/** "host:port" as listen() takes it; IPv6 hosts in brackets. */
export function parseListen(s) {
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(String(s || ''));
  if (!m) throw fail('settings_invalid', `server.listen is "${s}"; write it as host:port, such as 0.0.0.0:8443.`);
  return { host: m[1] || m[2] || '0.0.0.0', port: Number(m[3]) };
}

/** Why the server is "not configured" (PR-ADM-01), each reason a sentence the status page shows. */
function notConfigured(settings, counts) {
  const reasons = [];
  if (!settings.server.publicUrl) reasons.push('server.publicUrl is not set in the settings file: set it to the address the lawyers type.');
  if (!counts.admins) reasons.push('There is no admin yet: run gcl admin issue-code --for "<name>" --admin inside the container.');
  return reasons;
}

/** The team server's document store service, from its settings and environment (plan task 11). */
export function teamStore({ settings, env = process.env, dataDir, defaultMode = 'off', log = console }) {
  // trash.purgeAfterDays (off by default, decision 188) switches on Paperless's own emptying of its trash (a managed store;
  // in the shipped container, compose.yml's store-init reads it from the same settings file).
  return createStoreService({ config: storeConfig({ settings: { ...(settings.store || {}), purgeAfterDays: settings.trash?.purgeAfterDays ?? null }, env, dataDir, defaultMode }), log });
}

/**
 * Check everything that must hold before serving, open the record and build the app. Throws with a `code` and the
 * sentence an admin reads: ai_credential_present, settings_unknown_key, settings_invalid, tls_missing,
 * schema_newer_than_code. `env` is the process environment (tests pass a clean one); `mailDeps` replaces the mail
 * consumer's outside world (IMAP client class, DNS, token) in tests and the simulated-mailbox harness. `store` is the
 * document store service mail captures go to (createStoreService, or anything with serviceClient(), start() and
 * status()); without it one is made from the settings file's `store` keys and GCL_STORE_* (teamStore), with
 * `defaultStoreMode` when no mode is set: main() passes 'managed'; tests leave it off.
 */
export async function createTeamServer({ dataDir, env = process.env, log = console, now = () => new Date().toISOString(), clock = () => Date.now(), mailDeps = {}, store = null, defaultStoreMode = 'off' }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const wroteDefaults = writeDefaultServerSettings(dataDir);
  const { settings, forbidden } = readServerSettings(dataDir, { env });
  const found = findAiCredentials({ env, forbidden });
  if (found.length) throw fail('ai_credential_present', refusalMessage(found));
  const { certFile, keyFile } = settings.server.tls;
  if (!certFile || !keyFile || !existsSync(certFile) || !existsSync(keyFile)) throw fail('tls_missing', `No certificate at ${certFile} and ${keyFile}. The team server serves HTTPS only: put the certificate and key IT issued there (or set server.tls.certFile and keyFile) and start again.`);
  const tls = { cert: readFileSync(certFile), key: readFileSync(keyFile) };
  let certificate; try { const x = new X509Certificate(tls.cert); certificate = { subject: x.subject, expiresAt: new Date(x.validTo).toISOString(), fingerprint256: x.fingerprint256 }; } catch (e) { throw fail('tls_missing', `The certificate at ${certFile} could not be read: ${e.message}`); }
  const listen = parseListen(settings.server.listen);
  const minClientVersion = settings.server.minClientVersion || PACKAGE.version;

  const record = openLocalRecord({ dataDir, mode: 'team', now });
  await importPlaybooks(record, dataDir).catch(e => log.error(`Shipped playbooks not copied into the record: ${e.message}`));
  const team = record.internal.team;
  const started = clock();
  const limiter = rateLimiter({ now: clock });
  const perIp = Number(settings.codes.redeemRatePerMinute) || 10;
  // Mail capture (7.2): one consumer for the one shared mailbox; "check mail now" starts a check and answers at once.
  // Its captures go to the document store (plan task 9), asked for at capture time so an unavailable store fails that
  // message only. A service already started by the caller is not started again (a fake one would start empty).
  const documents = store || teamStore({ settings, env, dataDir, defaultMode: defaultStoreMode, log });
  if (settings.mail.enabled && documents.status?.().state !== 'ready') await documents.start();
  else if (documents.status?.().state !== 'ready') documents.start().then(s => { if (s.state === 'unavailable') log.error(`Document store unavailable: ${s.reason}`); }); // never blocks the server
  const mail = settings.mail.enabled ? createMailConsumer({ record, settings, documents: () => documents.serviceClient(), log, now, clock, deps: mailDeps }) : null;
  if (mail) record.admin.checkMailNow = async () => mail.checkNow();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000'); res.setHeader('Cache-Control', 'no-store');
    if (settings.log.requests) res.on('finish', () => log.log(`${req.method} ${req.path} ${res.statusCode}${req.user ? ` ${req.user.userId}` : ''}`)); // never bodies or keys
    next();
  });
  const info = () => ({ name: NAME, version: PACKAGE.version, minClientVersion, mode: 'team', oidc: false, schemaVersion: null });
  const errorOut = (res, status, code, message) => res.status(status).json({ error: { code, message } });

  app.get('/api/v2/server-info', async (req, res) => res.json({ ...info(), schemaVersion: (await record.info()).schemaVersion, configured: !notConfigured(settings, team.counts()).length }));
  app.post('/api/v2/setup-codes/redeem', express.json({ limit: '16kb' }), (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!limiter.allow('all', 60) || !limiter.allow(`ip:${req.ip}`, perIp) || !limiter.allow(`prefix:${code.slice(0, 6)}`, perIp)) return errorOut(res, 429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
    try { res.status(201).json(team.redeem({ code, deviceName: req.body?.deviceName })); } catch (e) { errorOut(res, e.status || 400, e.code || 'bad_request', e.message); }
  });
  // The record's generation, for RemoteRecord's cache (6.1): this process, the writes it has answered and the last
  // event, so a read the client already holds is answered 304 and a colleague's write shows at once.
  const boot = randomBytes(4).toString('hex'); let writes = 0;
  const maxSeq = record.internal.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events');
  app.use('/api/v2', (req, res, next) => { if (req.method !== 'GET') res.on('finish', () => { writes++; }); next(); });
  // Every other /api/v2 route needs a member's key (6.2.1); reads are not logged (decision 167).
  app.use('/api/v2', (req, res, next) => {
    const who = bearerIdentity(req, team);
    if (!who) return errorOut(res, 401, 'unauthorized', 'Sign in to the team server with a setup code.');
    if (who.revoked) return errorOut(res, 401, 'key_revoked', 'Signed out by an admin.');
    req.user = who;
    if (req.method === 'GET' && !req.path.startsWith('/store/')) { // the store's reads are not the record's: never 304 on its generation
      const tag = `"${boot}-${writes}-${maxSeq.get().n}"`;
      if (req.headers['if-none-match'] === tag) return res.status(304).end();
      res.setHeader('ETag', tag);
    }
    next();
  });
  app.get('/api/v2/me', (req, res) => res.json({ userId: req.user.userId, name: req.user.name, admin: req.user.admin }));
  // The document store for the lawyers' apps (team mode): its routes as on a solo app, acting as the member whose key
  // signed the request, through their own Paperless user (made on their first store request), so its history names
  // them; holds and the whole store's activity for admins, as the member's admin flag says. Paperless itself, its
  // address and its tokens stay on this machine. Review history is kept here, beside the record.
  const memberActor = req => ({ id: req.user.userId, name: req.user.name, admin: !!req.user.admin });
  const storeUsers = new Set();
  const reviews = openReviewHistory({ dataDir });
  const storeView = Object.assign(Object.create(documents), { check: async () => ({ ...(await (documents.check ? documents.check() : documents.status())), url: null }) });
  app.use('/api/v2/store', async (req, res, next) => {
    const id = req.user.userId;
    if (!storeUsers.has(id) && documents.ensureUser && documents.status?.().state === 'ready') {
      try { await documents.ensureUser({ id, name: req.user.name }); storeUsers.add(id); } catch (e) { log.error(`Store user not created for ${req.user.name}: ${e.message}`); }
    }
    next();
  }, storeReadRoutes(documents, { actor: memberActor }), storeRoutes(storeView, { actor: memberActor, reviews, log, ourNames: () => settings.ourNames || [] }));
  const statusExtras = async () => ({ uptimeSeconds: Math.round((clock() - started) / 1000), publicUrl: settings.server.publicUrl, certificate, mail: { ...(await record.admin.status()).mail, enabled: !!settings.mail.enabled, mailbox: settings.mail.auth.mailbox }, notConfigured: notConfigured(settings, team.counts()), minClientVersion, store: documents.status ? { ...documents.status(), url: null } : null }); // the store's address stays on this machine
  app.use('/api/v2', recordRoutes(() => record, {
    actor: req => req.user.userId, statusExtras,
    adminGuard: (req, op) => {
      if (!req.user.admin) throw Object.assign(new Error('Only an admin can do this.'), { status: 403, code: 'forbidden' });
      if (op === 'checkMailNow' && !settings.mail.enabled) throw Object.assign(new Error('Mail capture is off: set mail.enabled in the settings file.'), { status: 409, code: 'mail_disabled' });
    },
  }));
  // The status page (9.4): what anyone on the network may see. The full list is the Admin page's, for admins.
  app.get('/', async (req, res) => {
    const reasons = notConfigured(settings, team.counts());
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = [['Version', PACKAGE.version], ['Schema', (await record.info()).schemaVersion], ['Up for', `${Math.round((clock() - started) / 60000)} minutes`], ['Certificate expires', certificate.expiresAt.slice(0, 10)], ['State', reasons.length ? 'Not configured' : 'Ready']];
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${NAME}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}dt{color:#666}dd{margin:0 0 .5rem}</style></head><body><h1>${NAME}</h1><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${reasons.length ? `<h2>Not configured</h2><ul>${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}<p>Admins see the full status on the Admin page of their app.</p></body></html>`);
  });
  app.use((req, res) => errorOut(res, 404, 'not_found', 'Unknown operation.'));

  let httpsServer = null;
  return {
    app, record, settings, certificate, wroteDefaults, mail, store: documents,
    /** Listen over HTTPS (the given port overrides settings, for tests) and write the pid file `gcl restore` checks. */
    listen(port = listen.port, host = listen.host) {
      return new Promise((resolve, reject) => {
        httpsServer = createHttpsServer({ ...tls, minVersion: 'TLSv1.2' }, app);
        httpsServer.once('error', reject);
        httpsServer.listen(port, host, () => {
          writeFileSync(pidFile(dataDir), String(process.pid));
          mail?.start();
          resolve({ port: httpsServer.address().port, server: httpsServer });
        });
      });
    },
    async close() {
      await mail?.stop();
      await new Promise(r => (httpsServer ? httpsServer.close(() => r()) : r()));
      try { if (readFileSync(pidFile(dataDir), 'utf8') === String(process.pid)) rmSync(pidFile(dataDir)); } catch { /* gone */ }
      try { record.close(); } catch { /* closed */ }
      try { reviews.close(); } catch { /* closed */ }
    },
  };
}

async function main() {
  const args = process.argv.slice(2); const at = args.indexOf('--data');
  const dataDir = path.resolve(at >= 0 ? args[at + 1] : process.env.GCL_DATA_DIR || '/data');
  let srv;
  try { srv = await createTeamServer({ dataDir, defaultStoreMode: 'managed' }); } catch (e) { console.error(e.message); process.exit(1); }
  if (srv.wroteDefaults) console.log(`Wrote the default settings file to ${path.join(dataDir, 'settings.json')}.`);
  const { port } = await srv.listen().catch(e => { console.error(`The team server could not listen on ${srv.settings.server.listen}: ${e.message}`); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => srv.close().finally(() => process.exit(0)));
  console.log(`${NAME} ${PACKAGE.version} is ready at https://${parseListen(srv.settings.server.listen).host === '0.0.0.0' ? 'localhost' : parseListen(srv.settings.server.listen).host}:${port}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) main();
