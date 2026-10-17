// SPDX-License-Identifier: GPL-3.0-or-later
// The canary (BENCHMARK-V2.md 5.11, 11.9): one GUID in a top-level `canary` field of every v2 file, never inside paragraph
// text, and removed before anything reaches a model. Documents, playbooks and seeded-record documents pass through
// these functions on their way to the reviewer; review-one.mjs and seed-record.mjs call them.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CANARY_FILE = fileURLToPath(new URL('./CANARY.md', import.meta.url));
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The benchmark's GUID from CANARY.md, or null before P12 writes it. */
export function canaryGuid(file = CANARY_FILE) { if (!existsSync(file)) return null; const m = readFileSync(file, 'utf8').match(GUID); return m ? m[0] : null; }
/** A copy of a JSON object without its top-level canary (other fields untouched). */
export function stripCanary(obj) { if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !('canary' in obj)) return obj; const { canary, ...rest } = obj; return rest; }
/** A record seed with the canary removed from the seed and from every round's and standard form's document. */
export function stripSeed(seed) {
  const s = stripCanary(seed);
  return { ...s, matters: (s.matters || []).map(m => ({ ...stripCanary(m), rounds: (m.rounds || []).map(r => (r.document ? { ...r, document: stripCanary(r.document) } : r)) })),
    ...(s.standardForms ? { standardForms: s.standardForms.map(f => (f.document ? { ...f, document: stripCanary(f.document) } : f)) } : {}) };
}
/** Whether some text (a payload as sent) carries a canary: the field name or a known GUID. */
export function carriesCanary(text, guids = []) { const t = String(text); return /"canary"\s*:/.test(t) || guids.filter(Boolean).some(g => t.includes(g)); }
