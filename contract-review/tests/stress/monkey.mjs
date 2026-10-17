// SPDX-License-Identifier: GPL-3.0-or-later
// The seeded random click-through (tests/stress): random but valid lawyer actions on the Word pane (380 px, Office fake)
// and on the pages (1440 px), N steps each, reproducible by seed. Every step is logged; the invariants run after each.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { FIXTURES, sleep } from './harness.mjs';

const QUESTIONS = ['What did they change in this draft?', 'Summarise the key terms', 'Is the term within our playbook?', 'What is the liability cap?', 'Ünïcödé — ما هي مدة السرية؟ 🤔', `${'Explain every obligation in detail and compare it with our standard position. '.repeat(5)}`.trim(), 'x', '"quoted" <b>html</b> & {braces}'];
const SEARCHES = ['confidential', 'term', 'Brightwater', '"seven years"', 'a'.repeat(300), 'NDA AND (term OR law)', 'ünïcödé', '*', 'title:foo', ':', '%', '(('];
const TITLES = ['Renamed by stress', 'A'.repeat(140), 'Ünïcödé — 合同 🤝', '  padded  ', 'x'];
const NAMES = ['Brightwater Analytics Ltd', 'Northgate', 'New Counterparty Ltd', 'Ünïcödé GmbH', 'NDA', 'Order form', 'signed', 'urgent'];
const UPLOADS = ['history/helix-brightwater-nda-v1.docx', 'history/helix-oakfield-nda-v1.docx', 'history/2026-05-19-brightwater-returns-markup.eml', 'order-form/policy-note.txt', 'order-form/helix-northgate-order-form-v1.docx'];
const upload = (name, buffer) => ({ name, mimeType: name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : name.endsWith('.eml') ? 'message/rfc822' : 'text/plain', buffer });
const fixtureFile = f => upload(path.basename(f), readFileSync(path.join(FIXTURES, f)));

/** Visible, enabled locators of a selector, as an array. */
async function visible(page, selector) {
  const all = await page.locator(selector).all(); const out = [];
  for (const l of all) { try { if (await l.isVisible() && await l.isEnabled().catch(() => true)) out.push(l); } catch { /* detached */ } }
  return out;
}
async function clickOne(page, r, selector, label, opts = {}) {
  const list = await visible(page, selector); if (!list.length) return null;
  const el = r.pick(list); const name = ((await el.getAttribute('aria-label').catch(() => null)) || (await el.textContent().catch(() => '')) || '').trim().slice(0, 50);
  if (opts.double) await el.dblclick({ timeout: 2000 }).catch(() => {}); else await el.click({ timeout: 2000 }).catch(() => {});
  return `${label} “${name}”${opts.double ? ' (double-click)' : ''}`;
}
async function fill(page, selector, text) { const l = (await visible(page, selector))[0]; if (!l) return false; await l.fill(text, { timeout: 2000 }).catch(() => {}); return true; }

// ---- the Word pane ----------------------------------------------------------------------------------------------
export function paneActions(env) {
  return [
    ['review', 5, async (p, r) => clickOne(p, r, '.start button.primary', 'click')],
    ['choose playbook', 1, async (p, r) => { await clickOne(p, r, '.pane__ctx button.link', 'click'); return clickOne(p, r, '.pane__books button[role=radio]', 'choose playbook'); }],
    ['open point', 4, async (p, r) => clickOne(p, r, 'button.prow', 'open point')],
    ['apply', 4, async (p, r) => clickOne(p, r, '.point__actions button.primary', 'click')],
    ['dismiss', 3, async (p, r) => { await clickOne(p, r, '.point__actions button.quiet', 'click'); return clickOne(p, r, '.point__why-dismiss button', 'dismiss reason'); }],
    ['confirm bulk', 1, async (p, r) => { await clickOne(p, r, '.bulkrow', 'toggle'); return clickOne(p, r, '.point__actions button', 'click'); }],
    ['undo', 2, async (p, r) => clickOne(p, r, '.prow--done button.link', 'undo')],
    ['ask typed', 3, async (p, r) => { const q = r.pick(QUESTIONS); if (!await fill(p, 'input[aria-label="Ask about this draft"]', q)) return null; await p.keyboard.press('Enter').catch(() => {}); return `ask “${q.slice(0, 40)}”`; }],
    ['ask chip', 2, async (p, r) => clickOne(p, r, '.askchip, .chips .chip', 'ask chip')],
    ['stop', 2, async (p, r) => clickOne(p, r, 'button[aria-label=Stop]', 'click')],
    ['tabs', 2, async (p, r) => { const n = 2 + r.int(6); for (let i = 0; i < n; i++) await p.locator(i % 2 ? '#tab-ask' : '#tab-review').click({ timeout: 1000 }).catch(() => {}); return `switch tabs ${n} times`; }],
    ['select in Word', 3, async (p, r) => p.evaluate(([x, y]) => { const t = window.__word.texts(); const ps = t.map((s, i) => [s, i]).filter(([s]) => s.trim().length > 3); if (!ps.length) return null; const [s, i] = ps[Math.floor(x * ps.length)]; const from = Math.floor(y * s.length / 2); const piece = s.slice(from, from + 5 + Math.floor((1 - y) * 400)); if (!piece.trim()) return null; window.__word.selectText(i, piece); return `select ${piece.length} characters in Word paragraph ${i}`; }, [r.next(), r.next()]).catch(() => null)],
    ['select none', 1, async p => p.evaluate(() => { window.__word.selectNone(); return 'clear the selection in Word'; }).catch(() => null)],
    ['clear chip', 1, async (p, r) => clickOne(p, r, '.selchip__x', 'click')],
    ['coverage', 1, async (p, r) => clickOne(p, r, '.pane__coverage button', 'click')],
    ['sources', 1, async (p, r) => clickOne(p, r, '.qa__more button, .source button', 'click')],
    ['save reply', 1, async (p, r) => clickOne(p, r, '.save-reply button', 'click')],
    ['review again', 1, async (p, r) => clickOne(p, r, '.pane__status button', 'click')],
    ['edit in Word', 1, async (p, r) => p.evaluate(x => { const t = window.__word.texts(); const ps = t.map((s, i) => [s, i]).filter(([s]) => /\w{4,}/.test(s)); if (!ps.length) return null; const [s, i] = ps[Math.floor(x * ps.length)]; const w = s.match(/\w{4,}/)[0]; window.__word.typeInto(i, w, `${w}x`); return `type into Word paragraph ${i}`; }, r.next()).catch(() => null)],
    ['reject in Word', 1, async p => p.evaluate(() => { window.__word.rejectBy('Lawyer'); return 'reject the lawyer\'s changes in Word'; }).catch(() => null)],
    ['store line', 1, async (p, r) => clickOne(p, r, '.pane__store button, .backbar__btn', 'click')],
    ['double-click', 2, async (p, r) => clickOne(p, r, '.pane button:not([aria-label=Stop])', 'click', { double: true })],
    ['random button', 3, async (p, r) => clickOne(p, r, 'button:not(.selchip__x)', 'click')],
    ['reload', 1, async p => { await p.reload().catch(() => {}); return 'reload the pane'; }],
    ['reload mid-action', 1, async (p, r) => { const b = (await visible(p, '.start button.primary, .point__actions button.primary, .askchip, .chips .chip'))[0]; if (!b) return null; b.click({ timeout: 1000 }).catch(() => {}); await sleep(r.int(800)); await p.reload().catch(() => {}); return 'start an action, then reload the pane'; }],
    ['model chaos', env.chaos ? 2 : 0, async (p, r) => { const m = r.weighted([['ok', 6], ['fenced', 1], ['prose', 1], ['truncated', 1], ['empty', 1], ['errored', 1], ['fail', 1]]); env.server.setModel({ review: m, ask: m, findings: 4 + r.int(10) }); return `model now answers “${m}”`; }],
    ['store chaos', env.chaos ? 1 : 0, async (p, r) => { const f = r.weighted([[{}, 5], [{ down: true }, 1], [{ raw: true }, 1]]); env.server.setStore(f); return `store now ${JSON.stringify(f)}`; }],
  ];
}

// ---- the pages --------------------------------------------------------------------------------------------------
export function pageActions(env) {
  const go = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash).catch(() => {}); return `go to ${hash}`; };
  return [
    ['nav', 6, async (p, r) => clickOne(p, r, '.topnav__item, .wordmark', 'nav')],
    ['rapid nav', 1, async (p, r) => { const n = 3 + r.int(6); for (let i = 0; i < n; i++) await p.locator('.topnav__item').nth(r.int(8)).click({ timeout: 800 }).catch(() => {}); return `click ${n} nav items quickly`; }],
    ['inbox pick', 3, async (p, r) => clickOne(p, r, '.inbox__list button.li', 'pick')],
    ['labels', 4, async (p, r) => { const field = r.pick(['Title', 'Counterparty', 'Type', 'Date', 'Add tag']); const l = (await visible(p, `.labels input[aria-label="${field}"]`))[0]; if (!l) return null; const v = field === 'Date' ? r.pick(['2026-02-30', '1999-01-01', '2026-10-17', '']) : field === 'Title' ? r.pick(TITLES) : r.pick(NAMES); await l.fill(v, { timeout: 1500 }).catch(() => {}); if (field === 'Add tag') await l.press('Enter').catch(() => {}); return `set ${field} to “${v.slice(0, 30)}”`; }],
    ['remove tag', 1, async (p, r) => clickOne(p, r, '.tagchip button', 'click')],
    ['done', 3, async (p, r) => clickOne(p, r, '.inbox__detail .actions button.primary', 'click')],
    ['not a contract', 1, async (p, r) => clickOne(p, r, '.inbox__detail .actions button.secondary', 'click')],
    ['upload', 2, async (p, r) => { const input = p.locator('input[type=file][aria-label="Add files"]'); if (!await input.count()) return null; const files = Array.from({ length: 1 + r.int(3) }, () => fixtureFile(r.pick(UPLOADS))); if (r.chance(0.3)) files.push(upload(r.pick(['Ünïcödé 合同 🤝.txt', 'empty.txt', 'x'.repeat(200) + '.txt']), Buffer.from(r.chance(0.5) ? '' : 'A short note about the NDA term.'))); await input.setInputFiles(files).catch(() => {}); return `upload ${files.map(f => f.name.slice(0, 30)).join(', ')}`; }],
    ['dismiss processing', 1, async (p, r) => clickOne(p, r, '.li--processing button', 'click')],
    ['library search', 3, async (p, r) => { const q = r.pick(SEARCHES); if (!await fill(p, '#lib-q', q)) return null; await p.locator('#lib-q').press('Enter').catch(() => {}); return `search “${q.slice(0, 30)}”`; }],
    ['library filter', 2, async (p, r) => { const sel = (await visible(p, '.form-row--filters select'))[0 + r.int(2)] || (await visible(p, '.form-row--filters select'))[0]; if (!sel) return null; const opts = await sel.locator('option').allTextContents(); const v = r.pick(opts); await sel.selectOption({ label: v }, { timeout: 1500 }).catch(() => {}); return `filter “${v}”`; }],
    ['library dates', 1, async (p, r) => { const a = r.pick(['2026-12-31', '2020-01-01', '']); const b = r.pick(['2020-01-01', '2026-12-31', '']); await fill(p, '#lib-from', a); await fill(p, '#lib-to', b); return `dates ${a || 'none'} to ${b || 'none'}`; }],
    ['open document', 3, async (p, r) => clickOne(p, r, 'a.trow__main, .listrow__title, a[href^="#/documents/"]', 'open')],
    ['pager', 1, async (p, r) => clickOne(p, r, '.pager button', 'click')],
    ['doc save', 2, async (p, r) => clickOne(p, r, '.doc__side .actions button', 'click')],
    ['note', 2, async (p, r) => { const t = r.pick(['A note.', 'Ünïcödé note 🤝', 'n'.repeat(3000)]); if (!await fill(p, 'textarea[aria-label=Note]', t)) return null; await clickOne(p, r, '.note__new button', 'click'); return `add note (${t.length} chars)`; }],
    ['delete note', 1, async (p, r) => clickOne(p, r, '.note__links button', 'click')],
    ['doc ask', 2, async (p, r) => { await clickOne(p, r, '[aria-label="Document actions"] button[aria-pressed=false]', 'click'); const q = r.pick(QUESTIONS); if (!await fill(p, 'input[aria-label=Question]', q)) return null; await p.locator('input[aria-label=Question]').press('Enter').catch(() => {}); return `ask on the document page “${q.slice(0, 30)}”`; }],
    ['hold / trash', 2, async (p, r) => clickOne(p, r, '[aria-label="Document actions"] button', 'click')],
    ['restore', 2, async (p, r) => clickOne(p, r, '.trow--storetrash button', 'click')],
    ['review page', 2, async (p, r) => clickOne(p, r, '.doccol__actions button, .example, .narrow-switch button, .start button.primary, .point__actions button, .point__why-dismiss button, button.prow, .prow--done button.link', 'click')],
    ['open docx', 1, async (p, r) => { const input = p.locator('.doccol input[type=file]').first(); if (!await input.count()) return null; const f = r.pick(['history/helix-brightwater-nda-v2-bw-markup.docx', 'order-form/helix-northgate-order-form-v2-customer-markup.docx', 'order-form/policy-note.txt']); await input.setInputFiles(fixtureFile(f)).catch(() => {}); return `open ${path.basename(f)} in the browser`; }],
    ['pane ask', 1, async (p, r) => { const q = r.pick(QUESTIONS); if (!await fill(p, 'input[aria-label="Ask about this draft"]', q)) return null; await p.keyboard.press('Enter').catch(() => {}); return `ask “${q.slice(0, 30)}”`; }],
    ['random button', 3, async (p, r) => clickOne(p, r, 'main button, .main button', 'click')],
    ['double-click', 1, async (p, r) => clickOne(p, r, 'main button', 'click', { double: true })],
    ['back', 1, async p => { await p.goBack({ timeout: 3000 }).catch(() => {}); return 'browser back'; }],
    ['reload', 1, async p => { await p.reload().catch(() => {}); return 'reload'; }],
    ['deep link', 1, async (p, r) => go(p, r.pick(['#/documents/999999', '#/documents/abc', '#/library?counterparty=%E2%9C%93', '#/playbook/nope', '#/nowhere', '#/library?q=' + 'z'.repeat(400)]))],
    ['store chaos', env.chaos ? 1 : 0, async (p, r) => { const f = r.weighted([[{}, 5], [{ down: true }, 1], [{ raw: true }, 1], [{ failTasks: 'Not consumed: file type text/plain is not supported' }, 1]]); env.server.setStore(f); return `store now ${JSON.stringify(f)}`; }],
  ];
}

/** Run `steps` random actions from `actions` with `r`, calling `after(step)` after each. */
export async function monkey(page, r, actions, steps, log, after) {
  const live = actions.filter(([, w]) => w > 0).map(([name, w, fn]) => [[name, fn], w]);
  for (let i = 0; i < steps; i++) {
    const [name, fn] = r.weighted(live);
    let line = null;
    try { line = await Promise.race([fn(page, r), sleep(15_000).then(() => `${name} (still running after 15 s)`)]); } catch (e) { line = `${name} threw ${String(e.message).slice(0, 80)}`; }
    if (!line) continue; // not applicable here: no step
    log.push(`${line}${page.url().includes('#') ? ` [${new URL(page.url()).hash}]` : ''}`);
    await after(i);
  }
}
