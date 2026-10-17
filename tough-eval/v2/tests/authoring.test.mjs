// SPDX-License-Identifier: GPL-3.0-or-later
// Tests of the authoring pipeline (P4 to P9): apply's rules, the one return to the author, verification's contested
// handling and retry, markup assembly by hash, and reading each executor's raw output. No model is called: calls are
// stubbed, and the recorded GLM answer is replayed. Run: node --test tough-eval/v2/tests/authoring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSide, parseArrayAnswer, parseObjectAnswer, stripReasoning, readJson } from '../lib/common.mjs';
import { validateItem, applyEdits, checkQuotas, complies } from '../lib/items.mjs';
import { readStream, callModel } from '../lib/call.mjs';
import { runBatch, retryNote, scenarioPlan } from '../author.mjs';
import { applyBatch, screen } from '../apply.mjs';
import { decide, toRecord, verifyChunk, recordYes } from '../verify.mjs';
import { drawMarkup } from '../markups.mjs';
import { loadItems, saveItems, rebuild, markupVariant } from '../lib/store.mjs';
import { loadRoster } from '../lib/scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const nda = loadSide('nda-discloser');
const ctx = { doc: nda.doc, ruleIds: nda.ruleIds };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'v2-authoring-test-'));

// Six items covering the six families, written against the clean NDA for the discloser-weighted side.
const P19_RETAIN = ', but the terms of this MNDA will continue to apply to the retained Confidential Information';
const GOOD = [
  { kind: 'deviation', difficulty: 'easy', family: 'value', rule: 'NDA-19', edits: [{ paragraph: 'p7', find: '2 years from the Effective Date', replace: '1 year from the Effective Date' }], rationale: 'Below 18 months.',
    fixes: [{ paragraph: 'p7', referenceText: 'Term of Confidentiality: 2 years from the Effective Date, but in the case of trade secrets, until Confidential Information is no longer considered a trade secret under applicable laws.', check: { num: 'Confidentiality: ([0-9.]+) years?', min: 1.5, require: ['trade secret'] } }] },
  { kind: 'deviation', difficulty: 'medium', family: 'wording', rule: 'NDA-08', edits: [{ paragraph: 'p17', find: 'reasonable advance notice of the required disclosure', replace: 'notice of the required disclosure after it is made' }], rationale: 'Notice after the event defeats protection.',
    fixes: [{ paragraph: 'p17', referenceText: nda.paragraphs.get('p17'), check: { require: ['(advance|prior) notice'], forbid: ['after it is made'] } }] },
  { kind: 'deviation', difficulty: 'hard', family: 'deletion', rule: 'NDA-20', edits: [{ paragraph: 'p19', find: P19_RETAIN, replace: '' }], rationale: 'Retained copies released from the MNDA.',
    fixes: [{ paragraph: 'p19', referenceText: nda.paragraphs.get('p19'), check: { require: ['continue to apply'] } }] },
  { kind: 'deviation', difficulty: 'hard', family: 'insertion-omission', rule: 'NDA-04', edits: [{ paragraph: 'after:p24', find: '', replace: '12. Residuals. The Receiving Party may use information retained in the unaided memory of its personnel for any purpose.' }], rationale: 'Residuals clause.',
    fixes: [{ paragraph: 'p24a', referenceText: '', inserted: true }] },
  { kind: 'deviation', difficulty: 'hard', family: 'definition-crossclause', rule: 'NDA-07', edits: [{ paragraph: 'p15', find: ' and the Receiving Party remains responsible for their compliance with this MNDA', replace: '' }], rationale: 'Recipient no longer answers for representatives.',
    fixes: [{ paragraph: 'p15', referenceText: nda.paragraphs.get('p15'), check: { require: ['remains? responsible'] } }] },
  { kind: 'benign', difficulty: 'n/a', family: 'near-threshold', rule: 'NDA-19', edits: [{ paragraph: 'p7', find: '2 years from the Effective Date', replace: '18 months from the Effective Date' }], rationale: 'At the acceptable floor.', fixes: [] },
];
const clone = x => JSON.parse(JSON.stringify(x));

test('a good item applies, with its targets and fixes', () => {
  for (const item of GOOD) { const v = validateItem(item, ctx); assert.deepEqual(v.errors, [], JSON.stringify(v.errors)); }
  const v = validateItem(GOOD[0], ctx);
  assert.deepEqual(v.applied.targets, ['p7']);
  assert.match(v.applied.paragraphs.find(p => p.id === 'p7').text, /^Term of Confidentiality: 1 year/);
  const ins = validateItem(GOOD[3], ctx); assert.deepEqual(ins.applied.inserted, ['p24a']); assert.equal(ins.applied.fixes[0].inserted, true);
});

test('a missing find is rejected', () => {
  const it = clone(GOOD[0]); it.edits[0].find = '3 years from the Effective Date';
  assert.match(validateItem(it, ctx).errors.join(), /not found verbatim/);
});
test('a find that is not unique in its paragraph is rejected', () => {
  const it = clone(GOOD[1]); it.edits[0].find = 'Confidential Information';
  assert.match(validateItem(it, ctx).errors.join(), /occurs \d+ times/);
});
test('a check that passes on the planted text is rejected', () => {
  const it = clone(GOOD[0]); it.fixes[0].check = { require: ['trade secret'] };
  assert.match(validateItem(it, ctx).errors.join(), /passes on the planted text/);
});
test('a reference text that fails its own check is rejected', () => {
  const it = clone(GOOD[0]); it.fixes[0].referenceText = 'Term of Confidentiality: 1 year from the Effective Date, trade secrets excepted.';
  assert.match(validateItem(it, ctx).errors.join(), /fails on its own referenceText/);
});
test('a check that fails on the clean paragraph is rejected (E-49)', () => {
  const it = clone(GOOD[0]); it.fixes[0].check = { num: 'Confidentiality: ([0-9.]+) years?', min: 3 }; it.fixes[0].referenceText = 'Term of Confidentiality: 3 years from the Effective Date.';
  assert.match(validateItem(it, ctx).errors.join(), /fails on the clean text/);
});
test('an unknown rule, a bad family, an empty find and an invalid regex are rejected', () => {
  const a = clone(GOOD[0]); a.rule = 'NDA-06'; assert.match(validateItem(a, ctx).errors.join(), /not in the playbook/);
  const b = clone(GOOD[0]); b.family = 'typo'; assert.match(validateItem(b, ctx).errors.join(), /family must be/);
  const c = clone(GOOD[0]); c.edits[0].find = ''; assert.match(validateItem(c, ctx).errors.join(), /find is empty/);
  const d = clone(GOOD[0]); d.fixes[0].check = { require: ['(unclosed'] }; assert.match(validateItem(d, ctx).errors.join(), /invalid regex/);
  const e = clone(GOOD[3]); e.fixes[0] = { paragraph: 'p24a', referenceText: 'x', check: { require: ['x'] } }; assert.match(validateItem(e, ctx).errors.join(), /inserted paragraph/);
});
test('complies matches the scorer (score.mjs) on its own cases', () => {
  assert.equal(complies('Within 45 days', { num: 'within ([0-9]+) days', min: 30 }), true);
  assert.equal(complies('Within 10 days', { num: 'within ([0-9]+) days', min: 30 }), false);
  assert.equal(complies('a case study, with consent', { forbid: ['case study'], allowIf: 'consent' }), true);
  const score = readFileSync(path.join(here, '../../score.mjs'), 'utf8'); const mine = readFileSync(path.join(here, '../lib/items.mjs'), 'utf8');
  const body = s => s.slice(s.indexOf('function complies'), s.indexOf('\n}', s.indexOf('function complies')) + 2).replace(/^export /, '');
  assert.equal(body(mine), body(score), 'lib/items.mjs complies differs from score.mjs');
});
test('quotas: a third use of a rule and a missing family are found', () => {
  const entries = [GOOD[0], GOOD[5], { ...clone(GOOD[0]), family: 'wording' }].map((item, index) => ({ index, item }));
  const q = checkQuotas(entries); assert.deepEqual(q.overuse.map(o => [o.rule, o.excess]), [['NDA-19', [2]]]);
  assert.ok(q.missingFamilies.includes('deletion'));
  const s = screen(entries, ctx); assert.equal(s.rejected.length, 1); assert.match(s.rejected[0].errors[0], /quota: rule NDA-19/);
});
test('insertions after the same paragraph are named a, b', () => {
  const clean = new Map(nda.doc.paragraphs.map(p => [p.id, p.text]));
  const a = applyEdits(nda.doc.paragraphs, [{ paragraph: 'after:p24', find: '', replace: 'One.' }, { paragraph: 'after:p24', find: '', replace: 'Two.' }], clean);
  assert.deepEqual(a.inserted, ['p24a', 'p24b']);
});

// ---- apply: the one return to the author ----------------------------------------------------------------------------
async function batchRoot(objects) {
  const root = tmp();
  const recorded = JSON.stringify(objects);
  await runBatch({ who: 'glm', system: 's', user: 'u', prefix: path.join(root, 'authoring/glm/nda-discloser'), parse: raw => parseArrayAnswer(raw), call: async () => ({ raw: recorded, reasoning: '', meta: { finishReason: 'stop' } }), context: { kind: 'items', author: 'glm', document: 'nda', side: 'discloser' } });
  return root;
}
test('apply returns rejected items once; a fixed replacement is applied, a still-broken one is dropped', async () => {
  const bad = clone(GOOD[1]); bad.edits[0].find = 'no such words';
  const bad2 = clone(GOOD[2]); bad2.rule = 'NDA-99';
  const root = await batchRoot([...GOOD, bad, bad2]);
  const calls = [];
  const stub = async ({ user }) => { calls.push(JSON.parse(user).resubmission); const fixed = { ...clone(GOOD[1]), rule: 'NDA-08', replaces: 7 }; const still = { ...clone(bad2), replaces: 8 }; return { raw: JSON.stringify([fixed, still]), reasoning: '', meta: {} }; };
  const r = await applyBatch({ author: 'glm', document: 'nda', side: 'discloser', root, call: stub });
  assert.equal(calls.length, 1, 'one further call');
  assert.deepEqual(calls[0].rejectedItems.map(i => i.number), [7, 8]);
  // Item 7's replacement uses NDA-08 a second time (allowed: two per rule); item 8 still names an unknown rule.
  const items = loadItems(root).items;
  assert.equal(items.find(i => i.id === 'A-glm-nda-discloser-07').status, 'applied');
  assert.equal(items.find(i => i.id === 'A-glm-nda-discloser-07').apply.attempt, 2);
  const d = items.find(i => i.id === 'A-glm-nda-discloser-08'); assert.equal(d.status, 'dropped'); assert.match(d.apply.error, /not in the playbook/);
  assert.equal(r.summary.applied, 7); assert.equal(r.summary.dropped, 1);
  const manifest = readJson(path.join(root, 'manifest.json')); assert.equal(manifest.variants.length, 7); assert.ok(manifest.canary);
  assert.ok(existsSync(path.join(root, 'variants/A-glm-nda-discloser-04.json')));
  const v4 = readJson(path.join(root, 'variants/A-glm-nda-discloser-04.json')); assert.ok(v4.canary); assert.ok(v4.paragraphs.some(p => p.id === 'p24a'));
  const plant = manifest.variants.find(v => v.id === 'A-glm-nda-discloser-01').plants[0];
  assert.equal(plant.fixes[0].restore, nda.paragraphs.get('p7')); assert.match(plant.fixes[0].planted, /1 year/);
  // Re-running apply does not call again (the resubmission is stored).
  await applyBatch({ author: 'glm', document: 'nda', side: 'discloser', root, call: async () => { throw Error('called twice'); } });
});
test('a missing family is asked for by naming replaceable items; --no-call stops before writing', async () => {
  const root = await batchRoot([GOOD[0], GOOD[1], { ...clone(GOOD[5]) }]);
  const r = await applyBatch({ author: 'glm', document: 'nda', side: 'discloser', root, noCall: true });
  assert.ok(r.pending.constraints.some(c => /deletion/.test(c)));
  assert.equal(existsSync(path.join(root, 'items.json')), false);
});

// ---- verify ---------------------------------------------------------------------------------------------------------
test('decide: verified only when both validators answer yes to everything that applies', () => {
  const dev = { author: 'glm', kind: 'deviation', verification: [] };
  assert.equal(decide(dev), 'applied');
  dev.verification = [toRecord('opus', dev, { q1: true, q2: true, q3: true })]; assert.equal(decide(dev), 'applied');
  dev.verification = [toRecord('opus', dev, { q1: true, q2: true, q3: false })]; assert.equal(decide(dev), 'contested');
  dev.verification = [toRecord('opus', dev, { q1: true, q2: true, q3: true }), toRecord('deepseek', dev, { q1: true, q2: true, q3: true })];
  assert.equal(decide(dev), 'verified');
  dev.verification[1] = toRecord('deepseek', dev, { q1: true, q2: false, q3: true, reasons: 'fix too weak' });
  assert.equal(decide(dev), 'contested');
  dev.verification[1] = toRecord('deepseek', dev, null); assert.equal(dev.verification[1].answered, false); assert.equal(decide(dev), 'contested');
  const ben = { author: 'opus', kind: 'benign', verification: [toRecord('glm', { kind: 'benign' }, { q1: true, q2: null, q3: null }), toRecord('deepseek', { kind: 'benign' }, { q1: false, reasons: 'departs' })] };
  assert.equal(recordYes(ben, ben.verification[0]), true); assert.equal(ben.verification[1].departs, true); assert.equal(decide(ben), 'contested');
});
test('decide: an item a validator says names a real company, product or person is contested (q4)', () => {
  const dev = { author: 'glm', kind: 'deviation', verification: [] };
  const yes = { q1: true, q2: true, q3: true };
  dev.verification = [toRecord('opus', dev, { ...yes, q4: false }), toRecord('deepseek', dev, { ...yes, q4: false })];
  assert.equal(dev.verification[0].namesReal, false); assert.equal(decide(dev), 'verified');
  dev.verification[1] = toRecord('deepseek', dev, { ...yes, q4: true, reasons: 'the edit names Oracle Corporation' });
  assert.equal(dev.verification[1].namesReal, true); assert.equal(decide(dev), 'contested');
  const ben = { author: 'opus', kind: 'benign', verification: [toRecord('glm', { kind: 'benign' }, { q1: true, q4: true })] };
  assert.equal(recordYes(ben, ben.verification[0]), false);
  assert.equal(toRecord('opus', dev, yes).namesReal, null, 'a missing q4 is recorded as null');
  assert.equal(recordYes(dev, { family: 'opus', answered: true, departs: true, fixOk: true, checkOk: true }), true, 'a record made before q4 is unaffected');
});
test('verifyChunk: one retry for omitted items; still missing means unanswered', async () => {
  const dir = tmp(); const presented = [{ ref: 'X01' }, { ref: 'X02' }]; const users = [];
  const call = async ({ user }) => { users.push(user); return users.length === 1 ? { raw: '{"answers":[{"ref":"X01","q1":true,"q2":true,"q3":true,"reasons":"ok"}]}', meta: {} } : { raw: 'I cannot.', meta: {} }; };
  const a = await verifyChunk({ family: 'deepseek', side: 's', playbook: {}, presented, dir, name: 'nda-discloser-1', call });
  assert.equal(users.length, 2); assert.match(users[1], /did not cover these items: X02/);
  assert.ok(a.has('X01')); assert.equal(a.has('X02'), false);
  assert.ok(existsSync(path.join(dir, 'nda-discloser-1.raw.json'))); assert.ok(existsSync(path.join(dir, 'nda-discloser-1.retry.raw.json')));
});
test('verifyChunk: an unparseable reply is retried once with the error quoted', async () => {
  const dir = tmp(); let n = 0;
  const call = async ({ user }) => (++n === 1 ? { raw: '<think>hmm</think>', meta: {} } : (assert.match(user, /could not be read/), { raw: '```json\n{"answers":[{"ref":"X01","q1":true,"q2":true,"q3":false,"reasons":"check too strict"}]}\n```', meta: {} }));
  const a = await verifyChunk({ family: 'glm', side: 's', playbook: {}, presented: [{ ref: 'X01' }], dir, name: 'c', call });
  assert.equal(n, 2); assert.equal(a.get('X01').q3, false);
});

// ---- markups --------------------------------------------------------------------------------------------------------
test('markup assembly by hash is deterministic, order-independent and non-overlapping', async () => {
  const root = await batchRoot(GOOD);
  await applyBatch({ author: 'glm', document: 'nda', side: 'discloser', root, call: async () => { throw Error('no call expected'); } });
  const store = loadItems(root); for (const i of store.items) i.status = 'verified';
  const m1 = drawMarkup(store.items, 'glm', 'nda', 'discloser'), m2 = drawMarkup([...store.items].reverse(), 'glm', 'nda', 'discloser');
  assert.deepEqual(m1, m2);
  assert.ok(!m1.short, JSON.stringify(m1));
  const touchedBy = id => store.items.find(i => i.id === id).edits.map(e => e.paragraph.replace('after:', ''));
  const all = m1.items.flatMap(touchedBy); assert.equal(new Set(all).size, all.length, 'paragraphs overlap');
  assert.equal(m1.items.length, 5); // four deviations (p7 is shared by one deviation and the benign edit) and one benign
  saveItems(root, store); writeFileSync(path.join(root, 'markups.json'), JSON.stringify({ markups: [m1] }));
  const { doc, plants } = markupVariant(m1, store.items); assert.equal(plants.length, 5);
  for (const p of plants.filter(p => p.fixes)) for (const f of p.fixes) if (!f.inserted) assert.equal(doc.paragraphs.find(x => x.id === f.paragraph).text, f.planted);
  rebuild(root); assert.ok(readJson(path.join(root, 'manifest.json')).variants.some(v => v.id === 'M-glm-nda-discloser' && v.markup));
});

// ---- raw output parsing, per executor --------------------------------------------------------------------------------
const ITEMS = JSON.stringify(GOOD.slice(0, 2));
test('GLM-style: reasoning channel beside an answer with prose and a fenced array', async () => {
  const fx = path.join(here, 'fixtures/glm-batch.recorded.json');
  const r = await callModel({ who: `replay:${fx}`, system: 's', user: 'u' });
  assert.ok(r.reasoning.length > 100, 'reasoning kept'); assert.equal(r.meta.executor, 'replay');
  const arr = parseArrayAnswer(r.raw); assert.equal(arr.length, 12); assert.ok(arr.every(x => x.kind && x.edits));
  assert.equal(r.meta.model, 'zai-org/glm-5.3-flash'); assert.equal(r.meta.finishReason, 'stop');
  // The recorded batch passes apply's rules item by item.
  for (const item of arr) assert.deepEqual(validateItem(item, ctx).errors, []);
});
test('GLM-style inline <think> with a draft array, then the final array: the final one is read', () => {
  const raw = `<think>Draft: [{"kind":"benign","edits":[]}] ... no, revise.</think>\nHere are the items:\n${ITEMS}`;
  assert.equal(parseArrayAnswer(raw).length, 2);
  assert.equal(stripReasoning('<think>a</think>b'), 'b'); assert.equal(stripReasoning('reasoning without open tag</think>[1]'), '[1]');
});
test('DeepSeek-style fenced JSON and an object wrapper (JSON-object mode) are read', () => {
  assert.equal(parseArrayAnswer('```json\n' + ITEMS + '\n```').length, 2);
  assert.equal(parseArrayAnswer(`{"items": ${ITEMS}}`).length, 2);
  assert.equal(parseArrayAnswer(`{"answers": [{"ref":"X01","q1":true}]}`, { expectKey: 'answers' })[0].ref, 'X01');
});
test('Opus-style bare array, and an empty or prose-only answer is an error', () => {
  assert.equal(parseArrayAnswer(ITEMS).length, 2);
  assert.throws(() => parseArrayAnswer(''), /empty/); assert.throws(() => parseArrayAnswer('I could not do this [sorry].'), /no parseable JSON/);
  assert.deepEqual(parseObjectAnswer('note {"points": []} end').points, []);
});
test('streamed OpenAI-compatible output: content, reasoning, finish and served model are kept', async () => {
  const sse = ev => `data: ${JSON.stringify(ev)}\n\n`;
  const chunks = [sse({ model: 'zai-org/glm-5.3-flash', choices: [{ delta: { reasoning_content: 'Let me think. ' } }] }), sse({ choices: [{ delta: { reasoning_content: 'Done.' } }] }), sse({ choices: [{ delta: { content: '[{"kind":"benign",' } }] }), sse({ choices: [{ delta: { content: '"edits":[]}]' }, finish_reason: 'stop' }] }), sse({ usage: { completion_tokens: 9 }, choices: [] }), 'data: [DONE]\n\n'];
  const body = (async function* () { for (const c of chunks) yield new TextEncoder().encode(c); })();
  const r = await readStream(body);
  assert.equal(r.text, '[{"kind":"benign","edits":[]}]'); assert.equal(r.reasoning, 'Let me think. Done.'); assert.equal(r.finish, 'stop'); assert.equal(r.served, 'zai-org/glm-5.3-flash'); assert.equal(r.usage.completion_tokens, 9);
});
test('a call that spends its budget reasoning is recorded as such, and the retry asks for brief reasoning', async () => {
  const root = tmp(); const users = [];
  const call = async ({ user }) => { users.push(user); return users.length === 1 ? { raw: '', reasoning: 'x'.repeat(5000), meta: { finishReason: 'length', reasoningChars: 5000 } } : { raw: ITEMS, reasoning: '', meta: { finishReason: 'stop' } }; };
  const r = await runBatch({ who: 'glm', system: 's', user: 'u', prefix: path.join(root, 'b'), parse: raw => parseArrayAnswer(raw), call, context: {} });
  assert.equal(r.meta.status, 'ok'); assert.equal(r.meta.attempts[0].meta.budgetExhausted, true); assert.match(users[1], /output limit was reached while reasoning/);
  assert.equal(r.meta.used, 'b.retry.raw.json');
  assert.match(retryNote('x', { rawText: 'abc', finishReason: 'stop' }), /could not be used: x/);
});
test('three unusable answers leave the batch missing (P4)', async () => {
  const root = tmp(); let n = 0;
  const r = await runBatch({ who: 'glm', system: 's', user: 'u', prefix: path.join(root, 'b'), parse: raw => parseArrayAnswer(raw), call: async () => (n++, { raw: 'no', meta: {} }), context: {} });
  assert.equal(n, 3); assert.equal(r.meta.status, 'missing');
});
test('scenario plan assigns other counterparties from the roster: deterministic, distinct within an author', () => {
  const counts = { 'csa-customer': 4, 'csa-vendor': 4, 'nda-discloser': 4, 'nda-recipient': 4 };
  const names = plan => plan.map(p => p.parties.others.map(e => e.name));
  const a = scenarioPlan(counts, 'glm'), b = scenarioPlan(counts, 'glm');
  assert.deepEqual(names(a), names(b), 'same author, same assignment');
  assert.deepEqual(names(scenarioPlan({ ...counts, 'csa-vendor': 1 }, 'glm')), names(a), 'the fallback moves sides, not names');
  const flat = names(a).flat(); assert.equal(flat.length, 20); assert.equal(new Set(flat).size, 20, 'no name reused across the author\'s ten calls');
  const roster = loadRoster(); const docParties = Object.values(roster.documentParties).flatMap(d => d.parties.map(p => p.name));
  assert.ok(flat.every(n => roster.companies.some(c => c.name === n) && !docParties.includes(n)), 'others come from the companies, never the document parties');
  assert.notDeepEqual(names(scenarioPlan(counts, 'opus')), names(a), 'the hash takes the scenario id, so authors differ');
  assert.ok(a.every(p => p.parties.others.every(e => /\.example$/.test(e.domain))));
  assert.equal(scenarioPlan(counts)[0].parties, undefined, 'no author, no names');
  // the roster itself: about 40 companies, distinct names, aliases and domains, all .example
  assert.ok(roster.companies.length >= 40); assert.match(roster.about, /GPL-3\.0-or-later/);
  const all = [...roster.companies, ...Object.values(roster.documentParties).flatMap(d => d.parties)];
  const keys = all.flatMap(e => [e.name, ...e.aliases].map(n => n.toLowerCase()));
  assert.equal(new Set(keys).size, keys.length, 'no name or alias shared by two entries');
  assert.equal(new Set(all.map(e => e.domain)).size, all.length); assert.ok(all.every(e => /^[a-z0-9-]+\.example$/.test(e.domain)));
});
test('scenario plan keeps the kind quotas and moves calls off a thin side', () => {
  const plan = scenarioPlan({ 'csa-customer': 4, 'csa-vendor': 4, 'nda-discloser': 4, 'nda-recipient': 4 });
  const count = k => plan.filter(p => p.kind === k).length;
  assert.deepEqual([count('relevant-precedent'), count('concession'), count('wrong-counterparty'), count('injection')], [3, 3, 2, 2]);
  for (const [d, s] of [['csa', 'customer'], ['csa', 'vendor'], ['nda', 'discloser'], ['nda', 'recipient']]) assert.ok(plan.filter(p => p.document === d && p.side === s).length >= 2);
  const thin = scenarioPlan({ 'csa-customer': 4, 'csa-vendor': 1, 'nda-discloser': 4, 'nda-recipient': 4 });
  assert.equal(thin.filter(p => p.document === 'csa' && p.side === 'vendor').length, 1); assert.equal(thin.filter(p => p.document === 'csa').length, 5);
});
