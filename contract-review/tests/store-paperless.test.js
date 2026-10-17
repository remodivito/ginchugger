// SPDX-License-Identifier: GPL-3.0-or-later
// The Paperless-ngx adapter (server/store/paperless.js): how each operation builds its request and maps the answer,
// against a scripted fetch that answers as Paperless 3.3.2 / API v10 did in the spike. No Docker, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperlessStore } from '../server/store/paperless.js';

const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Api-Version': '10' } });
const page = results => ({ count: results.length, next: null, previous: null, results });

/** A scripted Paperless: taxonomy lists, documents by id, tasks, and a log of every request. */
function fakePaperless(over = {}) {
  const calls = [];
  const state = {
    correspondents: [{ id: 3, name: 'Northgate Biosciences Ltd', document_count: 2 }],
    document_types: [{ id: 4, name: 'Order form', document_count: 2 }],
    tags: [{ id: 1, name: 'signed' }, { id: 2, name: 'on hold' }, { id: 9, name: 'inbox' }],
    custom_fields: [{ id: 5, name: 'Former matter', data_type: 'string', extra_data: {} }, { id: 6, name: 'Status', data_type: 'select', extra_data: { select_options: [{ id: 'opt-a', label: 'Live' }] } }],
    docs: { 7: { id: 7, title: 'Pilot order form', correspondent: 3, document_type: 4, tags: [1], created: '2025-03-12', added: '2026-10-16T10:00:00Z', modified: '2026-10-16T10:00:00Z', versions: [{ id: 7, added: '2026-10-16T10:00:00Z', version_label: null, checksum: 'abc', is_root: true }], original_file_name: 'pilot.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', page_count: 2, notes: [{ id: 1 }], custom_fields: [{ field: 5, value: 'Helix pilot' }, { field: 6, value: 'opt-a' }], duplicate_documents: [] },
      8: { id: 8, title: 'Draft', correspondent: null, document_type: null, tags: [], created: '2026-06-01', versions: [{ id: 8, checksum: 'def', is_root: true }], original_file_name: 'draft.docx', custom_fields: [] } },
    tasks: [], nextId: 100, ...over,
  };
  async function fetch(url, init = {}) {
    const u = new URL(url); const method = init.method || 'GET'; const p = u.pathname;
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: p, query: Object.fromEntries(u.searchParams), headers: init.headers || {}, body });
    for (const [kind, key] of [['correspondents', 'correspondents'], ['document_types', 'document_types'], ['tags', 'tags'], ['custom_fields', 'custom_fields']]) {
      if (p === `/api/${kind}/` && method === 'GET') return json(page(state[key]));
      if (p === `/api/${kind}/` && method === 'POST') { const made = { id: state.nextId++, ...body }; state[key].push(made); return json(made, 201); }
    }
    if (p === '/api/documents/post_document/') { state.tasks.push({ id: state.tasks.length + 1, task_id: 'task-1', status: over.uploadFails ? 'failure' : 'success', task_type: 'consume_file', result_data: over.uploadFails ? { error: 'Not consuming x: unsupported' } : { document_id: 8 } }); return json('task-1'); }
    if (p === '/api/tasks/') {
      if (u.searchParams.get('task_id')) return json(page(state.tasks.filter(t => t.task_id === u.searchParams.get('task_id'))));
      return json(page(state.tasks.filter(t => t.task_type === 'bulk_update').sort((a, b) => b.id - a.id)));
    }
    if (p === '/api/documents/bulk_edit/') { state.tasks.push({ id: state.tasks.length + 1, task_type: 'bulk_update', status: over.bulkFails ? 'failure' : 'success', result_data: over.bulkFails ? { error: 'boom' } : null }); return json({ result: 'OK' }); }
    const m = p.match(/^\/api\/documents\/(\d+)\/(download|preview|thumb|notes|history)?\/?$/);
    if (m && !m[2] && method === 'GET') return state.docs[m[1]] ? json(state.docs[m[1]]) : json({ detail: 'No Document matches the given query.' }, 404);
    if (m && !m[2] && method === 'PATCH') { Object.assign(state.docs[m[1]], body); return json(state.docs[m[1]]); }
    if (m && !m[2] && method === 'DELETE') return new Response(null, { status: 204 });
    if (m && m[2] === 'download') return new Response(Buffer.from('ORIGINAL BYTES'), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="2025-03-12 Northgate pilot.docx"' } });
    if (m && m[2] === 'preview') return new Response(Buffer.from('%PDF'), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    if (m && m[2] === 'thumb') return new Response(Buffer.from('WEBP'), { status: 200, headers: { 'Content-Type': 'image/webp' } });
    if (m && m[2] === 'notes') return json([{ id: 11, note: body?.note || 'Agreed cap', created: '2026-10-16T10:00:00Z', user: { id: 2, username: 'p.raman' } }]);
    if (m && m[2] === 'history') return json([{ id: 5, timestamp: '2026-10-16T10:01:00Z', action: 'update', changes: { title: ['a', 'b'] }, actor: { id: 2, username: 'p.raman' } }, { id: 4, timestamp: '2026-10-16T10:00:00Z', action: 'create', changes: {}, actor: null }]);
    if (p === '/api/documents/') {
      const docs = Object.values(state.docs).map(d => (u.searchParams.get('query') ? { ...d, __search_hit__: { score: 2.5, highlights: 'pay within <b>60</b> days', note_highlights: '', rank: 0 } } : d));
      return json(page(docs));
    }
    if (p === '/api/trash/' && method === 'GET') return json(page([{ ...state.docs[8], deleted_at: '2026-10-16T11:00:00Z', root_document: null }, { ...state.docs[7], id: 20, deleted_at: '2026-10-16T11:00:00Z', root_document: 7 }]));
    if (p === '/api/trash/' && method === 'POST') return json({ result: 'OK', doc_ids: body.documents });
    if (p === '/api/status/') return json({ pngx_version: '3.3.2', database: { status: 'OK' }, tasks: { redis_status: 'OK', celery_status: 'OK' } });
    return json({ detail: `unscripted ${method} ${p}` }, 500);
  }
  return { fetch, calls, state };
}
const make = (over, opts = {}) => { const fp = fakePaperless(over); return { fp, store: createPaperlessStore({ url: 'http://127.0.0.1:8011/', token: 'tok', fetch: fp.fetch, sleep: async () => {}, pollMs: 0, ...opts }) }; };

test('every request carries the token and pins API version 10', async () => {
  const { fp, store } = make();
  await store.getDocument(7);
  for (const c of fp.calls) { assert.equal(c.headers.Authorization, 'Token tok'); assert.match(c.headers.Accept, /version=10/); }
  assert.ok(fp.calls.every(c => !c.path.includes('//')), 'the trailing slash in the address is dropped');
});

test('a document maps ids to names, select options to labels, and keeps the duplicates', async () => {
  const { store } = make();
  const d = await store.getDocument(7);
  assert.deepEqual({ ...d, added: undefined, modified: undefined }, { id: 7, title: 'Pilot order form', counterparty: 'Northgate Biosciences Ltd', type: 'Order form', tags: ['signed'], created: '2025-03-12', added: undefined, modified: undefined, checksum: 'abc', originalName: 'pilot.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pageCount: 2, notesCount: 1, fields: { 'Former matter': 'Helix pilot', Status: 'Live' }, inbox: false, duplicates: [], versions: [{ id: 7, added: '2026-10-16T10:00:00Z', label: null, checksum: 'abc', isRoot: true }] });
});

test('addDocument sends the file and our labels as ids, creating missing taxonomy with matching off', async () => {
  const { fp, store } = make();
  const { taskId } = await store.addDocument(Buffer.from('x'), { filename: 'new.docx', title: 'New', counterparty: 'Acme Ltd', type: 'Order form', tags: ['inbox', 'urgent'], created: '2026-06-04T10:00:00Z', fields: { 'Former matter': 'Acme NDA' } });
  assert.equal(taskId, 'task-1');
  const made = fp.calls.filter(c => c.method === 'POST' && c.path !== '/api/documents/post_document/');
  assert.deepEqual(made.map(c => [c.path, c.body]), [
    ['/api/correspondents/', { name: 'Acme Ltd', matching_algorithm: 0, match: '' }],
    ['/api/tags/', { name: 'urgent', matching_algorithm: 0, match: '', is_inbox_tag: false }],
  ]);
  const form = fp.calls.find(c => c.path === '/api/documents/post_document/').body;
  assert.equal(form.get('title'), 'New');
  assert.equal(form.get('created'), '2026-06-04', 'created is a date only (API v9+)');
  assert.equal(form.get('document_type'), '4');
  assert.deepEqual(form.getAll('tags'), ['9', String(fp.state.tags.find(t => t.name === 'urgent').id)]);
  assert.deepEqual(JSON.parse(form.get('custom_fields')), { 5: 'Acme NDA' });
  assert.equal(form.get('document').name, 'new.docx');
});

test('waitForDocument returns the document id, and a failed task throws with its error', async () => {
  const { store } = make();
  const { taskId } = await store.addDocument(Buffer.from('x'), { filename: 'a.docx' });
  assert.deepEqual(await store.waitForDocument(taskId), { id: 8 });
  const bad = make({ uploadFails: true }).store;
  const t = await bad.addDocument(Buffer.from('x'), { filename: 'a.docx' });
  await assert.rejects(bad.waitForDocument(t.taskId), e => e.code === 'store_task_failed' && /unsupported/.test(e.message));
});

test('a task still running past the timeout is reported, not waited on for ever', async () => {
  const { fp, store } = make({}, { timeoutMs: -1 });
  fp.state.tasks.push({ id: 1, task_id: 'slow', status: 'started', task_type: 'consume_file' });
  await assert.rejects(store.waitForDocument('slow'), e => e.code === 'store_task_timeout');
});

test('getOriginal always asks for the original and names it by the original file name, not Paperless\'s', async () => {
  const { fp, store } = make();
  const f = await store.getOriginal(7);
  assert.equal(f.body.toString(), 'ORIGINAL BYTES');
  assert.equal(f.filename, 'pilot.docx');
  assert.equal(fp.calls.find(c => c.path.endsWith('/download/')).query.original, 'true');
  assert.equal((await store.getPreviewPdf(7)).mimeType, 'application/pdf');
  assert.equal((await store.getThumbnail(7)).mimeType, 'image/webp');
});

test('list turns our filters into Paperless query parameters', async () => {
  const { fp, store } = make();
  await store.list({ counterparty: 'Northgate Biosciences Ltd', type: ['Order form'], tags: { all: ['signed'], any: ['on hold'], none: ['nope'] }, inbox: false, createdFrom: '2025-01-01', createdTo: '2025-12-31T10:00:00Z', fields: [['Former matter', 'exact', 'Helix pilot'], ['Status', 'exact', 'Live']], text: 'payment', sort: '-counterparty', page: 2, pageSize: 500 });
  const q = fp.calls.find(c => c.path === '/api/documents/').query;
  assert.deepEqual(q, { correspondent__id__in: '3', document_type__id__in: '4', tags__id__all: '1', tags__id__in: '2', tags__id__none: '9', created__date__gte: '2025-01-01', created__date__lte: '2025-12-31', custom_field_query: JSON.stringify(['AND', [[5, 'exact', 'Helix pilot'], [6, 'exact', 'opt-a']]]), text: 'payment', ordering: '-correspondent__name', page: '2', page_size: '100' });
});

test('a filter naming something that does not exist matches nothing, without asking Paperless', async () => {
  const { fp, store } = make();
  assert.deepEqual(await store.list({ counterparty: 'Nobody Ltd' }), { count: 0, page: 1, pageSize: 25, results: [] });
  assert.deepEqual(await store.list({ tags: ['signed', 'missing'] }), { count: 0, page: 1, pageSize: 25, results: [] });
  assert.equal(fp.calls.filter(c => c.path === '/api/documents/').length, 0);
  await assert.rejects(store.list({ sort: 'size' }), e => e.status === 400);
});

test('search uses query= and returns the hit with its highlighted snippet; similar uses more_like_id', async () => {
  const { fp, store } = make();
  const r = await store.search('"60 days"');
  const docsCall = () => fp.calls.filter(c => c.path === '/api/documents/').at(-1);
  assert.equal(docsCall().query.query, '"60 days"');
  assert.equal(docsCall().query.ordering, undefined, 'search keeps Paperless\'s relevance order');
  assert.deepEqual(r.results[0].hit, { score: 2.5, highlights: 'pay within <b>60</b> days', noteHighlights: '', rank: 0 });
  await store.similar(7);
  assert.equal(docsCall().query.more_like_id, '7');
  await assert.rejects(store.search('  '), e => e.status === 400);
});

test('update sends ids and merges custom fields (Paperless replaces the list it is sent)', async () => {
  const { fp, store } = make();
  await store.update(8, { tags: ['inbox'] }, { actor: { id: 'jane' } });
  await store.update(7, { title: 'Pilot', counterparty: null, fields: { Status: null, 'Former matter': 'Renamed' } }, { actor: { id: 'jane' } });
  const patch = fp.calls.filter(c => c.method === 'PATCH').at(-1).body;
  assert.deepEqual(patch, { title: 'Pilot', correspondent: null, custom_fields: [{ field: 5, value: 'Renamed' }] });
});

test('bulkUpdate waits for its bulk_update task and fails when the task failed', async () => {
  const { fp, store } = make();
  assert.deepEqual(await store.bulkUpdate([7, 8], { addTags: ['inbox'], removeTags: ['missing'] }), { ok: true, ids: [7, 8] });
  assert.deepEqual(fp.calls.find(c => c.path === '/api/documents/bulk_edit/').body, { documents: [7, 8], method: 'modify_tags', parameters: { add_tags: [9], remove_tags: [] } });
  const bad = make({ bulkFails: true }).store;
  await assert.rejects(bad.bulkUpdate([8], { counterparty: 'Northgate Biosciences Ltd' }), e => e.code === 'store_task_failed');
});

test('notes, history, trash and restore map to their endpoints; a deleted version is recognised in the trash', async () => {
  const { fp, store } = make();
  assert.deepEqual(await store.notes.add(7, ' Agreed cap '), [{ id: 11, text: 'Agreed cap', created: '2026-10-16T10:00:00Z', user: 'p.raman' }]);
  assert.deepEqual(fp.calls.at(-1).body, { note: 'Agreed cap' });
  await store.notes.delete(7, 11);
  assert.deepEqual([fp.calls.at(-1).method, fp.calls.at(-1).query], ['DELETE', { id: '11' }]);
  assert.deepEqual((await store.history(7)).map(h => h.actor), ['p.raman', null]);
  await store.trash([8]);
  assert.deepEqual([fp.calls.at(-1).method, fp.calls.at(-1).path], ['DELETE', '/api/documents/8/']);
  const trash = await store.listTrash();
  assert.deepEqual(trash.map(d => [d.id, d.isVersion, d.rootId]), [[8, false, null], [20, true, 7]]);
  assert.deepEqual(await store.restore([8]), { ids: [8] });
});

test('our rules: signed or held documents cannot be trashed; only an admin changes a hold', async () => {
  const { fp, store } = make();
  await assert.rejects(store.trash([7]), e => e.status === 409 && e.code === 'protected' && /signed/.test(e.message));
  fp.state.docs[8].tags = [2];
  await assert.rejects(store.trash([8]), e => e.status === 409 && /on hold/.test(e.message));
  await assert.rejects(store.update(8, { tags: [] }, { actor: { id: 'jane', admin: false } }), e => e.status === 403);
  await store.update(8, { tags: [] }, { actor: { id: 'ann', admin: true } });
  await assert.rejects(store.bulkUpdate([8], { addTags: ['on hold'] }, { actor: { id: 'jane' } }), e => e.status === 403);
  await assert.rejects(store.addDocument(Buffer.from('x'), { filename: 'a.docx', tags: ['On Hold'] }, {}), e => e.status === 403);
});

test('taxonomy: names cached, a miss reloads once, create sets matching off; select fields keep option ids', async () => {
  const { fp, store } = make();
  assert.equal((await store.taxonomy.counterparties.get('northgate biosciences ltd')).id, 3);
  await store.taxonomy.counterparties.get('Northgate Biosciences Ltd');
  assert.equal(fp.calls.filter(c => c.path === '/api/correspondents/').length, 1, 'the second lookup is cached');
  assert.equal(await store.taxonomy.counterparties.get('Nobody'), null);
  assert.equal(fp.calls.filter(c => c.path === '/api/correspondents/').length, 2, 'a miss reloads once');
  const f = await store.taxonomy.fields.create({ name: 'Signed on', dataType: 'date' });
  assert.equal(f.name, 'Signed on');
  assert.deepEqual(fp.calls.at(-1).body, { name: 'Signed on', data_type: 'date' });
  await assert.rejects(store.taxonomy.fields.create({ name: 'X', dataType: 'colour' }), e => e.status === 400);
  assert.deepEqual((await store.taxonomy.fields.get('Status')).options, [{ id: 'opt-a', label: 'Live' }]);
});

test('errors: a missing document is 404, an unreachable store 503, a refused upload says why', async () => {
  const { store } = make();
  await assert.rejects(store.getDocument(99), e => e.status === 404 && e.code === 'not_found');
  const down = createPaperlessStore({ url: 'http://127.0.0.1:1', token: 't', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.getDocument(1), e => e.status === 503 && e.code === 'store_unavailable');
  const refusing = createPaperlessStore({ url: 'http://x', token: 't', fetch: async () => json({ document: ['File type application/json not supported'] }, 400) });
  await assert.rejects(refusing.addDocument(Buffer.from('{}'), { filename: 'a.json' }), e => e.code === 'store_rejected' && /application\/json not supported/.test(e.message));
  assert.throws(() => createPaperlessStore({ url: 'http://x' }), /token/);
});

test('health reads /api/status/', async () => {
  const { store } = make();
  assert.deepEqual(await store.health(), { ok: true, version: '3.3.2', apiVersion: 10, detail: null });
});
