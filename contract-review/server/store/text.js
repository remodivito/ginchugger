// SPDX-License-Identifier: GPL-3.0-or-later
// A store document's text as the review, Ask and the agent tools read it (plan architecture decision 2): our own
// extraction of the original file (always downloaded as the original), never Paperless's text, which for a .docx joins
// tracked deletions and insertions. Paragraphs keep the product's representation of a tracked change: `text` is the
// wording with it, `originalText` the wording before it. One function, so the tools, Ask's fallback context and the
// citation check all see the same text.
import { extractText, MEDIA } from '../record/files.js';
import { storeError } from './index.js';

const extOf = name => (String(name || '').match(/\.[^.]+$/) || [''])[0].toLowerCase();
/** The media type our extraction reads a store document as: by its original file's extension, else the store's type. */
export const mediaOf = d => MEDIA[extOf(d.originalName)] || d.mimeType;

/**
 * `doc`: a store document (or its id). Returns { document, paragraphs: [{ id, text, originalText? }] (empty lines left
 * out), email: { from, to, subject, date } | null }. Throws 415 `not_readable` for a file with no text we can read.
 */
export async function readStoreText(store, doc) {
  const d = typeof doc === 'object' && doc ? doc : await store.getDocument(doc);
  const f = await store.getOriginal(d.id);
  const t = await extractText(f.body, mediaOf(d), d.originalName || d.title);
  if (!Array.isArray(t.paragraphs)) throw storeError(415, 'not_readable', 'This file has no text we can read.');
  const paragraphs = t.paragraphs
    .filter(p => String(p.text || '').trim() || String(p.originalText || '').trim())
    .map(p => ({ id: p.id, text: String(p.text ?? ''), ...(typeof p.originalText === 'string' && p.originalText !== p.text ? { originalText: p.originalText } : {}), ...(p.hidden ? { hidden: true } : {}) }));
  const head = mediaOf(d) === MEDIA['.eml'] ? (t.warnings || [])[0] || null : null;
  return { document: d, paragraphs, email: head ? { from: head.from ?? null, to: head.to ?? null, subject: head.subject ?? null, date: head.date ?? null } : null };
}

/** The text a citation's quote must be an exact substring of: every paragraph's wording, then every earlier wording. */
export function citableText({ paragraphs = [], email = null } = {}) {
  const before = paragraphs.filter(p => typeof p.originalText === 'string').map(p => p.originalText);
  const head = email ? [email.from, email.to, email.subject].filter(Boolean) : [];
  return [paragraphs.map(p => p.text).join('\n'), before.join('\n'), head.join('\n')].filter(Boolean).join('\n\n');
}

/** Paragraphs as one text, a tracked change's earlier wording beside it (Ask's fallback context, server/store/context.js); a paragraph holding hidden text says so. */
export function plainText(paragraphs = []) {
  return paragraphs.map(p => `${typeof p.originalText === 'string' && p.originalText !== p.text ? `${p.text}  [tracked; before: ${p.originalText}]` : p.text}${p.hidden ? '  [hidden text in this paragraph]' : ''}`).join('\n');
}
