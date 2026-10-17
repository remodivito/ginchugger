// SPDX-License-Identifier: GPL-3.0-or-later
// One Record interface, two implementations (product v2 spec 6.1): the same suite against LocalRecord and against
// RemoteRecord talking to a team server over HTTPS (slice S7).
import { recordInterfaceSuite } from './fixtures/record/interface-suite.js';
import { freshRecord } from './fixtures/record/helpers.js';
import { startTeam } from './fixtures/team.js';

recordInterfaceSuite('LocalRecord', async () => { const { record } = await freshRecord(); return { record, close: () => record.close() }; });
recordInterfaceSuite('RemoteRecord', async () => {
  const team = await startTeam();
  const { remote } = await team.member('Ada Admin', true);
  return { record: remote, close: async () => { remote.close(); await team.close(); } };
});
