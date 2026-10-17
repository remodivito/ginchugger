# Preliminary v2 run: lanes, logs, restarts, timings

Launched Friday 16 October 2026, 09:35 to 09:38 London, for preliminary results by Saturday 17 October, 09:00. What differs from the spec: `../PRELIMINARY.md`. The report, at any time: `node tough-eval/v2/prelim/report.mjs` → `tough-eval/v2/prelim/REPORT.md`.

All commands run from `outputs/` (the folder holding `tough-eval/`). Every lane is a detached zsh script under `caffeinate -i`, built on `lane.zsh`: it walks its steps in priority order, runs the first one that is not done and whose gate holds (gates and done-checks are files on disk, answered by `gate.mjs`), and after each step starts again from the top. A step that ends not done backs off (Claude 15 minutes, Munito 5 minutes) and is retried, up to 40 (Claude) or 30 (Munito) tries; then it is marked given up in `state/<lane>/<step>.gaveup`. Review runs use `run.mjs` / `layer-c/run.mjs` with `--retry-policy` (P16), so usage limits and transport errors inside a run are retried every 15 minutes by the run itself. Everything is resumable: a lane killed and restarted continues where it stopped, and a run directory is resumed, never started twice (layer B test-split runs are also guarded by `gate.mjs b-unique`). One instance per lane (`state/<lane>/pid`).

## The lanes

| Lane | Log | What it does, in priority order |
|---|---|---|
| `claude-gates` | `logs/claude-gates.log` | Opus 5.5 (medium) authoring, 4 layer A batches, each applied when written (one resubmission inside `apply.mjs`); verification of GLM's and DeepSeek's items once both are applied; layer C panel control with Opus as judge; 10 scenarios once Opus's items carry both other families' verdicts, then `apply-scenarios`; verification of GLM's and DeepSeek's scenarios once applied; judging of the GLM and DeepSeek layer C runs (Opus + the other open model, Qwen tiebreak) |
| `claude-runs` | `logs/claude-runs.log` | `prelim-B-opus-product` (layer B test split, 123 NDAs, concurrency 4); `prelim-C-opus-product`, `prelim-C-opus-plain`; once markups exist: `prelim-A-opus-product` (all verified singles + markups), `prelim-A-opus-plain` (budget-gated); once every scenario is applied and verified: `prelim-H-opus-agentic` (layer H, store tools: the flat document store of decisions 190 and 191); `prelim-Aempty-opus-agentic` (the 40 empty-record items); last, `prelim-B-opus-plain` (budget-gated) |
| `munito-gates-glm`, `munito-gates-deepseek` | `logs/munito-gates-<f>.log` | that family's 4 authoring batches, each applied when written; playbook read (P2, 4 calls; recorded only); verification of the other two authors' items once all are applied; markups once every family has verified (first lane there builds them); 10 scenarios once its own items are verified, then `apply-scenarios`; verification of the other authors' scenarios |
| `munito-runs-deepseek` | `logs/munito-runs-deepseek.log` | layer C control as judge; `prelim-C-deepseek-product`; `prelim-B-deepseek-product` (concurrency 2); `prelim-A-deepseek-product` once markups exist |
| `munito-runs-mistral` | `logs/munito-runs-mistral.log` | `prelim-B-mistral-product` (concurrency 2); `prelim-A-mistral-product` once markups exist; GLM + DeepSeek (Qwen tiebreak) judging the two Opus layer C runs once the control is complete |
| `munito-runs-glm` | `logs/munito-runs-glm.log` | layer C control as judge; `prelim-C-glm-product`; `prelim-B-glm-product` (concurrency 2); `prelim-A-glm-product` last, if time allows |
| `munito-runs-qwen` | `logs/munito-runs-qwen.log` | layer C control as judge (Qwen is the tiebreaker); `prelim-B-qwen-product` (concurrency 2); no layer A |
| `gemini-runs-gemini-flash` (added 16 October evening) | `logs/gemini-runs-gemini-flash.log` | Gemini 3.8 Flash at high effort (`gemini-3.8-flash-high`) through Google's Antigravity CLI (`run.mjs --executor agy`, the user's Google AI Pro sign-in), product prompt with the system prompt in the user turn: `prelim-B-gemini-flash-product` (layer B test split, its single look; concurrency 2); `prelim-A-gemini-flash-product` once markups exist; `prelim-C-gemini-flash-product`; then its layer C judging (Opus + GLM, DeepSeek tiebreak) once the panel validity control is complete. Rate-limited by the plan's quota: usage limits retried every 15 minutes inside each run, the lane backs off 15 minutes, up to 400 tries |

Run directories: `tough-eval/runs/<UTC time>Z-prelim-<layer>-<setup>` (layer C: `…Z-v2c-prelim-C-…`). Item store and gates: `tough-eval/v2/` (`items.json`, `variants/`, `manifest.json`, `markups.json`, `authoring/`, `verification/`, `scenarios/`, `verification-scenarios/`, `playbook-read/`). Layer C judgements: `tough-eval/results/v2/C/`.

## Check, stop, restart

- Progress: `tail -f tough-eval/v2/prelim/logs/*.log`; `node tough-eval/v2/prelim/report.mjs` and read `REPORT.md` (it lists which lanes are running and any step given up or skipped).
- Claude tokens spent so far: `node tough-eval/v2/prelim/gate.mjs tokens` (budget 8,000,000; plain-prompt steps are skipped rather than exceed it).
- Stop one lane and everything it started: `zsh tough-eval/v2/prelim/stop.zsh <lane>` (or `all`).
- Restart (each resumes; safe to run while it is already running, a second instance exits at once):

```
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-claude-gates.zsh >> tough-eval/v2/prelim/logs/claude-gates.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-claude-runs.zsh >> tough-eval/v2/prelim/logs/claude-runs.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-gates.zsh glm >> tough-eval/v2/prelim/logs/munito-gates-glm.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-gates.zsh deepseek >> tough-eval/v2/prelim/logs/munito-gates-deepseek.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-runs.zsh deepseek >> tough-eval/v2/prelim/logs/munito-runs-deepseek.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-runs.zsh mistral >> tough-eval/v2/prelim/logs/munito-runs-mistral.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-runs.zsh glm >> tough-eval/v2/prelim/logs/munito-runs-glm.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-runs.zsh qwen >> tough-eval/v2/prelim/logs/munito-runs-qwen.log 2>&1 &
nohup caffeinate -i zsh tough-eval/v2/prelim/lane-gemini-runs.zsh gemini-flash >> tough-eval/v2/prelim/logs/gemini-runs-gemini-flash.log 2>&1 &
```

- A step given up: read its log, fix, `rm tough-eval/v2/prelim/state/<lane>/<step>.{gaveup,tries,until}`, restart the lane.
- Munito rate limits: if the logs show HTTP 429 failures, stop `munito-runs-qwen` (then `munito-runs-glm`) and restart it later; runs resume. `CONC=1` before the command runs a stream's new runs at concurrency 1 (an existing run keeps going at whatever concurrency the restart passes).
- Never start a layer B test-split run by hand: the lanes resume the one run per setup.
- Gemini lane: under the watchdog, add `gemini-runs:gemini-flash` to `WATCH_LANES`. Its reviews are slow and heavy (development check, 16 October, `../dev/gemini-2026-10-16/`): at high, 197 s for the ten-paragraph fixture and 322 s for a 3 KB NDA (29,000 and 47,000 output tokens, nearly all thinking), while a 13 KB NDA (the test split's median is 12.6 KB) ran into the output token limit twice (about 68,000 output tokens) and past the 30-minute limit once; at medium the same NDA took 250 s (39,000). At concurrency 2 and five minutes a review the 123 test NDAs take about 5 hours if the quota holds; cut-off answers are malformed (retried at once, three attempts at most), timeouts are transport (every 15 minutes, as for the Claude CLI). `lane-gemini-runs.zsh gemini-flash-medium` runs the medium setup instead (its own runs, state and log). `CONC=1` before the start command runs new runs at concurrency 1.

## Expected timeline (London time, from the speeds measured at launch)

Measured in the first minutes: Opus authoring 60 to 80 s per CSA batch (about 8,000 output tokens), GLM 190 s, all 12 items of each applied; Opus NDA reviews about 100 s; Mistral 40 to 150 s; DeepSeek layer C judgements about 12 s each.

| Milestone | Expected |
|---|---|
| All 12 authoring batches written and applied | about 10:30 to 11:00 Friday |
| Item verification by all three families; markups built | about 11:30 to 12:30 |
| Opus layer B (product) complete | about 10:30 to 11:00 |
| Opus layer C runs; panel control complete (all four judges) | about 11:00 to 12:00 |
| Opus layer A product, then plain | about 13:00, 14:00 |
| Scenarios written, applied, verified (GLM verification is the slowest) | about 14:00 to 16:00 |
| Opus layer H and the 40 empty-record items | about 15:00 to 17:00 |
| Mistral B, then Mistral A | about 11:00, then 13:30 to 14:30 |
| DeepSeek B, then DeepSeek A | about 14:00, then about 19:00 to 21:00 |
| Qwen B | about 17:00 to 19:00 |
| GLM B, then GLM A (if time allows) | about 17:00 to 19:00, then early Saturday |
| Opus layer B plain (lowest priority, budget permitting) | late Friday afternoon |
| Preliminary report with every layer | Friday evening; refresh Saturday before 09:00 with `report.mjs` |

Usage limits on the Claude plan pause the Claude lanes, which resume within 15 minutes of the reset; the Claude total is expected near 7 to 7.5M output tokens.

## Paused, 16 October about 11:45 London

The user asked to pause the Claude lanes for a few hours while the product is finished ("other evals can go on"). `claude-gates` and `claude-runs` were stopped with `stop.zsh`; the six Munito lanes keep running. Claude output tokens at the pause: 2,599,883 of 8,000,000. While paused: Claude's verification of the GLM and DeepSeek items does not run, so markups, and therefore every layer A run that needs them, wait; Opus judging of the GLM and DeepSeek layer C runs waits. Resume with the two `lane-claude-*` commands above; both pick up where they stopped.
