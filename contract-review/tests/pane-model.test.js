// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sequence, worstFirst, inferPlaybook, diffExcerpt, quoteExcerpt, quoteSize, applicableText, senderLabel, passageFor, minimalEdit, minimalEdits, isClauseWording, optionReply, clauseHeading, leadSentences, positionLabel } from '../src/review/model.js';

test('sequence is exception-led and keeps points on unchanged text apart', () => {
  const f = (id, status, untouched = false) => ({ id, status, untouched });
  const s = sequence([f('a', 'within-guidance'), f('b', 'attention'), f('c', 'context', true), f('d', 'context'), f('e', 'attention', true), f('g', 'within-guidance', true)]);
  assert.deepEqual(s.primary.map(x => x.id), ['b', 'd', 'a', 'g'], 'attention, context, within guidance; untouched within-guidance stays in the main run');
  assert.deepEqual(s.also.map(x => x.id), ['e', 'c']);
});

test('the pane lists every point worst first, changed text before unchanged text at the same severity (decision 184)', () => {
  const f = (id, status, untouched = false) => ({ id, status, untouched });
  const list = worstFirst([f('a', 'within-guidance'), f('b', 'attention'), f('c', 'context', true), f('d', 'context'), f('e', 'attention', true), f('g', 'within-guidance', true)]);
  assert.deepEqual(list.map(x => x.id), ['b', 'e', 'd', 'c', 'a', 'g']);
  assert.deepEqual(worstFirst(), []);
});

test('with no matter, the playbook is inferred from the title or the first lines, else none: the lawyer chooses (decision 184, audit finding 2)', () => {
  const books = [{ id: 'nda', appliesTo: { phrases: ['non-disclosure agreement', 'nda'] } }, { id: 'order-form', appliesTo: { phrases: ['order form'] } }, { id: 'msa' }];
  assert.equal(inferPlaybook(books, { title: '', paragraphs: [{ text: '' }, { text: 'ORDER FORM' }, { text: 'Customer: Northgate' }] }), 'order-form');
  assert.equal(inferPlaybook(books, { title: 'Brightwater NDA v3.docx', paragraphs: [] }), 'nda');
  assert.equal(inferPlaybook(books, { title: 'agenda.docx', paragraphs: [{ text: 'Minutes' }] }), null, 'nothing matched: no silent NDA fallback; the lawyer chooses (audit finding 2)');
  assert.equal(inferPlaybook([{ id: 'msa' }], { title: 'x' }), null);
  assert.equal(inferPlaybook([], { title: 'x' }), null);
  assert.equal(inferPlaybook(books, { paragraphs: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'Order form' }] }), null, 'only the first three lines are read');
});

test('the recorded demo run orders retention first, then the two within-guidance changes', () => {
  const raw = readFileSync(new URL('../data/recorded-runs/demo-fixture/review.raw.txt', import.meta.url), 'utf8').replace(/^```json\s*|\s*```\s*$/g, '');
  const { findings } = JSON.parse(raw);
  const s = sequence(findings.map((x, i) => ({ ...x, id: String(i) })));
  assert.deepEqual(s.primary.map(x => x.paragraphId), ['p13', 'p5', 'p14']);
  assert.deepEqual(s.also.map(x => x.paragraphId), ['p12', 'p16']);
});

test('diffExcerpt keeps the changed words with a little context', () => {
  const before = 'Confidentiality Period: seven (7) years from the date of disclosure, except that obligations in respect of trade secrets continue.';
  const after = before.replace('seven (7)', 'five (5)');
  const e = diffExcerpt(before, after);
  const text = e.parts.map(p => p.text).join('');
  assert.match(text, /seven \(7\)/); assert.match(text, /five \(5\)/);
  assert.ok(e.parts.some(p => p.kind === 'del' && p.text.includes('seven')));
  assert.ok(e.parts.some(p => p.kind === 'add' && p.text.includes('five')));
  assert.ok(e.length < 60, 'short enough for the large size');
  assert.equal(quoteSize(e), 'l');
  assert.equal(diffExcerpt('same', 'same'), null);
});

test('long insertions are clamped at a word boundary and marked truncated', () => {
  const before = 'Upon expiration the Receiving Party will destroy it.';
  const after = `${before} Notwithstanding the foregoing, the Receiving Party may retain copies of Confidential Information in its routine backup systems and as required by its internal compliance policies, provided such copies remain subject to this MNDA.`;
  const e = diffExcerpt(before, after);
  assert.equal(e.truncated, true);
  assert.ok(e.length <= 140);
  assert.ok(!/\s$/.test(e.parts.at(-1).text), 'cut at a word boundary');
  assert.equal(quoteSize(e), 'm');
  assert.ok(e.full.length >= 2, 'the full diff is kept for "Full wording"');
});

test('quoteExcerpt, applicableText, senderLabel', () => {
  assert.equal(quoteExcerpt('the laws of the State of Governing Law').parts[0].text, 'the laws of the State of Governing Law');
  assert.equal(quoteExcerpt(''), null);
  assert.equal(applicableText({ proposedText: 'x', proposalStatus: 'ok' }), 'x');
  assert.equal(applicableText({ proposedText: 'x', proposalStatus: 'not-applicable' }), null);
  assert.equal(applicableText({}), null);
  assert.equal(senderLabel('Nkechi Okafor <n.okafor@brightwater-analytics.example>'), 'N. Okafor');
  assert.equal(senderLabel('n.okafor@example'), null);
});

test('passageFor picks the finding\'s own words in the document and never an unverified or foreign quote', () => {
  const f = { paragraphId: 'p3', evidence: [{ paragraphId: 'p1', quote: 'elsewhere' }, { paragraphId: 'p3', quote: 'own words' }] };
  assert.equal(passageFor(f), 'own words', 'replayed evidence has no verified flag and is still a passage');
  assert.equal(passageFor({ paragraphId: 'p3', evidence: [{ paragraphId: 'p3', quote: 'gone', verified: false }, { paragraphId: 'p1', quote: 'kept', verified: true }] }), 'kept');
  assert.equal(passageFor({ paragraphId: 'p3', evidence: [{ paragraphId: 'p3', quote: 'from the starting text', source: 'baseline', verified: true }] }), null);
  assert.equal(passageFor({ paragraphId: 'p3' }), null);
});

test('minimalEdit names the changed words and a unique run around them', () => {
  const before = 'General confidentiality obligations continue for 7 years after termination. Trade secrets remain protected for 7 further years.';
  const e = minimalEdit(before, before.replace('continue for 7 years', 'continue for 5 years'));
  assert.equal(e.inner, '7'); assert.equal(e.innerReplacement, '5');
  assert.ok(e.context.includes('7') && before.split(e.context).length === 2, 'the context is found exactly once'); assert.equal(e.contextReplacement, e.context.replace('7', '5'));
  assert.ok(e.context.length < 40, e.context);
  assert.equal(before.replace(e.context, e.contextReplacement), before.replace('continue for 7 years', 'continue for 5 years'));
  // An added sentence: no words are struck, so the context carries the insertion.
  const add = minimalEdit('The Receiving Party may retain copies.', 'The Receiving Party may retain copies, subject to this MNDA.');
  assert.equal(add.inner, 'copies.'); assert.equal(add.innerReplacement, 'copies, subject to this MNDA.');
  const ins = minimalEdit('Alpha beta gamma.', 'Alpha beta new words gamma.');
  assert.equal(ins.inner, null); assert.equal('Alpha beta gamma.'.replace(ins.context, ins.contextReplacement), 'Alpha beta new words gamma.');
  const del = minimalEdit('Alpha beta gamma delta.', 'Alpha gamma delta.');
  assert.equal(del.inner, null); assert.equal('Alpha beta gamma delta.'.replace(del.context, del.contextReplacement), 'Alpha gamma delta.');
  assert.equal(minimalEdit('Same.', 'Same.'), null);
  const whole = minimalEdit('Old text entirely.', 'Completely different words here.');
  assert.equal('Old text entirely.'.replace(whole.context, whole.contextReplacement), 'Completely different words here.');
});

test('an option is applied only when its text is wording for the clause; a remark is shown as a remark', () => {
  const clause = '5. Payment. The Customer shall pay each undisputed invoice within 90 days of the invoice date.';
  const before = clause.replace('90', '30'), suggested = clause.replace('90', '60');
  const refs = [clause, before, suggested];
  // The two option texts the recorded order-form review returned (seen applied in Word before this check existed).
  assert.equal(isClauseWording('Within the playbook ceiling; no escalation needed for this outcome.', refs), false);
  assert.equal(isClauseWording("Accept the customer's 90 days.", refs), false);
  assert.equal(isClauseWording(suggested, refs), true);
  assert.equal(isClauseWording('5. Payment. The Customer shall pay each undisputed invoice within 45 days of the invoice date, and Helix may suspend the service for late payment.', refs), true);
  assert.equal(isClauseWording('Term: 5 years.', ['Term: 3 years.']), true, 'a short clause with one word changed');
  assert.equal(isClauseWording('', refs), false); assert.equal(isClauseWording('Escalate.', refs), false);
  assert.equal(isClauseWording('Restore: ' + before, refs), false, 'an instruction with the clause attached is not wording');
  assert.deepEqual(optionReply({ label: 'Counter at 60 days', text: 'Within the playbook ceiling; no escalation needed for this outcome.' }, refs), { label: 'Counter at 60 days', hint: null, text: null, note: 'Within the playbook ceiling; no escalation needed for this outcome.' });
  assert.deepEqual(optionReply({ label: 'Counter at 60 days', text: suggested }, refs), { label: 'Counter at 60 days', hint: null, text: suggested, note: null });
  assert.deepEqual(optionReply({ label: 'Escalate' }, refs), { label: 'Escalate', hint: null, text: null, note: null });
});

test('wording changed in two places becomes two edits, last first; an added sentence is an insertion with nothing struck', () => {
  const before = 'Confidentiality Period: seven (7) years from the date of disclosure, except that obligations in respect of trade secrets continue for so long as the information remains a trade secret.';
  const after = before.replace('seven (7)', 'five (5)') + ' This applies to both parties.';
  const edits = minimalEdits(before, after);
  assert.equal(edits.length, 2);
  assert.equal(edits[0].insertAfter, ' This applies to both parties.', 'the addition comes first because it is last in the clause');
  assert.ok(before.endsWith(edits[0].context) && before.split(edits[0].context).length === 2);
  assert.equal(edits[1].inner, 'seven (7)'); assert.equal(edits[1].innerReplacement, 'five (5)');
  // Applying them in the order given reproduces the new wording exactly.
  let text = before; for (const e of edits) { assert.equal(text.split(e.context).length, 2, 'each place is found exactly once when its turn comes'); text = text.replace(e.context, e.contextReplacement); }
  assert.equal(text, after);
  // One place, or two places a few words apart, stay a single edit; no change is no edit.
  assert.equal(minimalEdits(before, before.replace('seven (7)', 'five (5)')).length, 1);
  assert.equal(minimalEdits('Pay within 30 days of the invoice date.', 'Pay within 60 days of the delivery date.').length, 1);
  assert.deepEqual(minimalEdits(before, before), []);
  // A place that cannot be found once without reaching into its neighbour falls back to the single spanning edit.
  const twin = 'The fee is 7 and the cap is 7 and the term is long and the notice is 7 days.';
  const fallback = minimalEdits(twin, 'The fee is 5 and the cap is 7 and the term is long and the notice is 9 days.');
  let t = twin; for (const e of fallback) t = t.replace(e.context, e.contextReplacement); assert.equal(t, 'The fee is 5 and the cap is 7 and the term is long and the notice is 9 days.');
});

// The point is named by the clause it sits under (decision 120): the paragraph's own label, else the heading above it.
test('clauseHeading reads the paragraph label or the heading above it', () => {
  const paras = [
    { id: 'p1', text: 'Mutual Non-Disclosure Agreement — Cover Page' },
    { id: 'p5', text: 'Confidentiality Period: five (5) years from the date of disclosure, except that obligations continue.' },
    { id: 'p9', text: '6. Return or Destruction.' },
    { id: 'p10', text: 'Upon expiration or termination of this MNDA the Receiving Party will cease using Confidential Information.' },
    { id: 'p11', text: 'Notwithstanding the foregoing, the Receiving Party may retain copies.' },
    { id: 'p20', text: 'The Receiving Party shall: (a) use Confidential Information solely for the Purpose; (b) not disclose it.' },
  ];
  assert.equal(clauseHeading(paras, 'p5'), 'Confidentiality Period');
  assert.equal(clauseHeading(paras, 'p10'), '6. Return or Destruction');
  assert.equal(clauseHeading(paras, 'p11'), '6. Return or Destruction');
  assert.equal(clauseHeading(paras, 'p1'), 'Mutual Non-Disclosure Agreement — Cover Page');
  assert.equal(clauseHeading(paras, 'p20'), '6. Return or Destruction'); // the nearest heading above, within reach
  assert.equal(clauseHeading(paras, 'nope'), null);
  assert.equal(clauseHeading([{ id: 'a', text: 'A long first sentence that runs on without any heading above it and ends with a stop.' }], 'a'), null);
});

test('leadSentences keeps the first two sentences within the limit', () => {
  const text = 'A new sentence lets the Receiving Party keep copies. RET-01 permits ordinary backup only while restrictions continue. It has three weaknesses. (1) It repeats.';
  assert.equal(leadSentences(text), 'A new sentence lets the Receiving Party keep copies. RET-01 permits ordinary backup only while restrictions continue.');
  assert.equal(leadSentences(text, { max: 1 }), 'A new sentence lets the Receiving Party keep copies.');
  assert.equal(leadSentences(''), '');
  const long = 'x'.repeat(50) + ' ' + 'y'.repeat(400) + '.';
  assert.ok(leadSentences(long, { limit: 120 }).endsWith('…'));
});

test('positionLabel drops list letters and moves the rule bracket to a hint', () => {
  assert.deepEqual(positionLabel('A: Delete the residuals sentence (USE-01 fallback)'), { label: 'Delete the residuals sentence', hint: 'USE-01 fallback' });
  assert.deepEqual(positionLabel('Counter at five years (within the DUR-01 ceiling)'), { label: 'Counter at five years', hint: 'within the DUR-01 ceiling' });
  assert.deepEqual(positionLabel('Restore England and Wales'), { label: 'Restore England and Wales', hint: null });
  assert.deepEqual(positionLabel('(odd)'), { label: '(odd)', hint: null });
  assert.equal(optionReply({ label: 'B: Narrow it (needs approval)', text: 'Within the ceiling; no escalation needed' }, ['Fees are due in 30 days.']).hint, 'needs approval');
});
