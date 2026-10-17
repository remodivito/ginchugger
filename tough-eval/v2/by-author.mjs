// SPDX-License-Identifier: GPL-3.0-or-later
// The by-author table and the pre-registered self-advantage rule (BENCHMARK-V2.md 5.9, 11.8, P18), on layer A's
// verified single items, from the runs' scores, with no model call.
//   Per setup: all-pass, miss rate and false alarms on the items of each author (opus, glm, deepseek), on its own
//   family's items (authoring families only) and on the others'.
//   Self-advantage, a difference in differences, for each authoring family f with a setup of its own:
//     SA_f = (allPass_f(own) − allPass_f(others')) − mean over the other authoring families g of
//            (allPass_g(f's items) − allPass_g(items by neither f nor g))
//   with a 95% bootstrap interval over items (4,000 resamples, seed 20261010); the raw own-minus-others figure beside it;
//   the same test on the miss rate and on false alarms, for information. "detected" iff the all-pass interval excludes
//   zero, else "not detected" (never "absent"). A family with a detected self-advantage is compared with any other setup
//   on the items written by neither side: the table names the item set each setup's comparison with the reference uses.
// A setup's family comes from its model id; the setup that stands for a family is the first non-agentic, non-baseline
// setup of that family (or --family-setup opus=<setup>,glm=<setup>,...).
// Usage: node tough-eval/v2/by-author.mjs [--out <dir>] [--check] [--reference <setup>] [--family-setup ...] [<v2a runDir> ...]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun } from '../score.mjs';
import { bootstrap } from './stats.mjs';
import { setupOf, layerOf, defaultRuns, DEFAULT_OUT } from './profile.mjs';

export const AUTHORS = ['opus', 'glm', 'deepseek'];
export const familyOf = model => { const m = String(model || '').toLowerCase(); return /claude|opus|sonnet/.test(m) ? 'opus' : /glm/.test(m) ? 'glm' : /deepseek/.test(m) ? 'deepseek' : null; };
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r3 = x => (x === null || x === undefined || Number.isNaN(x) ? null : +x.toFixed(3));

/** Per item and setup: { allPass, missed (deviations only), falseAlarms }. */
export function itemTable(runs) {
  const setups = []; const items = new Map();
  for (const dir of runs) {
    const meta = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); const s = scoreRun(dir); const name = setupOf(meta);
    setups.push({ name, model: meta.model, family: meta.baseline ? null : familyOf(meta.model), agentic: !!meta.agentic, baseline: !!meta.baseline });
    for (const d of s.docs.filter(d => !d.markup && d.status === 'verified')) {
      const p = s.plants.find(x => x.variant === d.variant);
      const it = items.get(d.variant) || items.set(d.variant, { id: d.variant, author: p.author, kind: p.kind, by: {} }).get(d.variant);
      it.by[name] = { allPass: d.allPass ? 1 : 0, missed: p.kind === 'deviation' ? (p.caught ? 0 : 1) : null, falseAlarms: d.falseAlarms };
    }
  }
  return { setups, items: [...items.values()] };
}
const measureOn = (items, setup, k) => { const xs = items.filter(i => i.by[setup] && i.by[setup][k] !== null).map(i => i.by[setup][k]); return xs.length ? mean(xs) : null; };
/** SA_f on a sample of items, for measure k; null when a needed group is empty. */
export function selfAdvantage(items, f, rep, k = 'allPass') {
  const own = items.filter(i => i.author === f), others = items.filter(i => i.author !== f);
  const a = measureOn(own, rep[f], k), b = measureOn(others, rep[f], k); if (a === null || b === null) return null;
  const terms = Object.keys(rep).filter(g => g !== f).map(g => { const x = measureOn(own, rep[g], k), y = measureOn(items.filter(i => i.author !== f && i.author !== g), rep[g], k); return x === null || y === null ? null : x - y; }).filter(x => x !== null);
  return terms.length ? (a - b) - mean(terms) : null;
}
export function byAuthor(runs, { reference = null, familySetup = {} } = {}) {
  const { setups, items } = itemTable(runs);
  const rep = {}; for (const f of AUTHORS) { const s = familySetup[f] || setups.find(x => x.family === f && !x.agentic && !x.baseline)?.name; if (s) rep[f] = s; }
  const sa = {};
  for (const f of Object.keys(rep)) {
    const res = {};
    for (const k of ['allPass', 'missed', 'falseAlarms']) {
      const pool = k === 'missed' ? items.filter(i => i.kind === 'deviation') : items; const b = bootstrap(pool, s => selfAdvantage(s, f, rep, k));
      const own = measureOn(pool.filter(i => i.author === f), rep[f], k), oth = measureOn(pool.filter(i => i.author !== f), rep[f], k);
      res[k] = { sa: b.point, ci95: [b.lo, b.hi], raw: own === null || oth === null ? null : r3(own - oth), ...(k === 'allPass' ? { verdict: b.lo !== null && (b.lo > 0 || b.hi < 0) ? 'detected' : 'not detected', decides: true } : { forInformation: true }) };
    }
    sa[f] = { setup: rep[f], comparators: Object.keys(rep).filter(g => g !== f).map(g => rep[g]), ...res };
  }
  const ref = reference || setups.find(s => s.family === 'opus' && !s.agentic && !s.baseline)?.name || setups[0]?.name;
  const refFamily = setups.find(s => s.name === ref)?.family || null;
  const rows = setups.map(s => {
    const row = { setup: s.name, family: s.family };
    for (const a of AUTHORS) { const its = items.filter(i => i.author === a); row[a] = { allPass: r3(measureOn(its, s.name, 'allPass')), miss: r3(measureOn(its, s.name, 'missed')), falseAlarms: r3(measureOn(its, s.name, 'falseAlarms')), n: its.filter(i => i.by[s.name]).length }; }
    if (AUTHORS.includes(s.family)) { const own = items.filter(i => i.author === s.family), oth = items.filter(i => i.author !== s.family);
      row.own = { allPass: r3(measureOn(own, s.name, 'allPass')), miss: r3(measureOn(own, s.name, 'missed')), falseAlarms: r3(measureOn(own, s.name, 'falseAlarms')) };
      row.others = { allPass: r3(measureOn(oth, s.name, 'allPass')), miss: r3(measureOn(oth, s.name, 'missed')), falseAlarms: r3(measureOn(oth, s.name, 'falseAlarms')) }; }
    const fam = rep[s.family] === s.name || (s.family && sa[s.family]) ? sa[s.family] : null;
    row.SA = fam && rep[s.family] === s.name ? { value: fam.allPass.sa, ci95: fam.allPass.ci95, raw: fam.allPass.raw, verdict: fam.allPass.verdict } : null;
    // Detected on either side: the comparison uses the items written by neither side's family (96 against a non-author, 48 against another author).
    const triggered = [s.family, refFamily].some(f => f && sa[f]?.allPass.verdict === 'detected');
    const excl = triggered ? [...new Set([s.family, refFamily].filter(f => AUTHORS.includes(f)))] : [];
    row.itemSet = s.name === ref ? 'reference' : triggered ? 'reduced' : 'common';
    if (triggered) { row.itemSetExcludes = excl; row.reducedItems = items.filter(i => !excl.includes(i.author)).length; }
    return row;
  });
  return { reference: ref, representatives: rep, items: items.length, itemsByAuthor: Object.fromEntries(AUTHORS.map(a => [a, items.filter(i => i.author === a).length])), selfAdvantage: sa, rows,
    note: 'A non-significant self-advantage is reported as "not detected", not "absent": with 48 own items against 96 others, about 15 to 18 points is the smallest detectable at 80% power (section 5.9).' };
}
export function toMarkdown(t) {
  const f = x => (x === null || x === undefined ? '' : x);
  const lines = ['# By author (layer A, verified single items)', '', `Reference: ${t.reference}. Items: ${t.items} (${AUTHORS.map(a => `${a} ${t.itemsByAuthor[a]}`).join(', ')}).`, '',
    '| Setup | opus all-pass / miss / FA | glm all-pass / miss / FA | deepseek all-pass / miss / FA | own all-pass | others all-pass | SA [95%] (raw) | verdict | item set |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of t.rows) lines.push(`| ${r.setup} | ${AUTHORS.map(a => `${f(r[a].allPass)} / ${f(r[a].miss)} / ${f(r[a].falseAlarms)}`).join(' | ')} | ${f(r.own?.allPass)} | ${f(r.others?.allPass)} | ${r.SA ? `${f(r.SA.value)} [${r.SA.ci95.map(f).join(', ')}] (${f(r.SA.raw)})` : ''} | ${r.SA ? r.SA.verdict : ''} | ${r.itemSet}${r.itemSetExcludes ? ` (without ${r.itemSetExcludes.join(' and ')} items: ${r.reducedItems})` : ''} |`);
  lines.push('', t.note, ''); return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const FLAGS = ["check"]; // flags take no value (else `--check <runDir>` would swallow the run)
  const take = k => { const i = argv.indexOf(`--${k}`); if (i < 0) return null; if (FLAGS.includes(k)) { argv.splice(i, 1); return true; } const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; argv.splice(i, v === true ? 1 : 2); return v; };
  const out = path.resolve(take('out') || DEFAULT_OUT); const check = !!take('check'); const reference = take('reference');
  const familySetup = Object.fromEntries(String(take('family-setup') || '').split(',').filter(Boolean).map(x => x.split('=')));
  const runs = (argv.length ? argv.map(d => path.resolve(d)) : defaultRuns()).filter(d => layerOf(JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8'))) === 'A');
  if (!runs.length) { console.log('no layer A runs'); process.exit(0); }
  const t = byAuthor(runs, { reference, familySetup }); const json = JSON.stringify(t, null, 1) + '\n', md = toMarkdown(t);
  if (check) { const same = existsSync(path.join(out, 'by-author.json')) && readFileSync(path.join(out, 'by-author.json'), 'utf8') === json && readFileSync(path.join(out, 'by-author.md'), 'utf8') === md; console.log(same ? 'by-author reproduced' : 'by-author DIFFERS'); process.exitCode = same ? 0 : 1; }
  else { mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, 'by-author.json'), json); writeFileSync(path.join(out, 'by-author.md'), md); }
  console.log(md);
}
