// SPDX-License-Identifier: GPL-3.0-or-later
// The safety batch of 16 October 2026 end to end (design deviation audit), after decision 190: the Word pane's one
// store line before review (no filing) and "Save as our reply" into the store, the playbook line, the coverage line, and
// the hold and signed rules on a document's page (the record inbox's two-choice filing went with filing). Documents made here
// carry a unique counterparty so the shared e2e record never decides the outcome. With SAFETY_SHOTS=<dir> each new
// state is also saved as a screenshot (380 px pane, 1440 px pages).
import { test, expect, storeDocs } from './fixtures.js';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { docx } from '../fixtures/record/helpers.js';

const json = async r => { expect(r.ok(), await r.text()).toBe(true); return r.json(); };
const SHOTS = process.env.SAFETY_SHOTS || null;
const shot = async (page, name, target = page) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await target.screenshot({ path: path.join(SHOTS, `${name}.png`), ...(target === page ? { fullPage: false } : {}) }); };
const COUNTER = 'history/helix-brightwater-nda-v3-helix-counter.docx';
const dir = mkdtempSync(path.join(tmpdir(), 'safety-e2e-'));
/** A .docx written for this test, as a file URL the Word fake can open. */
async function document(name, lines) { const file = path.join(dir, name); writeFileSync(file, await docx(lines)); return pathToFileURL(file).href; }
const NDA = party => ['MUTUAL NON-DISCLOSURE AGREEMENT', `This agreement is between ${party} and Helix Systems Ltd.`, 'The recipient keeps the information confidential for three years.', 'English law governs this agreement.'];

/** A counterparty in the store: a scratch document labelled with it (the store makes a counterparty on first use). */
async function storeCounterparty(request, name) {
  const up = await json(await request.post('/api/v2/store/documents', { multipart: { file: { name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Note about ${name}`) } } }));
  expect(up.tasks).toHaveLength(1);
  let doc = null;
  await expect.poll(async () => { doc = (await json(await request.get('/api/v2/store/inbox'))).documents.find(d => d.title === name); return !!doc; }).toBe(true);
  await json(await request.post(`/api/v2/store/documents/${doc.id}/done`, { data: { counterparty: name } }));
}

test('Word before review: a document the store does not hold goes to the inbox with the counterparty matching names; one line says it and opens its Document page; nothing is asked', async ({ page, word, request }) => {
  const stamp = Date.now(); const party = `Zentrix ${stamp} Ltd`;
  await storeCounterparty(request, party);
  await word.open(await document(`zentrix-${stamp}.docx`, NDA(party)));
  const line = page.locator('.pane__store');
  await expect(line).toHaveText(party);
  await expect(page.locator('.pane__book')).toContainText('Playbook · NDA');
  await expect(page.getByRole('button', { name: 'Change playbook', exact: true })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0); // no filing choice, no round, no matter
  await shot(page, 'pane-380-store-line');
  const added = (await storeDocs(request)).find(d => d.title === `zentrix-${stamp}`);
  expect([added.counterparty, added.inbox, added.type]).toEqual([party, true, null]);

  const [sent] = await Promise.all([page.waitForRequest('**/api/review'), page.getByRole('button', { name: 'Review', exact: true }).click()]);
  expect(sent.postDataJSON()).toMatchObject({ playbookId: 'nda' });
  expect(sent.postDataJSON().matterId).toBeUndefined();
  // The recordings cover the demonstration documents only, so this review ends in its error; the line stays.
  await line.getByRole('button', { name: party }).click();
  await expect(page.getByRole('heading', { level: 1, name: `zentrix-${stamp}` })).toBeVisible();
});

test('Word: no playbook phrase in the document means no playbook until the lawyer chooses one (no silent NDA)', async ({ page, word }) => {
  const stamp = Date.now();
  await word.open(await document(`minutes-${stamp}.docx`, ['Minutes of the call', `Attendees: Ostrel ${stamp}.`, 'Next steps agreed.']));
  await expect(page.getByText('Choose a playbook')).toBeVisible();
  await expect(page.locator('.pane__book')).toHaveCount(0); // nothing named until the lawyer chooses
  await expect(page.getByRole('button', { name: 'Change playbook' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeDisabled();
  await shot(page, 'pane-380-choose-playbook');
  await page.getByRole('radiogroup', { name: 'Playbook' }).getByRole('radio', { name: 'Order form' }).click();
  await expect(page.locator('.pane__book')).toContainText('Playbook · Order form');
  await expect(page.getByRole('button', { name: 'Change playbook', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  await expect(page.locator('.pane__store')).toHaveText('No counterparty'); // added to the inbox with no counterparty; labels are set on its page
});

test('Word: the coverage line says what was not checked; Dismiss asks why; Save as our reply adds the version to the Library with the same counterparty and type', async ({ page, word, request }) => {
  await word.open(COUNTER);
  await expect(page.locator('.pane__store')).toBeVisible();
  // The recorded demo review reports on every rule and verifies every quote; the response is altered here so that
  // one rule goes unreported and the worst point's quote fails verification, as a live review can.
  let worst = null;
  await page.route('**/api/review', async route => {
    const response = await route.fetch(); const body = await response.json();
    body.coverage[0].status = 'not-assessed';
    worst = body.findings.find(f => f.status === 'attention') || body.findings[0];
    worst.evidence[0].verified = false;
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText('0 of 5 done')).toBeVisible();
  const coverage = page.locator('.pane__coverage');
  await expect(coverage).toHaveText('2 of 3 rules checked · 1 not verified');
  await expect(page.locator('.tag', { hasText: 'Not verified' })).toHaveCount(1);
  await coverage.getByRole('button').click();
  await expect(coverage.getByRole('list', { name: 'Not checked' })).toContainText('not reported on');
  await expect(coverage.getByRole('list', { name: 'Not checked' })).toContainText('1 point with a quote or citation not verified');
  await shot(page, 'pane-380-coverage-open');
  await coverage.getByRole('button').click();

  await page.locator('.point').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.point').getByRole('button', { name: 'Not an issue' })).toBeVisible();
  await expect(page.locator('.point').getByRole('button', { name: 'Accept their wording' })).toBeVisible();
  await shot(page, 'pane-380-dismiss-why');
  await page.locator('.point').getByRole('button', { name: 'Accept their wording' }).click();
  for (let i = 2; i <= 5; i++) {
    if (!(await page.locator('.point').count())) await page.locator('button.prow').first().click();
    await page.locator('.point').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.locator('.point').getByRole('button', { name: 'Not an issue' }).click();
    await expect(page.getByText(`${i} of 5 done`)).toBeVisible();
  }
  await expect(page.locator('.prow--done').filter({ hasText: 'Accepted' })).toHaveCount(1);
  await expect(page.locator('.prow--done').filter({ hasText: 'Not an issue' })).toHaveCount(4);

  const source = (await storeDocs(request)).find(d => d.originalName === 'helix-brightwater-nda-v3-helix-counter.docx' && !/our reply/.test(d.title));
  await expect(page.getByRole('group', { name: 'Filing' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save as our reply' }).click();
  await expect(page.locator('.save-reply')).toContainText('Saved to Library');
  await expect(page.locator('.toast')).toHaveCount(0);
  await shot(page, 'pane-380-saved');
  const reply = (await storeDocs(request)).find(d => d.title === `${source.title} (our reply)`);
  expect([reply.counterparty, reply.type, reply.inbox]).toEqual([source.counterparty, source.type, false]);
});

test('hold and signed: an admin holds a document from its page; a held or signed document stays out of the trash', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now(); const name = `Holdfast ${stamp}`;
  await storeCounterparty(request, name);
  const doc = (await storeDocs(request)).find(d => d.title === name);
  await page.goto(`/#/documents/${doc.id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  await expect(page.locator('.toast')).toHaveText('On hold');
  await expect(page.getByText('On hold: kept out of the trash')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move to trash' })).toBeDisabled();
  await shot(page, 'document-1440-on-hold');
  const held = await request.post(`/api/v2/store/documents/${doc.id}/trash`);
  expect(held.status()).toBe(409); expect((await held.json()).code).toBe('protected');
  await page.getByRole('button', { name: 'Lift hold' }).click();
  await expect(page.getByRole('button', { name: 'Move to trash' })).toBeEnabled();
  // A signed document: Move to trash is off, and the route refuses it.
  await json(await request.patch(`/api/v2/store/documents/${doc.id}`, { data: { tags: ['signed'] } }));
  await page.reload();
  await expect(page.getByText('Signed: kept out of the trash')).toBeVisible();
  const refused = await request.post(`/api/v2/store/documents/${doc.id}/trash`);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe(`${name} is signed, so it cannot be moved to the trash.`);
});
