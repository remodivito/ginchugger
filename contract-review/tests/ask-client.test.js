// SPDX-License-Identifier: GPL-3.0-or-later
// The pane's Ask request (src/review/ask-client.js) in a webview that holds a streamed response back until it ends
// (17 Oct 2026, Word for Mac): the steps so far are polled from /api/ask/progress/:askId, and the answer is still read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askStream, mergeStep } from '../src/review/ask-client.js';

const enc = new TextEncoder();
function fakeFetch({ steps, release, chunked = true }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(String(url));
    if (String(url).startsWith('/api/ask/progress/')) return new Response(JSON.stringify({ steps: steps(), done: false }), { headers: { 'Content-Type': 'application/json' } });
    const body = '{"type":"start"}\n' + steps().map(s => JSON.stringify({ type: 'step', step: s })).join('\n') + '\n{"type":"answer","answer":{"answer":"Done."}}\n';
    // The whole body only once the test releases it: nothing reaches the reader before (a buffering webview).
    const stream = new ReadableStream({ async start(c) { await release; c.enqueue(enc.encode(body)); c.close(); } });
    return chunked ? new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }) : new Response(await release.then(() => body), { headers: { 'Content-Type': 'text/plain' } });
  };
  return { fn, calls };
}

test('no stream chunk for a while: the steps so far are polled and shown, then the answer arrives', async () => {
  let open; const release = new Promise(r => { open = r; });
  const now = [{ id: 'draft', text: 'Reading this draft', state: 'active' }];
  const { fn, calls } = fakeFetch({ steps: () => now, release });
  const saved = globalThis.fetch; globalThis.fetch = fn;
  try {
    const seen = [];
    const pending = askStream({ askId: 'ask-12345678', question: 'q' }, new AbortController().signal, s => seen.push(s), { quietMs: 30, everyMs: 20 });
    await new Promise(r => setTimeout(r, 150));
    assert.ok(calls.includes('/api/ask/progress/ask-12345678'), 'polled');
    assert.deepEqual(seen[0], { id: 'draft', text: 'Reading this draft', state: 'active' });
    open();
    assert.deepEqual(await pending, { answer: 'Done.' });
    const n = calls.length; await new Promise(r => setTimeout(r, 80)); assert.equal(calls.length, n, 'polling stops with the answer');
  } finally { globalThis.fetch = saved; }
});

test('a webview without a readable stream: the NDJSON body read in one piece gives the answer', async () => {
  const { fn } = fakeFetch({ steps: () => [], release: Promise.resolve(), chunked: false });
  const saved = globalThis.fetch; globalThis.fetch = fn;
  try { assert.deepEqual(await askStream({ question: 'q' }, new AbortController().signal, () => {}), { answer: 'Done.' }); }
  finally { globalThis.fetch = saved; }
});

test('steps merge by id; a done step never goes back to active', () => {
  const a = { id: 'a', text: 'Reading', state: 'active' }, aDone = { id: 'a', text: 'Read', state: 'done' };
  const s1 = mergeStep([], a); assert.deepEqual(s1, [a]);
  const s2 = mergeStep(s1, aDone); assert.deepEqual(s2, [aDone]);
  assert.equal(mergeStep(s2, a), s2); assert.equal(mergeStep(s2, aDone), s2);
  assert.deepEqual(mergeStep(s2, { id: 'b', text: 'x', state: 'active' }).map(s => s.id), ['a', 'b']);
});

test('the selection: a short snippet for the chip, Word\'s paragraphs matched in order, and the payload in the review\'s ids', async () => {
  const { selectionSnippet, selectionIndexes, selectionPayload } = await import('../src/review/ask-client.js');
  assert.equal(selectionSnippet('  The Receiving Party\nshall keep   all Confidential Information secret.  '), 'The Receiving Party shall keep all Confi…');
  assert.equal(selectionSnippet('Short.'), 'Short.');
  assert.deepEqual(selectionIndexes(['Title', 'A', 'B', 'A', 'C'], ['A', 'C']), [3, 4]);
  assert.deepEqual(selectionIndexes(['Title', 'A', 'B'], ['B']), [2]);
  assert.deepEqual(selectionIndexes(['Title'], ['missing']), []);
  const doc = { wordIndex: { p1: 0, p2: 1, p3: null, p4: 3 } };
  assert.deepEqual(selectionPayload({ text: '  keep it secret ', wordIndexes: [1, 3, 9] }, doc), { text: 'keep it secret', paragraphIds: ['p2', 'p4'] });
  assert.equal(selectionPayload({ text: '   ' }, doc), null); assert.equal(selectionPayload(null, doc), null);
  assert.equal(selectionPayload({ text: 'x'.repeat(5000) }, doc).text.length, 4000);
});
