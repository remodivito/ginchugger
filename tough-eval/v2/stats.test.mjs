// SPDX-License-Identifier: GPL-3.0-or-later
// The worked values in BENCHMARK-V2.md section 3.1 and textbook Clopper–Pearson values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upperBound, boundWords, clopperPearson, betaCdf, missRate, clusteredRate, bootstrap } from './stats.mjs';

const near = (a, b, tol = 5e-4) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
test('section 3.1 worked values', () => {
  near(upperBound(0, 96), 1 - 0.05 ** (1 / 96)); near(upperBound(0, 96), 0.0307);
  assert.equal(boundWords(upperBound(0, 96)), 'misses fewer than 1 in 32 with 95% confidence');
  near(upperBound(1, 96), 0.049, 1e-3); assert.equal(boundWords(upperBound(1, 96)), 'misses fewer than 1 in 20 with 95% confidence');
  near(upperBound(0, 48), 0.061, 1e-3); assert.equal(boundWords(upperBound(0, 48)), 'misses fewer than 1 in 16 with 95% confidence');
  assert.equal(boundWords(0.064), 'misses fewer than 1 in 15 with 95% confidence');
});
test('two-sided Clopper–Pearson', () => {
  const [lo, hi] = clopperPearson(5, 20); near(lo, 0.0866); near(hi, 0.4910);
  assert.deepEqual(clopperPearson(0, 10).map(x => +x.toFixed(4)), [0, 0.3085]);
  assert.equal(clopperPearson(10, 10)[1], 1);
  near(betaCdf(0.5, 2, 2), 0.5, 1e-9);
});
test('miss rate object and bound words at high rates', () => {
  const m = missRate(2, 4); assert.equal(m.rate, 0.5); assert.match(m.words, /as many as/);
  assert.equal(missRate(0, 0).upper95, null);
});
test('cluster bootstrap falls back to Clopper–Pearson when nothing is missed', () => {
  const c = clusteredRate([{ x: 0, n: 3 }, { x: 0, n: 2 }], { miss: true });
  assert.equal(c.rate, 0); assert.match(c.upperMethod, /fallback/); near(c.upper95, upperBound(0, 5));
  const d = clusteredRate([{ x: 1, n: 3 }, { x: 0, n: 2 }, { x: 2, n: 4 }], { miss: true });
  assert.match(d.upperMethod, /95th percentile/); assert.ok(d.upper95 >= d.rate);
});
test('bootstrap is deterministic', () => {
  const a = bootstrap([1, 2, 3, 4], s => s.reduce((x, y) => x + y, 0) / s.length), b = bootstrap([1, 2, 3, 4], s => s.reduce((x, y) => x + y, 0) / s.length);
  assert.deepEqual(a, b);
});
