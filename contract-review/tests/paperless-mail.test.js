// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Paperless-ngx (https://github.com/paperless-ngx/paperless-ngx), GPL-3.0.
//   Source: src/paperless_mail/tests/test_mail.py, src/paperless_mail/tests/test_mail_nfc.py and
//   src/paperless/tests/test_network.py, commit c50c6f5517e3fd8f97fa546ede69a52b622e2b20 (kept unchanged in
//   server/ports/paperless/reference/).
//   Modified: translated to JavaScript for GinChugger, 15 October 2026 (product v2 spec 10.B.3). Each test keeps
//   its Paperless name and assertions. The Django objects are plain data; `queue_consumption_tasks` is the injected
//   function the handler is built with; `apply_mail_actions` applies each queued rule action over a fresh connection to
//   the same simulated mailbox, as the Celery chord would. The simulated mailbox is BogusMailBox at the imapflow client
//   boundary (tests/fixtures/paperless/bogus-mailbox.js), so every test also runs the imapflow adapter and mailparser.
//   Not ported (Django, Celery or multi-account plumbing this product does not have): test_post_consume_*,
//   TestErrorCallback, TestManagementCommand, TestTasks, TestMailAccountTestView, TestMailAccountProcess,
//   TestMailRuleAPI, test_error_skip_account (several accounts), and test_network.py's httpx transport tests.
//   The section "semantics sheet" at the end is ours: spec 10.B.4's fixtures, not Paperless tests.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MailAccountHandler, MailError, TagMailAction, getMailbox, applyMailAction, makeCriterias, fnmatch, mailRule,
  MailAction, ConsumptionScope, AttachmentProcessing, TitleSource, CorrespondentSource, ImapSecurity, MATCH_LITERAL,
} from '../server/ports/paperless/mail.js';
import { isPublicIp } from '../server/ports/paperless/network.js';
import { ImapFlowMailBox, toMailMessage } from '../server/mail/imapflow-mailbox.js';
import { BogusMailBox, MessageBuilder, AttachmentDef, bogusImapFlow, resetBogusMailbox, fakeMagicFromBuffer, buildRaw } from './fixtures/paperless/bogus-mailbox.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const SUPPORTED = new Set(['application/pdf']); // documents.parsers.is_mime_type_supported, as far as these tests need

function memoryProcessed() {
  const rows = [];
  const same = (r, k) => r.ruleId === k.ruleId && String(r.uid) === String(k.uid) && r.folder === k.folder;
  return {
    rows,
    async list({ ruleId, folder, uids }) { const want = new Set(uids.map(String)); return rows.filter(r => r.ruleId === ruleId && r.folder === folder && want.has(String(r.uid))); },
    async create(row) { rows.push({ uidValidity: null, ...row }); },
    async getOrCreate(key, defaults) { const f = rows.find(r => same(r, key) && (r.uidValidity ?? null) === (key.uidValidity ?? null)); if (f) return [f, false]; rows.push({ ...key, ...defaults }); return [rows[rows.length - 1], true]; },
  };
}

/** MailMocker: the simulated mailbox, the queued consumption calls, and apply_mail_actions. */
function mailMocker({ log = quiet } = {}) {
  const bogusMailbox = new BogusMailBox();
  const messageBuilder = new MessageBuilder();
  resetBogusMailbox(bogusMailbox, messageBuilder);
  const ImapFlow = bogusImapFlow(bogusMailbox);
  const queued = [];
  const processed = memoryProcessed();
  const correspondents = []; let nextCorrespondent = 1; const db = { fail: false };
  const correspondentFromName = name => {
    if (db.fail) throw new Error('DatabaseError');
    let c = correspondents.find(x => x.name === name);
    if (!c) { c = { id: nextCorrespondent++, name, match: name, matchingAlgorithm: MATCH_LITERAL }; correspondents.push(c); }
    return c;
  };
  const open = (server, port, security) => getMailbox(server, port, security, { resolve: async () => ['93.184.216.34'], createMailbox: o => new ImapFlowMailBox({ ...o, ImapFlow }) });
  const handlerOptions = { getMailbox: open, queueConsumptionTasks: args => { queued.push(args); }, processed, correspondentFromName, detectMimeType: fakeMagicFromBuffer, isMimeTypeSupported: m => SUPPORTED.has(m), log };
  const mocker = {
    bogusMailbox, messageBuilder, queued, processed, correspondents, db, ImapFlow, open,
    handler: () => new MailAccountHandler(handlerOptions),
    createCorrespondent: name => correspondentFromName(name),
    async applyMailActions() {
      for (const { message, rule } of queued.splice(0)) {
        const M = await open(rule.account.imapServer, rule.account.imapPort, rule.account.imapSecurity);
        await M.login(rule.account.username, rule.account.password);
        await M.folder.set(rule.folder);
        await applyMailAction(M, rule, { uid: message.uid, subject: message.subject, date: message.date }, { processed, log: quiet });
        await M.close();
      }
    },
    /** assert_queue_consumption_tasks_call_args */
    assertQueued(expected) {
      assert.equal(queued.length, expected.length, 'calls to queue_consumption_tasks');
      queued.forEach(({ consumeTasks }, i) => {
        assert.equal(consumeTasks.length, expected[i].length, `consume tasks in call ${i}`);
        consumeTasks.forEach((task, j) => {
          assert.ok(Buffer.isBuffer(task.inputDoc.payload) && task.inputDoc.payload.length > 0, 'the file exists');
          for (const [key, value] of Object.entries(expected[i][j])) {
            if (key === 'override_correspondent_id') assert.equal(task.overrides.correspondent?.id ?? null, value);
            else if (key === 'override_filename') assert.equal(task.overrides.filename, value);
            else if (key === 'override_title') assert.equal(task.overrides.title, value);
            else assert.fail('No match for expected arg');
          }
        });
      });
    },
    /** BogusMailBox.fetch(criteria) as the Paperless tests count: messages of INBOX matching an imapflow query. */
    async count(query) { const c = new ImapFlow({ auth: { user: 'admin', pass: 'secret' } }); await c.connect(); await c.mailboxOpen('INBOX'); return (await c.search(query, { uid: true })).length; },
  };
  return mocker;
}

let ruleIds = 0;
const account = (fields = {}) => ({ name: 'test', imapServer: '', imapPort: 993, imapSecurity: ImapSecurity.SSL, username: 'admin', password: 'secret', isToken: false, characterSet: 'UTF-8', expiration: null, rules: [], ...fields });
const addRule = (acc, fields = {}) => { const r = mailRule({ id: ++ruleIds, name: `rule-${ruleIds}`, account: acc, ...fields }); acc.rules.push(r); return r; };
const UNSEEN = { seen: false };

describe('Paperless-ngx test_mail.py TestMail', () => {
  test('test_handle_mail_account_batches_body_fetch_for_large_backlog', async () => {
    const mm = mailMocker();
    const acc = account();
    const rule = addRule(acc, { action: MailAction.MARK_READ, consumptionScope: ConsumptionScope.ATTACHMENTS_ONLY });
    const messageCount = 12;
    mm.bogusMailbox.messages = [];
    mm.bogusMailbox.put('INBOX', ...Array.from({ length: messageCount }, (_, i) => mm.messageBuilder.createMessage({ subject: `No attachment ${i}`, attachments: [] })));
    const handler = mm.handler();
    const fetchCalls = [];
    const open = handler.openMailbox;
    handler.openMailbox = async (...a) => { const M = await open(...a); const f = M.fetch.bind(M); M.fetch = args => { fetchCalls.push(args); return f({ ...args, bulk: 5 }); }; return M; };
    await handler.handleMailAccount(acc);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].uidList.length, messageCount);
    assert.equal(mm.processed.rows.filter(r => r.ruleId === rule.id).length, messageCount);
    assert.equal(mm.bogusMailbox.calls.filter(c => c[0] === 'fetchAll').length, 3, 'envelopes fetched in batches of 5');
  });

  test('test_get_correspondent', () => {
    const mm = mailMocker();
    const message = { from: 'someone@somewhere.com', fromValues: { name: 'Someone!', email: 'someone@somewhere.com' } };
    const message2 = { from: 'me@localhost.com', fromValues: { name: '', email: 'fake@localhost.com' } };
    const meLocalhost = mm.createCorrespondent(message2.from);
    const someoneElse = mm.createCorrespondent('someone else');
    const handler = mm.handler();

    assert.equal(handler.getCorrespondent(message, mailRule({ name: 'a', assignCorrespondentFrom: CorrespondentSource.FROM_NOTHING })), null);
    let rule = mailRule({ name: 'b', assignCorrespondentFrom: CorrespondentSource.FROM_EMAIL });
    let c = handler.getCorrespondent(message, rule);
    assert.ok(c);
    assert.equal(c.name, 'someone@somewhere.com');
    assert.equal(c.matchingAlgorithm, MATCH_LITERAL);
    assert.equal(c.match, 'someone@somewhere.com');
    c = handler.getCorrespondent(message2, rule);
    assert.ok(c);
    assert.equal(c.name, 'me@localhost.com');
    assert.equal(c.id, meLocalhost.id);
    rule = mailRule({ name: 'c', assignCorrespondentFrom: CorrespondentSource.FROM_NAME });
    c = handler.getCorrespondent(message, rule);
    assert.ok(c);
    assert.equal(c.name, 'Someone!');
    c = handler.getCorrespondent(message2, rule);
    assert.ok(c);
    assert.equal(c.id, meLocalhost.id);
    rule = mailRule({ name: 'd', assignCorrespondentFrom: CorrespondentSource.FROM_CUSTOM, assignCorrespondent: someoneElse });
    assert.equal(handler.getCorrespondent(message, rule), someoneElse);
  });

  test('test_get_title', () => {
    const message = { subject: 'the message title' };
    const att = { filename: 'this_is_the_file.pdf' };
    const handler = mailMocker().handler();
    assert.equal(handler.getTitle(message, att, mailRule({ name: 'a', assignTitleFrom: TitleSource.FROM_FILENAME })), 'this_is_the_file');
    assert.equal(handler.getTitle(message, att, mailRule({ name: 'b', assignTitleFrom: TitleSource.FROM_SUBJECT })), 'the message title');
    assert.equal(handler.getTitle(message, att, mailRule({ name: 'b', assignTitleFrom: TitleSource.NONE })), null);
  });

  test('test_handle_message', async () => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ subject: 'the message title', from: 'Myself', attachments: 2 }));
    const rule = mailRule({ id: 901, assignTitleFrom: TitleSource.FROM_FILENAME, account: account() });
    const result = await mm.handler().handleMessage(message, rule);
    assert.equal(result, 2);
    assert.ok(mm.queued.length);
    mm.assertQueued([[{ override_title: 'file_0', override_filename: 'file_0.pdf' }, { override_title: 'file_1', override_filename: 'file_1.pdf' }]]);
  });

  test('test_bogus_mailbox_uids_and_uid_criteria', async () => {
    const mm = mailMocker();
    const all = [...mm.bogusMailbox.messages];
    const M = new ImapFlowMailBox({ host: 'x', port: 993, ImapFlow: mm.ImapFlow });
    await M.login('admin', 'secret'); await M.folder.set('INBOX');
    // uids() returns the UIDs of unseen messages, no bodies needed to call it
    const unseen = await M.uids({ seen: false });
    assert.deepEqual(new Set(unseen), new Set(all.filter(m => !m.flags.has('\\Seen')).map(m => String(m.uid))));
    assert.equal(mm.bogusMailbox.calls.filter(c => c[0] === 'fetchOne').length, 0);
    // fetch() with an explicit UID criteria returns only the matching messages
    const target = String(all[0].uid);
    const fetched = []; for await (const m of M.fetch({ uidList: await M.uids({ uid: [target] }) })) fetched.push(m.uid);
    assert.deepEqual(fetched, [target]);
  });

  test('test_handle_empty_message', async () => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ subject: 'No attachments here', attachments: [] }));
    const owner = { id: 7, username: 'owner' };
    const rule = mailRule({ id: 902, account: account(), owner, consumptionScope: ConsumptionScope.ATTACHMENTS_ONLY });
    const handler = mm.handler();
    const result = await handler.handleMessage(message, rule);
    assert.equal(mm.queued.length, 0);
    assert.equal(result, 0);
    const rows = mm.processed.rows.filter(r => r.ruleId === rule.id && r.uid === message.uid && r.folder === rule.folder);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'PROCESSED_WO_CONSUMPTION');
    assert.equal(rows[0].owner, owner);
    // Calling it again must not create a second row
    await handler.handleMessage(message, rule);
    assert.equal(mm.processed.rows.filter(r => r.ruleId === rule.id && r.uid === message.uid && r.folder === rule.folder).length, 1);
  });

  test('test_handle_empty_message_long_subject', async () => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ subject: 'A'.repeat(300), attachments: [] }));
    const rule = mailRule({ id: 903, account: account(), consumptionScope: ConsumptionScope.ATTACHMENTS_ONLY });
    await mm.handler().handleMessage(message, rule);
    const row = mm.processed.rows.find(r => r.ruleId === rule.id && r.uid === message.uid);
    assert.equal(row.status, 'PROCESSED_WO_CONSUMPTION');
    assert.equal(row.subject, 'A'.repeat(256));
  });

  test('test_handle_unknown_mime_type', async () => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ attachments: [new AttachmentDef({ filename: 'f1.pdf' }), new AttachmentDef({ filename: 'f2.json', content: "{'much': 'payload.', 'so': 'json', 'wow': true}" })] }));
    const rule = mailRule({ id: 904, assignTitleFrom: TitleSource.FROM_FILENAME, account: account() });
    assert.equal(await mm.handler().handleMessage(message, rule), 1);
    mm.assertQueued([[{ override_filename: 'f1.pdf' }]]);
  });

  test('test_handle_disposition', async () => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ attachments: [new AttachmentDef({ filename: 'f1.pdf', disposition: 'inline' }), new AttachmentDef({ filename: 'f2.pdf' })] }));
    const rule = mailRule({ id: 905, assignTitleFrom: TitleSource.FROM_FILENAME, account: account() });
    assert.equal(await mm.handler().handleMessage(message, rule), 1);
    mm.assertQueued([[{ override_filename: 'f2.pdf' }]]);
  });

  test('test_handle_inline_files', async () => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ attachments: [new AttachmentDef({ filename: 'f1.pdf', disposition: 'inline' }), new AttachmentDef({ filename: 'f2.pdf' })] }));
    const rule = mailRule({ id: 906, assignTitleFrom: TitleSource.FROM_FILENAME, account: account(), attachmentType: AttachmentProcessing.EVERYTHING });
    assert.equal(await mm.handler().handleMessage(message, rule), 2);
    mm.assertQueued([[{ override_filename: 'f1.pdf' }, { override_filename: 'f2.pdf' }]]);
  });

  test('test_filename_filter', async t => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ attachments: ['f1.pdf', 'f2.pdf', 'f3.pdf', 'f2.png', 'file.PDf', 'f1.Pdf'].map(filename => new AttachmentDef({ filename })) }));
    const cases = [
      ['PDF Wildcard', '*.pdf', null, ['f1.pdf', 'f2.pdf', 'f3.pdf', 'file.PDf', 'f1.Pdf']],
      ['F1 PDF Only', 'f1.pdf', null, ['f1.pdf', 'f1.Pdf']],
      ['All Files', '*', null, ['f1.pdf', 'f2.pdf', 'f3.pdf', 'f2.png', 'file.PDf', 'f1.Pdf']],
      ['PNG Only', '*.png', null, ['f2.png']],
      ['PDF Files with f2 and f3', 'f2.pdf,f3*', null, ['f2.pdf', 'f3.pdf']],
      ['PDF Files without f1', '*.pdf', 'f1*', ['f2.pdf', 'f3.pdf', 'file.PDf']],
      ['PDF Files without f1 and f2', '*.pdf', 'f1*,f2*', ['f3.pdf', 'file.PDf']],
      ['PDF Files without f1 and f2 and f3', '*.pdf', 'f1*,f2*,f3*', ['file.PDf']],
      ['All Files, no PNG', '*', '*.png', ['f1.pdf', 'f2.pdf', 'f3.pdf', 'file.PDf', 'f1.Pdf']],
    ];
    for (const [name, include, exclude, expected] of cases) {
      await t.test(name, async () => {
        mm.queued.length = 0;
        const rule = mailRule({ id: ++ruleIds, name, assignTitleFrom: TitleSource.FROM_FILENAME, account: account({ name: name }), filterAttachmentFilenameInclude: include, filterAttachmentFilenameExclude: exclude });
        await mm.handler().handleMessage(message, rule);
        mm.assertQueued([expected.map(m => ({ override_filename: m }))]);
      });
    }
  });

  test('test_filename_filter_inline_no_consumption', async () => {
    const mm = mailMocker();
    mm.bogusMailbox.put('INBOX', mm.messageBuilder.createMessage({ attachments: [new AttachmentDef({ filename: 'test.png', disposition: 'inline' })] }));
    const acc = account();
    addRule(acc, { assignTitleFrom: TitleSource.FROM_FILENAME, filterAttachmentFilenameInclude: '*.pdf', attachmentType: AttachmentProcessing.EVERYTHING, action: MailAction.DELETE });
    assert.equal(mm.bogusMailbox.messages.length, 4);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 1);
  });

  test('test_handle_mail_account_mark_read', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.MARK_READ });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(await mm.count(UNSEEN), 2);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(await mm.count(UNSEEN), 0);
    assert.equal(mm.bogusMailbox.messages.length, 3);
  });

  test('test_handle_mail_account_delete', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.DELETE, filterSubject: 'Invoice' });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 1);
  });

  test('test_handle_mail_account_delete_no_filters', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.DELETE, maximumAge: 0 });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 0);
  });

  test('test_handle_mail_account_overlapping_rules_only_first_consumes', async () => {
    const mm = mailMocker();
    const acc = account();
    const first = addRule(acc, { name: 'testrule-first', action: MailAction.DELETE, filterSubject: 'Claim', order: 1 });
    addRule(acc, { name: 'testrule-second', action: MailAction.DELETE, filterSubject: 'Claim', order: 2 });
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 1);
    assert.equal(mm.queued[0].rule.id, first.id);
    await mm.applyMailActions();
  });

  test('test_handle_mail_account_skips_body_fetch_for_already_processed_mail', async () => {
    const mm = mailMocker();
    const acc = account();
    const rule = addRule(acc, { action: MailAction.MARK_READ, consumptionScope: ConsumptionScope.ATTACHMENTS_ONLY });
    const message = mm.messageBuilder.createMessage({ subject: 'No attachment', attachments: [] });
    mm.bogusMailbox.messages = []; mm.bogusMailbox.put('INBOX', message);
    // First run: records ProcessedMail without consuming anything.
    await mm.handler().handleMailAccount(acc);
    assert.ok(mm.processed.rows.some(r => r.ruleId === rule.id && r.uid === String(message.uid) && r.folder === rule.folder));
    assert.equal(mm.queued.length, 0);
    // Second run: message still matches UNSEEN, but its body must not be downloaded again.
    const before = mm.bogusMailbox.calls.filter(c => c[0] === 'fetchAll' || c[0] === 'fetchOne').length;
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.bogusMailbox.calls.filter(c => c[0] === 'fetchAll' || c[0] === 'fetchOne').length, before);
  });

  test('test_handle_mail_account_skip_duplicate_uids_from_fetch', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.DELETE, filterSubject: 'Duplicated mail' });
    const dup = mm.messageBuilder.createMessage({ subject: 'Duplicated mail' });
    mm.bogusMailbox.messages = []; mm.bogusMailbox.put('INBOX', dup, dup);
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 1);
    await mm.applyMailActions();
    assert.equal(mm.processed.rows.filter(r => r.status === 'SUCCESS').length, 1);
  });

  for (const [name, current, stored, expected] of [
    ['test_handle_mail_account_skips_mail_already_processed_in_same_uidvalidity', 'SAME', 'SAME', 0],
    ['test_handle_mail_account_processes_mail_after_uidvalidity_change', 'NEW', 'OLD', 1],
    ['test_handle_mail_account_skips_mail_processed_before_uidvalidity_tracking', null, null, 0],
  ]) {
    test(name, async () => {
      const mm = mailMocker();
      const acc = account();
      const rule = addRule(acc, { action: MailAction.DELETE });
      const message = mm.messageBuilder.createMessage();
      mm.bogusMailbox.messages = []; mm.bogusMailbox.put('INBOX', message);
      // UIDVALIDITY is a number in IMAP; the values stand for "same", "old" and "new" epochs.
      const epoch = { SAME: 7, OLD: 5, NEW: 6 };
      if (current) mm.bogusMailbox.folder('INBOX').uidValidity = epoch[current];
      mm.processed.rows.push({ ruleId: rule.id, folder: rule.folder, uid: String(message.uid), uidValidity: stored === null ? null : String(epoch[stored]), subject: 'Previously processed mail', status: 'SUCCESS', received: new Date(2023, 0, 1, 12) });
      await mm.handler().handleMailAccount(acc);
      assert.equal(mm.queued.length, expected);
    });
  }

  test('test_handle_mail_account_processes_mail_when_uidvalidity_unavailable', async () => {
    const warnings = [];
    const mm = mailMocker({ log: { ...quiet, warn: m => warnings.push(m) } });
    const acc = account();
    addRule(acc, { action: MailAction.DELETE });
    mm.bogusMailbox.messages = []; mm.bogusMailbox.put('INBOX', mm.messageBuilder.createMessage());
    mm.bogusMailbox.statusError = new Error('unsupported');
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Server does not support retrieving UIDVALIDITY/);
  });

  test('test_handle_mail_account_skips_mail_when_uidvalidity_unavailable_but_prior_record_exists', async () => {
    const mm = mailMocker();
    const acc = account();
    const rule = addRule(acc, { action: MailAction.DELETE });
    const message = mm.messageBuilder.createMessage();
    mm.bogusMailbox.messages = []; mm.bogusMailbox.put('INBOX', message);
    mm.processed.rows.push({ ruleId: rule.id, folder: rule.folder, uid: String(message.uid), uidValidity: 'REAL_VALIDITY', subject: 'Previously processed mail', status: 'SUCCESS' });
    mm.bogusMailbox.statusError = new Error('unsupported');
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 0);
  });

  test('test_handle_mail_account_flag', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.FLAG, filterSubject: 'Invoice' });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(await mm.count({ flagged: false }), 2);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(await mm.count({ flagged: false }), 1);
    assert.equal(mm.bogusMailbox.messages.length, 3);
  });

  test('test_handle_mail_account_move', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.MOVE, actionParameter: 'spam', filterSubject: 'Claim' });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(mm.bogusMailbox.messagesSpam.length, 0);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 2);
    assert.equal(mm.bogusMailbox.messagesSpam.length, 1);
  });

  test('test_handle_mail_account_move_no_filters', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.MOVE, actionParameter: 'spam', maximumAge: 0 });
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 0);
    assert.equal(mm.bogusMailbox.messagesSpam.length, 3);
  });

  test('test_handle_mail_account_tag', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.TAG, actionParameter: 'processed' });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(await mm.count({ unKeyword: 'processed' }), 2);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(await mm.count({ unKeyword: 'processed' }), 0);
  });

  test('test_handle_mail_account_tag_gmail (run on the rule directly: the Gmail path is left disabled, spec 10.B.4)', async () => {
    const mm = mailMocker();
    mm.bogusMailbox.capabilities.push('X-GM-EXT-1');
    const acc = account();
    const rule = addRule(acc, { action: MailAction.TAG, actionParameter: 'processed' });
    const notLabelled = { labels: { not: 'processed' } };
    assert.equal(await mm.count(notLabelled), 3); // nothing carries the label yet (the "processed" keyword is not a label)
    const M = await mm.open('', 993, ImapSecurity.SSL);
    await M.login('admin', 'secret');
    assert.deepEqual(M.client.capabilities.includes('X-GM-EXT-1'), false, 'the adapter never reports Gmail labels');
    const handler = mm.handler();
    await handler.handleMailRule(M, rule, { supportsGmailLabels: true, consumedMessages: new Set(), account: acc });
    assert.deepEqual(makeCriterias(rule, { supportsGmailLabels: true }), { not: { gmailLabel: 'processed' }, noKeyword: 'processed', dateGte: makeCriterias(rule, { supportsGmailLabels: false }).dateGte });
    for (const { message } of mm.queued.splice(0)) await applyMailAction(M, rule, { uid: message.uid, subject: message.subject, date: message.date }, { processed: mm.processed, supportsGmailLabels: true, log: quiet });
    await M.close();
    assert.equal(await mm.count(notLabelled), 1);
    assert.equal(mm.bogusMailbox.messages.length, 3);
  });

  test('test_tag_mail_action_applemail_wrong_input', () => {
    assert.throws(() => new TagMailAction('apple:black', { supportsGmailLabels: false }), MailError);
  });

  test('test_handle_mail_account_tag_applemail', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.TAG, actionParameter: 'apple:green' });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(await mm.count({ flagged: false }), 2);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(await mm.count({ flagged: false }), 0);
    assert.equal(mm.bogusMailbox.messages.length, 3);
  });

  test('test_error_login', async () => {
    const mm = mailMocker();
    const acc = account({ password: 'wrong' });
    await assert.rejects(mm.handler().handleMailAccount(acc), e => e instanceof MailError && /Error while authenticating account/.test(e.message));
  });

  test('test_error_skip_rule', async () => {
    const mm = mailMocker();
    const acc = account({ name: 'test2' });
    addRule(acc, { action: MailAction.MOVE, actionParameter: 'spam', filterSubject: 'Claim', order: 1, folder: 'uuuhhhh' });
    addRule(acc, { action: MailAction.MOVE, actionParameter: 'spam', filterSubject: 'Claim', order: 2 });
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 2);
    assert.equal(mm.bogusMailbox.messagesSpam.length, 1);
  });

  test('test_error_folder_set', async () => {
    const infos = [];
    const mm = mailMocker({ log: { ...quiet, info: m => infos.push(m) } });
    const acc = account({ name: 'test2' });
    addRule(acc, { action: MailAction.MOVE, actionParameter: 'spam', filterSubject: 'Claim', order: 1, folder: 'uuuhhhh' });
    let listed = 0;
    const handler = mm.handler(); const open = handler.openMailbox;
    handler.openMailbox = async (...a) => { const M = await open(...a); M.folder.list = async () => { listed++; return [{ name: 'SomeFoldername' }]; }; return M; };
    await handler.handleMailAccount(acc);
    assert.equal(listed, 1);
    assert.ok(infos.includes('Located folder: SomeFoldername'));
    assert.equal(mm.queued.length, 0);
    assert.equal(handler.ruleErrors[0].error.code, 'folder_missing');
  });

  test('test_error_folder_set_error_listing', async () => {
    const mm = mailMocker();
    const acc = account({ name: 'test2' });
    addRule(acc, { action: MailAction.MOVE, actionParameter: 'spam', filterSubject: 'Claim', order: 1, folder: 'uuuhhhh' });
    mm.bogusMailbox.listError = new Error('uhm');
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 0);
  });

  test('test_error_skip_mail', async () => {
    const mm = mailMocker();
    const acc = account({ name: 'test2' });
    addRule(acc, { action: MailAction.MOVE, actionParameter: 'spam' });
    const handler = mm.handler();
    handler.getCorrespondent = message => { if (message.from === 'amazon@amazon.de') throw new Error('Does not compute.'); return null; };
    await handler.handleMailAccount(acc);
    await mm.applyMailActions();
    // test that we still consume mail even if some mails throw errors.
    assert.equal(mm.processed.rows.filter(r => r.status === 'SUCCESS').length, 2);
    // faulty mail still in inbox, untouched
    assert.equal(mm.bogusMailbox.messages.length, 1);
    assert.equal(mm.bogusMailbox.messages[0].meta.from, 'amazon@amazon.de');
  });

  test('test_error_create_correspondent', async () => {
    const mm = mailMocker();
    const acc = account({ name: 'test2' });
    addRule(acc, { filterFrom: 'amazon@amazon.de', action: MailAction.MOVE, actionParameter: 'spam', assignCorrespondentFrom: CorrespondentSource.FROM_EMAIL });
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 1);
    const c = mm.correspondents.find(x => x.name === 'amazon@amazon.de');
    mm.assertQueued([[{ override_correspondent_id: c.id }]]);
    mm.queued.length = 0;
    resetBogusMailbox(mm.bogusMailbox, mm.messageBuilder);
    mm.db.fail = true;
    await mm.handler().handleMailAccount(acc);
    mm.assertQueued([[{ override_correspondent_id: null }]]);
  });

  test('test_filters', async t => {
    for (const [fBody, fFrom, fTo, fSubject, expectedMailCount] of [
      [null, null, null, 'Claim', 1],
      ['electronic', null, null, null, 1],
      [null, 'amazon', null, null, 2],
      ['cables', 'amazon', null, 'Invoice', 1],
      [null, null, 'test@email.com', null, 0],
      [null, null, 'invoices@mycompany.com', null, 1],
      ['electronic', null, 'invoices@mycompany.com', null, 1],
      [null, 'amazon', 'me@myselfandi.com', null, 1],
    ]) {
      await t.test(JSON.stringify({ fBody, fFrom, fTo, fSubject }), async () => {
        const mm = mailMocker();
        const acc = account({ name: 'test3' });
        addRule(acc, { action: MailAction.DELETE, filterSubject: fSubject, filterBody: fBody, filterFrom: fFrom, filterTo: fTo });
        assert.equal(mm.queued.length, 0);
        assert.equal(mm.bogusMailbox.messages.length, 3);
        await mm.handler().handleMailAccount(acc);
        const queuedCount = mm.queued.length;
        await mm.applyMailActions();
        assert.equal(mm.bogusMailbox.messages.length, 3 - expectedMailCount);
        assert.equal(queuedCount, expectedMailCount);
      });
    }
  });

  test('test_auth_plain_fallback', async () => {
    const mm = mailMocker();
    const acc = account({ username: BogusMailBox.USERNAME, password: BogusMailBox.UTF_PASSWORD });
    addRule(acc, { action: MailAction.MARK_READ });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(mm.queued.length, 0);
    assert.equal(await mm.count(UNSEEN), 2);
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 2);
    await mm.applyMailActions();
    assert.equal(await mm.count(UNSEEN), 0);
    assert.equal(mm.bogusMailbox.messages.length, 3);
  });

  test('test_auth_plain_fallback_fails_still', async () => {
    const mm = mailMocker();
    const acc = account({ username: BogusMailBox.USERNAME, password: 'réception' });
    addRule(acc, { action: MailAction.MARK_READ });
    await assert.rejects(mm.handler().handleMailAccount(acc), MailError);
  });

  test('test_auth_with_valid_token', async () => {
    const mm = mailMocker();
    const acc = account({ username: BogusMailBox.USERNAME, password: BogusMailBox.ACCESS_TOKEN, isToken: true });
    addRule(acc, { action: MailAction.MARK_READ });
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(mm.queued.length, 0);
    assert.equal(await mm.count(UNSEEN), 2);
    await mm.handler().handleMailAccount(acc);
    assert.equal(mm.queued.length, 2);
    // applied over the same token login
    for (const { message, rule } of mm.queued.splice(0)) {
      const M = await mm.open('', 993, ImapSecurity.SSL); await M.xoauth2(acc.username, acc.password); await M.folder.set(rule.folder);
      await applyMailAction(M, rule, { uid: message.uid, subject: message.subject, date: message.date }, { processed: mm.processed, log: quiet }); await M.close();
    }
    assert.equal(await mm.count(UNSEEN), 0);
    assert.equal(mm.bogusMailbox.messages.length, 3);
  });

  test('test_disabled_rule', async () => {
    const mm = mailMocker();
    const acc = account();
    addRule(acc, { action: MailAction.MARK_READ, enabled: false });
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(mm.bogusMailbox.messages.length, 3);
    assert.equal(await mm.count(UNSEEN), 2);
    await mm.handler().handleMailAccount(acc);
    await mm.applyMailActions();
    assert.equal(await mm.count(UNSEEN), 2); // still 2
  });
});

describe('Paperless-ngx test_mail.py TestGetMailboxHostPinning', () => {
  const capture = () => { const built = []; return { built, createMailbox: o => { built.push(o); const mb = new BogusMailBox(); mb.connectError = Object.assign(new Error('no connection in tests'), { code: 'ECONNREFUSED' }); return new ImapFlowMailBox({ ...o, ImapFlow: bogusImapFlow(mb) }); } }; };

  test('test_connects_to_validated_ip', async () => {
    const mb = new BogusMailBox(); mb.connectError = new Error('no connection in tests');
    const M = await getMailbox('mail.example.com', 143, ImapSecurity.NONE, { resolve: async () => ['93.184.216.34'], createMailbox: o => new ImapFlowMailBox({ ...o, ImapFlow: bogusImapFlow(mb) }) });
    await assert.rejects(M.login('admin', 'secret'), /no connection in tests/);
    // the hostname is never handed to the socket layer for a second lookup
    assert.equal(mb.connections.length, 1);
    assert.deepEqual([mb.connections[0].host, mb.connections[0].port], ['93.184.216.34', 143]);
  });

  test('test_ssl_pins_ip_but_keeps_hostname_for_sni', async () => {
    const { built, createMailbox } = capture();
    const M = await getMailbox('mail.example.com', 993, ImapSecurity.SSL, { resolve: async () => ['93.184.216.34'], createMailbox });
    await assert.rejects(M.login('admin', 'secret'), /no connection in tests/);
    assert.deepEqual(built[0].pinnedIps, ['93.184.216.34']);
    const mb = new BogusMailBox(); mb.connectError = new Error('no connection in tests');
    const M2 = new ImapFlowMailBox({ ...built[0], ImapFlow: bogusImapFlow(mb) });
    await assert.rejects(M2.login('admin', 'secret'));
    // certificate verification still happens against the hostname
    assert.deepEqual([mb.connections[0].host, mb.connections[0].port, mb.connections[0].secure, mb.connections[0].servername, mb.connections[0].tls.rejectUnauthorized], ['93.184.216.34', 993, true, 'mail.example.com', true]);
  });

  test('test_blocks_when_any_resolved_address_is_internal', async () => {
    const { built, createMailbox } = capture();
    await assert.rejects(getMailbox('mail.example.com', 993, ImapSecurity.SSL, { resolve: async () => ['93.184.216.34', '127.0.0.1'], createMailbox }), e => e instanceof MailError && e.code === 'mail_private_address');
    assert.equal(built.length, 0);
  });
});

describe('Paperless-ngx test_network.py', () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', 'fc00::1', 'fe80::1', '100.64.0.0', '100.64.0.1', '100.127.255.255', '64:ff9b::7f00:1', '64:ff9b::a00:5']) {
    test(`test_is_public_ip_blocks_non_public_addresses[${address}]`, () => assert.equal(isPublicIp(address), false));
  }
  for (const address of ['8.8.8.8', '142.250.185.196', '2606:4700:4700::1111', '100.63.255.255', '100.128.0.0', '64:ff9a::1', '64:ff9c::1']) {
    test(`test_is_public_ip_allows_public_addresses[${address}]`, () => assert.equal(isPublicIp(address), true));
  }
});

describe('Paperless-ngx test_mail_nfc.py TestMailNFCNormalization', () => {
  const attachmentRule = () => mailRule({ id: 950, name: 'attachment rule', account: account(), assignTitleFrom: TitleSource.FROM_FILENAME, consumptionScope: ConsumptionScope.ATTACHMENTS_ONLY, attachmentType: AttachmentProcessing.ATTACHMENTS_ONLY });
  const emlRule = () => mailRule({ id: 951, name: 'eml rule', account: account(), assignTitleFrom: TitleSource.FROM_SUBJECT, consumptionScope: ConsumptionScope.EML_ONLY, attachmentType: AttachmentProcessing.ATTACHMENTS_ONLY });

  test('test_attachment_nfd_filename_normalized_to_nfc', async () => {
    const mm = mailMocker();
    const nfd = 'Rechnung März.pdf'.normalize('NFD'); const nfcName = 'Rechnung März.pdf'.normalize('NFC');
    assert.equal(nfd.normalize('NFD'), nfd); assert.notEqual(nfd.normalize('NFC'), nfd);
    const message = await asMessage(mm.messageBuilder.createMessage({ subject: 'Test invoice', from: 'sender@example.com', attachments: [new AttachmentDef({ filename: nfd, content: '%PDF-1.4 test' })] }));
    assert.equal(await mm.handler().handleMessage(message, attachmentRule()), 1);
    assert.equal(mm.queued.length, 1);
    const [task] = mm.queued[0].consumeTasks;
    assert.equal(task.overrides.filename, nfcName);
    assert.equal(task.overrides.filename.normalize('NFC'), task.overrides.filename);
    assert.equal(task.overrides.title.normalize('NFC'), task.overrides.title);
    assert.equal(task.inputDoc.filename, nfcName);
  });

  test('test_eml_subject_filename_nfc', async () => {
    const mm = mailMocker();
    const nfdSubject = 'Rechnung März 2024'.normalize('NFD');
    const message = await asMessage(mm.messageBuilder.createMessage({ subject: nfdSubject, from: 'sender@example.com', attachments: 0 }));
    await mm.handler().handleMessage(message, emlRule());
    assert.equal(mm.queued.length, 1);
    assert.equal(mm.queued[0].consumeTasks.length, 1);
    assert.equal(mm.queued[0].consumeTasks[0].overrides.filename, 'Rechnung März 2024.eml'.normalize('NFC'));
  });

  test('test_already_nfc_attachment_filename_unchanged', async () => {
    const mm = mailMocker();
    const message = await asMessage(mm.messageBuilder.createMessage({ subject: 'Invoice', from: 'sender@example.com', attachments: [new AttachmentDef({ filename: 'Invoice_2024.pdf', content: '%PDF-1.4 test' })] }));
    await mm.handler().handleMessage(message, attachmentRule());
    assert.equal(mm.queued[0].consumeTasks[0].overrides.filename, 'Invoice_2024.pdf');
  });
});

/** A built message as the ported logic receives it from the adapter (mailparser over the raw bytes). */
function asMessage(built) { return toMailMessage({ uid: built.uid, raw: built.raw, flags: built.flags }); }

// ---- Semantics sheet (spec 10.B.4): ours, not Paperless's tests.

describe('semantics sheet', () => {
  test('fnmatch is Python fnmatch.translate: *, ?, [seq], [!seq], whole name, not a glob', () => {
    const cases = [
      ['a.docx', '*.docx', true], ['a.docx.zip', '*.docx', false], ['dir/a.docx', '*.docx', true], ['.docx', '*.docx', true],
      ['a1.pdf', 'a?.pdf', true], ['a12.pdf', 'a?.pdf', false], ['b.pdf', '[ab].pdf', true], ['c.pdf', '[!ab].pdf', true],
      ['a.pdf', '[!ab].pdf', false], ['[x].pdf', '[x].pdf', false], ['x.pdf', '[x].pdf', true], ['a[.pdf', 'a[.pdf', true],
      ['a{b,c}.pdf', 'a{b,c}.pdf', true], ['ab.pdf', 'a{b,c}.pdf', false], ['a+b.pdf', 'a+b.pdf', true], ['nda (2).docx', 'nda (?).docx', true],
      ['line\nbreak.pdf', '*.pdf', true], ['a-1.pdf', '[a-c]-1.pdf', true], ['d-1.pdf', '[a-c]-1.pdf', false], ['^.pdf', '[^].pdf', true],
    ];
    for (const [name, pattern, want] of cases) assert.equal(fnmatch(name, pattern), want, `${name} ~ ${pattern}`);
  });

  test('maximum_age: SINCE is the local calendar date maximumAge days back, inclusive; 0 means no date', () => {
    const rule = mailRule({ action: MailAction.MOVE, actionParameter: 'Filed', maximumAge: 30 });
    assert.deepEqual(makeCriterias(rule, { supportsGmailLabels: false, today: new Date(2026, 9, 15, 0, 0, 1) }), { dateGte: '2026-09-15' });
    assert.deepEqual(makeCriterias(rule, { supportsGmailLabels: false, today: new Date(2026, 9, 15, 23, 59, 59) }), { dateGte: '2026-09-15' });
    assert.deepEqual(makeCriterias(rule, { supportsGmailLabels: false, today: new Date(2026, 2, 1, 12) }), { dateGte: '2026-01-30' });
    assert.deepEqual(makeCriterias({ ...rule, maximumAge: 0 }, { supportsGmailLabels: false }), { all: true });
  });

  test('the date boundary in the simulated mailbox: a message on the SINCE day is found, the day before is not', async () => {
    const mb = new BogusMailBox(); const b = new MessageBuilder();
    mb.put('INBOX', { ...b.createMessage({ subject: 'on the day' }), internalDate: new Date('2026-09-15T00:00:00Z') }, { ...b.createMessage({ subject: 'day before' }), internalDate: new Date('2026-09-14T23:59:59Z') });
    const M = new ImapFlowMailBox({ host: 'x', port: 993, ImapFlow: bogusImapFlow(mb) });
    await M.login('admin', 'secret'); await M.folder.set('INBOX');
    assert.deepEqual(await M.uids({ dateGte: '2026-09-15' }), ['1']);
  });

  test('RFC 2231 file names, inline against attachment disposition, nested message/rfc822, charset fallbacks', async () => {
    const inner = buildRaw({ subject: 'Original from Acme', from: 'Legal <legal@acme.example>', body: 'Our markup attached.' });
    const raw = buildRaw({
      subject: 'Fwd: Mutual NDA', from: 'Ada <ada@ours.example>', body: 'See below.',
      attachments: [
        new AttachmentDef({ filename: 'Accord de confidentialité – v2.docx', maintype: 'application', subtype: 'vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('PK\x03\x04docx') }),
        new AttachmentDef({ filename: 'logo.png', maintype: 'image', subtype: 'png', disposition: 'inline', content: Buffer.from('png') }),
        new AttachmentDef({ filename: 'original.eml', maintype: 'message', subtype: 'rfc822', content: inner }),
      ],
    });
    const m = await toMailMessage({ uid: 1, raw });
    assert.deepEqual(m.attachments.map(a => [a.filename, a.contentDisposition]), [['Accord de confidentialité – v2.docx', 'attachment'], ['logo.png', 'inline'], ['original.eml', 'attachment']]);
    assert.match(m.attachments[2].payload.toString('utf8'), /Original from Acme/);
    // A Latin-1 message with no charset label on an 8-bit body, and an ISO-8859-1 encoded word: decoded, not mangled.
    const latin = Buffer.concat([Buffer.from('Subject: =?iso-8859-1?Q?R=E9ponse?=\r\nFrom: a@b.example\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n', 'latin1'), Buffer.from('Résumé des clauses', 'latin1')]);
    const lm = await toMailMessage({ uid: 2, raw: latin });
    assert.equal(lm.subject, 'Réponse');
    assert.match(lm.text, /Résumé des clauses/);
    // An HTML-only body is turned into text without fetching anything (no remote image or link is followed).
    const html = await toMailMessage({ uid: 3, raw: buildRaw({ html: '<p>Hello <img src="https://tracker.example/p.gif"> <a href="https://evil.example">here</a></p>' }) });
    assert.match(html.text, /Hello/);
  });
});
