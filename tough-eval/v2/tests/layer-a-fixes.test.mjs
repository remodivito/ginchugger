// SPDX-License-Identifier: GPL-3.0-or-later
// The layer A fixes made before the frozen run (17 October 2026): the side-parameterised plain prompt (fix 3), the Cover
// Page as a secondary target of NDA plants on the Standard Terms (fix 2), acceptable wording for inserted clauses (fix 4),
// typographic normalisation in the eval's quote check (fix 5), and the preliminary item set kept scorable.
// Run: node --test tough-eval/v2/tests/layer-a-fixes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillPrompt, partyOf } from '../../arms/render-prompt.mjs';
import { typo, reverifyQuotes, complies } from '../../score.mjs';
import { coverPageSecondary } from '../lib/items.mjs';
import { suiteOfRun, loadSuite, PRELIM_SNAPSHOT } from '../../suite.mjs';

const TE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const j = f => JSON.parse(readFileSync(path.join(TE, f), 'utf8'));
const strip = ({ canary, ...x }) => x;

test('fix 3: the plain prompt names the side its playbook is for, on all four sides and on layer B', () => {
  const text = readFileSync(path.join(TE, 'arms/plain.md'), 'utf8');
  assert.ok(!/Customer/.test(text), 'plain.md must not hard-code the Customer');
  const want = { 'playbook-bundle.json': 'Customer', 'playbook-vendor.json': 'Provider', 'v2/playbook-nda-discloser.json': 'Disclosing Party', 'v2/playbook-nda-recipient.json': 'Receiving Party', 'contractnli/playbook-nda.json': 'client' };
  for (const [f, party] of Object.entries(want)) {
    const pb = strip(j(f)); assert.equal(partyOf(pb), party, f);
    const out = fillPrompt(text, pb); assert.ok(!/\{side\}|\{playbookParty\}/.test(out), `${f}: placeholder left`);
    assert.match(out, new RegExp(`^You are reviewing a contract for the ${party} against the ${party}'s playbook\\.`), f);
  }
});

test('fix 5: typographic quotes, dashes and spaces are normalised; words, case and ellipses are not', () => {
  assert.equal(typo('Provider’s “Fees” – due  now'), `Provider's "Fees" - due now`);
  const doc = new Map([['p1', 'Provider will share, at Customer’s request, a copy — redacted.'], ['p2', 'Other text.']]);
  const flags = [{ evidence: [{ paragraphId: 'p1', quote: "at Customer's request, a copy - redacted", verified: false }] },
    { evidence: [{ paragraphId: 'p1', quote: "at customer's request", verified: false }] },
    { evidence: [{ paragraphId: 'p2', quote: "at Customer's request", verified: false }] },
    { evidence: [{ paragraphId: 'p1', quote: 'a copy… redacted', verified: false }] },
    { evidence: [{ quote: 'Other  text.', verified: false }] }];
  assert.equal(reverifyQuotes(flags, doc), 2);
  assert.deepEqual(flags.map(f => f.evidence[0].verified), [true, false, false, false, true]);
});

test('fix 2: an NDA plant on the Standard Terms has the Cover Page lines as secondary targets; a Cover Page edit and the CSA do not', () => {
  const nda = strip(j('v2/base-nda.json')), csa = strip(j('v2/base-csa.json'));
  const ids = nda.paragraphs.filter(p => /^Changes to Standard Terms: None|^Neither party has changed the Standard Terms/.test(p.text)).map(p => p.id);
  assert.deepEqual(ids, ['p10', 'p12']);
  assert.deepEqual(coverPageSecondary({ edits: [{ paragraph: 'p19', find: 'x', replace: 'y' }] }, nda), ['p10', 'p12']);
  assert.deepEqual(coverPageSecondary({ edits: [{ paragraph: 'after:p24', find: '', replace: 'y' }] }, nda), ['p10', 'p12']);
  assert.deepEqual(coverPageSecondary({ edits: [{ paragraph: 'p7', find: 'x', replace: 'y' }] }, nda), []);
  assert.deepEqual(coverPageSecondary({ edits: [{ paragraph: 'after:p10', find: '', replace: 'y' }] }, nda), []);
  assert.deepEqual(coverPageSecondary({ edits: [{ paragraph: 'p95', find: 'x', replace: 'y' }] }, csa), []);
});

// The public repository holds the layer A items back until the frozen results are published; skip without them.
test('fix 4: every inserted-clause accept check fails on its planted clause and passes on its reference', { skip: !existsSync(path.join(TE, 'v2/inserted-checks.json')) && 'layer A items are held back in the public repository' }, () => {
  const ic = j('v2/inserted-checks.json'); assert.equal(ic.format, 'tough-eval-inserted-checks/1');
  const items = existsSync(path.join(TE, 'v2/items.json')) ? j('v2/items.json').items : [];
  for (const c of ic.checks) {
    assert.ok(complies(c.acceptReference, c.acceptCheck), `${c.item}: fails on its acceptReference`);
    const it = items.find(i => i.id === c.item); if (!it) continue;
    const ins = it.edits.find(e => e.paragraph.startsWith('after:'));
    assert.ok(ins, `${c.item}: not an inserted clause`); assert.ok(!complies(ins.replace, c.acceptCheck), `${c.item}: passes on the planted clause`);
    assert.equal(c.paragraph, `${ins.paragraph.slice(6)}a`, `${c.item}: paragraph id`);
  }
  // Negation-aware: a carve-out is compliant wording, the planted reach is not.
  const c19 = ic.checks.find(c => c.rule === 'C-19').acceptCheck;
  assert.ok(complies("On at least 30 days' notice, once per year, at Provider's cost, Provider may review usage records, without access to Customer's systems.", c19));
  assert.ok(!complies("On at least 30 days' notice, once per year, at Provider's cost, Provider may inspect Customer's systems.", c19));
  assert.ok(!complies("On at least 10 days' notice, once per year, at Provider's cost, Provider may review usage records.", c19));
});

test('preliminary runs are scored on the preliminary item set snapshot', () => {
  assert.equal(suiteOfRun({ suiteName: 'v2a', suite: 'v2a-dev' }), 'v2a-prelim');
  assert.equal(suiteOfRun({ suiteName: 'v2h', suite: 'v2a-dev+h25' }), 'v2h-prelim');
  assert.equal(suiteOfRun({ suiteName: 'v2a', suite: 'v2a-1' }), 'v2a');
  assert.equal(suiteOfRun({ suiteName: 'v2a-fixture', suite: 'v2a-dev' }), 'v2a-fixture');
  if (!existsSync(path.join(TE, PRELIM_SNAPSHOT, 'manifest.json'))) return;
  const s = loadSuite('v2a-prelim'); assert.ok(s.variants.length > 0);
  for (const v of s.variants) assert.ok(v.file.startsWith(PRELIM_SNAPSHOT + '/') && existsSync(path.join(TE, v.file)), v.id);
});
