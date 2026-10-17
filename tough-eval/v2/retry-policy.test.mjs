// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, nextStep, attemptsFor, completion } from './retry-policy.mjs';
import { stripCanary, stripSeed, carriesCanary } from './canary.mjs';

test('error classes from the fixed pattern list (14.2)', () => {
  assert.equal(classify('Claude CLI failed (exit 1): You have hit your usage limit'), 'usage-limit');
  for (const m of ['Live provider returned HTTP 429.', 'HTTP 503', 'fetch failed', 'read ECONNRESET', 'connect ETIMEDOUT', 'Claude CLI could not start: spawn claude ENOENT', 'No recorded run for "review" in /x', 'Live provider returned HTTP 502. No offline result was substituted.', 'window closed', 'rate limit exceeded'])
    assert.equal(classify(m), 'transport', m);
  for (const m of ['Model returned an invalid review structure: no findings array.', 'The model did not return a JSON object.', 'Unexpected token } in JSON', 'something else']) assert.equal(classify(m), 'malformed', m);
});
test('the Antigravity CLI (agy, the Gemini lane): usage limits, its failures and timeouts, and an unusable answer', () => {
  assert.equal(classify('Antigravity CLI usage limit: RESOURCE_EXHAUSTED: You have exhausted your capacity on this model.'), 'usage-limit');
  for (const m of ['Antigravity CLI failed (exit 1, status ERROR): stream closed', 'Antigravity CLI failed (timed out after 1800 s): ', 'Antigravity CLI could not start: spawnSync agy ENOENT']) assert.equal(classify(m), 'transport', m);
  assert.equal(classify('The model did not return a JSON object.'), 'malformed');
  assert.equal(classify('Antigravity CLI answer cut off at the output token limit: Your previous response was cut off'), 'malformed');
  // No other executor's message changes class: the new patterns name the Antigravity CLI only.
  for (const m of ['Muse CLI failed (exit 1): x', 'Codex CLI failed (exit 1): x']) assert.equal(classify(m), 'malformed', m);
});
test('the queue: malformed retried at once up to three attempts; provider failures wait until the window closes', () => {
  assert.equal(nextStep({ ok: true }, 1), 'done');
  assert.equal(nextStep({ ok: false, error: 'not JSON' }, 1), 'retry-now');
  assert.equal(nextStep({ ok: false, error: 'not JSON' }, 3), 'done');
  assert.equal(nextStep({ ok: false, error: 'HTTP 503' }, 0), 'retry-later');
  assert.equal(nextStep({ ok: false, error: 'HTTP 503' }, 0, { windowClosed: true }), 'done');
});
test('attempts count usable and malformed results, not provider failures', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'attempts-')); mkdirSync(path.join(d, 'results')); mkdirSync(path.join(d, 'results-failed'));
  writeFileSync(path.join(d, 'results', 'X1.json'), JSON.stringify({ ok: true }));
  writeFileSync(path.join(d, 'results-failed', 'X1-1.json'), JSON.stringify({ ok: false, error: 'HTTP 429' }));
  writeFileSync(path.join(d, 'results-failed', 'X1-2.json'), JSON.stringify({ ok: false, error: 'not JSON' }));
  writeFileSync(path.join(d, 'results-failed', 'X10-3.json'), JSON.stringify({ ok: false, error: 'not JSON' })); // another variant
  assert.equal(attemptsFor(d, 'X1'), 2); rmSync(d, { recursive: true, force: true });
});
test('the not-completed rule is above 10%', () => {
  const docs = n => Array.from({ length: 20 }, (_, i) => ({ errorClass: i < n ? 'transport' : null }));
  assert.equal(completion(docs(2)).notCompleted, false); assert.equal(completion(docs(3)).notCompleted, true);
});
test('the canary never reaches a model', () => {
  const doc = { canary: 'g', id: 'x', paragraphs: [{ id: 'p1', text: 't' }] };
  assert.deepEqual(stripCanary(doc), { id: 'x', paragraphs: [{ id: 'p1', text: 't' }] });
  const seed = stripSeed({ format: 'f', canary: 'g', matters: [{ id: 'm', rounds: [{ n: 1, document: { canary: 'g', paragraphs: [] } }] }] });
  assert.equal(carriesCanary(JSON.stringify(seed)), false); assert.equal(carriesCanary(JSON.stringify(doc)), true);
});
