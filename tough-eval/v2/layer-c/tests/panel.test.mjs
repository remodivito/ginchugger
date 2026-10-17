// SPDX-License-Identifier: GPL-3.0-or-later
// Panel assignment (never the contestant's own family; Qwen breaks ties; replacement after a failed validity control),
// verdict combination, and the validity control's judge-versus-item attribution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, combine, needsTiebreak, validity, familyOf, JUDGES, ORDER } from '../panel.mjs';

const ok = pass => ({ ok: true, pass });
const failed = { ok: false, pass: null, errorClass: 'malformed' };

test('families of contestant model ids', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'anthropic'); assert.equal(familyOf('claude-sonnet-5-5'), 'anthropic');
  assert.equal(familyOf('zai-org/glm-5.3-flash'), 'zhipu'); assert.equal(familyOf('deepseek-ai/deepseek-v4-flash'), 'deepseek');
  assert.equal(familyOf('qwen/qwen3.8-27b'), 'alibaba'); assert.equal(familyOf('sample-mode'), null);
  assert.equal(familyOf('gemini-3.8-flash-high'), 'google'); assert.deepEqual(assign('google'), { judges: ['opus', 'glm'], tiebreak: 'deepseek', replaced: [] });
});

test('the spec\'s assignment: Claude → GLM + DeepSeek; GLM → Opus + DeepSeek; DeepSeek → Opus + GLM; Qwen breaks ties', () => {
  assert.deepEqual(assign('anthropic'), { judges: ['glm', 'deepseek'], tiebreak: 'qwen', replaced: [] });
  assert.deepEqual(assign('zhipu'), { judges: ['opus', 'deepseek'], tiebreak: 'qwen', replaced: [] });
  assert.deepEqual(assign('deepseek'), { judges: ['opus', 'glm'], tiebreak: 'qwen', replaced: [] });
});

test('a judge never grades its own family, whatever fails validity', () => {
  const fams = ['anthropic', 'zhipu', 'deepseek', 'alibaba', 'mistral', null];
  const failSets = [[], ['glm'], ['deepseek'], ['opus'], ['qwen'], ['glm', 'qwen']];
  for (const f of fams) for (const fv of failSets) {
    let p; try { p = assign(f, { failedValidity: fv }); } catch (e) { assert.match(e.message, /no panel of three/); continue; }
    for (const j of [...p.judges, p.tiebreak]) { assert.notEqual(JUDGES[j].family, f, `${j} judged its own family ${f}`); assert.ok(!fv.includes(j), `${j} failed validity yet sits on the panel`); }
    assert.equal(new Set([...p.judges, p.tiebreak]).size, 3);
  }
});

test('a judge that fails validity is replaced by the next family in order, recorded', () => {
  assert.deepEqual(assign('anthropic', { failedValidity: ['glm'] }), { judges: ['deepseek', 'qwen'], tiebreak: 'mistral', replaced: [{ judge: 'glm', by: 'mistral', reason: 'failed the panel validity control' }] });
  assert.deepEqual(assign('zhipu', { failedValidity: ['qwen'] }).tiebreak, 'mistral');
  assert.throws(() => assign('anthropic', { failedValidity: ['glm', 'deepseek'] }), /no panel of three/);
  assert.deepEqual(ORDER.slice(0, 3), ['opus', 'glm', 'deepseek']);
});

test('combination: agreement decides; disagreement or a missing judgement goes to the tiebreaker', () => {
  const panel = assign('anthropic');
  assert.deepEqual(combine(panel, { glm: ok(true), deepseek: ok(true) }), { pass: true, decidedBy: 'panel', agreed: true, votes: { glm: true, deepseek: true } });
  assert.equal(combine(panel, { glm: ok(false), deepseek: ok(false) }).pass, false);
  assert.ok(needsTiebreak(ok(true), ok(false))); assert.ok(needsTiebreak(ok(true), failed)); assert.ok(!needsTiebreak(ok(false), ok(false)));
  const tie = combine(panel, { glm: ok(true), deepseek: ok(false), qwen: ok(false) });
  assert.deepEqual([tie.pass, tie.decidedBy, tie.agreed], [false, 'tiebreak', false]);
  assert.deepEqual([combine(panel, { glm: ok(true), deepseek: ok(false), qwen: ok(true) }).pass, combine(panel, { glm: ok(true), deepseek: ok(false), qwen: ok(true) }).decidedBy], [true, 'tiebreak']);
  const missing = combine(panel, { glm: failed, deepseek: ok(true), qwen: ok(true) }); assert.deepEqual([missing.pass, missing.decidedBy, missing.agreed], [true, 'tiebreak', null]);
  assert.deepEqual([combine(panel, { glm: ok(true), deepseek: ok(false) }).decidedBy, combine(panel, { glm: ok(true), deepseek: ok(false), qwen: failed }).pass], ['undecided', null]);
  assert.equal(combine(panel, { glm: failed, deepseek: ok(true), qwen: ok(false) }).decidedBy, 'undecided');
});

test('validity control: wrong where another judge is right fails the judge; an item all judges miss is the item\'s fault', () => {
  const rows = [];
  const add = (output, criterion, expected, verdicts) => { for (const [judge, verdict] of Object.entries(verdicts)) rows.push({ output, criterion, judge, verdict, expected }); };
  add('golden', 'C-1', true, { opus: true, glm: true, deepseek: false, qwen: true });   // deepseek wrong, others right
  add('empty', 'C-1', false, { opus: false, glm: false, deepseek: false, qwen: false });
  add('golden', 'C-2', true, { opus: false, glm: false, deepseek: false, qwen: false }); // everyone "wrong": the item's fault
  add('empty', 'C-2', true, { opus: true, glm: null, deepseek: true, qwen: true });       // glm returned nothing
  const v = validity(rows);
  assert.deepEqual(v.failed, ['deepseek', 'glm']);
  assert.equal(v.judges.opus.ok, true); assert.equal(v.judges.qwen.ok, true);
  assert.deepEqual(v.judges.deepseek.wrong, [{ output: 'golden', criterion: 'C-1', verdict: false, expected: true }]);
  assert.deepEqual(v.judges.glm.missing, [{ output: 'empty', criterion: 'C-2' }]);
  assert.equal(v.criterionFailures.length, 1); assert.equal(v.criterionFailures[0].criterion, 'C-2');
  assert.equal(v.judges.opus.itemFaults.length, 1, 'recorded against the item, not the judge');
});
