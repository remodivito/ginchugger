// SPDX-License-Identifier: GPL-3.0-or-later
// Team mode end to end (product v2 spec 11.2, slice S7): a real team server over HTTPS (the test CA) and two local
// apps, each a lawyer's own computer. Ada joins with the first admin code (issued by `gcl` on the server's data
// folder, as inside the container), issues Ben's code on the Admin page; Ben joins on his app. Ada changes a shared
// playbook and reviews a document in the pane (the recorded demo, single call); Ben sees the change and "Last changed by
// Ada Admin". Ada revokes a code and then Ben: Ben's app says "Signed out by an admin" and the revoked code is refused.
// The documents are the team store's (the in-memory store on the team server): Ben's Inbox and Library show what Ada's
// pane added, his upload shows in Ada's Inbox, labels and history name who did what, the pane finds the document in the
// team store, and a member's page never reaches Paperless (matters and rounds went with decision 190).
// This spec starts its own processes on their own ports, so the shared server the other specs use is untouched.
import { test, expect } from './fixtures.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testTls } from '../fixtures/test-tls.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TLS = testTls();
const CA_FILE = path.join(TLS, 'ca.crt');
const OFF = Number(process.env.E2E_PORT_OFFSET || 0); // see playwright.config.js
const A = `http://localhost:${3291 + OFF}`, B = `http://localhost:${3292 + OFF}`;
const ORDER_V2 = 'order-form/helix-northgate-order-form-v2-customer-markup.docx';
const temp = p => mkdtempSync(path.join(tmpdir(), p));
const procs = [];
let teamUrl, serverData, adaCode;

function start(args, env, ready) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(child);
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`${args[0]} did not start: ${out}`)), 30_000);
    child.stderr.on('data', d => { out += d; });
    child.stdout.on('data', d => { out += d; const m = ready.exec(out); if (m) { clearTimeout(timer); resolve(m); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`${args[0]} exited ${code}: ${out}`)); });
  });
}
const appEnv = (port, state) => ({ ...process.env, PORT: String(port), MARGIN_STATE_DIR: state, GCL_KEYCHAIN: 'file', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: path.join(root, 'data/recorded-runs/demo-fixture'), REVIEW_TOOLS_SUPPORTED: 'false', REVIEW_TRACE_DIR: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '' });

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: A });

test.beforeAll(async () => {
  serverData = temp('gcl-team-e2e-');
  writeFileSync(path.join(serverData, 'settings.json'), JSON.stringify({ mode: 'server', server: { listen: '127.0.0.1:0', publicUrl: 'https://localhost', tls: { certFile: path.join(TLS, 'server.crt'), keyFile: path.join(TLS, 'server.key') } }, store: { mode: 'fake' } }));
  const issued = spawnSync(process.execPath, ['bin/gcl.js', '--data', serverData, 'admin', 'issue-code', '--for', 'Ada Admin', '--admin'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  adaCode = /: ([0-9A-Z]{26})$/m.exec(issued.stdout)[1];
  const emptyPath = temp('gcl-path-'); mkdirSync(emptyPath, { recursive: true });
  const [, port] = await start(['server/team-server.js', '--data', serverData], { PATH: emptyPath }, /ready at https:\/\/[^:]+:(\d+)/);
  teamUrl = `https://localhost:${port}`;
  await Promise.all([start(['server/index.js'], appEnv(3291 + OFF, temp('gcl-app-a-')), /ready at/), start(['server/index.js'], appEnv(3292 + OFF, temp('gcl-app-b-')), /ready at/)]);
});
test.afterAll(() => { for (const p of procs) p.kill(); });

async function join(page, base, code, device) {
  await page.goto(`${base}/#/settings/team`);
  const form = page.getByRole('form', { name: 'Join a team' });
  await form.getByLabel('Server address').fill(teamUrl);
  await form.getByLabel('Setup code').fill(code);
  await form.getByLabel('Device name').fill(device);
  await form.getByLabel('CA file').fill(CA_FILE);
  await form.getByRole('button', { name: 'Join' }).click();
}

test('two lawyers join the team with setup codes; only the admin sees Admin', async ({ page, browser }) => {
  await join(page, A, adaCode, 'Ada’s Mac');
  await expect(page.getByText('Signed in as Ada Admin (admin)')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Application' });
  await nav.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('list', { name: 'Status' })).toContainText('1 active');
  await expect(page.getByRole('list', { name: 'Status' })).toContainText('Document storeReady · in memory'); // the team store's state, not its address
  const issue = page.getByRole('form', { name: 'Issue a setup code' });
  await issue.getByLabel('Name').fill('Ben Member');
  await issue.getByRole('button', { name: 'Issue code' }).click();
  await expect(page.getByText(/Give this to Ben Member in person or by a channel you trust\. It expires on .* and works once\./)).toBeVisible();
  const benCode = (await page.getByTestId('setup-code').textContent()).trim();
  expect(benCode).toMatch(/^[0-9A-Z]{26}$/);

  const ben = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await join(ben, B, benCode, 'Ben’s PC');
  await expect(ben.getByText('Signed in as Ben Member')).toBeVisible();
  await expect(ben.getByRole('navigation', { name: 'Application' }).getByRole('link', { name: 'Admin' })).toHaveCount(0);
  expect((await (await ben.request.get(`${B}/api/v2/admin/users`)).json()).error.code).toBe('forbidden');
  await ben.context().close();
});

test('Ada changes a shared playbook and reviews a document in the pane; Ben sees the change and who made it', async ({ page, word, request, browser }) => {
  const pb = await (await request.get(`${A}/api/v2/playbooks/order-form`)).json();
  const saved = await request.put(`${A}/api/v2/playbooks/order-form`, { data: { changeCount: pb.changeCount, rules: pb.rules.slice(0, -1) } });
  expect(saved.status()).toBe(200);
  const removed = pb.rules.at(-1).id;
  await word.open(ORDER_V2, { counterparty: 'Daniel Osei (Northgate)' });
  await expect(page.locator('.pane__doc')).toHaveText('helix-northgate-order-form-v2-customer-markup');
  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), page.getByRole('button', { name: 'Review', exact: true }).click()]);
  expect(sent.postDataJSON().matterId).toBeUndefined();
  expect(sent.postDataJSON().storeDocumentId).toEqual(expect.any(Number)); // the pane found the document in the team store
  await expect(page.locator('.pane__store')).toBeVisible();
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();

  const ben = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await ben.goto(`${B}/#/playbook/order-form`);
  await expect(ben.getByTestId('last-change')).toHaveText(new RegExp(`^Change ${pb.changeCount + 1} · Last changed by Ada Admin on .* · ${removed} removed$`));
  await ben.context().close();
});

test('the team store: Ben\'s Inbox and Library show what Ada\'s pane added; his upload and labels reach Ada, credited to him', async ({ page, browser }) => {
  const ben = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await ben.goto(`${B}/#/inbox`);
  const benWaiting = ben.getByRole('region', { name: 'Waiting' });
  const added = benWaiting.getByRole('button', { name: /helix-northgate-order-form-v2-customer-markup/ });
  await expect(added).toBeVisible(); // Ada's pane put it in the team store

  // Ben uploads on his app; Ada sees it in her Inbox.
  const stamp = Date.now();
  await ben.locator('input[type=file]').setInputFiles({ name: `brightwater-${stamp}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Brightwater NDA ${stamp}. Term: two years.`) });
  await expect(benWaiting.getByRole('button', { name: new RegExp(`brightwater-${stamp}`) })).toBeVisible();
  await page.goto(`${A}/#/inbox`);
  await expect(page.getByRole('region', { name: 'Waiting' }).getByRole('button', { name: new RegExp(`brightwater-${stamp}`) })).toBeVisible();

  // Ben files Ada's document with its labels; Ada finds it in her Library, and its history names Ben.
  await added.click();
  const detail = ben.getByRole('article', { name: 'helix-northgate-order-form-v2-customer-markup' });
  const labels = detail.getByRole('group', { name: 'Labels' });
  await labels.getByLabel('Counterparty').fill('Northgate Biosciences Ltd');
  await labels.getByLabel('Type').fill('Order form');
  await detail.getByRole('button', { name: 'Done' }).click();
  await expect(ben.getByRole('status').filter({ hasText: 'filed' })).toBeVisible();
  await page.goto(`${A}/#/library?counterparty=${encodeURIComponent('Northgate Biosciences Ltd')}`);
  const row = page.getByRole('table', { name: 'Documents' }).getByRole('row', { name: 'helix-northgate-order-form-v2-customer-markup' });
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'helix-northgate-order-form-v2-customer-markup' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'helix-northgate-order-form-v2-customer-markup' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'History' }).getByRole('row').first()).toContainText('ben.member');
  await expect(page.getByRole('table', { name: 'History' })).toContainText('ada.admin');

  // Holds are for admins on the team server too; nothing in the answers names the store's address.
  const doc = (await (await ben.request.get(`${B}/api/v2/store/documents?counterparty=${encodeURIComponent('Northgate Biosciences Ltd')}`)).json()).results[0];
  expect((await ben.request.post(`${B}/api/v2/store/documents/${doc.id}/hold`, { data: { on: true } })).status()).toBe(403);
  const status = await (await ben.request.get(`${B}/api/v2/store/status`)).json();
  expect([status.state, status.url]).toEqual(['ready', null]);
  await ben.context().close();
});

test('a revoked code is refused, and a revoked person is signed out by an admin', async ({ page, browser }) => {
  await page.goto(`${A}/#/admin`);
  const issue = page.getByRole('form', { name: 'Issue a setup code' });
  await issue.getByLabel('Name').fill('Cy Contractor');
  await issue.getByRole('button', { name: 'Issue code' }).click();
  const cyCode = (await page.getByTestId('setup-code').textContent()).trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByLabel('Code for Cy Contractor').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByLabel('Code for Cy Contractor')).toContainText('Revoked');
  const people = page.getByRole('region', { name: 'People' });
  await people.getByLabel('Ben Member').getByRole('button', { name: 'Revoke' }).click();
  await people.getByLabel('Ben Member').getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(people.getByLabel('Ben Member')).toContainText('Revoked');

  const ben = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await ben.goto(`${B}/#/library`);
  await expect(ben.getByRole('status').filter({ hasText: 'Signed out by an admin' })).toBeVisible();
  await ben.goto(`${B}/#/settings/team`);
  const form = ben.getByRole('form', { name: 'Join a team' });
  await form.getByLabel('Setup code').fill(cyCode);
  await form.getByLabel('CA file').fill(CA_FILE);
  await form.getByRole('button', { name: 'Join' }).click();
  await expect(ben.getByRole('alert')).toContainText('This code is not valid.');
  await ben.context().close();
});

test('with the team server stopped the pane says the record is unavailable, and a review still completes (PR-TEAM-06)', async ({ page, word }) => {
  const server = procs[0];
  await new Promise(resolve => { server.removeAllListeners('exit'); server.once('exit', resolve); server.kill(); });
  await word.open(ORDER_V2, { counterparty: 'Daniel Osei (Northgate)' });
  await expect(page.getByRole('status').filter({ hasText: 'Record unavailable: the team server cannot be reached' })).toBeVisible();
  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), page.getByRole('button', { name: 'Review', exact: true }).click()]);
  expect(sent.postDataJSON().playbookId).toBe('order-form'); // inferred from the document's first lines: no matter to name it
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
});
