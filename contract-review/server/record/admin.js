// SPDX-License-Identifier: GPL-3.0-or-later
// Admin operations behind `gcl` (product v2 spec sections 9.3 and 9.5): check, backup, restore. Rebuilding projections
// and collecting unreferenced blobs went with matters (decision 190): the record no longer holds documents. The document
// store is backed up with its own data folder (docs/FOR-IT.md, "Backups").
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TABLES, SCHEMA_VERSION, currentVersion } from './schema.js';

/** PR-REC-01, PR-REC-08: tables at the expected schema, clause-type mappings valid, unmapped rules warned. */
export async function check(record) {
  const { db, clauseTypes } = record.internal;
  const errors = [], warnings = [], ok = [];
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all().map(r => r.name));
  for (const t of TABLES) (present.has(t) ? ok : errors).push(`table ${t}${present.has(t) ? '' : ' missing'}`);
  const v = currentVersion(db);
  (v === SCHEMA_VERSION ? ok : errors).push(`schema version ${v} (code expects ${SCHEMA_VERSION})`);
  ok.push(`clause types: ${clauseTypes.file.types.length} types, mappings for ${Object.keys(clauseTypes.file.mappings).length} playbooks`);
  const playbooks = db.prepare('SELECT id, rules FROM playbooks ORDER BY id').all().map(p => ({ id: p.id, rules: JSON.parse(p.rules) }));
  for (const u of clauseTypes.unmapped(playbooks)) warnings.push(`rule ${u.ruleId} of playbook ${u.playbookId} has no clause type`);
  const counts = { playbooks: playbooks.length, users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n, events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n };
  return { ok: !errors.length, errors, warnings, passed: ok, counts };
}

/** Section 9.5: VACUUM INTO a timestamped copy (and copy an old record's files folder, if any, when `dir` is given); write the marker. */
export function backup(record, dir) {
  const { db, dataDir } = record.internal;
  const target = path.resolve(dir || path.join(dataDir, 'backups'));
  mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(target, `record-${stamp}.sqlite`);
  db.prepare('VACUUM INTO ?').run(file);
  let copied = 0;
  // The blobs are immutable, so an incremental copy is safe at any time; the default folder sits beside them and needs none.
  if (dir) copied = copyTree(path.join(dataDir, 'files'), path.join(target, 'files'));
  const marker = { at: new Date().toISOString(), file, filesCopied: copied };
  writeFileSync(path.join(dataDir, 'last-backup.json'), JSON.stringify(marker, null, 2));
  return marker;
}

function copyTree(from, to) {
  if (!existsSync(from)) return 0;
  let n = 0; mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'tmp') continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) n += copyTree(a, b);
    else if (!existsSync(b)) { copyFileSync(a, b); n++; }
  }
  return n;
}

/** The pid file the local app or server writes while it runs, so restore can refuse. */
export const pidFile = dataDir => path.join(dataDir, 'server.pid');
export function serverRunning(dataDir) {
  // Our own pid is not "the app": in a container the server and a later `gcl` run are both pid 1.
  try { const pid = Number(readFileSync(pidFile(dataDir), 'utf8')); if (!pid || pid === process.pid) return false; process.kill(pid, 0); return pid; } catch { return false; }
}

/** Section 9.5: replace record.sqlite with the newest backup in `dir` (or the named file) and add its files. */
export function restore(dataDir, from) {
  const running = serverRunning(dataDir);
  if (running) throw Object.assign(new Error(`The app is running (pid ${running}). Stop it before restoring.`), { code: 'server_running' });
  const src = path.resolve(from);
  const file = statSync(src).isDirectory() ? (() => { const all = readdirSync(src).filter(f => /^record-.*\.sqlite$/.test(f)).sort(); if (!all.length) throw new Error(`No record-*.sqlite backup in ${src}.`); return path.join(src, all[all.length - 1]); })() : src;
  const probe = new Database(file, { readonly: true }); const v = currentVersion(probe); probe.close();
  if (v > SCHEMA_VERSION) throw Object.assign(new Error(`The backup is at schema ${v}; this release knows schema ${SCHEMA_VERSION}.`), { code: 'schema_newer_than_code' });
  mkdirSync(dataDir, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) rmSync(path.join(dataDir, 'record.sqlite' + ext), { force: true });
  copyFileSync(file, path.join(dataDir, 'record.sqlite'));
  const filesDir = statSync(src).isDirectory() ? path.join(src, 'files') : path.join(path.dirname(src), 'files');
  const copied = copyTree(filesDir, path.join(dataDir, 'files'));
  return { restoredFrom: file, filesCopied: copied };
}
