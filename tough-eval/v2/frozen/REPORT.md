# FROZEN layer A results (bench-v2.0-a)

Generated 2026-10-18T14:31:28.352Z by `tough-eval/v2/frozen/report.mjs` from the `runs/*Z-frozen-A-*` runs only; the preliminary runs are reported apart in `prelim/REPORT.md`. A run is a frozen result only if its manifest says `test: true` (started with `run.mjs --test` at the tag). Formulas: `BENCHMARK-V2.md` section 3.1, as amended on 17 October 2026 (`v2/LAYER-A-FIXES.md`).

| Setup | test run | reviews | misses (verified single deviations) | upper bound (one-sided 95%) | by side | invented (reviews) | false alarms per agreement | benign flagged | fixed / caught | all-pass singles | failures | Cover Page flags (not false alarms) | quotes verified after normalisation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4-flash-product | yes (bench-v2.0-a) | complete (78) | 0/28 = 0.0% | 10.2%: misses fewer than 1 in 9 with 95% confidence | customer 0/3, discloser 0/8, recipient 0/8, vendor 0/9 | 1/75 | 0.1067 | 2/47 | 27/28 | 65/75; markups 2/3 | 3/78 | 10 | 1 |
| opus-5.5-product | yes (bench-v2.0-a) | complete (78) | 0/28 = 0.0% | 10.2%: misses fewer than 1 in 9 with 95% confidence | customer 0/3, discloser 0/8, recipient 0/8, vendor 0/9 | 0/78 | 0.0769 | 5/47 | 27/28 | 66/75; markups 2/3 | 0/78 | 23 | 0 |
| opus-5.5-plain | yes (bench-v2.0-a) | complete (78) | 1/28 = 3.6% | 15.8%: misses fewer than 1 in 6 with 95% confidence | customer 0/3, discloser 1/8, recipient 0/8, vendor 0/9 | 0/78 | 0 | 7/47 | 24/27 | 64/75; markups 3/3 | 0/78 | 1 | 0 |
| glm-5.3-flash-product | yes (bench-v2.0-a) | complete (78) | 4/28 = 14.3% | 29.8%: misses fewer than 1 in 3 with 95% confidence | customer 0/3, discloser 0/8, recipient 0/8, vendor 4/9 | 0/75 | 0.04 | 2/47 | 21/24 | 61/75; markups 1/3 | 3/78 | 7 | 2 |
| mistral-small-4-product | yes (bench-v2.0-a) | complete (78) | 20/28 = 71.4% | 84.9%: misses could be as many as 85% with 95% confidence | customer 3/3, discloser 6/8, recipient 4/8, vendor 7/9 | 13/78 | 2.9615 | 5/47 | 4/8 | 17/75; markups 0/3 | 0/78 | 5 | 0 |

### deepseek-v4-flash-product (2026-10-17T12-13-36Z-frozen-A-deepseek-v4-flash-product)

```
deepseek-v4-flash-product, layer A
  1. misses 0/28 = 0.0% [0.0, 12.3]; upper bound 10.2% (clopper-pearson one-sided): misses fewer than 1 in 9 with 95% confidence
     customer: 0/3, misses could be as many as 63% with 95% confidence
     discloser: 0/8, misses fewer than 1 in 3 with 95% confidence
     recipient: 0/8, misses fewer than 1 in 3 with 95% confidence
     vendor: 0/9, misses fewer than 1 in 3 with 95% confidence
     markup plants (apart from the headline): 0/12, misses fewer than 1 in 4 with 95% confidence [clopper-pearson one-sided (fallback: no misses observed)]
  2. invented quotes, rules or paragraphs: 1/75 reviews = 1.3% [0.0, 7.2]; 1 instances
  3. false alarms per agreement: 0.1067 [0.0267, 0.2267]; benign edits flagged 2/47
  4. fixes: 27/28 caught deviations fixed = 96.4% [81.7, 99.9]; surgical 19/20
  5. all-pass: singles 86.7% [76.8, 93.4], markups 66.7%, together 85.9%
  6. failures: 3/78 (0 provider); attempts mean 1.179, max 3
  8. median 307 s per review, cost n/a
```

### opus-5.5-product (2026-10-17T12-13-37Z-frozen-A-opus-5.5-product)

```
opus-5.5-product, layer A
  1. misses 0/28 = 0.0% [0.0, 12.3]; upper bound 10.2% (clopper-pearson one-sided): misses fewer than 1 in 9 with 95% confidence
     customer: 0/3, misses could be as many as 63% with 95% confidence
     discloser: 0/8, misses fewer than 1 in 3 with 95% confidence
     recipient: 0/8, misses fewer than 1 in 3 with 95% confidence
     vendor: 0/9, misses fewer than 1 in 3 with 95% confidence
     markup plants (apart from the headline): 0/12, misses fewer than 1 in 4 with 95% confidence [clopper-pearson one-sided (fallback: no misses observed)]
  2. invented quotes, rules or paragraphs: 0/78 reviews = 0.0% [0.0, 4.6]; 0 instances
  3. false alarms per agreement: 0.0769 [0.0256, 0.141]; benign edits flagged 5/47
  4. fixes: 27/28 caught deviations fixed = 96.4% [81.7, 99.9]; surgical 18/20
  5. all-pass: singles 88.0% [78.4, 94.4], markups 66.7%, together 87.2%
  6. failures: 0/78 (0 provider); attempts mean 1, max 1
  8. median 85 s per review, cost 0.3202902
```

### opus-5.5-plain (2026-10-17T12-47-02Z-frozen-A-opus-5.5-plain)

```
opus-5.5-plain, layer A
  1. misses 1/28 = 3.6% [0.1, 18.4]; upper bound 15.8% (clopper-pearson one-sided): misses fewer than 1 in 6 with 95% confidence
     customer: 0/3, misses could be as many as 63% with 95% confidence
     discloser: 1/8, misses fewer than 1 in 2 with 95% confidence
     recipient: 0/8, misses fewer than 1 in 3 with 95% confidence
     vendor: 0/9, misses fewer than 1 in 3 with 95% confidence
     markup plants (apart from the headline): 0/12, misses fewer than 1 in 4 with 95% confidence [clopper-pearson one-sided (fallback: no misses observed)]
  2. invented quotes, rules or paragraphs: 0/78 reviews = 0.0% [0.0, 4.6]; 0 instances
  3. false alarms per agreement: 0 [0, 0]; benign edits flagged 7/47
  4. fixes: 24/27 caught deviations fixed = 88.9% [70.8, 97.7]; surgical 17/18
  5. all-pass: singles 85.3% [75.3, 92.4], markups 100.0%, together 85.9%
  6. failures: 0/78 (0 provider); attempts mean 1, max 1
  8. median 19 s per review, cost 0.15502
```

### glm-5.3-flash-product (2026-10-17T16-17-24Z-frozen-A-glm-5.3-flash-product)

```
glm-5.3-flash-product, layer A
  1. misses 4/28 = 14.3% [4.0, 32.7]; upper bound 29.8% (clopper-pearson one-sided): misses fewer than 1 in 3 with 95% confidence
     customer: 0/3, misses could be as many as 63% with 95% confidence
     discloser: 0/8, misses fewer than 1 in 3 with 95% confidence
     recipient: 0/8, misses fewer than 1 in 3 with 95% confidence
     vendor: 4/9, misses could be as many as 75% with 95% confidence
     markup plants (apart from the headline): 4/12, misses could be as many as 50% with 95% confidence [cluster bootstrap 95th percentile]
  2. invented quotes, rules or paragraphs: 0/75 reviews = 0.0% [0.0, 4.8]; 0 instances
  3. false alarms per agreement: 0.04 [0, 0.0933]; benign edits flagged 2/47
  4. fixes: 21/24 caught deviations fixed = 87.5% [67.6, 97.3]; surgical 16/16
  5. all-pass: singles 81.3% [70.7, 89.4], markups 33.3%, together 79.5%
  6. failures: 3/78 (0 provider); attempts mean 1.282, max 3
  8. median 380 s per review, cost n/a
```

### mistral-small-4-product (2026-10-17T22-29-27Z-frozen-A-mistral-small-4-product)

```
mistral-small-4-product, layer A
  1. misses 20/28 = 71.4% [51.3, 86.8]; upper bound 84.9% (clopper-pearson one-sided): misses could be as many as 85% with 95% confidence
     customer: 3/3, misses could be as many as 100% with 95% confidence
     discloser: 6/8, misses could be as many as 95% with 95% confidence
     recipient: 4/8, misses could be as many as 81% with 95% confidence
     vendor: 7/9, misses could be as many as 96% with 95% confidence
     markup plants (apart from the headline): 11/12, misses could be as many as 100% with 95% confidence [cluster bootstrap 95th percentile]
  2. invented quotes, rules or paragraphs: 13/78 reviews = 16.7% [9.2, 26.8]; 26 instances
  3. false alarms per agreement: 2.9615 [2.0256, 4.0513]; benign edits flagged 5/47
  4. fixes: 4/8 caught deviations fixed = 50.0% [15.7, 84.3]; surgical 2/4
  5. all-pass: singles 22.7% [13.8, 33.8], markups 0.0%, together 21.8%
  6. failures: 0/78 (0 provider); attempts mean 1.038, max 2
  8. median 59 s per review, cost n/a
```

## By author (verified single items)


Reference: opus-5.5-product. Items: 75 (opus 26, glm 22, deepseek 27).

| Setup | opus all-pass / miss / FA | glm all-pass / miss / FA | deepseek all-pass / miss / FA | own all-pass | others all-pass | SA [95%] (raw) | verdict | item set |
|---|---|---|---|---|---|---|---|---|
| deepseek-v4-flash-product | 0.885 / 0 / 0.077 | 0.864 / 0 / 0.227 | 0.852 / 0 / 0.037 | 0.852 | 0.875 | -0.0435 [-0.2476, 0.1536] (-0.023) | not detected | common |
| opus-5.5-product | 0.885 / 0 / 0.115 | 0.818 / 0 / 0.136 | 0.926 / 0 / 0 | 0.885 | 0.878 | -0.0369 [-0.264, 0.1821] (0.007) | not detected | reference |
| opus-5.5-plain | 0.885 / 0 / 0 | 0.864 / 0 / 0 | 0.815 / 0.091 / 0 | 0.885 | 0.837 |  |  | common |
| glm-5.3-flash-product | 0.808 / 0.182 / 0 | 0.909 / 0 / 0 | 0.741 / 0.182 / 0.111 | 0.909 | 0.774 | 0.1999 [0.0147, 0.3716] (0.136) | detected | reduced (without glm and opus items: 27) |
| mistral-small-4-product | 0.231 / 0.727 / 2.115 | 0.273 / 0.667 / 2.364 | 0.185 / 0.727 / 3.926 |  |  |  |  | common |

A non-significant self-advantage is reported as "not detected", not "absent": with 48 own items against 96 others, about 15 to 18 points is the smallest detectable at 80% power (section 5.9).

