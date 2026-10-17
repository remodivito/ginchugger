// SPDX-License-Identifier: GPL-3.0-or-later
// The document store's routes under /api/v2/store (tasks/paperless-store-plan.md tasks 1, 4–7). Every route goes
// through the store interface (server/store/index.js) as the acting lawyer (`service.getClient`, plan decision 5), so
// the engine's history names them, and our rules (`withRules`: signed or on-hold documents stay out of the trash, holds
// are for admins) apply to every write. Permissions follow the rest of the app (server/record/permissions.js): in solo
// mode the one user is the admin; in team mode the member's admin flag decides. Admin only: holds and the activity of
// the whole store (as the record's whole-record activity was). Everything else is for everyone.
//
//   GET  /status                       the store's status (the pages' one line)
//   GET  /taxonomy                     counterparty, type and tag names, to offer existing labels
//   GET  /inbox[?count=1]              documents tagged "inbox", newest first, each with its duplicates; uploads still processing
//   POST /documents                    multipart `file` (one or more): added with the "inbox" tag; 202 with the task ids
//   DELETE /processing/:taskId         forget a failed upload
//   GET  /documents                    the Library: q (full-text), counterparty, type, tag (repeatable), from, to, sort, page, pageSize
//   GET  /documents/:id                one document, with duplicates
//   PATCH /documents/:id               labels: title, counterparty, type, tags, created
//   POST /documents/:id/done           labels (optional) saved and the "inbox" tag removed
//   POST /documents/:id/trash          moved to the trash (409 `protected` for signed or on hold)
//   POST /documents/:id/hold           { on: true|false }, admins only
//   GET  /documents/:id/original|preview|thumb   the original (attachment, our filename), the preview, the thumbnail
//   GET  /documents/:id/email          an email's sender, recipients, subject, date and text (our parsing of the original)
//   GET  /documents/:id/paragraphs     our own text of the original (.docx, .eml, .txt, .md), for Ask
//   GET|POST /documents/:id/notes, DELETE /documents/:id/notes/:noteId
//   GET  /documents/:id/history        the store's history of the document, newest first
//   GET  /documents/:id/similar        "more like this"
//   GET  /trash, POST /trash/restore   the store's trash; restore { ids }
//   GET  /activity                     recent changes across documents (admins): built from the most recently modified
//                                      documents' histories, as the store interface has no history across documents
// The Word pane (task 8):
//   POST /pane/open                    multipart `file` (the open Word file), `add` ('false': look it up only): the store
//                                      document holding it, by checksum, else by its paragraphs' content key (Word hands
//                                      over new bytes on every read); else it is added with the "inbox" tag and the
//                                      counterparty matching suggests. { document, found }
//   POST /pane/save                    multipart `file`, `sourceId` (the document reviewed): "Save as our reply", a new
//                                      document with the source's counterparty and type, not in the inbox
//   GET|POST /documents/:id/review-events   the review history of a document (our SQLite, server/store/review-history.js);
//                                      an "Accept their wording" dismissal also adds a store note on the document (undo
//                                      deletes it)
// The Library collapses byte-identical documents on a page into one row carrying `copies` (fix B, 16 Oct).
import express from 'express';
import multer from 'multer';
import { storeError, TAG_INBOX, TAG_HOLD, titleFromName, CONTENT_KEY_FIELD } from './index.js';
import { extractText, parseEmlFull, MEDIA, sha256 } from '../record/files.js';
import { suggestStoreCounterparty } from './matching.js';
import { concessionNote } from './review-history.js';
import { plainMessage } from '../../shared/plain-error.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
export const INBOX_LIMIT = 100;
export const ACTIVITY_DOCUMENTS = 25;
export const ACTIVITY_LIMIT = 100;
export { CONTENT_KEY_FIELD };
/** The title "Save as our reply" gives the version going back. */
export const REPLY_SUFFIX = ' (our reply)';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const lc = s => String(s ?? '').toLowerCase();
const extOf = name => (String(name || '').match(/\.[^.]+$/) || [''])[0].toLowerCase();
const mediaOf = d => MEDIA[extOf(d.originalName)] || d.mimeType;
const INLINE = /^(application\/pdf|image\/(png|jpeg|webp|gif)|text\/plain)$/;
// multer reads the filename as latin1; browsers send UTF-8.
const fileName = f => { const n = Buffer.from(f.originalname, 'latin1').toString('utf8'); return n.includes('\uFFFD') ? f.originalname : n; };
const disposition = (kind, name) => `${kind}; filename="${String(name).replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/**
 * A store failure in words a lawyer can act on (stress audit, 17 Oct 2026): Paperless's own replies ("refused GET
 * /api/documents/… (400: {…})", "cannot be reached (fetch failed)", a task's traceback) go to the log, never the page.
 */
export function storeErrorMessage(err) {
  if (err?.code === 'store_unavailable') return 'The document store cannot be reached. Try again in a moment.';
  if (err?.code === 'store_task_failed') return plainMessage(err.message, 'The document store could not add this file.');
  if (err?.code === 'store_rejected' || err?.upstreamStatus) return plainMessage(err.message, 'The document store refused that. Try again, or try different words or a different file.');
  return plainMessage(err?.message, 'The document store could not do that. Try again.');
}

/** The label patch a request may make, checked. Unknown keys are ignored. */
export function labelPatch(body = {}) {
  const p = {};
  if (body.title !== undefined) { if (typeof body.title !== 'string' || !body.title.trim()) throw storeError(400, 'bad_request', 'Give it a title.'); p.title = body.title.trim().slice(0, 128); }
  for (const k of ['counterparty', 'type']) if (body[k] !== undefined) {
    if (body[k] !== null && typeof body[k] !== 'string') throw storeError(400, 'bad_request', `The ${k} is a name.`);
    p[k] = body[k] === null || !body[k].trim() ? null : body[k].trim().slice(0, 128);
  }
  if (body.created !== undefined) { if (typeof body.created !== 'string' || !DAY.test(body.created)) throw storeError(400, 'bad_request', 'The date is YYYY-MM-DD.'); p.created = body.created; }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some(t => typeof t !== 'string' || !t.trim())) throw storeError(400, 'bad_request', 'Tags are a list of names.');
    p.tags = [...new Map(body.tags.map(t => [lc(t.trim()), t.trim().slice(0, 128)])).values()];
  }
  return p;
}

/** The Library's filters from a query string. */
export function libraryFilters(q = {}) {
  const tags = [].concat(q.tag ?? []).flatMap(t => String(t).split(',')).map(t => t.trim()).filter(Boolean);
  const f = { sort: q.sort || undefined, page: q.page, pageSize: q.pageSize };
  if (q.counterparty) f.counterparty = String(q.counterparty);
  if (q.type) f.type = String(q.type);
  if (tags.length) f.tags = tags;
  for (const [k, key] of [['from', 'createdFrom'], ['to', 'createdTo']]) if (q[k]) { if (!DAY.test(String(q[k]))) throw storeError(400, 'bad_request', 'Dates are YYYY-MM-DD.'); f[key] = String(q[k]); }
  return f;
}

/**
 * One row per copy of a document on a page (fix B; plan task 11): documents with the same bytes (checksum) or the same
 * words (the Content key field: Word hands over new bytes on every read) are one row, at the place of the first on the
 * page. The copy with the most labels (counterparty, type), else the one stored first, stands for the others, with `copies`,
 * the number of live documents it stands for (those on the page with its bytes or words, and the store's byte-identical
 * duplicates elsewhere) and `copyIds`, their ids; the others are left out of the page and its count. Nothing is deleted.
 */
const labelled = d => (d.counterparty ? 1 : 0) + (d.type ? 1 : 0);
/** Which copy stands for the others: the one with more labels, then the one stored first. */
const better = (d, cur) => labelled(d) > labelled(cur) || (labelled(d) === labelled(cur) && String(d.added || '') < String(cur.added || ''));
export function collapseCopies(page) {
  const rows = []; const byKey = new Map(); const byChecksum = new Map();
  for (const d of page.results || []) {
    const key = d.fields?.[CONTENT_KEY_FIELD] || null;
    const row = (key && byKey.get(key)) || (d.checksum && byChecksum.get(d.checksum)) || null;
    if (row) { row.ids.add(d.id); for (const x of d.duplicates || []) if (!x.deletedAt) row.ids.add(x.id); if (better(d, row.doc)) row.doc = d; }
    else { const r = { doc: d, ids: new Set([d.id, ...(d.duplicates || []).filter(x => !x.deletedAt).map(x => x.id)]) }; rows.push(r); if (key) byKey.set(key, r); if (d.checksum) byChecksum.set(d.checksum, r); continue; }
    if (key && !byKey.has(key)) byKey.set(key, row);
    if (d.checksum && !byChecksum.has(d.checksum)) byChecksum.set(d.checksum, row);
  }
  const results = rows.map(r => ({ ...r.doc, copies: r.ids.size, ...(r.ids.size > 1 ? { copyIds: [...r.ids].sort((x, y) => x - y) } : {}) }));
  return { ...page, count: Math.max(0, (page.count ?? results.length) - ((page.results || []).length - results.length)), results };
}

/**
 * `service`: the store service (server/store/service.js). `actor(req)`: who is acting, as { id, name, admin }; the
 * default is the solo user (admin), as in the tests. `log`: where background upload failures are reported.
 */
export function storeRoutes(service, { actor = () => ({ id: null, name: null, admin: true }), log = console, reviews = null, ourNames = () => [] } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));
  // Uploads the store is still processing (a Paperless task each, 1–6 s): shown as "Processing" in the Inbox.
  const pending = new Map();
  const who = req => actor(req) || { id: null, name: null, admin: false };
  const h = fn => async (req, res, next) => { try { const a = who(req); await fn(req, res, service.getClient(a.id), a); } catch (e) { next(e); } };
  const docId = req => { const n = Number(req.params.id); if (!Number.isInteger(n) || n < 1) throw storeError(404, 'not_found', 'Document not found.'); return n; };
  const needAdmin = (a, message) => { if (!a.admin) throw storeError(403, 'forbidden', message); };

  r.get('/status', async (req, res, next) => { try { res.json(await service.check()); } catch (e) { next(e); } });

  r.get('/taxonomy', h(async (req, res, store) => {
    const [counterparties, types, tags] = await Promise.all(['counterparties', 'types', 'tags'].map(k => store.taxonomy[k].list()));
    const names = list => list.map(x => x.name);
    res.json({ counterparties: names(counterparties), types: names(types), tags: names(tags) });
  }));

  // ---- Inbox (task 4)
  r.get('/inbox', h(async (req, res, store) => {
    const processing = [...pending.values()];
    if (req.query.count) return res.json({ count: (await store.list({ inbox: true, pageSize: 1 })).count, processing: processing.filter(p => !p.error).length });
    const page = await store.list({ inbox: true, sort: '-added', pageSize: INBOX_LIMIT });
    const documents = await Promise.all(page.results.map(async d => ({ ...d, duplicates: await store.findDuplicates(d.id).catch(() => []) })));
    res.json({ count: page.count, documents, processing });
  }));
  r.post('/documents', upload.array('file', 20), h(async (req, res, store, a) => {
    if (!req.files?.length) throw storeError(400, 'bad_request', 'Send the document as a file.');
    const tasks = [];
    for (const f of req.files) {
      const filename = fileName(f);
      const { taskId } = await store.addDocument(f.buffer, { filename, title: titleFromName(filename), tags: [TAG_INBOX] }, { actor: a });
      const entry = { taskId, filename, since: new Date().toISOString(), error: null };
      pending.set(taskId, entry); tasks.push(entry);
      store.waitForDocument(taskId).then(() => pending.delete(taskId), e => { entry.error = storeErrorMessage(e); log.error?.(`Upload not added: ${filename}: ${e.message}`); });
    }
    res.status(202).json({ tasks });
  }));
  r.delete('/processing/:taskId', (req, res) => { const p = pending.get(req.params.taskId); if (p?.error) pending.delete(req.params.taskId); res.json({ ok: true }); });

  // ---- Library (task 5)
  r.get('/documents', h(async (req, res, store) => {
    const f = libraryFilters(req.query);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.json(collapseCopies(q ? await store.search(q, { ...f, sort: undefined }) : await store.list(f)));
  }));

  // ---- The Word pane (task 8)
  const docxText = async (buffer, name) => extractText(buffer, MEDIA['.docx'], name);
  r.post('/pane/open', upload.single('file'), h(async (req, res, store, a) => {
    if (!req.file) throw storeError(400, 'bad_request', 'Send the document as a file.');
    const filename = fileName(req.file);
    const byBytes = await store.findByChecksum(sha256(req.file.buffer));
    if (byBytes) return res.json({ document: byBytes, found: true });
    const t = await docxText(req.file.buffer, filename);
    const key = t.contentKey || null;
    if (key) {
      // Several documents can hold the same words; the one the Library shows for them stands for them (`better`): an
      // unlabelled copy stored first would leave the review and Ask with no counterparty (live bug, 17 Oct 2026).
      const copies = (await store.list({ fields: [[CONTENT_KEY_FIELD, 'exact', key]], sort: 'added', pageSize: 25 }).catch(() => ({ results: [] }))).results;
      const byKey = copies.reduce((best, d) => (!best || better(d, best) ? d : best), null);
      if (byKey) return res.json({ document: byKey, found: true });
    }
    if (req.body?.add === 'false') return res.json({ document: null, found: false });
    const counterparty = await suggestStoreCounterparty(store, { paragraphs: t.paragraphs || [] }, { ourNames: ourNames() }).catch(() => null);
    const document = await store.add(req.file.buffer, { filename, title: titleFromName(filename), counterparty, tags: [TAG_INBOX], ...(key ? { fields: { [CONTENT_KEY_FIELD]: key } } : {}) }, { actor: a });
    res.status(201).json({ document, found: false });
  }));
  r.post('/pane/save', upload.single('file'), h(async (req, res, store, a) => {
    if (!req.file) throw storeError(400, 'bad_request', 'Send the document as a file.');
    const filename = fileName(req.file);
    const sourceId = Number(req.body?.sourceId);
    const source = Number.isInteger(sourceId) && sourceId > 0 ? await store.getDocument(sourceId).catch(e => { if (e.status === 404) return null; throw e; }) : null;
    const key = (await docxText(req.file.buffer, filename)).contentKey || null;
    const title = source ? `${source.title}${REPLY_SUFFIX}`.slice(0, 128) : titleFromName(filename);
    const document = await store.add(req.file.buffer, { filename, title, counterparty: source?.counterparty || null, type: source?.type || null, tags: [], ...(key ? { fields: { [CONTENT_KEY_FIELD]: key } } : {}) }, { actor: a });
    res.status(201).json({ document });
  }));

  // ---- One document (tasks 4 and 6)
  r.get('/documents/:id', h(async (req, res, store) => res.json(await store.getDocument(docId(req)))));
  r.patch('/documents/:id', h(async (req, res, store, a) => res.json(await store.update(docId(req), labelPatch(req.body), { actor: a }))));
  r.post('/documents/:id/done', h(async (req, res, store, a) => {
    const id = docId(req); const patch = labelPatch(req.body || {});
    const tags = patch.tags ?? (await store.getDocument(id)).tags;
    res.json(await store.update(id, { ...patch, tags: tags.filter(t => lc(t) !== TAG_INBOX) }, { actor: a }));
  }));
  r.post('/documents/:id/trash', h(async (req, res, store, a) => res.json(await store.trash([docId(req)], { actor: a }))));
  r.post('/documents/:id/hold', h(async (req, res, store, a) => {
    needAdmin(a, 'Only an admin can set or lift a hold.');
    const id = docId(req); const on = req.body?.on === true;
    const now = (await store.getDocument(id)).tags.filter(t => lc(t) !== TAG_HOLD);
    res.json(await store.update(id, { tags: on ? [...now, TAG_HOLD] : now }, { actor: a }));
  }));
  r.get('/documents/:id/original', h(async (req, res, store) => {
    const f = await store.getOriginal(docId(req));
    res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', disposition('attachment', f.filename || 'document'));
    res.send(f.body);
  }));
  // Shown inline only when the browser cannot run it (a PDF, an image, plain text); anything else is a download.
  const binary = get => h(async (req, res, store) => {
    const f = await get(store, docId(req));
    const type = String(f.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    res.setHeader('Content-Type', INLINE.test(type) ? f.mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', INLINE.test(type) ? 'inline' : 'attachment');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(f.body);
  });
  r.get('/documents/:id/preview', binary((s, id) => s.getPreviewPdf(id)));
  r.get('/documents/:id/thumb', binary((s, id) => s.getThumbnail(id)));
  r.get('/documents/:id/email', h(async (req, res, store) => {
    const id = docId(req); const d = await store.getDocument(id);
    if (mediaOf(d) !== MEDIA['.eml']) return res.json(null);
    const m = await parseEmlFull((await store.getOriginal(id)).body);
    res.json({ from: m.from, to: m.to, subject: m.subject, date: m.date, text: String(m.text || '').slice(0, 4000) });
  }));
  r.get('/documents/:id/paragraphs', h(async (req, res, store) => {
    const id = docId(req); const d = await store.getDocument(id);
    const t = await extractText((await store.getOriginal(id)).body, mediaOf(d), d.originalName || d.title);
    const paragraphs = (t.paragraphs || []).filter(p => String(p.text).trim()).slice(0, 1500).map(p => ({ id: p.id, text: p.text }));
    if (!paragraphs.length) throw storeError(415, 'not_readable', 'This file has no text we can read.');
    res.json({ id: `store-${d.id}`, title: d.title, paragraphs });
  }));
  r.get('/documents/:id/notes', h(async (req, res, store) => res.json(await store.notes.list(docId(req)))));
  r.post('/documents/:id/notes', h(async (req, res, store, a) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (text.length > 10_000) throw storeError(400, 'bad_request', 'A note is at most 10,000 characters.');
    res.status(201).json(await store.notes.add(docId(req), text, { actor: a }));
  }));
  r.delete('/documents/:id/notes/:noteId', h(async (req, res, store, a) => res.json(await store.notes.delete(docId(req), Number(req.params.noteId), { actor: a }))));
  r.get('/documents/:id/history', h(async (req, res, store) => res.json(await store.history(docId(req)))));
  r.get('/documents/:id/similar', h(async (req, res, store) => res.json(await store.similar(docId(req), { page: req.query.page, pageSize: req.query.pageSize || 6 }))));

  // ---- Review history (task 8): our SQLite, keyed by the store document's id
  const history = () => { if (!reviews) throw storeError(503, 'store_unavailable', 'The review history is not available.'); return reviews; };
  r.get('/documents/:id/review-events', (req, res, next) => { try { res.json(history().list(docId(req))); } catch (e) { next(e); } });
  r.post('/documents/:id/review-events', async (req, res, next) => {
    try {
      const id = docId(req); const a = who(req);
      const events = history().append(id, req.body?.events, a.name || null);
      await concessions(id, events, a);
      res.status(201).json({ events });
    } catch (e) { next(e); }
  });
  // "Accept their wording" is a position we took: it goes on the document as a store note, written as the lawyer, so
  // the agent reads it on the next review; undoing the dismissal deletes that note. "Not an issue" adds nothing. The
  // store is best effort here: if it cannot be reached the dismissal is still in the review history and nothing is said.
  async function concessions(id, events, a) {
    for (const e of events) {
      const { reviewId, findingId } = e.payload;
      try {
        if (e.type === 'finding_dismissed' && e.payload.reason === 'accepted') {
          const flagged = reviews.flagged(id, reviewId, findingId) || {};
          const text = concessionNote({ ...e.payload, title: e.payload.title || flagged.title, quote: e.payload.quote || flagged.quote });
          const store = service.getClient(a.id);
          const old = reviews.takeConcessionNote(id, reviewId, findingId);
          if (old !== null) await store.notes.delete(id, old, { actor: a }).catch(() => null);
          const notes = await store.notes.add(id, text, { actor: a });
          const mine = (notes || []).filter(n => n.text === text).sort((x, y) => y.id - x.id)[0];
          if (mine) reviews.setConcessionNote(id, reviewId, findingId, mine.id);
        } else if (e.type === 'finding_undismissed') {
          const old = reviews.takeConcessionNote(id, reviewId, findingId);
          if (old !== null) await service.getClient(a.id).notes.delete(id, old, { actor: a });
        }
      } catch (err) { log.error?.(`Concession note not ${e.type === 'finding_undismissed' ? 'removed' : 'added'} on document ${id}: ${err.message}`); }
    }
  }

  // ---- Trash and activity (task 7)
  r.get('/trash', h(async (req, res, store) => {
    const items = (await store.listTrash()).sort((x, y) => String(y.deletedAt).localeCompare(String(x.deletedAt)));
    res.json({ items });
  }));
  r.post('/trash/restore', h(async (req, res, store, a) => {
    const ids = [].concat(req.body?.ids ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) throw storeError(400, 'bad_request', 'Which documents?');
    res.json(await store.restore(ids, { actor: a }));
  }));
  r.get('/activity', h(async (req, res, store, a) => {
    needAdmin(a, 'The activity of the whole store is for admins.');
    const recent = await store.list({ sort: '-modified', pageSize: ACTIVITY_DOCUMENTS });
    const per = await Promise.all(recent.results.map(async d => (await store.history(d.id).catch(() => [])).map(e => ({ ...e, document: { id: d.id, title: d.title } }))));
    const items = per.flat().sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, ACTIVITY_LIMIT);
    res.json({ items, documents: recent.results.length });
  }));

  r.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A file is at most 25 MB.' : err.message, code: 'bad_request' });
    const error = storeErrorMessage(err);
    if (error !== err.message) log.error?.(`Store request failed: ${req.method} ${req.originalUrl.slice(0, 200)}: ${err.message}`);
    res.status(err.status || 500).json({ error, ...(err.code ? { code: err.code } : {}) });
  });
  return r;
}
