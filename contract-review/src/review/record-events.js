// SPDX-License-Identifier: GPL-3.0-or-later
// The review events the pane writes to the document's review history (product v2 spec 5.2, 7.4 step 6; plan task 8).
// The pane is their one writer: after a review arrives it posts one batch, `review_run` and one `finding_flagged` per
// attention finding with a rule, to POST /api/v2/store/documents/:id/review-events; each later decision is posted the
// same way as it happens. Text fields are cut to
// the route's limits before posting (6.2.1): quotes at 2,000 characters, proposed and applied wording at 8,000.
export const QUOTE_MAX = 2000, TEXT_MAX = 8000;

/** The note a dismissal carries for each reason (the event's `reason` is the field the record reads). */
export const DISMISS_NOTE = { 'not-an-issue': 'Not an issue', accepted: 'Accepted their wording' };

const cut = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s ?? null);

/** The wording a finding quotes from the document: its first verified quote of the document, else its first quote. */
export const findingQuote = f => (f.evidence || []).find(e => e.verified !== false && !e.source)?.quote ?? f.evidence?.[0]?.quote ?? '';

/** The clause type a playbook rule maps to, from the clause-types file (`mappings[playbookId][ruleId]`), or null. */
export function clauseTypeFor(clauseTypes, playbookId, ruleId) {
  return (ruleId && clauseTypes?.mappings?.[playbookId]?.[ruleId]) || null;
}

/** The batch written once per review: `review_run`, then a `finding_flagged` per attention finding citing a rule. */
export function reviewBatch(review, { round = null, reviewMode = null, clauseTypes = null } = {}) {
  const playbookId = review.playbook?.id || null;
  const findings = review.findings || [];
  const flagged = findings.filter(f => f.status === 'attention' && f.ruleIds?.length);
  const m = review.model || {};
  const run = { type: 'review_run', payload: {
    reviewId: review.id, round: Number.isInteger(round) ? round : null, playbookId, playbookChange: review.playbookVersion ?? null,
    promptSha256: m.promptSha256 || null, executor: m.executor || null, model: m.model || null, effort: m.effort || null,
    agentic: m.agentic === true, toolCalls: Number.isInteger(m.toolCalls) ? m.toolCalls : 0, findings: findings.length,
    attention: findings.filter(f => f.status === 'attention').length, unverifiedRecordCitations: review.unverifiedRecordCitations || 0,
    reviewMode: reviewMode || m.reviewMode || null,
  } };
  return [run, ...flagged.map(f => ({ type: 'finding_flagged', payload: {
    reviewId: review.id, findingId: f.id, ruleId: f.ruleIds[0], clauseType: clauseTypeFor(clauseTypes, playbookId, f.ruleIds[0]),
    paragraphId: f.paragraphId || null, title: f.title || null, decision: f.decision || null,
    quote: cut(findingQuote(f), QUOTE_MAX),
    proposedText: cut(f.proposedText ?? f.suggestedText ?? null, TEXT_MAX),
    record: (f.record || []).map(c => ({ documentId: Number.isInteger(c.documentId) ? c.documentId : null, quote: cut(c.quote ?? '', QUOTE_MAX), counterparty: c.counterparty ?? null, verified: c.verified === true })),
  } }))];
}

/**
 * One decision as a review event, or null when the decision has no event in the record (marked reviewed, an option
 * recorded, an applied change undone in the browser: those stay in the pane's own activity).
 *   kind: 'dismissed' { note, reason: 'not-an-issue' | 'accepted' } | 'undismissed' | 'revised' { instruction, revisionNote } | 'applied' { before, after,
 *         bookmark, paragraphId? } | 'rejected' { bookmark } | 'replied' { commentId, text } | 'exported' { sha256, signed }
 */
export function decisionEvent(kind, { review, finding = null, clauseTypes = null, ...d } = {}) {
  const reviewId = review?.id; if (!reviewId) return null;
  const ruleId = finding?.ruleIds?.[0] || null;
  const base = { reviewId, ...(finding ? { findingId: finding.id } : {}) };
  const rule = { ruleId, clauseType: clauseTypeFor(clauseTypes, review.playbook?.id, ruleId) };
  switch (kind) {
    // Audit finding 1: the pane asks why (one tap): not an issue, or accept their wording; only the second is a position.
    // An accepted wording carries the point's title and their quote: the server puts the concession on the document as a
    // store note, which the agent reads on the next review.
    case 'dismissed': return { type: 'finding_dismissed', payload: { ...base, ...rule, note: (d.note || '').trim() || DISMISS_NOTE[d.reason] || '(no note)', ...(DISMISS_NOTE[d.reason] ? { reason: d.reason } : {}), ...(d.reason === 'accepted' && finding ? { title: finding.title || null, quote: cut(findingQuote(finding), QUOTE_MAX) } : {}) } };
    case 'undismissed': return { type: 'finding_undismissed', payload: base };
    case 'revised': return { type: 'finding_revised', payload: { ...base, instruction: cut(d.instruction ?? null, TEXT_MAX), revisionNote: cut(d.revisionNote ?? null, TEXT_MAX) } };
    case 'applied': return { type: 'edit_applied', payload: { ...base, ...rule, paragraphId: d.paragraphId || finding?.paragraphId || null, before: cut(d.before ?? null, TEXT_MAX), after: cut(d.after ?? null, TEXT_MAX), bookmark: d.bookmark || null, overRevisions: d.overRevisions === true } };
    case 'rejected': return { type: 'edit_rejected_in_word', payload: { ...base, bookmark: d.bookmark || null } };
    case 'replied': return { type: 'comment_replied', payload: { ...base, ...rule, paragraphId: finding?.paragraphId || null, commentId: d.commentId || null, text: cut(String(d.text || ''), TEXT_MAX) } };
    case 'exported': return d.sha256 ? { type: 'document_exported', payload: { reviewId, sha256: d.sha256, signed: d.signed === true } } : null;
    default: return null;
  }
}
