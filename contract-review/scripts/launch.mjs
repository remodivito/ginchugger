#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The installed app's entry point (PR-REL-01). The release runs it with its bundled Node:
//   ginchugger-legal                 start the local app (the login item does this with --log)
//   ginchugger-legal setup-word      make the localhost certificate Word needs (825 days) and print the trust step
//   ginchugger-legal gcl <command>   the admin commands (gcl check, gcl backup, ...)
// The install folder is read-only for the lawyer, so the data folder is the user's own: Application Support on a Mac,
// %LOCALAPPDATA% on Windows (MARGIN_STATE_DIR overrides it). Once setup-word has made the certificate, the app serves
// HTTPS on port 3443 for the Word pane; until then plain HTTP on port 3000 for the browser.
import { mkdirSync, existsSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// The data folder's name. It predates the rename to GinChugger (decision 194) and stays, so existing data is found.
export const APP_NAME = 'GinChugger Legal';

/** The per-user data folder for an installed app. */
export function defaultStateDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.MARGIN_STATE_DIR) return env.MARGIN_STATE_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME);
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'ginchugger-legal');
}

/** The environment the app starts with: the data folder, HTTPS when the Word certificate exists, and a PATH that finds `claude`. */
export function launchEnv({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const stateDir = defaultStateDir({ platform, env, home });
  const out = { ...env, MARGIN_STATE_DIR: stateDir };
  const tls = path.join(stateDir, 'word-tls');
  const key = path.join(tls, 'localhost.key'), cert = path.join(tls, 'localhost.crt');
  if (!env.HTTPS_KEY && existsSync(key) && existsSync(cert)) Object.assign(out, { HTTPS_KEY: key, HTTPS_CERT: cert, PORT: env.PORT || '3443' });
  // A login item starts with a bare PATH; the Claude Code CLI usually lives in one of these.
  const extra = platform === 'win32'
    ? [path.join(env.APPDATA || '', 'npm'), path.join(home, '.local', 'bin')]
    : [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const key0 = Object.keys(out).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  const parts = String(out[key0] || '').split(path.delimiter).filter(Boolean);
  out[key0] = [...parts, ...extra.filter(p => p && !parts.includes(p))].join(path.delimiter);
  return out;
}

async function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = launchEnv();
  mkdirSync(env.MARGIN_STATE_DIR, { recursive: true, mode: 0o700 });
  const [command, ...rest] = argv;
  if (command === 'setup-word') { const { run } = await import(pathToFileURL(path.join(here, 'setup-word.js'))); run({ env }); return; }
  if (command === 'gcl') { Object.assign(process.env, env); const { main: gcl } = await import(pathToFileURL(path.join(here, '..', 'bin', 'gcl.js'))); process.exitCode = await gcl(rest); return; }
  if (command && command !== '--log') { console.error(`Unknown command: ${command}. Use setup-word, gcl, or nothing to start the app.`); process.exitCode = 2; return; }
  if (command === '--log') {
    // The login item: the app's output goes to a log in the data folder, and no window is left open.
    const log = openSync(path.join(env.MARGIN_STATE_DIR, 'app.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: ['ignore', log, log], windowsHide: true });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
    return;
  }
  Object.assign(process.env, env);
  process.chdir(env.MARGIN_STATE_DIR);
  await import(pathToFileURL(path.join(here, '..', 'server', 'index.js')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
