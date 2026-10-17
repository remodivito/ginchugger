You are checking test items written for a contract-review benchmark. Each item is one edit to a clean agreement, written by another author. You are told exactly what changed, which playbook rule it is said to concern, and from which side the agreement is reviewed. This is not a search task: judge only the items listed, as stated.

For each item answer four questions, from the stated side, holding the playbook given:

1. `q1`. For an item of kind "deviation": does the edited text depart from the playbook's acceptable position under the stated rule (so that a careful lawyer for this side, holding this playbook, would want it changed)? For an item of kind "benign": does the edited text comply with the playbook for this side (no departure under the stated rule or any other)?
2. `q2`. For a deviation: does the reference fix meet the rule's acceptable position (it need not be the preferred position)? For a benign item: null.
3. `q3`. For a deviation: is the check sound? The check is applied case-insensitively to a proposed paragraph: every `require` regex must match, no `forbid` regex may match, and the number captured by `num` must lie within `min` and `max` (either may be absent). It is sound if it accepts the reference fix, rejects the edited text, and would accept any other wording that meets the acceptable position that you can think of. For an inserted paragraph the fix is its deletion and there is no check: answer whether deleting it meets the acceptable position. For a benign item: null.

4. `q4`. For every item: does the edited text name a real company, product or person (the agreement's parties are fictional)? Answer true if it does, and name it in your reasons; false otherwise.

Give a short reason for every answer to q1 to q3 that is false and for a q4 that is true, and one sentence otherwise.

Return only a JSON object: {"answers": [{"ref": "X01", "q1": true, "q2": true, "q3": true, "q4": false, "reasons": "…"}, …]} with one entry for every item listed, in any order.
