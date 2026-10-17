// SPDX-License-Identifier: GPL-3.0-or-later
// Security review, 17 Oct 2026 (docs/SECURITY-REVIEW.md): the team proxy forwards store paths only (T1); the store's file
// routes keep a hostile filename out of the response headers and show inline only what a browser cannot run (R2, R3);
// and nothing a document, a title or a model answer carries reaches a page as markup (R1).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { openRemoteStore, storePath } from '../../server/store/remote.js';
import { storeConfig, createStoreService } from '../../server/store/service.js';
import { storeRoutes } from '../../server/store/http.js';
import { Markdown, docLabel, citeTargets } from '../../src/review/markdown.js';

const quiet = { log() {}, error() {} };

test('storePath: only paths that stay under /api/v2/store once normalised are forwarded, with their query', () => {
  assert.equal(storePath('/api/v2/store/documents/12/original'), '/api/v2/store/documents/12/original');
  assert.equal(storePath('/api/v2/store/documents?q=term&page=2'), '/api/v2/store/documents?q=term&page=2');
  for (const p of ['/api/v2/store/../admin/users', '/api/v2/store/documents/../../admin/users', '/api/v2/store/%2e%2e/admin/users', '/api/v2/store/./../me', '/api/v2/admin/users', '//evil.example/api/v2/store/x', 'http://evil.example/api/v2/store/x', '/api/v2/store', '']) assert.equal(storePath(p), null, p);
});

test('the team proxy refuses a path that would leave the store routes and never sends it with the member\'s key', async () => {
  const sent = [];
  const request = async (url, opts) => { sent.push({ url, auth: opts.headers.Authorization }); return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') }; };
  const remote = openRemoteStore({ url: 'https://team.example:8443', key: 'member-key', ca: undefined, request });
  const app = express(); app.use('/api/v2/store', (req, res) => remote.proxy(req, res));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const rawGet = p => new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p }, res => { let s = ''; res.on('data', d => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, body: s })); }); req.on('error', reject); req.end(); });
  try {
    const ok = await rawGet('/api/v2/store/documents/3');
    assert.equal(ok.status, 200); assert.deepEqual(sent.map(s => s.url), ['https://team.example:8443/api/v2/store/documents/3']);
    assert.equal(sent[0].auth, 'Bearer member-key');
    const escape = await rawGet('/api/v2/store/../admin/users');
    assert.equal(escape.status, 404, escape.body);
    const encoded = await rawGet('/api/v2/store/%2e%2e/admin/users');
    assert.equal(encoded.status, 404, encoded.body);
    assert.equal(sent.length, 1, 'nothing else was sent to the team server');
  } finally { server.close(); remote.close(); }
});

async function serveStore() {
  const svc = createStoreService({ config: storeConfig({ dataDir: mkdtempSync(path.join(tmpdir(), 'gcl-sec-store-')), env: { GCL_STORE: 'fake' } }), log: quiet });
  await svc.start();
  // The preview and thumbnail as a store might hand them back with a type a browser would run: served as a download.
  const hostile = { getPreviewPdf: async () => ({ body: Buffer.from('<script>alert(1)</script>'), mimeType: 'text/html; charset=utf-8' }), getThumbnail: async () => ({ body: Buffer.from('<svg onload="alert(1)"/>'), mimeType: 'image/svg+xml' }) };
  let shim = false;
  const service = Object.assign(Object.create(svc), { getClient: id => (shim ? Object.assign(Object.create(svc.getClient(id)), hostile) : svc.getClient(id)) });
  const app = express(); app.use(express.json()); app.use('/api/v2/store', storeRoutes(service, { actor: () => ({ id: 'ada', name: 'Ada', admin: true }), log: quiet }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v2/store`;
  const upload = async (name, content) => { const form = new FormData(); form.append('file', new Blob([content]), name); const r = await fetch(`${base}/documents`, { method: 'POST', body: form }); assert.equal(r.status, 202); await new Promise(x => setTimeout(x, 5)); const inbox = await (await fetch(`${base}/inbox`)).json(); return inbox.documents[0]; }; // newest first; one upload per store here
  return { base, upload, shim: on => { shim = on; }, close: () => server.close() };
}

test('a hostile filename is sanitised in Content-Disposition, and the original of an HTML file is a download, never a page', async () => {
  const s = await serveStore();
  try {
    // A multipart filename may carry quotes, backslashes and even a line break (the browser percent-encodes it and the
    // parser decodes it again); a NUL byte is refused by the parser itself.
    const name = 'evil"; filename=x.html\\\r\nX-Injected: 1 ünïcode.html';
    const doc = await s.upload(name, '<script>alert(1)</script>');
    assert.ok(doc, 'the upload landed');
    const r = await fetch(`${s.base}/documents/${doc.id}/original`);
    const cd = r.headers.get('content-disposition');
    assert.match(cd, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    assert.doesNotMatch(/filename="([^"]*)"/.exec(cd)[1], /\\/, 'no backslash inside the quoted name');
    assert.doesNotMatch(cd, /[\r\n]/); assert.equal(r.headers.get('x-injected'), null, 'no header was injected');
    assert.match(cd, /filename\*=UTF-8''[A-Za-z0-9%._-]*%0D%0AX-Injected/, 'the UTF-8 form is percent-encoded, the line break included');
    assert.match(cd, /^attachment/, 'whatever the type, the original is a download');
  } finally { s.close(); }
});

test('preview and thumbnail are shown inline only as PDF, image or plain text; HTML or SVG from the store becomes a download', async () => {
  const s = await serveStore();
  try {
    const doc = await s.upload('nda.txt', 'Term. Three years.');
    const pdf = await fetch(`${s.base}/documents/${doc.id}/preview`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(pdf.headers.get('content-disposition'), 'inline');
    s.shim(true);
    const html = await fetch(`${s.base}/documents/${doc.id}/preview`);
    assert.equal(html.headers.get('content-type'), 'application/octet-stream'); assert.equal(html.headers.get('content-disposition'), 'attachment');
    const svg = await fetch(`${s.base}/documents/${doc.id}/thumb`);
    assert.equal(svg.headers.get('content-type'), 'application/octet-stream'); assert.equal(svg.headers.get('content-disposition'), 'attachment');
  } finally { s.close(); }
});

test('a hostile document title or counterparty name reaches the Ask answer and its chips as text, never as markup or a link target', () => {
  const title = '<img src=x onerror=alert(1)>"onmouseover="alert(2)';
  const sources = [{ documentId: 12, title, quote: 'q', verified: true, counterparty: '<b>Evil</b> Ltd', otherCounterparty: true }, { documentId: 'javascript:alert(1)', title: 'x', quote: 'q' }, { documentId: '7; drop', quote: 'q' }];
  const out = renderToStaticMarkup(createElement(Markdown, { text: 'See [doc 12] and [doc 7] and <a href="javascript:alert(1)">x</a>', cites: { sources } }));
  assert.deepEqual([...new Set(out.match(/<\/?[a-z]+/g))].sort(), ['</a', '</div', '</p', '</span', '<a', '<div', '<p', '<span'], out);
  assert.deepEqual(out.match(/href="[^"]*"/g), ['href="#/documents/12"'], 'the only link is the chip to the store document page');
  assert.match(out, /<a class="cite" href="#\/documents\/12" aria-label="Open &lt;img src=x onerror=alert\(1\)&gt;&quot;onmouseover=&quot;alert\(2\)">/);
  assert.match(out, /\[doc 7\]/, 'a document id that is not a whole number is never a chip');
  assert.equal(docLabel({ documentId: 1, title }), '<img src=x…');
  const t = citeTargets({ sources });
  assert.equal(t.doc('javascript:alert(1)'), null); assert.equal(t.doc(7), null); assert.ok(t.doc(12));
});
