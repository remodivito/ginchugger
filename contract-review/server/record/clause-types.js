// SPDX-License-Identifier: GPL-3.0-or-later
// Clause types (product v2 spec section 5.5; decision 159): CUAD's 41 categories plus a few custom types, and the
// mapping from each playbook's rule ids to one type. Kept apart from the playbooks so playbook hashes stay valid.
// Validated at start: an unknown type id in a mapping fails start. Retired types stay listed and still resolve.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CLAUSE_TYPES_PATH = fileURLToPath(new URL('../../data/clause-types.json', import.meta.url));
export const FORMAT = 'ginchugger-clause-types/1';
const ID = /^(cuad|custom):[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateClauseTypes(file) {
  const fail = m => { throw Object.assign(new Error(`clause-types: ${m}`), { code: 'clause_types_invalid' }); };
  if (!file || file.format !== FORMAT) fail(`format must be ${FORMAT}.`);
  if (!Array.isArray(file.types) || !file.types.length) fail('types must be a non-empty array.');
  const ids = new Set();
  for (const t of file.types) {
    if (!t || !ID.test(t.id || '')) fail(`bad type id ${JSON.stringify(t?.id)}.`);
    if (ids.has(t.id)) fail(`duplicate type id ${t.id}.`);
    ids.add(t.id);
    if (typeof t.name !== 'string' || !t.name.trim()) fail(`${t.id} needs a name.`);
    if (!['active', 'retired'].includes(t.status)) fail(`${t.id} status must be active or retired.`);
    if (t.status === 'retired' && !t.retiredOn) fail(`${t.id} is retired without retiredOn.`);
    if (t.id.startsWith('custom:') && !t.addedOn) fail(`${t.id} is custom without addedOn.`);
  }
  const cuad = file.types.filter(t => t.id.startsWith('cuad:')).length;
  if (cuad !== 41) fail(`CUAD lists 41 categories; this file has ${cuad}.`);
  if (!file.mappings || typeof file.mappings !== 'object' || Array.isArray(file.mappings)) fail('mappings must be an object keyed by playbook id.');
  for (const [pb, rules] of Object.entries(file.mappings)) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) fail(`mappings.${pb} must map rule ids to one type each.`);
    for (const [rule, type] of Object.entries(rules)) if (typeof type !== 'string' || !ids.has(type)) fail(`mappings.${pb}.${rule} names unknown type ${JSON.stringify(type)}.`);
  }
  return file;
}

/** Load and validate; returns a resolver over the file. */
export function loadClauseTypes(path = CLAUSE_TYPES_PATH) {
  return clauseTypes(validateClauseTypes(JSON.parse(readFileSync(path, 'utf8'))));
}

export function clauseTypes(file) {
  const byId = new Map(file.types.map(t => [t.id, t]));
  return {
    file,
    /** The type a playbook's rule maps to, or null. */
    typeFor(playbookId, ruleId) { return (playbookId && ruleId && file.mappings[playbookId]?.[ruleId]) || null; },
    /** Resolve a type id, retired ones included. */
    get(id) { return byId.get(id) || null; },
    /** Enabled rules of each playbook with no mapping (PR-REC-08: a warning, not an error). */
    unmapped(playbooks) { return playbooks.flatMap(pb => (pb.rules || []).filter(r => r.enabled !== false && !this.typeFor(pb.id, r.id)).map(r => ({ playbookId: pb.id, ruleId: r.id }))); },
  };
}
