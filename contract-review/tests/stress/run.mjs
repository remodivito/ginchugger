#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The stress and click-through harness (npm run stress; not part of npm test or the e2e run). For each seed: a fresh app
// server (its own port and state folder, the in-memory store, the model stub), the Word pane at 380 px over the Office
// fake and the pages at 1440 px, each driven by the seeded monkey for --steps steps with the invariants checked after
// every step and a drain at the end (no busy state may outlive --busy-ms). Then the named fault scenarios
// (tests/stress/scenarios.mjs). Failures go to .local/stress/REPORT.md with seed, steps, screenshot and DOM text.
//
//   npm run stress                                  default seeds and every scenario
//   npm run stress -- --seeds 1,2,3 --steps 80      these seeds, 80 steps per surface
//   npm run stress -- --seeds 20                    seeds 1..20
//   npm run stress -- --seeds none --scenarios model-prose,store-down
//   npm run stress -- --chaos                       the monkey also flips the model and the store into fault modes
//   options: --busy-ms 60000  --no-build  --headed  --list
import { chromium } from '@playwright/test';
import path from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build, makeRunDir, startApp, rng, fixtureSeed, syntheticSeed, FIXTURE_DOCS, SYNTHETIC, openPane, snapshot, check, watch, Recorder, stopAll, FIXTURES, sleep, OUT } from './harness.mjs';
import { monkey, paneActions, pageActions } from './monkey.mjs';
import { SCENARIOS } from './scenarios.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i < 0 ? def : argv[i + 1]; };
const flag = name => argv.includes(`--${name}`);
const DEFAULT_SEEDS = [1, 2, 3, 4, 5, 6];
const seedsArg = opt('seeds', null);
const seeds = seedsArg === 'none' ? [] : !seedsArg ? DEFAULT_SEEDS : /^\d+$/.test(seedsArg) ? Array.from({ length: Number(seedsArg) }, (_, i) => i + 1) : seedsArg.split(',').map(Number);
const steps = Number(opt('steps', 60));
const busyMs = Number(opt('busy-ms', 60_000));
const scenarioArg = opt('scenarios', 'all');
const scenarios = scenarioArg === 'none' ? [] : scenarioArg === 'all' ? Object.keys(SCENARIOS) : scenarioArg.split(',');
if (flag('list')) { console.log(Object.keys(SCENARIOS).join('\n')); process.exit(0); }
for (const s of scenarios) if (!SCENARIOS[s]) { console.error(`Unknown scenario ${s}. --list shows them.`); process.exit(2); }

const recorder = new Recorder();
// Requests that fail by design: the fake store's thumbnail is not an image; the about page reads status.
const EXPECTED_HTTP = [/GET \/api\/v2\/store\/documents\/\d+\/thumb/, /GET \/api\/v2\/store\/documents\/(999999|abc)\b/, /GET \/api\/playbook\?id=nope/];

/** Run one surface: a page with the invariants after each step and the drain at the end. */
async function surface(browser, { name, seed, server, viewport, open, actions, chaos }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const sink = []; watch(page, sink);
  const log = [], problems = [];
  const ctx = { busyMs, busySince: new Map(), settled: false, allowRaw: [] };
  // Product copy that names the model setup (Settings, About): the executor's name is what the lawyer chose there.
  const allowFor = hash => (/^#\/(settings|about|admin)/.test(hash) ? [/Claude CLI|Paperless|\/var\/|\/Users\/|\/tmp\/|gcl-stress|secrets\.json/] : []);
  const r = rng(seed * 7919 + (name.includes('pane') ? 1 : 2));
  let failures = 0;
  const report = async (where, list) => { failures++; await recorder.fail(page, { where, problems: list, steps: log, seed, server }); };
  try {
    log.push(await open(page, r));
    await page.waitForLoadState('networkidle').catch(() => {});
    const env = { server, chaos };
    await monkey(page, r, actions(env), steps, log, async () => {
      await sleep(120);
      ctx.settled = false;
      const s = await snapshot(page).catch(() => null); if (!s) return;
      ctx.allowRaw = allowFor(s.hash);
      const events = sink.splice(0);
      // By design: a document reached again by Back or a typed link, or re-read when the pane is back on Review, may be in
      // the trash by now; a file that is not .docx
      // opened as the agreement is refused in words.
      const last = log[log.length - 1] || '';
      const byDesign = e => (e.kind === 'http-404' && /\/api\/v2\/store\/documents\/\d+$/.test(e.detail) && /^(browser back|go to|reload|click “Review”)/.test(last)) || (e.kind === 'http-400' && /POST \/api\/documents\/import/.test(e.detail) && /\.txt in the browser/.test(last));
      const badHttp = events.filter(e => e.kind.startsWith('http-') && !(EXPECTED_HTTP.some(x => x.test(e.detail)) || byDesign(e) || (chaos && /^http-(4\d\d|50[23])$/.test(e.kind))));
      // A console "Failed to load resource" line is the browser's echo of a response already judged above.
      const found = [...check(s, ctx), ...badHttp, ...events.filter(e => !e.kind.startsWith('http-') && !(e.kind === 'console' && /Failed to load resource/.test(e.detail) && !badHttp.length))];
      // Counts are compared only once the page is quiet (no request in flight for a moment).
      if (s.inboxRows !== null) { await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); ctx.settled = true; const again = await snapshot(page).catch(() => null); if (again) found.push(...check(again, ctx).filter(p => p.kind === 'count')); }
      problems.push(...found);
      if (found.length) await report(`${name} step ${log.length}`, found);
    });
    // Drain: every busy state must end within busyMs once the actions stop (the model is put back to normal first).
    server.setModel({}); server.setStore({});
    const until = Date.now() + busyMs + 5000;
    let s;
    while (Date.now() < until) { s = await snapshot(page).catch(() => null); if (!s || !s.busy.length) break; await sleep(1000); }
    if (s?.busy.length) { log.push(`wait for the busy state to end (${busyMs / 1000} s)`); await report(`${name} drain`, [{ kind: 'stuck-busy', detail: `${s.busy.join(', ')} still showing ${busyMs / 1000} s after the last action` }]); }
  } catch (e) {
    await report(`${name} harness`, [{ kind: 'harness', detail: String(e.stack || e).slice(0, 500) }]);
  } finally { await context.close().catch(() => {}); }
  recorder.runs.push({ name: `seed ${seed} ${name}`, steps: log.length, failures });
  // Every step of every run, for reproducing by hand what a seed did.
  mkdirSync(path.join(OUT, 'logs'), { recursive: true });
  writeFileSync(path.join(OUT, 'logs', `seed-${seed}-${name.replace(/\s+/g, '-')}.txt`), log.map((l, i) => `${i + 1}. ${l}`).join('\n') + '\n');
  return failures;
}

async function seedStore(server) {
  const form = new FormData();
  for (const f of ['history/helix-brightwater-nda-v1.docx', 'history/helix-brightwater-nda-v2-bw-markup.docx', 'history/2026-05-19-brightwater-returns-markup.eml', 'order-form/helix-northgate-order-form-v1.docx', 'order-form/policy-note.txt'])
    form.append('file', new Blob([readFileSync(path.join(FIXTURES, f))]), path.basename(f));
  await fetch(`${server.url}/api/v2/store/documents`, { method: 'POST', body: form });
  for (let i = 0; i < 50; i++) { const r = await (await fetch(`${server.url}/api/v2/store/inbox`)).json(); if (!(r.processing || []).some(p => !p.error)) return r; await sleep(100); }
}

async function main() {
  if (!flag('no-build')) build();
  const run = makeRunDir();
  const browser = await chromium.launch({ headless: !flag('headed') });
  const started = Date.now();
  try {
    for (const seed of seeds) {
      const server = await startApp(run);
      try {
        await seedStore(server);
        const r = rng(seed);
        const doc = r.weighted([...FIXTURE_DOCS.map(d => [d, 3]), ['synthetic:long', 1], ['synthetic:unicode', 1], ['synthetic:short', 1]]);
        const seedDoc = doc.startsWith('synthetic:') ? await syntheticSeed(`stress-${doc.slice(10)}`, SYNTHETIC[doc.slice(10)]()) : await fixtureSeed(doc);
        const chaos = flag('chaos');
        console.log(`seed ${seed}: pane on ${seedDoc.name}, then pages (port ${server.port})`);
        await surface(browser, { name: 'pane 380', seed, server, chaos, viewport: { width: 380, height: 860 }, actions: paneActions,
          open: async page => { await openPane(page, server.url, seedDoc, `seed${seed}`); return `open ${seedDoc.name} in the Word pane`; } });
        await surface(browser, { name: 'pages 1440', seed, server, chaos, viewport: { width: 1440, height: 900 }, actions: pageActions,
          open: async (page, rr) => { const start = rr.pick(['#/inbox', '#/library', '#/', '#/trash', '#/playbook', '#/settings', '#/about']); await page.goto(`${server.url}/${start}`); return `open the app at ${start}`; } });
      } finally { await server.stop(); server.setModel({}); server.setStore({}); }
    }
    for (const name of scenarios) {
      console.log(`scenario ${name}`);
      const before = recorder.failures.length;
      const t0 = Date.now();
      try { await SCENARIOS[name]({ browser, run, recorder, busyMs, name }); }
      catch (e) { recorder.failures.push({ id: `${name}-harness`, where: `${name} harness`, scenario: name, problems: [{ kind: 'harness', detail: String(e.stack || e).slice(0, 600) }], steps: [], shot: null, dom: '', serverLog: '' }); }
      recorder.runs.push({ name: `scenario ${name} (${Math.round((Date.now() - t0) / 1000)} s)`, steps: '-', failures: recorder.failures.length - before });
    }
  } finally { await browser.close().catch(() => {}); stopAll(); }
  const summary = `${seeds.length} seed(s) × ${steps} steps, ${scenarios.length} scenario(s), ${recorder.failures.length} failure(s), ${Math.round((Date.now() - started) / 1000)} s`;
  recorder.write({ summary, command: `npm run stress -- ${argv.join(' ')}`.trim(), seeds, steps, scenarios });
  console.log(`${summary}. Report: ${path.relative(process.cwd(), path.join(OUT, 'REPORT.md'))}`);
  process.exit(recorder.failures.length ? 1 : 0);
}
main().catch(e => { console.error(e); stopAll(); process.exit(1); });
