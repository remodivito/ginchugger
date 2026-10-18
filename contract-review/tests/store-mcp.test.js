// SPDX-License-Identifier: GPL-3.0-or-later
// The review's MCP child over stdio (6.4.2; plan task 10), driven by the SDK client with no model:
// `store-mcp.js --stdio --review` for the Claude CLI, and nothing else (decision 188); and the tools listener (6.4.2
// step 4): loopback only, live review token only, scoped by the token (the document under review, its counterparty and
// the lawyer the store is read as), bounded call count. The record's GET /api/v2/tools/* routes are gone (decision 190).
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NOTICE, TOOL_NAMES } from '../server/store/tools.js';
import { startToolsListener, createTokenStore, toolsHandler } from '../server/tools-listener.js';
import { parseRendered, MCP_SCRIPT, serveStdio } from '../server/store-mcp.js';
import { seedFakeStore } from '../server/store/seed.js';
import { fileURLToPath } from 'node:url';

const SEED = fileURLToPath(new URL('../data/fixtures/tools-smoke/store-seed.json', import.meta.url));
const scope = { documentId: 8, counterparty: 'Quillon Instruments Ltd', actor: 'jane' };
async function mcpClient(args, env = {}) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env: { PATH: process.env.PATH || '', ...env }, stderr: 'pipe' }));
  return client;
}
const text = r => r.content[0].text;
function get(port, pathName, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathName, method, headers }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); req.end();
  });
}

test('decision 188: no external MCP surface: gcl has no mcp command, and the MCP script refuses to start without --review and a review token', async () => {
  const { main } = await import('../bin/gcl.js');
  const lines = []; const code = await main(['mcp'], { log: l => lines.push(l) });
  assert.equal(code, 2, 'an unknown command'); assert.doesNotMatch(lines.join('\n'), /\bmcp\b/i, 'the usage names no mcp command');
  const plain = spawnSync(process.execPath, [MCP_SCRIPT, '--stdio'], { env: { PATH: process.env.PATH }, input: '', encoding: 'utf8' });
  assert.equal(plain.status, 1); assert.match(plain.stderr, /Only the agentic review starts this server \(--review\)/);
  const data = spawnSync(process.execPath, [MCP_SCRIPT, '--stdio', '--data', '.'], { env: { PATH: process.env.PATH }, input: '', encoding: 'utf8' });
  assert.equal(data.status, 1); assert.match(data.stderr, /Unknown argument --data/);
  const noToken = spawnSync(process.execPath, [MCP_SCRIPT, '--stdio', '--review'], { env: { PATH: process.env.PATH, GCL_TOOLS_URL: 'http://127.0.0.1:9/api/v2/tools' }, input: '', encoding: 'utf8' });
  assert.equal(noToken.status, 1); assert.match(noToken.stderr, /GCL_TOOLS_URL and GCL_REVIEW_TOKEN/);
  await assert.rejects(serveStdio({ env: {} }), /Only the agentic review/);
});

test('review mode: the MCP child forwards to the tools listener with the review token, gets the review\'s scope and reads as its lawyer', async () => {
  const { store } = await seedFakeStore(SEED);
  const asked = [];
  const listener = await startToolsListener({ getStore: s => { asked.push(s.actor); return store; } });
  try {
    const token = listener.mint(scope);
    const client = await mcpClient([MCP_SCRIPT, '--stdio', '--review'], { GCL_TOOLS_URL: listener.url, GCL_REVIEW_TOKEN: token });
    try {
      assert.deepEqual((await client.listTools()).tools.map(t => t.name), TOOL_NAMES);
      const overview = parseRendered(text(await client.callTool({ name: 'get_counterparty_overview', arguments: {} })));
      assert.equal(overview.counterparty, 'Quillon Instruments Ltd', 'defaults to the token\'s counterparty');
      assert.ok(overview.types[0].documents.some(d => d.documentId === 8 && d.underReview), 'the document under review is marked');
      const read = parseRendered(text(await client.callTool({ name: 'read_document', arguments: { documentId: 5, fromParagraph: 3, toParagraph: 3 } })));
      assert.deepEqual(read.paragraphs.map(p => [p.n, p.text]), [[3, 'Term. The obligations in this Agreement continue for five years after termination.']], 'integers survive the query string');
      assert.ok(asked.every(a => a === 'jane'), 'the store is read as the token\'s lawyer');
      listener.revoke(token);
      const after = await client.callTool({ name: 'get_counterparty_overview', arguments: {} });
      assert.equal(after.isError, true); assert.equal(parseRendered(text(after)).error.code, 'unauthorized', 'a revoked token reads nothing');
    } finally { await client.close(); }
    const bad = await mcpClient([MCP_SCRIPT, '--stdio', '--review'], { GCL_TOOLS_URL: listener.url, GCL_REVIEW_TOKEN: 'x'.repeat(43) });
    try { assert.equal(parseRendered(text(await bad.callTool({ name: 'list_documents', arguments: {} }))).error.code, 'unauthorized'); } finally { await bad.close(); }
  } finally { await listener.close(); }
  const none = spawnSync(process.execPath, [MCP_SCRIPT, '--stdio', '--review'], { env: { PATH: process.env.PATH }, input: '', encoding: 'utf8' });
  assert.equal(none.status, 1); assert.match(none.stderr, /GCL_TOOLS_URL and GCL_REVIEW_TOKEN/);
  const remote = spawnSync(process.execPath, [MCP_SCRIPT, '--stdio', '--review'], { env: { PATH: process.env.PATH, GCL_TOOLS_URL: 'http://10.0.0.1:80/api/v2/tools', GCL_REVIEW_TOKEN: 't' }, input: '', encoding: 'utf8' });
  assert.equal(remote.status, 1); assert.match(remote.stderr, /127\.0\.0\.1/);
  assert.match(spawnSync(process.execPath, [MCP_SCRIPT], { encoding: 'utf8', input: '' }).stderr, /Only the stdio transport/);
});

test('tools listener: loopback only, a live token only, the right Host, GET only, the four routes only, a bounded call count; a store that cannot be reached is an error result', async () => {
  const { store } = await seedFakeStore(SEED);
  let clock = Date.parse('2026-10-15T10:00:00Z'); let down = false;
  const tokens = createTokenStore({ now: () => clock });
  const listener = await startToolsListener({ getStore: () => { if (down) throw Object.assign(new Error('The document store is unavailable.'), { status: 503 }); return store; }, tokens });
  try {
    const { port } = listener; const host = { Host: `127.0.0.1:${port}` };
    const token = listener.mint(scope, { maxCalls: 3 }); const auth = { ...host, Authorization: `Bearer ${token}` };
    assert.equal(new URL(listener.url).hostname, '127.0.0.1'); assert.equal(new URL(listener.url).protocol, 'http:');
    assert.equal((await get(port, '/api/v2/tools/list-documents', host)).status, 401, 'no token');
    assert.equal((await get(port, '/api/v2/tools/list-documents', { ...host, Authorization: 'Bearer not-a-real-token-at-all-0000' })).status, 401, 'unknown token');
    assert.equal((await get(port, '/api/v2/tools/list-documents', { ...host, Authorization: token })).status, 401, 'not a bearer');
    assert.equal((await get(port, '/api/v2/tools/list-documents', { ...auth, Host: `evil.example:${port}` })).status, 403, 'DNS-rebinding Host refused');
    assert.equal((await get(port, '/api/v2/store/documents', auth)).status, 404, 'only the tool routes');
    assert.equal((await get(port, '/api/v2/tools/previous-round', auth)).status, 404, 'the record tools are gone');
    assert.equal((await get(port, '/api/v2/tools/list-documents', auth, 'POST')).status, 405);
    const ok = await get(port, '/api/v2/tools/list-documents?counterparty=Merrow%20Bay%20Logistics%20Ltd', auth);
    assert.equal(ok.status, 200); assert.deepEqual(ok.body.documents.map(d => d.documentId), [7, 6], 'newest first');
    assert.equal(ok.body.notice, NOTICE);
    down = true;
    assert.equal((await get(port, '/api/v2/tools/search-documents?query=years', auth)).body.error.code, 'store_unavailable');
    down = false;
    assert.ok((await get(port, '/api/v2/tools/search-documents?query=years', auth)).body.hits.length > 0);
    const fourth = await get(port, '/api/v2/tools/search-documents?query=years', auth);
    assert.equal(fourth.body.error.code, 'tool_limit', 'the token bounds the number of lookups');
    const later = listener.mint(scope);
    clock += 30 * 60 * 1000 + 1;
    assert.equal((await get(port, '/api/v2/tools/list-documents', { ...host, Authorization: `Bearer ${later}` })).status, 401, 'expired after 30 minutes');
  } finally { await listener.close(); }
  // A request from any address but loopback is refused before anything else is looked at.
  const handler = toolsHandler({ getStore: () => store, tokens: createTokenStore() });
  for (const remoteAddress of ['10.0.0.5', '::ffff:192.168.1.2', '192.0.2.1']) {
    const res = { status: null, writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
    await handler({ socket: { remoteAddress }, headers: {}, url: '/api/v2/tools/list-documents', method: 'GET' }, res);
    assert.equal(res.status, 403, remoteAddress); assert.equal(res.body.error.code, 'forbidden');
  }
});
