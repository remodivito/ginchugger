// SPDX-License-Identifier: GPL-3.0-or-later
// A first start without Docker (readiness audit, 17 Oct 2026; Sample mode's removal, 17 Oct 2026): the managed store
// cannot start, so the solo app falls back to the built-in, in-memory store, and the pages' one line says so and what
// it means. Documents can still be added. This spec starts its own app on a free port with an empty PATH, so `docker`
// is not found; the shared server the other specs use is untouched.
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
  const env = { PATH: temp('gcl-empty-path-'), PORT: '0', MARGIN_STATE_DIR: temp('gcl-nodocker-'), GCL_STORE: 'managed', GCL_KEYCHAIN: 'file', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: path.join(root, 'data/recorded-runs/demo-fixture'), REVIEW_TOOLS_SUPPORTED: 'false', REVIEW_TRACE_DIR: '' };
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`the app did not start: ${out}`)), 30_000);
    const look = d => { out += d; const m = /ready at (http:\/\/localhost:\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } };
    child.stdout.on('data', look); child.stderr.on('data', look);
    child.on('exit', code => { clearTimeout(timer); reject(Error(`the app exited ${code}: ${out}`)); });
  });
});
test.afterAll(() => child?.kill());

test('without Docker the built-in store stands in: one line says so, the log says so, and a document can be added', async ({ page }) => {
  await page.goto(`${base}/#/inbox`);
  const line = page.getByRole('status').filter({ hasText: 'Document store' });
  await expect(line).toHaveText('Document store: built-in (Docker not found) · documents are kept until the app stops');
  expect(out).toMatch(/Document store: built-in, in memory \(Docker is not installed\)/);
  const name = `nodocker-${Date.now()}`;
  await page.locator('input[type=file]').setInputFiles({ name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Mutual NDA. Term: three years.') });
  await expect(page.getByRole('region', { name: 'Waiting' }).getByRole('button', { name: new RegExp(name) })).toBeVisible();
});
