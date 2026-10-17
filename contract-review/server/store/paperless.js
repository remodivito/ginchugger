// SPDX-License-Identifier: GPL-3.0-or-later
// The Paperless-ngx adapter behind the store interface (server/store/index.js; decision 191; plan architecture
// decision 1). A client over HTTP: Paperless-ngx (GPL-3.0) runs unmodified as its own service and none of its code is
// here. Every call and gotcha below was verified against v3.3.2, API v10 (dms-port-research/paperless-headless-spike.md):
// - the API version is pinned on every request (`Accept: application/json; version=10`, gap 13);
// - names are mapped to Paperless ids and cached per kind; select custom fields take option ids (gap 14);
// - uploads and bulk edits are asynchronous; the adapter waits on the task and checks its result (gaps 3 and 4);
// - originals are always fetched with ?original=true and named by us, not by Paperless (gap 2);
// - our taxonomy is created with matching off and no inbox tag, so labels are only what we set (gap 9);
// - a deleted version shows in the trash as its own item: recognised by `root_document` (gap 8);
// - API v10 returns no `checksum` on a document (found 16 Oct, unlike the spike's reading): the current original's
//   SHA-256 is the newest entry of `versions`, and `checksum__iexact` still filters by it.
import { storeError, withRules, checkSort, tagFilter, paging, BASE_TAGS, TAG_INBOX, FIELD_TYPES } from './index.js';

export const API_VERSION = 10;
const ACCEPT = `application/json; version=${API_VERSION}`;
const KIND_PATH = { counterparties: 'correspondents', types: 'document_types', tags: 'tags', fields: 'custom_fields' };
const SORT_FIELD = { created: 'created', added: 'added', modified: 'modified', title: 'title', counterparty: 'correspondent__name', type: 'document_type__name' };
const DONE = new Set(['success', 'failure', 'revoked']);
const day = v => (typeof v === 'string' ? v.slice(0, 10) : v ?? null);

/**
 * `url`: Paperless's base address (http://127.0.0.1:8011). `token`: the API token of the user the calls act as (plan
 * decision 5: history credits the token's user). `fetch`, `sleep` and the timings are injectable for tests.
 * Returns the store with our rules applied (`withRules`). `raw: true` returns it without them (tests only).
 */
export function createPaperlessStore({ url, token, fetch: fetchFn = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 250, timeoutMs = 120_000, raw = false } = {}) {
  if (!url || !token) throw new Error('The Paperless store needs its address and an API token.');
  const base = String(url).replace(/\/+$/, '');

  async function call(method, path, { query, json, form, binary = false, ok = [200, 201, 204] } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString() : '';
    const headers = { Authorization: `Token ${token}`, Accept: binary ? `*/*; version=${API_VERSION}` : ACCEPT };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    let res;
    try { res = await fetchFn(`${base}${path}${qs ? `?${qs}` : ''}`, { method, headers, body }); } catch (e) { throw storeError(503, 'store_unavailable', `The document store cannot be reached (${e.message}).`); }
    if (!ok.includes(res.status)) {
      const text = await res.text().catch(() => '');
      let detail = text; try { const j = JSON.parse(text); detail = typeof j === 'string' ? j : j.detail || Object.entries(j).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`).join('; '); } catch { /* not JSON */ }
      const status = res.status === 404 ? 404 : res.status === 403 ? 403 : res.status === 401 ? 503 : res.status >= 500 ? 503 : 400;
      const code = { 404: 'not_found', 403: 'forbidden', 503: res.status === 401 ? 'store_unauthorized' : 'store_unavailable' }[status] || 'store_rejected';
      throw storeError(status, code, status === 404 ? 'Document not found.' : `The document store refused ${method} ${path} (${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}).`, { upstreamStatus: res.status });
    }
    if (binary) return { body: Buffer.from(await res.arrayBuffer()), mimeType: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0], apiVersion: res.headers.get('x-api-version') };
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  /** Every page of a list endpoint. */
  async function all(path, query = {}) {
    const out = []; let page = 1;
    for (;;) {
      const r = await call('GET', path, { query: { ...query, page, page_size: 100 } });
      out.push(...r.results);
      if (!r.next) return out;
      page++;
    }
  }

  // ---- Taxonomy: name → item, cached per kind; a miss reloads once (another process may have added it).
  const cache = {};
  const norm = (kind, x) => ({ id: x.id, name: x.name, documentCount: x.document_count ?? 0,
    ...(kind === 'tags' ? { color: x.color } : {}),
    ...(kind === 'fields' ? { dataType: x.data_type, options: (x.extra_data?.select_options || []).map(o => ({ id: o.id, label: o.label })) } : {}) });
  async function load(kind) { const items = (await all(`/api/${KIND_PATH[kind]}/`)).map(x => norm(kind, x)); cache[kind] = { byName: new Map(items.map(i => [i.name.toLowerCase(), i])), byId: new Map(items.map(i => [i.id, i])) }; return cache[kind]; }
  const loaded = async kind => cache[kind] || load(kind);
  async function find(kind, name) {
    if (name === null || name === undefined || name === '') return null;
    let c = await loaded(kind); let hit = c.byName.get(String(name).toLowerCase());
    if (!hit) { c = await load(kind); hit = c.byName.get(String(name).toLowerCase()); }
    return hit || null;
  }
  async function byId(kind, id) {
    if (id === null || id === undefined) return null;
    let c = await loaded(kind); let hit = c.byId.get(id);
    if (!hit) { c = await load(kind); hit = c.byId.get(id); }
    return hit || null;
  }
  function taxonomy(kind) {
    const path = `/api/${KIND_PATH[kind]}/`;
    const need = async name => { const t = await find(kind, name); if (!t) throw storeError(404, 'not_found', `No ${kind.replace(/s$/, '')} named ${name}.`); return t; };
    const self = {
      async list() { return [...(await load(kind)).byName.values()].sort((a, b) => a.name.localeCompare(b.name)); },
      get: name => find(kind, name),
      async create({ name, ...extra } = {}) {
        if (typeof name !== 'string' || !name.trim()) throw storeError(400, 'bad_request', 'Give it a name.');
        let body = { name: name.trim() };
        if (kind === 'fields') {
          const dataType = extra.dataType || 'string';
          if (!FIELD_TYPES.includes(dataType)) throw storeError(400, 'bad_request', `A field type is one of: ${FIELD_TYPES.join(', ')}.`);
          body = { ...body, data_type: dataType, ...(dataType === 'select' ? { extra_data: { select_options: (extra.options || []).map(o => ({ label: typeof o === 'string' ? o : o.label })) } } : {}) };
        } else body = { ...body, matching_algorithm: 0, match: '', ...(kind === 'tags' ? { is_inbox_tag: false, ...(extra.color ? { color: extra.color } : {}) } : {}) };
        const made = norm(kind, await call('POST', path, { json: body }));
        cache[kind] = undefined;
        return made;
      },
      async ensure(name, extra = {}) { return (await find(kind, name)) || self.create({ name, ...extra }); },
      async update(name, patch = {}) {
        const t = await need(name); const body = {};
        if (typeof patch.name === 'string' && patch.name.trim()) body.name = patch.name.trim();
        if (kind === 'tags' && patch.color) body.color = patch.color;
        const out = norm(kind, await call('PATCH', `${path}${t.id}/`, { json: body }));
        cache[kind] = undefined;
        return out;
      },
      async remove(name) { const t = await need(name); await call('DELETE', `${path}${t.id}/`); cache[kind] = undefined; return { removed: t.name }; },
    };
    return self;
  }
  const tax = Object.fromEntries(Object.keys(KIND_PATH).map(k => [k, taxonomy(k)]));
  const idsOf = async (kind, names) => Promise.all([].concat(names || []).map(async n => (await find(kind, n))?.id ?? null));

  // ---- Custom field values: select options by label on our side, by id on Paperless's.
  async function fieldOut(cf) {
    const f = await byId('fields', cf.field);
    if (!f) return null;
    const value = f.dataType === 'select' ? f.options.find(o => o.id === cf.value)?.label ?? cf.value : cf.value;
    return [f.name, value];
  }
  async function fieldIn(name, value, { create = false } = {}) {
    const f = create ? await tax.fields.ensure(name, { dataType: 'string' }) : await find('fields', name);
    if (!f) throw storeError(400, 'bad_request', `No custom field named ${name}.`);
    if (f.dataType === 'select' && value !== null) {
      const o = f.options.find(x => x.label === value || x.id === value);
      if (!o) throw storeError(400, 'bad_request', `${name} has no option ${value}.`);
      return [f.id, o.id];
    }
    return [f.id, value];
  }

  async function docOut(d) {
    const tags = (await Promise.all((d.tags || []).map(id => byId('tags', id)))).filter(Boolean).map(t => t.name);
    const fields = Object.fromEntries((await Promise.all((d.custom_fields || []).map(fieldOut))).filter(Boolean));
    return {
      id: d.id, title: d.title,
      counterparty: (await byId('counterparties', d.correspondent))?.name ?? null,
      type: (await byId('types', d.document_type))?.name ?? null,
      tags, created: day(d.created), added: d.added ?? null, modified: d.modified ?? null,
      checksum: d.checksum ?? d.versions?.[0]?.checksum ?? null, originalName: d.original_file_name ?? null, mimeType: d.mime_type ?? null,
      pageCount: d.page_count ?? null, notesCount: Array.isArray(d.notes) ? d.notes.length : d.notes ?? 0,
      fields, inbox: tags.map(t => t.toLowerCase()).includes(TAG_INBOX),
      ...(Array.isArray(d.duplicate_documents) ? { duplicates: d.duplicate_documents.map(x => ({ id: x.id, title: x.title, deletedAt: x.deleted_at ?? null })) } : {}),
      ...(Array.isArray(d.versions) ? { versions: d.versions.map(versionOut) } : {}),
      ...(d.deleted_at ? { deletedAt: d.deleted_at, rootId: d.root_document ?? null, isVersion: !!(d.root_document && d.root_document !== d.id) } : {}),
      ...(d.__search_hit__ ? { hit: { score: d.__search_hit__.score, highlights: d.__search_hit__.highlights || '', noteHighlights: d.__search_hit__.note_highlights || '', rank: d.__search_hit__.rank } } : {}),
    };
  }
  const versionOut = v => ({ id: v.id, added: v.added, label: v.version_label ?? null, checksum: v.checksum ?? null, isRoot: !!v.is_root });
  const pageOut = async (r, p) => ({ count: r.count, page: p.page, pageSize: p.pageSize, results: await Promise.all(r.results.map(docOut)) });

  // ---- Filters (spike section 3): names resolved to ids; a name that does not exist matches nothing.
  const NOTHING = Symbol('nothing');
  async function filters(f = {}) {
    const q = {};
    const many = async (kind, v, key) => {
      if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return;
      const ids = (await idsOf(kind, v)).filter(x => x !== null);
      if (!ids.length) throw NOTHING;
      q[key] = ids.join(',');
    };
    await many('counterparties', f.counterparty, 'correspondent__id__in');
    await many('types', f.type, 'document_type__id__in');
    const t = tagFilter(f.tags);
    if (f.inbox === true) t.all = [...t.all, TAG_INBOX];
    if (f.inbox === false) t.none = [...t.none, TAG_INBOX];
    if (t.all.length) { const ids = await idsOf('tags', t.all); if (ids.includes(null)) throw NOTHING; q.tags__id__all = ids.join(','); }
    if (t.any.length) { const ids = (await idsOf('tags', t.any)).filter(x => x !== null); if (!ids.length) throw NOTHING; q.tags__id__in = ids.join(','); }
    if (t.none.length) { const ids = (await idsOf('tags', t.none)).filter(x => x !== null); if (ids.length) q.tags__id__none = ids.join(','); }
    if (f.createdFrom) q.created__date__gte = day(f.createdFrom);
    if (f.createdTo) q.created__date__lte = day(f.createdTo);
    if (Array.isArray(f.fields) && f.fields.length) {
      const parts = await Promise.all(f.fields.map(async ([name, op, value]) => {
        const fd = await find('fields', name); if (!fd) throw NOTHING;
        const v = fd.dataType === 'select' && op === 'exact' ? fd.options.find(o => o.label === value)?.id ?? value : value;
        return [fd.id, op, v];
      }));
      q.custom_field_query = JSON.stringify(parts.length === 1 ? parts[0] : ['AND', parts]);
    }
    if (f.text) q.text = f.text;
    if (f.title) q.title__icontains = f.title;
    if (f.checksum) q.checksum__iexact = f.checksum;
    if (Array.isArray(f.ids)) { if (!f.ids.length) throw NOTHING; q.id__in = f.ids.join(','); }
    return q;
  }
  const ordering = sort => { const s = checkSort(sort); const desc = s.startsWith('-'); return (desc ? '-' : '') + SORT_FIELD[s.replace(/^-/, '')]; };
  async function listing(extra, f, p, { sort = true } = {}) {
    let q; try { q = await filters(f); } catch (e) { if (e === NOTHING) return { count: 0, page: p.page, pageSize: p.pageSize, results: [] }; throw e; }
    const r = await call('GET', '/api/documents/', { query: { ...q, ...extra, ...(sort ? { ordering: ordering(f.sort) } : {}), page: p.page, page_size: p.pageSize } });
    return pageOut(r, p);
  }

  // ---- Tasks (spike section 1): poll until done; the task's own result is the only place a failure shows.
  async function waitTask(taskId, { timeoutMs: limit = timeoutMs } = {}) {
    const until = Date.now() + limit;
    for (;;) {
      const r = await call('GET', '/api/tasks/', { query: { task_id: taskId } });
      const t = (r?.results || r || [])[0];
      if (t && DONE.has(t.status)) {
        if (t.status !== 'success') throw storeError(422, 'store_task_failed', `The document store could not process it: ${typeof t.result_data === 'object' && t.result_data ? t.result_data.error || JSON.stringify(t.result_data) : t.result || t.status}`, { task: t });
        return t;
      }
      if (Date.now() > until) throw storeError(504, 'store_task_timeout', 'The document store is still processing it.', { taskId });
      await sleep(pollMs);
    }
  }
  const lastBulkTaskId = async () => (await call('GET', '/api/tasks/', { query: { task_type: 'bulk_update', ordering: '-date_created', page_size: 1 } }))?.results?.[0]?.id ?? 0;
  /** bulk_edit answers OK before it runs; its bulk_update task (newer than `after`) says whether it worked (gap 4). */
  async function bulkEdit(ids, method, parameters) {
    const after = await lastBulkTaskId();
    await call('POST', '/api/documents/bulk_edit/', { json: { documents: ids, method, parameters } });
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await call('GET', '/api/tasks/', { query: { task_type: 'bulk_update', ordering: '-date_created', page_size: 5 } });
      const mine = (r?.results || []).filter(t => t.id > after).sort((a, b) => a.id - b.id)[0];
      if (mine && DONE.has(mine.status)) {
        if (mine.status !== 'success') throw storeError(422, 'store_task_failed', `The document store could not apply the change: ${mine.result_data ? JSON.stringify(mine.result_data) : mine.status}`);
        return;
      }
      if (Date.now() > until) throw storeError(504, 'store_task_timeout', 'The document store is still applying the change.');
      await sleep(pollMs);
    }
  }

  const store = {
    kind: 'paperless', url: base,
    async addDocument(buffer, { filename, title, counterparty, type, tags, created, fields } = {}) {
      if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw storeError(400, 'bad_request', 'Send the file.');
      if (typeof filename !== 'string' || !filename.trim()) throw storeError(400, 'bad_request', 'Name the file.');
      const form = new FormData();
      form.append('document', new Blob([buffer]), filename);
      if (title) form.append('title', title);
      if (created) form.append('created', day(created));
      if (counterparty) form.append('correspondent', String((await tax.counterparties.ensure(counterparty)).id));
      if (type) form.append('document_type', String((await tax.types.ensure(type)).id));
      for (const t of [].concat(tags || [])) form.append('tags', String((await tax.tags.ensure(t)).id));
      if (fields && Object.keys(fields).length) form.append('custom_fields', JSON.stringify(Object.fromEntries(await Promise.all(Object.entries(fields).map(([n, v]) => fieldIn(n, v, { create: true }))))));
      const taskId = await call('POST', '/api/documents/post_document/', { form });
      return { taskId: String(taskId) };
    },
    async waitForDocument(taskId, opts = {}) {
      const t = await waitTask(taskId, opts);
      const id = t.result_data?.document_id ?? t.related_document_ids?.[0];
      if (!id) throw storeError(422, 'store_task_failed', 'The document store finished without a document.', { task: t });
      return { id };
    },
    async add(buffer, meta, opts) { const { taskId } = await store.addDocument(buffer, meta, opts); return store.getDocument((await store.waitForDocument(taskId, opts)).id); },
    async addVersion(id, buffer, { filename, label } = {}) {
      const form = new FormData();
      form.append('document', new Blob([buffer]), filename || 'version');
      if (label) form.append('version_label', String(label).slice(0, 64));
      return { taskId: String(await call('POST', `/api/documents/${id}/update_version/`, { form })) };
    },
    async listVersions(id) { return ((await call('GET', `/api/documents/${id}/`)).versions || []).map(versionOut); },
    async getDocument(id, { version } = {}) { return docOut(await call('GET', `/api/documents/${id}/`, { query: { version } })); },
    async findByChecksum(sha) { const r = await listing({}, { checksum: sha }, { page: 1, pageSize: 1 }, { sort: false }); return r.results[0] || null; },
    async getOriginal(id, { version } = {}) {
      const d = await call('GET', `/api/documents/${id}/`, { query: { version } });
      const f = await call('GET', `/api/documents/${id}/download/`, { query: { original: 'true', version }, binary: true });
      return { body: f.body, filename: d.original_file_name || `${d.title}`, mimeType: d.mime_type || f.mimeType };
    },
    async getPreviewPdf(id) { const f = await call('GET', `/api/documents/${id}/preview/`, { binary: true }); return { body: f.body, mimeType: f.mimeType }; },
    async getThumbnail(id) { const f = await call('GET', `/api/documents/${id}/thumb/`, { binary: true }); return { body: f.body, mimeType: f.mimeType }; },
    async list(f = {}) { return listing({}, f, paging(f)); },
    async search(query, f = {}) {
      if (typeof query !== 'string' || !query.trim()) throw storeError(400, 'bad_request', 'Type something to search for.');
      return listing({ query: query.trim() }, { ...f, sort: undefined }, paging(f), { sort: false });
    },
    async similar(id, f = {}) { return listing({ more_like_id: id }, {}, paging(f), { sort: false }); },
    async update(id, patch = {}) {
      const body = {};
      if (typeof patch.title === 'string') body.title = patch.title;
      if (patch.created !== undefined) body.created = day(patch.created);
      if (patch.counterparty !== undefined) body.correspondent = patch.counterparty === null ? null : (await tax.counterparties.ensure(patch.counterparty)).id;
      if (patch.type !== undefined) body.document_type = patch.type === null ? null : (await tax.types.ensure(patch.type)).id;
      if (Array.isArray(patch.tags)) body.tags = await Promise.all(patch.tags.map(async t => (await tax.tags.ensure(t)).id));
      if (patch.fields && typeof patch.fields === 'object') {
        // Paperless replaces the document's field list with the one sent: merge with what is there; null removes.
        const now = await call('GET', `/api/documents/${id}/`);
        const merged = new Map((now.custom_fields || []).map(cf => [cf.field, cf.value]));
        for (const [name, value] of Object.entries(patch.fields)) {
          if (value === null) { const fd = await find('fields', name); if (fd) merged.delete(fd.id); continue; }
          const [fid, v] = await fieldIn(name, value, { create: true }); merged.set(fid, v);
        }
        body.custom_fields = [...merged].map(([field, value]) => ({ field, value }));
      }
      await call('PATCH', `/api/documents/${id}/`, { json: body });
      return store.getDocument(id);
    },
    async bulkUpdate(ids, op = {}) {
      const list = [].concat(ids).map(Number);
      if (!list.length) return { ok: true, ids: [] };
      if ((op.addTags || []).length || (op.removeTags || []).length) {
        const add = await Promise.all((op.addTags || []).map(async t => (await tax.tags.ensure(t)).id));
        const remove = (await idsOf('tags', op.removeTags || [])).filter(x => x !== null);
        await bulkEdit(list, 'modify_tags', { add_tags: add, remove_tags: remove });
      }
      if (op.counterparty !== undefined) await bulkEdit(list, 'set_correspondent', { correspondent: op.counterparty === null ? null : (await tax.counterparties.ensure(op.counterparty)).id });
      if (op.type !== undefined) await bulkEdit(list, 'set_document_type', { document_type: op.type === null ? null : (await tax.types.ensure(op.type)).id });
      if ((op.setFields && Object.keys(op.setFields).length) || (op.removeFields || []).length) {
        const add = Object.fromEntries(await Promise.all(Object.entries(op.setFields || {}).map(([n, v]) => fieldIn(n, v, { create: true }))));
        const remove = (await idsOf('fields', op.removeFields || [])).filter(x => x !== null);
        await bulkEdit(list, 'modify_custom_fields', { add_custom_fields: add, remove_custom_fields: remove });
      }
      return { ok: true, ids: list };
    },
    notes: {
      async list(id) { return (await call('GET', `/api/documents/${id}/notes/`)).map(noteOut); },
      async add(id, text) {
        if (typeof text !== 'string' || !text.trim()) throw storeError(400, 'bad_request', 'Write the note first.');
        return (await call('POST', `/api/documents/${id}/notes/`, { json: { note: text.trim() } })).map(noteOut);
      },
      async delete(id, noteId) { return (await call('DELETE', `/api/documents/${id}/notes/`, { query: { id: noteId } }) || []).map(noteOut); },
    },
    async history(id) { return (await call('GET', `/api/documents/${id}/history/`)).map(h => ({ id: h.id, at: h.timestamp, action: h.action, changes: h.changes, actor: h.actor?.username ?? null })); },
    async trash(ids) { const list = [].concat(ids); for (const id of list) await call('DELETE', `/api/documents/${id}/`); return { ids: list }; },
    async listTrash() { return Promise.all((await all('/api/trash/')).map(docOut)); },
    async restore(ids) { const r = await call('POST', '/api/trash/', { json: { action: 'restore', documents: [].concat(ids) } }); return { ids: r?.doc_ids || [].concat(ids) }; },
    async findDuplicates(id) { return (await store.getDocument(id)).duplicates || []; },
    async health() {
      const s = await call('GET', '/api/status/');
      const ok = s?.database?.status === 'OK' && s?.tasks?.redis_status === 'OK' && s?.tasks?.celery_status === 'OK';
      return { ok, version: s?.pngx_version ?? null, apiVersion: API_VERSION, detail: ok ? null : [s?.database?.error, s?.tasks?.redis_error, s?.tasks?.celery_error].filter(Boolean).join('; ') || 'not ready' };
    },
    /** Our base tags, made once per store (matching off, no inbox tag behaviour: gap 9). */
    async ensureBaseTaxonomy() { for (const t of BASE_TAGS) await tax.tags.ensure(t); },
    taxonomy: tax,
    /** For the service and tests: the low-level call, already authenticated and version-pinned. */
    call,
  };
  const noteOut = n => ({ id: n.id, text: n.note, created: n.created, user: n.user?.username ?? null });
  return raw ? store : withRules(store);
}
