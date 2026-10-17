# Demonstration data and evaluation

The bundled cases are development fixtures, not lawyer-validated decisions or a held-out legal benchmark. They do not represent any organisation's policies, negotiations, clients, or technology. The playbook is a small set of explicit prototype assumptions. No fixture establishes authorization to sign, send, or accept an agreement.

## Public source and modifications

`data/source-common-paper-nda-v1.json` preserves the complete eleven sections of [Common Paper Mutual NDA Standard Terms v1.0](https://commonpaper.com/standards/mutual-nda/1.0/), retrieved 29 September 2026. HTML formatting is normalized to paragraph text; section headings and stable paragraph identifiers are retained. The snapshot includes a SHA-256 digest of its normalized paragraph array (Python JSON encoding, sorted keys, UTF-8 with non-ASCII characters preserved).

Common Paper releases its [standard agreements](https://commonpaper.com/standards/) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribution: Adapted from Common Paper Mutual NDA Standard Terms v1.0, CC BY 4.0. Demonstration cover fields and marked amendments added. No publisher endorsement is implied.

NDA cases contain all standard terms plus an unsigned demonstration cover identifying both parties by neutral roles, the purpose, confidentiality duration, effective date, governing law, jurisdiction, notice addresses, and the one-year agreement term. General confidentiality survival is a separate three-year provision. Cover fields, controlled amendments and additional provisions are our constructions. This is a complete text-based public-NDA fixture; it is not an executed document, nor a native Word tracked-changes fixture. `originalText` and a separate baseline represent revisions explicitly.

The commercial cases are original compact test extracts. They are prominently labelled as incomplete agreements, not presented as Common Paper commercial terms or representative legal advice. Their purpose is to isolate cap/indemnity interaction and a missing controlling schedule.

## Cases

| Case | Intended check |
|---|---|
| nda-clean | Quiet control: public NDA terms plus supplied provisional cover; protected retention is permitted. |
| nda-duration | General confidentiality changes from three to seven years, beyond the stated ceiling. |
| nda-harmless | Evaluating/assessing paraphrase should not generate an alert. |
| nda-residual | Additional residual-memory use overrides the purpose restriction; cite both passages. |
| nda-retention-protected | Retention permission and continuing protection appear in separate paragraphs. |
| nda-retention-unprotected | Same retention permission, but the separate protection condition is reversed. |
| nda-later-round | Seven years becomes five; current wording is within the ceiling without inventing approval. |
| nda-no-baseline | Seven-year current wording is assessable; change/history is unknown. |
| commercial-cap | A headline cap is defeated by uncapped indemnities and expanded indemnity scope. |
| commercial-missing-schedule | A missing controlling schedule prevents claiming the visible payment default is effective. |

Each case names the playbook it belongs to (`playbook`: `nda` for the eight NDA cases, `order-form` for the two commercial extracts, since 5 October 2026); the v1 rule engine's check (`../../tough-eval/baselines/evaluate-cases.mjs`) reviews each case against that playbook. The two shipped playbooks are `data/playbook.json` (NDAs) and `data/playbooks/order-form.json`; both are illustrative demonstration assumptions, not any organisation's policy. The order-form negotiation used by the demo is in `data/fixtures/order-form/` (original text, fictional parties; see its README).

The evaluator-only labels moved out of this file on 15 October 2026 to `../../tough-eval/baselines/cases-v1-labels.json`. Pass only `document`, `baseline` and `playbook` to the review engine. Never send expected findings, mutation descriptions, case titles or evaluator instructions to a model as review evidence. The API must strip expected labels from client-facing case data as well.

## What results mean

The evaluator measures attention-item precision/recall, expected status, required evidence coverage, citation grounding, and unsupported approval language separately. Evidence quotes must actually appear in the cited current paragraph. Good evidence also needs the right surrounding provisions, so matching a quote alone is insufficient. Clean controls penalize noisy findings; missing-context cases penalize confident conclusions.

All eight NDA cases share one source family. Do not count them as eight independent agreements or randomly divide mutations of this NDA between training and test. The two commercial examples are also constructed. Results establish only behavior on these documented examples. They do not measure real lawyer time saved, legal correctness in deployment, historical recall, Word fidelity, or resistance to arbitrary unseen wording. A deterministic demonstration engine passing fixtures is a software regression result, not an AI accuracy claim.

Before claiming broader quality, add independently sourced untouched documents, policy variants, ambiguous cases and qualified review of reference labels. Test native document parsing separately from semantic assessment. Public datasets such as ContractNLI offer external interpretation labels, but those are not company-policy decisions.

## Starter history fixture

`data/fixtures/history/` holds one constructed negotiation in three rounds (form, counterparty markup, our counter-turn), a counterparty comment email, two cover emails and one unrelated NDA on the same form, with `truth.json` recording which documents belong together, their order, which earlier version each answers and which emails go with them (written before decision 190; the app keeps no matters now, and the store is flat). Built deterministically by `scripts/build-history-fixture.mjs` from the Common Paper source above; see its README for provenance and the trap it contains. It is development and demonstration data for the store and for "what did we accept last time" questions, not evidence about real document collections.
