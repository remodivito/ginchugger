// SPDX-License-Identifier: GPL-3.0-or-later
// The record after decision 190: schema (old tables kept, unused), the team's events, a second record in another folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openLocalRecord } from '../server/record/local.js';
import { TABLES, SCHEMA_VERSION, migrate } from '../server/record/schema.js';
import { validateEvent, EVENT_TYPES, derivedId } from '../server/record/events.js';
import { freshRecord, tempDir } from './fixtures/record/helpers.js';

test('schema: every table of section 5.1 exists at the expected version, WAL and foreign keys on; migrate is idempotent', async () => {
  const { record, dataDir } = await freshRecord();
  const db = record.internal.db;
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  for (const t of TABLES) assert.ok(names.has(t), t);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, SCHEMA_VERSION);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(migrate(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  assert.equal((await record.info()).schemaVersion, SCHEMA_VERSION);
  record.close();
  // Reopening runs no migration; a database from a newer release refuses to open with the section 9.6 message.
  const again = openLocalRecord({ dataDir }); again.close();
  const raw = new Database(path.join(dataDir, 'record.sqlite')); raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(SCHEMA_VERSION + 1, 'x'); raw.close();
  assert.throws(() => openLocalRecord({ dataDir }), e => e.code === 'schema_newer_than_code' && new RegExp(`this release knows schema ${SCHEMA_VERSION}`).test(e.message));
});

test('events: only the team\'s own events go in the record; review events belong to a document\'s review history; matter events are gone', () => {
  assert.throws(() => validateEvent({ type: 'made_up', payload: {} }), e => e.status === 400);
  for (const gone of ['matter_created', 'round_recorded', 'counterparty_created', 'capture_confirmed', 'note_added', 'matter_trashed', 'instruction_set']) assert.ok(!EVENT_TYPES.includes(gone), gone);
  assert.throws(() => validateEvent({ type: 'review_run', payload: { reviewId: 'r', playbookId: 'nda' } }), /review history/);
  assert.throws(() => validateEvent({ type: 'playbook_changed', matterId: 'm', payload: { playbookId: 'nda', changeNo: 2, kind: 'edited' } }), /names no matter/);
  assert.throws(() => validateEvent({ type: 'playbook_changed', payload: { playbookId: 'nda', changeNo: 2 } }), /needs "kind"/);
  assert.throws(() => validateEvent({ type: 'playbook_changed', payload: { playbookId: 'nda', changeNo: 2, kind: 'edited', colour: 'red' } }), /no field "colour"/);
  assert.throws(() => validateEvent({ type: 'playbook_change_declined', payload: { playbookId: 'nda', proposalId: 'p', note: 'x'.repeat(50_001) } }), e => e.status === 413);
  assert.equal(validateEvent({ type: 'code_revoked', payload: { codeId: 'c', a: undefined } }), '{"codeId":"c"}');
  assert.equal(derivedId('x'), derivedId('x')); assert.match(derivedId('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the record keeps no documents: no files folder is made, and the record has no matter, file or inbox methods', async () => {
  const { record, dataDir } = await freshRecord();
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(path.join(dataDir, 'files')), false);
  for (const gone of ['matters', 'rounds', 'files', 'inbox', 'trash', 'notes', 'counterparties', 'search', 'register', 'tools', 'standardForms', 'tombstones']) assert.equal(record[gone], undefined, gone);
  record.close();
});

test('a second record in another folder is independent', () => {
  const r = openLocalRecord({ dataDir: tempDir() });
  assert.equal(r.internal.db.prepare('SELECT COUNT(*) AS n FROM matters').get().n, 0);
  r.close();
});
