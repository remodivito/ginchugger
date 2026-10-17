// SPDX-License-Identifier: GPL-3.0-or-later
// A stranger's first run (readiness audit 2, 17 Oct 2026): docs/SETUP.md followed on a computer with Node and nothing
// else. No Docker (the built-in store stands in), no Claude CLI, no key: the Review screen says in one line that no
// model is set up and where to set one up, Review itself fails in plain words that name the same place, and Settings ·
// Models shows the state of each route. This spec starts its own app on a free port with an empty PATH.
import { test, expect } from './fixtures.js';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = p => mkdtempSync(path.join(tmpdir(), p));
let child, base, out = '';

test.beforeAll(async () => {
  const env = { PATH: temp('gcl-empty-path-'), PORT: '0', MARGIN_STATE_DIR: temp('gcl-first-run-'), GCL_STORE: 'managed', GCL_KEYCHAIN: 'file', REVIEW_EXECUTOR: '', REVIEW_REPLAY_DIR: '', REVIEW_TOOLS_SUPPORTED: '', REVIEW_TRACE_DIR: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`the app did not start: ${out}`)), 30_000);
    const look = d => { out += d; const m = /ready at (http:\/\/localhost:\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } };
    child.stdout.on('data', look); child.stderr.on('data', look);
    child.on('exit', code => { clearTimeout(timer); reject(Error(`the app exited ${code}: ${out}`)); });
  });
});
test.afterAll(() => child?.kill());

test('with no model set up, the Review screen says so and points at Settings · Models; Review fails in the same plain words', async ({ page }) => {
  await page.goto(`${base}/`);
  const line = page.getByRole('status').filter({ hasText: 'No model set up yet' });
  await expect(line).toBeVisible();
  await expect(line.getByRole('link', { name: 'Settings · Models' })).toHaveAttribute('href', '#/settings/models');
  await page.locator('.start').getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText('The model could not be started on this computer. Check the review setup under Settings · Models, then review again.')).toBeVisible();
  await line.getByRole('link', { name: 'Settings · Models' }).click();
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();
  await expect(page.getByText('The claude CLI is not on PATH.').first()).toBeVisible();
  // The internals stay in the log; nothing in the page says ENOENT or spawn.
  expect(out).toMatch(/Review failed: Claude CLI could not start/);
  await expect(page.locator('body')).not.toContainText(/ENOENT|spawn/);
});

test('in the Word pane the same line names the place without a link, since the pane cannot open the app\'s pages', async ({ page, word }) => {
  await word.open('order-form/helix-northgate-order-form-v2-customer-markup.docx', { counterparty: 'Daniel Osei (Northgate)' });
  await page.goto(`${base}/?host=word`);
  await expect(page.getByRole('status').filter({ hasText: 'No model set up yet · open Settings · Models in the browser app' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings · Models' })).toHaveCount(0);
});
