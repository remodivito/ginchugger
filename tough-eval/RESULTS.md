# GinBench results

Updated 19 October 2026. Work in progress: layer A is frozen (tag `bench-v2.0-a`), run once per setup; layers H, B and C are preliminary.

## Layer A: applying a playbook (frozen)

28 planted deviations and 47 harmless edits across 75 contracts (Common Paper CSA and NDA, four sides), plus 3 multi-change markups.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/readme/fully-right-by-cost-dark.png">
  <img src="../docs/readme/fully-right-by-cost-light.png" alt="Agreements fully right against cost per review; see the tables below">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/readme/caught-vs-false-alarms-dark.png">
  <img src="../docs/readme/caught-vs-false-alarms-light.png" alt="Planted deviations caught against false alarms per agreement; see the table below">
</picture>


| Setup | Deviations missed | Upper bound (95%) | Reviews with an invented quote | False alarms per agreement | Fixed (of caught) | All-pass (of 75) | Failed reviews |
|---|---|---|---|---|---|---|---|
| Opus 5.5, product prompt | 0 of 28 | 10.2% | 0 of 78 | 0.08 | 27 of 28 | 66 | 0 of 78 |
| DeepSeek V4 Flash, product prompt | 0 of 28 | 10.2% | 1 of 75 | 0.11 | 27 of 28 | 65 | 3 of 78 |
| Opus 5.5, plain prompt | 1 of 28 | 15.8% | 0 of 78 | 0 | 24 of 27 | 64 | 0 of 78 |
| GLM-5.3 Flash, product prompt | 4 of 28 | 29.8% | 0 of 75 | 0.04 | 21 of 24 | 61 | 3 of 78 |
| Mistral Small 4, product prompt | 20 of 28 | 84.9% | 13 of 78 | 2.96 | 4 of 8 | 17 | 0 of 78 |
| GLM-5.3 Flash, 131k output budget (declared variant, not frozen) | 2 of 28 | 20.8% | 1 of 78 | 0.12 | 23 of 26 | 57 | 0 of 78 |

### Cost and time (layer A)

Medians over the 78 reviews of each run. Open-model costs are estimates: tokens used × Munito's listed prices (USD per million tokens, from its models.dev entry, retrieved 19 October 2026; Munito publishes none of its own), not a bill. Opus costs are the API-equivalent figures Claude Code reports. Times include queueing at the host. Figures and prices: [`v2/charts/data.json`](v2/charts/data.json).

| Setup | Cost per review | Time per review | Output tokens per review |
|---|---|---|---|
| Opus 5.5, product prompt | $0.32 | 85 s | 10,352 |
| DeepSeek V4 Flash, product prompt | $0.011 (estimate) | 307 s | 36,727 |
| Opus 5.5, plain prompt | $0.155 | 19 s | 1,503 |
| GLM-5.3 Flash, product prompt | $0.025 (estimate) | 380 s | 46,159 |
| Mistral Small 4, product prompt | $0.005 (estimate) | 59 s | 5,636 |
| GLM-5.3 Flash, 131k output budget (declared variant) | $0.026 (estimate) | 397 s | 49,469 |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/readme/cost-and-time-dark.png">
  <img src="../docs/readme/cost-and-time-light.png" alt="Median cost and time per review; see the table above">
</picture>

### Does a model favour its own items? (layer A)

All-pass rate on the single items each family wrote (Opus 26, GLM 22, DeepSeek 27), and the own-item advantage measured against Opus as the reference, with its 95% interval. "Not detected" is not "absent": with these item counts only a gap of about 15 to 18 points could be detected.

| Setup | Opus items | GLM items | DeepSeek items | Own-item advantage |
|---|---|---|---|---|
| Opus 5.5, product prompt | 0.885 | 0.818 | 0.926 | not detected: −4 points [−26, +18] |
| DeepSeek V4 Flash, product prompt | 0.885 | 0.864 | 0.852 | not detected: −4 points [−25, +15] |
| GLM-5.3 Flash, product prompt | 0.808 | 0.909 | 0.741 | **detected: +20 points [+1.5, +37]**, on a reduced item set |
| Opus 5.5, plain prompt | 0.885 | 0.864 | 0.815 | not computed |
| Mistral Small 4, product prompt | 0.231 | 0.273 | 0.185 | wrote no items |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/readme/own-items-dark.png">
  <img src="../docs/readme/own-items-light.png" alt="Agreements fully right by which model family wrote the item; see the table above">
</picture>

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
