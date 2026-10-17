// SPDX-License-Identifier: GPL-3.0-or-later
// The local app's secrets (product v2 spec 6.2.2, PR-TEAM-03, PR-SEC-03): the team server key and the executor keys,
// kept in the Mac Keychain or Windows Credential Manager through @napi-rs/keyring (MIT) under the service
// "GinChugger", one account per secret, never in the settings file and never sent to the browser or the pane.
// Where the OS keychain cannot be used (the package did not install for this platform, no keychain service, or
// GCL_KEYCHAIN=file as the tests set), the secrets go in <data>/secrets.json with mode 0600 and the Settings page says so.
// Executor keys reach a model call through the environment for that call only (`withSecrets`), so executors.js is
// unchanged; a variable set in the environment or `.env` when the app started wins (development).
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

export const SERVICE = 'GinChugger';
/** The service name before decision 194. A key found only there is read, then copied to SERVICE, so none is orphaned. */
export const OLD_SERVICE = 'GinChugger Legal';
/**
 * Each secret's keychain account and the variable it fills for a model call (null: never placed in the environment).
 * The record signing key is null on purpose (readiness audit, 17 Oct 2026, security finding 1): it signs review records
 * in process (server/record.js is handed the key directly) and must never reach a CLI that a review spawns.
 */
export const SECRETS = { 'server-key': null, 'anthropic-key': 'ANTHROPIC_API_KEY', 'openai-key': 'OPENAI_API_KEY', 'record-signing-key': null };
export const EDITABLE = ['anthropic-key', 'openai-key', 'record-signing-key'];
const bad = message => Object.assign(new Error(message), { status: 400, code: 'bad_request' });

function fileStore(file) {
  const read = () => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; } };
  const write = all => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(all, null, 2) + '\n', { mode: 0o600 }); chmodSync(file + '.tmp', 0o600); renameSync(file + '.tmp', file); };
  return { get: n => read()[n] ?? null, set: (n, v) => write({ ...read(), [n]: v }), delete: n => { const all = read(); delete all[n]; write(all); } };
}

async function osStore(Entry) {
  Entry ??= (await import('@napi-rs/keyring')).Entry; // loading the binding touches no keychain
  const entry = n => new Entry(SERVICE, n);
  const old = n => new Entry(OLD_SERVICE, n);
  const get = n => {
    const now = entry(n).getPassword();
    if (now != null) return now;
    const was = old(n).getPassword();
    if (was == null) return null;
    entry(n).setPassword(was); // copy forward; the old entry stays until the key is changed or removed
    return was;
  };
  const drop = e => { try { e.deletePassword(); } catch { /* not there */ } };
  return { get, set: (n, v) => { entry(n).setPassword(v); drop(old(n)); }, delete: n => { drop(entry(n)); drop(old(n)); } };
}

/**
 * `backend`: 'os' (the keychain, falling back to the file) or 'file'. `Entry` replaces @napi-rs/keyring's (tests). Returns { kind: 'keychain'|'file', note, get,
 * set, delete, names() }. `note` is the one line the Settings page shows when the file is used. The keychain is first
 * touched when a secret is read or written, so a solo app that stores none never asks the OS for it.
 */
export async function openSecrets({ dataDir, backend = process.env.GCL_KEYCHAIN === 'file' ? 'file' : 'os', log = console, Entry } = {}) {
  const file = path.join(dataDir, 'secrets.json');
  let os = null;
  if (backend === 'os') { try { os = await osStore(Entry); } catch (e) { log.error(`The OS keychain is not available (${e.message}); secrets go in ${file}.`); } }
  const fallback = fileStore(file);
  const self = { kind: os ? 'keychain' : 'file', note: os ? null : `The OS keychain is not available here; keys are kept in ${file}, readable by this user only.` };
  const use = (fn, n, v) => {
    if (os) { try { return fn(os, n, v); } catch (e) { log.error(`The OS keychain refused (${e.message}); secrets go in ${file}.`); os = null; Object.assign(self, { kind: 'file', note: `The OS keychain is not available here; keys are kept in ${file}, readable by this user only.` }); } }
    return fn(fallback, n, v);
  };
  const known = n => { if (!(n in SECRETS)) throw bad(`Unknown secret ${n}.`); return n; };
  return Object.assign(self, {
    get: n => use((s, k) => s.get(k), known(n)),
    set(n, value) {
      known(n);
      if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw bad('Paste the key.');
      if (n === 'record-signing-key' && !/^[0-9a-f]{64}$/i.test(value.trim())) throw bad('The record signing key is 64 hex characters (openssl rand -hex 32).');
      use((s, k, v) => s.set(k, v), n, value.trim());
    },
    delete: n => use((s, k) => s.delete(k), known(n)),
    /** Which executor keys are set (names only, never values). */
    names: () => EDITABLE.filter(n => !!self.get(n)),
  });
}

/**
 * Run `fn` with the stored executor keys in the environment, for that call only. Variables present when the app
 * started (`fixed`) are left alone. Overlapping calls share one load; the last to finish removes the keys.
 */
export function secretsLoader(secrets, { fixed = new Set(), env = process.env } = {}) {
  let active = 0; let loaded = [];
  const values = () => Object.fromEntries(Object.entries(SECRETS).filter(([n, v]) => v && !fixed.has(v)).map(([n, v]) => [v, secrets.get(n)]).filter(([, v]) => v));
  return {
    /** The environment a status check sees: the stored keys added, without changing the process. */
    view: () => ({ ...values(), ...env }),
    async with(fn) {
      if (active++ === 0) { const add = values(); loaded = Object.keys(add).filter(k => env[k] === undefined || env[k] === ''); for (const k of loaded) env[k] = add[k]; }
      try { return await fn(); } finally { if (--active === 0) { for (const k of loaded) delete env[k]; loaded = []; } }
    },
  };
}
