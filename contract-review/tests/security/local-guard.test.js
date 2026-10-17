// SPDX-License-Identifier: GPL-3.0-or-later
// Security review, 17 Oct 2026 (docs/SECURITY-REVIEW.md, findings G1 and G2): the local API guard's path check sees a
// path the way Express routes it (without regard to case, so "/API/status" reaches the /api/status route and must get
// the Sec-Fetch-Site check too), and an IPv6 Origin ("http://[::1]:3443") is accepted for a Host of "[::1]:3443".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { checkLocalRequest, isApiPath, localGuard } from '../../server/local-guard.js';

test('isApiPath: any spelling Express would route to /api', () => {
  for (const p of ['/api', '/api/', '/api/status', '/API/status', '/Api/v2/store/documents', '//api/status', '///API']) assert.equal(isApiPath(p), true, p);
  for (const p of ['/', '/apis', '/apix/status', '/help.html', '/assets/api.js', '']) assert.equal(isApiPath(p), false, p);
});

test('checkLocalRequest: the Sec-Fetch-Site check applies to an upper-case or doubled-slash API path; an IPv6 Origin matches an IPv6 Host', () => {
  const refused = (headers, path) => checkLocalRequest({ headers, path })?.status === 403;
  assert.equal(refused({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }, '/API/status'), true);
  assert.equal(refused({ host: 'localhost:3000', 'sec-fetch-site': 'same-site' }, '//api/documents/import'), true);
  assert.equal(refused({ host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }, '/API/status'), false);
  assert.equal(checkLocalRequest({ headers: { host: '[::1]:3443', origin: 'http://[::1]:3443' }, path: '/api/status' }), null);
  assert.equal(checkLocalRequest({ headers: { host: '[::1]:3443', origin: 'https://[::1]:3443' }, path: '/api/status' }), null);
  assert.equal(refused({ host: '[::1]:3443', origin: 'http://[::1]:3444' }, '/api/status'), true);
  assert.equal(refused({ host: 'localhost:3443', origin: 'http://[::1]:3443' }, '/api/status'), true, 'a different loopback name is a different origin');
});

/** A raw request so the headers go exactly as written (fetch would not let a caller set Host or Sec-Fetch-Site). */
const raw = (port, method, path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, res => { let s = ''; res.on('data', d => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, body: s })); });
  req.on('error', reject); req.end();
});

test('through Express: a cross-site request to /API/status is refused before the route answers; the pane\'s own requests on [::1] pass', async () => {
  const app = express(); app.use(localGuard()); let hits = 0;
  app.get('/api/status', (req, res) => { hits++; res.json({ ok: true }); });
  app.post('/api/documents/import', (req, res) => { hits++; res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const upper = await raw(port, 'GET', '/API/status', { 'sec-fetch-site': 'cross-site' });
    assert.equal(upper.status, 403); assert.match(upper.body, /Cross-site requests are not allowed/);
    const post = await raw(port, 'POST', '/API/documents/import', { 'sec-fetch-site': 'same-site' });
    assert.equal(post.status, 403);
    assert.equal(hits, 0, 'no route ran');
    assert.equal((await raw(port, 'GET', '/API/status', { 'sec-fetch-site': 'same-origin' })).status, 200, 'the same origin may use any case');
    assert.equal((await raw(port, 'GET', '/api/status', { host: `[::1]:${port}`, origin: `http://[::1]:${port}`, 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal(hits, 2);
  } finally { server.close(); }
});
