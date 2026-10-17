// SPDX-License-Identifier: GPL-3.0-or-later
// The browser pages (product v2, slice S6; PR-PAGE-01, 02), end to end on the real server (replay executor, started by
// playwright.config.js) at a laptop
// width: hash-route navigation to every page, a playbook edit recorded with who and when, and the settings page. The
// matter timeline, counterparty, register and search pages went with decision 190 (the store's pages are in
// store.spec.js). Each test makes its own playbook where it writes.
import { test, expect } from '@playwright/test';
import { userInfo } from 'node:os';

test.use({ viewport: { width: 1280, height: 800 } });
const me = userInfo().username;
const json = async r => { expect(r.ok(), await r.text()).toBe(true); return r.json(); };
const watchConsole = page => { const errors = []; page.on('console', m => m.type() === 'error' && errors.push(m.text())); page.on('pageerror', e => errors.push(e.message)); return errors; };

test('every page is reached by its hash route from the top bar, with no console errors', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/#/library');
  const nav = page.getByRole('navigation', { name: 'Application' });
  for (const [link, heading, hash] of [['Inbox', 'Inbox', '#/inbox'], ['Library', 'Library', '#/library'], ['Playbook', null, '#/playbook'], ['Trash', 'Trash', '#/trash'], ['Settings', 'Settings', '#/settings'], ['Activity', 'Activity', '#/activity'], ['Admin', 'Admin', '#/admin'], ['About', 'About', '#/about']]) {
    await nav.getByRole('link', { name: new RegExp(`^${link}`) }).click();
    await expect(page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`));
    await expect(nav.getByRole('link', { name: new RegExp(`^${link}`) })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, ...(heading ? { name: heading } : {}) })).toBeVisible();
  }
  for (const gone of ['Matters', 'Register', 'Search']) await expect(nav.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Review' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('complementary', { name: 'Review' })).toBeVisible();
  await expect(page.locator('.pane__mark')).toBeHidden(); // the sidebar carries the wordmark in the browser (UX audit)
  // A page opened directly by its address renders on its own (the pane links to them).
  await page.goto('/#/playbook/order-form');
  await expect(page.getByRole('heading', { level: 1, name: 'Order forms (demonstration)' })).toBeVisible();
  await page.goto('/#/library?counterparty=Northgate%20Biosciences%20Ltd');
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an entry saved on the Playbook page is recorded with who, when and which entry; removing one is recorded too', async ({ page, request }) => {
  const made = await json(await request.post('/api/v2/playbooks', { data: { title: `E2E playbook ${Date.now()}`, draft: { rules: [{ id: 'E-01', title: 'Notice period', guidance: 'Thirty days.' }, { id: 'E-02', title: 'Governing law', guidance: 'England and Wales.' }] } } }));
  await page.goto(`/#/playbook/${made.id}`);
  await expect(page.getByRole('heading', { level: 1, name: made.title })).toBeVisible();
  await expect(page.getByTestId('last-change')).toHaveText(new RegExp(`^Change 1 · Last changed by ${me} on .* · Playbook created$`));
  await page.getByRole('button', { name: /Notice period/ }).click();
  await page.getByLabel('Position').fill('Sixty days, never less than thirty.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/^Saved · /);
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  await expect(page.getByTestId('last-change')).toHaveText(`Change 2 · Last changed by ${me} on ${today} · E-01 edited`);
  const after = (await json(await request.get('/api/v2/playbooks'))).find(p => p.id === made.id);
  expect([after.changeCount, after.updatedBy, after.lastChange]).toEqual([2, me, { ruleId: 'E-01', kind: 'edited' }]);
  expect(Date.now() - Date.parse(after.updatedAt)).toBeLessThan(60_000);
  expect((await json(await request.get(`/api/v2/playbooks/${made.id}`))).rules.find(r => r.id === 'E-01').guidance).toBe('Sixty days, never less than thirty.');

  await page.getByRole('button', { name: /Governing law/ }).click();
  await page.getByRole('button', { name: 'Remove entry' }).click();
  await expect(page.getByTestId('last-change')).toHaveText(`Change 3 · Last changed by ${me} on ${today} · E-02 removed`);
  await expect(page.getByRole('button', { name: /Governing law/ })).toHaveCount(0);
});

test('settings show the setup the environment fixes, how each model is reached, the tool check and each setup\'s benchmark profile; there is no record switch', async ({ page, request }) => {
  await page.goto('/#/settings');
  const cats = page.getByRole('navigation', { name: 'Settings categories' });
  await expect(cats.getByRole('link', { name: /Reviewing/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Model in use' })).toContainText('Recorded runs (test)');
  await expect(page.getByRole('region', { name: 'Playbooks' }).getByRole('link', { name: 'Open' }).first()).toHaveAttribute('href', /^#\/playbook\//);
  await cats.getByRole('link', { name: /Models/ }).click();
  await expect(page).toHaveURL(/#\/settings\/models$/);
  await expect(page.getByText('Set by REVIEW_EXECUTOR in the environment')).toBeVisible();
  const executors = page.getByRole('radiogroup', { name: 'Executor' }).getByRole('radio');
  expect(await executors.evaluateAll(els => els.map(e => e.getAttribute('aria-label')))).toEqual(['Claude CLI', 'Anthropic API', 'OpenAI-compatible', 'Recorded runs (test)']);
  await expect(page.getByRole('radio', { name: 'Recorded runs (test)' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Recorded runs (test)' })).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Claude CLI' })).toContainText('Claude subscription · the Claude CLI on this computer');
  await expect(page.getByRole('radio', { name: 'Anthropic API' })).toContainText('Anthropic API key');
  const connections = page.getByRole('region', { name: 'Connections' });
  await expect(connections.getByLabel('Anthropic API key')).toContainText('Not set');
  await expect(connections.getByLabel('OpenAI-compatible key (Munito)')).toContainText('Not set');
  await expect(page.getByText('Read the record during review')).toHaveCount(0); // reading the record is always on
  await cats.getByRole('link', { name: /GinBench/ }).click();
  await expect(page.getByText('Recorded runs (test): Not benchmarked')).toBeVisible();
  const bench = page.getByRole('region', { name: 'GinBench' });
  await bench.getByRole('button', { name: /^Opus 5\.5/ }).click();
  await expect(bench.getByText('Planted deviations', { exact: true })).toBeVisible();
  await expect(bench.getByText('0.995 ±0.009')).toBeVisible();
  await expect(bench.getByText('0 of 122 reviews')).toBeVisible();
  await expect(bench.getByText(/results-ledger\.md R20, R22/)).toBeVisible();
  await page.goto('/#/settings/models');
  await expect(page.getByRole('region', { name: 'Tool check' }).getByText('Not used: single call')).toBeVisible();

  // The settings API still takes review.agentic (the benchmark and older settings files); the page only reports it.
  expect((await request.put('/api/v2/local/settings', { data: { review: { agentic: false } } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Tool check' }).getByText('Off', { exact: true })).toBeVisible();
  expect((await request.put('/api/v2/local/settings', { data: { review: { agentic: true } } })).ok()).toBe(true);
  expect((await json(await request.get('/api/v2/local/settings'))).review.agentic).toBe(true);
});


test('a record signing key the keychain refuses says why on the Reviewing panel', async ({ page }) => {
  // Walkthrough 17 Oct: the refusal was set but only the Models panel showed key errors, so Save did nothing visible here.
  await page.goto('/#/settings/reviewing');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('textbox', { name: 'Record signing key' }).fill('not-hex');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('64 hex characters');
});

test('the Playbook page header is the title, then one line (what it applies to, the last change) and a quiet Switch playbook', async ({ page }) => {
  // UX taste call 2 (17 Oct 2026): no "Playbook" dropdown repeating the title, no stack of context lines.
  await page.goto('/#/playbook/order-form');
  await expect(page.getByRole('heading', { level: 1, name: 'Order forms (demonstration)' })).toBeVisible();
  const line = page.locator('.pagehead__line');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('For Customer order forms on our paper');
  await expect(line.getByTestId('last-change')).toHaveText(/^Change \d+ · Last changed/);
  await expect(page.getByText(/^Applies to /)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Playbook', exact: true })).toHaveCount(0);
  const change = page.getByRole('combobox', { name: 'Switch playbook' });
  await expect(change).toHaveCount(1);
  await expect(change.locator('option', { hasText: 'Order forms (demonstration)' })).toHaveCount(0); // only the others
  await change.selectOption({ label: 'NDAs (demonstration)' });
  await expect(page).toHaveURL(/#\/playbook\/nda$/);
  await expect(page.getByRole('heading', { level: 1, name: 'NDAs (demonstration)' })).toBeVisible();
});

test.describe('at a phone width (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the review\'s view switch says Document / Points, not a fourth "Review"; the sideways nav fades at its edge until scrolled to the end', async ({ page }) => {
    // UX taste call 4 (17 Oct 2026).
    await page.goto('/#/');
    const view = page.getByRole('group', { name: 'View' });
    await expect(view.getByRole('button')).toHaveText(['Document', 'Points']);
    await expect(view.getByRole('button', { name: 'Points' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('complementary', { name: 'Review' }).getByRole('button', { name: 'Review', exact: true })).toBeVisible();
    await view.getByRole('button', { name: 'Document' }).click();
    await expect(page.getByRole('region', { name: 'Agreement' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Review' })).toBeHidden();
    const side = page.getByRole('navigation', { name: 'Application' });
    await expect(side).toHaveAttribute('data-more', 'true');
    const fade = () => side.evaluate(el => getComputedStyle(el, '::after').opacity);
    expect(await fade()).toBe('1');
    await side.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect(side).toHaveAttribute('data-more', 'false');
    await expect.poll(fade).toBe('0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test('the Library\'s filters fold behind one Filters button that counts the filters in use', async ({ page }) => {
    // UX taste call 5 (17 Oct 2026).
    await page.goto('/#/library');
    const filters = page.getByRole('group', { name: 'Filters' });
    const toggle = page.getByRole('button', { name: /^Filters/ });
    await expect(toggle).toHaveText('Filters');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(filters).toBeHidden();
    await expect(page.getByRole('region', { name: 'Documents' })).toBeInViewport();
    await toggle.click();
    await expect(filters).toBeVisible();
    await filters.getByLabel('From').fill('2020-01-01');
    await toggle.click();
    await expect(filters).toBeHidden();
    await expect(toggle).toHaveText('Filters1');
    await expect(toggle).toHaveAccessibleName('Filters, 1 in use');
  });
});

test('on a laptop the view switch, the nav fade and the Filters button do not show; the filters do', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('group', { name: 'View' })).toBeHidden();
  const side = page.getByRole('navigation', { name: 'Application' });
  expect(await side.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
  await page.goto('/#/library');
  await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
  await expect(page.getByRole('group', { name: 'Filters' })).toBeVisible();
});
