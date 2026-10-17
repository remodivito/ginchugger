// SPDX-License-Identifier: GPL-3.0-or-later
// Loading the record into the document store (scripts/migrate-record-to-paperless.mjs; plan task 3), against the
// in-memory store that refuses JSON as Paperless does: every file becomes a document with its counterparty, type, date,
// tags, former matter and round, and notes; paragraph files become .docx; a second run adds nothing. The old record is
// tests/fixtures/old-record/ (a record.sqlite and files folder written by the record layer before decision 190 removed
// it; tests/fixtures/make-old-record.mjs), copied to a temporary folder for each test. Also --content-keys (task 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { planMigration, migrateRecord, retitleDocuments, setContentKeys, typeForKind, FIELD_MATTER, FIELD_ROUND, FIELD_SOURCE } from '../scripts/migrate-record-to-paperless.mjs';
import { createFakeStore, paperlessRejects } from '../server/store/fake.js';
import { CONTENT_KEY_FIELD } from '../server/store/index.js';
import { docx, tempDir } from './fixtures/record/helpers.js';

const sha = b => createHash('sha256').update(b).digest('hex');
const OLD = fileURLToPath(new URL('./fixtures/old-record/', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/old-record.json', import.meta.url), 'utf8'));

/** A copy of the old record (Northgate order form: v1 ours, v2 theirs with a covering email, signed, a matter note;
 *  Lantern NDA on hold with a paragraph-format round and a file kept without a round; a waiting inbox entry). */
async function sampleRecord() {
  const dataDir = tempDir('old-record-');
  cpSync(OLD, dataDir, { recursive: true });
  return { dataDir, shas: FIXTURE.shas, inboxId: FIXTURE.inboxId };
}
const open = dataDir => ({ db: new Database(path.join(dataDir, 'record.sqlite'), { readonly: true }), blobOf: s => { const f = path.join(dataDir, 'files', s.slice(0, 2), s); return existsSync(f) ? readFileSync(f) : null; } });

test('typeForKind: our kinds by name, others as words', () => {
  assert.deepEqual(['nda', 'order-form', 'supply-agreement', null].map(typeForKind), ['NDA', 'Order form', 'Supply agreement', null]);
});

test('planMigration: what each file becomes', async () => {
  const { dataDir, shas } = await sampleRecord();
  const { db, blobOf } = open(dataDir);
  const plan = Object.fromEntries(planMigration(db, blobOf).map(p => [p.sha256, p]));
  assert.equal(Object.keys(plan).length, 6);
  const kept = Object.values(plan).find(p => p.name === 'lantern-draft.docx');
  assert.deepEqual([kept.counterparty, kept.type, kept.tags, kept.fields[FIELD_MATTER], kept.fields[FIELD_ROUND]], ['Lantern Ltd', 'NDA', ['on hold'], 'Lantern NDA', undefined]);
  const v2 = plan[shas.v2];
  assert.deepEqual([v2.title, v2.counterparty, v2.type, v2.created, v2.tags], ['order-form-v2-markup', 'Northgate Biosciences Ltd', 'Order form', '2026-06-04', ['signed']]);
  assert.deepEqual(v2.fields, { [FIELD_SOURCE]: shas.v2, [FIELD_MATTER]: 'Northgate order form', [FIELD_ROUND]: '2, theirs' });
  assert.equal(v2.notes.length, 1, 'the matter\'s notes go on its latest file');
  assert.match(v2.notes[0], /^Kept the 60-day term\.\n\n\(Matter note by jane, /);
  assert.deepEqual(plan[shas.v1].tags, [], 'only the signed round is tagged signed');
  assert.deepEqual(plan[shas.v1].notes, []);
  const cover = plan[shas.cover];
  assert.deepEqual([cover.type, cover.created, cover.tags, cover.fields[FIELD_ROUND]], ['Email', '2026-06-04', [], '2, theirs, covering email']);
  assert.deepEqual([plan[shas.para].type, plan[shas.para].tags, plan[shas.para].counterparty], ['NDA', ['on hold'], 'Lantern Ltd']);
  const waiting = Object.values(plan).find(p => p.name === 'new-from-northgate.docx');
  assert.deepEqual([waiting.tags, waiting.fields[FIELD_MATTER]], [['inbox'], undefined]);
  db.close();
});

test('migrateRecord: every file in, byte-identical or converted, counts match; a second run adds nothing', async () => {
  const { dataDir, shas } = await sampleRecord();
  const { db, blobOf } = open(dataDir);
  const store = createFakeStore({ reject: paperlessRejects });
  const first = await migrateRecord({ db, blobOf, store });
  assert.deepEqual({ ...first.summary, byType: undefined, byCounterparty: undefined, byTag: undefined }, { filesInRecord: 6, added: 6, skipped: 0, failed: 0, missing: 0, byteIdentical: 5, converted: 1, convertedVerified: 1, verifyFailed: 0, notesAdded: 2, trashed: 0, inStore: 6, countsMatch: true, byType: undefined, byCounterparty: undefined, byTag: undefined });
  assert.deepEqual(first.summary.byTag, { signed: 1, 'on hold': 2, inbox: 1, '(none)': 2 });
  const signed = await store.list({ tags: ['signed'] });
  assert.deepEqual(signed.results.map(d => [d.title, d.counterparty, d.type, d.created]), [['order-form-v2-markup', 'Northgate Biosciences Ltd', 'Order form', '2026-06-04']]);
  assert.deepEqual((await store.notes.list(signed.results[0].id)).map(n => n.text.split('\n')[0]), ['Kept the 60-day term.']);
  const para = (await store.list({ fields: [[FIELD_SOURCE, 'exact', shas.para]] })).results[0];
  assert.equal(para.originalName, 'pilot-round-1.docx');
  const zip = await JSZip.loadAsync((await store.getOriginal(para.id)).body);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<w:del /); assert.match(xml, /Pay within 60 days\./);
  assert.match((await store.notes.list(para.id))[0].text, /Converted from the record's paragraph format/);
  for (const s of [shas.v1, shas.v2, shas.cover]) assert.equal(sha((await store.getOriginal((await store.findByChecksum(s)).id)).body), s);
  const again = await migrateRecord({ db, blobOf, store });
  assert.deepEqual([again.summary.added, again.summary.skipped, again.summary.countsMatch], [0, 6, true]);
  assert.equal((await store.list({ pageSize: 100 })).count, 6);
  db.close();
});

test('a missing blob is reported, not skipped silently', async () => {
  const { dataDir, shas } = await sampleRecord();
  const { db, blobOf } = open(dataDir);
  const r = await migrateRecord({ db, blobOf: s => (s === shas.v1 ? null : blobOf(s)), store: createFakeStore({ reject: paperlessRejects }) });
  assert.deepEqual([r.summary.missing, r.summary.countsMatch], [1, false]);
  db.close();
});

test('--retitle: titles lose their file extension, nothing else changes, and a second run changes nothing (fix A)', async () => {
  const store = createFakeStore();
  const a = await store.add(Buffer.from('one'), { filename: 'northgate-v2.docx', title: 'northgate-v2.docx', counterparty: 'Northgate Biosciences Ltd' });
  const b = await store.add(Buffer.from('two'), { filename: 'round-3.docx', title: 'demo-round-3.json' });
  const c = await store.add(Buffer.from('three'), { filename: 'x.docx', title: 'Helix / Northgate order form (demo fixture)' });
  const first = await retitleDocuments(store);
  assert.deepEqual(first.retitled.map(r => [r.id, r.to]).sort((x, y) => x[0] - y[0]), [[a.id, 'northgate-v2'], [b.id, 'demo-round-3']]);
  assert.deepEqual([(await store.getDocument(a.id)).title, (await store.getDocument(a.id)).counterparty, (await store.getDocument(c.id)).title], ['northgate-v2', 'Northgate Biosciences Ltd', 'Helix / Northgate order form (demo fixture)']);
  assert.deepEqual((await retitleDocuments(store)).retitled, []);
});

test('--content-keys: every live Word document gets the content key of its words; a re-read copy gets the same key; a second run changes nothing', async () => {
  const store = createFakeStore();
  const a = await store.add(await docx(['Order Form', { was: 'Pay within 30 days.', text: 'Pay within 60 days.' }]), { filename: 'northgate-v2.docx', title: 'northgate-v2' });
  const b = await store.add(await docx(['Order Form', { was: 'Pay within 30 days.', text: 'Pay within 60 days.' }], { stamp: 'word read it again' }), { filename: 'northgate-v2.docx', title: 'northgate-v2' });
  const c = await store.add(await docx(['Order Form', 'Pay within 45 days.']), { filename: 'northgate-v3.docx', title: 'northgate-v3' });
  const e = await store.add(Buffer.from('From: a@b.example\r\nSubject: x\r\n\r\nHello'), { filename: 'cover.eml', title: 'cover' });
  const first = await setContentKeys(store);
  assert.deepEqual([first.checked, first.set.length, first.unchanged, first.failed.length], [3, 3, 0, 0]);
  const key = async id => (await store.getDocument(id)).fields[CONTENT_KEY_FIELD];
  assert.match(await key(a.id), /^[0-9a-f]{64}$/);
  assert.equal(await key(a.id), await key(b.id), 'the same words with new bytes: the same key');
  assert.notEqual(await key(a.id), await key(c.id));
  assert.equal(await key(e.id), undefined, 'an email has no content key');
  const again = await setContentKeys(store);
  assert.deepEqual([again.set.length, again.unchanged], [0, 3]);
});
