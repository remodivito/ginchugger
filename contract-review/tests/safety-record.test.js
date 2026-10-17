// SPDX-License-Identifier: GPL-3.0-or-later
// The safety batch of 16 October 2026 (design deviation audit) after decision 190: why a point was dismissed (finding 1:
// only "accept their wording" is a concession), checked by the document's review history; and text the counterparty
// reads (finding 9): the export's tracked-change author is the lawyer, never the tool. Signed and held documents out of
// the trash, and the hold for admins only, are the store's rules now (tests/store-*.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { DISMISS_REASONS } from '../server/record/events.js';
import { checkReviewEvent } from '../server/store/review-history.js';
import { decisionEvent, DISMISS_NOTE } from '../src/review/record-events.js';
import { exportDocx, DEFAULT_AUTHOR } from '../server/docx.js';

// ---- finding 1: dismiss reasons ------------------------------------------------------------------------------------

test('dismiss reasons: the pane\'s event says why; the review history refuses an unknown reason and keeps old events valid', () => {
  assert.deepEqual(DISMISS_REASONS, ['not-an-issue', 'accepted']);
  const review = { id: 'r1', playbook: { id: 'nda' } }, finding = { id: 'f1', ruleIds: ['DUR-01'], paragraphId: 'p2' };
  assert.deepEqual(decisionEvent('dismissed', { review, finding, reason: 'not-an-issue' }).payload, { reviewId: 'r1', findingId: 'f1', ruleId: 'DUR-01', clauseType: null, note: DISMISS_NOTE['not-an-issue'], reason: 'not-an-issue' });
  assert.deepEqual(decisionEvent('dismissed', { review, finding, reason: 'accepted' }).payload.note, 'Accepted their wording');
  assert.equal(decisionEvent('dismissed', { review, finding }).payload.reason, undefined); // an old caller: no reason, as before
  assert.throws(() => checkReviewEvent({ type: 'finding_dismissed', payload: { reviewId: 'r', findingId: 'f', note: 'x', reason: 'bored' } }), /reason is one of/);
  assert.doesNotThrow(() => checkReviewEvent({ type: 'finding_dismissed', payload: { reviewId: 'r', findingId: 'f', note: '(no note)' } }));
});

// ---- finding 9: the export's author ------------------------------------------------------------------------------

test('the exported tracked changes are authored by the lawyer, never "Review prototype"', async () => {
  const doc = { id: 'd1', title: 'NDA', revision: 1, paragraphs: [{ id: 'p1', text: 'Term: five years.', originalText: 'Term: three years.' }] };
  const xml = async buf => (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  const named = await xml(await exportDocx(doc, null, { author: 'Sam <Lawyer> & Co' }));
  assert.match(named, /w:author="Sam &lt;Lawyer&gt; &amp; Co"/);
  const unnamed = await xml(await exportDocx(doc, null));
  assert.match(unnamed, new RegExp(`w:author="${DEFAULT_AUTHOR}"`));
  for (const x of [named, unnamed]) assert.doesNotMatch(x, /Review prototype/);
});
