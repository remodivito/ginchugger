// SPDX-License-Identifier: GPL-3.0-or-later
// P5: apply one author's batch for one document and side, enforcing the authoring spec.
//   An item is rejected when an edit's `find` is missing or not unique in the named clean paragraph (or the edit is
//   malformed), its rule id is not in the playbook, a fix's check passes on the planted text, fails on the item's own
//   referenceText or fails on the clean paragraph (E-49), or it breaks a quota (a rule's third and later uses).
//   A family missing from the batch is a batch-level quota failure: the author is asked to replace one of the named
//   items (later members of the largest family) with an item of the missing family.
//   Rejections go back to the author once, in one further call listing only those items with their errors and the
//   constraint to satisfy; each replacement carries "replaces": <item number>. A replacement that still fails, or a
//   rejected item with no replacement, is dropped with the reason (status "dropped", apply.error); nothing is backfilled.
//   Ids are A-<author>-<document>-<side>-<nn> in batch order (a replacement keeps the number of the item it replaces).
//   Writes <root>/items.json (the batch's items replaced), variants/ and manifest.json (rebuilt), and
//   <root>/authoring/<author>/<document>-<side>.apply.json (counts, quota warnings, drops).
// Usage: node tough-eval/v2/apply.mjs --author glm --document nda --side discloser [--root v2] [--no-call]
//   --no-call writes the resubmission prompt (.resubmit.prompt.txt) instead of calling, and stops before writing items.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SIDES, sideKey, loadSide, readJson, writeJson, parseArrayAnswer, sha256 } from './lib/common.mjs';
import { validateItem, checkQuotas, familyReplacementCandidates, QUOTA } from './lib/items.mjs';
import { callModel, MODELS } from './lib/call.mjs';
import { rootAbs, loadItems, saveItems, rebuild, withStoreLock } from './lib/store.mjs';
import { itemPrompt, args } from './author.mjs';

const pad = n => String(n).padStart(2, '0');
export const itemId = (author, document, side, n) => `A-${author}-${document}-${side}-${pad(n)}`;

/** Validate a list of entries ([{ index, item }]) and apply the quota; returns { ok: [...], rejected: [{ index, item, errors }], quota }. */
export function screen(entries, ctx) {
  const ok = [], rejected = [];
  for (const e of entries) { const v = validateItem(e.item, ctx); if (v.errors.length) rejected.push({ ...e, errors: v.errors, warnings: v.warnings }); else ok.push({ ...e, warnings: v.warnings, applied: v.applied }); }
  const quota = checkQuotas(ok);
  for (const o of quota.overuse) for (const ix of o.excess) {
    const k = ok.findIndex(e => e.index === ix); const [e] = ok.splice(k, 1);
    rejected.push({ ...e, errors: [`quota: rule ${o.rule} is used ${o.indexes.length} times (items ${o.indexes.map(i => i + 1).join(', ')}); no rule may carry more than ${QUOTA.maxPerRule}. Move this item to another rule.`] });
  }
  rejected.sort((a, b) => a.index - b.index);
  return { ok, rejected, quota: checkQuotas(ok) };
}

/** The one further call's request: the rejected items with their errors, and any missing family with candidates. */
export function resubmissionRequest(rejected, missingFamilies, candidates) {
  const items = rejected.map(r => ({ number: r.index + 1, yourItem: r.item, errors: r.errors }));
  const constraints = missingFamilies.map(f => `No item of the family "${f}" is left in the batch. Replace one of items ${candidates.map(i => i + 1).join(', ')} with an item of the family "${f}".`);
  const text = 'Some of your items cannot be used. For each listed item, write one replacement item that meets the specification and fixes the errors stated' +
    (constraints.length ? '; and satisfy each constraint by replacing one of the items it names' : '') +
    '. Return only a JSON array of the replacement items, each in the item format with one extra field, "replaces": the number of the item it replaces.';
  return { instruction: text, rejectedItems: items, ...(constraints.length ? { constraints } : {}) };
}

export async function applyBatch({ author, document, side, root = 'v2', noCall = false, call = callModel }) {
  const key = sideKey(document, side), s = loadSide(key), ctx = { doc: s.doc, ruleIds: s.ruleIds };
  const dir = path.join(rootAbs(root), 'authoring', author), prefix = path.join(dir, `${document}-${side}`);
  const meta = readJson(`${prefix}.meta.json`);
  const summary = { format: 'tough-eval-apply/1', author, document, side, appliedAt: new Date().toISOString(), batch: meta.status, notes: [] };
  if (meta.status !== 'ok') { summary.notes.push('batch missing after the P4 retries; no items'); writeJson(`${prefix}.apply.json`, summary); return { summary, items: [] }; }
  let objects = parseArrayAnswer(readJson(path.join(dir, meta.used)).raw);
  if (objects.length > QUOTA.items) { summary.notes.push(`${objects.length} objects returned; items after the twelfth are dropped`); }
  const entries = objects.map((item, index) => ({ index, item }));
  const first = screen(entries.slice(0, QUOTA.items), ctx);
  const extra = entries.slice(QUOTA.items).map(e => ({ ...e, errors: ['beyond the twelve items asked for'] }));
  const candidates = familyReplacementCandidates(first.ok);
  const missing = first.quota.missingFamilies;
  let second = null;
  const resubPrefix = `${prefix}.resubmit`;
  if (first.rejected.length || missing.length) {
    const req = resubmissionRequest(first.rejected, missing, candidates);
    const { system, user } = itemPrompt(key);
    const userR = JSON.stringify({ ...JSON.parse(user), resubmission: req });
    if (!existsSync(`${resubPrefix}.meta.json`)) {
      if (noCall) { writeFileSync(`${resubPrefix}.prompt.txt`, JSON.stringify(req, null, 1)); summary.notes.push('resubmission pending (--no-call)'); writeJson(`${prefix}.apply.json`, { ...summary, pending: req }); return { summary, pending: req }; }
      const r = await call({ who: author, system, user: userR, name: `${document}-${side}.resubmit` });
      writeJson(`${resubPrefix}.raw.json`, { format: 'tough-eval-author-raw/1', kind: 'resubmission', author, document, side, raw: r.raw, reasoning: r.reasoning || '' });
      let parsed = { ok: false, error: null, count: null };
      try { parsed = { ok: true, error: null, count: parseArrayAnswer(r.raw).length }; } catch (e) { parsed.error = e.message; }
      writeJson(`${resubPrefix}.meta.json`, { format: 'tough-eval-author-meta/1', kind: 'resubmission', author, model: MODELS[author]?.model ?? null, document, side, request: req, requestSha256: sha256(userR), meta: r.meta, parse: parsed });
    }
    const rm = readJson(`${resubPrefix}.meta.json`);
    let replacements = [];
    if (rm.parse.ok) replacements = parseArrayAnswer(readJson(`${resubPrefix}.raw.json`).raw); else summary.notes.push(`resubmission unusable: ${rm.parse.error}`);
    const asked = new Set([...first.rejected.map(r => r.index), ...(missing.length ? candidates : [])]);
    const byIndex = new Map();
    for (const rep of replacements) {
      const n = Number(rep?.replaces); if (!Number.isInteger(n) || !asked.has(n - 1)) { summary.notes.push(`a replacement names item ${JSON.stringify(rep?.replaces)}, which was not asked for; ignored`); continue; }
      if (byIndex.has(n - 1)) { summary.notes.push(`a second replacement for item ${n} ignored`); continue; }
      const { replaces, ...item } = rep; byIndex.set(n - 1, item);
    }
    second = { byIndex, replacements: replacements.length };
  }
  // Final set: accepted first-round items (a family candidate replaced only by a valid replacement), replacements for
  // rejected items, the rest dropped.
  const final = []; const dropped = [];
  const all = new Map([...first.ok.map(e => [e.index, { ...e, attempt: 1 }]), ...first.rejected.map(r => [r.index, { ...r, attempt: 1, rejected: true }])]);
  for (const index of [...all.keys()].sort((a, b) => a - b)) {
    const e = all.get(index), rep = second?.byIndex.get(index);
    if (rep) {
      const v = validateItem(rep, ctx);
      if (!v.errors.length) { final.push({ index, item: rep, attempt: 2, applied: v.applied, warnings: v.warnings, replaced: e.item, replacedErrors: e.errors || null }); continue; }
      if (!e.rejected) { final.push({ ...e, notes: [`replacement for the family quota failed: ${v.errors.join('; ')}`] }); continue; }
      dropped.push({ index, item: rep, attempt: 2, errors: v.errors, firstErrors: e.errors, original: e.item }); continue;
    }
    if (e.rejected) dropped.push({ index, item: e.item, attempt: 1, errors: [...e.errors, ...(second ? ['no replacement returned'] : [])] });
    else final.push(e);
  }
  // Quotas again: a rule still used three times loses its later items (second failure: dropped).
  const q2 = checkQuotas(final);
  for (const o of q2.overuse) for (const ix of o.excess) { const k = final.findIndex(e => e.index === ix); const [e] = final.splice(k, 1); dropped.push({ index: ix, item: e.item, attempt: e.attempt, errors: [`quota: rule ${o.rule} still used ${o.indexes.length} times after resubmission`] }); }
  const q3 = checkQuotas(final);
  for (const e of extra) dropped.push({ index: e.index, item: e.item, attempt: 1, errors: e.errors });
  // Records.
  const records = [...final.map(e => ({ e, status: 'applied' })), ...dropped.map(e => ({ e, status: 'dropped' }))].sort((a, b) => a.e.index - b.e.index).map(({ e, status }) => {
    const it = e.item && typeof e.item === 'object' ? e.item : {};
    return { id: itemId(author, document, side, e.index + 1), author, document, side, playbook: SIDES[key].playbook,
      kind: it.kind ?? null, difficulty: it.kind === 'benign' ? 'n/a' : (it.difficulty ?? null), family: it.family ?? null, rule: it.rule ?? null,
      edits: it.edits ?? [], rationale: it.rationale ?? '',
      fixes: status === 'applied' && it.kind === 'deviation' ? e.applied.fixes.map(f => ({ paragraph: f.paragraph, referenceText: f.referenceText, ...(f.inserted ? { inserted: true } : { check: f.check }) })) : (it.fixes ?? []),
      status, apply: { attempt: e.attempt, error: status === 'dropped' ? e.errors.join('; ') : null, ...(e.replacedErrors ? { replacedAfter: e.replacedErrors.join('; ') } : {}), ...(e.warnings?.length ? { warnings: e.warnings } : {}), ...(e.notes ? { notes: e.notes } : {}) },
      verification: [], variantId: status === 'applied' ? itemId(author, document, side, e.index + 1) : null };
  });
  // Merge into the store; an item whose content is unchanged keeps its verification.
  withStoreLock(root, () => {
    const store = loadItems(root); const old = new Map(store.items.map(i => [i.id, i]));
    const sameContent = (a, b) => JSON.stringify([a.kind, a.rule, a.edits, a.fixes]) === JSON.stringify([b.kind, b.rule, b.edits, b.fixes]);
    for (const r of records) { const o = old.get(r.id); if (o && r.status !== 'dropped' && sameContent(o, r) && o.verification?.length) { r.verification = o.verification; r.status = o.status; } }
    store.items = [...store.items.filter(i => !(i.author === author && i.document === document && i.side === side)), ...records];
    saveItems(root, store); rebuild(root);
  });
  Object.assign(summary, { returned: objects.length, applied: final.length, dropped: dropped.length, resubmitted: first.rejected.length + (missing.length ? missing.length : 0), counts: q3.counts, quotaWarnings: q3.warnings, missingFamilies: q3.missingFamilies,
    drops: dropped.map(d => ({ id: itemId(author, document, side, d.index + 1), attempt: d.attempt, errors: d.errors })) });
  writeJson(`${prefix}.apply.json`, summary);
  return { summary, items: records };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const o = args(process.argv.slice(2));
  const r = await applyBatch({ author: o.author, document: o.document, side: o.side, root: o.root || 'v2', noCall: !!o['no-call'] });
  console.log(JSON.stringify(r.summary, null, 1));
}
