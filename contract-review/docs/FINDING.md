# The finding contract

Spec R5.2 and R5.3. One structure, produced by `validateFindings` in `server/review.js` from whatever the model returns, and rendered by the browser view and the Word task pane without re-interpretation. Validation flags problems on the finding; it never removes a finding. The only error it throws is when the model output has no `findings` array at all.

## Shape

```json
{
  "id": "uuid",
  "paragraphId": "p42",
  "anchored": true,
  "title": "Confidentiality term extended to seven years",
  "status": "attention",
  "decision": "reserved",
  "explanation": "Playbook S-05: up to five years acceptable without escalation; above five requires GC approval.",
  "evidence": [
    { "paragraphId": "p42", "quote": "seven (7) years", "verified": true },
    { "paragraphId": "p42", "quote": "three (3) years", "source": "baseline", "verified": true }
  ],
  "ruleIds": ["S-05"],
  "unknownRuleIds": [],
  "proposedText": "…shall survive for a period of five (5) years…",
  "proposalStatus": "ok",
  "suggestedText": "…shall survive for a period of five (5) years…",
  "insertAfter": [{ "afterParagraphId": "p60", "text": "…", "anchored": true }],
  "options": [{ "label": "Counter at five years", "text": "…" }, { "label": "Counter at three years" }, { "label": "Escalate on seven" }],
  "flags": {},
  "notes": []
}
```

| Field | Meaning |
|---|---|
| `paragraphId`, `anchored` | Target paragraph in the current document. `anchored:false` means the id was not found; the finding is still returned and shown unanchored. |
| `status` | `attention`, `within-guidance`, `context`. Unknown values become `context` with a note. `within-guidance` without a rule becomes `context`. "Within guidance" is never approval. |
| `decision` | `accept`, `reject`, `accept-with-modification`, `counter`, `reserved`, `none`. Unknown values become `none`. |
| `evidence[].verified` | True only when the quote is a non-empty exact substring of the cited paragraph's current text, or of its pre-change text when `source` is `baseline`. Unverified quotes are kept and shown as unverified. |
| `ruleIds`, `unknownRuleIds` | Active playbook rules cited; references that do not exist are moved to `unknownRuleIds` with a note. |
| `proposedText`, `proposalStatus`, `proposalNote` | The model's proposed replacement for the paragraph. `ok` means it may be offered for application. `not-applicable` (empty wording for an empty paragraph, unanchored, no rule or instruction cited, or absurdly long) keeps the text visible but the interface must not offer apply. `suggestedText` is set only when `ok`, for older callers. |
| `insertAfter[]` | New paragraphs anchored after an existing one; `anchored:false` when the anchor is unknown. |
| `options[]` | Choices the model says depend on the lawyer; rendered as buttons. |
| `deletion` | Present and `true` when `proposedText` is empty for a paragraph that has text: the proposal is to delete the clause (the prompt's form for rejecting an inserted clause). Offered for Apply as "Delete clause", which strikes the whole paragraph as one tracked deletion. |
| `revisionNote` | After Reword: what the revision changed, in the model's words (up to 300 characters). |
| `flags` | `missingWording` (a decision that changes the text with no wording drafted) and `missingRisk` (a deviation with no rating under a playbook that sets out a risk scheme). The earlier `judgmentBoundary` flag was removed on 9 October 2026: on 21 recorded runs it fired 36 times, never about the contract (R18). The product has no approve action, so the boundary is held by what the pane lets anyone do. |
| `notes[]` | Every problem the validator recorded, in plain words. The interface shows them beside the finding. |

Review-level: `validateFindings` also returns `notes` (collection-level problems) and `limits` (the model's own stated limits), which the server appends to the review's `limits`.

## What changed on 3 October 2026

Before: three validators (strict, lenient, v2). Strict threw away a whole review over one finding, which is how product v1.1 produced no output in EXP-008. After: one validator, every finding returned, every problem a note. `CONSTRAINTS.md` forbids weakening quote verification: the check may tolerate more whitespace variants, but a non-matching quote is never marked verified.

## Completeness flags (added 4 October 2026)

`flags.missingWording` is set when the decision is `reject`, `counter` or `accept-with-modification` and the finding carries neither `proposedText` nor `insertAfter`. `flags.missingRisk` is set when the active playbook has a risk classification scheme, the finding needs attention, the decision is not `accept` or `none`, and no `risk` was returned. Each adds a plain note the lawyer sees ("The decision calls for wording but none was drafted. Use Revise to ask for it."). The tool never drafts the wording or assigns the rating itself, and the finding is never dropped. The review prompt states the same two requirements, plus one on figures: where a deviation's weight depends on a figure in the supplied documents, the explanation states the figures and the arithmetic.
