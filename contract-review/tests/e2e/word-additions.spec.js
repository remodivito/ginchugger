// SPDX-License-Identifier: GPL-3.0-or-later
// The pane additions of product v2 (slice S5), end to end with the Office fake and the recorded order-form review, as
// they stand on the store (task 8): comment-thread replies (PR-PANE-04), the bulk-apply card (PR-PANE-05), Reject in
// Word reopening the point (PR-PANE-06, the fake half of U1/U2), the playbook-changed line (PR-PANE-07), and, in place of
// the "last time" line, one suggested question in the ask bar when the document has a counterparty. Review events go to
// the store document's review history. Reference files from the record, the round summary and the limits line left the
// pane (the limits line is on the About page).
import { test, expect, storeDocFor, reviewEvents, label } from './fixtures.js';
import { readFileSync } from 'node:fs';

const ORDER = 'order-form/helix-northgate-order-form-v2-customer-markup.docx';
const ORDER_NAME = 'helix-northgate-order-form-v2-customer-markup.docx';
const COUNTER = 'history/helix-brightwater-nda-v3-helix-counter.docx';
const NORTHGATE = 'Daniel Osei (Northgate)';
const TERMINATION = 'Termination for convenience with refund';
const ours = changes => changes.filter(c => c.author === 'Lawyer');
const doneRow = (page, title) => page.locator('.prow--done').filter({ hasText: title });
/** The review history of the order form's store document (the pane adds it on first open). */
const events = async request => reviewEvents(request, (await storeDocFor(request, ORDER_NAME)).id);

/** Review the order-form markup and open the termination point (p11, TFC-01). */
async function reviewToTermination(page) {
  await expect(page.locator('.pane__store')).toBeVisible(); // the store has the document
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
  await page.getByRole('button', { name: TERMINATION }).click();
  await expect(page.locator('.point')).toContainText(TERMINATION);
}

test('the pane sends no reference files and states no limits line; the review comes back after a reload', async ({ page, word }) => {
  await word.open(ORDER, { counterparty: NORTHGATE });
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  await expect(page.getByRole('note')).toHaveCount(0); // the limits line is on the About page (PR-PANE-08)
  await expect(page.getByRole('button', { name: /^(Attach|Remove)$/ })).toHaveCount(0);
  await expect(page.locator('.pane__book')).toContainText('Playbook · Order form'); // audit finding 2: the playbook is named, in the header
  await expect(page.getByRole('button', { name: /^Change/ })).toHaveCount(1); // and changed from the one line under Review
  await expect(page.getByRole('button', { name: 'Change playbook', exact: true })).toBeVisible();
  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), page.getByRole('button', { name: 'Review', exact: true }).click()]);
  expect(sent.postDataJSON().references).toBeUndefined();
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
  const done = await page.locator('.pane__done').textContent();
  await page.waitForTimeout(600); // the pane saves its review a moment after each change
  await page.reload();
  await expect(page.getByText(/Review restored/)).toBeVisible();
  await expect(page.getByText(done)).toBeVisible();
});

test('in place of "last time": with a counterparty, the ask bar offers one question; it asks at once, with the store document named so the answer can read the counterparty\'s other documents', async ({ page, word, request }) => {
  // Another Brightwater document in the store, for the question to be about.
  const up = await request.post('/api/v2/store/documents', { multipart: { file: { name: 'helix-brightwater-nda-v2-bw-markup.docx', mimeType: 'application/octet-stream', buffer: readFileSync(new URL('../../data/fixtures/history/helix-brightwater-nda-v2-bw-markup.docx', import.meta.url)) } } });
  expect(up.ok()).toBe(true);
  await word.open(COUNTER);
  await expect(page.locator('.pane__store')).toBeVisible();
  const doc = await storeDocFor(request, 'helix-brightwater-nda-v3-helix-counter.docx');
  if (doc.counterparty !== 'Brightwater Analytics Ltd') { // labelled as a lawyer would on its page; the pane reads it on next open
    await label(request, doc.id, { counterparty: 'Brightwater Analytics Ltd' });
    await word.reload();
  }
  await expect(page.locator('.pane__store')).toHaveText('Brightwater Analytics Ltd');
  const chip = page.getByRole('button', { name: 'What did we accept from Brightwater Analytics Ltd before?' });
  await expect(chip).toBeVisible();
  const [sent] = await Promise.all([page.waitForRequest('**/api/ask'), chip.click()]);
  expect(sent.postDataJSON()).toMatchObject({ question: 'What did we accept from Brightwater Analytics Ltd before?', storeDocumentId: doc.id });
  await expect(page.locator('.qa__a')).toBeVisible();
  await expect(chip).toHaveCount(0); // one answer on screen: the chip steps aside
  await expect(page.locator('.point__last')).toHaveCount(0);
});

test('Apply on a point whose paragraph carries a comment thread replies in the thread and records comment_replied', async ({ page, word, request }) => {
    await word.open(ORDER, { counterparty: NORTHGATE, comments: [{ paragraph: 10, author: NORTHGATE, text: 'We need to be able to leave early.' }] });
  await reviewToTermination(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(doneRow(page, TERMINATION)).toContainText('Applied');
  const [thread] = await page.evaluate(() => window.__word.comments());
  expect(thread.replies).toHaveLength(1);
  expect(thread.replies[0].author).toBe('Lawyer');
  expect(thread.replies[0].text).toMatch(/^Changed: “.+” to “.+”\.$/); // audit finding 9: no playbook, no rule id in text the counterparty reads
  expect(thread.replies[0].text).not.toMatch(/playbook|TFC-01/i);
  expect(thread.replies[0].text.length).toBeLessThanOrEqual(300);
  await expect.poll(async () => (await events(request)).filter(e => e.type === 'comment_replied').at(-1)?.payload).toMatchObject({ ruleId: 'TFC-01', clauseType: 'cuad:termination-for-convenience', paragraphId: 'p11', commentId: thread.id, text: thread.replies[0].text });
});

test('Apply on a paragraph without a thread posts nothing; a Word without the comment API says the reply was not posted', async ({ page, word, request }) => {
    const before = (await storeDocFor(request, ORDER_NAME)) ? (await events(request)).filter(e => e.type === 'comment_replied').length : 0;
  await word.open(ORDER, { counterparty: NORTHGATE, comments: [{ paragraph: 0, text: 'Title is fine.' }] });
  await reviewToTermination(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(doneRow(page, TERMINATION)).toContainText('Applied');
  expect((await page.evaluate(() => window.__word.comments()))[0].replies).toEqual([]);
  expect((await events(request)).filter(e => e.type === 'comment_replied')).toHaveLength(before);
  await expect(page.getByText('Reply not posted: Word version')).toHaveCount(0);

  const other = await page.context().newPage();
  const { seedFor } = await import('./fixtures.js');
  const { installOfficeFake } = await import('./office-fake.js');
  const { imported, ...seed } = await seedFor(ORDER, { counterparty: NORTHGATE, wordApi: 1.3, comments: [{ paragraph: 10, text: 'Old Word.' }] });
  seed.url += '?test=old-word';
  await other.addInitScript(installOfficeFake, seed);
  await other.goto('/?host=word');
  await reviewToTermination(other);
  await other.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(doneRow(other, TERMINATION).getByText('Reply not posted: Word version')).toBeVisible(); // on the done row
  void imported;
});

test('a point whose reply makes two edits opens the confirmation card; a point with one edit applies on its click', async ({ page, word, request }) => {
    const added = 'Neither party may terminate for convenience during a renewal term.';
  await page.route('**/api/review', async route => {
    const json = await (await route.fetch()).json();
    const f = json.findings.find(x => x.paragraphId === 'p11');
    f.insertAfter = [{ afterParagraphId: 'p11', text: added, anchored: true }];
    await route.fulfill({ json });
  });
  await word.open(ORDER, { counterparty: NORTHGATE });
  const original = await word.texts();
  await reviewToTermination(page);
  await expect(page.locator('.point__box ins').filter({ hasText: added })).toHaveCount(1); // both edits drawn in the box
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const card = page.getByRole('group', { name: 'Changes' });
  await expect(card.getByRole('button')).toHaveCount(2);
  await expect(card.getByText('¶ 11', { exact: true })).toBeVisible();
  await expect(card.getByText('New ¶ after ¶ 11')).toBeVisible();
  expect(ours(await word.changes())).toEqual([]); // nothing lands before Confirm
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(doneRow(page, TERMINATION)).toContainText('Applied');
  await expect(card).toHaveCount(0);
  const texts = await word.texts();
  expect(texts).toHaveLength(original.length + 1);
  expect(texts[11]).toBe(added); // in document order: the clause, then the new paragraph after it
  expect(ours(await word.changes()).filter(c => c.type === 'Added').map(c => c.text)).toContain(added);
  await expect.poll(async () => (await events(request)).filter(e => e.type === 'edit_applied' && e.payload.ruleId === 'TFC-01').slice(-2).map(e => e.payload.after === added)).toEqual([false, true]);

  await expect(page.locator('.point')).toContainText('Customer purchase-order terms to prevail'); // the next open point (9. Entire agreement) opened
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); // one edit (its clause): no card
  await expect(page.getByRole('group', { name: 'Changes' })).toHaveCount(0);
  await expect(doneRow(page, 'Customer purchase-order terms to prevail')).toContainText('Applied');
});

test('Reject in Word restores the paragraph, and the pane reopens the point on its next read', async ({ page, word, request }) => {
    await word.open(ORDER, { counterparty: NORTHGATE });
  const original = (await word.texts())[10];
  await reviewToTermination(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(doneRow(page, TERMINATION)).toContainText('Applied');
  await expect(page.getByText(/^1 of \d+ done$/)).toBeVisible();
  expect((await word.texts())[10]).not.toBe(original);
  await page.evaluate(() => window.__word.rejectBy('Lawyer'));
  expect((await word.texts())[10]).toBe(original); // the fake half of U2: the paragraph reads as before
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible(); // the point is open again
  await expect(doneRow(page, TERMINATION)).toHaveCount(0);
  await expect(page.getByText('Document changed')).toHaveCount(0);
  await expect.poll(async () => (await events(request)).map(e => e.type)).toContain('edit_rejected_in_word');
});

test('a playbook changed after the review shows one line with Review again, which reviews against the new version', async ({ page, word, request }) => {
  await word.open(ORDER, { counterparty: NORTHGATE });
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
  await expect(page.getByText('Playbook changed')).toHaveCount(0);
  const pb = await (await request.get('/api/playbook?id=order-form')).json();
  pb.rules[0].guidance = `${pb.rules[0].guidance} (Checked again.)`;
  expect((await request.put('/api/playbook?id=order-form', { data: pb })).ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const line = page.getByRole('status').filter({ hasText: 'Playbook changed' });
  await expect(line).toBeVisible();
  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), line.getByRole('button', { name: 'Review again' }).click()]);
  expect(sent.postDataJSON().playbookId).toBe('order-form');
  await expect(page.getByText('Playbook changed')).toHaveCount(0);
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
});
