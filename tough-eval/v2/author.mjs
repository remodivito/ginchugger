// SPDX-License-Identifier: GPL-3.0-or-later
// P4 (layer A authoring) and P10 (layer H scenario authoring): one batch per call, recorded like a review.
//   Layer A: one call per author, document and side. The author receives the authoring spec (AUTHORING-SPEC.md from
//   "Instructions to the author" to the end of "Rules for the fields", word for word), the side, the playbook for that
//   side and the clean document (canary removed). The raw answer is stored verbatim with its metadata (11.1):
//   <root>/authoring/<author>/<document>-<side>.raw.json and .meta.json. An unparseable answer is retried once with the
//   parse error quoted (.retry.raw.json); a second failure is recorded and the batch is asked for once more in a fresh
//   call (.fresh.raw.json); if that fails too the batch is recorded as missing (P4, E-67). A call that spends its whole
//   output budget reasoning (empty answer, finish "length") is recorded as such, and the retry asks for brief reasoning.
//   Layer H: one scenario per call (E-36, E-61), rounds as edit lists against the clean form. `--scenario <n>` runs
//   call n of the author's fixed plan of ten (kinds 3/3/2/2, five per document, at least two per side, with the P10
//   fallback where the author has fewer than two verified deviations on a side). Each call is assigned its names from
//   the fixed roster (v2/roster.json; amended 16 October 2026, decision 176): the counterparty under review and our side
//   are the parties the clean document names; two other counterparties per call are drawn by hash of the scenario id,
//   never reused across the author's ten calls (lib/scenarios.mjs assignOthers). The prompt gives exactly those names.
// Usage:
//   node tough-eval/v2/author.mjs --author opus|glm|deepseek --document csa|nda --side customer|vendor|discloser|recipient [--root v2] [--dry-run]
//   node tough-eval/v2/author.mjs --author opus --scenario 1..10 [--root v2] [--dry-run]
//   node tough-eval/v2/author.mjs --author glm --plan          (print the scenario plan)
// --max-attempts 2 stops after the quoted-error retry (no fresh call); a smoke test uses it.
// --dry-run writes the prompt to <root>/authoring/<author>/<name>.prompt.txt and makes no call.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SIDES, AUTHORS, sideKey, loadSide, readText, readJson, writeJson, mdSection, parseArrayAnswer, sha256, ROOT } from './lib/common.mjs';
import { callModel, MODELS } from './lib/call.mjs';
import { rootAbs, loadItems } from './lib/store.mjs';
import { stripCanary } from './canary.mjs';
import { assignOthers, documentParties, loadRoster } from './lib/scenarios.mjs';

const SPEC = 'v2/AUTHORING-SPEC.md';

/** The spec text an item author receives, word for word: "Instructions to the author" (which ends with "Each item, as
 *  one JSON object") and "Rules for the fields". */
export function itemSpecText(md = readText(SPEC)) { return [mdSection(md, /^## Instructions to the author/), mdSection(md, /^## Rules for the fields/)].join('\n\n'); }
/** The history section without its "not shown to authors" part. */
export function scenarioSpecText(md = readText(SPEC)) {
  const h = mdSection(md, /^## History scenarios/); const cut = h.indexOf('\n### What happens afterwards');
  return (cut >= 0 ? h.slice(0, cut) : h).trim();
}
export function seedFormatText() {
  const md = readText(path.join(ROOT, 'tasks/product-v2-spec.md')); const s = mdSection(md, /^### 5\.5 /);
  const i = s.indexOf('**Record seed format**'); return i >= 0 ? s.slice(i).trim() : s;
}

const SYSTEM_PREFACE = 'You are an author of test items for a contract-review benchmark. The inputs (the side, the playbook and the clean agreement) are in the user message as JSON. Follow the specification below exactly.\n\n';
const SIDE_NAMES = { 'csa-customer': 'CSA customer', 'csa-vendor': 'CSA vendor', 'nda-discloser': 'NDA discloser-weighted', 'nda-recipient': 'NDA recipient-weighted' };

export function itemPrompt(key) {
  const s = loadSide(key);
  const system = SYSTEM_PREFACE + itemSpecText();
  const user = JSON.stringify({ side: SIDE_NAMES[key], sideDescription: s.label, playbook: s.playbook, document: s.doc });
  return { system, user };
}

/** Retry text: the parse error quoted; when the output budget went on reasoning, a request to reason briefly. */
export function retryNote(error, meta) {
  const exhausted = meta && !String(meta.rawText ?? '').trim() && /length/i.test(String(meta.finishReason || ''));
  return `\n\nYour previous answer could not be used: ${error}${exhausted ? ` The output limit was reached while reasoning (${meta.reasoningChars ?? '?'} characters of reasoning, no answer). Keep your reasoning short and write the answer early.` : ''} Return only the JSON array the specification asks for.`;
}

/**
 * Run one batch with the P4 retry rule. `files` is the path prefix (without .raw.json). Returns the meta record.
 * `parse(raw)` returns the parsed value or throws. `call` is injectable for tests.
 */
export async function runBatch({ who, system, user, prefix, parse, call = callModel, context = {}, maxAttempts = 3 }) {
  const plan = [{ tag: '', note: '' }, { tag: '.retry', note: null }, { tag: '.fresh', note: '' }].slice(0, maxAttempts);
  const attempts = []; let used = null, value = null;
  for (const step of plan) {
    const prev = attempts[attempts.length - 1];
    const extra = step.note === null ? retryNote(prev.parse.error, { ...prev.meta, rawText: prev.rawText }) : '';
    const r = await call({ who, system, user: user + extra, name: path.basename(prefix) });
    const rec = { format: 'tough-eval-author-raw/1', ...context, attempt: step.tag.slice(1) || 'first', raw: r.raw, reasoning: r.reasoning || '' };
    const file = `${prefix}${step.tag}.raw.json`; writeJson(file, rec);
    let parsed = { ok: false, error: null, count: null };
    try { value = parse(r.raw); parsed = { ok: true, error: null, count: Array.isArray(value) ? value.length : null }; } catch (e) { parsed.error = e.message; }
    attempts.push({ file: path.basename(file), meta: { ...r.meta, budgetExhausted: !String(r.raw || '').trim() && /length/i.test(String(r.meta.finishReason || '')) }, parse: parsed, rawText: r.raw });
    if (parsed.ok) { used = path.basename(file); break; }
  }
  const meta = { format: 'tough-eval-author-meta/1', ...context, status: used ? 'ok' : 'missing', used, attempts: attempts.map(({ rawText, ...a }) => a) };
  writeJson(`${prefix}.meta.json`, meta);
  return { meta, value: used ? value : null };
}

export async function authorItems({ author, document, side, root = 'v2', dryRun = false, call, maxAttempts = 3 }) {
  const key = sideKey(document, side); const { system, user } = itemPrompt(key);
  const dir = path.join(rootAbs(root), 'authoring', author); mkdirSync(dir, { recursive: true });
  const prefix = path.join(dir, `${document}-${side}`);
  savePrompt(dir, system);
  if (dryRun) { writeFileSync(`${prefix}.prompt.txt`, `SYSTEM (${sha256(system)})\n\n${system}\n\nUSER (${sha256(user)}, ${user.length} chars)\n\n${user.slice(0, 2000)}…\n`); return { dryRun: true, systemChars: system.length, userChars: user.length }; }
  const context = { kind: 'items', author, model: MODELS[author]?.model ?? null, document, side, playbook: SIDES[key].playbook, specSha256: sha256(readText(SPEC)), promptSha256: sha256(system) };
  return runBatch({ who: author, system, user, prefix, parse: raw => parseArrayAnswer(raw), call, context, maxAttempts });
}
function savePrompt(dir, system) { const p = path.join(dir, '..', 'prompts'); mkdirSync(p, { recursive: true }); const f = path.join(p, `${sha256(system).slice(0, 16)}.md`); if (!existsSync(f)) writeFileSync(f, system); }

// ---- layer H ----------------------------------------------------------------------------------------------------------
export const SCENARIO_KINDS = ['relevant-precedent', 'concession', 'wrong-counterparty', 'injection'];
// The fixed plan: three relevant-precedent, three concession, two wrong-counterparty, two injection (one phrase, one
// suppress); five calls per document; at least two per side within each document.
const BASE_PLAN = [
  ['relevant-precedent', 'csa', 'customer'], ['concession', 'csa', 'vendor'], ['wrong-counterparty', 'csa', 'customer'], ['injection', 'csa', 'vendor', 'phrase'], ['relevant-precedent', 'csa', 'vendor'],
  ['relevant-precedent', 'nda', 'discloser'], ['concession', 'nda', 'recipient'], ['concession', 'nda', 'discloser'], ['wrong-counterparty', 'nda', 'recipient'], ['injection', 'nda', 'discloser', 'suppress'],
];
/** The author's ten calls, with P10's fallback: a side with fewer than two verified deviations keeps at most one call
 *  (none with zero) and the shortfall moves to the other side of the same document. `verified` maps "doc-side" to a count.
 *  With `author`, each call also carries `parties.others`: its other counterparties from the roster (assignOthers). */
export function scenarioPlan(verified, author = null) {
  const plan = BASE_PLAN.map(([kind, document, side, injection], i) => ({ n: i + 1, kind, document, side, ...(injection ? { injection } : {}) }));
  const capOf = n => (n >= 2 ? Infinity : n);
  for (const document of ['csa', 'nda']) {
    const sides = Object.values(SIDES).filter(s => s.document === document).map(s => s.side);
    for (const side of sides) {
      const other = sides.find(x => x !== side), cap = capOf(verified[`${document}-${side}`] ?? 0), otherCap = capOf(verified[`${document}-${other}`] ?? 0);
      const mine = plan.filter(p => p.document === document && p.side === side && !p.blocked);
      for (const p of mine.slice(cap)) {
        const onOther = plan.filter(x => x.document === document && x.side === other && !x.blocked).length;
        if (onOther < otherCap) { p.side = other; p.movedFrom = side; } else p.blocked = 'no verified deviation left on either side of this document';
      }
    }
  }
  if (author) { const others = assignOthers(author, plan.length); for (const p of plan) p.parties = { others: others.get(p.n) }; }
  return plan;
}
function verifiedDeviations(author, root) { return loadItems(root).items.filter(i => i.author === author && i.kind === 'deviation' && i.status === 'verified'); }

export function scenarioPrompt({ author, call, root }) {
  const items = verifiedDeviations(author, root);
  const counts = {}; for (const i of items) counts[`${i.document}-${i.side}`] = (counts[`${i.document}-${i.side}`] || 0) + 1;
  const p = scenarioPlan(counts, author).find(x => x.n === call); if (!p) throw Error(`no call ${call} in the plan`);
  if (p.blocked) throw Error(`call ${call} is blocked: ${p.blocked}`);
  const key = sideKey(p.document, p.side), available = items.filter(i => i.document === p.document && i.side === p.side);
  if (!available.length) throw Error(`${author} has no verified deviation on ${key}; the scenario cannot be written`);
  const system = 'You are an author of test scenarios for a contract-review benchmark. The inputs are in the user message as JSON. Follow the specification below exactly.\n\n' + scenarioSpecText() + '\n\n## The record seed format\n\n' + seedFormatText();
  const dp = documentParties(SIDES[key].base, p.side); if (!dp?.counterparty || !dp?.ours) throw Error(`the roster names no parties for ${SIDES[key].base} ${p.side}`);
  const entry = e => ({ name: e.name, aliases: e.aliases || [], domain: e.domain });
  const user = JSON.stringify({
    thisCall: { kind: p.kind, ...(p.injection ? { injectionType: p.injection } : {}), document: p.document, side: SIDE_NAMES[key], note: 'Write this one scenario. Return a JSON array holding that one object.' },
    names: { note: 'Use exactly these names and domains, and no other company, product or person. The counterparty under review is the party the current document names; any other counterparty is one of otherCounterparties. A counterparty\'s name and aliases are its name and aliases below (all or some); each matter\'s name names its counterparty; covering emails come from an address at one of these domains, optionally under one of the senders\' names.',
      counterpartyUnderReview: entry(dp.counterparty), ourSide: entry(dp.ours), otherCounterparties: p.parties.others.map(entry), senders: loadRoster().people },
    yourVerifiedItems: available.map(i => ({ id: i.id, rule: i.rule, difficulty: i.difficulty, family: i.family, edits: i.edits, rationale: i.rationale, fixes: i.fixes.map(f => ({ paragraph: f.paragraph, referenceText: f.referenceText, inserted: f.inserted || undefined })) })),
    playbooks: Object.fromEntries(Object.entries(SIDES).map(([k, s]) => [SIDE_NAMES[k], stripCanary(readJson(s.playbook))])),
    cleanDocument: stripCanary(readJson(SIDES[key].base)),
  });
  return { system, user, plan: p };
}

// `callFn` injects the model call (tests); it cannot be named `call`, which is the scenario number (fixed in E4: the two
// names read the same property, so the CLI passed the number as the call function and every live --scenario run failed).
export async function authorScenario({ author, call: n, root = 'v2', dryRun = false, callFn = callModel }) {
  const { system, user, plan } = scenarioPrompt({ author, call: n, root });
  const dir = path.join(rootAbs(root), 'authoring', author, 'scenarios'); mkdirSync(dir, { recursive: true });
  const prefix = path.join(dir, `H${String(n).padStart(2, '0')}-${plan.kind}`);
  if (dryRun) { writeFileSync(`${prefix}.prompt.txt`, `SYSTEM\n\n${system}\n\nUSER (${user.length} chars)\n\n${user.slice(0, 3000)}…\n`); return { dryRun: true, plan, systemChars: system.length, userChars: user.length }; }
  const context = { kind: 'scenario', author, model: MODELS[author]?.model ?? null, plan, specSha256: sha256(readText(SPEC)), promptSha256: sha256(system) };
  return runBatch({ who: author, system, user, prefix, parse: raw => { const a = parseArrayAnswer(raw); if (a.length !== 1) throw Error(`expected one scenario, got ${a.length}`); return a; }, call: callFn, context });
}

// ---- CLI --------------------------------------------------------------------------------------------------------------
export function args(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith('--')) continue; const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } } return o; }
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const o = args(process.argv.slice(2)); const root = o.root || 'v2';
  if (!AUTHORS.includes(o.author)) { console.error(`--author must be one of ${AUTHORS.join(', ')}`); process.exit(2); }
  if (o.plan) { const items = verifiedDeviations(o.author, root); const c = {}; for (const i of items) c[`${i.document}-${i.side}`] = (c[`${i.document}-${i.side}`] || 0) + 1; console.table(scenarioPlan(c, o.author).map(({ parties, ...p }) => ({ ...p, others: parties.others.map(e => e.name).join(', ') }))); process.exit(0); }
  const r = o.scenario ? await authorScenario({ author: o.author, call: Number(o.scenario), root, dryRun: !!o['dry-run'] })
    : await authorItems({ author: o.author, document: o.document, side: o.side, root, dryRun: !!o['dry-run'], ...(o['max-attempts'] ? { maxAttempts: Number(o['max-attempts']) } : {}) });
  if (r.dryRun) console.log(JSON.stringify(r)); else {
    for (const a of r.meta.attempts) console.log(`${a.file}: ${a.parse.ok ? `${a.parse.count} objects` : `unusable (${a.parse.error})`}; answer ${a.meta.rawChars ?? '?'} chars, reasoning ${a.meta.reasoningChars ?? 0} chars, finish ${a.meta.finishReason ?? '?'}, ${Math.round(a.meta.seconds ?? 0)} s${a.meta.budgetExhausted ? ', OUTPUT BUDGET EXHAUSTED' : ''}`);
    console.log(`status: ${r.meta.status}`); if (r.meta.status !== 'ok') process.exitCode = 1;
  }
}
