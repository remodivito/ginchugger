// SPDX-License-Identifier: GPL-3.0-or-later
// The document store interface (decisions 190 and 191; tasks/paperless-store-plan.md, architecture decision 1). Every
// screen, the Word pane and the agent reach documents through these operations only, so the engine behind them
// (Paperless-ngx today, server/store/paperless.js; the in-memory fake for tests, server/store/fake.js) can be swapped.
// The operations are the table "What this means for our store interface" in dms-port-research/paperless-headless-spike.md.
//
// Names, not engine ids, cross this interface: a document carries its counterparty, type and tags by name and its custom
// fields as { name: value }; the adapter maps names to ids. Our own rules sit on top of either engine (`withRules`):
// a document tagged "signed" or "on hold" cannot be moved to the trash, and only an admin sets or lifts a hold.
//
// A document, as every operation returns it:
//   { id, title, counterparty, type, tags: [name], created: 'YYYY-MM-DD', added, modified, checksum (SHA-256 of the
//     original), originalName, mimeType, pageCount, notesCount, fields: { name: value }, inbox: boolean,
//     duplicates?: [{ id, title, deletedAt }] (getDocument and list results: Paperless v10 lists them too), versions?: [...] (getDocument only),
//     deletedAt?, rootId?, isVersion? (trash items only), hit?: { score, highlights, noteHighlights, rank } (search) }
//
// Operations (all async):
//   addDocument(buffer, { filename, title, counterparty, type, tags, created, fields }, { actor }) → { taskId }
//   waitForDocument(taskId, { timeoutMs }) → { id }; a failed task throws code 'store_task_failed'
//   add(buffer, meta, opts) → document (addDocument, then waitForDocument, then getDocument)
//   addVersion(id, buffer, { filename, label }) → { taskId }        listVersions(id) → [{ id, added, label, checksum, isRoot }]
//   getDocument(id, { version }) → document                          findByChecksum(sha256) → document | null
//   getOriginal(id, { version }) → { body: Buffer, filename, mimeType } (always the original bytes, our filename)
//   getPreviewPdf(id) / getThumbnail(id) → { body: Buffer, mimeType }
//   list({ counterparty, type, tags: [name] | { all, any, none }, createdFrom, createdTo, fields: [[name, op, value]],
//          inbox, text, title, checksum, ids, sort, page, pageSize }) → { count, page, pageSize, results }
//   search(query, { page, pageSize, ...list filters }) → { count, page, pageSize, results (each with `hit`) }
//   similar(id, { page, pageSize }) → { count, page, pageSize, results }
//   update(id, { title, counterparty, type, tags, created, fields }, { actor }) → document (fields merge; null removes)
//   bulkUpdate(ids, { addTags, removeTags, counterparty, type, setFields, removeFields }, { actor }) → { ok, ids }
//   notes.add(id, text, { actor }) → [note]   notes.list(id) → [note]   notes.delete(id, noteId) → [note]
//     note: { id, text, created, user }
//   history(id) → [{ id, at, action, changes, actor }] newest first
//   trash(ids, { actor }) → { ids }   listTrash() → [document]   restore(ids) → { ids }
//   taxonomy.<kind>.list() / get(name) / ensure(name, extra) / create({ name, ... }) / update(name, patch) / remove(name)
//     kinds: counterparties (Paperless correspondents), types (document types), tags, fields (custom fields)
//   findDuplicates(id) → [{ id, title, deletedAt }]
//   health() → { ok, version, apiVersion }

export const TAG_SIGNED = 'signed';
export const TAG_HOLD = 'on hold';
export const TAG_INBOX = 'inbox';
/** The custom field a Word file's content key is kept in (fields are not shown on our screens): the hash of its
 *  paragraphs and tracked changes, so a document Word hands over with new bytes is still found (task 8, fix B). */
export const CONTENT_KEY_FIELD = 'Content key';
/** The tags every store has from the start (our taxonomy, created with matching off: spike gap 9). */
export const BASE_TAGS = [TAG_SIGNED, TAG_HOLD, TAG_INBOX];
export const TAXONOMY_KINDS = ['counterparties', 'types', 'tags', 'fields'];
export const FIELD_TYPES = ['string', 'url', 'date', 'boolean', 'integer', 'float', 'monetary', 'documentlink', 'select', 'longtext'];
/** List orderings we offer, by our name; the adapter maps them to the engine's. */
export const SORTS = ['created', '-created', 'added', '-added', 'modified', '-modified', 'title', '-title', 'counterparty', '-counterparty', 'type', '-type'];

/** Every operation an implementation must provide (checked by `checkStore`). */
export const OPERATIONS = ['addDocument', 'waitForDocument', 'add', 'addVersion', 'listVersions', 'getDocument', 'findByChecksum', 'getOriginal', 'getPreviewPdf', 'getThumbnail', 'list', 'search', 'similar', 'update', 'bulkUpdate', 'history', 'trash', 'listTrash', 'restore', 'findDuplicates', 'health'];

export const storeError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/** File extensions a title never carries (phase 2b, fix A): the ones our captures and the migration produce. */
export const TITLE_EXTENSION = /\.(docx?|pdf|eml|msg|txt|md|json|rtf|odt|html?|xlsx?)$/i;
/** A document's title from a file name: the name without its extension ("northgate-v2.docx" → "northgate-v2"). */
export function titleFromName(name, fallback = 'Untitled') {
  const t = String(name ?? '').trim().replace(TITLE_EXTENSION, '').trim();
  return (t || fallback).slice(0, 128);
}

/** Throws naming the first missing operation, so a new engine cannot be wired in half done. */
export function checkStore(store) {
  for (const op of OPERATIONS) if (typeof store[op] !== 'function') throw new Error(`The store has no ${op} operation.`);
  for (const op of ['add', 'list', 'delete']) if (typeof store.notes?.[op] !== 'function') throw new Error(`The store has no notes.${op} operation.`);
  for (const kind of TAXONOMY_KINDS) for (const op of ['list', 'get', 'ensure', 'create', 'update', 'remove']) if (typeof store.taxonomy?.[kind]?.[op] !== 'function') throw new Error(`The store has no taxonomy.${kind}.${op} operation.`);
  return store;
}

const lower = names => (names || []).map(n => String(n).toLowerCase());
const hasTag = (tags, name) => lower(tags).includes(name);
const isAdmin = actor => !!(actor && typeof actor === 'object' && actor.admin);
const needAdminForHold = (touches, actor) => { if (touches && !isAdmin(actor)) throw storeError(403, 'forbidden', 'Only an admin can set or lift a hold.'); };

/**
 * Our rules on top of an engine (plan task 7; audit finding 5): documents tagged "signed" or "on hold" cannot be moved
 * to the trash (409, code `protected`), and only an admin (`actor.admin`) adds or removes the "on hold" tag (403).
 * Everything else passes through unchanged.
 */
export function withRules(store) {
  const ruled = Object.create(store);
  Object.assign(ruled, {
    async addDocument(buffer, meta = {}, opts = {}) {
      needAdminForHold(hasTag(meta.tags, TAG_HOLD), opts.actor);
      return store.addDocument(buffer, meta, opts);
    },
    async add(buffer, meta = {}, opts = {}) {
      const { taskId } = await ruled.addDocument(buffer, meta, opts);
      const { id } = await store.waitForDocument(taskId, opts);
      return store.getDocument(id);
    },
    async update(id, patch = {}, opts = {}) {
      if (Array.isArray(patch.tags)) {
        const now = await store.getDocument(id);
        needAdminForHold(hasTag(now.tags, TAG_HOLD) !== hasTag(patch.tags, TAG_HOLD), opts.actor);
      }
      return store.update(id, patch, opts);
    },
    async bulkUpdate(ids, op = {}, opts = {}) {
      needAdminForHold(hasTag(op.addTags, TAG_HOLD) || hasTag(op.removeTags, TAG_HOLD), opts.actor);
      return store.bulkUpdate(ids, op, opts);
    },
    async trash(ids, opts = {}) {
      const list = [].concat(ids);
      for (const id of list) {
        const d = await store.getDocument(id);
        if (hasTag(d.tags, TAG_SIGNED)) throw storeError(409, 'protected', `${d.title} is signed, so it cannot be moved to the trash.`, { documentId: d.id });
        if (hasTag(d.tags, TAG_HOLD)) throw storeError(409, 'protected', `${d.title} is on hold, so it cannot be moved to the trash.`, { documentId: d.id });
      }
      return store.trash(list, opts);
    },
  });
  return checkStore(ruled);
}

/** `sort` by our name, or the default (newest first). */
export function checkSort(sort) {
  if (sort === undefined || sort === null || sort === '') return '-created';
  if (!SORTS.includes(sort)) throw storeError(400, 'bad_request', `Sort by one of: ${SORTS.join(', ')}.`);
  return sort;
}

/** `tags` filter as { all, any, none } (a plain list means all of them). */
export function tagFilter(tags) {
  if (!tags) return { all: [], any: [], none: [] };
  if (Array.isArray(tags)) return { all: tags, any: [], none: [] };
  return { all: tags.all || [], any: tags.any || [], none: tags.none || [] };
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export function paging({ page, pageSize } = {}) {
  const p = Number.isInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const s = Number.isInteger(Number(pageSize)) && Number(pageSize) > 0 ? Math.min(Number(pageSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: p, pageSize: s };
}
