# Setup

From a fresh machine to a first review, in Word and in the browser. Written for a Mac; Windows and Linux differences are noted where they matter. Every command runs from the repository unless it says otherwise. No lawyer has validated the app's output.

## 1. Prerequisites

1. **Node.js 22 or later.** `node --version` should print `v22` or higher. On a Mac, the installer from nodejs.org or `brew install node`; on Windows, the nodejs.org installer; on Linux, your distribution's package or nodesource.
2. **git.** `git --version`. On a Mac it comes with the Xcode command line tools (`xcode-select --install`).
3. **Docker, for the document store (recommended).** Docker Desktop on a Mac or Windows, Docker Engine on Linux, installed and running: `docker info` should print a server version. The store is Paperless-ngx, run unmodified in four containers bound to `127.0.0.1`. The first start pulls about 6.6 GB of images; the store then uses about 1.5 GB of memory.
   **Without Docker** the app uses its built-in store instead: it keeps documents in memory until the app stops, and every page says so in one line. Everything below works the same, except that documents are gone after a restart and the document page shows no preview.
4. **A model route** (step 3): a Claude subscription with the Claude Code CLI, an Anthropic API key, or a key for an OpenAI-compatible endpoint.
5. **For the Word add-in (optional):** Word for Mac or Windows with WordApi 1.6 (Microsoft 365 or Office 2021 and later).

## 2. Install and start

```sh
git clone https://github.com/remodivito/ginchugger.git
cd ginchugger/contract-review
npm install
npm run build
npm start
```

- After `npm install`: no errors (warnings are fine). It builds `better-sqlite3` and `@napi-rs/keyring` for your platform; on Linux that needs `build-essential` and `python3` if no prebuilt binary matches.
- After `npm run build`: a `dist/` folder.
- After `npm start`, you should see `GinChugger is ready at http://localhost:3000`. With Docker, a little later: `Document store ready: Paperless-ngx 3.3.2 at http://127.0.0.1:8011.` (the first start waits for the image pull). Without Docker: `Document store: built-in, in memory (Docker is not installed).`

Open http://localhost:3000. You should see the Review screen with the side bar (Review, Inbox, Library, Playbook, Trash). Until step 3 is done one grey line under Review says "No model set up yet · Settings · Models"; pressing Review anyway says so in one line. While the store starts nothing is shown; if it cannot start, one line at the top says why. Without Docker the line reads "Document store: built-in (Docker not found) · documents are kept until the app stops".

The app's data (settings, keys fallback, the record, the store's files) is in `.local/` beside `package.json`. Stop the app with Ctrl+C; the store's containers keep running under Docker and are reused at the next start.

## 3. Choose a model route

Open **Settings · Models**. Under **Reviews use**, pick one, then **Save**. The local app makes every model call; the browser and the pane never hold a credential. Read your provider's terms before sending client material.

| Route | What you need | Whose terms apply |
|---|---|---|
| **Claude CLI** (Claude subscription) | The Claude Code CLI on this computer, signed in: `npm install -g @anthropic-ai/claude-code`, then run `claude` once and sign in. Settings · Models then shows "Claude CLI found" under Connections. | That plan's terms. Team and Enterprise seats are business terms; Free, Pro and Max are for personal use |
| **Anthropic API** | An Anthropic API key: **Add** beside "Anthropic API key" under Connections. | Anthropic's Commercial Terms |
| **OpenAI-compatible** | A key (**Add** beside "OpenAI-compatible key"), a model id in **Model**, and the endpoint's base URL in `OPENAI_BASE_URL` (see below). | That provider's terms |

The OpenAI-compatible endpoint is read from the environment when the app starts; put it in a `.env` file beside `package.json` (copy `.env.example`) and restart:

```sh
OPENAI_BASE_URL=https://api.eu.munito.ai/inference/v1   # Munito, EU-hosted open models; or OpenRouter, or a local model server
```

The model id is the provider's own (for example `deepseek-ai/deepseek-v4-flash` or `zai-org/glm-5.3-flash` on Munito). An EU-hosted endpoint keeps contract text with a provider in the EU; Settings · GinBench shows how each benchmarked model did (GinBench is the project's benchmark; its code is in `tough-eval/`, a folder that keeps its old name until the next benchmark version because the frozen benchmark's hashes key on paths).

Keys entered on Settings go in the Mac Keychain or Windows Credential Manager (the system keyring on Linux). When the keychain refuses, they go in `secrets.json` in the data folder (mode 0600) and the Settings page says so. A key set in the environment when the app starts wins over the keychain. A `REVIEW_EXECUTOR` variable fixes the route and the page then shows it disabled, naming the variable.

**Run check** under Tool check confirms the route can call the store's read-only tools. If it fails, reviews still run, as a single call without reading the store.

## 4. A first review in the browser

1. **Inbox → Add files**, choose a few of the fictional documents in `data/fixtures/`: `order-form/helix-northgate-order-form-v1.docx` and `order-form/2026-06-04-northgate-returns-order-form.eml`. You should see each under Waiting with a suggested counterparty and type. Check them (counterparty Northgate Biosciences Ltd; type Order form, or Email) and press **Done**. They are now in the **Library**.
2. **Review → Open**, choose `data/fixtures/order-form/helix-northgate-order-form-v2-customer-markup.docx`, then **Review**. After the model answers (usually under a minute) you should see the points, worst first, with "0 of n done" above them. Each point quotes the wording it relies on.
3. **Apply** or **Dismiss** a point. In Word, Apply writes a tracked change under your name; Dismiss asks why and records it.
4. **Ask** at the foot: "What did we accept from Northgate Biosciences Ltd before?" The answer cites the documents it read in the store, each quote checked word for word.

[The demo script](DEMO.md) walks through the whole flow in about five minutes.

## 5. The Word add-in

Word loads the pane only from a trusted HTTPS address, `https://localhost:3443`. Details and limits: [Word setup](WORD.md).

1. **Make the certificate:** `node scripts/setup-word.js`. It writes `.local/word-tls/localhost.crt` and `localhost.key` (825 days), trusts nothing itself, and prints the trust step for your platform.
2. **Trust it, once per computer.**
   - Mac: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db .local/word-tls/localhost.crt`, or open the `.crt`, double-click "localhost" in Keychain Access, and set Trust to Always Trust.
   - Windows: `certutil -user -addstore Root .local\word-tls\localhost.crt` (Windows asks you to confirm).
3. **Start the app on HTTPS:**
   ```sh
   PORT=3443 HTTPS_KEY=.local/word-tls/localhost.key HTTPS_CERT=.local/word-tls/localhost.crt npm start
   ```
   On Windows (PowerShell): `$env:PORT=3443; $env:HTTPS_KEY=".local\word-tls\localhost.key"; $env:HTTPS_CERT=".local\word-tls\localhost.crt"; npm start`. You should see `ready at https://localhost:3443`, and https://localhost:3443 should open in your browser with no certificate warning. Clicking through a warning is not a substitute: Word will refuse it.
4. **Sideload `public/manifest.xml`.**
   - Mac: `mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef && cp public/manifest.xml ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`, then quit and reopen Word.
   - Windows: share a folder, copy `manifest.xml` into it, add its network path (`\\<computer>\<share>`) in Word under File → Options → Trust Center → Trust Center Settings → Trusted Add-in Catalogs with "Show in Menu" ticked, and restart Word.
5. **Open a document and the pane.** Open a contract (or make a copy that opens the pane by itself: `node scripts/attach-pane.mjs data/fixtures/order-form/helix-northgate-order-form-v2-customer-markup.docx <folder>/helix-northgate-order-form-v2-customer-markup.docx`). Mac: Home → Add-ins (or Insert → My Add-ins), then GinChugger under Developer Add-ins. Windows: Insert → My Add-ins → Shared Folder → GinChugger. You should see the pane with one line naming the document's counterparty and the playbook it will use, and a **Review** button.

## 6. Optional: a team server and a shared mailbox

A team shares one store, its playbooks and people through a team server, one Docker container on a machine inside your network; mail forwarded to a shared mailbox is captured into the team's Inbox. The steps (certificate, `docker compose up -d`, the first admin's setup code, joining from Settings · Team, the Microsoft 365 mailbox, backup and upgrade) are in [For IT and security](FOR-IT.md) and the repository README's "A team, with Docker". For a trial certificate: `node scripts/team-cert.mjs tls`.

## 7. Troubleshooting

| What you see | What to do |
|---|---|
| "Document store: built-in (Docker not found)" | Docker is not installed. The app works, but documents last until it stops. Install Docker Desktop (Mac, Windows) or Docker Engine (Linux), then restart the app. |
| "Document store: built-in (Docker not running)" | Start Docker Desktop (or `sudo systemctl start docker`), wait until `docker info` answers, then restart the app. |
| No store line for several minutes on the first start | The first start pulls about 6.6 GB of images. Wait; the terminal says `Document store ready` when it is done. `docker compose ls` shows the `gcl-store` project starting. |
| "Document store unavailable · …" | Docker is running but the store did not start. The reason is in the line and in the terminal. Check `docker ps` for the `gcl-store` containers and that port 8011 is free; restart the app to try again. A review still runs, without the store. A second copy of the app on the same computer needs its own store: `GCL_STORE_PROJECT=gcl-store-2 GCL_STORE_PORT=8012 npm start`. |
| Reviews fail with "not logged in" on the Claude CLI route | The app was started from a shell an agent or automation spawned, which does not carry your Claude sign-in. Run `claude` in your own terminal, sign in, and start the app from that terminal. |
| "The claude CLI is not on PATH." | Install the Claude Code CLI (step 3) and start the app from a terminal where `claude --version` works. |
| "ANTHROPIC_API_KEY is required…" / "OPENAI_API_KEY and a model are required…" | Add the key under Settings · Models · Connections (and a model id for OpenAI-compatible), then Save. |
| Word shows a blank pane or "add-in could not be loaded" | The certificate is not trusted, or the app is not on 3443. Open https://localhost:3443 in a browser: it must load with no warning. Redo step 5.2, then quit and reopen Word. |
| "No model set up yet · Settings · Models" | Expected before step 3. Pick a route under Settings · Models; the line goes when the route can be used (the Claude CLI found, or a key saved). |
| `EADDRINUSE` when the app starts | Another program (or another copy of the app) is on the port. Stop it, or start on another port: `PORT=3001 npm start` (the Word pane needs 3443). `lsof -i :3000` on a Mac or Linux, `netstat -ano | findstr :3000` on Windows, shows what holds it. |
