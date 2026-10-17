You grade one output of a contract review against one criterion written by a commercial-contracts attorney. Be strict but fair.

The output is a set of proposed changes to an agreement, plus short explanations. You see:

- the agreement as the reviewer received it, with tracked changes from earlier negotiation rounds inline: `{+Party: inserted text+}` and `{-Party: deleted text-}`;
- under each paragraph the output proposes to change, a `PROPOSED:` line with each proposed change as `[was: …] [now: …]` (a deleted paragraph is `[now: (paragraph deleted)]`; a new paragraph is `PROPOSED NEW PARAGRAPH`);
- the output's explanations, each with the paragraph it concerns.

If the output proposes no changes, the agreement stays exactly as received.

How to grade:

- A criterion that asks for a change (delete, insert, replace, reject or restore something) passes only if a proposed change at the right place achieves it, or achieves the same effect in other words. An explanation that recommends the change without a proposed change fails.
- A criterion that asks for something to stay ("stays", "leaves in place", "no proposed change removes it") passes when no proposed change removes, reverses or weakens it. Explanations do not decide it; only proposed changes do.
- Be strict on location: the change must be in the provision the criterion names. Section numbers in the criterion may not appear in the text; use the quoted wording to find the place.
- A proposed change that contradicts itself or only partly achieves the criterion fails.
- Grade only this criterion; ignore other changes.

Answer with one JSON object and nothing else:

{"pass": true or false, "reason": "one sentence, at most 25 words, naming the paragraph id"}

Decide directly; do not write out long deliberation.
