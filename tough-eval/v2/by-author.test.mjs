// SPDX-License-Identifier: GPL-3.0-or-later
// The difference-in-differences of BENCHMARK-V2.md 5.9 on a hand-computed table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfAdvantage, familyOf } from './by-author.mjs';

const item = (id, author, o, g, d) => ({ id, author, kind: 'deviation', by: { O: { allPass: o }, G: { allPass: g }, D: { allPass: d } } });
test('SA_f is own-minus-others less the other families\' same difference', () => {
  // opus setup O passes its own items (1,1) and half of the others; glm G and deepseek D pass everything except
  // that both fail one opus item, so opus items are a little harder for everyone.
  const items = [item('o1', 'opus', 1, 1, 0), item('o2', 'opus', 1, 0, 1), item('g1', 'glm', 1, 1, 1), item('g2', 'glm', 0, 1, 1), item('d1', 'deepseek', 1, 1, 1), item('d2', 'deepseek', 0, 1, 1)];
  const rep = { opus: 'O', glm: 'G', deepseek: 'D' };
  // O: own 1, others 0.5 -> 0.5. G: opus items 0.5, items by neither opus nor glm (deepseek) 1 -> -0.5. D: opus 0.5, glm items 1 -> -0.5.
  // SA = 0.5 - mean(-0.5, -0.5) = 1.0
  assert.equal(selfAdvantage(items, 'opus', rep), 1);
  // A family whose own items are not easier for it shows none: G on glm items 1, others 0.75 -> 0.25; O on glm items 0.5 vs deepseek 0.5 -> 0; D on glm 1 vs opus 0.5 -> 0.5; SA = 0.25 - 0.25 = 0
  assert.equal(selfAdvantage(items, 'glm', rep), 0);
});
test('family of a model id', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'opus'); assert.equal(familyOf('claude-sonnet-5-5'), 'opus');
  assert.equal(familyOf('z-ai/glm-5.3-flash'), 'glm'); assert.equal(familyOf('deepseek-v4-flash'), 'deepseek'); assert.equal(familyOf('qwen-3.8-27b'), null);
});
