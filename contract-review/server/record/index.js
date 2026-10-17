// SPDX-License-Identifier: GPL-3.0-or-later
// The record module (product v2 spec section 6.1, after decision 190): the team's own data beside the document store.
// One interface, two implementations: LocalRecord over SQLite in the data folder (solo mode, and inside the team server)
// and RemoteRecord over the team server's /api/v2 (remote.js; the local app's team client, server/team-client.js,
// chooses between them). Documents are not here: they live in the document store (server/store/).
//
// interface Record {   // every method returns a promise; every write takes `actor`
//   info()
//   playbooks: { list(), get(id), update(id, draft, changeCount, actor) -> playbook | { proposal }, create(draft, actor), import(text, actor),
//                proposals(id), accept(id, proposalId, actor), decline(id, proposalId, note, actor), setOwners(id, owners, actor) }
//   (decision 178: a playbook's non-owner save is kept as a proposal)
//   clauseTypes: { get() }
//   actors() (ids as names)
//   admin: { status, issueCode, listCodes, revokeCode, listUsers, revokeUser, checkMailNow, setRetention }
//          (slice S7; the team server checks the admin flag)
// }
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalRecord, soloActor } from './local.js';

export { openLocalRecord, soloActor };
const appRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The local data folder: MARGIN_STATE_DIR (decision 146 keeps the name) or contract-review/.local, as the app has always used. */
export const stateDir = (env = process.env) => env.MARGIN_STATE_DIR || path.join(appRoot, '.local');

/** The local record in a data folder. Team mode's RemoteRecord is opened by server/team-client.js. */
export function openRecord({ dataDir = stateDir(), ...rest } = {}) { return openLocalRecord({ dataDir, ...rest }); }
