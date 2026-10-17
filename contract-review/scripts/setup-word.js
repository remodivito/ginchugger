// SPDX-License-Identifier: GPL-3.0-or-later
// The localhost certificate the Word pane needs (PR-REL-01, spec 9.1 step 6). Valid for 825 days, the longest a Mac
// accepts for a TLS server certificate, so it is trusted once rather than every month. It never installs trust,
// changes Word's settings or sideloads the add-in: it prints the one trust step for this platform for the lawyer or
// IT to run. Written to <data folder>/word-tls: MARGIN_STATE_DIR (the installed app sets it) or contract-review/.local.
//   node scripts/setup-word.js            (installed release: ginchugger-legal setup-word)
import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const CERT_DAYS = 825;
const RESTART = {
  darwin: 'On a Mac: launchctl kickstart -k gui/$(id -u)/com.ginchugger.legal (or sign out and back in).',
  win32: 'On Windows: sign out and back in.',
};

/** The trust step for one platform, as lines to print. */
export function trustSteps(platform, cert) {
  if (platform === 'darwin') return [
    'Trust it once, in Keychain Access (Mac):',
    `  open "${cert}"   (adds it to the login keychain), then in Keychain Access double-click "localhost",`,
    '  open Trust and set "When using this certificate" to Always Trust. Or, in Terminal:',
    `  security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${cert}"`,
  ];
  if (platform === 'win32') return [
    'Trust it once (Windows), from a Command Prompt:',
    `  certutil -user -addstore Root "${cert}"   (this user; Windows asks you to confirm)`,
    `  or, as an administrator, for everyone on this computer: certutil -addstore Root "${cert}"`,
  ];
  return ['Trust it in your system\'s certificate store as a root for localhost.'];
}

// A self-signed certificate for localhost and 127.0.0.1, written in DER by hand so that no openssl is needed (Windows
// does not ship one): RSA 2048, SHA-256, serverAuth, the subject alternative names Word and macOS require.
const der = (tag, ...parts) => { const body = Buffer.concat(parts); const n = body.length;
  const len = n < 128 ? Buffer.from([n]) : (b => Buffer.concat([Buffer.from([0x80 | b.length]), b]))(Buffer.from(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), '0'), 'hex'));
  return Buffer.concat([Buffer.from([tag]), len, body]); };
const seq = (...p) => der(0x30, ...p);
const oid = s => { const [a, b, ...rest] = s.split('.').map(Number); const out = [40 * a + b];
  for (const v of rest) { const bytes = [v & 0x7f]; for (let x = v >>> 7; x; x >>>= 7) bytes.unshift(0x80 | (x & 0x7f)); out.push(...bytes); }
  return der(0x06, Buffer.from(out)); };
const time = d => { const z = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(z.slice(2))) : der(0x18, Buffer.from(z)); };
const name = cn => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), der(0x05));

export function selfSignedLocalhost({ days = CERT_DAYS, now = new Date() } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serial = randomBytes(16); serial[0] &= 0x7f; serial[0] |= 0x01;
  const from = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000), to = new Date(from.getTime() + days * 86_400_000);
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), SHA256_RSA, name('localhost'), seq(time(from), time(to)), name('localhost'),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, der(0x03, Buffer.from([0x05, 0xa0]))),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])))),
    )));
  const cert = seq(tbs, SHA256_RSA, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

export function makeCertificate(dir, { days = CERT_DAYS } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = path.join(dir, 'localhost.key'), cert = path.join(dir, 'localhost.crt');
  if (existsSync(key) && existsSync(cert)) return { key, cert, created: false };
  if (existsSync(key) || existsSync(cert)) throw Error(`Partial certificate files exist in ${dir}. Inspect them before regenerating.`);
  const made = selfSignedLocalhost({ days });
  writeFileSync(key, made.key, { mode: 0o600 }); chmodSync(key, 0o600);
  writeFileSync(cert, made.cert);
  return { key, cert, created: true };
}

const root = fileURLToPath(new URL('../', import.meta.url));

/** Make or keep the certificate in the data folder and print the trust step. */
export function run({ env = process.env, platform = process.platform, log = console.log } = {}) {
  const dir = path.join(env.MARGIN_STATE_DIR || path.join(root, '.local'), 'word-tls');
  const { key, cert, created } = makeCertificate(dir);
  log(`${created ? 'Made' : 'Kept'} the localhost certificate (${CERT_DAYS} days): ${cert}`);
  log('Nothing was trusted and no Word setting was changed.');
  for (const line of trustSteps(platform, cert)) log(line);
  log(`Then restart the app; from then on it serves the Word pane at https://localhost:3443. ${RESTART[platform] || ''}`.trim());
  log(`From a source checkout instead: PORT=3443 HTTPS_KEY="${key}" HTTPS_CERT="${cert}" npm start`);
  log('Sideload public/manifest.xml in Word (docs/WORD.md, "Run and sideload").');
  return { key, cert, created };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
