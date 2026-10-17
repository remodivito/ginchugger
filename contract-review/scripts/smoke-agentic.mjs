#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Slice S3's exit check (product v2 spec section 12; the benchmark's phase-0 exit): ONE agentic review through the real
// Claude CLI executor on the tools-smoke fixture store (plan task 10), with the store tools reached over MCP. Prints the
// CLI version, the MCP tools the CLI saw, every tool call, and the store citations with whether each verified; writes the
// trace to a temporary folder; exits non-zero unless the review completed, made at least one tool call and has at least
// one verified store citation. Also reports the tool smoke criterion (PR-MODEL-03: a store tool called, findings parsed).
// Cheap by design: one five-paragraph document, low effort by default.
//
//   node scripts/smoke-agentic.mjs --dry-run      no model: prints the exact command line and MCP config, then drives the
//                                                 MCP child with the SDK client through the tools listener
//   node scripts/smoke-agentic.mjs                the live run (needs `claude` logged in, so run it from a terminal)
//   options: --model <id> (default claude-opus-5-5), --effort <low|medium|...> (default low), --max-tool-calls <n> (8),
//            --trace <dir> (default a new temporary folder)
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { claudeAgenticArgs, mcpConfigFor, MCP_TOOL_NAMES } from '../server/executors.js';
import { loadAgenticPrompt } from '../server/review.js';
import { runToolSmoke, openToolsSmoke } from '../server/tool-smoke.js';
import { DEFAULT_MAX_TOOL_CALLS } from '../server/store/tools.js';
import { MCP_SERVER } from '../server/executors.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const dryRun = argv.includes('--dry-run');
const model = opt('--model', 'claude-opus-5-5'); const effort = opt('--effort', 'low');
const maxToolCalls = Number(opt('--max-tool-calls', DEFAULT_MAX_TOOL_CALLS));
const traceDir = path.resolve(opt('--trace', mkdtempSync(path.join(tmpdir(), 'gcl-smoke-agentic-'))));
const config = { executor: 'claude', model, effort, replayDir: null, traceDir, toolsSupported: true };
const bin = process.env.CLAUDE_BIN || 'claude';
const quote = a => (a === '' ? "''" : /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
console.log(`Claude CLI: ${v.status === 0 ? v.stdout.trim() : `not runnable (${v.error?.message || v.stderr})`}`);

if (dryRun) {
  const smoke = await openToolsSmoke({ maxToolCalls });
  const { review, playbook, agentic, listener } = smoke;
  let ok = false;
  try {
    const system = loadAgenticPrompt(maxToolCalls).text;
    const token = listener.mint(agentic.tools.scope, { maxCalls: maxToolCalls });
    const mcpPath = path.join(traceDir, 'mcp.json');
    const mcp = mcpConfigFor({ url: listener.url, token });
    writeFileSync(mcpPath, JSON.stringify(mcp), { mode: 0o600 });
    const args = claudeAgenticArgs({ config, system, mcpConfigPath: mcpPath, maxToolCalls });
    const shown = args.map((a, i) => (args[i - 1] === '--system-prompt' ? `<prompts/review-record.md with ${maxToolCalls} calls: ${a.length} chars, sha256 ${createHash('sha256').update(a).digest('hex').slice(0, 16)}>` : quote(a)));
    const payload = JSON.stringify({ document: review.document, baseline: null, playbook: { ...playbook, rules: playbook.rules.filter(r => r.enabled !== false) }, mode: review.reviewMode });
    console.log('\nCommand (the payload goes on stdin; cwd is a fresh temporary folder; API keys stripped from the environment):');
    console.log(`  ${bin} ${shown.join(' ')}  < payload (${payload.length} chars)`);
    console.log('\nMCP config (written mode 0600 in the call\'s temporary folder; the token is minted per review and revoked after it):');
    console.log(JSON.stringify({ mcpServers: { [MCP_SERVER]: { ...mcp.mcpServers[MCP_SERVER], env: { ...mcp.mcpServers[MCP_SERVER].env, GCL_REVIEW_TOKEN: '<review token, 256 bits>' } } } }, null, 2));
    console.log(`\nAllowed tools: ${MCP_TOOL_NAMES.join(', ')}`);
    // No model: drive the MCP child exactly as the CLI would, with the SDK client.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const s = mcp.mcpServers[MCP_SERVER];
    const client = new Client({ name: 'smoke-dry-run', version: '1' });
    await client.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { PATH: process.env.PATH, ...s.env }, stderr: 'inherit' }));
    const listed = (await client.listTools()).tools.map(t => t.name);
    const res = await client.callTool({ name: 'get_counterparty_overview', arguments: {} });
    const text = res.content?.[0]?.text || '';
    const body = JSON.parse(text.slice(text.indexOf('\n\n') + 2));
    await client.close();
    console.log(`\nMCP child (no model): protocol ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}; tools listed: ${listed.join(', ')}`);
    console.log(`get_counterparty_overview through the tools listener: ${body.error ? `error ${body.error.code}` : `${body.counterparty}, ${body.documentCount} documents`}`);
    ok = listed.length === 4 && !body.error;
    listener.revoke(token);
  } finally { await smoke.close(); }
  console.log(ok ? '\nDry run passed.' : '\nDry run FAILED.');
  process.exit(ok ? 0 : 1);
}

console.log(`Model ${model}, effort ${effort}, at most ${maxToolCalls} tool calls. Trace: ${traceDir}`);
const r = await runToolSmoke({ config, traceDir, maxToolCalls });
if (r.error) {
  console.log(`\nReview FAILED: ${r.error.code ? `${r.error.code}: ` : ''}${r.error.message}`);
  try { console.log(readFileSync(path.join(traceDir, 'review.raw.txt'), 'utf8').slice(0, 1500)); } catch { /* no trace */ }
  process.exit(1);
}
const m = r.result.model;
console.log(`\nCLI ${m.cliVersion || '?'}; agentic ${m.agentic}; turns ${m.numTurns ?? '?'}; cost ${m.costUsd != null ? `$${Number(m.costUsd).toFixed(4)}` : '?'}; ${m.seconds}s`);
console.log(`MCP tools the CLI offered the model: ${m.mcpTools ? m.mcpTools.join(', ') || '(none)' : '(not reported)'}`);
console.log(`\nTool calls (${r.toolCalls.length}):`);
for (const t of r.toolCalls) console.log(`  ${t.name} ${JSON.stringify(t.args)} -> ${t.bytes} bytes${t.error ? ` (error ${t.error})` : ''}`);
console.log(`\nFindings: ${r.result.findings.length}; store citations: ${r.citations.length}, verified ${r.verifiedCitations.length}`);
for (const c of r.citations) console.log(`  [${c.verified ? 'verified' : 'UNVERIFIED'}] document ${c.documentId} (${c.counterparty}) "${String(c.quote).slice(0, 80)}"${c.reason ? ` - ${c.reason}` : ''}`);
console.log(`\nTool smoke (PR-MODEL-03: a store tool called and findings parsed): ${r.passed ? 'pass' : 'fail'}${r.calledTools ? '' : ' (no store tool called)'}`);
const ok = r.toolCalls.length > 0 && r.verifiedCitations.length > 0;
console.log(ok ? '\nSmoke passed: tools reached over MCP and at least one store citation verified.' : `\nSmoke FAILED: ${r.toolCalls.length ? 'no verified store citation' : 'no tool call was made'}.`);
console.log(`Trace written to ${traceDir}`);
process.exit(ok ? 0 : 1);
