// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Paperless-ngx (https://github.com/paperless-ngx/paperless-ngx), GPL-3.0.
//   Source: src/paperless_mail/mail.py (the action classes, `get_rule_action`, `make_criterias`, `mailbox_login`,
//   `apply_mail_action`, `get_mailbox` with `PinnedIMAP4`/`PinnedMailBox`, and `MailAccountHandler`: `_get_title`,
//   `_get_uid_validity`, `_get_correspondent`, `handle_mail_account`, `_handle_mail_rule`, `_handle_message`,
//   `_record_processed_without_consumption`, `filename_inclusion_matches`, `filename_exclusion_matches`,
//   `_process_attachments`, `_process_eml`) and the rule model's choices in src/paperless_mail/models.py, commit
//   c50c6f5517e3fd8f97fa546ede69a52b622e2b20; the Python is kept unchanged in ./reference/ for provenance.
//   Modified: translated to JavaScript for GinChugger, 15 October 2026 (product v2 spec 10.B). Only the logic is
//   ported. Not ported: Django models (accounts, rules and the processed-mail record are plain data and a store
//   interface), Celery (consumption is the injected `queueConsumptionTasks`; the post-consume action is
//   `applyMailAction` run in-process by the caller, without its own connection), the GPG preprocessor, the OAuth
//   refresh manager (injected `refreshAccountToken`), the From-header reordering in `_process_eml` (a workaround for
//   libmagic; the .eml is kept as received), temporary files (payloads stay in memory). IMAP is the `M` interface below,
//   implemented over imapflow in server/mail/imapflow-mailbox.js; criteria are data objects, not IMAP strings.
//   Additions, marked "GinChugger:": MailError carries a `code`; skipped attachments and rule/account errors are kept
//   on the handler (`skipped`, `ruleErrors`, `accountError`) for the status page, where Paperless only logs them.
//
// Python -> JavaScript semantics this file keeps (spec 10.B.4):
// - fnmatch is Python's fnmatch.translate (`*`, `?`, `[seq]`, `[!seq]`; whole-name match), not a shell glob; both
//   sides are lowercased by the callers, as in Paperless.
// - Titles and file names are NFC-normalised (test_mail_nfc.py); subjects are truncated by code point, not UTF-16 unit.
// - `date.today() - timedelta(days=maximum_age)` is a local calendar date; IMAP SINCE compares dates, inclusive.
// - UIDs are strings, as imap_tools returns them; they sort numerically.
//
// The `M` (mailbox) interface the handler uses, after imap_tools.MailBox:
//   M.client.capabilities: string[]; M.client.uid('STORE', uid, '+X-GM-LABELS', label)
//   M.login(user, pass), M.loginUtf8(user, pass), M.xoauth2(user, token)      (throw MailboxLoginError)
//   M.folder.set(name) (throws MailboxFolderSelectError), M.folder.status(name, ['UIDVALIDITY']) -> { UIDVALIDITY },
//   M.folder.list() -> [{ name }]
//   M.uids(criteria, charset) -> string[]; M.fetch({ uidList, markSeen, bulk }) -> (async) iterable of messages
//   M.delete(uids), M.flag(uids, flags, value), M.move(uids, folder), M.close()
// A message: { uid, subject, from, fromValues: { name, email }, to: [], text, date, raw, attachments: [{ filename,
//   contentDisposition, contentType, payload }] }.
import path from 'node:path';
import { isPublicIp, resolveHostnameIps } from './network.js';

// ---- models.py choices (MailRule, MailAccount), as plain numbers with the same values.
export const ImapSecurity = Object.freeze({ NONE: 1, SSL: 2, STARTTLS: 3 });
export const ConsumptionScope = Object.freeze({ ATTACHMENTS_ONLY: 1, EML_ONLY: 2, EVERYTHING: 3 });
export const AttachmentProcessing = Object.freeze({ ATTACHMENTS_ONLY: 1, EVERYTHING: 2 });
export const MailAction = Object.freeze({ DELETE: 1, MOVE: 2, MARK_READ: 3, FLAG: 4, TAG: 5 });
export const TitleSource = Object.freeze({ FROM_SUBJECT: 1, FROM_FILENAME: 2, NONE: 3 });
export const CorrespondentSource = Object.freeze({ FROM_NOTHING: 1, FROM_EMAIL: 2, FROM_NAME: 3, FROM_CUSTOM: 4 });
export const MATCH_LITERAL = 'literal';

/** A rule with the model's defaults (models.py MailRule). */
export function mailRule(fields = {}) {
  return {
    id: null, name: '', account: null, enabled: true, order: 0, folder: 'INBOX',
    filterFrom: null, filterTo: null, filterSubject: null, filterBody: null,
    filterAttachmentFilenameInclude: null, filterAttachmentFilenameExclude: null,
    maximumAge: 30, attachmentType: AttachmentProcessing.ATTACHMENTS_ONLY, consumptionScope: ConsumptionScope.ATTACHMENTS_ONLY,
    action: MailAction.MARK_READ, actionParameter: null, assignTitleFrom: TitleSource.FROM_SUBJECT,
    assignTags: [], assignDocumentType: null, assignCorrespondentFrom: CorrespondentSource.FROM_NOTHING, assignCorrespondent: null,
    owner: null, assignOwnerFromRule: true, stopProcessing: false,
    ...fields,
  };
}

// imap_tools.MailMessageFlags
export const MailMessageFlags = Object.freeze({ SEEN: '\\Seen', FLAGGED: '\\Flagged' });

export const APPLE_MAIL_TAG_COLORS = {
  red: [],
  orange: ['$MailFlagBit0'],
  yellow: ['$MailFlagBit1'],
  blue: ['$MailFlagBit2'],
  green: ['$MailFlagBit0', '$MailFlagBit1'],
  violet: ['$MailFlagBit0', '$MailFlagBit2'],
  grey: ['$MailFlagBit1', '$MailFlagBit2'],
};

export const MAIL_FETCH_BATCH_SIZE = 500;
export const PROCESSED_UID_QUERY_BATCH_SIZE = 10_000;

export class MailError extends Error {
  constructor(message, { cause, code = 'mail_error', ...extra } = {}) { super(message, cause ? { cause } : undefined); this.name = 'MailError'; this.code = code; Object.assign(this, extra); } // GinChugger: code
}
// imap_tools.errors, raised by an `M` implementation.
export class MailboxFolderSelectError extends Error { constructor(message) { super(message); this.name = 'MailboxFolderSelectError'; } }
export class MailboxFolderStatusError extends Error { constructor(message) { super(message); this.name = 'MailboxFolderStatusError'; } }
export class MailboxLoginError extends Error { constructor(message) { super(message); this.name = 'MailboxLoginError'; } }

const nfc = s => String(s ?? '').normalize('NFC');
const codePoints = (s, n) => Array.from(String(s ?? '')).slice(0, n).join('');

// ---- Mail actions

export class BaseMailAction {
  /** Filtering criteria for this action, as data. */
  getCriteria() { return {}; }
  async postConsume(M, messageUid, parameter) { throw new Error('Not implemented.'); } // eslint-disable-line no-unused-vars
}
export class DeleteMailAction extends BaseMailAction {
  async postConsume(M, messageUid) { await M.delete([messageUid]); }
}
export class MarkReadMailAction extends BaseMailAction {
  getCriteria() { return { seen: false }; }
  async postConsume(M, messageUid) { await M.flag([messageUid], [MailMessageFlags.SEEN], true); }
}
export class MoveMailAction extends BaseMailAction {
  async postConsume(M, messageUid, parameter) { await M.move([messageUid], parameter); }
}
export class FlagMailAction extends BaseMailAction {
  getCriteria() { return { flagged: false }; }
  async postConsume(M, messageUid) { await M.flag([messageUid], [MailMessageFlags.FLAGGED], true); }
}
export class TagMailAction extends BaseMailAction {
  constructor(parameter, { supportsGmailLabels }) {
    super();
    // The custom tag should look like "apple:<color>"
    if (String(parameter).toLowerCase().includes('apple:')) {
      this.color = String(parameter).split(':')[1].trim();
      if (!(this.color.toLowerCase() in APPLE_MAIL_TAG_COLORS)) throw new MailError('Not a valid AppleMail tag color.');
      this.keyword = null;
    } else {
      this.keyword = parameter;
      this.color = null;
    }
    this.supportsGmailLabels = supportsGmailLabels;
  }

  getCriteria() {
    // AppleMail: We only need to check if mails are \Flagged
    if (this.color) return { flagged: false };
    if (this.keyword) return this.supportsGmailLabels ? { not: { gmailLabel: this.keyword }, noKeyword: this.keyword } : { noKeyword: this.keyword };
    throw new Error('This should never happen.');
  }

  async postConsume(M, messageUid) {
    if (this.supportsGmailLabels) {
      await M.client.uid('STORE', messageUid, '+X-GM-LABELS', this.keyword);
    } else if (this.color) { // AppleMail
      // Remove all existing $MailFlagBits
      await M.flag([messageUid], [...new Set(Object.values(APPLE_MAIL_TAG_COLORS).flat())], false);
      // Set new $MailFlagBits
      await M.flag([messageUid], APPLE_MAIL_TAG_COLORS[this.color], true);
      // Set the general \Flagged: "red" in AppleMail, "stars" in Thunderbird or Gmail
      await M.flag([messageUid], [MailMessageFlags.FLAGGED], true);
    } else if (this.keyword) {
      await M.flag([messageUid], [this.keyword], true);
    } else {
      throw new MailError('No keyword specified.');
    }
  }
}

export async function mailboxLogin(M, account, log = console) {
  try {
    if (account.isToken) {
      await M.xoauth2(account.username, account.password);
    } else if (/^[\x00-\x7f]*$/.test(account.password)) {
      await M.login(account.username, account.password);
    } else {
      log.debug?.('Falling back to AUTH=PLAIN');
      await M.loginUtf8(account.username, account.password);
    }
  } catch (e) {
    log.error?.(`Error while authenticating account ${account.name}: ${e.message}`);
    throw new MailError(`Error while authenticating account ${account.name}`, { cause: e, code: 'mail_auth' });
  }
}

/**
 * apply_mail_action without Celery: run the rule's action on one message and write the processed-mail record
 * (SUCCESS, or FAILED with the error, which is then raised again). Paperless opens its own connection here; the caller
 * hands over the mailbox, logged in and with the rule's folder selected.
 */
export async function applyMailAction(M, rule, { uid, subject, date, uidValidity = null }, { processed, supportsGmailLabels = false, log = console }) {
  try {
    const action = getRuleAction(rule, { supportsGmailLabels });
    try {
      await action.postConsume(M, uid, rule.actionParameter);
    } catch (e) {
      log.error?.(`Error while processing mail action during post_consume: ${e.message}`);
      throw e;
    }
    await processed.create({ owner: rule.owner, ruleId: rule.id, folder: rule.folder, uid, uidValidity, subject: codePoints(subject, 256), received: date, status: 'SUCCESS' });
  } catch (e) {
    await processed.create({ owner: rule.owner, ruleId: rule.id, folder: rule.folder, uid, uidValidity, subject: codePoints(subject, 256), received: date, status: 'FAILED', error: String(e?.stack || e) });
    throw e;
  }
}

export function getRuleAction(rule, { supportsGmailLabels }) {
  switch (rule.action) {
    case MailAction.FLAG: return new FlagMailAction();
    case MailAction.DELETE: return new DeleteMailAction();
    case MailAction.MOVE: return new MoveMailAction();
    case MailAction.MARK_READ: return new MarkReadMailAction();
    case MailAction.TAG: return new TagMailAction(rule.actionParameter, { supportsGmailLabels });
    default: throw new Error('Unknown action.');
  }
}

/** A local calendar date as YYYY-MM-DD (Python's date). */
export const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** make_criterias: the search for a rule, as data. `{ all: true }` is imap_tools' "ALL". */
export function makeCriterias(rule, { supportsGmailLabels, today = new Date() }) {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - rule.maximumAge);
  const criterias = {};
  if (rule.maximumAge > 0) criterias.dateGte = isoDate(day);
  if (rule.filterFrom) criterias.from = rule.filterFrom;
  if (rule.filterTo) criterias.to = rule.filterTo;
  if (rule.filterSubject) criterias.subject = rule.filterSubject;
  if (rule.filterBody) criterias.body = rule.filterBody;
  const ruleQuery = getRuleAction(rule, { supportsGmailLabels }).getCriteria();
  if (Object.keys(ruleQuery).length || Object.keys(criterias).length) return { ...ruleQuery, ...criterias };
  return { all: true };
}

// ---- Host pinning (PinnedIMAP4, PinnedMailBox, get_mailbox; spec 10.B.6)

/**
 * get_mailbox: resolve the server once, refuse it when any address is not public (unless internal hosts are allowed),
 * and build the mailbox against those addresses while keeping the name for TLS SNI and certificate checks.
 * `createMailbox({ host, port, security, pinnedIps })` builds the `M` (PinnedMailBox / Unencrypted / StartTls).
 */
export async function getMailbox(server, port, security, { allowInternalHosts = false, resolve = resolveHostnameIps, createMailbox }) {
  let pinnedIps = null;
  if (!allowInternalHosts) {
    try { pinnedIps = await resolve(server); } catch (e) { throw new MailError(e.message, { cause: e, code: 'mail_resolve' }); }
    for (const ip of pinnedIps) {
      if (!isPublicIp(ip)) throw new MailError(`Connection blocked: ${server} resolves to a non-public address`, { code: 'mail_private_address', address: ip });
    }
  }
  if (![ImapSecurity.NONE, ImapSecurity.SSL, ImapSecurity.STARTTLS].includes(security)) throw new Error('Unknown IMAP security');
  if (security === ImapSecurity.STARTTLS && Number(port) === 993) throw new Error('Port 993 requires IMAP4_SSL. Use MailBox class for SSL/TLS connection.');
  return createMailbox({ host: server, port, security, pinnedIps });
}

// ---- fnmatch (Python's fnmatch.translate, which Paperless's filters use)

function translate(pat) {
  let i = 0; const n = pat.length; let res = '';
  while (i < n) {
    const c = pat[i++];
    if (c === '*') { if (!res.endsWith('.*')) res += '.*'; } // consecutive stars compress to one
    else if (c === '?') res += '.';
    else if (c === '[') {
      let j = i;
      if (j < n && pat[j] === '!') j++;
      if (j < n && pat[j] === ']') j++;
      while (j < n && pat[j] !== ']') j++;
      if (j >= n) res += '\\[';
      else {
        let stuff = pat.slice(i, j); i = j + 1;
        const negate = stuff[0] === '!';
        if (negate) stuff = stuff.slice(1);
        stuff = stuff.replace(/[\\\]\[]/g, '\\$&');
        if (!negate && stuff[0] === '^') stuff = '\\' + stuff;
        res += stuff === '' ? (negate ? '.' : '(?!)') : `[${negate ? '^' : ''}${stuff}]`;
      }
    } else res += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^(?:${res})$`, 'su');
}
const fnmatchCache = new Map();
/** Python fnmatch.fnmatch on POSIX (normcase is the identity there). */
export function fnmatch(name, pattern) {
  let re = fnmatchCache.get(pattern);
  if (!re) { re = translate(pattern); if (fnmatchCache.size > 500) fnmatchCache.clear(); fnmatchCache.set(pattern, re); }
  return re.test(name);
}

/**
 * pathvalidate.sanitize_filename for the "universal" platform, as far as the names here need it: invalid characters
 * and control characters removed, trailing spaces and periods dropped, reserved device names suffixed, 255 bytes.
 */
export function sanitizeFilename(name) {
  let s = String(name ?? '').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '').trim().replace(/[ .]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) s = s.replace(/^([^.]+)/, '$1_');
  while (Buffer.byteLength(s, 'utf8') > 255) s = Array.from(s).slice(0, -1).join('');
  return s;
}

// ---- The handler

export class MailAccountHandler {
  /**
   * @param deps.getMailbox (server, port, security) -> M
   * @param deps.queueConsumptionTasks ({ consumeTasks, rule, message, uidValidity }) -> void
   * @param deps.processed { list({ ruleId, folder, uids }) -> rows, getOrCreate(key, defaults), create(row) }
   * @param deps.correspondentFromName (name) -> correspondent (Correspondent.objects.get_or_create)
   * @param deps.detectMimeType (payload, att) -> mime type (magic.from_buffer); deps.isMimeTypeSupported (mime) -> bool
   * @param deps.refreshAccountToken (account) -> bool (PaperlessMailOAuth2Manager.refresh_account_oauth_token)
   */
  constructor({ getMailbox: open, queueConsumptionTasks, processed, correspondentFromName = name => ({ name, match: name, matchingAlgorithm: MATCH_LITERAL }), detectMimeType = () => 'application/octet-stream', isMimeTypeSupported = () => false, refreshAccountToken = async () => false, log = console, today = () => new Date(), now = () => new Date() } = {}) {
    Object.assign(this, { openMailbox: open, queueConsumptionTasks, processed, correspondentFromNameImpl: correspondentFromName, detectMimeType, isMimeTypeSupported, refreshAccountToken, log, today, now });
    this.currentUidValidity = null;
    this.messagePreprocessors = []; // the GPG decryptor is not ported
    this.skipped = []; this.ruleErrors = []; this.accountError = null; // GinChugger: kept for the status page
  }

  /** GinChugger: what Paperless only logs at debug level, kept per message for the reason in the status page. */
  noteSkipped(message, att, reason) { this.skipped.push({ uid: message.uid, filename: att?.filename ?? null, reason }); }

  correspondentFromName(name) {
    try { return this.correspondentFromNameImpl(name); } catch (e) { this.log.error?.(`Error while retrieving correspondent ${name}: ${e.message}`); return null; }
  }

  getTitle(message, att, rule) {
    if (rule.assignTitleFrom === TitleSource.FROM_SUBJECT) return nfc(message.subject);
    if (rule.assignTitleFrom === TitleSource.FROM_FILENAME) return nfc(path.posix.parse(String(att.filename)).name);
    if (rule.assignTitleFrom === TitleSource.NONE) return null;
    throw new Error('Unknown title selector.');
  }

  async getUidValidity(M, folder) {
    try {
      const v = (await M.folder.status(folder, ['UIDVALIDITY']))?.UIDVALIDITY;
      if (v !== undefined && v !== null) return String(v);
    } catch (e) {
      if (e instanceof MailboxFolderStatusError) this.log.warn?.(`Server does not support retrieving UIDVALIDITY for folder ${folder}: ${e.message}`);
      else this.log.warn?.(`Unable to retrieve UIDVALIDITY for folder ${folder}: ${e.message}`);
    }
    return null;
  }

  getCorrespondent(message, rule) {
    const from = rule.assignCorrespondentFrom;
    if (from === CorrespondentSource.FROM_NOTHING) return null;
    if (from === CorrespondentSource.FROM_EMAIL) return this.correspondentFromName(message.from);
    if (from === CorrespondentSource.FROM_NAME) {
      const values = message.fromValues;
      return values && values.name && values.name.length > 0 ? this.correspondentFromName(values.name) : this.correspondentFromName(message.from);
    }
    if (from === CorrespondentSource.FROM_CUSTOM) return rule.assignCorrespondent;
    throw new Error('Unknown correspondent selector');
  }

  /** Main entry: every enabled rule of the account, in order. Returns the number of files queued. */
  async handleMailAccount(account) {
    this.log.debug?.(`Processing mail account ${account.name}`);
    let total = 0;
    const consumedMessages = new Set();
    try {
      const M = await this.openMailbox(account.imapServer, account.imapPort, account.imapSecurity);
      try {
        if (account.isToken && account.expiration && account.expiration < this.now()) {
          if (!(await this.refreshAccountToken(account))) return total;
        }
        const supportsGmailLabels = (M.client?.capabilities || []).includes('X-GM-EXT-1');
        await mailboxLogin(M, account, this.log);
        const rules = [...(account.rules || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        for (const rule of rules) {
          if (!rule.enabled) { this.log.debug?.(`Rule ${rule.name}: Skipping disabled rule`); continue; }
          try {
            total += await this.handleMailRule(M, rule, { supportsGmailLabels, consumedMessages, account });
            if (total > 0 && rule.stopProcessing) break;
          } catch (e) {
            this.log.error?.(`Rule ${rule.name}: Error while processing rule: ${e.message}`);
            this.ruleErrors.push({ rule, error: e });
          }
        }
      } finally {
        await M.close?.();
      }
    } catch (e) {
      if (e instanceof MailError) throw e;
      this.log.error?.(`Error while retrieving mailbox ${account.name}: ${e.message}`);
      this.accountError = e;
    }
    return total;
  }

  preprocessMessage(message) {
    for (const p of this.messagePreprocessors) message = p.run(message);
    return message;
  }

  processedFilter(rows) {
    const v = this.currentUidValidity;
    return v === null ? rows : rows.filter(r => r.uidValidity === v || r.uidValidity === null || r.uidValidity === undefined);
  }

  async handleMailRule(M, rule, { supportsGmailLabels, consumedMessages, account = rule.account }) {
    const folders = [rule.folder];
    // In case of MOVE, make sure also the destination exists
    if (rule.action === MailAction.MOVE) folders.unshift(rule.actionParameter);
    let folder;
    try {
      for (folder of folders) { this.log.debug?.(`Rule ${rule.name}: Selecting folder ${folder}`); await M.folder.set(folder); }
    } catch (err) {
      if (!(err instanceof MailboxFolderSelectError)) throw err;
      this.log.error?.(`Unable to access folder ${folder}, attempting folder listing`);
      try {
        for (const info of await M.folder.list()) this.log.info?.(`Located folder: ${info.name}`);
      } catch (e) {
        this.log.error?.('Exception during folder listing, unable to provide list folders: ' + e.message);
      }
      throw new MailError(`Rule ${rule.name}: Folder ${folder} does not exist in account ${account?.name}`, { cause: err, code: 'folder_missing', folder });
    }

    this.currentUidValidity = await this.getUidValidity(M, rule.folder);
    const criterias = makeCriterias(rule, { supportsGmailLabels, today: this.today() });
    this.log.debug?.(`Rule ${rule.name}: Searching folder with criteria ${JSON.stringify(criterias)}`);

    let allUids;
    try {
      allUids = new Set((await M.uids(criterias, account?.characterSet)).map(String));
    } catch (err) {
      throw new MailError(`Rule ${rule.name}: Error while searching folder ${rule.folder}`, { cause: err });
    }
    const list = [...allUids];
    const processedUids = new Set();
    for (let i = 0; i < list.length; i += PROCESSED_UID_QUERY_BATCH_SIZE) {
      const chunk = list.slice(i, i + PROCESSED_UID_QUERY_BATCH_SIZE);
      for (const r of this.processedFilter(await this.processed.list({ ruleId: rule.id, folder: rule.folder, uids: chunk }))) processedUids.add(String(r.uid));
    }
    const newUids = list.filter(u => !processedUids.has(u));
    if (!newUids.length) { this.log.debug?.(`Rule ${rule.name}: No new mail matching criteria`); return 0; }

    const sorted = newUids.sort((a, b) => Number(a) - Number(b));
    let messages;
    try {
      messages = await M.fetch({ uidList: sorted, markSeen: false, bulk: MAIL_FETCH_BATCH_SIZE });
    } catch (err) {
      throw new MailError(`Rule ${rule.name}: Error while fetching folder ${rule.folder}`, { cause: err });
    }

    let mailsProcessed = 0; let total = 0;
    const ruleSeen = new Set();
    for await (const message of messages) {
      const key = `${rule.folder}\u0000${message.uid}`;
      if (ruleSeen.has(key)) { this.log.debug?.(`Skipping duplicate fetched mail '${message.uid}'.`); continue; }
      ruleSeen.add(key);
      if (consumedMessages.has(key)) { this.log.debug?.(`Skipping mail '${message.uid}', already queued by a previous rule in this run.`); continue; }
      const already = this.processedFilter(await this.processed.list({ ruleId: rule.id, folder: rule.folder, uids: [message.uid] }));
      if (already.length) { this.log.debug?.(`Skipping mail '${message.uid}', already processed.`); continue; }
      try {
        const n = await this.handleMessage(message, rule);
        if (n > 0) consumedMessages.add(key);
        total += n; mailsProcessed += 1;
      } catch (e) {
        this.log.error?.(`Rule ${rule.name}: Error while processing mail ${message.uid}: ${e.message}`);
      }
    }
    this.log.debug?.(`Rule ${rule.name}: Processed ${mailsProcessed} matching mail(s)`);
    return total;
  }

  async handleMessage(message, rule) {
    message = this.preprocessMessage(message);
    let processedElements = 0;
    // Skip Message handling when only attachments are to be processed but message doesn't have any.
    if (!message.attachments.length && rule.consumptionScope === ConsumptionScope.ATTACHMENTS_ONLY) {
      await this.recordProcessedWithoutConsumption(message, rule);
      return processedElements;
    }
    this.log.debug?.(`Rule ${rule.name}: Processing mail ${message.subject} from ${message.from} with ${message.attachments.length} attachment(s)`);
    const tagIds = (rule.assignTags || []).map(t => t.id ?? t);
    const docType = rule.assignDocumentType;
    if (rule.consumptionScope === ConsumptionScope.EML_ONLY || rule.consumptionScope === ConsumptionScope.EVERYTHING) processedElements += await this.processEml(message, rule, tagIds, docType);
    if (rule.consumptionScope === ConsumptionScope.ATTACHMENTS_ONLY || rule.consumptionScope === ConsumptionScope.EVERYTHING) processedElements += await this.processAttachments(message, rule, tagIds, docType);
    return processedElements;
  }

  async recordProcessedWithoutConsumption(message, rule) {
    await this.processed.getOrCreate(
      { ruleId: rule.id, uid: message.uid, folder: rule.folder, uidValidity: this.currentUidValidity },
      { owner: rule.owner, subject: codePoints(message.subject, 256), received: message.date, status: 'PROCESSED_WO_CONSUMPTION' },
    );
  }

  filenameInclusionMatches(include, filename) {
    if (include) {
      // Force the filename and pattern to the lowercase as this is system dependent otherwise
      const name = String(filename).toLowerCase();
      for (const p of include.split(',')) if (p && fnmatch(name, p.toLowerCase())) return true;
      return false;
    }
    return true;
  }

  filenameExclusionMatches(exclude, filename) {
    if (exclude) {
      const name = String(filename).toLowerCase();
      for (const p of exclude.split(',')) if (p && fnmatch(name, p.toLowerCase())) return true;
    }
    return false;
  }

  async processAttachments(message, rule, tagIds, docType) {
    let processedAttachments = 0;
    const consumeTasks = [];
    for (const att of message.attachments) {
      if (att.contentDisposition !== 'attachment' && rule.attachmentType === AttachmentProcessing.ATTACHMENTS_ONLY) {
        this.log.debug?.(`Rule ${rule.name}: Skipping attachment ${att.filename} with content disposition ${att.contentDisposition}`);
        continue;
      }
      if (!this.filenameInclusionMatches(rule.filterAttachmentFilenameInclude, att.filename)) {
        this.log.debug?.(`Rule ${rule.name}: Skipping attachment ${att.filename} does not match pattern ${rule.filterAttachmentFilenameInclude}`);
        this.noteSkipped(message, att, 'include');
        continue;
      } else if (this.filenameExclusionMatches(rule.filterAttachmentFilenameExclude, att.filename)) {
        this.log.debug?.(`Rule ${rule.name}: Skipping attachment ${att.filename} does match pattern ${rule.filterAttachmentFilenameExclude}`);
        this.noteSkipped(message, att, 'exclude');
        continue;
      }
      const correspondent = this.getCorrespondent(message, rule);
      const title = this.getTitle(message, att, rule);
      // don't trust the content type of the attachment. Could be generic application/octet-stream.
      const mimeType = await this.detectMimeType(att.payload, att);
      if (this.isMimeTypeSupported(mimeType, att)) {
        this.log.info?.(`Rule ${rule.name}: Consuming attachment ${att.filename} from mail ${message.subject} from ${message.from}`);
        const attachmentName = sanitizeFilename(nfc(att.filename));
        consumeTasks.push({
          inputDoc: { source: 'MailFetch', filename: attachmentName || 'no-name-attachment', payload: att.payload, mimeType, mailruleId: rule.id },
          overrides: { title, filename: attachmentName, correspondent, documentType: docType ?? null, tagIds, owner: rule.assignOwnerFromRule && rule.owner ? rule.owner : null },
        });
        processedAttachments += 1;
      } else {
        this.log.debug?.(`Rule ${rule.name}: Skipping attachment ${att.filename} since guessed mime type ${mimeType} is not supported`);
        this.noteSkipped(message, att, `type ${mimeType}`);
      }
    }
    if (consumeTasks.length > 0) await this.queueConsumptionTasks({ consumeTasks, rule, message, uidValidity: this.currentUidValidity });
    else await this.recordProcessedWithoutConsumption(message, rule); // no files to consume
    return processedAttachments;
  }

  async processEml(message, rule, tagIds, docType) {
    const correspondent = this.getCorrespondent(message, rule);
    this.log.info?.(`Rule ${rule.name}: Consuming eml from mail ${message.subject} from ${message.from}`);
    const filename = sanitizeFilename(nfc(`${message.subject}.eml`));
    const consumeTask = {
      inputDoc: { source: 'MailFetch', filename, payload: message.raw, mimeType: 'message/rfc822', mailruleId: rule.id },
      overrides: { title: message.subject, filename, correspondent, documentType: docType ?? null, tagIds, owner: rule.owner ?? null },
    };
    await this.queueConsumptionTasks({ consumeTasks: [consumeTask], rule, message, uidValidity: this.currentUidValidity });
    return 1;
  }
}
