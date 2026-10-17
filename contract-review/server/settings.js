// SPDX-License-Identifier: GPL-3.0-or-later
// The settings file (product v2 spec 9.2): `settings.json` in the data folder. Slice S4 reads the keys intake needs
// (internalDomains, ourNames, folders.watch); slice S6 adds the review setup the Settings page edits (review.executor,
// review.model, review.effort, review.agentic) and what the tool smoke test found (review.toolsSupported,
// review.toolSmoke). Slice S7 adds the local app's team keys (mode, server.url, server.caFile) and the team server's
// own file, every key named with its default, where an unknown key fails start with the key named (PR-ADM-01). A
// missing file or key takes the default. Environment variables (and `.env`, for development) override the file (6.5).
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'settings.json';
/** The executors the Settings page offers (PR-MODEL-01); codex and muse stay for the eval. */
export const REVIEW_EXECUTORS = ['claude', 'anthropic', 'openai'];
/**
 * Replay (recorded runs, no model call) is test infrastructure, not a choice for users: it is accepted only when the
 * environment asks for it (REVIEW_EXECUTOR=replay, as the tests and the benchmark set it, or GCL_DEV_REPLAY=1).
 */
export const replayAllowed = (env = process.env) => env.REVIEW_EXECUTOR === 'replay' || env.GCL_DEV_REPLAY === '1';
export const reviewExecutors = (env = process.env) => (replayAllowed(env) ? [...REVIEW_EXECUTORS, 'replay'] : REVIEW_EXECUTORS);
export const REVIEW_EFFORTS = ['low', 'medium', 'high'];
/** Which environment variable overrides which review setting (6.5). */
export const REVIEW_ENV = { executor: 'REVIEW_EXECUTOR', model: 'REVIEW_MODEL', effort: 'REVIEW_EFFORT', toolsSupported: 'REVIEW_TOOLS_SUPPORTED' };
const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);
const bad = message => Object.assign(new Error(message), { status: 400, code: 'bad_request' });

function readRaw(dataDir) {
  const file = path.join(dataDir, SETTINGS_FILE);
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) || {}; } catch (e) { throw Object.assign(new Error(`The settings file ${file} is not valid JSON: ${e.message}`), { code: 'settings_invalid' }); }
}

/** The settings from `<dataDir>/settings.json`, read fresh on each call so an edit applies without a restart. */
export function readSettings(dataDir) {
  const raw = readRaw(dataDir);
  const watch = raw.folders && typeof raw.folders.watch === 'string' && raw.folders.watch.trim() ? raw.folders.watch.trim() : null;
  const r = raw.review && typeof raw.review === 'object' ? raw.review : {};
  const srv = raw.server && typeof raw.server === 'object' ? raw.server : {};
  return {
    mode: raw.mode === 'team' ? 'team' : 'solo',
    server: { url: typeof srv.url === 'string' && srv.url.trim() ? srv.url.trim().replace(/\/+$/, '') : null, caFile: typeof srv.caFile === 'string' && srv.caFile.trim() ? srv.caFile.trim() : null },
    internalDomains: strings(raw.internalDomains).map(d => d.toLowerCase().replace(/^@/, '')),
    ourNames: strings(raw.ourNames),
    folders: { watch: watch && !path.isAbsolute(watch) ? path.resolve(dataDir, watch) : watch },
    review: {
      executor: reviewExecutors().includes(r.executor) ? r.executor : null,
      model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null,
      effort: REVIEW_EFFORTS.includes(r.effort) ? r.effort : null,
      agentic: r.agentic !== false,
      toolSmoke: r.toolSmoke && typeof r.toolSmoke === 'object' ? r.toolSmoke : null,
    },
  };
}

/**
 * The document store's keys (tasks/paperless-store-plan.md task 1): `store.mode` (managed, external, fake, off),
 * `store.url` (external only), `store.port` (managed; default 8011), `store.dataDir` (default paperless-data, under the
 * data folder), `store.project` (the compose project name), and `trash.purgeAfterDays` (as on the team server: Paperless's
 * emptying of its trash, off unless set). Read apart from readSettings; server/store/service.js
 * fills the defaults and applies the GCL_STORE_* overrides.
 */
export function readStoreSettings(dataDir) {
  const raw = readRaw(dataDir); const s = raw.store; const t = raw.trash;
  // trash.purgeAfterDays, as on the team server: off unless set; when set, Paperless empties its trash of items older than
  // that many days (server/store/service.js checks it is a whole number of days).
  const purge = t && typeof t === 'object' && !Array.isArray(t) && t.purgeAfterDays !== undefined ? { purgeAfterDays: t.purgeAfterDays } : {};
  if (!s || typeof s !== 'object' || Array.isArray(s)) return purge;
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { mode: str(s.mode), url: str(s.url), port: Number.isInteger(s.port) ? s.port : null, dataDir: str(s.dataDir), project: str(s.project), ...purge };
}

/** Which review settings the environment fixes, by the variable that does: `{ executor: 'REVIEW_EXECUTOR' | null, ... }`. A fixed executor fixes the whole setup. */
export function lockedReviewSettings(fixed) {
  const has = name => fixed.has(name);
  const setup = has(REVIEW_ENV.executor) ? REVIEW_ENV.executor : null;
  return {
    executor: setup,
    model: setup || (has(REVIEW_ENV.model) ? REVIEW_ENV.model : null),
    effort: setup || (has(REVIEW_ENV.effort) ? REVIEW_ENV.effort : null),
    toolsSupported: has(REVIEW_ENV.toolsSupported) ? REVIEW_ENV.toolsSupported : null,
  };
}

/**
 * Put the file's review setup into the environment the executors read (executors.js is frozen and reads only the
 * environment). Variables fixed at start (`fixed`, the names present then) are left alone. The tool smoke result
 * counts only for the setup it was run on.
 */
export function applyReviewSettings(dataDir, { fixed, env = process.env, describe = null } = {}) {
  const s = readSettings(dataDir).review; const locked = lockedReviewSettings(fixed);
  for (const key of ['executor', 'model', 'effort']) {
    if (locked[key]) continue;
    if (s[key]) env[REVIEW_ENV[key]] = s[key]; else delete env[REVIEW_ENV[key]];
  }
  if (!locked.toolsSupported) {
    const now = describe ? describe(env) : null;
    const smoke = s.toolSmoke;
    const applies = smoke && now && smoke.executor === now.executor && (smoke.model || null) === (now.model || null);
    if (applies && smoke.passed === false) env[REVIEW_ENV.toolsSupported] = 'false'; else delete env[REVIEW_ENV.toolsSupported];
  }
  return s;
}

/** Validate a change to the review setup from the Settings page and write it. Keys the environment fixes are refused. */
export function writeReviewSettings(dataDir, patch, { fixed = new Set() } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Send the review settings to change.');
  const locked = lockedReviewSettings(fixed); const next = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!['executor', 'model', 'effort', 'agentic', 'toolSmoke'].includes(k)) throw bad(`Unknown setting review.${k}.`);
    if (locked[k]) throw bad(`review.${k} is set by ${locked[k]} in the environment.`);
    if (k === 'executor' && !reviewExecutors().includes(v)) throw bad(`Choose one of: ${reviewExecutors().join(', ')}.`);
    if (k === 'model' && v !== null && (typeof v !== 'string' || v.length > 200)) throw bad('A model id is up to 200 characters.');
    // The id reaches a CLI's argument list (--model <id>): letters, digits and . _ / : @ - only, never starting with a dash.
    if (k === 'model' && typeof v === 'string' && v.trim() && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(v.trim())) throw bad('A model id uses letters, digits and . _ / : - and starts with a letter or digit.');
    if (k === 'effort' && !REVIEW_EFFORTS.includes(v)) throw bad(`Choose one of: ${REVIEW_EFFORTS.join(', ')}.`);
    if (k === 'agentic' && typeof v !== 'boolean') throw bad('review.agentic is true or false.');
    next[k] = k === 'model' && typeof v === 'string' ? v.trim() || null : v;
  }
  const raw = readRaw(dataDir);
  const review = { ...(raw.review && typeof raw.review === 'object' ? raw.review : {}), ...next };
  for (const k of Object.keys(review)) if (review[k] === null) delete review[k];
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, SETTINGS_FILE);
  writeFileSync(file + '.tmp', JSON.stringify({ ...raw, review }, null, 2) + '\n'); renameSync(file + '.tmp', file);
  return readSettings(dataDir).review;
}

/** The team server's address, as the local app accepts it: HTTPS only (PR-SEC-04: no plaintext fallback). */
export function checkServerUrl(url) {
  let u; try { u = new URL(String(url || '').trim()); } catch { throw bad('Enter the team server address, such as https://gcl.office.example:8443.'); }
  if (u.protocol !== 'https:') throw Object.assign(bad('The team server is reached over HTTPS only. Use an https:// address.'), { code: 'https_required' });
  if (u.username || u.password || u.search || u.hash) throw bad('Enter the server address only.');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** Join or leave a team (7.10 step 3, 6.2.2 sign-out): `mode` and the server keys of the local settings file. */
export function writeTeamSettings(dataDir, { mode, url = null, caFile = null }) {
  const raw = readRaw(dataDir);
  const next = { ...raw, mode };
  if (mode === 'team') next.server = { ...(raw.server && typeof raw.server === 'object' ? raw.server : {}), url: checkServerUrl(url), caFile: caFile || null };
  else delete next.server;
  if (next.server && !next.server.caFile) delete next.server.caFile;
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, SETTINGS_FILE);
  writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n'); renameSync(file + '.tmp', file);
  return readSettings(dataDir);
}

// ---- The team server's settings file (section 9.2): every key named, with its default.

export const SERVER_DEFAULTS = Object.freeze({
  mode: 'server',
  server: { listen: '0.0.0.0:8443', publicUrl: null, tls: { certFile: '/data/tls/server.crt', keyFile: '/data/tls/server.key' }, minClientVersion: null },
  data: { dir: '/data' },
  codes: { ttlHours: 168, redeemRatePerMinute: 10 },
  mail: {
    enabled: false, host: 'outlook.office365.com', port: 993, tls: true,
    auth: { type: 'oauth2-client-credentials', tenantId: null, clientId: null, mailbox: null, clientSecretFile: '/data/secrets/mail-client-secret' },
    folders: { inbox: 'INBOX', toFile: 'To file', filed: 'Filed', failed: 'Not filed' },
    intervalMinutes: 10, maxAgeDays: 30,
    attachments: { include: ['*.docx', '*.pdf', '*.eml'], exclude: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.ics', '*.vcf', '*.p7s'], maxBytes: 26214400 },
    allowPrivateAddresses: false,
  },
  internalDomains: [], ourNames: [],
  // The document store (decision 191; plan task 11): as the local app's `store` keys (readStoreSettings). Unset mode means
  // managed when the server runs from its own data folder (GCL_DATA_DIR or /data), else off; GCL_STORE_* override.
  store: { mode: null, url: null, port: null, dataDir: null, project: null },
  // Kept so settings files written before decision 190 still load; nothing reads folders.watch now (the record's watched
  // folder went with matters: Paperless's consume folder can take its role).
  folders: { watch: null },
  retention: { adoptedOn: null },
  // Paperless's emptying of its trash: off (null) unless set to a number of days (decision 188); the solo app reads the
  // same key (readStoreSettings).
  trash: { purgeAfterDays: null },
  log: { level: 'info', requests: false },
  signing: { recordKeyFile: null },
});
/** Keys whose presence means an AI credential or a model setup (PR-SEC-07): refused with that message, not as unknown. */
export const SERVER_FORBIDDEN_KEYS = ['review', 'openai', 'anthropic'];
/** Development overrides (PR-ADM-01: environment variables override settings for development only). */
export const SERVER_ENV = { GCL_LISTEN: 'server.listen', GCL_PUBLIC_URL: 'server.publicUrl', GCL_TLS_CERT: 'server.tls.certFile', GCL_TLS_KEY: 'server.tls.keyFile' };

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function mergeChecked(defaults, given, at, unknown) {
  const out = {};
  for (const [k, d] of Object.entries(defaults)) {
    const v = given?.[k];
    out[k] = isObj(d) ? mergeChecked(d, isObj(v) ? v : {}, `${at}${k}.`, unknown) : v === undefined ? d : v;
  }
  for (const k of Object.keys(given || {})) if (!(k in defaults)) unknown.push(at + k);
  return out;
}
function setPath(obj, dotted, value) { const keys = dotted.split('.'); let o = obj; for (const k of keys.slice(0, -1)) o = o[k]; o[keys[keys.length - 1]] = value; }

/**
 * The server's settings from `<dataDir>/settings.json`, defaults filled in. Throws `settings_unknown_key` naming the
 * first unknown key (PR-ADM-01). Keys under review/openai/anthropic are left in `forbidden` for the refusal check.
 */
export function readServerSettings(dataDir, { env = {} } = {}) {
  const raw = readRaw(dataDir);
  const forbidden = SERVER_FORBIDDEN_KEYS.filter(k => k in raw).map(k => isObj(raw[k]) && Object.keys(raw[k]).length ? `${k}.${Object.keys(raw[k])[0]}` : k);
  const unknown = [];
  const given = Object.fromEntries(Object.entries(raw).filter(([k]) => !SERVER_FORBIDDEN_KEYS.includes(k)));
  const out = mergeChecked(SERVER_DEFAULTS, given, '', unknown);
  if (unknown.length) throw Object.assign(new Error(`The settings file ${path.join(dataDir, SETTINGS_FILE)} has a key this release does not know: ${unknown[0]}. Remove it or check its spelling.`), { code: 'settings_unknown_key', key: unknown[0] });
  if (out.mode !== 'server') throw Object.assign(new Error(`The team server's settings file says mode "${out.mode}"; it must be "server".`), { code: 'settings_invalid' });
  for (const [name, key] of Object.entries(SERVER_ENV)) if (typeof env[name] === 'string' && env[name]) setPath(out, key, env[name]);
  out.data.dir = dataDir;
  return { settings: out, forbidden, exists: existsSync(path.join(dataDir, SETTINGS_FILE)) };
}

/** A fresh data folder gets a settings file naming every key with its default (PR-ADM-01). */
export function writeDefaultServerSettings(dataDir) {
  const file = path.join(dataDir, SETTINGS_FILE);
  if (existsSync(file)) return false;
  mkdirSync(dataDir, { recursive: true });
  const defaults = JSON.parse(JSON.stringify(SERVER_DEFAULTS));
  defaults.data.dir = dataDir;
  if (dataDir !== '/data') { defaults.server.tls = { certFile: path.join(dataDir, 'tls', 'server.crt'), keyFile: path.join(dataDir, 'tls', 'server.key') }; defaults.mail.auth.clientSecretFile = path.join(dataDir, 'secrets', 'mail-client-secret'); }
  writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n');
  return true;
}

/** One key of a settings file as written, or undefined (the record reads codes.ttlHours and retention.adoptedOn so). */
export function readRawSetting(dataDir, dotted) {
  let o = readRaw(dataDir);
  for (const k of dotted.split('.')) { if (!isObj(o) || !(k in o)) return undefined; o = o[k]; }
  return o;
}

/** One key of the server's settings file, written back (the Admin page's "mark adopted": retention.adoptedOn). */
export function writeServerSetting(dataDir, dotted, value) {
  const raw = readRaw(dataDir);
  const keys = dotted.split('.'); let o = raw;
  for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value;
  const file = path.join(dataDir, SETTINGS_FILE);
  writeFileSync(file + '.tmp', JSON.stringify(raw, null, 2) + '\n'); renameSync(file + '.tmp', file);
}
