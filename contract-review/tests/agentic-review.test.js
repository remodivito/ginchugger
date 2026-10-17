// SPDX-License-Identifier: GPL-3.0-or-later
// The agentic review end to end (product v2 spec 4.3, 6.4, 7.4; plan task 10) with no model: the executor matrix with
// the store tool router over a seeded in-memory store (claude through a stub CLI that really starts the MCP child and
// calls the tools listener; anthropic and openai through fetch stubs; replay from a recorded tools file), the
// single-call fallback, and traces. Store citations name a document and quote its text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewDocument } from '../server/review.js';
import { toolsSupported, recordedToolRouter, parseClaudeStream, MCP_TOOL_NAMES, getExecutorConfig } from '../server/executors.js';
import { makeToolRouter, NOTICE, TOOL_NAMES } from '../server/store/tools.js';
import { openToolsSmoke } from '../server/tool-smoke.js';

const STUB = fileURLToPath(new URL('./fixtures/agentic/claude-stub.mjs', import.meta.url));
const tmp = p => mkdtempSync(path.join(tmpdir(), p));
const answer = record => JSON.stringify({ findings: [{ paragraphId: 'p3', title: 'Term extended to seven years', status: 'attention', decision: 'reject', explanation: 'DUR-01: five years at most.', evidence: [{ paragraphId: 'p3', quote: 'continue for seven years after termination' }], ruleIds: ['DUR-01'], proposedText: 'Term. The obligations in this Agreement continue for three years after termination.', record }], limits: [] });
// The seed's documents in order: 1 our standard NDA, 2–5 Quillon 2025 (5 signed: five years), 6–7 Merrow Bay (7 signed: seven years), 8 Quillon 2026 draft.
const goodCite = { documentId: 5, quote: 'continue for five years after termination', counterparty: 'same', note: 'five years accepted' };
const badCite = { documentId: 7, quote: 'continue for seven years after termination', counterparty: 'same' };

async function seeded(fn, { listener = false, maxToolCalls = 8 } = {}) {
  const s = await openToolsSmoke({ listen: listener, maxToolCalls });
  try { return await fn(s); } finally { await s.close(); }
}
const run = (s, config) => reviewDocument({ document: s.review.document, playbook: s.playbook, reviewMode: s.review.reviewMode, agentic: s.agentic, config });
async function withFetch(handler, fn) {
  const saved = globalThis.fetch; const requests = [];
  globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); requests.push({ url, body }); return handler(body, requests.length); };
  try { return await fn(requests); } finally { globalThis.fetch = saved; }
}
const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: k => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body });
function withEnv(vars, fn) { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } const restore = () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }; return Promise.resolve().then(fn).finally(restore); }

test('which executors may use tools: codex and muse, and a setup whose smoke test failed, run single call', () => {
  for (const e of ['anthropic', 'claude', 'openai', 'replay']) assert.equal(toolsSupported({ executor: e }), true, e);
  for (const e of ['codex', 'muse']) assert.equal(toolsSupported({ executor: e }), false, e);
  assert.equal(toolsSupported({ executor: 'claude', toolsSupported: false }), false);
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'claude', REVIEW_TOOLS_SUPPORTED: 'false' }).toolsSupported, false);
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'claude' }).toolsSupported, true);
});

test('the brief says what the store holds for the counterparty, with none of its content', () => seeded(async s => {
  assert.deepEqual(s.agentic.brief, { document: null, counterparty: 'Quillon Instruments Ltd', documentsInStore: 8, otherDocumentsWithThisCounterparty: 5, signedDocumentsWithThisCounterparty: 1 });
  assert.deepEqual(s.agentic.tools.scope, { documentId: null, counterparty: 'Quillon Instruments Ltd', actor: null });
}));

test('replay: recorded tool calls are played back, the recorded answer validated, citations verified, the trace complete', () => seeded(async s => {
  const rec = tmp('agentic-replay-'); const traceDir = tmp('agentic-trace-');
  const live = makeToolRouter(s.store, s.agentic.tools.scope);
  const calls = [['get_counterparty_overview', {}], ['read_document', { documentId: 5 }]];
  const lines = []; for (const [name, args] of calls) { const result = await live.call(name, args); lines.push(JSON.stringify({ n: lines.length + 1, name, args, bytes: JSON.stringify(result).length, result })); }
  writeFileSync(path.join(rec, 'review.tools.jsonl'), lines.join('\n') + '\n');
  writeFileSync(path.join(rec, 'review.raw.txt'), answer([goodCite, badCite]));
  const r = await run(s, { executor: 'replay', model: 'replay', effort: 'medium', replayDir: rec, traceDir, toolsSupported: true });
  assert.equal(r.model.agentic, true); assert.equal(r.model.promptFile, 'prompts/review-record.md'); assert.equal(r.model.toolCalls, 2);
  assert.deepEqual(r.toolCalls.map(t => t.name), ['get_counterparty_overview', 'read_document']);
  const f = r.findings.find(x => x.paragraphId === 'p3');
  assert.deepEqual(f.record.map(c => c.verified), [true, false]); assert.equal(r.unverifiedRecordCitations, 1);
  assert.deepEqual([f.record[0].documentId, f.record[1].documentId], [5, 7]);
  assert.match(f.record[1].reason, /another counterparty/);
  // Trace (6.4.4): the four files plus review.tools.jsonl; the user message carries the store brief, no history.
  for (const x of ['meta.json', 'system.txt', 'user.json', 'raw.txt', 'tools.jsonl']) assert.ok(existsSync(path.join(traceDir, `review.${x}`)), x);
  const meta = JSON.parse(readFileSync(path.join(traceDir, 'review.meta.json'), 'utf8'));
  assert.equal(meta.agentic, true); assert.equal(meta.toolCalls, 2);
  assert.match(readFileSync(path.join(traceDir, 'review.system.txt'), 'utf8'), /at most 8 calls/);
  const user = JSON.parse(readFileSync(path.join(traceDir, 'review.user.json'), 'utf8'));
  assert.ok(!('history' in user)); assert.equal(user.store.counterparty, 'Quillon Instruments Ltd'); assert.ok(!('matter' in user));
  const traced = readFileSync(path.join(traceDir, 'review.tools.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(traced.map(t => [t.n, t.name, t.result.notice]), [[1, 'get_counterparty_overview', NOTICE], [2, 'read_document', NOTICE]]);
  // A trace is a recording: replaying it gives the same review.
  const again = await run(s, { executor: 'replay', model: 'replay', effort: 'medium', replayDir: traceDir, traceDir: null, toolsSupported: true });
  assert.deepEqual(again.findings.map(x => x.record?.map(c => c.verified)), r.findings.map(x => x.record?.map(c => c.verified)));
  assert.deepEqual(again.toolCalls, r.toolCalls);
}));

test('citations: an invented quote, an unknown document, a missing label and a document number written as text', () => seeded(async s => {
  const rec = tmp('agentic-cites-');
  writeFileSync(path.join(rec, 'review.raw.txt'), answer([
    { documentId: 5, quote: 'continue for four years after termination', counterparty: 'same' },
    { documentId: 99, quote: 'continue for five years after termination', counterparty: 'same' },
    { documentId: 5, quote: 'continue for five years after termination' },
    { documentId: '3', quote: 'continue for five years after termination', counterparty: 'same' },
    { documentId: 4, quote: 'We need five years because our calibration data stays sensitive', counterparty: 'same' },
  ]));
  writeFileSync(path.join(rec, 'review.tools.jsonl'), '');
  const r = await run(s, { executor: 'replay', model: 'replay', effort: 'medium', replayDir: rec, traceDir: null, toolsSupported: true });
  const c = r.findings.find(x => x.paragraphId === 'p3').record;
  assert.deepEqual(c.map(x => [x.documentId, x.verified, x.reason || null]), [
    [5, false, 'The quote is not in that document\'s text.'], [99, false, 'No such document in the store.'], [5, false, 'The document belongs to this counterparty, not another.'], [3, true, null], [4, true, null]]);
  assert.ok(r.findings.find(x => x.paragraphId === 'p3').notes.some(n => /3 store citation\(s\) could not be verified/.test(n)));
}));

test('replay router: calls answered in order from the recording; a call not in it is "not recorded"', async () => {
  const router = recordedToolRouter([{ name: 'search_documents', args: { query: 'a' }, result: { n: 1 } }, { name: 'search_documents', args: { query: 'a' }, result: { n: 2 } }, { name: 'list_documents', args: {}, result: { n: 3 } }]);
  assert.deepEqual(await router.call('search_documents', { query: 'a' }), { n: 1 });
  assert.deepEqual(await router.call('list_documents', {}), { n: 3 });
  assert.deepEqual(await router.call('search_documents', { query: 'a' }), { n: 2 });
  assert.deepEqual((await router.call('search_documents', { query: 'a' })).error, { code: 'not_recorded', message: 'not recorded' });
  assert.deepEqual((await router.call('read_document', { documentId: 1 })).error.code, 'not_recorded');
});

test('fallback: a setup without tools runs the single call with review.md and says the store was not consulted', () => seeded(async s => {
  const rec = tmp('agentic-fallback-'); const traceDir = tmp('agentic-fallback-trace-');
  writeFileSync(path.join(rec, 'review.raw.txt'), answer([goodCite]));
  const r = await run(s, { executor: 'replay', model: 'replay', effort: 'medium', replayDir: rec, traceDir, toolsSupported: false });
  assert.equal(r.model.agentic, false); assert.equal(r.model.promptFile, 'prompts/review.md');
  assert.ok(r.limits.includes('Document store not consulted by the model: this setup runs the single-call review.'));
  assert.deepEqual(r.toolCalls, []); assert.ok(!existsSync(path.join(traceDir, 'review.tools.jsonl')));
  assert.equal(readFileSync(path.join(traceDir, 'review.system.txt'), 'utf8'), readFileSync(new URL('../prompts/review.md', import.meta.url), 'utf8'));
  assert.equal(r.findings.find(f => f.paragraphId === 'p3').record[0].verified, true, 'a citation is still checked against the store');
  // Without `agentic` the review is exactly the single call it was: no tool fields.
  const plain = await reviewDocument({ document: s.review.document, playbook: s.playbook, reviewMode: 'own-paper', config: { executor: 'replay', model: 'replay', effort: 'medium', replayDir: rec, traceDir: null } });
  assert.ok(!('toolCalls' in plain)); assert.equal(plain.model.agentic, false); assert.ok(!plain.limits.some(l => /not consulted/.test(l)));
  assert.equal(plain.findings.find(f => f.paragraphId === 'p3').record[0].reason, 'The document store was not read in this review.');
}));

test('anthropic: tool_use blocks are answered in-process up to the limit, then tools are switched off', () => seeded(async s => withEnv({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: undefined }, () => withFetch((body, n) => {
  if (n === 1) return json({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu1', name: 'get_counterparty_overview', input: {} }, { type: 'tool_use', id: 'tu2', name: 'read_document', input: { documentId: 8 } }], usage: { input_tokens: 5 } });
  if (n === 2) return json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu3', name: 'search_documents', input: { query: 'years' } }] });
  return json({ stop_reason: 'end_turn', content: [{ type: 'text', text: answer([{ documentId: 8, quote: 'continue for three years after termination', counterparty: 'same' }]) }] });
}, async requests => {
  s.agentic.tools.maxToolCalls = 2;
  const r = await run(s, { executor: 'anthropic', model: 'claude-test', effort: 'medium', traceDir: null, toolsSupported: true });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].body.tools.map(t => t.name), TOOL_NAMES);
  assert.deepEqual(TOOL_NAMES, ['search_documents', 'list_documents', 'read_document', 'get_counterparty_overview']);
  assert.equal(requests[0].body.max_tokens, 16000); assert.ok(!requests[0].body.tool_choice);
  const results = requests[1].body.messages.at(-1).content;
  assert.deepEqual(results.map(c => [c.type, c.tool_use_id]), [['tool_result', 'tu1'], ['tool_result', 'tu2']]);
  assert.equal(JSON.parse(results[0].content).counterparty, 'Quillon Instruments Ltd');
  assert.equal(JSON.parse(results[1].content).document.title, 'Quillon NDA 2026 (service pilot) - our draft 1');
  assert.deepEqual(requests[2].body.tool_choice, { type: 'none' }, 'the limit reached, tools are off for the next turn');
  assert.equal(JSON.parse(requests[2].body.messages.at(-1).content[0].content).error.code, 'tool_limit');
  assert.deepEqual(r.toolCalls.map(t => [t.name, t.error || null]), [['get_counterparty_overview', null], ['read_document', null], ['search_documents', 'tool_limit']]);
  assert.equal(r.model.agentic, true); assert.equal(r.findings.find(f => f.paragraphId === 'p3').record[0].verified, true);
}))));

const sse = events => ({ ok: true, status: 200, headers: { get: k => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) }, body: (async function* () { for (const e of events) yield new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`); yield new TextEncoder().encode('data: [DONE]\n\n'); })() });
test('openai-compatible: tool_calls (streamed in fragments) are answered and the final answer parsed', () => seeded(async s => withEnv({ OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://llm.example/v1' }, () => withFetch((body, n) => {
  if (n === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_', arguments: '{"que' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'documents', arguments: 'ry":"five years"}' } }] }, finish_reason: 'tool_calls' }] }]);
  if (n === 2) return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_document', arguments: '{"documentId":5}' } }] }, finish_reason: 'tool_calls' }] });
  return json({ choices: [{ message: { content: answer([goodCite]) }, finish_reason: 'stop' }], usage: { total_tokens: 9 } });
}, async requests => {
  const r = await run(s, { executor: 'openai', model: 'glm-test', effort: 'medium', traceDir: null, toolsSupported: true });
  assert.equal(requests[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(requests[0].body.tools[0].type, 'function'); assert.equal(requests[0].body.tool_choice, 'auto'); assert.ok(!requests[0].body.response_format);
  assert.deepEqual(requests[1].body.messages.at(-2).tool_calls, [{ id: 'c1', type: 'function', function: { name: 'search_documents', arguments: '{"query":"five years"}' } }]);
  assert.equal(requests[1].body.messages.at(-1).role, 'tool'); assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'c1');
  assert.ok(JSON.parse(requests[1].body.messages.at(-1).content).hits.some(h => h.documentId === 5 && h.signed));
  assert.deepEqual(r.toolCalls.map(t => t.name), ['search_documents', 'read_document']);
  assert.equal(r.findings.find(f => f.paragraphId === 'p3').record[0].verified, true);
}))));

test('openai-compatible: a provider that refuses `tools` with HTTP 400 is reviewed single call instead', () => seeded(async s => withEnv({ OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://llm.example/v1' }, () => withFetch((body, n) => (n === 1 ? json({ error: 'tools not supported' }, 400) : json({ choices: [{ message: { content: answer([]) }, finish_reason: 'stop' }] })), async requests => {
  const r = await run(s, { executor: 'openai', model: 'small-test', effort: 'medium', traceDir: null, toolsSupported: true });
  assert.equal(requests.length, 2); assert.ok(requests[0].body.tools); assert.ok(!requests[1].body.tools, 'the retry is the plain single call');
  assert.equal(requests[1].body.response_format.type, 'json_object');
  assert.equal(r.model.agentic, false); assert.equal(r.model.promptFile, 'prompts/review.md');
  assert.ok(r.limits.includes('Document store not consulted by the model: the provider refused tool calling.'));
}))));

test('claude: the CLI gets the MCP config and flags; its MCP child reads the store through the tools listener with a review token', () => seeded(async s => {
  const { listener } = s;
  const argsFile = path.join(tmp('claude-stub-'), 'args.json'); const traceDir = tmp('claude-trace-');
  await withEnv({ CLAUDE_BIN: STUB, STUB_ARGS_FILE: argsFile, STUB_MODE: '', ANTHROPIC_API_KEY: 'must-not-reach-the-cli' }, async () => {
    const r = await run(s, { executor: 'claude', model: 'claude-opus-5-5', effort: 'low', traceDir, toolsSupported: true });
    const seen = JSON.parse(readFileSync(argsFile, 'utf8')); const a = seen.args; const after = f => a[a.indexOf(f) + 1];
    assert.equal(a[0], '-p'); assert.equal(after('--model'), 'claude-opus-5-5'); assert.equal(after('--effort'), 'low');
    assert.equal(after('--tools'), '', 'no built-in tool'); assert.ok(a.includes('--strict-mcp-config')); assert.ok(a.includes('--no-session-persistence'));
    assert.equal(after('--allowedTools'), MCP_TOOL_NAMES.join(',')); assert.equal(after('--max-turns'), '9');
    assert.deepEqual(MCP_TOOL_NAMES, TOOL_NAMES.map(n => `mcp__store__${n}`));
    assert.equal(after('--output-format'), 'stream-json'); assert.ok(a.includes('--verbose')); assert.equal(after('--permission-prompts'), 'none');
    assert.match(after('--system-prompt'), /\*\*The document store\.\*\*/);
    assert.ok(!seen.envKeys.includes('ANTHROPIC_API_KEY'), 'API keys are stripped from the CLI environment');
    const server = seen.mcp.mcpServers.store;
    assert.equal(server.command, process.execPath); assert.deepEqual(server.args.slice(1), ['--stdio', '--review']); assert.match(server.args[0], /server[\\/]store-mcp\.js$/);
    assert.equal(server.env.GCL_TOOLS_URL, listener.url); assert.match(server.env.GCL_REVIEW_TOKEN, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') assert.equal(seen.mcpMode, 0o600);
    assert.equal(listener.tokens.check(server.env.GCL_REVIEW_TOKEN), null, 'the token is revoked when the call ends');
    assert.equal(listener.tokens.size, 0);
    assert.equal(r.model.agentic, true); assert.equal(r.model.cliVersion, '9.9.9 (stub)'); assert.equal(r.model.mcpTools.length, 4);
    assert.deepEqual(r.toolCalls.map(t => t.name), ['get_counterparty_overview']);
    const traced = JSON.parse(readFileSync(path.join(traceDir, 'review.tools.jsonl'), 'utf8').trim());
    assert.equal(traced.result.counterparty, 'Quillon Instruments Ltd', 'the result came through MCP from the store, scoped by the token');
    assert.equal(traced.result.documentCount, 5);
    assert.equal(r.findings.find(f => f.paragraphId === 'p3').record[0].verified, true);
    // Failure paths (6.4.2 step 5): MCP server not connected, turns exhausted, CLI error. Never silently single call.
    process.env.STUB_MODE = 'mcp-failed';
    await assert.rejects(run(s, { executor: 'claude', model: 'm', effort: 'low', traceDir: null, toolsSupported: true }), e => e.code === 'store_tools_failed');
    process.env.STUB_MODE = 'max-turns';
    const last = await run(s, { executor: 'claude', model: 'm', effort: 'low', traceDir: null, toolsSupported: true });
    assert.equal(last.model.turnsExhausted, true); assert.equal(last.findings.find(f => f.paragraphId === 'p3').record[0].verified, true);
    process.env.STUB_MODE = 'max-turns-garbage';
    await assert.rejects(run(s, { executor: 'claude', model: 'm', effort: 'low', traceDir: null, toolsSupported: true }), e => e.code === 'tool_turns_exhausted');
    process.env.STUB_MODE = 'exit-error';
    await assert.rejects(run(s, { executor: 'claude', model: 'm', effort: 'low', traceDir: null, toolsSupported: true }), /Claude CLI failed/);
    assert.equal(listener.tokens.size, 0, 'every token revoked, failures included');
  });
}, { listener: true }));

test('claude: without a tools listener the agentic review fails rather than running without the store', () => seeded(async s => {
  await withEnv({ CLAUDE_BIN: STUB }, () => assert.rejects(run(s, { executor: 'claude', model: 'm', effort: 'low', traceDir: null, toolsSupported: true }), /tools listener/));
}));

test('the Claude stream parser pairs each tool_use with its result and finds the final message', () => {
  const lines = [
    { type: 'system', subtype: 'init', tools: ['mcp__store__search_documents'], mcp_servers: [{ name: 'store', status: 'connected' }] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__store__search_documents', input: { query: 'x' } }, { type: 'tool_use', id: 'b', name: 'mcp__store__list_documents', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: `${NOTICE}\n\n{"count":0}` }, { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: `${NOTICE}\n\n{"hits":[]}` }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '{"findings":[]}' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '{"findings":[]}', num_turns: 2 },
  ];
  const s = parseClaudeStream(lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n');
  assert.deepEqual(s.toolCalls.map(t => [t.name, t.args, t.result]), [['search_documents', { query: 'x' }, { hits: [] }], ['list_documents', {}, { count: 0 }]]);
  assert.equal(s.result.num_turns, 2); assert.equal(s.lastText, '{"findings":[]}'); assert.equal(s.init.mcp_servers[0].status, 'connected');
});
