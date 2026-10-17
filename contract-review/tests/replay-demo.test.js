// SPDX-License-Identifier: GPL-3.0-or-later
// The recorded demo replays with no login (product v2, slice S4; after decision 190 without the record): the demo set's rounds
// give the single-call review the v2 `history` payload it was recorded with (6.4.3), and every
// excerpt the recording cites maps onto those items through ids.json and re-verifies. The recording is
// data/recorded-runs/demo-fixture (made by scripts/record-demo.mjs, removed with the record); the test skips when it is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayDemo } from './fixtures/record/demo-replay.js';

const REC = fileURLToPath(new URL('../data/recorded-runs/demo-fixture/', import.meta.url));
const have = existsSync(path.join(REC, 'review.raw.txt')) && existsSync(path.join(REC, 'ids.json'));
test('the demo matter replays from the record: the counter-turn against round 2, with the earlier rounds as history', { skip: !have && 'no recording present' }, async () => {
  const { demo, history, review: r } = await replayDemo('history');
  assert.equal(demo.incoming.round, 4);
  assert.deepEqual(history.map(h => h.itemId.replace(demo.matterId, 'm')), ['m/1', 'm/2/covering', 'm/3'], 'the document under review and its earlier version are left out; the covering email stays');
  assert.equal(r.model.executor, 'replay'); assert.match(r.model.replayedFrom, /review\.raw\.txt$/); assert.ok(r.findings.length > 0);
  const withHistory = r.findings.filter(f => f.history?.length); assert.ok(withHistory.length > 0, 'at least one finding carries history');
  assert.ok(withHistory.every(f => f.history.every(h => h.verified && h.itemId.startsWith(`${demo.matterId}/`))), 'every replayed excerpt maps onto a round of the record and re-verifies');
  assert.ok(r.findings.every(f => f.evidence.every(e => e.verified !== false)), 'evidence quotes verify against the document');
});

test('the first return replays too: the markup (round 2) against our first draft, the emails as history', { skip: !(have && existsSync(path.join(REC, 'review@round1.raw.txt'))) && 'no round-one recording present' }, async () => {
  const { review: r } = await replayDemo('history', { round: 2 });
  assert.match(r.model.replayedFrom, /review@round1\.raw\.txt$/);
  const cited = r.findings.flatMap(f => f.history || []);
  assert.ok(cited.length > 0 && cited.every(h => h.verified), 'the emails the recording cites are the covering email of round 2 and round 3');
});

test('playback picks the recording made for the same document and never plays one about another', async () => {
  const { pickRecording, replaySubject } = await import('../server/executors.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const path = (await import('node:path')).default;
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-pick-'));
  const doc = (texts, originals = {}) => ({ document: { paragraphs: texts.map((text, i) => ({ id: `p${i}`, text, ...(originals[i] ? { originalText: originals[i] } : {}) })) } });
  const two = doc(['Alpha', 'Term: seven years', 'Gamma'], { 1: 'Term: three years' }), three = doc(['Alpha', 'Term: five years', 'Gamma'], { 1: 'Term: seven years' });
  writeFileSync(path.join(dir, 'review.raw.txt'), '{"round":3}'); writeFileSync(path.join(dir, 'review.user.json'), JSON.stringify(three));
  assert.ok(pickRecording(dir, 'review', three).endsWith('review.raw.txt'));
  assert.throws(() => pickRecording(dir, 'review', two), e => e.code === 'NO_RECORDING' && /do not include "review" for this document/.test(e.message));
  writeFileSync(path.join(dir, 'review@round1.raw.txt'), '{"round":2}'); writeFileSync(path.join(dir, 'review@round1.user.json'), JSON.stringify(two));
  assert.ok(pickRecording(dir, 'review', two).endsWith('review@round1.raw.txt'));
  // The lawyer applies an edit: the request changes, the document it is about does not.
  const edited = doc(['Alpha', 'Term: four years', 'Gamma'], { 1: 'Term: seven years' });
  assert.equal(replaySubject(edited), replaySubject(three)); assert.ok(pickRecording(dir, 'review', edited).endsWith('review.raw.txt'));
  // Calls with no document, and recordings that kept no request, play as before.
  writeFileSync(path.join(dir, 'organise.raw.txt'), '{}'); assert.ok(pickRecording(dir, 'organise', { matter: {} }).endsWith('organise.raw.txt'));
  writeFileSync(path.join(dir, 'ask.raw.txt'), '{}'); assert.ok(pickRecording(dir, 'ask', two).endsWith('ask.raw.txt'));
  assert.throws(() => pickRecording(dir, 'baseline', two), e => e.code === 'NO_RECORDING');
});
