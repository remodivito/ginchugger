// SPDX-License-Identifier: GPL-3.0-or-later
// The record's SQLite schema (product v2 spec section 5.1). Migrations are forward-only and applied in one transaction
// on open; a database newer than the code refuses to open (section 9.6).
export const SCHEMA_VERSION = 5;

const V1 = `
CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), key_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE setup_codes (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, for_name TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0,
  issued_by TEXT REFERENCES users(id), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  redeemed_at TEXT, redeemed_by TEXT REFERENCES users(id), revoked_at TEXT);

CREATE TABLE counterparties (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
  match_algorithm TEXT NOT NULL DEFAULT 'literal' CHECK (match_algorithm IN ('none','any','all','literal','regex','fuzzy')),
  match_pattern TEXT NOT NULL DEFAULT '', match_insensitive INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by TEXT);
CREATE UNIQUE INDEX counterparties_name ON counterparties(name COLLATE NOCASE);

CREATE TABLE matters (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, counterparty_id TEXT NOT NULL REFERENCES counterparties(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','signed','closed')),
  end_date TEXT, legacy_id TEXT UNIQUE, created_at TEXT NOT NULL, created_by TEXT, last_event_seq INTEGER);
CREATE INDEX matters_counterparty ON matters(counterparty_id);

CREATE TABLE files (
  sha256 TEXT PRIMARY KEY, content_key TEXT, bytes INTEGER NOT NULL, media_type TEXT NOT NULL, original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT, text_status TEXT NOT NULL
    CHECK (text_status IN ('extracted','not-extracted','failed')));
CREATE TABLE file_text (
  sha256 TEXT PRIMARY KEY REFERENCES files(sha256), paragraphs TEXT NOT NULL,
  text TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]');
CREATE VIRTUAL TABLE file_fts USING fts5(text, sha256 UNINDEXED, matter_id UNINDEXED, counterparty_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, matter_id TEXT,
  type TEXT NOT NULL, at TEXT NOT NULL, actor TEXT, payload TEXT NOT NULL);
CREATE INDEX events_matter ON events(matter_id, seq);
CREATE INDEX events_type ON events(type, seq);

CREATE TABLE rounds (
  matter_id TEXT NOT NULL REFERENCES matters(id), n INTEGER NOT NULL, side TEXT NOT NULL CHECK (side IN ('ours','theirs')),
  file_sha256 TEXT NOT NULL REFERENCES files(sha256), responds_to INTEGER, covering_sha256 TEXT,
  source TEXT NOT NULL CHECK (source IN ('pane','mail','folder','upload','migrated')), received_at TEXT NOT NULL,
  signed INTEGER NOT NULL DEFAULT 0, event_seq INTEGER NOT NULL, PRIMARY KEY (matter_id, n));
CREATE TABLE positions (
  id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, round_n INTEGER NOT NULL, counterparty_id TEXT NOT NULL,
  playbook_id TEXT NOT NULL, rule_id TEXT NOT NULL, clause_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('flagged','dismissed','applied','held','pushed-back','replied','rejected')),
  paragraph_id TEXT, quote TEXT, wording TEXT, note TEXT, title TEXT, actor TEXT, at TEXT NOT NULL, event_seq INTEGER NOT NULL);
CREATE INDEX positions_lookup ON positions(counterparty_id, clause_type, at);
CREATE INDEX positions_matter ON positions(matter_id, round_n);

CREATE TABLE playbooks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, applies_to TEXT, rules TEXT NOT NULL,
  provenance TEXT, change_count INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT,
  last_change_rule TEXT, last_change_kind TEXT);

CREATE TABLE inbox (
  id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('pane','mail','folder','upload')), received_at TEXT NOT NULL,
  file_sha256 TEXT NOT NULL REFERENCES files(sha256), covering_sha256 TEXT, mail_message_id TEXT,
  suggestions TEXT NOT NULL,
  duplicate_of TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','confirmed','discarded')),
  decided_by TEXT, decided_at TEXT, note TEXT);
CREATE TABLE processed_mail (
  folder TEXT NOT NULL, uidvalidity INTEGER NOT NULL, uid INTEGER NOT NULL, message_id TEXT, processed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('captured','no-attachment','skipped','failed')), detail TEXT,
  PRIMARY KEY (folder, uidvalidity, uid));
CREATE INDEX processed_mail_message ON processed_mail(message_id);
CREATE TABLE mail_status (id INTEGER PRIMARY KEY CHECK (id = 1), last_check_at TEXT, last_ok_at TEXT, last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, next_check_at TEXT);

CREATE TABLE tombstones (
  id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, matter_name TEXT NOT NULL, counterparty_name TEXT NOT NULL,
  deleted_by TEXT NOT NULL, deleted_at TEXT NOT NULL);
`;

// Version 2 (slice S3): our standard form per playbook kind, which the standard_form tool reads (product v2 spec 6.3.1).
// A state table like playbooks: the form itself is a stored file; the row names the current one for a kind.
const V2 = `
CREATE TABLE standard_forms (
  kind TEXT PRIMARY KEY, name TEXT NOT NULL, file_sha256 TEXT NOT NULL REFERENCES files(sha256),
  updated_at TEXT NOT NULL, updated_by TEXT);
`;

// Version 3 (slice S7): a setup code issued for a second device of an existing user names that user (6.2.1
// `POST /admin/setup-codes` with `userId`), so redeeming it adds a key to that user instead of creating one.
const V3 = `
ALTER TABLE setup_codes ADD COLUMN user_id TEXT REFERENCES users(id);
`;

// Version 4 (DMS batch 1): matter notes as a projection of the note events (ported from Paperless-ngx notes and
// OpenContracts Note/NoteRevision; server/record/notes.js), and tombstones that also name a round or a loose file
// purged from the trash (server/record/trash.js): `kind` is matter, round or file; `item` says which round or file.
const V4 = `
CREATE TABLE matter_notes (
  id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, author TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL,
  edited_at TEXT, edited_by TEXT, version INTEGER NOT NULL DEFAULT 1, event_seq INTEGER NOT NULL);
CREATE INDEX matter_notes_matter ON matter_notes(matter_id, created_at);
ALTER TABLE tombstones ADD COLUMN kind TEXT NOT NULL DEFAULT 'matter' CHECK (kind IN ('matter','round','file'));
ALTER TABLE tombstones ADD COLUMN item TEXT;
`;

// Version 5 (audit finding 5, 16 October 2026): a matter on hold (`matter_hold_set` events, set by an admin) cannot be moved
// to the trash, purged or deleted. The flag is a projection of those events.
const V5 = `
ALTER TABLE matters ADD COLUMN on_hold INTEGER NOT NULL DEFAULT 0;
`;

/** Forward-only migrations by target version. */
export const MIGRATIONS = { 1: V1, 2: V2, 3: V3, 4: V4, 5: V5 };

/** Every table section 5.1 names; `gcl check` reports each one. */
export const TABLES = ['schema_version', 'users', 'api_keys', 'setup_codes', 'counterparties', 'matters', 'files', 'file_text', 'file_fts', 'events', 'rounds', 'positions', 'playbooks', 'inbox', 'processed_mail', 'mail_status', 'tombstones', 'standard_forms', 'matter_notes'];


export function currentVersion(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!has) return 0;
  return db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
}

export function migrate(db, { now = () => new Date().toISOString() } = {}) {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) throw Object.assign(new Error(`The data folder is at schema ${from}; this release knows schema ${SCHEMA_VERSION}. Install the newer release or restore a backup.`), { code: 'schema_newer_than_code', status: 500 });
  if (from === SCHEMA_VERSION) return { from, to: from };
  db.transaction(() => {
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      db.exec(MIGRATIONS[v]);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, now());
    }
  })();
  return { from, to: SCHEMA_VERSION };
}
