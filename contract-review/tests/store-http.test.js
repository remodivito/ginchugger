// SPDX-License-Identifier: GPL-3.0-or-later
// The store's HTTP routes for the phase 2 screens (server/store/http.js; tasks/paperless-store-plan.md tasks 4–7),
// against the in-memory fake behind the real store service, so no Docker is needed: the Inbox (upload lands in the
// inbox, duplicates flagged, Done, Not a contract), the Library (filters, full-text search with highlights, sort,
// paging), one document (labels, notes, history, similar, original, preview, email, our own text), the trash with our
// rules (signed and on hold stay out; holds are for admins), and the activity built from recent documents' histories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { storeConfig, createStoreService } from '../server/store/service.js';
import { storeRoutes, labelPatch, libraryFilters } from '../server/store/http.js';
import { docx } from './fixtures/record/helpers.js';

const quiet = { log() {}, error() {} };
const ADA = { id: 'ada', name: 'Ada', admin: true };
const BEN = { id: 'ben', name: 'Ben', admin: false };

async function serve({ mode = 'fake' } = {}) {
  const svc = createStoreService({ config: storeConfig({ dataDir: mkdtempSync(path.join(tmpdir(), 'gcl-store-http-')), env: { GCL_STORE: mode } }), log: quiet });
  await svc.start();
  let who = ADA;
  const app = express(); app.use(express.json()); app.use('/api/v2/store', storeRoutes(svc, { actor: () => who, log: quiet }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v2/store`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const upload = async (...files) => {
    const form = new FormData();
    for (const [name, content] of files) form.append('file', new Blob([content]), name);
    const r = await fetch(`${base}/documents`, { method: 'POST', body: form });
    return { status: r.status, body: await r.json() };
  };
  // The fake's tasks finish at once; the route forgets them on the next tick.
  const settle = () => new Promise(r => setTimeout(r, 5));
  return { svc, call, upload, settle, as: a => { who = a; }, close: () => server.close() };
}

test('an upload lands in the inbox with the inbox tag; the same bytes again are flagged as duplicates', async () => {
  const s = await serve();
  try {
    const up = await s.upload(['NDA Corrigan.txt', 'Mutual NDA between Helix and Corrigan. Term: three years.'], ['Order form.txt', 'Order Form. Fees: 12,000 a year.']);
    assert.equal(up.status, 202);
    assert.deepEqual(up.body.tasks.map(t => t.filename), ['NDA Corrigan.txt', 'Order form.txt']);
    await s.settle();
    let inbox = (await s.call('GET', '/inbox')).body;
    assert.equal(inbox.count, 2);
    assert.deepEqual(inbox.processing, []);
    assert.deepEqual(inbox.documents.map(d => d.title), ['Order form', 'NDA Corrigan'], 'newest first');
    assert.ok(inbox.documents.every(d => d.inbox && d.tags.includes('inbox')));
    assert.deepEqual(inbox.documents[0].duplicates, []);

    await s.upload(['copy.txt', 'Order Form. Fees: 12,000 a year.']); await s.settle();
    inbox = (await s.call('GET', '/inbox')).body;
    assert.equal(inbox.documents[0].title, 'copy');
    assert.deepEqual(inbox.documents[0].duplicates.map(d => d.title), ['Order form']);
    assert.deepEqual((await s.call('GET', '/inbox?count=1')).body, { count: 3, processing: 0 });
    assert.equal((await s.upload()).status, 400);
  } finally { s.close(); }
});

test('a failed upload stays listed as processing with its error until it is dismissed', async () => {
  const s = await serve();
  try {
    s.svc.serviceClient().failNextTask('it is password protected');
    const up = await s.upload(['locked.docx', 'x']); await s.settle();
    const { processing } = (await s.call('GET', '/inbox')).body;
    assert.equal(processing.length, 1);
    assert.match(processing[0].error, /password protected/);
    await s.call('DELETE', `/processing/${up.body.tasks[0].taskId}`);
    assert.deepEqual((await s.call('GET', '/inbox')).body.processing, []);
  } finally { s.close(); }
});

test('Done saves the labels and removes the inbox tag; the labels offered are the store\'s own', async () => {
  const s = await serve();
  try {
    await s.upload(['nda.txt', 'Mutual NDA. Term: three years.']); await s.settle();
    const [doc] = (await s.call('GET', '/inbox')).body.documents;
    const done = await s.call('POST', `/documents/${doc.id}/done`, { title: 'Corrigan NDA', counterparty: 'Corrigan Ltd', type: 'NDA', created: '2026-05-01', tags: ['inbox', 'urgent'] });
    assert.equal(done.status, 200);
    assert.deepEqual({ title: done.body.title, counterparty: done.body.counterparty, type: done.body.type, created: done.body.created, tags: done.body.tags, inbox: done.body.inbox }, { title: 'Corrigan NDA', counterparty: 'Corrigan Ltd', type: 'NDA', created: '2026-05-01', tags: ['urgent'], inbox: false });
    assert.equal((await s.call('GET', '/inbox')).body.count, 0);
    const tax = (await s.call('GET', '/taxonomy')).body;
    assert.deepEqual(tax.counterparties, ['Corrigan Ltd']);
    assert.deepEqual(tax.types, ['NDA']);
    assert.ok(['signed', 'on hold', 'inbox', 'urgent'].every(t => tax.tags.includes(t)));
    // Done with no labels just files it.
    await s.upload(['b.txt', 'Another.']); await s.settle();
    const [b] = (await s.call('GET', '/inbox')).body.documents;
    assert.deepEqual((await s.call('POST', `/documents/${b.id}/done`, {})).body.tags, []);
    assert.equal((await s.call('PATCH', `/documents/${b.id}`, { created: '1 May' })).status, 400);
    assert.equal((await s.call('PATCH', `/documents/${b.id}`, { title: ' ' })).status, 400);
    assert.equal((await s.call('GET', '/documents/999')).status, 404);
  } finally { s.close(); }
});

test('Not a contract moves it to the trash; signed and on-hold documents are refused with the reason; restore brings it back', async () => {
  const s = await serve();
  try {
    await s.upload(['newsletter.txt', 'Our autumn newsletter.'], ['signed.txt', 'Signed order form.']); await s.settle();
    const [signed, letter] = (await s.call('GET', '/inbox')).body.documents;
    await s.call('PATCH', `/documents/${signed.id}`, { tags: ['inbox', 'signed'] });
    assert.deepEqual((await s.call('POST', `/documents/${letter.id}/trash`)).body, { ids: [letter.id] });
    const refused = await s.call('POST', `/documents/${signed.id}/trash`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'protected');
    assert.match(refused.body.error, /signed/);
    const trash = (await s.call('GET', '/trash')).body.items;
    assert.deepEqual(trash.map(d => d.title), ['newsletter']);
    assert.ok(trash[0].deletedAt);
    assert.equal((await s.call('GET', `/documents/${letter.id}`)).status, 404);
    assert.deepEqual((await s.call('POST', '/trash/restore', { ids: [letter.id] })).body, { ids: [letter.id] });
    assert.deepEqual((await s.call('GET', '/trash')).body.items, []);
    assert.equal((await s.call('GET', `/documents/${letter.id}`)).body.title, 'newsletter');
    assert.equal((await s.call('POST', '/trash/restore', {})).status, 400);
  } finally { s.close(); }
});

test('holds: only an admin sets or lifts one, by the hold route or by editing tags; a held document stays out of the trash', async () => {
  const s = await serve();
  try {
    await s.upload(['msa.txt', 'Master services agreement.']); await s.settle();
    const [d] = (await s.call('GET', '/inbox')).body.documents;
    s.as(BEN);
    assert.equal((await s.call('POST', `/documents/${d.id}/hold`, { on: true })).status, 403);
    assert.equal((await s.call('PATCH', `/documents/${d.id}`, { tags: ['inbox', 'on hold'] })).status, 403);
    s.as(ADA);
    assert.ok((await s.call('POST', `/documents/${d.id}/hold`, { on: true })).body.tags.includes('on hold'));
    s.as(BEN);
    const refused = await s.call('POST', `/documents/${d.id}/trash`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /on hold/);
    assert.equal((await s.call('PATCH', `/documents/${d.id}`, { tags: ['inbox'] })).status, 403, 'removing the hold by editing tags is refused too');
    assert.equal((await s.call('PATCH', `/documents/${d.id}`, { title: 'MSA', tags: ['inbox', 'on hold', 'urgent'] })).status, 200, 'other tags change freely');
    s.as(ADA);
    assert.ok(!(await s.call('POST', `/documents/${d.id}/hold`, { on: false })).body.tags.includes('on hold'));
    const held = (await s.call('GET', '/documents?tag=on%20hold')).body;
    assert.equal(held.count, 0);
  } finally { s.close(); }
});

test('Library: filters by counterparty, type, tags and dates; sorts; pages; full-text search returns highlighted snippets', async () => {
  const s = await serve();
  try {
    const docs = [
      ['a.txt', 'Northgate order form. Payment within 30 days.', { counterparty: 'Northgate', type: 'Order form', created: '2025-03-12', tags: ['signed'] }],
      ['b.txt', 'Northgate order form markup. Payment within 60 days.', { counterparty: 'Northgate', type: 'Order form', created: '2026-06-01', tags: [] }],
      ['c.txt', 'Corrigan mutual NDA. Term three years.', { counterparty: 'Corrigan', type: 'NDA', created: '2026-02-01', tags: [] }],
    ];
    for (const [name, text] of docs) await s.upload([name, text]);
    await s.settle();
    const all = (await s.call('GET', '/documents?sort=title')).body.results;
    for (const [i, [, , labels]] of docs.entries()) await s.call('POST', `/documents/${all[i].id}/done`, labels);

    const titles = async q => (await s.call('GET', `/documents?${q}`)).body.results.map(d => d.title);
    assert.deepEqual(await titles(''), ['b', 'c', 'a'], 'newest first by default');
    assert.deepEqual(await titles('counterparty=Northgate'), ['b', 'a']);
    assert.deepEqual(await titles('type=NDA'), ['c']);
    assert.deepEqual(await titles('tag=signed'), ['a']);
    assert.deepEqual(await titles('from=2026-01-01&to=2026-03-01'), ['c']);
    assert.deepEqual(await titles('sort=title'), ['a', 'b', 'c']);
    assert.deepEqual(await titles('counterparty=Nobody'), []);
    const page2 = (await s.call('GET', '/documents?sort=title&pageSize=2&page=2')).body;
    assert.deepEqual({ count: page2.count, page: page2.page, titles: page2.results.map(d => d.title) }, { count: 3, page: 2, titles: ['c'] });

    const found = (await s.call('GET', '/documents?q=payment&counterparty=Northgate')).body;
    assert.equal(found.count, 2);
    assert.ok(found.results.every(d => /<b>Payment<\/b>/.test(d.hit.highlights)));
    assert.equal((await s.call('GET', '/documents?q=payment&type=NDA')).body.count, 0, 'search keeps the filters');
    assert.equal((await s.call('GET', '/documents?from=March')).status, 400);
    assert.equal((await s.call('GET', '/documents?sort=size')).status, 400);
  } finally { s.close(); }
});

test('one document: notes added, listed and deleted; history names the lawyer; similar documents; original, preview and our own text', async () => {
  const s = await serve();
  try {
    await s.upload(['term.txt', 'Mutual confidentiality agreement. Term three years. Governing law England.'], ['other.txt', 'Confidentiality agreement with Velantis. Governing law England.']);
    await s.settle();
    const [, d] = (await s.call('GET', '/inbox')).body.documents;
    const notes = (await s.call('POST', `/documents/${d.id}/notes`, { text: 'Kept the three-year term.' })).body;
    assert.deepEqual(notes.map(n => [n.text, n.user]), [['Kept the three-year term.', 'ada']]);
    assert.equal((await s.call('POST', `/documents/${d.id}/notes`, { text: ' ' })).status, 400);
    assert.deepEqual((await s.call('DELETE', `/documents/${d.id}/notes/${notes[0].id}`)).body, []);
    const history = (await s.call('GET', `/documents/${d.id}/history`)).body;
    assert.deepEqual(history.map(h => Object.keys(h.changes)[0]), ['Note Deleted', 'Note Added', 'title']);
    assert.equal(history[0].actor, 'ada');
    assert.deepEqual((await s.call('GET', `/documents/${d.id}/similar`)).body.results.map(x => x.title), ['other']);

    const original = await s.call('GET', `/documents/${d.id}/original`);
    assert.equal(original.text, 'Mutual confidentiality agreement. Term three years. Governing law England.');
    assert.match(original.headers.get('content-disposition'), /^attachment; filename="term.txt"/);
    const preview = await s.call('GET', `/documents/${d.id}/preview`);
    assert.equal(preview.headers.get('content-type'), 'application/pdf');
    assert.equal(preview.headers.get('content-disposition'), 'inline');
    const text = (await s.call('GET', `/documents/${d.id}/paragraphs`)).body;
    assert.deepEqual(text.paragraphs, [{ id: 'p1', text: 'Mutual confidentiality agreement. Term three years. Governing law England.' }]);
    assert.equal((await s.call('GET', `/documents/${d.id}/email`)).body, null);
  } finally { s.close(); }
});

test('an email shows its sender, subject and date; a Word file gives our own paragraphs', async () => {
  const s = await serve();
  try {
    const eml = 'From: Priya Shah <priya@northgate.example>\r\nTo: legal@helix.example\r\nSubject: Order form markup\r\nDate: Thu, 4 Jun 2026 09:12:00 +0100\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease find our markup attached.';
    await s.upload(['markup.eml', eml], ['form.docx', await docx(['Order Form', 'Fees: 12,000 a year.'])]);
    await s.settle();
    const [word, mail] = (await s.call('GET', '/inbox')).body.documents;
    const e = (await s.call('GET', `/documents/${mail.id}/email`)).body;
    assert.deepEqual({ from: e.from, subject: e.subject, date: e.date, text: e.text }, { from: 'Priya Shah <priya@northgate.example>', subject: 'Order form markup', date: 'Thu, 4 Jun 2026 09:12:00 +0100', text: 'Please find our markup attached.' });
    assert.deepEqual((await s.call('GET', `/documents/${word.id}/paragraphs`)).body.paragraphs.map(p => p.text), ['Order Form', 'Fees: 12,000 a year.']);
  } finally { s.close(); }
});

test('activity: recent changes across documents, newest first, each naming its document; admins only', async () => {
  const s = await serve();
  try {
    await s.upload(['one.txt', 'One.'], ['two.txt', 'Two.']); await s.settle();
    const [two, one] = (await s.call('GET', '/inbox')).body.documents;
    await s.call('POST', `/documents/${one.id}/notes`, { text: 'Checked.' });
    await s.call('POST', `/documents/${two.id}/done`, { counterparty: 'Corrigan' });
    const a = (await s.call('GET', '/activity')).body;
    assert.equal(a.documents, 2);
    assert.deepEqual(a.items.map(i => [i.document.title, Object.keys(i.changes).sort().join(',')]).slice(0, 2), [['two', 'counterparty,tags'], ['one', 'Note Added']]);
    assert.ok(a.items.every((x, i, all) => i === 0 || all[i - 1].at >= x.at));
    s.as(BEN);
    assert.equal((await s.call('GET', '/activity')).status, 403);
  } finally { s.close(); }
});

test('with the store off every screen route answers 503 store_unavailable; the status still answers', async () => {
  const s = await serve({ mode: 'off' });
  try {
    for (const p of ['/inbox', '/documents', '/trash', '/taxonomy']) {
      const r = await s.call('GET', p);
      assert.deepEqual([r.status, r.body.code], [503, 'store_unavailable'], p);
    }
    assert.equal((await s.call('GET', '/status')).body.state, 'off');
  } finally { s.close(); }
});

test('labelPatch and libraryFilters check what a request may send', () => {
  assert.deepEqual(labelPatch({ title: ' X ', counterparty: '', type: null, tags: ['a', 'A', ' b '], created: '2026-01-02', other: 1 }), { title: 'X', counterparty: null, type: null, tags: ['A', 'b'], created: '2026-01-02' });
  assert.throws(() => labelPatch({ tags: 'a' }), /list of names/);
  assert.throws(() => labelPatch({ counterparty: 3 }), /is a name/);
  assert.deepEqual(libraryFilters({ tag: ['a', 'b,c'], counterparty: 'N', from: '2026-01-01' }), { sort: undefined, page: undefined, pageSize: undefined, counterparty: 'N', tags: ['a', 'b', 'c'], createdFrom: '2026-01-01' });
});
