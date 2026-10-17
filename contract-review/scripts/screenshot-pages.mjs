// SPDX-License-Identifier: GPL-3.0-or-later
// Portfolio screenshots of the browser pages (on the document store, decisions 190 and 191). Solo part: boots the app
// with the replay executor over the recorded demo (test infrastructure: no model call) and the in-memory store
// (GCL_STORE=fake: no Docker) on a scratch data folder, adds the
// fictional fixtures to the store through the app's own routes and labels them (counterparty, type, date, "signed",
// a note), saves one playbook edit, and runs the recorded review of Northgate's markup in the browser. Settings and About
// come from a second app set up as a person would (Claude CLI, Sonnet 5.5, in settings.json), so no shot shows the test
// executor. Team part: a team
// server whose shared mailbox is the simulated one of the tests (tests/e2e/mail-team-server.js; no real mail server)
// and whose store is the in-memory one, a lawyer's app joined to it with a setup code, a forwarded email captured into
// the team store's Inbox, and the Admin page. Each page is opened in Chromium at 1440 x 900 and saved as a PNG in
// docs/screenshots/. Fails if the browser console reports an error or a page fails to load. Every process started here
// is stopped by its PID at the end. Run `npm run build` first.
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { mailSettings, forwardedEmail, docxAttachment } from '../tests/fixtures/mail.js';
import { testTls } from '../tests/fixtures/test-tls.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// SCREENS_WIDTH and SCREENS_OUT take the same shots at another width into another folder (a responsive check).
const out = process.env.SCREENS_OUT ? path.resolve(process.env.SCREENS_OUT) : path.join(root, 'docs', 'screenshots');
const width = Number(process.env.SCREENS_WIDTH) || 1440;
const data = mkdtempSync(path.join(tmpdir(), 'gcl-screens-'));
mkdirSync(out, { recursive: true });

const procs = [], temps = [data];
const temp = p => { const d = mkdtempSync(path.join(tmpdir(), p)); temps.push(d); return d; };
function start(args, env, ready = /ready at (https?:\/\/localhost:\d+)/) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(child); let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`${args[0]} did not start: ${out}`)), 30000);
    child.stderr.on('data', d => { out += d; });
    child.stdout.on('data', d => { out += d; const m = ready.exec(out); if (m) { clearTimeout(timer); resolve([m, out]); } });
    child.on('exit', code => { clearTimeout(timer); reject(Error(`${args[0]} exited ${code}: ${out}`)); });
  });
}
const replayEnv = { REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: path.join(root, 'data/recorded-runs/demo-fixture'), REVIEW_TOOLS_SUPPORTED: 'false', REVIEW_TRACE_DIR: '' };
const [[, base]] = await start(['server/index.js'], { ...process.env, PORT: '0', MARGIN_STATE_DIR: data, GCL_ACTOR: 'P. Raman', GCL_STORE: 'fake', ...replayEnv });
console.log(`App (replay) at ${base}, PID ${procs[0].pid}, data ${data}`);
// The app as a person sets it up: no REVIEW_* variables, the model route in settings.json.
const userEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('REVIEW_') && !['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HTTPS_KEY', 'HTTPS_CERT'].includes(k)));
const userData = temp('gcl-screens-user-');
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ review: { executor: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } }));
const [[, userApp]] = await start(['server/index.js'], { ...userEnv, PORT: '0', MARGIN_STATE_DIR: userData, GCL_ACTOR: 'P. Raman', GCL_STORE: 'fake' });
const call = async (method, p, body, at = base) => { const r = await fetch(at + p, { method, headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }); if (!r.ok) throw Error(`${method} ${p}: ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.json(); };
const fixture = name => readFileSync(path.join(root, 'data/fixtures', name));
/** Add a fixture file to the store (it lands in the inbox), wait for it, then file it with its labels. */
async function addDoc(file, labels, { inbox = false, at = base } = {}) {
  const form = new FormData(); form.append('file', new Blob([fixture(file)]), path.basename(file));
  await call('POST', '/api/v2/store/documents', form, at);
  let d = null;
  for (let i = 0; i < 40 && !d; i++) { d = (await call('GET', '/api/v2/store/inbox', undefined, at)).documents.find(x => x.originalName === path.basename(file)); if (!d) await new Promise(r => setTimeout(r, 100)); }
  if (!d) throw Error(`${file} did not reach the store`);
  return inbox ? call('PATCH', `/api/v2/store/documents/${d.id}`, { ...labels, tags: [...(labels.tags || []), 'inbox'] }, at) : call('POST', `/api/v2/store/documents/${d.id}/done`, labels, at);
}

const errors = [];
try {
  // The fictional documents: two negotiations as flat documents with their labels, one signed with a note.
  const NG = 'Northgate Biosciences Ltd', BW = 'Brightwater Analytics Ltd';
  await addDoc('order-form/helix-northgate-order-form-v1.docx', { title: 'Helix / Northgate order form v1', counterparty: NG, type: 'Order form', created: '2026-05-28' });
  await addDoc('order-form/2026-06-04-northgate-returns-order-form.eml', { title: 'Northgate: our comments on the order form', counterparty: NG, type: 'Email', created: '2026-06-04' });
  await addDoc('order-form/helix-northgate-order-form-v2-customer-markup.docx', { title: 'Helix / Northgate order form v2 (their markup)', counterparty: NG, type: 'Order form', created: '2026-06-04' });
  await addDoc('history/helix-brightwater-nda-v1.docx', { title: 'Helix / Brightwater NDA v1', counterparty: BW, type: 'NDA', created: '2026-05-12' });
  await addDoc('history/helix-brightwater-nda-v2-bw-markup.docx', { title: 'Helix / Brightwater NDA v2 (their markup)', counterparty: BW, type: 'NDA', created: '2026-05-19' });
  const signed = await addDoc('history/helix-brightwater-nda-v3-helix-counter.docx', { title: 'Helix / Brightwater NDA v3 (signed)', counterparty: BW, type: 'NDA', created: '2026-05-22', tags: ['signed'] });
  await call('POST', `/api/v2/store/documents/${signed.id}/notes`, { text: 'Signed 2 June. Brightwater accepted three years and the carve-out for backups.' });
  await addDoc('history/helix-oakfield-nda-v1.docx', { title: 'helix-oakfield-nda-v1' }, { inbox: true });
  const pb = await call('GET', '/api/v2/playbooks/order-form');
  await call('PUT', '/api/v2/playbooks/order-form', { changeCount: pb.changeCount, rules: pb.rules.map((r, i) => i === 0 ? { ...r, guidance: `${r.guidance}`.trim() + ' Confirm the cap covers data-protection claims.' } : r) });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') errors.push(`${page.url()}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${page.url()}: ${e.message}`));
  const shots = [];
  async function shot(name, hash, prepare = async () => {}, at = base) {
    await page.goto(`${at}/${hash}`); await page.waitForLoadState('networkidle');
    await prepare(); await snap(name);
  }
  async function snap(name, prepare = async () => {}) {
    await prepare(); await page.waitForTimeout(250);
    const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); shots.push(path.relative(root, file));
  }
  // The recorded review of Northgate's markup, opened in the browser: the store line names its counterparty and type.
  await shot('01-review', '#/', async () => {
    await page.locator('input[type=file][accept=".docx"]').first().setInputFiles({ name: 'helix-northgate-order-form-v2-customer-markup.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: fixture('order-form/helix-northgate-order-form-v2-customer-markup.docx') });
    await page.getByRole('complementary', { name: 'Review' }).getByRole('button', { name: 'Review', exact: true }).click(); // the pane's button (at a narrow width the view switch is also "Review")
    await page.getByText(/^0 of \d+ done$/).waitFor({ timeout: 20000 });
  });
  await shot('03-library', '#/library');
  await shot('05-library-search', '#/library', async () => {
    const search = page.getByRole('search', { name: 'Search the library' });
    await search.getByLabel('Search').fill('payment terms');
    await search.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('table', { name: 'Documents' }).waitFor();
  });
  await shot('04-document', `#/documents/${signed.id}`, async () => { await page.getByRole('table', { name: 'History' }).waitFor(); });
  await shot('06-counterparty', `#/library?counterparty=${encodeURIComponent(NG)}`);
  await shot('08-playbook', '#/playbook/order-form');
  await shot('09-settings', '#/settings', undefined, userApp);
  await shot('09-settings-models', '#/settings/models', undefined, userApp);
  await shot('09-settings-benchmark', '#/settings/benchmark', async () => { await page.getByRole('button', { name: /^Opus 5\.5/ }).click(); }, userApp);
  await shot('10-about', '#/about', undefined, userApp);

  // Team mode: a team server with the simulated shared mailbox, and this lawyer's app joined to it.
  const tls = testTls();
  const serverData = temp('gcl-screens-server-');
  writeFileSync(path.join(serverData, 'settings.json'), JSON.stringify({ mode: 'server', server: { listen: '127.0.0.1:0', publicUrl: 'https://gcl.helix.example', tls: { certFile: path.join(tls, 'server.crt'), keyFile: path.join(tls, 'server.key') } }, internalDomains: ['helix.example'], ourNames: ['Helix Instruments Ltd'], mail: mailSettings(serverData) }));
  const issued = spawnSync(process.execPath, ['bin/gcl.js', '--data', serverData, 'admin', 'issue-code', '--for', 'P. Raman', '--admin'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  const code = /: ([0-9A-Z]{26})$/m.exec(issued.stdout)?.[1]; if (!code) throw Error(`No setup code: ${issued.stdout}${issued.stderr}`);
  const [[, port], teamOut] = await start(['tests/e2e/mail-team-server.js', '--data', serverData], { PATH: temp('gcl-screens-path-') }, /ready at https:\/\/[^:]+:(\d+)/);
  const control = /control (http:\/\/127\.0\.0\.1:\d+)/.exec(teamOut)[1];
  const [[, app]] = await start(['server/index.js'], { ...process.env, PORT: '0', MARGIN_STATE_DIR: temp('gcl-screens-app-'), GCL_KEYCHAIN: 'file', GCL_STORE: 'fake', ...replayEnv, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '' });
  await page.goto(`${app}/#/settings/team`);
  const join = page.getByRole('form', { name: 'Join a team' });
  await join.getByLabel('Server address').fill(`https://localhost:${port}`);
  await join.getByLabel('Setup code').fill(code);
  await join.getByLabel('Device name').fill('P. Raman’s Mac');
  await join.getByLabel('CA file').fill(path.join(tls, 'ca.crt'));
  await join.getByRole('button', { name: 'Join' }).click();
  await page.getByText('Signed in as P. Raman (admin)').waitFor();
  // The counterparty's markup arrives by email and is forwarded to the shared mailbox; it lands in the team store's Inbox.
  const raw = forwardedEmail({ subject: 'Brightwater NDA – our markup', from: 'Nkechi Okafor <nkechi@brightwater.example>', body: 'Please find our markup attached.', messageId: '<bw-markup-1@brightwater.example>', attachments: [docxAttachment('helix-brightwater-nda-v2-bw-markup.docx', fixture('history/helix-brightwater-nda-v2-bw-markup.docx'))] });
  await call('POST', '/deliver', { raw: raw.toString('base64') }, control);
  await call('POST', '/api/v2/admin/mail/check', {}, app);
  for (let i = 0; i < 60 && !(await call('GET', '/api/v2/store/inbox', undefined, app)).count; i++) await new Promise(r => setTimeout(r, 250));
  await call('POST', '/api/v2/admin/setup-codes', { forName: 'J. Okafor' }, app).catch(e => console.log(`Second code not issued: ${e.message}`));
  await shot('02-inbox', '#/inbox', async () => { const w = page.getByRole('region', { name: 'Waiting' }); await w.getByRole('button').first().click(); await page.getByRole('article').first().waitFor(); }, app);
  await shot('12-admin', '#/admin', async () => { await page.getByRole('list', { name: 'Status' }).waitFor(); }, app);

  await browser.close();
  console.log(shots.join('\n'));
  console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'Console: no errors');
} finally {
  for (const p of procs) { try { process.kill(p.pid); console.log(`Stopped PID ${p.pid}.`); } catch { /* already gone */ } }
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
if (errors.length) process.exit(1);
