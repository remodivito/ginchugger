// SPDX-License-Identifier: GPL-3.0-or-later
// The document store in team mode: the lawyers' apps reach the store on the team machine through the team server, never
// Paperless itself (tasks/paperless-store-plan.md, architecture decision 8: Paperless stays bound to the team machine's
// loopback, and its tokens never leave that machine). Both sides of the wire are here.
//
// The team server mounts the store's own routes (server/store/http.js) under /api/v2/store behind the member's key,
// acting as that member's Paperless user (plan decision 5), plus `storeReadRoutes`: one read-only route the laptop's
// agent tools, Ask's context and the citation check read through, so they run against the team store with the same
// operations the in-process store offers.
//
// The laptop's server, in team mode, uses `openRemoteStore`: `proxy` forwards every /api/v2/store request from its pages
// and the Word pane to the team server with the member's key (the same key, CA and HTTPS rules as RemoteRecord), and
// `getClient()` is the store interface's read operations over that connection, for the agentic review, Ask and the
// tools listener the Claude CLI's MCP child calls. The member is whoever the key says; the laptop cannot act as anyone
// else.
//
//   POST /api/v2/store/read  { op, args }   op: getDocument, list, search, similar, findDuplicates, notes.list
import { storeErrorMessage } from './http.js';
import express from 'express';
import https from 'node:https';
import { httpsRequest, readCa } from '../record/remote.js';
import { storeError } from './index.js';

/** The read operations a laptop may ask for, and how each is called on a store. Nothing here writes. */
export const READ_OPS = {
  getDocument: (s, [id]) => s.getDocument(Number(id)),
  list: (s, [filters]) => s.list(filters || {}),
  search: (s, [query, opts]) => s.search(String(query ?? ''), opts || {}),
  similar: (s, [id, opts]) => s.similar(Number(id), opts || {}),
  findDuplicates: (s, [id]) => s.findDuplicates(Number(id)),
  'notes.list': (s, [id]) => s.notes.list(Number(id)),
};

/**
 * The team server's read route. `service`: the store service; `actor(req)`: { id, name, admin } of the member whose
 * key signed the request (the store is read as their Paperless user).
 */
export function storeReadRoutes(service, { actor }) {
  const r = express.Router();
  r.post('/read', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const { op, args = [] } = req.body || {};
      if (!Object.hasOwn(READ_OPS, op) || !Array.isArray(args) || args.length > 3) throw storeError(400, 'bad_request', 'Unknown read.');
      res.json(await READ_OPS[op](service.getClient(actor(req).id), args) ?? null);
    } catch (e) { res.status(e.status || 500).json({ error: storeErrorMessage(e), ...(e.code ? { code: e.code } : {}) }); }
  });
  return r;
}

export const UNREACHABLE = 'The team server cannot be reached.';
/** Request headers passed on to the team server, and response headers passed back. Nothing else crosses. */
const PASS_REQUEST = ['content-type', 'accept'];
const PASS_RESPONSE = ['content-type', 'content-disposition', 'cache-control'];
export const MAX_FORWARD_BYTES = 20 * 25 * 1024 * 1024 + 1024 * 1024; // the store routes' own limit: 20 files of 25 MB

/** An error answer from the team server ({ error: message, code } from the store routes, { error: { code, message } } from the server). */
function answerError(r) {
  let body = null; try { body = JSON.parse(r.body.toString('utf8')); } catch { /* not JSON */ }
  const e = body?.error;
  const code = (e && typeof e === 'object' ? e.code : body?.code) || 'error';
  const message = (e && typeof e === 'object' ? e.message : e) || `The team server answered ${r.status}.`;
  return storeError(r.status, code, message);
}
const unreachable = e => storeError(503, 'store_unavailable', UNREACHABLE, { reason: e.code || e.message });

/** The request body as the laptop received it: JSON already parsed by express.json, anything else read here. */
async function bodyOf(req) {
  if (req.is('application/json')) return req.body === undefined ? null : Buffer.from(JSON.stringify(req.body));
  if (req.readableEnded) return null;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_FORWARD_BYTES) throw storeError(413, 'too_large', 'Too much to send at once.'); chunks.push(c); }
  return chunks.length ? Buffer.concat(chunks) : null;
}

export const STORE_PREFIX = '/api/v2/store/';
/** The path to forward for a request the laptop received, or null unless it stays under /api/v2/store once normalised. */
export function storePath(originalUrl) {
  let u; try { u = new URL(String(originalUrl || ''), 'http://laptop'); } catch { return null; }
  if (u.origin !== 'http://laptop' || !u.pathname.startsWith(STORE_PREFIX) || /\/\.\.?(?:\/|$)|%2e/i.test(u.pathname)) return null;
  return u.pathname + u.search;
}

/** The filename in a Content-Disposition header (filename* first, as http.js writes both). */
export function dispositionName(header) {
  const h = String(header || '');
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  return /filename="([^"]*)"/i.exec(h)?.[1] || null;
}

/**
 * The store on the team server, for a laptop in team mode. `url`: the team server; `key`: the member's key; `caFile`
 * or `ca`: IT's CA; `onAuthError(code)`: told on a 401 (as RemoteRecord, so a revoked key signs the app out).
 * Returns a store service as index.js uses one: getClient(), serviceClient(), status(), check(), plus proxy() and close().
 */
export function openRemoteStore({ url, key, caFile = null, ca = readCa(caFile), onAuthError = () => {}, responseMs = 120_000, request = httpsRequest } = {}) {
  if (!url || !key) throw storeError(400, 'bad_request', 'No team server is configured.');
  const base = url.replace(/\/+$/, '');
  const agent = new https.Agent({ keepAlive: true, ca, maxSockets: 8 });
  let last = { mode: 'team', state: 'starting', reason: null, version: null, url: null, since: new Date().toISOString() };

  async function send(path, { method = 'GET', headers = {}, body = null } = {}) {
    let r;
    try { r = await request(base + path, { method, headers: { ...headers, Authorization: `Bearer ${key}` }, body, ca, agent, responseMs }); } catch (e) { throw unreachable(e); }
    if (r.status === 401) { let code = null; try { code = JSON.parse(r.body.toString('utf8')).error?.code; } catch { /* not JSON */ } onAuthError(code); }
    return r;
  }
  async function read(op, ...args) {
    const r = await send('/api/v2/store/read', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: Buffer.from(JSON.stringify({ op, args })) });
    if (r.status >= 400) throw answerError(r);
    return JSON.parse(r.body.toString('utf8'));
  }

  /** The store interface's read operations, as the member. Writes go through the pages' routes (proxy), never here. */
  const client = {
    getDocument: id => read('getDocument', id),
    list: (filters = {}) => read('list', filters),
    search: (query, opts = {}) => read('search', query, opts),
    similar: (id, opts = {}) => read('similar', id, opts),
    findDuplicates: id => read('findDuplicates', id),
    notes: { list: id => read('notes.list', id) },
    async getOriginal(id) {
      const r = await send(`/api/v2/store/documents/${encodeURIComponent(id)}/original`, { headers: { Accept: '*/*' } });
      if (r.status >= 400) throw answerError(r);
      return { body: r.body, filename: dispositionName(r.headers['content-disposition']), mimeType: r.headers['content-type'] || 'application/octet-stream' };
    },
  };

  return {
    mode: 'team',
    getClient: () => client,
    serviceClient: () => client,
    status: () => ({ ...last }),
    /** The team store's status, as the team server reports it; unreachable is "unavailable", never an error. */
    async check() {
      try {
        const r = await send('/api/v2/store/status', { headers: { Accept: 'application/json' } });
        if (r.status >= 400) throw answerError(r);
        last = { ...JSON.parse(r.body.toString('utf8')), url: null };
      } catch (e) { last = { ...last, state: 'unavailable', reason: e.message, since: new Date().toISOString() }; }
      return { ...last };
    },
    /** Express handler: the request as the laptop received it, sent on with the member's key; the answer sent back. */
    async proxy(req, res) {
      try {
        if (req.method === 'GET' && req.path === '/status') return res.json(await this.check());
        // Only the store's own routes are forwarded: a raw path with ".." segments would be normalised by the team server
        // into another /api/v2 route carrying the member's key (security review, 17 Oct 2026).
        const forward = storePath(req.originalUrl);
        if (!forward) return res.status(404).json({ error: 'Unknown operation.', code: 'not_found' });
        const headers = {}; for (const h of PASS_REQUEST) if (req.headers[h]) headers[h] = req.headers[h];
        const body = ['GET', 'HEAD'].includes(req.method) ? null : await bodyOf(req);
        if (body && req.is('application/json')) headers['content-type'] = 'application/json';
        const r = await send(forward, { method: req.method, headers, body });
        for (const h of PASS_RESPONSE) if (r.headers[h]) res.setHeader(h, r.headers[h]);
        res.status(r.status).send(r.body);
      } catch (e) { res.status(e.status || 500).json({ error: storeErrorMessage(e), ...(e.code ? { code: e.code } : {}) }); }
    },
    close() { agent.destroy(); },
  };
}
