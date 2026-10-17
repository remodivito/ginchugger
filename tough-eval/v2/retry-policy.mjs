// SPDX-License-Identifier: GPL-3.0-or-later
// The retry policy of BENCHMARK-V2.md P16 and section 14.2, by code and not by hand.
//   transport / usage-limit  a provider or transport error (no response, rate limit, dropped connection, server error, a
//                            CLI exit caused by a usage limit). Retried every 15 minutes until a response arrives or the
//                            test window closes; never counts as an attempt.
//   malformed                an unusable response (parse error, the validator's "invalid review structure", anything
//                            else). Counts as an attempt; retried at once, at most three attempts, then the review fails.
// `attempts` for a variant is computed from its result files across results/ and results-failed/: every usable result
// and every malformed one counts, transport failures do not (section 14.2). The reporting rule: a setup with more than
// 10% of a layer's items ending the window in transport or usage-limit failure is reported "not completed" for that layer.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const MAX_ATTEMPTS = 3;
export const TRANSPORT_WAIT_MS = 15 * 60 * 1000;
export const NOT_COMPLETED_SHARE = 0.10;
export const WINDOW_CLOSED = 'window closed';
// The fixed pattern list (section 14.2), plus "HTTP 5xx" and "window closed" from P16, plus the Antigravity CLI's own
// failure messages (16 Oct, the Gemini lane; they match no other executor's errors, so no other class changes). The agy
// executor itself names a quota, rate-limit or capacity refusal "Antigravity CLI usage limit" (executors.js).
export const USAGE_LIMIT_PATTERNS = [/usage limit/i];
export const TRANSPORT_PATTERNS = [/rate limit/i, /\b429\b/, /\b503\b/, /fetch failed/i, /ECONNRESET/, /ETIMEDOUT/, /aborted due to timeout/i, /TimeoutError/, /operation was aborted/i, /Claude CLI failed/, /Claude CLI could not start/, /Antigravity CLI failed/, /Antigravity CLI could not start/, /No recorded run/, /HTTP 5\d\d\b/, new RegExp(WINDOW_CLOSED)];

/** errorClass of a failed review's error message: 'usage-limit', 'transport' or 'malformed'. */
export function classify(message) {
  const m = String(message ?? '');
  if (USAGE_LIMIT_PATTERNS.some(rx => rx.test(m))) return 'usage-limit';
  if (TRANSPORT_PATTERNS.some(rx => rx.test(m))) return 'transport';
  return 'malformed';
}
/** The class of a result file's content: null for a usable review. Old results without errorClass are classified now. */
export const classOf = r => (r && r.ok ? null : r?.errorClass || classify(r?.error));
export const isProviderFailure = cls => cls === 'transport' || cls === 'usage-limit';

/** Every result file a run holds for one variant: the current one (results/) and the ones set aside (results-failed/). */
export function resultFiles(runDir, id) {
  const out = []; const cur = path.join(runDir, 'results', `${id}.json`); if (existsSync(cur)) out.push(cur);
  const failedDir = path.join(runDir, 'results-failed');
  if (existsSync(failedDir)) { const rx = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.json$`); for (const f of readdirSync(failedDir).sort()) if (rx.test(f)) out.push(path.join(failedDir, f)); }
  return out;
}
/** Attempts per section 14.2: usable or malformed results count, transport and usage-limit failures do not. */
export function attemptsFor(runDir, id) {
  let n = 0;
  for (const f of resultFiles(runDir, id)) { let r; try { r = JSON.parse(readFileSync(f, 'utf8')); } catch { n++; continue; } if (!isProviderFailure(classOf(r))) n++; }
  return n;
}
/**
 * What the queue does next with a result: 'done' (usable, or failed after the last attempt), 'retry-now' (malformed,
 * attempts left) or 'retry-later' (provider failure: wait TRANSPORT_WAIT_MS unless the window has closed, then 'done').
 */
export function nextStep(result, attemptsSoFar, { windowClosed = false } = {}) {
  const cls = classOf(result);
  if (!cls) return 'done';
  if (isProviderFailure(cls)) return windowClosed ? 'done' : 'retry-later';
  return attemptsSoFar < MAX_ATTEMPTS ? 'retry-now' : 'done';
}
/** The "not completed" rule: share of items ending in a provider failure, and whether it exceeds 10%. */
export function completion(docs) {
  const provider = docs.filter(d => isProviderFailure(d.errorClass)).length;
  const share = docs.length ? provider / docs.length : 0;
  return { providerFailures: provider, items: docs.length, share: +share.toFixed(4), notCompleted: share > NOT_COMPLETED_SHARE };
}
