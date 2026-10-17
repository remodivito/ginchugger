// SPDX-License-Identifier: GPL-3.0-or-later
// The pane's review events (product v2 spec 5.2, 7.4 step 6, PR-REC-07): the batch after a review and one event per
// decision, cut to the route's lengths, and accepted whole by the document's review history (server/store/review-history.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewBatch, decisionEvent, clauseTypeFor, QUOTE_MAX, TEXT_MAX } from '../src/review/record-events.js';
import { openReviewHistory } from '../server/store/review-history.js';

const clauseTypes = JSON.parse(readFileSync(new URL('../data/clause-types.json', import.meta.url), 'utf8'));
const ndaRule = Object.keys(clauseTypes.mappings.nda)[0];
const review = {
  id: 'rev-1', playbook: { id: 'nda', title: 'NDAs' }, playbookVersion: 3, unverifiedRecordCitations: 1,
  model: { executor: 'replay', model: 'm', effort: 'high', promptSha256: 'abc', agentic: false, toolCalls: 0, reviewMode: 'own-paper' },
  findings: [
    { id: 'f1', status: 'attention', ruleIds: [ndaRule], paragraphId: 'p5', title: 'Term', decision: 'counter', evidence: [{ paragraphId: 'p5', quote: 'q'.repeat(3000) }], proposedText: 'w'.repeat(9000),
      record: [{ documentId: 12, quote: 'earlier', counterparty: 'same', verified: false, note: 'x', reason: 'r' }] },
    { id: 'f2', status: 'attention', ruleIds: [], paragraphId: 'p6', title: 'Not covered', evidence: [] },
    { id: 'f3', status: 'within-guidance', ruleIds: [ndaRule], paragraphId: 'p7', title: 'Fine', evidence: [] },
  ],
};

test('one batch per review: review_run, then finding_flagged for each attention finding with a rule, cut to the limits', () => {
  const batch = reviewBatch(review, { round: 4, reviewMode: 'own-paper', clauseTypes });
  assert.deepEqual(batch.map(e => e.type), ['review_run', 'finding_flagged']);
  assert.deepEqual(batch[0].payload, { reviewId: 'rev-1', round: 4, playbookId: 'nda', playbookChange: 3, promptSha256: 'abc', executor: 'replay', model: 'm', effort: 'high', agentic: false, toolCalls: 0, findings: 3, attention: 2, unverifiedRecordCitations: 1, reviewMode: 'own-paper' });
  const f = batch[1].payload;
  assert.equal(f.clauseType, clauseTypes.mappings.nda[ndaRule]);
  assert.equal(f.quote.length, QUOTE_MAX); assert.equal(f.proposedText.length, TEXT_MAX);
  assert.deepEqual(f.record, [{ documentId: 12, quote: 'earlier', counterparty: 'same', verified: false }], 'a store citation names its document (decision 190)');
  assert.equal(reviewBatch(review).at(0).payload.round, null, 'a document that is not yet a round');
  assert.equal(clauseTypeFor(clauseTypes, 'nda', 'NO-SUCH-RULE'), null);
});

test('decisions: dismiss (note kept, or marked absent), undismiss, revise, apply (cut), reject in Word, export; others write nothing', () => {
  const f = review.findings[0];
  assert.deepEqual(decisionEvent('dismissed', { review, finding: f, clauseTypes, note: ' Agreed on the call. ' }).payload, { reviewId: 'rev-1', findingId: 'f1', ruleId: ndaRule, clauseType: clauseTypes.mappings.nda[ndaRule], note: 'Agreed on the call.' });
  assert.equal(decisionEvent('dismissed', { review, finding: f, note: '' }).payload.note, '(no note)');
  // "Accept their wording" carries the point's title and their quote (cut), for the concession note on the document.
  const acc = decisionEvent('dismissed', { review, finding: f, note: '', reason: 'accepted' }).payload;
  assert.deepEqual([acc.note, acc.reason, acc.title, acc.quote.length], ['Accepted their wording', 'accepted', 'Term', QUOTE_MAX]);
  const nai = decisionEvent('dismissed', { review, finding: f, note: '', reason: 'not-an-issue' }).payload;
  assert.deepEqual([nai.note, nai.title, nai.quote], ['Not an issue', undefined, undefined]);
  assert.deepEqual(decisionEvent('undismissed', { review, finding: f }), { type: 'finding_undismissed', payload: { reviewId: 'rev-1', findingId: 'f1' } });
  const applied = decisionEvent('applied', { review, finding: f, clauseTypes, before: 'b'.repeat(9000), after: 'a', bookmark: '_m_1' });
  assert.equal(applied.type, 'edit_applied'); assert.equal(applied.payload.before.length, TEXT_MAX); assert.equal(applied.payload.overRevisions, false);
  assert.equal(decisionEvent('revised', { review, finding: f, instruction: 'shorter' }).type, 'finding_revised');
  assert.deepEqual(decisionEvent('rejected', { review, finding: f, bookmark: '_m_1' }).payload, { reviewId: 'rev-1', findingId: 'f1', bookmark: '_m_1' });
  assert.deepEqual(decisionEvent('exported', { review, sha256: 'd'.repeat(64), signed: false }).payload, { reviewId: 'rev-1', sha256: 'd'.repeat(64), signed: false });
  for (const kind of ['reviewed', 'chosen', 'undone']) assert.equal(decisionEvent(kind, { review, finding: f }), null);
  assert.equal(decisionEvent('dismissed', { review: null, finding: f }), null);
});

test('a recorded pane session lands in the document\'s review history whole', async () => {
  const history = openReviewHistory();
  const f = review.findings[0];
  const session = [...reviewBatch(review, { round: null, clauseTypes }), decisionEvent('applied', { review, finding: f, clauseTypes, before: 'old', after: 'new', bookmark: '_m_1' }),
    decisionEvent('rejected', { review, finding: f, bookmark: '_m_1' }), decisionEvent('dismissed', { review, finding: f, clauseTypes, note: '' }), decisionEvent('undismissed', { review, finding: f }),
    decisionEvent('exported', { review, sha256: 'e'.repeat(64) })];
  const written = history.append(12, session, 'lawyer');
  assert.deepEqual(written.map(e => e.type), ['review_run', 'finding_flagged', 'edit_applied', 'edit_rejected_in_word', 'finding_dismissed', 'finding_undismissed', 'document_exported']);
  assert.ok(history.list(12).every(e => e.documentId === 12 && e.actor === 'lawyer'));
  assert.equal(history.list(12)[1].payload.clauseType, clauseTypes.mappings.nda[ndaRule]);
  history.close();
});
