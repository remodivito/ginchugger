// SPDX-License-Identifier: GPL-3.0-or-later
// The agent's store tools (plan task 10) over the in-memory store, with no HTTP and no Docker: each tool, its arguments
// and caps, the citation resolver (a quote verifies only as an exact substring of the document's text as read_document
// returns it), and Ask with the tools (replayed) and without them (the counterparty's documents sent with the question).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeToolRouter, makeCitationResolver, prepareAgenticReview, checkArgs, argsFromQuery, plainSnippet, NOTICE, LIMITS, TOOL_NAMES, anthropicTools, openaiTools, mcpTools } from '../server/store/tools.js';
import { seedFakeStore } from '../server/store/seed.js';
import { readStoreText, citableText } from '../server/store/text.js';
import { counterpartyContext } from '../server/store/context.js';
import { askQuestion } from '../server/review.js';
import { docx } from './fixtures/record/helpers.js';

const SEED = new URL('../data/fixtures/tools-smoke/store-seed.json', import.meta.url).pathname;
const scope = { documentId: 8, counterparty: 'Quillon Instruments Ltd' };
const tmp = p => mkdtempSync(path.join(tmpdir(), p));

test('four read-only tools, one schema in each provider\'s shape; no write tool', () => {
  assert.deepEqual(TOOL_NAMES, ['search_documents', 'list_documents', 'read_document', 'get_counterparty_overview']);
  assert.deepEqual([anthropicTools().length, openaiTools().length, mcpTools().length], [4, 4, 4]);
  assert.ok(TOOL_NAMES.every(n => !/write|add|update|delete|trash|set/.test(n)));
  assert.deepEqual(checkArgs('read_document', { documentId: '5', fromParagraph: 2 }), { documentId: 5, fromParagraph: 2 }, 'a number written as text is read as a number');
  assert.deepEqual(checkArgs('list_documents', { counterparty: '' }), {}, 'an empty filter is no filter');
  assert.throws(() => checkArgs('read_document', {}), /needs "documentId"/);
  assert.throws(() => checkArgs('list_documents', { from: '1 May' }), /YYYY-MM-DD/);
  assert.throws(() => checkArgs('list_documents', { limit: 51 }), /from 1 to 50/);
  assert.throws(() => checkArgs('search_documents', { query: 'x', matterId: 'm' }), /takes no argument "matterId"/);
  assert.deepEqual(argsFromQuery('read_document', { documentId: '7', toParagraph: ['2', '3'] }), { documentId: 7, toParagraph: 3 });
  assert.equal(plainSnippet('the <span class="match">five</span> years &amp; more'), 'the five years & more');
});

test('get_counterparty_overview: the counterparty\'s documents by type, newest first, signed marked, the one under review marked; another counterparty by name', async () => {
  const { store } = await seedFakeStore(SEED);
  const tools = makeToolRouter(store, scope);
  const o = await tools.call('get_counterparty_overview', {});
  assert.equal(o.notice, NOTICE);
  assert.deepEqual([o.counterparty, o.documentCount, o.signedCount], ['Quillon Instruments Ltd', 5, 1]);
  assert.deepEqual(o.types.map(t => [t.type, t.count, t.signed]), [['NDA', 4, 1], ['Email', 1, 0]]);
  assert.deepEqual(o.types[0].documents.map(d => [d.documentId, d.date, d.signed, !!d.underReview]), [[8, '2026-09-01', false, true], [5, '2025-02-20', true, false], [3, '2025-02-17', false, false], [2, '2025-02-03', false, false]]);
  const other = await tools.call('get_counterparty_overview', { counterparty: 'Merrow Bay Logistics Ltd' });
  assert.deepEqual(other.types[0].documents.map(d => d.documentId), [7, 6]);
  assert.equal((await makeToolRouter(store, {}).call('get_counterparty_overview', {})).error.code, 'bad_request', 'no counterparty in scope: name one');
});

test('list_documents: newest first, filtered by counterparty, type, tag and dates, paged, capped at 50', async () => {
  const { store } = await seedFakeStore(SEED);
  const tools = makeToolRouter(store, scope);
  const all = await tools.call('list_documents', {});
  assert.equal(all.count, 8); assert.deepEqual(all.documents.map(d => d.documentId), [8, 7, 6, 5, 4, 3, 2, 1], 'newest first');
  assert.deepEqual((await tools.call('list_documents', { tag: 'signed' })).documents.map(d => d.documentId), [7, 5]);
  assert.deepEqual((await tools.call('list_documents', { type: 'Email' })).documents.map(d => d.title), ['Quillon comments on the NDA']);
  const ranged = await tools.call('list_documents', { counterparty: 'Quillon Instruments Ltd', from: '2025-02-10', to: '2025-12-31' });
  assert.deepEqual(ranged.documents.map(d => [d.documentId, d.date]), [[5, '2025-02-20'], [4, '2025-02-17'], [3, '2025-02-17']]);
  const page = await tools.call('list_documents', { limit: 3 });
  assert.deepEqual([page.documents.length, page.nextPage], [3, 2]);
  assert.equal((await tools.call('list_documents', { limit: 3, page: 3 })).nextPage, undefined);
  // The cap: a store of 60 documents lists 50 at most per call.
  const big = (await seedFakeStore({ documents: Array.from({ length: 60 }, (_, i) => ({ title: `Doc ${i}`, counterparty: 'Big Ltd', created: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, text: `Text ${i}` })) })).store;
  const capped = await makeToolRouter(big, {}).call('list_documents', { limit: 50 });
  assert.deepEqual([capped.count, capped.documents.length, capped.nextPage], [60, 50, 2]);
  assert.equal((await makeToolRouter(big, {}).call('get_counterparty_overview', { counterparty: 'Big Ltd' })).types[0].count, 60);
});

test('search_documents: full text, best first, with labels, signed marked and a plain snippet; filters; at most 20 hits', async () => {
  const { store } = await seedFakeStore(SEED);
  const tools = makeToolRouter(store, scope);
  const r = await tools.call('search_documents', { query: 'five years' });
  assert.ok(r.hits.length >= 3);
  const signed = r.hits.find(h => h.documentId === 5);
  assert.deepEqual([signed.title, signed.counterparty, signed.type, signed.signed, signed.tags], ['Quillon NDA 2025 - our draft 3', 'Quillon Instruments Ltd', 'NDA', true, ['signed']]);
  assert.match(signed.snippet, /five years/); assert.doesNotMatch(signed.snippet, /</);
  assert.deepEqual((await tools.call('search_documents', { query: 'seven years', counterparty: 'Merrow Bay Logistics Ltd' })).hits.map(h => h.documentId), [7]);
  assert.deepEqual((await tools.call('search_documents', { query: 'years', tag: 'signed' })).hits.map(h => h.documentId).sort(), [5, 7]);
  assert.equal((await tools.call('search_documents', { query: 'nothing-like-this' })).hits.length, 0);
  const big = (await seedFakeStore({ documents: Array.from({ length: 30 }, (_, i) => ({ title: `Doc ${i}`, created: '2026-01-01', text: `Indemnity clause ${i}` })) })).store;
  const many = await makeToolRouter(big, {}).call('search_documents', { query: 'indemnity' });
  assert.deepEqual([many.count, many.hits.length, many.more], [30, LIMITS.hits, 10]);
});

test('read_document: our text (tracked changes as text and originalText), labels, notes, an email\'s headers; a paragraph range; long documents cut with `next`', async () => {
  const { store } = await seedFakeStore(SEED);
  const tools = makeToolRouter(store, scope);
  const d = await tools.call('read_document', { documentId: 5 });
  assert.deepEqual([d.document.title, d.document.signed, d.totalParagraphs, d.range, d.next], ['Quillon NDA 2025 - our draft 3', true, 5, [1, 5], undefined]);
  assert.equal(d.paragraphs[2].text, 'Term. The obligations in this Agreement continue for five years after termination.');
  const form = await tools.call('read_document', { documentId: 1 });
  assert.deepEqual(form.notes.map(n => n.text), ['Our standard form for NDAs.']);
  const mail = await tools.call('read_document', { documentId: 4 });
  assert.equal(mail.email.subject, 'Quillon comments on the NDA'); assert.match(mail.paragraphs.map(p => p.text).join(' '), /calibration data stays sensitive/);
  const part = await tools.call('read_document', { documentId: 5, fromParagraph: 2, toParagraph: 3 });
  assert.deepEqual(part.paragraphs.map(p => p.n), [2, 3]); assert.deepEqual(part.range, [2, 3]);
  assert.equal((await tools.call('read_document', { documentId: 99 })).error.code, 'not_found');
  // A tracked change: the wording with it, and the wording before it.
  const tracked = await store.add(await docx(['Term', { was: 'Three years.', text: 'Seven years.' }]), { filename: 'markup.docx', title: 'markup', counterparty: 'Quillon Instruments Ltd' });
  const t = await tools.call('read_document', { documentId: tracked.id });
  assert.deepEqual(t.paragraphs[1], { n: 2, id: t.paragraphs[1].id, text: 'Seven years.', originalText: 'Three years.' });
  // A long document: 24,000 characters a call, and where to go on.
  const long = await store.add(await docx(Array.from({ length: 60 }, (_, i) => `Clause ${i + 1}. ${'x'.repeat(990)}`)), { filename: 'long.docx', title: 'long' });
  const first = await tools.call('read_document', { documentId: long.id });
  assert.ok(first.paragraphs.reduce((n, p) => n + p.text.length, 0) <= LIMITS.readChars);
  assert.deepEqual([first.totalParagraphs, first.range[0], first.next], [60, 1, first.range[1] + 1]);
  const second = await tools.call('read_document', { documentId: long.id, fromParagraph: first.next });
  assert.equal(second.paragraphs[0].text.startsWith(`Clause ${first.next}.`), true);
  // A file with no text we read (a PDF) says so.
  const pdf = await store.add(Buffer.from('%PDF-1.4'), { filename: 'scan.pdf', title: 'scan' });
  assert.equal((await tools.call('read_document', { documentId: pdf.id })).error.code, 'not_readable');
});

test('citations: the resolver gives the text read_document returns; an invented quote is not in it; unknown documents resolve to nothing', async () => {
  const { store } = await seedFakeStore(SEED);
  const resolve = makeCitationResolver(store);
  const five = await resolve(5);
  assert.equal(five.counterparty, 'Quillon Instruments Ltd');
  assert.ok(five.text.includes('continue for five years after termination'));
  assert.ok(!five.text.includes('continue for four years after termination'), 'an invented quote is not in the text');
  assert.equal(five.text, citableText(await readStoreText(store, 5)));
  const read = await makeToolRouter(store, {}).call('read_document', { documentId: 5 });
  for (const p of read.paragraphs) assert.ok(five.text.includes(p.text), 'every paragraph the tool returns can be quoted');
  const tracked = await store.add(await docx([{ was: 'Three years.', text: 'Seven years.' }]), { filename: 'm.docx', title: 'm' });
  const t = await resolve(tracked.id);
  assert.ok(t.text.includes('Seven years.') && t.text.includes('Three years.'), 'the wording before a tracked change can be quoted too');
  assert.equal(await resolve(999), null); assert.equal(await resolve('abc'), null);
});

test('prepareAgenticReview: the document under review scopes the tools; its byte-identical copies are not counted as other documents', async () => {
  const { store } = await seedFakeStore(SEED);
  const a = await prepareAgenticReview(store, { documentId: 8, actor: 'jane' });
  assert.deepEqual(a.tools.scope, { documentId: 8, counterparty: 'Quillon Instruments Ltd', actor: 'jane' });
  assert.deepEqual(a.brief, { document: { documentId: 8, title: 'Quillon NDA 2026 (service pilot) - our draft 1', type: 'NDA', date: '2026-09-01', signed: false }, counterparty: 'Quillon Instruments Ltd', documentsInStore: 8, otherDocumentsWithThisCounterparty: 4, signedDocumentsWithThisCounterparty: 1 });
  assert.equal(a.citations.counterparty, 'Quillon Instruments Ltd');
  const none = await prepareAgenticReview(store, { documentId: 999, counterparty: null });
  assert.deepEqual([none.brief.document, none.brief.counterparty, none.tools.scope.documentId], [null, null, null]);
});

// ---- Ask with the tools, and without them -----------------------------------------------------------------------
const document = { id: 'd', revision: 1, title: 'NDA', paragraphs: [{ id: 'p3', text: 'Term. The obligations in this Agreement continue for seven years after termination.' }] };
const playbook = { version: 1, rules: [{ id: 'DUR-01', title: 'Duration', guidance: 'Five years at most.', enabled: true }] };
const replay = dir => ({ executor: 'replay', model: 'replay', effort: 'medium', replayDir: dir, traceDir: null, toolsSupported: true });

test('Ask with the tools: the model reads the store, cites documents, and each quote is checked against that document\'s text', async () => {
  const { store } = await seedFakeStore(SEED);
  const agentic = await prepareAgenticReview(store, { documentId: 8 });
  const dir = tmp('ask-tools-'); const traceDir = tmp('ask-trace-');
  const live = makeToolRouter(store, agentic.tools.scope);
  const lines = [];
  for (const [name, args] of [['get_counterparty_overview', {}], ['read_document', { documentId: 5 }]]) { const result = await live.call(name, args); lines.push(JSON.stringify({ name, args, result })); }
  writeFileSync(path.join(dir, 'ask.tools.jsonl'), lines.join('\n') + '\n');
  writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify({ answer: 'Last time (Quillon NDA 2025, signed 20 Feb 2025) we accepted five years.', evidence: [{ paragraphId: 'p3', quote: 'seven years' }], sources: [{ documentId: 5, quote: 'continue for five years after termination', note: 'signed' }, { documentId: 5, quote: 'continue for four years' }, { documentId: 42, quote: 'anything' }], ruleIds: ['DUR-01'], limits: [] }));
  const r = await askQuestion({ document, playbook, question: 'What did we accept from Quillon before?', agentic, config: { ...replay(dir), traceDir } });
  assert.equal(r.model.agentic, true);
  assert.deepEqual(r.toolCalls.map(t => t.name), ['get_counterparty_overview', 'read_document']);
  assert.deepEqual(r.sources.map(c => [c.documentId, c.verified, c.reason || null]), [[5, true, null], [5, false, 'The quote is not in that document\'s text.'], [42, false, 'No such document in the store.']]);
  assert.match(r.limits.join(' '), /2 quote\(s\) from other documents could not be verified/);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(path.join(traceDir, 'ask.system.txt'), 'utf8'), /\*\*The document store\.\*\*[\s\S]*at most 8 calls/);
  assert.equal(JSON.parse(readFileSync(path.join(traceDir, 'ask.user.json'), 'utf8')).store.counterparty, 'Quillon Instruments Ltd');
});

test('Ask without tool calling: the counterparty\'s other documents go with the question, and its citations are checked against them', async () => {
  const { store } = await seedFakeStore(SEED);
  const items = await counterpartyContext(store, { counterparty: 'Quillon Instruments Ltd', exclude: [8] });
  assert.deepEqual(items.map(d => [d.documentId, d.signed]), [[5, true], [4, false], [3, false], [2, false]], 'newest first, the open document left out');
  assert.ok(items.every(d => Array.isArray(d.paragraphs) && typeof d.text === 'string'));
  const dir = tmp('ask-context-'); const traceDir = tmp('ask-context-trace-');
  writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify({ answer: 'Five years, in the signed 2025 NDA.', evidence: [], sources: [{ documentId: 5, quote: 'continue for five years after termination' }, { documentId: 6, quote: 'continue for three years after termination' }], ruleIds: [], limits: [] }));
  const r = await askQuestion({ document, playbook, question: 'What did we accept before?', context: { counterparty: 'Quillon Instruments Ltd', documents: items }, config: { ...replay(dir), traceDir, toolsSupported: false } });
  assert.equal(r.model.agentic, false); assert.equal(r.model.storeDocuments, items.length);
  assert.deepEqual(r.sources.map(c => [c.documentId, c.verified]), [[5, true], [6, false]], 'a document not sent cannot be cited');
  const { readFileSync } = await import('node:fs');
  const sent = JSON.parse(readFileSync(path.join(traceDir, 'ask.user.json'), 'utf8')).counterpartyDocuments;
  assert.equal(sent.counterparty, 'Quillon Instruments Ltd'); assert.ok(sent.documents.every(d => !('paragraphs' in d)), 'the text goes once, as text');
  // Neither tools nor documents: the draft alone, and no sources.
  writeFileSync(path.join(dir, 'ask.raw.txt'), JSON.stringify({ answer: 'Seven years.', evidence: [{ paragraphId: 'p3', quote: 'seven years' }], ruleIds: [], limits: [] }));
  const alone = await askQuestion({ document, playbook, question: 'How long?', config: replay(dir) });
  assert.equal(alone.sources, undefined); assert.equal(alone.evidence[0].verified, true);
});
