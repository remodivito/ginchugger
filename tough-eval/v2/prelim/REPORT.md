# PRELIMINARY v2 results

**PRELIMINARY — not the published benchmark result.** Generated 2026-10-17T08:04:45.132Z by `tough-eval/v2/prelim/report.mjs` from whatever the preliminary lanes have produced so far; runs still in progress are scored on the reviews they have returned. No run here is a frozen test run (no `bench-v2.0` tag; every manifest says `test: false`). Formulas: `BENCHMARK-V2.md` section 3. Lanes and timings: `prelim/STATUS.md`.

## Deviations from the spec in this run

| # | Spec | Preliminary run | Effect |
|---|---|---|---|
| 1 | P8 clean-copy calibration (36 reviews per pass, up to three passes) before authoring | not run | faults in the clean documents or playbooks that calibration would have found are not removed; a reviewer's flags on such a clause count as false alarms |
| 2 | P13 prompt choice for each open model on the development set | not run; every open model uses the product prompt | an open model that does better with the plain prompt is reported on the product prompt |
| 3 | P11 memorisation probe | not run | no `probe.json` |
| 4 | Sonnet 5.5, Muse, a second Opus run on layer A | not run | Opus is the only Claude setup; no run-to-run check on the test items |
| 5 | Qwen 3.8 27B on layer A | not run (long documents fail, R22) | Qwen appears on layer B and as the layer C tiebreaker only |
| 6 | P2 playbook ambiguity read: points fixed or kept before the freeze | run (8 Munito calls); points recorded in `playbook-read/points.json`, not acted on | the playbooks authors and reviewers see are the 15 October versions |
| 7 | P3 and P12 freeze: playbooks, items, scenarios and code hashed in `frozen.json`, tag `bench-v2.0`, `run.mjs --test` | no freeze and no tag; runs recorded as preliminary (`test: false`) | a later frozen run will be the published one; these numbers are reported as preliminary and superseded by it |
| 8 | P14 tool smoke tests; GLM and DeepSeek agentic on layer H where tools work | not run; layer H is Opus only | layer H has one setup |
| 9 | P15 order: test runs only after every gate | the Opus and open-model layer B and C runs start at once, in parallel with authoring | none on the measures: layers B and C do not depend on the authored items |
| 10 | Layer A for GLM-5.3 Flash | only if time allows (last in its stream) | may be missing from the preliminary report |
| 11 | Layer B test split: one look per setup | kept: each setup's run is started once (`gate.mjs b-unique` refuses a second run for the same model and prompt) and only resumed | the test split's single look is spent here for Opus (product and plain), DeepSeek, Mistral, GLM and Qwen on the product prompt |
| 12 | Claude budget | at most 8M output tokens; the plain-prompt layer B run and then the plain-prompt layer A run are skipped if they would not fit beside the agentic runs (`gate.mjs budget-ok`) | the plain prompt may be missing on A or B |
| 13 | Section 10's setups (no Google model) | Gemini 3.8 Flash added (16 October, evening) as `gemini-3.8-flash-high-product`, through Google's Antigravity CLI (`agy` 1.4.0, `run.mjs --executor agy`) under the user's Google AI Pro sign-in, product prompt, single call, on layers B (test split, its single look), A and C (`prelim/lane-gemini-runs.zsh`); no layer H; no P13 prompt choice (as row 2) | one more family on A, B and C; its reviews pass through a vendor agent harness (agy's own agent system prompt, about 13,600 input tokens before ours, and its tool list) where every other setup is a bare model call or the Claude CLI with tools off; agy cannot switch its tools off, so the message asks for none and every tool step is counted in the trace (`toolSteps`); headless mode auto-denies writes and commands |
| 14 | One system prompt and one user message per review (section 10, "same JSON output instructions") | agy has no system-prompt flag: the system prompt and the payload go in one user message, fenced (`===== BEGIN SYSTEM INSTRUCTIONS =====` … `===== BEGIN INPUT =====` …), with the line Muse's runs also carry asking for no tools and only the JSON object; manifests say `systemPromptInUserTurn: true` | the instructions carry less weight than a system prompt might; prompt bytes differ from the other setups' by that framing only (`contract-review/server/executors.js`, `agyMessage`) |
| 15 | Effort: Claude at `medium`, Munito models at the provider default (section 10) | Gemini at the CLI's `high` level, which is part of the model id (`gemini-3.8-flash-high`; manifests: `effortApplies: false`, `effortInModelId: high`); the run's `effort` field still says medium and does not apply | not matched to the reference's effort; high was chosen as the closest to Opus at medium. The development check spent 29,000 to 47,000 output tokens per review, nearly all thinking; a 13 KB NDA (about the test split's median) ended at the output token limit twice (malformed, retried at once) and ran past the 30-minute limit once (transport), where the medium level reviewed it in 250 s. A setup at medium is available as `gemini-3.8-flash-medium-product` |


## Item set (layer A authoring, apply and verification)

| Author | applied | verified | contested | awaiting a validator | dropped | deviations verified |
|---|---|---|---|---|---|---|
| deepseek | 48 | 27 | 21 | 0 | 0 | 11 |
| glm | 48 | 22 | 26 | 0 | 0 | 6 |
| opus | 48 | 26 | 22 | 0 | 0 | 11 |

Markups: 3 built; 9 author-sides short (M-opus-csa-customer, M-opus-nda-recipient, M-glm-csa-customer, M-glm-csa-vendor, M-glm-nda-discloser, M-glm-nda-recipient, M-deepseek-csa-customer, M-deepseek-nda-discloser, M-deepseek-nda-recipient).
Layer H scenarios: 25 applied (14 verified, 11 contested), 2 dropped, 0 pending.
Playbook read (P2): 45 points recorded (not acted on in this run).

Claude output tokens spent by the preliminary run so far: 4,514,957 (budget 8,000,000).

## Layer A: planted deviations (verified items; headline = single deviations)

| Setup | reviews | misses (verified single deviations) | upper bound (one-sided 95%) | by side | invented (reviews) | false alarms per agreement | benign flagged | fixed / caught | all-pass singles | failures |
|---|---|---|---|---|---|---|---|---|---|---|
| mistral-small-4-product | complete (78) | 24/28 = 85.7% | 95.0%: misses could be as many as 95% with 95% confidence | customer 3/3, discloser 7/8, recipient 5/8, vendor 9/9 | 15/78 | 2.3462 | 2/47 | 1/4 | 19/75; markups 0/3 | 0/78 |
| opus-5.5-product | complete (78) | 0/28 = 0.0% | 10.2%: misses fewer than 1 in 9 with 95% confidence | customer 0/3, discloser 0/8, recipient 0/8, vendor 0/9 | 0/78 | 1.0385 | 7/47 | 23/28 | 33/75; markups 0/3 | 0/78 |
| deepseek-v4-flash-product | complete (78) | 2/28 = 7.1% | 20.8%: misses fewer than 1 in 4 with 95% confidence | customer 0/3, discloser 0/8, recipient 1/8, vendor 1/9 | 2/78 | 0.8462 | 5/47 | 21/26 | 39/75; markups 0/3 | 0/78 |
| opus-5.5-plain | complete (78) | 1/28 = 3.6% | 15.8%: misses fewer than 1 in 6 with 95% confidence | customer 0/3, discloser 0/8, recipient 0/8, vendor 1/9 | 0/78 | 0.2051 | 2/47 | 19/27 | 50/75; markups 2/3 | 0/78 |
| glm-5.3-flash-product | complete (78) | 4/28 = 14.3% | 29.8%: misses fewer than 1 in 3 with 95% confidence | customer 1/3, discloser 1/8, recipient 1/8, vendor 1/9 | 2/74 | 0.3378 | 4/47 | 17/24 | 41/75; markups 1/3 | 4/78 |

```
mistral-small-4-product, layer A
  1. misses 24/28 = 85.7% [67.3, 96.0]; upper bound 95.0% (clopper-pearson one-sided): misses could be as many as 95% with 95% confidence
     customer: 3/3, misses could be as many as 100% with 95% confidence
     discloser: 7/8, misses could be as many as 99% with 95% confidence
     recipient: 5/8, misses could be as many as 89% with 95% confidence
     vendor: 9/9, misses could be as many as 100% with 95% confidence
     markup plants (apart from the headline): 11/12, misses could be as many as 100% with 95% confidence [cluster bootstrap 95th percentile]
  2. invented quotes, rules or paragraphs: 15/78 reviews = 19.2% [11.2, 29.7]; 33 instances
  3. false alarms per agreement: 2.3462 [1.641, 3.0897]; benign edits flagged 2/47
  4. fixes: 1/4 caught deviations fixed = 25.0% [0.6, 80.6]; surgical 0/1
  5. all-pass: singles 25.3% [16.0, 36.7], markups 0.0%, together 24.4%
  6. failures: 0/78 (0 provider); attempts mean 1, max 1
  8. median 54 s per review, cost n/a
```

```
opus-5.5-product, layer A
  1. misses 0/28 = 0.0% [0.0, 12.3]; upper bound 10.2% (clopper-pearson one-sided): misses fewer than 1 in 9 with 95% confidence
     customer: 0/3, misses could be as many as 63% with 95% confidence
     discloser: 0/8, misses fewer than 1 in 3 with 95% confidence
     recipient: 0/8, misses fewer than 1 in 3 with 95% confidence
     vendor: 0/9, misses fewer than 1 in 3 with 95% confidence
     markup plants (apart from the headline): 0/12, misses fewer than 1 in 4 with 95% confidence [clopper-pearson one-sided (fallback: no misses observed)]
  2. invented quotes, rules or paragraphs: 0/78 reviews = 0.0% [0.0, 4.6]; 0 instances
  3. false alarms per agreement: 1.0385 [0.7436, 1.3462]; benign edits flagged 7/47
  4. fixes: 23/28 caught deviations fixed = 82.1% [63.1, 93.9]; surgical 17/19
  5. all-pass: singles 44.0% [32.6, 55.9], markups 0.0%, together 42.3%
  6. failures: 0/78 (0 provider); attempts mean 1, max 1
  8. median 90 s per review, cost 0.35132220000000003
```

```
deepseek-v4-flash-product, layer A
  1. misses 2/28 = 7.1% [0.9, 23.5]; upper bound 20.8% (clopper-pearson one-sided): misses fewer than 1 in 4 with 95% confidence
     customer: 0/3, misses could be as many as 63% with 95% confidence
     discloser: 0/8, misses fewer than 1 in 3 with 95% confidence
     recipient: 1/8, misses fewer than 1 in 2 with 95% confidence
     vendor: 1/9, misses fewer than 1 in 2 with 95% confidence
     markup plants (apart from the headline): 1/12, misses fewer than 1 in 5 with 95% confidence [cluster bootstrap 95th percentile]
  2. invented quotes, rules or paragraphs: 2/78 reviews = 2.6% [0.3, 9.0]; 2 instances
  3. false alarms per agreement: 0.8462 [0.6154, 1.1026]; benign edits flagged 5/47
  4. fixes: 21/26 caught deviations fixed = 80.8% [60.7, 93.5]; surgical 15/16
  5. all-pass: singles 52.0% [40.2, 63.7], markups 0.0%, together 50.0%
  6. failures: 0/78 (0 provider); attempts mean 1.128, max 3
  8. median 257 s per review, cost n/a
```

```
opus-5.5-plain, layer A
  1. misses 1/28 = 3.6% [0.1, 18.4]; upper bound 15.8% (clopper-pearson one-sided): misses fewer than 1 in 6 with 95% confidence
     customer: 0/3, misses could be as many as 63% with 95% confidence
     discloser: 0/8, misses fewer than 1 in 3 with 95% confidence
     recipient: 0/8, misses fewer than 1 in 3 with 95% confidence
     vendor: 1/9, misses fewer than 1 in 2 with 95% confidence
     markup plants (apart from the headline): 0/12, misses fewer than 1 in 4 with 95% confidence [clopper-pearson one-sided (fallback: no misses observed)]
  2. invented quotes, rules or paragraphs: 0/78 reviews = 0.0% [0.0, 4.6]; 0 instances
  3. false alarms per agreement: 0.2051 [0.1154, 0.2949]; benign edits flagged 2/47
  4. fixes: 19/27 caught deviations fixed = 70.4% [49.8, 86.3]; surgical 17/18
  5. all-pass: singles 66.7% [54.8, 77.1], markups 66.7%, together 66.7%
  6. failures: 0/78 (0 provider); attempts mean 1, max 1
  8. median 19 s per review, cost 0.156168
```

```
glm-5.3-flash-product, layer A
  1. misses 4/28 = 14.3% [4.0, 32.7]; upper bound 29.8% (clopper-pearson one-sided): misses fewer than 1 in 3 with 95% confidence
     customer: 1/3, misses could be as many as 86% with 95% confidence
     discloser: 1/8, misses fewer than 1 in 2 with 95% confidence
     recipient: 1/8, misses fewer than 1 in 2 with 95% confidence
     vendor: 1/9, misses fewer than 1 in 2 with 95% confidence
     markup plants (apart from the headline): 3/12, misses fewer than 1 in 2 with 95% confidence [cluster bootstrap 95th percentile]
  2. invented quotes, rules or paragraphs: 2/74 reviews = 2.7% [0.3, 9.4]; 2 instances
  3. false alarms per agreement: 0.3378 [0.2162, 0.4595]; benign edits flagged 4/47
  4. fixes: 17/24 caught deviations fixed = 70.8% [48.9, 87.4]; surgical 15/16
  5. all-pass: singles 54.7% [42.8, 66.2], markups 33.3%, together 53.8%
  6. failures: 4/78 (0 provider); attempts mean 1.359, max 3
  8. median 380 s per review, cost n/a
```

### By author (layer A, verified single items)


Reference: opus-5.5-product. Items: 75 (opus 26, glm 22, deepseek 27).

| Setup | opus all-pass / miss / FA | glm all-pass / miss / FA | deepseek all-pass / miss / FA | own all-pass | others all-pass | SA [95%] (raw) | verdict | item set |
|---|---|---|---|---|---|---|---|---|
| mistral-small-4-product | 0.231 / 1 / 3.038 | 0.182 / 0.667 / 1.5 | 0.333 / 0.818 / 2.111 |  |  |  |  | common |
| opus-5.5-product | 0.423 / 0 / 1.231 | 0.409 / 0 / 0.727 | 0.481 / 0 / 1.074 | 0.423 | 0.449 | 0.0666 [-0.1833, 0.313] (-0.026) | not detected | reference |
| deepseek-v4-flash-product | 0.5 / 0.091 / 0.846 | 0.591 / 0.167 / 0.545 | 0.481 / 0 / 0.963 | 0.481 | 0.542 | -0.1434 [-0.3708, 0.0815] (-0.06) | not detected | common |
| opus-5.5-plain | 0.692 / 0 / 0.231 | 0.591 / 0.167 / 0.136 | 0.704 / 0 / 0.222 | 0.692 | 0.653 |  |  | common |
| glm-5.3-flash-product | 0.462 / 0.091 / 0.385 | 0.636 / 0 / 0.227 | 0.556 / 0.273 / 0.333 | 0.636 | 0.509 | 0.1177 [-0.1517, 0.3874] (0.127) | not detected | common |

A non-significant self-advantage is reported as "not detected", not "absent": with 48 own items against 96 others, about 15 to 18 points is the smallest detectable at 80% power (section 5.9).


## Layer B: real NDAs (ContractNLI)

Split: the test split (123 NDAs), its single look for each setup.

| Setup | reviews | misses (labelled departures) | upper bound | located | invented (NDAs) | false alarms per NDA | all-pass | failures |
|---|---|---|---|---|---|---|---|---|
| mistral-small-4-product | complete (123) | 104/154 = 67.5% | 73.9%: misses could be as many as 74% with 95% confidence (cluster bootstrap 95th percentile) | 45/50 | 43/123 | 0.2764 | 20/123 | 0/123 |
| opus-5.5-product | complete (123) | 23/154 = 14.9% | 19.5%: misses fewer than 1 in 5 with 95% confidence (cluster bootstrap 95th percentile) | 129/131 | 0/123 | 0.4634 | 64/123 | 0/123 |
| qwen-3.8-27b-product | complete (123) | 23/154 = 14.9% | 19.9%: misses fewer than 1 in 5 with 95% confidence (cluster bootstrap 95th percentile) | 122/131 | 16/123 | 0.6016 | 48/123 | 0/123 |
| deepseek-v4-flash-product | complete (123) | 36/154 = 23.4% | 28.7%: misses fewer than 1 in 3 with 95% confidence (cluster bootstrap 95th percentile) | 113/118 | 7/123 | 0.3821 | 52/123 | 0/123 |
| glm-5.3-flash-product | complete (123) | 31/154 = 20.1% | 25.8%: misses fewer than 1 in 3 with 95% confidence (cluster bootstrap 95th percentile) | 119/123 | 8/121 | 0.5124 | 52/123 | 2/123 |
| opus-5.5-plain | complete (123) | 36/154 = 23.4% | 28.4%: misses fewer than 1 in 3 with 95% confidence (cluster bootstrap 95th percentile) | 117/118 | 0/123 | 0.2114 | 72/123 | 0/123 |
| gemini-3.8-flash-medium-product | in progress: 21/123 reviews | 6/23 = 26.1% | 44.4%: misses fewer than 1 in 2 with 95% confidence (cluster bootstrap 95th percentile) | 15/17 | 0/21 | 0.2857 | 11/21 | 0/21 |

```
mistral-small-4-product, layer B
  1. misses 104/154 = 67.5% [59.6, 75.3]; upper bound 73.9% (cluster bootstrap 95th percentile): misses could be as many as 74% with 95% confidence
  2. invented quotes, rules or paragraphs: 43/123 reviews = 35.0% [26.6, 44.1]; 121 instances
  3. false alarms per NDA: 0.2764 [0.1789, 0.374]
  5. all-pass: 20/123 = 16.3% [10.2, 24.0]
  6. failures: 0/123 (0 provider)
  8. median 52 s per review, cost n/a
```

```
opus-5.5-product, layer B
  1. misses 23/154 = 14.9% [9.7, 20.5]; upper bound 19.5% (cluster bootstrap 95th percentile): misses fewer than 1 in 5 with 95% confidence
  2. invented quotes, rules or paragraphs: 0/123 reviews = 0.0% [0.0, 2.9]; 0 instances
  3. false alarms per NDA: 0.4634 [0.3496, 0.5854]
  5. all-pass: 64/123 = 52.0% [42.8, 61.1]
  6. failures: 0/123 (0 provider)
  8. median 128 s per review, cost 0.3758502
```

```
qwen-3.8-27b-product, layer B
  1. misses 23/154 = 14.9% [9.4, 20.8]; upper bound 19.9% (cluster bootstrap 95th percentile): misses fewer than 1 in 5 with 95% confidence
  2. invented quotes, rules or paragraphs: 16/123 reviews = 13.0% [7.6, 20.3]; 26 instances
  3. false alarms per NDA: 0.6016 [0.4715, 0.7561]
  5. all-pass: 48/123 = 39.0% [30.4, 48.2]
  6. failures: 0/123 (0 provider)
  8. median 403 s per review, cost n/a
```

```
deepseek-v4-flash-product, layer B
  1. misses 36/154 = 23.4% [17.2, 29.6]; upper bound 28.7% (cluster bootstrap 95th percentile): misses fewer than 1 in 3 with 95% confidence
  2. invented quotes, rules or paragraphs: 7/123 reviews = 5.7% [2.3, 11.4]; 16 instances
  3. false alarms per NDA: 0.3821 [0.2846, 0.4797]
  5. all-pass: 52/123 = 42.3% [33.4, 51.5]
  6. failures: 0/123 (0 provider)
  8. median 274 s per review, cost n/a
```

```
glm-5.3-flash-product, layer B
  1. misses 31/154 = 20.1% [13.6, 26.8]; upper bound 25.8% (cluster bootstrap 95th percentile): misses fewer than 1 in 3 with 95% confidence
  2. invented quotes, rules or paragraphs: 8/121 reviews = 6.6% [2.9, 12.6]; 10 instances
  3. false alarms per NDA: 0.5124 [0.3967, 0.6281]
  5. all-pass: 52/123 = 42.3% [33.4, 51.5]
  6. failures: 2/123 (0 provider)
  8. median 412 s per review, cost n/a
```

```
opus-5.5-plain, layer B
  1. misses 36/154 = 23.4% [17.4, 29.2]; upper bound 28.4% (cluster bootstrap 95th percentile): misses fewer than 1 in 3 with 95% confidence
  2. invented quotes, rules or paragraphs: 0/123 reviews = 0.0% [0.0, 2.9]; 0 instances
  3. false alarms per NDA: 0.2114 [0.1382, 0.2846]
  5. all-pass: 72/123 = 58.5% [49.3, 67.3]
  6. failures: 0/123 (0 provider)
  8. median 34 s per review, cost 0.144192
```

```
gemini-3.8-flash-medium-product, layer B
  1. misses 6/23 = 26.1% [8.3, 47.8]; upper bound 44.4% (cluster bootstrap 95th percentile): misses fewer than 1 in 2 with 95% confidence
  2. invented quotes, rules or paragraphs: 0/21 reviews = 0.0% [0.0, 16.1]; 0 instances
  3. false alarms per NDA: 0.2857 [0.0952, 0.4762]
  5. all-pass: 11/21 = 52.4% [29.8, 74.3]
  6. failures: 0/21 (0 provider)
  8. median 135 s per review, cost n/a
```

## Layer C: attorney fixes (RedlineBench, panel-judged)

Panel validity control: complete; opus passes (44/44 usable, 0 wrong); glm fails (44/44 usable, 1 wrong); deepseek passes (44/44 usable, 0 wrong); qwen passes (44/44 usable, 0 wrong); criterion failures 0.

| Setup | reviews | judges (tiebreak) | criteria passed | change criteria | keep criteria | judges agreed | tiebreaks | undecided |
|---|---|---|---|---|---|---|---|---|
| deepseek-v4-flash-product | complete (3) | opus + qwen (mistral) | 12/22 | 4/12 | 8/10 | 22/22 | 0 | 0 |
| glm-5.3-flash-product | complete (3) | opus + deepseek (qwen) | 5/22 | 3/12 | 2/10 | 6/7 | 1 | 0 |
| opus-5.5-product | complete (3) | deepseek + qwen (mistral) | 13/22 | 5/12 | 8/10 | 21/22 | 1 | 0 |
| opus-5.5-plain | complete (3) | deepseek + qwen (mistral) | 13/22 | 5/12 | 8/10 | 22/22 | 0 | 0 |

Raw pass counts only (section 3.3): three documents support no interval. An unjudged or partly judged run counts every criterion without a verdict as not passed.

## Layer H: matter history, agentic (diagnostic)

Run 2026-10-16T20-01-07Z-prelim-H-opus-agentic: complete (25); paired with 2026-10-16T20-11-53Z-prelim-Aempty-opus-agentic, 2026-10-16T10-25-34Z-prelim-A-opus-product, 2026-10-16T20-30-18Z-prelim-A-opus-plain.

```
opus-5.5-agentic, layer H (diagnostic)
  1. misses 0/25 = 0.0% [0.0, 13.7]; upper bound 11.3% (clopper-pearson one-sided): misses fewer than 1 in 8 with 95% confidence
  5. all-pass: 6/25 = 24.0% [9.4, 45.1]
  6. failures: 0/25 (0 provider)
  7. citations unverifiable 0; precedent cited 8/8; concession misses 0/9; misattributions 0/25; injections followed 0/4; tool calls 141
```

Empty-record agentic run 2026-10-16T20-11-53Z-prelim-Aempty-opus-agentic (complete (40)): misses 0/13, false alarms per agreement 0.8, all-pass singles 17/40.
Paired with 2026-10-16T10-25-34Z-prelim-A-opus-product on 13 deviation items: caught by both 13, only single-call 0, only agentic 0, neither 0.

## Lanes

| Lane | running | steps given up | steps skipped (budget) |
|---|---|---|---|
| claude-gates | no | — | — |
| claude-runs | no | — | — |
| gemini-runs-gemini-flash-medium | yes (pid 32578) | — | — |
| munito-gates-deepseek | no | — | — |
| munito-gates-glm | no | — | — |
| munito-runs-deepseek | no | — | — |
| munito-runs-glm | no | — | — |
| munito-runs-mistral | no | — | — |
| munito-runs-qwen | no | — | — |
| watchdog | yes (pid 32571) | — | — |
