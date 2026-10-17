# v2 run plan: building and running the test set without wasting usage

Written 15 October 2026 under decision 161 and made consistent with the completed design the same day. The design is `../BENCHMARK-V2.md` (procedures P1 to P23 in its section 12); the item spec is `AUTHORING-SPEC.md`. This file says what runs where, in what order, and why.

**16 October 2026, decisions 190 and 191.** The product's record of matters and rounds is replaced by a flat document store (Paperless-ngx; an in-memory fake in tests) with four read-only store tools (`contract-review/server/store/tools.js`, `store-mcp.js`); citations name documents. Layer H now runs on a flat store seeded from the same scenarios (`seed-record.mjs`: every round a document, covering emails as Email documents, the current document newest; the document-to-matter map stays in the eval), and `score-h.mjs` verifies citations against each document's text as `read_document` returns it; scenarios, expectations and measures unchanged (`BENCHMARK-V2.md` section 8). Layers A, B and C are untouched: their prompt bytes and request shape are identical before and after the change. Where the plan below names record tools, `record-mcp.js` or `server/record/tools.js`, read the store equivalents.

**16 October 2026, evening: a Gemini lane.** Gemini 3.8 Flash (`gemini-3.8-flash-high`) joins the preliminary run through Google's Antigravity CLI (`run.mjs --executor agy`, the user's Google AI Pro plan) on layers B, A and C, product prompt, with the system prompt in the user turn (agy has no system-prompt flag); its layer C output is judged by Opus and GLM, DeepSeek breaking ties. Quota-bound: `prelim/lane-gemini-runs.zsh` at concurrency 2 with 15-minute back-off. `PRELIMINARY.md` deviations 13 to 15.

**17 October 2026: the frozen layer A run.** After the preliminary run, layer A alone is frozen under the tag `bench-v2.0-a` (`frozen.json` with `"layers": ["A"]`; `check-frozen.mjs --layer A`), after the P8 clean-copy calibration and the layer A fixes recorded in `LAYER-A-FIXES.md`. It is run by `frozen/lane-frozen-a.zsh`: a Claude lane (Opus 5.5 product, then plain, concurrency 4 with staggered starts) and a Munito lane (DeepSeek V4 Flash, GLM-5.3 Flash, Mistral Small 4, product prompt), every run `run.mjs --test` with names `frozen-A-<setup>`, reported by `frozen/report.mjs` apart from the preliminary runs. Layers B, C and H are not part of this freeze.

## The three lanes

The work runs on three budgets that do not compete, so they run in parallel and the plan keeps each one busy.

| Lane | Setups | Scarce resource | How it is run |
|---|---|---|---|
| **Claude** | Opus 5.5 (product, plain and agentic), then Sonnet 5.5 | the user's plan: about 7M output tokens a day in usage windows | `opus-overnight.sh`-style queue: priority order, failed reviews retried every 15 minutes until usable or the window closes, so a usage limit only pauses it |
| **Munito** | GLM-5.3 Flash, DeepSeek V4 Flash, Qwen 3.8 27B, Mistral Small 4 | wall-clock: one review takes 1 to 7 minutes and the free tier is rate-limited | one queue per model, one review at a time, two models at once to start; four once a day passes without rate-limit errors |
| **Muse** | Wonder 1.0, Spark 1.3 | a weekly quota (next reset 19 October, 00:00 UTC) | `muse-plan.sh`; never on the critical path; reported when complete |

**Measured costs used below** (`../../results-ledger.md`, R23, R25): Opus output per review about 9,000 tokens on planted CSA cases, 18,700 with the vendor playbook, 15,700 on NDAs; the plain prompt about a quarter; an agentic review assumed at 20,000 (the tools add input, not output). Median minutes per review on Munito: GLM 6, Qwen 6.5, DeepSeek 3.5, Mistral 1.

## Principles

1. **Start whatever does not depend on the new items now.** The open models' prompt choice runs on the v1 development set, so the Munito lane starts today while the items are being written.
2. **Opus first.** The reference setup's test runs go first in the Claude lane; Sonnet only after every Opus run is complete (user, 15 October); the optional second Opus run on layer A last.
3. **Gates are cheap and small.** Everything before the freeze (playbook reads, authoring, verification, calibration, scenarios, probe) is about 1M Claude tokens and a few hours of Munito; nothing large runs until the freeze.
4. **Nothing runs twice by accident.** Every queue is resumable and skips finished reviews; `run.mjs --test` checks the frozen tag before any test run starts (a mismatch makes it a development run, marked in the manifest).
5. **One retry policy for every lane, fixed before the test runs** (`BENCHMARK-V2.md` P16): transport errors and usage limits retried every 15 minutes until usable or the two-week window closes; malformed output retried twice more, then counted as a failure (a miss) and reported in the failures column.
6. **Score as runs land.** Each finished run is scored, committed, catalogued and added to the ledger the same day; the results page is refreshed at each phase end.

## Phases

### Phase 0: build (today; session work, no test usage)

| Task | Done when |
|---|---|
| Freeze the reviewer under test: `frozen.json` (`BENCHMARK-V2.md` §11.7) listing the review path, prompts, tool schemas, executors, playbooks, documents, items, scenarios, scorer, scripts and spec hashes; tag `bench-v2.0` | `run.mjs --test` refuses a run whose HEAD is not the tag's commit or whose hashes differ from `frozen.json`; a run without `--test` is marked `test: false` |
| Import the Common Paper Mutual NDA (CC BY 4.0) as a clean document with paragraph ids and filled cover terms (P1) | the clean copy loads through the product's importer, numbering written into the text |
| Write the two NDA position sets (discloser-weighted, recipient-weighted) over the 17 NDA rules, and extend the vendor playbook with annex rules V-20 to V-27 (P1) | each rule has preferred, acceptable and escalation positions per side, grounded in Common Paper's annotations and cited; the clean bundle meets every vendor annex rule |
| `author.mjs`: sends one batch (document, side, playbook, spec) through any executor and stores the raw answer with metadata | a demo batch through each executor stores a parseable array |
| `apply.mjs`: applies items, enforces the spec's rules and quotas, assigns ids, returns failures to the author once, writes `items.json`, variants and a `suite.mjs`-compatible manifest | self-test: a known-good item applies; a missing `find`, a check that passes on planted text, a reference text that fails its check, an unknown rule and a broken quota are each rejected |
| `verify.mjs`: sends each other author's batch to a family with the change and rule stated, shuffled with the third author's; records the three answers per item | contested items are kept with both answers |
| Record tools and the seeded-record loader for layer H (the product's slice S3: `server/record/tools.js`, `tool-schemas.json`, `record-mcp.js`, the review token, `prompts/review-record.md`, executor tool loops, tool replay); `seed-record.mjs`; `score-h.mjs` with its self-test | an agentic review of one layer H scenario runs in replay and its record citations are verified; the oracle and sycophant score as expected |
| `v2a` and `v2h` suites in `suite.mjs` (items, markups and scenarios as variants, each with its `file`), with `--suite` on `score.mjs`, `selftest.mjs` and `compare.mjs` reading variants from `v.file`; `retry-policy.mjs` (error classification); `profile.mjs` (error profile and intervals, `BENCHMARK-V2.md` §3), `by-author.mjs`, `baselines.mjs` (silent, flag-everything, the v1 rule engine from `baselines/local-rules.mjs`), `check-frozen.mjs`, `replicate.sh` | `selftest.mjs --suite v2a` passes on the new suite with synthetic reviewers; `replicate.sh` exits 0 on the development runs |
| Canary GUID (`CANARY.md`) in every v2 file as a top-level field, stripped by `review-one.mjs`; memorisation probe script (`probe.mjs`) | probe runs on one family in demo mode; a variant reaching the model carries no canary |
| Tool smoke fixture and `tool-smoke.mjs` (P14); `arms/plain.md` made side-parameterised | pass/fail recorded per model into `frozen.json.toolsSupported`; the plain prompt renders for all four sides |
| Layer C task list (`layer-c-tasks.json`: 22 criteria, adapted wording, a positions source per task), renderer (`render-layer-c.mjs`), judge prompt (`prompts/judge-c.md`), panel runner (`judge-c.mjs`), `arm-c-form.json` | a demo judgement round trips through each executor; the panel validity control (golden redline passes, empty output fails) is runnable |

### Phase 1: Munito lane starts (today, runs about a day)

Plain-prompt development runs for each open model's prompt choice (P13): the 53 v1 development cases and the 61 development NDAs (114 reviews per model). The product-prompt runs already exist (R22, R25). The prompt with the lower miss rate, averaged with equal weight over the two development layers, is fixed per model in `frozen.json`; a difference under one point is a tie, broken by fewer invented quotes, then by the product prompt. Order: DeepSeek and Mistral first (fast), then GLM and Qwen.

### Phase 2: the gates (day 1)

1. **Playbook reads** (P2). GLM and DeepSeek each read all four playbooks (customer, vendor, two NDA sides) and list ambiguous rules; ambiguities are fixed and logged. Eight Munito calls.
2. **Calibration** (P8), before authoring. Each clean document reviewed on each side three times by each authoring family: 12 reviews per family per pass, up to three passes. Faults found by two or more families are fixed and logged.
3. **Freeze playbooks** (P3).
4. **Authoring** (P4). Twelve batches: four per author (CSA customer, CSA vendor, NDA discloser, NDA recipient). Opus batches through `claude -p` (four calls); GLM and DeepSeek through Munito.
5. **Apply** (P5), with one return to the author for failures.
6. **Verification** (P6, P7). Each family verifies the other two authors' batches: eight calls per family, 24 in all; contested items recorded.
7. **Markups** (P9), by hash.
8. **History scenarios** (P10): ten calls per author (one scenario each, rounds as edit lists) once its own deviations are verified; apply checks and materialisation; verification by the other two families on the edit lists; `score-h.mjs --selftest`.
9. **Probe** (P11): memorisation probe once per family.
10. **Smoke tests** (P14) for the agentic setups, once the product's slice S3 is merged.
11. **Freeze** (P12): canary stamped; `frozen.json` written with `promptPerSetup` and `toolsSupported`; items, documents, playbooks, scenarios and spec committed and tagged `bench-v2.0`. If the product's slice S3 is not merged within seven days of the probe, tag without the agentic entries and run layers A, B and C; layer H follows under `bench-v2.0-h` (`BENCHMARK-V2.md` P12).

Claude usage for phase 2: about 1M output tokens. Munito: about 160 calls (P2 8, P8 up to 72 of which 36 on long documents, P4 8, P5 up to 8, P6 16, P10 about 36, P11 40, P14 2), about five hours at the measured rates.

### Phase 3: test runs (from the night of day 1; the two-week window opens here and is dated in the card)

**Claude lane, in this order:**

| Run | Reviews | Output tokens |
|---|---|---|
| Opus 5.5 product prompt, layer A | 156 | about 2.3M |
| Opus 5.5 product prompt, layer B test | 123 | about 1.9M |
| Opus 5.5 plain prompt, layers A and B | 279 | about 1.0M |
| Opus 5.5 agentic with record tools: layer H (30) and 40 layer A items with an empty record | 70 | about 1.5M |
| Sonnet 5.5 product prompt, layers A and B (after all Opus runs) | 279 | about 4.2M |
| Optional: Opus 5.5 product prompt, layer A, second run (a check; the first run stays the published figure) | 156 | about 2.3M |

Opus test runs are about 6.7M output tokens, 7.7M with phase 2: one night and most of a day. Sonnet is a second night. Every run starts with `run.mjs --test`.

**Munito lane, in parallel:** each open model on layer A and the layer B test split with its chosen prompt (279 reviews per model), then layer H for GLM and DeepSeek where `toolsSupported` is true (30 scenarios each, agentic through tool calling). At the measured speeds: Mistral about 5 hours, DeepSeek about 16, GLM about 28, Qwen about 30. Two streams (GLM with Mistral then Qwen; DeepSeek alone) finish in about two and a half days; four streams in about a day and a half if the rate limit allows.

**Trivial baselines** (P21: silent, flag-everything, the v1 rule engine) scored on the test set: no model cost.

**Arm C** (Claude for Word by hand): the ten items drawn by hash, CSA customer side, during the window.

### Phase 4: layer C, attorney fixes (day 3 onward)

Import RedlineBench's transferable tasks (CC BY 4.0) as listed in `layer-c-tasks.json`. Contestants: Opus 5.5 (both prompts), GLM, DeepSeek, then Sonnet. Each output rendered and judged, criterion by criterion, by two families other than its own among Opus, GLM and DeepSeek; Qwen breaks ties (P19). Claude judging load is small (GLM and DeepSeek outputs only).

### Phase 5: scoring and write-up

Error profile per setup (miss-rate upper bound first; P17), by-author table and self-advantage test (P18), layer H scoring (P20), error analysis (every Opus miss and false alarm read; twenty per other setup) and the layer B label audit (P22), eval card, errata, replication script check, publication (P23). GPT 6.1 Sol's early-October work (R1 to R16) goes in the write-up as earlier exploratory evaluation, not comparable with v2.

### Muse lane, whenever its quota allows

Wonder finishes the NDA development split first (resumes 19 October). Test-set runs only once the Claude and Munito lanes are done, and only if the quota allows inside the window; otherwise Muse is reported on the development sets.

## Optional, after everything above

- Vendor-side gold labels for v1's 53 cases, written by GLM and verified by Opus and DeepSeek, so the three overnight vendor runs of 14 October can be scored as v1.
- GPT 6.1 Sol as a contestant, and as a fourth author and validator if the subscription returns before the freeze: the same 279 test reviews, its prompt chosen on the development set first.

## Totals

| Lane | Work | Usage or time |
|---|---|---|
| Claude | phase 2 plus Opus test runs (product, plain, agentic) | about 7.7M output tokens, a day and a few hours of the plan |
| Claude | Sonnet, then the optional Opus repeat | about 4.2M, then 2.3M |
| Munito | prompt choice (114), test runs (279), and for GLM and DeepSeek the gates (about 160 calls between them), layer H (30) and layer C | about 393 to 460 reviews per model plus the gates; about three to four days wall-clock in total |
| Muse | as quota allows | not on the critical path |

End to end: about four days from the start of phase 2 to scored results, with the Claude lane idle on usage only while it waits for the open models and layer C; the whole of phase 3 and 4 sits inside the dated two-week window.
