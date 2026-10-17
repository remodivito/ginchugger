// SPDX-License-Identifier: GPL-3.0-or-later
// One-off (16 Oct 2026, phase 3): writes tests/fixtures/old-record/, a record.sqlite and files folder made by the record
// layer before decision 190 removed it, so the migration script's test keeps an old record to read. Kept for the trail;
// it no longer runs (the record layer it used is gone).
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { freshRecord, docx } from './record/helpers.js';

const out = fileURLToPath(new URL('./old-record/', import.meta.url));
const eml = Buffer.from('From: legal@northgate.example\r\nTo: us@helix.example\r\nSubject: Our markup\r\n\r\nPlease see attached.\r\n');
const paragraphs = Buffer.from(JSON.stringify({ paragraphs: [{ id: 'p1', text: 'Order Form' }, { id: 'p2', originalText: 'Pay within 30 days.', text: 'Pay within 60 days.' }] }));
const { record, dataDir } = await freshRecord();
const cp = await record.counterparties.create({ name: 'Northgate Biosciences Ltd' }, 'jane');
const m = await record.matters.create({ name: 'Northgate order form', counterpartyId: cp.id, kind: 'order-form' }, 'jane');
const v1 = await record.files.store(await docx(['Order Form', 'Pay within 30 days.']), 'order-form-v1.docx', 'upload', 'jane');
const v2 = await record.files.store(await docx([{ was: 'Pay within 30 days.', text: 'Pay within 60 days.' }]), 'order-form-v2-markup.docx', 'upload', 'jane');
const cover = await record.files.store(eml, 'northgate-returns.eml', 'upload', 'jane');
const para = await record.files.store(paragraphs, 'pilot-round-1.json', 'upload', 'jane');
await record.rounds.record(m.id, { round: 1, side: 'ours', fileSha256: v1.sha256, source: 'upload', receivedAt: '2026-06-01T09:00:00.000Z' }, 'jane');
await record.rounds.record(m.id, { round: 2, side: 'theirs', fileSha256: v2.sha256, coveringSha256: cover.sha256, respondsTo: 1, source: 'upload', receivedAt: '2026-06-04T10:00:00.000Z' }, 'jane');
await record.rounds.markSigned(m.id, 2, 'jane');
await record.notes.add(m.id, 'Kept the 60-day term.', 'jane');
const nda = await record.matters.create({ name: 'Lantern NDA', counterpartyId: (await record.counterparties.create({ name: 'Lantern Ltd' }, 'jane')).id, kind: 'nda' }, 'jane');
await record.rounds.record(nda.id, { round: 1, side: 'theirs', fileSha256: para.sha256, source: 'upload', receivedAt: '2025-03-10T10:15:00Z' }, 'jane');
const loose = await record.inbox.captureFromUpload(await docx(['Something new from Northgate']), 'new-from-northgate.docx', 'jane');
const kept = await record.files.store(await docx(['Lantern NDA, our draft']), 'lantern-draft.docx', 'upload', 'jane');
record.close?.();
const db = new Database(path.join(dataDir, 'record.sqlite'));
db.prepare('UPDATE matters SET on_hold = 1 WHERE id = ?').run(nda.id);
db.prepare("INSERT INTO events (id, matter_id, type, at, actor, payload) VALUES ('ev-kept', ?, 'file_stored', '2026-01-02T00:00:00Z', 'migrated', ?)").run(nda.id, JSON.stringify({ sha256: kept.sha256, name: 'lantern-draft.docx' }));
db.pragma('wal_checkpoint(TRUNCATE)'); db.pragma('journal_mode = DELETE');
db.close();
rmSync(out, { recursive: true, force: true });
cpSync(path.join(dataDir, 'record.sqlite'), path.join(out, 'record.sqlite'));
cpSync(path.join(dataDir, 'files'), path.join(out, 'files'), { recursive: true, filter: s => !s.endsWith('/tmp') });
console.log(JSON.stringify({ shas: { v1: v1.sha256, v2: v2.sha256, cover: cover.sha256, para: para.sha256 }, inboxId: loose.id, matter: m.id, nda: nda.id }));
