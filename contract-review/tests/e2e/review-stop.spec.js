// SPDX-License-Identifier: GPL-3.0-or-later
// Stop for a review (17 Oct 2026; stress scenario review-hang): while a review runs the pane shows Stop beside the
// progress, as Ask does; Stop cancels the request, the pane is ready again with one plain line, and nothing of the
// review is applied. /api/review is held by a stand-in in the page until Stop (the server ending the model call is
// tested in tests/review-nonblocking.test.js); once released the real route answers.
import { test, expect } from './fixtures.js';

const COUNTER = 'history/helix-brightwater-nda-v3-helix-counter.docx';

/** /api/review held until its signal aborts, while `__review.hold`; otherwise the real route. */
function holdReview() {
  const real = window.fetch.bind(window);
  window.__review = { hold: true, requests: 0, aborted: false };
  window.fetch = (url, opts = {}) => {
    if (String(url) !== '/api/review' || !window.__review.hold) return real(url, opts);
    window.__review.requests++;
    return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => { window.__review.aborted = true; reject(new DOMException('Aborted', 'AbortError')); }));
  };
}

async function stopAndRetry(page, points) {
  const start = page.locator('.start');
  await start.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(start.getByRole('button', { name: /^Reviewing \d+:\d\d$/ })).toBeDisabled();
  const stop = start.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  await stop.click();
  expect(await page.evaluate(() => window.__review.aborted)).toBe(true);
  await expect(start.getByRole('status').filter({ hasText: 'Review stopped.' })).toBeVisible();
  await expect(start.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  await expect(start.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.locator('.points')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Released: the next Review runs as usual and the stopped line goes.
  await page.evaluate(() => { window.__review.hold = false; });
  await start.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('.pane__segs span')).toHaveCount(points); // one segment per point
  await expect(page.getByText('Review stopped.')).toHaveCount(0);
}

test('the Word pane: Stop during a review returns the pane to ready with "Review stopped."; the next review runs', async ({ page, word }) => {
  await page.addInitScript(holdReview);
  await word.open(COUNTER);
  await stopAndRetry(page, 5);
});

test('the browser review: the same Stop beside Reviewing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(holdReview);
  await page.goto('/');
  await expect(page.locator('.start').getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  const start = page.locator('.start');
  await start.getByRole('button', { name: 'Review', exact: true }).click();
  await start.getByRole('button', { name: 'Stop' }).click();
  await expect(start.getByRole('status').filter({ hasText: 'Review stopped.' })).toBeVisible();
  await expect(start.getByRole('button', { name: 'Review', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__review.requests)).toBe(1);
});
