// SPDX-License-Identifier: GPL-3.0-or-later
// Browser tests of the Word pane (tests/e2e). The pane is the production build, served by the real server on its own
// port with its own empty state folder; Word is the in-page fake in tests/e2e/office-fake.js; the model is the recorded
// demo run (REVIEW_EXECUTOR=replay, the single call: test infrastructure, not a mode for users), so nothing here needs a login, a key or Word.
import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// E2E_PORT_OFFSET moves every fixed port the specs use (this one, and the team, mail and permissions specs' apps), so
// two checkouts can run the suite side by side.
const PORT = 3197 + Number(process.env.E2E_PORT_OFFSET || 0);
const state = mkdtempSync(path.join(tmpdir(), 'margin-e2e-'));

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.spec.js',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 380, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 380, height: 900 } } }],
  webServer: {
    command: 'npx vite build --logLevel error && node server/index.js',
    url: `http://localhost:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(PORT), MARGIN_STATE_DIR: state, GCL_KEYCHAIN: 'file', REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: path.resolve('data/recorded-runs/demo-fixture'), REVIEW_TOOLS_SUPPORTED: 'false', REVIEW_TRACE_DIR: '', GCL_STORE: 'fake' },
  },
});
