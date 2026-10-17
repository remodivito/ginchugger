// SPDX-License-Identifier: GPL-3.0-or-later
// LocalRecord (product v2 spec section 6.1, after decision 190): the team's own data over one SQLite file in the data
// folder: playbooks (with owners and proposals), members, keys and setup codes, the clause types, and the mail
// consumer's bookkeeping (processed_mail, mail_status). Documents live in the document store (server/store/), not here:
// matters, rounds, files, the inbox, the trash, notes, positions, the register and search went with decision 190, and
// their tables stay in old record.sqlite files untouched (nothing reads or writes them). Used in solo mode and inside
// the team server; every method returns a promise so RemoteRecord can share the interface.
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, statSync, statfsSync, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { canonical } from '../record.js';
import { migrate, SCHEMA_VERSION } from './schema.js';
import { validateEvent, newId } from './events.js';
import { loadClauseTypes, CLAUSE_TYPES_PATH } from './clause-types.js';
import { validatePlaybook, normalizeAppliesTo, importProsePlaybook } from '../playbook.js';
import { readSettings, readRawSetting, writeServerSetting } from '../settings.js';
import { makeTeam } from './team.js';
import { makePermissions, ruleChanges, applyRuleChanges } from './permissions.js';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const notFound = what => err(404, 'not_found', `${what} not found.`);
const json = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
// The OS user name; GCL_ACTOR overrides it (the portfolio screenshots use a fictional name).
export const soloActor = () => { if (process.env.GCL_ACTOR) return process.env.GCL_ACTOR; try { return userInfo().username || 'solo'; } catch { return 'solo'; } };

export function openLocalRecord({ dataDir, clauseTypesPath = CLAUSE_TYPES_PATH, now = () => new Date().toISOString(), mode = 'solo', settings = () => readSettings(dataDir) } = {}) {
  if (!dataDir) throw new Error('openLocalRecord needs a data folder.');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'record.sqlite'));
  try { // a refused open (a schema newer than the code) must not keep the file open: Windows could not move or delete it
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db, { now });
  } catch (e) { db.close(); throw e; }
  const clauseTypes = loadClauseTypes(clauseTypesPath);

  // ---- internals
  const insertEventStmt = db.prepare('INSERT INTO events (id, matter_id, type, at, actor, payload) VALUES (?, ?, ?, ?, ?, ?)');
  function insertEvent({ id = newId(), matterId = null, type, at = now(), actor = null, payload }) {
    const body = validateEvent({ type, matterId, payload });
    const { lastInsertRowid } = insertEventStmt.run(id, matterId, type, at, actor, body);
    return { seq: Number(lastInsertRowid), id, matterId, type, at, actor, payload: JSON.parse(body) };
  }
  const tx = fn => db.transaction(fn)();
  const playbookExists = id => !!db.prepare('SELECT 1 FROM playbooks WHERE id = ?').get(id);
  const team = makeTeam({ db, now, insertEvent, tx });
  const perms = makePermissions({ db, mode });

  /** The record's half of the status page (9.4); the server adds uptime, certificate and settings. */
  function adminStatus() {
    const size = f => { try { return statSync(f).size; } catch { return 0; } };
    const db0 = path.join(dataDir, 'record.sqlite');
    let freeBytes = null; try { const s = statfsSync(dataDir); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { /* not reported */ }
    const mail = db.prepare('SELECT * FROM mail_status WHERE id = 1').get() || {};
    const since = new Date(Date.parse(now()) - 86_400_000).toISOString();
    const processed = Object.fromEntries(['captured', 'no-attachment', 'skipped', 'failed'].map(o => [o, db.prepare('SELECT COUNT(*) AS n FROM processed_mail WHERE outcome = ? AND processed_at >= ?').get(o, since).n]));
    let lastBackupAt = null; try { const f = path.join(dataDir, 'last-backup.json'); if (existsSync(f)) lastBackupAt = JSON.parse(readFileSync(f, 'utf8')).at || null; } catch { /* no marker */ }
    return {
      mode, version: VERSION, schemaVersion: SCHEMA_VERSION, dataDir,
      database: { bytes: size(db0) + size(db0 + '-wal') }, disk: { freeBytes },
      mail: { lastCheckAt: mail.last_check_at || null, lastOkAt: mail.last_ok_at || null, lastError: mail.last_error || null, consecutiveFailures: mail.consecutive_failures || 0, nextCheckAt: mail.next_check_at || null, processed24h: processed },
      ...team.counts(), lastBackupAt, retentionAdoptedOn: readRawSetting(dataDir, 'retention.adoptedOn') ?? null,
    };
  }

  /** Write one applied playbook change: the row and its `playbook_changed` event, in one transaction. */
  function applyPlaybook(cur, clean, change, actor, credit = {}) {
    const next = cur.changeCount + 1; const at = now();
    tx(() => {
      db.prepare('UPDATE playbooks SET title = ?, applies_to = ?, rules = ?, provenance = ?, change_count = ?, updated_at = ?, updated_by = ?, last_change_rule = ?, last_change_kind = ? WHERE id = ?').run(clean.title || cur.title, clean.appliesTo ? canonical(clean.appliesTo) : null, canonical(clean.rules), clean.provenance ? canonical(clean.provenance) : null, next, at, actor, change.ruleId, change.kind, cur.id);
      insertEvent({ type: 'playbook_changed', at, actor, payload: { playbookId: cur.id, changeNo: next, ruleId: change.ruleId, kind: change.kind, ...credit } });
    });
    return record.playbooks.get(cur.id);
  }

  const record = {
    info: async () => ({ mode, version: VERSION, schemaVersion: SCHEMA_VERSION }),

    playbooks: {
      async list() { return db.prepare('SELECT * FROM playbooks ORDER BY id').all().map(r => ({ id: r.id, title: r.title, appliesTo: json(r.applies_to), rules: json(r.rules, []).length, changeCount: r.change_count, updatedAt: r.updated_at, updatedBy: r.updated_by, lastChange: r.last_change_kind ? { ruleId: r.last_change_rule, kind: r.last_change_kind } : null, owners: perms.owners(r.id), proposals: perms.pending(r.id).length })); },
      async get(id) { const r = db.prepare('SELECT * FROM playbooks WHERE id = ?').get(id); if (!r) throw notFound('Playbook'); return { id: r.id, title: r.title, appliesTo: json(r.applies_to), rules: json(r.rules, []), provenance: json(r.provenance), changeCount: r.change_count, version: r.change_count, updatedAt: r.updated_at, updatedBy: r.updated_by, lastChange: r.last_change_kind ? { ruleId: r.last_change_rule, kind: r.last_change_kind } : null, owners: perms.owners(r.id) }; },
      /**
       * One save of the shared playbook (PR-PB-01, PR-PB-05): an owner's save applies; anyone else's is kept as a
       * proposal (decision 178) and answered `{ proposal }`. `kind` names a whole-playbook change ('imported').
       */
      async update(id, draft, changeCount, actor, { kind = null } = {}) {
        const cur = await this.get(id);
        if (changeCount !== cur.changeCount) throw err(409, 'playbook_changed', 'The playbook changed. Reload it before saving.');
        const clean = validatePlaybook({ ...cur, ...draft });
        const change = kind ? { ruleId: null, kind } : describeChange(cur.rules, clean.rules);
        if (perms.isOwner(actor, id)) return applyPlaybook(cur, clean, change, actor);
        const changes = ruleChanges(cur.rules, clean.rules);
        const fields = {};
        if (clean.title && clean.title !== cur.title) fields.title = clean.title;
        if (canonical(clean.appliesTo ?? null) !== canonical(cur.appliesTo ?? null)) fields.appliesTo = clean.appliesTo ?? null;
        if (canonical(clean.provenance ?? null) !== canonical(cur.provenance ?? null)) fields.provenance = clean.provenance ?? null;
        if (!changes.length && !Object.keys(fields).length) throw err(400, 'bad_request', 'Nothing changed.');
        const proposalId = newId();
        insertEvent({ type: 'playbook_change_proposed', actor, payload: { playbookId: id, proposalId, kind: change.kind, ruleId: change.ruleId ?? undefined, changes, baseChange: cur.changeCount, ...(Object.keys(fields).length ? { fields } : {}) } });
        return { proposal: perms.proposal(id, proposalId) };
      },
      /** Proposed changes waiting for an owner (decision 178), oldest first. */
      async proposals(id) { await this.get(id); return perms.pending(id); },
      /** An owner applies a proposal to the playbook as it is now: one `playbook_changed` naming the proposer too. */
      async accept(id, proposalId, actor) {
        const cur = await this.get(id);
        perms.requireOwner(actor, id);
        const p = perms.proposal(id, String(proposalId || ''));
        const clean = validatePlaybook({ ...cur, ...p.fields, rules: applyRuleChanges(cur.rules, p.changes) });
        const change = p.kind === 'imported' ? { ruleId: null, kind: 'imported' } : describeChange(cur.rules, clean.rules);
        return applyPlaybook(cur, clean, change, actor, { proposalId: p.id, proposedBy: p.proposedBy });
      },
      /** An owner declines a proposal, with a note; the playbook is unchanged. */
      async decline(id, proposalId, note, actor) {
        await this.get(id);
        perms.requireOwner(actor, id);
        const p = perms.proposal(id, String(proposalId || ''));
        if (typeof note !== 'string' || !note.trim()) throw err(400, 'bad_request', 'Say why the change is declined.');
        insertEvent({ type: 'playbook_change_declined', actor, payload: { playbookId: id, proposalId: p.id, note: note.trim().slice(0, 1000) } });
        return { declined: p.id };
      },
      /** An admin names a playbook's owners (user ids of members); admins are owners whether named or not. */
      async setOwners(id, owners, actor) {
        await this.get(id);
        perms.requireAdmin(actor, 'Only an admin can name a playbook\'s owners.');
        if (!Array.isArray(owners) || owners.some(o => typeof o !== 'string' || !o)) throw err(400, 'bad_request', 'Send the owners as a list of people.');
        const list = [...new Set(owners)];
        if (mode === 'team') for (const o of list) if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND revoked_at IS NULL').get(o)) throw err(400, 'bad_request', 'An owner is a member of the team.');
        insertEvent({ type: 'playbook_owners_set', actor, payload: { playbookId: id, owners: list } });
        return this.get(id);
      },
      async create({ id, title, appliesTo = null, draft = {} } = {}, actor) {
        const name = typeof title === 'string' ? title.trim().slice(0, 200) : '';
        if (!name) throw err(400, 'bad_request', 'Name the new playbook.');
        const clean = validatePlaybook({ rules: [], ...draft });
        const base = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'playbook';
        let pid = base; for (let n = 2; playbookExists(pid); n++) pid = `${base}-${n}`;
        const at = now();
        tx(() => {
          db.prepare('INSERT INTO playbooks (id, title, applies_to, rules, provenance, change_count, updated_at, updated_by, last_change_rule, last_change_kind) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)').run(pid, name, canonical(normalizeAppliesTo(appliesTo) || clean.appliesTo || null), canonical(clean.rules), clean.provenance ? canonical(clean.provenance) : null, at, actor, 'created');
          insertEvent({ type: 'playbook_changed', at, actor, payload: { playbookId: pid, changeNo: 1, ruleId: null, kind: 'created' } });
          // Whoever creates a playbook owns it (decision 178); an admin owns every playbook already.
          if (actor && !perms.isAdmin(actor)) insertEvent({ type: 'playbook_owners_set', at, actor, payload: { playbookId: pid, owners: [actor] } });
        });
        return this.get(pid);
      },
      async import(text) { return { rules: importProsePlaybook(text) }; },
    },

    clauseTypes: { get: async () => clauseTypes.file },

    /** Actor ids as names (users, `system:mail`, `system:folder`); an id not listed (solo: the OS user name) shows as itself. */
    async actors() { return team.actors(); },

    /**
     * Administration (section 9.4, 7.10). In the team server these act on its own database behind the admin routes; in
     * solo mode the local app offers the status only. `checkMailNow` is the team server's mail consumer (slice S8).
     */
    admin: {
      async status() { return adminStatus(); },
      async issueCode(forName, admin, ttlHours, actor, { userId = null } = {}) { return team.issueCode({ forName, admin, ttlHours: ttlHours ?? readRawSetting(dataDir, 'codes.ttlHours') ?? 168, userId }, actor); },
      async listCodes() { return team.listCodes(); },
      async revokeCode(id, actor) { return team.revokeCode(id, actor); },
      async listUsers() { return team.listUsers(); },
      async revokeUser(id, actor) { return team.revokeUser(id, actor); },
      /** Replaced by the team server when mail capture is on (server/mail/consumer.js); solo mode has no mailbox (PR-SOLO-01). */
      async checkMailNow() { throw err(409, 'mail_disabled', mode === 'team' ? 'Mail capture is off: set mail.enabled in the settings file.' : 'There is no mailbox in solo mode.'); },
      /** PR-SEC-08: the date the team adopted its retention statement, written into the settings file. */
      async setRetention(adoptedOn) {
        if (adoptedOn !== null && !(typeof adoptedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(adoptedOn) && !Number.isNaN(Date.parse(adoptedOn)))) throw err(400, 'bad_request', 'Send the date the statement was adopted, as YYYY-MM-DD.');
        writeServerSetting(dataDir, 'retention.adoptedOn', adoptedOn);
        return { adoptedOn };
      },
    },

    /** Internals for gcl, the playbook import and the mail consumer; not part of the Record interface. */
    internal: { db, dataDir, team, clauseTypes, settings, insertEvent, tx, now },
    close() { db.close(); },
  };
  return record;
}

/** What one playbook save changed, for the one-line "last changed" note (decision 150: no rule content). */
export function describeChange(before, after) {
  const a = new Map(before.map(r => [r.id, r])), b = new Map(after.map(r => [r.id, r]));
  const added = after.filter(r => !a.has(r.id)), removed = before.filter(r => !b.has(r.id));
  const edited = after.filter(r => a.has(r.id) && canonical(a.get(r.id)) !== canonical(r));
  if (added.length + removed.length + edited.length !== 1) return { ruleId: null, kind: 'edited' };
  if (added.length) return { ruleId: added[0].id, kind: 'added' };
  if (removed.length) return { ruleId: removed[0].id, kind: 'removed' };
  const was = a.get(edited[0].id), now = edited[0];
  if (was.enabled !== now.enabled && canonical({ ...was, enabled: null }) === canonical({ ...now, enabled: null })) return { ruleId: now.id, kind: now.enabled === false ? 'disabled' : 'enabled' };
  return { ruleId: now.id, kind: 'edited' };
}

