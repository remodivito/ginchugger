// SPDX-License-Identifier: GPL-3.0-or-later
// The Word pane end to end: the production build in a real browser, the real server, the recorded demo review, and the
// Office.js fake standing in for Word. What is asserted is what Word would hold afterwards. Since decision 184 the pane
// has one job: Review, then Apply or Dismiss each point, worst first; plus "Ask about this draft".
import { test, expect } from './fixtures.js';

const COUNTER = 'history/helix-brightwater-nda-v3-helix-counter.docx';
const theirs = changes => changes.filter(c => c.author === 'Counterparty');
const ours = changes => changes.filter(c => c.author === 'Lawyer');
const RETENTION = 'New backup and compliance-copy retention sentence';
const done = (page, name) => page.locator('.prow--done').filter({ hasText: name });

async function review(page) {
  await page.getByRole('button', { name: 'Review', exact: true }).click(); // the playbook is inferred from the document
  await expect(page.getByText('0 of 5 done')).toBeVisible();
}

test('reads the open document, reviews it with one button and marks the first (worst) point in Word', async ({ page, word }) => {
  await word.open(COUNTER);
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), review(page)]);
  expect(sent.postDataJSON().playbookId).toBe('nda'); // "nda" in the document's name; no picker
  const rows = page.getByRole('list', { name: 'Points' }).getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText(RETENTION); // worst first, and open
  await expect(rows.first().getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await expect.poll(() => word.highlighted()).toEqual([expect.stringContaining('routine backup systems')]);
  expect(ours(await word.changes())).toEqual([]);
});

test('the pane has none of the controls decision 184 removed', async ({ page, word }) => {
  await word.open(COUNTER);
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  // 'Change playbook' came back once, on the line under Review before a review (audit finding 2); it is checked below.
  const gone = ['Record', 'Record this round', 'Export record', 'Add to playbook', 'Reword', 'Mark reviewed', 'Copy wording', 'New review', 'Review again', 'Close', 'Next point', 'Previous point'];
  const check = async () => {
    for (const name of gone) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox')).toHaveCount(0); // no playbook picker
    await expect(page.getByRole('button', { name: /^(Inbox|Round summary|Also noticed|Positions|Sources|Last time|Activity|This review)/ })).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(1); // the ask field only: no instruction, no dismiss note
    await expect(page.getByRole('textbox', { name: 'Ask about this draft' })).toBeVisible();
  };
  await check();
  await expect(page.locator('.pane__book')).toContainText('Playbook · NDA'); // inferred from the document's name, and said
  await expect(page.getByRole('button', { name: 'Change playbook', exact: true })).toBeVisible();
  await review(page);
  await check();
  await expect(page.getByRole('button', { name: 'Change playbook', exact: true })).toHaveCount(0);
  // Dismiss asks why in one tap, with no note field (audit finding 1).
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Not an issue' }).click();
  await expect(done(page, RETENTION)).toContainText('Not an issue');
  await check();
});

test('Apply makes the lawyer’s tracked change, anchors it with a hidden bookmark and writes nothing into the document’s settings', async ({ page, word }) => {
  await word.open(COUNTER);
  const before = theirs(await word.changes());
  await review(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(done(page, RETENTION)).toContainText('Applied');
  const after = await word.changes();
  expect(theirs(after)).toEqual(before);
  expect(ours(after).map(c => c.type).sort()).toEqual(['Added', 'Deleted']);
  expect(ours(after).find(c => c.type === 'Added').text).toContain('for so long as they are retained');
  expect((await word.texts()).some(t => t.includes('for so long as they are retained'))).toBe(true);
  const names = Object.keys(await word.bookmarks());
  expect(names).toHaveLength(1); expect(names[0]).toMatch(/^_m_[a-z0-9]+$/);
  expect(await word.settings()).toEqual({});
  expect((await word.log()).filter(e => e.op === 'mode').map(e => e.mode)).toEqual(['TrackAll', 'Off']);
});

test('the header counts the points done; a done point is greyed and struck through with what happened, and has Undo', async ({ page, word }) => {
  await word.open(COUNTER);
  await review(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('1 of 5 done')).toBeVisible();
  // The next open point opened by itself.
  const open = page.locator('.point');
  await expect(open).toContainText('Survival clause uses undefined');
  await open.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await open.getByRole('button', { name: 'Accept their wording' }).click();
  await expect(page.getByText('2 of 5 done')).toBeVisible();

  const applied = done(page, RETENTION), dismissed = page.locator('.prow--done').filter({ hasText: 'Accepted' });
  await expect(applied).toContainText('Applied');
  await expect(dismissed).toHaveCount(1);
  for (const row of [applied, dismissed]) {
    await expect(row.locator('.prow__title')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(row).toHaveCSS('color', 'rgb(142, 142, 147)');
  }
  await expect(applied.getByRole('button', { name: 'Undo' })).toHaveCount(1); // since 17 Oct 2026 the pane rejects its own change in Word
  await dismissed.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('1 of 5 done')).toBeVisible();
  await expect(page.locator('.point')).toContainText('Survival clause uses undefined'); // the point is open again

  for (let left = 4; left > 0; left--) { // the rest: each decision opens the next open point
    if (!(await page.locator('.point').count())) await page.locator('button.prow').first().click();
    await page.locator('.point').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.locator('.point').getByRole('button', { name: 'Not an issue' }).click();
    await expect(page.getByText(`${5 - left + 1} of 5 done`)).toBeVisible();
  }
  await expect(page.getByText('5 of 5 done')).toBeVisible();
  await expect(page.locator('.point')).toHaveCount(0);
  await expect.poll(() => word.highlighted()).toEqual([]); // nothing open, nothing marked
});

test('a finished point opens again to read: what was applied, or why it was dismissed, the passage and Undo; one at a time', async ({ page, word }) => {
  await word.open(COUNTER);
  await review(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.locator('.point').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.locator('.point').getByRole('button', { name: 'Not an issue' }).click();
  await expect(page.getByText('2 of 5 done')).toBeVisible();

  const applied = done(page, RETENTION), dismissed = page.locator('.prow--done').filter({ hasText: 'Not an issue' });
  const toggle = row => row.getByRole('button', { name: /Applied|Not an issue/ });
  await expect(toggle(applied)).toHaveAttribute('aria-expanded', 'false');
  await toggle(applied).click();
  await expect(toggle(applied)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.point')).toHaveCount(0); // the open point closed: one card at a time
  const card = applied.locator('.finished');
  await expect(card.locator('.point__why')).not.toBeEmpty();
  await expect(card.locator('.point__box ins')).toContainText('retained'); // the wording applied, drawn in as on the open card
  await expect(card.locator('.quote--s')).toContainText('routine backup systems');
  await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await card.getByRole('button', { name: 'Show in document' }).click();
  await expect.poll(async () => (await word.highlighted()).join(' ')).toContain('retained');

  await toggle(dismissed).focus(); await page.keyboard.press('Enter'); // keyboard: the row is a button
  await expect(toggle(dismissed)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(applied)).toHaveAttribute('aria-expanded', 'false'); // opening another row closes the first
  await expect(dismissed.locator('.prow__state')).toHaveText('Not an issue'); // why it was dismissed is said on the row, once
  await expect(dismissed.locator('.finished')).not.toContainText('Not an issue');
  await expect(dismissed.locator('.finished .point__box')).toHaveCount(0);
  await toggle(dismissed).click();
  await expect(page.locator('.finished')).toHaveCount(0);
});

test('Undo on an applied point rejects the pane’s own tracked changes in Word, restores the clause and opens the point again', async ({ page, word }) => {
  await word.open(COUNTER);
  const original = (await word.texts())[12], before = theirs(await word.changes());
  await review(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(done(page, RETENTION)).toContainText('Applied');
  expect((await word.texts())[12]).not.toBe(original);
  const row = done(page, RETENTION);
  await row.getByRole('button', { name: 'Applied' }).click();
  await row.locator('.finished').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('0 of 5 done')).toBeVisible();
  expect((await word.texts())[12]).toBe(original);
  expect(ours(await word.changes())).toEqual([]);
  expect(theirs(await word.changes())).toEqual(before);
  expect(await word.bookmarks()).toEqual({});
  expect((await word.log()).filter(e => e.op === 'reject').map(e => e.type).sort()).toEqual(['Added', 'Deleted']);
  const open = page.locator('.point');
  await expect(open).toContainText(RETENTION); // open again, with Apply offered
  await expect(open.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Document changed')).toHaveCount(0);
});

test('Undo refuses a change edited in Word by hand: the point stays applied and the message says to undo it there', async ({ page, word }) => {
  await word.open(COUNTER);
  await review(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const row = done(page, RETENTION);
  await expect(row).toContainText('Applied');
  await page.evaluate(() => window.__word.typeInto(12, 'for so long as', 'while'));
  const mine = ours(await word.changes());
  await row.getByRole('button', { name: 'Undo' }).click();
  await expect(row.getByRole('alert')).toHaveText('This change was edited in Word. Undo it there.');
  await expect(row).toContainText('Applied');
  await expect(page.getByText('1 of 5 done')).toBeVisible();
  expect(ours(await word.changes())).toEqual(mine);
});

test('stepping quickly through the points leaves exactly one passage highlighted: the last one asked for', async ({ page, word }) => {
  await word.open(COUNTER);
  await review(page);
  const first = (await word.highlighted())[0];
  const rows = page.locator('button.prow');
  await rows.nth(2).click(); await rows.nth(0).click(); await rows.nth(3).click();
  await expect(page.locator('.point')).toHaveCount(1);
  await expect.poll(async () => (await word.highlighted()).length).toBe(1);
  expect((await word.highlighted())[0]).not.toBe(first);
});

test('a clause edited in Word after the review is not touched: Apply refuses and says why', async ({ page, word }) => {
  await word.open(COUNTER);
  await review(page);
  await page.evaluate(() => window.__word.typeInto(12, 'routine backup systems', 'daily backup systems'));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/could not be located|has changed/);
  await expect(page.getByText('0 of 5 done')).toBeVisible();
  expect(ours(await word.changes()).filter(c => c.text.includes('retained'))).toEqual([]);
  expect(Object.keys(await word.bookmarks())).toEqual([]);
  // The change is noticed as one line with the only Review again.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const line = page.getByRole('status').filter({ hasText: 'Document changed' });
  await expect(line).toBeVisible();
  await expect(line.getByRole('button')).toHaveText(['Review again']);
});

test('Ask from the pane: the question goes with the document, Ask opens, and a cited passage is shown in Word', async ({ page, word }) => {
  await word.open(COUNTER);
  await review(page);
  const field = page.getByRole('textbox', { name: 'Ask about this draft' });
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await field.fill('Does anything else bear on the residuals sentence?');
  const [sent] = await Promise.all([page.waitForRequest('**/api/ask'), page.getByRole('button', { name: 'Ask', exact: true }).click()]);
  expect(sent.postDataJSON()).toMatchObject({ question: 'Does anything else bear on the residuals sentence?', playbookId: 'nda', stream: true });
  await expect(page.getByRole('tab', { name: 'Ask' })).toHaveAttribute('aria-selected', 'true'); // asking from Review opens Ask
  const entry = page.getByRole('article', { name: 'Does anything else bear on the residuals sentence?' });
  await expect(entry.locator('.qa__a')).toContainText('residuals');
  await entry.getByRole('button', { name: /^\d+ sources?$/ }).click();
  await expect(entry.getByRole('list', { name: 'Sources' }).getByRole('listitem').first()).toContainText('¶');
  await entry.getByRole('button', { name: 'Show in document' }).first().click(); // a cited passage is marked in Word
  await expect.poll(async () => (await word.highlighted()).length).toBe(1);
});

test('a proposal to delete a clause is offered with Apply and lands as one tracked deletion by the lawyer', async ({ page, word }) => {
  // The recorded demo has no deletion, so the review response is turned into one: the first point proposes deleting its clause.
  await page.route('**/api/review', async route => {
    const json = await (await route.fetch()).json();
    const f = json.findings.find(x => x.title.startsWith('New backup'));
    Object.assign(f, { decision: 'reject', proposedText: '', suggestedText: '', proposalStatus: 'ok', deletion: true }); delete f.options;
    await route.fulfill({ json });
  });
  await word.open(COUNTER);
  const clause = (await word.texts())[12];
  await review(page);
  await expect(page.locator('.point__box del')).toHaveText(clause.trim()); // the whole clause struck in the box
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(done(page, RETENTION)).toContainText('Applied');
  const mine = ours(await word.changes());
  expect(mine.map(c => c.type)).toEqual(['Deleted']); expect(mine[0].text).toBe(clause);
  expect((await word.texts())[12]).toBe('');
  expect((await word.log()).filter(e => e.op === 'mode').map(e => e.mode)).toEqual(['TrackAll', 'Off']);
});

test('Export record left the pane (decision 184); the API still exports the review and the decisions with a hash of each part, and the file verifies', async ({ request }) => {
  const { verifyRecord } = await import('../../server/record.js');
  const { seedFor } = await import('./fixtures.js');
  const { imported: document } = await seedFor(COUNTER);
  const r = await request.post('/api/review', { data: { document, playbookId: 'nda' } });
  expect(r.ok(), await r.text()).toBe(true);
  const review = await r.json();
  const f = review.findings.find(x => x.title === RETENTION);
  const outcomes = { [f.id]: { kind: 'applied', at: new Date().toISOString(), text: f.proposedText } };
  const exported = await request.post('/api/review-record', { data: { document, baseline: null, review, stale: false, outcomes, events: [] } });
  expect(exported.ok(), await exported.text()).toBe(true);
  const record = await exported.json();
  expect(record.format).toBe('margin-review-record/1');
  expect(Object.values(record.decisions.outcomes).map(o => o.kind)).toEqual(['applied']);
  const v = verifyRecord(record);
  expect(v.ok).toBe(true); expect(v.signature).toBe('unsigned');
  record.decisions.outcomes[f.id].kind = 'dismissed';
  expect(verifyRecord(record).parts.decisions).toBe(false);
});
