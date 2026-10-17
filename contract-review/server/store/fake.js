// SPDX-License-Identifier: GPL-3.0-or-later
// An in-memory store with the same interface as the Paperless adapter (server/store/index.js), for unit tests and for
// the browser tests, so neither needs Docker. It keeps Paperless's observable behaviour where screens depend on it:
// numeric ids, duplicates accepted and listed on each copy (spike section 6), a task id from every upload, notes left
// out of plain search, a trash that keeps documents restorable, newest-first history credited to the acting user, and
// deleted versions listed in the trash with their root. Search is a plain word match with <b>…</b> highlights.
import { createHash, randomUUID } from 'node:crypto';
import { storeError, withRules, checkSort, tagFilter, paging, BASE_TAGS, TAG_INBOX, FIELD_TYPES } from './index.js';

const sha256 = b => createHash('sha256').update(b).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const MIME = { '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.eml': 'message/rfc822', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown' };
const mimeOf = name => MIME[(String(name).match(/\.[^.]+$/) || [''])[0].toLowerCase()] || 'application/octet-stream';
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));

/**
 * `user`: the name history and notes credit (the token's user in Paperless). `now`: a clock for tests. `text`: how a
 * file's searchable text is read (default: the bytes as UTF-8). `reject`: a function returning a message for files the
 * engine refuses (Paperless refuses JSON, for example). `shared`: another fake's state, so several "users" see one store.
 */
export function createFakeStore({ user = 'admin', now = () => new Date().toISOString(), text = buf => Buffer.from(buf).toString('utf8'), reject = null, shared = null, raw = false } = {}) {
  const s = shared || { seq: 0, noteSeq: 0, histSeq: 0, docs: new Map(), tasks: new Map(), versions: new Map(), taxonomy: { counterparties: [], types: [], tags: [], fields: [] }, taxSeq: 0 };
  const log = (doc, action, changes) => { (doc.history ||= []).unshift({ id: ++s.histSeq, at: now(), action, changes, actor: user }); };

  function taxonomy(kind) {
    const items = () => s.taxonomy[kind];
    const find = name => items().find(i => i.name.toLowerCase() === String(name ?? '').toLowerCase()) || null;
    const need = name => { const t = find(name); if (!t) throw storeError(404, 'not_found', `No ${kind.replace(/s$/, '')} named ${name}.`); return t; };
    const count = name => [...s.docs.values()].filter(d => !d.deletedAt && (kind === 'counterparties' ? d.counterparty === name : kind === 'types' ? d.type === name : kind === 'tags' ? d.tags.includes(name) : name in d.fields)).length;
    const out = t => ({ ...t, documentCount: count(t.name) });
    const self = {
      async list() { return items().map(out).sort((a, b) => a.name.localeCompare(b.name)); },
      async get(name) { const t = find(name); return t ? out(t) : null; },
      async create({ name, ...extra } = {}) {
        if (typeof name !== 'string' || !name.trim()) throw storeError(400, 'bad_request', 'Give it a name.');
        if (find(name)) throw storeError(400, 'store_rejected', `${name} already exists.`);
        const t = { id: ++s.taxSeq, name: name.trim() };
        if (kind === 'fields') {
          t.dataType = extra.dataType || 'string';
          if (!FIELD_TYPES.includes(t.dataType)) throw storeError(400, 'bad_request', `A field type is one of: ${FIELD_TYPES.join(', ')}.`);
          t.options = t.dataType === 'select' ? (extra.options || []).map(o => ({ id: randomUUID().slice(0, 16), label: typeof o === 'string' ? o : o.label })) : [];
        }
        if (kind === 'tags' && extra.color) t.color = extra.color;
        items().push(t);
        return out(t);
      },
      async ensure(name, extra) { return find(name) ? out(find(name)) : self.create({ name, ...extra }); },
      async update(name, patch = {}) {
        const t = need(name); const old = t.name;
        if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim();
        if (kind === 'tags' && patch.color) t.color = patch.color;
        if (t.name !== old) for (const d of s.docs.values()) {
          if (kind === 'counterparties' && d.counterparty === old) d.counterparty = t.name;
          if (kind === 'types' && d.type === old) d.type = t.name;
          if (kind === 'tags') d.tags = d.tags.map(x => (x === old ? t.name : x));
          if (kind === 'fields' && old in d.fields) { d.fields[t.name] = d.fields[old]; delete d.fields[old]; }
        }
        return out(t);
      },
      async remove(name) {
        const t = need(name); s.taxonomy[kind] = items().filter(x => x !== t);
        for (const d of s.docs.values()) {
          if (kind === 'counterparties' && d.counterparty === t.name) d.counterparty = null;
          if (kind === 'types' && d.type === t.name) d.type = null;
          if (kind === 'tags') d.tags = d.tags.filter(x => x !== t.name);
          if (kind === 'fields') delete d.fields[t.name];
        }
        return { removed: t.name };
      },
      find,
    };
    return self;
  }
  const tax = { counterparties: taxonomy('counterparties'), types: taxonomy('types'), tags: taxonomy('tags'), fields: taxonomy('fields') };
  const canon = async (kind, name) => (name === null || name === undefined || name === '' ? null : (await tax[kind].ensure(name)).name);
  async function fieldValue(name, value) {
    const f = tax.fields.find(name) || await tax.fields.create({ name, dataType: 'string' });
    if (f.dataType === 'select' && value !== null && !(f.options || []).some(o => o.label === value)) throw storeError(400, 'bad_request', `${name} has no option ${value}.`);
    return [f.name, value];
  }

  const live = id => { const d = s.docs.get(Number(id)); if (!d || d.deletedAt) throw storeError(404, 'not_found', 'Document not found.'); return d; };
  const dupes = d => [...s.docs.values()].filter(o => o !== d && !o.hidden && o.checksum === d.checksum).map(o => ({ id: o.id, title: o.title, deletedAt: o.deletedAt || null }));
  const out = (d, { detail = false } = {}) => ({
    id: d.id, title: d.title, counterparty: d.counterparty, type: d.type, tags: [...d.tags], created: d.created, added: d.added, modified: d.modified,
    checksum: d.checksum, originalName: d.originalName, mimeType: d.mimeType, pageCount: null, notesCount: d.notes.length, fields: { ...d.fields },
    inbox: d.tags.map(t => t.toLowerCase()).includes(TAG_INBOX), duplicates: dupes(d),
    ...(detail ? { versions: (s.versions.get(d.id) || []).map(v => ({ id: v.id, added: v.added, label: v.label, checksum: v.checksum, isRoot: v.isRoot })) } : {}),
    ...(d.deletedAt ? { deletedAt: d.deletedAt, rootId: d.rootId ?? null, isVersion: !!(d.rootId && d.rootId !== d.id) } : {}),
  });

  function matches(d, f) {
    const lc = x => String(x ?? '').toLowerCase();
    const names = v => [].concat(v).map(lc);
    if (f.counterparty !== undefined && f.counterparty !== null && !(Array.isArray(f.counterparty) && !f.counterparty.length) && !names(f.counterparty).includes(lc(d.counterparty))) return false;
    if (f.type !== undefined && f.type !== null && !(Array.isArray(f.type) && !f.type.length) && !names(f.type).includes(lc(d.type))) return false;
    const t = tagFilter(f.tags); const has = d.tags.map(lc);
    if (f.inbox === true) t.all = [...t.all, TAG_INBOX];
    if (f.inbox === false) t.none = [...t.none, TAG_INBOX];
    if (!t.all.every(x => has.includes(lc(x)))) return false;
    if (t.any.length && !t.any.some(x => has.includes(lc(x)))) return false;
    if (t.none.some(x => has.includes(lc(x)))) return false;
    if (f.createdFrom && d.created < String(f.createdFrom).slice(0, 10)) return false;
    if (f.createdTo && d.created > String(f.createdTo).slice(0, 10)) return false;
    for (const [name, op, value] of f.fields || []) {
      const key = Object.keys(d.fields).find(k => lc(k) === lc(name)); const v = key === undefined ? undefined : d.fields[key];
      if (op === 'exists' ? (v !== undefined) !== !!value : op === 'exact' ? v !== value : op === 'icontains' ? !lc(v).includes(lc(value)) : op === 'gt' ? !(Number(v) > Number(value)) : op === 'gte' ? !(Number(v) >= Number(value)) : op === 'lt' ? !(Number(v) < Number(value)) : op === 'lte' ? !(Number(v) <= Number(value)) : true) return false;
    }
    if (f.text && !lc(`${d.title} ${d.content}`).includes(lc(f.text))) return false;
    if (f.title && !lc(d.title).includes(lc(f.title))) return false;
    if (f.checksum && d.checksum !== lc(f.checksum)) return false;
    if (Array.isArray(f.ids) && !f.ids.map(Number).includes(d.id)) return false;
    return true;
  }
  const SORT_KEY = { created: d => d.created, added: d => d.added, modified: d => d.modified, title: d => d.title.toLowerCase(), counterparty: d => (d.counterparty || '').toLowerCase(), type: d => (d.type || '').toLowerCase() };
  function pageOf(docs, f, decorate = d => out(d)) {
    const p = paging(f); const start = (p.page - 1) * p.pageSize;
    return { count: docs.length, page: p.page, pageSize: p.pageSize, results: docs.slice(start, start + p.pageSize).map(decorate) };
  }
  const liveDocs = () => [...s.docs.values()].filter(d => !d.deletedAt && !d.hidden);

  const store = {
    kind: 'fake', user,
    async addDocument(buffer, { filename, title, counterparty, type, tags, created, fields } = {}) {
      if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw storeError(400, 'bad_request', 'Send the file.');
      if (typeof filename !== 'string' || !filename.trim()) throw storeError(400, 'bad_request', 'Name the file.');
      const refused = reject && reject(buffer, filename);
      if (refused) throw storeError(400, 'store_rejected', `The document store refused POST /api/documents/post_document/ (400: document: ${refused}).`);
      if (s.failNext) { const taskId = randomUUID(); s.tasks.set(taskId, { status: 'failure', error: s.failNext }); s.failNext = null; return { taskId }; }
      const id = ++s.seq; const at = now(); const body = Buffer.from(buffer);
      const d = { id, title: title || filename.replace(/\.[^.]+$/, ''), counterparty: await canon('counterparties', counterparty), type: await canon('types', type), tags: [], created: created ? String(created).slice(0, 10) : today(), added: at, modified: at, checksum: sha256(body), originalName: filename, mimeType: mimeOf(filename), body, content: text(body, filename), fields: {}, notes: [], history: [] };
      for (const t of [].concat(tags || [])) { const n = await canon('tags', t); if (!d.tags.includes(n)) d.tags.push(n); }
      for (const [n, v] of Object.entries(fields || {})) { const [k, val] = await fieldValue(n, v); d.fields[k] = val; }
      s.docs.set(id, d);
      log(d, 'create', { title: [null, d.title] });
      const taskId = randomUUID();
      s.tasks.set(taskId, { status: 'success', documentId: id });
      return { taskId };
    },
    async waitForDocument(taskId) {
      const t = s.tasks.get(String(taskId));
      if (!t) throw storeError(404, 'not_found', 'No such task.');
      if (t.status !== 'success') throw storeError(422, 'store_task_failed', `The document store could not process it: ${t.error}`);
      return { id: t.documentId };
    },
    async add(buffer, meta, opts) { const { taskId } = await store.addDocument(buffer, meta, opts); return store.getDocument((await store.waitForDocument(taskId)).id); },
    async addVersion(id, buffer, { filename, label } = {}) {
      const d = live(id); const list = s.versions.get(d.id) || [{ id: d.id, added: d.added, label: null, checksum: d.checksum, isRoot: true, body: d.body }];
      const v = { id: ++s.seq, added: now(), label: label ? String(label).slice(0, 64) : null, checksum: sha256(buffer), isRoot: false, body: Buffer.from(buffer), filename };
      list.unshift(v); s.versions.set(d.id, list);
      s.docs.set(v.id, { ...d, id: v.id, hidden: true, rootId: d.id, body: v.body, checksum: v.checksum, notes: [], history: [] });
      log(d, 'update', { version: [null, v.id] });
      const taskId = randomUUID(); s.tasks.set(taskId, { status: 'success', documentId: v.id });
      return { taskId };
    },
    async listVersions(id) { return (s.versions.get(live(id).id) || []).map(({ body, ...v }) => v); },
    async getDocument(id, { version } = {}) {
      const d = live(id);
      if (version !== undefined && version !== null) { const v = (s.versions.get(d.id) || []).find(x => x.id === Number(version)); if (!v) throw storeError(404, 'not_found', 'Document not found.'); return { ...out(d, { detail: true }), checksum: v.checksum }; }
      return out(d, { detail: true });
    },
    async findByChecksum(sha) { const d = liveDocs().find(x => x.checksum === String(sha).toLowerCase()); return d ? out(d) : null; },
    async getOriginal(id, { version } = {}) {
      const d = live(id); const v = version !== undefined && version !== null ? (s.versions.get(d.id) || []).find(x => x.id === Number(version)) : (s.versions.get(d.id) || [])[0];
      return { body: Buffer.from(v ? v.body : d.body), filename: d.originalName, mimeType: d.mimeType };
    },
    async getPreviewPdf(id) { const d = live(id); return { body: Buffer.from(`%PDF-1.4\n% preview of ${d.title}\n`), mimeType: 'application/pdf' }; },
    async getThumbnail(id) { live(id); return { body: Buffer.from('RIFF\0\0\0\0WEBP'), mimeType: 'image/webp' }; },
    async list(f = {}) {
      const sort = checkSort(f.sort); const key = SORT_KEY[sort.replace(/^-/, '')]; const dir = sort.startsWith('-') ? -1 : 1;
      const docs = liveDocs().filter(d => matches(d, f)).sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : b.id - a.id));
      return pageOf(docs, f);
    },
    async search(query, f = {}) {
      if (typeof query !== 'string' || !query.trim()) throw storeError(400, 'bad_request', 'Type something to search for.');
      const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const scored = liveDocs().filter(d => matches(d, { ...f, text: undefined })).map(d => {
        const hay = `${d.title} ${d.content}`.toLowerCase();
        return { d, score: words.filter(w => hay.includes(w)).length };
      }).filter(x => x.score === words.length && words.length).sort((a, b) => b.score - a.score || b.d.id - a.d.id);
      return pageOf(scored, f, ({ d, score }) => {
        const i = d.content.toLowerCase().indexOf(words[0]); const from = Math.max(0, i - 40);
        let snip = escapeHtml(d.content.slice(from, from + 160));
        for (const w of words) snip = snip.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<b>$1</b>');
        return { ...out(d), hit: { score, highlights: snip, noteHighlights: '', rank: null } };
      });
    },
    async similar(id, f = {}) {
      const d = live(id); const words = new Set((d.content.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
      const docs = liveDocs().filter(o => o !== d).map(o => ({ o, n: (o.content.toLowerCase().match(/[\p{L}]{4,}/gu) || []).filter(w => words.has(w)).length })).filter(x => x.n).sort((a, b) => b.n - a.n).map(x => x.o);
      return pageOf(docs, f);
    },
    async update(id, patch = {}) {
      const d = live(id); const changes = {};
      const set = (k, v) => { if (JSON.stringify(d[k]) !== JSON.stringify(v)) { changes[k] = [d[k], v]; d[k] = v; } };
      if (typeof patch.title === 'string') set('title', patch.title);
      if (patch.created !== undefined) set('created', String(patch.created).slice(0, 10));
      if (patch.counterparty !== undefined) set('counterparty', await canon('counterparties', patch.counterparty));
      if (patch.type !== undefined) set('type', await canon('types', patch.type));
      if (Array.isArray(patch.tags)) set('tags', [...new Set(await Promise.all(patch.tags.map(t => canon('tags', t))))]);
      if (patch.fields && typeof patch.fields === 'object') {
        const next = { ...d.fields };
        for (const [n, v] of Object.entries(patch.fields)) { if (v === null) { const k = Object.keys(next).find(x => x.toLowerCase() === n.toLowerCase()); if (k) delete next[k]; } else { const [k, val] = await fieldValue(n, v); next[k] = val; } }
        set('fields', next);
      }
      if (Object.keys(changes).length) { d.modified = now(); log(d, 'update', changes); }
      return out(d, { detail: true });
    },
    async bulkUpdate(ids, op = {}) {
      const list = [].concat(ids).map(Number); list.forEach(live);
      for (const id of list) {
        const d = live(id);
        const add = await Promise.all((op.addTags || []).map(t => canon('tags', t))); const remove = (op.removeTags || []).map(t => t.toLowerCase());
        const tags = [...new Set([...d.tags.filter(t => !remove.includes(t.toLowerCase())), ...add])];
        const fields = { ...d.fields };
        for (const n of op.removeFields || []) delete fields[n];
        for (const [n, v] of Object.entries(op.setFields || {})) { const [k, val] = await fieldValue(n, v); fields[k] = val; }
        await store.update(id, { tags, fields, ...(op.counterparty !== undefined ? { counterparty: op.counterparty } : {}), ...(op.type !== undefined ? { type: op.type } : {}) });
      }
      return { ok: true, ids: list };
    },
    notes: {
      async list(id) { return live(id).notes.map(n => ({ ...n })); },
      async add(id, text) {
        if (typeof text !== 'string' || !text.trim()) throw storeError(400, 'bad_request', 'Write the note first.');
        const d = live(id); d.notes.push({ id: ++s.noteSeq, text: text.trim(), created: now(), user }); log(d, 'create', { 'Note Added': [null, s.noteSeq] });
        return store.notes.list(id);
      },
      async delete(id, noteId) { const d = live(id); d.notes = d.notes.filter(n => n.id !== Number(noteId)); log(d, 'update', { 'Note Deleted': [Number(noteId), null] }); return store.notes.list(id); },
    },
    async history(id) { return live(id).history.map(h => ({ ...h })); },
    async trash(ids) { const list = [].concat(ids).map(Number); for (const id of list) { const d = live(id); d.deletedAt = now(); } return { ids: list }; },
    async listTrash() { return [...s.docs.values()].filter(d => d.deletedAt).map(d => out(d)); },
    async restore(ids) { const list = [].concat(ids).map(Number); for (const id of list) { const d = s.docs.get(id); if (d) delete d.deletedAt; } return { ids: list }; },
    async findDuplicates(id) { return dupes(live(id)); },
    async health() { return { ok: true, version: 'fake', apiVersion: 10, detail: null }; },
    async ensureBaseTaxonomy() { for (const t of BASE_TAGS) await tax.tags.ensure(t); },
    taxonomy: tax,
    /** A fake acting as another user over the same documents (the service's per-lawyer clients). */
    as(otherUser) { return createFakeStore({ user: otherUser, now, text, reject, shared: s, raw }); },
    /** Test hook: make the next upload's task fail with `error` (Paperless reports failures only in the task). */
    failNextTask(error) { s.failNext = error; },
  };
  return raw ? store : withRules(store);
}

/** What Paperless 3.3.2 refuses at upload (verified 16 Oct): JSON, detected by content whatever the file is called. */
export function paperlessRejects(buffer) {
  const t = Buffer.from(buffer).toString('utf8').trim();
  if (!/^[{[]/.test(t)) return null;
  try { JSON.parse(t); return 'File type application/json not supported'; } catch { return null; }
}
