#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# Stop a preliminary lane and everything it started (run.mjs, review-one, author/verify/judge calls), by walking the
# process tree from the lane's pid (state/<lane>/pid). Restart the lane with its start command (STATUS.md); it resumes.
# Usage: zsh tough-eval/v2/prelim/stop.zsh <lane>|all     e.g. claude-runs, munito-runs-glm
cd "${0:A:h}"
tree() { local p=$1; for c in $(pgrep -P $p); do tree $c; done; echo $p; }
lanes=(${@:#all}); [[ $1 == all ]] && lanes=(${(f)"$(ls state)"})
for l in $lanes; do
  f=state/$l/pid; [ -f $f ] || { echo "$l: no pid file"; continue; }
  p=$(cat $f); if ! kill -0 $p 2>/dev/null; then echo "$l: not running"; rm -f $f; continue; fi
  pids=($(tree $p)); kill $pids 2>/dev/null; rm -f $f; echo "$l: stopped (${#pids} processes)"
done
