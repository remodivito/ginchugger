// SPDX-License-Identifier: GPL-3.0-or-later
// Memorisation probe (BENCHMARK-V2.md 5.11, P11): does a family continue Common Paper's published text verbatim? For
// each clean document, ten paragraphs are drawn by hash (lowest sha256("v2-probe:" + document + ":" + paragraph id))
// from the published standard terms only, never from the cover terms written for the suite; the model is given the
// first ten words and asked to continue; the share of the next 40 words it reproduces is recorded. Reported, not scored.
//   prefix   words matched in order from the start, before the first difference, over 40 (the headline: verbatim)
//   lcs      words of the reference covered by the longest common word subsequence, over 40 (reported beside it)
// Words are compared lower-cased with curly quotes straightened and punctuation removed.
// Which paragraphs are standard terms: `standardTermsFrom` (the first standard-terms paragraph id) from v2/documents.json
// or the base document, or the base document's `coverParagraphs` (ids to exclude); otherwise every paragraph shaped
// like a cover term ("Label: value") is excluded. Paragraphs of at least 50 words are drawn first; when fewer than ten
// exist the draw is filled, in the same hash order, with standard-terms paragraphs of at least 20 words (scored over the
// words they have). The rule used is recorded.
// Usage: node tough-eval/v2/probe.mjs --family opus|glm|deepseek [--docs csa=<base.json>,nda=<base.json>] [--out v2/probe.json]
//          live: [--executor claude|openai --model <id> --base-url <url> --key-env <VAR>]   (one call per paragraph)
//        node tough-eval/v2/probe.mjs --dry-run [--docs ...]   no model: an empty and an exact continuation, to check
//          the draw, the prompts and the scoring (must score 0 and 1)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCanary, canaryGuid } from './canary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const TE = path.resolve(here, '..');
const sha = s => createHash('sha256').update(s).digest('hex');
export const SYSTEM = 'You will be given the first words of a paragraph from a published standard-form contract. Continue the paragraph exactly as it appears in the published document, word for word, for at least 60 words. Return only the continuation, with no commentary.';
const words = t => String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9%£$'\s]/g, ' ').split(/\s+/).filter(Boolean);
const rawWords = t => String(t || '').split(/\s+/).filter(Boolean);
export function eligible(doc, minWords = 50) {
  const ps = doc.paragraphs.filter(p => rawWords(p.text).length >= minWords);
  if (Array.isArray(doc.coverParagraphs)) return { rule: 'coverParagraphs', paragraphs: ps.filter(p => !doc.coverParagraphs.includes(p.id)) };
  if (doc.standardTermsFrom) { const i = doc.paragraphs.findIndex(p => p.id === doc.standardTermsFrom); const ok = new Set(doc.paragraphs.slice(i).map(p => p.id)); return { rule: `standardTermsFrom ${doc.standardTermsFrom}`, paragraphs: ps.filter(p => ok.has(p.id)) }; }
  return { rule: 'heuristic: cover-term-shaped paragraphs ("Label: value") excluded', paragraphs: ps.filter(p => !/^[A-Z][A-Za-z ’'&-]{1,60}:\s/.test(p.text)) };
}
export function draw(document, doc, k = 10) {
  const order = ps => ps.map(p => [sha(`v2-probe:${document}:${p.id}`), p]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => p);
  const { rule, paragraphs } = eligible(doc); let picked = order(paragraphs).slice(0, k); let filled = 0;
  if (picked.length < k) { const extra = order(eligible(doc, 20).paragraphs.filter(p => !picked.includes(p))).slice(0, k - picked.length); filled = extra.length; picked = [...picked, ...extra]; }
  return { rule: rule + (filled ? `; ${filled} filled from paragraphs of 20 to 49 words` : ''), picked: picked.map(p => { const w = rawWords(p.text); return { id: p.id, prompt: w.slice(0, 10).join(' '), reference: w.slice(10, 50).join(' ') }; }) };
}
export function scoreContinuation(reference, continuation) {
  const r = words(reference).slice(0, 40), c = words(continuation); let prefix = 0; while (prefix < r.length && r[prefix] === c[prefix]) prefix++;
  const prev = new Array(c.length + 1).fill(0);
  for (let i = 1; i <= r.length; i++) { let diag = 0; for (let j = 1; j <= c.length; j++) { const up = prev[j]; prev[j] = r[i - 1] === c[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]); diag = up; } }
  const n = r.length || 1; return { prefix: +(prefix / n).toFixed(3), lcs: +(prev[c.length] / n).toFixed(3) };
}
const meanOf = (xs, k) => (xs.length ? +(xs.reduce((a, x) => a + x[k], 0) / xs.length).toFixed(3) : null);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
  const docs = Object.fromEntries(String(opt('docs', 'csa=v2/base-csa.json,nda=v2/base-nda.json')).split(',').map(x => x.split('=')));
  const dry = !!opt('dry-run'); const family = opt('family');
  if (!dry && !['opus', 'glm', 'deepseek'].includes(family)) { console.error('--family opus|glm|deepseek, or --dry-run'); process.exit(2); }
  const draws = {};
  const meta = existsSync(path.join(here, 'documents.json')) ? JSON.parse(readFileSync(path.join(here, 'documents.json'), 'utf8')).documents || {} : {};
  for (const [d, f] of Object.entries(docs)) {
    const file = path.resolve(TE, f); if (!existsSync(file)) { console.log(`${d}: ${f} does not exist yet; skipped`); continue; }
    const doc = stripCanary(JSON.parse(readFileSync(file, 'utf8'))); const m = meta[d]; if (m && m.base === path.relative(TE, file) && m.standardTermsFrom && !doc.standardTermsFrom) doc.standardTermsFrom = m.standardTermsFrom;
    draws[d] = { file: path.relative(TE, file), sha256: sha(readFileSync(file)), ...draw(d, doc) };
  }
  if (dry) {
    for (const [d, x] of Object.entries(draws)) {
      const none = x.picked.map(p => scoreContinuation(p.reference, '')), exact = x.picked.map(p => scoreContinuation(p.reference, p.reference + ' and so on'));
      console.log(`${d} (${x.file}): ${x.picked.length} paragraphs drawn (${x.rule}): ${x.picked.map(p => p.id).join(', ')}`);
      console.log(`  first prompt: "${x.picked[0]?.prompt}"`);
      console.log(`  empty continuation: prefix ${meanOf(none, 'prefix')}, lcs ${meanOf(none, 'lcs')}; exact continuation: prefix ${meanOf(exact, 'prefix')}, lcs ${meanOf(exact, 'lcs')}`);
      if (meanOf(none, 'prefix') !== 0 || meanOf(exact, 'prefix') !== 1) { console.error('probe dry run FAILED: the scoring does not give 0 and 1'); process.exitCode = 1; }
    }
    console.log('dry run: no model called, nothing written');
  } else {
    const { runModel } = await import('../../contract-review/server/executors.js');
    const defaults = { opus: { executor: 'claude', model: 'claude-opus-5-5' } }[family] || {};
    const config = { executor: opt('executor', defaults.executor || 'openai'), model: opt('model', defaults.model), effort: opt('effort', 'medium'), traceDir: null, toolsSupported: false };
    if (config.executor === 'openai') { if (!opt('base-url')) throw Error('--base-url and --key-env for an OpenAI-compatible endpoint'); process.env.OPENAI_BASE_URL = opt('base-url'); const key = process.env[opt('key-env', 'OPENAI_API_KEY')]; if (!key) throw Error(`${opt('key-env')} is not set`); process.env.OPENAI_API_KEY = key; }
    const outFile = path.resolve(TE, opt('out', 'v2/probe.json')); const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { format: 'tough-eval-probe/1', canary: canaryGuid(), families: {} };
    const result = { model: config.model, executor: config.executor, date: new Date().toISOString(), systemSha256: sha(SYSTEM), documents: {} };
    for (const [d, x] of Object.entries(draws)) {
      const rows = [];
      for (const p of x.picked) {
        // runModel parses a JSON object; the probe wants text, so the continuation is asked for inside a JSON field.
        let continuation = '', error = null;
        try { const r = await runModel({ name: 'probe', system: SYSTEM + ' Return it as JSON: {"continuation": "..."}', payload: { start: p.prompt }, config }); continuation = String(r.data?.continuation || ''); }
        catch (e) { error = e.message.slice(0, 300); }
        rows.push({ ...p, continuation, ...scoreContinuation(p.reference, continuation), ...(error ? { error } : {}) });
      }
      result.documents[d] = { file: x.file, sha256: x.sha256, rule: x.rule, paragraphs: rows, meanPrefix: meanOf(rows, 'prefix'), meanLcs: meanOf(rows, 'lcs') };
      console.log(`${family} ${d}: verbatim prefix ${result.documents[d].meanPrefix}, lcs ${result.documents[d].meanLcs}`);
    }
    prev.families[family] = result; writeFileSync(outFile, JSON.stringify(prev, null, 1) + '\n');
  }
}
