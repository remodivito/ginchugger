// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { markRange, searchTail, removeOurTraces, alignParagraphs, readWordDocument, wordIndexOf, deleteTracked } from '../src/word.js';

// Minimal Word fakes: paragraphs that can be searched, ranges that record highlight/select/delete.
function fake(texts, tracked = {}) {
  const log = [];
  const context = { sync: async () => {} };
  const paragraphs = texts.map((text, index) => {
    const p = { text, index, load() {},
      getTrackedChanges() { return { items: (tracked[index] || []).map(c => ({ ...c, reject() { log.push(`reject:${c.type}:${c.text}`); } })), load() {} }; },
      search(needle) { return results(p.text.includes(needle) ? [range(p)] : []); } };
    return p;
  });
  function range(p) { const r = { paragraphs: { getFirst: () => p }, highlight() { log.push(`highlight:${p.index}`); }, select(mode) { log.push(`select:${mode}`); }, expandTo() { log.push(`expand:${p.index}`); return r; }, delete() { log.push(`delete:${p.index}`); p.text = ''; } }; return r; }
  function results(items) { return { items, load() {} }; }
  const body = { paragraphs: { items: paragraphs, load() {} }, search: needle => results(paragraphs.filter(p => p.text.includes(needle)).map(range)) };
  const store = {}; const settings = { get: k => store[k], set: (k, v) => { store[k] = v; }, saveAsync: cb => cb() };
  const document = { deleteBookmark(name) { log.push(`deleteBookmark:${name}`); }, changeTrackingMode: 'Off', load() {} };
  Object.defineProperty(document, 'changeTrackingMode', { get() { return document._m || 'Off'; }, set(v) { document._m = v; log.push(`mode:${v}`); } });
  return { log, api: { context, body, document, settings }, store };
}

test('markRange highlights then moves the cursor to the start when WordApi 1.8 is available', async () => {
  const { api, log } = fake(['Preamble.', 'Confidentiality Period: five (5) years.']);
  const r = await markRange({ ...api, highlight: true, Word: { SelectionMode: { start: 'Start', select: 'Select' } } }, { quote: 'five (5) years', paragraphIndex: 1 });
  assert.equal(r.how, 'highlight');
  assert.deepEqual(log, ['highlight:1', 'select:Start']);
});

test('markRange falls back to selecting the passage below WordApi 1.8', async () => {
  const { api, log } = fake(['Confidentiality Period: five (5) years.']);
  const r = await markRange({ ...api, highlight: false, Word: { SelectionMode: { start: 'Start', select: 'Select' } } }, { quote: 'five (5)', paragraphIndex: 0 });
  assert.equal(r.how, 'select'); assert.deepEqual(log, ['select:Select']);
});

test('markRange refuses a passage it cannot find, and writes nothing', async () => {
  const { api, log } = fake(['Something else.']);
  await assert.rejects(markRange({ ...api, highlight: true }, { quote: 'five (5)' }), /could not be located/);
  assert.deepEqual(log, []);
});

test('alignParagraphs: same index when the text agrees, the one other match when it moved, null when it cannot be matched', () => {
  const server = [{ id: 'p1', text: 'Title' }, { id: 'p2', text: 'Term is  five years.' }, { id: 'p3', text: 'Moved clause.' }, { id: 'p4', text: 'Gone.' }, { id: 'p5', text: 'Twice.' }];
  const word = ['Title', 'Term is five years.', 'Twice.', 'Moved clause.', 'Twice.'];
  const a = alignParagraphs(server, word);
  assert.deepEqual(a.index, { p1: 0, p2: 1, p3: 3, p4: null, p5: 4 });
  assert.deepEqual([a.exact, a.moved, a.missing], [3, 1, 1]);
});

test('readWordDocument sends the open file through the importer, keeps tracked changes and maps paragraphs to Word; falls back to plain text with a warning', async () => {
  globalThis.Word = { run: async fn => fn({ document: { properties: { title: 'NDA', load() {} } }, sync: async () => {} }) };
  globalThis.Office = { context: { document: {} } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) }); // diagnostics are best effort
  try {
    const imported = { id: 'd1', title: 'file', paragraphs: [{ id: 'p1', text: 'Parties.' }, { id: 'p2', text: 'Seven (7) years.', originalText: 'Three (3) years.' }], warnings: [] };
    let sent = null;
    const doc = await readWordDocument({ readFile: async () => new Uint8Array([1, 2, 3]), importFile: async bytes => { sent = bytes; return imported; }, readTexts: async () => ['Parties.', 'Seven (7) years.'] });
    assert.equal(sent.length, 3); assert.equal(doc.tracked, true); assert.equal(doc.source, 'word'); assert.equal(doc.title, 'NDA');
    assert.equal(doc.paragraphs[1].originalText, 'Three (3) years.', 'the counterparty’s change reaches the review');
    assert.equal(wordIndexOf(doc, 'p2'), 1); assert.equal(doc.timing.exact, 2); assert.equal(doc.timing.missing, 0);
    const fallback = await readWordDocument({ readFile: async () => { throw new Error('no file'); }, importFile: async () => imported, readTexts: async () => ['Parties.', 'Seven (7) years.'] });
    assert.equal(fallback.tracked, false); assert.equal(fallback.paragraphs.length, 2); assert.equal(fallback.paragraphs[1].originalText, undefined);
    assert.match(fallback.warnings[0], /tracked changes were not read/); assert.equal(wordIndexOf(fallback, 'p2'), 1);
  } finally { delete globalThis.Word; delete globalThis.Office; delete globalThis.fetch; }
});

test('a quote longer than one Word search is marked to its end, not just its first 255 characters', async () => {
  const long = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ') + '.';
  assert.ok(long.length > 255);
  const tail = searchTail(long);
  assert.ok(tail.length <= 255 && long.endsWith(tail) && long[long.length - tail.length - 1] === ' ', 'the tail is the end of the quote, cut at a word');
  assert.equal(searchTail('short quote'), null);
  const { api, log } = fake(['Preamble.', long]);
  await markRange({ ...api, highlight: true, Word: { SelectionMode: { start: 'Start' } } }, { quote: long, paragraphIndex: 1 });
  assert.deepEqual(log, ['expand:1', 'highlight:1', 'select:Start']);
});

test('stepping quickly through points leaves exactly one passage marked: the last one asked for', async () => {
  const { markPassage, clearMark } = await import('../src/word.js');
  const live = new Set(); const order = [];
  const texts = ['Alpha clause.', 'Beta clause.', 'Gamma clause.'];
  const context = { sync: () => new Promise(r => setTimeout(r, 2)), trackedObjects: { add() {} } };
  const paragraphs = texts.map((text, index) => { const p = { text, index, load() {}, search: needle => ({ load() {}, items: text.includes(needle) ? [range(p)] : [] }) }; return p; });
  function range(p) { return { paragraphs: { getFirst: () => p }, highlight() { live.add(p.index); order.push(p.index); }, removeHighlight() { live.delete(p.index); }, untrack() {}, select() {}, load() {} }; }
  context.document = { body: { paragraphs: { items: paragraphs, load() {} }, search: () => ({ load() {}, items: [] }) } };
  const saved = { Word: globalThis.Word, Office: globalThis.Office, fetch: globalThis.fetch };
  globalThis.Word = { run: async (a, b) => (b || a)(context), SelectionMode: { start: 'Start', select: 'Select' } };
  globalThis.Office = { context: { host: 'Word', document: {}, requirements: { isSetSupported: () => true } }, HostType: { Word: 'Word' } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  try {
    const results = await Promise.all([markPassage('Alpha clause.', 0), markPassage('Beta clause.', 1), markPassage('Gamma clause.', 2)]);
    assert.deepEqual([...live], [2], 'only the last passage is still highlighted');
    assert.ok(results[1].superseded, 'a request overtaken before it started is skipped, not carried out late');
    assert.equal(results[2].marked, true);
    await clearMark();
    assert.equal(live.size, 0);
  } finally { Object.assign(globalThis, saved); }
});

test('an apply asked for while a mark is in flight starts only after the mark has finished', async () => {
  const { markPassage, applyWordReplacement } = await import('../src/word.js');
  const order = [];
  const slow = () => new Promise(r => setTimeout(r, 5));
  const saved = { Word: globalThis.Word, Office: globalThis.Office, fetch: globalThis.fetch };
  globalThis.Word = { run: async (a, b) => { const fn = b || a; const label = fn.toString().includes('applyTracked') ? 'apply' : 'mark'; order.push(`${label}:start`); await slow(); order.push(`${label}:end`); return { marked: true, applied: true }; }, SelectionMode: { start: 'Start' } };
  globalThis.Office = { context: { host: 'Word', document: {}, requirements: { isSetSupported: () => false } } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  try {
    await Promise.all([markPassage('Alpha clause.', 0), applyWordReplacement({ quote: 'Alpha', replacement: 'Beta' })]);
    assert.deepEqual(order, ['mark:start', 'mark:end', 'apply:start', 'apply:end']);
  } finally { Object.assign(globalThis, saved); }
});

test('before a version is sent, our hidden bookmarks and any old registry are removed; the other side’s bookmarks stay', async () => {
  const log = []; const store = { 'margin.anchors.v1': '{"f1":{"bookmark":"_m_f1_abc"}}', 'someone.elses': 'kept' };
  const api = { context: { sync: async () => {} },
    body: { getRange: where => ({ getBookmarks: (hidden, adjacent) => { log.push(`list:${where}:${hidden}:${adjacent}`); return { value: ['_m_f1_abc', '_Toc123', 'Signature', '_m_lz3k9a1b2c3'] }; } }) },
    document: { deleteBookmark: name => log.push(`delete:${name}`) },
    settings: { get: k => store[k], remove: k => { delete store[k]; }, saveAsync: cb => { log.push('settings-saved'); cb(); } } };
  const r = await removeOurTraces(api);
  assert.deepEqual(r, { bookmarks: 2, registry: true });
  assert.deepEqual(log, ['list:Whole:true:true', 'delete:_m_f1_abc', 'delete:_m_lz3k9a1b2c3', 'settings-saved']);
  assert.deepEqual(store, { 'someone.elses': 'kept' });
  const clean = await removeOurTraces({ ...api, body: { getRange: () => ({ getBookmarks: () => ({ value: ['_Toc123'] }) }) } });
  assert.deepEqual(clean, { bookmarks: 0, registry: false });
});

test('a proposed deletion strikes the whole clause with tracking on, restores the mode and confirms the wording is gone', async () => {
  const { api, log } = fake(['Preamble.', 'Industry Availability. Information generally available in the industry is excluded.']);
  const r = await deleteTracked(api, { quote: 'Industry Availability. Information generally available in the industry is excluded.', paragraphIndex: 1 });
  assert.deepEqual(log, ['mode:TrackAll', 'delete:1', 'mode:Off']); assert.equal(r.verified, true); assert.equal(r.bookmark, null);
  await assert.rejects(deleteTracked(fake(['Something else.']).api, { quote: 'Industry Availability.' }), /could not be located/);
});
