// SPDX-License-Identifier: GPL-3.0-or-later
// The store's screens end to end (tasks/paperless-store-plan.md tasks 4–7; solo mode, laptop width), on the in-memory
// store (GCL_STORE=fake in playwright.config.js), so no Docker is needed: the navigation, the Inbox (an upload lands in
// it, labels checked, Done, a duplicate flagged, Not a contract), the Library (filter, full-text search with the words
// highlighted, opened filtered to a counterparty by address), the document page (labels saved, notes added and deleted,
// history, signed documents kept out of the trash with the reason) and the Trash (restore).
import { test, expect } from '@playwright/test';
import { userInfo } from 'node:os';

test.use({ viewport: { width: 1280, height: 900 } });
const me = userInfo().username;
const json = async r => { expect(r.ok(), await r.text()).toBe(true); return r.json(); };
const watchConsole = page => { const errors = []; page.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text())); page.on('pageerror', e => errors.push(e.message)); return errors; };

/** A document in the store with its labels, filed (out of the inbox) unless `inbox`. */
async function addDoc(request, name, text, labels = {}, { inbox = false } = {}) {
  await json(await request.post('/api/v2/store/documents', { multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(text) } } }));
  const found = await json(await request.get(`/api/v2/store/documents?${new URLSearchParams({ q: text.split(' ').slice(0, 3).join(' ') })}`));
  const d = found.results.find(x => x.originalName === name);
  if (!inbox) return json(await request.post(`/api/v2/store/documents/${d.id}/done`, { data: labels }));
  return Object.keys(labels).length ? json(await request.patch(`/api/v2/store/documents/${d.id}`, { data: { ...labels, tags: [...(labels.tags || []), 'inbox'] } })) : d;
}

test('navigation: Library replaces Matters, Register and Search; the record\'s old addresses open the review (decision 190)', async ({ page }) => {
  await page.goto('/#/library');
  const nav = page.getByRole('navigation', { name: 'Application' });
  await expect(nav.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  for (const gone of ['Matters', 'Register', 'Search']) await expect(nav.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
  for (const old of ['#/matters', '#/register', '#/search', '#/record-inbox', '#/counterparties/x']) {
    await page.goto(`/${old}`);
    await expect(page.getByRole('complementary', { name: 'Review' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Matters' })).toHaveCount(0);
  }
});

test('inbox: an upload lands in the inbox; labels are checked and Done files it; a duplicate is flagged; Not a contract moves it to the trash', async ({ page, request }) => {
  const errors = watchConsole(page);
  const stamp = Date.now();
  const name = `nda-${stamp}.txt`;
  await page.goto('/#/inbox');
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`Mutual NDA ${stamp}. Term: three years.`) });
  const list = page.getByRole('region', { name: 'Waiting' });
  await expect(list.getByRole('button', { name: new RegExp(`nda-${stamp}`) })).toBeVisible();
  await list.getByRole('button', { name: new RegExp(`nda-${stamp}`) }).click();
  const detail = page.getByRole('article', { name: `nda-${stamp}` });
  await expect(detail.getByRole('group', { name: 'Labels' })).toBeVisible();
  await expect(detail.getByText(/Already in the library|this is new/)).toHaveCount(0); // a new document has no duplicate row (UX taste call 3)
  const labels = detail.getByRole('group', { name: 'Labels' });
  await labels.getByLabel('Title').fill(`Corrigan NDA ${stamp}`);
  await labels.getByLabel('Counterparty').fill(`Corrigan ${stamp}`);
  await labels.getByLabel('Type').fill('NDA');
  await labels.getByLabel('Date').fill('2026-05-01');
  await labels.getByLabel('Add tag').fill('urgent');
  await labels.getByLabel('Add tag').press('Enter');
  await expect(labels.getByText('urgent')).toBeVisible();
  await detail.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Corrigan NDA ${stamp} filed` })).toBeVisible();
  await expect(list.getByRole('button', { name: new RegExp(`Corrigan NDA ${stamp}`) })).toHaveCount(0);
  const filed = (await json(await request.get(`/api/v2/store/documents?counterparty=${encodeURIComponent(`Corrigan ${stamp}`)}`))).results;
  expect(filed.map(d => [d.title, d.type, d.created, d.tags, d.inbox])).toEqual([[`Corrigan NDA ${stamp}`, 'NDA', '2026-05-01', ['urgent'], false]]);

  // The same bytes again: flagged, with a link to the one already filed; then Not a contract.
  await page.locator('input[type=file]').setInputFiles({ name: `copy-${stamp}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Mutual NDA ${stamp}. Term: three years.`) });
  const copy = list.getByRole('button', { name: new RegExp(`copy-${stamp}`) });
  await expect(copy).toContainText('Duplicate');
  await copy.click();
  const copyDetail = page.getByRole('article', { name: `copy-${stamp}` });
  await expect(copyDetail.getByText('Already in the library?')).toBeVisible();
  await expect(copyDetail.getByText(/^Same file as/)).toBeVisible();
  await expect(copyDetail.getByRole('link', { name: `Corrigan NDA ${stamp}` })).toHaveAttribute('href', `#/documents/${filed[0].id}`);
  await copyDetail.getByRole('button', { name: 'Not a contract' }).click();
  await expect(page.getByRole('status').filter({ hasText: `copy-${stamp} moved to the trash` })).toBeVisible();
  await expect(copy).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('inbox: a signed document cannot be sent to the trash, and says why', async ({ page, request }) => {
  const stamp = Date.now();
  await addDoc(request, `signed-${stamp}.txt`, `Executed order form ${stamp}.`, { tags: ['signed'] }, { inbox: true });
  await page.goto('/#/inbox');
  await page.getByRole('region', { name: 'Waiting' }).getByRole('button', { name: new RegExp(`signed-${stamp}`) }).click();
  const detail = page.getByRole('article', { name: `signed-${stamp}` });
  await expect(detail.getByRole('button', { name: 'Not a contract' })).toBeDisabled();
  await expect(detail.getByText('Signed: kept out of the trash')).toBeVisible();
  await detail.getByRole('button', { name: 'Done' }).click();
});

test('library: filters by counterparty, searches the text with the words highlighted; opens filtered to a counterparty by address', async ({ page, request }) => {
  const errors = watchConsole(page);
  const stamp = Date.now();
  const north = `Northgate ${stamp}`;
  await addDoc(request, `of-v1-${stamp}.txt`, `Order form ${stamp}. Payment within 30 days of invoice.`, { counterparty: north, type: 'Order form', created: '2025-03-12', title: `Order form v1 ${stamp}` });
  await addDoc(request, `of-v2-${stamp}.txt`, `Order form markup ${stamp}. Payment within 60 days of invoice.`, { counterparty: north, type: 'Order form', created: '2026-06-01', title: `Order form v2 ${stamp}` });
  await addDoc(request, `nda-${stamp}.txt`, `Mutual NDA ${stamp}. Term three years.`, { counterparty: `Corrigan ${stamp}`, type: 'NDA', created: '2026-02-01', title: `NDA ${stamp}` });

  await page.goto('/#/library');
  await page.getByLabel('Counterparty').selectOption(north);
  const docs = page.getByRole('table', { name: 'Documents' });
  await expect(docs.getByRole('row').filter({ hasText: String(stamp) })).toHaveCount(2);
  await expect(docs.getByRole('row').nth(1)).toHaveAccessibleName(`Order form v2 ${stamp}`, { timeout: 5000 });

  await page.getByRole('search').getByLabel('Search').fill(`payment ${stamp}`);
  await page.getByRole('search').getByRole('button', { name: 'Search' }).click();
  await expect(page.getByLabel('Sort')).toHaveValue('relevance');
  const hit = docs.getByRole('row', { name: `Order form v1 ${stamp}` });
  await expect(hit.locator('mark').filter({ hasText: /^Payment$/ })).toBeVisible();
  await expect(hit).toContainText('within 30 days of invoice');

  // #/library?counterparty=<name> opens the Library filtered to that counterparty.
  await page.goto(`/#/library?counterparty=${encodeURIComponent(north)}`);
  await expect(page.getByLabel('Counterparty')).toHaveValue(north);
  await expect(docs.getByRole('row').filter({ hasText: String(stamp) })).toHaveCount(2);
  await docs.getByRole('link', { name: `Order form v2 ${stamp}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Order form v2 ${stamp}` })).toBeVisible();
  expect(errors).toEqual([]);
});

test('document page: labels saved, a note added and deleted, history in plain words; signed stays out of the trash', async ({ page, request }) => {
  const errors = watchConsole(page);
  const stamp = Date.now();
  const d = await addDoc(request, `msa-${stamp}.txt`, `Master services agreement ${stamp}. Liability cap 1m.`, { counterparty: `Velantis ${stamp}`, type: 'MSA', created: '2026-04-01', title: `MSA ${stamp}` });
  await page.goto(`/#/documents/${d.id}`);
  await expect(page.getByRole('heading', { level: 1, name: `MSA ${stamp}` })).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: 'Document actions' });
  await expect(toolbar.getByRole('link', { name: 'Download original' })).toHaveAttribute('href', `/api/v2/store/documents/${d.id}/original`);
  await expect(toolbar.getByRole('link', { name: 'Open in Word' })).toHaveCount(0); // it downloaded the same file (UX audit)
  // The in-memory store makes no PDF preview: the page shows our own text of the original instead of an empty frame.
  await expect(page.getByLabel(`Text of MSA ${stamp}`)).toContainText(`Master services agreement ${stamp}.`);

  const labels = page.getByRole('region', { name: 'Labels' });
  await labels.getByLabel('Type').fill('Master services agreement');
  await labels.getByLabel('Add tag').fill('signed');
  await labels.getByLabel('Add tag').press('Enter');
  await labels.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Labels saved' })).toBeVisible();
  await expect(labels.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Move to trash' })).toBeDisabled();
  await expect(toolbar.getByText('Signed: kept out of the trash')).toBeVisible();

  const notes = page.getByRole('region', { name: 'Notes' });
  await notes.getByRole('textbox', { name: 'Note' }).fill('Cap agreed at 1m on the call.');
  await notes.getByRole('button', { name: 'Add note' }).click();
  const note = notes.getByLabel(`Note by ${me}`);
  await expect(note).toContainText('Cap agreed at 1m on the call.');
  const history = page.getByRole('table', { name: 'History' });
  await expect(history.getByRole('row').first()).toContainText('Added a note');
  await expect(history).toContainText('Type set to Master services agreement; Tagged signed');
  // A note goes for good, so Delete asks once more; Cancel keeps it.
  await note.getByRole('button', { name: 'Delete' }).click();
  await note.getByRole('button', { name: 'Cancel' }).click();
  await expect(note).toContainText('Cap agreed at 1m on the call.');
  await note.getByRole('button', { name: 'Delete' }).click();
  await note.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(notes.getByLabel(`Note by ${me}`)).toHaveCount(0);
  await expect(history.getByRole('row').first()).toContainText('Deleted a note');
  await expect(history.getByRole('row').first()).toContainText(me);
  expect(errors).toEqual([]);
});

test('trash: a document moved to the trash from its page comes back with Restore', async ({ page, request }) => {
  const stamp = Date.now();
  const d = await addDoc(request, `old-${stamp}.txt`, `Superseded draft ${stamp}.`, { title: `Draft ${stamp}`, counterparty: `Corrigan ${stamp}` });
  await page.goto(`/#/documents/${d.id}`);
  await page.getByRole('toolbar', { name: 'Document actions' }).getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Draft ${stamp} moved to the trash` })).toBeVisible();
  await expect(page).toHaveURL(/#\/library$/);

  await page.getByRole('navigation', { name: 'Application' }).getByRole('link', { name: 'Trash' }).click();
  const row = page.getByRole('row', { name: `Draft ${stamp}` });
  await expect(row).toContainText(`Corrigan ${stamp}`);
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Draft ${stamp} restored` })).toBeVisible();
  await expect(page.getByRole('row', { name: `Draft ${stamp}` })).toHaveCount(0);
  expect((await json(await request.get(`/api/v2/store/documents/${d.id}`))).title).toBe(`Draft ${stamp}`);
});

test('activity: recent changes across documents, naming the document and the person', async ({ page, request }) => {
  const stamp = Date.now();
  const d = await addDoc(request, `act-${stamp}.txt`, `Activity check ${stamp}.`, { title: `Activity ${stamp}` });
  await json(await request.post(`/api/v2/store/documents/${d.id}/notes`, { data: { text: 'Checked.' } }));
  await page.goto('/#/activity');
  await expect(page.getByText(/^From the \d+ most recently changed documents$/)).toBeVisible();
  const row = page.getByRole('table', { name: 'Changes' }).getByRole('row').filter({ hasText: `Activity ${stamp}` }).first();
  await expect(row).toContainText('Added a note');
  await expect(row).toContainText(me);
  await expect(row.getByRole('link', { name: `Activity ${stamp}` })).toHaveAttribute('href', `#/documents/${d.id}`);
});
