#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The team-server container's document store (compose.yml, service `store-init`): Docker is not available inside the
// team-server container, so its compose file runs Paperless beside it on a private network, and this runs once before
// both on every `docker compose up`. It writes, into the store's secrets volume, readable by uid 1000 only:
//   - paperless.env: Paperless's secret key and admin password, generated on first start (ensureSecrets, as a managed
//     store does), never in the repo or the image; the team server signs in with it (store.mode external);
//   - secret-key, admin-password: the same two values, one per file, which Paperless reads through its own
//     PAPERLESS_<NAME>_FILE variables;
//   - empty-trash-cron, empty-trash-delay: Paperless's emptying of its trash, from trash.purgeAfterDays in the team
//     server's /data/settings.json: off unless set (decision 188), as everywhere else (trashSchedule).
// Paperless reads *_FILE values verbatim, so these four files have no trailing newline.
import { chownSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureSecrets, trashSchedule, purgeDays } from './service.js';

export const FILES = { secretKey: 'secret-key', adminPassword: 'admin-password', trashCron: 'empty-trash-cron', trashDelay: 'empty-trash-delay' };

/** trash.purgeAfterDays from a team server's settings file, or null (no file, not JSON, or not set). */
export function purgeAfterDaysFrom(settingsFile) {
  try { return existsSync(settingsFile) ? purgeDays(JSON.parse(readFileSync(settingsFile, 'utf8'))?.trash?.purgeAfterDays) : null; } catch { return null; }
}

/** Writes the files above into `dir`; `owner` { uid, gid } when run as root. Returns what Paperless will be given. */
export function writeStoreInit({ dir, settingsFile, owner = null }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = ensureSecrets(dir);
  const days = purgeAfterDaysFrom(settingsFile);
  const t = trashSchedule(days);
  const values = { [FILES.secretKey]: env.PAPERLESS_SECRET_KEY, [FILES.adminPassword]: env.PAPERLESS_ADMIN_PASSWORD, [FILES.trashCron]: t.cron, [FILES.trashDelay]: t.delay };
  for (const [name, value] of Object.entries(values)) {
    const file = path.join(dir, name);
    writeFileSync(file + '.tmp', String(value), { mode: 0o600 }); chmodSync(file + '.tmp', 0o600); renameSync(file + '.tmp', file);
  }
  if (owner) for (const name of ['.', ...Object.keys(values), 'paperless.env', 'store-tokens.json']) {
    const p = path.join(dir, name); if (existsSync(p)) chownSync(p, owner.uid, owner.gid);
  }
  chmodSync(dir, 0o700);
  return { purgeAfterDays: days, cron: t.cron, delay: t.delay };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.GCL_STORE_SECRETS || '/store';
  const settingsFile = process.env.GCL_SETTINGS_FILE || '/data/settings.json';
  const owner = typeof process.getuid === 'function' && process.getuid() === 0 ? { uid: 1000, gid: 1000 } : null;
  const r = writeStoreInit({ dir, settingsFile, owner });
  console.log(`Document store secrets ready in ${dir}; trash emptying ${r.purgeAfterDays ? `on, after ${r.purgeAfterDays} days` : 'off'}.`);
}
