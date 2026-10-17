#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
# Overnight watchdog (16 October 2026): every 10 minutes, (re)start each preliminary lane. A lane already running exits
# at once (one instance per lane, state/<lane>/pid), and a lane with nothing left to do logs "lane complete" and exits,
# so restarting is always safe; a lane that died (a crash, a killed shell) resumes where it stopped.
# Lanes listed in WATCH_LANES (default below); PRELIM_CLAUDE_BUDGET is passed through to the Claude lanes.
# Start: nohup caffeinate -i zsh tough-eval/v2/prelim/watchdog.zsh >> tough-eval/v2/prelim/logs/watchdog.log 2>&1 &
# Stop:  kill $(cat tough-eval/v2/prelim/state/watchdog/pid)
cd "${0:A:h}/../../.." || exit 2   # outputs/
P=tough-eval/v2/prelim
mkdir -p $P/state/watchdog; echo $$ > $P/state/watchdog/pid
: ${WATCH_LANES:="claude-gates claude-runs munito-runs:glm munito-runs:deepseek"}
: ${EVERY:=600}
while true; do
  for l in ${=WATCH_LANES}; do
    name=${l%%:*}; arg=${l#*:}; [ "$arg" = "$l" ] && arg=""
    script=$P/lane-$name.zsh; [ -f $script ] || continue
    log=$P/logs/$name${arg:+-$arg}.log
    nohup caffeinate -i zsh $script ${arg:+$arg} >> $log 2>&1 &
  done
  echo "[$(date '+%a %H:%M:%S')] watchdog: lanes poked"
  sleep $EVERY
done
