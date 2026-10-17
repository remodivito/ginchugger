// SPDX-License-Identifier: GPL-3.0-or-later
// Mail capture end to end (product v2 spec 11.2, slice S8; plan task 9): a real team server whose shared mailbox is the
// simulated one and whose document store is the in-memory fake (tests/e2e/mail-team-server.js), and a lawyer's app in
// team mode. A counterparty forwards their markup; the admin presses "Check mail now"; the store then holds two
// documents tagged inbox: the email (type Email) and the markup, matched to Brightwater Analytics Ltd from its text,
// with a note naming the email. The same message delivered again (same Message-ID) is not captured twice.
import { test, expect } from './fixtures.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testTls } from '../fixtures/test-tls.js';
import { fileURLToPath } from 'node:url';
import { mailSettings, forwardedEmail, docxAttachment } from '../fixtures/mail.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TLS = testTls();
const CA_FILE = path.join(TLS, 'ca.crt');
const OFF = Number(process.env.E2E_PORT_OFFSET || 0); // see playwright.config.js
const A = `http://localhost:${3293 + OFF}`;
const temp = p => mkdtempSync(path.join(tmpdir(), p));
const fixture = name => readFileSync(path.join(root, 'data/fixtures', name));
const procs = [];
let teamUrl, control, adaCode;

function start(args, env, ready) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(child);
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`${args[0]} did not start: ${out}`)), 30_000);
    child.stderr.on('data', d => { out += d; });
    child.stdout.on('data', d => { out += d; const m = ready.exec(out); if (m) { clearTimeout(timer); resolve([m, out]); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`${args[0]} exited ${code}: ${out}`)); });
  });
}
const appEnv = (port, state) => ({ ...process.env, PORT: String(port), MARGIN_STATE_DIR: state, GCL_KEYCHAIN: 'file', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: path.join(root, 'data/recorded-runs/demo-fixture'), REVIEW_TOOLS_SUPPORTED: 'false', REVIEW_TRACE_DIR: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '' });
const deliver = async (request, raw) => expect((await request.post(`${control}/deliver`, { data: { raw: raw.toString('base64') } })).status()).toBe(201);
const folders = async request => (await request.get(`${control}/folders`)).json();
const stored = async request => (await request.get(`${control}/store`)).json();

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: A });

test.beforeAll(async () => {
  const serverData = temp('gcl-mail-e2e-');
  writeFileSync(path.join(serverData, 'settings.json'), JSON.stringify({ mode: 'server', server: { listen: '127.0.0.1:0', publicUrl: 'https://localhost', tls: { certFile: path.join(TLS, 'server.crt'), keyFile: path.join(TLS, 'server.key') } }, internalDomains: ['firm.example'], mail: mailSettings(serverData) }));
  const issued = spawnSync(process.execPath, ['bin/gcl.js', '--data', serverData, 'admin', 'issue-code', '--for', 'Ada Admin', '--admin'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  adaCode = /: ([0-9A-Z]{26})$/m.exec(issued.stdout)[1];
  const emptyPath = temp('gcl-path-'); mkdirSync(emptyPath, { recursive: true });
  const [[, port], out] = await start(['tests/e2e/mail-team-server.js', '--data', serverData], { PATH: emptyPath }, /ready at https:\/\/[^:]+:(\d+)/);
  teamUrl = `https://localhost:${port}`;
  control = /control (http:\/\/127\.0\.0\.1:\d+)/.exec(out)[1];
  await start(['server/index.js'], appEnv(3293 + OFF, temp('gcl-app-mail-')), /ready at/);
});
test.afterAll(() => { for (const p of procs) p.kill(); });

test('a forwarded email with a .docx lands in the store as two inbox documents, the markup noting its email; the same Message-ID again is not captured twice', async ({ page, request }) => {
  await page.goto(`${A}/#/settings/team`);
  const form = page.getByRole('form', { name: 'Join a team' });
  await form.getByLabel('Server address').fill(teamUrl);
  await form.getByLabel('Setup code').fill(adaCode);
  await form.getByLabel('Device name').fill('Ada’s Mac');
  await form.getByLabel('CA file').fill(CA_FILE);
  await form.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('Signed in as Ada Admin (admin)')).toBeVisible();

  // Their markup arrives by email and is forwarded to the shared mailbox.
  const raw = forwardedEmail({ subject: 'Brightwater NDA – our markup', from: 'Nkechi Okafor <nkechi@brightwater.example>', body: 'Please find our markup attached.', messageId: '<bw-markup-1@brightwater.example>', attachments: [docxAttachment('helix-brightwater-nda-v2-bw-markup.docx', fixture('history/helix-brightwater-nda-v2-bw-markup.docx'))] });
  await deliver(request, raw);

  await page.goto(`${A}/#/admin`);
  await page.getByRole('button', { name: 'Check mail now' }).click();
  await expect(page.getByText('Mail check started')).toBeVisible();
  await expect.poll(async () => (await stored(request)).length, { timeout: 15_000 }).toBe(2);
  expect((await folders(request)).Filed).toEqual(['Brightwater NDA – our markup']);

  const docs = await stored(request);
  const email = docs.find(d => d.type === 'Email');
  const markup = docs.find(d => d.title === 'helix-brightwater-nda-v2-bw-markup');
  expect([email.title, email.tags, email.mimeType]).toEqual(['Brightwater NDA – our markup', ['inbox'], 'message/rfc822']);
  expect([markup.type, markup.tags, markup.counterparty, markup.originalName]).toEqual([null, ['inbox'], 'Brightwater Analytics Ltd', 'helix-brightwater-nda-v2-bw-markup.docx']);
  expect(markup.notes).toEqual([`Came with email: Brightwater NDA – our markup (document ${email.id})`]);
  expect(markup.created).toBe(email.created);

  // The same message again (a re-send, or the mailbox rebuilt): skipped by its Message-ID, not captured twice.
  const before = (await (await request.get('/api/v2/admin/status')).json()).mail.lastCheckAt;
  await deliver(request, raw);
  expect((await request.post('/api/v2/admin/mail/check', { data: {} })).status()).toBe(202);
  await expect.poll(async () => (await (await request.get('/api/v2/admin/status')).json()).mail.processed24h.skipped, { timeout: 15_000 }).toBe(1);
  const status = (await (await request.get('/api/v2/admin/status')).json()).mail;
  expect(status.lastCheckAt).not.toBe(before);
  expect([status.processed24h.captured, status.lastError]).toEqual([1, null]);
  expect((await stored(request)).length).toBe(2);
  expect((await folders(request)).Filed).toEqual(['Brightwater NDA – our markup', 'Brightwater NDA – our markup']);
  await page.reload(); // still on the Admin page from "Check mail now": read its status again
  await expect(page.getByRole('list', { name: 'Status' })).toContainText('1 captured');
});
