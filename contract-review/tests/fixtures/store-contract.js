// SPDX-License-Identifier: GPL-3.0-or-later
// The store interface's contract (server/store/index.js), run against the in-memory fake (tests/store-fake.test.js)
// and, when PAPERLESS_TEST_URL and PAPERLESS_TEST_TOKEN are set, against a real Paperless (tests/store-paperless-live.test.js).
// Every name it makes starts with a unique prefix, and it returns what it made so the caller can clean up.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const sha = b => createHash('sha256').update(b).digest('hex');
const admin = { actor: { id: 'contract-admin', admin: true } };
const lawyer = { actor: { id: 'contract-lawyer', admin: false } };

/** `t`: the node:test context (each operation is a subtest). `store`: a store with our rules. */
export async function storeContract(t, store) {
  const px = `p1-${randomBytes(3).toString('hex')}`;
  const made = { px, docs: [], counterparties: [`${px} Northgate`], types: [`${px} Order form`], tags: [`${px} reviewed`], fields: [`${px} Former matter`] };
  const word = `zq${randomBytes(4).toString('hex')}`; // a word no other document has, for search
  const fileA = Buffer.from(`Order Form ${px}\nThe Customer shall pay each undisputed invoice within 60 days. Marker ${word}.\nGoverning law: England.\n`);
  const fileB = Buffer.from(`Mutual NDA ${px}\nEach party keeps the other's confidential information secret for three years.\n`);
  let A, B;

  await t.test('health', async () => { assert.equal((await store.health()).ok, true); });

  await t.test('add waits for the task and keeps labels, fields and the original bytes', async () => {
    A = await store.add(fileA, { filename: `${px}-order-form.txt`, title: `${px} order form`, counterparty: made.counterparties[0], type: made.types[0], tags: ['inbox'], created: '2025-03-12T16:40:00Z', fields: { [made.fields[0]]: 'Helix / Northgate pilot' } }, lawyer);
    made.docs.push(A.id);
    assert.equal(A.title, `${px} order form`);
    assert.equal(A.counterparty, made.counterparties[0]);
    assert.equal(A.type, made.types[0]);
    assert.deepEqual(A.tags, ['inbox']);
    assert.equal(A.inbox, true);
    assert.equal(A.created, '2025-03-12');
    assert.deepEqual(A.fields, { [made.fields[0]]: 'Helix / Northgate pilot' });
    assert.equal(A.checksum, sha(fileA));
    assert.equal(A.originalName, `${px}-order-form.txt`);
    const o = await store.getOriginal(A.id);
    assert.equal(sha(o.body), sha(fileA), 'the original comes back byte-identical');
    assert.equal(o.filename, `${px}-order-form.txt`);
  });

  await t.test('addDocument answers a task id; waitForDocument gives the document', async () => {
    const { taskId } = await store.addDocument(fileB, { filename: `${px}-nda.txt`, title: `${px} nda`, counterparty: made.counterparties[0], created: '2026-06-01' }, lawyer);
    B = await store.getDocument((await store.waitForDocument(taskId)).id);
    made.docs.push(B.id);
    assert.equal(B.type, null);
  });

  await t.test('findByChecksum finds a document by its original\'s SHA-256', async () => {
    assert.equal((await store.findByChecksum(sha(fileA)))?.id, A.id);
    assert.equal(await store.findByChecksum('0'.repeat(64)), null);
  });

  await t.test('list filters by counterparty, type, tags, inbox, dates and custom fields, sorts and pages', async () => {
    const ids = r => r.results.map(d => d.id);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], sort: 'created' })), [A.id, B.id]);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], sort: '-created' })), [B.id, A.id]);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], type: made.types[0] })), [A.id]);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], inbox: true })), [A.id]);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], inbox: false })), [B.id]);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], tags: { none: ['inbox'] } })), [B.id]);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], createdFrom: '2026-01-01' })), [B.id]);
    assert.deepEqual(ids(await store.list({ counterparty: made.counterparties[0], createdTo: '2025-12-31' })), [A.id]);
    assert.deepEqual(ids(await store.list({ fields: [[made.fields[0], 'exact', 'Helix / Northgate pilot']] })), [A.id]);
    const p = await store.list({ counterparty: made.counterparties[0], sort: 'title', pageSize: 1, page: 2 });
    assert.equal(p.count, 2); assert.deepEqual(ids(p), [A.id]);
    assert.equal((await store.list({ counterparty: `${px} nobody` })).count, 0);
  });

  await t.test('search finds a word with a highlighted snippet; similar answers a page', async () => {
    // Paperless's index lags the task by up to a second or so (verified 16 Oct): poll briefly.
    let r; for (let i = 0; i < 20; i++) { r = await store.search(word); if (r.count) break; await new Promise(res => setTimeout(res, 500)); }
    assert.deepEqual(r.results.map(d => d.id), [A.id]);
    assert.match(r.results[0].hit.highlights, new RegExp(`<b>${word}</b>`, 'i'));
    const s = await store.similar(A.id);
    assert.ok(Array.isArray(s.results) && Number.isInteger(s.count));
  });

  await t.test('update changes labels and merges fields', async () => {
    const u = await store.update(A.id, { title: `${px} order form (signed)`, tags: ['inbox', 'signed'], fields: { [`${made.fields[0]}`]: 'Renamed matter' } }, lawyer);
    assert.equal(u.title, `${px} order form (signed)`);
    assert.deepEqual([...u.tags].sort(), ['inbox', 'signed']);
    assert.deepEqual(u.fields, { [made.fields[0]]: 'Renamed matter' });
  });

  await t.test('bulkUpdate applies to every document and is confirmed', async () => {
    assert.deepEqual(await store.bulkUpdate([A.id, B.id], { addTags: [made.tags[0]], removeTags: ['inbox'] }, lawyer), { ok: true, ids: [A.id, B.id] });
    assert.deepEqual([...(await store.getDocument(A.id)).tags].sort(), [made.tags[0], 'signed'].sort());
    assert.deepEqual((await store.getDocument(B.id)).tags, [made.tags[0]]);
  });

  await t.test('notes are added, listed and deleted', async () => {
    const after = await store.notes.add(A.id, 'Payment term kept at 60 days.', lawyer);
    assert.equal(after.length, 1); assert.equal(after[0].text, 'Payment term kept at 60 days.');
    assert.deepEqual((await store.notes.list(A.id)).map(n => n.text), ['Payment term kept at 60 days.']);
    await store.notes.delete(A.id, after[0].id);
    assert.deepEqual(await store.notes.list(A.id), []);
  });

  await t.test('history lists changes newest first', async () => {
    const h = await store.history(A.id);
    assert.ok(h.length >= 2);
    assert.ok(h[0].at >= h.at(-1).at);
    assert.ok(h.some(e => e.action === 'update'));
  });

  await t.test('trash: a signed document is refused; others go and come back', async () => {
    await assert.rejects(store.trash([A.id], lawyer), e => e.status === 409 && e.code === 'protected');
    await store.trash([B.id], lawyer);
    await assert.rejects(store.getDocument(B.id), e => e.status === 404);
    assert.ok((await store.listTrash()).some(d => d.id === B.id && d.deletedAt && d.isVersion === false));
    await store.restore([B.id]);
    assert.equal((await store.getDocument(B.id)).id, B.id);
  });

  await t.test('hold: only an admin sets or lifts it, and a held document cannot be trashed', async () => {
    await assert.rejects(store.update(B.id, { tags: [made.tags[0], 'on hold'] }, lawyer), e => e.status === 403);
    await store.update(B.id, { tags: [made.tags[0], 'on hold'] }, admin);
    await assert.rejects(store.trash([B.id], admin), e => e.status === 409 && /on hold/.test(e.message));
    await assert.rejects(store.bulkUpdate([B.id], { removeTags: ['on hold'] }, lawyer), e => e.status === 403);
    await store.bulkUpdate([B.id], { removeTags: ['on hold'] }, admin);
  });

  await t.test('duplicates are accepted and each copy lists the other', async () => {
    const copy = await store.add(fileA, { filename: `${px}-copy.txt`, title: `${px} copy` }, lawyer);
    made.docs.push(copy.id);
    assert.ok((await store.findDuplicates(copy.id)).some(d => d.id === A.id));
    assert.ok((await store.findDuplicates(A.id)).some(d => d.id === copy.id));
  });

  await t.test('versions: added under the root and listed newest first', async () => {
    const v2 = Buffer.from(`${fileB}\nVersion two.\n`);
    const { taskId } = await store.addVersion(B.id, v2, { filename: `${px}-nda-v2.txt`, label: 'v2' });
    await store.waitForDocument(taskId);
    const versions = await store.listVersions(B.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].checksum, sha(v2));
    assert.equal(sha((await store.getOriginal(B.id)).body), sha(v2), 'the original is the latest version');
    assert.equal(sha((await store.getOriginal(B.id, { version: versions[1].id })).body), sha(fileB));
  });

  await t.test('preview and thumbnail answer bytes', async () => {
    assert.ok((await store.getPreviewPdf(A.id)).body.length > 0);
    assert.ok((await store.getThumbnail(A.id)).body.length > 0);
  });

  await t.test('taxonomy: ensure, list, rename, remove', async () => {
    const name = `${px} temp tag`;
    const tag = await store.taxonomy.tags.ensure(name);
    assert.equal((await store.taxonomy.tags.ensure(name)).id, tag.id, 'ensure does not make it twice');
    assert.ok((await store.taxonomy.tags.list()).some(x => x.name === name));
    await store.taxonomy.tags.update(name, { name: `${name} 2` });
    assert.equal(await store.taxonomy.tags.get(name), null);
    await store.taxonomy.tags.remove(`${name} 2`);
    assert.equal(await store.taxonomy.tags.get(`${name} 2`), null);
  });

  return made;
}
