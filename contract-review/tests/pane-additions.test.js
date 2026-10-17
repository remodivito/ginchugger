// SPDX-License-Identifier: GPL-3.0-or-later
// The pane additions of product v2, slice S5 (spec 11.1 "Pane model"); "last time" left the pane on the store (task 8):
// the bulk confirmation list, comment reply composition, the comment_replied event (kept in the document's review
// history); the Word calls behind them (comments, reply, a new paragraph as a tracked insertion) against minimal API
// fakes. Reference files, standard forms and the demo matters went with the record's matters (decision 190).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planEdits, commentReplyText, threadFor } from '../src/review/model.js';
import { decisionEvent, reviewBatch } from '../src/review/record-events.js';
import { readCommentsWith, replyWith, insertParagraphTracked } from '../src/word.js';
import { openReviewHistory } from '../server/store/review-history.js';

const clauseTypes = JSON.parse(readFileSync(new URL('../data/clause-types.json', import.meta.url), 'utf8'));

test('the bulk list: the clause and each new paragraph, in document order; one edit stays one click; insertions only in Word', () => {
  const f = { paragraphId: 'p5', insertAfter: [{ afterParagraphId: 'p5', text: 'New sentence.', anchored: true }, { afterParagraphId: 'p2', text: 'Earlier.', anchored: true }, { afterParagraphId: 'p9', text: 'Lost.', anchored: false }] };
  const order = id => Number(id.slice(1));
  const rows = planEdits(f, { replyText: 'p5 new', current: 'p5 old', insertions: true, order });
  assert.deepEqual(rows.map(r => [r.kind, r.paragraphId]), [['insert', 'p2'], ['replace', 'p5'], ['insert', 'p5']]);
  assert.equal(planEdits(f, { replyText: 'p5 new', current: 'p5 old', insertions: false, order }).length, 1, 'the browser applies the clause only');
  assert.equal(planEdits({ paragraphId: 'p5' }, { replyText: 'p5 old', current: 'p5 old' }).length, 0, 'nothing differs');
  assert.deepEqual(planEdits({ paragraphId: 'p5' }, { deletes: true, current: 'p5 old' }).map(r => r.after), ['']);
});

test('the comment reply is composed by code: what changed, within 300 characters, and no playbook or rule id (audit finding 9)', () => {
  const before = 'Either party may terminate this Order Form by written notice. The Customer may terminate for convenience on 30 days\' notice.';
  const after = 'Either party may terminate this Order Form by written notice. Neither party may terminate for convenience during a Subscription Term.';
  const text = commentReplyText(before, after, 'TFC-01'); // a rule id handed in by an older caller is ignored
  assert.match(text, /^Changed: “.*The Customer may terminate.*” to “.*Neither party may terminate.*”\.$/);
  assert.equal(commentReplyText('', 'A new paragraph.'), 'Changed: added “A new paragraph.”.');
  assert.equal(commentReplyText('Old clause.', ''), 'Changed: deleted “Old clause.”.');
  const long = commentReplyText('x '.repeat(400), 'y '.repeat(400));
  assert.ok(long.length <= 300);
  for (const t of [text, long]) { assert.doesNotMatch(t, /playbook/i); assert.doesNotMatch(t, /TFC-01|[A-Z]{1,5}-\d{2}/); }
  const comments = [{ id: 'c1', paragraphIndex: 3, resolved: true }, { id: 'c2', paragraphIndex: 3, resolved: false }];
  assert.equal(threadFor(comments, 3).id, 'c2'); assert.equal(threadFor(comments, 4), null); assert.equal(threadFor(null, 3), null);
});

test('comment_replied is a review event with the rule and clause type, kept in the document\'s review history', async () => {
  const review = { id: 'rev-r', playbook: { id: 'order-form' }, playbookVersion: 1, model: {}, findings: [{ id: 'f1', status: 'attention', ruleIds: ['TFC-01'], paragraphId: 'p11', evidence: [{ paragraphId: 'p11', quote: 'q' }] }] };
  const e = decisionEvent('replied', { review, finding: review.findings[0], clauseTypes, commentId: 'c7', text: 'Changed: “a” to “b”. Playbook TFC-01.' });
  assert.deepEqual(e, { type: 'comment_replied', payload: { reviewId: 'rev-r', findingId: 'f1', ruleId: 'TFC-01', clauseType: 'cuad:termination-for-convenience', paragraphId: 'p11', commentId: 'c7', text: 'Changed: “a” to “b”. Playbook TFC-01.' } });
  const history = openReviewHistory();
  history.append(7, [...reviewBatch(review, { clauseTypes }), e], 'lawyer');
  assert.deepEqual(history.list(7).map(x => [x.type, x.actor]), [['review_run', 'lawyer'], ['finding_flagged', 'lawyer'], ['comment_replied', 'lawyer']]);
  assert.equal(history.list(7)[2].payload.clauseType, 'cuad:termination-for-convenience');
  history.close();
});

// ---- Word calls against minimal API fakes ----
function wordFake({ paragraphs, comments = [], uniqueIds = true }) {
  const log = [];
  const para = (i) => ({ get text() { return paragraphs[i]; }, uniqueLocalId: uniqueIds ? `u${i}` : undefined, load() { return this; },
    insertParagraph(text) { paragraphs.splice(i + 1, 0, text); log.push(['insertParagraph', text, document.changeTrackingMode]); return { ...para(i + 1), getRange: () => ({ insertBookmark: name => log.push(['bookmark', name]) }) }; } });
  const body = {
    paragraphs: { get items() { return paragraphs.map((_, i) => para(i)); }, load() { return this; } },
    getComments() { return { items: comments.map(c => ({ ...c, load() { return this; }, getRange: () => ({ paragraphs: { getFirst: () => para(c.at) } }), reply(text) { log.push(['reply', c.id, text]); } })), load() { return this; } }; },
  };
  const document = { changeTrackingMode: 'Off', load() { return this; } };
  return { api: { context: { sync: async () => {} }, body, document }, log, paragraphs };
}

test('Word: comments are read with their paragraph; a reply goes to the named thread', async () => {
  const w = wordFake({ paragraphs: ['Title', 'Same', 'Clause six.', 'Same'], comments: [{ id: 'c1', authorName: 'D. Osei', content: 'Why?', resolved: false, at: 2 }, { id: 'c2', authorName: 'X', content: 'Dup', resolved: true, at: 3 }] });
  assert.deepEqual(await readCommentsWith(w.api, { uniqueIds: true }), [{ id: 'c1', author: 'D. Osei', text: 'Why?', resolved: false, paragraphIndex: 2 }, { id: 'c2', author: 'X', text: 'Dup', resolved: true, paragraphIndex: 3 }]);
  const plain = wordFake({ paragraphs: ['Title', 'Same', 'Clause six.', 'Same'], comments: [{ id: 'c2', content: 'Dup', at: 3 }, { id: 'c1', content: 'Why?', at: 2 }], uniqueIds: false });
  assert.deepEqual((await readCommentsWith(plain.api)).map(c => c.paragraphIndex), [null, 2], 'by text when Word has no paragraph ids: a repeated text is not guessed');
  await replyWith(w.api, { commentId: 'c1', text: 'Changed.' });
  assert.deepEqual(w.log, [['reply', 'c1', 'Changed.']]);
  await assert.rejects(replyWith(w.api, { commentId: 'gone', text: 'x' }), /no longer in the document/);
});

test('Word: a new paragraph goes in after its anchor as a tracked insertion, bookmarked, and tracking is restored', async () => {
  const w = wordFake({ paragraphs: ['One.', 'Anchor clause.', 'Three.'] });
  const r = await insertParagraphTracked(w.api, { anchorText: 'Anchor clause.', paragraphIndex: 7, text: 'Inserted.' }); // a stale index falls back to the text
  assert.deepEqual(w.paragraphs, ['One.', 'Anchor clause.', 'Inserted.', 'Three.']);
  assert.deepEqual([r.verified, r.paragraphIndex], [true, 2]);
  assert.deepEqual(w.log.map(x => x.slice(0, 1).concat(x[0] === 'insertParagraph' ? [x[2]] : [])), [['insertParagraph', 'TrackAll'], ['bookmark']]);
  assert.equal(w.api.document.changeTrackingMode, 'Off');
  await assert.rejects(insertParagraphTracked(w.api, { anchorText: 'Missing.', text: 'x' }), /could not be located/);
  await assert.rejects(insertParagraphTracked(w.api, { anchorText: 'One.', text: 'two\nlines' }), /one new paragraph/);
});

// ---- the record side ----
