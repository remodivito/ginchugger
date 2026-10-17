// SPDX-License-Identifier: GPL-3.0-or-later
// Word task-pane adapter (spec R6.3–R6.5; T11). Apply follows the pattern shipping add-ins use (research E58):
//   1. locate once: paragraph-scoped exact search (≤255 chars, exactly one hit), falling back to the whole body;
//   2. track: set changeTrackingMode to trackAll in its own sync, insert after the range then delete it (a tracked
//      Replace can decompose on Word for Mac), restore the previous mode;
//   3. anchor the inserted wording with a hidden bookmark (name starts with an underscore, ≤40 chars, no finding id).
//      The pane and its saved session remember which bookmark belongs to which finding; nothing about the review is
//      written into the document's add-in settings, and cleanOutgoing() removes the bookmarks before a version is sent;
//   4. verify: re-read the paragraph and confirm the new wording is present before reporting success.
// Nothing is applied in bulk; nothing is applied without the lawyer's action; a missing or ambiguous target is a
// warning and no edit. The Word API objects are injected so the logic is unit-testable without Word.

const SEARCH_LIMIT = 255;
const LEGACY_REGISTRY_KEY = 'margin.anchors.v1'; // written by builds before 5 Oct 2026; only ever removed now
const BOOKMARK_PREFIX = '_m_';

import { selectionIndexes } from './review/ask-client.js';
import { plainMessage } from '../shared/plain-error.js';
export const OFFICE_JS = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';
let ready = null;

// One queue for every call that changes the document or what Word shows (apply, undo, mark, select, clean): Word runs
// them one at a time, in the order the lawyer asked, so a mark cannot land between an apply's search and its edit.
// Reads are not queued. A queued call must never wait on another queued call.
let wordChain = Promise.resolve();
function queued(fn) { const run = wordChain.then(fn); wordChain = run.catch(() => {}); return run; }
/** Load Office.js when the pane is opened by Word (`?host=` in the URL) and wait for Office.onReady. Resolves false in a plain browser. */
export function initializeWord() {
  if (ready) return ready;
  const hosted = new URLSearchParams(globalThis.location?.search || '').has('host');
  if (!globalThis.Office && !hosted) return Promise.resolve(false);
  ready = new Promise((resolve, reject) => {
    const finish = () => { const timer = setTimeout(() => reject(Error('Word did not initialize. Open the sideloaded task pane in Word.')), 12000); globalThis.Office.onReady(() => { clearTimeout(timer); resolve(detectWord()); }); };
    if (globalThis.Office) return finish();
    const script = globalThis.document.createElement('script'); script.src = OFFICE_JS; script.onload = finish; script.onerror = () => reject(Error('Could not load Microsoft Office.js.')); globalThis.document.head.appendChild(script);
  });
  return ready;
}
export function detectWord() { return Boolean(globalThis.Word && globalThis.Office?.context?.document); }
function requireWord() { if (!detectWord()) throw Error('Open this pane inside Word to use document actions.'); }

/** Split a long quote into the first ≤255-char piece Word can search for, cut at a word boundary. */
export function searchNeedle(quote) {
  const q = String(quote).replace(/\s+/g, ' ').trim();
  if (q.length <= SEARCH_LIMIT) return q;
  const cut = q.lastIndexOf(' ', SEARCH_LIMIT); return q.slice(0, cut > 40 ? cut : SEARCH_LIMIT).trim();
}
const norm = s => String(s).replace(/\s+/g, ' ').trim();

// Word's own error codes, in words a lawyer can act on. Anything else that looks like a bare code gets the general line.
const WORD_ERRORS = {
  SearchStringInvalidOrTooLong: 'Word could not search for that passage. Apply the wording in Word by hand.',
  ItemNotFound: 'That passage is no longer in the document. Rerun the review.',
  InvalidArgument: 'Word refused that change. Apply the wording in Word by hand.',
  AccessDenied: 'Word did not allow the change. Check the document is not read-only or protected.',
  NotAllowed: 'Word did not allow the change. Check the document is not read-only or protected.',
  ApiNotFound: 'This version of Word cannot make that change. Update Word, or apply it by hand.',
  GeneralException: 'Word could not make the change. Try again, or apply it by hand.',
};
const GENERAL_WORD_ERROR = 'Word could not make the change. Try again, or apply it by hand.';
/** The message to show for an error: a known Word code in plain words; any other bare code or Office internals, a general line. */
export function plainError(e) {
  const message = String(e?.message || '');
  if (e?.status) return plainMessage(message); // the app's own server errors, guarded once more
  const code = (typeof e?.code === 'string' && WORD_ERRORS[e.code]) ? e.code : (/^[A-Z][A-Za-z]+$/.test(message) ? message : null);
  if (code) return WORD_ERRORS[code] || GENERAL_WORD_ERROR;
  return plainMessage(message, GENERAL_WORD_ERROR);
}

const officeCall = fn => new Promise((resolve, reject) => fn(r => r.status === globalThis.Office.AsyncResultStatus.Succeeded ? resolve(r.value) : reject(Error(r.error?.message || 'Word could not complete the request.'))));

/** The open document's bytes (a .docx), read from Word in slices. Phase 6 W1: this is what lets the pane use the server's importer. */
export async function readWordFileBytes() {
  requireWord();
  const officeDoc = globalThis.Office.context.document;
  const file = await officeCall(cb => officeDoc.getFileAsync(globalThis.Office.FileType.Compressed, { sliceSize: 65536 }, cb));
  try {
    const chunks = [];
    for (let i = 0; i < file.sliceCount; i++) { const slice = await officeCall(cb => file.getSliceAsync(i, cb)); chunks.push(new Uint8Array(slice.data)); }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  } finally { await new Promise(resolve => file.closeAsync(() => resolve())); }
}

/** Word's own paragraphs as plain text: the cheap read, used for "has the document changed" and for alignment. */
export async function readWordTexts() {
  requireWord();
  return globalThis.Word.run(async context => {
    const paragraphs = context.document.body.paragraphs; paragraphs.load('items/text'); await context.sync();
    return paragraphs.items.map(p => p.text);
  });
}

/**
 * Line the server's paragraphs up with Word's (Phase 6, W1/W2). Measured on Word for Mac 16.113: same count, same order,
 * and Word's paragraph text equals the server's current text (tracked deletions excluded), tables and fields included.
 * So: same index when the text agrees; otherwise the one other paragraph with that text; otherwise no index, and
 * locate() falls back to searching the body. Returns { index: { [paragraphId]: number|null }, exact, moved, missing }.
 */
export function alignParagraphs(serverParagraphs, wordTexts) {
  const texts = wordTexts.map(norm); const index = {}; let exact = 0, moved = 0, missing = 0;
  serverParagraphs.forEach((p, i) => {
    const t = norm(p.text);
    if (texts[i] === t) { index[p.id] = i; exact++; return; }
    const hits = []; for (let j = 0; j < texts.length; j++) if (texts[j] === t) hits.push(j);
    if (t && hits.length === 1) { index[p.id] = hits[0]; moved++; } else { index[p.id] = null; missing++; }
  });
  return { index, exact, moved, missing };
}

let lastFile = null;
/** The bytes of the document as last read for a review (so the pane can find or add the same file in the store). */
export function lastWordFile() { return lastFile; }
/** The document as it is now, as an upload (used when the version sent back is saved to the store as our reply). */
export async function currentWordFile(name) { const bytes = await readWordFileBytes(); return new File([bytes], name || lastFile?.name || 'Current Word document.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }); }
/** The file last read from Word, as an upload, or null when Word did not hand it over. */
export function wordFile() { return lastFile ? new File([lastFile.bytes], lastFile.name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) : null; }
/** A plain .docx file name for the open document: the last part of Word's path or URL for it, else the title. */
export function wordFileName(url, title) {
  let name = ''; try { name = decodeURIComponent(String(url || '').split(/[?#]/)[0].split(/[\\/]/).pop() || ''); } catch { name = ''; }
  name = name.replace(/[\\/]/g, '').trim() || String(title || '').replace(/[\\/]/g, ' ').trim() || 'Current Word document';
  return (/\.docx$/i.test(name) ? name : `${name.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.docx`).slice(-255);
}

/**
 * Read the open document for a review (R5.1): the file itself goes through the server's importer, so the review sees the
 * counterparty's tracked changes exactly as the browser does. If Word cannot hand over the file, fall back to plain
 * paragraph text and say so; the review then has no "what they changed".
 * `deps` lets tests supply the file read, the importer and the cheap text read.
 */
export async function readWordDocument(deps = {}) {
  requireWord();
  const readFile = deps.readFile || readWordFileBytes; const readTexts = deps.readTexts || readWordTexts;
  const importFile = deps.importFile || (async bytes => { const form = new FormData(); form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'Current Word document.docx'); const r = await fetch('/api/documents/import', { method: 'POST', body: form }); const d = await r.json(); if (!r.ok) throw Error(d.error || 'The document could not be read.'); return d; });
  const title = await globalThis.Word.run(async context => { const props = context.document.properties; props.load('title'); await context.sync(); return props.title || ''; }).catch(() => '');
  const fileName = wordFileName(deps.url ?? globalThis.Office?.context?.document?.url, title);
  const started = Date.now(); let wordTexts = [];
  try {
    const bytes = await readFile(); const msFile = Date.now() - started;
    const imported = await importFile(bytes); wordTexts = await readTexts();
    const aligned = alignParagraphs(imported.paragraphs, wordTexts);
    lastFile = { bytes, at: Date.now(), name: fileName };
    const timing = { msFile, msTotal: Date.now() - started, fileBytes: bytes.length, paragraphs: imported.paragraphs.length, wordParagraphs: wordTexts.length, exact: aligned.exact, moved: aligned.moved, missing: aligned.missing };
    report({ kind: 'word-read', ...timing });
    const warnings = [...(imported.warnings || []), ...(aligned.missing ? [`${aligned.missing} paragraph(s) could not be matched to Word's own; wording there is located by search.`] : [])];
    return { ...imported, title: title || fileName.replace(/\.docx$/i, ''), fileName, source: 'word', imported: true, revision: 0, warnings, wordIndex: aligned.index, wordTexts, tracked: true, timing };
  } catch (e) {
    if (!wordTexts.length) wordTexts = await readTexts();
    lastFile = null;
    report({ kind: 'word-read-fallback', error: e.message });
    return { id: `word-${Date.now()}`, title: title || 'Current Word document', revision: 0, source: 'word', imported: true, tracked: false, paragraphs: wordTexts.map((text, i) => ({ id: `p${i + 1}`, text })), wordIndex: Object.fromEntries(wordTexts.map((_, i) => [`p${i + 1}`, i])), wordTexts,
      warnings: [`Word did not hand over the file (${e.message}), so tracked changes were not read; this review covers the current text only.`] };
  }
}
/**
 * The selection in Word (17 Oct 2026): its text and Word's indexes of its paragraphs (matched against the body's
 * paragraph texts). `{ text: '' }` for an empty selection.
 */
export async function readWordSelection() {
  requireWord();
  return globalThis.Word.run(async context => {
    const sel = context.document.getSelection(); sel.load('text');
    const selParas = sel.paragraphs; selParas.load('items/text');
    const body = context.document.body.paragraphs; body.load('items/text');
    await context.sync();
    const text = String(sel.text || '');
    if (!text.trim()) return { text: '' };
    return { text, wordIndexes: selectionIndexes(body.items.map(p => p.text), selParas.items.map(p => p.text)) };
  });
}
/**
 * Calls `onChange(selection)` after Word's selection changes (debounced by `waitMs`); returns a function that stops.
 * Without Word's selection event (an older host) it does nothing.
 */
export function watchWordSelection(onChange, { waitMs = 250 } = {}) {
  const doc = globalThis.Office?.context?.document; const type = globalThis.Office?.EventType?.DocumentSelectionChanged;
  if (!doc?.addHandlerAsync || !type) return () => {};
  let timer = null, seq = 0, stopped = false;
  const handler = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      try { const s = await readWordSelection(); if (!stopped && mine === seq) onChange(s); } catch { /* the chip is optional */ }
    }, waitMs);
  };
  doc.addHandlerAsync(type, handler, () => {});
  return () => { stopped = true; clearTimeout(timer); try { doc.removeHandlerAsync?.(type, { handler }, () => {}); } catch { /* gone */ } };
}
/** Word's index for one of the review's paragraphs, or null when it could not be matched. */
export function wordIndexOf(doc, paragraphId) { const i = doc?.wordIndex?.[paragraphId]; return Number.isInteger(i) ? i : null; }
// Diagnostics (timings, failed marks) go to the server's log only when it runs with PANE_DIAGNOSTICS=1 (audit item 5).
let diagnostics = false;
export function setDiagnostics(on) { diagnostics = Boolean(on); }
function report(body) { if (!diagnostics) return; try { fetch('/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch { /* best effort */ } }

/**
 * Locate the target: within the paragraph at `paragraphIndex` when given, otherwise in the body. Returns
 * { range, paragraph } or throws a warning-grade error. `api` is { context, body } for testability.
 */
export async function locate(api, { quote, paragraphIndex = null }) {
  const { context, body } = api; const needle = searchNeedle(quote);
  const scopes = [];
  if (Number.isInteger(paragraphIndex) && paragraphIndex >= 0) { const paragraphs = body.paragraphs; paragraphs.load('items'); await context.sync(); if (paragraphs.items[paragraphIndex]) scopes.push({ scope: paragraphs.items[paragraphIndex], where: 'paragraph' }); }
  scopes.push({ scope: body, where: 'document' });
  for (const { scope, where } of scopes) {
    const results = scope.search(needle, { matchCase: true, matchWholeWord: false, matchWildcards: false }); results.load('items'); await context.sync();
    if (results.items.length === 1) { const range = results.items[0]; const paragraph = range.paragraphs.getFirst(); paragraph.load('text'); await context.sync(); if (!norm(paragraph.text).includes(norm(quote))) throw Error('The passage was found but its wording has changed since the review. Rerun before applying.'); return { range, paragraph, where }; }
    if (results.items.length > 1 && where === 'paragraph') throw Error('That wording appears more than once in the paragraph; apply it in Word by hand.');
  }
  throw Error('That passage could not be located in the document; it may have been edited. Rerun the review.');
}

/** `_m_<time><random>`: the underscore makes Word hide it; the name says nothing about the review (W7). */
export function bookmarkName() { return `${BOOKMARK_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

/**
 * Apply one replacement as a tracked change. `api` provides { context, document, body, settings }.
 * Returns { applied, bookmark, verified, warning }.
 */
export async function applyTracked(api, { findingId, quote, replacement, paragraphIndex = null, inner = null, innerReplacement = null, insertAfter = null }) {
  if (typeof replacement !== 'string' || !replacement.trim()) throw Error('Nothing to apply.');
  if (/[\r\n]/.test(replacement)) throw Error('Only a replacement within one paragraph is supported here; multi-paragraph insertions are prepared as text for Word.');
  const { context, document } = api;
  const found = await locate(api, { quote, paragraphIndex }); const { paragraph } = found;
  let range = await wholeQuote({ context }, found, quote, true); let wording = replacement; let struck = quote;
  // `quote` is a run of words found exactly once. When the caller also names the changed words inside it and they too
  // are found exactly once there, only those are struck and replaced, so the redline shows the change and nothing else.
  // Word cannot search for more than 255 characters; a longer inner change is applied as the whole quoted passage.
  if (!insertAfter && inner && innerReplacement && range.search && norm(inner).length <= SEARCH_LIMIT) {
    try { const hits = range.search(inner, { matchCase: true, matchWholeWord: false, matchWildcards: false }); hits.load('items'); await context.sync(); if (hits.items.length === 1) { range = hits.items[0]; wording = innerReplacement; struck = inner; } } catch { /* fall back to the whole passage */ }
  }
  // A returned markup is full of the other side's revisions; our counter-edit must land on top of them as a further
  // tracked change. We note it and proceed; Word records a deletion of their insertion and our insertion beside it.
  let overRevisions = false; const existing = range.getTrackedChanges?.(); if (existing) { existing.load('items'); await context.sync(); overRevisions = existing.items.length > 0; }
  // 2. track in its own sync, insert after the located range, then delete it
  document.load('changeTrackingMode'); await context.sync(); const previous = document.changeTrackingMode;
  document.changeTrackingMode = globalThis.Word?.ChangeTrackingMode?.trackAll || 'TrackAll'; await context.sync();
  let inserted;
  try {
    // An addition with nothing struck: insert after the anchor words and delete nothing, so the redline is the addition alone.
    inserted = range.insertText(insertAfter || wording, globalThis.Word?.InsertLocation?.after || 'After'); await context.sync();
    if (!insertAfter) { range.delete(); await context.sync(); }
  } finally { document.changeTrackingMode = previous; await context.sync(); }
  // 3. anchor the new wording (not the deleted run): hidden bookmark (leading underscore) within Word's 40-character limit
  const bookmark = bookmarkName();
  (inserted || range).insertBookmark?.(bookmark); await context.sync();
  // 4. verify
  paragraph.load('text'); await context.sync();
  const verified = norm(paragraph.text).includes(norm(replacement));
  const warning = !verified ? 'The change was applied but could not be verified by re-reading the paragraph; check it in Word.' : overRevisions ? 'Applied on top of existing tracked changes in this passage; check how Word shows the layered revisions.' : null;
  // What Undo needs to find exactly this change again (undoTracked): the wording inserted and the wording struck.
  return { applied: true, tracked: true, bookmark, verified, overRevisions, warning, inserted: insertAfter || wording, deleted: insertAfter ? '' : struck };
}

/** Host entry used by the pane: applies one finding's wording with tracking on. */
export async function applyWordReplacement({ findingId, quote, replacement, paragraphIndex = null, inner = null, innerReplacement = null, insertAfter = null }) {
  requireWord();
  return queued(() => globalThis.Word.run(async context => applyTracked({ context, document: context.document, body: context.document.body }, { findingId, quote, replacement, paragraphIndex, inner, innerReplacement, insertAfter })));
}

/**
 * Delete a whole clause as a tracked change (audit item 8, 9 Oct 2026). The model proposes deleting a paragraph, typically
 * one the counterparty added, by returning empty wording for it. The clause's text is located as for an edit, struck
 * with tracking on, and the paragraph re-read to confirm the text is gone. No bookmark: nothing was inserted to anchor.
 */
export async function deleteTracked(api, { quote, paragraphIndex = null }) {
  const { context, document } = api;
  const found = await locate(api, { quote, paragraphIndex }); const range = await wholeQuote({ context }, found, quote, true);
  document.load('changeTrackingMode'); await context.sync(); const previous = document.changeTrackingMode;
  document.changeTrackingMode = globalThis.Word?.ChangeTrackingMode?.trackAll || 'TrackAll'; await context.sync();
  try { range.delete(); await context.sync(); } finally { document.changeTrackingMode = previous; await context.sync(); }
  found.paragraph.load('text'); await context.sync();
  const verified = !norm(found.paragraph.text).includes(norm(quote));
  return { applied: true, tracked: true, bookmark: null, verified, warning: verified ? null : 'The clause was struck but its wording can still be read in the paragraph; check it in Word.' };
}
export async function applyWordDeletion({ quote, paragraphIndex = null }) {
  requireWord();
  return queued(() => globalThis.Word.run(async context => deleteTracked({ context, document: context.document, body: context.document.body }, { quote, paragraphIndex })));
}

/**
 * Insert one new paragraph after an anchor paragraph as a tracked change (bulk application, product v2 spec 7.8: a
 * point whose reply adds a paragraph). The anchor is found at `paragraphIndex` when its text agrees, otherwise as the
 * one paragraph with that text; anything else is refused. The new paragraph takes the anchor's style (Word's own
 * insertParagraph), is anchored with a hidden bookmark like any applied change, and is re-read to confirm it.
 * `api` is { context, document, body } for testability.
 */
export async function insertParagraphTracked(api, { anchorText, paragraphIndex = null, text }) {
  if (typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text)) throw Error('Only one new paragraph of text can be inserted here.');
  const { context, document, body } = api;
  const paragraphs = body.paragraphs; paragraphs.load('items/text'); await context.sync();
  const items = paragraphs.items; const want = norm(anchorText);
  let at = Number.isInteger(paragraphIndex) && items[paragraphIndex] && norm(items[paragraphIndex].text) === want ? paragraphIndex : null;
  if (at === null) { const hits = items.map((p, i) => [norm(p.text), i]).filter(([t]) => t === want); if (hits.length === 1) at = hits[0][1]; }
  if (at === null) throw Error('The paragraph the new one follows could not be located; it may have been edited.');
  document.load('changeTrackingMode'); await context.sync(); const previous = document.changeTrackingMode;
  document.changeTrackingMode = globalThis.Word?.ChangeTrackingMode?.trackAll || 'TrackAll'; await context.sync();
  let inserted;
  try { inserted = items[at].insertParagraph(text, globalThis.Word?.InsertLocation?.after || 'After'); await context.sync(); }
  finally { document.changeTrackingMode = previous; await context.sync(); }
  const bookmark = bookmarkName();
  inserted.getRange?.('Whole')?.insertBookmark?.(bookmark); await context.sync();
  inserted.load('text'); await context.sync();
  const verified = norm(inserted.text) === norm(text);
  return { applied: true, tracked: true, bookmark, verified, paragraphIndex: at + 1, inserted: text, deleted: '', warning: verified ? null : 'The new paragraph was inserted but could not be verified by re-reading it; check it in Word.' };
}
export async function applyWordInsertion({ anchorText, paragraphIndex = null, text }) {
  requireWord();
  return queued(() => globalThis.Word.run(async context => insertParagraphTracked({ context, document: context.document, body: context.document.body }, { anchorText, paragraphIndex, text })));
}

// ---- Comment threads (product v2 spec 6.2.3, 7.7; WordApi 1.4) ----
// The pane reads the document's comments when a review starts, matches each thread to a finding by paragraph, and,
// after an applied change is verified, replies in that thread saying what changed. The reply is posted by Word under
// the lawyer's name, as the tracked change is. Reads are not queued; the reply changes the document and is.
export const commentsSupported = () => supports('WordApi', '1.4');

/** Which of Word's paragraphs `p` is: by uniqueLocalId (WordApi 1.6) when loaded, else the one paragraph with its text. */
function paragraphIndexOf(items, p, uniqueIds) {
  if (uniqueIds && p.uniqueLocalId) { const i = items.findIndex(x => x.uniqueLocalId === p.uniqueLocalId); if (i >= 0) return i; }
  const t = norm(p.text); const hits = []; items.forEach((x, i) => { if (norm(x.text) === t) hits.push(i); });
  return hits.length === 1 ? hits[0] : null;
}
/** The document's comments: [{ id, author, text, resolved, paragraphIndex }]. `api` is { context, body } for tests. */
export async function readCommentsWith(api, { uniqueIds = false } = {}) {
  const { context, body } = api;
  const comments = body.getComments(); comments.load('items/id,items/authorName,items/content,items/resolved');
  const paragraphs = body.paragraphs; paragraphs.load(uniqueIds ? 'items/text,items/uniqueLocalId' : 'items/text');
  await context.sync();
  const firsts = comments.items.map(c => { const p = c.getRange().paragraphs.getFirst(); p.load(uniqueIds ? 'text,uniqueLocalId' : 'text'); return p; });
  await context.sync();
  return comments.items.map((c, i) => ({ id: c.id, author: c.authorName || null, text: c.content || '', resolved: c.resolved === true, paragraphIndex: paragraphIndexOf(paragraphs.items, firsts[i], uniqueIds) }));
}
/** The open document's comments, or null when this Word has no comment API (below WordApi 1.4). */
export async function readComments() {
  requireWord();
  if (!commentsSupported()) return null;
  return globalThis.Word.run(async context => readCommentsWith({ context, body: context.document.body }, { uniqueIds: supports('WordApi', '1.6') }));
}
/** Reply in one thread. `api` is { context, body } for tests. */
export async function replyWith(api, { commentId, text }) {
  const comments = api.body.getComments(); comments.load('items/id'); await api.context.sync();
  const comment = comments.items.find(c => c.id === commentId);
  if (!comment) throw Error('That comment is no longer in the document.');
  comment.reply(text); await api.context.sync();
  return { replied: true };
}
export async function replyToComment(commentId, text) {
  requireWord();
  return queued(() => globalThis.Word.run(async context => replyWith({ context, body: context.document.body }, { commentId, text })));
}

/** The open document's address as Word reports it: the key the pane's saved review is kept under. Null when unsaved. */
export function wordDocumentKey() { try { return String(globalThis.Office?.context?.document?.url || '').trim() || null; } catch { return null; } }

/**
 * After a reload, is a change the pane applied still in the document? Its hidden bookmark holds the inserted wording:
 * 'present' when the bookmark is there and still holds text, 'gone' when it is missing or empty (the change was
 * rejected or deleted in Word). A read: it selects nothing and is not queued. `api` is { context, document } for tests.
 */
export async function appliedState(api, bookmark) {
  if (!bookmark) return 'unknown';
  const range = api.document.getBookmarkRangeOrNullObject(bookmark); range.load('isNullObject,text'); await api.context.sync();
  return range.isNullObject || !norm(range.text) ? 'gone' : 'present';
}
export async function appliedChangeState(bookmark) {
  requireWord();
  return globalThis.Word.run(async context => appliedState({ context, document: context.document }, bookmark));
}

// ---- Undo from the pane (17 Oct 2026; TrackedChange.reject and Range.getTrackedChanges are WordApi 1.6) ----
export const UNDO_EDITED = 'This change was edited in Word. Undo it there.';
export const UNDO_IN_WORD = 'Undo this change in Word.';
export const undoSupported = () => supports('WordApi', '1.6');
const refuse = message => Object.assign(Error(message), { refused: true });
const isAdded = c => /add|insert/i.test(String(c.type)), isDeleted = c => /delet/i.test(String(c.type));

/**
 * Reject exactly the tracked changes the pane made for one point, then remove their hidden bookmarks. `changes` is
 * [{ bookmark, inserted, deleted }], one per tracked insert (and delete) applyTracked or insertParagraphTracked made.
 * Each insertion is the one tracked insertion inside its bookmark, whose text is still the wording inserted; each
 * deletion is a deletion in that paragraph by the same author with the struck wording. Word for Mac reports a
 * deletion's text as empty (measured 5 Oct 2026, docs/WORD.md): then the author's empty-text deletions in the paragraph
 * must be exactly as many as ours. Anything else (bookmark gone, wording edited, several candidates, a change accepted)
 * refuses before anything is rejected: all of a point's changes are rejected together, or none. The counterparty's
 * revisions are never candidates (another author). `api` is { context, document } for tests. Returns { undone, rejected }.
 */
export async function undoTracked(api, { changes = null, bookmark = null, inserted = null, deleted = '' } = {}) {
  const { context, document } = api;
  const list = (changes || (bookmark ? [{ bookmark, inserted, deleted }] : [])).filter(Boolean);
  if (!list.length || list.some(c => !c.bookmark || typeof c.inserted !== 'string' || !c.inserted.trim())) throw refuse(UNDO_IN_WORD);
  const ranges = list.map(c => { const r = document.getBookmarkRangeOrNullObject(c.bookmark); r.load('isNullObject,text'); return r; });
  await context.sync();
  if (ranges.some((r, i) => r.isNullObject || norm(r.text) !== norm(list[i].inserted))) throw refuse(UNDO_EDITED);
  const looked = ranges.map(r => {
    const inside = r.getTrackedChanges(); inside.load('items/type,items/text,items/author');
    const paragraph = r.paragraphs.getFirst(); paragraph.load('text');
    const around = paragraph.getTrackedChanges(); around.load('items/type,items/text,items/author');
    return { inside, paragraph, around };
  });
  await context.sync();
  // Our insertions: the one tracked insertion inside each bookmark (empty text only where Word reports none).
  const ours = looked.map(({ inside }, i) => {
    const added = inside.items.filter(isAdded);
    return added.length === 1 && (!norm(added[0].text) || norm(added[0].text) === norm(list[i].inserted)) ? added[0] : null;
  });
  if (ours.some(c => !c) || new Set(ours.map(c => c.author || '')).size !== 1) throw refuse(UNDO_EDITED);
  const author = ours[0].author || '';
  // Our deletions, paragraph by paragraph: by text when Word reports it, else by count.
  const reject = [...ours]; const groups = new Map();
  list.forEach((c, i) => { if (!norm(c.deleted || '')) return; const key = norm(looked[i].paragraph.text); if (!groups.has(key)) groups.set(key, { around: looked[i].around, texts: [] }); groups.get(key).texts.push(norm(c.deleted)); });
  for (const { around, texts } of groups.values()) {
    const pool = around.items.filter(c => isDeleted(c) && (c.author || '') === author);
    const empties = pool.filter(c => !norm(c.text));
    const counts = texts.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
    const byText = [...counts].map(([t, n]) => { const hits = pool.filter(c => norm(c.text) === t); return hits.length === n ? hits : null; });
    if (byText.every(Boolean)) reject.push(...byText.flat());
    else if (pool.every(c => !norm(c.text)) && empties.length === texts.length) reject.push(...empties);
    else throw refuse(UNDO_EDITED);
  }
  // The last change first: a rejected new paragraph leaves the earlier ones where they were.
  for (const c of reject.reverse()) c.reject();
  await context.sync();
  for (const c of list) document.deleteBookmark(c.bookmark);
  try { await context.sync(); } catch { /* a bookmark that went with its wording is already gone */ }
  return { undone: true, rejected: reject.length };
}
/** Host entry used by the pane: Undo on an applied point (queued like every change to the document). */
export async function undoWordChange({ changes }) {
  requireWord();
  if (!undoSupported()) throw refuse(UNDO_IN_WORD);
  return queued(() => globalThis.Word.run(async context => undoTracked({ context, document: context.document }, { changes })));
}

/**
 * Before a version is saved for sending (decision 99): remove every hidden bookmark this add-in placed and any registry
 * an older build left in the document's add-in settings. Tracked changes, comments and the other side's bookmarks are
 * not touched. `api` is { context, body, document, settings } for testability. Returns { bookmarks, registry }.
 */
export async function removeOurTraces(api) {
  const { context, body, document, settings } = api;
  const listed = body.getRange('Whole').getBookmarks(true, true); await context.sync();
  const ours = (listed.value || []).filter(name => name.startsWith(BOOKMARK_PREFIX));
  for (const name of ours) document.deleteBookmark(name);
  if (ours.length) await context.sync();
  let registry = false;
  if (settings?.get?.(LEGACY_REGISTRY_KEY) != null) { settings.remove(LEGACY_REGISTRY_KEY); await new Promise(resolve => settings.saveAsync(() => resolve())); registry = true; }
  return { bookmarks: ours.length, registry };
}
export async function cleanOutgoing() {
  requireWord(); ++markSeq;
  return queued(async () => { await clearNow(); return globalThis.Word.run(async context => removeOurTraces({ context, body: context.document.body, document: context.document, settings: globalThis.Office.context.document.settings })); });
}

// ---- Marking the passage on screen (docs/DESIGN-SYSTEM.md, "Marking the document"; ../word-highlighting-research.md) ----
// Only mechanisms that leave the counterparty's file untouched: Range.highlight() (WordApi 1.8, one pale colour Word
// chooses, "without changing document content") plus select(Start), which scrolls without selecting the text; below 1.8,
// select() alone. The previous highlight is removed through a tracked range. Nothing here writes to the document.
let markedRange = null;
const supports = (set, v) => { try { return Boolean(globalThis.Office?.context?.requirements?.isSetSupported?.(set, v)); } catch { return false; } };

/** The end of a quote too long for one search (Word's limit is 255 characters): its last ≤255 characters, cut at a word. */
export function searchTail(quote) {
  const q = norm(quote); if (q.length <= SEARCH_LIMIT) return null;
  const cut = q.indexOf(' ', q.length - SEARCH_LIMIT); return q.slice(cut > 0 ? cut + 1 : q.length - SEARCH_LIMIT).trim();
}
/**
 * locate() finds the first 255 characters of a long quote; extend that to the quote's end. Marking falls back to the
 * first part; an edit must not (`strict`): replacing only the start of a long passage would leave its end duplicated.
 */
async function wholeQuote({ context }, { range, paragraph }, quote, strict = false) {
  const tail = searchTail(quote); if (!tail) return range;
  let whole = null;
  if (paragraph?.search && range.expandTo) { try { const ends = paragraph.search(tail, { matchCase: true, matchWholeWord: false, matchWildcards: false }); ends.load('items'); await context.sync(); if (ends.items.length === 1) whole = range.expandTo(ends.items[0]); } catch { whole = null; } }
  if (!whole && strict) throw Error('That passage is too long to place exactly; apply the wording in Word by hand.');
  return whole || range;
}

/** Mark one passage. `api` is { context, body, Word, highlight } for testability; returns { how } ('highlight' | 'select'). */
export async function markRange(api, { quote, paragraphIndex = null }) {
  const { context, body } = api; const W = api.Word || globalThis.Word;
  const found = await locate({ context, body }, { quote, paragraphIndex });
  const range = await wholeQuote({ context }, found, quote);
  if (api.highlight) {
    range.highlight();
    range.select(W?.SelectionMode?.start || 'Start');
    await context.sync();
    return { how: 'highlight', range };
  }
  range.select(W?.SelectionMode?.select || 'Select'); await context.sync();
  return { how: 'select', range };
}

/**
 * Remove the previous highlight, then mark this passage. Errors are returned, not thrown: marking is a convenience.
 * Calls run one at a time and only the latest request is carried out: stepping quickly through points in real Word
 * (5 Oct 2026) otherwise left several passages highlighted, because each call cleared a mark the one before had not yet placed.
 */
let markSeq = 0;
export function markPassage(quote, paragraphIndex = null) {
  requireWord();
  const mine = ++markSeq;
  return queued(() => mine === markSeq ? markNow(quote, paragraphIndex) : { marked: false, superseded: true });
}
async function markNow(quote, paragraphIndex) {
  const highlight = supports('WordApi', '1.8');
  await clearNow();
  try {
    return await globalThis.Word.run(async context => {
      const result = await markRange({ context, body: context.document.body, highlight }, { quote, paragraphIndex });
      if (result.how === 'highlight') { context.trackedObjects.add(result.range); await context.sync(); markedRange = result.range; }
      return { marked: true, how: result.how };
    });
  } catch (e) { report({ kind: 'mark-failed', error: e.message, paragraphIndex, needle: searchNeedle(quote).slice(0, 200) }); return { marked: false, error: e.message }; }
}

/** Remove the highlight placed by markPassage, if any. Queued behind any marking still in flight. */
export function clearMark() { ++markSeq; return queued(clearNow); }
async function clearNow() {
  const range = markedRange; markedRange = null;
  if (!range || !globalThis.Word) return;
  try { await globalThis.Word.run(range, async context => { range.removeHighlight(); range.untrack(); await context.sync(); }); } catch { /* the range may have been edited away; nothing to clear */ }
}
