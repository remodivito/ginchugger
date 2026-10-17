// SPDX-License-Identifier: GPL-3.0-or-later
// The stress harness's plumbing (tests/stress): the app servers it starts (its own, on free ports, with the model stub
// and the faulty in-memory store), the documents it opens in the Office fake, the browser checks run after every step
// and the failures it collects for the report. No live model, Word or Paperless is ever reached.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffWordsWithSpace } from 'diff';
import { importDocx, exportDocx } from '../../server/docx.js';
import { installOfficeFake } from '../e2e/office-fake.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const STRESS = fileURLToPath(new URL('./', import.meta.url));
export const FIXTURES = path.join(ROOT, 'data/fixtures');
export const OUT = path.join(ROOT, '.local/stress');
const STUB = path.join(STRESS, 'model-stub.mjs');

// ---- a seeded random source -------------------------------------------------------------------------------------
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  const next = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = { next, int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)], chance: p => next() < p,
    weighted: items => { const total = items.reduce((n, [, w]) => n + w, 0); let x = next() * total; for (const [v, w] of items) { if ((x -= w) < 0) return v; } return items[items.length - 1][0]; } };
  return r;
}

// ---- servers ----------------------------------------------------------------------------------------------------
const temp = p => mkdtempSync(path.join(tmpdir(), p));
const procs = new Set();
export function stopAll() { for (const p of procs) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } } procs.clear(); }
process.on('exit', stopAll);

/** The `claude` shim (first on the server's PATH) and the control files the stub and the faulty store read. */
export function makeRunDir() {
  const dir = temp('gcl-stress-');
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`); chmodSync(path.join(bin, 'claude'), 0o755);
  const control = path.join(dir, 'model.json'); writeFileSync(control, '{}');
  const faults = path.join(dir, 'store.json'); writeFileSync(faults, '{}');
  return { dir, bin, control, faults };
}

/**
 * One app server: node --import store-faults.mjs server/index.js on a free port (PORT=0) with its own empty state folder,
 * the fake store and the model stub. Resolves { url, port, state, child, log(), setModel(), setStore(), stop() }.
 */
export async function startApp(run, extraEnv = {}, { state = temp('gcl-stress-state-') } = {}) {
  const env = { ...process.env, PORT: '0', MARGIN_STATE_DIR: state, GCL_KEYCHAIN: 'file', GCL_STORE: 'fake', REVIEW_EXECUTOR: 'claude', REVIEW_MODEL: 'stub', CLAUDE_BIN: STUB,
    PATH: `${run.bin}${path.delimiter}${process.env.PATH}`, STRESS_CONTROL: run.control, GCL_STRESS_STORE_FAULTS: run.faults, REVIEW_TRACE_DIR: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', HTTPS_KEY: '', HTTPS_CERT: '', PANE_DIAGNOSTICS: '', ...extraEnv };
  const child = spawn(process.execPath, ['--import', path.join(STRESS, 'store-faults.mjs'), 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(child); child.on('exit', () => procs.delete(child));
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`The app did not start: ${out}`)), 30_000);
    const look = () => { const m = /ready at https?:\/\/localhost:(\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
    child.stdout.on('data', look); child.on('exit', code => { clearTimeout(timer); reject(Error(`The app exited ${code}: ${out}`)); });
  });
  if ([3291, 3292, 3443].includes(port)) throw Error(`refusing reserved port ${port}`);
  const url = `http://localhost:${port}`;
  // The store starts in the background; wait for it to say ready.
  for (let i = 0; i < 100; i++) { try { const s = await (await fetch(`${url}/api/v2/store/status`)).json(); if (s.state === 'ready') break; } catch { /* starting */ } await sleep(100); }
  return { url, port, state, child, log: () => out, setModel: m => writeFileSync(run.control, JSON.stringify(m || {})), setStore: f => writeFileSync(run.faults, JSON.stringify(f || {})),
    stop: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); try { process.kill(child.pid, 'SIGTERM'); } catch { resolve(); } }) };
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Build the pane and pages once (dist/), as the e2e run does. */
export function build() {
  const r = spawnSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw Error('vite build failed');
}

// ---- documents --------------------------------------------------------------------------------------------------
/** A seed for the Office fake from a fixture .docx (as tests/e2e/fixtures.js does). */
export async function fixtureSeed(file, { counterparty = 'Counterparty', date = '2026-05-19T09:40:00Z', url } = {}) {
  const buffer = readFileSync(path.join(FIXTURES, file));
  const doc = await importDocx(buffer, file.split('/').pop());
  const paragraphs = doc.paragraphs.map(p => {
    if (p.originalText === undefined || p.originalText === p.text) return [{ text: p.text, state: 'n' }];
    return diffWordsWithSpace(p.originalText, p.text).map(part => ({ text: part.value, state: part.added ? 'ins' : part.removed ? 'del' : 'n', ...(part.added || part.removed ? { author: counterparty, date } : {}) }));
  });
  return { paragraphs, fileBase64: buffer.toString('base64'), url: url || `https://contoso.sharepoint.test/Shared/${encodeURIComponent(file.split('/').pop())}`, title: '', author: 'Lawyer', name: file.split('/').pop() };
}
/** A seed for a document made here: plain paragraphs, its .docx written by the app's own exporter. */
export async function syntheticSeed(name, texts, { url } = {}) {
  const buffer = await exportDocx({ title: name, paragraphs: texts.map((text, i) => ({ id: `p${i + 1}`, text })) }, null);
  return { paragraphs: texts.map(text => [{ text, state: 'n' }]), fileBase64: Buffer.from(buffer).toString('base64'), url: url || `https://contoso.sharepoint.test/Shared/${encodeURIComponent(name)}.docx`, title: '', author: 'Lawyer', name: `${name}.docx`, buffer: Buffer.from(buffer) };
}
export const FIXTURE_DOCS = ['history/helix-brightwater-nda-v3-helix-counter.docx', 'history/helix-brightwater-nda-v2-bw-markup.docx', 'history/helix-brightwater-nda-v1.docx', 'history/helix-oakfield-nda-v1.docx', 'order-form/helix-northgate-order-form-v2-customer-markup.docx', 'order-form/helix-northgate-order-form-v1.docx'];
const CLAUSE = 'The Recipient shall keep the Confidential Information confidential and shall not disclose it to any third party without the prior written consent of the Discloser, except to its employees and professional advisers who need to know it for the Purpose and who are bound by obligations of confidence no less protective than those in this Agreement';
/** Documents that stress the pane: very long, long paragraphs, unicode / RTL / emoji, an empty one. */
export const SYNTHETIC = {
  // Hundreds of paragraphs, some over Word's 255-character search limit. (The Office fake keeps every character in
  // sessionStorage, about 50 bytes each, so the whole document stays under its 5 MB quota.)
  long: () => Array.from({ length: 320 }, (_, i) => i % 9 === 0 ? `${Math.floor(i / 9) + 1}. Clause heading ${i}` : i % 4 === 0 ? `${i}. ${CLAUSE}.` : `${i}. The parties agree to term ${i} of this Agreement for ${i % 7 + 1} years.`),
  unicode: () => ['Mutual Non-Disclosure Agreement — Ünïcödé Ltd', '1. الطرف المتلقي يحافظ على سرية المعلومات لمدة خمس سنوات من تاريخ الإفصاح.', '2. הצד המקבל ישמור על סודיות המידע למשך שלוש שנים.', '3. 受領者は、開示日から五年間、秘密情報を秘密として保持するものとします。', '4. The Recipient 🤝 shall pay £1,000,000 within thirty (30) days 📄✅ of the invoice date — “net 30”.', `5. ${'Ω≈ç√∫ '.repeat(60)}`, '6. Governing law: the laws of England and Wales. Zero‑width​join and soft­hyphen.'],
  empty: () => [''],
  short: () => ['NDA', '1. Term: five years.', '2. Law: England.'],
};

// ---- the page under test ----------------------------------------------------------------------------------------
/** Open the Word pane at `base` with the Office fake seeded with `seed` (each open is its own document to the server). */
export async function openPane(page, base, seed, key = Math.random().toString(36).slice(2)) {
  const { buffer, name, ...s } = seed;
  s.url = `${seed.url}?stress=${key}`;
  await page.addInitScript(installOfficeFake, s);
  await page.goto(`${base}/?host=word`);
}

/**
 * What a lawyer must never see: internals of every kind. Each entry is [name, pattern]. The text scanned is the visible
 * text of the page and the title/aria-label of visible elements, minus the contract text itself (the document column).
 */
export const RAW_PATTERNS = [
  ['json', /[{[]\s*"[\w $-]+"\s*:/], ['undefined', /\bundefined\b/], ['NaN', /\bNaN\b/], ['null', /\bnull\b/], ['[object Object]', /\[object \w+\]/],
  ['stack trace', /\bat [\w$.<>]+ \(?[^)\s]*:\d+:\d+\)?/], ['error class', /\b(TypeError|ReferenceError|SyntaxError|RangeError|AbortError|DOMException)\b/], ['Error:', /\bError:/],
  ['PascalCase code', /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+){2,}\b/], ['camelCase code', /\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/], ['CONSTANT_CODE', /\b[A-Z]{2,}_[A-Z_]{2,}\b/], ['snake_code', /\b[a-z]+_[a-z]+(?:_[a-z]+)*\b/],
  ['HTTP code', /\b(?:HTTP|status|exit|code)\s*\(?\d{3}\b|\(\d{3}[:)]/i], ['file path', /(?:\/Users\/|\/usr\/|\/tmp\/|\/private\/|\/var\/|node_modules|\.m?js:\d+|[A-Z]:\\)/], ['API path', /\/api\/[\w/-]+/],
  ['spawn', /\bspawn\b/], ['errno', /\b(ENOENT|EACCES|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EADDRINUSE)\b/], ['Claude CLI', /Claude CLI|claude CLI/], ['stdio', /\b(stderr|stdout)\b/],
  ['fetch', /fetch failed|Failed to fetch|NetworkError|Load failed/i], ['parser', /Unexpected (token|end of JSON)|JSON\.parse|not valid JSON|JSON object|JSON input|in JSON at|JSON at position/i], ['internal word', /\b(OfficeExtension|RichApi|webpack|vite|Express|multer|Paperless)\b/],
];
/** Phrases that look like internals but are product copy (checked against the matched text). */
const ALLOWED = [/^GinChugger$/];

/** The page's state for the invariants, read in the page. */
export async function snapshot(page) {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    // The contract text and the Office fake's document are content, not messages.
    const skip = el => el.closest('.doccol__scroll, .paper, .qa__q, .qa__sel, .selchip, .quote, input, textarea, select, option, datalist, .doc__preview, .trow__main, .li__t, .inbox__subject, .page__title, .pane__doc, .doccol__title, .snippet, .tagchip, .note__text, .listrow__title, .inbox__email, .prow__title, .point__title, .example');
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { const el = n.parentElement; if (!el || !n.textContent.trim() || skip(el) || !visible(el)) continue; texts.push(n.textContent.trim()); }
    for (const el of document.querySelectorAll('[title],[aria-label]')) { if (skip(el) || !visible(el)) continue; for (const a of ['title', 'aria-label']) { const v = el.getAttribute(a); if (v) texts.push(v); } }
    const buttons = [...document.querySelectorAll('button, [role=button], a[href]')].filter(visible).map(b => ({ name: (b.getAttribute('aria-label') || b.textContent || b.getAttribute('title') || '').trim(), html: b.outerHTML.slice(0, 160) }));
    const busy = [];
    for (const el of document.querySelectorAll('.primary--busy, [aria-label=Progress], .step--active, button')) {
      if (!visible(el)) continue;
      const t = (el.textContent || '').trim();
      if (el.matches('.primary--busy')) busy.push(`busy:${t.replace(/\d+:\d+/, '')}`);
      else if (el.matches('[aria-label=Progress]')) busy.push('progress');
      else if (el.matches('button') && /(…|\.\.\.)$/.test(t) && !/^“/.test(t)) busy.push(`button:${t}`);
    }
    const done = document.querySelectorAll('.points .prow--done').length;
    const rows = document.querySelectorAll('.points > li').length - (document.querySelector('.points > li .grey')?.textContent === 'Nothing found.' ? 1 : 0);
    const tab = document.querySelector('#tab-review')?.textContent || '';
    const segsOn = document.querySelectorAll('.pane__segs span.on').length, segs = document.querySelectorAll('.pane__segs span').length;
    const inboxNav = [...document.querySelectorAll('.topnav__item')].find(a => /^Inbox/.test(a.textContent))?.textContent || null;
    const inboxRows = location.hash.startsWith('#/inbox') && document.querySelector('.inbox__list') ? document.querySelectorAll('.inbox__list button.li').length : null;
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const wide = overflow > 1 ? [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.right > document.documentElement.clientWidth + 1 && r.width > 0 && visible(el); }).slice(0, 3).map(el => el.outerHTML.slice(0, 140)) : [];
    return { texts, buttons, busy, done, rows, tab, segsOn, segs, inboxNav, inboxRows, overflow, wide, hash: location.hash, search: location.search, bodyText: document.body.innerText.slice(0, 4000) };
  });
}

/** The invariants over one snapshot; returns a list of { kind, detail }. `ctx.busySince` carries busy states across steps. */
export function check(s, ctx) {
  const problems = [];
  const seen = new Set();
  for (const t of s.texts) for (const [name, re] of RAW_PATTERNS) {
    const m = re.exec(t); if (!m || ALLOWED.some(a => a.test(m[0]))) continue;
    if ((ctx.allowRaw || []).some(a => a.test(t))) continue;
    const key = `${name}|${t.slice(0, 80)}`; if (seen.has(key)) continue; seen.add(key);
    problems.push({ kind: 'raw-text', detail: `${name} (“${m[0]}”) in: ${t.slice(0, 300)}` });
  }
  for (const b of s.buttons) if (!b.name) problems.push({ kind: 'unnamed-control', detail: b.html });
  if (s.overflow > 1) problems.push({ kind: 'overflow', detail: `${s.overflow}px wider than the viewport: ${s.wide.join(' | ')}` });
  // Counts: the Review tab's "d of n", the segments and the rows agree.
  const m = /Review · (\d+) of (\d+)/.exec(s.tab);
  if (m && s.rows > 0) {
    if (Number(m[2]) !== s.rows) problems.push({ kind: 'count', detail: `tab says ${m[2]} points, list has ${s.rows}` });
    if (Number(m[1]) !== s.done) problems.push({ kind: 'count', detail: `tab says ${m[1]} done, list has ${s.done} done rows` });
    if (s.segs && (s.segs !== s.rows || s.segsOn !== s.done)) problems.push({ kind: 'count', detail: `segments ${s.segsOn}/${s.segs}, rows ${s.done}/${s.rows}` });
  }
  if (s.inboxRows !== null && s.inboxNav !== null && ctx.settled) {
    const n = Number((/\d+/.exec(s.inboxNav) || ['0'])[0]);
    if (n !== s.inboxRows) problems.push({ kind: 'count', detail: `Inbox badge ${n}, inbox list ${s.inboxRows}` });
  }
  // Busy states: each kind is timed from when it was first seen; one held longer than ctx.busyMs is stuck.
  const now = Date.now(); const still = new Map();
  for (const b of new Set(s.busy)) { const since = ctx.busySince?.get(b) ?? now; still.set(b, since); if (now - since > ctx.busyMs) problems.push({ kind: 'stuck-busy', detail: `${b} for ${Math.round((now - since) / 1000)} s` }); }
  ctx.busySince = still;
  return problems;
}

/** Console errors, page errors and failed requests, collected per page; `expect` patterns are not failures. */
export function watch(page, sink) {
  page.on('console', msg => { if (msg.type() === 'error') sink.push({ kind: 'console', detail: msg.text().slice(0, 400) }); });
  page.on('pageerror', e => sink.push({ kind: 'pageerror', detail: String(e.stack || e.message).slice(0, 600) }));
  page.on('requestfailed', r => { const f = r.failure()?.errorText || ''; if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(f)) return; sink.push({ kind: 'requestfailed', detail: `${r.method()} ${new URL(r.url()).pathname} ${f}` }); });
  page.on('response', r => { if (r.status() >= 400 && new URL(r.url()).hostname === 'localhost') sink.push({ kind: `http-${r.status()}`, detail: `${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search.slice(0, 80)}` }); });
}

// ---- failures and the report ------------------------------------------------------------------------------------
export class Recorder {
  constructor() { this.failures = []; this.runs = []; this.known = []; rmSync(path.join(OUT, 'shots'), { recursive: true, force: true }); mkdirSync(path.join(OUT, 'shots'), { recursive: true }); }
  async fail(page, { where, problems, steps, seed, scenario, server }) {
    const id = `${scenario || `seed-${seed}`}-${this.failures.length + 1}`.replace(/[^\w.-]+/g, '-');
    const shot = path.join(OUT, 'shots', `${id}.png`);
    let dom = '';
    try { await page.screenshot({ path: shot, fullPage: false }); dom = await page.evaluate(() => document.body.innerText.slice(0, 2500)); } catch { /* page gone */ }
    const serverLog = server ? server.log().split('\n').filter(l => /error|failed|unavailable|refused|exception/i.test(l)).slice(-12).join('\n') : '';
    this.failures.push({ id, where, seed, scenario, problems, steps: steps.slice(-15), shot: existsSync(shot) ? path.relative(ROOT, shot) : null, dom, serverLog });
    return id;
  }
  write(meta) {
    const lines = [`# Stress run report`, '', `Run ${new Date().toISOString()} · ${meta.summary}`, '', `Command: \`${meta.command}\``, ''];
    lines.push('| Run | Steps | Result |', '|---|---|---|', ...this.runs.map(r => `| ${r.name} | ${r.steps} | ${r.failures ? `${r.failures} failure(s)` : 'clean'} |`), '');
    if (this.known.length) lines.push('## Known, needs a product decision (not failures)', '', ...[...new Set(this.known.map(k => `- ${k.scenario}: ${k.detail}`))], '');
    if (!this.failures.length) lines.push('No failures.');
    for (const f of this.failures) {
      lines.push(`## ${f.id}`, '', `- Where: ${f.where}`, f.seed !== undefined ? `- Seed: ${f.seed} (rerun: \`npm run stress -- --seeds ${f.seed} --scenarios none\`)` : `- Scenario: ${f.scenario} (rerun: \`npm run stress -- --seeds none --scenarios ${f.scenario}\`)`, f.shot ? `- Screenshot: ${f.shot}` : '- Screenshot: none', '');
      lines.push('Problems:', '', ...[...new Map(f.problems.map(p => [`${p.kind}: ${p.detail}`, p])).keys()].slice(0, 25).map(p => `- ${p.replace(/\n/g, ' ')}`), '');
      lines.push('Steps to reproduce (last 15):', '', ...f.steps.map((s, i) => `${i + 1}. ${s}`), '');
      lines.push('DOM text:', '', '```', f.dom.slice(0, 1500), '```', '');
      if (f.serverLog) lines.push('Server log (errors):', '', '```', f.serverLog, '```', '');
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 'REPORT.md'), lines.join('\n') + '\n');
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ meta, runs: this.runs, known: this.known, failures: this.failures }, null, 2));
  }
}
