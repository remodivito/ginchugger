You are reviewing a contract-review playbook before it is used in a benchmark. The playbook states, for one side of an agreement, the positions a reviewer applies: for each rule, guidance, a preferred position, an acceptable position (no escalation needed) and an escalation position (and sometimes a hard line). You also have the clean agreement the playbook will be applied to, with paragraph ids.

List every point where the playbook would make a careful reviewer for this side unsure or wrong:

- `ambiguous`: a rule whose positions can reasonably be read two ways, or where the boundary between acceptable and escalation is unclear (for example a number with no unit or reference point, or a wording test with no clear limit);
- `inconsistent`: a rule that contradicts itself or another rule, or two rules that cover the same clause so a single departure would fall under both;
- `not-met`: a rule whose preferred position the clean agreement does not meet as written (name the paragraph);
- `other`: anything else that would make the rule hard to apply to this agreement.

Do not list matters of drafting style. Do not list rules that are clear and met.

Return only a JSON object: {"points": [{"ruleId": "NDA-04", "type": "ambiguous | inconsistent | not-met | other", "paragraphs": ["p15"], "explanation": "…", "suggestion": "…"}]}. Return {"points": []} if there is nothing to raise.
