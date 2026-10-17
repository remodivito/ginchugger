# Eval v2: preliminary results

17 October 2026. Preliminary: there is no frozen test run yet (no `bench-v2.0` tag), so these numbers will be superseded by the frozen run. Every figure comes from `prelim/REPORT.md` (generated 17 October) and the two error analyses in `analysis/`. No lawyer has checked the error readings. Gemini 3.8 Flash is left out: it reached its Antigravity quota after 21 of 123 NDAs.

## The question

For routine commercial paper reviewed against a team's stated positions, how often does each model miss a departure, raise a false alarm or invent something? This is the case of a small in-house legal team: familiar paper and a known playbook, with repetitive, low-stakes work.

## What was run

| Layer | What it tests | Items | Scored by |
|---|---|---|---|
| A. Planted deviations | Applying our playbook to our kind of paper: Common Paper CSA and NDA, four sides, deviations written by Opus, GLM and DeepSeek, each cross-checked by the other two | 75 verified single items (28 deviations, 47 benign edits) and 3 markups | code |
| B. Real NDAs | Unfamiliar third-party paper: ContractNLI test split, labelled by the dataset's annotators against 17 statements, mapped to our playbook | 123 NDAs, 154 labelled departures | code |
| H. History | The agent using past deals from the document store without being misled: precedent, bait concessions, wrong counterparty, injected instructions | 25 scenarios (Opus only) | code |
| C. Attorney fixes | Whether proposed changes match an attorney's, adapted from RedlineBench | 3 documents, 22 criteria | two LLM judges |

## Headline: layer A, applying the playbook

| Setup | Deviations missed (of 28) | Upper bound (95%) | Reviews with an invented quote | False alarms per agreement | Fixes (of caught) | All-pass |
|---|---|---|---|---|---|---|
| **Opus 5.5, product prompt** | **0** | 10.2% | **0 / 78** | 1.04 | 23 / 28 | 33 / 75 |
| Opus 5.5, plain prompt | 1 | 15.8% | 0 / 78 | 0.21 | 19 / 27 | 50 / 75 |
| DeepSeek V4 Flash | 2 | 20.8% | 2 / 78 | 0.85 | 21 / 26 | 39 / 75 |
| GLM-5.3 Flash | 4 | 29.8% | 2 / 74 | 0.34 | 17 / 24 | 41 / 75 |
| Mistral Small 4 | 24 | 95.0% | 15 / 78 | 2.35 | 1 / 4 | 19 / 75 |

Opus with the product prompt missed nothing and invented nothing. Its cost is extra flags, about one per agreement. The error analysis found **almost all of them defensible**: they point at real issues in our own test materials, and only 2 (on benign edits) were genuinely wrong.
- **62** sit on five clauses of our own clean CSA that literally trip a playbook tier. Clean-copy calibration (P8), skipped in this run, exists to catch these.
- **19** follow from the plant itself. The Cover Page still says "Changes to Standard Terms: None" after a planted change.

The plain prompt's one miss is a bug in the plain prompt: it says "for the Customer". On a vendor-side item, Opus declined to review.

## Robustness: layer B, real third-party NDAs

| Setup | Departures missed (of 154) | Upper bound | NDAs with an invented quote | False alarms per NDA | All-pass |
|---|---|---|---|---|---|
| **Opus 5.5, product prompt** | 23 (14.9%) | 19.5% | **0 / 123** | 0.46 | 64 / 123 |
| Qwen 3.8 27B | 23 (14.9%) | 19.9% | 16 / 123 | 0.60 | 48 / 123 |
| GLM-5.3 Flash | 31 (20.1%) | 25.8% | 8 / 121 | 0.51 | 52 / 123 |
| Opus 5.5, plain prompt | 36 (23.4%) | 28.4% | 0 / 123 | 0.21 | 72 / 123 |
| DeepSeek V4 Flash | 36 (23.4%) | 28.7% | 7 / 123 | 0.38 | 52 / 123 |
| Mistral Small 4 | 104 (67.5%) | 73.9% | 43 / 123 | 0.28 | 20 / 123 |

**The labels are a problem for every setup, not only Opus.** On a Claude model's reading, 34 of the 154 labelled departures (22%) are not departures under our playbook, and 47 (31%) if borderline cases count. Most fall on three rules: NDA-01 (16 of 24), NDA-17 and NDA-02. All 23 of Opus's misses fall in that set, but so do some of every setup's misses and some of every setup's catches. Applied to every setup the same way:

| Setup | Raw (154) | Disputed labels removed (120) | Borderline also removed (107) |
|---|---|---|---|
| Opus 5.5, product prompt | 23 | 0 | 0 |
| Qwen 3.8 27B | 23 | 4 | 0 |
| Opus 5.5, plain prompt | 36 | 7 | 0 |
| GLM-5.3 Flash | 31 | 8 | 5 |
| DeepSeek V4 Flash | 36 | 8 | 2 |
| Mistral Small 4 | 104 | 77 | 69 |

The clean columns rest on readings made by a Claude model, the same family as the reference model. A blind re-check by a second Claude model agreed on 17 of 17 sampled misses, but it isn't independent of the family. The raw column is the score.

**What layer B can and can't say:**
- **The undisputed departures don't separate the top setups.** Opus with either prompt and Qwen reach zero or near-zero misses on them, so most of the raw differences between those three come from the disputed pairs.
- **It covers five topics, not 17.** 86% of departures fall on five rules (NDA-20, 18, 07, 17, 01). Six rules have no departures in the test split, and two of the five (NDA-18, NDA-04) are caught by nearly every setup.
- **Precision is barely measured.** False alarms count only on the six rules where silence is acceptable, which carry one departure between them. 70% of Opus's flags sit on rules where nothing is scored, so a reviewer that flagged everything would miss nothing. Counting only each finding's first-listed rule, Opus's catches fall from 131 to 125 but Qwen's from 131 to 95, so their tie depends on multi-rule tags.
- **Single runs are noisier than the intervals show.** Three near-identical contract pairs sit inside the test split. Opus gives different verdicts on 6 of their 51 rule pairs, and catches a problem in one copy of the same contract while missing it in the other.
- **Opus's false alarms on B (57)** mostly come from one tagging habit: it files the retention point (NDA-20) under the return-and-destroy rule (NDA-16) as well, and that accounts for 36 of them.

**Why all-pass is higher on the plain prompt.** All-pass needs every departure caught and nothing else flagged. The plain prompt flags less than half as often, so clean NDAs pass more easily, but it misses more real departures. For a lawyer, a missed departure costs more than a false alarm, which is why the miss rate leads.

## History: layer H (Opus, agentic, on the document store)

| Measure | Result |
|---|---|
| Deviations missed | 0 / 25 |
| Citations that could not be verified | 0 |
| Precedent cited where needed | 8 / 8 |
| Bait concessions followed | 0 / 9 |
| Citations attributed to the wrong counterparty | 0 / 25 |
| Injected instructions followed | 0 / 4 |
| Tool calls | 141 (102 read, 23 overview, 16 search) |
| All-pass | 6 / 25 |

All-pass is low for benchmark reasons. 16 failures are false alarms from the same clean-CSA clauses and the Cover Page point. 6 are fixes that proposed the playbook's acceptable wording where the item only accepts deletion. Without those causes, 22 of 25 pass.

**Caveat:** two concession scenarios made no store calls, so they never tested resistance to a precedent.

## Fix quality: layer C (indicative only)

The 22 criteria are of two kinds: 12 ask for a change, and 10 ask for one of the counterparty's changes to be left alone. An empty output passes all 10 of the second kind, which is why it scores 10.

| Setup | Changes made (of 12) | Counterparty changes wrongly undone (of 10) | Total as reported (of 22) |
|---|---|---|---|
| Opus 5.5, product prompt | 5 | 2 | 13 (14 with the rendering bug corrected) |
| Opus 5.5, plain prompt | 5 | 2 | 13 |
| DeepSeek V4 Flash | 4 | 2 | 12 |
| GLM-5.3 Flash | — | — | 5 (2 of 3 reviews failed and count as 0) |
| Empty output (control) | 0 | 0 | 10 |

**This layer can't rank anything, and is left out of the comparison.**
- **Only two criteria separate the setups.** One was decided by a single judge that passed and failed the identical proposal in two runs. The other was met by an Opus fix that a bug in our rendering hid from the judges.
- **One of the three tasks is acceptance only:** the attorney's ideal answer renders the same as an empty output.
- **The panel differs per contestant.** The judges are drawn from the contestants themselves, so each setup was marked by a different, partly lenient panel. One tie was broken by a model that never passed the validity check.
- **It isn't RedlineBench's method,** and its scores can't be compared with RedlineBench's. The differences that matter:
  - no validity gate: in RedlineBench an empty output scores 0;
  - text renderings instead of .docx redlines;
  - 22 criteria chosen by us;
  - contestant judges instead of three judges from outside the tested families.

## The open models, in short

- **DeepSeek V4 Flash is closest to Opus on applying the playbook** (layer A): 2 misses against 0, a similar fix rate, fewer false alarms. Its "invented quotes" are citation slips such as wrong paragraph ids, not invented text. It is slow.
- **Qwen 3.8 27B matches Opus's recall on real NDAs,** but cites paragraphs one place late (13 times) and cannot run long documents.
- **GLM-5.3 Flash reviews as well as the others when it finishes.** On long documents it spends most of its 64,000-token output limit on reasoning and the answer is cut off. That causes all of its failures and its layer C score.
- **Mistral Small 4 is not usable.** It misses most departures, and every sampled false alarm was wrong.
- **None of the four made up contract text.** Their invented quotes are paraphrases, punctuation and id slips, and Mistral's invented rule ids.

## What this means for GinChugger

1. **For the in-house team case, applying our playbook to familiar paper, Opus 5.5 with the product prompt did well on what it was asked.** It missed no planted deviations and invented nothing on any layer. On history it cited past deals correctly and resisted every manipulation tested. On real NDAs it ties for the lowest raw miss rate, but layer B can't separate it from Qwen or from its own plain prompt once the disputed labels are set aside.
2. **Its weakness is noise, not misses.** Most extra flags come from our own clean documents and one tagging habit, which can be fixed in the documents and the prompt.
3. **DeepSeek V4 Flash is the strongest open alternative** for a team that cannot send documents to Anthropic, with more misses and slips.

## Deviations from the benchmark plan (why this is preliminary)

- No freeze or tag; every run is `test: false`.
- Clean-copy calibration (P8) not run. This is the main source of Opus's layer A and H false alarms.
- No prompt choice per open model (P13): every open model used the product prompt.
- Not run: Sonnet 5.5, a second Opus run, Qwen on layer A (long documents fail), layer H for the open models.
- Gemini 3.8 Flash ran through the Antigravity CLI, with the system prompt in the user turn. It stopped at 21 of 123 NDAs on quota and is excluded.

## To fix before the frozen run

- **Benchmark materials:** the clean CSA clauses at a26, a63, p19, p95 and p80 (run P8), and the Cover Page as a second target for plants that change the Standard Terms.
- **Layer B's test split is spent.** These runs used its single look, and the fixes below come from reading their outputs. A frozen run on the same 123 NDAs would be tuned to Opus's misses. Fix the mappings from development-split evidence only, and run the frozen layer B on a fresh sample from the untouched pool, removing its 13 near-duplicates of test documents first.
- **Layer B's mappings and labels:** NDA-01, NDA-18, NDA-17 and the NDA-16/NDA-20 overlap. Have the roughly 47 disputed pairs judged blind by models outside the Claude family. Report flags per NDA and unscored flags beside the false alarms, and add a first-listed-rule sensitivity check.
- **Layer C:** keep it out of comparisons until it has a validity gate, judges from outside the tested families with repeated judging, the rendering bug fixed, and more documents.
- **Same-family judgement:** the playbook, mapping, label audit and error readings were all made with Claude. The frozen run needs at least one non-Claude reading of the disputed cases.
- **Prompt and scorer bugs:**
  - the plain prompt is hard-coded to the Customer side;
  - inserted plants accept only deletion;
  - quote checking does not normalise apostrophes;
  - layer C hides proposals made in within-guidance findings;
  - layer C's table has no failures column.
- **Playbook:** NDA-01's acceptable tier overlaps its escalation tier.

Sources: `prelim/REPORT.md`, `analysis/opus-errors-2026-10-17.md`, `analysis/open-models-errors-2026-10-17.md`.
