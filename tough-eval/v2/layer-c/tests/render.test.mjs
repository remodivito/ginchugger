// SPDX-License-Identifier: GPL-3.0-or-later
// Normalisation: one shape for every output, no setup identity in what a judge reads, word-level [was]/[now] hunks,
// paragraph alignment of a golden redline, and the product's own boilerplate kept out of the explanations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, outputFromReview, outputFromGolden, EMPTY_OUTPUT, leaks, plain, showChange, wordDiff, alignParagraphs, documentTerms, partyOf } from '../render.mjs';
import { loadTasks, readStripped } from '../import.mjs';
import { renderedFor, outputFor, userMessage } from '../judge.mjs';

const doc = { id: 'C-x', revision: 1, title: 't', paragraphs: [{ id: 'p-000', text: 'Definitions apply.' }, { id: 'p-001', text: 'Liability is capped at fees paid or $1,000,000.', originalText: 'Liability is capped at fees paid.' }, { id: 'p-002', text: 'Notices in writing.' }] };
const markup = { 'p-001': [{ text: 'Liability is capped at fees paid', kind: null, author: null }, { text: ' or $1,000,000', kind: 'ins', author: 'Trainer 1 - LargeCo' }, { text: '.', kind: null, author: null }] };
// A review result as review-one.mjs writes it, full of setup identity in places a careless renderer would copy.
const review = { ok: true, ms: 1234, model: { executor: 'openai', model: 'zai-org/glm-5.3-flash', promptFile: 'prompts/review.md' }, servedModel: 'glm-5.3-flash-0925', setup: 'glm-5.3-flash-plain',
  findings: [
    { paragraphId: 'p-001', title: 'GLM-5.3 Flash: cap floor', status: 'attention', decision: 'counter', ruleIds: ['RB-05'], risk: 'high', explanation: '**As GLM** (Zhipu), I recommend: delete the floor. Claude would agree; ask DeepSeek or Qwen.', proposedText: 'Liability is capped at fees paid.', suggestedText: 'Liability is capped at fees paid.', proposalStatus: 'ok' },
    { paragraphId: 'p-002', title: 'Accept', status: 'attention', decision: 'accept', ruleIds: ['RB-01'], explanation: 'Fine as it is.', suggestedText: 'Notices by email.' },
    { paragraphId: 'p-000', title: 'Amendment for contextual review', status: 'context', ruleIds: [], explanation: 'The available text comparison identifies this amendment.' },
    { paragraphId: 'p-002', title: 'Not offered', status: 'attention', decision: 'counter', ruleIds: [], explanation: 'Unsupported proposal.', proposedText: 'Notices by fax.', proposalStatus: 'not-applicable' }],
  limits: ['Opus 5.5 limit note'] };

test('a contestant review renders with no model, family, product or setup identity', () => {
  const out = outputFromReview(review, doc); const text = render(doc, markup, out);
  assert.deepEqual(leaks(text, documentTerms(doc)), []);
  for (const s of ['GLM', 'glm', 'Zhipu', 'Claude', 'DeepSeek', 'Qwen', 'zai-org', '0925', 'glm-5.3-flash-plain', 'prompts/review.md', '1234', 'RB-05', 'high', 'counter', 'cap floor', 'Opus', 'limit note']) assert.ok(!text.includes(s), `rendered output must not carry "${s}"`);
  assert.match(text, /\[redacted\]/, 'identity words in explanations are redacted');
  assert.match(text, /PROPOSED: Liability is capped at fees paid \[was: or \$1,000,000\] \[now: \(nothing\)\]\./);
  assert.match(text, /\{\+LargeCo: or \$1,000,000\+\}/, 'earlier rounds shown with the party name only');
  assert.ok(!text.includes('Trainer'));
  assert.ok(!text.includes('Notices by email'), 'an accepted finding is not a proposal');
  assert.ok(!text.includes('Notices by fax'), 'wording not offered for Apply is not a proposal');
  assert.ok(!text.includes('available text comparison'), 'the product\'s own boilerplate is not the output\'s explanation');
});

test('golden, empty and review share one shape; a failed review has no output', () => {
  const head = t => t.split('\n').slice(0, 2).join('\n');
  const g = render(doc, markup, outputFromGolden({ source: 'x', changes: [{ paragraphId: 'p-001', text: 'Liability is capped at fees paid.' }], explanations: [{ paragraphId: 'p-001', text: 'We can’t accept a floor.' }] }, doc));
  const e = render(doc, markup, EMPTY_OUTPUT); const r = render(doc, markup, outputFromReview(review, doc));
  assert.equal(head(g), head(e)); assert.equal(head(g), head(r));
  assert.match(e, /\(The output proposes no changes\.\)/); assert.match(e, /EXPLANATIONS\n\(none\)/);
  assert.equal(outputFromReview({ ok: false, error: 'malformed' }, doc), null);
  assert.equal(g.split('PROPOSED:')[1].split('\n')[0], r.split('PROPOSED:')[1].split('\n')[0], 'the same change renders identically whoever proposed it');
});

test('the document\'s own words are never redacted', () => {
  const d = { paragraphs: [{ id: 'p-0', text: 'Provider may use Google Cloud and Gemini models.' }] };
  const t = render(d, {}, { changes: [{ paragraphId: 'p-0', text: 'Provider may use Google Cloud.' }], explanations: [{ paragraphId: 'p-0', text: 'Gemini is a subprocessor; Claude says so.' }] });
  assert.match(t, /Gemini is a subprocessor; \[redacted\] says so/);
  assert.deepEqual(leaks(t, documentTerms(d)), []);
});

test('plain text, hunks and alignment', () => {
  assert.equal(plain('## Head\n**bold** and `code`\n\n\n\n* item'), 'Head\nbold and code\n\n- item');
  assert.equal(showChange('a b c d e', 'a X c d Y e'), 'a [was: b] [now: X] c d [was: (nothing)] [now: Y] e');
  assert.equal(showChange('keep me', ''), '[was: keep me] [now: (paragraph deleted)]');
  assert.deepEqual(wordDiff('same text', 'same text'), [{ same: 'same text' }]);
  assert.deepEqual(alignParagraphs(['A one', 'B two three', 'C'], ['A one', 'B two four', 'New para here', 'C']), [{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: null, b: 2 }, { a: 2, b: 3 }]);
  assert.equal(partyOf('Trainer 2 - LargeCo'), 'LargeCo'); assert.equal(partyOf('Trainer 1'), 'earlier round');
});

test('every committed task renders golden and empty with no identity leak, and the judge message names no setup', () => {
  for (const t of loadTasks().tasks) {
    const terms = documentTerms(readStripped(t.document));
    for (const o of ['golden', 'empty']) {
      const text = renderedFor(t, outputFor(o, t)); assert.deepEqual(leaks(text, terms), []);
      const u = userMessage(t, t.criteria[0], text);
      for (const s of ['golden', 'attorney redline', 'Trainer', 'empty output', 'opus', 'glm', 'deepseek', 'qwen']) assert.ok(!u.toLowerCase().includes(s.toLowerCase()) || terms.has(s), `message carries ${s}`);
    }
  }
});
