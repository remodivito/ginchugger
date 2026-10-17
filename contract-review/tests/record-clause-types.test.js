// SPDX-License-Identifier: GPL-3.0-or-later
// Clause types (product v2 spec section 5.5, PR-REC-08, decision 159): CUAD's 41 categories, custom types only with
// addedOn, retired never removed, every rule of the customer, vendor and NDA playbooks mapped, unknown ids fail start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClauseTypes, validateClauseTypes, clauseTypes, CLAUSE_TYPES_PATH } from '../server/record/clause-types.js';
import { openLocalRecord } from '../server/record/local.js';
import { check } from '../server/record/admin.js';
import { freshRecord, tempDir } from './fixtures/record/helpers.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const file = JSON.parse(readFileSync(CLAUSE_TYPES_PATH, 'utf8'));
const frozen = {
  customer: ['tough-eval/playbook.json', 'tough-eval/playbook-bundle.json'],
  vendor: ['tough-eval/playbook-vendor.json'],
  nda: ['tough-eval/contractnli/playbook-nda.json'],
};

test('the shipped file is valid: 41 CUAD categories with the official names, custom types dated, a source cited', () => {
  const ct = loadClauseTypes();
  const cuad = file.types.filter(t => t.id.startsWith('cuad:'));
  assert.equal(cuad.length, 41);
  for (const name of ['Cap on Liability', 'Uncapped Liability', 'Governing Law', 'Anti-Assignment', 'Audit Rights', 'Termination for Convenience', 'Rofr/Rofo/Rofn', 'Third Party Beneficiary', 'Document Name']) assert.ok(cuad.some(t => t.name === name), name);
  assert.ok(cuad.every(t => t.source === 'CUAD v1 (Atticus Project, CC BY 4.0)'));
  assert.ok(file.types.filter(t => t.id.startsWith('custom:')).every(t => t.addedOn && t.source === 'custom'));
  assert.match(file.source, /TheAtticusProject\/cuad/);
  assert.equal(ct.typeFor('customer', 'C-01'), 'cuad:cap-on-liability');
  assert.equal(ct.typeFor('customer', 'C-13'), 'custom:data-deletion');
  assert.equal(ct.typeFor('nda', 'NDA-16'), 'custom:data-deletion');
  assert.equal(ct.typeFor('vendor', 'V-01'), 'cuad:cap-on-liability');
  assert.equal(ct.typeFor('nda', 'NOPE'), null);
});

test('every rule of the frozen customer, vendor and NDA playbooks maps to a type (the playbooks themselves are only read)', () => {
  const ct = loadClauseTypes();
  for (const [kind, files] of Object.entries(frozen)) for (const f of files) {
    const pb = JSON.parse(readFileSync(path.join(repo, f), 'utf8'));
    const missing = pb.rules.filter(r => !ct.typeFor(kind, r.id)).map(r => r.id);
    assert.deepEqual(missing, [], `${f} as ${kind}`);
  }
  // The product's own shipped playbooks map too.
  for (const [kind, f] of [['nda', 'contract-review/data/playbook.json'], ['order-form', 'contract-review/data/playbooks/order-form.json']]) {
    const pb = JSON.parse(readFileSync(path.join(repo, f), 'utf8'));
    assert.deepEqual(ct.unmapped([{ id: kind, rules: pb.rules }]), [], f);
  }
});

test('validation: an unknown type in a mapping, a custom type without addedOn, a missing CUAD category or a retired type without a date fail', () => {
  const clone = () => structuredClone(file);
  const unknown = clone(); unknown.mappings.customer['C-01'] = 'cuad:made-up';
  assert.throws(() => validateClauseTypes(unknown), /unknown type "cuad:made-up"/);
  const undated = clone(); delete undated.types.find(t => t.id === 'custom:data-deletion').addedOn;
  assert.throws(() => validateClauseTypes(undated), /without addedOn/);
  const short = clone(); short.types = short.types.filter(t => t.id !== 'cuad:insurance');
  assert.throws(() => validateClauseTypes(short), /41 categories/);
  const retired = clone(); retired.types.find(t => t.id === 'custom:publicity').status = 'retired';
  assert.throws(() => validateClauseTypes(retired), /retiredOn/);
  const dup = clone(); dup.types.push({ ...dup.types[0] });
  assert.throws(() => validateClauseTypes(dup), /duplicate/);
  // An invalid file fails the record's start.
  const bad = path.join(tempDir(), 'clause-types.json'); writeFileSync(bad, JSON.stringify(unknown));
  assert.throws(() => openLocalRecord({ dataDir: tempDir(), clauseTypesPath: bad }), /unknown type/);
});

test('a retired type still resolves for old events and still gives positions', () => {
  const f = structuredClone(file);
  Object.assign(f.types.find(t => t.id === 'custom:confidentiality-term'), { status: 'retired', retiredOn: '2026-10-16' });
  const ct = clauseTypes(validateClauseTypes(f));
  assert.equal(ct.get('custom:confidentiality-term').status, 'retired');
  assert.equal(ct.typeFor('nda', 'DUR-01'), 'custom:confidentiality-term');
});

test('gcl check warns on enabled rules with no mapping and leaves disabled ones alone', async () => {
  const { record } = await freshRecord();
  await record.playbooks.create({ id: 'lease', title: 'Leases', draft: { rules: [
    { id: 'L-01', title: 'Rent review', guidance: 'Upward only is not acceptable.' },
    { id: 'L-02', title: 'Break clause', guidance: 'Tenant break at year 3.', enabled: false },
  ] } }, 'jane');
  const c = await check(record);
  assert.ok(c.ok);
  assert.ok(c.warnings.includes('rule L-01 of playbook lease has no clause type'));
  assert.ok(!c.warnings.some(w => w.includes('L-02')));
  assert.ok(!c.warnings.some(w => / of playbook (nda|order-form) /.test(w)), 'the shipped playbooks are fully mapped');
});
