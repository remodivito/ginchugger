// SPDX-License-Identifier: GPL-3.0-or-later
// The Microsoft 365 access token for the shared mailbox (product v2 spec 7.2 step 1, 9.1 step 3, PR-SEC-03): the OAuth
// 2.0 client-credentials flow through @azure/msal-node (MIT) against
// https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token with scope https://outlook.office365.com/.default.
// The token is kept in memory until 5 minutes before it expires; a token the mailbox refuses is dropped so the next
// attempt asks for a new one. The client secret is read from its own file (mode 0600), never from the settings file,
// never logged and never sent anywhere but Microsoft's token endpoint.
import { readFileSync, statSync } from 'node:fs';

export const SCOPE = 'https://outlook.office365.com/.default';
export const REFRESH_MARGIN_MS = 5 * 60_000;
const fail = (code, message, cause) => Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });

/** The client secret from its file: present, not empty, and readable by the server only (0600) where modes exist. */
export function readClientSecret(file, { platform = process.platform } = {}) {
  let st;
  try { st = statSync(file); } catch { throw fail('mail_secret_missing', `The mail client secret file ${file} does not exist. Put the client secret from the app registration there (mode 600).`); }
  if (platform !== 'win32' && (st.mode & 0o077)) throw fail('mail_secret_mode', `The mail client secret file ${file} can be read by other users. Run chmod 600 on it.`);
  const secret = readFileSync(file, 'utf8').trim();
  if (!secret) throw fail('mail_secret_missing', `The mail client secret file ${file} is empty.`);
  return secret;
}

/** One token request through MSAL. Our own cache decides when to ask, so MSAL's is skipped. */
export async function msalAcquire({ tenantId, clientId, clientSecret }) {
  const { ConfidentialClientApplication, LogLevel } = await import('@azure/msal-node');
  const app = new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
    system: { loggerOptions: { piiLoggingEnabled: false, logLevel: LogLevel.Error, loggerCallback() {} } },
  });
  const r = await app.acquireTokenByClientCredential({ scopes: [SCOPE], skipCache: true });
  if (!r?.accessToken) throw new Error('Microsoft returned no access token.');
  return { accessToken: r.accessToken, expiresOn: r.expiresOn instanceof Date ? r.expiresOn : new Date(Date.now() + 3600_000) };
}

/** A tenant is a GUID or a domain; anything else (a slash, a query) would change the token endpoint. */
export const validTenant = t => typeof t === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(t);

/**
 * The token provider. `get()` returns { accessToken, expiresOn }, asking Microsoft only when there is no token or it
 * expires within REFRESH_MARGIN_MS; `invalidate()` drops it (the mailbox refused it). `acquire` and `readSecret` are
 * injectable for tests; nothing here makes a request in tests.
 */
export function tokenProvider({ tenantId, clientId, clientSecretFile, acquire = msalAcquire, readSecret = readClientSecret, now = () => Date.now() }) {
  let cached = null;
  return {
    async get() {
      if (cached && cached.expiresOn.getTime() - REFRESH_MARGIN_MS > now()) return cached;
      if (!validTenant(tenantId)) throw fail('mail_settings', 'mail.auth.tenantId is not a tenant id or domain.');
      const clientSecret = readSecret(clientSecretFile);
      try { cached = await acquire({ tenantId, clientId, clientSecret }); } catch (e) {
        cached = null;
        throw fail('mail_token', `Could not get a Microsoft 365 access token: ${e.errorCode || e.code || 'error'}${e.errorMessage ? ` (${String(e.errorMessage).split('\n')[0].slice(0, 200)})` : ''}.`, e);
      }
      return cached;
    },
    invalidate() { cached = null; },
    get cached() { return cached; },
  };
}
