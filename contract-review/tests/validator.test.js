// SPDX-License-Identifier: GPL-3.0-or-later
// Checks of validateFindings written from the mutants that survived its mutation run (decision 135): each test pins a
// behaviour that a weakened check would otherwise have changed without any test noticing. The validator's promise is
// "flag, never discard": every finding comes back, and whatever is wrong with it is said in its notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings } from '../server/review.js';

const plain = { rules: [{ id: 'term', title: 'Term', guidance: 'Up to five years.', enabled: true }, { id: 'old', title: 'Old', guidance: 'Retired.', enabled: false }] };
const scheme = { rules: [{ id: 'term', title: 'Term', guidance: 'Rate each deviation as high risk, medium risk or low risk.', enabled: true }] };
const document = { paragraphs: [
  { id: 'p1', text: 'The term is seven years.' },
  { id: 'p2', text: 'Short.', originalText: 'x'.repeat(3000) },
  { id: 'p3', text: 'y'.repeat(3000), originalText: 'Brief.' },
  { id: 'p4', text: 'Each party bears its own costs.', originalText: 'Each party bears its own reasonable costs.' },
] };
const base = { paragraphId: 'p1', title: 'Term', status: 'attention', ruleIds: ['term'], explanation: 'Longer than the playbook allows.', evidence: [{ quote: 'seven years' }] };
const run = (findings, playbook = plain, options) => validateFindings({ findings }, document, playbook, options);
const one = (patch, playbook = plain, options) => run([{ ...base, ...patch }], playbook, options).findings[0];
const noted = (f, pattern) => f.notes.some(n => pattern.test(n));

test('a well-formed finding passes with no notes, and nothing is invented for fields it did not give', () => {
  const r = run([base]);
  assert.deepEqual(r.notes, []); assert.deepEqual(r.limits, []);
  const f = r.findings[0];
  assert.deepEqual(f.notes, []); assert.equal(f.status, 'attention'); assert.equal(f.decision, 'none'); assert.equal(f.untouched, false);
  for (const k of ['proposedText', 'suggestedText', 'deletion', 'revisionNote', 'insertAfter', 'options', 'positions', 'risk', 'history', 'unknownRuleIds']) assert.equal(k in f, false, k);
  assert.deepEqual(Object.keys(f.flags), [], 'no flags raised');
});

test('a reply that is not a findings list is refused; entries that are not objects are skipped with a note; at most 200 are kept', () => {
  for (const raw of [null, 'findings', [], { limits: [] }]) assert.throws(() => validateFindings(raw, document, plain), /no findings array/);
  const r = run([null, 'x', base]);
  assert.equal(r.findings.length, 1); assert.deepEqual(r.notes, ['Skipped a non-object entry in findings.', 'Skipped a non-object entry in findings.']);
  const many = run(Array.from({ length: 201 }, () => base));
  assert.equal(many.findings.length, 200); assert.match(many.notes.at(-1), /first 200 of 201/);
  assert.equal(run(Array.from({ length: 200 }, () => base)).notes.length, 0);
  assert.deepEqual(validateFindings({ findings: [], limits: ['Schedule A missing.', 7, null] }, document, plain).limits, ['Schedule A missing.']);
});

test('a finding whose paragraph is missing or unknown is kept, unanchored, and says which', () => {
  const missing = one({ paragraphId: undefined });
  assert.equal(missing.anchored, false); assert.equal(missing.paragraphId, ''); assert.ok(noted(missing, /Target paragraph \(missing\) is not in the document/));
  const unknown = one({ paragraphId: 'p9' });
  assert.ok(noted(unknown, /Target paragraph p9 is not in the document/));
  assert.equal(one({}).notes.some(n => /Target paragraph/.test(n)), false);
});

test('status: the three known statuses pass as given; anything else is shown as context with a note; within guidance needs a rule', () => {
  assert.equal(one({ status: 'within-guidance' }).status, 'within-guidance');
  assert.deepEqual(one({ status: 'context' }).notes, []);
  const odd = one({ status: 'urgent' });
  assert.equal(odd.status, 'context'); assert.ok(noted(odd, /Status "urgent" not recognised; shown as context/));
  const unruled = one({ status: 'within-guidance', ruleIds: [] });
  assert.equal(unruled.status, 'context'); assert.ok(noted(unruled, /Within-guidance claimed without a saved rule/));
  assert.equal(one({ status: 'attention', ruleIds: [] }).status, 'attention');
  assert.equal(one({ title: '' }).title, 'Untitled finding');
  assert.equal(one({ decision: 'sign it' }).decision, 'none');
});

test('rule references: only enabled rules of this playbook count; others are listed by name', () => {
  const f = one({ ruleIds: ['term', 'old', 'fiction', 3] });
  assert.deepEqual(f.ruleIds, ['term']); assert.deepEqual(f.unknownRuleIds, ['old', 'fiction']);
  assert.ok(noted(f, /not in the active playbook: old, fiction\./));
  assert.equal('unknownRuleIds' in one({ ruleIds: undefined }), false);
});

test('evidence: a quote verifies only as an exact passage of the paragraph it cites; an earlier-version quote is checked against the earlier text', () => {
  const f = one({ evidence: [{ quote: 'seven years' }, { paragraphId: 'p4', quote: 'own costs' }, { paragraphId: 'p4', quote: 'reasonable costs', source: 'original' }, { paragraphId: 'p4', quote: 'reasonable costs' }, { paragraphId: 'p9', quote: 'seven' }, { quote: 7 }, null] });
  assert.deepEqual(f.evidence.map(e => [e.paragraphId, e.quote, e.source || null, e.verified]), [
    ['p1', 'seven years', null, true], ['p4', 'own costs', null, true], ['p4', 'reasonable costs', 'baseline', true], ['p4', 'reasonable costs', null, false], ['p9', 'seven', null, false], ['p1', '', null, false], ['p1', '', null, false]]);
  assert.ok(noted(f, /^4 quote\(s\) could not be verified/)); assert.equal(noted(f, /No verified quote from the target paragraph/), false);
  assert.equal(one({ evidence: [{ quote: 'seven years', source: 'baseline' }] }).evidence[0].verified, true, 'with no earlier text the earlier version is the current text');
  const none = one({ evidence: 'seven years' });
  assert.deepEqual(none.evidence, []); assert.ok(noted(none, /^No evidence quoted\.$/));
  const elsewhere = one({ evidence: [{ paragraphId: 'p4', quote: 'own costs' }] });
  assert.ok(noted(elsewhere, /No verified quote from the target paragraph/)); assert.equal(noted(elsewhere, /could not be verified/), false);
  assert.equal(one({ evidence: Array.from({ length: 31 }, () => ({ quote: 'seven years' })) }).evidence.length, 30);
});

test('proposed wording is offered for Apply only when it is wording, for a paragraph in the document, with support, and not far longer', () => {
  const offered = one({ proposedText: 'The term is five years.' });
  assert.equal(offered.proposalStatus, 'ok'); assert.equal(offered.suggestedText, 'The term is five years.'); assert.equal(noted(offered, /not offered/), false);
  assert.equal(one({ suggestedText: 'The term is five years.' }).suggestedText, 'The term is five years.');
  assert.equal('proposedText' in one({ suggestedText: 5 }), false);
  const cases = [
    [{ paragraphId: 'p9', proposedText: 'The term is five years.' }, /Cannot apply: target paragraph not found/],
    [{ ruleIds: [], proposedText: 'The term is five years.' }, /No playbook rule or client instruction cited in support/],
    [{ proposedText: 'y'.repeat(4097) }, /Far longer than the target paragraph/],
  ];
  for (const [patch, why] of cases) {
    const f = one(patch);
    assert.equal(f.proposalStatus, 'not-applicable', JSON.stringify(patch).slice(0, 80)); assert.equal(f.suggestedText, undefined); assert.equal(f.proposedText, patch.proposedText);
    assert.ok(noted(f, new RegExp(`Proposed wording shown but not offered for application: ${why.source}`)), why.source); assert.match(f.proposalNote, why);
  }
  // Support without a playbook rule needs an instruction or a held email that this review was actually given.
  const byInstruction = { ruleIds: [], explanation: 'Per the client instruction.', proposedText: 'The term is five years.' };
  assert.equal(one(byInstruction).proposalStatus, 'not-applicable', 'no instruction was supplied');
  assert.equal(one(byInstruction, plain, { context: [{ name: 'matter-instructions', text: 'Hold five years.' }] }).proposalStatus, 'ok');
  assert.equal(one(byInstruction, plain, { context: [{ name: 'matter-instructions', text: '  ' }] }).proposalStatus, 'not-applicable', 'an empty instruction is none');
  assert.equal(one(byInstruction, plain, { context: [{ text: '' }, { text: 'Hold five years.' }] }).proposalStatus, 'ok', 'one real instruction among empty ones is enough');
  assert.equal(one(byInstruction, plain, { context: [null, { text: 7 }] }).proposalStatus, 'not-applicable', 'malformed context entries are not instructions');
  const byEmail = { ruleIds: [], explanation: 'As agreed in the email of 19 May.', proposedText: 'The term is five years.' };
  assert.equal(one(byEmail).proposalStatus, 'not-applicable');
  assert.equal(one(byEmail, plain, { history: [{ itemId: 'a', text: 'Five years agreed.' }] }).proposalStatus, 'ok');
  // The limit is four times the longer of the clause's two versions, plus 4,000 characters; exactly at the limit is allowed.
  assert.equal(one({ proposedText: 'y'.repeat(24 * 4 + 4000) }).proposalStatus, 'ok');
  assert.equal(one({ paragraphId: 'p2', evidence: [{ quote: 'Short.' }], proposedText: 'z'.repeat(5000) }).proposalStatus, 'ok', 'cut down from 3,000 characters');
  assert.equal(one({ paragraphId: 'p3', evidence: [{ quote: 'yyy' }], proposedText: 'z'.repeat(5000) }).proposalStatus, 'ok', 'grown to 3,000 characters');
});

test('empty wording for a clause proposes deleting it: offered for Apply and marked as a deletion; for an empty paragraph it is not offered', () => {
  const del = one({ decision: 'reject', proposedText: '' });
  assert.equal(del.proposalStatus, 'ok'); assert.equal(del.suggestedText, ''); assert.equal(del.deletion, true); assert.deepEqual(del.notes, []);
  assert.equal(del.flags.missingWording, undefined, 'a deletion is wording');
  assert.equal(one({ decision: 'reject', proposedText: '   ' }).deletion, true);
  for (const patch of [{ paragraphId: 'p9', proposedText: '' }, { ruleIds: [], proposedText: '' }]) { const f = one(patch); assert.equal(f.proposalStatus, 'not-applicable'); assert.equal('deletion' in f, false); }
  const blank = validateFindings({ findings: [{ ...base, paragraphId: 'p5', evidence: [], proposedText: '' }] }, { paragraphs: [...document.paragraphs, { id: 'p5', text: '' }] }, plain).findings[0];
  assert.equal(blank.proposalStatus, 'not-applicable'); assert.match(blank.proposalNote, /empty paragraph/);
  const doc2 = { paragraphs: [...document.paragraphs, { id: 'p5', text: '   ' }] };
  for (const proposedText of ['', '  ']) assert.equal(validateFindings({ findings: [{ ...base, paragraphId: 'p5', evidence: [], proposedText }] }, doc2, plain).findings[0].proposalStatus, 'not-applicable', `a blank paragraph cannot be deleted (${JSON.stringify(proposedText)})`);
  assert.equal('deletion' in one({ proposedText: 'The term is five years.' }), false);
});

test('a reworded finding says what changed in its own field, bounded; the title is left alone', () => {
  const f = one({ title: 'Term', revisionNote: '  Narrowed to five years.  ' });
  assert.equal(f.title, 'Term'); assert.equal(f.revisionNote, 'Narrowed to five years.');
  assert.equal(one({ revisionNote: 'n'.repeat(400) }).revisionNote.length, 300);
  for (const revisionNote of [undefined, '  ', 7]) assert.equal('revisionNote' in one({ revisionNote }), false);
});

test('insertions keep only real wording, say whether their anchor paragraph exists, and stand in for wording', () => {
  const f = one({ decision: 'counter', insertAfter: [{ afterParagraphId: 'p1', text: 'A new clause.' }, { afterParagraphId: 'p9', text: 'Lost.' }, { afterParagraphId: 'p1', text: '  ' }, { afterParagraphId: 'p1', text: 5 }, null, { afterParagraphId: 'p1', text: 'w'.repeat(20001) }] });
  assert.deepEqual(f.insertAfter.map(x => [x.afterParagraphId, x.text.length, x.anchored]), [['p1', 13, true], ['p9', 5, false], ['p1', 20000, true]]);
  assert.ok(noted(f, /An insertion names a paragraph that is not in the document/));
  assert.equal(f.flags.missingWording, undefined, 'an insertion is wording');
  assert.equal(noted(one({ insertAfter: [{ afterParagraphId: 'p1', text: 'A new clause.' }] }), /insertion names/), false);
});

test('options keep a label and any wording, up to eight; malformed options are dropped', () => {
  const f = one({ options: ['Accept', { label: 'Counter at five', text: 'The term is five years.' }, { label: 'L'.repeat(250), text: 5 }, { text: 'no label' }, null, 4] });
  assert.deepEqual(f.options.map(o => [o.label.length, 'text' in o ? o.text : null]), [[6, null], [15, 'The term is five years.'], [200, null]]);
  assert.equal(one({ options: Array.from({ length: 9 }, (_, i) => `Option ${i}`) }).options.length, 8);
  assert.equal('options' in one({ options: 'Accept' }), false);
});

test('positions keep the four tiers that were given, each bounded; none given means none shown', () => {
  const f = one({ positions: { preferred: 'Five years.', acceptable: '  ', escalation: 'e'.repeat(1600), hardLine: 7, invented: 'x' } });
  assert.deepEqual(f.positions, { preferred: 'Five years.', acceptable: null, escalation: 'e'.repeat(1500), hardLine: null });
  assert.equal('positions' in one({ positions: { preferred: ' ' } }), false);
  assert.equal('positions' in one({ positions: 'Five years.' }), false);
});

test('a risk rating keeps its rating and basis, bounded; a rating given as bare text or blank is not a rating', () => {
  assert.deepEqual(one({ decision: 'counter', risk: { rating: 'High', basis: 'Beyond the hard line.' } }, scheme).risk, { rating: 'High', basis: 'Beyond the hard line.' });
  assert.deepEqual(one({ risk: { rating: 'R'.repeat(120), basis: 'B'.repeat(600) } }).risk, { rating: 'R'.repeat(100), basis: 'B'.repeat(500) });
  assert.deepEqual(one({ risk: { rating: 'Low', basis: 3 } }).risk, { rating: 'Low', basis: null });
  for (const risk of ['High', { rating: '  ' }]) { const f = one({ decision: 'counter', risk }, scheme); assert.equal(f.risk, undefined); assert.equal(f.flags.missingRisk, true); }
});

test('a missing risk rating is flagged only for a deviation that is being acted on, under an enabled rule that sets out a risk scheme', () => {
  assert.equal(one({ decision: 'counter' }, plain).flags.missingRisk, undefined);
  const flagged = one({ decision: 'counter' }, scheme);
  assert.equal(flagged.flags.missingRisk, true); assert.ok(noted(flagged, /No risk rating given/));
  for (const decision of ['none', 'accept']) assert.equal(one({ decision }, scheme).flags.missingRisk, undefined, decision);
  assert.equal(one({ decision: 'counter', status: 'context' }, scheme).flags.missingRisk, undefined);
  assert.equal(one({ decision: 'counter' }, { rules: [...plain.rules, { ...scheme.rules[0], id: 'risk', enabled: false }] }).flags.missingRisk, undefined);
});

test('a decision that changes the text needs wording; its absence is flagged and said', () => {
  for (const decision of ['reject', 'counter', 'accept-with-modification']) { const f = one({ decision }); assert.equal(f.flags.missingWording, true, decision); assert.ok(noted(f, /calls for wording but none was drafted/)); }
  for (const decision of ['accept', 'reserved', 'none']) assert.equal(one({ decision }).flags.missingWording, undefined, decision);
  assert.equal(one({ decision: 'counter', proposedText: 'The term is five years.' }).flags.missingWording, undefined);
});

test('history excerpts verify only as exact quotes of a held item, carry its name and date, and are bounded', () => {
  const held = [{ itemId: 'a', text: 'We said seven years. Note it.', filename: 'a.eml', date: '2026-05-19' }, { itemId: 'b', text: 'Five years.', filename: 'b.docx' }];
  const f = one({ history: [{ itemId: 'a', quote: 'said seven', note: 'n'.repeat(400) }, { itemId: 'b', quote: 'Five years.' }, { itemId: 'a', quote: ' ' }, { itemId: 'zz', quote: 'said seven' }, null, { itemId: 'a', quote: 'said seven' }] }, plain, { history: held });
  assert.equal(f.history.length, 5);
  assert.deepEqual(f.history.map(h => [h.itemId, h.filename, h.date, h.verified]), [['a', 'a.eml', '2026-05-19', true], ['b', 'b.docx', null, true], ['a', 'a.eml', '2026-05-19', false], ['zz', null, null, false], [null, null, null, false]]);
  assert.equal(f.history[0].note.length, 300); assert.equal(f.history[1].note, null);
  assert.ok(noted(f, /history excerpt could not be verified/));
  assert.equal(one({ history: [{ itemId: 'a', quote: 'q'.repeat(1600) }] }, plain, { history: [{ itemId: 'a', text: 'q'.repeat(1600) }] }).history[0].quote.length, 1500);
  const good = one({ history: [{ itemId: 'b', quote: 'Five years.' }] }, plain, { history: held });
  assert.equal(noted(good, /history excerpt/), false);
  assert.deepEqual(one({ history: [{ quote: 'said seven' }, { itemId: 'a', quote: 7 }] }).history.map(h => [h.quote, h.verified]), [['said seven', false], ['', false]], 'no held items given');
  assert.equal(one({ history: [{ quote: 'said seven' }] }, plain, { history: null }).history[0].verified, false, 'held items given as null');
});

test('untouched is set only when the model says exactly true', () => {
  assert.equal(one({ untouched: true }).untouched, true);
  for (const untouched of ['true', 1, undefined]) assert.equal(one({ untouched }).untouched, false);
});
