# GinBench results

Updated 18 October 2026. Work in progress: layer A is frozen (tag `bench-v2.0-a`), run once per setup; layers H, B and C are preliminary.

## Layer A: applying a playbook (frozen)

28 planted deviations and 47 harmless edits across 75 contracts (Common Paper CSA and NDA, four sides), plus 3 multi-change markups.

| Setup | Deviations missed | Upper bound (95%) | Reviews with an invented quote | False alarms per agreement | Fixed (of caught) | All-pass (of 75) | Failed reviews |
|---|---|---|---|---|---|---|---|
| Opus 5.5, product prompt | 0 of 28 | 10.2% | 0 of 78 | 0.08 | 27 of 28 | 66 | 0 of 78 |
| DeepSeek V4 Flash, product prompt | 0 of 28 | 10.2% | 1 of 75 | 0.11 | 27 of 28 | 65 | 3 of 78 |
| Opus 5.5, plain prompt | 1 of 28 | 15.8% | 0 of 78 | 0 | 24 of 27 | 64 | 0 of 78 |
| GLM-5.3 Flash, product prompt | 4 of 28 | 29.8% | 0 of 75 | 0.04 | 21 of 24 | 61 | 3 of 78 |
| Mistral Small 4, product prompt | 20 of 28 | | 13 of 78 | 2.96 | 4 of 8 | 17 | 0 of 78 |
| GLM-5.3 Flash, 131k output budget (declared variant, not frozen) | 2 of 28 | 20.8% | 1 of 78 | 0.12 | 23 of 26 | 57 | 0 of 78 |

## Layer H: history from a document store (preliminary, Opus 5.5 only)

| Measure | Result |
|---|---|
| Deviations missed | 0 of 25 |
| Precedent cited where needed | 8 of 8 |
| Bait concessions followed | 0 of 9 |
| Citations to the wrong counterparty | 0 of 25 |
| Planted instructions followed | 0 of 4 |

## Layer B: real NDAs (preliminary)

ContractNLI test split, 123 NDAs, 154 labelled departures. About a quarter of the labels don't fit the playbook, for every model.

| Setup | Departures missed | NDAs with an invented quote | All-pass (of 123) |
|---|---|---|---|
| Opus 5.5, product prompt | 23 | 0 | 64 |
| Qwen 3.8 27B | 23 | 16 | 48 |
| GLM-5.3 Flash | 31 | 8 | 52 |
| Opus 5.5, plain prompt | 36 | 0 | 72 |
| DeepSeek V4 Flash | 36 | 7 | 52 |
| Mistral Small 4 | 104 | 43 | 20 |

Layer C (attorney fixes) is not used for comparison: an empty answer scores 10 of 22.

## Notes

- Upper bound: with 28 items, 0 missed means fewer than about 1 in 9 at 95% confidence.
- Deviations were written by three model families (Opus, GLM, DeepSeek), each checked by the other two. No lawyer has validated the playbooks or labels.
- Open models ran through an EU-hosted endpoint.
- Details: [`v2/RESULTS-2026-10-17.md`](v2/RESULTS-2026-10-17.md), [`v2/frozen/REPORT.md`](v2/frozen/REPORT.md), [`v2/prelim/REPORT.md`](v2/prelim/REPORT.md).
