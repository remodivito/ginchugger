// SPDX-License-Identifier: GPL-3.0-or-later
// Event types and payload shapes (product v2 spec section 5.2, after decision 190). The record keeps only the team's own
// events now: playbook changes, owners and proposals, members, keys and setup codes. Review events (what a review raised
// and what the lawyer did) belong to a store document's review history (server/store/review-history.js), which checks
// them against the shapes below. Matter, round, filing, trash and note events are gone with matters (decision 190); old
// record.sqlite files still hold them, and nothing reads them. Unknown types are refused; payloads over 50,000 bytes too.
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from '../record.js';

export const MAX_PAYLOAD_BYTES = 50_000;

// type -> { scope: 'global' (the record) | 'document' (a store document's review history), required, optional }
export const EVENT_SHAPES = {
  review_run: { scope: 'document', required: ['reviewId', 'playbookId'], optional: ['round', 'playbookChange', 'promptSha256', 'executor', 'model', 'effort', 'agentic', 'toolCalls', 'findings', 'attention', 'unverifiedRecordCitations', 'reviewMode'] },
  finding_flagged: { scope: 'document', required: ['reviewId', 'findingId', 'ruleId'], optional: ['clauseType', 'paragraphId', 'title', 'decision', 'quote', 'proposedText', 'record'] },
  // Audit finding 1: `reason` says why a point was dismissed: 'not-an-issue' (the model was wrong; a false alarm, never a
  // position) or 'accepted' (we accept their wording: a concession). Events written before it carry no reason.
  // `title` and `quote` (the point's title and their wording) ride on an 'accepted' dismissal, so the concession can be
  // put on the document as a store note the agent reads (server/store/http.js).
  finding_dismissed: { scope: 'document', required: ['reviewId', 'findingId', 'note'], optional: ['ruleId', 'clauseType', 'reason', 'title', 'quote'] },
  finding_undismissed: { scope: 'document', required: ['reviewId', 'findingId'] },
  finding_revised: { scope: 'document', required: ['reviewId', 'findingId'], optional: ['instruction', 'revisionNote'] },
  edit_applied: { scope: 'document', required: ['reviewId', 'findingId'], optional: ['ruleId', 'clauseType', 'paragraphId', 'before', 'after', 'bookmark', 'overRevisions'] },
  edit_rejected_in_word: { scope: 'document', required: ['reviewId', 'findingId'], optional: ['bookmark'] },
  comment_replied: { scope: 'document', required: ['reviewId', 'findingId', 'text'], optional: ['ruleId', 'clauseType', 'paragraphId', 'commentId'] },
  document_exported: { scope: 'document', required: ['reviewId', 'sha256'], optional: ['signed'] },
  playbook_changed: { scope: 'global', required: ['playbookId', 'changeNo', 'kind'], optional: ['ruleId', 'proposalId', 'proposedBy'] },
  // Decision 178: a playbook's owners, and a non-owner's edit kept as a proposal until an owner accepts or declines it.
  playbook_owners_set: { scope: 'global', required: ['playbookId', 'owners'] },
  playbook_change_proposed: { scope: 'global', required: ['playbookId', 'proposalId', 'kind', 'changes', 'baseChange'], optional: ['ruleId', 'fields'] },
  playbook_change_declined: { scope: 'global', required: ['playbookId', 'proposalId', 'note'] },
  user_joined: { scope: 'global', required: ['userId', 'name'], optional: ['admin', 'codeId', 'deviceName'] },
  key_revoked: { scope: 'global', required: ['userId', 'keyId'] },
  code_issued: { scope: 'global', required: ['codeId', 'forName', 'expiresAt'], optional: ['admin'] },
  code_revoked: { scope: 'global', required: ['codeId'] },
};
export const EVENT_TYPES = Object.keys(EVENT_SHAPES);
export const REVIEW_EVENT_TYPES = ['review_run', 'finding_flagged', 'finding_dismissed', 'finding_undismissed', 'finding_revised', 'edit_applied', 'edit_rejected_in_word', 'comment_replied', 'document_exported'];
/** Why a point was dismissed (audit finding 1). Only 'accepted' is a position we took. */
export const DISMISS_REASONS = ['not-an-issue', 'accepted'];
const PLAYBOOK_CHANGE_KINDS = ['added', 'edited', 'removed', 'enabled', 'disabled', 'imported', 'created'];

const bad = message => Object.assign(new Error(message), { status: 400, code: 'bad_request' });
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** Check one record event's type and payload; returns the payload as canonical JSON. Throws 400 on anything else. */
export function validateEvent({ type, matterId = null, payload }) {
  const shape = EVENT_SHAPES[type];
  if (!shape) throw bad(`Unknown event type "${type}".`);
  if (shape.scope !== 'global') throw bad(`A ${type} event belongs to a document's review history, not the record.`);
  if (matterId) throw bad(`A ${type} event names no matter.`);
  if (!isObj(payload)) throw bad('An event payload is an object.');
  for (const k of shape.required) if (payload[k] === undefined) throw bad(`A ${type} event needs "${k}".`);
  const known = new Set([...shape.required, ...(shape.optional || [])]);
  for (const k of Object.keys(payload)) if (payload[k] !== undefined && !known.has(k)) throw bad(`A ${type} event has no field "${k}".`);
  if (['playbook_changed', 'playbook_change_proposed'].includes(type) && !PLAYBOOK_CHANGE_KINDS.includes(payload.kind)) throw bad(`Playbook change kind is one of ${PLAYBOOK_CHANGE_KINDS.join(', ')}.`);
  if (type === 'playbook_owners_set' && (!Array.isArray(payload.owners) || payload.owners.some(o => typeof o !== 'string' || !o))) throw bad('Owners are a list of user ids.');
  if (type === 'playbook_change_proposed' && (!Array.isArray(payload.changes) || payload.changes.some(c => !isObj(c) || typeof c.ruleId !== 'string' || (c.rule !== null && !isObj(c.rule))))) throw bad('A proposed change names each rule it changes.');
  if (type === 'playbook_change_declined' && (typeof payload.note !== 'string' || !payload.note.trim())) throw bad('Declining a proposed change needs a note.');
  const json = canonical(payload);
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw Object.assign(new Error('Event too large.'), { status: 413, code: 'too_large' });
  return json;
}

/** A UUID-shaped id derived from a string, so migrated and seeded events keep the same id on every run. */
export function derivedId(seed) {
  const h = createHash('sha256').update(String(seed)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const newId = () => randomUUID();
