#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# CLAUDE RUNS lane (preliminary v2, 16 October 2026): Opus 5.5 at medium effort, the review runs, in priority order:
#   B-opus-product   layer B test split (123 NDAs), product prompt: its single look; never started twice (b-unique)
#   C-opus-product, C-opus-plain   layer C contestant runs (3 tasks each)
#   A-opus-product   layer A, every verified single item and markup (--variants verified), once markups are built
#   A-opus-plain     the same with the plain prompt; skipped if the Claude budget cannot also cover H and the 40
#   H-opus-agentic   layer H (every applied scenario) with the store tools, once all scenarios are applied and verified
#   Aempty-opus-agentic  the 40 empty-record items, agentic, once markups are built
#   B-opus-plain     layer B test split, plain prompt: lowest priority, only within budget
# Each run is started once under the fixed retry policy (P16: malformed output retried up to three attempts; usage
# limits and transport errors retried every 15 minutes inside run.mjs) and resumed if the lane restarts.
# Budget (PRELIM_CLAUDE_BUDGET, default 8,000,000 output tokens; gate.mjs tokens): plain-prompt steps run only if the
# tokens spent plus their estimate plus a reserve for the agentic runs not yet done fit.
# Start: nohup caffeinate -i zsh tough-eval/v2/prelim/lane-claude-runs.zsh >> tough-eval/v2/prelim/logs/claude-runs.log 2>&1 &
LANE=claude-runs; WAIT=900; MAXTRIES=${MAXTRIES:-400}
source "${0:A:h}/lane.zsh"
OPUS=claude-opus-5-5; PLAIN=tough-eval/arms/plain.md
STEPS=(b_product c_product c_plain a_product h_agentic e_agentic a_plain b_plain)
# Output-token reserve for agentic steps not yet done (70 reviews at about 20,000: RUN-PLAN.md).
reserve() { local r=0; g run-done prelim-H-opus-agentic || r=$((r + 600000)); g run-done prelim-Aempty-opus-agentic || r=$((r + 800000)); echo $r; }
budget() { local est=$1 step=$2; if g budget-ok $est $(reserve); then return 0; fi; log "budget: $step skipped (estimate $est, reserve $(reserve), used $(g tokens))"; touch $STATE/$step.skipped; return 1; }

b_product_done() { g run-done prelim-B-opus-product; }; b_product_ready() { g b-unique prelim-B-opus-product $OPUS product; }
b_product_run() { run_a prelim-B-opus-product opus-5.5-product contractnli test 4 $OPUS; }
c_product_done() { g run-done prelim-C-opus-product; }; c_product_ready() { true; }; c_product_run() { run_c prelim-C-opus-product opus-5.5-product --model $OPUS; }
c_plain_done() { g run-done prelim-C-opus-plain; }; c_plain_ready() { true; }; c_plain_run() { run_c prelim-C-opus-plain opus-5.5-plain --model $OPUS --review-prompt $PLAIN; }
a_product_done() { g run-done prelim-A-opus-product; }; a_product_ready() { g markups; }; a_product_run() { run_a prelim-A-opus-product opus-5.5-product v2a verified 4 $OPUS; }
a_plain_done() { g run-done prelim-A-opus-plain; }; a_plain_ready() { g markups && { [ -n "$(g run-dir prelim-A-opus-plain)" ] || budget 700000 a_plain; }; }
a_plain_run() { run_a prelim-A-opus-plain opus-5.5-plain v2a verified 4 $OPUS --review-prompt $PLAIN; }
h_agentic_done() { g run-done prelim-H-opus-agentic; }; h_agentic_ready() { g markups && g all-scen-verified; }; h_agentic_run() { run_a prelim-H-opus-agentic opus-5.5-agentic v2h all 3 $OPUS; }
e_agentic_done() { g run-done prelim-Aempty-opus-agentic; }; e_agentic_ready() { g markups; }; e_agentic_run() { run_a prelim-Aempty-opus-agentic opus-5.5-agentic-empty v2a empty-record 3 $OPUS --agentic empty; }
b_plain_done() { g run-done prelim-B-opus-plain; }
b_plain_ready() { g b-unique prelim-B-opus-plain $OPUS plain && { [ -n "$(g run-dir prelim-B-opus-plain)" ] || { g run-done prelim-A-opus-product && { g run-done prelim-A-opus-plain || retired a_plain; } && budget 600000 b_plain; }; }; }
b_plain_run() { run_a prelim-B-opus-plain opus-5.5-plain contractnli test 4 $OPUS --review-prompt $PLAIN; }
lane_main
