// SPDX-License-Identifier: GPL-3.0-or-later
// The shipped playbooks into the record (product v2 spec section 5.6, slice S6): the local app and the team server copy
// them in on start (importPlaybooks), from the playbook library's seeds. The folder-store migration (`gcl import-legacy`,
// matters into the record) went with matters (decision 190).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '../record.js';
import { makeLibrary } from '../playbook.js';
import { derivedId } from './events.js';

export const MIGRATED = 'migrated';
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
/** The shipped playbooks, as the local app seeds its library. */
export const defaultSeeds = () => [{ id: 'nda', seedPath: path.join(appRoot, 'data', 'playbook.json') }, { id: 'order-form', seedPath: path.join(appRoot, 'data', 'playbooks', 'order-form.json') }].filter(s => existsSync(s.seedPath));

/**
 * Step 5 on its own: the active playbook and each library playbook into the record, `change_count = version`,
 * `updated_by` = `actor` ('migrated' by default; the local app passes its user for a library save, slice S5). A
 * playbook already at that change count or later is left alone. Returns the ids copied.
 */
export async function importPlaybooks(record, root, { seeds = defaultSeeds(), actor = MIGRATED, report = { at: new Date().toISOString(), playbooks: [], eventsAdded: 0 } } = {}) {
  const { db, insertEvent, tx } = record.internal;
  const has = id => !!db.prepare('SELECT 1 FROM events WHERE id = ?').get(id);
  if (!seeds.length) return report.playbooks;
  const library = makeLibrary({ dir: root, seeds });
  for (const meta of await library.list()) {
    const pb = await library.get(meta.id); const version = Number(pb.version) || 1;
    const cur = db.prepare('SELECT change_count FROM playbooks WHERE id = ?').get(pb.id);
    if (cur && cur.change_count >= version) continue;
    tx(() => {
      const at = pb.updatedAt || report.at;
      db.prepare(`INSERT INTO playbooks (id, title, applies_to, rules, provenance, change_count, updated_at, updated_by, last_change_rule, last_change_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'imported')
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, applies_to = excluded.applies_to, rules = excluded.rules, provenance = excluded.provenance, change_count = excluded.change_count, updated_at = excluded.updated_at, updated_by = excluded.updated_by, last_change_rule = NULL, last_change_kind = 'imported'`)
        .run(pb.id, pb.title || pb.id, pb.appliesTo ? canonical(pb.appliesTo) : null, canonical(pb.rules || []), pb.provenance ? canonical(pb.provenance) : null, version, at, actor);
      const id = derivedId(`legacy-playbook:${pb.id}:${version}`);
      if (!has(id)) { insertEvent({ id, type: 'playbook_changed', at, actor, payload: { playbookId: pb.id, changeNo: version, ruleId: null, kind: 'imported' } }); report.eventsAdded++; }
    });
    report.playbooks.push({ id: pb.id, title: pb.title || pb.id, changeCount: version });
  }
  return report.playbooks;
}
