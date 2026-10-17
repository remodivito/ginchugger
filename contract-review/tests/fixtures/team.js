// SPDX-License-Identifier: GPL-3.0-or-later
// A team server for the tests, in-process over HTTPS with the test certificate (made at test time by test-tls.js with
// scripts/team-cert.mjs; a throwaway CA, valid for localhost and 127.0.0.1), and a member signed in with a setup code.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTeamServer } from '../../server/team-server.js';
import { openRemoteRecord, redeemCode, readCa } from '../../server/record/remote.js';
import { tempDir } from './record/helpers.js';
import { testTls } from './test-tls.js';

export const TLS = testTls();
export const CA_FILE = path.join(TLS, 'ca.crt');
/** An environment with no AI credential and a PATH that holds no model CLI (this machine may have one installed). */
export const cleanEnv = (extra = {}) => ({ PATH: tempDir('empty-path-'), ...extra });
export const quiet = { log() {}, error() {}, warn() {} };

/** A settings file for a test server: the test certificate, any port, everything else at its default. */
export function serverDataDir(dataDir = tempDir('team-data-'), settings = {}) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ mode: 'server', server: { listen: '127.0.0.1:0', publicUrl: 'https://localhost', tls: { certFile: path.join(TLS, 'server.crt'), keyFile: path.join(TLS, 'server.key') } }, ...settings }, null, 2));
  return dataDir;
}

export async function startTeam({ dataDir = serverDataDir(), env = cleanEnv(), now, clock, mailDeps } = {}) {
  const srv = await createTeamServer({ dataDir, env, log: quiet, ...(now ? { now } : {}), ...(clock ? { clock } : {}), ...(mailDeps ? { mailDeps } : {}) });
  const { port } = await srv.listen(0, '127.0.0.1');
  const url = `https://localhost:${port}`;
  const ca = readCa(CA_FILE);
  return {
    srv, url, dataDir, port, ca,
    /** Issue a code as `gcl admin issue-code` would inside the container. */
    issue: (forName, admin = false, ttlHours) => srv.record.admin.issueCode(forName, admin, ttlHours, 'system:gcl'),
    /** A member signed in through a code: their key and a RemoteRecord for them. */
    async member(name, admin = false, opts = {}) {
      const { code } = await srv.record.admin.issueCode(name, admin, undefined, 'system:gcl');
      const me = await redeemCode(url, { code, deviceName: `${name}'s laptop` }, { ca });
      return { ...me, remote: openRemoteRecord({ url, key: me.key, ca, ...opts }) };
    },
    close: () => srv.close(),
  };
}
