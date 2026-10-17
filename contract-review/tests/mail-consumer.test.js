// SPDX-License-Identifier: GPL-3.0-or-later
// Mail capture on the team server (product v2 spec 7.2, 11.1 "Mail"; PR-IN-03, 04, 05, PR-SEC-02, PR-TEAM-04): the
// consumer loop over the simulated mailbox (the ported BogusMailBox behind a fake imapflow client), with the SSRF guard,
// the folder-missing error, the back-off, a UIDVALIDITY change, Message-ID de-duplication, size limits, documents we
// do not file, the .eml-only capture, malformed mail, and the expiry of the OAuth token. Captures go to the document
// store (plan task 9): here the in-memory fake (server/store/fake.js). No real mail server, DNS answer, Microsoft
// endpoint or Paperless is contacted.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalRecord } from '../server/record/local.js';
import { extractText } from '../server/record/files.js';
import { extractTextInWorker } from '../server/record/extract.js';
import { readServerSettings, SERVER_DEFAULTS } from '../server/settings.js';
import { createMailConsumer, backoffMinutes, mailConfigProblems, builtInRules, CHECK_FLAG } from '../server/mail/consumer.js';
import { tokenProvider, readClientSecret, REFRESH_MARGIN_MS } from '../server/mail/oauth.js';
import { serverDataDir, quiet, cleanEnv } from './fixtures/team.js';
import { createFakeStore } from '../server/store/fake.js';
import { tempDir } from './fixtures/record/helpers.js';
import { sharedMailbox, mailDeps, mailSettings, forwardedEmail, docxAttachment, fakeTokens, AttachmentDef, MAILBOX, PUBLIC_IP } from './fixtures/mail.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const NDA = readFileSync(path.join(root, 'data/fixtures/history/helix-brightwater-nda-v1.docx'));
const NDA3 = readFileSync(path.join(root, 'data/fixtures/history/helix-brightwater-nda-v3-helix-counter.docx'));
const LONG = 'Dear Ada, thank you for the draft. We have reviewed the confidentiality obligations and the term, and we would like to discuss clause 4 on the call tomorrow. Our position on the non-solicitation clause is unchanged. Kind regards, Legal';
const log = { ...quiet, log() {}, debug() {}, info() {} };

const MAIL_DATE = new Date('2026-10-14T16:30:00Z');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BRIGHTWATER = 'Brightwater Analytics Ltd';

/**
 * A record (the processed-mail bookkeeping), a fake document store (the captures), server settings with mail on, a
 * mailbox and a consumer over them, at a controllable clock. `counterparties` are made in the store first.
 */
async function setup({ mail = {}, mailbox = sharedMailbox(), deps = {}, t0 = Date.parse('2026-10-15T09:00:00Z'), opts = {}, counterparties = [] } = {}) {
  const fake = createFakeStore();
  await fake.ensureBaseTaxonomy();
  for (const name of counterparties) await fake.taxonomy.counterparties.create({ name });
  const dataDir = tempDir('mail-');
  serverDataDir(dataDir, { mail: { ...mailSettings(dataDir), ...mail } });
  const { settings } = readServerSettings(dataDir);
  let t = t0;
  // The record shares the consumer's clock, so "the last 24 hours" on the status page is measured from the test's time,
  // not the real one (the test failed once real time passed t0 + 24h, 16 Oct).
  const record = openLocalRecord({ dataDir, mode: 'team', now: () => new Date(t).toISOString() });
  const clock = () => t;
  // The store as the consumer sees it, noting the actor of every write.
  const actors = [];
  const spy = Object.assign(Object.create(fake), {
    add: (b, m, o) => { actors.push(o?.actor); return fake.add(b, m, o); },
    notes: { ...fake.notes, add: (id, text, o) => { actors.push(o?.actor); return fake.notes.add(id, text, o); } },
  });
  const consumer = createMailConsumer({ record, settings, log, clock, now: () => new Date(t).toISOString(), documents: opts.documents || (() => spy), deps: { ...mailDeps(mailbox), extract: extractText, ...deps }, ...opts });
  return { dataDir, settings, record, fake, actors, mailbox, consumer, db: record.internal.db, advance: ms => { t += ms; }, clock };
}
/** Every document in a store, oldest first, with its notes' text. */
async function stored(store) {
  const { results } = await store.list({ pageSize: 100 });
  return Promise.all(results.sort((a, b) => a.id - b.id).map(async d => ({ ...d, notes: (await store.notes.list(d.id)).map(n => n.text) })));
}
const docCount = async s => (await stored(s.fake)).length;
const rows = db => db.prepare('SELECT folder, uidvalidity, uid, message_id, outcome, detail FROM processed_mail ORDER BY processed_at, folder, uid').all();
const titles = mb => name => mb.folder(name)?.messages.map(m => m.meta.subject) || [];

describe('capture (7.2 steps 1 to 6; PR-IN-03, PR-IN-04)', () => {
  test('a forwarded email in the inbox and one dragged to "To file" each become store documents: the covering .eml (type Email) and every contract attachment (with a note naming it), all tagged inbox, dated by the email, matched to a counterparty; both end in Filed', async () => {
    const s = await setup({ counterparties: [BRIGHTWATER, 'Acme'] });
    await s.mailbox.deliver(forwardedEmail({ subject: 'FW: Brightwater NDA', body: 'Forwarding their markup.', date: MAIL_DATE, attachments: [docxAttachment('Brightwater NDA v1.docx', NDA), docxAttachment('Brightwater NDA v3.docx', NDA3), new AttachmentDef({ filename: 'logo.png', maintype: 'image', subtype: 'png', content: Buffer.from('png') })] }));
    s.mailbox.addFolder('To file', 300);
    await s.mailbox.deliver(forwardedEmail({ subject: 'Acme order form', from: 'Legal <legal@acme.example>', date: MAIL_DATE, attachments: [new AttachmentDef({ filename: 'Order form.pdf', content: Buffer.from('%PDF-1.7 order form') })] }), { folder: 'To file' });

    const r = await s.consumer.runCheck();
    assert.equal(r.ok, true, r.error?.message);
    const docs = await stored(s.fake);
    const by = title => docs.find(d => d.title === title);
    assert.deepEqual(docs.map(d => [d.title, d.type, d.tags, d.created, d.counterparty]).sort(), [
      ['Acme order form', 'Email', ['inbox'], '2026-10-14', 'Acme'],
      ['Brightwater NDA v1', null, ['inbox'], '2026-10-14', BRIGHTWATER],
      ['Brightwater NDA v3', null, ['inbox'], '2026-10-14', BRIGHTWATER],
      ['FW Brightwater NDA', 'Email', ['inbox'], '2026-10-14', null],
      ['Order form', null, ['inbox'], '2026-10-14', 'Acme'],
    ].sort());
    assert.deepEqual([by('FW Brightwater NDA').originalName, by('FW Brightwater NDA').mimeType, by('Brightwater NDA v1').originalName], ['FW Brightwater NDA.eml', 'message/rfc822', 'Brightwater NDA v1.docx']);
    const emailId = by('FW Brightwater NDA').id;
    assert.deepEqual([by('Brightwater NDA v1').notes, by('Brightwater NDA v3').notes], [[`Came with email: FW: Brightwater NDA (document ${emailId})`], [`Came with email: FW: Brightwater NDA (document ${emailId})`]], 'several attachments name the one covering email');
    assert.deepEqual(by('Order form').notes, [`Came with email: Acme order form (document ${by('Acme order form').id})`]);
    assert.deepEqual(by('FW Brightwater NDA').notes, []);
    assert.equal(by('Brightwater NDA v1').checksum, createHash('sha256').update(NDA).digest('hex'), 'the attachment is stored as it came');
    assert.equal(s.actors.length, 8, 'five documents and three notes');
    assert.ok(s.actors.every(a => a?.name === 'system:mail' && a.admin === false), 'written as system:mail, never as an admin');
    assert.deepEqual(titles(s.mailbox)('Filed').sort(), ['Acme order form', 'FW: Brightwater NDA']);
    assert.deepEqual([titles(s.mailbox)('INBOX'), titles(s.mailbox)('To file')], [[], []]);
    assert.deepEqual(rows(s.db).map(x => [x.folder, x.outcome, x.detail]).sort(), [['INBOX', 'captured', '2 attachments'], ['To file', 'captured', '1 attachment']]);
    const st = s.consumer.status();
    assert.deepEqual([st.last_error, st.consecutive_failures, st.next_check_at], [null, 0, '2026-10-15T09:10:00.000Z']);
    assert.ok(s.mailbox.folder('Not filed'), 'the server creates Filed and Not filed');
  });

  test('polling twice over the same mailbox captures each message once (PR-IN-04), even when the move to Filed failed', async () => {
    const s = await setup();
    await s.mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }));
    s.mailbox.refuseCreate.add('Filed');
    await s.consumer.runCheck();
    assert.equal(s.mailbox.folder('INBOX').messages.length, 1, 'still in the inbox: Filed is missing');
    assert.match(s.consumer.status().last_error, /Folder 'Filed' not found in the mailbox/);
    // The rule needs its Filed folder (Paperless checks the move target first), so nothing was captured yet.
    assert.equal(await docCount(s), 0);
    s.mailbox.refuseCreate.clear();
    await s.consumer.runCheck(); await s.consumer.runCheck();
    assert.deepEqual((await stored(s.fake)).map(d => [d.title, d.type]), [['FW Mutual NDA, our comments', 'Email'], ['NDA', null]]);
    assert.equal(rows(s.db).length, 1);
  });

  test('a message with no document and a long body is captured as the .eml alone; a short one is no-attachment; both are filed', async () => {
    const s = await setup();
    await s.mailbox.deliver(forwardedEmail({ subject: 'Our position on clause 4', body: LONG }));
    await s.mailbox.deliver(forwardedEmail({ subject: 'Thanks', body: 'Thanks!' }));
    await s.consumer.runCheck();
    const docs = await stored(s.fake);
    assert.deepEqual(docs.map(d => [d.title, d.originalName, d.mimeType, d.type, d.tags, d.notes]), [['Our position on clause 4', 'Our position on clause 4.eml', 'message/rfc822', 'Email', ['inbox'], []]]);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0, 'the record inbox no longer receives mail');
    assert.deepEqual(rows(s.db).map(r => [r.outcome, r.detail]), [['captured', 'email only'], ['no-attachment', null]]);
    assert.equal(s.mailbox.folder('Filed').messages.length, 2);
  });

  test('attachments that are not documents we file (.xlsx, .zip, .doc, a .docx that is not one) are skipped with the reason; the message is still filed', async () => {
    const s = await setup();
    await s.mailbox.deliver(forwardedEmail({ subject: 'Spreadsheet', body: 'see attached', attachments: [
      new AttachmentDef({ filename: 'prices.xlsx', maintype: 'application', subtype: 'vnd.ms-excel', content: Buffer.from('PK\x03\x04xlsx') }),
      new AttachmentDef({ filename: 'old.doc', maintype: 'application', subtype: 'msword', content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]) }),
      docxAttachment('fake.docx', Buffer.from('%PDF-1.4 not a docx')),
    ] }));
    await s.consumer.runCheck();
    assert.equal(await docCount(s), 0);
    const [row] = rows(s.db);
    assert.equal(row.outcome, 'skipped');
    assert.match(row.detail, /prices\.xlsx: not a document we file/);
    assert.match(row.detail, /old\.doc: a \.doc file is not a document we file; save it as \.docx/);
    assert.match(row.detail, /fake\.docx: not a document we file/);
    assert.equal(s.mailbox.folder('Filed').messages.length, 1);
  });

  test('an attachment over mail.attachments.maxBytes lands in Not filed with the reason on the status page; nothing is captured from it', async () => {
    const s = await setup({ mail: { attachments: { ...SERVER_DEFAULTS.mail.attachments, maxBytes: 20_000 } } });
    await s.mailbox.deliver(forwardedEmail({ subject: 'Big one', attachments: [docxAttachment('NDA.docx', NDA), docxAttachment('Huge.docx', Buffer.concat([NDA, Buffer.alloc(30_000)]))] }));
    await s.consumer.runCheck();
    assert.equal(await docCount(s), 0);
    assert.equal(s.mailbox.folder('Not filed').messages.length, 1);
    const [row] = rows(s.db);
    assert.equal(row.outcome, 'failed');
    assert.match(row.detail, /the attachment Huge\.docx is .* over the limit of 0\.0 MB/);
    assert.match(s.consumer.status().last_error, /"Big one" not filed: the attachment Huge\.docx/);
    assert.equal(s.consumer.status().consecutive_failures, 0, 'a message that fails is not a failed check');
    assert.equal((await s.record.admin.status()).mail.processed24h.failed, 1);
  });

  test('a message over the 25 MB a stored email may be is not downloaded and lands in Not filed', async () => {
    const s = await setup();
    const m = await s.mailbox.deliver(forwardedEmail({ subject: 'Enormous' }));
    m.raw = Buffer.concat([m.raw, Buffer.alloc(26 * 1024 * 1024, 0x41)]);
    await s.consumer.runCheck();
    assert.equal(s.mailbox.calls.filter(c => c[0] === 'fetchOne').length, 0, 'the body was not fetched');
    assert.deepEqual(rows(s.db).map(r => r.outcome), ['failed']);
    assert.match(rows(s.db)[0].detail, /over the 25 MB a stored email may be/);
    assert.equal(s.mailbox.folder('Not filed').messages.length, 1);
  });

  test('malformed mail: a body the server cannot return is failed; a broken multipart is still read; a corrupt .docx fails that capture\'s text only', async () => {
    const s = await setup();
    const lost = await s.mailbox.deliver(forwardedEmail({ subject: 'Lost body' }));
    const broken = Buffer.from('Message-ID: <broken@x>\r\nSubject: Broken\r\nFrom: a@acme.example\r\nContent-Type: multipart/mixed; boundary="zz"\r\n\r\n--zz\r\nContent-Type: text/plain\r\n\r\nhello\r\n--zz\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="Corrupt.docx"\r\nContent-Disposition: attachment; filename="Corrupt.docx"\r\nContent-Transfer-Encoding: base64\r\n\r\nUEsDBAo=not-base64-at-all!!\r\n');
    await s.mailbox.deliver(broken);
    // The server returns no body for the first message, as one does when the message vanished between calls.
    lost.raw = Buffer.alloc(0);
    await s.consumer.runCheck();
    const out = Object.fromEntries(rows(s.db).map(r => [r.uid, [r.outcome, r.detail]]));
    assert.equal(out[1][0], 'failed');
    assert.match(out[1][1], /could not be read \(The server returned no message body\.\)/);
    assert.equal(out[2][0], 'captured');
    // The corrupt .docx is still stored (its text could not be read, so matching had none); the email with it too.
    assert.deepEqual((await stored(s.fake)).map(d => [d.originalName, d.type]), [['Broken.eml', 'Email'], ['Corrupt.docx', null]]);
  });

  test('PR-IN-05: only the two configured folders are read; nothing else in the mailbox is touched', async () => {
    const s = await setup();
    s.mailbox.addFolder('Personal', 9); s.mailbox.addFolder('Sent Items', 10);
    await s.mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }), { folder: 'Personal' });
    await s.mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }), { folder: 'Sent Items' });
    await s.consumer.runCheck();
    assert.equal(await docCount(s), 0);
    assert.deepEqual([...new Set(s.mailbox.calls.filter(c => c[0] === 'search').map(c => c[1]))].sort(), ['INBOX', 'To file']);
    assert.deepEqual(builtInRules(s.settings.mail).map(r => r.folder), ['INBOX', 'To file']);
    assert.equal(s.mailbox.folder('Personal').messages.length, 1);
    assert.equal(s.mailbox.folder('Sent Items').messages.length, 1);
  });
});

describe('never twice (7.2 "Fails when": UIDVALIDITY, Message-ID)', () => {
  test('a re-delivery of the same Message-ID is skipped ("already processed") and filed, not captured twice', async () => {
    const s = await setup();
    const raw = forwardedEmail({ messageId: '<nda-42@acme.example>', attachments: [docxAttachment('NDA.docx', NDA)] });
    await s.mailbox.deliver(raw);
    await s.consumer.runCheck();
    await s.mailbox.deliver(raw);
    await s.consumer.runCheck();
    assert.deepEqual((await stored(s.fake)).map(d => d.title), ['FW Mutual NDA, our comments', 'NDA'], 'one email and its attachment, once');
    assert.deepEqual(rows(s.db).map(r => [r.uid, r.outcome, r.detail]), [[1, 'captured', '1 attachment'], [2, 'skipped', 'already processed']]);
    assert.equal(s.mailbox.folder('Filed').messages.length, 2);
  });

  test('UIDVALIDITY changes: old rows are kept, new rows use the new value, a known Message-ID is skipped and a new message on a reused UID is captured', async () => {
    const s = await setup();
    await s.mailbox.deliver(forwardedEmail({ messageId: '<kept@acme.example>', attachments: [docxAttachment('NDA.docx', NDA)] }));
    await s.consumer.runCheck();
    assert.deepEqual(rows(s.db).map(r => [r.uidvalidity, r.uid, r.outcome]), [[100, 1, 'captured']]);
    // The server rebuilds INBOX under a new UIDVALIDITY: a new message takes UID 1 again, and the filed message
    // comes back (a user restores it) as UID 2.
    await s.mailbox.deliver(forwardedEmail({ messageId: '<new@acme.example>', subject: 'New round', attachments: [docxAttachment('NDA v3.docx', NDA3)] }));
    s.mailbox.folder('INBOX').messages.push(...s.mailbox.folder('Filed').messages.splice(0));
    s.mailbox.resetUids('INBOX', 101);
    await s.consumer.runCheck();
    assert.deepEqual(rows(s.db).map(r => [r.uidvalidity, r.uid, r.outcome, r.detail]), [[100, 1, 'captured', '1 attachment'], [101, 1, 'captured', '1 attachment'], [101, 2, 'skipped', 'already processed']]);
    assert.deepEqual((await stored(s.fake)).filter(d => !d.type).map(d => d.originalName).sort(), ['NDA v3.docx', 'NDA.docx']);
  });

  test('a message that failed may be dragged back to "To file" and is tried again', async () => {
    const s = await setup({ mail: { attachments: { ...SERVER_DEFAULTS.mail.attachments, maxBytes: 20_000 } } });
    const raw = forwardedEmail({ messageId: '<retry@acme.example>', attachments: [docxAttachment('Big.docx', Buffer.concat([NDA, Buffer.alloc(30_000)]))] });
    await s.mailbox.deliver(raw);
    await s.consumer.runCheck();
    assert.equal(rows(s.db)[0].outcome, 'failed');
    s.settings.mail.attachments.maxBytes = 26214400; // the admin raises the limit
    const back = s.mailbox.folder('Not filed').messages.splice(0);
    s.mailbox.folder('To file').messages.push(...back.map(m => ({ ...m, uid: s.mailbox.folder('To file').uidNext++ })));
    await s.consumer.runCheck();
    assert.deepEqual(rows(s.db).map(r => [r.folder, r.outcome]), [['INBOX', 'failed'], ['To file', 'captured']]);
  });
});

describe('failures of the check itself (7.2 "Fails when")', () => {
  test('the folder is missing: "Folder \'To file\' not found in the mailbox", no capture from that rule, the inbox rule still runs', async () => {
    const s = await setup();
    s.mailbox.refuseCreate.add('To file');
    await s.mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }));
    const r = await s.consumer.runCheck();
    assert.equal(r.ok, true);
    assert.equal(await docCount(s), 2);
    assert.equal(s.consumer.status().last_error, "Folder 'To file' not found in the mailbox.");
  });

  test('back-off: token or sign-in failures double the wait from the interval up to an hour; a good check resets it', async () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(n => backoffMinutes(10, n)), [20, 40, 60, 60, 60]);
    assert.equal(backoffMinutes(90, 1), 90);
    const failing = { calls: 0, async get() { this.calls++; throw Object.assign(new Error('Could not get a Microsoft 365 access token: invalid_client.'), { code: 'mail_token' }); }, invalidate() {} };
    const s = await setup({ deps: { tokens: failing } });
    const t = s.clock();
    for (const [n, minutes] of [[1, 20], [2, 40], [3, 60], [4, 60]]) {
      const r = await s.consumer.runCheck();
      assert.equal(r.ok, false);
      const st = s.consumer.status();
      assert.deepEqual([st.consecutive_failures, st.next_check_at, st.last_error], [n, new Date(s.clock() + minutes * 60_000).toISOString(), 'Could not get a Microsoft 365 access token: invalid_client.']);
      s.advance(minutes * 60_000);
    }
    assert.ok(s.clock() > t);
    failing.get = async () => ({ accessToken: 'token-1', expiresOn: new Date(s.clock() + 3600_000) });
    assert.equal((await s.consumer.runCheck()).ok, true);
    assert.deepEqual([s.consumer.status().consecutive_failures, s.consumer.status().last_error], [0, null]);
  });

  test('OAuth token expiry: a token the mailbox refuses is dropped and one new token is fetched; a second refusal is a sign-in failure', async () => {
    const mailbox = sharedMailbox(); mailbox.accessToken = 'token-2'; // the cached token-1 has expired at Microsoft
    const tokens = fakeTokens();
    const s = await setup({ mailbox, deps: { tokens } });
    await mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }));
    assert.equal((await s.consumer.runCheck()).ok, true);
    assert.equal(tokens.calls(), 2);
    assert.equal(await docCount(s), 2);
    mailbox.accessToken = 'never';
    const r = await s.consumer.runCheck();
    assert.equal(r.ok, false);
    assert.match(s.consumer.status().last_error, /^The mailbox refused the sign-in for contracts@firm\.example: AUTHENTICATE failed\. Check the app registration/);
    assert.equal(s.consumer.status().consecutive_failures, 1);
  });

  test('the token provider caches until 5 minutes before expiry, reads the secret from its 0600 file, and refuses a readable one', async () => {
    let t = 0; const calls = [];
    const dir = tempDir('secret-'); const file = path.join(dir, 'secret'); writeFileSync(file, 's3cret\n'); chmodSync(file, 0o600);
    const p = tokenProvider({ tenantId: 'contoso.onmicrosoft.com', clientId: 'c', clientSecretFile: file, now: () => t, acquire: async a => { calls.push(a); return { accessToken: `t${calls.length}`, expiresOn: new Date(t + 3600_000) }; } });
    assert.equal((await p.get()).accessToken, 't1');
    t = 3600_000 - REFRESH_MARGIN_MS - 1; assert.equal((await p.get()).accessToken, 't1');
    t = 3600_000 - REFRESH_MARGIN_MS + 1; assert.equal((await p.get()).accessToken, 't2');
    p.invalidate(); assert.equal((await p.get()).accessToken, 't3');
    assert.deepEqual(calls[0], { tenantId: 'contoso.onmicrosoft.com', clientId: 'c', clientSecret: 's3cret' });
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644);
      assert.throws(() => readClientSecret(file), e => e.code === 'mail_secret_mode' && /chmod 600/.test(e.message));
    }
    await assert.rejects(tokenProvider({ tenantId: 'evil.example/x?', clientId: 'c', clientSecretFile: file, acquire: async () => assert.fail('asked') }).get(), e => e.code === 'mail_settings');
    const failing = tokenProvider({ tenantId: 't', clientId: 'c', clientSecretFile: file, readSecret: () => 'x', acquire: async () => { throw Object.assign(new Error('AADSTS7000215: Invalid client secret provided.\nTrace ID: 1'), { errorCode: 'invalid_client', errorMessage: 'AADSTS7000215: Invalid client secret provided.\nTrace ID: 1' }); } });
    await assert.rejects(failing.get(), e => e.code === 'mail_token' && e.message === 'Could not get a Microsoft 365 access token: invalid_client (AADSTS7000215: Invalid client secret provided.).');
  });

  test('incomplete settings stop the check with the reasons and make no connection', async () => {
    const s = await setup({ mail: { auth: { ...SERVER_DEFAULTS.mail.auth, tenantId: null, mailbox: 'a@x.example, b@x.example' } } });
    const r = await s.consumer.runCheck();
    assert.equal(r.ok, false);
    assert.match(s.consumer.status().last_error, /mail\.auth\.tenantId is not set\..* mail\.auth\.mailbox is one mailbox address/);
    assert.equal(s.mailbox.connections.length, 0);
    assert.deepEqual(mailConfigProblems({ ...SERVER_DEFAULTS.mail, auth: { ...SERVER_DEFAULTS.mail.auth, tenantId: 't', clientId: 'c', mailbox: MAILBOX } }), []);
  });
});

describe('PR-SEC-02: the SSRF guard (spec 10.B.6, ported PinnedIMAP4 behaviour)', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1']) {
    test(`mail.host ${host} is refused with mail_private_address by default; no connection is made`, async () => {
      const s = await setup({ mail: { host } });
      const r = await s.consumer.runCheck();
      assert.equal(r.code, 'mail_private_address');
      assert.match(s.consumer.status().last_error, new RegExp(`^mail_private_address: Connection blocked: ${host.replace(/[.:]/g, '\\$&')} resolves to a non-public address \\(${host.replace(/[.:]/g, '\\$&')}\\)\\. The server connects only to public addresses`));
      assert.equal(s.mailbox.connections.length, 0);
      console.log(`SSRF guard: ${host} -> ${r.code}`);
    });
  }

  test('a name that resolves to 10.0.0.1 (or to any private address among public ones) is refused; DNS is asked once', async () => {
    let lookups = 0;
    const s = await setup({ mail: { host: 'mail.internal.example' }, deps: { lookup: async () => { lookups++; return [{ address: '52.97.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]; } } });
    const r = await s.consumer.runCheck();
    assert.equal(r.code, 'mail_private_address');
    assert.equal(lookups, 1);
    assert.equal(s.mailbox.connections.length, 0);
    console.log(`SSRF guard: mail.internal.example (10.0.0.1) -> ${r.code}`);
  });

  test('the connection goes to the address that was checked, with the configured name for TLS SNI and the certificate', async () => {
    const s = await setup();
    await s.consumer.runCheck();
    const c = s.mailbox.connections[0];
    assert.deepEqual([c.host, c.servername, c.port, c.secure, c.tls.rejectUnauthorized, c.auth.user, c.auth.accessToken], [PUBLIC_IP, 'outlook.office365.com', 993, true, true, MAILBOX, 'token-1']);
  });

  test('mail.allowPrivateAddresses: true lets a private address through, still resolved once and pinned', async () => {
    const s = await setup({ mail: { host: 'imap.office.lan', allowPrivateAddresses: true }, deps: { lookup: async () => [{ address: '10.0.0.25', family: 4 }] } });
    assert.equal((await s.consumer.runCheck()).ok, true);
    assert.deepEqual([s.mailbox.connections[0].host, s.mailbox.connections[0].servername], ['10.0.0.25', 'imap.office.lan']);
  });
});

describe('schedule, "check mail now" and the worker cap', () => {
  test('checkNow answers at once with startedAt; a second call while it runs names the same check', async () => {
    const s = await setup();
    const a = s.consumer.checkNow(); const b = s.consumer.checkNow();
    assert.match(a.startedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(a.startedAt, b.startedAt);
    await s.consumer.runCheck();
  });

  test('gcl mail check inside the container: the flag file starts a check within the poll', async () => {
    const s = await setup({ opts: { flagPollMs: 50, startDelayMs: 60_000 } });
    s.consumer.start();
    writeFileSync(path.join(s.dataDir, CHECK_FLAG), '');
    const started = Date.now();
    while (existsSync(path.join(s.dataDir, CHECK_FLAG)) && Date.now() - started < 8000) await new Promise(r => setTimeout(r, 100));
    assert.equal(existsSync(path.join(s.dataDir, CHECK_FLAG)), false);
    await s.consumer.stop();
  });

  test('text extraction runs in a worker with a time cap; a timeout still stores the document, matched without its text', async () => {
    const ok = await extractTextInWorker(NDA, DOCX, 'NDA.docx');
    assert.equal(ok.textStatus, 'extracted');
    assert.ok(ok.paragraphs.length > 5);
    const slow = await extractTextInWorker(NDA, DOCX, 'NDA.docx', { timeoutMs: 1 });
    assert.deepEqual([slow.textStatus, slow.warnings[0]], ['failed', 'Text extraction took longer than 0 seconds.']);
    const s = await setup({ counterparties: [BRIGHTWATER], deps: { extract: (b, m, n) => extractTextInWorker(b, m, n, { timeoutMs: 1 }) } });
    await s.mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }));
    await s.consumer.runCheck();
    assert.deepEqual((await stored(s.fake)).map(d => [d.originalName, d.counterparty]), [['FW Mutual NDA, our comments.eml', null], ['NDA.docx', null]]);
    assert.deepEqual(rows(s.db).map(r => r.outcome), ['captured']);
  });

  test('the consumer extracts through the worker by default: the counterparty named in the document\'s text is matched', async () => {
    const s = await setup({ counterparties: [BRIGHTWATER], deps: { extract: undefined } });
    await s.mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }));
    await s.consumer.runCheck();
    assert.deepEqual((await stored(s.fake)).map(d => [d.title, d.counterparty]), [['FW Mutual NDA, our comments', null], ['NDA', BRIGHTWATER]]);
  });
});

describe('the team server runs the consumer (S7 notes; 6.2.1 POST /admin/mail/check)', () => {
  test('with mail.enabled the server starts the consumer on listen and the store GCL_STORE names; "check mail now" answers 202 { startedAt }; the capture is in the store at once; close stops it', async () => {
    const { startTeam } = await import('./fixtures/team.js');
    const dataDir = tempDir('team-mail-');
    serverDataDir(dataDir, { mail: mailSettings(dataDir) });
    const mailbox = sharedMailbox();
    const team = await startTeam({ dataDir, env: cleanEnv({ GCL_STORE: 'fake' }), mailDeps: { ...mailDeps(mailbox), extract: extractText } });
    try {
      const ada = await team.member('Ada Admin', true);
      const ben = await team.member('Ben Member');
      await mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('Brightwater NDA.docx', NDA)] }));
      const r = await ada.remote.admin.checkMailNow();
      assert.match(r.startedAt, /^\d{4}-/);
      await assert.rejects(ben.remote.admin.checkMailNow(), e => e.code === 'forbidden');
      await team.srv.mail.runCheck();
      const docs = await stored(team.srv.store.serviceClient());
      assert.deepEqual(docs.map(d => [d.originalName, d.type, d.tags]), [['FW Mutual NDA, our comments.eml', 'Email', ['inbox']], ['Brightwater NDA.docx', null, ['inbox']]]);
      assert.equal(ben.remote.inbox, undefined, 'the record has no inbox: mail goes to the store');
      const status = await ada.remote.admin.status();
      assert.deepEqual([status.mail.enabled, status.mail.mailbox, status.mail.lastError, status.mail.processed24h.captured], [true, MAILBOX, null, 1]);
      const actors = await ada.remote.actors?.();
      if (actors) assert.equal(actors['system:mail'], 'Mailbox');
    } finally {
      await team.close();
    }
  });
});

describe('the document store (plan task 9)', () => {
  test('a store that is unavailable, or a consume task that fails, fails the message: Not filed, outcome failed with the reason; a later check captures it once dragged back', async () => {
    let up = false; let fake = null;
    const s = await setup({ opts: { documents: () => { if (!up) throw Object.assign(new Error('The document store is unavailable.'), { status: 503, code: 'store_unavailable' }); return fake; } } });
    fake = s.fake;
    await s.mailbox.deliver(forwardedEmail({ subject: 'Store down', messageId: '<down@acme.example>', attachments: [docxAttachment('NDA.docx', NDA)] }));
    await s.consumer.runCheck();
    assert.deepEqual(rows(s.db).map(r => [r.outcome, r.detail]), [['failed', 'The document store is unavailable.']]);
    assert.deepEqual(titles(s.mailbox)('Not filed'), ['Store down']);
    assert.match(s.consumer.status().last_error, /"Store down" not filed: The document store is unavailable\./);
    assert.equal(s.consumer.status().consecutive_failures, 0, 'a message that fails is not a failed check');

    up = true; s.fake.failNextTask('Unsupported mime type.');
    await s.mailbox.deliver(forwardedEmail({ subject: 'Task fails', attachments: [docxAttachment('NDA.docx', NDA)] }));
    await s.consumer.runCheck();
    assert.deepEqual(rows(s.db).at(-1).outcome, 'failed');
    assert.match(rows(s.db).at(-1).detail, /could not process it: Unsupported mime type\./);
    assert.deepEqual(titles(s.mailbox)('Not filed'), ['Store down', 'Task fails']);

    const back = s.mailbox.folder('Not filed').messages.splice(0, 1);
    s.mailbox.folder('To file').messages.push(...back.map(m => ({ ...m, uid: s.mailbox.folder('To file').uidNext++ })));
    await s.consumer.runCheck();
    assert.deepEqual(rows(s.db).at(-1).outcome, 'captured');
    assert.ok((await stored(s.fake)).some(d => d.title === 'Store down'));
  });

  test('createTeamServer hands the consumer the store service it is given (started already: not started again)', async () => {
    const { createTeamServer } = await import('../server/team-server.js');
    const { createStoreService, storeConfig } = await import('../server/store/service.js');
    const dataDir = tempDir('team-store-');
    serverDataDir(dataDir, { mail: mailSettings(dataDir) });
    const service = createStoreService({ config: storeConfig({ settings: { mode: 'fake' }, dataDir }), log });
    await service.start();
    await service.serviceClient().taxonomy.counterparties.create({ name: BRIGHTWATER });
    const mailbox = sharedMailbox();
    const srv = await createTeamServer({ dataDir, env: cleanEnv(), log, store: service, mailDeps: { ...mailDeps(mailbox), extract: extractText } });
    try {
      assert.equal(srv.store, service);
      await mailbox.deliver(forwardedEmail({ subject: 'Brightwater NDA', attachments: [docxAttachment('Brightwater NDA.docx', NDA)] }));
      assert.equal((await srv.mail.runCheck()).ok, true);
      assert.deepEqual((await stored(service.serviceClient())).map(d => [d.title, d.counterparty]), [['Brightwater NDA', null], ['Brightwater NDA', BRIGHTWATER]], 'the counterparty made before survives: the service was not started again');
    } finally { await srv.close(); }
  });

  test('without a store (GCL_STORE unset: off) the team server still starts; a capture fails as "store unavailable"', async () => {
    const { createTeamServer } = await import('../server/team-server.js');
    const dataDir = tempDir('team-nostore-');
    serverDataDir(dataDir, { mail: mailSettings(dataDir) });
    const mailbox = sharedMailbox();
    const srv = await createTeamServer({ dataDir, env: cleanEnv(), log, mailDeps: { ...mailDeps(mailbox), extract: extractText } });
    try {
      assert.equal(srv.store.status().mode, 'off');
      await mailbox.deliver(forwardedEmail({ attachments: [docxAttachment('NDA.docx', NDA)] }));
      await srv.mail.runCheck();
      assert.deepEqual(srv.record.internal.db.prepare('SELECT outcome, detail FROM processed_mail').all().map(r => [r.outcome, r.detail]), [['failed', 'The document store is unavailable.']]);
    } finally { await srv.close(); }
  });
});

describe('gcl mail check (9.3)', () => {
  test('solo mode has no mailbox; a server folder with mail off says so; with the server running it asks the server through the flag file', async () => {
    const { main } = await import('../bin/gcl.js');
    const out = []; const log = l => out.push(l);
    assert.equal(await main(['--data', tempDir('solo-'), 'mail', 'check'], { log, env: {} }), 1);
    assert.equal(out.pop(), 'There is no mailbox in solo mode.');
    const off = serverDataDir(tempDir('srv-off-'));
    assert.equal(await main(['--data', off, 'mail', 'check'], { log, env: {} }), 1);
    assert.equal(out.pop(), 'Mail capture is off: set mail.enabled in the settings file.');
    const on = tempDir('srv-on-'); serverDataDir(on, { mail: mailSettings(on) });
    writeFileSync(path.join(on, 'server.pid'), String(process.ppid)); // a live process that is not this one: "the server"
    assert.equal(await main(['--data', on, 'mail', 'check'], { log, env: {} }), 0);
    assert.match(out.pop(), /^Mail check requested from the running server \(pid \d+\)/);
    assert.ok(existsSync(path.join(on, CHECK_FLAG)));
    assert.equal(await main(['--data', on, 'mail', 'nonsense'], { log, env: {} }), 2);
  });
});
