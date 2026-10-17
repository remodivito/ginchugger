# Who writes the test: author bias in generated benchmarks, and the precedent for cross-family authoring

15 October 2026. Prompted by the user's question whether Opus 5.5, which wrote the planted deviations, biases the planted suite in its own favour, and the suggestion that deviations be written by a model that is not being evaluated. Sources were found by web search on 15 October; **only the search summaries were read, not the papers**, so every figure below is to be checked against the paper before it is quoted in the eval card.

## 1. Who wrote v1's planted deviations

Claude Opus 5.5, in this project's coding sessions on 9 and 10 October, directed by the user. The commits that built the suite (`772764e`, `c333384`, and the bundle on 10 October) carry `Co-Authored-By: Claude Opus 5.5`. Opus also wrote the customer playbook, the clean-copy cover terms and the per-plant fix checks. `tough-eval/README.md` said the plants were "written by the same person"; corrected on 15 October to name the model.

## 2. The bias channels in v1, from our own record

1. **Clean copies calibrated on Opus.** The bundle was revised in five rounds until Opus 5.5 raised no flag on the clean copy (`tough-eval/README.md`, calibration log). Each change fixed a real fault, but whatever Opus does not see as a departure is, by construction, not one; another model's flag there scores as a false alarm. This bears on false alarms and all-pass, the headline.
2. **Asymmetric item audit.** P17 and P20 were repaired because both Claude models "missed" them. Items other models miss were not audited.
3. **Fix checks written after reading Claude's fixes.** The compliance checks accept paraphrase; their wording was settled on Claude output.
4. **Same-family style (speculative).** Plants phrased the way Claude writes may be easier for Claude to see. Not measured.

Against: the scorer is deterministic, so the best-documented form of self-preference (a model grading its own output) does not arise. On ContractNLI, where others wrote the labels, Opus still leads, but by less (all-pass 0.42 against 0.28–0.33, against 0.91 against 0.40–0.66 on the planted suite); that is consistent with construction bias and equally with the NDA task being more uniform. The data cannot separate the two.

## 3. Evidence that generated benchmarks favour their author

- "When LLMs Benchmark Themselves: Deconstructing Self-Bias in Automated Evaluation" (arXiv 2509.26600) names *testset self-bias*: a test set a model generates inflates that model's score. https://arxiv.org/abs/2509.26600
- "Deconstructing Self-Bias in LLM-generated Translation Benchmarks": strongest with strong frontier generators and low-resource directions; more diverse source texts reduce it. https://www.researchgate.net/publication/396048674_Deconstructing_Self-Bias_in_LLM-generated_Translation_Benchmarks
- Judge side: Panickssery, Bowman and Feng, "LLM Evaluators Recognize and Favor Their Own Generations" (NeurIPS 2024): models recognise their own text and score it higher; self-recognition and self-preference correlate linearly under fine-tuning. https://papers.nips.cc/paper_files/paper/2024/hash/7f1f0218e45f5414c79c0679633e47bc-Abstract-Conference.html ; arXiv 2404.13076. Also "Do LLM Evaluators Prefer Themselves for a Reason?" (part of the preference tracks real quality), https://arxiv.org/html/2504.03846v2 , and "Self-Preference Bias in Rubric-Based Evaluation" (same-family over-credit even with objective rubrics), https://arxiv.org/html/2604.06996

## 4. Evidence that it is not universal

- RoleConflictBench rebuilt its dataset with Gemini 2.5 Flash instead of GPT-4.1 and found no self-advantage. https://arxiv.org/pdf/2509.25897
- An agent-centric text-anomaly benchmark reports a same-family "Bias Index" near zero for four generator families, Claude the exception in its table. https://arxiv.org/pdf/2602.23729
- JailNewsBench found no significant same- versus cross-model difference. https://arxiv.org/pdf/2603.01291 ; bias-eliciting question generation likewise, https://arxiv.org/pdf/2510.12857
- Pattern in the summaries: the effect is clearest when one model both generates and grades; separating generation from grading, as our deterministic scorer does, tends to shrink it.

## 5. Precedent for the remedy

- **Several designer models, a panel of answerers, exact checkers where possible, self- and same-family bias measured**: BenchBench, https://arxiv.org/html/2603.20807 . Closest to the design adopted.
- **A bias factor**: a model's score on its own synthetic data minus its score on other models' data; smaller models favoured their own data, larger ones did not; recommends data from several larger models. "Efficacy of Synthetic Data as a Benchmark", https://www.researchgate.net/publication/384116075_Efficacy_of_Synthetic_Data_as_a_Benchmark
- **Generator and evaluator from different families** as a safeguard: https://arxiv.org/pdf/2608.26899 ; diversity of generators and prompts: https://arxiv.org/pdf/2503.14023
- **Grading panels**: RedlineBench grades by a three-model majority (`benchmark-public-data-research.md` §4).

## 6. What none of it establishes

None of these studies concerns contracts or planted deviations against a playbook. Whether same-family advantage appears in our task is an empirical question the v2 design answers with its own measurement (the by-author table), rather than an assumption either way.

## 7. Precedent for planting deviations at all (for the record)

Recorded in the conversation of 15 October; the legal precedent is verified, the others are from general knowledge and to be checked: CLAUSE (EACL 2026; 7,514 CUAD/ContractNLI contracts, 23,955 LLM-injected flaws; `benchmark-public-data-research.md` §4); mutation testing (since the late 1970s); LAVA (2016, injected bugs); MEDEC (2024–25, injected errors in clinical notes); FactCC (2020) and SummEdits (2023, edited summaries). Documented weakness: injected errors are cleaner and easier than natural ones (Goyal and Durrett 2021 on factuality; criticism of LAVA's realism), which v1 shows as saturation on single plants.
