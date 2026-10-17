#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for the Claude CLI in the executor tests: no model. It reads the --mcp-config it is given, starts the MCP
// server exactly as the CLI would (with the SDK client), lists the tools, makes one tool call through it, and prints a
// stream-json transcript with that call, its result and a final answer citing a store document. STUB_ARGS_FILE receives the
// argv and stdin; STUB_MODE = 'max-turns' | 'max-turns-garbage' | 'mcp-failed' | 'exit-error' varies the ending. Ask:
// 'ask' also reads the counterparty's newest other document and answers as Ask does; 'ask-hang' writes its pid to
// STUB_PID_FILE after the first call and never answers (Stop must kill it); 'ask-prose-once' answers in prose until corrected.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (stub)'); process.exit(0); }
const input = readFileSync(0, 'utf8');
// The single call (no --mcp-config; Ask without the store): 'single-slow' answers after STUB_DELAY_MS; 'single-prose'
// always answers in prose; 'single-prose-once' answers in prose until the request carries Ask's correction. A review
// (the payload has no question) is answered with no findings after STUB_DELAY_MS; 'single-hang' never answers (Stop
// must kill it). STUB_PID_FILE receives the pid.
if (!args.includes('--mcp-config')) {
  const mode = process.env.STUB_MODE || '';
  if (process.env.STUB_ARGS_FILE) writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify({ args, input }) + '\n', { flag: 'a' });
  if (process.env.STUB_PID_FILE) writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
  if (mode === 'single-hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }
  await new Promise(r => setTimeout(r, Number(process.env.STUB_DELAY_MS || 0)));
  let review = false; try { review = typeof JSON.parse(input).question !== 'string'; } catch { /* not JSON */ }
  const prose = mode === 'single-prose' || (mode === 'single-prose-once' && !input.includes('"correction"'));
  const result = review ? JSON.stringify({ findings: [], limits: [] }) : prose ? '### What changed\n- **Payment** moves to 90 days.\n- The cap drops to 3%.' : 'Here it is:\n```json\n' + JSON.stringify({ answer: '**Two changes.**\n- payment\n- cap', evidence: [], ruleIds: [], limits: [] }) + '\n```';
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exit(0);
}
const mcpPath = args[args.indexOf('--mcp-config') + 1];
if (process.env.STUB_ARGS_FILE) writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify({ args, input, cwd: process.cwd(), envKeys: Object.keys(process.env), mcpMode: statSync(mcpPath).mode & 0o777, mcp: JSON.parse(readFileSync(mcpPath, 'utf8')) }));
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const mode = process.env.STUB_MODE || '';
const config = JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.store;
if (mode === 'mcp-failed') { out({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'store', status: 'failed' }] }); out({ type: 'result', subtype: 'success', is_error: false, result: '{"findings":[]}' }); process.exit(0); }
const client = new Client({ name: 'claude-stub', version: '1' });
await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { PATH: process.env.PATH || '', ...config.env }, stderr: 'ignore' }));
const tools = (await client.listTools()).tools.map(t => `mcp__store__${t.name}`);
out({ type: 'system', subtype: 'init', tools, mcp_servers: [{ name: 'store', status: 'connected' }] });
const call = { name: 'get_counterparty_overview', arguments: {} };
const res = await client.callTool(call);
if (mode === 'ask-hang') { writeFileSync(process.env.STUB_PID_FILE, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); }
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: `mcp__store__${call.name}`, input: call.arguments }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: res.content }] } });
if (mode === 'ask' || mode === 'ask-prose-once') {
  const overview = JSON.parse(res.content[0].text.split('\n\n').slice(1).join('\n\n'));
  const other = overview.types.flatMap(t => t.documents).find(d => !d.underReview);
  const read = await client.callTool({ name: 'read_document', arguments: { documentId: other.documentId } });
  await client.close();
  const text = JSON.parse(read.content[0].text.split('\n\n').slice(1).join('\n\n'));
  const quote = text.paragraphs.find(p => p.text.length > 20).text.slice(0, 40);
  const answer = JSON.stringify({ answer: `**Yes.** We accepted it in ${other.title}.\n\n- one\n- two`, evidence: [], sources: [{ documentId: other.documentId, quote, note: 'earlier' }], ruleIds: [], limits: [] });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__store__read_document', input: { documentId: other.documentId } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: read.content }] } });
  // 'ask-prose-once': the first reply is Markdown prose; the second (with Ask's correction) is the JSON object.
  const reply = mode === 'ask-prose-once' && !input.includes('"correction"') ? `**Yes.** We accepted it in ${other.title}.` : answer;
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, num_turns: 3, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
await client.close();
const answer = JSON.stringify({ findings: [{ paragraphId: 'p3', title: 'Term extended to seven years', status: 'attention', decision: 'reject', explanation: 'DUR-01 allows at most five years; our round 1 said three.', evidence: [{ paragraphId: 'p3', quote: 'continue for seven years after termination' }], ruleIds: ['DUR-01'], proposedText: 'Term. The obligations in this Agreement continue for three years after termination.',
  record: [{ documentId: 8, quote: 'continue for three years after termination', counterparty: 'same', note: 'our draft' }] }], limits: [] });
out({ type: 'assistant', message: { content: [{ type: 'text', text: mode === 'max-turns-garbage' ? 'still thinking' : answer }] } });
if (mode.startsWith('max-turns')) { out({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9 }); process.exit(1); }
if (mode === 'exit-error') { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }); process.exit(1); }
out({ type: 'result', subtype: 'success', is_error: false, result: answer, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
