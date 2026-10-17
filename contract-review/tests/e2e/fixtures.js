// SPDX-License-Identifier: GPL-3.0-or-later
// Shared Playwright fixture for the Word pane: `word.open(file)` seeds the Office.js fake with a .docx from the fixtures
// and opens the pane as Word would (?host=word). The seed's paragraphs come from the server's own importer, and each
// paragraph's tracked changes are rebuilt from its current and original text, so Word's paragraph text and the
// server's agree exactly, as measured in Word for Mac (decision log, 5 Oct 2026).
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { diffWordsWithSpace } from 'diff';
import { importDocx } from '../../server/docx.js';
import { installOfficeFake } from './office-fake.js';

const FIXTURES = new URL('../../data/fixtures/', import.meta.url);

export async function seedFor(file, { counterparty = 'Counterparty', date = '2026-05-19T09:40:00Z', ...options } = {}) {
  const buffer = readFileSync(new URL(file, FIXTURES));
  const doc = await importDocx(buffer, file.split('/').pop());
  const paragraphs = doc.paragraphs.map(p => {
    if (p.originalText === undefined || p.originalText === p.text) return [{ text: p.text, state: 'n' }];
    return diffWordsWithSpace(p.originalText, p.text).map(part => ({ text: part.value, state: part.added ? 'ins' : part.removed ? 'del' : 'n', ...(part.added || part.removed ? { author: counterparty, date } : {}) }));
  });
  return { paragraphs, fileBase64: buffer.toString('base64'), url: `https://contoso.sharepoint.test/Shared/${encodeURIComponent(file.split('/').pop())}`, title: '', author: 'Lawyer', ...options, imported: doc };
}

export const test = base.extend({
  word: async ({ page }, use, testInfo) => {
    const word = {
      async open(file, options) {
        const { imported, ...seed } = await seedFor(file, options);
        seed.url += `?test=${testInfo.testId}`; // each test is its own document to the server, so nothing carries over between tests
        await page.addInitScript(installOfficeFake, seed);
        await page.goto('/?host=word');
        return imported;
      },
      texts: () => page.evaluate(() => window.__word.texts()),
      changes: () => page.evaluate(() => window.__word.changes()),
      bookmarks: () => page.evaluate(() => window.__word.bookmarks()),
      highlighted: () => page.evaluate(() => window.__word.highlighted()),
      settings: () => page.evaluate(() => window.__word.settings()),
      log: () => page.evaluate(() => window.__word.log()),
      // Close and reopen the pane: the document (and what Word keeps with it) stays, every handle in the page goes.
      reload: () => page.reload(),
    };
    await use(word);
  },
});
export { expect };

// The store (task 8): what the pane added or found, read back through the app's own routes (the fake store in e2e).
const ok = async r => { expect(r.ok(), await r.text()).toBe(true); return r.json(); };
/**
 * Every live document in the store: the Library's rows, and the copies each row stands for (`copyIds`: the same bytes,
 * or the same words by the Content key field; the Office fake hands over the same bytes on every read, so a saved reply
 * is a copy of the document reviewed).
 */
export async function storeDocs(request) {
  const rows = (await ok(await request.get('/api/v2/store/documents?pageSize=100'))).results;
  const out = [...rows];
  for (const r of rows.filter(x => x.copies > 1)) for (const id of r.copyIds || r.duplicates.filter(x => !x.deletedAt).map(x => x.id)) if (!out.some(o => o.id === id)) out.push(await ok(await request.get(`/api/v2/store/documents/${id}`)));
  return out.sort((a, b) => a.id - b.id);
}
/** The store document the pane holds for a fixture file, by its original file name (the first one, not a reply). */
export const storeDocFor = async (request, originalName) => (await storeDocs(request)).find(d => d.originalName === originalName && !/\(our reply\)$/.test(d.title)) || null;
/** A document's review history (our SQLite, keyed by store id). */
export const reviewEvents = async (request, id) => ok(await request.get(`/api/v2/store/documents/${id}/review-events`));
/** Label a store document (as the Document page does). */
export const label = async (request, id, patch) => ok(await request.patch(`/api/v2/store/documents/${id}`, { data: patch }));
