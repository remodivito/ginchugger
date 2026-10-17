// SPDX-License-Identifier: GPL-3.0-or-later
// Decomposed review arms (decomposed-arm-brief.md): the same review fanned out to one worker per active playbook rule,
// then merged. A rule-parallel workflow, not a multi-agent system: code decides every step; models do the reading.
//   decomposed        one model call per rule (sees everything the single call sees, plus a focus on its rule)
//   decomposed-raw    the same, with the consolidator skipped (union of every worker's findings)
//   decomposed-agent  one small agent per rule: it gets an outline of the agreement and reads, searches, looks up
//                     definitions and resolves cross-references with tools, for up to REVIEW_AGENT_TURNS replies
//   decomposed-agent-raw  the agent arm without the consolidator
//   agent             one review agent over the whole playbook: it receives the whole agreement, as the single call
//                     does, and can read, search, look up definitions and follow cross-references with tools for up to
//                     REVIEW_AGENT_TURNS replies before answering
//   agent-hybrid      the agent as the main review, plus per-rule checker calls as in hybrid
//   hybrid            the single call as the main review, plus one checker call per rule on REVIEW_WORKER_MODEL (e.g. a
//                     cheaper model); a checker's finding is added only on a paragraph the main review did not flag, and
//                     says so. No sweep, no consolidator: the main review already covers the agreement.
// After the workers, one sweep call covers paragraphs no worker addressed (in own-paper mode every tracked change
// must still be accounted for). Every worker's output goes through the same validator as the single call. Then a
// deterministic merge by paragraph: a paragraph with one worker's findings is final; a paragraph where findings from
// two or more workers need attention or propose wording goes to one consolidator call, which must account for every
// input finding (kept, merged-into or dropped with a reason). If its accounting is incomplete or its output fails
// validation, that paragraph keeps the unmerged findings and says so. Memos are written to <traceDir>/memos as they
// land, so a crash loses nothing and a run can be replayed through the replay executor.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutorConfig, runModel } from '../../contract-review/server/executors.js';
import { attachComparison, changeFor, checkInputs, loadPrompt, makeReview, reviewDocument, validateFindings } from '../../contract-review/server/review.js';

// The arm prompts live beside this file. Same contract as the product's loadPrompt: an environment variable
// (REVIEW_RULE_PROMPT, SWEEP_PROMPT, ...) may name an alternative file; the text is hashed for the manifest.
export const ARM_PROMPT_DIR = fileURLToPath(new URL('./', import.meta.url));
const armPromptCache = new Map();
function armPrompt(name) {
  const file = process.env[`${name.toUpperCase().replaceAll('-', '_')}_PROMPT`] || path.join(ARM_PROMPT_DIR, `${name}.md`);
  if (!armPromptCache.has(file)) { const text = readFileSync(file, 'utf8'); armPromptCache.set(file, { text, sha256: createHash('sha256').update(text).digest('hex'), file }); }
  return armPromptCache.get(file);
}

export const ARMS = ['decomposed', 'decomposed-raw', 'decomposed-agent', 'decomposed-agent-raw', 'hybrid', 'agent', 'agent-hybrid'];

// ---- indexes (no model calls) ----------------------------------------------------------------------------------

const TERM_DEF = /[“"]([A-Z][A-Za-z0-9 ’'&\-/]{1,60})[”"]\s+(?:means|shall mean|has the meaning|refers to|includes)\b/g;
const TERM_PAREN = /\((?:the |each,? (?:a|an) |together,? the |collectively,? the |hereinafter |individually,? (?:a|an) )?[“"]([A-Z][A-Za-z0-9 ’'&\-/]{1,60})[”"]\)/g;
const XREF = /\b(Section|Clause|Article|Exhibit|Schedule|Annex|Appendix|paragraph)\s+((?:\d+(?:\.\d+)*)(?:\s*\([a-z0-9]+\))*|[A-Z](?:-\d+)?)\b/g;
const LABEL = /^\s*(?:(?:Section|Clause|Article)\s+)?(\d+(?:\.\d+)*)[.)]?\s/;

export function buildIndexes(document) {
  const ps = document.paragraphs;
  const terms = new Map();
  for (const p of ps) for (const re of [TERM_DEF, TERM_PAREN]) for (const m of String(p.text).matchAll(re)) if (!terms.has(m[1])) terms.set(m[1], p.id);
  const definedTerms = [...terms].map(([term, paragraphId]) => ({ term, paragraphId, usedIn: ps.filter(p => p.id !== paragraphId && p.text.includes(term)).map(p => p.id).slice(0, 30) }));
  const byLabel = new Map(); const byHeading = new Map();
  for (const p of ps) { const m = String(p.text).match(LABEL); if (m && !byLabel.has(m[1])) byLabel.set(m[1], p.id); const h = String(p.text).trim().match(/^(Exhibit|Schedule|Annex|Appendix)\s+([A-Z0-9-]+)\b/i); if (h && !byHeading.has(`${h[1].toLowerCase()} ${h[2]}`)) byHeading.set(`${h[1].toLowerCase()} ${h[2]}`, p.id); }
  const refs = new Map();
  for (const p of ps) for (const m of String(p.text).matchAll(XREF)) {
    const ref = `${m[1]} ${m[2].replace(/\s+/g, '')}`; const num = m[2].replace(/\s*\(.*$/, '');
    const to = /^(Exhibit|Schedule|Annex|Appendix)$/i.test(m[1]) ? byHeading.get(`${m[1].toLowerCase()} ${num}`) ?? null : byLabel.get(num) ?? null;
    const e = refs.get(ref) || { reference: ref, paragraphId: to, citedIn: [] }; if (!e.citedIn.includes(p.id) && e.citedIn.length < 30) e.citedIn.push(p.id); refs.set(ref, e);
  }
  return { definedTerms, crossReferences: [...refs.values()] };
}

// ---- agent tools (no model calls) --------------------------------------------------------------------------------

export function agentTool(request, document, indexes) {
  const ps = document.paragraphs; const byId = new Map(ps.map(p => [p.id, p]));
  const show = p => ({ id: p.id, text: p.text, ...(typeof p.originalText === 'string' && p.originalText !== p.text ? { originalText: p.originalText } : {}) });
  switch (request?.tool) {
    case 'read': return { paragraphs: (Array.isArray(request.paragraphIds) ? request.paragraphIds : []).slice(0, 12).map(id => byId.get(id)).filter(Boolean).map(show) };
    case 'search': {
      const q = String(request.query || '').toLowerCase().trim(); if (!q) return { error: 'query is empty' };
      const hits = ps.filter(p => `${p.text}\n${p.originalText || ''}`.toLowerCase().includes(q)).slice(0, 20);
      return { matches: hits.map(p => { const t = p.text.toLowerCase().includes(q) ? p.text : p.originalText; const i = t.toLowerCase().indexOf(q); return { id: p.id, snippet: t.slice(Math.max(0, i - 80), i + q.length + 80) }; }) };
    }
    case 'define': {
      const t = String(request.term || '').toLowerCase().replace(/[“”"]/g, '').trim();
      const e = indexes.definedTerms.find(d => d.term.toLowerCase() === t) || indexes.definedTerms.find(d => d.term.toLowerCase().includes(t));
      return e ? { term: e.term, definition: show(byId.get(e.paragraphId)), usedIn: e.usedIn } : { error: `no defined term "${request.term}"` };
    }
    case 'resolve': {
      const r = String(request.reference || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const e = indexes.crossReferences.find(x => x.reference.toLowerCase() === r.replace(/ \(/, '(')) || indexes.crossReferences.find(x => x.reference.toLowerCase().startsWith(r));
      return e?.paragraphId ? { reference: e.reference, paragraph: show(byId.get(e.paragraphId)), citedIn: e.citedIn } : { error: `cannot resolve "${request.reference}"` };
    }
    default: return { error: `unknown tool ${JSON.stringify(request?.tool)}; use read, search, define or resolve, or give the final answer` };
  }
}

// ---- merge and consolidation (no model calls) ----------------------------------------------------------------------

const proposes = f => typeof f.proposedText === 'string' || (Array.isArray(f.insertAfter) && f.insertAfter.length);
const needs = f => f.status === 'attention' || proposes(f);

/** Deterministic merge: final findings, and the paragraphs that need the consolidator. */
export function mergeFindings(findings) {
  const byPara = new Map();
  for (const f of findings) { const k = f.paragraphId || `unanchored:${f.id}`; (byPara.get(k) || byPara.set(k, []).get(k)).push(f); }
  const final = [], conflicts = [];
  for (const [paragraphId, fs] of byPara) {
    const sources = new Set(fs.filter(needs).map(f => f.memoId));
    if (sources.size >= 2 && !paragraphId.startsWith('unanchored:')) conflicts.push({ paragraphId, findings: fs });
    else final.push(...fs);
  }
  return { final, conflicts };
}

/** A consolidator's accounting is complete when every input finding is disposed of exactly once, kept and merged
 *  findings name an output, and every drop gives a reason. Returns a list of problems (empty when complete). */
export function checkDispositions(inputIds, dispositions, outputCount) {
  const problems = []; const seen = new Map();
  for (const d of Array.isArray(dispositions) ? dispositions : []) {
    if (!d || !inputIds.includes(d.inputId)) { problems.push(`disposition for unknown input ${JSON.stringify(d?.inputId)}`); continue; }
    seen.set(d.inputId, (seen.get(d.inputId) || 0) + 1);
    if (!['kept', 'merged-into', 'dropped'].includes(d.outcome)) problems.push(`${d.inputId}: unknown outcome ${JSON.stringify(d.outcome)}`);
    if (d.outcome !== 'dropped' && !(Number.isInteger(d.into) && d.into >= 0 && d.into < outputCount)) problems.push(`${d.inputId}: ${d.outcome} names no output finding`);
    if (d.outcome === 'dropped' && !String(d.reason || '').trim()) problems.push(`${d.inputId}: dropped without a reason`);
  }
  for (const id of inputIds) { const n = seen.get(id) || 0; if (n !== 1) problems.push(`${id}: disposed of ${n} times`); }
  return problems;
}

// ---- hybrid: main review plus per-rule checkers ------------------------------------------------------------------

/** Adds checker findings only where the main review raised nothing that needs attention; the main review stands
 *  wherever it flagged a paragraph. Each added finding says it came from a per-rule check. */
export function addCheckerFindings(mainFindings, checkerFindings) {
  const flagged = new Set(mainFindings.filter(needs).map(f => f.paragraphId));
  const added = checkerFindings.filter(f => needs(f) && f.paragraphId && !flagged.has(f.paragraphId))
    .map(f => ({ ...f, notes: [...(f.notes || []), `Found by the per-rule check for ${f.sourceRule}, not by the main review.`] }));
  return { added, ignored: checkerFindings.length - added.length };
}

function hybridResult(main, memos, { workerConfig, stats, started, rules, base, rulePrompt, document, baseline }) {
  const { added, ignored } = addCheckerFindings(main.findings, memos.flatMap(m => m.findings));
  const result = { ...main, findings: [...main.findings, ...added] };
  result.limits = [...new Set([...(main.limits || []), ...memos.flatMap(m => [...m.limits, ...m.notes])])];
  result.coverage = rules.map(r => ({ ruleId: r.id, status: result.findings.some(f => (f.ruleIds || []).includes(r.id)) ? 'examined' : 'not-assessed', findingIds: result.findings.filter(f => (f.ruleIds || []).includes(r.id)).map(f => f.id) }));
  result.model = { ...main.model, arm: 'hybrid', workerModel: workerConfig.model, rules: rules.length, checkers: { ...stats, added: added.length, ignored }, wallMs: Date.now() - started,
    prompts: { ...(main.model?.prompts || {}), [path.basename(base.file)]: base.sha256, [path.basename(rulePrompt.file)]: rulePrompt.sha256 } };
  result.memos = memos.map(m => ({ memoId: m.memoId, ruleId: m.ruleId, findings: m.findings.length }));
  return attachComparison(result, document, baseline);
}

// ---- the arms -------------------------------------------------------------------------------------------------------

async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const addUsage = (t, meta) => { const u = meta?.usage || {}; t.inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); t.cacheReadTokens += u.cache_read_input_tokens || 0; t.outputTokens += u.output_tokens || 0; if (typeof meta?.costUsd === 'number') t.costUsd += meta.costUsd; };

export async function reviewDocumentDecomposed({ document, baseline = null, playbook, context = null, reviewMode = 'own-paper', history = null, arm = 'decomposed' }) {
  if (!ARMS.includes(arm)) throw new Error(`Unknown review arm "${arm}". Use one of: single, ${ARMS.join(', ')}.`);
  checkInputs(document, playbook, baseline);
  if (!['own-paper', 'third-party'].includes(reviewMode)) throw new Error('Unknown review mode.');
  if (reviewMode === 'third-party' && baseline) { context = [...(context || []), { name: 'standard-form (reference language, not a prior version)', text: baseline.paragraphs.map(p => p.text).filter(Boolean).join('\n') }]; baseline = null; }
  const agent = arm.startsWith('decomposed-agent'), consolidate = !arm.endsWith('-raw'), hybrid = arm === 'hybrid' || arm === 'agent-hybrid', mainAgent = arm === 'agent' || arm === 'agent-hybrid';
  const config = getExecutorConfig(); const workerConfig = hybrid ? { ...config, model: process.env.REVIEW_WORKER_MODEL || config.model } : config; const concurrency = Number(process.env.REVIEW_CONCURRENCY || 4); const maxTurns = Number(process.env.REVIEW_AGENT_TURNS || 8);
  const base = loadPrompt('review'), rulePrompt = armPrompt(agent ? 'review-rule-agent' : 'review-rule'), sweepPrompt = armPrompt('sweep'), consolidatePrompt = armPrompt('consolidate');
  const rules = playbook.rules.filter(r => r.enabled !== false);
  const held = Array.isArray(history) && history.length ? history.map(h => ({ itemId: h.itemId, filename: h.filename, kind: h.kind, date: h.date, text: h.text })) : null;
  const shared = { baseline, playbook: { ...playbook, rules }, ...(context ? { context } : {}), ...(held ? { history: held } : {}), mode: reviewMode };
  const indexes = buildIndexes(document);
  const memoDir = config.traceDir ? path.join(config.traceDir, 'memos') : null; if (memoDir) mkdirSync(memoDir, { recursive: true });
  const started = Date.now(); const stats = { calls: 0, retries: 0, firstMemoMs: null, agentTurns: {}, notAssessed: [], inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0 };
  if (memoDir) writeFileSync(path.join(config.traceDir, 'decomposed-manifest.json'), JSON.stringify({ arm, rules: rules.map(r => r.id), concurrency, maxTurns: agent ? maxTurns : null, executor: config.executor, model: config.model, effort: config.effort,
    prompts: Object.fromEntries([base, rulePrompt, sweepPrompt, consolidatePrompt].map(p => [path.basename(p.file), p.sha256])) }, null, 1));

  const call = async (name, system, payload, cfg = config) => {
    for (let attempt = 0; ; attempt++) {
      try { stats.calls++; const r = await runModel({ name, system, payload, config: cfg }); addUsage(stats, r.meta); return r; }
      catch (e) { if (attempt >= 1 || e.code === 'NO_RECORDING') throw e; stats.retries++; }
    }
  };
  const validate = raw => validateFindings(raw, document, playbook, { history: held || [], context });
  // An agent loop: one request per reply (read, search, define, resolve), the transcript sent back each turn, until a
  // final answer or the turn budget runs out (the last reply must be the answer).
  const agentLoop = async (name, system, payloadFor, cfg = config) => {
    const transcript = [];
    for (let turn = 1; ; turn++) {
      const left = maxTurns - turn + 1;
      const reply = (await call(`${name}-t${turn}`, system, payloadFor(transcript, left), cfg)).data;
      if (reply && reply.tool && left > 1) { transcript.push({ request: reply, result: agentTool(reply, document, indexes) }); continue; }
      return { raw: reply && reply.tool ? { findings: [], limits: [`${name}: ran out of turns before a final answer`] } : reply, turns: turn, transcript };
    }
  };
  // The single review agent: the whole agreement and playbook, plus tools. Assembled like the single call's review.
  const agentReview = async () => {
    const agentPrompt = armPrompt('review-agent');
    const r = await agentLoop('agent', `${base.text}\n\n${agentPrompt.text}`, (transcript, left) => ({ document, ...shared, indexes, transcript, turnsLeft: left }));
    if (config.traceDir) writeFileSync(path.join(config.traceDir, 'agent-transcript.json'), JSON.stringify(r.transcript.map(t => t.request), null, 1));
    const v = validate(r.raw);
    const result = makeReview(document, baseline, playbook, 'live-model');
    result.findings = v.findings.map(f => ({ ...f, id: f.id || randomUUID() }));
    result.limits = [...new Set([...v.limits, ...v.notes])].concat('Model findings require lawyer verification. Exact citation validation does not establish the correctness of an interpretation. No automatic approval or sending occurs.');
    result.coverage = rules.map(rule => ({ ruleId: rule.id, status: result.findings.some(f => (f.ruleIds || []).includes(rule.id)) ? 'examined' : 'not-assessed', findingIds: result.findings.filter(f => (f.ruleIds || []).includes(rule.id)).map(f => f.id) }));
    result.model = { executor: config.executor, model: config.model, effort: config.effort, arm: 'agent', turns: r.turns, toolRequests: r.transcript.map(t => t.request.tool), calls: stats.calls, retries: stats.retries, inputTokens: stats.inputTokens, cacheReadTokens: stats.cacheReadTokens, outputTokens: stats.outputTokens, costUsd: stats.costUsd, wallMs: Date.now() - started, prompts: { [path.basename(base.file)]: base.sha256, [path.basename(agentPrompt.file)]: agentPrompt.sha256 } };
    return attachComparison(result, document, baseline);
  };

  // Workers: one per rule.
  const outline = document.paragraphs.map(p => ({ id: p.id, opening: String(p.text).slice(0, 120), ...(typeof p.originalText === 'string' && p.originalText !== p.text ? { changed: true } : {}) }));
  // A worker whose answer cannot be read (twice) costs that rule, recorded as not assessed (brief §3.8). Any other
  // failure — the CLI exiting, a usage limit, a missing recording — fails the whole review, so the runner retries it
  // instead of scoring a review with rules silently missing.
  const unreadable = e => e instanceof SyntaxError || /did not return (a JSON object|bounded valid JSON)/.test(String(e?.message));
  const worker = async rule => {
    try { return await workerFor(rule); }
    catch (e) {
      if (!unreadable(e)) throw e;
      stats.notAssessed.push(rule.id);
      const memo = { memoId: `memo-${rule.id}`, ruleId: rule.id, findings: [], notes: [], limits: [`${rule.id}: not assessed (${e.message})`] };
      if (memoDir) writeFileSync(path.join(memoDir, `${rule.id}.json`), JSON.stringify(memo, null, 1));
      return memo;
    }
  };
  const workerFor = async rule => {
    let raw;
    if (!agent) raw = (await call(`rule-${rule.id}`, `${base.text}\n\n${rulePrompt.text}`, { document, ...shared, focusRule: rule, indexes }, workerConfig)).data;
    else {
      const r = await agentLoop(`rule-${rule.id}`, `${base.text}\n\n${rulePrompt.text}`, (transcript, left) => ({ outline, ...shared, focusRule: rule, definedTerms: indexes.definedTerms.map(d => d.term), transcript, turnsLeft: left }));
      raw = r.raw; stats.agentTurns[rule.id] = r.turns;
    }
    // An unusable answer from one worker costs that rule's findings, not the review: it is recorded as a limit.
    const memoId = `memo-${rule.id}`; let v; try { v = validate(raw); } catch (e) { v = { findings: [], notes: [], limits: [`${rule.id}: ${e.message}`] }; }
    const deps = new Map((Array.isArray(raw?.findings) ? raw.findings : []).map((f, i) => [i, Array.isArray(f?.dependsOnParagraphIds) ? f.dependsOnParagraphIds.filter(id => document.paragraphs.some(p => p.id === id)) : []]));
    const findings = v.findings.map((f, i) => ({ ...f, id: `${rule.id}#${i + 1}`, sourceRule: rule.id, memoId, ...(deps.get(i)?.length ? { dependsOn: deps.get(i) } : {}) }));
    if (stats.firstMemoMs === null) stats.firstMemoMs = Date.now() - started;
    const memo = { memoId, ruleId: rule.id, findings, notes: v.notes, limits: v.limits };
    if (memoDir) writeFileSync(path.join(memoDir, `${rule.id}.json`), JSON.stringify(memo, null, 1));
    return memo;
  };
  // Hybrid: the single call runs first (its own trace, its own validation), then the per-rule checkers.
  const main = mainAgent ? await agentReview() : hybrid ? await reviewDocument({ document, baseline, playbook, context, reviewMode, history }) : null;
  if (arm === 'agent') return main;
  const mainStats = mainAgent ? { calls: stats.calls, inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, costUsd: stats.costUsd } : null;
  if (mainAgent) Object.assign(stats, { calls: 0, retries: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0 });
  const memos = await pool(rules, concurrency, worker);
  if (hybrid) { const r = hybridResult(main, memos, { workerConfig, stats, started, rules, base, rulePrompt, document, baseline }); r.model.arm = arm; if (mainStats) r.model.main = mainStats; return r; }

  // Sweep: what no worker addressed.
  const touched = new Set(memos.flatMap(m => m.findings.map(f => f.paragraphId)));
  // Own paper: every tracked change no worker addressed. Third-party paper: untouched paragraphs long enough to carry an
  // obligation (under 80 characters is taken as a heading or boilerplate, brief §3.4).
  const sweepIds = document.paragraphs.filter(p => !touched.has(p.id) && String(p.text || p.originalText || '').trim() && (reviewMode === 'third-party' ? String(p.text).trim().length >= 80 : ['changed', 'recorded'].includes(changeFor(p, baseline)))).map(p => p.id);
  if (sweepIds.length) {
    const r = await call('sweep', `${base.text}\n\n${sweepPrompt.text}`, { document, ...shared, sweepParagraphIds: sweepIds });
    const v = validate(r.data); const findings = v.findings.filter(f => sweepIds.includes(f.paragraphId)).map((f, i) => ({ ...f, id: `sweep#${i + 1}`, sourceRule: 'sweep', memoId: 'memo-sweep' }));
    const memo = { memoId: 'memo-sweep', ruleId: 'sweep', findings, notes: v.notes, limits: v.limits }; memos.push(memo);
    if (memoDir) writeFileSync(path.join(memoDir, 'sweep.json'), JSON.stringify(memo, null, 1));
  }

  // Merge, then consolidate the conflicts.
  const all = memos.flatMap(m => m.findings);
  const { final, conflicts } = mergeFindings(all);
  const consolidation = { conflicts: conflicts.length, conflictParagraphs: conflicts.map(c => c.paragraphId), dispositions: [], fallbacks: [] };
  let merged = [...final];
  if (consolidate && conflicts.length) {
    const ruleById = new Map(rules.map(r => [r.id, r]));
    const payload = { conflicts: conflicts.map(c => { const p = document.paragraphs.find(x => x.id === c.paragraphId); return { paragraphId: c.paragraphId, text: p?.text, ...(typeof p?.originalText === 'string' ? { originalText: p.originalText } : {}),
      findings: c.findings.map(f => ({ inputId: f.id, sourceRule: f.sourceRule, title: f.title, status: f.status, decision: f.decision, explanation: f.explanation, evidence: f.evidence, ruleIds: f.ruleIds, ...(typeof f.proposedText === 'string' ? { proposedText: f.proposedText } : {}), ...(f.insertAfter ? { insertAfter: f.insertAfter } : {}), ...(f.options ? { options: f.options } : {}) })) }; }),
      rules: [...new Set(conflicts.flatMap(c => c.findings.flatMap(f => f.ruleIds || [])))].map(id => ruleById.get(id)).filter(Boolean), ...(context ? { context } : {}), mode: reviewMode };
    let out = null, problems = [];
    try { out = (await call('consolidate', consolidatePrompt.text, payload)).data; } catch (e) { problems = [`consolidator call failed: ${e.message}`]; }
    const outputs = Array.isArray(out?.findings) ? out.findings : [];
    const v = out ? validate({ findings: outputs }) : { findings: [] };
    if (out) problems = checkDispositions(conflicts.flatMap(c => c.findings.map(f => f.id)), out.dispositions, outputs.length);
    if (out && v.findings.some(f => !conflicts.some(c => c.paragraphId === f.paragraphId))) problems.push('consolidator returned a finding on a paragraph it was not given');
    if (!problems.length) {
      consolidation.dispositions = out.dispositions;
      merged.push(...v.findings.map((f, i) => ({ ...f, sourceRule: 'consolidated', memoId: 'memo-consolidate', mergedFrom: out.dispositions.filter(d => d.into === i && d.outcome !== 'dropped').map(d => d.inputId) })));
    } else {
      consolidation.fallbacks.push(...problems);
      merged.push(...conflicts.flatMap(c => c.findings.map(f => ({ ...f, notes: [...(f.notes || []), 'Other rule reviews also addressed this paragraph; reconciliation failed, so each is shown as found.'] }))));
    }
  } else if (conflicts.length) merged.push(...conflicts.flatMap(c => c.findings));

  // Assemble as the single call does.
  const result = makeReview(document, baseline, playbook, 'live-model');
  result.findings = merged.map(f => ({ ...f, id: f.id || randomUUID(), change: changeFor(document.paragraphs.find(p => p.id === f.paragraphId) || {}, baseline) }));
  if (reviewMode === 'own-paper') for (const p of document.paragraphs) if (['changed', 'recorded'].includes(changeFor(p, baseline)) && !result.findings.some(f => f.paragraphId === p.id)) result.findings.push({ id: randomUUID(), paragraphId: p.id, title: 'Amendment not assessed by model', status: 'context', explanation: 'No rule review or the sweep returned an assessment of this recorded amendment. Inspect the wording and related clauses directly.', evidence: [{ paragraphId: p.id, quote: p.text }], ruleIds: [], change: changeFor(p, baseline) });
  result.limits = [...new Set(memos.flatMap(m => [...m.limits, ...m.notes]))].concat(consolidation.fallbacks.map(x => `Reconciliation: ${x}`)).concat('Model findings require lawyer verification. Exact citation validation does not establish the correctness of an interpretation. No automatic approval or sending occurs.');
  result.coverage = rules.map(r => ({ ruleId: r.id, status: result.findings.some(f => (f.ruleIds || []).includes(r.id)) ? 'examined' : 'not-assessed', findingIds: result.findings.filter(f => (f.ruleIds || []).includes(r.id)).map(f => f.id) }));
  result.model = { executor: config.executor, model: config.model, effort: config.effort, arm, reviewMode, rules: rules.length, ...stats, wallMs: Date.now() - started, prompts: Object.fromEntries([base, rulePrompt, sweepPrompt, consolidatePrompt].map(p => [path.basename(p.file), p.sha256])) };
  result.consolidation = consolidation;
  result.memos = memos.map(m => ({ memoId: m.memoId, ruleId: m.ruleId, findings: m.findings.length }));
  return attachComparison(result, document, baseline);
}
