// SPDX-License-Identifier: GPL-3.0-or-later
// Is the review saved for this Word URL still this document's? (Stress audit, 17 Oct 2026.) The pane keeps its review per
// document URL (decision 134), but a new version saved over the old file (same name, same folder, or the same
// SharePoint item) has the same URL: the pane then brought back the earlier document's review and named the earlier
// store document. The store decides first: the open file looked up by its bytes or words (never added). Without a
// store answer the words decide: versions of one agreement share most paragraphs, a different agreement few.

const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
/** The share of the current paragraphs (non-empty) whose text is in the saved document, before or after our changes. */
export function textOverlap(savedDoc, currentTexts) {
  const known = new Set((savedDoc?.paragraphs || []).flatMap(p => [p.text, p.originalText]).map(squash).filter(Boolean));
  const now = (currentTexts || []).map(squash).filter(Boolean);
  if (!now.length) return known.size ? 0 : 1;
  return now.filter(t => known.has(t)).length / now.length;
}
/**
 * `found`: the store document holding the open file (null: none; undefined: the store could not be asked). The saved
 * session is this document's when the store names the document the session reviewed (or the reply saved from it), or,
 * without a store answer naming another, when at least `minOverlap` of the paragraphs are the saved document's.
 */
export function sessionIsFor(state, currentTexts, found, { minOverlap = 0.6 } = {}) {
  if (!state?.doc) return false;
  if (found && (state.storeDoc?.id || state.saved?.id)) return [state.storeDoc?.id, state.saved?.id].includes(found.id);
  return textOverlap(state.doc, currentTexts) >= minOverlap;
}
