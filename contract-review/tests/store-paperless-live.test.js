// SPDX-License-Identifier: GPL-3.0-or-later
// The Paperless adapter against a real Paperless-ngx (plan task 2, "an integration test against the running Paperless
// covers each operation"). Runs only when PAPERLESS_TEST_URL and PAPERLESS_TEST_TOKEN are set, for example:
//   PAPERLESS_TEST_URL=http://127.0.0.1:8011 PAPERLESS_TEST_TOKEN=... node --test tests/store-paperless-live.test.js
// The token's user must be a superuser. Everything it makes carries a unique prefix and is removed afterwards: its
// documents are trashed and then emptied from the trash by id, and its counterparty, type, tags and field deleted.
// Nothing else in that Paperless is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperlessStore } from '../server/store/paperless.js';
import { storeContract } from './fixtures/store-contract.js';

const url = process.env.PAPERLESS_TEST_URL; const token = process.env.PAPERLESS_TEST_TOKEN;
const skip = !url || !token ? 'set PAPERLESS_TEST_URL and PAPERLESS_TEST_TOKEN to run against a real Paperless' : false;

test('the Paperless adapter passes the store contract against a real Paperless', { skip, timeout: 10 * 60_000 }, async t => {
  const store = createPaperlessStore({ url, token, timeoutMs: 120_000 });
  await store.ensureBaseTaxonomy();
  let made = null;
  try { made = await storeContract(t, store); } finally {
    // Clean up by prefix, whether or not the contract finished.
    const px = made?.px;
    const raw = createPaperlessStore({ url, token, raw: true });
    const mine = px ? (await raw.list({ title: px, pageSize: 100 })).results.map(d => d.id) : [];
    for (const id of mine) { await raw.update(id, { tags: [] }).catch(() => {}); await raw.trash([id]).catch(() => {}); }
    const trashed = (await raw.listTrash()).filter(d => px && d.title.startsWith(px)).map(d => d.id);
    if (trashed.length) await raw.call('POST', '/api/trash/', { json: { action: 'empty', documents: trashed } });
    for (const kind of ['counterparties', 'types', 'tags', 'fields']) for (const item of await raw.taxonomy[kind].list()) if (px && item.name.startsWith(px)) await raw.taxonomy[kind].remove(item.name).catch(() => {});
    if (px) assert.equal((await raw.list({ title: px })).count, 0, 'nothing of ours is left');
  }
});
