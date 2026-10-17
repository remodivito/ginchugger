// SPDX-License-Identifier: GPL-3.0-or-later
// What Ask sees beyond the open draft when the executor has no tool calling (plan task 10 keeps phase 2b's context as
// the fallback; with tools the model reads the store itself, server/store/tools.js): the other documents of the draft's
// counterparty, newest first, each as our own extraction of its original (never Paperless's text: plan architecture
// decision 2), signed ones marked, cut to a total that fits one request. Each keeps its paragraphs, so a quote the answer
// cites from it is checked against the same text the tools would have returned.
import { TAG_SIGNED } from './index.js';
import { readStoreText, plainText } from './text.js';

export const MAX_DOCUMENTS = 12;
export const MAX_CHARS = 60_000;
export const PER_DOCUMENT_CHARS = 15_000;

/**
 * The counterparty's other documents for Ask: [{ documentId, title, type, created, signed, text, paragraphs }], newest
 * first. `exclude`: ids not to include (the open document and its byte-identical copies). Unreadable files are skipped.
 * `text` is cut to the budget; `paragraphs` are the ones `text` holds, for checking citations.
 */
export async function counterpartyContext(store, { counterparty, exclude = [], maxDocuments = MAX_DOCUMENTS, maxChars = MAX_CHARS, perDocument = PER_DOCUMENT_CHARS } = {}) {
  if (!counterparty) return [];
  const skip = new Set(exclude.map(Number));
  const page = await store.list({ counterparty, sort: '-created', pageSize: Math.min(100, maxDocuments + skip.size) });
  const out = []; let left = maxChars;
  for (const d of page.results) {
    if (skip.has(d.id) || out.length >= maxDocuments || left <= 0) continue;
    let paragraphs;
    try { paragraphs = (await readStoreText(store, d)).paragraphs; } catch { continue; }
    let text = plainText(paragraphs);
    if (!text.trim()) continue;
    const cap = Math.min(perDocument, left);
    if (text.length > cap) {
      text = text.slice(0, cap);
      let used = 0; paragraphs = paragraphs.filter(p => (used += plainText([p]).length + 1) <= cap);
    }
    left -= text.length;
    out.push({ documentId: d.id, title: d.title, type: d.type || null, created: d.created, signed: (d.tags || []).some(t => String(t).toLowerCase() === TAG_SIGNED), text, paragraphs });
  }
  return out;
}
