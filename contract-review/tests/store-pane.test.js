// SPDX-License-Identifier: GPL-3.0-or-later
// The Word pane on the store (tasks/paperless-store-plan.md task 8; phase 2b fixes A and B), against the in-memory fake
// behind the real store service: opening a document finds it by its bytes (or its paragraphs' content key, since Word
// hands over new bytes on every read), else adds it to the inbox with the counterparty matching suggests; "Save as our
// reply" adds the version going back with the same counterparty and type; the review history is kept by store document
// id; Ask's context is the counterparty's other documents; titles carry no extension; the Library shows byte-identical
// documents as one row with its number of copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { storeConfig, createStoreService } from '../server/store/service.js';
import { storeRoutes, collapseCopies, CONTENT_KEY_FIELD } from '../server/store/http.js';
import { openReviewHistory, concessionNote, CONCESSION_QUOTE_MAX } from '../server/store/review-history.js';
import { counterpartyContext } from '../server/store/context.js';
import { titleFromName } from '../server/store/index.js';
import { createFakeStore } from '../server/store/fake.js';
import { docx } from './fixtures/record/helpers.js';

const quiet = { log() {}, error() {} };

async function serve({ ourNames = [], store: mode = 'fake', log = quiet } = {}) {
  const svc = createStoreService({ config: storeConfig({ dataDir: mkdtempSync(path.join(tmpdir(), 'gcl-store-pane-')), env: { GCL_STORE: mode } }), log: quiet });
  await svc.start();
  const reviews = openReviewHistory();
  const app = express(); app.use(express.json());
  app.use('/api/v2/store', storeRoutes(svc, { actor: () => ({ id: 'ada', name: 'Ada', admin: true }), log, reviews, ourNames: () => ourNames }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v2/store`;
  const send = async (p, file, name, fields = {}) => {
    const form = new FormData(); form.append('file', new Blob([file]), name);
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    const r = await fetch(base + p, { method: 'POST', body: form });
    return { status: r.status, body: await r.json() };
  };
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { store: mode === 'off' ? null : svc.serviceClient(), svc, send, call, close: () => server.close() };
}

test('titles carry no file extension (fix A)', () => {
  assert.equal(titleFromName('northgate-v2.docx'), 'northgate-v2');
  assert.equal(titleFromName('demo-round-3.json'), 'demo-round-3');
  assert.equal(titleFromName('Re: our markup.eml'), 'Re: our markup');
  assert.equal(titleFromName('Helix / Northgate order form (demo fixture)'), 'Helix / Northgate order form (demo fixture)');
  assert.equal(titleFromName('v1.2 terms'), 'v1.2 terms', 'a dot that is not a known extension stays');
  assert.equal(titleFromName('.docx'), 'Untitled');
});

test('opening a document the store does not hold adds it to the inbox, titled without the extension, with the counterparty matching names; nothing is asked', async () => {
  const s = await serve();
  try {
    await s.store.taxonomy.counterparties.create({ name: 'Northgate Biosciences Ltd' });
    await s.store.taxonomy.counterparties.create({ name: 'Brightwater Analytics Ltd' });
    const file = await docx(['Order Form', 'Customer: Northgate Biosciences Ltd.', 'Pay within 30 days.']);
    const r = await s.send('/pane/open', file, 'northgate-order-form.docx');
    assert.equal(r.status, 201);
    assert.equal(r.body.found, false);
    assert.deepEqual([r.body.document.title, r.body.document.counterparty, r.body.document.type, r.body.document.inbox], ['northgate-order-form', 'Northgate Biosciences Ltd', null, true]);
    assert.match(r.body.document.fields[CONTENT_KEY_FIELD], /^[0-9a-f]{64}$/);
    // The same bytes again: found, not added twice.
    const again = await s.send('/pane/open', file, 'northgate-order-form.docx');
    assert.deepEqual([again.status, again.body.found, again.body.document.id], [200, true, r.body.document.id]);
    // Word hands over new bytes on every read: the same paragraphs are the same document.
    const reread = await s.send('/pane/open', await docx(['Order Form', 'Customer: Northgate Biosciences Ltd.', 'Pay within 30 days.'], { stamp: 'word read 2' }), 'northgate-order-form.docx');
    assert.deepEqual([reread.body.found, reread.body.document.id], [true, r.body.document.id]);
    assert.equal((await s.store.list({})).count, 1);
  } finally { s.close(); }
});

test('opening by content key finds the labelled copy, as the Library shows it, not an unlabelled copy stored first (live bug 17 Oct: Ask saw no counterparty)', async () => {
  const s = await serve();
  try {
    const words = ['Order Form', 'Customer: Northgate Biosciences Ltd.', 'Pay within 90 days.'];
    // An unlabelled copy stored first (no counterparty is known yet, as with the migrated pane snapshots in the live store),
    // then the labelled one, then another unlabelled copy: same words, different bytes.
    const first = (await s.send('/pane/open', await docx(words, { stamp: 'a' }), 'northgate-v2.docx')).body.document;
    assert.equal(first.counterparty, null);
    const key = first.fields[CONTENT_KEY_FIELD];
    const labelled = await s.store.add(await docx(words, { stamp: 'b' }), { filename: 'markup.docx', title: 'markup', counterparty: 'Northgate Biosciences Ltd', type: 'Order form', fields: { [CONTENT_KEY_FIELD]: key } });
    await s.store.add(await docx(words, { stamp: 'c' }), { filename: 'northgate-v2.docx', title: 'northgate-v2', fields: { [CONTENT_KEY_FIELD]: key } });
    const r = (await s.send('/pane/open', await docx(words, { stamp: 'word read' }), 'northgate-v2.docx')).body;
    assert.deepEqual([r.found, r.document.id, r.document.counterparty], [true, labelled.id, 'Northgate Biosciences Ltd']);
  } finally { s.close(); }
});

test('opening: no counterparty when none or two match, ours never; a browser file is only looked up (add=false)', async () => {
  const s = await serve({ ourNames: ['Helix Instruments Ltd'] });
  try {
    for (const name of ['Northgate Biosciences Ltd', 'Brightwater Analytics Ltd', 'Helix Instruments Ltd']) await s.store.taxonomy.counterparties.create({ name });
    const two = await s.send('/pane/open', await docx(['Between Northgate Biosciences Ltd and Brightwater Analytics Ltd.']), 'three-way.docx');
    assert.equal(two.body.document.counterparty, null);
    const ours = await s.send('/pane/open', await docx(['Helix Instruments Ltd standard NDA.']), 'helix-nda.docx');
    assert.equal(ours.body.document.counterparty, null);
    const looked = await s.send('/pane/open', await docx(['Something else entirely.']), 'other.docx', { add: 'false' });
    assert.deepEqual([looked.status, looked.body], [200, { document: null, found: false }]);
    assert.equal((await s.store.list({})).count, 2);
  } finally { s.close(); }
});

test('"Save as our reply": a new document with the reviewed document\'s counterparty and type, out of the inbox, titled "<title> (our reply)"; without a source, the file name without extension', async () => {
  const s = await serve();
  try {
    const theirs = await s.store.add(await docx(['Order Form', 'Pay within 90 days.']), { filename: 'northgate-markup.docx', title: 'Northgate markup', counterparty: 'Northgate Biosciences Ltd', type: 'Order form', tags: ['inbox'] });
    const r = await s.send('/pane/save', await docx(['Order Form', 'Pay within 45 days.']), 'northgate-markup.docx', { sourceId: theirs.id });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.document.title, r.body.document.counterparty, r.body.document.type, r.body.document.tags, r.body.document.inbox], ['Northgate markup (our reply)', 'Northgate Biosciences Ltd', 'Order form', [], false]);
    assert.notEqual(r.body.document.id, theirs.id);
    const loose = await s.send('/pane/save', await docx(['Draft']), 'Our draft.docx');
    assert.deepEqual([loose.body.document.title, loose.body.document.counterparty, loose.body.document.inbox], ['Our draft', null, false]);
    const gone = await s.send('/pane/save', await docx(['Draft 2']), 'Draft 2.docx', { sourceId: 9999 });
    assert.equal(gone.body.document.title, 'Draft 2', 'a source no longer in the store is ignored');
  } finally { s.close(); }
});

test('the review history is kept by store document id, checked against the review events\' shapes', async () => {
  const s = await serve();
  try {
    const d = await s.store.add(Buffer.from('x'), { filename: 'a.txt' });
    const run = { type: 'review_run', payload: { reviewId: 'rev-1', playbookId: 'nda', round: null, findings: 2 } };
    const dismissed = { type: 'finding_dismissed', payload: { reviewId: 'rev-1', findingId: 'f1', ruleId: 'DUR-01', note: 'Accepted their wording', reason: 'accepted' } };
    assert.equal((await s.call('POST', `/documents/${d.id}/review-events`, { events: [run, dismissed] })).status, 201);
    const list = (await s.call('GET', `/documents/${d.id}/review-events`)).body;
    assert.deepEqual(list.map(e => [e.documentId, e.type, e.actor]), [[d.id, 'review_run', 'Ada'], [d.id, 'finding_dismissed', 'Ada']]);
    assert.deepEqual(list[1].payload, dismissed.payload);
    assert.equal((await s.call('POST', `/documents/${d.id}/review-events`, { events: [{ type: 'matter_created', payload: {} }] })).status, 400);
    assert.equal((await s.call('POST', `/documents/${d.id}/review-events`, { events: [{ type: 'finding_dismissed', payload: { reviewId: 'r', findingId: 'f', note: 'x', reason: 'because' } }] })).status, 400);
    assert.equal((await s.call('POST', `/documents/${d.id}/review-events`, { events: [{ type: 'finding_undismissed', payload: { reviewId: 'r', findingId: 'f', extra: 1 } }] })).status, 400);
    assert.equal((await s.call('GET', '/documents/0/review-events')).status, 404);
    assert.deepEqual((await s.call('GET', '/documents/77/review-events')).body, []);
  } finally { s.close(); }
});

test('a concession note: "Accept their wording" on <title>: "<their quote, trimmed>", and the lawyer\'s own reason if they wrote one; nothing else', () => {
  assert.equal(concessionNote({ reason: 'accepted', note: 'Accepted their wording', title: 'Liability cap', quote: '  The cap is\n 1x the fees. ' }), 'Accepted their wording on Liability cap: "The cap is 1x the fees."');
  assert.equal(concessionNote({ reason: 'accepted', note: 'Conceded 3x to close the quarter.', title: 'Liability cap', quote: '3x the fees' }), 'Accepted their wording on Liability cap: "3x the fees". Conceded 3x to close the quarter.');
  assert.equal(concessionNote({ reason: 'accepted', note: 'Accepted their wording' }), 'Accepted their wording.');
  const long = concessionNote({ reason: 'accepted', note: 'Accepted their wording', title: 'T', quote: 'word '.repeat(200) });
  assert.ok(long.length < CONCESSION_QUOTE_MAX + 40 && long.endsWith('…"'), long);
  assert.equal(concessionNote({ reason: 'not-an-issue', note: 'Not an issue', title: 'T', quote: 'q' }), null);
  assert.equal(concessionNote({ note: 'Agreed on the call.' }), null, 'a dismissal without a reason is not a concession');
});

test('"Accept their wording" puts the concession on the document as a store note written as the lawyer; undo deletes it; "Not an issue" adds none', async () => {
  const s = await serve();
  try {
    const d = await s.store.add(Buffer.from('x'), { filename: 'a.txt' });
    const flagged = { type: 'finding_flagged', payload: { reviewId: 'rev-1', findingId: 'f2', ruleId: 'CAP-01', title: 'Liability cap', quote: 'Liability is capped at 1x the fees.' } };
    const accepted = { type: 'finding_dismissed', payload: { reviewId: 'rev-1', findingId: 'f1', ruleId: 'DUR-01', note: 'Accepted their wording', reason: 'accepted', title: 'Term', quote: 'This agreement lasts two years.' } };
    const notAnIssue = { type: 'finding_dismissed', payload: { reviewId: 'rev-1', findingId: 'f3', note: 'Not an issue', reason: 'not-an-issue' } };
    assert.equal((await s.call('POST', `/documents/${d.id}/review-events`, { events: [flagged, accepted, notAnIssue] })).status, 201);
    const notes = async () => (await s.call('GET', `/documents/${d.id}/notes`)).body.map(n => [n.text, n.user]);
    assert.deepEqual(await notes(), [['Accepted their wording on Term: "This agreement lasts two years."', 'ada']]);
    // A dismissal without title or quote takes them from the point the review flagged; a reason typed is kept.
    await s.call('POST', `/documents/${d.id}/review-events`, { events: [{ type: 'finding_dismissed', payload: { reviewId: 'rev-1', findingId: 'f2', note: 'Agreed on the call.', reason: 'accepted' } }] });
    assert.deepEqual((await notes()).at(-1), ['Accepted their wording on Liability cap: "Liability is capped at 1x the fees." Agreed on the call.', 'ada']);
    // Undo deletes that point's note only; undoing a "Not an issue" changes nothing.
    await s.call('POST', `/documents/${d.id}/review-events`, { events: [{ type: 'finding_undismissed', payload: { reviewId: 'rev-1', findingId: 'f1' } }, { type: 'finding_undismissed', payload: { reviewId: 'rev-1', findingId: 'f3' } }] });
    assert.deepEqual((await notes()).map(n => n[0]), ['Accepted their wording on Liability cap: "Liability is capped at 1x the fees." Agreed on the call.']);
    // Accepting again after an undo adds it again, once.
    await s.call('POST', `/documents/${d.id}/review-events`, { events: [accepted] });
    await s.call('POST', `/documents/${d.id}/review-events`, { events: [accepted] });
    assert.equal((await notes()).filter(n => n[0].includes('on Term')).length, 1);
  } finally { s.close(); }
});

test('with no store, an accepted wording is still recorded in the review history and the answer is the same', async () => {
  const errors = [];
  const s = await serve({ store: 'off', log: { log() {}, error: m => errors.push(m) } });
  try {
    const accepted = { type: 'finding_dismissed', payload: { reviewId: 'rev-1', findingId: 'f1', note: 'Accepted their wording', reason: 'accepted', title: 'Term', quote: 'Two years.' } };
    const r = await s.call('POST', '/documents/5/review-events', { events: [accepted] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.events.map(e => [e.type, e.payload.reason]), [['finding_dismissed', 'accepted']]);
    assert.deepEqual((await s.call('GET', '/documents/5/review-events')).body.map(e => e.type), ['finding_dismissed']);
    assert.equal(errors.length, 1, 'logged on the server only');
  } finally { s.close(); }
});

test('the Library shows byte-identical documents as one row with its number of copies; nothing is deleted (fix B)', async () => {
  const s = await serve();
  try {
    const bytes = await docx(['Order Form v2']);
    for (let i = 0; i < 3; i++) await s.store.add(bytes, { filename: 'northgate-v2.docx' });
    await s.store.add(await docx(['Something else']), { filename: 'other.docx' });
    const page = (await s.call('GET', '/documents')).body;
    assert.deepEqual(page.results.map(d => [d.title, d.copies]), [['other', 1], ['northgate-v2', 3]]);
    assert.equal(page.count, 2, 'the rows shown, not the copies');
    assert.equal((await s.store.list({})).count, 4);
    // A copy in the trash is not counted.
    const [newest] = (await s.store.list({ title: 'northgate' })).results;
    await s.store.trash([newest.id]);
    assert.deepEqual((await s.call('GET', '/documents')).body.results.map(d => [d.title, d.copies]), [['other', 1], ['northgate-v2', 2]]);
    assert.deepEqual(collapseCopies({ count: 0, results: [] }).results, []);
  } finally { s.close(); }
});

test('Ask\'s context: the counterparty\'s other documents, newest first, our own text, signed ones marked, the open one left out, cut to the budget', async () => {
  const store = createFakeStore();
  const open = await store.add(await docx(['Order Form', 'Pay within 90 days.']), { filename: 'now.docx', counterparty: 'Northgate', created: '2026-06-04' });
  await store.add(await docx(['Order Form 2025', { was: 'Pay within 30 days.', text: 'Pay within 45 days.' }]), { filename: 'pilot.docx', counterparty: 'Northgate', created: '2025-03-10', tags: ['signed'] });
  await store.add(Buffer.from('From: a@northgate.example\r\nSubject: Re: pilot\r\n\r\nWe can live with 45 days.\r\n'), { filename: 'reply.eml', counterparty: 'Northgate', created: '2025-03-12', type: 'Email' });
  await store.add(await docx(['Unrelated']), { filename: 'other.docx', counterparty: 'Brightwater', created: '2026-01-01' });
  const items = await counterpartyContext(store, { counterparty: 'Northgate', exclude: [open.id] });
  assert.deepEqual(items.map(i => [i.title, i.created, i.signed, i.type]), [['reply', '2025-03-12', false, 'Email'], ['pilot', '2025-03-10', true, null]]);
  assert.match(items[1].text, /Pay within 45 days\.  \[tracked; before: Pay within 30 days\.\]/);
  assert.match(items[0].text, /We can live with 45 days/);
  const cut = await counterpartyContext(store, { counterparty: 'Northgate', exclude: [open.id], maxChars: 20 });
  assert.equal(cut.map(i => i.text).join('').length, 20);
  assert.deepEqual(await counterpartyContext(store, { counterparty: null }), []);
});

test('the Library collapses copies with the same words (Content key) as well as the same bytes; the labelled copy stands for them (task 11)', () => {
  const d = (id, extra) => ({ id, title: `d${id}`, checksum: `c${id}`, added: `2026-10-0${id}`, duplicates: [], fields: {}, ...extra });
  const page = { count: 5, results: [
    d(1, { fields: { [CONTENT_KEY_FIELD]: 'k' } }),
    d(2, { fields: { [CONTENT_KEY_FIELD]: 'k' }, counterparty: 'Northgate', type: 'Order form' }),
    d(3, { fields: { [CONTENT_KEY_FIELD]: 'other' } }),
    d(4, { checksum: 'c3' }),
    d(5, { fields: { [CONTENT_KEY_FIELD]: 'k' }, duplicates: [{ id: 9, title: 'x', deletedAt: null }] }),
  ] };
  const out = collapseCopies(page);
  assert.deepEqual(out.results.map(r => [r.id, r.copies, r.copyIds || null]), [[2, 4, [1, 2, 5, 9]], [3, 2, [3, 4]]]);
  assert.equal(out.count, 2);
});
