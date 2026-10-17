// SPDX-License-Identifier: GPL-3.0-or-later
// Header D and Ask C (17 Oct 2026) in the Word pane: the wordmark, the playbook and one segment per point; Review and
// Ask as tabs; the Ask tab's history with rendered answers and sources behind one control; live steps while the model
// works, with the time so far and Stop. The live steps come from a stand-in for the streaming /api/ask installed in the
// page (the server's own stream is tested in tests/ask-stream.test.js), so each step can be seen before the answer.
import { test, expect } from './fixtures.js';

const COUNTER = 'history/helix-brightwater-nda-v3-helix-counter.docx';
const QUESTION = 'What did we accept from Brightwater before?';

/** /api/ask answered by a stream the test drives: the steps below arrive one by one; `__ask.finish(answer)` ends it. */
function fakeAskStream() {
  const real = window.fetch.bind(window);
  window.__ask = { requests: [], aborted: false, finish: null };
  window.fetch = (url, opts = {}) => {
    if (String(url) !== '/api/ask') return real(url, opts);
    window.__ask.requests.push(JSON.parse(opts.body));
    const encoder = new TextEncoder(); let ctrl;
    const stream = new ReadableStream({ start(c) { ctrl = c; } });
    const send = o => ctrl.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
    const steps = [
      { id: 'draft', text: 'Reading this draft', state: 'active' }, { id: 'draft', text: 'Read this draft', state: 'done' },
      { id: 't1', text: 'Searching Brightwater Analytics Ltd’s documents', state: 'active' }, { id: 't1', text: 'Searched Brightwater Analytics Ltd’s documents · 3 found', state: 'done' },
      { id: 't2', text: 'Reading Helix NDA v1 (signed)', state: 'active' },
    ];
    let i = 0; const timer = setInterval(() => { if (i < steps.length) send({ type: 'step', step: steps[i++] }); }, 60);
    window.__ask.finish = answer => { clearInterval(timer); send({ type: 'answer', answer }); ctrl.close(); };
    opts.signal?.addEventListener('abort', () => { clearInterval(timer); window.__ask.aborted = true; try { ctrl.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ } });
    return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }));
  };
}
async function ask(page, q = QUESTION) {
  await page.getByRole('textbox', { name: 'Ask about this draft' }).fill(q);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}

test('header D: the wordmark, the playbook and version, the title, and one segment per point filled as points are done', async ({ page, word }) => {
  await word.open(COUNTER);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByText('0 of 5 done')).toBeAttached(); // said to screen readers
  await expect(page.locator('.pane__mark')).toHaveText('GinChugger');
  await expect(page.locator('.pane__book')).toHaveText(/^Playbook · .+ v\d+$/);
  await expect(page.locator('.pane__segs span')).toHaveCount(5);
  await expect(page.locator('.pane__segs span.on')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Review · 0 of 5' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Not an issue' }).click();
  await expect(page.locator('.pane__segs span.on')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Review · 1 of 5' })).toBeVisible();
  await expect(page.getByText('1 of 5 done')).toBeAttached();
});

test('Ask shows each step as it happens with the time so far; Stop cancels the request and the question stays as stopped', async ({ page, word }) => {
  await page.addInitScript(fakeAskStream);
  await word.open(COUNTER);
  await ask(page);
  await expect(page.getByRole('tab', { name: 'Ask' })).toHaveAttribute('aria-selected', 'true');
  const progress = page.getByRole('status', { name: 'Progress' });
  await expect(progress).toContainText('Searched Brightwater Analytics Ltd’s documents · 3 found');
  await expect(progress.locator('.step--done')).toHaveText(['Read this draft', 'Searched Brightwater Analytics Ltd’s documents · 3 found']);
  await expect(progress.locator('.step--active')).toHaveText('Reading Helix NDA v1 (signed)');
  await expect(progress.locator('.progress__time')).toHaveText(/^\d+ s$/);
  expect((await page.evaluate(() => window.__ask.requests))[0]).toMatchObject({ question: QUESTION, stream: true });
  await page.getByRole('button', { name: 'Stop' }).click();
  expect(await page.evaluate(() => window.__ask.aborted)).toBe(true);
  const entry = page.getByRole('article', { name: QUESTION });
  await expect(entry).toContainText('Stopped');
  await expect(progress).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
});

test('the Ask tab keeps the document\'s questions: a rendered answer, sources behind one control, kept across a reload', async ({ page, word }) => {
  await page.addInitScript(fakeAskStream);
  const doc = await word.open(COUNTER);
  const p = doc.paragraphs.find(x => x.text.length > 80);
  await ask(page);
  await expect(page.getByRole('status', { name: 'Progress' })).toContainText('Reading Helix NDA v1 (signed)');
  await page.evaluate(([paragraphId, quote]) => window.__ask.finish({
    answer: '**Three years**, as signed.\n\n- v1 was signed\n- v2 asked for five\n\n<b>not markup</b>',
    evidence: [{ paragraphId, quote, verified: true }],
    sources: [{ documentId: 12, title: 'Helix NDA v1 (signed)', date: '2025-03-01', quote: 'three years after termination', verified: true }],
    limits: ['The 2024 email was not read.'],
  }), [p.id, p.text.slice(0, 40)]);
  const entry = page.getByRole('article', { name: QUESTION });
  await expect(entry.locator('.qa__q')).toHaveText(QUESTION);
  await expect(entry.locator('.qa__a strong')).toHaveText('Three years');
  await expect(entry.locator('.qa__a li')).toHaveText(['v1 was signed', 'v2 asked for five']);
  await expect(entry.locator('.qa__a')).toContainText('<b>not markup</b>');
  // Sources open under the answer: the passage in this draft, and the earlier document with its title and date.
  const more = entry.getByRole('button', { name: '2 sources' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  const items = entry.getByRole('list', { name: 'Sources' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(`This draft · ¶ ${p.id.slice(1)}`);
  await expect(items.nth(1)).toContainText('Helix NDA v1 (signed) · 2025-03-01');
  await expect(items.nth(1)).toContainText('“three years after termination”');
  await items.nth(0).getByRole('button', { name: 'Show in document' }).click();
  await expect.poll(() => word.highlighted()).toEqual([expect.stringContaining(p.text.slice(0, 30).trim())]);
  await entry.getByRole('button', { name: '1 note' }).click();
  await expect(entry.getByRole('list', { name: 'Notes' })).toHaveText('The 2024 email was not read.');
  // Suggested questions follow an answer; the one asked is not offered again.
  const chips = page.getByRole('group', { name: 'Suggested questions' });
  await expect(chips.getByRole('button', { name: 'What did they change in this draft?' })).toBeVisible();
  // The history comes back with the pane.
  await page.waitForTimeout(600);
  await word.reload();
  await page.getByRole('tab', { name: 'Ask' }).click();
  await expect(page.getByRole('article', { name: QUESTION }).locator('.qa__a strong')).toHaveText('Three years');
  // A store source opens its document page.
  await page.getByRole('article', { name: QUESTION }).getByRole('button', { name: '2 sources' }).click();
  await page.getByRole('button', { name: 'Open document' }).click();
  await expect(page).toHaveURL(/#\/documents\/12$/);
});

/**
 * A webview that holds the streamed /api/ask back until it ends (17 Oct 2026, Word for Mac): nothing reaches the reader
 * before `__held.finish(answer)`; the steps so far come only from GET /api/ask/progress/:askId (`__held.steps`).
 */
function heldAskStream() {
  const real = window.fetch.bind(window);
  window.__held = { requests: [], polls: [], steps: [], finish: null };
  window.fetch = (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/ask/progress/')) { window.__held.polls.push(u); return Promise.resolve(new Response(JSON.stringify({ steps: window.__held.steps, done: false }), { headers: { 'Content-Type': 'application/json' } })); }
    if (u !== '/api/ask') return real(url, opts);
    window.__held.requests.push(JSON.parse(opts.body));
    const encoder = new TextEncoder(); let ctrl;
    const stream = new ReadableStream({ start(c) { ctrl = c; } });
    window.__held.finish = (answer, error) => {
      const lines = [{ type: 'start' }, ...window.__held.steps.map(step => ({ type: 'step', step })), error ? { type: 'error', error } : { type: 'answer', answer }];
      ctrl.enqueue(encoder.encode(lines.map(l => JSON.stringify(l)).join('\n') + '\n')); ctrl.close();
    };
    return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }));
  };
}

test('a webview that holds the stream back: the steps are polled by the Ask\'s id and shown; a prose answer says its sources could not be checked', async ({ page, word }) => {
  await page.addInitScript(heldAskStream);
  await word.open(COUNTER);
  await ask(page, 'What did they change in this draft?');
  const progress = page.getByRole('status', { name: 'Progress' });
  await page.evaluate(() => { window.__held.steps = [{ id: 'draft', text: 'Read this draft', state: 'done' }, { id: 't1', text: 'Searching Brightwater Analytics Ltd’s documents', state: 'active' }]; });
  await expect(progress.locator('.step--done')).toHaveText(['Read this draft'], { timeout: 6000 });
  await expect(progress.locator('.step--active').first()).toHaveText('Searching Brightwater Analytics Ltd’s documents');
  const [request] = await page.evaluate(() => window.__held.requests);
  expect(request.askId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(await page.evaluate(() => window.__held.polls)).toContain(`/api/ask/progress/${request.askId}`);
  await page.evaluate(() => window.__held.finish({ answer: '### What changed\n- **Payment** moves to 90 days.', evidence: [], limits: [], unchecked: true }));
  const entry = page.getByRole('article', { name: 'What did they change in this draft?' });
  await expect(entry.locator('.qa__a h3, .qa__a strong').first()).toBeVisible();
  await expect(entry.locator('.qa__a li')).toHaveText('Payment moves to 90 days.');
  await expect(entry).toContainText('This answer’s sources could not be checked.');
  await expect(progress).toHaveCount(0);
  // Polling stops with the answer.
  const n = (await page.evaluate(() => window.__held.polls)).length;
  await page.waitForTimeout(2500);
  expect((await page.evaluate(() => window.__held.polls)).length).toBe(n);
});

test('an Ask that fails shows the server\'s plain message under the question', async ({ page, word }) => {
  await page.addInitScript(heldAskStream);
  await word.open(COUNTER);
  await ask(page);
  await expect.poll(() => page.evaluate(() => typeof window.__held.finish)).toBe('function');
  await page.evaluate(() => window.__held.finish(null, 'The question could not be answered. Ask again.'));
  await expect(page.getByRole('article', { name: QUESTION }).getByRole('alert')).toHaveText('The question could not be answered. Ask again.');
});

test('the selection in Word: a chip above the ask bar, sent with the question and kept with it; × or an empty selection clears it', async ({ page, word }) => {
  await page.addInitScript(fakeAskStream);
  const doc = await word.open(COUNTER);
  const i = doc.paragraphs.findIndex(x => x.text.length > 80);
  const passage = doc.paragraphs[i].text.slice(0, 70);
  const chip = page.getByRole('group', { name: 'Selection' });
  await expect(chip).toHaveCount(0);
  await page.evaluate(([p, t]) => window.__word.selectText(p, t), [i, passage]);
  const snippet = `${passage.replace(/\s+/g, ' ').slice(0, 40).trimEnd()}…`;
  await expect(chip).toHaveText(`“${snippet}” selected×`);
  // × clears it; selecting again brings it back; clicking to an empty selection in Word clears it.
  await chip.getByRole('button', { name: 'Clear selection' }).click();
  await expect(chip).toHaveCount(0);
  await page.evaluate(([p, t]) => window.__word.selectText(p, t), [i, passage]);
  await expect(chip).toBeVisible();
  await page.evaluate(() => window.__word.selectNone());
  await expect(chip).toHaveCount(0);
  await page.evaluate(([p, t]) => window.__word.selectText(p, t), [i, passage]);
  await expect(chip).toBeVisible();
  await ask(page, 'What does this mean?');
  await expect.poll(() => page.evaluate(() => window.__ask.requests.length)).toBe(1);
  const [request] = await page.evaluate(() => window.__ask.requests);
  expect(request.selection).toEqual({ text: passage.trim(), paragraphIds: [doc.paragraphs[i].id] });
  await page.evaluate(() => window.__ask.finish({ answer: 'It means this.', evidence: [], limits: [] }));
  const entry = page.getByRole('article', { name: 'What does this mean?' });
  await expect(entry.locator('.qa__sel')).toHaveText(`“${passage.replace(/\s+/g, ' ').trim()}”`);
});

test('citation chips and tables in an answer: a ¶ chip marks the passage in Word, a doc chip opens the document, an unknown marker is text, a table is one block per row at 380 px', async ({ page, word }) => {
  await page.addInitScript(fakeAskStream);
  const doc = await word.open(COUNTER);
  const p = doc.paragraphs.find(x => x.text.length > 80);
  const n = p.id.slice(1);
  await ask(page, 'Summarise the commercial and risk terms');
  await expect(page.getByRole('status', { name: 'Progress' })).toContainText('Reading Helix NDA v1 (signed)');
  await page.evaluate(([paragraphId, quote, no]) => window.__ask.finish({
    answer: `### Commercials\nThe term is **three years** [¶${no}], as in the pilot [doc 12]. Nothing at [¶999] or [doc 77].\n\n### Risk\n| Term | This draft | Playbook |\n|---|---|---|\n| **Term** | 3 years [¶${no}] | 2 years |\n| Cap | Uncapped | 12 months [doc 12] |`,
    evidence: [{ paragraphId, quote, verified: true }],
    sources: [{ documentId: 12, title: 'Pilot 2025', date: '2025-03-01', quote: 'three years', verified: true }],
    limits: [],
  }), [p.id, p.text.slice(0, 40), n]);
  const answer = page.getByRole('article', { name: 'Summarise the commercial and risk terms' }).locator('.qa__a');
  // The chips: real controls with labels; unknown markers stay as their text.
  const para = answer.getByRole('button', { name: `Show paragraph ${n} in the document` });
  await expect(para).toHaveCount(2);
  await expect(para.first()).toHaveText(`¶${n}↗`);
  const docChip = answer.getByRole('link', { name: 'Open Pilot 2025' });
  await expect(docChip).toHaveCount(2);
  await expect(docChip.first()).toHaveAttribute('href', '#/documents/12');
  await expect(answer).toContainText('Nothing at [¶999] or [doc 77].');
  // The table: one block per row in the pane, the <table> hidden; the row label bold, each value under its header.
  await expect(answer.locator('table')).toBeHidden();
  const rows = answer.getByRole('group');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.mdt__label')).toHaveText('Term');
  await expect(rows.nth(0).locator('dt')).toHaveText(['This draft', 'Playbook']);
  await expect(rows.nth(1).locator('dd')).toHaveText(['Uncapped', '12 months Pilot 2025↗']);
  expect(await rows.nth(0).boundingBox().then(b => b.width)).toBeLessThanOrEqual(380);
  // The ¶ chip, by keyboard, marks the passage in Word.
  await para.first().focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => word.highlighted()).toEqual([expect.stringContaining(p.text.slice(0, 30).trim())]);
  // Where there is room (a pane wider than about 520 px) the same table is a real <table>.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(answer.locator('table')).toBeVisible();
  await expect(answer.locator('table thead th')).toHaveText(['Term', 'This draft', 'Playbook']);
  await expect(rows).toHaveCount(0);
  await page.setViewportSize({ width: 380, height: 900 });
  // The doc chip opens the document page.
  await docChip.first().click();
  await expect(page).toHaveURL(/#\/documents\/12$/);
});
