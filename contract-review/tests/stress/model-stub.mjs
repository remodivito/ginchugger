#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The stress harness's stand-in for the Claude CLI (tests/stress): no model. The app server runs with
// REVIEW_EXECUTOR=claude, CLAUDE_BIN pointing here and a `claude` shim first on PATH (for anything that spawns `claude` by
// name; every model call has used CLAUDE_BIN since the review's single call stopped blocking, 17 Oct 2026), so every model call of the app (review, Ask, revise; single call or with the store tools)
// lands here. What it answers is read per call from the JSON file named by STRESS_CONTROL:
//   { "review": mode, "ask": mode, "revise": mode, "delayMs": n, "findings": n, "queue": [mode, ...] }
// A mode in `queue` is used once (by the next call of any kind) before the per-kind mode. Modes:
//   ok        a valid answer (a review with `findings` synthetic findings quoting the document exactly; an answer with a
//             Markdown table and a quote from the draft)
//   fenced    the JSON object in a ```json fence after a sentence
//   prose     Markdown prose, no JSON at all
//   truncated the JSON object cut in half
//   empty     an empty reply
//   huge      a very large reply (a ~300 KB answer; a review with 200 findings)
//   slow      `ok` after delayMs (default 35 s)
//   fail      exit 1 with a stack trace and an ENOENT on stderr
//   errored   exit 0 with is_error and an "API Error: 529 overloaded" result
//   hang      never answers (Stop or the timeout must kill it)
//   tableask  an answer that is mostly a wide table
// With --mcp-config (the store tools) the stub really starts the MCP child and makes one or two lookups first, so
// Ask's live steps come from real tool calls, as with the real CLI.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (stress stub)'); process.exit(0); }
const input = readFileSync(0, 'utf8');
const control = () => { try { return JSON.parse(readFileSync(process.env.STRESS_CONTROL, 'utf8')); } catch { return {}; } };
let payload = {}; try { payload = JSON.parse(input); } catch { /* not JSON */ }
const kind = typeof payload.question === 'string' ? 'ask' : payload.instruction ? 'revise' : 'review';
const c = control();
let mode = c[kind] || 'ok';
if (Array.isArray(c.queue) && c.queue.length) { mode = c.queue.shift(); try { writeFileSync(process.env.STRESS_CONTROL, JSON.stringify(c)); } catch { /* best effort */ } }
const corrected = typeof payload.correction === 'string';
const agentic = args.includes('--mcp-config');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
// Exit only once stdout is flushed: a pipe write is asynchronous, and exiting early truncates a large reply.
const done = (code = 0) => process.stdout.write('', () => process.exit(code));

// A hanging stub ends with the app server that started it, so a stopped run leaves nothing behind.
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 1000).unref();
if (mode === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }
// The wait comes after the store lookups (a model thinks between and after its tool calls), so Ask's steps show first.
const wait = () => (mode === 'slow' ? sleep(Number(c.delayMs ?? 35_000)) : c.delayMs && mode !== 'fail' ? sleep(Math.min(Number(c.delayMs), 5000)) : null);
if (!agentic) await wait();
if (mode === 'fail') {
  process.stderr.write(`Error: spawn ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n    at /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js:12:3\nTypeError: Cannot read properties of undefined (reading 'content')\n`);
  if (agentic) out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'TypeError: Cannot read properties of undefined' });
  process.exit(1);
}

const paragraphs = (payload.document?.paragraphs || []).filter(p => typeof p.text === 'string');
const rules = (payload.playbook?.rules || []).map(r => r.id).filter(Boolean);
const words = paragraphs.filter(p => p.text.trim().length > 20);

function reviewObject(n) {
  const findings = [];
  for (let i = 0; i < n && words.length; i++) {
    const p = words[i % words.length];
    if (findings.some(f => f.paragraphId === p.id)) break;
    const status = ['attention', 'context', 'within-guidance'][i % 3];
    // The whole paragraph as the quote: a paragraph over 255 characters exercises Word's search limit.
    const quote = p.text.trim();
    const proposedText = i % 4 === 3 ? null : p.text.replace(/\b(\w{4,})\b/, '$1 (as amended)');
    findings.push({ paragraphId: p.id, title: `Point ${i + 1}: ${p.text.trim().split(/\s+/).slice(0, 5).join(' ')}`, status, decision: status === 'within-guidance' ? 'accept' : 'counter',
      explanation: `This clause departs from the playbook. ${'The wording should be narrowed. '.repeat(1 + (i % 3))}`, evidence: [{ paragraphId: p.id, quote }], ruleIds: rules.length ? [rules[i % rules.length]] : [],
      ...(proposedText ? { proposedText } : {}) });
  }
  return { findings, limits: [] };
}
function askObject(huge = false) {
  const p = words[0];
  const table = '| Clause | Theirs | Ours |\n|---|---|---|\n' + words.slice(0, 6).map((x, i) => `| ¶ ${x.id.replace(/^p/, '')} | ${x.text.slice(0, 40).replace(/\|/g, '/')} | point ${i + 1} |`).join('\n');
  const body = `**Short answer.** The draft changes the terms.\n\n${table}\n\n- first\n- second`;
  return { answer: huge ? body + '\n\n' + 'A long paragraph of analysis that repeats. '.repeat(7000) : body, evidence: p ? [{ paragraphId: p.id, quote: p.text.trim() }] : [], ruleIds: rules.slice(0, 1), limits: [] };
}
function answer() {
  if (kind === 'review' || kind === 'revise') return reviewObject(mode === 'huge' ? 200 : kind === 'revise' ? 1 : Number(c.findings ?? 6));
  if (mode === 'tableask') return { answer: '| ' + Array.from({ length: 14 }, (_, i) => `Column ${i}`).join(' | ') + ' |\n|' + '---|'.repeat(14) + '\n| ' + Array.from({ length: 14 }, () => 'a-very-long-unbroken-cell-value-without-spaces').join(' | ') + ' |', evidence: [], ruleIds: [], limits: [] };
  return askObject(mode === 'huge');
}
function text() {
  const json = JSON.stringify(answer());
  // Ask's correction is honoured, as a model usually does on the second attempt (except in `prose`, which never does).
  if (corrected && mode !== 'prose' && mode !== 'empty') return json;
  switch (mode) {
    case 'fenced': return `Here is the result you asked for:\n\n\`\`\`json\n${json}\n\`\`\`\n\nLet me know if you need more.`;
    case 'prose': return `### What changed\n\n- **Payment** moves to 90 days.\n- The cap drops to 3%.\n\nI could not format this as JSON {because reasons}.`;
    case 'truncated': return json.slice(0, Math.floor(json.length / 2));
    case 'empty': return '';
    default: return json;
  }
}

async function lookups() {
  const mcpPath = args[args.indexOf('--mcp-config') + 1];
  const config = JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.store;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'stress-stub', version: '1' });
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { PATH: process.env.PATH || '', ...config.env }, stderr: 'ignore' }));
  const tools = (await client.listTools()).tools.map(t => `mcp__store__${t.name}`);
  out({ type: 'system', subtype: 'init', tools, mcp_servers: [{ name: 'store', status: 'connected' }] });
  let n = 0;
  const call = async (name, a) => {
    const id = `toolu_${++n}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__store__${name}`, input: a } ] } });
    let res; try { res = await client.callTool({ name, arguments: a }); } catch (e) { res = { content: [{ type: 'text', text: String(e.message) }], isError: true }; }
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: res.content, ...(res.isError ? { is_error: true } : {}) }] } });
    return res;
  };
  await call('get_counterparty_overview', {});
  if (kind === 'ask') await call('search_documents', { query: 'term' }).catch(() => null);
  await client.close();
}

await (async () => {
const t = text();
if (agentic) {
  await lookups().catch(e => { out({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'store', status: 'connected' }] }); process.stderr.write(String(e.message)); });
  await wait();
  out({ type: 'assistant', message: { content: [{ type: 'text', text: t || ' ' }] } });
  if (mode === 'errored') { out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }); return done(0); }
  out({ type: 'result', subtype: 'success', is_error: false, result: t, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  return done(0);
}
if (mode === 'errored') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })); return done(0); }
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: t, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));
void existsSync;
})();
