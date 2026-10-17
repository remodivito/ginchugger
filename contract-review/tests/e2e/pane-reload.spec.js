// SPDX-License-Identifier: GPL-3.0-or-later
// The pane is closed or reloaded mid-review (Word does this freely). The review and the lawyer's decisions come back,
// checked against the document before they are believed; nothing about them is kept in the document itself.
import { test, expect, seedFor } from './fixtures.js';
import { installOfficeFake } from './office-fake.js';

const COUNTER = 'history/helix-brightwater-nda-v3-helix-counter.docx';
const RETENTION = 'New backup and compliance-copy retention sentence';
const ours = changes => changes.filter(c => c.author === 'Lawyer');

async function reviewAndApplyFirst(page) {
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText('0 of 5 done')).toBeVisible();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.prow--done').filter({ hasText: RETENTION })).toContainText('Applied');
}

test('the review and the lawyer’s decisions come back after the pane is reloaded', async ({ page, word }) => {
  await word.open(COUNTER);
  await reviewAndApplyFirst(page);
  await expect(page.locator('.point')).toContainText('Survival clause'); // the next open point opened
  await page.waitForTimeout(600); // the save follows each change after a moment
  await word.reload();
  await expect(page.getByText(/Review restored/)).toBeVisible();
  await expect(page.getByText('1 of 5 done')).toBeVisible();
  await expect(page.locator('.prow--done').filter({ hasText: RETENTION })).toContainText('Applied');
  await expect(page.locator('.point')).toContainText('Survival clause'); // the same point open as before
  expect(ours(await word.changes())).toHaveLength(2);
  expect(Object.keys(await word.bookmarks())).toHaveLength(1);
  expect(await word.settings()).toEqual({});
});

test('a change rejected in Word while the pane was closed reopens its point', async ({ page, word }) => {
  await word.open(COUNTER);
  await reviewAndApplyFirst(page);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__word.rejectBy('Lawyer'));
  expect(ours(await word.changes())).toEqual([]);
  await word.reload();
  await expect(page.getByText(/Review restored/)).toBeVisible();
  await expect(page.getByText('0 of 5 done')).toBeVisible();
  await expect(page.locator('.prow--done')).toHaveCount(0);
  await page.getByRole('button', { name: RETENTION }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.prow--done').filter({ hasText: RETENTION })).toContainText('Applied');
  expect(ours(await word.changes()).map(c => c.type).sort()).toEqual(['Added', 'Deleted']);
});

test('without a saved review the pane starts fresh, with Review and nothing else to set', async ({ page, word }) => {
  await word.open(COUNTER);
  await word.reload();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  await expect(page.getByText(/Review restored/)).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText('0 of 5 done')).toBeVisible();
});

test('a different document saved at the same place (so the same Word URL) opens fresh, not with the earlier review (stress audit)', async ({ page, word }, testInfo) => {
  const url = `https://contoso.sharepoint.test/Shared/Agreement.docx?test=${testInfo.testId}`;
  await word.open(COUNTER, { url });
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText('0 of 5 done')).toBeVisible();
  await page.waitForTimeout(600); // the session is saved
  // Another agreement saved over Agreement.docx: Word opens it at the same URL. (Oakfield: no other spec stores it.)
  const { imported, ...seed } = await seedFor('history/helix-oakfield-nda-v1.docx', { url });
  const other = await page.context().newPage();
  await other.addInitScript(installOfficeFake, seed);
  await other.goto('/?host=word');
  await expect(other.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  await expect(other.getByText(/Review restored/)).toHaveCount(0);
  await expect(other.locator('.points')).toHaveCount(0);
  await expect(other.locator('.pane__store')).toBeVisible(); // looked up, and added to the store as its own document
});
