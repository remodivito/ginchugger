// SPDX-License-Identifier: GPL-3.0-or-later
// Port of Paperless-ngx correspondent matching, checked against reference outputs of the real Python (product v2 spec
// section 10.A). The golden cases come from scripts/paperless-matching-oracle.py run over the pinned Paperless commit;
// the held-out quarter (matching-hidden.json) is run by scripts/paperless-matching-heldout.mjs, not here. Cases listed
// in tests/fixtures/paperless/matching-known-diffs.json are reported as todo with their reason, not hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matches, _splitMatch, setLogger, PY_SPACE } from '../server/ports/paperless/matching.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/paperless/matching-golden.json', import.meta.url), 'utf8'));
const knownDiffs = JSON.parse(readFileSync(new URL('./fixtures/paperless/matching-known-diffs.json', import.meta.url), 'utf8')).diffs;
const known = new Map(knownDiffs.map(d => [d.id, d.reason]));
setLogger(() => {});

/** A split term as plain text: `\s+` (Python) or the ported whitespace class (JS) becomes one marker; escapes drop. */
function termText(source) {
  const ported = `[${PY_SPACE}]+`;
  let out = ''; let i = 0;
  while (i < source.length) {
    if (source.startsWith(ported, i)) { out += '\u241f'; i += ported.length; continue; }
    if (source.startsWith('\\s+', i)) { out += '\u241f'; i += 3; continue; }
    if (source[i] === '\\') { out += source[i + 1]; i += 2; continue; }
    out += source[i]; i += 1;
  }
  return out;
}

test('the golden file is pinned to a Paperless commit and holds every algorithm', () => {
  assert.match(golden.commit, /^[0-9a-f]{40}$/);
  const algorithms = new Set(golden.cases.filter(c => c.kind === 'matches').map(c => c.algorithm));
  for (const a of ['none', 'any', 'all', 'literal', 'regex', 'fuzzy']) assert.ok(algorithms.has(a), a);
  assert.ok(golden.cases.some(c => c.kind === 'split'));
});

for (const c of golden.cases) {
  const label = c.kind === 'split' ? `_split_match ${JSON.stringify(c.match)}` : `${c.algorithm}${c.insensitive ? '' : ' (case-sensitive)'} ${JSON.stringify(c.match).slice(0, 60)} on ${JSON.stringify(c.content).slice(0, 60)}`;
  test(`${c.id} ${label}`, { todo: known.get(c.id) }, () => {
    if (c.kind === 'split') {
      const got = _splitMatch({ match: c.match });
      assert.deepEqual(got.map(termText), c.expected.map(termText));
      return;
    }
    assert.equal(matches({ match: c.match, matchingAlgorithm: c.algorithm, isInsensitive: c.insensitive }, c.content), c.expected);
  });
}
