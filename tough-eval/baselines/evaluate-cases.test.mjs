// SPDX-License-Identifier: GPL-3.0-or-later
// The v1 rule engine on the ten labelled examples (moved from contract-review/tests/evaluation.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures, reviewInput, assessReview } from './evaluate-cases.mjs';
import { reviewLocal as reviewDocument } from './local-rules.mjs';

const { cases, playbook } = await loadFixtures();

for (const testCase of cases) {
  test(`review fixture: ${testCase.id}`, async () => {
    const review = await reviewDocument(reviewInput(testCase, playbook));
    const result = assessReview(testCase, review);
    assert.deepEqual(result.errors, [], result.errors.join('\n'));
  });
}

test('reference labels never enter review input', () => {
  const input = reviewInput(cases[0], playbook);
  assert.deepEqual(Object.keys(input).sort(), ['baseline', 'document', 'playbook']);
  assert.equal(input.expected, undefined);
});

test('no baseline means no invented change attribution', async () => {
  const testCase = cases.find(c => c.id === 'nda-no-baseline');
  const review = await reviewDocument(reviewInput(testCase, playbook));
  const finding = review.findings.find(f => f.paragraphId === 'nda-term' && f.status === 'attention');
  assert.ok(finding, 'Current duration should remain assessable');
  const narrative = [finding.title, finding.summary, finding.explanation, finding.rationale].filter(Boolean).join(' ');
  assert.doesNotMatch(narrative, /(?:increased|extended|changed)\s+from\s+(?:3|three)/i);
  assert.equal(finding.change, 'unknown', 'No baseline should not invent a change state');
});

test('source fixture retains all eleven standard-term sections', () => {
  const base = cases.find(c => c.id === 'nda-clean').document;
  assert.equal(base.source.completeStandardTerms, true);
  assert.equal(base.paragraphs.filter(p => /^\d+\./.test(p.heading || '')).length, 11);
  assert.ok(base.paragraphs.some(p => p.id === 'nda-general' && p.text.includes('entire agreement')));
});

test('evaluator rejects a fabricated quote even with a correct paragraph ID', () => {
  const testCase = cases.find(c => c.id === 'nda-duration');
  const result = assessReview(testCase, { findings: [{ paragraphId: 'nda-term', status: 'attention', evidence: [{ paragraphId: 'nda-term', quote: 'Approved by our legal department.' }] }] });
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(e => e.includes('Ungrounded citation')));
});
