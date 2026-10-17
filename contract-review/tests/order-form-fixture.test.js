// SPDX-License-Identifier: GPL-3.0-or-later
// The order-form fixture (Phase 7, P1): the files are what the builder makes, byte for byte; the importer reads every
// tracked change with its original text; and the markup with its tracked changes undone is the form as sent, word for word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDocx } from '../server/docx.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const DIR = path.join(root, 'data/fixtures/order-form'); const read = f => readFileSync(path.join(DIR, f));
const truth = JSON.parse(read('truth.json'));
const SENT = 'helix-northgate-order-form-v1.docx', MARKUP = 'helix-northgate-order-form-v2-customer-markup.docx';

test('the fixture holds the form, the markup, the email, the policy note, truth and a README naming source, licence and fictional parties', () => {
  for (const f of [SENT, MARKUP, '2026-06-04-northgate-returns-order-form.eml', 'policy-note.txt', 'truth.json', 'README.md']) assert.ok(existsSync(path.join(DIR, f)), f);
  const readme = read('README.md').toString();
  assert.match(readme, /licen[cs]e/i); assert.match(readme, /fictional/i); assert.match(readme, /Common Paper/); assert.match(readme, /Northgate Biosciences Ltd/);
  for (const [name, hash] of Object.entries(truth.sha256)) assert.equal(createHash('sha256').update(read(name)).digest('hex'), hash, `${name} matches the hash the builder recorded`);
});

test('the builder reproduces every file byte for byte', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'order-form-build-'));
  const r = spawnSync(process.execPath, ['scripts/build-order-form-fixture.mjs'], { cwd: root, env: { ...process.env, ORDER_FORM_OUT: out }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const built = readdirSync(out).sort(); assert.deepEqual(built, [...Object.keys(truth.sha256), 'truth.json'].sort());
  for (const f of built) assert.ok(readFileSync(path.join(out, f)).equals(read(f)), `${f} is byte-identical`);
});

test('the importer reads every tracked change with its original text, under the customer\'s name', async () => {
  const markup = await importDocx(read(MARKUP), MARKUP);
  const changed = markup.paragraphs.filter(p => p.originalText !== p.text);
  assert.deepEqual(changed.map(p => p.id), truth.changes.v2.map(c => c.paragraph));
  const sent = await importDocx(read(SENT), SENT);
  for (const p of changed) { const before = sent.paragraphs.find(x => x.id === p.id); assert.equal(p.originalText, before.text, `${p.id} keeps its original wording`); assert.notEqual(p.text, before.text); }
  assert.ok(changed.some((p, i) => i > 0 && Number(p.id.slice(1)) === Number(changed[i - 1].id.slice(1)) + 1), 'two neighbouring clauses are changed');
  assert.equal(truth.changes.v2.filter(c => !c.playbook).length, 1, 'one change is not covered by the playbook');
  const xml = (await (await import('jszip')).default.loadAsync(read(MARKUP))).file('word/document.xml');
  assert.match(await xml.async('string'), /w:author="Daniel Osei \(Northgate\)"/);
});

test('the markup with its tracked changes undone is the form as sent, word for word', async () => {
  const markup = await importDocx(read(MARKUP), MARKUP); const sent = await importDocx(read(SENT), SENT);
  assert.deepEqual(markup.paragraphs.map(p => p.originalText), sent.paragraphs.map(p => p.text));
  assert.deepEqual(sent.paragraphs.filter(p => p.originalText !== p.text), [], 'the form as sent carries no tracked changes');
});
