// SPDX-License-Identifier: GPL-3.0-or-later
// P6 and P7: verification of applied items by the two families that did not write them (BENCHMARK-V2.md 5.6).
//   A validator family receives, per document and side, the other two authors' items shuffled together by hash and
//   labelled X01, X02, ... (never by id, which names the author), each with its edit (paragraph before and after), rule,
//   kind, side, rationale, reference fix and check, the playbook for the side, and the four questions
//   (prompts/verify.md; q4, added 16 October 2026 with decision 176: does the edit name a real company, product or
//   person? A yes contests the item). The shuffled list is split into `--chunks` calls (default 2, so a family makes 8 calls over the
//   four document-sides, as the run plan counts).
//   A reply that cannot be parsed is retried once with the parse error quoted; items a reply omits are asked for once
//   more in one call listing only them; an item still unanswered gets { answered: false, reasons: "no usable reply" }.
//   An item is verified when both validators answered and said yes to every applicable question; otherwise contested,
//   kept with both answers, never repaired. Contested items and the contest rate per author are written to
//   <root>/verification/summary.json and to a generated block in <root>/ERRATA.md.
// Usage: node tough-eval/v2/verify.mjs --family opus|glm|deepseek [--document nda --side discloser] [--items id,id] [--chunks 2] [--root v2]
//        node tough-eval/v2/verify.mjs --report [--root v2]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SIDES, AUTHORS, loadSide, writeJson, parseArrayAnswer, byHash, V2 } from './lib/common.mjs';
import { callModel, MODELS } from './lib/call.mjs';
import { rootAbs, loadItems, saveItems, rebuild, itemVariant, withStoreLock } from './lib/store.mjs';
import { args } from './author.mjs';

export const PROMPT = path.join(V2, 'prompts/verify.md');
const pad = n => String(n).padStart(2, '0');

/** What a validator sees of one item: no id, no author. */
export function presentItem(item, ref) {
  const s = loadSide(`${item.document}-${item.side}`); const { doc, plant } = itemVariant(item); const now = new Map(doc.paragraphs.map(p => [p.id, p.text]));
  const edits = plant.targets.map(id => (s.paragraphs.has(id) ? { paragraph: id, before: s.paragraphs.get(id), after: now.get(id) }
    : { paragraph: id, inserted: `new paragraph, inserted after ${doc.paragraphs[doc.paragraphs.findIndex(p => p.id === id) - 1]?.id}`, before: null, after: now.get(id) }));
  return { ref, kind: item.kind, rule: item.rule, ruleText: s.playbook.rules.find(r => r.id === item.rule), edits, rationale: item.rationale,
    ...(item.kind === 'deviation' ? { referenceFixes: item.fixes.map(f => (f.inserted ? { paragraph: f.paragraph, fix: 'delete the inserted paragraph' } : { paragraph: f.paragraph, referenceText: f.referenceText, check: f.check })) } : {}) };
}

/** Map a validator's answer for an item to the stored record (11.2). */
export function toRecord(family, item, a) {
  if (!a) return { family, answered: false, departs: null, fixOk: null, checkOk: null, namesReal: null, reasons: 'no usable reply' };
  const namesReal = typeof a.q4 === 'boolean' ? a.q4 : null;
  if (item.kind === 'benign') return { family, answered: true, departs: a.q1 === true ? false : a.q1 === false ? true : null, complies: a.q1 ?? null, fixOk: null, checkOk: null, namesReal, reasons: String(a.reasons ?? '') };
  return { family, answered: true, departs: a.q1 ?? null, fixOk: a.q2 ?? null, checkOk: a.q3 ?? null, namesReal, reasons: String(a.reasons ?? '') };
}
/** Whether a record says yes to every question that applies to the item, and does not say it names a real company,
 *  product or person (q4; a missing q4 is recorded as null and does not contest). */
export const recordYes = (item, r) => r.answered === true && r.namesReal !== true && (item.kind === 'benign' ? r.complies === true : r.departs === true && r.fixOk === true && r.checkOk === true);
/** Status from the records of the two validators (the families other than the author): contested on any no or
 *  missing answer, verified when both said yes, 'applied' (pending) while a yes awaits the second validator. */
export function decide(item) {
  const need = AUTHORS.filter(a => a !== item.author); const recs = need.map(f => item.verification.find(r => r.family === f));
  if (recs.some(r => r && !recordYes(item, r))) return 'contested'; // settled by one no, whatever the other says
  if (recs.some(r => !r)) return 'applied';
  return 'verified';
}

function answersByRef(raw) { const arr = parseArrayAnswer(raw, { expectKey: 'answers' }); const m = new Map(); for (const a of arr) if (a && typeof a.ref === 'string' && !m.has(a.ref)) m.set(a.ref, a); return m; }

/**
 * One chunk for one family: call, one retry on a parse failure, one call for omitted refs. Returns Map ref -> answer.
 * Every raw reply is stored under <dir>/<name>[.retry|.missing].raw.json with its meta.
 */
export async function verifyChunk({ family, side, playbook, presented, dir, name, call = callModel }) {
  const system = readFileSync(PROMPT, 'utf8');
  const send = async (list, tag, note = '') => {
    const user = JSON.stringify({ side, playbook, items: list }) + note;
    const r = await call({ who: family, system, user, name: `${name}${tag}` });
    let answers = null, error = null; try { answers = answersByRef(r.raw); } catch (e) { error = e.message; }
    writeJson(path.join(dir, `${name}${tag}.raw.json`), { format: 'tough-eval-verify-raw/1', family, model: MODELS[family]?.model ?? null, refs: list.map(i => i.ref), raw: r.raw, reasoning: r.reasoning || '', meta: r.meta, parse: { ok: !error, error, answered: answers ? [...answers.keys()] : [] } });
    return { answers, error };
  };
  // One retry in all (P6): with the parse error quoted, or with the omitted refs listed.
  const first = await send(presented, '');
  if (!first.answers) { const again = await send(presented, '.retry', `\n\nYour previous answer could not be read: ${first.error} Return only the JSON object the instructions ask for.`); return again.answers || new Map(); }
  const answers = first.answers; const missing = presented.filter(p => !answers.has(p.ref));
  if (missing.length) {
    const again = await send(missing, '.retry', `\n\nYour previous answer did not cover these items: ${missing.map(m => m.ref).join(', ')}. Answer them now.`);
    for (const [k, v] of again.answers || []) if (missing.some(m => m.ref === k)) answers.set(k, v);
  }
  return answers;
}

export async function verifyFamily({ family, root = 'v2', only = null, sideKeys = Object.keys(SIDES), chunks = 2, call = callModel }) {
  const store = loadItems(root); const out = [];
  for (const key of sideKeys) {
    const s = loadSide(key);
    let items = store.items.filter(i => `${i.document}-${i.side}` === key && i.author !== family && i.status !== 'dropped');
    if (only) items = items.filter(i => only.includes(i.id)); if (!items.length) continue;
    const shuffled = byHash(items, `v2-verify:${family}:${key}:`);
    const refs = new Map(shuffled.map((it, k) => [it.id, `X${pad(k + 1)}`]));
    const n = Math.max(1, Math.min(chunks, shuffled.length)), size = Math.ceil(shuffled.length / n);
    const dir = path.join(rootAbs(root), 'verification', family);
    for (let c = 0; c < n; c++) {
      const part = shuffled.slice(c * size, (c + 1) * size); if (!part.length) continue;
      // Resumable (preliminary run, 16 October 2026): a chunk whose items all carry this family's record is not asked again.
      if (part.every(it => (it.verification || []).some(r => r.family === family))) continue;
      const presented = part.map(it => presentItem(it, refs.get(it.id)));
      const name = `${key}-${c + 1}`;
      writeJson(path.join(dir, `${name}.refs.json`), { format: 'tough-eval-verify-refs/1', family, side: key, refs: Object.fromEntries(part.map(it => [refs.get(it.id), it.id])) });
      const answers = await verifyChunk({ family, side: s.label, playbook: s.playbook, presented, dir, name, call });
      // Saved per chunk under the store lock, merged into the store as it is now (other lanes write it too).
      withStoreLock(root, () => {
        const now = loadItems(root); const byId = new Map(now.items.map(i => [i.id, i]));
        for (const it0 of part) {
          const it = byId.get(it0.id) || it0; const rec = toRecord(family, it, answers.get(refs.get(it0.id)));
          it.verification = [...(it.verification || []).filter(r => r.family !== family), rec];
          it.status = decide(it); it0.verification = it.verification; it0.status = it.status; out.push({ id: it.id, ...rec, status: it.status });
        }
        saveItems(root, now); rebuild(root);
      });
    }
  }
  report(root);
  return out;
}

/** P7: contest rate per author, the contested list, and the generated block in ERRATA.md. */
export function report(root = 'v2') {
  const store = withStoreLock(root, () => { const st = loadItems(root); let changed = false;
    for (const i of st.items) if (i.status !== 'dropped' && i.verification?.length) { const s = decide(i); if (s !== i.status) { i.status = s; changed = true; } }
    if (changed) { saveItems(root, st); rebuild(root); } return st; });
  const items = store.items.filter(i => i.status !== 'dropped');
  const by = Object.fromEntries(AUTHORS.map(a => { const mine = items.filter(i => i.author === a); const done = mine.filter(i => ['verified', 'contested'].includes(i.status)); const c = done.filter(i => i.status === 'contested').length;
    return [a, { applied: mine.length, decided: done.length, verified: done.length - c, contested: c, contestRate: done.length ? +(c / done.length).toFixed(3) : null }]; }));
  const contested = items.filter(i => i.status === 'contested').map(i => ({ id: i.id, kind: i.kind, rule: i.rule, verification: i.verification }));
  writeJson(path.join(rootAbs(root), 'verification', 'summary.json'), { format: 'tough-eval-verify-summary/1', at: new Date().toISOString(), byAuthor: by, contested });
  const lines = ['<!-- contested:start (generated by verify.mjs; do not edit inside this block) -->', '', `Contested items (P7), ${new Date().toISOString().slice(0, 10)}. Kept in the set, never repaired.`, ''];
  for (const c of contested) { lines.push(`- **${c.id}** (${c.kind}, ${c.rule})`); for (const r of c.verification) lines.push(`  - ${r.family}: ${r.answered ? (c.kind === 'benign' ? `complies ${r.complies}` : `departs ${r.departs}, fix ${r.fixOk}, check ${r.checkOk}`) + (r.namesReal === true ? ', names a real company, product or person' : '') : 'no usable reply'}. ${String(r.reasons || '').replace(/\s+/g, ' ').trim()}`); }
  if (!contested.length) lines.push('None so far.');
  lines.push('', '<!-- contested:end -->');
  const f = path.join(rootAbs(root), 'ERRATA.md'); let md = existsSync(f) ? readFileSync(f, 'utf8') : '# Errata\n\nDated entries: contested items (with validators\' reasons), the layer B label audit, and any scoring fault found after release with its effect on published numbers (BENCHMARK-V2.md 11.10).\n\n';
  md = /<!-- contested:start/.test(md) ? md.replace(/<!-- contested:start[\s\S]*?<!-- contested:end -->/, lines.join('\n')) : md.trimEnd() + '\n\n' + lines.join('\n') + '\n';
  writeFileSync(f, md);
  return { byAuthor: by, contested: contested.length };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const o = args(process.argv.slice(2)); const root = o.root || 'v2';
  if (o.report) { console.log(JSON.stringify(report(root), null, 1)); process.exit(0); }
  if (!AUTHORS.includes(o.family)) { console.error(`--family must be one of ${AUTHORS.join(', ')}`); process.exit(2); }
  const sideKeys = o.document && o.side ? [`${o.document}-${o.side}`] : Object.keys(SIDES);
  const r = await verifyFamily({ family: o.family, root, only: o.items ? String(o.items).split(',') : null, sideKeys, chunks: Number(o.chunks || 2) });
  console.table(r.map(x => ({ id: x.id, answered: x.answered, departs: x.departs, complies: x.complies, fixOk: x.fixOk, checkOk: x.checkOk, namesReal: x.namesReal, status: x.status })));
}
