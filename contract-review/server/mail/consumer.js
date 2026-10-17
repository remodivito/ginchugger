// SPDX-License-Identifier: GPL-3.0-or-later
// Mailbox capture on the team server (product v2 spec 7.2, decision 162, PR-IN-03 to 05, PR-SEC-02): one shared
// mailbox, two built-in rules that share one code path (the inbox, for forwarded mail, and the "To file" folder, for
// mail dragged there), each a rule of the ported Paperless-ngx consumer (server/ports/paperless/mail.js). This file is
// the plumbing around the port: the schedule and back-off, the OAuth token, the pinned connection, the processed-mail
// record in the record's SQLite, and what a capture is here: documents in the document store (server/store/index.js;
// plan task 9), written as `system:mail`. The covering email is a document of its own (type "Email", tagged "inbox");
// each contract attachment is a document tagged "inbox" with a note naming that email; each gets the counterparty that
// matching suggests (server/store/matching.js: sender, then subject, then its own text). No other mail is read: only
// these two folders of this one mailbox (PR-IN-05, PR-SEC-09).
//
// Per message (7.2 steps 3 to 6 and "Fails when"):
//   - over the size limit, unreadable MIME, an attachment over mail.attachments.maxBytes, or a store failure (the store
//     unavailable, a consume task failed): moved to the "Not filed" folder, processed_mail outcome `failed` with the reason;
//   - a Message-ID already processed (a re-delivery, or UIDs reset by a UIDVALIDITY change): `skipped`, "already
//     processed", moved to "Filed", nothing captured;
//   - matching attachments: the .eml a store document, each attachment one with the note
//     "Came with email: <subject> (document <id>)": `captured`;
//   - none, and a body over 200 characters: the .eml alone is the store document: `captured` ("email only");
//   - none and a short body: `no-attachment`, or `skipped` naming the attachments that are not documents we file.
// This module imports nothing that reaches executors.js (PR-TEAM-01): it captures; it never reviews.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  MailAccountHandler, MailError, getMailbox, mailRule, MoveMailAction, getRuleAction, sanitizeFilename,
  MailAction, ConsumptionScope, AttachmentProcessing, TitleSource, CorrespondentSource, ImapSecurity,
} from '../ports/paperless/mail.js';
import { resolveHostnameIps } from '../ports/paperless/network.js';
import { ImapFlowMailBox } from './imapflow-mailbox.js';
import { tokenProvider } from './oauth.js';
import { extractTextInWorker } from '../record/extract.js';
import { MEDIA, MAX_FILE_BYTES, htmlToText } from '../record/files.js';
import { TAG_INBOX, titleFromName } from '../store/index.js';
import { suggestStoreCounterparty, senderForMatching } from '../store/matching.js';

export const MAIL_ACTOR = 'system:mail';
/** Who the store's calls are made as (the store's `actor`): the mailbox, never an admin. */
export const MAIL_STORE_ACTOR = { id: null, name: MAIL_ACTOR, admin: false };
export const EMAIL_TYPE = 'Email';
export const EML_ONLY_MIN_BODY = 200;
export const CHECK_FLAG = 'mail-check-requested';
export const MAX_BACKOFF_MINUTES = 60;
const DAY_MS = 86_400_000;
const noStore = () => { throw Object.assign(new Error('The document store is unavailable.'), { status: 503, code: 'store_unavailable' }); };
const mb = n => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
const short = s => { const t = String(s || '(no subject)').replace(/\s+/g, ' ').trim(); return t.length > 80 ? t.slice(0, 79) + '…' : t; };

/** What is wrong with the mail settings, each a sentence for the status page (9.2). Empty when they can be used. */
export function mailConfigProblems(mail) {
  const p = [];
  const str = v => typeof v === 'string' && v.trim() !== '';
  for (const k of ['tenantId', 'clientId', 'mailbox']) if (!str(mail.auth?.[k])) p.push(`mail.auth.${k} is not set.`);
  if (Array.isArray(mail.auth?.mailbox) || (str(mail.auth?.mailbox) && !/^[^\s,;@]+@[^\s,;@]+$/.test(mail.auth.mailbox.trim()))) p.push('mail.auth.mailbox is one mailbox address, such as contracts@firm.example.');
  if (mail.auth?.type !== 'oauth2-client-credentials') p.push('mail.auth.type must be "oauth2-client-credentials".');
  if (!str(mail.auth?.clientSecretFile)) p.push('mail.auth.clientSecretFile is not set.');
  if (!str(mail.host)) p.push('mail.host is not set.');
  if (!Number.isInteger(Number(mail.port)) || Number(mail.port) < 1 || Number(mail.port) > 65535) p.push('mail.port is a port number.');
  const f = mail.folders || {};
  for (const k of ['inbox', 'toFile', 'filed', 'failed']) if (!str(f[k])) p.push(`mail.folders.${k} is not set.`);
  if (new Set([f.inbox, f.toFile, f.filed, f.failed].map(x => String(x || '').toLowerCase())).size < 4) p.push('mail.folders names four different folders.');
  if (!(Number(mail.intervalMinutes) >= 1)) p.push('mail.intervalMinutes is at least 1.');
  if (!(Number.isInteger(Number(mail.maxAgeDays)) && Number(mail.maxAgeDays) >= 0)) p.push('mail.maxAgeDays is a whole number of days.');
  const a = mail.attachments || {};
  for (const k of ['include', 'exclude']) if (!Array.isArray(a[k]) || a[k].some(x => typeof x !== 'string' || x.includes(','))) p.push(`mail.attachments.${k} is a list of file patterns such as "*.docx".`);
  if (!(Number(a.maxBytes) > 0)) p.push('mail.attachments.maxBytes is a size in bytes.');
  return p;
}

/** The two built-in rules (7.2 step 2): same model, same code path; only the folder differs. */
export function builtInRules(mail) {
  const common = {
    enabled: true, maximumAge: Number(mail.maxAgeDays),
    filterAttachmentFilenameInclude: mail.attachments.include.join(','), filterAttachmentFilenameExclude: mail.attachments.exclude.join(','),
    attachmentType: AttachmentProcessing.ATTACHMENTS_ONLY, consumptionScope: ConsumptionScope.EVERYTHING,
    action: MailAction.MOVE, actionParameter: mail.folders.filed,
    assignTitleFrom: TitleSource.FROM_SUBJECT, assignCorrespondentFrom: CorrespondentSource.FROM_NOTHING, // the inbox suggests the counterparty (7.3)
  };
  return [
    mailRule({ ...common, id: 1, name: 'Inbox', order: 1, folder: mail.folders.inbox }),
    mailRule({ ...common, id: 2, name: 'To file', order: 2, folder: mail.folders.toFile }),
  ];
}

/** The back-off after n failures in a row (7.2): the interval doubled per failure, at most an hour. */
export const backoffMinutes = (intervalMinutes, failures) => Math.min(Math.max(MAX_BACKOFF_MINUTES, intervalMinutes), intervalMinutes * 2 ** failures);

/** Content sniffing for attachments (Paperless's "don't trust the content type"): the bytes must agree with the name. */
export function sniffMediaType(payload, att) {
  const ext = path.extname(String(att?.filename || '')).toLowerCase();
  const head = Buffer.isBuffer(payload) ? payload.subarray(0, 8) : Buffer.alloc(0);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return MEDIA['.pdf'];
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return ext === '.docx' ? MEDIA['.docx'] : 'application/zip';
  if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return 'application/x-ole-storage'; // .doc, .xls, .msg
  if (ext === '.eml' || att?.contentType === 'message/rfc822') return MEDIA['.eml'];
  if (ext === '.txt' || ext === '.md') return MEDIA[ext];
  return 'application/octet-stream';
}
/** Supported: a medium section 5.3 accepts, and the one the file's name says. */
export const isFiledMediaType = (mime, att) => Object.values(MEDIA).includes(mime) && MEDIA[path.extname(String(att?.filename || '')).toLowerCase()] === mime;

/** A stored name that keeps its extension and fits the record's 255-character limit. */
function fitName(name, fallback) {
  const clean = sanitizeFilename(String(name || '').normalize('NFC'));
  const ext = path.extname(clean); const stem = clean.slice(0, clean.length - ext.length);
  if (!stem.trim() || !ext) return fallback;
  return Array.from(stem).slice(0, 200).join('').trim() + ext.toLowerCase();
}

/** processed_mail over the record's SQLite: the port's store interface, keyed by folder, UIDVALIDITY and UID. */
export function processedStore(db) {
  const out = r => ({ uid: String(r.uid), uidValidity: r.uidvalidity ? String(r.uidvalidity) : null, outcome: r.outcome, messageId: r.message_id });
  return {
    async list({ folder, uids }) {
      const rows = [];
      for (let i = 0; i < uids.length; i += 500) {
        const chunk = uids.slice(i, i + 500).map(Number);
        rows.push(...db.prepare(`SELECT * FROM processed_mail WHERE folder = ? AND uid IN (${chunk.map(() => '?').join(',')})`).all(folder, ...chunk).map(out));
      }
      return rows;
    },
    async create(row) { this.write(row); },
    async getOrCreate(key, defaults) { const r = db.prepare('SELECT * FROM processed_mail WHERE folder = ? AND uidvalidity = ? AND uid = ?').get(key.folder, Number(key.uidValidity) || 0, Number(key.uid)); if (r) return [out(r), false]; this.write({ ...key, ...defaults }); return [key, true]; },
    write({ folder, uidValidity, uid, messageId = null, outcome, detail = null, at = new Date().toISOString() }) {
      db.prepare('INSERT OR REPLACE INTO processed_mail (folder, uidvalidity, uid, message_id, processed_at, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(folder, Number(uidValidity) || 0, Number(uid), messageId ? String(messageId).slice(0, 500) : null, at, outcome, detail ? String(detail).slice(0, 2000) : null);
    },
    /** A Message-ID already captured, filed or skipped (a failed one may be dragged back to try again). */
    seenMessageId(messageId) { return !!messageId && !!db.prepare("SELECT 1 FROM processed_mail WHERE message_id = ? AND outcome != 'failed' LIMIT 1").get(String(messageId).slice(0, 500)); },
  };
}

/** The ported handler with this product's per-message decisions (7.2 steps 3 to 6). */
class GclMailHandler extends MailAccountHandler {
  constructor({ documents, mail, ourNames, internalDomains = [], store, nowIso, extract, ...base }) {
    super({ ...base, processed: store, detectMimeType: sniffMediaType, isMimeTypeSupported: isFiledMediaType, queueConsumptionTasks: args => this.collect(args) });
    Object.assign(this, { documents, mail, ourNames, internalDomains, store, nowIso, extract });
    this.outcomes = []; this.failures = []; this.foldersReady = false;
  }

  /** Create the three folders the rules use when they are missing (9.1 step 4: the server creates them). */
  async ensureFolders(M) {
    let have = new Set();
    try { have = new Set((await M.folder.list()).map(f => f.name.toLowerCase())); } catch (e) { this.log.warn?.(`Mail: could not list folders: ${e.message}`); }
    for (const name of [this.mail.folders.toFile, this.mail.folders.filed, this.mail.folders.failed]) {
      if (have.has(name.toLowerCase())) continue;
      try { await M.folder.create(name); this.log.log?.(`Mail: created the folder "${name}".`); } catch (e) { this.log.warn?.(`Mail: could not create the folder "${name}": ${e.message}`); }
    }
  }

  async handleMailRule(M, rule, opts) {
    this.M = M;
    if (!this.foldersReady) { this.foldersReady = true; await this.ensureFolders(M); }
    try { return await super.handleMailRule(M, rule, opts); } catch (e) {
      if (e.code === 'folder_missing') throw new MailError(`Folder '${e.folder}' not found in the mailbox.`, { code: 'folder_missing', folder: e.folder, cause: e });
      throw e;
    }
  }

  collect({ consumeTasks, message }) {
    for (const task of consumeTasks) {
      if (task.inputDoc.payload === message.raw && task.inputDoc.mimeType === 'message/rfc822') this.pending.eml = task;
      else this.pending.attachments.push(task);
    }
  }
  async recordProcessedWithoutConsumption() { /* the commit below decides and records */ }

  record_(message, outcome, detail) {
    this.store.write({ folder: this.ruleNow.folder, uidValidity: this.currentUidValidity, uid: message.uid, messageId: message.messageId, outcome, detail, at: this.nowIso() });
    this.outcomes.push({ folder: this.ruleNow.folder, uid: message.uid, subject: message.subject, outcome, detail });
  }

  async postAction(message, rule) {
    try { await getRuleAction(rule, { supportsGmailLabels: false }).postConsume(this.M, message.uid, rule.actionParameter); return null; } catch (e) {
      this.log.error?.(`Mail: could not move "${short(message.subject)}" to ${rule.actionParameter}: ${e.message}`);
      return `not moved to ${rule.actionParameter}: ${e.message}`;
    }
  }

  async fail(message, rule, reason) {
    let detail = reason;
    try { await new MoveMailAction().postConsume(this.M, message.uid, this.mail.folders.failed); } catch (e) { detail += `; not moved to ${this.mail.folders.failed}: ${e.message}`; }
    this.record_(message, 'failed', detail);
    this.failures.push(`"${short(message.subject)}" not filed: ${detail}`);
    this.log.warn?.(`Mail: "${short(message.subject)}" not filed: ${detail}`);
    return 0;
  }

  async handleMessage(message, rule) {
    this.ruleNow = rule;
    if (message.oversize) return this.fail(message, rule, `the message is ${mb(message.size)}, over the ${mb(MAX_FILE_BYTES)} a stored email may be.`);
    if (message.parseError) return this.fail(message, rule, `the message could not be read (${message.parseError}).`);
    if (this.store.seenMessageId(message.messageId)) {
      const moved = await this.postAction(message, rule);
      this.record_(message, 'skipped', ['already processed', moved].filter(Boolean).join('; '));
      return 0;
    }
    this.pending = { eml: null, attachments: [] };
    this.skipped = [];
    try { await super.handleMessage(message, rule); } catch (e) { return this.fail(message, rule, e.message); }
    try { return await this.commit(message, rule); } catch (e) { return this.fail(message, rule, e.message); }
  }

  async commit(message, rule) {
    const max = Number(this.mail.attachments.maxBytes);
    const over = this.pending.attachments.find(t => t.inputDoc.payload.length > max);
    if (over) return this.fail(message, rule, `the attachment ${over.overrides.filename} is ${mb(over.inputDoc.payload.length)}, over the limit of ${mb(max)}.`);
    const emlName = fitName(this.pending.eml?.overrides.filename, 'email.eml');
    const exclude = rule.filterAttachmentFilenameExclude; // images, invites, signatures: noise, not worth a reason
    const refused = this.skipped.filter(s => s.reason !== 'exclude' && !this.filenameExclusionMatches(exclude, s.filename || '')).map(s => `${s.filename}: ${/\.doc$/i.test(s.filename || '') ? 'a .doc file is not a document we file; save it as .docx' : 'not a document we file'}`);
    let outcome, detail; let entries = 0;
    const body = (message.text || htmlToText(message.html || '')).trim();
    if (this.pending.attachments.length) {
      const capture = this.capturer(message, body);
      const email = await capture.email(emlName);
      for (const t of this.pending.attachments) {
        await capture.attachment(t, fitName(t.overrides.filename, `attachment${path.extname(t.inputDoc.filename || '') || '.bin'}`), email);
        entries++;
      }
      outcome = 'captured'; detail = `${entries} attachment${entries === 1 ? '' : 's'}${refused.length ? `; skipped ${refused.join(', ')}` : ''}`;
    } else if (body.length > EML_ONLY_MIN_BODY) {
      await this.capturer(message, body).email(emlName);
      entries = 1; outcome = 'captured'; detail = `email only${refused.length ? `; skipped ${refused.join(', ')}` : ''}`;
    } else if (refused.length) {
      outcome = 'skipped'; detail = refused.join(', ');
    } else {
      outcome = 'no-attachment'; detail = null;
    }
    const moved = await this.postAction(message, rule);
    this.record_(message, outcome, [detail, moved].filter(Boolean).join('; ') || null);
    return entries;
  }

  /**
   * The store writes for one message. The store is asked for here, so an unavailable one (503 store_unavailable) or a
   * failed consume task fails the message like any store failure. Counterparty matching is the inbox's: the sender
   * (the From header of the email that reached the mailbox, as the record inbox read it from the covering .eml), then the
   * subject, then the document's own text (the email's body for the email, the attachment's extracted text for each
   * attachment), each document matched on its own.
   */
  capturer(message, body) {
    const docs = this.documents();
    const opts = { actor: MAIL_STORE_ACTOR };
    // A colleague forwarding to the shared mailbox is not the counterparty: mail from our own domains (internalDomains) is
    // matched by the forwarded original sender, or by its subject and text when it quotes none.
    const from = senderForMatching(message.fromHeader || message.from || null, body, this.internalDomains);
    const subject = message.subject || '';
    const created = mailDate(message.date) || this.nowIso().slice(0, 10);
    const match = paragraphs => suggestStoreCounterparty(docs, { from, subject, paragraphs }, { ourNames: this.ourNames });
    return {
      email: async name => docs.add(message.raw, { filename: name, title: titleFromName(name), type: EMAIL_TYPE, tags: [TAG_INBOX], created, counterparty: await match(body.split(/\r?\n/)) }, opts),
      attachment: async (task, name, email) => {
        const buffer = task.inputDoc.payload;
        const text = await this.extract(buffer, task.inputDoc.mimeType || MEDIA[path.extname(name).toLowerCase()], name).catch(() => null);
        const doc = await docs.add(buffer, { filename: name, title: titleFromName(name), tags: [TAG_INBOX], created, counterparty: await match(text?.paragraphs || []) }, opts);
        await docs.notes.add(doc.id, `Came with email: ${subject || '(no subject)'} (document ${email.id})`, opts);
        return doc;
      },
    };
  }
}

/** A message's date as YYYY-MM-DD (UTC), or null when it has none or it cannot be read. */
function mailDate(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * The consumer. `record` holds the processed-mail bookkeeping and the status (its SQLite); `documents` is a function
 * returning the document store client the captures are written to (the team server passes
 * `() => storeService.serviceClient()`, which throws 503 store_unavailable while the store is not ready; without it every
 * capture fails that way). `deps` replaces the outside world in tests: ImapFlow (the client class), lookup (DNS), tokens
 * or acquireToken/readSecret (OAuth), extract (text extraction). Returns { start, stop, checkNow, runCheck, status }.
 */
export function createMailConsumer({ record, settings, documents = noStore, log = console, now = () => new Date().toISOString(), clock = () => Date.now(), deps = {}, startDelayMs = 5000, flagPollMs = 5000 }) {
  const mail = settings.mail; const dataDir = settings.data?.dir;
  const db = record.internal.db;
  const store = processedStore(db);
  const tokens = deps.tokens || tokenProvider({ tenantId: mail.auth.tenantId, clientId: mail.auth.clientId, clientSecretFile: mail.auth.clientSecretFile, ...(deps.acquireToken ? { acquire: deps.acquireToken } : {}), ...(deps.readSecret ? { readSecret: deps.readSecret } : {}), now: clock });
  const extract = deps.extract || extractTextInWorker;
  const security = mail.tls === false ? ImapSecurity.STARTTLS : ImapSecurity.SSL; // never plaintext: credentials cross this connection
  const createMailbox = o => new ImapFlowMailBox({ ...o, ...(deps.ImapFlow ? { ImapFlow: deps.ImapFlow } : {}), maxMessageBytes: MAX_FILE_BYTES, log });
  const resolve = host => resolveHostnameIps(host, deps.lookup ? { lookup: deps.lookup } : {});
  const open = async (server, port, sec) => {
    if (!mail.allowPrivateAddresses) return getMailbox(server, port, sec, { resolve, createMailbox });
    return createMailbox({ host: server, port, security: sec, pinnedIps: await resolve(server) }); // still resolved once and pinned
  };

  const readStatus = () => db.prepare('SELECT * FROM mail_status WHERE id = 1').get() || { consecutive_failures: 0 };
  function writeStatus(fields) {
    db.prepare('INSERT OR IGNORE INTO mail_status (id, consecutive_failures) VALUES (1, 0)').run();
    const keys = Object.keys(fields);
    db.prepare(`UPDATE mail_status SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = 1`).run(...keys.map(k => fields[k]));
  }
  const at = ms => new Date(ms).toISOString();

  async function runHandler(accessToken) {
    const handler = new GclMailHandler({ documents, mail, ourNames: settings.ourNames || [], internalDomains: settings.internalDomains || [], store, nowIso: now, extract, getMailbox: open, log, today: () => new Date(clock()), now: () => new Date(clock()) });
    const account = { name: mail.auth.mailbox, imapServer: mail.host, imapPort: Number(mail.port), imapSecurity: security, username: mail.auth.mailbox, password: accessToken, isToken: true, expiration: null, characterSet: 'UTF-8', rules: builtInRules(mail) };
    try { await handler.handleMailAccount(account); } catch (e) {
      if (e.code === 'mail_auth' && e.cause?.authenticationFailed) return { authFailed: true, error: e, handler };
      if (e.code === 'mail_auth') throw Object.assign(new Error(`Could not reach the mailbox at ${mail.host}: ${e.cause?.message || e.message}`), { code: 'mail_connection', cause: e });
      throw e;
    }
    return { handler };
  }

  async function checkOnce(startedAt) {
    writeStatus({ last_check_at: startedAt });
    const interval = Math.max(1, Number(mail.intervalMinutes) || 10);
    try {
      const problems = mailConfigProblems(mail);
      if (problems.length) throw Object.assign(new Error(`The mail settings are incomplete: ${problems.join(' ')}`), { code: 'mail_settings' });
      let r = await runHandler((await tokens.get()).accessToken);
      if (r.authFailed) { tokens.invalidate(); r = await runHandler((await tokens.get()).accessToken); } // an expired or revoked token: one new one
      if (r.authFailed) throw Object.assign(new Error(`The mailbox refused the sign-in for ${mail.auth.mailbox}: ${r.error.cause?.message || r.error.message} Check the app registration (IMAP.AccessAsApp, admin consent) and the mailbox permission.`), { code: 'mail_auth' });
      const h = r.handler;
      if (h.accountError) throw Object.assign(new Error(`Could not reach the mailbox at ${mail.host}: ${h.accountError.message}`), { code: 'mail_connection' });
      const problemsSeen = [...h.ruleErrors.map(x => x.error.message), ...h.failures];
      writeStatus({ last_ok_at: now(), last_error: problemsSeen.length ? problemsSeen.join(' ').slice(0, 2000) : null, consecutive_failures: 0, next_check_at: at(clock() + interval * 60_000) });
      const counts = h.outcomes.reduce((o, x) => ({ ...o, [x.outcome]: (o[x.outcome] || 0) + 1 }), {});
      if (h.outcomes.length) log.log?.(`Mail: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
      return { ok: true, startedAt, outcomes: h.outcomes, errors: problemsSeen };
    } catch (e) {
      const failures = (readStatus().consecutive_failures || 0) + 1;
      const message = e.code === 'mail_private_address' ? `${e.message} (${e.address}). The server connects only to public addresses; set mail.allowPrivateAddresses to true only if your mail server is on your own network.` : e.message;
      writeStatus({ last_error: `${e.code && !/^mail_(auth|connection|settings|token)$/.test(e.code) ? `${e.code}: ` : ''}${message}`.slice(0, 2000), consecutive_failures: failures, next_check_at: at(clock() + backoffMinutes(interval, failures) * 60_000) });
      log.error?.(`Mail check failed: ${message}`);
      return { ok: false, startedAt, error: Object.assign(e, { message }), code: e.code || 'mail_error' };
    }
  }

  let running = null, timer = null, flagTimer = null, stopped = true;
  function runCheck() {
    if (!running) {
      const startedAt = now();
      running = checkOnce(startedAt).finally(() => { running = null; schedule(); });
      running.startedAt = startedAt;
    }
    return running;
  }
  function schedule(delayMs = null) {
    if (stopped) return;
    clearTimeout(timer);
    const next = Date.parse(readStatus().next_check_at || '');
    const delay = delayMs ?? (Number.isFinite(next) ? Math.min(DAY_MS, Math.max(1000, next - clock())) : startDelayMs);
    timer = setTimeout(() => { runCheck().catch(e => log.error?.(`Mail check: ${e.message}`)); }, delay);
    timer.unref?.();
  }
  const flagFile = dataDir ? path.join(dataDir, CHECK_FLAG) : null;

  return {
    /** Begin the schedule: a first check shortly after start (or at the next time already due), and the gcl flag. */
    start() {
      stopped = false;
      const next = Date.parse(readStatus().next_check_at || '');
      schedule(Number.isFinite(next) && next > clock() ? null : startDelayMs);
      if (flagFile) {
        flagTimer = setInterval(() => { if (existsSync(flagFile)) { rmSync(flagFile, { force: true }); runCheck().catch(() => {}); } }, flagPollMs);
        flagTimer.unref?.();
      }
      return this;
    },
    async stop() { stopped = true; clearTimeout(timer); clearInterval(flagTimer); try { await running; } catch { /* reported in the status */ } },
    /** The admin's "check mail now" (6.2.1 POST /admin/mail/check -> 202 { startedAt }): starts a check, or names the one running. */
    checkNow() { const p = runCheck(); p.catch(() => {}); return { startedAt: p.startedAt }; },
    runCheck,
    status: readStatus,
  };
}
