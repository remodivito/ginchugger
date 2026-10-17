// SPDX-License-Identifier: GPL-3.0-or-later
// RemoteRecord (product v2 spec 6.1): the Record interface over the team server's /api/v2, for a local app in team
// mode. Every method answers as LocalRecord does (tests/record-interface.test.js runs one suite against both). Reads
// are cached for 60 seconds by URL and every write clears the cache; a cached read is revalidated with the record's
// generation tag (`If-None-Match`, answered 304 when nothing changed), so a colleague's write shows at once and an
// unchanged read costs a few bytes. A connection gets 10 seconds, a response 60. HTTPS only, validated against
// `server.caFile` when IT runs its own CA (Node's own store otherwise; PR-SEC-04); there is no plaintext fallback.
// Errors arrive as { error: { code, message } } and are thrown with `status` and `code`; a server that cannot be
// reached is 503 `record_unavailable`; an untrusted certificate is `certificate_untrusted`. Also: redeeming a setup
// code (7.10 step 3), `server-info` for the version banner (7.11), and the `tls.connect` probe that reads an
// untrusted certificate's subject and fingerprint so the lawyer can check it with IT (7.10, never "trust anyway").
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { importProsePlaybook } from '../playbook.js';

export const TIMEOUTS = { connectMs: 10_000, responseMs: 60_000 };
export const CACHE_MS = 60_000;
const err = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const TLS_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE']);
export const UNAVAILABLE = 'Record unavailable: the team server cannot be reached. Retry.';
export const UNTRUSTED = "The team server's certificate is not trusted. Ask IT for its CA certificate and set it as the CA file.";

/** The CA bundle for `server.caFile` (PEM), or undefined to use Node's own store. */
export const readCa = caFile => (caFile ? readFileSync(caFile) : undefined);

/** One HTTPS request with the connect and response timeouts. Resolves { status, headers, body: Buffer }. */
export function httpsRequest(url, { method = 'GET', headers = {}, body = null, ca, agent, connectMs = TIMEOUTS.connectMs, responseMs = TIMEOUTS.responseMs } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return Promise.reject(err(400, 'https_required', 'The team server is reached over HTTPS only.'));
  return new Promise((resolve, reject) => {
    let done = false; const finish = (fn, v) => { if (!done) { done = true; clearTimeout(connectTimer); clearTimeout(responseTimer); fn(v); } };
    const req = https.request(u, { method, headers: { Accept: 'application/json', ...headers, ...(body ? { 'Content-Length': body.length } : {}) }, ca, agent, servername: u.hostname });
    const connectTimer = setTimeout(() => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), connectMs);
    const responseTimer = setTimeout(() => req.destroy(Object.assign(new Error('response timeout'), { code: 'ETIMEDOUT' })), responseMs);
    req.on('socket', s => { if (!s.connecting) clearTimeout(connectTimer); else s.once('secureConnect', () => clearTimeout(connectTimer)); });
    req.on('response', res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', e => finish(reject, e)); });
    req.on('error', e => finish(reject, e));
    if (body) req.write(body);
    req.end();
  });
}

/** A network or TLS failure as the error the pages show. */
export function transportError(e) {
  if (e.status) return e;
  if (TLS_CODES.has(e.code) || /certificate|self.signed/i.test(e.message || '')) return err(503, 'certificate_untrusted', UNTRUSTED, { reason: e.code || e.message });
  return err(503, 'record_unavailable', UNAVAILABLE, { reason: e.code || e.message });
}

/**
 * The certificate a server presents, read without trusting it (7.10): subject, issuer, SHA-256 fingerprint, expiry.
 * Nothing is sent over this connection and it is closed at once; it is never used to sign in.
 */
export function probeCertificate(url, { timeoutMs = TIMEOUTS.connectMs } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false }, () => {
      const c = socket.getPeerCertificate();
      socket.destroy();
      resolve(c && c.fingerprint256 ? { subject: Object.entries(c.subject || {}).map(([k, v]) => `${k}=${v}`).join(', '), issuer: Object.entries(c.issuer || {}).map(([k, v]) => `${k}=${v}`).join(', '), fingerprint256: c.fingerprint256, validTo: c.valid_to } : null);
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(err(503, 'record_unavailable', UNAVAILABLE)); });
    socket.on('error', e => reject(transportError(e)));
  });
}

async function call(base, path, { method = 'GET', key = null, json, raw, ca, agent, responseMs, etag } = {}) {
  const headers = {}; let body = null;
  if (etag) headers['If-None-Match'] = etag;
  if (key) headers.Authorization = `Bearer ${key}`;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = Buffer.from(JSON.stringify(json)); }
  if (raw) { headers['Content-Type'] = raw.type; body = raw.body; }
  let r;
  try { r = await httpsRequest(base + '/api/v2' + path, { method, headers, body, ca, agent, ...(responseMs ? { responseMs } : {}) }); } catch (e) { throw transportError(e); }
  if (r.status >= 400) {
    let e = null; try { e = JSON.parse(r.body.toString('utf8')).error; } catch { /* not JSON */ }
    throw err(r.status, e?.code || 'error', e?.message || `The team server answered ${r.status}.`);
  }
  return r;
}
const parse = r => (r.body.length ? JSON.parse(r.body.toString('utf8')) : null);

/** `GET /server-info` (anyone): name, version, minClientVersion, schema version. */
export async function serverInfo(url, { ca } = {}) { return parse(await call(url, '/server-info', { ca })); }

/** Redeem a setup code (7.10 step 3): `{ userId, name, admin, key }`. The key is shown here once. */
export async function redeemCode(url, { code, deviceName }, { ca } = {}) {
  return parse(await call(url, '/setup-codes/redeem', { method: 'POST', json: { code, deviceName }, ca }));
}

const enc = encodeURIComponent;

/**
 * `url`: the team server's https:// address; `key`: the member's key (from the keychain); `caFile`: IT's CA.
 * `onAuthError(code)`: told when the server answers 401 (`key_revoked` when an admin revoked this key).
 */
export function openRemoteRecord({ url, key, caFile = null, ca = readCa(caFile), cacheMs = CACHE_MS, now = () => Date.now(), onAuthError = () => {}, timeouts = TIMEOUTS } = {}) {
  if (!url) throw err(400, 'bad_request', 'No team server is configured.');
  if (new URL(url).protocol !== 'https:') throw err(400, 'https_required', 'The team server is reached over HTTPS only.');
  const base = url.replace(/\/+$/, '');
  const agent = new https.Agent({ keepAlive: true, ca, maxSockets: 8 });
  const cache = new Map();
  const clear = () => cache.clear();
  const stats = { fetched: 0, notModified: 0 };

  async function send(path, opts = {}) {
    const method = opts.method || 'GET';
    if (method !== 'GET') clear(); // every write clears the read cache, before and after (6.1)
    try {
      const r = await call(base, path, { ...opts, method, key, ca, agent, responseMs: timeouts.responseMs });
      if (method !== 'GET') clear();
      return r;
    } catch (e) { if (e.status === 401) { clear(); onAuthError(e.code); } throw e; }
  }
  async function get(path, { fresh = false } = {}) {
    const hit = !fresh && cache.get(path);
    const live = hit && now() - hit.at < cacheMs;
    const r = await send(path, live && hit.etag ? { etag: hit.etag } : {});
    if (r.status === 304 && live) { stats.notModified++; return structuredClone(hit.value); }
    stats.fetched++;
    const value = parse(r);
    cache.set(path, { at: now(), value, etag: r.headers.etag || null }); if (cache.size > 500) cache.delete(cache.keys().next().value);
    return structuredClone(value);
  }
  const post = async (path, json, method = 'POST') => parse(await send(path, { method, json }));

  const record = {
    async info() { const i = await get('/server-info'); return { mode: 'team', version: i.version, schemaVersion: i.schemaVersion }; },
    playbooks: {
      list: () => get('/playbooks'),
      get: id => get(`/playbooks/${enc(id)}`),
      update: (id, draft = {}, changeCount, actor, { kind = null } = {}) => post(`/playbooks/${enc(id)}`, { ...draft, changeCount, ...(kind ? { kind } : {}) }, 'PUT'),
      create: ({ id, title, appliesTo = null, draft = {} } = {}) => post('/playbooks', { id, title, appliesTo, draft }),
      proposals: id => get(`/playbooks/${enc(id)}/proposals`),
      accept: (id, proposalId) => post(`/playbooks/${enc(id)}/proposals/${enc(proposalId)}/accept`, {}),
      decline: (id, proposalId, note) => post(`/playbooks/${enc(id)}/proposals/${enc(proposalId)}/decline`, { note }),
      setOwners: (id, owners) => post(`/playbooks/${enc(id)}/owners`, { owners }, 'PUT'),
      import: async text => ({ rules: importProsePlaybook(text) }), // a mechanical split, no record involved
    },
    clauseTypes: { get: () => get('/clause-types') },
    actors: () => get('/actors'),
    admin: {
      status: () => get('/admin/status', { fresh: true }),
      issueCode: (forName, admin, ttlHours, actor, { userId = null } = {}) => post('/admin/setup-codes', { forName, admin: !!admin, ttlHours, userId }),
      listCodes: () => get('/admin/setup-codes', { fresh: true }),
      revokeCode: id => post(`/admin/setup-codes/${enc(id)}`, undefined, 'DELETE'),
      listUsers: () => get('/admin/users', { fresh: true }),
      revokeUser: id => post(`/admin/users/${enc(id)}/revoke`, {}),
      checkMailNow: () => post('/admin/mail/check', {}),
      setRetention: adoptedOn => post('/admin/retention', { adoptedOn }, 'PUT'),
    },
    /** Team-mode only: who this key is, and the server's version (never cached: they drive sign-out and the banner). */
    me: () => get('/me', { fresh: true }),
    serverInfo: () => get('/server-info', { fresh: true }),
    clearCache: clear,
    /** Reads fetched in full and reads answered 304 from the cache (tests). */
    cacheStats: () => ({ ...stats }),
    close() { agent.destroy(); clear(); },
  };
  return record;
}
