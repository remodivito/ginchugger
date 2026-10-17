// SPDX-License-Identifier: GPL-3.0-or-later
// The store in team mode (server/store/remote.js): a lawyer's app reaches the team store through the team server, never
// Paperless. A real team server in-process over HTTPS (the test CA) with the in-memory store; a laptop's side is the
// remote store's proxy behind a plain Express app, as index.js mounts it. Covered: the pages' and the pane's routes
// forwarded with the member's key (multipart, JSON, binary), each member acting as their own store user (history and
// notes name them), admin-only holds and activity by the member's admin flag, the review history on the team server,
// the read operations the agent tools, Ask and citations use, the tools listener (the Claude CLI's MCP path) reading
// through them, no Paperless address or token crossing, a revoked key signing the app out, and an unreachable server
// reported as unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startTeam, serverDataDir, CA_FILE } from './fixtures/team.js';
import { docx } from './fixtures/record/helpers.js';
import { openRemoteStore, dispositionName, READ_OPS } from '../server/store/remote.js';
import { makeToolRouter, prepareAgenticReview } from '../server/store/tools.js';
import { startToolsListener, createTokenStore } from '../server/tools-listener.js';
import { readStoreText } from '../server/store/text.js';

async function teamWithStore() {
  const team = await startTeam({ dataDir: serverDataDir(undefined, { store: { mode: 'fake' } }) });
  for (let i = 0; i < 100 && team.srv.store.status().state !== 'ready'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(team.srv.store.status().state, 'ready');
  return team;
}

/** A laptop: the remote store for one member, behind an app that parses JSON first, as index.js does. */
async function laptop(team, member, extra = {}) {
  const auth = [];
  const remote = openRemoteStore({ url: team.url, key: member.key, caFile: CA_FILE, onAuthError: code => auth.push(code), ...extra });
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use('/api/v2/store', (req, res) => remote.proxy(req, res));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v2/store`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
    return { status: r.status, body: json, buf, headers: r.headers };
  };
  const send = async (p, fields) => {
    const form = new FormData();
    for (const [k, v, name] of fields) { if (name) form.append(k, new Blob([v]), name); else form.append(k, v); }
    const r = await fetch(base + p, { method: 'POST', body: form });
    return { status: r.status, body: await r.json() };
  };
  return { remote, call, send, auth, close: () => { server.close(); remote.close(); } };
}

const settle = () => new Promise(r => setTimeout(r, 20));

test('team mode: the pages and the pane reach the team store through the team server, each member as their own store user', async () => {
  const team = await teamWithStore();
  const ada = await team.member('Ada Admin', true); const ben = await team.member('Ben Member');
  const A = await laptop(team, ada); const B = await laptop(team, ben);
  try {
    const status = await A.call('GET', '/status');
    assert.deepEqual([status.status, status.body.state, status.body.mode, status.body.url], [200, 'ready', 'fake', null], 'the status, without the store address');
    // The admin status (the Admin page) names the store's state, never its address.
    const admin = await ada.remote.admin.status();
    assert.deepEqual([admin.store.state, admin.store.mode, admin.store.url], ['ready', 'fake', null], 'the admin status leaves the store address out');

    // Inbox: Ben uploads two files (multipart through the proxy); both land in the team store's inbox.
    const ndaFile = await docx(['Mutual NDA', 'Between Helix Instruments Ltd and Northgate Biosciences Ltd.']);
    const up = await B.send('/documents', [['file', ndaFile, 'northgate-nda.docx'], ['file', Buffer.from('Notes from the call.'), 'call-notes.txt']]);
    assert.equal(up.status, 202); assert.equal(up.body.tasks.length, 2);
    await settle();
    const inbox = await A.call('GET', '/inbox');
    assert.deepEqual(inbox.body.documents.map(d => d.title).sort(), ['call-notes', 'northgate-nda'], 'Ada sees what Ben added');
    const nda = inbox.body.documents.find(d => d.title === 'northgate-nda');

    // Labels and Done (JSON through the proxy); the history names Ben's own store user.
    const done = await B.call('POST', `/documents/${nda.id}/done`, { counterparty: 'Northgate Biosciences Ltd', type: 'NDA' });
    assert.deepEqual([done.status, done.body.counterparty, done.body.inbox], [200, 'Northgate Biosciences Ltd', false]);
    const history = (await A.call('GET', `/documents/${nda.id}/history`)).body;
    assert.equal(history[0].actor, 'ben.member', 'the change is credited to Ben, not the service account');
    await A.call('POST', `/documents/${nda.id}/notes`, { text: 'Their counsel wants a 2-year term.' });
    assert.deepEqual((await B.call('GET', `/documents/${nda.id}/notes`)).body.map(n => [n.text, n.user]), [['Their counsel wants a 2-year term.', 'ada.admin']]);

    // Library and search.
    const lib = await B.call('GET', '/documents?counterparty=Northgate%20Biosciences%20Ltd');
    assert.deepEqual(lib.body.results.map(d => d.id), [nda.id]);
    assert.equal((await B.call('GET', '/documents?q=Helix')).body.results[0].id, nda.id);

    // The original: binary, with our filename.
    const orig = await B.call('GET', `/documents/${nda.id}/original`);
    assert.equal(orig.status, 200);
    assert.equal(dispositionName(orig.headers.get('content-disposition')), 'northgate-nda.docx');
    assert.equal(orig.buf.subarray(0, 2).toString(), 'PK');

    // Permissions: the member's admin flag on the team server decides.
    assert.equal((await B.call('POST', `/documents/${nda.id}/hold`, { on: true })).status, 403);
    assert.equal((await B.call('GET', '/activity')).status, 403);
    assert.equal((await A.call('POST', `/documents/${nda.id}/hold`, { on: true })).body.tags.includes('on hold'), true);
    assert.equal((await A.call('GET', '/activity')).status, 200);
    assert.equal((await B.call('POST', `/documents/${nda.id}/trash`)).body.code, 'protected');

    // The Word pane: open finds the stored document by its bytes; "Save as our reply" adds one under the counterparty.
    const opened = await B.send('/pane/open', [['file', ndaFile, 'northgate-nda.docx']]);
    assert.deepEqual([opened.status, opened.body.found, opened.body.document.id], [200, true, nda.id]);
    const reply = await B.send('/pane/save', [['file', await docx(['Mutual NDA', 'Our reply.']), 'reply.docx'], ['sourceId', String(nda.id)]]);
    assert.deepEqual([reply.status, reply.body.document.counterparty, reply.body.document.title], [201, 'Northgate Biosciences Ltd', 'northgate-nda (our reply)']);

    // Review history lives on the team server, credited to the member.
    const ev = await B.call('POST', `/documents/${nda.id}/review-events`, { events: [{ type: 'finding_dismissed', payload: { reviewId: 'rv1', findingId: 'f1', ruleId: 'r1', note: 'Accepted last time.' } }] });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    assert.deepEqual((await A.call('GET', `/documents/${nda.id}/review-events`)).body.map(e => [e.type, e.actor]), [['finding_dismissed', 'Ben Member']]);
    // Ben accepts their wording: the concession is a note on the team store's document, written as Ben; his undo deletes it.
    await B.call('POST', `/documents/${nda.id}/review-events`, { events: [{ type: 'finding_dismissed', payload: { reviewId: 'rv1', findingId: 'f2', note: 'Accepted their wording', reason: 'accepted', title: 'Term', quote: 'Two years.' } }] });
    assert.deepEqual((await A.call('GET', `/documents/${nda.id}/notes`)).body.map(n => [n.text, n.user]).at(-1), ['Accepted their wording on Term: "Two years."', 'ben.member']);
    await B.call('POST', `/documents/${nda.id}/review-events`, { events: [{ type: 'finding_undismissed', payload: { reviewId: 'rv1', findingId: 'f2' } }] });
    assert.equal((await A.call('GET', `/documents/${nda.id}/notes`)).body.some(n => n.text.startsWith('Accepted their wording')), false);

    // Nothing about Paperless crossed: no store address, no token.
    for (const r of [status.body, inbox.body, done.body]) assert.doesNotMatch(JSON.stringify(r), /127\.0\.0\.1|Token |store-tokens/);
  } finally { A.close(); B.close(); await team.close(); }
});

test('team mode: the agent tools, Ask\'s reads and the citation check read the team store as the member; the tools listener (the MCP path) too', async () => {
  const team = await teamWithStore();
  const ben = await team.member('Ben Member');
  const B = await laptop(team, ben);
  const listener = await startToolsListener({ getStore: () => B.remote.getClient(), tokens: createTokenStore() });
  try {
    const svc = team.srv.store.serviceClient();
    const v1 = await svc.add(await docx(['Order Form', 'Payment within 60 days of invoice.', 'Liability capped at fees paid.']), { filename: 'northgate-v1.docx', counterparty: 'Northgate Biosciences Ltd', type: 'Order form', tags: ['signed'], created: '2026-03-01' });
    const v2 = await svc.add(await docx(['Order Form', 'Payment within 30 days of invoice.']), { filename: 'northgate-v2.docx', counterparty: 'Northgate Biosciences Ltd', type: 'Order form', created: '2026-09-01' });
    await svc.notes.add(v1.id, 'Signed after two rounds.');

    const store = B.remote.getClient();
    assert.equal((await store.getDocument(v1.id)).title, 'northgate-v1');
    assert.equal((await store.list({ counterparty: 'Northgate Biosciences Ltd' })).count, 2);
    assert.equal((await store.search('invoice', {})).count, 2);
    assert.deepEqual((await store.notes.list(v1.id)).map(n => n.text), ['Signed after two rounds.']);
    const text = await readStoreText(store, v1.id);
    assert.deepEqual(text.paragraphs.map(p => p.text), ['Order Form', 'Payment within 60 days of invoice.', 'Liability capped at fees paid.']);
    await assert.rejects(store.getDocument(9999), e => e.status === 404);

    const router = makeToolRouter(store, { documentId: v2.id, counterparty: 'Northgate Biosciences Ltd' });
    const overview = await router.call('get_counterparty_overview', {});
    assert.deepEqual([overview.documentCount, overview.signedCount], [2, 1]);
    const read = await router.call('read_document', { documentId: v1.id });
    assert.deepEqual([read.paragraphs.length, read.notes[0].text], [3, 'Signed after two rounds.']);

    const prepared = await prepareAgenticReview(store, { documentId: v2.id, actor: ben.userId });
    assert.deepEqual([prepared.brief.counterparty, prepared.brief.otherDocumentsWithThisCounterparty, prepared.brief.signedDocumentsWithThisCounterparty], ['Northgate Biosciences Ltd', 1, 1]);
    assert.match((await prepared.citations.resolve(v1.id)).text, /Payment within 60 days/);

    // The Claude CLI's MCP child calls the local tools listener, which reads the team store through the same client.
    const token = listener.mint({ documentId: v2.id, counterparty: 'Northgate Biosciences Ltd', actor: ben.userId });
    const r = await fetch(`${listener.url}/search-documents?query=liability`, { headers: { Authorization: `Bearer ${token}` } });
    const hits = (await r.json()).hits;
    assert.deepEqual(hits.map(h => h.documentId), [v1.id]);

    // The read route takes only the listed read operations.
    assert.deepEqual(Object.keys(READ_OPS).sort(), ['findDuplicates', 'getDocument', 'list', 'notes.list', 'search', 'similar']);
    const write = await B.call('POST', '/read', { op: 'trash', args: [[v1.id]] });
    assert.deepEqual([write.status, write.body.code], [400, 'bad_request']);
    assert.equal((await svc.getDocument(v1.id)).deletedAt ?? null, null);
  } finally { await listener.close(); B.close(); await team.close(); }
});

test('team mode: without a member key the store is closed; a revoked key signs the app out; an unreachable server is unavailable', async () => {
  const team = await teamWithStore();
  const ben = await team.member('Ben Member');
  const B = await laptop(team, ben);
  const stranger = await laptop(team, { key: 'not-a-key-of-this-team-000000' });
  try {
    assert.equal((await stranger.call('GET', '/inbox')).status, 401);
    await assert.rejects(stranger.remote.getClient().list({}), e => e.status === 401);
    assert.equal((await B.call('GET', '/inbox')).status, 200);
    await team.srv.record.admin.revokeUser(ben.userId, 'system:gcl');
    const r = await B.call('GET', '/inbox');
    assert.deepEqual([r.status, r.body.error.code], [401, 'key_revoked'], 'the team server\'s own answer, passed back');
    assert.ok(B.auth.includes('key_revoked'), 'the app is told, as RemoteRecord tells it');
  } finally { stranger.close(); B.close(); await team.close(); }
  // The team server is gone: the status says unavailable (one line on the pages), reads fail as store_unavailable.
  const down = await laptop(team, ben);
  try {
    const s = await down.call('GET', '/status');
    assert.deepEqual([s.status, s.body.state], [200, 'unavailable']);
    await assert.rejects(down.remote.getClient().getDocument(1), e => e.code === 'store_unavailable' && e.status === 503);
    assert.equal((await down.call('GET', '/inbox')).body.code, 'store_unavailable');
  } finally { down.close(); }
});
