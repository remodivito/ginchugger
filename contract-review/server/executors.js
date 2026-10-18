// SPDX-License-Identifier: GPL-3.0-or-later
// Model executors (spec R9.1–R9.4; T3, revised T20). One seam, five backends:
//   anthropic – keyed Anthropic Messages API (the route a deployment uses: Commercial Terms, key held on the server only).
//   claude    – the unmodified Claude Code CLI in print mode under the developer's own subscription login
//               (development, evaluation and the demo on the developer's machine; not a shipped route, see decision log 3 Oct 2026).
//   openai    – keyed OpenAI-compatible /chat/completions (fallback for reviewers without an Anthropic key).
//   replay    – a recorded run on disk; no model call. Sample mode: the recorded demo by default (DEMO_RECORDING).
//   codex     – subscription Codex CLI (evaluation only).
//   muse      – subscription Muse Code CLI, `muse exec` headless with tools off (evaluation only; 14 Oct 2026).
//   agy       – Google's Antigravity CLI (Gemini) under its own sign-in, print mode, one message holding the system
//               prompt and the payload (it has no system-prompt flag); evaluation only (16 Oct 2026).
// Default: anthropic when ANTHROPIC_API_KEY is set, otherwise claude.
// The server makes every call; the add-in and browser never hold credentials. Every call returns the parsed
// JSON object plus metadata (executor, model, effort, timings, usage, promptSha256) for the run manifest.
// Agentic calls (product v2 spec 6.4; plan task 10) also take `tools` and return the tool calls made: the Claude CLI
// reaches the store tools (server/store/tools.js) through an MCP child that calls the local tools listener with a review
// token; the Anthropic API and OpenAI-compatible endpoints through tool calling answered in-process; replay from the
// recorded tools file.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicTools, openaiTools, TOOL_NAMES, NOTICE } from './store/tools.js';

export const EXECUTORS = ['anthropic', 'claude', 'openai', 'replay', 'codex', 'muse', 'agy'];
const DEFAULT_MODEL = { anthropic: 'claude-sonnet-5-5', claude: 'claude-sonnet-5-5', openai: null, replay: 'replay', codex: 'gpt-6.1-sol', muse: 'muse-wonder-1.0', agy: 'gemini-3.8-flash-high' };
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Sample mode (product v2 spec section 2): the replay executor over the recorded demo unless REVIEW_REPLAY_DIR names another.
export const DEMO_RECORDING = fileURLToPath(new URL('../data/recorded-runs/demo-fixture/', import.meta.url));
const sha256 = s => createHash('sha256').update(s).digest('hex');
const STRIP = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function getExecutorConfig(env = process.env) {
  const executor = env.REVIEW_EXECUTOR || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'claude');
  if (!EXECUTORS.includes(executor)) throw Object.assign(new Error(`Unknown REVIEW_EXECUTOR "${executor}". Use one of: ${EXECUTORS.join(', ')}.`), { status: 500 });
  const model = env.REVIEW_MODEL || (executor === 'openai' ? env.OPENAI_MODEL || null : DEFAULT_MODEL[executor]);
  const effort = env.REVIEW_EFFORT || 'medium';
  // toolsSupported: false when the setup's tool smoke test failed (PR-MODEL-03); the settings file carries it from S6.
  return { executor, model, effort, replayDir: env.REVIEW_REPLAY_DIR || (executor === 'replay' ? DEMO_RECORDING : null), traceDir: env.REVIEW_TRACE_DIR || null, toolsSupported: env.REVIEW_TOOLS_SUPPORTED !== 'false' };
}

/** Whether a review on this configuration may use the store tools: codex and muse are single call (eval only). */
export function toolsSupported(config) { return Boolean(config) && config.toolsSupported !== false && ['anthropic', 'claude', 'openai', 'replay'].includes(config.executor); }

/** What /api/status reports. `available` is a configuration check, not a proof the route works right now. */
export function describeExecutor(env = process.env) {
  let cfg; try { cfg = getExecutorConfig(env); } catch (e) { return { executor: env.REVIEW_EXECUTOR || null, model: null, effort: null, available: false, reason: e.message }; }
  let available = true, reason = null;
  if (cfg.executor === 'anthropic' && !env.ANTHROPIC_API_KEY) { available = false; reason = 'ANTHROPIC_API_KEY is required for the anthropic executor.'; }
  if (cfg.executor === 'openai' && !(env.OPENAI_API_KEY && cfg.model)) { available = false; reason = 'OPENAI_API_KEY and a model are required for the openai executor.'; }
  if (cfg.executor === 'replay' && !(cfg.replayDir && existsSync(cfg.replayDir))) { available = false; reason = 'REVIEW_REPLAY_DIR must point at a folder of recorded runs.'; }
  if (cfg.executor === 'claude' && !which(env.CLAUDE_BIN || 'claude')) { available = false, reason = 'The claude CLI is not on PATH.'; }
  if (cfg.executor === 'codex' && !which(env.CODEX_BIN || 'codex')) { available = false, reason = 'The codex CLI is not on PATH.'; }
  if (cfg.executor === 'muse' && !which(env.MUSE_BIN || 'muse')) { available = false, reason = 'The muse CLI is not on PATH.'; }
  if (cfg.executor === 'agy' && !which(env.AGY_BIN || 'agy')) { available = false, reason = 'The agy CLI is not on PATH.'; }
  return { executor: cfg.executor, model: cfg.model, effort: cfg.effort, available, reason };
}

// A path (either separator) must exist; a bare name is looked up on PATH: `where` on Windows (which has no sh), else sh.
function which(bin) {
  if (/[\\/]/.test(bin)) return existsSync(bin);
  const r = process.platform === 'win32' ? spawnSync('where', [bin], { encoding: 'utf8' }) : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 && Boolean(String(r.stdout || '').trim());
}
// API keys never reach a CLI. The Claude CLI's own long-lived token (claude setup-token) is its sign-in, so it stays.
function cleanEnv(keep = []) { const env = { ...process.env }; for (const k of STRIP) if (!keep.includes(k)) delete env[k]; return env; }
/** First JSON object in the text. Greedy match first; if the model wrote anything after the object (a second object,
 *  a stray brace, commentary), fall back to a balanced scan that respects strings, so one trailing character never
 *  loses a whole review (found by the demo recording, 3 Oct 2026). */
function parseJsonObject(text) {
  const str = String(text); const m = str.match(/\{[\s\S]*\}/); if (!m) throw new Error('The model did not return a JSON object.');
  try { return JSON.parse(m[0]); } catch (greedyError) {
    const start = str.indexOf('{'); let depth = 0, inString = false, escape = false;
    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (inString) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(str.slice(start, i + 1)); }
    }
    throw greedyError;
  }
}
// A trace holds the contract, the playbook and the model's reply in plain text (benchmark spec 14.4), so the folder and
// its files are readable by this user only (security review, 17 Oct 2026). No key is ever written here.
function trace(dir, name, meta, system, user, raw, toolCalls = null) {
  if (!dir) return; mkdirSync(dir, { recursive: true, mode: 0o700 });
  const put = (file, text) => writeFileSync(path.join(dir, file), text, { mode: 0o600 });
  put(`${name}.meta.json`, JSON.stringify(meta, null, 2)); put(`${name}.system.txt`, system);
  put(`${name}.user.json`, user); put(`${name}.raw.txt`, String(raw));
  // An agentic call's tool calls, one per line, in order (6.4.4); the same file is what replay plays back.
  if (toolCalls) put(`${name}.tools.jsonl`, toolCalls.map((t, i) => JSON.stringify({ n: i + 1, name: t.name, args: t.args, bytes: t.bytes, result: t.result })).join('\n') + (toolCalls.length ? '\n' : ''));
}

/**
 * Run one model call. `payload` is serialised as the user message. Returns { data, meta }.
 * `name` labels the trace files (e.g. 'review', 'organise', 'ask').
 */
/**
 * `replayIds`, optional: { filename: liveId }. A recorded run names items by the ids they had when recorded; the
 * recording's ids.json maps those ids to filenames, so playback can point at the items as they exist now.
 */
/**
 * What a request is about: the document as it stood before anyone's tracked changes (so the answer does not move when
 * the lawyer applies an edit, and two rounds of one negotiation are told apart). Null for calls with no single document.
 */
export function replaySubject(payload) {
  let p = payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return null; } }
  const lines = Array.isArray(p?.document?.paragraphs) ? p.document.paragraphs.map(x => typeof x.originalText === 'string' ? x.originalText : x.text)
    : p?.incoming ? (p.incoming.reconstructedOriginal || p.incoming.head || null) : null;
  return Array.isArray(lines) && lines.length ? sha256(JSON.stringify(lines)).slice(0, 16) : null;
}
/**
 * The recording to play for this call. A folder may hold several recordings of one call (`review.raw.txt`,
 * `review@round1.raw.txt`); the one made for the same document is played. A recording about a different document is
 * never played in its place (found in Word, 5 Oct 2026: a recorded answer about the counter-turn was shown for the markup).
 */
export function pickRecording(dir, name, payload) {
  const none = message => Object.assign(new Error(message), { status: 503, code: 'NO_RECORDING' });
  const stems = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.raw.txt') && (f === `${name}.raw.txt` || f.startsWith(`${name}@`))).map(f => f.slice(0, -'.raw.txt'.length)) : [];
  if (!stems.length) throw none(`No recorded run for "${name}" in ${dir}.`);
  const want = replaySubject(payload);
  const known = stems.map(stem => { const u = path.join(dir, `${stem}.user.json`); return { stem, subject: existsSync(u) ? replaySubject(readFileSync(u, 'utf8')) : null }; });
  const match = want && known.find(k => k.subject === want);
  if (match) return path.join(dir, `${match.stem}.raw.txt`);
  // No way to compare (the call has no document, or the recording kept no request): play the plain recording as before.
  const plain = known.find(k => k.stem === name);
  if (plain && (!want || !plain.subject)) return path.join(dir, `${name}.raw.txt`);
  throw none(`The recorded runs do not include "${name}" for this document. They cover the demonstration documents only.`);
}


// ---- Agentic calls (product v2 spec 6.4) ----------------------------------------------------------------------------
const toolError = (code, message) => Object.assign(new Error(message), { code });
const bytesOf = result => Buffer.byteLength(JSON.stringify(result ?? null));
const limitResult = max => ({ notice: NOTICE, error: { code: 'tool_limit', message: `This review may make at most ${max} store lookups; answer from what has been read.` } });
/** The MCP child the Claude CLI starts (6.4.2 step 2). */
// The Claude CLI reports usage per model; besides the model asked for it may make a small background call to another
// (16 Oct: a Haiku call of about 1,500 tokens in and 11 out per run). The answering model is the one that wrote the
// most output; the others are listed as auxiliary so a reader does not take them for the reviewer.
export function servedFromModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return { servedModel: null, auxiliaryModels: [] };
  const rows = Object.entries(modelUsage).map(([m, u]) => [m, Number(u?.outputTokens) || 0]).sort((a, b) => b[1] - a[1]);
  return { servedModel: rows[0]?.[0] ?? null, auxiliaryModels: rows.slice(1).map(r => r[0]) };
}

export const MCP_SCRIPT = fileURLToPath(new URL('./store-mcp.js', import.meta.url));
export const MCP_SERVER = 'store';
export const MCP_TOOL_NAMES = TOOL_NAMES.map(n => `mcp__${MCP_SERVER}__${n}`);
export function mcpConfigFor({ url, token, script = MCP_SCRIPT, node = process.execPath }) {
  return { mcpServers: { [MCP_SERVER]: { command: node, args: [script, '--stdio', '--review'], env: { GCL_TOOLS_URL: url, GCL_REVIEW_TOKEN: token } } } };
}
/** The Claude CLI's arguments for an agentic review (6.4.2 step 3): today's flags plus the MCP config, the store tools
 *  allowed by name, a turn limit, and the stream so tool calls can be traced. `--tools ""` keeps every built-in off. */
export function claudeAgenticArgs({ config, system, mcpConfigPath, maxToolCalls }) {
  return ['-p', '--model', config.model, '--effort', config.effort, '--system-prompt', system, '--tools', '', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands',
    '--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', MCP_TOOL_NAMES.join(','), '--permission-prompts', 'none',
    '--max-turns', String(maxToolCalls + 1), '--output-format', 'stream-json', '--verbose'];
}
/** The JSON result out of an MCP text block (the notice, a blank line, the JSON). */
function renderedResult(text) { const s = String(text ?? ''); const i = s.indexOf('\n\n'); try { return JSON.parse(i >= 0 ? s.slice(i + 2) : s); } catch { return { raw: s.slice(0, 2000) }; } }

/** Read the Claude CLI's stream-json output: the init line, every tool_use with its tool_result, the final result. */
export function parseClaudeStream(stdout) {
  const events = String(stdout || '').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find(e => e.type === 'system' && e.subtype === 'init') || null;
  const byId = new Map(); const toolCalls = []; let lastText = null;
  for (const e of events) {
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === 'assistant') for (const c of content) {
      if (c.type === 'tool_use') { const t = { name: String(c.name || '').replace(/^mcp__store__/, ''), args: c.input || {}, bytes: 0, result: null }; byId.set(c.id, t); toolCalls.push(t); }
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) lastText = c.text;
    }
    if (e.type === 'user') for (const c of content) if (c.type === 'tool_result' && byId.has(c.tool_use_id)) {
      const text = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.filter(x => x.type === 'text').map(x => x.text).join('') : '');
      const t = byId.get(c.tool_use_id); t.bytes = Buffer.byteLength(text); t.result = renderedResult(text); if (c.is_error && !t.result.error) t.result = { error: { code: 'tool_error', message: text.slice(0, 300) } };
    }
  }
  const result = [...events].reverse().find(e => e.type === 'result') || null;
  return { init, toolCalls, result, lastText, events: events.length };
}

// CLAUDE_BIN may name a .js/.mjs script (the tests' stub CLI), run with this Node on every platform.
const viaNode = (bin, args) => (/\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args]);
/** A tool call as it happens, for a caller's live progress (Ask; `tools.onCall`); a failing listener never stops the call. */
export function notifyTool(tools, event) { try { tools?.onCall?.(event); } catch { /* progress only */ } }
/** The timeout, and the caller's signal when it gave one (Ask's Stop). */
const callSignal = (timeoutMs, signal) => (signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs));
function spawnCollect(bin, args, { input, env, cwd, timeoutMs, signal = null }) {
  return new Promise(resolve => {
    let child; try { child = spawn(...viaNode(bin, args), { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) { resolve({ error }); return; }
    const out = [], err = []; let done = false;
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    // Stop (Ask): the caller gave up, so the CLI child is ended at once.
    const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); child.on('close', () => signal.removeEventListener('abort', stop)); }
    child.stdout.on('data', d => out.push(d)); child.stderr.on('data', d => err.push(d));
    child.on('error', error => { if (!done) { done = true; clearTimeout(timer); resolve({ error }); } });
    child.on('close', (status, signal) => { if (!done) { done = true; clearTimeout(timer); resolve({ status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); } });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

async function claudeWithTools({ config, system, user, tools, timeoutMs, signal = null }) {
  if (!tools.listener?.url || typeof tools.listener.mint !== 'function') throw new Error('The Claude CLI reaches the store through the local tools listener, and none is running.');
  const bin = process.env.CLAUDE_BIN || 'claude';
  const v = spawnSync(...viaNode(bin, ['--version']), { encoding: 'utf8', timeout: 20_000, env: cleanEnv(['CLAUDE_CODE_OAUTH_TOKEN']) });
  const cliVersion = v.status === 0 ? String(v.stdout).trim() : null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
  const token = tools.listener.mint(tools.scope, { maxCalls: tools.maxToolCalls, ...(tools.onCall ? { onCall: event => notifyTool(tools, event) } : {}) });
  try {
    const mcpConfigPath = path.join(dir, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigFor({ url: tools.listener.url, token })), { mode: 0o600 });
    const r = await spawnCollect(bin, claudeAgenticArgs({ config, system, mcpConfigPath, maxToolCalls: tools.maxToolCalls }), { input: user, env: cleanEnv(['CLAUDE_CODE_OAUTH_TOKEN']), cwd: dir, timeoutMs, signal });
    if (r.error) throw new Error(`Claude CLI could not start: ${r.error.message}`);
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { code: 'stopped' });
    const s = parseClaudeStream(r.stdout);
    const server = (s.init?.mcp_servers || []).find(x => x.name === MCP_SERVER);
    if (s.init && (!server || server.status !== 'connected')) throw toolError('store_tools_failed', `The store tools did not start (MCP server ${server ? server.status : 'missing'}). No offline result was substituted.`);
    const extra = { usage: s.result?.usage || null, costUsd: s.result?.total_cost_usd ?? null, modelUsage: s.result?.modelUsage || null, ...servedFromModelUsage(s.result?.modelUsage), numTurns: s.result?.num_turns, durationMs: s.result?.duration_ms, stopReason: s.result?.stop_reason ?? s.result?.subtype ?? null, cliVersion,
      mcpTools: Array.isArray(s.init?.tools) ? s.init.tools.filter(t => String(t).startsWith('mcp__')) : null };
    if (s.result?.subtype === 'error_max_turns') {
      // Turns ran out: the CLI's last message is the answer if it parses (6.4.2 step 5).
      try { parseJsonObject(s.lastText); } catch { throw toolError('tool_turns_exhausted', 'The model used every turn without returning the review.'); }
      return { raw: s.lastText, extra: { ...extra, turnsExhausted: true }, toolCalls: s.toolCalls };
    }
    if (r.status !== 0 || !s.result) throw new Error(`Claude CLI failed (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}): ${String(s.result?.result || r.stderr || '').slice(-400)}`);
    if (s.result.is_error) throw new Error(`Claude CLI returned an error: ${String(s.result.result || '').slice(0, 200)}`);
    return { raw: s.result.result, extra, toolCalls: s.toolCalls };
  } finally { tools.listener.revoke?.(token); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** The single call's Claude CLI arguments: print mode, no tools, no settings, JSON out. The request the model receives is
 *  these flags, the system prompt and the payload on stdin; the review benchmark depends on them staying the same. */
export function claudeSingleArgs({ config, system }) {
  return ['-p', '--model', config.model, '--effort', config.effort, '--system-prompt', system, '--tools', '', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--permission-prompts', 'none', '--output-format', 'json'];
}
/** The single call through the Claude CLI, for Ask (17 Oct 2026) and the review (17 Oct 2026, stress scenario
 *  review-blocks-server): spawned without blocking, so the server keeps answering pages, Ask and progress polls while the
 *  model works, and the caller's signal (Stop, or the client going away) ends the child. The request is unchanged from
 *  the former blocking call (claudeSingleArgs; same stdin). */
async function claudeSingle({ config, system, user, timeoutMs, signal = null }) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
  try {
    const args = claudeSingleArgs({ config, system });
    const r = await spawnCollect(bin, args, { input: user, env: cleanEnv(['CLAUDE_CODE_OAUTH_TOKEN']), cwd: dir, timeoutMs, signal });
    if (r.error) throw new Error(`Claude CLI could not start: ${r.error.message}`);
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { code: 'stopped' });
    if (r.status !== 0) throw new Error(`Claude CLI failed (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}): ${String(r.stderr || '').slice(-400)}`);
    const data = JSON.parse(r.stdout); if (data.is_error) throw new Error(`Claude CLI returned an error: ${String(data.result || '').slice(0, 200)}`);
    return { raw: data.result, extra: { usage: data.usage || null, costUsd: data.total_cost_usd ?? null, modelUsage: data.modelUsage || null, ...servedFromModelUsage(data.modelUsage), numTurns: data.num_turns, durationMs: data.duration_ms, stopReason: data.stop_reason } };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

async function anthropicWithTools({ config, system, user, tools, timeoutMs, signal = null }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Live review needs ANTHROPIC_API_KEY on the server. No offline result was substituted.');
  const url = (process.env.ANTHROPIC_BASE_URL ? process.env.ANTHROPIC_BASE_URL.replace(/\/$/, '') + '/v1/messages' : ANTHROPIC_URL);
  const messages = [{ role: 'user', content: user }]; const toolCalls = []; const usage = []; let executed = 0;
  for (let turn = 0; turn <= tools.maxToolCalls + 1; turn++) {
    const spent = executed >= tools.maxToolCalls;
    const response = await fetch(url, { method: 'POST', signal: callSignal(timeoutMs, signal), headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.model, max_tokens: 16000, system, messages, tools: anthropicTools(), ...(spent ? { tool_choice: { type: 'none' } } : {}) }) });
    if (!response.ok) throw new Error(`Anthropic API returned HTTP ${response.status}. No offline result was substituted.`);
    const body = await response.json(); usage.push(body?.usage || null);
    const content = Array.isArray(body?.content) ? body.content : [];
    const uses = content.filter(c => c.type === 'tool_use');
    if (body?.stop_reason !== 'tool_use' || !uses.length) {
      const raw = content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (!raw || raw.length > 400_000) throw new Error('Anthropic API did not return bounded valid JSON.');
      return { raw, extra: { usage, stopReason: body?.stop_reason || null, turns: turn + 1 }, toolCalls };
    }
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) {
      const live = executed < tools.maxToolCalls;
      if (live) notifyTool(tools, { phase: 'start', name: u.name, args: u.input || {} });
      const result = live ? (executed++, await tools.call(u.name, u.input || {})) : limitResult(tools.maxToolCalls);
      if (live) notifyTool(tools, { phase: 'done', name: u.name, args: u.input || {}, result });
      toolCalls.push({ name: u.name, args: u.input || {}, bytes: bytesOf(result), result });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(result), ...(result?.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  throw toolError('tool_turns_exhausted', 'The model used every turn without returning the review.');
}

/** One OpenAI-compatible response, streamed or not: text, tool calls (assembled from deltas) and usage. */
async function readOpenAI(response) {
  if (String(response.headers?.get?.('content-type') || '').includes('event-stream')) {
    let text = '', finish = null, usage = null, served = null, buffer = ''; const calls = []; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const data = line.startsWith('data:') ? line.slice(5).trim() : ''; if (!data || data === '[DONE]') continue;
        let event; try { event = JSON.parse(data); } catch { continue; }
        if (event.model) served = event.model;
        const c = event.choices?.[0]; if (c?.delta?.content) text += c.delta.content; if (c?.finish_reason) finish = c.finish_reason; if (event.usage) usage = event.usage;
        for (const d of c?.delta?.tool_calls || []) { const i = d.index ?? calls.length; calls[i] ||= { id: '', name: '', arguments: '' }; if (d.id) calls[i].id = d.id; if (d.function?.name) calls[i].name += d.function.name; if (d.function?.arguments) calls[i].arguments += d.function.arguments; }
      }
    }
    return { content: text || null, toolCalls: calls.filter(Boolean), finish, usage, served };
  }
  const body = await response.json(); const choice = body?.choices?.[0];
  return { content: choice?.message?.content ?? null, toolCalls: (choice?.message?.tool_calls || []).map(t => ({ id: t.id, name: t.function?.name || '', arguments: t.function?.arguments || '' })), finish: choice?.finish_reason || null, usage: body?.usage || null, served: body?.model || null };
}

async function openaiWithTools({ config, system, user, tools, timeoutMs, signal = null }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !config.model) throw new Error('Live review needs OPENAI_API_KEY and a model on the server. No offline result was substituted.');
  const url = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }]; const toolCalls = []; const usage = []; let executed = 0, served = null;
  for (let turn = 0; turn <= tools.maxToolCalls + 1; turn++) {
    const spent = executed >= tools.maxToolCalls;
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(url, { method: 'POST', signal: callSignal(Math.min(timeoutMs, 600_000), signal), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: config.model, max_completion_tokens: Number(process.env.REVIEW_MAX_OUTPUT_TOKENS || 16000), messages, tools: openaiTools(), tool_choice: spent ? 'none' : 'auto', stream: true, stream_options: { include_usage: true } }) });
      if (![429, 503].includes(response.status) || attempt >= 5 || !response.headers?.get?.('retry-after')) break;
      await new Promise(r => setTimeout(r, Math.min(300, Number(response.headers?.get?.('retry-after')) || 30) * 1000));
    }
    // A provider that refuses `tools` outright runs the single call instead (6.4.3); reviewDocument catches this code.
    if (response.status === 400 && turn === 0) throw toolError('tools_unsupported', 'The provider refused tool calling (HTTP 400).');
    if (!response.ok) throw new Error(`Live provider returned HTTP ${response.status}. No offline result was substituted.`);
    const r = await readOpenAI(response); usage.push(r.usage); if (r.served) served = r.served;
    if (!r.toolCalls.length) {
      if (typeof r.content !== 'string' || r.content.length > 400_000) throw new Error(`Live provider did not return bounded valid JSON (finish reason: ${r.finish || 'none'}).`);
      return { raw: r.content, extra: { usage, stopReason: r.finish, turns: turn + 1, servedModel: served }, toolCalls };
    }
    messages.push({ role: 'assistant', content: r.content, tool_calls: r.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) });
    for (const t of r.toolCalls) {
      let args; try { args = t.arguments ? JSON.parse(t.arguments) : {}; } catch { args = null; }
      const live = args !== null && executed < tools.maxToolCalls;
      if (live) notifyTool(tools, { phase: 'start', name: t.name, args });
      const result = args === null ? { notice: NOTICE, error: { code: 'bad_request', message: 'Tool arguments were not valid JSON.' } }
        : live ? (executed++, await tools.call(t.name, args)) : limitResult(tools.maxToolCalls);
      if (live) notifyTool(tools, { phase: 'done', name: t.name, args, result });
      toolCalls.push({ name: t.name, args: args ?? {}, bytes: bytesOf(result), result });
      messages.push({ role: 'tool', tool_call_id: t.id, content: JSON.stringify(result) });
    }
  }
  throw toolError('tool_turns_exhausted', 'The model used every turn without returning the review.');
}

/** Replay of tool calls (6.4.3): recorded calls answered in order; a call not in the recording gets an error result. */
export function recordedToolRouter(lines) {
  const left = lines.map(l => ({ ...l, key: `${l.name}\u0000${JSON.stringify(l.args ?? {})}` }));
  return {
    async call(name, args = {}) {
      const key = `${name}\u0000${JSON.stringify(args ?? {})}`; const i = left.findIndex(l => l.key === key);
      if (i < 0) return { notice: NOTICE, error: { code: 'not_recorded', message: 'not recorded' } };
      return left.splice(i, 1)[0].result;
    },
  };
}
export function readRecordedTools(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).map(l => ({ name: l.name, args: l.args ?? {}, bytes: l.bytes ?? bytesOf(l.result), result: l.result }));
}

// ---- Antigravity CLI (agy), evaluation only -------------------------------------------------------------------------
// agy has no system-prompt flag, so the system prompt and the payload go in one user message, each fenced by a marker
// line (recorded as systemPromptInUserTurn in the run manifest). The message is sent on stdin as one stream-json input
// event (an argument could exceed ARG_MAX on a long contract), from a fresh empty working directory, sandboxed, with
// slash commands and skills off. agy's headless mode auto-denies any tool that needs a permission (writes, commands);
// the instruction line asks for no tool use and every tool step the CLI reports is counted in the metadata.
export const AGY_NO_TOOLS = 'Do not use tools, browse, read files or run commands; all necessary material is in the input below. Return only the JSON object.';
export function agyMessage(system, user) {
  return ['===== BEGIN SYSTEM INSTRUCTIONS =====', system, '===== END SYSTEM INSTRUCTIONS =====', '', AGY_NO_TOOLS, '', '===== BEGIN INPUT =====', user, '===== END INPUT ====='].join('\n');
}
/** agy's arguments: print mode, stream-json in and out, the print timeout a little inside the process timeout. agy 1.4.0
 *  overran its --print-timeout (a 36-minute call against 1770 s) and ignores SIGTERM, so the process is killed with
 *  SIGKILL at the timeout (development check, 16 Oct). */
export function agyArgs({ model, timeoutMs }) {
  const printSeconds = Math.max(60, Math.floor(timeoutMs / 1000) - 30);
  return ['--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox', '--disable-slash-commands', '--print-timeout', `${printSeconds}s`, '-p', ''];
}
/** Read agy's stream-json output: the init event (model as configured), tool steps, the final result. */
export function parseAgyStream(stdout) {
  const events = String(stdout || '').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find(e => e.event === 'init')?.init || null;
  const result = [...events].reverse().find(e => e.event === 'result')?.result || null;
  const tools = new Map();
  for (const e of events) { const u = e.step_update; if (u?.step_type === 'tool') tools.set(u.step_index, { name: u.tool_name || u.tool_info?.name || null, state: u.state }); }
  return { init, result, toolSteps: [...tools.values()], events: events.length };
}
// Quota, rate limits and capacity are usage limits (retried every 15 minutes by the eval's retry policy); any other CLI
// failure, a timeout included, is "Antigravity CLI failed" (transport, as a Claude CLI failure is); an answer cut off at
// the output token limit, and a run that finishes without a parseable answer, are malformed.
export const AGY_USAGE_LIMIT = /quota|RESOURCE_EXHAUSTED|rate[ _-]?limit|\b429\b|capacity|exhausted|too many requests|usage limit|try again later/i;
export const AGY_TRUNCATED = /exceeded the output token limit|response was cut off/i;
export function agyFailure({ error = null, status = null, signal = null, stderr = '', result = null, timeoutMs = null }) {
  if (error && error.code !== 'ETIMEDOUT') return `Antigravity CLI could not start: ${error.message}`;
  const detail = [result?.error, String(stderr || '').trim().slice(-300)].filter(Boolean).join(' | ').slice(0, 500);
  if (AGY_USAGE_LIMIT.test(detail)) return `Antigravity CLI usage limit: ${detail}`;
  // The model's answer outgrew the output limit (seen on a development NDA at high effort, 16 Oct): an unusable answer,
  // malformed like a provider's finish reason "length", so it is retried at once and counts as an attempt.
  if (AGY_TRUNCATED.test(detail)) return `Antigravity CLI answer cut off at the output token limit: ${detail}`;
  if (error?.code === 'ETIMEDOUT' || /print timeout|deadline exceeded|timed out/i.test(detail)) return `Antigravity CLI failed (timed out${timeoutMs ? ` after ${Math.round(timeoutMs / 1000)} s` : ''}): ${detail}`;
  if (status !== 0 || signal || !result || result.status !== 'SUCCESS') return `Antigravity CLI failed (exit ${status}${signal ? `, ${signal}` : ''}${result?.status ? `, status ${result.status}` : ''}): ${detail}`;
  return null;
}
function agyCall({ config, system, user, timeoutMs, cwd }) {
  const bin = process.env.AGY_BIN || 'agy';
  const input = JSON.stringify({ event: 'user', message: { content: agyMessage(system, user) } }) + '\n';
  const r = spawnSync(...viaNode(bin, agyArgs({ model: config.model, timeoutMs })), { input, env: cleanEnv(), encoding: 'utf8', cwd, maxBuffer: 1 << 28, timeout: timeoutMs, killSignal: 'SIGKILL' });
  const s = parseAgyStream(r.stdout);
  const failure = agyFailure({ error: r.error, status: r.status, signal: r.signal, stderr: r.stderr, result: s.result, timeoutMs });
  const extra = { servedModel: s.init?.model || null, usage: s.result?.usage || null, durationMs: s.result?.duration_seconds != null ? Math.round(s.result.duration_seconds * 1000) : null, numTurns: s.result?.num_turns ?? null,
    conversationId: s.result?.conversation_id || s.init?.conversation_id || null, permissionMode: s.init?.permission_mode || null, toolSteps: s.toolSteps.length, toolNames: [...new Set(s.toolSteps.map(t => t.name))], deniedActions: s.result?.denied_actions || [], systemPromptInUserTurn: true, events: s.events };
  if (failure) throw Object.assign(new Error(failure), { extra });
  return { raw: s.result.response ?? '', extra };
}

// `lenient` (Ask): a reply that is not JSON comes back as { data: null, raw } instead of throwing, so the caller can ask
// again or show the prose. `signal` (Ask's and the review's Stop): aborting it kills a Claude CLI child or cancels an API
// call, and the call throws { code: 'stopped' }. The codex, muse and agy CLIs (evaluation only) still run blocking.
const stopped = () => Object.assign(new Error('Stopped.'), { code: 'stopped' });
/** A wait that ends early, with `stopped`, when the signal aborts (a provider's Retry-After). */
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(stopped()); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(stopped()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});
export async function runModel({ system, payload, name = 'model-call', config = getExecutorConfig(), timeoutMs = 1_800_000, replayIds = null, tools = null, signal = null, lenient = false }) {
  const user = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const started = Date.now();
  const base = { executor: config.executor, model: config.model, effort: config.effort, promptSha256: sha256(system), userSha256: sha256(user), userChars: user.length };
  let raw, extra = {}, toolCalls = null;
  const agentic = Boolean(tools) && toolsSupported(config);
  try {
  if (config.executor === 'replay') {
    if (!config.replayDir) throw Object.assign(new Error('REVIEW_REPLAY_DIR is not set.'), { status: 500 });
    const file = pickRecording(config.replayDir, name, payload);
    raw = readFileSync(file, 'utf8'); extra = { replayedFrom: file };
    const idsFile = path.join(config.replayDir, 'ids.json');
    if (replayIds && existsSync(idsFile)) { const recorded = JSON.parse(readFileSync(idsFile, 'utf8')); let mapped = 0; for (const [oldId, filename] of Object.entries(recorded)) { const live = replayIds[filename]; if (live && live !== oldId && raw.includes(oldId)) { raw = raw.split(oldId).join(live); mapped++; } } extra.replayIdsMapped = mapped; }
    if (agentic) {
      // The recording's tool calls are played back in order through the same router replay offers any caller.
      const recorded = readRecordedTools(file.replace(/\.raw\.txt$/, '.tools.jsonl')); const router = recordedToolRouter(recorded);
      toolCalls = []; for (const t of recorded) { notifyTool(tools, { phase: 'start', name: t.name, args: t.args }); const result = await router.call(t.name, t.args); notifyTool(tools, { phase: 'done', name: t.name, args: t.args, result }); toolCalls.push({ name: t.name, args: t.args, bytes: bytesOf(result), result }); }
    }
  } else if (agentic && config.executor === 'claude') {
    ({ raw, extra, toolCalls } = await claudeWithTools({ config, system, user, tools, timeoutMs, signal }));
  } else if (agentic && config.executor === 'anthropic') {
    ({ raw, extra, toolCalls } = await anthropicWithTools({ config, system, user, tools, timeoutMs, signal }));
  } else if (agentic && config.executor === 'openai') {
    ({ raw, extra, toolCalls } = await openaiWithTools({ config, system, user, tools, timeoutMs, signal }));
  } else if (config.executor === 'claude') {
    ({ raw, extra } = await claudeSingle({ config, system, user, timeoutMs, signal }));
  } else if (config.executor === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Live review needs ANTHROPIC_API_KEY on the server. No offline result was substituted.');
    const url = (process.env.ANTHROPIC_BASE_URL ? process.env.ANTHROPIC_BASE_URL.replace(/\/$/, '') + '/v1/messages' : ANTHROPIC_URL);
    const response = await fetch(url, { method: 'POST', signal: callSignal(timeoutMs, signal), headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] }) });
    if (!response.ok) throw new Error(`Anthropic API returned HTTP ${response.status}. No offline result was substituted.`);
    const body = await response.json();
    raw = (body?.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); extra = { usage: body?.usage || null, stopReason: body?.stop_reason || null };
    if (typeof raw !== 'string' || !raw || raw.length > 400_000) throw new Error('Anthropic API did not return bounded valid JSON.');
  } else if (config.executor === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key || !config.model) throw new Error('Live review needs OPENAI_API_KEY and a model on the server. No offline result was substituted.');
    const url = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
    // A busy or rate-limited provider (429, 503) is waited out when it sends Retry-After, up to six times.
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(url, { method: 'POST', signal: callSignal(Math.min(timeoutMs, 600_000), signal), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.model, max_completion_tokens: Number(process.env.REVIEW_MAX_OUTPUT_TOKENS || 16000), messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true } }) });
      if (![429, 503].includes(response.status) || attempt >= 5 || !response.headers?.get?.('retry-after')) break;
      const wait = Math.min(300, Number(response.headers?.get?.('retry-after')) || 30);
      await pause(wait * 1000, signal);
    }
    if (!response.ok) throw new Error(`Live provider returned HTTP ${response.status}. No offline result was substituted.`);
    // Streamed, so a long reasoning answer does not hit fetch's five-minute wait for response headers; a provider that
    // ignores `stream` and answers with one JSON body is read as before.
    let choice, usage = null, served = null;
    if (String(response.headers?.get?.('content-type') || '').includes('event-stream')) {
      let text = '', finish = null, buffer = ''; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          const data = line.startsWith('data:') ? line.slice(5).trim() : ''; if (!data || data === '[DONE]') continue;
          let event; try { event = JSON.parse(data); } catch { continue; }
          if (event.model) served = event.model;
          const c = event.choices?.[0]; if (c?.delta?.content) text += c.delta.content; if (c?.finish_reason) finish = c.finish_reason; if (event.usage) usage = event.usage;
        }
      }
      choice = { message: { content: text || null }, finish_reason: finish };
    } else { const body = await response.json(); choice = body?.choices?.[0]; usage = body?.usage || null; served = body?.model || null; }
    raw = choice?.message?.content; extra = { usage, stopReason: choice?.finish_reason || null, servedModel: served };
    if (typeof raw !== 'string' || raw.length > 400_000) throw new Error(`Live provider did not return bounded valid JSON (finish reason: ${choice?.finish_reason || 'none'}).`);
  } else {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'review-cli-'));
    try {
      if (config.executor === 'muse') {
        // Muse has no separate system prompt: the prompt file carries the instructions, then the payload. Tools, web,
        // reminders, shell and writes are all off, so the model has only the material in the prompt. The final answer is
        // the `run.terminal.completed` event's text; any other terminal state is an error with its reason.
        const bin = process.env.MUSE_BIN || 'muse'; const promptFile = path.join(dir, 'prompt.txt');
        writeFileSync(promptFile, system + '\n\nDo not use tools, browse, read files or run commands; all necessary material is below. Return only the JSON object.\n\n' + user);
        const args = ['exec', '--json', '--prompt-file', promptFile, '--model', config.model, '--reasoning-effort', config.effort, '--disable-web-tools', '--disable-reminders', '--no-session-log', '--no-foreign-personal-context', '--approval-mode', 'never', '--disable-shell', '--disable-write'];
        const r = spawnSync(bin, args, { env: cleanEnv(), encoding: 'utf8', cwd: dir, maxBuffer: 1 << 28, timeout: timeoutMs });
        if (r.error) throw new Error(`Muse CLI could not start: ${r.error.message}`);
        const events = String(r.stdout).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const terminal = events.find(e => String(e.payload_type || '').startsWith('run.terminal.'));
        if (r.status !== 0 || !terminal || terminal.payload?.terminal !== 'completed') throw new Error(`Muse CLI ${terminal ? terminal.payload?.terminal + (terminal.payload?.reason ? ': ' + String(terminal.payload.reason).slice(0, 300) : '') : `failed (exit ${r.status})`}: ${String(r.stderr || '').slice(-300)}`);
        raw = terminal.payload.text;
        const attempts = events.filter(e => e.payload?.event?.details?.phase === 'opening_stream').length;
        extra = { museModel: events.find(e => e.payload_type === 'run.model.configured')?.payload?.model_id || null, streamAttempts: attempts, events: events.length };
      } else if (config.executor === 'agy') {
        try { ({ raw, extra } = agyCall({ config, system, user, timeoutMs, cwd: dir })); } catch (e) { extra = e.extra || {}; throw e; }
      } else {
        const bin = process.env.CODEX_BIN || 'codex'; const instr = path.join(dir, 'instructions.txt'); const out = path.join(dir, 'out.txt');
        writeFileSync(instr, system + '\n\nDo not use tools, browse, read files or run commands; all necessary material is in the user message. Return only the JSON object.');
        const args = ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', dir, '-m', config.model, '-c', `model_reasoning_effort="${config.effort}"`, '-c', 'model_instructions_file=' + JSON.stringify(instr), '--json', '-o', out, '-'];
        const r = spawnSync(bin, args, { input: user, env: cleanEnv(), encoding: 'utf8', maxBuffer: 1 << 28, timeout: timeoutMs });
        if (r.error) throw new Error(`Codex CLI could not start: ${r.error.message}`);
        if (r.status !== 0) throw new Error(`Codex CLI failed (exit ${r.status}): ${String(r.stderr || '').slice(-400)}`);
        raw = readFileSync(out, 'utf8');
        const events = String(r.stdout).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        extra = { usage: events.filter(e => e.type === 'turn.completed').map(e => e.usage), toolEvents: events.filter(e => ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(e.item?.type)).length };
      }
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  if (signal?.aborted) throw stopped(); // a call that finished as Stop came is not used
  } catch (e) {
    // Stop: whatever the call threw on the way out (a killed child, an aborted fetch) is reported as stopped.
    const err = signal?.aborted && e?.code !== 'stopped' ? stopped() : e;
    // A failed call still leaves a trace (benchmark spec 14.4, P22): what was sent, the error, and any partial answer.
    try { trace(config.traceDir, name, { ...base, ...extra, error: String(err?.message || err), seconds: (Date.now() - started) / 1000 }, system, user, typeof raw === 'string' ? raw : ''); } catch { /* tracing never hides the error */ }
    throw err;
  }
  const meta = { ...base, ...extra, ...(agentic ? { agentic: true, toolCalls: toolCalls.length } : {}), seconds: (Date.now() - started) / 1000 };
  trace(config.traceDir, name, meta, system, user, raw, agentic ? toolCalls : null);
  if (lenient) { let data = null; try { data = parseJsonObject(raw); } catch { /* the caller decides */ } return { data, raw: typeof raw === 'string' ? raw : '', meta, ...(agentic ? { toolCalls } : {}) }; }
  return { data: parseJsonObject(raw), meta, ...(agentic ? { toolCalls } : {}) };
}
