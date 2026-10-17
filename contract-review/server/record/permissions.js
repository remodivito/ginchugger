// SPDX-License-Identifier: GPL-3.0-or-later
// Who may do what to the shared record (decision 178; product v2 spec PR-DEL-02, PR-PB-05 to 07). Two rules only:
// deleting a matter is for admins; a playbook is edited by its owners (admins always count as owners), and everyone
// else's edit is kept as a proposal an owner accepts or declines. In solo mode the one user is the admin and the owner.
// Owners and proposals are events (`playbook_owners_set`, `playbook_change_proposed`, `playbook_change_declined`, and
// `playbook_changed` naming the proposal it applied), read back here; no table of their own, so no schema change.
import { canonical } from '../record.js';

const err = (status, code, message) => Object.assign(new Error(message), { status, code });
/** The admin command inside the container acts as an admin (it can issue the first admin's code). */
const ADMIN_SYSTEM_ACTORS = ['system:gcl'];

export function makePermissions({ db, mode }) {
  const userRow = id => db.prepare('SELECT admin, revoked_at FROM users WHERE id = ?').get(String(id ?? ''));
  const latest = (type, playbookId) => db.prepare(`SELECT * FROM events WHERE type = ? AND json_extract(payload, '$.playbookId') = ? ORDER BY seq DESC LIMIT 1`).get(type, playbookId);

  /** Solo mode: the one user is the admin. Team mode: a member whose admin flag is set and who is not revoked. */
  function isAdmin(actor) {
    if (mode !== 'team') return true;
    if (ADMIN_SYSTEM_ACTORS.includes(actor)) return true;
    const u = userRow(actor);
    return !!(u && u.admin && !u.revoked_at);
  }
  /** The playbook's named owners (user ids), from its latest `playbook_owners_set` event; admins are owners besides. */
  function owners(playbookId) {
    const e = latest('playbook_owners_set', playbookId);
    return e ? JSON.parse(e.payload).owners : [];
  }
  const isOwner = (actor, playbookId) => isAdmin(actor) || owners(playbookId).includes(actor);

  return {
    isAdmin, owners, isOwner,
    requireAdmin(actor, message) { if (!isAdmin(actor)) throw err(403, 'forbidden', message); },
    requireOwner(actor, playbookId) { if (!isOwner(actor, playbookId)) throw err(403, 'forbidden', 'Only an owner of this playbook can accept or decline a proposed change.'); },
    /** Proposals not yet accepted or declined, oldest first. */
    pending(playbookId) {
      const decided = new Set(db.prepare(`SELECT json_extract(payload, '$.proposalId') AS p FROM events WHERE type IN ('playbook_change_declined', 'playbook_changed') AND json_extract(payload, '$.playbookId') = ? AND json_extract(payload, '$.proposalId') IS NOT NULL`).all(playbookId).map(r => r.p));
      return db.prepare(`SELECT * FROM events WHERE type = 'playbook_change_proposed' AND json_extract(payload, '$.playbookId') = ? ORDER BY seq`).all(playbookId)
        .map(r => ({ r, p: JSON.parse(r.payload) })).filter(({ p }) => !decided.has(p.proposalId))
        .map(({ r, p }) => ({ id: p.proposalId, playbookId, proposedBy: r.actor, at: r.at, ruleId: p.ruleId ?? null, kind: p.kind, baseChange: p.baseChange, changes: p.changes, fields: p.fields || {} }));
    },
    proposal(playbookId, proposalId) {
      const p = this.pending(playbookId).find(x => x.id === proposalId);
      if (p) return p;
      const any = db.prepare(`SELECT 1 FROM events WHERE type = 'playbook_change_proposed' AND json_extract(payload, '$.playbookId') = ? AND json_extract(payload, '$.proposalId') = ?`).get(playbookId, proposalId);
      throw any ? err(409, 'proposal_decided', 'That proposed change has already been accepted or declined.') : err(404, 'not_found', 'Proposed change not found.');
    },
  };
}

/** The rules a save changes, one entry per rule id: the rule as it would be, or null when it is removed. */
export function ruleChanges(before, after) {
  const a = new Map(before.map(r => [r.id, r])), b = new Map(after.map(r => [r.id, r]));
  const out = [];
  for (const r of after) if (!a.has(r.id) || canonical(a.get(r.id)) !== canonical(r)) out.push({ ruleId: r.id, rule: r });
  for (const r of before) if (!b.has(r.id)) out.push({ ruleId: r.id, rule: null });
  return out;
}

/** A proposal's rule changes applied to the playbook as it is now: replaced in place, added at the end, or removed. */
export function applyRuleChanges(rules, changes) {
  let out = rules.slice();
  for (const c of changes) {
    const i = out.findIndex(r => r.id === c.ruleId);
    if (c.rule === null) { if (i >= 0) out.splice(i, 1); } else if (i >= 0) out[i] = c.rule; else out = [...out, c.rule];
  }
  return out;
}
