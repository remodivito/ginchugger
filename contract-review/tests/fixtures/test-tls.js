// SPDX-License-Identifier: GPL-3.0-or-later
// The team server's certificate for the tests, the end-to-end tests and the screenshots: a throwaway CA and a server
// certificate it signs, for localhost and 127.0.0.1, made at test time in a temporary folder once per process, the
// layout scripts/team-cert.mjs writes for IT. No private key is committed (*.key is ignored), and the certificates are
// written by Node (DER by hand, as scripts/setup-word.js does) so no openssl is needed on any platform.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DAYS = 825;
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts); const n = body.length;
  const len = n < 128 ? Buffer.from([n]) : (b => Buffer.concat([Buffer.from([0x80 | b.length]), b]))(Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'), 'hex'));
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p) => der(0x30, ...p);
const oid = s => {
  const [a, b, ...rest] = s.split('.').map(Number); const out = [40 * a + b];
  for (const v of rest) { const bytes = [v & 0x7f]; for (let x = v >>> 7; x; x >>>= 7) bytes.unshift(0x80 | (x & 0x7f)); out.push(...bytes); }
  return der(0x06, Buffer.from(out));
};
const time = d => { const z = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(z.slice(2))) : der(0x18, Buffer.from(z)); };
const name = cn => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), der(0x05));
const pem = (label, buf) => `-----BEGIN ${label}-----\n${buf.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const keyId = publicKey => createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest();

function certificate({ subject, issuer, publicKey, issuerPublicKey, signingKey, extensions, from, to }) {
  const serial = randomBytes(16); serial[0] &= 0x7f; serial[0] |= 0x01;
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), SHA256_RSA, name(issuer), seq(time(from), time(to)), name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(...extensions,
      ext('2.5.29.14', false, der(0x04, keyId(publicKey))),
      ext('2.5.29.35', false, seq(der(0x80, keyId(issuerPublicKey)))))));
  return pem('CERTIFICATE', seq(tbs, SHA256_RSA, der(0x03, Buffer.from([0]), sign('sha256', tbs, signingKey))));
}

/** ca.crt, server.crt and server.key (and ca.key) for localhost and 127.0.0.1, written into `dir`. */
export function makeTestTls(dir, { now = new Date(), days = DAYS } = {}) {
  const from = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000), to = new Date(from.getTime() + days * 86_400_000);
  const ca = generateKeyPairSync('rsa', { modulusLength: 2048 }), srv = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const CA = 'GinChugger test CA';
  writeFileSync(path.join(dir, 'ca.crt'), certificate({ subject: CA, issuer: CA, publicKey: ca.publicKey, issuerPublicKey: ca.publicKey, signingKey: ca.privateKey, from, to, extensions: [
    ext('2.5.29.19', true, seq(der(0x01, Buffer.from([0xff])))), // CA:TRUE
    ext('2.5.29.15', true, der(0x03, Buffer.from([0x01, 0x06]))), // keyCertSign, cRLSign
  ] }));
  writeFileSync(path.join(dir, 'server.crt'), certificate({ subject: 'localhost', issuer: CA, publicKey: srv.publicKey, issuerPublicKey: ca.publicKey, signingKey: ca.privateKey, from, to, extensions: [
    ext('2.5.29.19', true, seq()), // CA:FALSE
    ext('2.5.29.15', true, der(0x03, Buffer.from([0x05, 0xa0]))), // digitalSignature, keyEncipherment
    ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // serverAuth
    ext('2.5.29.17', false, seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])))),
  ] }));
  writeFileSync(path.join(dir, 'server.key'), srv.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(path.join(dir, 'ca.key'), ca.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return dir;
}

let made = null;
/** A folder holding ca.crt, server.crt and server.key for localhost and 127.0.0.1, made once per process. */
export function testTls() {
  return made || (made = makeTestTls(mkdtempSync(path.join(tmpdir(), 'gcl-test-tls-'))));
}
