#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# GEMINI RUNS lane (preliminary v2, 16 October 2026, evening): Gemini 3.8 Flash at high effort (model id
# gemini-3.8-flash-high; the effort is part of the id) through Google's Antigravity CLI (`agy`, run.mjs --executor agy)
# under the user's Google AI Pro sign-in, product prompt, single call. agy has no system-prompt flag: the system prompt
# travels in the user turn (manifest: systemPromptInUserTurn; PRELIMINARY.md deviations 13 to 15). In priority order:
#   b_run    prelim-B-gemini-flash-product  layer B test split (123 NDAs): its single look; never started twice (b-unique)
#   a_run    prelim-A-gemini-flash-product  layer A, every verified single item and markup, once markups are built
#   c_run    prelim-C-gemini-flash-product  layer C contestant run (3 tasks)
#   judge_c  its layer C panel (Opus + GLM, DeepSeek tiebreak: panel.mjs for the Google family), once the run is done
#            and the panel validity control is complete; uses the Claude plan for the Opus judgements
# Rate-limited: the plan's quota, not the clock, is the limit. A quota, rate-limit or capacity refusal is a usage limit
# (retried every 15 minutes inside run.mjs under P16); a step that ends not done backs off WAIT (15 minutes) and is
# retried up to MAXTRIES times, enough to outlast a night and a day of quota windows.
# CONC (default 2): reviews at once. Two parallel calls ran without refusal in the development check (16 October,
# tough-eval/v2/dev/gemini-2026-10-16/); CONC=1 before the command for a new run if refusals pile up.
# Start (from outputs/ of the checkout that holds the item store and runs):
#   nohup caffeinate -i zsh tough-eval/v2/prelim/lane-gemini-runs.zsh gemini-flash >> tough-eval/v2/prelim/logs/gemini-runs-gemini-flash.log 2>&1 &
# Under the watchdog: add gemini-runs:gemini-flash to WATCH_LANES (its log name matches the one above).
# gemini-flash-medium: the same at the CLI's medium level, a separate setup with its own runs and state, in case high
# proves unusable (development check: high ran a 13 KB NDA into the output token limit twice and past 30 minutes once;
# medium reviewed it in 250 s).
S=$1; LANE=gemini-runs-$S; WAIT=900; MAXTRIES=${MAXTRIES:-400}
case $S in
  gemini-flash) M=gemini-3.8-flash-high; SETUP=gemini-3.8-flash-high-product ;;
  gemini-flash-medium) M=gemini-3.8-flash-medium; SETUP=gemini-3.8-flash-medium-product ;;
  *) echo "usage: lane-gemini-runs.zsh gemini-flash|gemini-flash-medium"; exit 2 ;;
esac
source "${0:A:h}/lane.zsh"
: ${CONC:=2}
AGY=(--executor agy)
STEPS=(b_run a_run c_run judge_c)

b_run_done() { g run-done prelim-B-$S-product; }; b_run_ready() { g b-unique prelim-B-$S-product $M product; }
b_run_run() { run_a prelim-B-$S-product $SETUP contractnli test $CONC $M $AGY; }
a_run_done() { g run-done prelim-A-$S-product; }; a_run_ready() { g markups; }
a_run_run() { run_a prelim-A-$S-product $SETUP v2a verified $CONC $M $AGY; }
# Layer C directly (lane.zsh's run_c fixes concurrency 3; this lane keeps to CONC).
c_run_done() { g run-done prelim-C-$S-product; }; c_run_ready() { true; }
c_run_run() {
  local d=$(g run-dir prelim-C-$S-product)
  if [ -z "$d" ]; then node tough-eval/v2/layer-c/run.mjs --name prelim-C-$S-product --setup $SETUP --model $M --effort medium --concurrency $CONC --retry-policy $AGY
  else node tough-eval/v2/layer-c/run.mjs --resume "$d" --concurrency $CONC; fi
}
judge_c_done() { g judged prelim-C-$S-product; }; judge_c_ready() { g run-done prelim-C-$S-product && g validity; }
judge_c_run() { node tough-eval/v2/layer-c/judge.mjs --run "$(g run-dir prelim-C-$S-product)" --concurrency 2; }
lane_main
