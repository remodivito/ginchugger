// SPDX-License-Identifier: GPL-3.0-or-later
// Review history on the store (tasks/paperless-store-plan.md, architecture decision 7, task 8): which points a review
// of a document raised and what the lawyer did with each (applied, dismissed and why, undone, rejected in Word, replied).
// None of this is a document, so it stays in our own SQLite, one small file in the app's data folder, keyed by the store
// document's id. The events are the record's review events (server/record/events.js EVENT_SHAPES, written by the pane
// through src/review/record-events.js), checked against the same shapes; only the matter is gone.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EVENT_SHAPES, REVIEW_EVENT_TYPES, DISMISS_REASONS, MAX_PAYLOAD_BYTES } from '../record/events.js';
import { storeError } from './index.js';

export const FILE = 'review-history.sqlite';
export const MAX_BATCH = 500;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, document_id INTEGER NOT NULL,
  type TEXT NOT NULL, at TEXT NOT NULL, actor TEXT, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS review_events_document ON review_events(document_id, seq);
CREATE TABLE IF NOT EXISTS concession_notes (
  document_id INTEGER NOT NULL, review_id TEXT NOT NULL, finding_id TEXT NOT NULL, note_id INTEGER NOT NULL,
  PRIMARY KEY (document_id, review_id, finding_id));
`;
/** How much of their wording a concession note quotes. */
export const CONCESSION_QUOTE_MAX = 300;
const ACCEPTED_DEFAULT = 'Accepted their wording';

/**
 * The store note an "Accept their wording" dismissal puts on the document (so the agent reads the concession on the next
 * review), in plain words: `Accepted their wording on <title>: "<their quote, trimmed>"`, then the lawyer's own reason,
 * if they wrote one (the dismissal's note when it is not the default). Null for any other dismissal.
 */
export function concessionNote(payload = {}) {
  if (payload.reason !== 'accepted') return null;
  const flat = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const title = flat(payload.title);
  let quote = flat(payload.quote);
  if (quote.length > CONCESSION_QUOTE_MAX) quote = `${quote.slice(0, CONCESSION_QUOTE_MAX - 1).replace(/\s+\S*$/, '')}…`;
  const reason = flat(payload.note);
  const head = `${ACCEPTED_DEFAULT}${title ? ` on ${title}` : ''}`;
  if (!reason || reason === ACCEPTED_DEFAULT) return quote ? `${head}: "${quote}"` : `${head}.`;
  return quote ? `${head}: "${quote}"${/[.!?…]$/.test(quote) ? '' : '.'} ${reason}` : `${head}. ${reason}`;
}

const bad = message => storeError(400, 'bad_request', message);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** One review event checked: its type is a review event, its payload has the shape's fields and no others. */
export function checkReviewEvent(e) {
  if (!isObj(e) || !REVIEW_EVENT_TYPES.includes(e.type)) throw bad(`A review event is one of ${REVIEW_EVENT_TYPES.join(', ')}.`);
  const shape = EVENT_SHAPES[e.type]; const p = e.payload;
  if (!isObj(p)) throw bad('An event payload is an object.');
  for (const k of shape.required) if (p[k] === undefined) throw bad(`A ${e.type} event needs "${k}".`);
  const known = new Set([...shape.required, ...(shape.optional || [])]);
  for (const k of Object.keys(p)) if (p[k] !== undefined && !known.has(k)) throw bad(`A ${e.type} event has no field "${k}".`);
  if (e.type === 'finding_dismissed' && (typeof p.note !== 'string' || !p.note.trim())) throw bad('A dismissal needs a note.');
  if (e.type === 'finding_dismissed' && p.reason !== undefined && !DISMISS_REASONS.includes(p.reason)) throw bad(`A dismissal's reason is one of ${DISMISS_REASONS.join(', ')}.`);
  const json = JSON.stringify(p);
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw storeError(413, 'too_large', 'Event too large.');
  return json;
}

/** The review history in `<dataDir>/review-history.sqlite` (":memory:" for tests). */
export function openReviewHistory({ dataDir = null, file = null, now = () => new Date().toISOString() } = {}) {
  const where = file || (dataDir ? path.join(dataDir, FILE) : ':memory:');
  if (where !== ':memory:') mkdirSync(path.dirname(where), { recursive: true });
  const db = new Database(where);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const docId = id => { const n = Number(id); if (!Number.isInteger(n) || n < 1) throw storeError(404, 'not_found', 'Document not found.'); return n; };
  const out = r => ({ seq: r.seq, id: r.id, documentId: r.document_id, type: r.type, at: r.at, actor: r.actor, payload: JSON.parse(r.payload) });
  return {
    /** Append a batch for one document, all or nothing. Returns the events as stored. */
    append(documentId, events, actor = null) {
      const id = docId(documentId);
      if (!Array.isArray(events) || !events.length) throw bad('Send the events as a list.');
      if (events.length > MAX_BATCH) throw bad(`At most ${MAX_BATCH} events at once.`);
      const rows = events.map(e => ({ type: e.type, payload: checkReviewEvent(e) }));
      const insert = db.prepare('INSERT INTO review_events (id, document_id, type, at, actor, payload) VALUES (?, ?, ?, ?, ?, ?)');
      const seqs = db.transaction(() => rows.map(r => insert.run(randomUUID(), id, r.type, now(), actor, r.payload).lastInsertRowid))();
      return seqs.map(seq => out(db.prepare('SELECT * FROM review_events WHERE seq = ?').get(seq)));
    },
    /** The point a review flagged on a document (its finding_flagged payload), or null. */
    flagged(documentId, reviewId, findingId) {
      const rows = db.prepare("SELECT payload FROM review_events WHERE document_id = ? AND type = 'finding_flagged' ORDER BY seq DESC").all(docId(documentId));
      for (const r of rows) { const p = JSON.parse(r.payload); if (p.reviewId === reviewId && p.findingId === findingId) return p; }
      return null;
    },
    /** The store note a concession put on the document, so undoing the dismissal can delete it. */
    setConcessionNote(documentId, reviewId, findingId, noteId) {
      db.prepare('INSERT OR REPLACE INTO concession_notes (document_id, review_id, finding_id, note_id) VALUES (?, ?, ?, ?)').run(docId(documentId), String(reviewId), String(findingId), noteId);
    },
    /** The concession note's id for a point (forgotten as it is returned), or null. */
    takeConcessionNote(documentId, reviewId, findingId) {
      const key = [docId(documentId), String(reviewId), String(findingId)];
      const row = db.prepare('SELECT note_id FROM concession_notes WHERE document_id = ? AND review_id = ? AND finding_id = ?').get(...key);
      if (row) db.prepare('DELETE FROM concession_notes WHERE document_id = ? AND review_id = ? AND finding_id = ?').run(...key);
      return row ? row.note_id : null;
    },
    /** A document's review events, oldest first. */
    list(documentId) { return db.prepare('SELECT * FROM review_events WHERE document_id = ? ORDER BY seq').all(docId(documentId)).map(out); },
    close() { db.close(); },
  };
}
