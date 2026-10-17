// SPDX-License-Identifier: GPL-3.0-or-later
// Decision 178 (product v2 spec PR-PB-05 to 07; deleting a matter went with matters, decision 190): a playbook's owners (admins
// always among them) save changes directly, and anyone else's save is kept as a proposal an owner accepts or declines;
// in solo mode the one user is admin and owner. Over LocalRecord in both modes and over the team server's HTTP routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLocalRecord } from '../server/record/local.js';
import { importPlaybooks } from '../server/record/legacy.js';
import { ruleChanges, applyRuleChanges } from '../server/record/permissions.js';
import { validateEvent } from '../server/record/events.js';
import { freshRecord, tempDir } from './fixtures/record/helpers.js';
import { startTeam } from './fixtures/team.js';

const forbidden = (p, re) => assert.rejects(p, e => (e.status === 403 && e.code === 'forbidden' && (!re || re.test(e.message))) || assert.fail(`${e.status} ${e.code}: ${e.message}`));
const rule = (id, extra = {}) => ({ id, title: `Rule ${id}`, topic: 'custom', guidance: `Guidance for ${id}.`, conditions: {}, fallback: '', enabled: true, ...extra });

/** A team-mode record (as inside the team server) with an admin and a member who joined with setup codes. */
async function teamRecord() {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const record = openLocalRecord({ dataDir: tempDir('gcl-perm-'), mode: 'team', now: () => new Date(t += 1000).toISOString() });
  await importPlaybooks(record, tempDir('empty-state-'));
  const join = (name, admin) => { const { code } = record.internal.team.issueCode({ forName: name, admin }, 'system:gcl'); return record.internal.team.redeem({ code }).userId; };
  return { record, admin: join('Ada Admin', true), member: join('Ben Member', false), other: join('Cy Colleague', false) };
}
const events = (record, type) => record.internal.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq').all(type).map(r => ({ actor: r.actor, ...JSON.parse(r.payload) }));

test('playbook, team mode: a member\'s save becomes a proposal; the playbook is unchanged until an owner accepts it, crediting both', async () => {
  const { record, admin, member } = await teamRecord();
  const before = await record.playbooks.get('nda');
  assert.deepEqual(before.owners, []);
  const out = await record.playbooks.update('nda', { rules: [...before.rules, rule('NEW-01')] }, before.changeCount, member);
  assert.ok(out.proposal, 'answered with the proposal');
  assert.deepEqual([out.proposal.proposedBy, out.proposal.ruleId, out.proposal.kind, out.proposal.baseChange], [member, 'NEW-01', 'added', before.changeCount]);
  assert.deepEqual(out.proposal.changes.map(c => c.ruleId), ['NEW-01']);
  const still = await record.playbooks.get('nda');
  assert.equal(still.changeCount, before.changeCount); assert.ok(!still.rules.some(r => r.id === 'NEW-01'));
  assert.equal(events(record, 'playbook_change_proposed').length, 1);
  assert.equal((await record.playbooks.list()).find(p => p.id === 'nda').proposals, 1);
  assert.deepEqual((await record.playbooks.proposals('nda')).map(p => p.id), [out.proposal.id]);
  // A non-owner cannot accept or decline.
  await forbidden(record.playbooks.accept('nda', out.proposal.id, member), /Only an owner/);
  await forbidden(record.playbooks.decline('nda', out.proposal.id, 'no', member));
  // The admin (an owner by being admin) accepts: one playbook_changed, by the admin, naming the proposer and the proposal.
  const accepted = await record.playbooks.accept('nda', out.proposal.id, admin);
  assert.equal(accepted.changeCount, before.changeCount + 1); assert.ok(accepted.rules.some(r => r.id === 'NEW-01'));
  assert.deepEqual([accepted.updatedBy, accepted.lastChange], [admin, { ruleId: 'NEW-01', kind: 'added' }]);
  const changed = events(record, 'playbook_changed').at(-1);
  assert.deepEqual([changed.actor, changed.proposedBy, changed.proposalId, changed.kind, changed.ruleId], [admin, member, out.proposal.id, 'added', 'NEW-01']);
  assert.deepEqual(await record.playbooks.proposals('nda'), []);
  await assert.rejects(record.playbooks.accept('nda', out.proposal.id, admin), e => e.status === 409 && e.code === 'proposal_decided');
  await assert.rejects(record.playbooks.accept('nda', 'nope', admin), e => e.status === 404);
  record.close();
});

test('playbook, team mode: a stale read is still refused; an empty proposal is refused; a declined proposal needs a note and changes nothing', async () => {
  const { record, admin, member } = await teamRecord();
  const pb = await record.playbooks.get('nda');
  await assert.rejects(record.playbooks.update('nda', { rules: pb.rules }, pb.changeCount - 1, member), e => e.status === 409 && e.code === 'playbook_changed');
  await assert.rejects(record.playbooks.update('nda', { rules: pb.rules }, pb.changeCount, member), e => e.status === 400 && /Nothing changed/.test(e.message));
  const { proposal } = await record.playbooks.update('nda', { rules: pb.rules.slice(1) }, pb.changeCount, member);
  assert.deepEqual([proposal.kind, proposal.ruleId, proposal.changes], ['removed', pb.rules[0].id, [{ ruleId: pb.rules[0].id, rule: null }]]);
  await assert.rejects(record.playbooks.decline('nda', proposal.id, '  ', admin), e => e.status === 400 && /Say why/.test(e.message));
  assert.deepEqual(await record.playbooks.decline('nda', proposal.id, 'We keep this clause.', admin), { declined: proposal.id });
  assert.deepEqual(events(record, 'playbook_change_declined').map(e => [e.actor, e.proposalId, e.note]), [[admin, proposal.id, 'We keep this clause.']]);
  assert.deepEqual(await record.playbooks.get('nda'), pb, 'the playbook is unchanged');
  assert.deepEqual(await record.playbooks.proposals('nda'), []);
  await assert.rejects(record.playbooks.accept('nda', proposal.id, admin), e => e.code === 'proposal_decided');
  record.close();
});

test('playbook, team mode: an accepted proposal applies to the playbook as it is now, keeping changes saved since', async () => {
  const { record, admin, member } = await teamRecord();
  const pb = await record.playbooks.get('nda');
  const edited = { ...pb.rules[1], guidance: 'Proposed wording.' };
  const { proposal } = await record.playbooks.update('nda', { rules: pb.rules.map(r => (r.id === edited.id ? edited : r)) }, pb.changeCount, member);
  const after = await record.playbooks.update('nda', { rules: [...pb.rules, rule('ADMIN-01')] }, pb.changeCount, admin);
  assert.equal(after.changeCount, pb.changeCount + 1);
  const accepted = await record.playbooks.accept('nda', proposal.id, admin);
  assert.equal(accepted.rules.find(r => r.id === edited.id).guidance, 'Proposed wording.');
  assert.ok(accepted.rules.some(r => r.id === 'ADMIN-01'), 'the admin\'s later change is kept');
  assert.deepEqual(accepted.lastChange, { ruleId: edited.id, kind: 'edited' });
  record.close();
});

test('playbook owners: an admin names them; a named owner\'s save applies and the owner accepts proposals; others cannot name owners', async () => {
  const { record, admin, member, other } = await teamRecord();
  await forbidden(record.playbooks.setOwners('nda', [member], member), /Only an admin/);
  await assert.rejects(record.playbooks.setOwners('nda', ['not-a-member'], admin), e => e.status === 400);
  await assert.rejects(record.playbooks.setOwners('nda', 'x', admin), e => e.status === 400);
  assert.deepEqual((await record.playbooks.setOwners('nda', [member, member], admin)).owners, [member]);
  assert.deepEqual((await record.playbooks.list()).find(p => p.id === 'nda').owners, [member]);
  const pb = await record.playbooks.get('nda');
  const saved = await record.playbooks.update('nda', { rules: [...pb.rules, rule('OWN-01')] }, pb.changeCount, member);
  assert.equal(saved.changeCount, pb.changeCount + 1, 'an owner\'s save applies');
  const { proposal } = await record.playbooks.update('nda', { rules: [...saved.rules, rule('OTH-01')] }, saved.changeCount, other);
  assert.equal((await record.playbooks.accept('nda', proposal.id, member)).rules.at(-1).id, 'OTH-01');
  // Owners are per playbook: the member owns nda, not order-form.
  const of = await record.playbooks.get('order-form');
  assert.ok((await record.playbooks.update('order-form', { rules: of.rules.slice(1) }, of.changeCount, member)).proposal);
  // Clearing the owners leaves the admins.
  assert.deepEqual((await record.playbooks.setOwners('nda', [], admin)).owners, []);
  const cur = await record.playbooks.get('nda');
  assert.ok((await record.playbooks.update('nda', { rules: cur.rules.slice(1) }, cur.changeCount, member)).proposal);
  record.close();
});

test('playbook, team mode: whoever creates a playbook owns it', async () => {
  const { record, member, other } = await teamRecord();
  const created = await record.playbooks.create({ title: 'Supplier terms', draft: { rules: [rule('SUP-01')] } }, member);
  assert.deepEqual(created.owners, [member]);
  const saved = await record.playbooks.update(created.id, { rules: [...created.rules, rule('SUP-02')] }, created.changeCount, member);
  assert.equal(saved.rules.length, 2);
  assert.ok((await record.playbooks.update(created.id, { rules: [] }, saved.changeCount, other)).proposal);
  record.close();
});

test('playbook, solo mode: the one user is the owner; every save applies as before', async () => {
  const { record } = await freshRecord();
  const pb = await record.playbooks.get('nda');
  const saved = await record.playbooks.update('nda', { rules: [...pb.rules, rule('SOLO-01')] }, pb.changeCount, 'sam');
  assert.equal(saved.changeCount, pb.changeCount + 1); assert.ok(!('proposal' in saved));
  assert.deepEqual((await record.playbooks.create({ title: 'Mine', draft: { rules: [] } }, 'sam')).owners, [], 'no owner event in solo mode');
  record.close();
});

test('rule changes: computed per rule and applied onto a moved-on playbook; the new events are validated', () => {
  const a = [rule('A'), rule('B'), rule('C')];
  const b = [rule('A', { guidance: 'Changed.' }), rule('C'), rule('D')];
  const changes = ruleChanges(a, b);
  assert.deepEqual(changes.map(c => [c.ruleId, c.rule ? 'set' : 'removed']), [['A', 'set'], ['D', 'set'], ['B', 'removed']]);
  assert.deepEqual(applyRuleChanges([rule('A'), rule('B'), rule('C'), rule('E')], changes).map(r => r.id), ['A', 'C', 'E', 'D']);
  assert.throws(() => validateEvent({ type: 'playbook_owners_set', payload: { playbookId: 'nda', owners: [1] } }), e => e.status === 400);
  assert.throws(() => validateEvent({ type: 'playbook_change_declined', payload: { playbookId: 'nda', proposalId: 'p', note: '' } }), e => e.status === 400);
  assert.throws(() => validateEvent({ type: 'playbook_change_proposed', payload: { playbookId: 'nda', proposalId: 'p', kind: 'made-up', changes: [], baseChange: 1 } }), e => e.status === 400);
  assert.throws(() => validateEvent({ type: 'playbook_change_proposed', payload: { playbookId: 'nda', proposalId: 'p', kind: 'added', changes: [{ rule: {} }], baseChange: 1 } }), e => e.status === 400);
});

test('team server routes: a member\'s PUT is 202 with the proposal; an admin accepts over HTTP', async () => {
  const team = await startTeam();
  try {
    const ada = await team.member('Ada Admin', true), ben = await team.member('Ben Member');
    const pb = await ben.remote.playbooks.get('nda');
    const out = await ben.remote.playbooks.update('nda', { rules: [...pb.rules, rule('HTTP-01')] }, pb.changeCount);
    assert.equal(out.proposal.proposedBy, ben.userId);
    assert.equal((await ada.remote.playbooks.proposals('nda')).length, 1);
    await forbidden(ben.remote.playbooks.accept('nda', out.proposal.id));
    await forbidden(ben.remote.playbooks.setOwners('nda', [ben.userId]));
    const accepted = await ada.remote.playbooks.accept('nda', out.proposal.id);
    assert.ok(accepted.rules.some(r => r.id === 'HTTP-01'));
    assert.deepEqual((await ada.remote.playbooks.setOwners('nda', [ben.userId])).owners, [ben.userId]);
    const cur = await ben.remote.playbooks.get('nda');
    assert.equal((await ben.remote.playbooks.update('nda', { rules: cur.rules.slice(0, -1) }, cur.changeCount)).changeCount, cur.changeCount + 1);
    ada.remote.close(); ben.remote.close();
  } finally { await team.close(); }
});
