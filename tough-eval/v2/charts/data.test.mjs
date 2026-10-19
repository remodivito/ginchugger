// The README charts are drawn from data.json; every frozen number in it must match the frozen report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(path.join(HERE, 'data.json'), 'utf8'));
const report = readFileSync(path.join(HERE, '../frozen/REPORT.md'), 'utf8');
const cells = (id, text = report) => text.split('\n').find(l => l.startsWith(`| ${id} |`))?.split('|').map(c => c.trim());
const byAuthor = report.slice(report.indexOf('## By author'));
const section = id => report.slice(report.indexOf(`### ${id} (`)).split('\n### ')[0];

for (const s of data.setups.filter(s => s.frozen)) {
  test(`${s.id} matches the frozen report`, () => {
    const c = cells(s.id);
    assert.ok(c, `no row for ${s.id}`);
    assert.match(c[4], new RegExp(`^${s.misses}/${data.deviations} `));
    assert.match(c[5], new RegExp(`^${s.missUpper}%`));
    assert.equal(c[7], `${s.invented[0]}/${s.invented[1]}`);
    assert.equal(Number(c[8]).toFixed(4), s.falseAlarms.toFixed(4));
    assert.match(c[11], new RegExp(`^${s.allPass[0]}/${s.allPass[1]};`));
    const m = section(s.id).match(/median (\d+) s per review, cost (\S+)/);
    assert.equal(Number(m[1]), s.seconds);
    if (s.cost === 'reported') assert.equal(Number(m[2]).toFixed(3), s.costUsd.toFixed(3));
    else assert.equal(m[2], 'n/a');
  });
}

test('by-author rows match the frozen report', () => {
  for (const r of data.byAuthor.rows) {
    const c = cells(r.id, byAuthor).filter(Boolean);
    const allPass = c.slice(1, 4).map(x => Number(x.split(' / ')[0]));
    assert.deepEqual(allPass, r.allPass, r.id);
    if (r.advantage != null) {
      const sa = c.find(x => x.includes('['));
      assert.ok(sa.startsWith(String(r.advantage)), `${r.id}: ${sa}`);
      assert.ok(sa.includes(`[${r.interval[0]}, ${r.interval[1]}]`), `${r.id}: ${sa}`);
      assert.ok(c.includes(r.verdict), r.id);
    }
  }
});

test('the variant is declared, not frozen, and only open-model costs are estimates', () => {
  assert.deepEqual(data.setups.filter(s => !s.frozen).map(s => s.kind), ['variant']);
  for (const s of data.setups) assert.equal(s.cost, s.provider === 'anthropic' ? 'reported' : 'estimate', s.id);
});
