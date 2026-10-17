// SPDX-License-Identifier: GPL-3.0-or-later
// The stress harness's named fault scenarios (tests/stress). Each starts its own app server (fresh state, model stub,
// faulty in-memory store), drives the Word pane (380 px) or the pages (1440 px) into one fault, and checks that the
// lawyer sees a plain sentence (never internals), that no busy state outlives the fault, and that the next attempt
// works once the fault is gone. Run one alone: npm run stress -- --seeds none --scenarios <name>.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp, openPane, fixtureSeed, syntheticSeed, SYNTHETIC, snapshot, check, watch, sleep, ROOT, FIXTURES, STRESS } from './harness.mjs';

const NDA = 'history/helix-brightwater-nda-v3-helix-counter.docx';
const ORDER = 'order-form/helix-northgate-order-form-v2-customer-markup.docx';

/**
 * One scenario's session: a server, a page, a step log and the problems found. `t.check()` runs the invariants now;
 * `t.idle()` waits for every busy state to end; `t.expect(ok, what)` records a failed expectation.
 */
async function session(ctx, { env = {}, viewport = { width: 380, height: 860 } } = {}, body) {
  const server = await startApp(ctx.run, env);
  const context = await ctx.browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const sink = []; watch(page, sink);
  const steps = [], problems = [];
  const state = { busyMs: ctx.busyMs, busySince: new Map(), settled: true, allowRaw: [] };
  const t0 = Date.now();
  const allowedHttp = [/GET \/api\/v2\/store\/documents\/\d+\/thumb/];
  const t = {
    server, page, steps, context, sink,
    step: s => steps.push(`${s} (at ${Math.round((Date.now() - t0) / 1000)} s)`),
    allowHttp: (...re) => allowedHttp.push(...re),
    expect(ok, what) { if (!ok) problems.push({ kind: 'expectation', detail: what }); return ok; },
    /** A known gap that needs a product decision: reported, not failed. */
    known(ok, what) { if (!ok) ctx.recorder.known.push({ scenario: ctx.name, detail: what }); return ok; },
    async check(label = '') {
      const s = await snapshot(page).catch(() => null); if (!s) return null;
      const found = check(s, state);
      const events = sink.splice(0);
      const http = events.filter(e => e.kind.startsWith('http-'));
      const unexpected = http.filter(e => !allowedHttp.some(re => re.test(`${e.kind} ${e.detail}`)));
      found.push(...unexpected);
      found.push(...events.filter(e => !e.kind.startsWith('http-') && !allowedHttp.some(re => re.test(`${e.kind} ${e.detail}`)) && !(e.kind === 'console' && /Failed to load resource/.test(e.detail) && !unexpected.length)));
      for (const p of found) problems.push({ ...p, detail: `${label ? `[${label}] ` : ''}${p.detail}` });
      return s;
    },
    async idle(limit = ctx.busyMs) {
      const until = Date.now() + limit; let s;
      while (Date.now() < until) { s = await snapshot(page).catch(() => null); if (!s || !s.busy.length) return true; await sleep(500); }
      problems.push({ kind: 'stuck-busy', detail: `${s.busy.join(', ')} still showing after ${Math.round(limit / 1000)} s` });
      return false;
    },
    text: () => page.evaluate(() => document.body.innerText),
  };
  try { await body(t); } catch (e) { problems.push({ kind: 'harness', detail: String(e.stack || e).slice(0, 500) }); }
  if (process.env.STRESS_VERBOSE) console.log(steps.map(x => `  ${x}`).join('\n'));
  if (problems.length) await ctx.recorder.fail(page, { where: ctx.name, problems, steps, scenario: ctx.name, server });
  await context.close().catch(() => {});
  await server.stop();
  server.setModel({}); server.setStore({});
}

// ---- pane helpers -----------------------------------------------------------------------------------------------
async function pane(t, seed, key) {
  // The pane is ready once it has looked the document up in the store (or failed to).
  const identified = t.page.waitForResponse(r => r.url().includes('/api/v2/store/pane/open'), { timeout: 20_000 }).catch(() => null);
  await openPane(t.page, t.server.url, seed, key || Math.random().toString(36).slice(2));
  await identified;
  t.step(`open ${seed.name} in the Word pane`);
  await t.page.locator('.start button.primary').waitFor({ timeout: 15_000 });
  await t.page.waitForFunction(() => !document.querySelector('.primary--busy'), null, { timeout: 15_000 }).catch(() => {});
}
async function review(t, { wait = 30_000 } = {}) {
  const p = t.page;
  if (await p.locator('#tab-review[aria-selected=false]').count()) { await p.locator('#tab-review').click(); t.step('open the Review tab'); }
  await p.waitForFunction(() => !document.querySelector('.primary--busy'), null, { timeout: 15_000 }).catch(() => {});
  await sleep(400); // the playbook is inferred once the list arrives
  const radios = p.locator('.pane__books button[role=radio]');
  if (await radios.count() && !(await p.locator('.pane__books button[aria-checked=true]').count())) { await radios.first().click(); t.step('choose the first playbook'); }
  await p.locator('.start button.primary').click(); t.step('click Review');
  await p.waitForFunction(() => document.querySelector('.points') || (document.querySelector('.pane__error') && !document.querySelector('.primary--busy')), null, { timeout: wait }).catch(() => {});
}
async function ask(t, q = 'What did they change in this draft?') {
  await t.page.locator('input[aria-label="Ask about this draft"]').fill(q);
  await t.page.locator('button[aria-label=Ask]').click(); t.step(`ask “${q.slice(0, 50)}”`);
}
const lastEntry = t => t.page.locator('article.qa').last();
async function settled(t, timeout = 30_000) { await sleep(200); await t.page.waitForFunction(() => !document.querySelector('[aria-label=Progress]'), null, { timeout }).catch(() => {}); }
async function errorText(t) { return (await t.page.locator('.pane__error, .page-error').allTextContents()).join(' | '); }
async function firstDocId(page) { return page.evaluate(async () => (await (await fetch('/api/v2/store/documents?pageSize=5')).json()).results?.[0]?.id); }
async function docAsk(t, page, id, q = 'What is the term?') {
  await page.goto(`${t.server.url}/#/documents/${id}`); t.step(`open document ${id} at 1440 px`);
  await page.locator('[aria-label="Document actions"] button', { hasText: 'Ask' }).click();
  await page.locator('input[aria-label=Question]').fill(q); await page.locator('input[aria-label=Question]').press('Enter'); t.step(`ask “${q}” on the Document page`);
  await sleep(300);
  await page.waitForFunction(() => !/Asking…/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
}

/** A model fault in the pane, for review and for Ask: plain words, no stuck state, and the next attempt works. */
function modelFault(mode, { reviewOk = false, askOk = false } = {}) {
  return ctx => session(ctx, {}, async t => {
    t.allowHttp(/http-50[02] POST \/api\/(review|ask)/, /http-400 POST \/api\/ask/);
    await pane(t, await fixtureSeed(NDA));
    t.server.setModel({ review: mode, ask: mode, revise: mode }); t.step(`the model answers “${mode}”`);
    await review(t);
    await t.idle(); await t.check('review');
    const reviewed = await t.page.locator('.points').count();
    if (reviewOk) t.expect(reviewed, `a review answered “${mode}” should still show its points; saw: ${await errorText(t)}`);
    else t.expect(reviewed || (await errorText(t)).length, 'a failed review should say why; nothing shown');
    await ask(t); await settled(t); await t.idle(); await t.check('ask');
    const entry = lastEntry(t);
    const answered = await entry.locator('.qa__a').count();
    if (askOk) t.expect(answered, `Ask answered “${mode}” should show the answer; saw: ${await entry.textContent()}`);
    else t.expect(answered || await entry.locator('.pane__error').count(), `a failed Ask should say why in the thread; saw: ${await entry.textContent()}`);
    // Recovery: the model is back; review and Ask work.
    t.server.setModel({}); t.step('the model answers normally again');
    if (!reviewed) { await review(t); t.expect(await t.page.locator('.points').count(), `Review after the fault did not work: ${await errorText(t)}`); }
    await ask(t, 'Summarise the key terms'); await settled(t); await t.check('after recovery');
    t.expect(await lastEntry(t).locator('.qa__a').count(), `Ask after the fault did not answer: ${await lastEntry(t).textContent()}`);
    // The same on the Document page's Ask (one JSON answer, no stream).
    t.server.setModel({ ask: mode });
    const id = await firstDocId(t.page);
    if (id) { await t.page.setViewportSize({ width: 1440, height: 900 }); await docAsk(t, t.page, id); await t.idle(); await t.check('document page ask'); }
  });
}

// ---- the scenarios ----------------------------------------------------------------------------------------------
export const SCENARIOS = {
  'model-prose': modelFault('prose', { askOk: true }),
  'model-fenced': modelFault('fenced', { reviewOk: true, askOk: true }),
  'model-truncated': modelFault('truncated', { askOk: true }),
  'model-empty': modelFault('empty'),
  'model-huge': modelFault('huge', { reviewOk: true, askOk: true }),
  'model-fail': modelFault('fail'),
  'model-errored': modelFault('errored'),

  'model-slow': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(NDA));
    t.server.setModel({ ask: 'slow', review: 'slow', delayMs: 32_000 }); t.step('the model takes 32 s');
    await ask(t);
    await sleep(4000);
    const s = await t.check('slow ask, 4 s in');
    t.expect(s?.busy.includes('progress'), 'no progress shown 4 s into a slow Ask');
    const steps = await t.page.locator('.progress .step').allTextContents();
    t.expect(steps.length >= 1, `progress shows no step while the model works: ${steps.join(' / ')}`);
    t.expect(/\d+ s/.test(await t.page.locator('.progress__time').textContent().catch(() => '')), 'no elapsed time on a slow Ask');
    await settled(t, 60_000); await t.check('slow ask done');
    t.expect(await lastEntry(t).locator('.qa__a').count(), `slow Ask did not answer: ${await lastEntry(t).textContent()}`);
    await t.page.locator('#tab-review').click();
    await review(t, { wait: 60_000 }); await t.idle(); await t.check('slow review');
    t.expect(await t.page.locator('.points').count(), `slow review did not finish: ${await errorText(t)}`);
  }),

  'ask-hang-stop': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(NDA));
    t.server.setModel({ ask: 'hang' }); t.step('the model never answers');
    await ask(t); await sleep(2500);
    await t.page.locator('button[aria-label=Stop]').click(); t.step('click Stop');
    await settled(t, 5000); await t.idle(5000); await t.check('after Stop');
    t.expect(/Stopped/.test(await lastEntry(t).textContent()), 'the stopped question does not say Stopped');
    await sleep(1500);
    const kids = spawnSync('pgrep', ['-P', String(t.server.child.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      .filter(pid => /model-stub/.test(spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout));
    t.expect(!kids.length, `model process still running after Stop: ${kids.join(', ')}`);
    t.server.setModel({}); await ask(t, 'Summarise the key terms'); await settled(t); await t.check('ask after Stop');
    t.expect(await lastEntry(t).locator('.qa__a').count(), 'Ask after Stop did not answer');
  }),

  'review-hang': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(NDA));
    t.server.setModel({ review: 'hang' }); t.step('the model never answers a review');
    await review(t, { wait: 3000 });
    const s = await t.check('review hanging');
    t.expect(s?.busy.some(b => b.startsWith('busy:Reviewing')), 'a hanging review shows no Reviewing state');
    const stop = t.page.locator('.start button[aria-label=Stop]');
    if (!t.expect(await stop.count(), 'a review that never ends cannot be stopped: no Stop beside Reviewing')) return;
    await stop.click(); t.step('click Stop');
    await t.idle(5000); await t.check('after Stop');
    t.expect(/Review stopped\./.test(await t.text()), 'the stopped review does not say "Review stopped."');
    t.expect(await t.page.locator('.start button.primary').isEnabled().catch(() => false), 'after Stop the pane is still blocked by the hanging review');
    await sleep(1500);
    const kids = spawnSync('pgrep', ['-P', String(t.server.child.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
      .filter(pid => /model-stub/.test(spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout));
    t.expect(!kids.length, `model process still running after Stop: ${kids.join(', ')}`);
    t.server.setModel({}); await review(t); await t.idle(); await t.check('review after Stop');
    t.expect(await t.page.locator('.points').count(), `the review after Stop did not finish: ${await errorText(t)}`);
  }),

  'review-blocks-server': ctx => session(ctx, {}, async t => {
    // Without the store the review is the single call; it runs the CLI without blocking (17 Oct 2026), so the server
    // answers other requests while the model works.
    await pane(t, await fixtureSeed(NDA));
    t.allowHttp(/http-5\d\d/);
    t.server.setStore({ down: true }); t.server.setModel({ review: 'slow', delayMs: 8000 }); t.step('the store is down; the model takes 8 s to review');
    await t.page.locator('.start button.primary').click(); t.step('click Review'); await sleep(1500);
    const started = Date.now();
    const answered = await fetch(`${t.server.url}/api/status`, { signal: AbortSignal.timeout(4000) }).then(r => r.ok, () => false);
    const ms = Date.now() - started;
    t.step(`GET /api/status while the review runs: ${answered ? `answered in ${ms} ms` : 'no answer in 4 s'}`);
    t.expect(answered && ms < 1500, `a review without the store (the single model call) blocks the server: GET /api/status ${answered ? `took ${ms} ms` : 'got no answer in 4 s'} while the model worked`);
    await t.page.waitForFunction(() => document.querySelector('.points') || document.querySelector('.pane__error'), null, { timeout: 30_000 }).catch(() => {});
    await t.idle(); await t.check('after the review');
    t.expect(await t.page.locator('.points').count(), `the slow review did not finish: ${await errorText(t)}`);
  }),

  'store-down': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(ORDER));
    t.allowHttp(/http-5\d\d/);
    t.server.setStore({ down: true }); t.step('the store goes down');
    await review(t); await t.idle(); await t.check('review, store down');
    t.expect(await t.page.locator('.points').count(), `a review with the store down should run without it: ${await errorText(t)}`);
    await ask(t); await settled(t); await t.check('ask, store down');
    t.expect(await lastEntry(t).locator('.qa__a').count(), `Ask with the store down should still answer: ${await lastEntry(t).textContent()}`);
    await t.page.setViewportSize({ width: 1440, height: 900 });
    for (const h of ['#/inbox', '#/library', '#/documents/1', '#/trash', '#/activity']) { await t.page.goto(`${t.server.url}/${h}`); t.step(`open ${h}`); await t.page.waitForLoadState('networkidle').catch(() => {}); await sleep(300); await t.check(h); }
    t.server.setStore({}); t.step('the store is back');
    await t.page.goto(`${t.server.url}/#/library`); await t.page.waitForLoadState('networkidle').catch(() => {}); await sleep(300);
    await t.check('library after recovery');
    t.expect(await t.page.locator('.trow--library:not(.trow--head)').count(), 'the Library is empty after the store came back');
  }),

  'store-raw-errors': ctx => session(ctx, { viewport: { width: 1440, height: 900 } }, async t => {
    t.allowHttp(/http-4\d\d/, /http-5\d\d/);
    await t.page.goto(`${t.server.url}/#/inbox`); await t.page.waitForLoadState('networkidle');
    t.server.setStore({ raw: true }); t.step('every store call fails with the raw message Paperless gives');
    for (const h of ['#/inbox', '#/library', '#/documents/1', '#/trash', '#/activity']) { await t.page.goto(`${t.server.url}/${h}`); t.step(`open ${h}`); await t.page.waitForLoadState('networkidle').catch(() => {}); await sleep(300); await t.check(h); }
    await t.page.goto(`${t.server.url}/#/library`); await t.page.locator('#lib-q').fill('a'.repeat(300)); await t.page.locator('#lib-q').press('Enter'); t.step('search for 300 characters');
    await sleep(500); await t.check('library search');
    await t.page.setViewportSize({ width: 380, height: 860 });
    await pane(t, await fixtureSeed(NDA)); await review(t); await t.idle(); await t.check('pane review');
    await ask(t); await settled(t); await t.check('pane ask');
  }),

  'store-task-failures': ctx => session(ctx, { viewport: { width: 1440, height: 900 } }, async t => {
    await t.page.goto(`${t.server.url}/#/inbox`); await t.page.waitForLoadState('networkidle');
    t.server.setStore({ failTasks: 'Not consumed: {"error": "document_consumer.ConsumerError: Unsupported mime type text/plain", "traceback": "File /usr/src/paperless/src/documents/consumer.py"}' });
    t.step('the store fails every upload task with its raw error');
    await t.page.locator('input[type=file][aria-label="Add files"]').setInputFiles([{ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('A note about the NDA term.') }]); t.step('upload note.txt');
    await t.page.waitForFunction(() => /Not added/.test(document.body.innerText), null, { timeout: 10_000 }).catch(() => {});
    await t.idle(15_000); await t.check('failed upload');
    t.expect(/Not added/.test(await t.text()), 'a failed upload does not say it was not added');
    const dismiss = t.page.locator('.li--processing button'); if (await dismiss.count()) { await dismiss.first().click(); t.step('dismiss it'); await sleep(500); await t.check('dismissed'); }
  }),

  'duplicate-uploads': ctx => session(ctx, { viewport: { width: 1440, height: 900 } }, async t => {
    await t.page.goto(`${t.server.url}/#/inbox`); await t.page.waitForLoadState('networkidle');
    const file = { name: 'helix-brightwater-nda-v1.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: readFileSync(path.join(FIXTURES, 'history/helix-brightwater-nda-v1.docx')) };
    const input = t.page.locator('input[type=file][aria-label="Add files"]');
    await input.setInputFiles([file, file]); t.step('upload the same file twice at once');
    await sleep(300); await input.setInputFiles([file]); t.step('upload it a third time');
    await t.page.waitForFunction(() => document.querySelectorAll('.inbox__list button.li').length >= 3 && !/Processing/.test(document.querySelector('.inbox__list').innerText), null, { timeout: 15_000 }).catch(() => {});
    await t.idle(15_000); await t.check('three copies');
    t.expect((await t.page.locator('.inbox__list button.li', { hasText: 'Duplicate' }).count()) >= 2, 'copies of the same file are not flagged Duplicate');
    for (let i = 0; i < 3; i++) { const b = t.page.locator('.inbox__detail .actions button.primary'); if (!await b.count()) break; await b.dblclick(); t.step('double-click Done'); await sleep(600); await t.check(`done ${i + 1}`); }
    await t.page.goto(`${t.server.url}/#/library`); await t.page.waitForLoadState('networkidle'); await sleep(300);
    await t.check('library');
    t.expect(/3 copies/.test(await t.text()), 'the Library does not show one row with 3 copies');
  }),

  'long-document': ctx => session(ctx, {}, async t => {
    t.server.setModel({ findings: 60 });
    await pane(t, await syntheticSeed('stress-long', SYNTHETIC.long()));
    await review(t, { wait: 60_000 }); await t.idle(); await t.check('reviewed');
    t.expect(await t.page.locator('.points > li').count() >= 30, 'a long document with 60 findings shows fewer than 30 points');
    for (let i = 0; i < 4; i++) {
      const apply = t.page.locator('.point__actions button.primary'); if (!await apply.count()) break;
      await apply.click(); t.step(`apply point ${i + 1}`);
      await sleep(300);
      await t.page.waitForFunction(() => !/Applying…/.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
      await t.check(`apply ${i + 1}`);
      const err = await errorText(t);
      if (err) { t.step(`saw: ${err}`); await t.page.locator('.point__actions button.quiet').first().click().catch(() => {}); await t.page.locator('.point__why-dismiss button').first().click().catch(() => {}); }
    }
    await t.page.evaluate(() => window.__word.selectText(5, window.__word.texts()[5].slice(0, 300))); t.step('select 300 characters in Word');
    await ask(t, 'Explain this'); await settled(t); await t.check('ask about a long selection');
    t.expect(await lastEntry(t).locator('.qa__a').count(), `Ask about a long selection did not answer: ${await lastEntry(t).textContent()}`);
    const show = lastEntry(t).locator('.qa__more button').first();
    if (await show.count()) { await show.click(); await lastEntry(t).locator('.source button').first().click().catch(() => {}); t.step('show a long quote in the document'); await sleep(800); await t.check('show in document'); }
  }),

  'empty-document': ctx => session(ctx, {}, async t => {
    await pane(t, await syntheticSeed('stress-empty', SYNTHETIC.empty()));
    await t.check('opened');
    if (await t.page.locator('.start button.primary').isEnabled().catch(() => false)) { await review(t); await t.idle(); await t.check('review'); }
    await ask(t); await settled(t); await t.idle(); await t.check('ask');
    const text = await lastEntry(t).textContent();
    t.expect(/\w/.test(text.replace('What did they change in this draft?', '')), `Ask on an empty document shows nothing: ${text}`);
  }),

  'unicode-document': ctx => session(ctx, {}, async t => {
    await pane(t, await syntheticSeed('stress-unicode Ünïcödé 合同', SYNTHETIC.unicode()));
    await review(t); await t.idle(); await t.check('review');
    t.expect(await t.page.locator('.points').count(), `review of a unicode document failed: ${await errorText(t)}`);
    for (let i = 0; i < 3; i++) { const a = t.page.locator('.point__actions button.primary'); if (!await a.count()) break; await a.click(); t.step(`apply point ${i + 1}`); await sleep(800); await t.check(`apply ${i + 1}`); const e = await errorText(t); if (e) { t.step(`saw: ${e}`); break; } }
    await t.page.evaluate(() => window.__word.selectText(4, 'shall pay £1,000,000 within thirty (30) days 📄✅')); t.step('select text with emoji in Word');
    await ask(t, 'ما هي مدة السرية؟ 🤔'); await settled(t); await t.check('ask');
    t.expect(await lastEntry(t).locator('.qa__a').count(), 'Ask in Arabic about an emoji selection did not answer');
  }),

  'table-answer': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(NDA));
    t.server.setModel({ ask: 'tableask' });
    await ask(t, 'Tabulate every term'); await settled(t); await t.check('wide table');
    t.server.setModel({});
    await ask(t, 'Compare in a table'); await settled(t); await t.check('table');
  }),

  'many-findings': ctx => session(ctx, {}, async t => {
    t.server.setModel({ findings: 55 });
    await pane(t, await syntheticSeed('stress-many', SYNTHETIC.long().slice(0, 120)));
    await review(t, { wait: 60_000 }); await t.idle(); await t.check('reviewed');
    const n = await t.page.locator('.points > li').count();
    t.expect(n >= 50, `55 findings show as ${n} points`);
    for (let i = 0; i < n + 2; i++) {
      const d = t.page.locator('.point__actions button.quiet');
      if (!await d.count()) { const r = t.page.locator('button.prow'); if (!await r.count()) break; await r.first().click(); continue; }
      await d.first().click(); await t.page.locator('.point__why-dismiss button').first().click();
    }
    t.step(`dismiss every point (${n})`); await sleep(500); await t.check('all dismissed');
    t.expect(await t.page.locator('.save-reply button').count(), 'with every point done there is no Save as our reply');
    await sleep(800); await t.page.reload(); t.step('reload the pane'); await t.page.locator('.points').waitFor({ timeout: 10_000 }).catch(() => {}); await sleep(800);
    const s = await t.check('after reload');
    t.expect(s && new RegExp(`Review · ${n} of ${n}`).test(s.tab), `after a reload the review is not ${n} of ${n} done: ${s?.tab}`);
  }),

  'two-asks': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(NDA));
    t.server.setModel({ delayMs: 2000 });
    const input = t.page.locator('input[aria-label="Ask about this draft"]');
    await input.fill('First question'); await input.press('Enter');
    await input.fill('Second question'); await input.press('Enter'); t.step('ask two questions back to back');
    await t.page.locator('.askchip, .chips .chip').first().click({ timeout: 1000 }).catch(() => {}); t.step('click a suggested question while it works');
    const other = await t.context.newPage(); watch(other, t.sink); await other.setViewportSize({ width: 1440, height: 900 });
    await other.goto(`${t.server.url}/#/library`); const id = await firstDocId(other);
    if (id) await docAsk(t, other, id, 'Same time?');
    await settled(t); await t.idle(); await t.check('both answered');
    t.expect(!(await t.page.locator('article.qa .pane__error').count()), `two quick asks: ${await t.page.locator('.pane').textContent()}`);
    if (id) t.expect(await other.locator('[aria-label=Answer]').count(), 'the Document page ask in the other tab did not answer');
    await other.close();
  }),

  'stop-mid-stream': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(ORDER));
    t.server.setModel({ ask: 'slow', delayMs: 20_000 });
    await ask(t); await t.page.locator('.progress .step--done').first().waitFor({ timeout: 8000 }).catch(() => {});
    t.step(`steps shown: ${(await t.page.locator('.progress .step').allTextContents()).join(' / ')}`);
    await t.page.locator('button[aria-label=Stop]').click(); t.step('Stop while steps stream');
    await settled(t, 5000); await t.idle(5000); await t.check('stopped');
    t.server.setModel({});
    await ask(t, 'Again'); await settled(t); await t.check('ask again');
    t.expect(await lastEntry(t).locator('.qa__a').count(), 'Ask after a mid-stream Stop did not answer');
    await sleep(800); await t.page.reload(); t.step('reload'); await sleep(1500);
    await t.page.locator('#tab-ask').click(); await t.check('after reload');
    t.expect(await t.page.locator('article.qa').count() >= 2, `the Ask history is not kept across a reload (${await t.page.locator('article.qa').count()} entries)`);
  }),

  'reload-mid-ask': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(NDA));
    t.server.setModel({ ask: 'slow', delayMs: 8000 });
    await ask(t); await sleep(1500);
    await t.page.reload(); t.step('reload the pane while Ask works');
    await t.page.locator('.start button.primary, .points').first().waitFor({ timeout: 10_000 });
    await t.page.locator('#tab-ask').click(); await sleep(500);
    await t.check('after reload'); await t.idle(15_000);
    t.server.setModel({});
    await ask(t, 'After the reload'); await settled(t); await t.check('ask after reload');
    t.expect(await lastEntry(t).locator('.qa__a').count(), 'Ask after reloading mid-ask did not answer');
  }),

  'progress-network-errors': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(ORDER));
    // The webview holds the stream back until it ends (route.fetch reads the whole body), and the progress endpoint fails.
    await t.page.route('**/api/ask', async route => { const r = await route.fetch(); await route.fulfill({ response: r, body: await r.body() }); });
    t.allowHttp(/requestfailed.*\/api\/ask/);
    let failing = true;
    await t.page.route('**/api/ask/progress/**', route => (failing ? route.abort('connectionreset') : route.continue()));
    t.server.setModel({ ask: 'slow', delayMs: 9000 });
    await ask(t); await sleep(4000); await t.check('progress failing');
    t.sink.splice(0);
    t.expect((await t.page.locator('.progress').count()) === 1, 'no progress line while the progress endpoint fails');
    failing = false; t.step('the progress endpoint answers again'); await sleep(3000);
    const steps = await t.page.locator('.progress .step--done').allTextContents();
    t.expect(steps.length >= 1, `a held-back stream shows no finished step from polling: ${(await t.page.locator('.progress').textContent().catch(() => '')).slice(0, 200)}`);
    await settled(t); await t.check('answered');
    t.expect(await lastEntry(t).locator('.qa__a').count(), 'held-back stream: no answer');
    await t.page.unroute('**/api/ask'); await t.page.route('**/api/ask', route => route.abort('connectionreset'));
    t.server.setModel({});
    await ask(t, 'Network down'); await settled(t, 10_000); await t.idle(10_000); t.sink.splice(0); await t.check('ask network error');
    t.expect(await lastEntry(t).locator('.pane__error').count(), 'a network error on Ask shows no message in the thread');
  }),

  'store-identity': ctx => session(ctx, {}, async t => {
    // The pane names the document that is open: two documents of one counterparty in two panes, then the first again.
    const a = await fixtureSeed('history/helix-brightwater-nda-v2-bw-markup.docx'), b = await fixtureSeed(NDA);
    const title = async p => (await p.locator('.pane__doc').textContent()).trim();
    await pane(t, a, 'a'); await sleep(1000); const ta = await title(t.page); t.step(`pane names “${ta}”`); await t.check('A');
    const second = await t.context.newPage(); watch(second, t.sink);
    await openPane(second, t.server.url, b, 'b'); await second.locator('.start button.primary').waitFor(); await sleep(1500);
    const tb = await title(second); t.step(`open ${b.name} in a second pane: “${tb}”`);
    t.expect(tb !== ta, `two different documents show the same store document “${ta}”`);
    t.expect(/v3|counter/i.test(tb), `the second pane names “${tb}” for ${b.name}`);
    await second.close();
    await t.page.reload(); await t.page.locator('.start button.primary').waitFor(); await sleep(1500);
    t.expect(await title(t.page) === ta, `reopening ${a.name} names “${await title(t.page)}”, not “${ta}”`);
    await t.check('identity');
  }),

  'same-url-new-document': ctx => session(ctx, {}, async t => {
    // A new version saved over the old file (same name, same place: Word's URL is the same) is a different document.
    const url = 'https://contoso.sharepoint.test/Shared/Agreement.docx';
    const a = await fixtureSeed('history/helix-brightwater-nda-v2-bw-markup.docx', { url }), b = await fixtureSeed(ORDER, { url });
    await pane(t, a, 'same'); await review(t); await t.idle();
    const ta = (await t.page.locator('.pane__doc').textContent()).trim(); t.step(`pane names “${ta}” and has a review`);
    await sleep(800);
    const second = await t.context.newPage(); watch(second, t.sink);
    const identified = second.waitForResponse(r => r.url().includes('/api/v2/store/pane/open'), { timeout: 10_000 }).catch(() => null);
    await openPane(second, t.server.url, b, 'same'); await identified; await second.locator('.pane').waitFor(); await sleep(1500);
    const tb = (await second.locator('.pane__doc').textContent()).trim();
    t.step(`open ${b.name} saved at the same place: the pane names “${tb}”`);
    const stored = await second.evaluate(async () => (await (await fetch('/api/v2/store/documents?pageSize=50')).json()).count);
    t.expect(stored === 2, `a different document at the same URL was not added to the store as its own document (${stored} in the store)`);
    t.expect(!(await second.locator('.points').count()), 'a different document at the same URL opens with the earlier document’s review');
    await second.close();
  }),

  'state-survives-reload': ctx => session(ctx, {}, async t => {
    await pane(t, await fixtureSeed(ORDER));
    await review(t); await t.idle();
    await t.page.locator('.point__actions button.quiet').first().click(); await t.page.locator('.point__why-dismiss button').first().click(); t.step('dismiss the first point');
    await ask(t); await settled(t);
    const before = await t.check('before reload');
    await sleep(800); await t.page.reload(); t.step('reload');
    await t.page.locator('.points').waitFor({ timeout: 10_000 }).catch(() => {});
    const after = await t.check('after reload');
    t.expect(after?.tab === before?.tab, `the review is not restored: “${before?.tab}” before, “${after?.tab}” after`);
    await t.page.locator('#tab-ask').click();
    t.expect(await t.page.locator('article.qa .qa__a').count() >= 1, 'the Ask history is not restored after a reload');
  }),

  'team-server-gone': async ctx => {
    const { testTls } = await import('../fixtures/test-tls.js');
    const TLS = testTls();
    const data = mkdtempSync(path.join(tmpdir(), 'gcl-stress-team-'));
    writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ mode: 'server', server: { listen: '127.0.0.1:0', publicUrl: 'https://localhost', tls: { certFile: path.join(TLS, 'server.crt'), keyFile: path.join(TLS, 'server.key') } }, store: { mode: 'fake' } }));
    const issued = spawnSync(process.execPath, ['bin/gcl.js', '--data', data, 'admin', 'issue-code', '--for', 'Ada Admin', '--admin'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH } });
    const code = /: ([0-9A-Z]{26})$/m.exec(issued.stdout)?.[1];
    const emptyPath = mkdtempSync(path.join(tmpdir(), 'gcl-stress-path-')); // the team server refuses to run beside a model CLI
    const team = spawn(process.execPath, ['--import', path.join(STRESS, 'store-faults.mjs'), 'server/team-server.js', '--data', data], { cwd: ROOT, env: { PATH: emptyPath, GCL_STRESS_STORE_FAULTS: ctx.run.faults }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; team.stdout.on('data', d => { out += d; }); team.stderr.on('data', d => { out += d; });
    const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`team server: ${out}`)), 30_000); team.stdout.on('data', () => { const m = /ready at https:\/\/[^:]+:(\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } }); });
    try {
      await session(ctx, { viewport: { width: 1440, height: 900 } }, async t => {
        t.allowHttp(/http-\d\d\d/);
        await t.page.goto(`${t.server.url}/#/settings/team`);
        const form = t.page.getByRole('form', { name: 'Join a team' });
        await form.getByLabel('Server address').fill(`https://localhost:${port}`); await form.getByLabel('Setup code').fill(code);
        await form.getByLabel('Device name').fill('Stress Mac'); await form.getByLabel('CA file').fill(path.join(TLS, 'ca.crt'));
        await form.getByRole('button', { name: 'Join' }).click(); t.step('join the team');
        await t.page.waitForFunction(() => /Ada Admin|Leave/.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
        await t.check('joined');
        t.expect(/Ada Admin|Leave/.test(await t.text()), `joining the team did not work: ${(await t.text()).slice(0, 300)}`);
        await t.page.setViewportSize({ width: 380, height: 860 });
        await pane(t, await fixtureSeed(ORDER)); await review(t); await t.idle(); await t.check('team review');
        team.kill('SIGKILL'); t.step('the team server goes away');
        await sleep(500);
        await ask(t); await settled(t); await t.idle(); await t.check('ask, team gone');
        await t.page.locator('#tab-review').click();
        const d = t.page.locator('.point__actions button.quiet');
        if (await d.count()) { await d.first().click(); await t.page.locator('.point__why-dismiss button').first().click(); t.step('dismiss a point'); await sleep(800); await t.check('dismiss, team gone'); }
        await t.page.reload(); t.step('reload the pane'); await sleep(3000); await t.idle(20_000); await t.check('pane reload, team gone');
        await t.page.setViewportSize({ width: 1440, height: 900 });
        for (const h of ['#/inbox', '#/library', '#/playbook', '#/documents/1', '#/trash', '#/settings/team', '#/admin']) { await t.page.goto(`${t.server.url}/${h}`); t.step(`open ${h}`); await t.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}); await sleep(500); await t.idle(20_000); await t.check(h); }
      });
    } finally { team.kill('SIGKILL'); }
  },
};
