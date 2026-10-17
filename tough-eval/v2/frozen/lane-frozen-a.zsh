#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# FROZEN layer A lanes (17 October 2026, tag bench-v2.0-a; v2/frozen.json with layers ["A"]). Every run is started with
# `run.mjs --test` (it refuses unless HEAD is the tag's commit and every frozen file hashes as recorded; the retry policy
# of P16 is on: malformed output retried at once up to three attempts, usage limits and transport errors every 15
# minutes until the window closes) and resumed with --test after a restart. Run names frozen-A-<setup>.
#   claude   1. frozen-A-opus-5.5-product  Opus 5.5 medium, product prompt (contract-review/prompts/review.md), concurrency 4
#            2. frozen-A-opus-5.5-plain    Opus 5.5 medium, plain prompt (arms/plain.md, side-filled), concurrency 4
#            Workers start STAGGER_MS apart (default 8 s). Before each Opus step the Claude CLI's sign-in is checked
#            (gate.mjs claude-ok); signed out, the step waits without spending a try (sign in from a terminal: claude
#            auth login) and the lane logs it every 30 minutes.
#   munito   1. frozen-A-deepseek-v4-flash-product  (CONC_DEEPSEEK, default 4: no 429 at 4 concurrent Munito requests in P8, 17 October)
#            2. frozen-A-glm-5.3-flash-product      (CONC_GLM, default 2)
#            3. frozen-A-mistral-small-4-product    (CONC_MISTRAL, default 2)
#            through https://api.eu.munito.ai/inference/v1, key MUNITO_API_KEY (environment or contract-review/.env),
#            --max-output-tokens 64000; product prompt for every open model (no P13 prompt choice: frozen.json
#            promptPerSetup fixes product).
# Variants: VARIANTS (default verified: every verified single item and markup, as the preliminary run; `all` adds the
# contested items, reported apart by profile.mjs as allItems).
# A step not done backs off WAIT seconds (900) and gives up after MAXTRIES (400) tries (state/<lane>/<step>.gaveup).
# Start (from outputs/), once the tag exists and HEAD is the tagged commit:
#   mkdir -p tough-eval/v2/frozen/logs; nohup caffeinate -i zsh tough-eval/v2/frozen/lane-frozen-a.zsh claude >> tough-eval/v2/frozen/logs/claude.log 2>&1 &
#   mkdir -p tough-eval/v2/frozen/logs; nohup caffeinate -i zsh tough-eval/v2/frozen/lane-frozen-a.zsh munito >> tough-eval/v2/frozen/logs/munito.log 2>&1 &
# Stop: zsh tough-eval/v2/frozen/stop.zsh claude|munito|all   (resumes when started again)
# Report: node tough-eval/v2/frozen/report.mjs   (frozen-A runs only; writes v2/frozen/REPORT.md)
S=${1:-}; [[ $S == claude || $S == munito ]] || { echo "usage: lane-frozen-a.zsh claude|munito"; exit 2; }
cd "${0:A:h}/../../.." || exit 2   # outputs/
LANE=frozen-a-$S; G=tough-eval/v2/frozen/gate.mjs
STATE=tough-eval/v2/frozen/state/$LANE; mkdir -p $STATE tough-eval/v2/frozen/logs
: ${WAIT:=900} ${MAXTRIES:=400} ${IDLE:=120} ${HOURS:=72} ${VARIANTS:=verified} ${STAGGER_MS:=8000}
: ${CONC_OPUS:=4} ${CONC_DEEPSEEK:=4} ${CONC_GLM:=2} ${CONC_MISTRAL:=2}
MUNITO=https://api.eu.munito.ai/inference/v1
MUN=(--executor openai --base-url $MUNITO --key-env MUNITO_API_KEY --max-output-tokens 64000)
OPUS=claude-opus-5-5; PLAIN=tough-eval/arms/plain.md
log() { echo "[$(date '+%a %H:%M:%S')] [$LANE] $*"; }
g() { node $G "$@" 2>/dev/null; }
retired() { [ -f $STATE/$1.gaveup ]; }

# run_a <name> <setup> <concurrency> <model> [extra run.mjs flags...]: started once under --test, resumed with --test.
run_a() {
  local name=$1 setup=$2 conc=$3 model=$4; shift 4
  local d=$(g run-dir $name)
  if [ -z "$d" ]; then node tough-eval/run.mjs --test --suite v2a --variants $VARIANTS --name $name --setup $setup --model $model --effort medium --concurrency $conc "$@"
  else node tough-eval/run.mjs --test --suite v2a --variants $VARIANTS --resume "$d" --model $model --effort medium --concurrency $conc "$@"; fi
}

if [[ $S == claude ]]; then
  STEPS=(opus_product opus_plain)
  opus_product_done() { g run-done frozen-A-opus-5.5-product; }; opus_product_ready() { g claude-ok; }
  opus_product_run() { run_a frozen-A-opus-5.5-product opus-5.5-product $CONC_OPUS $OPUS --stagger-ms $STAGGER_MS; }
  opus_plain_done() { g run-done frozen-A-opus-5.5-plain; }; opus_plain_ready() { g run-done frozen-A-opus-5.5-product && g claude-ok; }
  opus_plain_run() { run_a frozen-A-opus-5.5-plain opus-5.5-plain $CONC_OPUS $OPUS --stagger-ms $STAGGER_MS --review-prompt $PLAIN; }
else
  STEPS=(deepseek glm mistral)
  deepseek_done() { g run-done frozen-A-deepseek-v4-flash-product; }; deepseek_ready() { true; }
  deepseek_run() { run_a frozen-A-deepseek-v4-flash-product deepseek-v4-flash-product $CONC_DEEPSEEK deepseek-ai/deepseek-v4-flash $MUN --stagger-ms 3000; }
  glm_done() { g run-done frozen-A-glm-5.3-flash-product; }; glm_ready() { g run-done frozen-A-deepseek-v4-flash-product || retired deepseek; }
  glm_run() { run_a frozen-A-glm-5.3-flash-product glm-5.3-flash-product $CONC_GLM zai-org/glm-5.3-flash $MUN --stagger-ms 3000; }
  mistral_done() { g run-done frozen-A-mistral-small-4-product; }; mistral_ready() { { g run-done frozen-A-glm-5.3-flash-product || retired glm; }; }
  mistral_run() { run_a frozen-A-mistral-small-4-product mistral-small-4-product $CONC_MISTRAL mistralai/mistral-small-4-119b-2603 $MUN --stagger-ms 3000; }
fi

# Fail fast if the checkout is not the frozen one (otherwise every step would be refused and retried for hours).
if ! node tough-eval/v2/check-frozen.mjs --require-tag > $STATE/frozen-check.txt 2>&1; then log "frozen check failed; not starting:"; cat $STATE/frozen-check.txt; exit 1; fi
log "$(grep -E '^tag|passed' $STATE/frozen-check.txt | tr '\n' ' ')"

# The loop of prelim/lane.zsh: run the first step not done, ready and not backing off; re-read priorities after each.
pidf=$STATE/pid
if [ -f $pidf ] && kill -0 $(cat $pidf) 2>/dev/null && [ "$(cat $pidf)" != "$$" ]; then log "already running as pid $(cat $pidf); exiting"; exit 1; fi
echo $$ > $pidf
log "lane start (pid $$), steps: $STEPS, variants: $VARIANTS"
end=$(( $(date +%s) + HOURS * 3600 )); lastwait=0
while (( $(date +%s) < end )); do
  pending=0; ran=0; waiting=()
  for s in $STEPS; do
    if retired $s || ${s}_done; then continue; fi
    pending=1
    if ! ${s}_ready; then waiting+=($s); continue; fi
    until=$(cat $STATE/$s.until 2>/dev/null || echo 0)
    if (( $(date +%s) < until )); then waiting+=("$s(backoff)"); continue; fi
    log "=== $s start"
    ${s}_run; rc=$?
    if ${s}_done; then log "=== $s DONE (exit $rc)"; rm -f $STATE/$s.tries $STATE/$s.until
    else
      n=$(( $(cat $STATE/$s.tries 2>/dev/null || echo 0) + 1 )); echo $n > $STATE/$s.tries
      echo $(( $(date +%s) + WAIT )) > $STATE/$s.until
      log "=== $s not done (exit $rc, try $n of $MAXTRIES); backing off ${WAIT}s"
      (( n >= MAXTRIES )) && { touch $STATE/$s.gaveup; log "=== $s GAVE UP after $n tries"; }
    fi
    ran=1; break
  done
  if (( ! pending )); then log "=== lane complete"; rm -f $pidf; exit 0; fi
  if (( ! ran )); then
    (( $(date +%s) - lastwait >= 1800 )) && { log "waiting on: ${waiting[*]}"; lastwait=$(date +%s); }
    sleep $IDLE
  fi
done
log "=== lane stopped after $HOURS hours"; rm -f $pidf
