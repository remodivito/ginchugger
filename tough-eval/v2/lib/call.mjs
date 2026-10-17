// SPDX-License-Identifier: GPL-3.0-or-later
// One recorded model call for the authoring pipeline (author, verify, playbook read). Every call returns the raw answer
// verbatim plus metadata (11.1: prompt hash, model id as sent and as served, date, executor), whatever the answer holds;
// parsing is the caller's job, so an unparseable answer is still recorded.
//   claude  Opus 5.5 through the product's executor (contract-review/server/executors.js, `claude -p`, effort medium).
//           runModel parses a JSON object and these answers are arrays, so the raw text is read back from its trace.
//   openai  Munito's OpenAI-compatible endpoint, streamed (long reasoning answers outlive fetch's header wait). Same
//           request as executors.js except no `response_format: json_object` (it forbids the array the spec asks for)
//           and the reasoning channel (`reasoning_content` / `reasoning`) is kept beside the answer, so a call that spends
//           its whole budget reasoning is visible as such.
//   replay  a recorded raw answer from a file: tests, and re-processing a stored batch without a call.
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256, ROOT } from './common.mjs';

export const MUNITO_BASE = 'https://api.eu.munito.ai/inference/v1';
export const MODELS = {
  opus: { executor: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
  glm: { executor: 'openai', model: 'zai-org/glm-5.3-flash', baseUrl: MUNITO_BASE, keyEnv: 'MUNITO_API_KEY' },
  deepseek: { executor: 'openai', model: 'deepseek-ai/deepseek-v4-flash', baseUrl: MUNITO_BASE, keyEnv: 'MUNITO_API_KEY' },
};
export const MAX_OUTPUT_TOKENS = 64000;

/** A key from the environment, else from contract-review/.env (read only; never written or logged). */
export function apiKey(name) {
  if (process.env[name]) return process.env[name];
  const env = path.join(ROOT, 'contract-review/.env'); if (!existsSync(env)) return null;
  const line = readFileSync(env, 'utf8').split('\n').find(l => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : null;
}

/** Read an OpenAI-compatible SSE stream: answer text, reasoning text, finish reason, usage, served model. */
export async function readStream(body) {
  let text = '', reasoning = '', finish = null, usage = null, served = null, buffer = ''; const decoder = new TextDecoder();
  const take = line => {
    const data = line.startsWith('data:') ? line.slice(5).trim() : ''; if (!data || data === '[DONE]') return;
    let e; try { e = JSON.parse(data); } catch { return; }
    if (e.model) served = e.model; if (e.usage) usage = e.usage;
    const c = e.choices?.[0]; if (!c) return;
    if (typeof c.delta?.content === 'string') text += c.delta.content;
    const r = c.delta?.reasoning_content ?? c.delta?.reasoning; if (typeof r === 'string') reasoning += r;
    if (c.finish_reason) finish = c.finish_reason;
  };
  for await (const chunk of body) { buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(take); }
  if (buffer) take(buffer);
  return { text, reasoning, finish, usage, served };
}

async function callOpenAI({ spec, system, user, maxTokens, timeoutMs, fetchImpl = fetch }) {
  const key = apiKey(spec.keyEnv); if (!key) throw Error(`${spec.keyEnv} is not set (environment or contract-review/.env)`);
  const url = spec.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const request = { model: spec.model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: true, stream_options: { include_usage: true } };
  let response, waits = 0;
  for (let attempt = 0; ; attempt++) {
    response = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(request) });
    if (![429, 503].includes(response.status) || attempt >= 5) break;
    const wait = Math.min(300, Number(response.headers?.get?.('retry-after')) || 30); waits++; await new Promise(r => setTimeout(r, wait * 1000));
  }
  if (!response.ok) { const body = await response.text().catch(() => ''); throw Error(`HTTP ${response.status} from ${spec.baseUrl}: ${body.slice(0, 300)}`); }
  let out;
  if (String(response.headers?.get?.('content-type') || '').includes('event-stream')) out = await readStream(response.body);
  else { const b = await response.json(); const c = b?.choices?.[0]; out = { text: c?.message?.content ?? '', reasoning: c?.message?.reasoning_content ?? c?.message?.reasoning ?? '', finish: c?.finish_reason ?? null, usage: b?.usage ?? null, served: b?.model ?? null }; }
  return { raw: out.text, reasoning: out.reasoning, meta: { finishReason: out.finish, usage: out.usage, servedModel: out.served, innerRetries: waits, maxOutputTokens: maxTokens, streamed: true } };
}

async function callClaude({ spec, system, user, timeoutMs, name }) {
  const { runModel } = await import('../../../contract-review/server/executors.js');
  const traceDir = mkdtempSync(path.join(os.tmpdir(), 'v2-author-'));
  try {
    let meta = null, error = null;
    try { ({ meta } = await runModel({ system, payload: user, name, config: { executor: 'claude', model: spec.model, effort: spec.effort, traceDir }, timeoutMs })); }
    catch (e) { error = e; }
    const rawFile = path.join(traceDir, `${name}.raw.txt`), metaFile = path.join(traceDir, `${name}.meta.json`);
    if (!existsSync(rawFile)) throw error || Error('the Claude CLI returned no answer');
    // A CLI failure (usage limit, transport) leaves an empty trace: rethrow it, so the caller retries later instead of
    // spending one of the batch's attempts on an answer that never came (preliminary run, 16 October 2026).
    const rawText = readFileSync(rawFile, 'utf8'); if (error && !rawText.trim()) throw error;
    meta = meta || JSON.parse(readFileSync(metaFile, 'utf8'));
    return { raw: rawText, reasoning: '', meta: { finishReason: meta.stopReason ?? null, usage: meta.usage ?? null, servedModel: meta.servedModel ?? null, auxiliaryModels: meta.auxiliaryModels ?? [], costUsd: meta.costUsd ?? null, effort: spec.effort } };
  } finally { rmSync(traceDir, { recursive: true, force: true }); }
}

/**
 * One call. `who` is an author/family key (opus, glm, deepseek) or `replay:<file>`. Returns { raw, reasoning, meta }.
 * meta: executor, model as sent, servedModel, date, promptSha256 (system), userSha256, seconds, finishReason, usage.
 */
export async function callModel({ who, system, user, name = 'call', maxTokens = MAX_OUTPUT_TOKENS, timeoutMs = 3_600_000, fetchImpl }) {
  const started = Date.now(), date = new Date().toISOString();
  const base = { promptSha256: sha256(system), userSha256: sha256(user), userChars: user.length, date };
  if (who.startsWith('replay:')) {
    const file = who.slice(7); const rec = readFileSync(file, 'utf8');
    let raw = rec, reasoning = '', meta = {};
    try { const j = JSON.parse(rec); if (j && typeof j.raw === 'string') { raw = j.raw; reasoning = j.reasoning || ''; meta = j.meta || {}; } } catch { /* a plain text recording */ }
    return { raw, reasoning, meta: { ...base, executor: 'replay', replayedFrom: file, model: meta.model ?? null, servedModel: meta.servedModel ?? null, finishReason: meta.finishReason ?? null, seconds: 0 } };
  }
  const spec = MODELS[who]; if (!spec) throw Error(`unknown model key ${who}; known: ${Object.keys(MODELS).join(', ')}, replay:<file>`);
  const r = spec.executor === 'claude' ? await callClaude({ spec, system, user, timeoutMs, name }) : await callOpenAI({ spec, system, user, maxTokens, timeoutMs, fetchImpl });
  return { raw: r.raw, reasoning: r.reasoning, meta: { ...base, executor: spec.executor, model: spec.model, ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}), ...r.meta, seconds: (Date.now() - started) / 1000, rawChars: r.raw.length, reasoningChars: r.reasoning.length } };
}
