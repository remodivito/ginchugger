// SPDX-License-Identifier: GPL-3.0-or-later
// The checks preflight-live.sh runs after each live call (pre-flight before the v2 test runs, 15 October). No model
// call: it reads what run.mjs or the judge wrote and prints one line per check, PASS, WARN or FAIL, appending the same
// lines to <summary file> so the script can total them.
//   node tough-eval/v2/preflight-check.mjs review <runDir> --label <name> --layer A|B|H [--plain] --summary <file>
//       the variant's result exists and is usable (if not: one FAIL, and the trace checks are SKIP); no canary in traces/*/review.user.json (or a tool result); the
//       side's prompt filled in (review.system.txt: no {side}/{playbookParty} left, the product's or the plain prompt as
//       asked); servedModel and errorClass recorded; the item scored (score.mjs, contractnli/score.mjs --split
//       development, score-h.mjs). Layer B also re-checks the NDA is on the development split. Layer H: tools were
//       called, store citations verified by review.js (unverifiedRecordCitations 0) and by score-h.mjs, and the store
//       brief names the document under review and counts the counterparty's other documents as seeded (16 October:
//       the flat document store of decisions 190 and 191 replaced the brief's earlier-round count).
//   node tough-eval/v2/preflight-check.mjs judge <judgement.json> --label <name> --summary <file>
//       a usable verdict, the served model recorded, no canary in what was sent.
//   node tough-eval/v2/preflight-check.mjs summary <file>
//       PASS/WARN/FAIL counts and the total token usage; exit 1 on any FAIL.
// A servedModel left null by the OpenAI-compatible executor is a WARN, not a FAIL: contract-review/server/executors.js
// does not keep the response's `model` field (reported to the user; the product is not changed by the eval).
import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carriesCanary, canaryGuid, stripCanary } from './canary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)); const TE = path.resolve(here, '..');
const FIXTURE_CANARY = '5f0c1e2a-9b7d-4c3e-8a61-0d2f4b6c8e10';
const GUIDS = [canaryGuid(), FIXTURE_CANARY].filter(Boolean);
const argv = process.argv.slice(2); const cmd = argv[0]; const target = argv[1];
const opt = k => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const summaryFile = opt('summary'); const label = opt('label') || '';
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
let failed = 0;
function line(status, what, proof) {
  const s = `${status.padEnd(4)} [${label}] ${what}${proof !== undefined ? ` :: ${proof}` : ''}`; console.log(s);
  if (status === 'FAIL') failed++;
  if (summaryFile) appendFileSync(summaryFile, s + '\n');
}
const check = (ok, what, proof) => line(ok ? 'PASS' : 'FAIL', what, proof);
/** Input and output tokens from a result's or judgement's usage, whatever the executor. */
function tokens(usage) {
  if (!usage) return { input: 0, output: 0 };
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.prompt_tokens || 0);
  return { input, output: (usage.output_tokens || 0) + (usage.completion_tokens || 0) };
}
const recordTokens = (usage, model) => { const t = tokens(usage); if (summaryFile) appendFileSync(summaryFile, `TOKENS [${label}] ${model} input ${t.input} output ${t.output}\n`); return t; };

async function review(dir) {
  const layer = opt('layer'); const plain = !!opt('plain');
  const manifest = readJson(path.join(dir, 'manifest.json')); const ids = manifest.variants.map(v => v.id);
  check(ids.length === 1, 'one variant in the run', ids.join(','));
  const id = ids[0]; const resFile = path.join(dir, 'results', `${id}.json`);
  if (!existsSync(resFile)) { check(false, 'result written', `${resFile} missing`); return; }
  const r = readJson(resFile);
  check(r.ok === true, 'review usable', r.ok ? `ok in ${Math.round(r.ms / 1000)} s` : `${r.errorClass}: ${String(r.error).slice(0, 200)}`);
  recordTokens(r.model?.usage, manifest.model);
  const traces = path.join(dir, 'traces');
  if (!r.ok) line('SKIP', 'trace, prompt and servedModel checks', `the review failed (above); the product writes no trace for a failed call; errorClass ${r.errorClass}`);
  else {
    // Canary: nothing the model received carries one.
    const sent = existsSync(traces) ? readdirSync(traces).flatMap(v => ['review.user.json', 'review.tools.jsonl', 'review.system.txt'].map(f => path.join(traces, v, f)).filter(existsSync)) : [];
    const users = sent.filter(f => f.endsWith('review.user.json'));
    const carrying = sent.filter(f => carriesCanary(readFileSync(f, 'utf8'), GUIDS));
    check(users.length > 0 && carrying.length === 0, 'no canary in traces/*/review.user.json (nor system prompt, tool results)', `${users.length} user payload(s), ${sent.length} file(s) checked, ${carrying.length} carrying a canary${carrying.length ? ': ' + carrying.map(f => path.relative(dir, f)).join(', ') : ''}`);
    // The side's prompt filled in.
    const sysFile = path.join(traces, id, 'review.system.txt');
    if (!existsSync(sysFile)) check(false, 'review.system.txt written', 'missing');
    else {
      const sys = readFileSync(sysFile, 'utf8'); const left = sys.match(/\{(side|playbookParty)\}/g) || [];
      const variant = manifest.variants[0]; const playbook = stripCanary(readJson(path.join(TE, manifest.playbookOverride || variant.playbook)));
      const party = playbook.party || ({ C: 'Customer', V: 'Provider' })[String(playbook.rules?.[0]?.id || '')[0]] || null;
      const product = readFileSync(path.join(TE, '../contract-review/prompts/review.md'), 'utf8').trim().slice(0, 120);
      const which = plain ? (party ? sys.includes(party) && !sys.startsWith(product) : !sys.startsWith(product)) : sys.trim().startsWith(product);
      check(left.length === 0 && sys.trim().length > 200 && which, `the side's prompt filled in (${plain ? 'plain' : 'product'})`, `${sys.length} chars, ${left.length} placeholder(s) left, starts "${sys.trim().slice(0, 70).replace(/\s+/g, ' ')}…"${plain && party ? `, names the ${party}` : ''}`);
    }
    // servedModel and errorClass recorded.
    const executor = manifest.executor; const hasKeys = 'servedModel' in r && 'errorClass' in r;
    if (!hasKeys) check(false, 'servedModel and errorClass recorded', `keys: ${Object.keys(r).join(', ')}`);
    else if (r.ok && !r.servedModel && executor === 'openai') line('WARN', 'servedModel recorded', `null (the product's OpenAI-compatible executor drops the response's model field); errorClass ${r.errorClass}`);
    else check(!r.ok || !!r.servedModel, 'servedModel and errorClass recorded', `servedModel ${r.servedModel}; errorClass ${r.errorClass}`);
  }
  // Scored.
  if (layer === 'B') {
    const split = readJson(path.join(TE, 'contractnli/split.json'));
    check(split.development.includes(id) && !split.heldout.includes(id), 'the NDA is on the development split', id);
    const { scoreRun } = await import('../contractnli/score.mjs'); const s = scoreRun(dir, 'development'); const d = s.docs.find(x => x.variant === id);
    const pairs = s.pairs.filter(p => p.variant === id && p.gold === 'departs');
    check(!!d, 'scored (contractnli/score.mjs, development split)', d ? `labelled departures caught ${pairs.filter(p => p.kind === 'caught').length}/${pairs.length}; false alarms ${d.falseAlarms}; invented quotes ${d.unverifiable ?? 0}` : 'not in the score');
    return;
  }
  const { scoreRun } = await import('../score.mjs'); const s = scoreRun(dir); const d = s.docs.find(x => x.variant === id);
  const plants = s.plants.filter(p => p.variant === id && p.kind === 'deviation');
  check(!!d, 'scored (score.mjs)', d ? `caught ${plants.filter(p => p.caught).length}/${plants.length}, fixed ${plants.filter(p => p.fixed).length}; false alarms ${d.falseAlarms}; all-pass ${d.allPass}; invented ${d.unverifiable ?? 0}` : 'not in the score');
  if (layer !== 'H') return;
  const tools = Array.isArray(r.tools) ? r.tools : [];
  check(r.agentic === true && tools.length > 0, 'tools were called (agentic)', `${tools.length} call(s): ${tools.map(t => t.name).join(', ') || 'none'}`);
  check(r.ok && (r.unverifiedRecordCitations ?? 0) === 0, 'store citations verified by review.js', `unverifiedRecordCitations ${r.unverifiedRecordCitations ?? 'absent'}`);
  const { scoreH } = await import('./score-h.mjs'); const h = await scoreH(dir); const sc = h.scenarios.find(x => x.scenario === id);
  check(!!sc && sc.citationVerifiable, 'store citations verified by score-h.mjs', sc ? `${sc.citations} citation(s), ${sc.unverifiableCitations.length} unverifiable${sc.precedentCited !== undefined ? `; precedent cited ${sc.precedentCited}` : ''}; tool calls ${sc.toolCalls}` : 'not scored');
  if (sc && sc.citations === 0) line('WARN', 'store citations exercised', 'the review cited nothing from the store, so the citation checks passed vacuously');
  const scenario = readJson(path.join(TE, manifest.variants[0].scenario || `v2/fixtures/synthetic/scenarios/${id}.json`));
  // The store brief (decisions 190 and 191): the document under review is in the store, and the count of this
  // counterparty's other documents is what seed-record.mjs seeded (earlier drafts and their emails, every matter of theirs).
  const { scenarioStoreSeed } = await import('./seed-record.mjs'); const { suiteNamed } = await import('../score.mjs');
  const flat = scenarioStoreSeed(scenario, readJson(path.join(TE, suiteNamed(manifest.suiteName).variants.find(v => v.id === id).file)));
  const want = flat.refs.filter(x => x.counterparty === scenario.matter.counterparty && !x.current).length;
  const brief = readJson(path.join(traces, id, 'review.user.json')).store || {};
  check(!!brief.document && brief.otherDocumentsWithThisCounterparty === want, "the brief's document and counterparty count", `document ${brief.document ? brief.document.documentId : 'absent'}; otherDocumentsWithThisCounterparty ${brief.otherDocumentsWithThisCounterparty}, store seeded with ${want}`);
}

function judge(file) {
  if (!existsSync(file)) { check(false, 'judgement written', `${file} missing`); return; }
  const j = readJson(file);
  check(j.ok === true && typeof j.pass === 'boolean', 'usable verdict', j.ok ? `pass ${j.pass}: ${String(j.reason || '').slice(0, 120)}` : `${j.errorClass}: ${String(j.error).slice(0, 200)}`);
  check(!!j.servedModel, 'served model recorded', `model ${j.model}, served ${j.servedModel}`);
  const rendered = path.join(path.dirname(path.dirname(file)), `${j.task}.rendered.txt`);
  const body = existsSync(rendered) ? readFileSync(rendered, 'utf8').split('\n').slice(1).join('\n') : '';
  check(body.length > 0 && !carriesCanary(body, GUIDS), 'no canary in the rendering the judge read', `${body.length} chars (the saved file's first line is the canary stamp, not sent)`);
  recordTokens(j.usage, j.model);
}

function summary(file) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const n = k => lines.filter(l => l.startsWith(k)).length; let input = 0, output = 0;
  for (const l of lines.filter(l => l.startsWith('TOKENS'))) { const m = l.match(/input (\d+) output (\d+)/); if (m) { input += +m[1]; output += +m[2]; } }
  console.log(`\nchecks: ${n('PASS')} PASS, ${n('WARN')} WARN, ${n('SKIP')} SKIP, ${n('FAIL')} FAIL`);
  for (const l of lines.filter(l => l.startsWith('TOKENS'))) console.log('  ' + l);
  console.log(`total tokens: input ${input}, output ${output}`);
  console.log(n('FAIL') ? 'PREFLIGHT FAIL' : 'PREFLIGHT PASS');
  if (n('FAIL')) process.exitCode = 1;
}

if (cmd === 'review') await review(path.resolve(target));
else if (cmd === 'judge') judge(path.resolve(target));
else if (cmd === 'summary') summary(path.resolve(target));
else { console.error('usage: preflight-check.mjs review <runDir> --label <l> --layer A|B|H [--plain] --summary <file> | judge <file> --label <l> --summary <file> | summary <file>'); process.exitCode = 2; }
if (failed) process.exitCode = 1;
