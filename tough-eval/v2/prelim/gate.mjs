// SPDX-License-Identifier: GPL-3.0-or-later
// Gates and done-checks for the preliminary v2 lanes (tough-eval/v2/prelim/*.zsh, 16 October 2026). Each question is
// answered from files on disk, so a lane can be killed and restarted at any time. Exit 0 = yes, 1 = no; `run-dir`,
// `scen-calls` and `tokens` print an answer instead. No model call is ever made here.
// Usage: node tough-eval/v2/prelim/gate.mjs <question> [args]
//   authored <author> <document> <side>     the author's batch has its .meta.json
//   applied <author>                        all four of the author's batches have .apply.json
//   pbread <family>                         the playbook read has a usable (or retried) answer for all four sides
//   verified-by <family>                    the other two authors are applied and every applied item of theirs carries
//                                           a verification record from <family>
//   own-verified <author>                   the author is applied and every applied item of theirs carries both other
//                                           families' records
//   all-verified                            verified-by for all three families
//   markups                                 markups.json exists (built after all-verified)
//   scen-calls <author>                     the author's non-blocked scenario call numbers (needs own-verified)
//   scen-authored <author> | scen-applied <author>
//   scen-verified-by <family> | all-scen-verified
//   run-dir <name>                          the run directory tough-eval/runs/*Z-<name> or *Z-v2c-<name>, if any
//   run-done <name>                         that run exists, has a result for every variant, and finishedAt
//   b-unique <name> <model> <prompt|product> no OTHER run on the ContractNLI test split has this model and prompt
//   control-done <judge>                    every control judgement (golden, empty) of <judge> is usable
//   validity                                results/v2/C/validity.json exists and is complete
//   judged <name>                           the layer C run <name> has its panel's judgements (and tiebreaks) on disk
//   tokens                                  Claude output tokens spent by the preliminary run so far
//   budget-ok <estimate> [<reserve>]        tokens + estimate + reserve <= PRELIM_CLAUDE_BUDGET (default 8,000,000)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const V2 = path.dirname(HERE); const EVAL = path.dirname(V2);
const RUNS = path.join(EVAL, 'runs'); const C_RESULTS = path.join(EVAL, 'results', 'v2', 'C');
const AUTHORS = ['opus', 'glm', 'deepseek'];
const SIDES = [['csa', 'customer'], ['csa', 'vendor'], ['nda', 'discloser'], ['nda', 'recipient']];
const j = f => JSON.parse(readFileSync(f, 'utf8'));
const items = () => (existsSync(path.join(V2, 'items.json')) ? j(path.join(V2, 'items.json')).items : []);
const applied = a => SIDES.every(([d, s]) => existsSync(path.join(V2, 'authoring', a, `${d}-${s}.apply.json`)));
const others = a => AUTHORS.filter(x => x !== a);
const live = it => it.status !== 'dropped';
const hasRec = (it, f) => (it.verification || []).some(r => r.family === f);
const verifiedBy = f => others(f).every(applied) && items().filter(i => live(i) && i.author !== f).every(i => hasRec(i, f));
const ownVerified = a => applied(a) && items().filter(i => live(i) && i.author === a).every(i => others(a).every(f => hasRec(i, f)));
const scenDir = a => path.join(V2, 'authoring', a, 'scenarios');
async function scenCalls(a) {
  const { scenarioPlan } = await import('../author.mjs');
  const c = {}; for (const i of items().filter(i => i.author === a && i.kind === 'deviation' && i.status === 'verified')) c[`${i.document}-${i.side}`] = (c[`${i.document}-${i.side}`] || 0) + 1;
  return scenarioPlan(c, a).filter(p => !p.blocked).map(p => ({ n: p.n, kind: p.kind }));
}
const pad = n => String(n).padStart(2, '0');
async function scenAuthored(a) { if (!ownVerified(a)) return false; return (await scenCalls(a)).every(p => existsSync(path.join(scenDir(a), `H${pad(p.n)}-${p.kind}.meta.json`))); }
async function scenApplied(a) {
  if (!(await scenAuthored(a))) return false;
  return (await scenCalls(a)).every(p => { const f = path.join(scenDir(a), `H${pad(p.n)}-${p.kind}.apply.json`); return existsSync(f) && ['applied', 'dropped'].includes(j(f).status); });
}
const scenarioFiles = () => { const d = path.join(V2, 'scenarios'); return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json') && !/\s/.test(f)).map(f => j(path.join(d, f))) : []; };
async function scenVerifiedBy(f) { for (const a of others(f)) if (!(await scenApplied(a))) return false; return scenarioFiles().filter(s => s.author !== f).every(s => (s.verification || []).some(v => v.family === f)); }

export function runDir(name) {
  if (!existsSync(RUNS)) return null;
  const d = readdirSync(RUNS).filter(x => x.endsWith(`Z-${name}`) || x.endsWith(`Z-v2c-${name}`)).sort();
  return d.length ? path.join(RUNS, d[0]) : null;
}
export function runDone(name) {
  const d = runDir(name); if (!d || !existsSync(path.join(d, 'manifest.json'))) return false;
  const m = j(path.join(d, 'manifest.json')); if (!m.finishedAt) return false;
  const have = new Set(readdirSync(path.join(d, 'results')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)));
  return (m.variants || []).every(v => have.has(v.id));
}
function bUnique(name, model, prompt) {
  const split = j(path.join(EVAL, 'contractnli', 'split.json')); const held = new Set(split.heldout);
  for (const d of existsSync(RUNS) ? readdirSync(RUNS) : []) {
    if (d.endsWith(`Z-${name}`)) continue; const f = path.join(RUNS, d, 'manifest.json'); if (!existsSync(f)) continue;
    const m = j(f); if (m.suiteName !== 'contractnli' || !(m.variants || []).some(v => held.has(v.id))) continue;
    const p = m.reviewPrompt ? path.basename(m.reviewPrompt, '.md') : 'product';
    if (m.model === model && p === prompt) { console.error(`test split already run for ${model} ${prompt}: ${d}`); return false; }
  }
  return true;
}
async function tasks() { return (await import('../layer-c/import.mjs')).loadTasks().tasks; }
async function controlDone(judge) {
  for (const t of await tasks()) for (const c of t.criteria) for (const o of ['golden', 'empty']) {
    const f = path.join(C_RESULTS, 'control', o, t.id, `${c.id}.${judge}.json`); if (!existsSync(f) || !j(f).ok) return false;
  }
  return true;
}
async function judged(name) {
  const d = runDir(name); if (!d) return false; const dir = path.join(C_RESULTS, 'judgements', path.basename(d)); const pf = path.join(dir, 'panel.json');
  if (!existsSync(pf)) return false; const panel = j(pf); const { needsTiebreak } = await import('../layer-c/panel.mjs');
  const rj = (t, c, k) => { const f = path.join(dir, t, `${c}.${k}.json`); return existsSync(f) ? j(f) : undefined; };
  for (const t of await tasks()) {
    const r = path.join(d, 'results', `C-${t.id}.json`); if (!existsSync(r) || !j(r).ok) continue; // failed reviews are not judged
    for (const c of t.criteria) {
      const a = rj(t.id, c.id, panel.judges[0]), b = rj(t.id, c.id, panel.judges[1]);
      if (!a?.ok || !b?.ok) return false;
      if (needsTiebreak(a, b) && !rj(t.id, c.id, panel.tiebreak)?.ok) return false;
    }
  }
  return true;
}

/** Claude output tokens spent by the preliminary run: prelim run traces with a Claude executor, Opus authoring,
 *  verification, scenario verification, and Opus judgements. */
export function claudeTokens() {
  let total = 0; const walk = (dir, pick) => { if (!existsSync(dir)) return; for (const f of readdirSync(dir)) { const p = path.join(dir, f); const st = statSync(p); if (st.isDirectory()) walk(p, pick); else pick(p); } };
  const out = u => Number(u?.output_tokens ?? 0) || 0;
  for (const d of existsSync(RUNS) ? readdirSync(RUNS) : []) {
    if (!/Z-(v2c-)?prelim-/.test(d)) continue; const mf = path.join(RUNS, d, 'manifest.json'); if (!existsSync(mf) || j(mf).executor !== 'claude') continue;
    walk(path.join(RUNS, d, 'traces'), p => { if (p.endsWith('.meta.json')) try { total += out(j(p).usage); } catch { /* partial */ } });
  }
  walk(path.join(V2, 'authoring', 'opus'), p => { if (!p.endsWith('.meta.json')) return; try { const m = j(p); for (const a of m.attempts || []) total += out(a.meta?.usage); if (m.meta) total += out(m.meta.usage); } catch { /* partial */ } });
  for (const v of ['verification', 'verification-scenarios']) walk(path.join(V2, v, 'opus'), p => { if (p.endsWith('.raw.json')) try { total += out(j(p).meta?.usage); } catch { /* partial */ } });
  walk(C_RESULTS, p => { if (p.endsWith('.opus.json')) try { total += out(j(p).usage); } catch { /* partial */ } });
  return total;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [q, ...a] = process.argv.slice(2); let ok;
  switch (q) {
    case 'authored': ok = existsSync(path.join(V2, 'authoring', a[0], `${a[1]}-${a[2]}.meta.json`)); break;
    case 'applied': ok = applied(a[0]); break;
    case 'pbread': ok = SIDES.every(([d, s]) => ['', '.retry'].some(t => existsSync(path.join(V2, 'playbook-read', a[0], `${d}-${s}${t}.raw.json`)))); break;
    case 'verified-by': ok = verifiedBy(a[0]); break;
    case 'own-verified': ok = ownVerified(a[0]); break;
    case 'all-verified': ok = AUTHORS.every(verifiedBy); break;
    case 'markups': ok = existsSync(path.join(V2, 'markups.json')); break;
    case 'scen-calls': console.log((await scenCalls(a[0])).map(p => p.n).join(' ')); process.exit(0);
    case 'scen-authored': ok = await scenAuthored(a[0]); break;
    case 'scen-applied': ok = await scenApplied(a[0]); break;
    case 'scen-verified-by': ok = await scenVerifiedBy(a[0]); break;
    case 'all-scen-verified': ok = true; for (const f of AUTHORS) if (!(await scenVerifiedBy(f))) ok = false; break;
    case 'run-dir': { const d = runDir(a[0]); if (d) console.log(d); process.exit(0); }
    case 'run-done': ok = runDone(a[0]); break;
    case 'b-unique': ok = bUnique(a[0], a[1], a[2]); break;
    case 'control-done': ok = await controlDone(a[0]); break;
    case 'validity': { const f = path.join(C_RESULTS, 'validity.json'); ok = existsSync(f) && j(f).complete === true; break; }
    case 'judged': ok = await judged(a[0]); break;
    case 'tokens': console.log(claudeTokens()); process.exit(0);
    case 'budget-ok': { const used = claudeTokens(), need = Number(a[0] || 0) + Number(a[1] || 0), cap = Number(process.env.PRELIM_CLAUDE_BUDGET || 8_000_000); ok = used + need <= cap; if (!ok) console.error(`budget: used ${used} + ${need} > ${cap}`); break; }
    default: console.error(`unknown question ${q}`); process.exit(2);
  }
  process.exit(ok ? 0 : 1);
}
