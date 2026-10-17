#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Live pre-flight for eval v2: a handful of real calls through the same scripts the test runs use, before the expensive
# runs start. Run it from a terminal where the Claude CLI is signed in (parts 1 to 4) and MUNITO_API_KEY is set in the
# environment or contract-review/.env (part 5). No test item is used: layer A and H use the synthetic fixture, layer B
# one DEVELOPMENT-split NDA (checked against contractnli/split.json before the call), layer C one criterion on the
# attorneys' golden redline (the panel validity control's input, not a contestant review).
#   1. Opus 5.5, product prompt at medium effort, on one layer A fixture item (run.mjs, not --test); then the plain prompt
#   2. Opus 5.5 agentic on one layer H fixture scenario over its seeded record
#   3. Opus 5.5 on one layer B development NDA
#   4. one Opus judgement of one layer C criterion on the golden output (layer-c/judge.mjs), served model recorded
#   5. GLM-5.3 Flash and DeepSeek V4 Flash (Munito) on the same layer A fixture item, max output 64,000 as every
#      Munito run since R22 (at 16,000 GLM stopped at the limit on this item in the first pre-flight)
# After each: no canary in traces/*/review.user.json, the side's prompt filled in (review.system.txt), servedModel and
# errorClass recorded, the item scored (v2/preflight-check.mjs). Ends with PASS/FAIL and the total token usage.
# Cost: five Opus reviews of tiny documents (the fixture CSA is ten paragraphs, the NDA about 2,300 characters) and one
# judgement (about 22k input tokens); two Munito reviews.
# Every run directory is moved out of tough-eval/runs into tough-eval/v2/dev/preflight-<date>/ (kept; --discard deletes
# it at the end), so nothing here can be mistaken for a test run.
# Usage: bash tough-eval/v2/preflight-live.sh [--parts 1,2,3,4,5] [--discard]
#   e.g. --parts 5 runs only the Munito part (what the agent shell can run); --parts 1,2,3,4 only the Claude parts.
set -u
cd "$(dirname "$0")/../.." || exit 2   # outputs/
PARTS="1,2,3,4,5"; DISCARD=0
while [ $# -gt 0 ]; do case "$1" in --parts) PARTS="$2"; shift 2;; --discard) DISCARD=1; shift;; *) echo "unknown argument $1"; exit 2;; esac; done
has() { case ",$PARTS," in *",$1,"*) return 0;; *) return 1;; esac; }

ITEM=A-opus-csa-customer-01          # layer A fixture item (v2a-fixture), CSA customer side
SCENARIO=H-opus-01                   # layer H fixture scenario: relevant precedent, two earlier matters
NDA=N456                             # layer B: the smallest development NDA with a labelled departure
LC_TASK=redline-s3-t4-g02a; LC_CRITERION=C-s3-03   # layer C: one criterion, golden output
OPUS=claude-opus-5-5; MUNITO=https://api.eu.munito.ai/inference/v1
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ); OUT="tough-eval/v2/dev/preflight-${STAMP%%T*}"; mkdir -p "$OUT"
SUMMARY="$OUT/summary-$STAMP.txt"; : > "$SUMMARY"
echo "pre-flight $STAMP, parts $PARTS, into $OUT"

# One review through run.mjs; moves the run directory into $OUT/<label>-<stamp> and checks it.
review() { # label layer extra-check-flags -- run.mjs args...
  local label="$1" layer="$2" flags="$3"; shift 4
  echo; echo "== $label"
  local log; log=$(node tough-eval/run.mjs --concurrency 1 --name "preflight-$label" "$@" 2>&1); echo "$log" | tail -3
  local dir; dir=$(echo "$log" | sed -n 's/^done //p' | tail -1)
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then echo "FAIL [$label] run.mjs did not finish :: $(echo "$log" | grep -m1 -E 'Error|refused' || echo 'no run directory')" | tee -a "$SUMMARY"; return; fi
  local dest="$OUT/$label-$STAMP"; mv "$dir" "$dest"
  # shellcheck disable=SC2086
  node tough-eval/v2/preflight-check.mjs review "$dest" --label "$label" --layer "$layer" $flags --summary "$SUMMARY"
}

if has 1; then
  review opus-product A "" -- --suite v2a-fixture --variants "$ITEM" --model "$OPUS" --effort medium --setup preflight-opus-5.5-product
  review opus-plain A "--plain" -- --suite v2a-fixture --variants "$ITEM" --model "$OPUS" --effort medium --setup preflight-opus-5.5-plain --review-prompt tough-eval/arms/plain.md
fi
if has 2; then
  review opus-agentic H "" -- --suite v2h-fixture --variants "$SCENARIO" --model "$OPUS" --effort medium --setup preflight-opus-5.5-agentic
fi
if has 3; then
  if node -e 'const s=require("./tough-eval/contractnli/split.json");const id=process.argv[1];process.exit(s.development.includes(id)&&!s.heldout.includes(id)?0:1)' "$NDA"; then
    review opus-nda-dev B "" -- --suite contractnli --variants "$NDA" --model "$OPUS" --effort medium --setup preflight-opus-5.5-product
  else echo "FAIL [opus-nda-dev] $NDA is not a development-split NDA: not run" | tee -a "$SUMMARY"; fi
fi
if has 4; then
  echo; echo "== opus-judge-c"
  JDIR="$OUT/judge-opus-$STAMP"
  node --input-type=module -e '
    const [dir, task, criterion] = process.argv.slice(1);
    const { judgeAll, judgementPath } = await import("./tough-eval/v2/layer-c/judge.mjs");
    const { loadTasks } = await import("./tough-eval/v2/layer-c/import.mjs");
    const tasks = loadTasks().tasks; const t = tasks.find(x => x.id === task); const c = t && t.criteria.find(x => x.id === criterion);
    if (!c) { console.error(`no criterion ${criterion} in ${task}`); process.exit(1); }
    await judgeAll({ items: [{ task, criterion: c, judge: "opus" }], outputKey: "preflight-golden", source: "golden", dir, tasks, concurrency: 1, transportRetries: 0 });
    console.log(judgementPath(dir, task, criterion, "opus"));' "$JDIR" "$LC_TASK" "$LC_CRITERION" 2>&1 | tail -2
  node tough-eval/v2/preflight-check.mjs judge "$JDIR/$LC_TASK/$LC_CRITERION.opus.json" --label opus-judge-c --summary "$SUMMARY"
fi
if has 5; then
  review glm-product A "" -- --suite v2a-fixture --variants "$ITEM" --executor openai --base-url "$MUNITO" --key-env MUNITO_API_KEY --model zai-org/glm-5.3-flash --max-output-tokens 64000 --setup preflight-glm-5.3-flash
  review deepseek-product A "" -- --suite v2a-fixture --variants "$ITEM" --executor openai --base-url "$MUNITO" --key-env MUNITO_API_KEY --model deepseek-ai/deepseek-v4-flash --max-output-tokens 64000 --setup preflight-deepseek-v4-flash
fi

echo; echo "== summary ($SUMMARY)"
node tough-eval/v2/preflight-check.mjs summary "$SUMMARY"; status=$?
if [ $DISCARD -eq 1 ]; then rm -rf "$OUT"; echo "discarded $OUT"; else echo "kept $OUT"; fi
exit $status
