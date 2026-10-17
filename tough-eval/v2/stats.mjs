// SPDX-License-Identifier: GPL-3.0-or-later
// The statistics of BENCHMARK-V2.md section 3.5 and 15, in one place so profile.mjs, by-author.mjs, score-h.mjs and
// compare.mjs agree to the last digit:
//   Clopper–Pearson intervals from the inverse regularised incomplete beta function (no library);
//   the one-sided 95% upper bound on a miss rate and its sentence ("misses fewer than 1 in N with 95% confidence");
//   the seeded bootstrap (seed 20261010, 4,000 resamples, the same generator compare.mjs has always used), over
//   independent items or over clusters (documents), with percentiles taken as compare.mjs takes them.
export const SEED = 20261010;
export const RESAMPLES = 4000;

// ---- Beta distribution ---------------------------------------------------------------------------------------------
function lgamma(z) { // Lanczos, g = 7
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betacf(a, b, x) { // continued fraction (Numerical Recipes 6.4)
  const MAXIT = 300, EPS = 1e-15, FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
/** Regularised incomplete beta I_x(a, b). */
export function betaCdf(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
/** BetaInv(p; a, b): the x with I_x(a, b) = p, by bisection to 1e-12. */
export function betaInv(p, a, b) {
  if (p <= 0) return 0; if (p >= 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-13; i++) { const mid = (lo + hi) / 2; if (betaCdf(mid, a, b) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// ---- Clopper–Pearson -----------------------------------------------------------------------------------------------
/** Two-sided 95% Clopper–Pearson interval for x of n (section 3.5). */
export function clopperPearson(x, n, level = 0.95) {
  if (!n) return [null, null];
  const a = (1 - level) / 2;
  return [x === 0 ? 0 : betaInv(a, x, n - x + 1), x === n ? 1 : betaInv(1 - a, x + 1, n - x)];
}
/** One-sided 95% upper limit: U = BetaInv(0.95; x + 1, n − x) (section 3.1). */
export function upperBound(x, n, level = 0.95) {
  if (!n) return null; if (x >= n) return 1;
  return betaInv(level, x + 1, n - x);
}
/** The bound in words, as the card states it. */
export function boundWords(U) {
  if (U === null || U === undefined) return 'no items';
  const inN = Math.floor(1 / U);
  if (U >= 0.5 || inN < 2) return `misses could be as many as ${(100 * U).toFixed(0)}% with 95% confidence`;
  return `misses fewer than 1 in ${inN} with 95% confidence`;
}
const r4 = v => v === null || v === undefined || Number.isNaN(v) ? null : +v.toFixed(4);
/** A proportion over independent items: rate, x, n and the two-sided interval. */
export function proportion(x, n) { const [lo, hi] = clopperPearson(x, n); return { rate: n ? r4(x / n) : null, x, n, ci95: [r4(lo), r4(hi)], interval: 'clopper-pearson' }; }
/** A miss rate over independent items: as proportion() plus the one-sided upper bound and its words. */
export function missRate(x, n) { const U = upperBound(x, n); return { ...proportion(x, n), upper95: r4(U), upperMethod: 'clopper-pearson one-sided', words: boundWords(U) }; }

// ---- Bootstrap -----------------------------------------------------------------------------------------------------
/** The generator compare.mjs uses (LCG, seed 20261010). */
export function rng(seed = SEED) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
export const pct = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
/**
 * Bootstrap over units (items, or clusters such as documents): `units` is an array, `stat(sample)` a number or null.
 * Returns { point, lo, hi, p95, samples } with lo/hi the 2.5th and 97.5th percentiles and p95 the 95th.
 */
export function bootstrap(units, stat, { resamples = RESAMPLES, seed = SEED } = {}) {
  const point = units.length ? stat(units) : null; if (!units.length) return { point: null, lo: null, hi: null, p95: null };
  const rand = rng(seed); const xs = [];
  for (let i = 0; i < resamples; i++) { const s = units.map(() => units[Math.floor(rand() * units.length)]); const v = stat(s); if (v !== null && !Number.isNaN(v)) xs.push(v); }
  xs.sort((a, b) => a - b);
  return { point: r4(point), lo: r4(pct(xs, 0.025)), hi: r4(pct(xs, 0.975)), p95: r4(pct(xs, 0.95)) };
}
/**
 * A clustered ratio Σx/Σn (e.g. departures missed over departures, per NDA) with the cluster bootstrap of section 3.5;
 * for a miss rate the upper bound is the bootstrap's 95th percentile, falling back to the one-sided Clopper–Pearson
 * limit on the item count when nothing was observed (the percentile is then zero).
 */
export function clusteredRate(clusters, { miss = false } = {}) {
  const live = clusters.filter(c => c.n > 0);
  const X = live.reduce((a, c) => a + c.x, 0), N = live.reduce((a, c) => a + c.n, 0);
  const b = bootstrap(live, s => { const n = s.reduce((a, c) => a + c.n, 0); return n ? s.reduce((a, c) => a + c.x, 0) / n : null; });
  const out = { rate: N ? r4(X / N) : null, x: X, n: N, clusters: live.length, ci95: [b.lo, b.hi], interval: 'cluster bootstrap (4,000, seed 20261010)' };
  if (!miss) return out;
  const fallback = X === 0;
  const U = fallback ? upperBound(0, N) : b.p95;
  return { ...out, upper95: r4(U), upperMethod: fallback ? 'clopper-pearson one-sided (fallback: no misses observed)' : 'cluster bootstrap 95th percentile', words: boundWords(U) };
}
/** A mean over independent units (e.g. false alarms per agreement) with a bootstrap interval over those units. */
export function meanWithInterval(values) {
  const b = bootstrap(values, s => s.reduce((a, v) => a + v, 0) / s.length);
  return { mean: b.point, n: values.length, ci95: [b.lo, b.hi], interval: 'bootstrap over units (4,000, seed 20261010)' };
}
export const median = xs => { const s = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
