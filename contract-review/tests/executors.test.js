// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutorConfig, describeExecutor, runModel, EXECUTORS, DEMO_RECORDING } from '../server/executors.js';
import { reviewDocument } from '../server/review.js';

const book = { version: 1, rules: [{ id: 'payment', title: 'Payment', topic: 'payment', guidance: 'Pay within 60 days.', enabled: true }] };
const doc = texts => ({ id: 'd1', paragraphs: texts.map((text, i) => ({ id: `p${i}`, text })) });

test('executor configuration: CLI is the default without a key, unknown names fail loudly', () => {
  assert.deepEqual(EXECUTORS, ['anthropic', 'claude', 'openai', 'replay', 'codex', 'muse', 'agy']);
  const c = getExecutorConfig({});
  assert.equal(c.executor, 'claude'); assert.equal(c.model, 'claude-sonnet-5-5'); assert.equal(c.effort, 'medium');
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'openai', OPENAI_MODEL: 'gpt-x' }).model, 'gpt-x');
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'claude', REVIEW_MODEL: 'claude-opus-5-5', REVIEW_EFFORT: 'high' }).model, 'claude-opus-5-5');
  assert.throws(() => getExecutorConfig({ REVIEW_EXECUTOR: 'bard' }), /Unknown REVIEW_EXECUTOR/);
  const d = describeExecutor({ REVIEW_EXECUTOR: 'openai' });
  assert.equal(d.available, false); assert.match(d.reason, /OPENAI_API_KEY/);
  // Replay (test infrastructure): with no folder named it plays the recorded demo; a folder that does not exist is reported.
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'replay' }).replayDir, DEMO_RECORDING); assert.match(DEMO_RECORDING.replace(/\\/g, '/'), /data\/recorded-runs\/demo-fixture\/$/);
  assert.equal(describeExecutor({ REVIEW_EXECUTOR: 'replay' }).available, true);
  assert.equal(describeExecutor({ REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: '/no/such/folder' }).available, false);
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'claude' }).replayDir, null);
  assert.equal(describeExecutor({ REVIEW_EXECUTOR: 'nope' }).available, false);
});

test('replay executor serves a recorded run, records metadata, and makes no network or CLI call', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-'));
  writeFileSync(path.join(dir, 'review.raw.txt'), '```json\n' + JSON.stringify({ findings: [{ paragraphId: 'p0', title: 'Payment period', status: 'attention', explanation: 'Outside the 60-day term.', evidence: [{ paragraphId: 'p0', quote: 'Invoices due in 90 days.' }], ruleIds: ['payment'], decision: 'counter', proposedText: 'Invoices due in 60 days.' }], limits: ['Recorded run.'] }) + '\n```');
  const config = { executor: 'replay', model: 'replay', effort: 'medium', replayDir: dir, traceDir: path.join(dir, 'trace') };
  const { data, meta } = await runModel({ system: 'sys', payload: { a: 1 }, name: 'review', config });
  assert.equal(data.findings.length, 1); assert.equal(meta.executor, 'replay'); assert.match(meta.promptSha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(path.join(dir, 'trace', 'review.meta.json')), 'trace written');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'trace', 'review.meta.json'), 'utf8')).replayedFrom, path.join(dir, 'review.raw.txt'));
  await assert.rejects(runModel({ system: 'sys', payload: {}, name: 'organise', config }), /No recorded run for "organise"/);
  // Through the review pipeline: live mode with the replay executor returns validated findings and metadata.
  const saved = { ...process.env };
  process.env.REVIEW_EXECUTOR = 'replay'; process.env.REVIEW_REPLAY_DIR = dir; delete process.env.REVIEW_TRACE_DIR;
  try {
    const r = await reviewDocument({ document: doc(['Invoices due in 90 days.']), playbook: book, mode: 'live' });
    assert.equal(r.engine, 'live-model'); assert.equal(r.findings[0].decision, 'counter'); assert.equal(r.findings[0].proposalStatus, 'ok');
    assert.equal(r.model.executor, 'replay'); assert.ok(r.model.promptSha256);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('anthropic executor calls the Messages API with the key on the server only, and parses the text block', async () => {
  const oldFetch = global.fetch; const saved = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-only-not-a-key';
  let seen = null;
  try {
    global.fetch = async (url, init) => { seen = { url, headers: init.headers, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"findings":[],"limits":["none"]}' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' }) }; };
    const { runModel, getExecutorConfig, describeExecutor } = await import('../server/executors.js');
    assert.equal(getExecutorConfig({ ANTHROPIC_API_KEY: 'x' }).executor, 'anthropic', 'a configured key selects the API route by default');
    assert.equal(getExecutorConfig({}).executor, 'claude');
    assert.equal(describeExecutor({ REVIEW_EXECUTOR: 'anthropic' }).available, false);
    const { data, meta } = await runModel({ system: 'sys', payload: { a: 1 }, name: 'review', config: { executor: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', replayDir: null, traceDir: null } });
    assert.deepEqual(data.limits, ['none']); assert.equal(meta.usage.output_tokens, 5);
    assert.equal(seen.url, 'https://api.anthropic.com/v1/messages'); assert.equal(seen.headers['x-api-key'], 'test-only-not-a-key'); assert.equal(seen.body.system, 'sys'); assert.equal(seen.body.messages[0].content, '{"a":1}');
    global.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(runModel({ system: 's', payload: {}, config: { executor: 'anthropic', model: 'm', effort: 'medium' } }), /HTTP 401/);
  } finally { global.fetch = oldFetch; if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
});

test('replay maps recorded item ids to the live ids of the same filenames', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-ids-'));
  writeFileSync(path.join(dir, 'baseline.raw.txt'), JSON.stringify({ baselineItemId: 'old-1', mode: 'own-paper', reason: 'v1.docx matches', confidence: 'high', alternatives: [{ itemId: 'old-2', why: 'x' }], limits: [] }));
  writeFileSync(path.join(dir, 'ids.json'), JSON.stringify({ 'old-1': 'v1.docx', 'old-2': 'v2.docx' }));
  const { runModel } = await import('../server/executors.js');
  const config = { executor: 'replay', model: 'replay', effort: 'medium', replayDir: dir, traceDir: null };
  const { data, meta } = await runModel({ system: 's', payload: {}, name: 'baseline', config, replayIds: { 'v1.docx': 'new-1', 'v2.docx': 'new-2' } });
  assert.equal(data.baselineItemId, 'new-1'); assert.equal(data.alternatives[0].itemId, 'new-2'); assert.equal(meta.replayIdsMapped, 2);
  const plain = await runModel({ system: 's', payload: {}, name: 'baseline', config }); assert.equal(plain.data.baselineItemId, 'old-1', 'without a map, the recording plays as recorded');
});

test('a model reply with text after the JSON object still parses (balanced scan), and a truncated one fails loudly', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-trailing-'));
  const { runModel } = await import('../server/executors.js');
  const config = { executor: 'replay', model: 'replay', effort: 'medium', replayDir: dir, traceDir: null };
  writeFileSync(path.join(dir, 'review.raw.txt'), '{"findings":[{"title":"a } brace in a string","explanation":"and an escaped \\" quote"}],"limits":[]}\n\n}  trailing notes { "not": "this" }');
  const { data } = await runModel({ system: 's', payload: {}, name: 'review', config });
  assert.equal(data.findings[0].title, 'a } brace in a string'); assert.deepEqual(data.limits, []);
  writeFileSync(path.join(dir, 'review.raw.txt'), '{"findings":[{"title":"cut off"');
  await assert.rejects(runModel({ system: 's', payload: {}, name: 'review', config }), /JSON/);
});

// The Antigravity CLI (agy, Gemini; evaluation only, 16 Oct 2026) through a stub: what it is sent and how its failures
// are named, so the eval's retry policy classes them (usage limit, transport, malformed).
test('agy executor: one stream-json message on stdin with the system prompt fenced in the user turn, sandboxed, from an empty folder', async () => {
  const { agyArgs, agyMessage, AGY_NO_TOOLS } = await import('../server/executors.js');
  const { classify } = await import('../../tough-eval/v2/retry-policy.mjs');
  assert.deepEqual(agyArgs({ model: 'gemini-3.8-flash-high', timeoutMs: 1_800_000 }), ['--model', 'gemini-3.8-flash-high', '--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox', '--disable-slash-commands', '--print-timeout', '1770s', '-p', '']);
  assert.equal(agyArgs({ model: 'm', timeoutMs: 10_000 }).at(-3), '60s', 'never under a minute');
  const msg = agyMessage('SYS', '{"a":1}');
  assert.ok(msg.indexOf('SYS') < msg.indexOf(AGY_NO_TOOLS) && msg.indexOf(AGY_NO_TOOLS) < msg.indexOf('{"a":1}'));
  assert.match(msg, /===== BEGIN SYSTEM INSTRUCTIONS =====\nSYS\n===== END SYSTEM INSTRUCTIONS =====/); assert.match(msg, /===== BEGIN INPUT =====\n\{"a":1\}\n===== END INPUT =====$/);
  const STUB = fileURLToPath(new URL('./fixtures/agy-stub.mjs', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-')); const argsFile = path.join(dir, 'args.json');
  const saved = { ...process.env };
  const run = (mode, extra = {}) => { Object.assign(process.env, { AGY_BIN: STUB, STUB_ARGS_FILE: argsFile, STUB_MODE: mode, OPENAI_API_KEY: 'must-not-reach-the-cli' }); return runModel({ system: 'SYS', payload: { a: 1 }, name: 'review', config: { executor: 'agy', model: 'gemini-3.8-flash-high', effort: 'medium', replayDir: null, traceDir: path.join(dir, `trace-${mode}`) }, ...extra }); };
  try {
    const { data, meta } = await run('ok');
    assert.deepEqual(data, { findings: [], limits: ['stub'] });
    assert.equal(meta.executor, 'agy'); assert.equal(meta.servedModel, 'gemini-3.8-flash-high'); assert.equal(meta.usage.output_tokens, 20); assert.equal(meta.durationMs, 2500);
    assert.equal(meta.systemPromptInUserTurn, true); assert.equal(meta.toolSteps, 0); assert.equal(meta.conversationId, 'conv-1');
    const seen = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.deepEqual(seen.args, agyArgs({ model: 'gemini-3.8-flash-high', timeoutMs: 1_800_000 }));
    assert.equal(seen.env.OPENAI_API_KEY, null, 'API keys never reach the CLI');
    assert.match(seen.cwd, /review-cli-/); assert.ok(!existsSync(seen.cwd), 'the working folder is removed afterwards');
    const line = JSON.parse(seen.input.trim()); assert.equal(line.event, 'user'); assert.equal(line.message.content, agyMessage('SYS', '{"a":1}'));
    // A tool step is counted, never hidden.
    const t = await run('tool'); assert.equal(t.meta.toolSteps, 1); assert.deepEqual(t.meta.toolNames, ['search_web']);
    // Failures, by class.
    const err = async mode => { try { await run(mode); } catch (e) { return e.message; } assert.fail(`${mode} did not throw`); };
    const quota = await err('quota'); assert.match(quota, /^Antigravity CLI usage limit: RESOURCE_EXHAUSTED/); assert.equal(classify(quota), 'usage-limit');
    const other = await err('error'); assert.match(other, /^Antigravity CLI failed \(exit 1, status ERROR\): stream closed/); assert.equal(classify(other), 'transport');
    const crash = await err('crash'); assert.match(crash, /^Antigravity CLI failed \(exit 3\): panic/); assert.equal(classify(crash), 'transport');
    const cut = await err('cutoff'); assert.match(cut, /^Antigravity CLI answer cut off at the output token limit/); assert.equal(classify(cut), 'malformed');
    const empty = await err('empty'); assert.match(empty, /did not return a JSON object/); assert.equal(classify(empty), 'malformed');
    assert.ok(existsSync(path.join(dir, 'trace-quota', 'review.meta.json')), 'a failed call still leaves a trace');
    const slow = await (async () => { try { await run('slow', { timeoutMs: 1500 }); } catch (e) { return e.message; } })(); assert.match(slow, /^Antigravity CLI failed \(timed out after 2 s\)/); assert.equal(classify(slow), 'transport');
    process.env.AGY_BIN = path.join(dir, 'no-such-agy'); const missing = await (async () => { try { await runModel({ system: 's', payload: {}, config: { executor: 'agy', model: 'm', effort: 'medium' } }); } catch (e) { return e.message; } })();
    assert.match(missing, /^Antigravity CLI could not start/); assert.equal(classify(missing), 'transport');
  } finally { for (const k of ['AGY_BIN', 'STUB_ARGS_FILE', 'STUB_MODE', 'OPENAI_API_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'agy' }).model, 'gemini-3.8-flash-high');
  assert.equal(describeExecutor({ REVIEW_EXECUTOR: 'agy', AGY_BIN: '/no/such/agy' }).available, false);
});
