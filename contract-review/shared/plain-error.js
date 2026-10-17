// SPDX-License-Identifier: GPL-3.0-or-later
// One guard for every message a lawyer reads (stress audit, 17 Oct 2026): the server's error handlers and the pane's and
// pages' request helper pass each message through `plainMessage`, so internals (parser output, CLI output, HTTP codes,
// stack traces, file paths, the store's raw replies, bare API error codes) are never shown; the internal message goes to
// the log only. Messages the app writes for people pass unchanged. Used by the server and the browser alike.

/** What marks a message as internal rather than written for a lawyer. */
export const INTERNAL = [
  /[{[]\s*"[\w $-]+"\s*:/, // a JSON object or array
  /\bat [\w$.<>]+ \(?[^)\s]*:\d+:\d+\)?/, // a stack frame
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|AbortError|DOMException|OfficeExtension|RichApi)\b/,
  /\bError:/, /\bundefined\b/, /\bNaN\b/, /\[object \w+\]/, /Cannot read propert/i,
  /\bin JSON\b|JSON at position|Unexpected (token|end of)|not valid JSON|JSON (object|input)|JSON\.parse/i,
  /\bCLI\b/, /\bspawn\b/, /\b(ENOENT|EACCES|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EADDRINUSE|EHOSTUNREACH|ENOTFOUND|CERT_\w+|ERR_\w+)\b/,
  /\b(stderr|stdout|exit \d+|SIGTERM|SIGKILL)\b/, /fetch failed|Failed to fetch|NetworkError|socket hang up/i,
  /\bHTTP\s*\d{3}\b|\(\d{3}[:)]|\bstatus (code )?\d{3}\b/i, /\/api\/[\w/-]+/,
  /(?:\/Users\/|\/usr\/|\/tmp\/|\/private\/|\/var\/|node_modules|\.m?js:\d+|[A-Z]:\\)/,
  /^[A-Z][a-z]+(?:[A-Z][a-z0-9]+){2,}$/, /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+){2,}\b/, // SearchStringInvalidOrTooLong, ItemNotFound
  /^[a-z]+(_[a-z]+)+$/, // a bare error code such as store_unavailable
];
/** True when a message shows internals rather than words written for people. */
export const looksInternal = message => INTERNAL.some(re => re.test(String(message ?? '')));
export const GENERAL_ERROR = 'That did not work. Try again.';
/** The message itself when it is written for people; otherwise `fallback`. */
export function plainMessage(message, fallback = GENERAL_ERROR) {
  const m = String(message ?? '').trim();
  return !m || looksInternal(m) ? fallback : m;
}
