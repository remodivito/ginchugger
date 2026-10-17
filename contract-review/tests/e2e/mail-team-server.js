#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The team server with its mailbox replaced by the simulated one (product v2 spec 11.2: "the inbox page confirming a
// mail capture produced by the simulated mailbox"). The real createTeamServer and mail consumer run; only the IMAP
// client class, the DNS answer and the Microsoft token are the fakes of tests/fixtures/mail.js, and the document store
// the captures go to is the in-memory fake (store mode "fake"), seeded with the counterparty Brightwater Analytics Ltd.
// A control endpoint on 127.0.0.1 lets the spec deliver messages into the mailbox, read its folders and read the
// store's documents with their notes (GET /store). Test harness only: not shipped.
//
//   node tests/e2e/mail-team-server.js --data <dir>
import { createServer } from 'node:http';
import path from 'node:path';
import { createTeamServer, parseListen } from '../../server/team-server.js';
import { sharedMailbox, mailDeps } from '../fixtures/mail.js';
import { createStoreService, storeConfig } from '../../server/store/service.js';

const args = process.argv.slice(2);
const dataDir = path.resolve(args[args.indexOf('--data') + 1]);
const mailbox = sharedMailbox();
const store = createStoreService({ config: storeConfig({ settings: { mode: 'fake' }, dataDir }) });
await store.start();
await store.serviceClient().taxonomy.counterparties.create({ name: 'Brightwater Analytics Ltd' });
const srv = await createTeamServer({ dataDir, mailDeps: mailDeps(mailbox), store });
const { port } = await srv.listen();
const control = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  try {
    if (req.method === 'POST' && req.url === '/deliver') {
      const { raw, folder = 'INBOX' } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!mailbox.folder(folder)) mailbox.addFolder(folder, 500);
      const m = await mailbox.deliver(Buffer.from(raw, 'base64'), { folder });
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ uid: m.uid }));
    } else if (req.method === 'GET' && req.url === '/folders') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Object.fromEntries([...mailbox.folders].map(([k, f]) => [k, f.messages.map(m => m.meta.subject)]))));
    } else if (req.method === 'GET' && req.url === '/store') {
      const docs = store.serviceClient();
      const { results } = await docs.list({ pageSize: 100 });
      const out = await Promise.all(results.sort((a, b) => a.id - b.id).map(async d => ({ ...d, notes: (await docs.notes.list(d.id)).map(n => n.text) })));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    } else res.writeHead(404).end();
  } catch (e) { res.writeHead(500).end(e.message); }
});
control.listen(0, '127.0.0.1', () => {
  console.log(`control http://127.0.0.1:${control.address().port}`);
  console.log(`ready at https://${parseListen(srv.settings.server.listen).host === '0.0.0.0' ? 'localhost' : 'localhost'}:${port}`);
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { control.close(); srv.close().finally(() => process.exit(0)); });
