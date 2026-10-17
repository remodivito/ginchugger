// SPDX-License-Identifier: GPL-3.0-or-later
// The pane's side of the safety batch (16 October 2026), as pure functions: the coverage line and "Not verified" tag
// (audit finding 3). The filing line and the record Inbox's list line went with filing (decision 190).
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageOf, notVerified } from '../src/review/model.js';

const HEADERS = 'Headers, footers, footnotes and endnotes are preserved but not reviewed.';
const BOXES = 'Unsupported txbxContent content exists; review coverage is incomplete and affected paragraphs cannot be edited.';

test('coverage: nothing to say when every rule was reported on, every part read and every quote verified', () => {
  const review = { coverage: [{ ruleId: 'A', status: 'examined' }], findings: [{ id: 'f', evidence: [{ verified: true }] }], limits: [] };
  assert.equal(coverageOf(review, { doc: { warnings: [] } }), null);
  assert.equal(coverageOf(null), null);
});

test('coverage: rules not reported on, parts not read and unverified points, in one line and a list', () => {
  const review = {
    coverage: [{ ruleId: 'CONF-01', status: 'examined' }, { ruleId: 'DUR-01', status: 'not-assessed' }, { ruleId: 'LAW-01', status: 'not-assessed' }],
    findings: [{ id: 'f1', evidence: [{ verified: false }] }, { id: 'f2', evidence: [{ verified: true }], record: [{ verified: false }] }, { id: 'f3', evidence: [{ verified: true }] }],
    limits: [BOXES],
  };
  const c = coverageOf(review, { doc: { warnings: [HEADERS] }, rules: [{ id: 'DUR-01', title: 'Duration' }] });
  assert.equal(c.line, '1 of 3 rules checked · headers and notes, text boxes not read · 2 not verified');
  assert.deepEqual(c.rules, [{ id: 'DUR-01', title: 'Duration' }, { id: 'LAW-01', title: 'LAW-01' }]);
  assert.deepEqual(c.parts, ['headers and notes', 'text boxes']);
  assert.deepEqual(c.unverified, ['f1', 'f2']);
  assert.equal(coverageOf({ coverage: [], findings: [], limits: [] }, { doc: { warnings: [HEADERS] } }).line, 'headers and notes not read');
});

test('notVerified: a failed quote or a failed record citation tags the point; a missing flag does not', () => {
  assert.equal(notVerified({ evidence: [{ verified: false }] }), true);
  assert.equal(notVerified({ evidence: [{ verified: true }], record: [{ verified: false }] }), true);
  assert.equal(notVerified({ evidence: [{ quote: 'x' }] }), false);
  assert.equal(notVerified(null), false);
});
