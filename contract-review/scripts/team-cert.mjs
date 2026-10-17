#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// A throwaway certificate authority and a team-server certificate signed by it, for trying the team server and for
// the tests (product v2 spec 9.1 step 2 expects IT's own certificate in production). Writes ca.crt, server.crt and
// server.key into <dir>. Names default to localhost and 127.0.0.1; pass more with --name.
//   node scripts/team-cert.mjs <dir> [--name gcl.office.example] [--days 825]
// Installs no trust anywhere: point the local app's server.caFile at <dir>/ca.crt.
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = path.resolve(args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'team-tls');
const names = ['localhost', ...args.flatMap((a, i) => (a === '--name' ? [args[i + 1]] : []))];
const days = String(Number(args[args.indexOf('--days') + 1]) || 825);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const f = n => path.join(dir, n);
const run = a => { const r = spawnSync('openssl', a, { encoding: 'utf8' }); if (r.status !== 0) throw Error(`openssl ${a[0]} failed: ${r.stderr}`); };
const san = [...new Set(names)].map(n => `DNS:${n}`).concat('IP:127.0.0.1').join(',');
writeFileSync(f('ca.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=GinChugger test CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
writeFileSync(f('server.cnf'), `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${names[names.length - 1]}\n[ext]\nsubjectAltName=${san}\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`);
run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', days, '-keyout', f('ca.key'), '-out', f('ca.crt'), '-config', f('ca.cnf')]);
run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('server.key'), '-out', f('server.csr'), '-config', f('server.cnf')]);
run(['x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', days, '-out', f('server.crt'), '-extfile', f('server.cnf'), '-extensions', 'ext']);
for (const n of ['server.csr', 'ca.srl', 'ca.cnf', 'server.cnf']) rmSync(f(n), { force: true });
chmodSync(f('server.key'), 0o600); chmodSync(f('ca.key'), 0o600);
console.log(`Wrote ${f('ca.crt')}, ${f('server.crt')} and ${f('server.key')} for ${san}. No trust was installed.`);
