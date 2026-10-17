// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildRecord, verifyRecord, canonical } from '../server/record.js';

const input = () => ({
  document: { id: 'd1', title: 'Helix NDA', paragraphs: [{ id: 'p1', text: 'The term is five years.', originalText: 'The term is seven years.' }, { id: 'p2', text: 'Governing law: England.' }] },
  baseline: { id: 'b1', title: 'v2', paragraphs: [{ id: 'p1', text: 'The term is seven years.' }] },
  review: { findings: [{ id: 'f1', paragraphId: 'p1', title: 'Term' }], playbook: { id: 'nda', title: 'NDAs' }, playbookVersion: 3, playbookSnapshot: { id: 'nda', version: 3, rules: [{ id: 'term' }] } },
  outcomes: { f1: { kind: 'applied', text: 'The term is five years.' } }, events: [{ type: 'edit_applied', findingId: 'f1' }], stale: false,
});
const key = randomBytes(32).toString('hex');
const roundTrip = r => JSON.parse(JSON.stringify(r));

test('canonical JSON ignores key order and undefined fields', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: undefined }] }), canonical({ a: [{ d: 2 }], b: 1 }));
});

test('a signed record verifies after a round trip through a file; the public key it names is the server’s', () => {
  const r = roundTrip(buildRecord(input(), { env: { REVIEW_RECORD_SIGNING_KEY: key } }));
  assert.equal(r.format, 'margin-review-record/1'); assert.equal(r.manifest.signature.algorithm, 'Ed25519');
  assert.equal(r.playbook.snapshot.rules[0].id, 'term'); assert.equal('playbookSnapshot' in r.review, false, 'the playbook is its own part');
  const v = verifyRecord(r, r.manifest.signature.publicKey);
  assert.equal(v.ok, true); assert.equal(v.signature, 'valid'); assert.equal(v.trusted, true);
  assert.deepEqual(Object.values(v.parts), [true, true, true, true, true]);
});

test('editing any decision, finding or document text after export is detected, and named', () => {
  const r = roundTrip(buildRecord(input(), { env: { REVIEW_RECORD_SIGNING_KEY: key } }));
  const pub = r.manifest.signature.publicKey;
  const edits = [rec => { rec.decisions.outcomes.f1.kind = 'dismissed'; }, rec => { rec.review.findings[0].title = 'Nothing to see'; }, rec => { rec.document.paragraphs[1].text = 'Governing law: Delaware.'; }, rec => { rec.playbook.version = 4; }];
  for (const [i, edit] of edits.entries()) {
    const copy = structuredClone(r); edit(copy);
    const v = verifyRecord(copy, pub);
    assert.equal(v.ok, false, `edit ${i}`); assert.equal(Object.values(v.parts).filter(x => !x).length, 1, `edit ${i} names one part`);
  }
  // Rewriting the hashes to match the edit breaks the digest; recomputing the digest too breaks the signature.
  const forged = structuredClone(r); forged.decisions.outcomes.f1.kind = 'dismissed';
  const fresh = roundTrip(buildRecord({ ...input(), outcomes: { f1: { kind: 'dismissed', text: 'The term is five years.' } } }));
  forged.manifest.hashes.decisions = fresh.manifest.hashes.decisions;
  assert.equal(verifyRecord(forged, pub).digest, false);
  forged.manifest.digest = fresh.manifest.digest;
  assert.equal(verifyRecord(forged, pub).signature, 'invalid'); assert.equal(verifyRecord(forged, pub).ok, false);
});

test('a record re-signed with another key verifies only against that key, not the one the recipient expects', () => {
  const expected = roundTrip(buildRecord(input(), { env: { REVIEW_RECORD_SIGNING_KEY: key } })).manifest.signature.publicKey;
  const other = roundTrip(buildRecord(input(), { env: { REVIEW_RECORD_SIGNING_KEY: randomBytes(32).toString('hex') } }));
  assert.equal(verifyRecord(other).signature, 'valid', 'consistent with the key it names');
  const v = verifyRecord(other, expected); assert.equal(v.signature, 'invalid'); assert.equal(v.keyMatches, false); assert.equal(v.trusted, false);
});

test('without a key the record is hashed, unsigned and says so; a malformed key refuses to export', () => {
  const r = roundTrip(buildRecord(input(), { env: {} }));
  assert.equal(r.manifest.signature, null); assert.match(r.note, /not signed/);
  const v = verifyRecord(r); assert.equal(v.ok, true); assert.equal(v.signature, 'unsigned'); assert.equal(v.trusted, false);
  assert.throws(() => buildRecord(input(), { env: { REVIEW_RECORD_SIGNING_KEY: 'not-a-key' } }), /64 hex characters/);
  assert.throws(() => buildRecord({ document: input().document }, { env: {} }), /needs the review/);
});
