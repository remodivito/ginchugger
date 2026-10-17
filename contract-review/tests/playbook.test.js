// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeRule, validatePlaybook, importProsePlaybook, makeStore, TIERS } from '../server/playbook.js';

const seed = new URL('../data/playbook.json', import.meta.url);

test('existing rules migrate to the widened schema without loss', () => {
  const pb = JSON.parse(readFileSync(seed, 'utf8'));
  const clean = validatePlaybook(pb);
  assert.equal(clean.rules.length, pb.rules.length);
  for (const [a, b] of clean.rules.map((r, i) => [r, pb.rules[i]])) { for (const k of ['id', 'title', 'topic', 'guidance', 'fallback', 'enabled']) assert.deepEqual(a[k], b[k]); assert.deepEqual(a.conditions, b.conditions); }
  const widened = normalizeRule({ id: 'X', title: 'Term', guidance: 'Three years.', preferred: '3 years', acceptable: 'up to 5', escalation: 'above 5: GC', hardLine: 'never perpetual', sources: [{ document: 'policy-note.md', paragraph: 'p3', quote: 'Up to five years is acceptable.' }] });
  for (const t of TIERS) assert.ok(widened[t]);
  assert.equal(widened.sources[0].quote, 'Up to five years is acceptable.');
  assert.throws(() => normalizeRule({ id: 'Y', title: '', guidance: 'x' }), /unique ID, title and guidance/);
  assert.throws(() => validatePlaybook({ rules: [{ id: 'A', title: 't', guidance: 'g' }, { id: 'A', title: 't', guidance: 'g' }] }), /unique ID/);
});

test('mechanical import of the Velantis prose playbook yields one entry per section with tiers and source references', () => {
  const text = readFileSync(new URL('./fixtures/playbooks/velantis-nda-negotiation-playbook.txt', import.meta.url), 'utf8');
  const entries = importProsePlaybook(text, { sourceName: 'velantis-nda-negotiation-playbook.docx' });
  assert.equal(entries.length, 19);
  const term = entries.find(e => e.id === 'S-05');
  assert.match(term.title, /Confidentiality Term/); assert.ok(term.guidance.length > 1000);
  assert.ok(term.acceptable && /shorter/i.test(term.acceptable)); assert.ok(term.hardLine && /two \(2\) years/i.test(term.hardLine)); assert.equal(term.fallback, term.acceptable);
  assert.equal(term.sources[0].document, 'velantis-nda-negotiation-playbook.docx'); assert.match(term.sources[0].paragraph, /^p\d+–p\d+$/);
  const total = entries.reduce((n, e) => n + e.guidance.length, 0); assert.ok(total > 80000, 'lossless: nearly all rendered text lands in guidance');
  assert.doesNotThrow(() => validatePlaybook({ rules: entries }));
});

test('store: edits and activation move the change counter, stale saves are refused, no version history is kept', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-'));
  const store = makeStore({ dir, seedPath: fileURLToPath(seed) });
  const v1 = await store.getActive(); assert.equal(v1.version, 1);
  const v2 = await store.update({ ...v1, rules: [...v1.rules, { id: 'NEW-1', title: 'New', guidance: 'Guidance.', preferred: 'p' }] });
  assert.equal(v2.version, 2); assert.equal(v2.rules.at(-1).preferred, 'p'); assert.equal(v2.activatedFrom, 'edit');
  await assert.rejects(store.update({ ...v1, rules: v1.rules }), /changed/);
  const draft = { title: 'Imported', rules: importProsePlaybook(readFileSync(new URL('./fixtures/playbooks/velantis-nda-negotiation-playbook.txt', import.meta.url), 'utf8'), { sourceName: 'velantis.docx' }) };
  const v3 = await store.activate(draft, { origin: 'import' });
  assert.equal(v3.version, 3); assert.equal(v3.previousVersion, 2); assert.equal(v3.rules.length, 19);
  assert.equal(store.listVersions, undefined); assert.equal(store.getVersion, undefined);
  assert.deepEqual(readdirSync(dir), ['playbook.json'], 'one active playbook, no version files (decision 150)');
});

test('Add to playbook (R7.5): a saved entry is used by the next review while the earlier review result is unchanged', async () => {
  const { reviewDocument } = await import('../server/review.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'playbook-'));
  const store = makeStore({ dir, seedPath: seed });
  const document = { id: 'd1', title: 'NDA', revision: 0, paragraphs: [{ id: 'p1', text: 'Confidentiality lasts seven (7) years after termination.', originalText: 'Confidentiality lasts three (3) years after termination.' }] };
  const before = await store.getActive();
  // The model is the replay executor answering with no findings: this test is about the playbook, not the reading.
  const replay = mkdtempSync(path.join(tmpdir(), 'replay-')); writeFileSync(path.join(replay, 'review.raw.txt'), JSON.stringify({ findings: [], limits: [] }));
  const saved_ = { ...process.env }; Object.assign(process.env, { REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: replay }); delete process.env.REVIEW_TRACE_DIR;
  try {
  const first = await reviewDocument({ document, playbook: before });
  const snapshot = JSON.stringify(first.findings);
  const entry = { id: 'RULE-added', title: 'Term: seven acceptable for strategic customers', topic: 'custom', guidance: 'Accept up to seven years for strategic customers.', conditions: {}, fallback: '', enabled: true, wording: 'Confidentiality lasts seven (7) years after termination.', sources: [{ document: 'NDA', paragraph: 'p1', quote: 'seven (7) years' }] };
  const saved = await store.update({ ...before, rules: [...before.rules, entry] });
  assert.equal(saved.version, before.version + 1); assert.ok(saved.rules.some(r => r.id === 'RULE-added'));
  const next = await store.getActive(); assert.ok(next.rules.some(r => r.id === 'RULE-added'), 'the next review reads the new entry');
  assert.equal(JSON.stringify(first.findings), snapshot, 'the earlier result is not rewritten');
  assert.equal(first.playbookVersion, before.version);
  const second = await reviewDocument({ document, playbook: next }); assert.equal(second.playbookVersion, saved.version);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved_)) delete process.env[k]; Object.assign(process.env, saved_); }
});
