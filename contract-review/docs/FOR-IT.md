# For IT and security teams

What GinChugger does with your data, and how to install, run and remove it. The first part describes each lawyer's computer (the same in solo and team mode). The team server is described after it.

## What runs where

- **A small Node.js server on the lawyer's own computer**, listening on localhost only (`127.0.0.1`). It serves the browser pages and the Word task pane, and makes the model calls.
- **The Word add-in** is a manifest that points Word at that local server. It installs no code of its own. It reads the open document, and writes tracked changes and comment replies only when the lawyer clicks to apply them.
- **Word loads Microsoft's Office JavaScript library** from `appsforoffice.microsoft.com`, as every Office add-in does.
- **The document store**: Paperless-ngx 3.3.2, run unmodified as a separate program in four Docker containers (the Paperless web server, a Valkey broker, Apache Tika and Gotenberg), bound to `127.0.0.1` only (port 8011 by default). It holds the documents. Its own web interface is never shown to users; the app talks to it over its HTTP API.
- **In team mode, a team server** inside your network holds the team's playbooks, people and keys and the team's document store, and captures mail into that store. The lawyer's app connects out to it over HTTPS and reaches the documents only through it; a lawyer's computer runs no store of its own and never talks to Paperless.

## Installing it on a lawyer's computer

Each release has a Mac installer and a Windows installer, with a SHA-256 checksum for each in `SHA256SUMS.txt`. Check the checksum before you deploy. The installers are not signed yet: on a Mac, Gatekeeper asks before opening an unsigned package (right-click, Open); on Windows, SmartScreen warns. Deploy them the way you deploy other unsigned internal software.

| | Mac (`GinChugger-<version>-mac-universal.pkg`) | Windows (`GinChugger-<version>-windows-x64.msi`) |
|---|---|---|
| Installs to | `/Library/Application Support/GinChugger Legal` | `C:\Program Files\GinChugger Legal` |
| Contains | Node.js 22 (Apple silicon and Intel), the app, its production dependencies, prebuilt `better-sqlite3` and `@napi-rs/keyring` | Node.js 22 (x64), the same app and modules for Windows x64 |
| Starts | at each login, through `/Library/LaunchAgents/com.ginchugger.legal.plist`; the installer also starts it for the person signed in | at each login, through the `GinChugger` value under `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` |
| Data folder | `~/Library/Application Support/GinChugger Legal` | `%LOCALAPPDATA%\GinChugger Legal` |
| Log | `app.log` in the data folder | `app.log` in the data folder |
| Commands | `"/Library/Application Support/GinChugger Legal/bin/ginchugger-legal" setup-word` (or `gcl <command>`) | `"C:\Program Files\GinChugger Legal\bin\ginchugger-legal.cmd" setup-word` (or `gcl <command>`) |

The install folder, data folder, command name and login item keep the "GinChugger Legal" / `ginchugger-legal` names from before the product was renamed, so an upgrade finds the existing data and settings.

Docker must be installed and running on the computer that runs the store: Docker Desktop on a Mac or Windows, Docker Engine on Linux. The installers do not include it. Without Docker the app falls back to a built-in, in-memory store: it works, but documents are kept only until the app stops, and each page and the log say so. With Docker present nothing changes.

Word needs the pane over trusted HTTPS on `https://localhost:3443`. Each lawyer runs the `setup-word` command once. It makes a certificate for `localhost` valid for 825 days in the data folder, trusts nothing itself, and prints the one trust step for the platform: Keychain Access ("Always Trust") or `security add-trusted-cert` on a Mac, `certutil -user -addstore Root` on Windows. After a restart of the app (sign out and in, or on a Mac `launchctl kickstart -k gui/$(id -u)/com.ginchugger.legal`) it serves the pane on port 3443. Until then it serves the browser pages on `http://localhost:3000`. Then sideload `app/public/manifest.xml` from the install folder (`docs/WORD.md`). Repeat `setup-word` before the 825 days run out: delete `word-tls` in the data folder first.

Updates: there is no auto-updater. Install the newer release over the old one. In team mode the app shows a one-line notice with a link to the matching release when its version and the team server's differ.

## The document store

The store is Paperless-ngx 3.3.2 with the images pinned in `paperless/docker-compose.yml` in the install folder: `ghcr.io/paperless-ngx/paperless-ngx:3.3.2`, `valkey/valkey:9-alpine`, `apache/tika:3.3.1.0` and `gotenberg/gotenberg:8.37`. The first pull is about 6.6 GB and takes several minutes. Running, it uses about 1.5 GB of memory.

- **Start and stop.** In managed mode (the default for the app's own data folder in solo mode) the app runs `docker compose up -d` on that file at start-up. It never waits for it: until the store answers, each page shows one line saying the store is unavailable. If Docker is not installed or not running, the lawyer's app uses the built-in, in-memory store for that run instead (`Document store: built-in, in memory (…)` in the log) and writes nothing to `paperless-data`; the team server has no such fallback. The containers restart with Docker unless they were stopped. By hand, from the `paperless` folder: `GCL_PAPERLESS_DATA=<data folder>/paperless-data docker compose -p gcl-store up -d` to start it, and the same with `stop` to stop it.
- **Data folder.** `<data folder>/paperless-data`, with `data`, `media`, `export`, `consume` and `redisdata`, and two secret files written on first start, readable by that user only: `paperless.env` (Paperless's secret key and admin password) and `store-tokens.json` (API tokens: one service account, and one Paperless user and token per lawyer, so Paperless's history names who did what).
- **What it stores.** The documents as received, their extracted text, their labels (counterparty, type, tags, date, custom fields), notes and history, and its trash. Notes include those the Word pane adds when a lawyer accepts the other side's wording (the point's title and up to 300 characters of their wording), so later reviews see the concession. It listens on loopback only; nothing outside the computer can reach it.
- **Modes.** `store.mode` in `settings.json`, or `GCL_STORE`: `managed` (the app runs it), `external` (a Paperless you run: `store.url` and the token in `GCL_STORE_TOKEN`), `fake` (in memory, for tests) or `off`. Other keys: `store.port` (8011), `store.dataDir` (default `paperless-data` under the data folder) and `store.project` (the compose project, default `gcl-store`). In team mode the app runs no store and ignores these keys: its pages, the Word pane and the model's store tools use the team store through the team server (see "The team store" below).
- **Backups.** Back up the store's data folder with the store stopped, or use Paperless's own document exporter into `export/`. Back up our own files with it: `record.sqlite` (with `gcl backup`), `review-history.sqlite`, `settings.json` and `pane-sessions/`.
- **Restore.** Stop the app and the store, put the store's data folder and our files back, then start the app.
- **Removal.** Stop and remove the containers (`docker compose -p gcl-store down` from the `paperless` folder), remove the four images (`docker image rm` with the names above), then delete `<data folder>/paperless-data`.

## Where contract text goes

Only to the model provider the lawyer configures, when they start a review:

- the agreement's text, and a comparison version if one is supplied;
- the chosen playbook's enabled entries;
- any context the lawyer adds, and what the model reads from other documents in the store. When the provider supports tool calls, the model reads the store through four read-only tools, only during a review or a question; it cannot write to the store. Otherwise a question sends the counterparty's other documents with it.

The providers are: Anthropic (through the lawyer's own Claude Code login, or an API key), or an OpenAI-compatible host the lawyer names. There is no telemetry, analytics or other outbound traffic. The app sends no API key or sign-in to the browser or the Word pane, strips API keys from the environment of any command-line tool it runs, and never places the record signing key in that environment.

**The local API.** The app answers only on `127.0.0.1`, and only to its own pages and the Word pane: every request's Host must be a loopback name, an Origin must be the app's own origin, and on `/api` the browser's Sec-Fetch-Site must be same-origin (`server/local-guard.js`, `tests/local-api.test.js`). A page served from another local port (another tool, a dev server, the store's own interface) therefore cannot upload to the store or start a review. A program running as the same user on the same computer can call the API, as it can read the data folder; the model's store tools read as the signed-in lawyer (read-only, quotes verified), not only the document under review.

## What is stored

On the lawyer's computer, in the data folder above (`MARGIN_STATE_DIR` overrides it; from a source checkout it is `contract-review/.local`):

- in solo mode, the document store's data folder (`paperless-data`, above): the documents and emails, their text, labels, notes and history (in team mode they are on the team machine, and the computer keeps no copy beyond the pane's working state and what a lawyer downloads);
- in solo mode, `record.sqlite`: playbooks with their owners and proposals, people and permissions, clause types; in team mode, a short-lived cache of what it read from the team server;
- `review-history.sqlite`: which points were applied or dismissed, and why, per store document (in team mode it is on the team server, beside the team store);
- the settings file (`settings.json`), the pane's working state (`pane-sessions/`), and the Word certificate.

An older `record.sqlite` may still hold the matter tables from before decision 190. Nothing reads them; they are kept as a backup.

API keys and the team-server key go in the Mac Keychain or Windows Credential Manager (service "GinChugger"; a key saved by an earlier version under "GinChugger Legal" is still read and copied across). Where no keychain can be used, the app keeps them in `secrets.json` in the data folder, readable by that user only, and says so on its Settings page. Nothing is encrypted at rest beyond what the operating system provides, so full-disk encryption (FileVault, BitLocker) should be on, as it should be for any client material.

## Who can see it

Anyone with access to the lawyer's user account on that computer. The local server accepts connections from the same machine only.

## How to switch it off and remove it

- Mac: `launchctl bootout gui/$(id -u)/com.ginchugger.legal` stops it. To remove it, as an administrator: delete `/Library/LaunchAgents/com.ginchugger.legal.plist` and `/Library/Application Support/GinChugger Legal`, then `pkgutil --forget com.ginchugger.legal`.
- Windows: Settings → Apps → GinChugger → Uninstall. That removes the program and the login item.
- Then remove the store as described under "The document store", remove the add-in from Word, delete the data folder and the "GinChugger" (and any older "GinChugger Legal") entries in the keychain or Credential Manager, remove the localhost certificate from the trust store, and revoke any API key in the provider's console.

## Retention and deletion

Documents accumulate in the store. A document tagged "signed", or one an admin has put on hold, cannot be moved to the trash; only an admin sets or lifts a hold. Anything else moved to the trash can be restored from the Trash page. Nothing is purged automatically: Paperless's own job that empties its trash (by default daily at 01:00, of items in the trash for more than 30 days) is switched off in our compose file (`PAPERLESS_EMPTY_TRASH_TASK_CRON=disable`, with `PAPERLESS_EMPTY_TRASH_DELAY` at 36500 days as a backstop), and the app has no "delete for good" button. `trash.purgeAfterDays` in the settings file switches it on, the same way in the solo app's `settings.json` and on the team server: Paperless then empties, daily at 01:00, items in its trash for more than that many days. It applies when the store next starts: restart the app (solo) or the server (a managed store); with the shipped team-server `compose.yml`, run `docker compose up -d --force-recreate`. Any other store you run yourself (`external`) follows its own `PAPERLESS_EMPTY_TRASH_*` settings: set them the same way. `docs/RETENTION.md` is a retention statement to fill in and adopt; the Admin page records the date it was adopted. Backups keep deleted documents until the backups are replaced.

## What is not established

No independent security review has been done. The installers are unsigned and have been built and inspected on a Mac only; the Windows installer has not yet been installed on a Windows machine, and the team server has been run only by the test suite and a compose smoke test, not by a team. The model's findings are not lawyer-validated. Nothing is approved or sent automatically; every edit is applied by the lawyer.

## Team mode: the team server

One container inside your network holds the team's playbooks, people and keys, and captures mail into a document store; each lawyer's computer still runs every review through that lawyer's own login or key. The server makes no model calls and holds no AI credentials.

### What it stores, and what it does not

Stored, in one data folder (`/data`), in `record.sqlite`: playbooks with owners and proposals; clause types; user names, admin flags and permissions; hashed keys and setup codes; processed-mail ids (folder, UIDVALIDITY, UID, Message-ID, outcome) and the mail status. Also the mail client secret file. Captured documents and emails go to the document store, not to `record.sqlite`.

The store is configured with the same `store` keys as the app, in the server's settings file, with the `GCL_STORE_*` variables over them. Unset, it is a managed store on the same machine when the server runs from its own data folder (`node server/team-server.js`, `GCL_DATA_DIR` or `/data`), and off otherwise. Docker is not available inside the shipped team-server container, so the shipped `compose.yml` runs the store beside it (see Install); the variables there set the server's store to `external` at `http://paperless-webserver:8000`, over the settings file. Without a store, a mail capture fails as "store unavailable". The Admin page shows the store's status.

### The team store

The lawyers' apps use the team server's store for everything to do with documents: the Inbox, Library, document pages, Trash and Activity, the Word pane (finding the open document, "Save as our reply"), and the read-only tools the model uses during a review or a question. Each request goes from the lawyer's app to the team server over the same HTTPS connection and key as the playbooks; the team server checks the key and acts in the store as that member, through a Paperless user and token of their own that it makes on their first request (kept in the store's `store-tokens.json` on the team machine), so the store's history names who did what. The member's admin flag decides holds and the whole store's activity, as elsewhere. Paperless, its address and its tokens stay on the team machine: the lawyers' computers never connect to it, and the status the apps see leaves its address out. The review history (`review-history.sqlite`) is kept in the server's data folder; back it up with `record.sqlite`. When the team server cannot be reached, the pages show the store as unavailable and a review still runs on the document open in Word, without the store.

Not stored: AI credentials; model prompts and raw outputs (those stay in the lawyer's trace folder when tracing is on); read logs; request logs (off unless `log.requests` is set, and even then method, path, status and user id only); personal mailboxes.

The server refuses to start, naming what it found, if any AI credential is in its environment (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CODEX_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), a `review`, `openai` or `anthropic` key is in its settings file, or a `claude`, `codex` or `muse` program is on its PATH or named by `CLAUDE_BIN`, `CODEX_BIN` or `MUSE_BIN`. The image contains no executor code.

### Install

1. Put the certificate and key you issue for the server (internal CA, or a DNS-validated public certificate) in a folder beside `compose.yml` as `tls/server.crt` and `tls/server.key`, readable by uid 1000 (the container's user). Without them the server does not start: there is no plain-HTTP mode.
2. `docker compose up -d`. The image is published with each release as `ghcr.io/<owner>/<repository>-server:<version>`; `compose.yml` names it, or build it yourself with `docker build -t <name> .` in `contract-review`. The first start writes `/data/settings.json` with every setting and its default; an unknown key stops the server with the key named.
   The same file runs the document store beside the server: Paperless-ngx with the images and settings of `paperless/docker-compose.yml` (services `paperless-webserver`, `paperless-broker`, `paperless-tika`, `paperless-gotenberg`; about 6.6 GB to pull the first time, 1.5 GB of memory running). They are on an internal Docker network that only the team server also joins: no port of theirs is published on the host, and they cannot connect out. The server reaches the store at `http://paperless-webserver:8000`. A one-shot service, `store-init` (the server's image, run as root, no network), runs before both on every `docker compose up`: on the first it generates Paperless's secret key and admin password into the `gcl-store` volume (files readable by uid 1000 only; nothing secret is in `compose.yml`, the image or the repository), and each time it writes the trash schedule from `trash.purgeAfterDays` (off unless set). The server keeps the lawyers' store tokens (`store-tokens.json`) in the same volume. The documents are in the `paperless-data` and `paperless-media` volumes.
3. Set `server.publicUrl` (the address lawyers type) in the settings file, then `docker compose up -d --force-recreate`. Until there is an address and an admin, the status page at `https://<server>:8443/` says "Not configured" and why.
4. `docker exec gcl gcl admin issue-code --for "<name>" --admin` prints the first admin's setup code once. Every later code is issued from the app's Admin page.
5. Each lawyer opens Settings → Team in their app and enters the server address, their code, a device name and, for an internal CA, the path to your CA certificate (`server.caFile`). If the certificate is not trusted, the app shows its subject and SHA-256 fingerprint to check with you; it never offers to trust it anyway.

### Network and keys

- HTTPS only, TLS 1.2 or later, on port 8443 (change the published port in `compose.yml`). The lawyers' apps connect out to it; nothing connects in to a laptop.
- Setup codes: 26 characters (128 random bits), shown once, stored as SHA-256, single use, expiring after `codes.ttlHours` (default 7 days), revocable; redemption is limited to 10 attempts a minute per address and per code prefix, 60 in all. A wrong, used, expired or revoked code gets the same answer.
- Keys: 256 random bits, shown once to the app, stored on the server as SHA-256 with the device name, kept on the laptop in the Mac Keychain or Windows Credential Manager (service "GinChugger", account "server-key"). Where no keychain is available the app keeps it in a file readable by that user only and says so on its Settings page.
- An admin revokes a person on the Admin page (or `gcl admin revoke-user <id>`): every key of theirs is refused at once and their app shows "Signed out by an admin".
- Every member reads every document; admins also manage codes, people, holds and mail. There are no per-document walls in this version.

### Running it

- Status: the page at `/` shows version, uptime, certificate expiry and whether it is configured; the Admin page shows the full list (data folder, database and files size, disk free, mail state, the store's status, people, codes outstanding, last backup, retention statement).
- Backup: `docker exec gcl gcl backup /data/backups/nightly` (a consistent copy of `record.sqlite`), nightly from cron; or copy the whole data volume with the container stopped. Back up the document store and `review-history.sqlite` as well: in the shipped `compose.yml`, `docker compose exec -T paperless-webserver document_exporter ../export` (Paperless's own exporter, into the `paperless-export` volume), or copy the `gcl-store` and `paperless-*` volumes with everything stopped (`docker compose stop`).
- Restore: stop the container, `gcl restore <backup folder>` against the data folder (it refuses while the server runs), restore the store's volumes from the same time, start, and check with `gcl check`. Work recorded after the backup is lost.
- Upgrade: change the image tag in `compose.yml`, then `docker compose pull && docker compose up -d`. Migrations run forward on start; a data folder from a newer release stops the server with "The data folder is at schema N; this release knows schema M. Install the newer release or restore a backup." The lawyers' apps show a one-line notice with a link to the matching release when their version and the server's differ; nothing updates itself.

### The shared mailbox (optional)

Lawyers can file a contract by forwarding the email to one shared mailbox, or by dragging it into that mailbox's "To file" folder in Outlook. The server reads only that one mailbox and only those two folders (the inbox and "To file"); it never connects to anyone's personal mailbox and never captures mail automatically. Each message's contract attachments (`.docx`, `.pdf`, `.eml`) and the covering email go into the document store, tagged "inbox", with the counterparty matching suggests. They show in the app's Inbox, where a lawyer checks the labels and clicks Done. Mail capture is off until you switch it on, and the server runs normally without it.

Setting it up (Microsoft 365, once):

1. Create or choose a shared mailbox, for example `contracts@yourfirm.example`.
2. In Microsoft Entra ID, App registrations → New registration (single tenant, no redirect URI). Note the Application (client) ID and the Directory (tenant) ID.
3. API permissions → Add a permission → APIs my organization uses → Office 365 Exchange Online → Application permissions → `IMAP.AccessAsApp`. Grant admin consent.
4. Certificates & secrets → New client secret. Copy the value once; note its expiry date (renew it before then, or mail capture stops with a sign-in error on the Admin page).
5. In Exchange Online PowerShell, give the app access to that mailbox only:
   `New-ServicePrincipal -AppId <client id> -ObjectId <object id of the Enterprise application>` and
   `Add-MailboxPermission -Identity contracts@yourfirm.example -User <object id of the Enterprise application> -AccessRights FullAccess`.
   (The object id is the Enterprise application's, not the App registration's.) Optionally restrict the app further with an application access policy or RBAC for Applications.
6. Put the secret in the data folder, readable by the container's user only: `docker exec -i gcl sh -c 'mkdir -p /data/secrets && umask 077 && cat > /data/secrets/mail-client-secret'` and paste the value, then Ctrl-D. The server refuses a secret file other users can read.
7. In `/data/settings.json` set `mail.enabled` to `true` and `mail.auth.tenantId`, `mail.auth.clientId` and `mail.auth.mailbox`; leave `mail.host` as `outlook.office365.com`, port `993`, TLS on. Set `ourNames` to your firm's own names (as they appear in contracts, for example "Helix Instruments Ltd"): these are never suggested as the counterparty. Set `internalDomains` to your firm's email domains (for example `helix.example`; subdomains count): mail from them is a colleague forwarding it, so the sender is not read as the counterparty; the original sender quoted in a forward is read instead when it is from outside, else the subject and the text decide. Make sure the server has a store (`store` keys, above). Restart the container.
8. On first check the server creates the folders "To file", "Filed" and "Not filed" in the mailbox if they are missing. Admin page → Check mail now, or `docker exec gcl gcl mail check`, runs a check at once.

How it behaves:

- Every `mail.intervalMinutes` (default 10) the server signs in with the OAuth 2.0 client-credentials flow (a token from `login.microsoftonline.com`, kept in memory, never written to disk) and reads messages from the last `mail.maxAgeDays` (default 30) days in the two folders. A processed message is moved to "Filed"; one that could not be filed (too large, unreadable) is moved to "Not filed", with the reason on the Admin page. Each message is processed once: the server remembers folder, UIDVALIDITY and UID, and also the Message-ID, so a message sent again is skipped.
- Limits: a message larger than 25 MB is not downloaded; an attachment larger than `mail.attachments.maxBytes` (default 25 MB) stops that message. Images, calendar invites, contact cards and signatures are ignored; spreadsheets, archives and `.doc` files are not filed (the reason is recorded; save a `.doc` as `.docx`).
- Network: the only outbound connections the server makes are to `mail.host` and to Microsoft's token endpoint. The mail host is resolved once per check and the connection is made to that checked address, with the name kept for the TLS certificate check; if the name resolves to a private, loopback or link-local address (for example `10.x`, `127.0.0.1`, `169.254.169.254`, `::1`), the server refuses to connect (`mail_private_address` on the Admin page). Set `mail.allowPrivateAddresses` to `true` only if your IMAP server really is on your own network. Links and images in mail are never fetched; HTML is stored as text.
- Failures: if the token request or the sign-in fails, the Admin page shows the error and the number of failures in a row, and the server waits longer between attempts (doubling from the interval, at most an hour). A missing folder is reported as "Folder 'To file' not found in the mailbox" and the other folder is still read.
- Store: a message whose documents the store cannot take (unavailable, or its task failed) is moved to "Not filed" with the reason.
- Switching it off: set `mail.enabled` to `false` and restart; delete the client secret in Entra ID and the file in `/data/secrets`.

An Outlook add-in that sends an email straight to the store is not built.

### Single sign-on

Not built. Sign-in goes through one function (`server/record/identity.js`, `whoIs`); an OpenID Connect version would use `openid-client` and `jose` and switch setup codes off. Ask for it and it will be built rather than improvised.
