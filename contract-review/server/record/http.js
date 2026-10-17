// SPDX-License-Identifier: GPL-3.0-or-later
// The /api/v2 routes over a Record (product v2 spec section 6.2.1, after decision 190): playbooks (reads, the editor's
// save and create, proposals and owners), clause types, actor names and the admin routes. The document routes are the
// store's (server/store/http.js, /api/v2/store); matters, rounds, files, the inbox, the trash, notes, activity, the
// register, search and the record tools went with decision 190. The same router serves the team server (the actor is
// the signed-in member, `adminGuard` checks the admin flag) and the local app (the actor is this computer's user in solo
// mode; in team mode the record is RemoteRecord and the team server decides). Errors are { error: { code, message } } (6.2.4).
import { plainMessage } from '../../shared/plain-error.js';
import express from 'express';

const CODES = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'rate_limited', 501: 'not_built', 503: 'record_unavailable' };
const ADMIN_OPS = ['status', 'issueCode', 'listCodes', 'revokeCode', 'listUsers', 'revokeUser', 'checkMailNow', 'setRetention'];

/**
 * `actor(req)`: who writes (the member on the team server, this computer's user in solo mode).
 * `adminGuard(req, op)`: throws when the caller may not run that admin operation.
 * `statusExtras(req)`: what the host adds to the record's half of the status page (uptime, certificate, settings).
 */
export function recordRoutes(getRecord, { actor, beforeRead = async () => {}, adminGuard = () => {}, statusExtras = async () => ({}) } = {}) {
  const r = express.Router();
  const h = fn => async (req, res, next) => { try { if (req.method === 'GET') await beforeRead(); await fn(req, res, getRecord()); } catch (e) { next(e); } };
  const who = req => (typeof actor === 'function' ? actor(req) : actor);

  r.get('/playbooks', h(async (req, res, rec) => res.json(await rec.playbooks.list())));
  r.get('/playbooks/:id', h(async (req, res, rec) => res.json(await rec.playbooks.get(req.params.id))));
  // The playbook editor (slice S6, PR-PAGE-02, PR-PB-01): the caller's change counter must be current. An owner's save
  // applies; anyone else's is kept as a proposal and answered 202 with `{ proposal }` (decision 178, PR-PB-05).
  r.put('/playbooks/:id', express.json({ limit: '2mb' }), h(async (req, res, rec) => {
    const b = req.body || {};
    if (!Number.isInteger(b.changeCount)) throw Object.assign(new Error('Send the change count the playbook was read at.'), { status: 400 });
    const draft = { rules: b.rules, ...(typeof b.title === 'string' ? { title: b.title } : {}), ...(b.appliesTo !== undefined ? { appliesTo: b.appliesTo } : {}) };
    if (b.provenance && typeof b.provenance === 'object') draft.provenance = b.provenance;
    // `kind: 'imported'`: an imported draft replaced the rules (the compatibility route's Use this playbook).
    if (b.kind !== undefined && b.kind !== 'imported') throw Object.assign(new Error('A playbook save names no kind, or "imported".'), { status: 400 });
    const out = await rec.playbooks.update(req.params.id, draft, b.changeCount, who(req), b.kind ? { kind: b.kind } : undefined);
    res.status(out?.proposal ? 202 : 200).json(out);
  }));
  // Proposed changes (decision 178, PR-PB-06): listed for everyone, accepted or declined by an owner; owners named by an admin.
  r.get('/playbooks/:id/proposals', h(async (req, res, rec) => res.json(await rec.playbooks.proposals(req.params.id))));
  r.post('/playbooks/:id/proposals/:proposalId/accept', express.json({ limit: '64kb' }), h(async (req, res, rec) => res.json(await rec.playbooks.accept(req.params.id, req.params.proposalId, who(req)))));
  r.post('/playbooks/:id/proposals/:proposalId/decline', express.json({ limit: '64kb' }), h(async (req, res, rec) => res.json(await rec.playbooks.decline(req.params.id, req.params.proposalId, req.body?.note, who(req)))));
  r.put('/playbooks/:id/owners', express.json({ limit: '64kb' }), h(async (req, res, rec) => res.json(await rec.playbooks.setOwners(req.params.id, req.body?.owners, who(req)))));
  r.post('/playbooks', express.json({ limit: '2mb' }), h(async (req, res, rec) => res.status(201).json(await rec.playbooks.create({ id: typeof req.body?.id === 'string' && req.body.id ? req.body.id : undefined, title: req.body?.title, appliesTo: req.body?.appliesTo || null, draft: req.body?.draft || {} }, who(req)))));
  r.get('/clause-types', h(async (req, res, rec) => res.json(await rec.clauseTypes.get())));
  // Actor ids as names ("Last changed by", proposals): members' names and the server's own actors.
  r.get('/actors', h(async (req, res, rec) => res.json(await rec.actors())));

  // Administration (6.2.1, PR-PAGE-03): admins only on the team server; the status only in solo mode.
  const run = (op, fn) => { if (!ADMIN_OPS.includes(op)) throw new Error(`Unknown admin operation ${op}.`); return h(async (req, res, rec) => { await adminGuard(req, op); await fn(req, res, rec); }); };
  r.get('/admin/status', run('status', async (req, res, rec) => res.json({ ...(await rec.admin.status()), ...(await statusExtras(req)) })));
  r.post('/admin/setup-codes', express.json({ limit: '64kb' }), run('issueCode', async (req, res, rec) => { const b = req.body || {}; res.status(201).json(await rec.admin.issueCode(b.forName, b.admin === true, b.ttlHours ?? undefined, who(req), { userId: typeof b.userId === 'string' && b.userId ? b.userId : null })); }));
  r.get('/admin/setup-codes', run('listCodes', async (req, res, rec) => res.json(await rec.admin.listCodes())));
  r.delete('/admin/setup-codes/:id', run('revokeCode', async (req, res, rec) => res.json(await rec.admin.revokeCode(req.params.id, who(req)))));
  r.get('/admin/users', run('listUsers', async (req, res, rec) => res.json(await rec.admin.listUsers())));
  r.post('/admin/users/:id/revoke', run('revokeUser', async (req, res, rec) => res.json(await rec.admin.revokeUser(req.params.id, who(req)))));
  r.post('/admin/mail/check', run('checkMailNow', async (req, res, rec) => res.status(202).json(await rec.admin.checkMailNow(who(req)))));
  r.put('/admin/retention', express.json({ limit: '64kb' }), run('setRetention', async (req, res, rec) => res.json(await rec.admin.setRetention(req.body?.adoptedOn, who(req)))));

  r.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown operation.' } }));
  // eslint-disable-next-line no-unused-vars
  r.use((e, req, res, next) => { const status = e.status || (e.type === 'entity.too.large' ? 413 : 400); res.status(status).json({ error: { code: e.code && !/^[A-Z_]+$/.test(e.code) ? e.code : CODES[status] || 'error', message: plainMessage(e.message, 'The operation could not be completed. Try again.') } }); });
  return r;
}
