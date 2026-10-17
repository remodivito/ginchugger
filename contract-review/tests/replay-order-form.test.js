// SPDX-License-Identifier: GPL-3.0-or-later
// The order-form round on recorded runs (Phase 7, P7): it plays its own recording and never the NDA's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayDemo } from './fixtures/record/demo-replay.js';

const REC = fileURLToPath(new URL('../data/recorded-runs/demo-fixture/', import.meta.url));
const FIX = fileURLToPath(new URL('../data/fixtures/order-form/', import.meta.url)); const read = f => readFileSync(path.join(FIX, f));
const recorded = existsSync(path.join(REC, 'review@orderform.raw.txt'));
const orderForm = JSON.parse(readFileSync(new URL('../data/playbooks/order-form.json', import.meta.url), 'utf8'));
const MARKUP = 'helix-northgate-order-form-v2-customer-markup.docx';

test('playback never answers the order form with an NDA recording', async () => {
  const { pickRecording } = await import('../server/executors.js'); const { importDocx } = await import('../server/docx.js');
  const document = await importDocx(read(MARKUP), MARKUP);
  if (recorded) {
    assert.ok(pickRecording(REC, 'review', { document }).endsWith('review@orderform.raw.txt'));
    const v3 = await importDocx(readFileSync(new URL('../data/fixtures/history/helix-brightwater-nda-v3-helix-counter.docx', import.meta.url)), 'v3.docx');
    assert.ok(pickRecording(REC, 'review', { document: v3 }).endsWith(`${path.sep}review.raw.txt`), 'the NDA counter-turn still plays its own');
  } else assert.throws(() => pickRecording(REC, 'review', { document }), e => e.code === 'NO_RECORDING');
});

test('the order-form round replays from the record: the markup against the form we sent, the order-form playbook', { skip: !recorded && 'no order-form recording present' }, async () => {
  const { demo, history, review: r } = await replayDemo('order-form', { playbookFile: 'playbooks/order-form.json' });
  assert.deepEqual(history.map(h => h.itemId.replace(demo.matterId, 'm')), ['m/2/covering']);
  assert.match(r.model.replayedFrom, /review@orderform\.raw\.txt$/); assert.ok(r.findings.length > 0);
  const ids = new Set(orderForm.rules.map(x => x.id));
  for (const f of r.findings) for (const id of f.ruleIds || []) assert.ok(ids.has(id), `${f.title} cites ${id}, which is in the order-form playbook`);
  assert.ok(!r.findings.some(f => (f.notes || []).some(n => /not in the active playbook/.test(n))), 'no finding cites a rule outside the playbook');
  assert.ok(r.findings.every(f => f.evidence.every(e => e.verified !== false)), 'evidence quotes verify against the document');
  const cited = r.findings.flatMap(f => f.history || []);
  assert.ok(cited.length > 0 && cited.every(h => h.verified), 'the cover email excerpts verify against the round\'s covering email');
});
