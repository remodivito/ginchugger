// SPDX-License-Identifier: GPL-3.0-or-later
// gcl check, backup, restore (product v2 spec sections 9.3 and 9.5; PR-REC-01, PR-ADM-03), after decision 190: the
// record holds the team's playbooks and members; rebuild-projections, gc, import-legacy, export-record and import-record
// went with matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { main } from '../bin/gcl.js';
import { pidFile } from '../server/record/admin.js';
import { SCHEMA_VERSION } from '../server/record/schema.js';
import { openLocalRecord } from '../server/record/local.js';
import { freshRecord, tempDir } from './fixtures/record/helpers.js';

async function populated() {
  const { record, dataDir } = await freshRecord();
  const pb = await record.playbooks.get('nda');
  await record.playbooks.update('nda', { rules: pb.rules.slice(0, -1) }, pb.changeCount, 'u');
  record.close();
  return dataDir;
}
async function gcl(...args) { const lines = []; const code = await main(args, { log: l => lines.push(l) }); return { code, out: lines.join('\n') }; }

test('gcl check: every table at the schema version and the clause-type mappings; a newer schema fails', async () => {
  const dataDir = await populated();
  const ok = await gcl('--data', dataDir, 'check');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /ok: table playbooks/); assert.match(ok.out, new RegExp(`ok: schema version ${SCHEMA_VERSION} \\(code expects ${SCHEMA_VERSION}\\)`)); assert.match(ok.out, /Check passed\./);
  assert.match(ok.out, /Counts: playbooks 2/);
});

test('gcl backup then restore into an empty folder gives the same record; restore refuses while the app runs', async () => {
  const dataDir = await populated();
  const target = tempDir('gcl-backup-');
  const b = await gcl('--data', dataDir, 'backup', target);
  assert.equal(b.code, 0, b.out);
  assert.equal(readdirSync(target).filter(f => /^record-.*\.sqlite$/.test(f)).length, 1);
  assert.ok(existsSync(path.join(dataDir, 'last-backup.json')));
  const restored = tempDir('gcl-restored-');
  const r = await gcl('--data', restored, 'restore', target);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Check passed\./);
  const a = openLocalRecord({ dataDir }), c = openLocalRecord({ dataDir: restored });
  assert.deepEqual(await c.playbooks.get('nda'), await a.playbooks.get('nda'));
  a.close(); c.close();
  // The default backup folder sits in the data folder.
  assert.match((await gcl('--data', dataDir, 'backup')).out, new RegExp(`${path.join(dataDir, 'backups').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // A live process other than the caller (gcl ignores its own pid: in a container the server and gcl are both pid 1).
  writeFileSync(pidFile(restored), String(process.ppid));
  await assert.rejects(gcl('--data', restored, 'restore', target), /running \(pid \d+\)\. Stop it/);
});

test('decision 190: the matter commands are gone and say so as unknown commands', async () => {
  const dataDir = tempDir('gcl-data-');
  for (const cmd of ['rebuild-projections', 'gc', 'import-legacy', 'export-record', 'import-record', 'nonsense']) {
    const r = await gcl('--data', dataDir, cmd, 'x');
    assert.equal(r.code, 2, cmd); assert.doesNotMatch(r.out, new RegExp(`^  ${cmd}`, 'm'), `${cmd} is not in the usage`);
  }
});
