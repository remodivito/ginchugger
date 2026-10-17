// SPDX-License-Identifier: GPL-3.0-or-later
// P10, verification of layer H scenarios by the two families that did not write them (BENCHMARK-V2.md section 8, P10),
// beside verify.mjs (items), which it leaves unchanged.
//   A validator family receives each other-author scenario in its own call (P10 counts 20 verification calls per
//   family), in an order shuffled by hash and labelled Y01, Y02, ... (never by id, which names the author), with what
//   changed in the current document and its rule, the record as edit lists with each edited paragraph as it reads
//   (the materialised quotes, not whole documents), the review events, the kind's correct behaviour in words and
//   `expect` (lib/scenarios.mjs presentScenario), and two questions (prompts/verify-scenario.md): does `expect` follow
//   from the playbook and the seed, for the stated kind? And (added 16 October 2026, decision 176, with the fixed name
//   roster in place of the blocklist) does the scenario name a real company, product or person (`namesReal`)?
//   A reply that cannot be read is retried once with the error quoted; still unread, the record is
//   { answered: false, reasons: "no usable reply" }. A scenario is verified when both other families answered yes
//   and neither said it names a real company, product or person; contested on any no, real name or missing answer (settled by one no), kept and never repaired; reported in
//   <root>/verification-scenarios/summary.json and a generated block of <root>/ERRATA.md.
// Usage: node tough-eval/v2/verify-scenarios.mjs --family opus|glm|deepseek [--scenarios H-glm-06,...] [--root v2]
//        node tough-eval/v2/verify-scenarios.mjs --report [--root v2]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AUTHORS, V2, readJson, writeJson, parseObjectAnswer, byHash } from './lib/common.mjs';
import { callModel, MODELS } from './lib/call.mjs';
import { rootAbs, withStoreLock } from './lib/store.mjs';
import { currentContext, presentScenario } from './lib/scenarios.mjs';
import { rebuildManifest } from './apply-scenarios.mjs';
import { args } from './author.mjs';

export const SCENARIO_PROMPT = path.join(V2, 'prompts/verify-scenario.md');
const pad = n => String(n).padStart(2, '0');
const scenarioFiles = root => { const d = path.join(rootAbs(root), 'scenarios'); return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => path.join(d, f)) : []; };

/** The answer object of a reply, checked: { ref, follows: boolean, namesReal: boolean or null when missing, reasons }. Throws with the reason otherwise. */
export function readAnswer(raw, ref) {
  const a = parseObjectAnswer(raw); const x = a && Array.isArray(a.answers) && a.answers.length === 1 ? a.answers[0] : a;
  if (typeof x.follows !== 'boolean') throw Error('The answer has no "follows": true or false.');
  if (x.ref !== undefined && x.ref !== ref) throw Error(`The answer is for ${JSON.stringify(x.ref)}, not ${ref}.`);
  return { follows: x.follows, namesReal: typeof x.namesReal === 'boolean' ? x.namesReal : null, reasons: String(x.reasons ?? '') };
}
/** The stored record (11.4 verification entry). */
export const toScenarioRecord = (family, a) => (a ? { family, answered: true, expectFollows: a.follows, namesReal: a.namesReal ?? null, reasons: a.reasons } : { family, answered: false, expectFollows: null, namesReal: null, reasons: 'no usable reply' });
/** verified when both other families answered yes; contested on any no, a real name (namesReal true) or an unanswered
 *  record; applied while one is missing. A missing namesReal (null, or a record made before the question) does not contest. */
export function decideScenario(sc) {
  const recs = AUTHORS.filter(a => a !== sc.author).map(f => (sc.verification || []).find(r => r.family === f));
  if (recs.some(r => r && !(r.answered === true && r.expectFollows === true && r.namesReal !== true))) return 'contested';
  if (recs.some(r => !r)) return 'applied';
  return 'verified';
}

/** One scenario, one call, one retry on an unreadable reply. Raw replies under <dir>/<ref>[.retry].raw.json. */
export async function verifyOne({ family, presented, dir, call = callModel }) {
  const system = readFileSync(SCENARIO_PROMPT, 'utf8'); const ref = presented.ref;
  const send = async (tag, note = '') => {
    const user = JSON.stringify({ scenario: presented }) + note;
    const r = await call({ who: family, system, user, name: `${ref}${tag}` });
    let answer = null, error = null; try { answer = readAnswer(r.raw, ref); } catch (e) { error = e.message; }
    writeJson(path.join(dir, `${ref}${tag}.raw.json`), { format: 'tough-eval-verify-scenario-raw/1', family, model: MODELS[family]?.model ?? null, ref, raw: r.raw, reasoning: r.reasoning || '', meta: r.meta, parse: { ok: !error, error } });
    return { answer, error, meta: r.meta };
  };
  const first = await send('');
  if (first.answer) return first;
  return send('.retry', `\n\nYour previous answer could not be read: ${first.error} Return only the JSON object the instructions ask for.`);
}

export async function verifyScenarios({ family, root = 'v2', only = null, call = callModel }) {
  let files = scenarioFiles(root).map(f => ({ f, s: readJson(f) })).filter(x => x.s.author !== family);
  if (only) files = files.filter(x => only.includes(x.s.id));
  const order = byHash(files, `v2-verify-h:${family}:`, x => x.s.id);
  const dir = path.join(rootAbs(root), 'verification-scenarios', family);
  const refs = Object.fromEntries(order.map((x, k) => [`Y${pad(k + 1)}`, x.s.id]));
  writeJson(path.join(dir, 'refs.json'), { format: 'tough-eval-verify-refs/1', family, refs });
  const out = [];
  for (const [k, { f, s }] of order.entries()) {
    const ref = `Y${pad(k + 1)}`;
    // Resumable (preliminary run, 16 October 2026): a scenario that already carries this family's record is not asked again.
    if ((readJson(f).verification || []).some(v => v.family === family)) continue;
    const ctx = currentContext(root, s.current.itemId);
    const r = await verifyOne({ family, presented: presentScenario(s, ctx, s.authored, ref), dir, call });
    const rec = { ...toScenarioRecord(family, r.answer), model: r.meta?.servedModel ?? MODELS[family]?.model ?? null };
    // Re-read under the store lock before writing: the other families verify the same file from other lanes.
    withStoreLock(root, () => { const now = readJson(f);
      now.verification = [...(now.verification || []).filter(v => v.family !== family), rec]; now.status = decideScenario(now);
      writeJson(f, now); out.push({ id: now.id, ref, ...rec, status: now.status }); });
  }
  withStoreLock(root, () => rebuildManifest(root)); report(root);
  return out;
}

/** Contested scenarios and the contest rate per author: summary.json and a generated ERRATA.md block. */
export function report(root = 'v2') {
  const all = scenarioFiles(root).map(f => readJson(f));
  const by = Object.fromEntries(AUTHORS.map(a => { const mine = all.filter(s => s.author === a); const done = mine.filter(s => ['verified', 'contested'].includes(s.status)); const c = done.filter(s => s.status === 'contested').length;
    return [a, { applied: mine.length, decided: done.length, verified: done.length - c, contested: c, contestRate: done.length ? +(c / done.length).toFixed(3) : null }]; }));
  const contested = all.filter(s => s.status === 'contested').map(s => ({ id: s.id, kind: s.kind, verification: s.verification }));
  writeJson(path.join(rootAbs(root), 'verification-scenarios', 'summary.json'), { format: 'tough-eval-verify-scenarios-summary/1', at: new Date().toISOString(), byAuthor: by, contested });
  const lines = ['<!-- contested-scenarios:start (generated by verify-scenarios.mjs; do not edit inside this block) -->', '', `Contested layer H scenarios (P10), ${new Date().toISOString().slice(0, 10)}. Kept in the set, never repaired.`, ''];
  for (const c of contested) { lines.push(`- **${c.id}** (${c.kind})`); for (const r of c.verification) lines.push(`  - ${r.family}: ${r.answered ? `expect follows ${r.expectFollows}${r.namesReal === true ? ', names a real company, product or person' : ''}` : 'no usable reply'}. ${String(r.reasons || '').replace(/\s+/g, ' ').trim()}`); }
  if (!contested.length) lines.push('None so far.');
  lines.push('', '<!-- contested-scenarios:end -->');
  const f = path.join(rootAbs(root), 'ERRATA.md'); let md = existsSync(f) ? readFileSync(f, 'utf8') : '# Errata\n\nDated entries: contested items (with validators\' reasons), the layer B label audit, and any scoring fault found after release with its effect on published numbers (BENCHMARK-V2.md 11.10).\n\n';
  md = /<!-- contested-scenarios:start/.test(md) ? md.replace(/<!-- contested-scenarios:start[\s\S]*?<!-- contested-scenarios:end -->/, lines.join('\n')) : md.trimEnd() + '\n\n' + lines.join('\n') + '\n';
  writeFileSync(f, md);
  return { byAuthor: by, contested: contested.length };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const o = args(process.argv.slice(2)); const root = o.root || 'v2';
  if (o.report) { console.log(JSON.stringify(report(root), null, 1)); process.exit(0); }
  if (!AUTHORS.includes(o.family)) { console.error(`--family must be one of ${AUTHORS.join(', ')}`); process.exit(2); }
  const r = await verifyScenarios({ family: o.family, root, only: o.scenarios ? String(o.scenarios).split(',') : null });
  console.table(r.map(x => ({ id: x.id, ref: x.ref, answered: x.answered, expectFollows: x.expectFollows, namesReal: x.namesReal, status: x.status })));
  for (const x of r) console.log(`${x.id}: ${x.reasons}`);
}
