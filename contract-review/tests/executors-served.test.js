// SPDX-License-Identifier: GPL-3.0-or-later
// The OpenAI-compatible executor records the model the provider served, and a failed call still leaves a trace
// (benchmark spec 14.4 and P22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runModel } from '../server/executors.js';

function provider(handler) {
  return new Promise(resolve => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });
}
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`); res.end('data: [DONE]\n\n'); };

test('servedModel comes from the provider stream; a failed call writes a trace with the error', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gcl-served-'));
  let mode = 'ok';
  const s = await provider((req, res) => {
    req.resume(); req.on('end', () => {
      if (mode === 'ok') sse(res, [{ model: 'vendor/served-7b', choices: [{ delta: { content: '{"findings":[],"limits":[]}' } }] }, { model: 'vendor/served-7b', choices: [{ delta: {}, finish_reason: 'stop' }] }]);
      else sse(res, [{ model: 'vendor/served-7b', choices: [{ delta: {}, finish_reason: 'length' }] }]);
    });
  });
  const old = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
  process.env.OPENAI_API_KEY = 'test-key'; process.env.OPENAI_BASE_URL = `http://127.0.0.1:${s.address().port}/v1`;
  try {
    const config = { executor: 'openai', model: 'vendor/requested', effort: 'medium', traceDir: path.join(dir, 'a') };
    const ok = await runModel({ system: 'sys', payload: { x: 1 }, name: 'review', config });
    assert.equal(ok.meta.servedModel, 'vendor/served-7b');
    mode = 'fail';
    const failDir = path.join(dir, 'b');
    await assert.rejects(runModel({ system: 'sys', payload: { x: 2 }, name: 'review', config: { ...config, traceDir: failDir } }), /finish reason: length/);
    assert.ok(existsSync(path.join(failDir, 'review.meta.json')));
    const meta = JSON.parse(readFileSync(path.join(failDir, 'review.meta.json'), 'utf8'));
    assert.match(meta.error, /finish reason: length/); assert.equal(meta.servedModel, 'vendor/served-7b');
    assert.equal(readFileSync(path.join(failDir, 'review.user.json'), 'utf8'), JSON.stringify({ x: 2 }));
  } finally {
    s.close(); process.env.OPENAI_API_KEY = old.key ?? ''; if (old.key === undefined) delete process.env.OPENAI_API_KEY;
    if (old.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = old.base;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('the Claude CLI\'s per-model usage: the model that wrote the output is served; a small background call is auxiliary', async () => {
  const { servedFromModelUsage } = await import('../server/executors.js');
  assert.deepEqual(servedFromModelUsage({ 'claude-haiku-4-5-20251001': { outputTokens: 11 }, 'claude-opus-5-5': { outputTokens: 3561 } }), { servedModel: 'claude-opus-5-5', auxiliaryModels: ['claude-haiku-4-5-20251001'] });
  assert.deepEqual(servedFromModelUsage(null), { servedModel: null, auxiliaryModels: [] });
});
