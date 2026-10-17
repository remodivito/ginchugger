#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The store's four read-only agent tools (server/store/tools.js) as an MCP server over stdio, for one use only: the
// Claude CLI's child during an agentic review or an Ask (product v2 spec 6.4.2; plan task 10). Exactly the tools of
// server/store/tool-schemas.json; `tools/list` and `tools/call` only; no write tool exists. Built on
// @modelcontextprotocol/sdk (MIT) with its low-level Server, because the tools are described by the shared JSON Schema
// file rather than zod.
//
//   node server/store-mcp.js --stdio --review    every call goes to the local app's tools listener (GCL_TOOLS_URL, on
//                                                127.0.0.1) with the review's token (GCL_REVIEW_TOKEN), scoped to that
//                                                review and its lawyer; it never holds a store token and never opens the store
//
// Decision 188 (16 October 2026): there is no external MCP surface; the script refuses to start without --review and a
// review token.
//
// Each result is one text block: the notice, a blank line, then the tool's JSON result. Nothing is written to stdout
// except protocol messages.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpTools, routeName, TOOL_NAMES, NOTICE } from './store/tools.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const MCP_SCRIPT = fileURLToPath(import.meta.url);

/** One text block: the notice, then the result as JSON. */
export const renderResult = result => `${NOTICE}\n\n${JSON.stringify(result)}`;
/** The JSON result back out of a rendered block (for traces and tests). */
export function parseRendered(text) { const s = String(text ?? ''); const i = s.indexOf('\n\n'); try { return JSON.parse(i >= 0 ? s.slice(i + 2) : s); } catch { return { raw: s.slice(0, 2000) }; } }

/** An MCP server whose tool calls go to `callTool(name, args) -> result`. */
export function createStoreMcpServer(callTool) {
  const server = new Server({ name: 'ginchugger-store', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = await callTool(request.params.name, request.params.arguments || {});
    return { content: [{ type: 'text', text: renderResult(result) }], ...(result?.error ? { isError: true } : {}) };
  });
  return server;
}

/** Review mode: forward each call to the tools listener with the review token. */
export function listenerCaller({ url, token, fetchImpl = globalThis.fetch }) {
  return async (name, args = {}) => {
    if (!TOOL_NAMES.includes(name)) return { notice: NOTICE, error: { code: 'bad_request', message: `There is no tool named ${name}.` } };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args || {})) if (v !== undefined && v !== null) q.set(k, Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));
    try {
      const r = await fetchImpl(`${url}/${routeName(name)}?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
      const body = await r.json();
      return r.ok ? body : { notice: NOTICE, error: body?.error || { code: 'error', message: `HTTP ${r.status}` } };
    } catch { return { notice: NOTICE, error: { code: 'store_unavailable', message: 'The document store could not be read.' } }; }
  };
}

/** Serve over stdio until stdin closes. Returns a promise that settles when the transport closes. */
export async function serveStdio({ review = false, env = process.env } = {}) {
  if (!review) throw new Error('Only the agentic review starts this server (--review); there is no MCP access to the store from outside a review.');
  if (!env.GCL_TOOLS_URL || !env.GCL_REVIEW_TOKEN) throw new Error('Review mode needs GCL_TOOLS_URL and GCL_REVIEW_TOKEN.');
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(env.GCL_TOOLS_URL)) throw new Error('GCL_TOOLS_URL must be the local tools listener on 127.0.0.1.');
  const callTool = listenerCaller({ url: env.GCL_TOOLS_URL.replace(/\/$/, ''), token: env.GCL_REVIEW_TOKEN });
  const server = createStoreMcpServer(callTool);
  const transport = new StdioServerTransport();
  const closed = new Promise(resolve => { server.onclose = () => resolve(); });
  await server.connect(transport);
  process.stdin.on('end', () => { server.close().catch(() => {}); });
  return closed;
}

export function parseArgs(argv) {
  const a = [...argv]; const opts = { stdio: false, review: false };
  for (const arg of a) {
    if (arg === '--stdio') opts.stdio = true;
    else if (arg === '--review') opts.review = true;
    else throw new Error(`Unknown argument ${arg}. Usage: store-mcp.js --stdio --review`);
  }
  if (!opts.stdio) throw new Error('Only the stdio transport is built (--stdio).');
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await serveStdio(parseArgs(process.argv.slice(2))); } catch (e) { process.stderr.write(`store-mcp: ${e.message}\n`); process.exitCode = 1; }
}
