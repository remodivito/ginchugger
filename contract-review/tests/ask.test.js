// SPDX-License-Identifier: GPL-3.0-or-later
// Ask flags what it cannot verify instead of refusing the answer (audit item 2, 9 Oct 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { askQuestion } from '../server/review.js';

const document = { id: 'd', revision: 1, title: 'NDA', paragraphs: [{ id: 'p0', text: 'The Receiving Party may use a fallback non-solicit only if approved by the General Counsel.' }] };
const playbook = { version: 1, rules: [{ id: 'S-06', title: 'Non-solicit', guidance: 'Prefer none.', enabled: true }] };
async function ask(answer) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ask-')); writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify(answer));
  const saved = { ...process.env }; process.env.REVIEW_EXECUTOR = 'replay'; process.env.REVIEW_REPLAY_DIR = dir; delete process.env.REVIEW_TRACE_DIR;
  try { return await askQuestion({ document, playbook, question: 'Who must approve a fallback?', mode: 'live' }); }
  finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}

test('an answer that uses "approved" in its ordinary sense is returned, not refused', async () => {
  const r = await ask({ answer: 'A fallback must be approved by the General Counsel.', evidence: [{ paragraphId: 'p0', quote: 'only if approved by the General Counsel' }], ruleIds: ['S-06'], limits: [] });
  assert.match(r.answer, /approved by the General Counsel/); assert.equal(r.evidence[0].verified, true); assert.deepEqual(r.limits, []);
});

test('unverifiable quotes, unknown rules and a missing basis are flagged in the limits; the answer is still shown', async () => {
  const r = await ask({ answer: 'Probably the CFO.', evidence: [{ paragraphId: 'p0', quote: 'approved by the CFO' }], ruleIds: ['S-06', 'X-1'], limits: ['Signatory list not supplied.'] });
  assert.equal(r.answer, 'Probably the CFO.'); assert.equal(r.evidence[0].verified, false); assert.deepEqual(r.ruleIds, ['S-06']);
  assert.match(r.limits.join(' '), /1 quote\(s\) could not be verified/); assert.match(r.limits.join(' '), /not in the active playbook: X-1/);
  assert.match(r.limits.join(' '), /No passage of the agreement was quoted in support/); assert.ok(r.limits.includes('Signatory list not supplied.'));
});

test('only an empty answer is refused, in plain words', async () => {
  await assert.rejects(ask({ answer: '', evidence: [] }), /No answer came back/);
  await assert.rejects(ask({ evidence: [] }), /No answer came back/);
});

test('a reply in prose is shown, marked as unchecked, after one more attempt (replay gives the same reply)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ask-')); writeFileSync(path.join(dir, 'ask.raw.txt'), 'The fallback needs **General Counsel** approval.');
  const saved = { ...process.env }; process.env.REVIEW_EXECUTOR = 'replay'; process.env.REVIEW_REPLAY_DIR = dir; delete process.env.REVIEW_TRACE_DIR;
  try {
    const r = await askQuestion({ document, playbook, question: 'Who must approve a fallback?' });
    assert.equal(r.answer, 'The fallback needs **General Counsel** approval.'); assert.equal(r.unchecked, true); assert.equal(r.model.retried, true);
    assert.deepEqual(r.evidence, []);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('the selection goes to the model with the question, bounded to this document\'s paragraphs', async () => {
  const { askSelection } = await import('../server/review.js');
  assert.deepEqual(askSelection({ text: ' only if approved ', paragraphIds: ['p0', 'p9', 7, 'p0'] }, document), { text: 'only if approved', paragraphIds: ['p0'] });
  assert.equal(askSelection({ text: '  ' }, document), null); assert.equal(askSelection(null, document), null);
  const dir = mkdtempSync(path.join(tmpdir(), 'ask-')); writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify({ answer: 'GC approval.', evidence: [] }));
  const trace = mkdtempSync(path.join(tmpdir(), 'ask-trace-'));
  const saved = { ...process.env }; process.env.REVIEW_EXECUTOR = 'replay'; process.env.REVIEW_REPLAY_DIR = dir; process.env.REVIEW_TRACE_DIR = trace;
  try {
    await askQuestion({ document, playbook, question: 'What does this mean?', selection: { text: 'only if approved', paragraphIds: ['p0'] } });
    const { readFileSync } = await import('node:fs');
    assert.deepEqual(JSON.parse(readFileSync(path.join(trace, 'ask.user.json'), 'utf8')).selection, { text: 'only if approved', paragraphIds: ['p0'] });
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
