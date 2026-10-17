// SPDX-License-Identifier: GPL-3.0-or-later
// The simulated mailbox wired as the mail consumer's outside world (product v2 spec 11.1, 11.2): the fake imapflow
// client over a BogusMailBox, a DNS answer that is a public address, and a token provider that never calls Microsoft.
// Used by tests/mail-consumer.test.js, the team-server test and the e2e harness (tests/e2e/mail-team-server.js).
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { BogusMailBox, bogusImapFlow, buildRaw, AttachmentDef } from './paperless/bogus-mailbox.js';

export const MAILBOX = 'contracts@firm.example';
export const PUBLIC_IP = '52.97.1.1';
export const DOCX_MEDIA = { maintype: 'application', subtype: 'vnd.openxmlformats-officedocument.wordprocessingml.document' };

/** A mailbox with the folders a fresh shared mailbox has (INBOX only; the server creates the rest). */
export function sharedMailbox() {
  const mb = new BogusMailBox({ folders: ['INBOX'], uidValidity: 100 });
  mb.username = MAILBOX; mb.accessToken = 'token-1';
  return mb;
}

/** A token provider whose tokens are 'token-1', 'token-2', ...; the mailbox accepts whichever it is told to. */
export function fakeTokens() {
  let n = 0; let cached = null;
  return {
    calls: () => n,
    async get() { if (!cached) { n++; cached = { accessToken: `token-${n}`, expiresOn: new Date(Date.now() + 3600_000) }; } return cached; },
    invalidate() { cached = null; },
  };
}

export const mailDeps = (mailbox, { tokens = fakeTokens(), lookup = async () => [{ address: PUBLIC_IP, family: 4 }], extract } = {}) => ({ ImapFlow: bogusImapFlow(mailbox), lookup, tokens, ...(extract ? { extract } : {}) });

/** The mail settings of a server whose capture is on, and the secret file they name (mode 600). */
export function mailSettings(dataDir, extra = {}) {
  const secret = path.join(dataDir, 'secrets', 'mail-client-secret');
  mkdirSync(path.dirname(secret), { recursive: true, mode: 0o700 }); writeFileSync(secret, 'not-a-real-secret\n'); chmodSync(secret, 0o600);
  return { enabled: true, auth: { tenantId: 'contoso.onmicrosoft.com', clientId: '00000000-0000-0000-0000-000000000001', mailbox: MAILBOX, clientSecretFile: secret }, ...extra };
}

/** A forwarded email carrying attachments, as Outlook sends one. */
export function forwardedEmail({ subject = 'FW: Mutual NDA, our comments', from = 'Ada Admin <ada@firm.example>', body = 'Forwarding Acme\'s markup.', attachments = [], messageId, date } = {}) {
  return buildRaw({ subject, from, to: [MAILBOX], body, attachments, ...(messageId ? { messageId } : {}), ...(date ? { date } : {}) });
}
export const docxAttachment = (filename, content) => new AttachmentDef({ filename, ...DOCX_MEDIA, content });
export { BogusMailBox, AttachmentDef, buildRaw };
