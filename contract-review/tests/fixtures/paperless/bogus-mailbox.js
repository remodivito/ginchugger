// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Paperless-ngx (https://github.com/paperless-ngx/paperless-ngx), GPL-3.0.
//   Source: src/paperless_mail/tests/helpers.py (`BogusMailBox`, `BogusFolderManager`, `BogusClient`,
//   `MessageBuilder`, `_AttachmentDef`, `fake_magic_from_buffer`), commit c50c6f5517e3fd8f97fa546ede69a52b622e2b20;
//   the Python is kept unchanged in server/ports/paperless/reference/mail_test_helpers.py.
//   Modified: translated to JavaScript for GinChugger, 15 October 2026 (product v2 spec 10.B.2). The simulated
//   mailbox sits at the imapflow client boundary instead of imap_tools': `BogusMailBox` holds folders (UIDVALIDITY,
//   UIDNEXT), messages as raw RFC 822 bytes with flags, and the accepted credentials; `bogusImapFlow(mailbox)` is a
//   class with the subset of imapflow's ImapFlow API the adapter (server/mail/imapflow-mailbox.js) calls, so the ported
//   logic, the adapter and mailparser all run for real. Searches take imapflow's query objects (data, not IMAP
//   strings); like IMAP, text searches are case-insensitive substrings. Messages are built as MIME by hand, with
//   RFC 2231 file names when they are not ASCII.
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';

export class AttachmentDef {
  constructor({ filename = 'a_file.pdf', maintype = 'application', subtype = 'pdf', disposition = 'attachment', content = Buffer.from('a PDF document') } = {}) {
    Object.assign(this, { filename, maintype, subtype, disposition, content: Buffer.isBuffer(content) ? content : Buffer.from(content) });
  }
}

/** fake_magic_from_buffer: "PDF" anywhere in the bytes is a PDF; anything else is an unknown type. */
export const fakeMagicFromBuffer = buffer => (String(buffer).includes('PDF') ? 'application/pdf' : 'unknown/type');

const ascii = s => /^[\x20-\x7e]*$/.test(s);
const encodeWord = s => (ascii(s) ? s : `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const fileParam = (key, name) => (ascii(name) ? `${key}="${name.replace(/["\\]/g, '\\$&')}"` : `${key}*=utf-8''${encodeURIComponent(name)}`);

/** RFC 822 bytes for a message (Python's EmailMessage.set_content plus add_attachment, by hand). */
export function buildRaw({ subject = 'the subject', from = 'no_one@mail.com', to = ['tosomeone@somewhere.com'], body = '', attachments = [], messageId = `<${randomUUID()}@bogus.example>`, date = new Date(), html = null, extraHeaders = [] }) {
  const head = [
    `Message-ID: ${messageId}`, `Subject: ${encodeWord(subject)}`, ...(from === null ? [] : [`From: ${encodeWord(from)}`]), `To: ${to.join(', ')}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`, 'MIME-Version: 1.0', ...extraHeaders,
  ];
  const textPart = html !== null
    ? ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(html, 'utf8'))]
    : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(body + '\n', 'utf8'))];
  if (!attachments.length) return Buffer.from([...head, ...textPart, ''].join('\r\n'), 'utf8');
  const boundary = `==bogus${randomUUID().replace(/-/g, '')}`;
  const parts = [textPart.join('\r\n')];
  for (const a of attachments) {
    const type = `${a.maintype}/${a.subtype}`;
    if (type === 'message/rfc822') {
      parts.push([`Content-Type: message/rfc822${a.filename ? `; ${fileParam('name', a.filename)}` : ''}`, `Content-Disposition: ${a.disposition}${a.filename ? `; ${fileParam('filename', a.filename)}` : ''}`, '', a.content.toString('utf8')].join('\r\n'));
      continue;
    }
    parts.push([`Content-Type: ${type}; ${fileParam('name', a.filename)}`, `Content-Disposition: ${a.disposition}; ${fileParam('filename', a.filename)}`, 'Content-Transfer-Encoding: base64', '', b64(a.content)].join('\r\n'));
  }
  return Buffer.from([...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.map(p => `--${boundary}\r\n${p}`), `--${boundary}--`, ''].join('\r\n'), 'utf8');
}

/** MessageBuilder.create_message: a message with a UID from a shared counter, ready for BogusMailBox.put. */
export class MessageBuilder {
  constructor() { this.nextUid = 1; }
  createMessage({ attachments = 1, body = '', subject = 'the subject', from = 'no_one@mail.com', to = ['tosomeone@somewhere.com'], seen = false, flagged = false, processed = false, date = new Date(), messageId, html = null } = {}) {
    const atts = typeof attachments === 'number' ? Array.from({ length: attachments }, (_, i) => new AttachmentDef({ filename: `file_${i}.pdf` })) : attachments;
    const raw = buildRaw({ subject, from, to, body, attachments: atts, date, html, ...(messageId ? { messageId } : {}) });
    const uid = this.nextUid++;
    const flags = new Set([...(seen ? ['\\Seen'] : []), ...(flagged ? ['\\Flagged'] : []), ...(processed ? ['processed'] : [])]);
    return { uid, raw, flags, labels: new Set(), internalDate: date, meta: { subject, from: from || '', to, text: body || html || '' } };
  }
}

/** The simulated mailbox: data only. Tests and the e2e harness put messages in; the fake client below reads it. */
export class BogusMailBox {
  static USERNAME = 'admin';
  static ASCII_PASSWORD = 'secret';
  static UTF_PASSWORD = 'w57äöüw4b6huwb6nhu';
  static ACCESS_TOKEN = 'ea7e075cd3acf2c54c48e600398d5d5a';

  constructor({ folders = ['INBOX', 'spam'], uidValidity = 1 } = {}) {
    this.folders = new Map();
    for (const f of folders) this.addFolder(f, uidValidity);
    this.capabilities = ['IMAP4rev1', 'MOVE', 'UIDPLUS'];
    this.username = BogusMailBox.USERNAME;
    this.accessToken = BogusMailBox.ACCESS_TOKEN;
    this.connections = []; // the options each client was built with (pinning tests)
    this.refuseCreate = new Set(); this.statusError = null; this.listError = null; this.connectError = null; this.searchError = null;
    this.calls = [];
  }
  addFolder(name, uidValidity = 1) { this.folders.set(name, { name, uidValidity, uidNext: 1, messages: [] }); return this.folders.get(name); }
  folder(name) { return this.folders.get(name); }
  /** Paperless's `bogus_mailbox.messages` (INBOX) and `messages_spam`. */
  get messages() { return this.folders.get('INBOX').messages; }
  set messages(list) { this.folders.get('INBOX').messages = list; }
  get messagesSpam() { return this.folders.get('spam')?.messages || []; }
  /** Put built messages into a folder as they are (a message may be put twice: duplicate UIDs from fetch). */
  put(folder, ...msgs) { const f = this.folders.get(folder); for (const m of msgs) { f.messages.push(m); f.uidNext = Math.max(f.uidNext, m.uid + 1); } return msgs; }
  /** Deliver raw bytes as a new message with the folder's next UID (the e2e harness and the consumer tests). */
  async deliver(raw, { folder = 'INBOX', seen = false, date = new Date() } = {}) {
    const f = this.folders.get(folder);
    const p = await simpleParser(raw);
    const m = { uid: f.uidNext++, raw: Buffer.from(raw), flags: new Set(seen ? ['\\Seen'] : []), labels: new Set(), internalDate: date, meta: { subject: p.subject || '', from: p.from?.text || '', to: (p.to?.value || []).map(a => a.address), text: p.text || '' } };
    f.messages.push(m);
    return m;
  }
  /** UIDVALIDITY changes and every UID is renumbered (a server rebuilding the folder). */
  resetUids(folder, uidValidity) {
    const f = this.folders.get(folder); f.uidValidity = uidValidity; f.uidNext = 1;
    for (const m of f.messages) m.uid = f.uidNext++;
  }
}

const has = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle).toLowerCase());
const dayOf = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
function uidSet(range) { return new Set(String(range).split(',').map(s => s.trim())); }
function matches(m, q) {
  if (q.all) return true;
  if (q.seen === false && m.flags.has('\\Seen')) return false;
  if (q.seen === true && !m.flags.has('\\Seen')) return false;
  if (q.flagged === false && m.flags.has('\\Flagged')) return false;
  if (q.unKeyword && m.flags.has(q.unKeyword)) return false;
  if (q.keyword && !m.flags.has(q.keyword)) return false;
  if (q.labels?.not && m.labels.has(q.labels.not)) return false;
  if (q.since && dayOf(m.internalDate) < dayOf(q.since)) return false;
  if (q.from && !has(m.meta.from, q.from)) return false;
  if (q.to && !m.meta.to.some(t => has(t, q.to))) return false;
  if (q.subject && !has(m.meta.subject, q.subject)) return false;
  if (q.body && !has(m.meta.text, q.body)) return false;
  if (q.uid && !uidSet(q.uid).has(String(m.uid))) return false;
  if (q.not && matches(m, q.not)) return false;
  return true;
}

/** The fake imapflow client class over one BogusMailBox. */
export function bogusImapFlow(mailbox) {
  return class BogusImapFlow {
    constructor(options) { this.options = options; this.capabilities = new Map(); this.mailbox = false; this.handlers = {}; mailbox.connections.push(options); }
    on(event, fn) { this.handlers[event] = fn; return this; }
    async connect() {
      if (mailbox.connectError) throw mailbox.connectError;
      const { user, pass, accessToken } = this.options.auth || {};
      const ok = user === mailbox.username && (accessToken !== undefined ? accessToken === mailbox.accessToken : pass === BogusMailBox.ASCII_PASSWORD || pass === BogusMailBox.UTF_PASSWORD);
      if (!ok) throw Object.assign(new Error('Authentication failed.'), { authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'AUTHENTICATE failed.' });
      this.capabilities = new Map(mailbox.capabilities.map(c => [c, true]));
      this.usable = true;
    }
    selectedFolder() { if (!this.mailbox) throw new Error('No mailbox is selected.'); return mailbox.folder(this.mailbox.path); }
    async mailboxOpen(path) {
      const f = mailbox.folder(path);
      if (!f) throw Object.assign(new Error(`Mailbox doesn't exist: ${path}`), { responseStatus: 'NO', mailboxMissing: true, responseText: `Mailbox doesn't exist: ${path}` });
      this.mailbox = { path, uidValidity: BigInt(f.uidValidity), uidNext: f.uidNext, exists: f.messages.length };
      return this.mailbox;
    }
    async status(path, query) {
      if (mailbox.statusError) throw mailbox.statusError;
      const f = mailbox.folder(path); if (!f) return false;
      return { path, ...(query.uidValidity ? { uidValidity: BigInt(f.uidValidity) } : {}) };
    }
    async list() {
      if (mailbox.listError) throw mailbox.listError;
      return [...mailbox.folders.keys()].map(p => ({ path: p, name: p.split('/').pop(), delimiter: '/', flags: new Set() }));
    }
    async mailboxCreate(path) {
      if (mailbox.refuseCreate.has(path)) throw Object.assign(new Error(`Cannot create ${path}`), { responseStatus: 'NO' });
      if (!mailbox.folder(path)) mailbox.addFolder(path, Math.floor(Math.random() * 1e6) + 1);
      return { path, created: true };
    }
    async search(query, opts) {
      if (mailbox.searchError) throw mailbox.searchError;
      mailbox.calls.push(['search', this.mailbox.path, query, opts]);
      return this.selectedFolder().messages.filter(m => matches(m, query)).map(m => m.uid);
    }
    head(m) { return { uid: m.uid, size: m.raw.length, flags: new Set(m.flags), envelope: { messageId: /^message-id:\s*(.+)$/im.exec(m.raw.toString('latin1'))?.[1]?.trim() || null, subject: m.meta.subject, date: m.internalDate, from: [{ address: m.meta.from }] } }; }
    async fetchAll(range, query, opts) {
      mailbox.calls.push(['fetchAll', range, opts]);
      const want = uidSet(range);
      return this.selectedFolder().messages.filter(m => want.has(String(m.uid))).map(m => this.head(m));
    }
    async fetchOne(uid, query) {
      mailbox.calls.push(['fetchOne', uid]);
      const m = this.selectedFolder().messages.find(x => String(x.uid) === String(uid));
      return m ? { ...this.head(m), ...(query.source ? { source: m.raw } : {}) } : false;
    }
    async messageMove(range, dest, opts) {
      mailbox.calls.push(['messageMove', range, dest, opts]);
      const to = mailbox.folder(dest); if (!to) throw Object.assign(new Error(`Mailbox doesn't exist: ${dest}`), { responseStatus: 'NO', mailboxMissing: true });
      const from = this.selectedFolder(); const want = uidSet(range);
      const moving = from.messages.filter(m => want.has(String(m.uid)));
      from.messages = from.messages.filter(m => !want.has(String(m.uid)));
      for (const m of moving) to.messages.push({ ...m, uid: to.uidNext++ });
      return { path: from.name, destination: dest, uidMap: new Map() };
    }
    async messageDelete(range) { const f = this.selectedFolder(); const want = uidSet(range); f.messages = f.messages.filter(m => !want.has(String(m.uid))); return true; }
    async messageFlagsAdd(range, flags, opts) { const want = uidSet(range); for (const m of this.selectedFolder().messages) if (want.has(String(m.uid))) for (const fl of flags) (opts?.useLabels ? m.labels : m.flags).add(fl); return true; }
    async messageFlagsRemove(range, flags) { const want = uidSet(range); for (const m of this.selectedFolder().messages) if (want.has(String(m.uid))) for (const fl of flags) m.flags.delete(fl); return true; }
    async logout() { this.usable = false; mailbox.calls.push(['logout']); }
    close() { this.usable = false; }
  };
}

/** reset_bogus_mailbox: the three messages most of Paperless's tests start from. */
export function resetBogusMailbox(mailbox, builder) {
  mailbox.messages = [];
  if (mailbox.folder('spam')) mailbox.folder('spam').messages = [];
  mailbox.put('INBOX',
    builder.createMessage({ subject: 'Invoice 1', from: 'amazon@amazon.de', to: ['me@myselfandi.com', 'helpdesk@mydomain.com'], body: 'cables', seen: true, flagged: false, processed: false }),
    builder.createMessage({ subject: 'Invoice 2', body: 'from my favorite electronic store', to: ['invoices@mycompany.com'], seen: false, flagged: true, processed: true }),
    builder.createMessage({ subject: 'Claim your $10M price now!', from: 'amazon@amazon-some-indian-site.org', to: ['special@me.me'], seen: false }),
  );
}
