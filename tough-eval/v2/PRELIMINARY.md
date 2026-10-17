# Preliminary v2 run (16 to 17 October 2026)

A compressed run of the v2 benchmark (`../BENCHMARK-V2.md`, `RUN-PLAN.md`, `AUTHORING-SPEC.md`) so that preliminary results exist by Saturday 17 October 2026, 09:00 London (decision 177). Launched on Friday 16 October at about 09:35. Everything not listed below follows the spec. The lanes, logs, restart commands and timings are in `prelim/STATUS.md`; the scored report is `prelim/REPORT.md` (`node tough-eval/v2/prelim/report.mjs`).

**Every result from this run is preliminary.** No run is a test run in the sense of section 11.7: there is no `bench-v2.0` tag and no `frozen.json`, so every manifest says `test: false`. Each run is started with `--retry-policy` (P16's policy, without `--test`).

## Deviations from the spec

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

## Code changes made for the run (16 October)

The lanes run several processes against the same item store at once, which the scripts were not written for. The changes, all in `tough-eval/v2/` (no change to the product):

- `lib/store.mjs`: `withStoreLock` (a lock directory, `.store.lock`) around every load-modify-save of `items.json`, `markups.json`, `playbook-read/points.json` and scenario files (`apply.mjs`, `verify.mjs`, `markups.mjs`, `playbook-read.mjs`, `verify-scenarios.mjs`, `apply-scenarios.mjs`); `rebuild` rewrites variant files in place (unchanged bytes untouched, stale files removed) instead of deleting and recreating `variants/`, so a run reading a variant never finds it missing.
- `verify.mjs`: saves after each chunk, merged into the store as it is then, and skips a chunk whose items already carry the family's record, so a verification interrupted by a usage limit resumes without asking again. `verify-scenarios.mjs` likewise per scenario, re-reading the file before writing.
- `lib/call.mjs`: a Claude CLI failure (usage limit, transport) is rethrown instead of being read as an empty answer, so it no longer spends one of a batch's P4 attempts.

`node --test tough-eval/v2/tests/authoring.test.mjs tough-eval/v2/tests/scenarios.test.mjs` passes (39 tests) after the changes.

## The Gemini lane (16 October, evening)

Deviations 13 to 15. Code: the `agy` executor in `contract-review/server/executors.js` beside the others (the claude, openai, muse and codex paths unchanged); `run.mjs` and `layer-c/run.mjs` accept `--executor agy` and record `cliVersion`, `systemPromptInUserTurn`, `effortApplies: false` and `effortInModelId` in the manifest; `retry-policy.mjs` classes the Antigravity CLI's own failures as transport (patterns that match no other executor's errors), the executor names quota, rate-limit and capacity refusals "usage limit", and an answer cut off at the output token limit is malformed; `layer-c/panel.mjs` gives Gemini the family `google` (its panel: Opus and GLM, DeepSeek tiebreak, by the assignment order). agy 1.4.0 overran its own `--print-timeout` and ignores SIGTERM, so the executor kills it with SIGKILL at the review timeout (30 minutes). Development check on the fixture and two development NDAs (high), and the larger NDA again at medium: `dev/gemini-2026-10-16/`.

## The document store (16 October, evening; decisions 190 and 191)

The product moved from matters and rounds to a flat document store while this run was under way. Layer H, which had not started (the Claude lanes were paused), now runs on a flat store seeded from the same scenarios (`seed-record.mjs`), with the product's four store tools, citations `{ documentId, quote, counterparty }` verified against each document's text, and the same scenarios, expectations and measures (`../BENCHMARK-V2.md` section 8). The layer A, B and C runs in flight are unaffected: the single-call review sends byte-identical prompts and payloads before and after the change, so a run started before it and resumed after it is one run. `score-h.mjs --selftest` gives the same outcomes as before on the fixture and on the 25 scenarios applied so far.

## What the preliminary report can and cannot say

- Layer A counts depend on how many items survive apply and verification; the miss-rate bounds are computed on the verified singles actually run (section 3.1), so they are wider than the spec's 96-item figures if fewer survive.
- Layer B uses the test split under the frozen NDA playbook; it is the one look that split gets for these setups.
- Layer C pass counts need the panel validity control first (section 7); a contestant not yet judged is listed as pending.
- Layer H is diagnostic (n = 30 at most), Opus only.
