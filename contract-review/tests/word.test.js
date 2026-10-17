// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, applyTracked, searchNeedle, searchTail, bookmarkName, initializeWord, OFFICE_JS } from '../src/word.js';

// A small fake of the Word object model: enough to exercise locate/apply without Word.
function fakeWord(paragraphTexts, { trackedOn = [] } = {}) {
  const log = [];
  const context = { sync: async () => { log.push('sync'); } };
  const doc = { changeTrackingMode: 'Off', load() {} };
  const settingsStore = {}; const settings = { get: k => settingsStore[k], set: (k, v) => { settingsStore[k] = v; }, saveAsync: cb => cb({ status: 'succeeded' }) };
  const paragraphs = paragraphTexts.map((text, i) => makeParagraph(text, i));
  function makeParagraph(text, i) {
    const p = { text, index: i, load() {}, search(needle, opts) { return makeResults(findAll(p, needle), p); } };
    return p;
  }
  function findAll(p, needle) { const hits = []; let from = 0; while (true) { const at = p.text.indexOf(needle, from); if (at < 0) break; hits.push(at); from = at + 1; } return hits.map(at => makeRange(p, at, needle.length)); }
  function makeRange(p, at, len) {
    return { paragraphs: { getFirst: () => p }, _p: p, _at: at, _len: len,
      getTrackedChanges() { const items = trackedOn.includes(p.index) ? [{}] : []; return { items, load() {} }; },
      insertBookmark(name) { log.push(`bookmark:${name}`); },
      insertText(text, where) { log.push(`insert:${where}`); p.text = p.text.slice(0, at + len) + text + p.text.slice(at + len); return { insertBookmark(name) { log.push(`bookmark-on-new:${name}`); } }; },
      delete() { log.push('delete'); p.text = p.text.slice(0, at) + p.text.slice(at + len); },
      select() { log.push('select'); },
      search(needle) { const hits = []; let from = at; while (true) { const i = p.text.indexOf(needle, from); if (i < 0 || i + needle.length > at + len) break; hits.push(makeRange(p, i, needle.length)); from = i + 1; } return makeResults(hits); },
      expandTo(other) { return makeRange(p, at, other._at + other._len - at); } };
  }
  function makeResults(items) { return { items, load() {} }; }
  const body = { paragraphs: { items: paragraphs, load() {} }, search(needle) { return makeResults(paragraphs.flatMap(p => findAll(p, needle))); } };
  Object.defineProperty(doc, 'changeTrackingMode', { get() { return doc._m || 'Off'; }, set(v) { doc._m = v; log.push(`mode:${v}`); } });
  return { api: { context, document: doc, body, settings }, log, settingsStore, paragraphs };
}

test('searchNeedle respects Word’s 255-character search limit at a word boundary', () => {
  assert.equal(searchNeedle('short quote'), 'short quote');
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const n = searchNeedle(long); assert.ok(n.length <= 255 && !n.endsWith(' ') && long.startsWith(n));
});

test('locate: unique hit in the paragraph, falling back to the document; zero or ambiguous hits are warnings', async () => {
  const { api } = fakeWord(['Preamble.', 'The term is three (3) years after termination.', 'Each party uses reasonable care.']);
  const r = await locate(api, { quote: 'three (3) years', paragraphIndex: 1 }); assert.equal(r.where, 'paragraph'); assert.equal(r.paragraph.index, 1);
  const r2 = await locate(api, { quote: 'reasonable care' }); assert.equal(r2.where, 'document');
  await assert.rejects(locate(api, { quote: 'seven (7) years', paragraphIndex: 1 }), /could not be located/);
  const dup = fakeWord(['the fee the fee']); await assert.rejects(locate(dup.api, { quote: 'the fee', paragraphIndex: 0 }), /more than once/);
});

test('apply: tracks in its own step, inserts then deletes, restores the mode, anchors the new wording with a hidden bookmark, writes nothing to the document\'s settings, verifies', async () => {
  const w = fakeWord(['Heading', 'Confidentiality lasts seven (7) years after termination.']);
  const out = await applyTracked(w.api, { findingId: 'f-1', quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 1 });
  assert.equal(out.applied, true); assert.equal(out.verified, true); assert.match(out.bookmark, /^_m_[a-z0-9]+$/); assert.ok(!out.bookmark.includes('f1'), 'the bookmark name does not carry the finding id');
  assert.equal(w.paragraphs[1].text, 'Confidentiality lasts five (5) years after termination.');
  const i = n => w.log.indexOf(n);
  assert.ok(i('mode:TrackAll') < i('insert:After') && i('insert:After') < i('delete'), 'track, insert after, then delete');
  assert.ok(w.log.lastIndexOf('mode:Off') > i('delete'), 'mode restored after the edit');
  assert.ok(i('bookmark-on-new:' + out.bookmark) > i('delete'), 'bookmark placed on the inserted wording, after the delete');
  assert.ok(!w.log.includes('bookmark:' + out.bookmark), 'the deleted run is not bookmarked');
  assert.deepEqual(w.settingsStore, {}, 'no registry or any other setting is written into the document');
});

test('apply lands on top of existing tracked changes with a warning, and refuses multi-paragraph text', async () => {
  const over = fakeWord(['Term: seven (7) years.'], { trackedOn: [0] });
  const out = await applyTracked(over.api, { findingId: 'f', quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 0 });
  assert.equal(out.applied, true); assert.equal(out.overRevisions, true); assert.match(out.warning, /on top of existing tracked changes/); assert.equal(over.paragraphs[0].text, 'Term: five (5) years.');
  const ok = fakeWord(['Term: seven (7) years.'], { trackedOn: [] });
  const clean = await applyTracked(ok.api, { findingId: 'f', quote: 'seven (7) years', replacement: 'five (5) years', paragraphIndex: 0 }); assert.equal(clean.verified, true); assert.equal(clean.warning, null);
  await assert.rejects(applyTracked(ok.api, { findingId: 'f', quote: 'x', replacement: 'a\nb' }), /one paragraph/);
});

test('apply: a changed passage is a warning and no edit', async () => {
  const w = fakeWord(['Term: seven (7) years, as amended by hand.']);
  await assert.rejects(applyTracked(w.api, { findingId: 'f', quote: 'Term: seven (7) years.', replacement: 'x', paragraphIndex: 0 }), /could not be located|wording has changed/);
  assert.equal(w.log.filter(l => l.startsWith('insert')).length, 0);
});

test('bookmark names are hidden (underscore), alphanumeric, within Word’s 40-character limit and say nothing about the review', () => {
  const n = bookmarkName();
  assert.ok(n.startsWith('_m_') && n.length <= 40 && /^[A-Za-z0-9_]+$/.test(n), n);
  assert.notEqual(bookmarkName(), n, 'names do not repeat');
});

test('initializeWord loads Office.js when opened by Word (?host=) and resolves with detectWord', async () => {
  const appended = [];
  globalThis.location = { search: '?host=word' };
  globalThis.document = { createElement: () => ({}), head: { appendChild(script) { appended.push(script.src); globalThis.Office = { onReady: cb => cb(), context: { document: {} } }; globalThis.Word = {}; script.onload(); } } };
  try { assert.equal(await initializeWord(), true); assert.deepEqual(appended, [OFFICE_JS]); }
  finally { delete globalThis.Office; delete globalThis.Word; delete globalThis.document; delete globalThis.location; }
});

test('apply strikes only the changed words when they are named and found once inside their context', async () => {
  const w = fakeWord(['Confidentiality lasts for 7 years and trade secrets for 7 more.']);
  const out = await applyTracked(w.api, { findingId: 'f', quote: 'lasts for 7 years', replacement: 'lasts for 5 years', inner: '7', innerReplacement: '5', paragraphIndex: 0 });
  assert.equal(out.verified, true); assert.equal(w.paragraphs[0].text, 'Confidentiality lasts for 5 years and trade secrets for 7 more.');
  // When the changed words are not unique inside the context, the context as a whole is replaced.
  const v = fakeWord(['The fee is 7 and the cap is 7 times the fee.']);
  await applyTracked(v.api, { findingId: 'f', quote: 'is 7 and the cap is 7 times', replacement: 'is 5 and the cap is 5 times', inner: '7', innerReplacement: '5', paragraphIndex: 0 });
  assert.equal(v.paragraphs[0].text, 'The fee is 5 and the cap is 5 times the fee.');
});

test('a passage longer than one Word search is replaced whole or not at all, never in part', async () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + '.';
  const w = fakeWord([long]);
  await applyTracked(w.api, { findingId: 'f', quote: long, replacement: 'Short now.', paragraphIndex: 0 });
  assert.equal(w.paragraphs[0].text, 'Short now.', 'the whole passage went, not just its first 255 characters');
  // If the end of the passage cannot be placed (here it occurs twice), nothing is edited.
  const twice = fakeWord([long + ' ' + searchTail(long)]);
  await assert.rejects(applyTracked(twice.api, { findingId: 'f', quote: long, replacement: 'Short now.', paragraphIndex: 0 }), /too long to place exactly/);
  assert.equal(twice.log.filter(l => l.startsWith('insert') || l === 'delete').length, 0);
});

test('an addition is inserted after its anchor words and nothing is struck', async () => {
  const w = fakeWord(['Obligations continue while the information remains a trade secret.']);
  const out = await applyTracked(w.api, { findingId: 'f', quote: 'trade secret.', replacement: 'trade secret. This applies to both parties.', insertAfter: ' This applies to both parties.', paragraphIndex: 0 });
  assert.equal(out.verified, true); assert.equal(w.paragraphs[0].text, 'Obligations continue while the information remains a trade secret. This applies to both parties.');
  assert.ok(!w.log.includes('delete'), 'no deletion is made');
});

test('plainError turns Word error codes into sentences and keeps the app\'s own messages', async () => {
  const { plainError } = await import('../src/word.js');
  assert.equal(plainError(Object.assign(Error('SearchStringInvalidOrTooLong'), { code: 'SearchStringInvalidOrTooLong' })), 'Word could not search for that passage. Apply the wording in Word by hand.');
  assert.equal(plainError(Error('SomeNewWordCode')), 'Word could not make the change. Try again, or apply it by hand.');
  assert.equal(plainError(Object.assign(Error('Signed documents stay out of the trash.'), { code: 'protected', status: 409 })), 'Signed documents stay out of the trash.');
  assert.equal(plainError(Error('That passage could not be located in the document; it may have been edited. Rerun the review.')), 'That passage could not be located in the document; it may have been edited. Rerun the review.');
});
