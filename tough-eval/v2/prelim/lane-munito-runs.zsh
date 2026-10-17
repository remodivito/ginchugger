#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# MUNITO RUNS lane for one model stream (preliminary v2, 16 October 2026). Every open model uses the product prompt
# (no P13 prompt choice in the preliminary run). Streams, each in priority order:
#   deepseek  layer C panel control as judge; layer C contestant run; layer B test split; layer A (once markups exist)
#   glm       the same for GLM-5.3 Flash (layer A only if time allows: it is last)
#   mistral   layer B test split; layer A (once markups exist); GLM+DeepSeek (Qwen tiebreak) judging the two Opus
#             layer C runs (once the control is complete)
#   qwen      layer C panel control as judge (Qwen is the tiebreaker); layer B test split (no layer A: R22, long
#             documents fail)
# Runs go through tough-eval/run.mjs or layer-c/run.mjs under the fixed retry policy (P16), with
# --executor openai --base-url https://api.eu.munito.ai/inference/v1 --key-env MUNITO_API_KEY --max-output-tokens 64000.
# A layer B test-split run is started once only (gate b-unique) and resumed thereafter.
# Start: nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-runs.zsh deepseek >> tough-eval/v2/prelim/logs/munito-runs-deepseek.log 2>&1 &
S=$1; LANE=munito-runs-$S; WAIT=300; MAXTRIES=30
source "${0:A:h}/lane.zsh"
: ${CONC:=2}
case $S in
  deepseek) M=deepseek-ai/deepseek-v4-flash; SETUP=deepseek-v4-flash-product; J=deepseek; STEPS=(control c_run b_run a_run) ;;
  glm) M=zai-org/glm-5.3-flash; SETUP=glm-5.3-flash-product; J=glm; STEPS=(control c_run b_run a_run) ;;
  mistral) M=mistralai/mistral-small-4-119b-2603; SETUP=mistral-small-4-product; STEPS=(b_run a_run judge_opus_product judge_opus_plain) ;;
  qwen) M=qwen/qwen3.8-27b; SETUP=qwen-3.8-27b-product; J=qwen; STEPS=(control b_run) ;;
  *) echo "usage: lane-munito-runs.zsh deepseek|glm|mistral|qwen"; exit 2 ;;
esac
control_done() { g control-done $J; }; control_ready() { true; }; control_run() { node tough-eval/v2/layer-c/judge.mjs --control --judges $J --concurrency 2; }
c_run_done() { g run-done prelim-C-$S-product; }; c_run_ready() { true; }; c_run_run() { run_c prelim-C-$S-product $SETUP --model $M $MUN; }
b_run_done() { g run-done prelim-B-$S-product; }; b_run_ready() { g b-unique prelim-B-$S-product $M product; }
b_run_run() { run_a prelim-B-$S-product $SETUP contractnli test $CONC $M $MUN; }
a_run_done() { g run-done prelim-A-$S-product; }; a_run_ready() { g markups; }; a_run_run() { run_a prelim-A-$S-product $SETUP v2a verified $CONC $M $MUN; }
judge_opus_product_done() { g judged prelim-C-opus-product; }; judge_opus_product_ready() { g run-done prelim-C-opus-product && g validity; }
judge_opus_product_run() { node tough-eval/v2/layer-c/judge.mjs --run "$(g run-dir prelim-C-opus-product)" --concurrency 2; }
judge_opus_plain_done() { g judged prelim-C-opus-plain; }; judge_opus_plain_ready() { g run-done prelim-C-opus-plain && g validity; }
judge_opus_plain_run() { node tough-eval/v2/layer-c/judge.mjs --run "$(g run-dir prelim-C-opus-plain)" --concurrency 2; }
lane_main
