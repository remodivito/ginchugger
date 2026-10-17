// SPDX-License-Identifier: GPL-3.0-or-later
// The mailbox the ported Paperless-ngx logic talks to (`M` in server/ports/paperless/mail.js), over imapflow (MIT) for
// IMAP and mailparser (MIT) for MIME (product v2 spec 10.B.5). Our plumbing, not ported code.
//
// Pinning (spec 10.B.6, PR-SEC-02): the caller resolves the configured host once and hands over the checked addresses;
// imapflow is given the address as `host` and the configured name as `servername`, so TLS SNI and the certificate
// check use the name while the socket goes to the address that was checked (no second DNS lookup, no rebinding).
// Mail bodies are parsed with link and image fetching off; nothing in a message is ever fetched.
import { ImapFlow as RealImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { MailboxFolderSelectError, MailboxFolderStatusError, MailboxLoginError, MailMessageFlags, ImapSecurity } from '../ports/paperless/mail.js';

const asUidRange = uids => uids.map(u => String(u)).join(',');

/** A criteria object of the ported make_criterias as an imapflow search query. */
export function toImapflowQuery(c = {}) {
  if (c.all) return { all: true };
  const q = {};
  if (c.seen === false) q.seen = false;
  if (c.flagged === false) q.flagged = false;
  if (c.noKeyword) q.unKeyword = c.noKeyword;
  if (c.not?.gmailLabel) q.labels = { not: c.not.gmailLabel };
  if (c.dateGte) q.since = new Date(`${c.dateGte}T00:00:00Z`); // imapflow sends the UTC calendar date of the Date given
  for (const k of ['from', 'to', 'subject', 'body']) if (c[k]) q[k] = c[k];
  if (c.uid) q.uid = Array.isArray(c.uid) ? asUidRange(c.uid) : String(c.uid);
  return Object.keys(q).length ? q : { all: true };
}

const addressOf = list => (Array.isArray(list?.value) ? list.value : []).flatMap(a => (a.group ? a.group : [a]));

/** A parsed message in the shape the ported logic reads (imap_tools.MailMessage's fields). */
export async function toMailMessage({ uid, raw, flags = new Set(), size = raw?.length || 0, envelope = null }) {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 2_000_000 });
  const from = addressOf(parsed.from)[0] || null;
  return {
    uid: String(uid),
    messageId: (parsed.messageId || envelope?.messageId || null),
    subject: parsed.subject ?? envelope?.subject ?? '',
    from: from?.address || '',
    fromValues: { name: from?.name || '', email: from?.address || '' },
    fromHeader: parsed.from?.text || '',
    to: addressOf(parsed.to).map(a => a.address).filter(Boolean),
    text: parsed.text || '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    date: parsed.date || envelope?.date || null,
    attachments: (parsed.attachments || []).map((a, i) => ({
      filename: a.filename ?? (a.contentType === 'message/rfc822' ? `attached-message-${i + 1}.eml` : ''),
      contentDisposition: a.contentDisposition || '',
      contentType: a.contentType || 'application/octet-stream',
      payload: a.content,
      size: a.size ?? a.content?.length ?? 0,
    })),
    raw, size,
    seen: flags.has(MailMessageFlags.SEEN), flagged: flags.has(MailMessageFlags.FLAGGED), flags,
  };
}

export class ImapFlowMailBox {
  /**
   * @param host the configured name (SNI, certificate); pinnedIps the checked addresses to connect to (null: the name)
   * @param maxMessageBytes a message larger than this is not downloaded: fetch yields { uid, oversize: true, ... }
   */
  constructor({ host, port, security = ImapSecurity.SSL, pinnedIps = null, ImapFlow = RealImapFlow, tls = {}, connectionTimeout = 30_000, maxMessageBytes = Infinity, log = null }) {
    Object.assign(this, { host, port: Number(port), security, pinnedIps, ImapFlowClass: ImapFlow, tls, connectionTimeout, maxMessageBytes, log });
    this.imap = null; this.selected = null;
    // imap_tools exposes the low-level client as M.client; the Gmail label path is left disabled (spec 10.B.4):
    // capabilities are only known after login, so the handler, which looks before login, never sees X-GM-EXT-1.
    this.client = { capabilities: [], uid: (cmd, uid, op, label) => this.storeLabel(cmd, uid, op, label) };
    this.folder = {
      set: async name => {
        try { const box = await this.imap.mailboxOpen(name); this.selected = name; return box; } catch (e) {
          throw Object.assign(new MailboxFolderSelectError(`Folder ${name}: ${e.responseText || e.message}`), { cause: e, missing: !!e.mailboxMissing });
        }
      },
      status: async (name, items = ['UIDVALIDITY']) => {
        let s;
        try { s = await this.imap.status(name, { uidValidity: items.includes('UIDVALIDITY') }); } catch (e) { throw Object.assign(new MailboxFolderStatusError(e.message), { cause: e }); }
        if (!s) throw new MailboxFolderStatusError(`The server gave no status for ${name}.`);
        return s.uidValidity === undefined || s.uidValidity === null ? {} : { UIDVALIDITY: Number(s.uidValidity) };
      },
      list: async () => (await this.imap.list()).map(f => ({ name: f.path, delimiter: f.delimiter, flags: f.flags })),
      create: async name => { await this.imap.mailboxCreate(name); },
    };
  }

  /** Connect and authenticate (imapflow does both in connect()), trying each pinned address in turn. */
  async connectWith(auth) {
    const targets = this.pinnedIps && this.pinnedIps.length ? this.pinnedIps : [this.host];
    let last = null;
    for (const address of targets) {
      const imap = new this.ImapFlowClass({
        host: address, servername: this.host, port: this.port,
        secure: this.security === ImapSecurity.SSL, doSTARTTLS: this.security === ImapSecurity.STARTTLS ? true : this.security === ImapSecurity.NONE ? false : undefined,
        auth, logger: false, emitLogs: false, disableAutoIdle: true, disableCompression: true,
        connectionTimeout: this.connectionTimeout, greetingTimeout: this.connectionTimeout, socketTimeout: 5 * 60_000,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, ...this.tls },
      });
      imap.on?.('error', e => this.log?.warn?.(`Mailbox connection: ${e.message}`));
      try {
        await imap.connect();
        this.imap = imap;
        this.client.capabilities = [...(imap.capabilities?.keys?.() || [])].filter(c => c !== 'X-GM-EXT-1');
        return;
      } catch (e) {
        if (e.authenticationFailed) throw Object.assign(new MailboxLoginError(e.responseText || 'Authentication failed.'), { cause: e, authenticationFailed: true });
        last = e;
      }
    }
    throw last || new Error(`Could not connect to ${this.host}`);
  }

  login(user, pass) { return this.connectWith({ user, pass }); }
  loginUtf8(user, pass) { return this.connectWith({ user, pass, loginMethod: 'AUTH=PLAIN' }); }
  xoauth2(user, accessToken) { return this.connectWith({ user, accessToken }); }

  async uids(criteria) {
    const found = await this.imap.search(toImapflowQuery(criteria), { uid: true });
    return (found || []).map(String);
  }

  /**
   * The messages with these UIDs, one at a time: envelopes and sizes first (cheap), then each body. A message over
   * maxMessageBytes is yielded as a stub without its body; one mailparser cannot read is yielded with `parseError`.
   */
  async *fetch({ uidList, bulk = 500 }) {
    for (let i = 0; i < uidList.length; i += bulk) {
      const batch = uidList.slice(i, i + bulk);
      const heads = await this.imap.fetchAll(asUidRange(batch), { uid: true, envelope: true, size: true, flags: true }, { uid: true });
      for (const h of heads) {
        const stub = { uid: String(h.uid), messageId: h.envelope?.messageId || null, subject: h.envelope?.subject || '', date: h.envelope?.date || null, from: h.envelope?.from?.[0]?.address || '', size: h.size || 0, flags: h.flags || new Set(), attachments: [] };
        if (stub.size > this.maxMessageBytes) { yield { ...stub, oversize: true }; continue; }
        const full = await this.imap.fetchOne(String(h.uid), { uid: true, source: true }, { uid: true });
        if (!full?.source?.length) { yield { ...stub, parseError: 'The server returned no message body.' }; continue; }
        try { yield await toMailMessage({ uid: h.uid, raw: full.source, flags: h.flags, size: h.size, envelope: h.envelope }); } catch (e) { yield { ...stub, raw: full.source, parseError: e.message }; }
      }
    }
  }

  async delete(uids) { await this.imap.messageDelete(asUidRange(uids), { uid: true }); }
  async move(uids, folder) {
    const r = await this.imap.messageMove(asUidRange(uids), folder, { uid: true });
    if (r === false) throw new Error(`Could not move the message to ${folder}.`);
  }
  async flag(uids, flags, value) {
    const list = [...flags];
    if (value) await this.imap.messageFlagsAdd(asUidRange(uids), list, { uid: true });
    else await this.imap.messageFlagsRemove(asUidRange(uids), list, { uid: true });
  }
  async storeLabel(cmd, uid, op, label) {
    if (cmd !== 'STORE' || op !== '+X-GM-LABELS') throw new Error(`Unsupported command ${cmd} ${op}.`);
    await this.imap.messageFlagsAdd(String(uid), [label], { uid: true, useLabels: true });
  }
  async close() {
    const imap = this.imap; this.imap = null;
    if (!imap) return;
    try { await imap.logout(); } catch { imap.close?.(); } // a connection already gone has nothing to log out of
  }
}
