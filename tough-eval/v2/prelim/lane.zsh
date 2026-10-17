# SPDX-License-Identifier: GPL-3.0-or-later
# Shared runner for the preliminary v2 lanes (16 October 2026), after opus-overnight.sh's retry-until-done pattern.
# A lane script defines STEPS (names in priority order) and, per step, three functions: <step>_done, <step>_ready and
# <step>_run. Each pass walks the steps from the top and runs the FIRST step that is not done, is ready (its gate holds)
# and is not backing off; after it returns, the pass starts again from the top, so priorities are re-read after every
# step. A step that returns without being done backs off for WAIT seconds (usage limits, transport errors) and gives up
# after MAXTRIES tries (recorded in state/<lane>/<step>.gaveup). A <step>_ready may write <step>.skipped (budget) to
# retire a step. Idempotent: every check reads files on disk, so the lane can be killed and started again at any time.
# Single instance per lane (state/<lane>/pid). Sourced by the lane scripts; never run on its own.
cd "${0:A:h}/../../.."   # outputs/
G=tough-eval/v2/prelim/gate.mjs
STATE=tough-eval/v2/prelim/state/$LANE; mkdir -p $STATE
MUNITO=https://api.eu.munito.ai/inference/v1
MUN=(--executor openai --base-url $MUNITO --key-env MUNITO_API_KEY --max-output-tokens 64000)
: ${WAIT:=900} ${MAXTRIES:=40} ${IDLE:=120} ${HOURS:=60}
log() { echo "[$(date '+%a %H:%M:%S')] [$LANE] $*"; }
g() { node $G "$@" 2>/dev/null; }
retired() { [ -f $STATE/$1.gaveup ] || [ -f $STATE/$1.skipped ]; }

# A review run through tough-eval/run.mjs: started once under --retry-policy (P16), resumed with the same flags after.
# run_a <name> <setup> <suite> <variants> <concurrency> <model> [extra run.mjs flags...]
run_a() {
  local name=$1 setup=$2 suite=$3 variants=$4 conc=$5 model=$6; shift 6
  local d=$(g run-dir $name)
  if [ -z "$d" ]; then node tough-eval/run.mjs --suite $suite --variants $variants --name $name --setup $setup --model $model --effort medium --concurrency $conc --retry-policy "$@"
  else node tough-eval/run.mjs --suite $suite --variants $variants --resume "$d" --model $model --effort medium --concurrency $conc "$@"; fi
}
# A layer C contestant run (tough-eval/v2/layer-c/run.mjs). run_c <name> <setup> [flags...]
run_c() {
  local name=$1 setup=$2; shift 2; local d=$(g run-dir $name)
  if [ -z "$d" ]; then node tough-eval/v2/layer-c/run.mjs --name $name --setup $setup --effort medium --concurrency 3 --retry-policy "$@"
  else node tough-eval/v2/layer-c/run.mjs --resume "$d" --concurrency 3; fi
}

lane_main() {
  local pidf=$STATE/pid
  if [ -f $pidf ] && kill -0 $(cat $pidf) 2>/dev/null && [ "$(cat $pidf)" != "$$" ]; then log "already running as pid $(cat $pidf); exiting"; exit 1; fi
  echo $$ > $pidf
  log "lane start (pid $$), steps: $STEPS"
  local end=$(( $(date +%s) + HOURS * 3600 )) lastwait=0
  while (( $(date +%s) < end )); do
    local pending=0 ran=0 waiting=()
    for s in $STEPS; do
      if retired $s || ${s}_done; then continue; fi
      pending=1
      if ! ${s}_ready; then waiting+=($s); continue; fi
      local until=$(cat $STATE/$s.until 2>/dev/null || echo 0)
      if (( $(date +%s) < until )); then waiting+=("$s(backoff)"); continue; fi
      log "=== $s start"
      ${s}_run; local rc=$?
      if ${s}_done; then log "=== $s DONE (exit $rc)"; rm -f $STATE/$s.tries $STATE/$s.until
      else
        local n=$(( $(cat $STATE/$s.tries 2>/dev/null || echo 0) + 1 )); echo $n > $STATE/$s.tries
        echo $(( $(date +%s) + WAIT )) > $STATE/$s.until
        log "=== $s not done (exit $rc, try $n of $MAXTRIES); backing off ${WAIT}s"
        (( n >= MAXTRIES )) && { touch $STATE/$s.gaveup; log "=== $s GAVE UP after $n tries"; }
      fi
      ran=1; break
    done
    if (( ! pending )); then log "=== lane complete"; rm -f $pidf; return 0; fi
    if (( ! ran )); then
      (( $(date +%s) - lastwait >= 1800 )) && { log "waiting on: ${waiting[*]}"; lastwait=$(date +%s); }
      sleep $IDLE
    fi
  done
  log "=== lane stopped after $HOURS hours"; rm -f $pidf
}
