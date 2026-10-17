// SPDX-License-Identifier: GPL-3.0-or-later
// The frozen per-setup choices (BENCHMARK-V2.md 11.7, 13): which promptPerSetup and toolsSupported entry binds a run,
// and what refuses a --test run. The tag and hash mechanics need a git tag and are checked in a scratch clone (pre-flight).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frozenChoice, frozenChoiceProblems } from './check-frozen.mjs';

const data = { promptPerSetup: { 'glm-5.3-flash': 'plain', 'deepseek-v4-flash': 'product', 'qwen-3.8-27b': 'product', 'mistral-small-4': 'plain' },
  toolsSupported: { 'glm-5.3-flash': true, 'deepseek-v4-flash': false } };

test('keys match the model ids as sent, whatever their punctuation', () => {
  assert.deepEqual(frozenChoice(data.promptPerSetup, { model: 'qwen/qwen3.8-27b' }), ['qwen-3.8-27b', 'product']);
  assert.deepEqual(frozenChoice(data.promptPerSetup, { model: 'zai-org/glm-5.3-flash' }), ['glm-5.3-flash', 'plain']);
  assert.deepEqual(frozenChoice(data.promptPerSetup, { model: 'mistralai/mistral-small-4-119b-2603' }), ['mistral-small-4', 'plain']);
  assert.deepEqual(frozenChoice(data.promptPerSetup, { setup: 'deepseek-v4-flash-product', model: 'x' }), ['deepseek-v4-flash', 'product']);
  assert.equal(frozenChoice(data.promptPerSetup, { model: 'claude-opus-5-5' }), null);
});

test('a test run is refused off its frozen prompt, without an entry on a non-Claude executor, or agentic without tools', () => {
  const p = o => frozenChoiceProblems(data, o);
  assert.deepEqual(p({ model: 'qwen/qwen3.8-27b', executor: 'openai' }), []);
  assert.match(p({ model: 'qwen/qwen3.8-27b', executor: 'openai', reviewPrompt: 'tough-eval/arms/plain.md' })[0], /fixes the product prompt for qwen-3.8-27b/);
  assert.match(p({ model: 'zai-org/glm-5.3-flash', executor: 'openai' })[0], /fixes the plain prompt/);
  assert.match(p({ model: 'muse-wonder-1.0', executor: 'muse' })[0], /fixes no prompt/);
  assert.deepEqual(p({ model: 'claude-opus-5-5', executor: 'claude', agentic: true }), []);
  assert.match(p({ model: 'deepseek-ai/deepseek-v4-flash', executor: 'openai', agentic: true })[0], /no tool support for deepseek-v4-flash/);
  assert.match(p({ model: 'qwen/qwen3.8-27b', executor: 'openai', agentic: true })[0], /no tool smoke result/);
  assert.deepEqual(p({ model: 'zai-org/glm-5.3-flash', executor: 'openai', reviewPrompt: 'arms/plain.md', agentic: true }), []);
  assert.deepEqual(frozenChoiceProblems({ promptPerSetup: {} }, { model: 'qwen/qwen3.8-27b', executor: 'openai' }), [], 'nothing fixed yet: nothing to bind');
});

test('the layer A freeze lists what a layer A result depends on, and binds only layer A suites (17 October 2026)', async () => {
  const { FROZEN_FILES_A, FILES_BY_LAYERS, layerOfSuite, writeFrozen, checkFrozen } = await import('./check-frozen.mjs');
  for (const f of ['contract-review/prompts/review.md', 'tough-eval/arms/plain.md', 'tough-eval/score.mjs', 'tough-eval/v2/items.json', 'tough-eval/v2/markups.json', 'tough-eval/v2/variants/*', 'tough-eval/v2/inserted-checks.json', 'tough-eval/playbook-vendor.json', 'tough-eval/v2/base-csa.json', 'contract-review/server/executors.js', 'tough-eval/v2/frozen/lane-frozen-a.zsh'])
    assert.ok(FROZEN_FILES_A.includes(f), f);
  assert.ok(!FROZEN_FILES_A.some(f => /scenarios|layer-c|score-h|contractnli/.test(f)), 'layer A freeze lists other layers');
  assert.equal(FILES_BY_LAYERS.A, FROZEN_FILES_A);
  assert.deepEqual(['v2a', 'v2a-fixture', 'v2h', 'contractnli', 'v2c', 'tough'].map(layerOfSuite), ['A', 'A', 'H', 'B', 'C', null]);
  const { mkdtempSync } = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'frozen-a-')), 'frozen.json');
  const { data, missing } = await writeFrozen({ frozenPath: f, tag: 'bench-v2.0-a', layer: 'A', draft: true, promptPerSetup: { 'deepseek-v4-flash': 'product' } });
  assert.deepEqual(data.layers, ['A']); assert.equal(data.layerBTest, undefined); assert.equal(Object.keys(data.files).length, FROZEN_FILES_A.length);
  assert.deepEqual(data.promptPerSetup, { 'deepseek-v4-flash': 'product' });
  const r = checkFrozen({ frozenPath: f }); assert.deepEqual(r.problems, [], 'a freshly written frozen.json checks clean against the working tree'); assert.equal(r.notYetFrozen.length, missing.length);
});
