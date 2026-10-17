// SPDX-License-Identifier: GPL-3.0-or-later
// P10, apply: one author's layer H scenarios (written by author.mjs --scenario n, one per call, rounds as edit lists)
// checked and materialised into full scenario files (BENCHMARK-V2.md 11.4) that seed-record.mjs and score-h.mjs read.
//   Checks (lib/scenarios.mjs buildScenario): the kind, document and side the call asked for; the current item is the
//   author's own verified deviation; every round is the clean form of the same document with the round's edits
//   (`find` verbatim and unique) and never the clean form unchanged; no standard form; dates in order; every event quote
//   verbatim in its round; the expectations per kind (precedent: this counterparty's signed matter with an applied edit
//   under the item's rule, kept verbatim by a later round from them; concession: a dismissal under the rule; wrong
//   counterparty: another counterparty's matter on the rule and nothing on it in this counterparty's own; injection:
//   the canary phrase verbatim at its location in the current matter's earlier round, absent from the current document
//   and playbook, unique across the workspace's scenarios); counterparty names and aliases, matter names and covering-email senders
//   exactly from the scenario's roster entries (v2/roster.json: the clean document's parties, the other counterparties
//   assigned to the call) and .example domains (free text is left to the validators' real-name question); counterparties distinguishable from one another. Then the seed is loaded with the product's loader through
//   seed-record.mjs into the document store (every round a document, the current document last; decisions 190 and 191,
//   16 October 2026) and every document must read through the product's read_document.
//   A scenario that fails goes back to the author once (one further call, E2's runBatch with one attempt, the author's
//   scenario and every error quoted); a second failure drops it with the reasons. Nothing is backfilled.
//   Writes <root>/scenarios/H-<author>-<nn>.json (nn = the plan's call number), <prefix>.apply.json beside the
//   author's raw files, and <root>/scenarios-manifest.json (every scenario, dropped ones with reasons, quota warnings).
//   An unchanged scenario keeps its verification on a re-apply.
// Usage: node tough-eval/v2/apply-scenarios.mjs --author glm [--scenario 6] [--root v2] [--no-call]
//        node tough-eval/v2/apply-scenarios.mjs --manifest [--root v2]       (rebuild the manifest only)
//   --no-call writes the resubmission request (.resubmit.prompt.txt) instead of calling, and stops before writing.
import { existsSync, readdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AUTHORS, readJson, writeJson, parseArrayAnswer, sha256 } from './lib/common.mjs';
import { callModel } from './lib/call.mjs';
import { rootAbs, rootRel, withStoreLock } from './lib/store.mjs';
import { runBatch, scenarioPrompt, args } from './author.mjs';
import { buildScenario, currentContext, checkSet, loadRoster, scenarioId, norm } from './lib/scenarios.mjs';
import { openReviewStore } from './seed-record.mjs';

const pad = n => String(n).padStart(2, '0');
const scenarioDir = (root, author) => path.join(rootAbs(root), 'authoring', author, 'scenarios');
/** The author's scenario calls on disk: [{ n, prefix }] from H<nn>-<kind>.meta.json (resubmissions excluded). */
export function authoredCalls(root, author) {
  const dir = scenarioDir(root, author); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^H\d{2}-[a-z-]+\.meta\.json$/.test(f)).sort().map(f => ({ n: Number(f.slice(1, 3)), prefix: path.join(dir, f.replace(/\.meta\.json$/, '')) }));
}
const scenarioFiles = root => { const d = path.join(rootAbs(root), 'scenarios'); return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => path.join(d, f)) : []; };

/**
 * Load the built scenario into a fresh document store with the product's loader (seed-record.mjs: the matters and rounds
 * flattened into documents, decisions 190 and 191), as a review would; every document must read through the product's
 * read_document and the counterparty overview must answer. Returns what the store holds.
 */
export async function loadCheck(scenario, currentDoc) {
  const r = await openReviewStore({ scenario, document: currentDoc });
  try {
    const problems = [];
    const overview = await r.agentic.tools.call('get_counterparty_overview', {});
    if (overview.error) problems.push(`get_counterparty_overview failed: ${overview.error.message}`);
    const documents = [];
    for (const [documentId, ref] of r.docs) {
      const d = await r.agentic.tools.call('read_document', { documentId });
      if (d.error) { problems.push(`read_document ${documentId} (${ref.matterId} round ${ref.round}${ref.email ? ' email' : ''}) failed: ${d.error.message}`); continue; }
      documents.push({ documentId, matterId: ref.matterId, round: ref.round, email: ref.email, current: ref.current, signed: d.document.signed, paragraphs: d.totalParagraphs, notes: d.notes.length });
    }
    if (!r.currentId) problems.push('the current document is not in the store');
    return { problems, brief: r.agentic.brief, documents };
  } finally { await r.close(); }
}

/** Check and build one authored object; the product's loader runs only when the rules pass. */
export async function check(authored, { root, id, author, plan, roster, usedPhrases }) {
  let ctx = null; try { ctx = authored?.current?.itemId ? currentContext(root, authored.current.itemId) : null; } catch { ctx = null; }
  const b = buildScenario(authored, ctx, { id, author, plan, roster, usedPhrases });
  if (b.errors.length || !b.scenario) return { ...b, ctx };
  try { const l = await loadCheck(b.scenario, ctx.currentDoc); if (l.problems.length) b.errors.push(...l.problems.map(p => `the product's loader: ${p}`)); b.loaded = l; }
  catch (e) { b.errors.push(`the product's loader refused the seed: ${e.message}`); }
  return { ...b, ctx };
}

/** The one further call's request: the author's scenario and every error, to be written again whole. */
export function scenarioResubmission(authored, errors) {
  return { instruction: 'Your scenario cannot be used as written. Write it again, whole, meeting the specification and fixing every error listed. Return only a JSON array holding the one corrected scenario.', yourScenario: authored, errors };
}

/** Canary phrases of the workspace's other applied scenarios (normalised phrase -> scenario id). */
function phrasesExcept(root, id) {
  const m = new Map();
  for (const f of scenarioFiles(root)) { const s = readJson(f); if (s.id === id) continue; const p = s.expect?.injection?.canaryPhrase; if (p) m.set(norm(p), s.id); }
  return m;
}

/**
 * Apply call `n` of `author`'s scenarios. `call` (the model call) and `prompt` (scenarioPrompt) are injectable for
 * tests. Returns the apply record (also written to <prefix>.apply.json).
 */
export async function applyScenario({ author, n, root = 'v2', noCall = false, call = callModel, prompt = scenarioPrompt, roster = loadRoster() }) {
  const found = authoredCalls(root, author).find(c => c.n === n); if (!found) throw Error(`no scenario call ${n} of ${author} under ${rootRel(root)}/authoring/${author}/scenarios`);
  const { prefix } = found; const meta = readJson(`${prefix}.meta.json`); const plan = meta.plan || null;
  const id = scenarioId(author, n); const file = path.join(rootAbs(root), 'scenarios', `${id}.json`);
  const rec = { format: 'tough-eval-scenario-apply/1', id, author, call: n, plan, appliedAt: new Date().toISOString(), authoring: meta.status, status: null, attempt: null, errors: [], warnings: [] };
  const finish = (status, extra = {}) => {
    Object.assign(rec, { status }, extra);
    if (status === 'dropped' && existsSync(file)) rmSync(file);
    writeJson(`${prefix}.apply.json`, rec); withStoreLock(root, () => rebuildManifest(root)); return rec;
  };
  if (meta.status !== 'ok') return finish('dropped', { errors: ['the scenario call returned nothing usable after the P4 retries'] });
  const authored = parseArrayAnswer(readJson(path.join(path.dirname(prefix), meta.used)).raw)[0];
  const opts = { root, id, author, plan, roster, usedPhrases: phrasesExcept(root, id) };
  let b = await check(authored, opts), attempt = 1, used = authored, first = null;
  if (b.errors.length) {
    first = b.errors; const rp = `${prefix}.resubmit`;
    if (!existsSync(`${rp}.meta.json`)) {
      const req = scenarioResubmission(authored, b.errors);
      if (noCall) { writeFileSync(`${rp}.prompt.txt`, JSON.stringify(req, null, 1)); writeJson(`${prefix}.apply.json`, { ...rec, status: 'pending', errors: b.errors, warnings: b.warnings, pending: req }); return { ...rec, status: 'pending', errors: b.errors, pending: req }; }
      const { system, user } = prompt({ author, call: n, root });
      await runBatch({ who: author, system, user: JSON.stringify({ ...JSON.parse(user), resubmission: req }), prefix: rp, call, maxAttempts: 1,
        context: { kind: 'scenario-resubmission', author, plan, request: req, requestSha256: sha256(JSON.stringify(req)) },
        parse: raw => { const a = parseArrayAnswer(raw); if (a.length !== 1) throw Error(`expected one scenario, got ${a.length}`); return a; } });
    }
    const rm = readJson(`${rp}.meta.json`);
    if (rm.status !== 'ok') return finish('dropped', { attempt: 2, errors: first, errorsAfterResubmission: [`the resubmission was unusable: ${rm.attempts?.[0]?.parse?.error ?? 'no answer'}`], warnings: b.warnings });
    used = parseArrayAnswer(readJson(path.join(path.dirname(rp), rm.used)).raw)[0]; attempt = 2;
    b = await check(used, opts);
    if (b.errors.length) return finish('dropped', { attempt, errors: first, errorsAfterResubmission: b.errors, warnings: b.warnings });
  }
  const sc = { ...b.scenario, source: { call: n, attempt, raw: path.basename(attempt === 1 ? meta.used : `${path.basename(prefix)}.resubmit.raw.json`), authoredSha256: sha256(JSON.stringify(used)), ...(first ? { firstErrors: first } : {}) }, authored: used };
  // An unchanged scenario keeps its verification.
  if (existsSync(file)) { const old = readJson(file); if (old.source?.authoredSha256 === sc.source.authoredSha256 && JSON.stringify(old.seed) === JSON.stringify(sc.seed) && old.verification?.length) { sc.verification = old.verification; sc.status = old.status; } }
  const w = writeJson(file, sc);
  return finish('applied', { attempt, errors: first || [], warnings: b.warnings, file: path.relative(rootAbs(root), file), sha256: w.sha256, loaded: b.loaded });
}

/** <root>/scenarios-manifest.json from every apply record and scenario file (never inside scenarios/, which the suite reads whole). */
export function rebuildManifest(root = 'v2') {
  const recs = AUTHORS.flatMap(a => { const d = scenarioDir(root, a); return existsSync(d) ? readdirSync(d).filter(f => /^H\d{2}-[a-z-]+\.apply\.json$/.test(f)).sort().map(f => readJson(path.join(d, f))) : []; });
  const files = new Map(scenarioFiles(root).map(f => { const s = readJson(f); return [s.id, { s, file: f }]; }));
  const scenarios = recs.filter(r => r.status === 'applied' && files.has(r.id)).map(r => { const { s } = files.get(r.id);
    return { id: s.id, author: s.author, call: r.call, kind: s.kind, document: s.current.document, side: s.current.side, itemId: s.current.itemId, status: s.status, file: `${rootRel(root)}/scenarios/${s.id}.json`, sha256: sha256(readFileSync(files.get(r.id).file)), attempt: r.attempt,
      ...(s.expect?.injection ? { injection: s.expect.injection.type, canaryPhrase: s.expect.injection.canaryPhrase } : {}), verification: s.verification.map(v => ({ family: v.family, expectFollows: v.expectFollows, namesReal: v.namesReal ?? null })), warnings: r.warnings }; });
  const dropped = recs.filter(r => r.status === 'dropped').map(r => ({ id: r.id, author: r.author, call: r.call, plan: r.plan, attempt: r.attempt, errors: r.errors, errorsAfterResubmission: r.errorsAfterResubmission ?? null }));
  const pending = recs.filter(r => r.status === 'pending').map(r => ({ id: r.id, author: r.author, call: r.call }));
  const set = checkSet([...files.values()].map(x => x.s));
  const manifest = { format: 'tough-eval-scenarios-manifest/1', builtAt: new Date().toISOString(), counts: { applied: scenarios.length, verified: scenarios.filter(s => s.status === 'verified').length, contested: scenarios.filter(s => s.status === 'contested').length, dropped: dropped.length, pending: pending.length },
    scenarios, dropped, pending, byAuthor: set.byAuthor, warnings: set.warnings };
  writeJson(path.join(rootAbs(root), 'scenarios-manifest.json'), manifest);
  return manifest;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const o = args(process.argv.slice(2)); const root = o.root || 'v2';
  if (o.manifest) { console.log(JSON.stringify(rebuildManifest(root).counts)); process.exit(0); }
  if (!AUTHORS.includes(o.author)) { console.error(`--author must be one of ${AUTHORS.join(', ')}`); process.exit(2); }
  const calls = o.scenario ? [Number(o.scenario)] : authoredCalls(root, o.author).map(c => c.n);
  for (const n of calls) {
    const r = await applyScenario({ author: o.author, n, root, noCall: !!o['no-call'] });
    console.log(`${r.id} (${r.plan?.kind ?? '?'}, ${r.plan?.document ?? '?'} ${r.plan?.side ?? '?'}): ${r.status}${r.attempt ? `, attempt ${r.attempt}` : ''}`);
    for (const e of r.errors || []) console.log(`  error: ${e}`);
    for (const e of r.errorsAfterResubmission || []) console.log(`  error after resubmission: ${e}`);
    for (const w of r.warnings || []) console.log(`  warning: ${w}`);
  }
}
