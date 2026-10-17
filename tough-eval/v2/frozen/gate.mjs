// SPDX-License-Identifier: GPL-3.0-or-later
// Done-checks for the frozen layer A lanes (lane-frozen-a.zsh, 17 October 2026), answered from files on disk so a lane
// can be killed and restarted at any time. Exit 0 = yes, 1 = no; run-dir prints the answer. No model call.
//   run-dir <name>     the run directory tough-eval/runs/*Z-<name>, if any (the earliest)
//   run-done <name>    that run exists, has a result for every variant, and finishedAt
//   claude-ok          the Claude CLI reports loggedIn: true (claude auth status); a lane pauses its Opus steps otherwise
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../runs');
const j = f => JSON.parse(readFileSync(f, 'utf8'));
export function runDir(name) {
  if (!existsSync(RUNS)) return null; const d = readdirSync(RUNS).filter(x => x.endsWith(`Z-${name}`)).sort();
  return d.length ? path.join(RUNS, d[0]) : null;
}
export function runDone(name) {
  const d = runDir(name); if (!d || !existsSync(path.join(d, 'manifest.json'))) return false;
  const m = j(path.join(d, 'manifest.json')); if (!m.finishedAt) return false;
  const have = new Set(readdirSync(path.join(d, 'results')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)));
  return (m.variants || []).every(v => have.has(v.id));
}
export function claudeOk() {
  try { return JSON.parse(execFileSync(process.env.CLAUDE_BIN || 'claude', ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 })).loggedIn === true; } catch { return false; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [q, a] = process.argv.slice(2);
  if (q === 'run-dir') { const d = runDir(a); if (d) console.log(d); process.exit(d ? 0 : 1); }
  if (q === 'run-done') process.exit(runDone(a) ? 0 : 1);
  if (q === 'claude-ok') process.exit(claudeOk() ? 0 : 1);
  console.error('usage: gate.mjs run-dir|run-done <name> | claude-ok'); process.exit(2);
}
