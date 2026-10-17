#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# MUNITO GATES lane for one authoring family, glm or deepseek (preliminary v2, 16 October 2026), in priority order:
# the four layer A authoring batches, each applied as soon as written (one resubmission, inside apply.mjs); the playbook
# ambiguity read (P2, four calls; points recorded in v2/playbook-read/points.json, not acted on in the preliminary run);
# verification of the other two authors' items once both are applied; the markups once every family has verified
# (whichever gates lane gets there first; markups.mjs holds the store lock); the ten scenarios once this author's items
# are verified by both other families, then apply-scenarios; verification of the other authors' scenarios once applied.
# Munito failures back off 5 minutes (the endpoint's own 429/503 retries are inside lib/call.mjs).
# Start: nohup caffeinate -i zsh tough-eval/v2/prelim/lane-munito-gates.zsh glm >> tough-eval/v2/prelim/logs/munito-gates-glm.log 2>&1 &
F=$1; [[ $F == glm || $F == deepseek ]] || { echo "usage: lane-munito-gates.zsh glm|deepseek"; exit 2; }
LANE=munito-gates-$F; WAIT=300; MAXTRIES=30
source "${0:A:h}/lane.zsh"
ALL=(opus glm deepseek); OTHERS=(${ALL:#$F})
STEPS=()
for d s in csa customer csa vendor nda discloser nda recipient; do
  STEPS+=(author_$d$s apply_$d$s)
  eval "author_$d${s}_done() { g authored $F $d $s; }; author_$d${s}_ready() { true; }; author_$d${s}_run() { node tough-eval/v2/author.mjs --author $F --document $d --side $s; }"
  eval "apply_$d${s}_done() { [ -f tough-eval/v2/authoring/$F/$d-$s.apply.json ]; }; apply_$d${s}_ready() { g authored $F $d $s; }; apply_$d${s}_run() { node tough-eval/v2/apply.mjs --author $F --document $d --side $s; }"
done
STEPS+=(pbread verify markups scen scen_apply scen_verify)
pbread_done() { g pbread $F; }; pbread_ready() { true; }; pbread_run() { node tough-eval/v2/playbook-read.mjs --family $F; }
verify_done() { g verified-by $F; }; verify_ready() { g applied opus && g applied glm && g applied deepseek; }; verify_run() { node tough-eval/v2/verify.mjs --family $F; }
markups_done() { g markups; }; markups_ready() { g all-verified; }; markups_run() { node tough-eval/v2/markups.mjs; }
scen_done() { g scen-authored $F; }; scen_ready() { g own-verified $F; }
scen_run() { for n in $(g scen-calls $F); do ls tough-eval/v2/authoring/$F/scenarios/H$(printf %02d $n)-*.meta.json >/dev/null 2>&1 && continue; node tough-eval/v2/author.mjs --author $F --scenario $n || return 1; done; }
scen_apply_done() { g scen-applied $F; }; scen_apply_ready() { g scen-authored $F; }; scen_apply_run() { node tough-eval/v2/apply-scenarios.mjs --author $F; }
scen_verify_done() { g scen-verified-by $F; }; scen_verify_ready() { g scen-applied $OTHERS[1] && g scen-applied $OTHERS[2]; }; scen_verify_run() { node tough-eval/v2/verify-scenarios.mjs --family $F; }
lane_main
