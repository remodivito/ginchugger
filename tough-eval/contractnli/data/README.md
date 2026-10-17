# ContractNLI (data)

Koreeda & Manning, "ContractNLI: A Dataset for Document-level Natural Language Inference for Contracts", Findings of EMNLP 2021. 607 real NDAs (375 web PDFs, 232 SEC filings), 17 fixed hypotheses, document-level labels (Entailment / Contradiction / NotMentioned) with evidence spans. Licence: CC BY 4.0 (LICENSE and TERMS in the archive, Hitachi America, Ltd.).

Downloaded 14 October 2026 from https://stanfordnlp.github.io/contract-nli/resources/contract-nli.zip
sha256 e03fc77bbf8b53e2976a250e81d8a294bc3d5e5fb014521e477dee9340d6287b (65,362,913 bytes).

Committed here: `contract-nli/{train,dev,test}.json`, LICENSE, TERMS, README.md (the labelled text, 10.6 MB). Not committed: the zip and `contract-nli/raw/` (the 607 source PDFs, HTML and text files, 70 MB), which the JSON `text` fields reproduce; re-download the zip to restore them.
