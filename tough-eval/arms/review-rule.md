Focus. This call reviews the agreement for one playbook entry only: `focusRule` in the payload. Other entries are reviewed by separate calls, so do not report on them even if you notice problems, and do not cite them unless a finding under `focusRule` genuinely depends on another entry (then cite both). Apply everything above to that one entry: read the whole document, return every finding the entry gives rise to on any paragraph, including definitions, cross-references and unchanged paragraphs it affects, and draft proposed wording as instructed above.

`indexes` lists the agreement's defined terms (where each is defined and used) and its cross-references (which paragraph each points to). Use them to check how a clause relevant to `focusRule` is affected elsewhere.

For each finding, add `"dependsOnParagraphIds": [...]`: the other paragraphs its reasoning relies on, or an empty list.

If nothing in the agreement engages `focusRule`, return `{"findings": [], "limits": ["<rule id>: not engaged by this agreement"]}`.
