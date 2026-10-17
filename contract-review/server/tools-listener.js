// SPDX-License-Identifier: GPL-3.0-or-later
// Review tokens and the tools listener (product v2 spec 6.4.2 steps 1 and 4; plan task 10). A review token is minted
// in-process for one agentic review or Ask: 256 random bits scoped to the document under review, its counterparty and
// the acting lawyer, kept in memory, valid 30 minutes, revoked when the call ends. The tools listener is a second,
// plain-HTTP server bound to 127.0.0.1 on an ephemeral port that the Claude CLI's MCP child calls (the main listener is
// HTTPS with the self-signed localhost certificate, which the child's fetch would refuse). It serves only
// GET /api/v2/tools/<tool>, only from loopback, only with a live review token, and answers through the store tool router
// (server/store/tools.js) over the store as the token's lawyer. Nothing else reads it.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { makeToolRouter, toolForRoute, argsFromQuery, NOTICE } from './store/tools.js';

export const TOKEN_TTL_MS = 30 * 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const digest = s => createHash('sha256').update(String(s)).digest();

/** In-memory review tokens. `mint(scope)` returns the token; `check(token)` returns its entry or null. */
export function createTokenStore({ now = () => Date.now(), ttlMs = TOKEN_TTL_MS } = {}) {
  const live = new Map(); // sha256(token) hex -> { scope, expiresAt, calls, maxCalls }
  const key = t => digest(t).toString('hex');
  return {
    mint({ documentId = null, counterparty = null, actor = null } = {}, { maxCalls = null, onCall = null } = {}) {
      const token = randomBytes(32).toString('base64url');
      for (const [k, v] of live) if (v.expiresAt <= now()) live.delete(k);
      // onCall: told of each lookup as it starts and ends (Ask's live progress); in memory only, like the token.
      live.set(key(token), { scope: { documentId, counterparty, actor }, expiresAt: now() + ttlMs, calls: 0, maxCalls, onCall: typeof onCall === 'function' ? onCall : null });
      return token;
    },
    check(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      const k = key(token); const entry = live.get(k);
      if (!entry) return null;
      // Constant-time comparison of the digests (the map lookup already matched; this keeps the check explicit).
      if (!timingSafeEqual(Buffer.from(k, 'hex'), digest(token))) return null;
      if (entry.expiresAt <= now()) { live.delete(k); return null; }
      return entry;
    },
    revoke(token) { if (typeof token === 'string') live.delete(key(token)); },
    get size() { return live.size; },
  };
}

const send = (res, status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(text); };
const refuse = (res, status, code, message) => send(res, status, { error: { code, message } });

/**
 * The request handler, separate from the socket so the loopback and token checks can be tested with any address.
 * `getStore(scope)` returns the store to read, as the token's lawyer (`scope.actor`); `port()` the listener's port, for
 * the Host check (a DNS-rebinding guard).
 */
export function toolsHandler({ getStore, tokens, port = () => null }) {
  return async (req, res) => {
    try {
      if (!LOOPBACK.has(req.socket?.remoteAddress)) return refuse(res, 403, 'forbidden', 'The tools listener serves this computer only.');
      const p = port(); const host = String(req.headers.host || '');
      if (p && host !== `127.0.0.1:${p}` && host !== `localhost:${p}`) return refuse(res, 403, 'forbidden', 'Unexpected Host.');
      const url = new URL(req.url, 'http://127.0.0.1');
      const m = /^\/api\/v2\/tools\/([a-z-]+)$/.exec(url.pathname); const name = m && toolForRoute(m[1]);
      if (!name) return refuse(res, 404, 'not_found', 'Unknown operation.');
      if (req.method !== 'GET') return refuse(res, 405, 'bad_request', 'Tools are read with GET.');
      const auth = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''));
      const entry = auth && tokens.check(auth[1]);
      if (!entry) return refuse(res, 401, 'unauthorized', 'A live review token is required.');
      const query = {}; for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
      // The CLI can ask for several tools in one turn, so --max-turns alone does not bound the count; the token does.
      if (entry.maxCalls != null && entry.calls >= entry.maxCalls) return send(res, 200, { notice: NOTICE, error: { code: 'tool_limit', message: `This review may make at most ${entry.maxCalls} store lookups; answer from what has been read.` } });
      entry.calls++;
      let store;
      try { store = getStore(entry.scope); } catch { return send(res, 200, { notice: NOTICE, error: { code: 'store_unavailable', message: 'The document store could not be read.' } }); }
      const args = argsFromQuery(name, query);
      const tell = event => { try { entry.onCall?.(event); } catch { /* progress only */ } };
      tell({ phase: 'start', name, args });
      const result = await makeToolRouter(store, entry.scope).call(name, args);
      tell({ phase: 'done', name, args, result });
      return send(res, 200, result);
    } catch (e) {
      return refuse(res, 500, 'error', 'The lookup failed.');
    }
  };
}

/** Start the tools listener on 127.0.0.1 at an ephemeral port. Returns { url, port, mint, revoke, tokens, close }. */
export async function startToolsListener({ getStore, tokens = createTokenStore(), host = '127.0.0.1' } = {}) {
  let port = null;
  const server = createServer(toolsHandler({ getStore, tokens, port: () => port }));
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/api/v2/tools`, port, tokens,
    mint: (scope, opts) => tokens.mint(scope, opts),
    revoke: token => tokens.revoke(token),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
