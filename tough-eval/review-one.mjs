// SPDX-License-Identifier: GPL-3.0-or-later
// One review of one variant through the product's own pipeline (server/review.js, third-party mode, no baseline).
// Model, effort and executor come from the environment the runner sets. Writes the result or the error to <out>.
// `demo` runs the v1 rule engine (baselines/local-rules.mjs, the product's former Sample mode) instead, with no model;
// REVIEW_ARM names a decomposed or agent arm (arms/review-decomposed.mjs) instead of the single call.
// v2 (BENCHMARK-V2.md 5.11, 10, 11.5, 14.2):
//   - the canary field is removed from the document and the playbook before anything reaches the reviewer;
//   - a review prompt holding {side} or {playbookParty} is filled from the playbook's `party` (the side-parameterised
//     plain prompt; arms/render-prompt.mjs) into a file beside the trace, and that file is what the model receives;
//   - TOUGH_EVAL_AGENTIC = <scenario.json> runs the agentic review over that scenario's seeded document store (layer H),
//     or `empty` over a store holding only the current document (the 40 empty-record items), through
//     v2/seed-record.mjs and the product's store tools (decisions 190 and 191);
//   - a failure carries `errorClass` (v2/retry-policy.mjs); every result carries `innerRetries` (the executor's own
//     retries, from its metadata where it reports them) and, for agentic runs, `tools: [{ name, args, resultBytes }]`.
// Usage: node tough-eval/review-one.mjs <variant.json> <out.json> [demo|live] [<playbook.json>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewDocument } from '../contract-review/server/review.js';
import { applyControl } from './controls.mjs';
import { stripCanary } from './v2/canary.mjs';
import { classify } from './v2/retry-policy.mjs';
import { renderPrompt } from './arms/render-prompt.mjs';

async function review(args) {
  if (mode === 'demo') return (await import('./baselines/local-rules.mjs')).reviewLocal(args);
  const arm = process.env.REVIEW_ARM;
  if (arm && arm !== 'single') return (await import('./arms/review-decomposed.mjs')).reviewDocumentDecomposed({ ...args, arm });
  return reviewDocument(args);
}
const innerRetriesOf = meta => (Number.isInteger(meta?.innerRetries) ? meta.innerRetries : Number.isInteger(meta?.streamAttempts) && meta.streamAttempts > 0 ? meta.streamAttempts - 1 : null);
const servedModelOf = meta => (meta?.servedModel || meta?.museModel || null);

const [variantPath, outPath, mode = 'live', playbookPath = new URL('./playbook.json', import.meta.url)] = process.argv.slice(2);
const { document, playbook } = applyControl(process.env.TOUGH_EVAL_CONTROL || null, {
  document: stripCanary(JSON.parse(readFileSync(variantPath, 'utf8'))),
  playbook: stripCanary(JSON.parse(readFileSync(playbookPath, 'utf8'))),
});
if (process.env.REVIEW_PROMPT) process.env.REVIEW_PROMPT = renderPrompt(process.env.REVIEW_PROMPT, playbook, process.env.REVIEW_TRACE_DIR || path.join(tmpdir(), 'tough-eval-prompts'));
const agenticSpec = process.env.TOUGH_EVAL_AGENTIC || '';
const started = Date.now(); let opened = null;
try {
  let agentic = null;
  if (agenticSpec && mode !== 'demo') {
    const { openReviewStore } = await import('./v2/seed-record.mjs');
    const scenario = agenticSpec === 'empty' ? null : JSON.parse(readFileSync(agenticSpec, 'utf8'));
    const item = scenario ? null : { document: process.env.TOUGH_EVAL_DOCUMENT || 'csa', side: process.env.TOUGH_EVAL_SIDE || 'customer' };
    opened = await openReviewStore({ scenario, item, document, listen: (process.env.REVIEW_EXECUTOR || 'claude') === 'claude' });
    agentic = opened.agentic;
  }
  const r = await review({ document, playbook, reviewMode: 'third-party', baseline: null, ...(agentic ? { agentic } : {}) });
  writeFileSync(outPath, JSON.stringify({ ok: true, ms: Date.now() - started, model: r.model || null, servedModel: servedModelOf(r.model), errorClass: null, innerRetries: innerRetriesOf(r.model), ...(r.consolidation ? { consolidation: r.consolidation, memos: r.memos } : {}),
    ...(agentic ? { agentic: true, tools: (r.toolCalls || []).map(t => ({ name: t.name, args: t.args, resultBytes: t.bytes, ...(t.error ? { error: t.error } : {}) })), unverifiedRecordCitations: r.unverifiedRecordCitations ?? 0 } : {}),
    findings: r.findings, limits: r.limits }, null, 1));
} catch (e) {
  const error = e.message + (e.cause ? ` (${e.cause.code || ''} ${e.cause.message || ''})` : '');
  writeFileSync(outPath, JSON.stringify({ ok: false, ms: Date.now() - started, error, errorClass: classify(error), innerRetries: null }, null, 1));
  process.exitCode = 1;
} finally { if (opened) await opened.close(); }
