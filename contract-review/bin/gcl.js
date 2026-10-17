#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// gcl: the record's admin commands (product v2 spec section 9.3; after decision 190 the record holds the team's playbooks,
// members, keys and setup codes, and documents live in the document store). On a laptop in solo mode it acts on the local record
// in the data folder (GCL_DATA_DIR, MARGIN_STATE_DIR or contract-review/.local, or --data <dir>); inside the team
// server's container it acts on /data directly (GCL_DATA_DIR), which is why the first admin code needs no key. The
// `admin` verbs (slice S7) issue and revoke setup codes and revoke people; on a laptop in team mode they go through
// the team server with the signed-in member's key, and the server checks that member is an admin.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { openRecord, stateDir } from '../server/record/index.js';
import { check, backup, restore, serverRunning } from '../server/record/admin.js';
import { readSettings, readRawSetting, readServerSettings } from '../server/settings.js';
import { openSecrets } from '../server/secrets.js';
import { openRemoteRecord } from '../server/record/remote.js';

const USAGE = `Usage: gcl [--data <dir>] <command>
  check                    schema and clause-type mappings
  backup [dir]             consistent copy of the database (the document store is backed up with its own data folder)
  restore <dir|file>       replace the database from a backup (refused while the app runs)
  admin issue-code --for <name> [--admin] [--hours n] [--user <id>]
                           issue a setup code (shown once); --user: a second device for that person
  admin list-codes         every code issued, with its state (never the code itself)
  admin revoke-code <id>   revoke a code not yet used
  admin list-users         every person with their devices
  admin revoke-user <id>   revoke every key of that person
  mail check               check the shared mailbox now (team server; or through it, as an admin)`;

const COMMANDS = ['check', 'backup', 'restore', 'admin', 'mail'];
const ADMIN = ['issue-code', 'list-codes', 'revoke-code', 'list-users', 'revoke-user'];
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const day = iso => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '');

/** The record `gcl admin` acts on: the local SQLite, or the team server when this laptop is signed in to one. */
async function adminRecord(dataDir) {
  const s = readSettings(dataDir);
  if (s.mode !== 'team' || !s.server.url) return { rec: openRecord({ dataDir }), actor: 'system:gcl', where: dataDir };
  const secrets = await openSecrets({ dataDir });
  const key = secrets.get('server-key');
  if (!key) throw new Error('This computer is in team mode but not signed in. Join the team on the Settings page first.');
  return { rec: openRemoteRecord({ url: s.server.url, key, caFile: s.server.caFile }), actor: null, where: s.server.url };
}

async function admin(dataDir, [verb, ...args], log) {
  if (!ADMIN.includes(verb)) { log(USAGE); return 2; }
  const { rec, actor } = await adminRecord(dataDir);
  try {
    switch (verb) {
      case 'issue-code': {
        const forName = flag(args, '--for'); const userId = flag(args, '--user');
        if (!forName && !userId) { log(USAGE); return 2; }
        const c = await rec.admin.issueCode(forName, args.includes('--admin'), flag(args, '--hours') ? Number(flag(args, '--hours')) : undefined, actor, { userId: userId || null });
        log(`Setup code for ${c.forName}${c.admin ? ' (admin)' : ''}: ${c.code}`);
        log(`Give this to ${c.forName} in person or by a channel you trust. It expires on ${day(c.expiresAt)} and works once. It is not shown again.`);
        return 0;
      }
      case 'list-codes': {
        const now = Date.now();
        for (const c of await rec.admin.listCodes()) log(`${c.id}  ${c.forName}${c.admin ? ' (admin)' : ''}  issued ${day(c.issuedAt)}  ${c.revokedAt ? 'revoked' : c.redeemedAt ? `used ${day(c.redeemedAt)}` : Date.parse(c.expiresAt) <= now ? 'expired' : `expires ${day(c.expiresAt)}`}`);
        return 0;
      }
      case 'revoke-code': { if (!args[0]) { log(USAGE); return 2; } await rec.admin.revokeCode(args[0], actor); log(`Code ${args[0]} revoked.`); return 0; }
      case 'list-users': {
        for (const u of await rec.admin.listUsers()) log(`${u.id}  ${u.name}${u.admin ? ' (admin)' : ''}  ${u.revokedAt ? `revoked ${day(u.revokedAt)}` : 'active'}  devices: ${u.keys.map(k => `${k.deviceName}${k.revokedAt ? ' (revoked)' : ''}`).join(', ') || 'none'}`);
        return 0;
      }
      case 'revoke-user': { if (!args[0]) { log(USAGE); return 2; } const u = await rec.admin.revokeUser(args[0], actor); log(`${u.name} revoked: every key of theirs now gets "Signed out by an admin".`); return 0; }
    }
  } finally { rec.close(); }
  return 2;
}

/**
 * `gcl mail check` (9.3). Inside the container (the data folder is the team server's): a running server is asked
 * through a flag file it polls, so two processes never read the mailbox at once; a stopped server's data folder is
 * checked here, once. On a laptop in team mode: the server's "check mail now", as an admin. Solo mode has no mailbox.
 */
async function mail(dataDir, [verb], log, env = process.env) {
  if (verb !== 'check') { log(USAGE); return 2; }
  if (readRawSetting(dataDir, 'mode') === 'server') {
    const { settings } = readServerSettings(dataDir);
    if (!settings.mail.enabled) { log('Mail capture is off: set mail.enabled in the settings file.'); return 1; }
    const { CHECK_FLAG, createMailConsumer } = await import('../server/mail/consumer.js');
    const pid = serverRunning(dataDir);
    if (pid) { writeFileSync(path.join(dataDir, CHECK_FLAG), new Date().toISOString()); log(`Mail check requested from the running server (pid ${pid}); it starts within a few seconds. The Admin page shows the result.`); return 0; }
    const rec = openRecord({ dataDir, mode: 'team' });
    // The captures go to the document store, configured as the team server configures it (plan task 11).
    const { teamStore } = await import('../server/team-server.js');
    const documents = teamStore({ settings, env, dataDir, defaultMode: env.GCL_DATA_DIR || dataDir === '/data' ? 'managed' : 'off', log: { log() {}, error() {} } });
    try {
      await documents.start();
      const r = await createMailConsumer({ record: rec, settings, documents: () => documents.serviceClient(), log: { log, error() {}, warn() {}, debug() {}, info() {} } }).runCheck();
      if (!r.ok) { log(`Mail check failed: ${r.error.message}`); return 1; }
      const counts = r.outcomes.reduce((o, x) => ({ ...o, [x.outcome]: (o[x.outcome] || 0) + 1 }), {});
      log(`Mail checked: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new'}.${r.errors.length ? ` ${r.errors.join(' ')}` : ''}`);
      return 0;
    } finally { rec.close(); }
  }
  const s = readSettings(dataDir);
  if (s.mode !== 'team' || !s.server.url) { log('There is no mailbox in solo mode.'); return 1; }
  const { rec } = await adminRecord(dataDir);
  try { const r = await rec.admin.checkMailNow(); log(`Mail check started on the team server at ${day(r.startedAt)}. The Admin page shows the result.`); return 0; } finally { rec.close?.(); }
}

export async function main(argv, { log = console.log, env = process.env } = {}) {
  const args = [...argv]; let dataDir = env.GCL_DATA_DIR ? path.resolve(env.GCL_DATA_DIR) : stateDir(env);
  const at = args.indexOf('--data'); if (at >= 0) { dataDir = path.resolve(args[at + 1]); args.splice(at, 2); }
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') { log(USAGE); return 0; }
  if (!COMMANDS.includes(cmd)) { log(USAGE); return 2; } // before anything opens or creates a record
  if (cmd === 'admin') return admin(dataDir, rest, log);
  if (cmd === 'mail') return mail(dataDir, rest, log, env);
  if (cmd === 'restore') {
    if (!rest[0]) { log(USAGE); return 2; }
    const r = restore(dataDir, rest[0]); log(`Restored from ${r.restoredFrom}${r.filesCopied ? `; ${r.filesCopied} files copied` : ''}.`);
    const rec = openRecord({ dataDir }); try { const c = await check(rec); report(c, log); return c.ok ? 0 : 1; } finally { rec.close(); }
  }
  const rec = openRecord({ dataDir });
  try {
    switch (cmd) {
      case 'check': { const c = await check(rec); report(c, log); return c.ok ? 0 : 1; }
      case 'backup': { const b = backup(rec, rest[0]); log(`Backup written: ${b.file}${rest[0] ? `; ${b.filesCopied} files copied` : ''}.`); return 0; }
      default: log(USAGE); return 2;
    }
  } finally { rec.close(); }
}

function report(c, log) {
  for (const p of c.passed) log(`ok: ${p}`);
  for (const w of c.warnings) log(`warning: ${w}`);
  for (const e of c.errors) log(`error: ${e}`);
  log(`Counts: ${Object.entries(c.counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  log(c.ok ? 'Check passed.' : 'Check failed.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/gcl') || process.argv[1]?.endsWith('gcl.js')) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.message); process.exitCode = 1; });
}
