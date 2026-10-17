// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';
// Playbook library (Phase 7, P2): several playbooks, each with its own versions; the first keeps the old paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeLibrary, makeStore } from '../server/playbook.js';

const seedDir = mkdtempSync(path.join(tmpdir(), 'pb-seeds-'));
const seed = (name, body) => { const p = path.join(seedDir, `${name}.json`); writeFileSync(p, JSON.stringify(body)); return p; };
const ndaSeed = seed('nda', { version: 1, title: 'NDAs', appliesTo: { label: 'Mutual NDAs', phrases: ['non-disclosure agreement'] }, rules: [{ id: 'DUR-01', title: 'Duration', topic: 'duration', guidance: 'Three years.' }] });
const ofSeed = seed('order-form', { version: 1, title: 'Order forms', appliesTo: { label: 'Order forms', phrases: ['order form'] }, rules: [{ id: 'PAY-01', title: 'Payment', topic: 'payment', guidance: '30 days.' }] });
const library = dir => makeLibrary({ dir, seeds: [{ id: 'nda', seedPath: ndaSeed }, { id: 'order-form', seedPath: ofSeed }] });

test('list, read, update and activate work per playbook; editing one never changes another; no version history is kept', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-lib-')); const lib = library(dir);
  assert.deepEqual((await lib.list()).map(p => [p.id, p.version, p.rules, p.appliesTo.label]), [['nda', 1, 1, 'Mutual NDAs'], ['order-form', 1, 1, 'Order forms']]);
  assert.equal((await lib.get()).id, 'nda', 'no id means the first playbook');
  const of = await lib.get('order-form');
  const edited = await lib.update('order-form', { ...of, rules: [...of.rules, { id: 'REN-01', title: 'Renewal', topic: 'renewal', guidance: 'Twelve months.' }] });
  assert.equal(edited.id, 'order-form'); assert.equal(edited.version, 2); assert.equal(edited.appliesTo.label, 'Order forms');
  const nda = await lib.get('nda'); assert.equal(nda.version, 1); assert.deepEqual(nda.rules.map(r => r.id), ['DUR-01'], 'the NDA playbook is untouched');
  const activated = await lib.activate('order-form', { title: 'Order forms (imported)', rules: [{ id: 'X-1', title: 'X', guidance: 'Y.' }] }, { origin: 'import' });
  assert.equal(activated.version, 3); assert.equal(activated.id, 'order-form'); assert.equal(activated.appliesTo.label, 'Order forms', 'activation keeps what the playbook applies to');
  assert.equal(lib.listVersions, undefined); assert.equal(lib.getVersion, undefined);
  await assert.rejects(lib.update('nda', { ...nda, version: 0 }), /changed/);
  await assert.rejects(lib.get('unknown'), e => e.status === 404);
  assert.ok(existsSync(path.join(dir, 'playbooks', 'order-form', 'playbook.json')));
  assert.ok(!existsSync(path.join(dir, 'playbooks', 'order-form', 'playbook-versions')), 'no version files (decision 150)');
  assert.ok(!existsSync(path.join(dir, 'playbook.json')), 'the NDA playbook was never written');
});

test('a state folder from before the library opens with its playbook intact', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-legacy-'));
  // What the single store left behind: an active playbook with no id or "applies to".
  const old = makeStore({ dir, seedPath: fileURLToPath(new URL('../data/playbook.json', import.meta.url)) });
  const first = await old.getActive();
  const v2 = await old.update({ ...first, title: 'Provisional demonstration playbook', rules: [...first.rules, { id: 'OLD-9', title: 'Kept', guidance: 'Kept.' }] });
  const before = readFileSync(path.join(dir, 'playbook.json'), 'utf8');
  const lib = library(dir); const pb = await lib.get();
  assert.equal(pb.id, 'nda'); assert.equal(pb.version, v2.version); assert.deepEqual(pb.rules, v2.rules); assert.equal(pb.title, 'Provisional demonstration playbook');
  assert.equal(pb.appliesTo.label, 'Mutual NDAs', 'scope comes from the shipped seed when the old file has none');
  assert.equal(readFileSync(path.join(dir, 'playbook.json'), 'utf8'), before, 'opening it rewrites nothing');
  assert.equal((await lib.get('order-form')).version, 1, 'the new playbook starts from its seed beside it');
  const saved = await lib.update(undefined, { ...pb, rules: [...pb.rules, { id: 'NEW-1', title: 'New', guidance: 'New.' }] });
  assert.equal(saved.version, v2.version + 1); assert.ok(JSON.parse(readFileSync(path.join(dir, 'playbook.json'), 'utf8')).rules.some(r => r.id === 'NEW-1'), 'the old path is still the one written');
});

test('creating a playbook is an explicit action with a name; the others are unchanged', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-create-')); const lib = library(dir);
  await assert.rejects(lib.create({ title: '  ', draft: { rules: [] } }), /Name the new playbook/);
  const made = await lib.create({ title: 'Order forms (generated)', appliesTo: { label: 'Customer order forms', phrases: ['Order Form'] }, draft: { rules: [{ id: 'G-1', title: 'Payment', guidance: '30 days.' }] }, origin: 'generated' });
  assert.equal(made.id, 'order-forms-generated'); assert.equal(made.version, 1); assert.equal(made.title, 'Order forms (generated)'); assert.deepEqual(made.appliesTo, { label: 'Customer order forms', phrases: ['order form'] }); assert.equal(made.activatedFrom, 'generated');
  const again = await lib.create({ title: 'Order forms (generated)', draft: { rules: [{ id: 'G-1', title: 'P', guidance: 'Q.' }] } });
  assert.equal(again.id, 'order-forms-generated-2', 'a second playbook with the same name gets its own id');
  assert.deepEqual((await lib.list()).map(p => p.id), ['nda', 'order-form', 'order-forms-generated', 'order-forms-generated-2']);
  assert.equal((await lib.get('nda')).version, 1); assert.equal((await lib.get('order-form')).version, 1);
  assert.equal((await library(dir).get('order-forms-generated')).rules[0].id, 'G-1', 'a fresh library on the same folder finds it');
  const nda = await lib.create({ title: 'NDA', draft: { rules: [{ id: 'N', title: 'N', guidance: 'N.' }] } }); assert.equal(nda.id, 'nda-2', 'a shipped id is never taken');
});
