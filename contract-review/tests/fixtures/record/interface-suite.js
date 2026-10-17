// SPDX-License-Identifier: GPL-3.0-or-later
// The Record interface (product v2 spec 6.1, after decision 190: the team's playbooks, members and settings) as one
// suite, run against every implementation: LocalRecord over SQLite and RemoteRecord over the team server
// (tests/record-interface.test.js). Only public methods are used, so whatever passes here is something the pages, the
// pane and gcl can rely on in either mode.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const rejects = (p, status, code) => assert.rejects(p, e => e.status === status && (!code || e.code === code) || assert.fail(`expected ${status} ${code || ''}, got ${e.status} ${e.code}: ${e.message}`));

/** `setup()` resolves { record, close } with the shipped playbooks (nda, order-form) present and an admin as the caller. */
export function recordInterfaceSuite(label, setup) {
  describe(label, () => suite(label, setup));
}

function suite(label, setup) {
  let ctx, record; let n = 0;
  const uniq = s => `${s} ${label} ${++n}`;
  before(async () => { ctx = await setup(); record = ctx.record; });
  after(async () => { await ctx?.close(); });
  test(`${label}: info names the mode and the schema`, async () => {
    const i = await record.info();
    assert.ok(['solo', 'team'].includes(i.mode)); assert.equal(typeof i.schemaVersion, 'number'); assert.match(i.version, /^\d+\.\d+\.\d+/);
  });

  test(`${label}: playbooks and clause types`, async () => {
    const list = await record.playbooks.list();
    assert.ok(list.some(p => p.id === 'nda') && list.some(p => p.id === 'order-form'));
    const pb = await record.playbooks.get('nda');
    const saved = await record.playbooks.update('nda', { rules: pb.rules.slice(0, -1) }, pb.changeCount, 'tester');
    assert.deepEqual([saved.changeCount, saved.lastChange.kind], [pb.changeCount + 1, 'removed']);
    await rejects(record.playbooks.update('nda', { rules: pb.rules }, pb.changeCount, 'tester'), 409, 'playbook_changed');
    const imported = await record.playbooks.update('nda', { rules: pb.rules }, saved.changeCount, 'tester', { kind: 'imported' });
    assert.deepEqual([imported.lastChange, imported.rules.length], [{ ruleId: null, kind: 'imported' }, pb.rules.length]);
    const created = await record.playbooks.create({ title: uniq('Supplier terms'), draft: { rules: [] } }, 'tester');
    assert.equal(created.changeCount, 1);
    assert.ok(Array.isArray((await record.playbooks.import('Section 1 — Term\nThree years at most.')).rules));
    assert.equal((await record.clauseTypes.get()).format, 'ginchugger-clause-types/1');
  });

  test(`${label}: actor names and administration`, async () => {
    const names = await record.actors();
    assert.deepEqual([names['system:mail'], names['system:folder']], ['Mailbox', 'Watched folder']);
    const s = await record.admin.status();
    assert.equal(typeof s.schemaVersion, 'number'); assert.equal(s.inboxWaiting, undefined, 'the inbox is the store\'s now'); assert.ok(s.users && 'active' in s.users);
    const c = await record.admin.issueCode(uniq('Cy Member'), false, 24, 'tester');
    assert.match(c.code, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal((await record.admin.listCodes()).find(x => x.id === c.id).code, undefined); // never retrievable after issue
    assert.ok((await record.admin.revokeCode(c.id, 'tester')).revokedAt);
    assert.ok(Array.isArray(await record.admin.listUsers()));
    await rejects(record.admin.setRetention('15 October', 'tester'), 400);
    assert.deepEqual(await record.admin.setRetention('2026-10-15', 'tester'), { adoptedOn: '2026-10-15' });
    assert.equal((await record.admin.status()).retentionAdoptedOn, '2026-10-15');
  });
}
