// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's answers as a small, safe Markdown subset (src/review/markdown.js): paragraphs, **bold**, lists and short
// headings; everything else, raw HTML and links above all, reaches the page as literal text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMarkdown, parseInline, Markdown } from '../src/review/markdown.js';

const html = text => renderToStaticMarkup(createElement(Markdown, { text }));

test('raw HTML, links and images from the model are escaped, never markup', () => {
  const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> [click](javascript:alert(1)) ![i](http://x/y.png) <a href="http://evil">x</a>');
  assert.ok(!/<script|<img|<a /.test(out), out);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /\[click\]\(javascript:alert\(1\)\)/);
  assert.equal(out.match(/<[a-z]+/g).filter(t => !['<div', '<p'].includes(t)).length, 0, 'only the wrapper and a paragraph');
});

test('bold is a closed pair only; a stray or empty marker is literal', () => {
  assert.deepEqual(parseInline('a **b** c'), [{ text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false }]);
  assert.deepEqual(parseInline('2 ** 3 and ****'), [{ text: '2 ** 3 and ****', bold: false }]);
  assert.equal(html('**<b>x</b>**'), '<div class="md"><p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p></div>');
  assert.equal(html('*one* and __two__'), '<div class="md"><p>*one* and __two__</p></div>', 'italics and underscores are not interpreted');
});

test('paragraphs, line breaks, bullet and numbered lists, headings', () => {
  assert.deepEqual(parseMarkdown('First\nstill first\n\nSecond').map(b => b.type), ['p', 'p']);
  assert.equal(html('One\ntwo'), '<div class="md"><p>One<br/>two</p></div>');
  assert.equal(html('Lead:\n- a **b**\n* c\n  continued\n\n1. x\n2. y'), '<div class="md"><p>Lead:</p><ul><li>a <strong>b</strong></li><li>c continued</li></ul><ol><li>x</li><li>y</li></ol></div>');
  assert.equal(html('3. third\n4. fourth'), '<div class="md"><ol start="3"><li>third</li><li>fourth</li></ol></div>');
  assert.equal(html('### What changed\nText'), '<div class="md"><p class="md__h">What changed</p><p>Text</p></div>');
  assert.equal(html(''), '<div class="md"></div>');
  assert.equal(html(null), '<div class="md"></div>');
});

test('a very long answer is cut, not rendered whole', () => {
  const blocks = parseMarkdown('x'.repeat(50_000));
  assert.equal(blocks[0].lines[0][0].text.length, 12_000);
});

// ---- Citation chips and tables (17 Oct 2026, from Claude for Word) ---------------------------------------------------
import { parseCites, parseTable, citeTargets, docLabel } from '../src/review/markdown.js';

const EVIDENCE = [{ paragraphId: 'p5', quote: 'three years', verified: true }];
const SOURCES = [{ documentId: 12, title: 'Pilot Agreement 2025 (signed)', quote: 'x', verified: true }, { documentId: 99, quote: 'y', verified: false, reason: 'No such document in the store.' }];
const withCites = (text, cites = { evidence: EVIDENCE, sources: SOURCES, onOpenEvidence: () => {} }) => renderToStaticMarkup(createElement(Markdown, { text, cites }));

test('markers: ¶ and doc markers are found, alone or several to a bracket; anything else is text', () => {
  assert.deepEqual(parseCites('Term [¶5] and [doc 12].').map(p => p.cite || p.text), ['Term ', { kind: 'para', id: 'p5', n: 5 }, ' and ', { kind: 'doc', id: 12 }, '.']);
  assert.deepEqual(parseCites('[¶ 5, ¶p7; Doc12]').map(p => p.cite?.id), ['p5', 'p7', 12]);
  assert.deepEqual(parseCites('[5] [¶] [doc x] [p5] ¶5 [¶5 ]').map(p => p.text), ['[5] [¶] [doc x] [p5] ¶5 [¶5 ]']);
});

test('a known ¶ marker is a button chip that opens its evidence; a known doc marker is a link to its document page', () => {
  const opened = [];
  const targets = citeTargets({ evidence: EVIDENCE, sources: SOURCES, onOpenEvidence: e => opened.push(e) });
  assert.equal(targets.para('p5'), EVIDENCE[0]);
  assert.equal(targets.doc(12), SOURCES[0]);
  const out = withCites('Liability is capped [¶5]; as in the pilot [doc 12].');
  assert.match(out, /<button type="button" class="cite" aria-label="Show paragraph 5 in the document">¶5<span class="cite__arrow" aria-hidden="true">↗<\/span><\/button>/);
  assert.match(out, /<a class="cite" href="#\/documents\/12" aria-label="Open Pilot Agreement 2025 \(signed\)">Pilot Agreement 2025…<span class="cite__arrow" aria-hidden="true">↗<\/span><\/a>/);
});

test('unknown markers stay plain text: no evidence, no source, a missing document, or no handler for passages', () => {
  const out = withCites('A [¶8] B [doc 7] C [doc 99]');
  assert.equal(out, '<div class="md"><p>A [¶8] B [doc 7] C [doc 99]</p></div>');
  assert.equal(withCites('A [¶5]', { evidence: EVIDENCE }), '<div class="md"><p>A [¶5]</p></div>', 'no onOpenEvidence: no chip');
  assert.equal(html('A [¶5] [doc 12]'), '<div class="md"><p>A [¶5] [doc 12]</p></div>', 'no cites at all: no chips');
  assert.equal(citeTargets({ evidence: [{ paragraphId: 'p5', quote: '' }], onOpenEvidence: () => {} }).para('p5'), null, 'evidence without a quote');
});

test('chips sit inside bold, and a verified quote is preferred for a paragraph cited twice', () => {
  const out = withCites('**Cap [¶5]** applies');
  assert.match(out, /<strong>Cap <button[^>]*>¶5/);
  const t = citeTargets({ evidence: [{ paragraphId: 'p5', quote: 'a', verified: false }, { paragraphId: 'p5', quote: 'b', verified: true }], onOpenEvidence: () => {} });
  assert.equal(t.para('p5').quote, 'b');
});

test('doc labels: short titles whole, long ones cut at a word, no title says the number', () => {
  assert.equal(docLabel({ documentId: 3, title: 'Pilot 2025' }), 'Pilot 2025');
  assert.equal(docLabel({ documentId: 3, title: 'Master Services Agreement with Helix Ltd' }), 'Master Services…');
  assert.equal(docLabel({ documentId: 3 }), 'Doc 3');
});

const TABLE = '| Term | This draft | Playbook |\n|---|:--|--:|\n| **Cap** | 12 months [¶5] | 12 months |\n| Term | 3 years | 2 years [doc 12] |';

test('a pipe table renders as a <table> and as one block per row, with bold and chips in cells', () => {
  const t = parseTable(TABLE.split('\n'));
  assert.equal(t.head.length, 3); assert.equal(t.rows.length, 2);
  const out = withCites(`Compared:\n${TABLE}\nEnd`);
  assert.match(out, /^<div class="md"><p>Compared:<\/p><div class="mdt"><table class="mdt__table">/);
  assert.match(out, /<thead><tr><th scope="col">Term<\/th><th scope="col">This draft<\/th><th scope="col">Playbook<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody><tr><th scope="row"><strong>Cap<\/strong><\/th><td>12 months <button[^>]*>¶5/);
  assert.match(out, /<div class="mdt__blocks"><div class="mdt__row" role="group" aria-label="Cap"><p class="mdt__label"><strong>Cap<\/strong><\/p><dl class="mdt__cells"><dt>This draft<\/dt><dd>12 months <button/);
  assert.match(out, /<dt>Playbook<\/dt><dd>2 years <a class="cite" href="#\/documents\/12"/);
  assert.match(out, /<\/div><\/div><p>End<\/p><\/div>$/);
});

test('table cells are escaped like everything else', () => {
  const out = html('| A | B |\n|---|---|\n| <script>x</script> | <img src=x onerror=1> |');
  assert.ok(!/<script|<img/.test(out), out);
  assert.match(out, /<td>&lt;img src=x onerror=1&gt;<\/td>/);
});

test('malformed tables fall back to plain text', () => {
  const plainP = s => html(s).startsWith('<div class="md"><p>') && !html(s).includes('<table');
  assert.ok(plainP('| A | B |\n| 1 | 2 |'), 'no separator row');
  assert.ok(plainP('| A | B |\n|---|---|\n| 1 | 2 | 3 |'), 'a row with too many cells');
  assert.ok(plainP('| A | B | C | D | E |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |'), 'more than four columns');
  assert.ok(plainP('| A |\n|---|\n| 1 |'), 'one column');
  assert.ok(plainP('| A | B |\n|---|---|'), 'no rows');
  assert.equal(html('| A | B |\n| 1 | 2 |'), '<div class="md"><p>| A | B |<br/>| 1 | 2 |</p></div>');
  assert.equal(html('a | b | c'), '<div class="md"><p>a | b | c</p></div>', 'pipes in prose are prose');
});

test('an empty cell is left out of its row block', () => {
  const out = html('| Term | A | B |\n|---|---|---|\n| Cap |  | x |');
  assert.match(out, /<dl class="mdt__cells"><dt>B<\/dt><dd>x<\/dd><\/dl>/);
});
