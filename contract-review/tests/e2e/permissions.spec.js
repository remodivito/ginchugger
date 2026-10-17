// SPDX-License-Identifier: GPL-3.0-or-later
// Decision 178 end to end in team mode (product v2 spec PR-DEL-02, PR-PB-05 to 07, PR-PANE-11): a real team server
// over HTTPS and two local apps. Ada (admin) and Ben (member) join; Ben moves a matter to the trash (DMS batch 1) but
// sees no Delete permanently there and the server refuses his delete; Ada deletes it from the trash. Ben's playbook edit becomes a proposed change that Ada accepts; once Ada names Ben
// an owner on the Admin page his next edit applies. The pane has no "Review without the record" control any more
// (redesign, 16 Oct 2026) and records no round (decision 184: the round is recorded through the inbox, here its API);
// POST /api/review still runs a review as the single call when asked for agentic: false, which the benchmark uses.
// Its own processes on their own ports, like team.spec.js.
import { test, expect } from './fixtures.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTls } from '../fixtures/test-tls.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TLS = testTls();
const CA_FILE = path.join(TLS, 'ca.crt');
const OFF = Number(process.env.E2E_PORT_OFFSET || 0); // see playwright.config.js
const A = `http://localhost:${3293 + OFF}`, B = `http://localhost:${3294 + OFF}`;
const ORDER_V1 = 'order-form/helix-northgate-order-form-v1.docx';
const ORDER_V2 = 'order-form/helix-northgate-order-form-v2-customer-markup.docx';
const temp = p => mkdtempSync(path.join(tmpdir(), p));
const procs = [];
let teamUrl, adaCode;

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
const wide = async browser => (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: A });

test.beforeAll(async () => {
  const serverData = temp('gcl-perm-e2e-');
  writeFileSync(path.join(serverData, 'settings.json'), JSON.stringify({ mode: 'server', server: { listen: '127.0.0.1:0', publicUrl: 'https://localhost', tls: { certFile: path.join(TLS, 'server.crt'), keyFile: path.join(TLS, 'server.key') } } }));
  const issued = spawnSync(process.execPath, ['bin/gcl.js', '--data', serverData, 'admin', 'issue-code', '--for', 'Ada Admin', '--admin'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  adaCode = /: ([0-9A-Z]{26})$/m.exec(issued.stdout)[1];
  const emptyPath = temp('gcl-path-'); mkdirSync(emptyPath, { recursive: true });
  const [, port] = await start(['server/team-server.js', '--data', serverData], { PATH: emptyPath }, /ready at https:\/\/[^:]+:(\d+)/);
  teamUrl = `https://localhost:${port}`;
  await Promise.all([start(['server/index.js'], appEnv(3293 + OFF, temp('gcl-app-a-')), /ready at/), start(['server/index.js'], appEnv(3294 + OFF, temp('gcl-app-b-')), /ready at/)]);
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

test('Ada (admin) and Ben (member) join the team', async ({ browser }) => {
  const ada = await wide(browser);
  await join(ada, A, adaCode, 'Ada’s Mac');
  await expect(ada.getByText('Signed in as Ada Admin (admin)')).toBeVisible();
  await ada.goto(`${A}/#/admin`);
  const issue = ada.getByRole('form', { name: 'Issue a setup code' });
  await issue.getByLabel('Name').fill('Ben Member');
  await issue.getByRole('button', { name: 'Issue code' }).click();
  const benCode = (await ada.getByTestId('setup-code').textContent()).trim();
  const ben = await wide(browser);
  await join(ben, B, benCode, 'Ben’s PC');
  await expect(ben.getByText('Signed in as Ben Member')).toBeVisible();
  await ada.context().close(); await ben.context().close();
});

test('a member\'s playbook edit is a proposed change the admin accepts; once named an owner, his edit applies', async ({ browser, request }) => {
  const before = await (await request.get(`${A}/api/v2/playbooks/nda`)).json();
  const ben = await wide(browser);
  await ben.goto(`${B}/#/playbook/nda`);
  await ben.getByRole('button', { name: /DUR-01/ }).click();
  await ben.getByLabel('Position').fill('Two years from disclosure, proposed by Ben.');
  await ben.getByRole('button', { name: 'Save' }).click();
  await expect(ben.getByText('Change proposed')).toBeVisible();
  const proposed = ben.getByRole('region', { name: 'Proposed changes' });
  await expect(proposed.getByText('DUR-01 edited')).toBeVisible();
  await expect(proposed.getByText(/^Ben Member · /)).toBeVisible();
  await proposed.getByRole('button', { name: /DUR-01 edited/ }).click();
  await expect(proposed.getByText('Two years from disclosure, proposed by Ben.')).toBeVisible();
  await expect(proposed.getByRole('button', { name: 'Accept' })).toHaveCount(0); // not an owner
  expect((await (await request.get(`${A}/api/v2/playbooks/nda`)).json()).changeCount).toBe(before.changeCount);

  const ada = await wide(browser);
  await ada.goto(`${A}/#/playbook/nda`);
  const list = ada.getByRole('region', { name: 'Proposed changes' });
  await list.getByRole('button', { name: /DUR-01 edited/ }).click();
  await list.getByRole('button', { name: 'Accept' }).click();
  await expect(list).toHaveCount(0);
  await expect(ada.getByTestId('last-change')).toContainText(`Change ${before.changeCount + 1} · Last changed by Ada Admin`);
  await expect(ada.getByTestId('last-change')).toContainText('DUR-01 edited');
  const after = await (await request.get(`${A}/api/v2/playbooks/nda`)).json();
  expect(after.rules.find(r => r.id === 'DUR-01').guidance).toBe('Two years from disclosure, proposed by Ben.');

  // Ada names Ben an owner of the NDA playbook on the Admin page; his next edit applies directly.
  await ada.goto(`${A}/#/admin`);
  const owners = ada.getByRole('region', { name: 'Playbook owners' });
  await owners.getByLabel(`Owners of ${after.title}`).first().getByRole('button', { name: 'Change' }).click();
  await owners.getByRole('group', { name: `Owners of ${after.title}` }).getByRole('button', { name: 'Ben Member' }).click();
  await expect(owners.getByText('Admins, Ben Member')).toBeVisible();
  await ada.context().close();

  await ben.goto(`${B}/#/playbook/nda`);
  await ben.reload();
  await ben.getByRole('button', { name: /DUR-01/ }).click();
  await ben.getByLabel('Position').fill('Two years from disclosure.');
  await ben.getByRole('button', { name: 'Save' }).click();
  await expect(ben.getByText(/^Saved · /)).toBeVisible();
  expect((await (await request.get(`${A}/api/v2/playbooks/nda`)).json()).changeCount).toBe(before.changeCount + 2);
  await ben.context().close();
});

test('the pane without a store sends no matter and no store id (tasks 8, 10); the API still runs a review without the tools', async ({ page, word, request }) => {
  // This app has no document store (off for a test data folder): the pane says nothing about the store and still reviews.
  await word.open(ORDER_V2, { counterparty: 'Daniel Osei (Northgate)' });
  await expect(page.locator('.pane__doc')).toHaveText('helix-northgate-order-form-v2-customer-markup');
  await expect(page.locator('.pane__ctx')).toHaveCount(1); // the one line under Review
  await expect(page.locator('.pane__ctx')).toHaveText('Change playbook'); // no store: no counterparty said
  await expect(page.getByRole('button', { name: 'Review without the record' })).toHaveCount(0);
  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), page.getByRole('button', { name: 'Review', exact: true }).click()]);
  const body = sent.postDataJSON();
  for (const k of ['matterId', 'round', 'agentic', 'baselineRound', 'references', 'storeDocumentId']) expect(body[k]).toBeUndefined();
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();

  // The same request with agentic: false (as the benchmark sends it) is still a review that does not use the store tools.
  const without = await request.post(`${A}/api/review`, { data: { ...body, agentic: false } });
  expect(without.ok(), await without.text()).toBe(true);
  expect((await without.json()).model?.agentic).not.toBe(true);
});
