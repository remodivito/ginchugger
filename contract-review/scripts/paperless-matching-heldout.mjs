// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the held-out quarter of the Paperless matching reference cases (product v2 spec 10.A.7) against the port and
// prints the pass rate and each failing case. Usage: node scripts/paperless-matching-heldout.mjs [fixture.json]
import { readFileSync } from 'node:fs';
import { matches, _splitMatch, setLogger, PY_SPACE } from '../server/ports/paperless/matching.js';

const file = process.argv[2] || new URL('../tests/fixtures/paperless/matching-hidden.json', import.meta.url);
const { cases, commit } = JSON.parse(readFileSync(file, 'utf8'));
setLogger(() => {});
const ported = `[${PY_SPACE}]+`;
const termText = source => { let out = ''; for (let i = 0; i < source.length;) { if (source.startsWith(ported, i)) { out += '␟'; i += ported.length; } else if (source.startsWith('\\s+', i)) { out += '␟'; i += 3; } else if (source[i] === '\\') { out += source[i + 1]; i += 2; } else { out += source[i]; i += 1; } } return out; };
const failures = [];
const byAlgorithm = {};
for (const c of cases) {
  const key = c.kind === 'split' ? 'split' : c.algorithm;
  byAlgorithm[key] ||= { pass: 0, total: 0 };
  byAlgorithm[key].total++;
  let ok; let got;
  if (c.kind === 'split') { got = _splitMatch({ match: c.match }).map(termText); ok = JSON.stringify(got) === JSON.stringify(c.expected.map(termText)); }
  else { got = matches({ match: c.match, matchingAlgorithm: c.algorithm, isInsensitive: c.insensitive }, c.content); ok = got === c.expected; }
  if (ok) byAlgorithm[key].pass++; else failures.push({ id: c.id, kind: c.kind, algorithm: c.algorithm, match: c.match, insensitive: c.insensitive, content: c.content, expected: c.expected, got });
}
const pass = cases.length - failures.length;
console.log(`Held-out cases (Paperless ${commit.slice(0, 12)}): ${pass}/${cases.length} pass (${((100 * pass) / cases.length).toFixed(1)}%)`);
for (const [k, v] of Object.entries(byAlgorithm)) console.log(`  ${k}: ${v.pass}/${v.total}`);
for (const f of failures) console.log(`FAIL ${JSON.stringify(f)}`);
process.exitCode = failures.length ? 1 : 0;
