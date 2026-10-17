#!/bin/zsh
# run-parallel.zsh <pass-k/run.sh> <family> <jobs>: runs the family's lines of a calibration run.sh, <jobs> at a time, STAGGER seconds apart (17 October 2026; how P8 passes 1 and 2 were run: opus 4 with STAGGER=20, deepseek 2, glm 2; failed reviews moved to results-failed/ and run again, up to three attempts).
RUN=$1; FAM=$2; JOBS=${3:-2}
cd "$(dirname "$0")/../../.." || exit 1   # the folder that holds contract-review/ and tough-eval/
export MUNITO_API_KEY="${MUNITO_API_KEY:-$(grep ^MUNITO_API_KEY= contract-review/.env | cut -d= -f2-)}"
only=$FAM
done_ok() { [ -f "$1" ] && grep -q '"ok": true' "$1"; }
lines=("${(@f)$(grep "\"\$only\" = $FAM ]" $RUN)}")
pids=()
for l in $lines; do
  while :; do
    live=(); for p in $pids; do kill -0 $p 2>/dev/null && live+=($p); done; pids=($live)
    (( ${#pids} < JOBS )) && break; sleep 5
  done
  eval "$l" & pids+=($!)
  sleep ${STAGGER:-2}
done
wait
echo "$FAM done $(date -u +%H:%M)"
