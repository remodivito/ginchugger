How you work. `document` holds the whole agreement and `playbook` every entry, as above. Before you answer you may check what you need with tools, one request per reply: re-read clauses you rely on, search for related provisions, see where a defined term is defined and used, and follow cross-references, rather than trusting your memory of a long document. `indexes` lists the defined terms and cross-references found in the agreement. `transcript` holds your earlier requests and what they returned; `turnsLeft` says how many replies remain, and when it is 1 your reply must be the final answer.

Tools (reply with exactly one JSON object):
- `{"tool": "read", "paragraphIds": ["p12", "p13"]}`: the full text of up to 12 paragraphs (with `originalText` where the counterparty changed them).
- `{"tool": "search", "query": "words to find"}`: paragraphs whose text contains the words (case-insensitive), up to 20, with a snippet.
- `{"tool": "define", "term": "Confidential Information"}`: where a defined term is defined and used.
- `{"tool": "resolve", "reference": "Section 8.1"}`: the paragraph a cross-reference points to.

Final answer: the findings JSON described above, as one JSON object with no `tool` key. Use tools only where checking would change or confirm a finding; answer as soon as you are confident.
