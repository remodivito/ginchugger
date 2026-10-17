// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's live progress steps (server/ask-progress.js): what each store lookup says while it runs and once it is done.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolStepText, askProgress, possessive, learnTitles, progressRegistry, ndjsonLine } from '../server/ask-progress.js';

const ctx = { counterparty: 'Northgate Biosciences', documentId: 7, titles: new Map([[3, 'Pilot order form (signed)']]) };

test('each tool reads as a short step, present tense while running and past tense with what came back', () => {
  assert.equal(toolStepText('get_counterparty_overview', {}, null, 'start', ctx), 'Searching Northgate Biosciences’ documents');
  assert.equal(toolStepText('get_counterparty_overview', {}, { documentCount: 8 }, 'done', ctx), 'Searched Northgate Biosciences’ documents · 8 found');
  assert.equal(toolStepText('list_documents', { counterparty: 'Brightwater' }, { count: 2 }, 'done', ctx), 'Searched Brightwater’s documents · 2 found');
  assert.equal(toolStepText('list_documents', {}, { count: 40 }, 'done', ctx), 'Searched the documents · 40 found');
  assert.equal(toolStepText('search_documents', { query: 'liability cap' }, { count: 1 }, 'done', ctx), 'Searched for “liability cap” · 1 found');
  assert.equal(toolStepText('search_documents', { query: 'cap', counterparty: 'Brightwater' }, null, 'start', ctx), 'Searching Brightwater’s documents for “cap”');
  assert.equal(toolStepText('read_document', { documentId: 3 }, null, 'start', ctx), 'Reading Pilot order form (signed)');
  assert.equal(toolStepText('read_document', { documentId: 9 }, { document: { title: '2026 order form' } }, 'done', ctx), 'Read 2026 order form');
  assert.equal(toolStepText('read_document', { documentId: 9 }, null, 'start', ctx), 'Reading document 9');
  assert.equal(toolStepText('read_document', { documentId: 7 }, null, 'start', ctx), 'Reading this draft');
  assert.equal(toolStepText('read_document', { documentId: 9 }, { error: { code: 'not_found' } }, 'done', ctx), 'Read document 9 · failed');
  assert.equal(toolStepText('something_new', {}, null, 'start', ctx), 'Looking something up');
  assert.equal(possessive('A'.repeat(200)).length, 82, 'long names are cut');
});

test('titles from earlier results name the documents read later', () => {
  const titles = learnTitles({ types: [{ documents: [{ documentId: 4, title: 'MSA 2024' }] }], hits: [{ documentId: 5, title: 'Email' }] }, new Map());
  assert.deepEqual([...titles].sort(), [[4, 'MSA 2024'], [5, 'Email']]);
});

test('one Ask: the draft step, then each lookup as it starts and ends, matched by name and arguments; finish closes all', () => {
  const sent = [];
  const p = askProgress({ emit: s => sent.push(`${s.id}:${s.state}:${s.text}`), counterparty: 'Northgate', documentId: 7 });
  p.draft();
  p.onCall({ phase: 'start', name: 'get_counterparty_overview', args: {} });
  p.onCall({ phase: 'done', name: 'get_counterparty_overview', args: {}, result: { documentCount: 2, types: [{ documents: [{ documentId: 3, title: 'Pilot' }] }] } });
  p.onCall({ phase: 'start', name: 'read_document', args: { documentId: 3 } });
  p.finish();
  assert.deepEqual(sent, [
    'draft:active:Reading this draft', 'draft:done:Read this draft',
    't1:active:Searching Northgate’s documents', 't1:done:Searched Northgate’s documents · 2 found',
    't2:active:Reading Pilot', 't2:done:Read Pilot',
  ]);
  assert.ok(p.steps().every(s => s.state === 'done'));
  // A done event without its start (a listener that missed it) still shows as one finished step.
  const q = askProgress({ emit: s => sent.push(`${s.id}:${s.state}`) }); sent.length = 0;
  q.onCall({ phase: 'done', name: 'list_documents', args: {}, result: { count: 1 } });
  assert.deepEqual(sent, ['t1:active', 't1:done']);
  // The fallback without tools: the counterparty's documents as one step.
  const r = askProgress({ emit: s => sent.push(s.text) }); sent.length = 0;
  r.counterpartyDocuments('Brightwater'); r.counterpartyDocumentsDone('Brightwater', 3);
  assert.deepEqual(sent, ['Reading Brightwater’s documents', 'Read Brightwater’s documents · 3 found']);
});

test('steps so far by request, for the pane to poll: unknown or malformed ids give nothing; kept a while after the end', () => {
  let t = 0; const runs = progressRegistry({ ttlMs: 1000, max: 2, now: () => t });
  assert.equal(runs.open('bad id!'), null); assert.equal(runs.open('short'), null);
  runs.open('ask-000001');
  runs.step('ask-000001', { id: 'draft', text: 'Reading this draft', state: 'active' });
  runs.step('ask-000001', { id: 'draft', text: 'Read this draft', state: 'done' });
  runs.step(null, { id: 'x', text: 'ignored', state: 'active' });
  assert.deepEqual(runs.get('ask-000001'), { steps: [{ id: 'draft', text: 'Read this draft', state: 'done' }], done: false });
  runs.end('ask-000001'); assert.equal(runs.get('ask-000001').done, true);
  t = 2000; assert.deepEqual(runs.get('ask-000001'), { steps: [], done: false }, 'gone after the time to keep');
  runs.open('ask-000002'); runs.open('ask-000003'); runs.open('ask-000004');
  assert.equal(runs.get('ask-000002').done, false); assert.deepEqual(runs.get('ask-000002').steps, []);
});

test('NDJSON lines are padded to the size asked for and still parse', () => {
  const l = ndjsonLine({ type: 'step', step: { id: 'a' } }, 512);
  assert.equal(Buffer.byteLength(l), 513); assert.ok(l.endsWith('\n'));
  assert.deepEqual(JSON.parse(l), { type: 'step', step: { id: 'a' } });
  assert.equal(ndjsonLine({ a: 1 }), '{"a":1}\n');
});
