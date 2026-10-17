// SPDX-License-Identifier: GPL-3.0-or-later
// The local app's side of team mode (product v2 spec 3.1, 7.10, 7.11, PR-TEAM-03 to 07): which record the app serves
// (LocalRecord in solo mode, RemoteRecord over the team server in team mode), joining a team with a setup code and
// leaving it, the "Signed out by an admin" state after a revoked key, and the version banner from `server-info`
// (on start, every 6 hours, and when a page asks). Never updates itself (decision 167). In team mode the documents are
// the team store's too: `store` is the team server's store over the same key and CA (server/store/remote.js).
import { existsSync, readFileSync } from 'node:fs';
import { readSettings, writeTeamSettings, checkServerUrl } from './settings.js';
import { openRemoteRecord, redeemCode, probeCertificate, readCa, serverInfo } from './record/remote.js';
import { versionBanner } from '../shared/version.js';
import { openRemoteStore } from './store/remote.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const APP_VERSION = PACKAGE.version;
export const CHECK_EVERY_MS = 6 * 3_600_000;
const bad = (message, code = 'bad_request', extra = {}) => Object.assign(new Error(message), { status: 400, code, ...extra });

/**
 * `openLocal()`: the solo record (opened once, kept open: it stays on disk when the app joins a team, 7.12).
 * `onSwitch(record)`: told whenever the record the app serves changes.
 */
export async function makeTeamClient({ dataDir, secrets, openLocal, onSwitch = () => {}, log = console, version = APP_VERSION, minServerVersion = PACKAGE.ginchugger?.minServerVersion || null, releases = PACKAGE.ginchugger?.releases || '' }) {
  let local = null, remote = null, remoteStore = null, timer = null;
  const state = { user: null, signedOut: false, reachable: null, server: null, banner: null, checkedAt: null };
  const settings = () => readSettings(dataDir);

  function openTeam() {
    const s = settings();
    if (s.mode !== 'team' || !s.server.url) return null;
    const key = secrets.get('server-key');
    if (!key) { state.signedOut = false; state.user = null; return null; }
    const onAuthError = code => { state.signedOut = code === 'key_revoked'; state.user = state.signedOut ? null : state.user; };
    try {
      const rec = openRemoteRecord({ url: s.server.url, key, caFile: s.server.caFile, onAuthError });
      remoteStore = openRemoteStore({ url: s.server.url, key, caFile: s.server.caFile, onAuthError });
      return rec;
    } catch (e) { log.error(`Team server not opened: ${e.message}`); return null; }
  }
  const current = () => remote || (local ||= openLocal());
  function startChecks() { if (remote && !timer) { timer = setInterval(() => check().catch(() => {}), CHECK_EVERY_MS); timer.unref?.(); } }
  function switchTo() { remote?.close(); remoteStore?.close(); remoteStore = null; remote = openTeam(); onSwitch(current()); startChecks(); }

  /** Who is signed in and what the server runs (never cached); sets the banner and the signed-out state. */
  async function check() {
    if (!remote) return view();
    try {
      const info = await remote.serverInfo();
      state.server = { version: info.version, minClientVersion: info.minClientVersion, configured: info.configured !== false };
      state.banner = versionBanner({ app: version, server: info.version, minClientVersion: info.minClientVersion, minServerVersion, releases });
      state.reachable = true;
      const me = await remote.me(); state.user = me; state.signedOut = false;
    } catch (e) {
      if (e.code === 'key_revoked') { state.signedOut = true; state.user = null; } else if (e.status === 401) state.user = null;
      else { state.reachable = false; state.problem = e.code; log.error(`Team server check: ${e.message}`); }
    }
    state.checkedAt = new Date().toISOString();
    return view();
  }

  function view() {
    const s = settings();
    return {
      mode: s.mode, serverUrl: s.server.url, caFile: s.server.caFile, version,
      signedIn: !!remote && !!state.user && !state.signedOut, user: state.user, signedOut: state.signedOut,
      reachable: remote ? state.reachable : null, problem: remote && state.reachable === false ? state.problem || 'record_unavailable' : null,
      server: remote ? state.server : null, banner: remote ? state.banner : null,
      keychain: { kind: secrets.kind, note: secrets.note },
    };
  }

  /** 7.10 step 3: redeem the code, keep the key in the keychain, write mode team and the server, switch the record. */
  async function signIn({ serverUrl, code, deviceName, caFile = null } = {}) {
    const url = checkServerUrl(serverUrl);
    if (typeof code !== 'string' || !code.trim()) throw bad('Enter the setup code.');
    const ca = caFile ? (existsSync(caFile) ? readCa(caFile) : (() => { throw bad(`No CA file at ${caFile}.`); })()) : undefined;
    let me;
    try { me = await redeemCode(url, { code, deviceName: deviceName || 'this computer' }, { ca }); } catch (e) {
      if (e.code === 'certificate_untrusted') {
        const cert = await probeCertificate(url).catch(() => null);
        throw bad(cert ? `The team server's certificate is not trusted. It names ${cert.subject}, SHA-256 fingerprint ${cert.fingerprint256}. Check both with IT, then set the CA file to IT's CA certificate.` : e.message, 'certificate_untrusted', { certificate: cert });
      }
      throw e;
    }
    secrets.set('server-key', me.key);
    writeTeamSettings(dataDir, { mode: 'team', url, caFile });
    state.user = { userId: me.userId, name: me.name, admin: me.admin }; state.signedOut = false;
    switchTo(); await check();
    return view();
  }

  /** 6.2.2: remove the key from the keychain and the server from settings; back to the solo record. */
  async function signOut() {
    secrets.delete('server-key');
    writeTeamSettings(dataDir, { mode: 'solo' });
    Object.assign(state, { user: null, signedOut: false, reachable: null, server: null, banner: null });
    switchTo();
    return view();
  }

  remote = openTeam();
  if (remote) { await check(); startChecks(); }
  return {
    record: current, view, check, signIn, signOut,
    get mode() { return remote ? 'team' : 'solo'; },
    get remote() { return remote; },
    /** The team server's document store in team mode (server/store/remote.js); null in solo mode. */
    get store() { return remote ? remoteStore : null; },
    serverInfo: (url, ca) => serverInfo(url, { ca }),
    close() { clearInterval(timer); remote?.close(); remoteStore?.close(); try { local?.close(); } catch { /* closed */ } },
  };
}
