// SPDX-License-Identifier: GPL-3.0-or-later
// The in-memory store (server/store/fake.js): the store contract (tests/fixtures/store-contract.js) that the Paperless
// adapter also passes against a real Paperless, plus what only the fake offers to tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeStore, paperlessRejects } from '../server/store/fake.js';
import { checkStore, withRules, OPERATIONS } from '../server/store/index.js';
import { storeContract } from './fixtures/store-contract.js';

test('the fake passes the store contract', async t => { await storeContract(t, createFakeStore()); });

test('checkStore names a missing operation', () => {
  const store = createFakeStore();
  assert.equal(checkStore(store), store);
  for (const op of OPERATIONS) assert.equal(typeof store[op], 'function', op);
  assert.throws(() => withRules({ ...createFakeStore({ raw: true }), similar: undefined }), /no similar operation/);
});

test('a failed task throws store_task_failed, as Paperless reports failures only in the task', async () => {
  const store = createFakeStore();
  store.failNextTask('Not consuming x.docx: it is password protected');
  const { taskId } = await store.addDocument(Buffer.from('x'), { filename: 'x.docx' });
  await assert.rejects(store.waitForDocument(taskId), e => e.code === 'store_task_failed' && /password/.test(e.message));
  assert.equal((await store.list()).count, 0);
});

test('paperlessRejects refuses JSON by content, as Paperless 3.3.2 does', async () => {
  assert.match(paperlessRejects(Buffer.from('{"paragraphs":[]}'), 'round.txt'), /application\/json/);
  assert.equal(paperlessRejects(Buffer.from('Order form'), 'a.json'), null);
  const store = createFakeStore({ reject: paperlessRejects });
  await assert.rejects(store.addDocument(Buffer.from('[1]'), { filename: 'a.json' }), e => e.code === 'store_rejected');
});

test('as(user): another user over the same documents, credited in history and notes', async () => {
  const store = createFakeStore({ user: 'service' });
  const jane = store.as('jane');
  const d = await jane.add(Buffer.from('hello'), { filename: 'a.txt' });
  await jane.update(d.id, { title: 'Renamed' });
  const notes = await store.as('ann').notes.add(d.id, 'Seen.');
  assert.equal((await store.getDocument(d.id)).title, 'Renamed');
  assert.equal((await store.history(d.id))[0].actor, 'ann');
  assert.equal((await store.history(d.id))[1].actor, 'jane');
  assert.equal(notes[0].user, 'ann');
});

test('taxonomy: renaming a counterparty renames it on its documents; removing clears it', async () => {
  const store = createFakeStore();
  const d = await store.add(Buffer.from('x'), { filename: 'a.txt', counterparty: 'Acme', tags: ['red'] });
  await store.taxonomy.counterparties.update('acme', { name: 'Acme Ltd' });
  assert.equal((await store.getDocument(d.id)).counterparty, 'Acme Ltd');
  assert.equal((await store.taxonomy.counterparties.get('Acme Ltd')).documentCount, 1);
  await store.taxonomy.tags.remove('red');
  assert.deepEqual((await store.getDocument(d.id)).tags, []);
  const f = await store.taxonomy.fields.create({ name: 'Status', dataType: 'select', options: ['Live', 'Ended'] });
  assert.deepEqual(f.options.map(o => o.label), ['Live', 'Ended']);
  await assert.rejects(store.update(d.id, { fields: { Status: 'Paused' } }), e => e.status === 400);
});
