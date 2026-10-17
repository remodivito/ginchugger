// SPDX-License-Identifier: GPL-3.0-or-later
// The Word pane on the store (tasks/paperless-store-plan.md tasks 8 and 10), end to end with the Office fake and the
// recorded demo. The pane knows no matter or round (decision 190): it finds the open document in the store (or adds it
// to the inbox), sends its store id with the review, writes the review's events to that document's review history, and
// saves our reply as a new document of the same counterparty and type.
import { test, expect, storeDocFor, storeDocs, reviewEvents } from './fixtures.js';
import { readFileSync } from 'node:fs';

const MARKUP = 'history/helix-brightwater-nda-v2-bw-markup.docx';
const ORDER = 'order-form/helix-northgate-order-form-v2-customer-markup.docx';
const json = async r => { expect(r.ok(), await r.text()).toBe(true); return r.json(); };

test('a review of a document in the store: one line names its counterparty and type and opens its page; the review and each decision, with why, go to its review history; an accepted wording is a note on the document', async ({ page, word, request }) => {
  await word.open(ORDER, { counterparty: 'Daniel Osei (Northgate)' });
  const line = page.locator('.pane__store');
  await expect(line).toBeVisible();
  const doc = await storeDocFor(request, 'helix-northgate-order-form-v2-customer-markup.docx');
  expect(doc).toBeTruthy();
  await expect(page.locator('.pane__doc')).toHaveText(doc.title);
  await expect(line).toHaveText([doc.counterparty, doc.type].filter(Boolean).join(' · ') || 'No counterparty');
  await expect(page.getByText(/Round \d|Earlier version|Filed under/)).toHaveCount(0);
  await expect(page.locator('.pane__book')).toContainText('Playbook · Order form'); // inferred from the document, named once, in the header
  await expect(page.locator('.pane__ctx')).toHaveText(`${await line.textContent()}·Change playbook`); // one line under Review
  await expect(page.getByRole('combobox')).toHaveCount(0);

  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), page.getByRole('button', { name: 'Review', exact: true }).click()]);
  expect(sent.postDataJSON()).toMatchObject({ playbookId: 'order-form' });
  expect(sent.postDataJSON().matterId).toBeUndefined();
  expect(sent.postDataJSON().storeDocumentId).toBe(doc.id); // the review reads the store through the tools (plan task 10)
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
  const types = async () => (await reviewEvents(request, doc.id)).map(e => e.type);
  await expect.poll(types).toEqual(expect.arrayContaining(['review_run', 'finding_flagged']));

  const first = page.locator('.point');
  const title = (await first.locator('.point__title').textContent()).trim();
  await first.getByRole('button', { name: 'Dismiss', exact: true }).click(); // no note field: one tap says why (audit finding 1)
  await first.getByRole('button', { name: 'Accept their wording' }).click();
  await expect(page.locator('.prow--done').filter({ hasText: title })).toContainText('Accepted');
  await expect.poll(types).toContain('finding_dismissed');
  const events = await reviewEvents(request, doc.id);
  const run = events.filter(e => e.type === 'review_run').at(-1);
  expect([run.payload.round, run.payload.playbookId]).toEqual([null, 'order-form']);
  expect(events.filter(e => e.type === 'finding_dismissed').at(-1).payload).toMatchObject({ reviewId: run.payload.reviewId, note: 'Accepted their wording', reason: 'accepted' });

  // The concession is a note on the document, for the agent's next review; undo deletes it; accepting again puts it back.
  const notes = async () => (await (await request.get(`/api/v2/store/documents/${doc.id}/notes`)).json()).map(n => n.text);
  await expect.poll(notes).toEqual([expect.stringMatching(/^Accepted their wording on .+: ".+"$/)]);
  expect((await notes())[0].startsWith(`Accepted their wording on ${title}: "`)).toBe(true);
  await page.locator('.prow--done').filter({ hasText: title }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(types).toContain('finding_undismissed');
  await expect.poll(notes).toEqual([]);
  await expect(page.locator('.point')).toContainText(title); // undone, the point is open again
  await page.locator('.point').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.locator('.point').getByRole('button', { name: 'Accept their wording' }).click();
  await expect.poll(notes).toHaveLength(1);

  // Back to the start (a fresh pane on the same document): the line opens the document's page in the pane.
  await page.evaluate(() => fetch('/api/pane-session?key=' + encodeURIComponent(window.Office.context.document.url), { method: 'DELETE' }));
  await word.reload();
  await page.locator('.pane__store').getByRole('button').click();
  await expect(page.getByRole('heading', { level: 1, name: doc.title })).toBeVisible();
  await expect(page.locator('.note')).toContainText(`Accepted their wording on ${title}: "`);
  await page.getByRole('button', { name: 'Review' }).click(); // the back bar
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
});

test('Save as our reply: once every point is handled, one click strips the hidden bookmarks and adds the document to the Library with the same counterparty and type', async ({ page, word, request }) => {
  await word.open(ORDER, { counterparty: 'Daniel Osei (Northgate)' });
  await expect(page.locator('.pane__store')).toBeVisible();
  const source = await storeDocFor(request, 'helix-northgate-order-form-v2-customer-markup.docx');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
  const total = Number(/of (\d+) done/.exec(await page.locator('.pane__done').textContent())[1]);
  await expect(page.getByRole('button', { name: 'Save as our reply' })).toHaveCount(0); // not before every point is handled

  // Apply the termination point (it leaves a hidden bookmark in Word), dismiss the rest.
  await page.getByRole('button', { name: 'Termination for convenience with refund' }).click();
  await page.locator('.point').getByRole('button', { name: 'Apply', exact: true }).click();
  const card = page.locator('.point').getByRole('button', { name: 'Apply', exact: true });
  if (await page.getByText(`1 of ${total} done`).isVisible().catch(() => false) === false && await card.count()) await card.click();
  await expect(page.getByText(`1 of ${total} done`)).toBeVisible();
  expect(Object.keys(await word.bookmarks()).length).toBeGreaterThan(0);
  for (let i = 2; i <= total; i++) {
    if (!(await page.locator('.point').count())) await page.locator('button.prow').first().click();
    await page.locator('.point').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.locator('.point').getByRole('button', { name: 'Not an issue' }).click();
    await expect(page.getByText(`${i} of ${total} done`)).toBeVisible();
  }

  await expect(page.getByText(/Round \d/)).toHaveCount(0); // no round, no question
  await page.getByRole('button', { name: 'Save as our reply' }).click();
  await expect(page.locator('.save-reply')).toContainText('Saved to Library');
  await expect(page.locator('.toast')).toHaveCount(0); // the line says it; no toast repeats it (UX audit)
  expect(await word.bookmarks()).toEqual({}); // nothing of ours leaves with the version sent (W7)
  const reply = (await storeDocs(request)).find(d => d.title === `${source.title} (our reply)`);
  expect([reply.counterparty, reply.type, reply.inbox, reply.id === source.id]).toEqual([source.counterparty, source.type, false, false]);
  await page.locator('.save-reply').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { level: 1, name: reply.title })).toBeVisible();
  // The bookmarks went with the version sent, not the change: reopened, the pane keeps the applied point done and records
  // no rejection (walkthrough 17 Oct: a missing bookmark read as "rejected in Word" and reopened the point).
  const before = (await reviewEvents(request, source.id)).length;
  await page.waitForTimeout(600); // the session save follows each change after a moment
  await word.reload();
  await expect(page.getByText(`${total} of ${total} done`)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  await expect(page.getByText(`${total} of ${total} done`)).toBeVisible();
  expect((await reviewEvents(request, source.id)).slice(before).map(e => e.type)).not.toContain('edit_rejected_in_word');
  // ...and says it was saved, rather than offering to save a second reply.
  await expect(page.locator('.save-reply')).toContainText('Saved to Library');
  await expect(page.getByRole('button', { name: 'Save as our reply' })).toHaveCount(0);
});

test('back on Review the store line is read again: new labels show, and a document moved to the trash is no longer offered (stress audit)', async ({ page, word, request }) => {
  await word.open('history/helix-brightwater-nda-v1.docx');
  const line = page.locator('.pane__store');
  await expect(line).toBeVisible();
  await line.getByRole('button').click();
  const labels = page.getByRole('region', { name: 'Labels' });
  await labels.getByLabel('Counterparty').fill('Stress Audit Ltd');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Labels saved')).toBeVisible();
  await page.locator('.backbar__btn').click();
  await expect(line).toContainText('Stress Audit Ltd');
  await line.getByRole('button').click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByText(/moved to the trash/)).toBeVisible();
  await page.locator('.backbar__btn').click();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await expect(line).toHaveCount(0);
  // Put it back for the specs that follow (the e2e server's store is shared).
  const trashed = (await (await request.get('/api/v2/store/trash')).json()).items.find(d => d.counterparty === 'Stress Audit Ltd');
  await request.post('/api/v2/store/trash/restore', { data: { ids: [trashed.id] } });
  await request.patch(`/api/v2/store/documents/${trashed.id}`, { data: { counterparty: null } });
});
