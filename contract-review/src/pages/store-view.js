// SPDX-License-Identifier: GPL-3.0-or-later
// What the store's screens (Inbox, Library, document page, Trash, Activity; tasks/paperless-store-plan.md tasks 4–7)
// share and what can be tested without a browser: a search hit's snippet as plain parts, our rules' reasons, a history
// entry in plain words, and a document's labels as the editor holds them.

export const TAG_INBOX = 'inbox';
export const TAG_SIGNED = 'signed';
export const TAG_HOLD = 'on hold';
const lc = s => String(s ?? '').toLowerCase();
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const isWord = d => /\.docx$/i.test(d?.originalName || '') || d?.mimeType === WORD;
export const isEmail = d => /\.eml$/i.test(d?.originalName || '') || d?.mimeType === 'message/rfc822';
export const hasTag = (d, name) => (d?.tags || []).some(t => lc(t) === name);
export const docHref = id => `#/documents/${encodeURIComponent(id)}`;
export const storeUrl = (id, part = '') => `/api/v2/store/documents/${encodeURIComponent(id)}${part ? `/${part}` : ''}`;

/** Why a document stays out of the trash (our rules, server/store/index.js `withRules`), or null. */
export function protection(d) {
  if (hasTag(d, TAG_SIGNED)) return 'Signed: kept out of the trash';
  if (hasTag(d, TAG_HOLD)) return 'On hold: kept out of the trash';
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#x27': "'", '#39': "'", nbsp: ' ' };
export const unescapeHtml = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k in ENTITIES) return ENTITIES[k];
  if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
  if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
  return m;
});

/**
 * A search hit's highlights (the engine's HTML: escaped text with <b>…</b> or <span class="match">…</span> around the
 * words found) as parts to render as text, never as HTML: [{ text, hit }].
 */
export function highlightParts(html) {
  const parts = [];
  const re = /<(b|strong|span)[^>]*>([\s\S]*?)<\/\1>/gi;
  let at = 0, m;
  const plain = s => unescapeHtml(s.replace(/<[^>]*>/g, ''));
  while ((m = re.exec(String(html || '')))) {
    if (m.index > at) parts.push({ text: plain(html.slice(at, m.index)), hit: false });
    parts.push({ text: plain(m[2]), hit: true });
    at = m.index + m[0].length;
  }
  if (at < String(html || '').length) parts.push({ text: plain(html.slice(at)), hit: false });
  return parts.filter(p => p.text);
}

/** The labels a lawyer edits (the "inbox" tag is the Inbox's state, not a label). */
export const labelsOf = d => ({ title: d?.title || '', counterparty: d?.counterparty || '', type: d?.type || '', created: d?.created || '', tags: (d?.tags || []).filter(t => lc(t) !== TAG_INBOX) });
export const sameLabels = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The labels as a request sends them: empty names cleared, the inbox tag kept when the document has it. */
export const labelBody = (labels, d) => ({ title: labels.title, counterparty: labels.counterparty || null, type: labels.type || null, ...(labels.created ? { created: labels.created } : {}), tags: [...labels.tags, ...(d?.inbox ? [TAG_INBOX] : [])] });

// ---- History in plain words. Paperless reports values as strings ("None" for nothing) and relations by id; the fake
// reports names. Changes the engine makes for itself (files, checksums, owner) are left out.
const NONE = v => v === null || v === undefined || v === 'None' || v === '';
const after = v => (Array.isArray(v) ? v[1] : v);
const named = v => (NONE(v) || /^\d+$/.test(String(v)) ? null : String(v));
const quiet = new Set(['archive_checksum', 'filename', 'archive_filename', 'owner', 'modified', 'checksum', 'content', 'page_count', 'mime_type', 'added', 'original_filename', 'root_document', 'storage_path', 'id', 'restored_at', 'share_links', 'notes', 'barcodes', 'versions', 'workflow_runs', 'archive_serial_number']);

// Paperless (django-auditlog) reports a tag taken off as operation "delete"; the fake says "remove".
function tagChange(v) {
  if (v && !Array.isArray(v) && typeof v === 'object') return `${v.operation === 'remove' || v.operation === 'delete' ? 'Removed tag' : 'Tagged'} ${[].concat(v.objects || []).join(', ')}`;
  if (Array.isArray(v) && Array.isArray(v[0]) && Array.isArray(v[1])) {
    const add = v[1].filter(t => !v[0].includes(t)), remove = v[0].filter(t => !v[1].includes(t));
    return [add.length ? `Tagged ${add.join(', ')}` : null, remove.length ? `Removed tag ${remove.join(', ')}` : null].filter(Boolean).join('; ') || null;
  }
  return 'Changed the tags';
}

/** One history entry ({ action, changes }) as a line, or null when it records only the engine's own housekeeping. */
export function describeChange(entry) {
  const c = entry?.changes || {};
  if (entry?.action === 'create' && 'title' in c) return 'Added';
  const out = [];
  for (const [k, v] of Object.entries(c)) {
    if (quiet.has(k)) continue;
    if (k === 'Note Added') out.push('Added a note');
    else if (k === 'Note Deleted') out.push('Deleted a note');
    else if (k === 'Version Added' || k === 'version') out.push('Added a version');
    else if (k === 'title') out.push(`Renamed to “${after(v)}”`);
    else if (k === 'correspondent' || k === 'counterparty') out.push(NONE(after(v)) ? 'Cleared the counterparty' : named(after(v)) ? `Counterparty set to ${after(v)}` : 'Changed the counterparty');
    else if (k === 'document_type' || k === 'type') out.push(NONE(after(v)) ? 'Cleared the type' : named(after(v)) ? `Type set to ${after(v)}` : 'Changed the type');
    else if (k === 'created') out.push(`Date set to ${String(after(v)).slice(0, 10)}`);
    else if (k === 'tags') { const t = tagChange(v); if (t) out.push(t); }
    else if (k === 'deleted_at') out.push(NONE(after(v)) ? 'Restored' : 'Moved to the trash');
    else if (k === 'custom_fields') out.push(v && typeof v === 'object' && !Array.isArray(v) && v.field ? `Set ${v.field}` : 'Changed a field');
    else if (k === 'fields') out.push('Changed a field');
  }
  return out.length ? out.join('; ') : null;
}

export const SORT_OPTIONS = [['-created', 'Newest'], ['created', 'Oldest'], ['-added', 'Recently added'], ['title', 'Title'], ['counterparty', 'Counterparty']];
