// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appliedState } from '../src/word.js';

test('a pane session is kept per document under a hash of its address, replaced on save and forgotten on clear', async () => {
  process.env.PANE_SESSION_ROOT = mkdtempSync(path.join(tmpdir(), 'pane-session-'));
  const { getSession, saveSession, clearSession } = await import('../server/pane-session.js');
  const key = 'https://contoso.sharepoint.com/sites/Legal/Helix NDA v3.docx';
  assert.equal(await getSession(key), null);
  await saveSession(key, { review: { findings: [1] }, doc: { id: 'd1' }, outcomes: {} });
  await saveSession(key, { review: { findings: [1, 2] }, doc: { id: 'd1' }, outcomes: { f1: { kind: 'applied' } } });
  const got = await getSession(key);
  assert.deepEqual(got.state.review.findings, [1, 2]); assert.ok(got.savedAt);
  const files = readdirSync(process.env.PANE_SESSION_ROOT);
  assert.equal(files.length, 1); assert.match(files[0], /^[0-9a-f]{64}\.json$/);
  assert.ok(!readFileSync(path.join(process.env.PANE_SESSION_ROOT, files[0]), 'utf8').includes('sharepoint'), 'the address is not stored');
  assert.equal(await getSession('https://elsewhere/other.docx'), null, 'another document has its own session');
  await assert.rejects(saveSession(key, { doc: {} }), /holds a review/);
  await assert.rejects(saveSession('', { review: {}, doc: {} }), /key is required/);
  await clearSession(key); assert.equal(await getSession(key), null);
});

test('before any review a session may hold the document\'s Ask history alone (Ask C); an empty one is refused', async () => {
  process.env.PANE_SESSION_ROOT = mkdtempSync(path.join(tmpdir(), 'pane-session-'));
  const { getSession, saveSession } = await import('../server/pane-session.js');
  const key = 'https://contoso.sharepoint.com/sites/Legal/Northgate order form.docx';
  await saveSession(key, { asks: [{ id: 'q1', question: 'What changed?', answer: { answer: 'Clause 4.' } }] });
  assert.equal((await getSession(key)).state.asks[0].answer.answer, 'Clause 4.');
  await assert.rejects(saveSession(key, { asks: [] }), /holds a review/);
});

test('after a reload an applied change counts as gone when its bookmark is missing or empty, present when it still holds text', async () => {
  const context = { sync: async () => {} };
  const doc = ranges => ({ getBookmarkRangeOrNullObject: name => ({ load() {}, ...(name in ranges ? { isNullObject: false, text: ranges[name] } : { isNullObject: true }) }) });
  assert.equal(await appliedState({ context, document: doc({ _m_a: 'five (5) years' }) }, '_m_a'), 'present');
  assert.equal(await appliedState({ context, document: doc({ _m_a: '' }) }, '_m_a'), 'gone');
  assert.equal(await appliedState({ context, document: doc({}) }, '_m_a'), 'gone');
  assert.equal(await appliedState({ context, document: doc({}) }, null), 'unknown');
});
