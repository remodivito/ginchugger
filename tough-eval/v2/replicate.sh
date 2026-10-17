#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Reproduce every published v2 number from the committed runs, with no model call and no network (BENCHMARK-V2.md 18).
# Run from a clean checkout of the results tag with Node 22. The exit code is the replication result.
#   1. the scorers pass their own checks          4. profiles and the by-author table regenerate identically
#   2. every hash in frozen.json matches          5. the paired comparisons regenerate
#   3. every run is rescored                       6. the card's numbers are printed for a side-by-side check
# Environment (for dry runs on the synthetic fixture; the defaults are the published setting):
#   SUITE=v2a  H_SUITE=v2h  FROZEN=tough-eval/v2/frozen.json  RESULTS_DIR=tough-eval/results/v2  REFERENCE=<config key>
# Arguments: run directories to use instead of every test and baseline run under tough-eval/runs.
set -u
cd "$(dirname "$0")/../.." || exit 2   # outputs/
SUITE=${SUITE:-v2a}; H_SUITE=${H_SUITE:-v2h}; FROZEN=${FROZEN:-tough-eval/v2/frozen.json}; RESULTS_DIR=${RESULTS_DIR:-tough-eval/results/v2}
fail=0
step() { echo; echo "== $1"; }
run() { "$@" || { echo "FAILED: $*"; fail=1; }; }

step "1. scorer self-tests"
run node tough-eval/selftest.mjs --suite "$SUITE"
run node tough-eval/contractnli/selftest.mjs
run node tough-eval/v2/score-h.mjs --selftest --suite "$H_SUITE"

step "2. frozen hashes"
run node tough-eval/v2/check-frozen.mjs --frozen "$FROZEN"

RUNS=("$@")
A_RUNS=(); B_RUNS=(); H_RUNS=()
while IFS= read -r d; do [ -n "$d" ] && A_RUNS+=("$d"); done < <(node tough-eval/v2/profile.mjs --list A ${RUNS[@]+"${RUNS[@]}"})
while IFS= read -r d; do [ -n "$d" ] && B_RUNS+=("$d"); done < <(node tough-eval/v2/profile.mjs --list B ${RUNS[@]+"${RUNS[@]}"})
while IFS= read -r d; do [ -n "$d" ] && H_RUNS+=("$d"); done < <(node tough-eval/v2/profile.mjs --list H ${RUNS[@]+"${RUNS[@]}"})
echo "runs: ${#A_RUNS[@]} layer A, ${#B_RUNS[@]} layer B, ${#H_RUNS[@]} layer H"

step "3. rescoring"
[ ${#A_RUNS[@]} -gt 0 ] && run node tough-eval/score.mjs "${A_RUNS[@]}" > /dev/null
[ ${#B_RUNS[@]} -gt 0 ] && run node tough-eval/contractnli/score.mjs --split heldout --final "${B_RUNS[@]}" > /dev/null
[ ${#H_RUNS[@]} -gt 0 ] && run node tough-eval/v2/score-h.mjs "${H_RUNS[@]}" > /dev/null

step "4. profiles and by-author table against $RESULTS_DIR"
ALL=(${A_RUNS[@]+"${A_RUNS[@]}"} ${B_RUNS[@]+"${B_RUNS[@]}"} ${H_RUNS[@]+"${H_RUNS[@]}"})
if [ ${#ALL[@]} -gt 0 ]; then
  tmp=$(mktemp)
  run node tough-eval/v2/profile.mjs --check --out "$RESULTS_DIR" "${ALL[@]}" > "$tmp"; grep -E '^(DIFFERS|profiles reproduced|[0-9]+ profile)' "$tmp"
  [ ${#A_RUNS[@]} -gt 0 ] && { run node tough-eval/v2/by-author.mjs --check --out "$RESULTS_DIR" "${A_RUNS[@]}" > "$tmp"; grep -E '^by-author' "$tmp"; }
  rm -f "$tmp"
else echo "no runs to profile"; fi

step "5. paired comparisons (layer A)"
MODEL_RUNS=(); for d in ${A_RUNS[@]+"${A_RUNS[@]}"}; do grep -q '"baseline"' "$d/manifest.json" || MODEL_RUNS+=("$d"); done
if [ ${#MODEL_RUNS[@]} -gt 1 ]; then run node tough-eval/compare.mjs --split all --final ${REFERENCE:+--reference "$REFERENCE"} "${MODEL_RUNS[@]}"; else echo "fewer than two model runs: nothing to compare"; fi

step "6. the card's numbers"
node -e '
const fs = require("fs"), path = require("path"); const root = process.argv[1]; const rows = [];
for (const layer of ["A", "B", "H"]) { const d = path.join(root, layer); if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter(f => f.endsWith(".json")).sort()) { const p = JSON.parse(fs.readFileSync(path.join(d, f))); const m = p.profile.miss;
    rows.push({ layer, setup: p.setup, misses: `${m.x}/${m.n}`, upper95: m.upper95, bound: m.words, halluc: p.profile.hallucinated ? `${p.profile.hallucinated.x}/${p.profile.hallucinated.n}` : "", allPass: p.profile.allPass?.together?.rate ?? p.profile.allPass?.rate ?? "", notCompleted: p.notCompleted || false }); } }
console.table(rows);' "$RESULTS_DIR"

echo; if [ $fail -eq 0 ]; then echo "REPLICATION PASSED"; else echo "REPLICATION FAILED"; fi
exit $fail
