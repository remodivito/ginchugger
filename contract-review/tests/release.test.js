// SPDX-License-Identifier: GPL-3.0-or-later
// Release (product v2 spec PR-REL-01): the Word certificate lasts 825 days and needs no openssl; the installed app
// keeps its data in the user's own folder and serves HTTPS once the certificate exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CERT_DAYS, makeCertificate, selfSignedLocalhost, trustSteps } from '../scripts/setup-word.js';
import { defaultStateDir, launchEnv } from '../scripts/launch.mjs';

test('the localhost certificate is valid for 825 days, for localhost and 127.0.0.1, and self-signed', () => {
  const { cert, key } = selfSignedLocalhost({ now: new Date('2026-10-15T12:00:00Z') });
  const x = new X509Certificate(cert);
  assert.equal(CERT_DAYS, 825);
  assert.equal((Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86_400_000, 825);
  assert.ok(x.verify(x.publicKey), 'signed by its own key');
  assert.equal(x.checkHost('localhost'), 'localhost');
  assert.equal(x.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x.ca, false);
  assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.match(key, /BEGIN PRIVATE KEY/);
});

test('makeCertificate writes the files once, the key readable by its owner only, and keeps them on a second run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gcl-word-tls-'));
  try {
    const first = makeCertificate(dir);
    assert.equal(first.created, true);
    if (process.platform !== 'win32') assert.equal(statSync(first.key).mode & 0o077, 0);
    const pem = readFileSync(first.cert, 'utf8');
    assert.equal(makeCertificate(dir).created, false);
    assert.equal(readFileSync(first.cert, 'utf8'), pem);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the trust step is printed for each platform and never run', () => {
  assert.match(trustSteps('darwin', '/x/localhost.crt').join('\n'), /Keychain Access[\s\S]*security add-trusted-cert/);
  assert.match(trustSteps('win32', 'C:\\x\\localhost.crt').join('\n'), /certutil -user -addstore Root[\s\S]*certutil -addstore Root/);
});

test('the installed app keeps its data in the user folder and serves HTTPS once the certificate exists', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gcl-home-'));
  try {
    assert.equal(defaultStateDir({ platform: 'darwin', env: {}, home }), path.join(home, 'Library', 'Application Support', 'GinChugger Legal'));
    assert.equal(defaultStateDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home }), path.join('C:\\Users\\a\\AppData\\Local', 'GinChugger Legal'));
    assert.equal(defaultStateDir({ platform: 'darwin', env: { MARGIN_STATE_DIR: '/elsewhere' }, home }), '/elsewhere');
    const before = launchEnv({ platform: process.platform, env: { MARGIN_STATE_DIR: home, PATH: '' }, home });
    assert.equal(before.HTTPS_KEY, undefined);
    makeCertificate(path.join(home, 'word-tls'));
    const after = launchEnv({ platform: process.platform, env: { MARGIN_STATE_DIR: home, PATH: '' }, home });
    assert.equal(after.PORT, '3443');
    assert.equal(after.HTTPS_CERT, path.join(home, 'word-tls', 'localhost.crt'));
    assert.ok(after.PATH.split(path.delimiter).includes(path.join(home, '.local', 'bin')), 'a login item still finds the Claude CLI');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
