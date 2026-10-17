// SPDX-License-Identifier: GPL-3.0-or-later
// Two shipped playbooks with honest scopes (Phase 7, P3): the NDA playbook keeps duration, use and retention; the
// order-form playbook takes payment, cap and indemnity and adds the order-form entries. Both are demonstration only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validatePlaybook } from '../server/playbook.js';

const load = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const nda = load('../data/playbook.json'), orderForm = load('../data/playbooks/order-form.json');
const REC = new URL('../data/recorded-runs/demo-fixture/', import.meta.url);

test('both seed playbooks validate and carry "applies to" and the demonstration label', () => {
  for (const pb of [nda, orderForm]) {
    const clean = validatePlaybook(pb); assert.equal(clean.rules.length, pb.rules.length);
    assert.ok(clean.appliesTo?.label && clean.appliesTo.phrases.length, `${pb.id} says what it applies to`);
    assert.match(pb.title, /demonstration/i); assert.match(pb.provenance, /not any organisation's policy/i);
    for (const r of pb.rules) assert.doesNotMatch(JSON.stringify(r), /\b(high|medium|low|critical)[- ]risk\b|risk (rating|tier|matrix)/i, 'no risk scheme is implied');
  }
  assert.deepEqual(nda.rules.map(r => r.id), ['DUR-01', 'USE-01', 'RET-01']);
  assert.deepEqual(orderForm.rules.map(r => r.id), ['PAY-01', 'CAP-01', 'IND-01', 'REN-01', 'PRI-01', 'TFC-01', 'LAW-01', 'PRE-01']);
  for (const r of orderForm.rules.slice(3)) assert.ok(r.preferred && (r.acceptable || r.escalation || r.hardLine), `${r.id} has tiers`);
  assert.ok(orderForm.rules.find(r => r.id === 'PRE-01').hardLine, 'an order form that tries to override the main terms has a stated position');
});

test('no rule id cited by a recorded run has moved out of the playbook that run used', () => {
  const ids = { nda: new Set(nda.rules.map(r => r.id)), 'order-form': new Set(orderForm.rules.map(r => r.id)) };
  const all = new Set([...ids.nda, ...ids['order-form'], 'CAP-01', 'IND-01', 'PAY-01']);
  const files = readdirSync(REC).filter(f => f.endsWith('.raw.txt')); assert.ok(files.length >= 8);
  let checked = 0;
  for (const f of files) {
    const cited = [...new Set(readFileSync(new URL(f, REC), 'utf8').match(/\b[A-Z]{3}-\d{2}\b/g) || [])].filter(x => all.has(x));
    const used = f.includes('@orderform') ? 'order-form' : 'nda';
    for (const id of cited) { assert.ok(ids[used].has(id), `${f} cites ${id}, which is not in the ${used} playbook`); checked++; }
  }
  assert.ok(checked > 0);
});
