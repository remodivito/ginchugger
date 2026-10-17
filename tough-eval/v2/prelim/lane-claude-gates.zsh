#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# CLAUDE GATES lane (preliminary v2, 16 October 2026): Opus 5.5 at medium effort through `claude -p`, the small calls on
# the critical path. In priority order: the four layer A authoring batches, each applied as soon as it is written
# (one resubmission allowed, inside apply.mjs); verification of GLM's and DeepSeek's items once both are applied; the
# layer C panel control with Opus as judge; the ten scenarios once Opus's own items are verified by both other
# families, then apply-scenarios; verification of GLM's and DeepSeek's scenarios once both are applied; Opus (with
# DeepSeek or GLM, Qwen breaking ties) judging the GLM and DeepSeek layer C runs. Retries every 15 minutes, so a usage
# limit only pauses it. Start: nohup caffeinate -i zsh tough-eval/v2/prelim/lane-claude-gates.zsh >> tough-eval/v2/prelim/logs/claude-gates.log 2>&1 &
LANE=claude-gates; WAIT=900; MAXTRIES=${MAXTRIES:-400}
source "${0:A:h}/lane.zsh"
STEPS=()
for d s in csa customer csa vendor nda discloser nda recipient; do
  STEPS+=(author_$d$s apply_$d$s)
  eval "author_$d${s}_done() { g authored opus $d $s; }; author_$d${s}_ready() { true; }; author_$d${s}_run() { node tough-eval/v2/author.mjs --author opus --document $d --side $s; }"
  eval "apply_$d${s}_done() { [ -f tough-eval/v2/authoring/opus/$d-$s.apply.json ]; }; apply_$d${s}_ready() { g authored opus $d $s; }; apply_$d${s}_run() { node tough-eval/v2/apply.mjs --author opus --document $d --side $s; }"
done
STEPS+=(verify control scen scen_apply scen_verify judge_glm judge_deepseek)
verify_done() { g verified-by opus; }; verify_ready() { g applied glm && g applied deepseek && g applied opus; }; verify_run() { node tough-eval/v2/verify.mjs --family opus; }
control_done() { g control-done opus; }; control_ready() { true; }; control_run() { node tough-eval/v2/layer-c/judge.mjs --control --judges opus --concurrency 2; }
scen_done() { g scen-authored opus; }; scen_ready() { g own-verified opus; }
scen_run() { for n in $(g scen-calls opus); do ls tough-eval/v2/authoring/opus/scenarios/H$(printf %02d $n)-*.meta.json >/dev/null 2>&1 && continue; node tough-eval/v2/author.mjs --author opus --scenario $n || return 1; done; }
scen_apply_done() { g scen-applied opus; }; scen_apply_ready() { g scen-authored opus; }; scen_apply_run() { node tough-eval/v2/apply-scenarios.mjs --author opus; }
scen_verify_done() { g scen-verified-by opus; }; scen_verify_ready() { g scen-applied glm && g scen-applied deepseek; }; scen_verify_run() { node tough-eval/v2/verify-scenarios.mjs --family opus; }
judge_glm_done() { g judged prelim-C-glm-product; }; judge_glm_ready() { g run-done prelim-C-glm-product && g validity; }; judge_glm_run() { node tough-eval/v2/layer-c/judge.mjs --run "$(g run-dir prelim-C-glm-product)" --concurrency 2; }
judge_deepseek_done() { g judged prelim-C-deepseek-product; }; judge_deepseek_ready() { g run-done prelim-C-deepseek-product && g validity; }; judge_deepseek_run() { node tough-eval/v2/layer-c/judge.mjs --run "$(g run-dir prelim-C-deepseek-product)" --concurrency 2; }
lane_main
