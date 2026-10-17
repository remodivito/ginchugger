// SPDX-License-Identifier: GPL-3.0-or-later
// Import: fetching at the pinned revision (verified by object id), the docx reader, the positions source (nothing from
// the rubric or the golden), the golden in the common shape, the tasks file (deterministic, every rubric line selected
// or excluded), and the committed layer-c-tasks.json (22 criteria: 9 as written, 13 adapted; 11 excluded).
// Run: node --test tough-eval/v2/layer-c/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchSource, checkSource, REVISION, TASKS } from '../source.mjs';
import { readDocx } from '../docx.mjs';
import { build, loadTasks, HERE } from '../import.mjs';
import { fakeHub, fixtureFiles, SELECTION, TASK, REV, docx, P } from './helpers.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'layer-c-import-'));
const GUID = '00000000-0000-4000-8000-000000000000';

test('the pinned revision is the one recorded for RedlineBench', () => {
  assert.equal(REVISION, REV); assert.deepEqual(TASKS, ['redline-s1-t3-g01a', 'redline-s2-t4-g03a', 'redline-s3-t4-g02a']);
});

test('fetch keeps only wanted files, verifies object ids, and the offline check catches a changed file', async () => {
  const dir = tmp(); const hub = fakeHub();
  const m = await fetchSource(dir, { tasks: [TASK], fetchImpl: hub.fetchImpl, log: () => {} });
  assert.equal(m.revision, REV); assert.equal(m.cardLicence, 'cc-by-4.0');
  assert.ok(hub.calls.every(u => u.includes(REV)), 'every request names the pinned revision');
  const paths = m.tasks[TASK].map(f => f.path);
  assert.ok(paths.includes('tests/attorney_redlines.docx') && paths.includes('environment/app/contract.docx'));
  assert.ok(!paths.includes('tests/judge.py'), 'verifier code is not fetched');
  assert.ok(existsSync(path.join(dir, TASK, 'contract.docx')), 'environment/app/ flattened');
  checkSource(dir);
  writeFileSync(path.join(dir, TASK, 'instruction.md'), 'changed');
  assert.throws(() => checkSource(dir), /differs from the pinned revision/);
});

test('fetch refuses bytes that do not match the dataset object id', async () => {
  const hub = fakeHub(fixtureFiles(), { tamper: 'tests/rubrics.json' });
  await assert.rejects(fetchSource(tmp(), { tasks: [TASK], fetchImpl: hub.fetchImpl, log: () => {} }), /do not match the dataset's object id/);
});

test('docx reader: top-level paragraphs only, current and original text, markup with authors, comments anchored', () => {
  const d = readDocx(docx([P.r('Plain.'), `${P.r('Cap')}${P.ins('Trainer 1 - LargeCo', ' raised')}${P.del('Trainer 1 - LargeCo', ' lowered')}${P.r('.')}`, `${P.anchor(3)}${P.r('Commented.')}`], [{ id: 3, author: 'Trainer 2 - AgentCo', text: 'Why?' }]));
  assert.deepEqual(d.paragraphs.map(p => p.id), ['p-000', 'p-001', 'p-002'], 'table paragraphs are outside the view');
  assert.deepEqual(d.paragraphs[1], { id: 'p-001', text: 'Cap raised.', originalText: 'Cap lowered.' });
  assert.equal(d.paragraphs[0].text, 'Plain.', 'tab-stop definitions are not text');
  assert.deepEqual(d.markup['p-001'].map(s => [s.kind, s.author]), [[null, null], ['ins', 'Trainer 1 - LargeCo'], ['del', 'Trainer 1 - LargeCo'], [null, null]]);
  assert.deepEqual(d.comments, [{ id: '3', author: 'Trainer 2 - AgentCo', text: 'Why?', paragraphId: 'p-002' }]);
});

async function built() {
  const src = tmp(), out = tmp(); await fetchSource(src, { tasks: [TASK], fetchImpl: fakeHub().fetchImpl, log: () => {} });
  return { src, out, t: build({ source: src, out, guid: GUID, selection: SELECTION }) };
}

test('build: document shape, positions from the instructions only, golden in the common shape', async () => {
  const { out, t } = await built(); const task = t.tasks[0];
  const doc = JSON.parse(readFileSync(path.join(out, 'documents', `${TASK}.json`), 'utf8'));
  assert.equal(doc.canary, GUID); assert.equal(doc.id, `C-${TASK}`);
  assert.deepEqual(Object.keys(doc).sort(), ['canary', 'id', 'paragraphs', 'revision', 'title'], 'nothing beyond the product document shape');
  assert.deepEqual(doc.paragraphs[1], { id: 'p-001', text: '2. Cap. Liability shall not exceed the fees paid in 12 months or $1,000,000.', originalText: '2. Cap. Liability shall not exceed the fees paid in 12 months.' });
  const pb = JSON.parse(readFileSync(path.join(out, 'playbooks', `${TASK}.json`), 'utf8'));
  assert.equal(pb.party, 'AgentCo');
  assert.deepEqual(pb.rules.map(r => r.id), ['RB-REP', 'RB-TURN', 'RB-HYG', 'RB-01', 'RB-02', 'RB-03']);
  assert.match(pb.rules.find(r => r.id === 'RB-02').guidance, /Protect the cap at fees paid in the prior twelve months/);
  const pbText = JSON.stringify(pb);
  for (const leak of ['rubric_', 'justification', '$1,000,000', 'We can’t accept testing', 'Trainer']) assert.ok(!pbText.includes(leak), `playbook must not carry ${leak}`);
  assert.ok(!/\.py\b/.test(pbText), 'tool mechanics removed'); assert.match(pbText, /Propose a change that walks the change back/);
  const golden = JSON.parse(readFileSync(path.join(out, 'golden', `${TASK}.json`), 'utf8'));
  assert.deepEqual(golden.changes.filter(c => !c.inserted).map(c => c.paragraphId), ['p-001', 'p-003']);
  assert.deepEqual(golden.changes.find(c => c.inserted), { afterParagraphId: 'p-003', text: '5. Notices. Notices are given in writing.', inserted: true });
  assert.deepEqual(golden.explanations, [{ paragraphId: 'p-003', text: 'We can’t accept testing of our systems.' }], 'only the attorney\'s new comments, anchored to the task document');
  assert.equal(task.golden.source, 'attorney-redline');
  assert.deepEqual(task.criteria.map(c => [c.id, c.kind, c.expect.empty]), [['C-s9-01', 'change', false], ['C-s9-02', 'keep', true], ['C-s9-03', 'change', false]]);
  assert.equal(task.criteria[0].attorney.criterion, 'Rejects in Section 2 the insertion of "or $1,000,000".');
  assert.equal(t.counts.excluded, 1);
});

test('build is deterministic and refuses a rubric line that is neither selected nor excluded', async () => {
  const { src, out } = await built(); const a = readFileSync(path.join(out, 'layer-c-tasks.json'));
  build({ source: src, out, guid: GUID, selection: SELECTION }); assert.deepEqual(readFileSync(path.join(out, 'layer-c-tasks.json')), a);
  const partial = { [TASK]: { ...SELECTION[TASK], excluded: [] } };
  assert.throws(() => build({ source: src, out: tmp(), guid: GUID, selection: partial }), /neither selected nor excluded/);
});

test('the committed layer-c-tasks.json: 3 tasks, 22 criteria (9 as written, 13 adapted), 11 excluded, golden for two', () => {
  const t = loadTasks(path.join(HERE, 'layer-c-tasks.json'));
  assert.deepEqual(t.counts, { tasks: 3, criteria: 22, transferAsWritten: 9, adapted: 13, change: 12, keep: 10, excluded: 11 });
  assert.equal(t.source.revision, REV);
  assert.deepEqual(t.tasks.map(x => [x.id, x.criteria.length, x.golden.source]), [['redline-s1-t3-g01a', 13, 'attorney-redline'], ['redline-s2-t4-g03a', 2, 'none'], ['redline-s3-t4-g02a', 7, 'attorney-redline']]);
  for (const x of t.tasks) for (const c of x.criteria) { assert.ok(c.adapted.length > 40 && c.attorney.criterion); assert.deepEqual(c.expect, { golden: true, empty: c.kind === 'keep' }); }
  for (const x of t.tasks.filter(y => y.golden.source === 'none')) assert.ok(x.criteria.every(c => c.kind === 'keep'), 'a task without a golden has only keep criteria');
});
