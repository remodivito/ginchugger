// SPDX-License-Identifier: GPL-3.0-or-later
// The pane's saved review is brought back only for the document it reviewed (stress audit, 17 Oct 2026: a different
// document saved at the same place, so with the same Word URL, opened with the earlier document's review and store
// document). src/review/session-match.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionIsFor, textOverlap } from '../src/review/session-match.js';

const doc = texts => ({ paragraphs: texts.map((text, i) => ({ id: `p${i + 1}`, text })) });
const nda = ['Mutual NDA', '1. Term: five years.', '2. Law: England.', '3. Notices by email.', '4. No assignment.'];
const state = { doc: doc(nda), storeDoc: { id: 7 }, saved: null, review: { findings: [] } };

test('the store decides: the session\'s document (or the reply saved from it) yes, another document no', () => {
  assert.equal(sessionIsFor(state, nda, { id: 7 }), true);
  assert.equal(sessionIsFor(state, nda, { id: 9 }), false, 'the same words but the store holds this file as another document');
  assert.equal(sessionIsFor({ ...state, saved: { id: 9 } }, nda, { id: 9 }), true, 'our saved reply holds the reviewed document as it now is');
});

test('without a store answer the words decide: our own applied change keeps the session, a different agreement does not', () => {
  const applied = [...nda]; applied[1] = '1. Term: three years.';
  const withApplied = { ...state, doc: { paragraphs: state.doc.paragraphs.map((p, i) => (i === 1 ? { ...p, text: applied[1], originalText: nda[1] } : p)) } };
  assert.equal(sessionIsFor(withApplied, applied, null), true);
  assert.equal(sessionIsFor(withApplied, nda, undefined), true, 'the change rejected in Word: the original text is known');
  assert.equal(sessionIsFor(state, ['Order form', 'Fees: 10,000', 'Term: 12 months', 'Users: 25'], null), false);
  assert.equal(sessionIsFor({ ...state, storeDoc: null }, nda, { id: 3 }), true, 'a session saved while the store was down, now found: same words');
  assert.equal(sessionIsFor({ review: {} }, nda, null), false);
});

test('textOverlap counts non-empty current paragraphs found in the saved document, whitespace aside', () => {
  assert.equal(textOverlap(doc(nda), [' Mutual  NDA ', '', 'other']), 0.5);
  assert.equal(textOverlap(doc([]), []), 1);
});
