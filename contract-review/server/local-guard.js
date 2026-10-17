// SPDX-License-Identifier: GPL-3.0-or-later
// The local app's request guard (readiness audits, 17 Oct 2026, security finding 2 and 8). The app listens on 127.0.0.1
// only, which keeps other computers out but not other pages in the same browser: before this guard any page served from
// any localhost port (a dev server, another local tool, Paperless's own UI) could post a multipart upload or a form to
// /api, because those are "simple" requests that browsers send without a preflight. Three checks, all on headers the
// browser sets and a page cannot forge:
//   1. Host is exactly localhost, 127.0.0.1 or [::1] (with any port): a DNS-rebinding guard.
//   2. When an Origin header is present it names this very host and port. A page on another port is another origin.
//   3. On /api, Sec-Fetch-Site (every current browser sends it) is same-origin or none. A cross-site or same-site
//      request from any other page is refused before it reaches a route, whatever its content type.
// Non-browser clients (the tests, curl, the Word pane's own fetches, which are same-origin) send no Origin or
// Sec-Fetch-Site and pass; a process on this computer running as this user is trusted, as the data folder it can read
// already is. The pane and the pages are served from the same origin they call, so nothing in src/ changes.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * Whether a path reaches the API. Express routes without regard to case, so "/API/status" is answered by the /api/status
 * route; the check must see it the same way (security review, 17 Oct 2026: the Sec-Fetch-Site check was skipped for an
 * upper-case path). Repeated leading slashes are read the same way.
 */
export const isApiPath = path => /^\/+api(?:\/|$)/i.test(String(path || ''));

/** { name, port } from a Host header or a URL's host: "localhost:3000", "[::1]:3443", "127.0.0.1". */
export function parseHost(value) {
  const v = String(value || '').trim().toLowerCase();
  const m = v.startsWith('[') ? /^(\[[0-9a-f:.]+\])(?::(\d+))?$/.exec(v) : /^([^:]+)(?::(\d+))?$/.exec(v);
  return m ? { name: m[1], port: m[2] ? Number(m[2]) : null } : null;
}

/**
 * Check one request. `headers`: the request's headers (lower-case names); `path`: its path; `secure`: whether the app
 * serves HTTPS (fills in the default port when a header leaves it out). Returns null when the request may proceed,
 * else { status, error } to send.
 */
export function checkLocalRequest({ headers = {}, path = '/', secure = false } = {}) {
  const host = parseHost(headers.host);
  if (!host || !LOCAL_HOSTS.has(host.name)) return { status: 403, error: 'This prototype only serves localhost.' };
  const origin = headers.origin;
  if (origin !== undefined) {
    let o = null;
    // An IPv6 hostname comes back from URL already in brackets ("[::1]"), as parseHost gives it (security review, 17 Oct 2026).
    try { const u = new URL(String(origin)); const h = u.hostname.toLowerCase(); o = { scheme: u.protocol, name: h.includes(':') && !h.startsWith('[') ? `[${h}]` : h, port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80) }; } catch { /* "null" or malformed */ }
    const expected = host.port ?? (secure ? 443 : 80);
    if (!o || !['http:', 'https:'].includes(o.scheme) || o.name !== host.name || o.port !== expected) return { status: 403, error: 'Cross-site requests are not allowed.' };
  }
  if (isApiPath(path)) {
    const site = headers['sec-fetch-site'];
    if (site !== undefined && !['same-origin', 'none'].includes(String(site).toLowerCase())) return { status: 403, error: 'Cross-site requests are not allowed.' };
  }
  return null;
}

/** Express middleware over checkLocalRequest, plus the two response headers every answer carries. */
export function localGuard({ secure = false } = {}) {
  return (req, res, next) => {
    const refused = checkLocalRequest({ headers: req.headers, path: req.path, secure });
    if (refused) return res.status(refused.status).json({ error: refused.error });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}
