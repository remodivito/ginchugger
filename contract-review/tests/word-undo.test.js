// SPDX-License-Identifier: GPL-3.0-or-later
// Undo from the pane (17 Oct 2026): undoTracked rejects exactly the tracked changes the pane made for one point, against
// the same Office.js fake the e2e tests use. The counterparty's revisions are never touched; a bookmark gone, wording
// edited by hand or more candidates than ours refuses before anything is rejected; a bulk point is undone all or none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installOfficeFake } from './e2e/office-fake.js';
import { applyTracked, insertParagraphTracked, undoTracked, UNDO_EDITED, UNDO_IN_WORD } from '../src/word.js';

const CLAUSE = 'Confidentiality lasts seven (7) years after termination of this Agreement.';
const THEIRS = [{ text: 'The Recipient may keep copies ', state: 'n' }, { text: 'in routine backups ', state: 'ins', author: 'Counterparty', date: '2026-05-19T09:40:00Z' }, { text: 'for audit.', state: 'n' }];

function word(paragraphs, { author = 'Lawyer' } = {}) {
  const store = new Map();
  globalThis.window = globalThis;
  globalThis.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  installOfficeFake({ paragraphs: paragraphs.map(p => (typeof p === 'string' ? [{ text: p, state: 'n' }] : p)), author });
  let api; globalThis.Word.run(async context => { api = { context, document: context.document, body: context.document.body }; });
  return { api, w: globalThis.__word };
}
const apply = async (api, args) => { const r = await applyTracked(api, args); return { bookmark: r.bookmark, inserted: r.inserted, deleted: r.deleted }; };

test('Undo rejects our insertion and our deletion, removes the bookmark, and leaves the counterparty’s revision', async () => {
  const { api, w } = word(['Heading', CLAUSE, THEIRS]);
  const change = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 1 });
  assert.equal(w.changes().filter(c => c.author === 'Lawyer').length, 2);
  const r = await undoTracked(api, { changes: [change] });
  assert.deepEqual(r, { undone: true, rejected: 2 });
  assert.equal(w.texts()[1], CLAUSE);
  assert.deepEqual(w.changes().map(c => [c.author, c.type, c.text]), [['Counterparty', 'Added', 'in routine backups ']]);
  assert.deepEqual(w.bookmarks(), {});
});

test('a narrowed change and a single-bookmark call: only the words struck and inserted are rejected', async () => {
  const { api, w } = word([CLAUSE]);
  const change = await apply(api, { quote: 'seven (7) years after', replacement: 'five (5) years after', inner: 'seven (7)', innerReplacement: 'five (5)', paragraphIndex: 0 });
  assert.equal(change.deleted, 'seven (7)'); assert.equal(change.inserted, 'five (5)');
  await undoTracked(api, change);
  assert.equal(w.texts()[0], CLAUSE); assert.deepEqual(w.changes(), []);
});

test('our change over the counterparty’s insertion is undone; their insertion stays as it was', async () => {
  const { api, w } = word([THEIRS]);
  const change = await apply(api, { quote: 'in routine backups', replacement: 'in encrypted backups', paragraphIndex: 0 });
  await undoTracked(api, { changes: [change] });
  assert.equal(w.texts()[0], 'The Recipient may keep copies in routine backups for audit.');
  assert.deepEqual(w.changes().map(c => [c.author, c.type, c.text]), [['Counterparty', 'Added', 'in routine backups ']]);
});

test('refuses, and rejects nothing, when the bookmark is gone, the wording was edited, or the change was accepted', async () => {
  { const { api, w } = word([CLAUSE]); const change = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 0 });
    api.document.deleteBookmark(change.bookmark);
    await assert.rejects(undoTracked(api, { changes: [change] }), e => e.message === UNDO_EDITED && e.refused === true);
    assert.equal(w.changes().length, 2); }
  { const { api, w } = word([CLAUSE]); const change = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 0 });
    w.typeInto(0, 'five (5)', 'six (6)');
    await assert.rejects(undoTracked(api, { changes: [change] }), new RegExp(UNDO_EDITED.replace(/[.()]/g, '\\$&')));
    assert.ok(w.texts()[0].includes('six (6)')); }
  { const { api, w } = word([CLAUSE]); const change = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 0 });
    api.body.paragraphs.items[0].getTrackedChanges().items.find(c => c.type === 'Added').accept();
    await assert.rejects(undoTracked(api, { changes: [change] }), /edited in Word/);
    assert.equal(w.texts()[0], 'Confidentiality lasts five (5) years after termination of this Agreement.'); }
  { const { api } = word([CLAUSE]);
    await assert.rejects(undoTracked(api, { changes: [] }), e => e.message === UNDO_IN_WORD);
    await assert.rejects(undoTracked(api, { changes: [{ bookmark: null, inserted: '', deleted: 'x' }] }), e => e.message === UNDO_IN_WORD); }
});

const strikeByHand = (api, p, text, nth = 0) => { api.document.changeTrackingMode = 'TrackAll'; api.body.paragraphs.items[p].search(text).items[nth].delete(); api.document.changeTrackingMode = 'Off'; };

test('refuses when our deletion cannot be told apart: two identical deletions by the same author where we made one', async () => {
  const { api, w } = word(['Pay the fee within 30 days; the fee is due monthly.']);
  strikeByHand(api, 0, 'the fee', 1); // the lawyer strikes the second "the fee" in Word, with tracking on
  const change = await apply(api, { quote: 'the fee within', replacement: 'the charges within', inner: 'the fee', innerReplacement: 'the charges', paragraphIndex: 0 });
  assert.equal(change.deleted, 'the fee');
  const before = w.changes();
  await assert.rejects(undoTracked(api, { changes: [change] }), /edited in Word/);
  assert.deepEqual(w.changes(), before);
});

/** Word for Mac lists a deletion with no text (docs/WORD.md, 5 Oct 2026): the fake made to do the same. */
function deletionsWithoutText(api) {
  const real = api.document.getBookmarkRangeOrNullObject.bind(api.document);
  api.document.getBookmarkRangeOrNullObject = name => {
    const r = real(name); if (r.isNullObject) return r;
    const first = r.paragraphs.getFirst(); const list = first.getTrackedChanges.bind(first);
    first.getTrackedChanges = () => { const c = list(); c.items.forEach(x => { if (x.type === 'Deleted') x.text = ''; }); return c; };
    r.paragraphs = { getFirst: () => first }; return r;
  };
}

test('Word for Mac reports deletions with no text: ours are matched by count, and refused when the author has more', async () => {
  { const { api, w } = word([CLAUSE]);
    const change = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 0 });
    deletionsWithoutText(api);
    await undoTracked(api, { changes: [change] });
    assert.equal(w.texts()[0], CLAUSE); assert.deepEqual(w.changes(), []); }
  { const { api, w } = word([CLAUSE]);
    strikeByHand(api, 0, 'of this Agreement');
    const change = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 0 });
    deletionsWithoutText(api);
    const before = w.changes();
    await assert.rejects(undoTracked(api, { changes: [change] }), /edited in Word/);
    assert.deepEqual(w.changes(), before); }
});

test('a bulk point (the clause and a new paragraph) is undone all or none', async () => {
  { const { api, w } = word(['Heading', CLAUSE, 'Next clause.']);
    const a = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 1 });
    const r = await insertParagraphTracked(api, { anchorText: 'Confidentiality lasts five (5) years after termination of this Agreement.', paragraphIndex: 1, text: 'Backups are kept encrypted.' });
    const b = { bookmark: r.bookmark, inserted: r.inserted, deleted: r.deleted };
    assert.equal(w.texts().length, 4);
    const out = await undoTracked(api, { changes: [a, b] });
    assert.equal(out.rejected, 3);
    assert.deepEqual(w.texts(), ['Heading', CLAUSE, 'Next clause.']); assert.deepEqual(w.changes(), []); assert.deepEqual(w.bookmarks(), {}); }
  { const { api, w } = word(['Heading', CLAUSE, 'Next clause.']);
    const a = await apply(api, { quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 1 });
    const r = await insertParagraphTracked(api, { anchorText: 'Confidentiality lasts five (5) years after termination of this Agreement.', paragraphIndex: 1, text: 'Backups are kept encrypted.' });
    w.typeInto(2, 'encrypted', 'offline'); // the new paragraph edited by hand
    const before = w.changes();
    await assert.rejects(undoTracked(api, { changes: [a, { bookmark: r.bookmark, inserted: r.inserted, deleted: '' }] }), /edited in Word/);
    assert.deepEqual(w.changes(), before, 'nothing rejected, not even the clause change that could have been'); }
});
