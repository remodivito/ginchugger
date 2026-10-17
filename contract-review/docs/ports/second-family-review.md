# Second-family review of the matching port (15 October 2026)

Product spec section 10.A.6 and decision 163: the ported correspondent matching (`server/ports/paperless/matching.js`) is reviewed by a model family other than the one that wrote it, then by a person.

**How.** `scripts/port-review-second-family.mjs` sends the pinned Python (`reference/matching.py`, `reference/regex.py`), the port and `known-diffs.md` to an open model through Munito and asks for inputs on which the two diverge, with severity. Run four times on 15 October:

| Run | GLM-5.3 Flash | DeepSeek V4 Flash |
|---|---|---|
| 1, 32,000 output tokens | spent all of it reasoning, no answer | same |
| 2, 64,000, non-streamed | response-header timeout after 5 minutes | same |
| 3, 64,000, streamed | spent all of it reasoning, no answer | same |
| 4, brief capped at ten findings, low reasoning effort | rate-limited (HTTP 429) | one finding |

**The finding.** DeepSeek reported that the port accepts the quantifier `{,3}` while Python's `regex` rejects it, so a malformed pattern could match in the port and not in Paperless. Tested against the reference interpreter (CPython 3.12.15, `regex` 2026.9.10, the versions behind the golden outputs): `re.search('a{,3}','a')` and `regex.search('a{,3}','a')` both match, and so does the port. The finding is wrong; no change.

**Result.** No divergence beyond `known-diffs.md` was found by the second family. The person's review is the code review of this slice. The reference outputs (299 of 299 development, 134 of 135 held-out) remain the main evidence.
