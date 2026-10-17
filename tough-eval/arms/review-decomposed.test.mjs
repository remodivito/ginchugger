// SPDX-License-Identifier: GPL-3.0-or-later
// Decomposed review arms (tough-eval/arms/review-decomposed.mjs), run against a fake model: recorded answers played back through
// the replay executor, one file per call name (rule-<id>, rule-<id>-t<n>, sweep, consolidate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIndexes, agentTool, mergeFindings, checkDispositions, reviewDocumentDecomposed, addCheckerFindings } from './review-decomposed.mjs';

const document = { id: 'd', revision: 1, title: 'Services agreement', paragraphs: [
  { id: 'p0', text: '1. Definitions. “Confidential Information” means non-public information disclosed by a party.' },
  { id: 'p1', text: '2. Liability. Each party’s liability is capped at the fees paid in the prior 3 months, subject to Section 3.' },
  { id: 'p2', text: '3. Exclusions. The cap in Section 2 does not apply to breach of confidentiality.' },
  { id: 'p3', text: '4. Term. This agreement lasts 5 years.', originalText: '4. Term. This agreement lasts 2 years.' },
] };
const playbook = { version: 1, rules: [
  { id: 'CAP', title: 'Liability cap', guidance: 'Cap at 12 months of fees.', enabled: true },
  { id: 'EXCL', title: 'Cap exclusions', guidance: 'Confidentiality breaches excluded; cap should be at least 12 months.', enabled: true },
  { id: 'OFF', title: 'Disabled', guidance: 'Not used.', enabled: false },
] };
const q = (paragraphId, quote) => [{ paragraphId, quote }];
const cap = { paragraphId: 'p1', title: 'Cap too low', status: 'attention', decision: 'counter', explanation: 'CAP asks for 12 months.', evidence: q('p1', 'prior 3 months'), ruleIds: ['CAP'],
  proposedText: '2. Liability. Each party’s liability is capped at the fees paid in the prior 12 months, subject to Section 3.' };
const excl = { paragraphId: 'p1', title: 'Cap below the floor', status: 'attention', decision: 'counter', explanation: 'EXCL requires at least 12 months.', evidence: q('p1', 'capped at the fees'), ruleIds: ['EXCL'],
  proposedText: cap.proposedText, dependsOnParagraphIds: ['p2', 'p99'] };
const exclOk = { paragraphId: 'p2', title: 'Confidentiality excluded', status: 'within-guidance', decision: 'accept', explanation: 'EXCL met.', evidence: q('p2', 'breach of confidentiality'), ruleIds: ['EXCL'] };
const sweep = { findings: [
  { paragraphId: 'p3', title: 'Term extended', status: 'context', decision: 'none', explanation: 'Counterparty extended the term.', evidence: q('p3', 'lasts 5 years'), ruleIds: [] },
  { paragraphId: 'p0', title: 'Outside the sweep', status: 'context', explanation: 'Not asked for.', evidence: q('p0', 'Definitions'), ruleIds: [] },
] };
const consolidated = { findings: [{ ...cap, title: 'Cap below 12 months', ruleIds: ['CAP', 'EXCL'], evidence: [...cap.evidence, ...excl.evidence] }],
  dispositions: [{ inputId: 'CAP#1', outcome: 'kept', into: 0 }, { inputId: 'EXCL#1', outcome: 'merged-into', into: 0 }] };

function recordings(calls) {
  const dir = mkdtempSync(path.join(tmpdir(), 'decomposed-'));
  for (const [name, answer] of Object.entries(calls)) writeFileSync(path.join(dir, `${name}.raw.txt`), typeof answer === 'string' ? answer : JSON.stringify(answer));
  return dir;
}
async function withReplay(calls, fn) {
  const saved = { ...process.env }; const replay = recordings(calls); const trace = mkdtempSync(path.join(tmpdir(), 'decomposed-trace-'));
  Object.assign(process.env, { REVIEW_EXECUTOR: 'replay', REVIEW_REPLAY_DIR: replay, REVIEW_TRACE_DIR: trace, REVIEW_CONCURRENCY: '2', REVIEW_AGENT_TURNS: '3' });
  try { return await fn(trace); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}
const workers = { 'rule-CAP': { findings: [cap] }, 'rule-EXCL': { findings: [excl, exclOk] }, sweep };

test('indexes find defined terms and resolve cross-references without a model', () => {
  const ix = buildIndexes(document);
  assert.deepEqual(ix.definedTerms.map(d => [d.term, d.paragraphId]), [['Confidential Information', 'p0']]);
  const s3 = ix.crossReferences.find(r => r.reference === 'Section 3');
  assert.deepEqual([s3.paragraphId, s3.citedIn], ['p2', ['p1']]);
  assert.equal(ix.crossReferences.find(r => r.reference === 'Section 2').paragraphId, 'p1');
});

test('agent tools read, search, define and resolve, and refuse what they do not know', () => {
  const ix = buildIndexes(document);
  assert.deepEqual(agentTool({ tool: 'read', paragraphIds: ['p3', 'nope'] }, document, ix).paragraphs, [{ id: 'p3', text: document.paragraphs[3].text, originalText: document.paragraphs[3].originalText }]);
  assert.deepEqual(agentTool({ tool: 'search', query: '2 YEARS' }, document, ix).matches.map(m => m.id), ['p3'], 'search covers the counterparty’s original wording');
  assert.equal(agentTool({ tool: 'define', term: '“confidential information”' }, document, ix).definition.id, 'p0');
  assert.equal(agentTool({ tool: 'resolve', reference: 'section 3' }, document, ix).paragraph.id, 'p2');
  assert.match(agentTool({ tool: 'resolve', reference: 'Section 9' }, document, ix).error, /cannot resolve/);
  assert.match(agentTool({ tool: 'search', query: ' ' }, document, ix).error, /empty/);
  assert.match(agentTool({ tool: 'shell' }, document, ix).error, /unknown tool/);
});

test('merge: one source per paragraph is final; two sources needing attention go to the consolidator', () => {
  const f = (id, paragraphId, memoId, status = 'attention', extra = {}) => ({ id, paragraphId, memoId, status, ...extra });
  const { final, conflicts } = mergeFindings([
    f('a', 'p1', 'm1'), f('b', 'p1', 'm1'), // one worker, two findings: final
    f('c', 'p2', 'm1'), f('d', 'p2', 'm2'), // two workers needing attention: conflict
    f('e', 'p3', 'm1', 'within-guidance'), f('g', 'p3', 'm2', 'context'), // two workers, nothing to reconcile: final
    f('h', 'p4', 'm1', 'context', { proposedText: 'x' }), f('i', 'p4', 'm2', 'context', { insertAfter: [{ text: 'y' }] }), // proposals: conflict
    f('j', '', 'm1'), f('k', '', 'm2'), // unanchored: never a conflict
  ]);
  assert.deepEqual(final.map(x => x.id).sort(), ['a', 'b', 'e', 'g', 'j', 'k']);
  assert.deepEqual(conflicts.map(c => [c.paragraphId, c.findings.map(x => x.id)]), [['p2', ['c', 'd']], ['p4', ['h', 'i']]]);
});

test('dispositions must account for every input once, name an output, and give a reason for a drop', () => {
  assert.deepEqual(checkDispositions(['a', 'b'], [{ inputId: 'a', outcome: 'kept', into: 0 }, { inputId: 'b', outcome: 'dropped', reason: 'duplicate of a' }], 1), []);
  const problems = checkDispositions(['a', 'b', 'c'], [{ inputId: 'a', outcome: 'kept', into: 1 }, { inputId: 'b', outcome: 'dropped' }, { inputId: 'b', outcome: 'merged', into: 0 }, { inputId: 'z', outcome: 'kept', into: 0 }], 1);
  for (const p of [/a: kept names no output/, /b: dropped without a reason/, /b: unknown outcome/, /b: disposed of 2 times/, /c: disposed of 0 times/, /unknown input "z"/]) assert.ok(problems.some(x => p.test(x)), `${p} in ${problems}`);
  assert.deepEqual(checkDispositions(['a'], null, 0), ['a: disposed of 0 times']);
});

test('decomposed: workers, sweep, merge and consolidation produce one verified review', () => withReplay({ ...workers, consolidate: consolidated }, async trace => {
  const r = await reviewDocumentDecomposed({ document, playbook, arm: 'decomposed' });
  assert.equal(r.model.arm, 'decomposed'); assert.equal(r.model.rules, 2, 'the disabled rule gets no worker');
  assert.equal(r.model.calls, 4, 'two workers, one sweep, one consolidation');
  const p1 = r.findings.filter(f => f.paragraphId === 'p1');
  assert.equal(p1.length, 1); assert.deepEqual(p1[0].mergedFrom, ['CAP#1', 'EXCL#1']); assert.equal(p1[0].suggestedText, cap.proposedText);
  assert.deepEqual(r.consolidation.conflictParagraphs, ['p1']); assert.deepEqual(r.consolidation.fallbacks, []);
  assert.ok(r.findings.some(f => f.paragraphId === 'p2' && f.sourceRule === 'EXCL'));
  assert.ok(r.findings.some(f => f.paragraphId === 'p3' && f.sourceRule === 'sweep'), 'the recorded amendment no worker addressed is swept');
  assert.ok(!r.findings.some(f => f.paragraphId === 'p0'), 'sweep findings outside its paragraphs are discarded');
  assert.ok(r.findings.every(f => f.evidence.every(e => e.verified)), 'every quote verifies');
  assert.deepEqual(r.coverage.map(c => [c.ruleId, c.status]), [['CAP', 'examined'], ['EXCL', 'examined']]);
  const memo = JSON.parse(readFileSync(path.join(trace, 'memos', 'EXCL.json'), 'utf8'));
  assert.deepEqual(memo.findings.map(f => f.id), ['EXCL#1', 'EXCL#2']); assert.deepEqual(memo.findings[0].dependsOn, ['p2'], 'dependencies outside the document are dropped');
  assert.ok(existsSync(path.join(trace, 'memos', 'sweep.json')) && existsSync(path.join(trace, 'decomposed-manifest.json')));
  const sweepPayload = JSON.parse(readFileSync(path.join(trace, 'sweep.user.json'), 'utf8'));
  assert.deepEqual(sweepPayload.sweepParagraphIds, ['p3'], 'own-paper sweep covers only untouched amendments');
}));

test('third-party sweep covers untouched paragraphs long enough to carry an obligation', () => withReplay({ ...workers, consolidate: consolidated }, async trace => {
  await reviewDocumentDecomposed({ document, playbook, arm: 'decomposed', reviewMode: 'third-party' });
  assert.deepEqual(JSON.parse(readFileSync(path.join(trace, 'sweep.user.json'), 'utf8')).sweepParagraphIds, ['p0'], 'p3 is under 80 characters');
}));

test('decomposed-raw: no consolidator; every worker finding survives', () => withReplay(workers, async () => {
  const r = await reviewDocumentDecomposed({ document, playbook, arm: 'decomposed-raw' });
  assert.equal(r.model.calls, 3);
  assert.deepEqual(r.findings.filter(f => f.paragraphId === 'p1').map(f => f.id).sort(), ['CAP#1', 'EXCL#1']);
  assert.equal(r.consolidation.conflicts, 1);
}));

test('a consolidator that loses a finding falls back to the unmerged findings and says so', () => withReplay({ ...workers, consolidate: { ...consolidated, dispositions: consolidated.dispositions.slice(0, 1) } }, async () => {
  const r = await reviewDocumentDecomposed({ document, playbook, arm: 'decomposed' });
  assert.deepEqual(r.findings.filter(f => f.paragraphId === 'p1').map(f => f.id).sort(), ['CAP#1', 'EXCL#1']);
  assert.ok(r.findings.find(f => f.id === 'CAP#1').notes.some(n => /reconciliation failed/.test(n)));
  assert.ok(r.limits.some(l => /Reconciliation: EXCL#1: disposed of 0 times/.test(l)));
}));

test('a worker whose answer is unusable costs only its rule, recorded as a limit', () => withReplay({ ...workers, 'rule-CAP': '{"answer":"no findings array"}', consolidate: consolidated }, async () => {
  const r = await reviewDocumentDecomposed({ document, playbook, arm: 'decomposed' });
  assert.ok(r.limits.some(l => /^CAP: Model returned an invalid review structure/.test(l)));
  assert.ok(r.findings.some(f => f.id === 'EXCL#1'), 'with one source left, p1 needs no consolidation');
  assert.equal(r.consolidation.conflicts, 0);
}));

test('decomposed-agent: a tool request is answered from the document and the next turn sees it', () => withReplay({
  'rule-CAP-t1': { tool: 'resolve', reference: 'Section 3' }, 'rule-CAP-t2': { findings: [cap] },
  'rule-EXCL-t1': { tool: 'search', query: 'cap' }, 'rule-EXCL-t2': { tool: 'read', paragraphIds: ['p2'] }, 'rule-EXCL-t3': { tool: 'read', paragraphIds: ['p1'] },
  sweep, consolidate: consolidated,
}, async trace => {
  const r = await reviewDocumentDecomposed({ document, playbook, arm: 'decomposed-agent-raw' });
  assert.deepEqual(r.model.agentTurns, { CAP: 2, EXCL: 3 });
  const t2 = JSON.parse(readFileSync(path.join(trace, 'rule-CAP-t2.user.json'), 'utf8'));
  assert.equal(t2.transcript[0].result.paragraph.id, 'p2'); assert.equal(t2.turnsLeft, 2); assert.ok(!('document' in t2), 'the agent gets an outline, not the document');
  assert.ok(r.limits.some(l => /EXCL: ran out of turns/.test(l)), 'a tool request on the last turn is not executed');
  assert.ok(r.findings.some(f => f.id === 'CAP#1'));
}));

test('unknown arms are refused; the product review has no arm switch', async () => {
  await assert.rejects(reviewDocumentDecomposed({ document, playbook, arm: 'swarm' }), /Unknown review arm/);
  const product = readFileSync(new URL('../../contract-review/server/review.js', import.meta.url), 'utf8');
  assert.ok(!/REVIEW_ARM|review-decomposed|\barm\b/.test(product), 'arms run only from tough-eval');
});

test('a rule whose answer cannot be read is recorded as not assessed; the rest of the review survives', async () => {
  const result = await withReplay({ ...workers, 'rule-EXCL': 'I could not complete this review.', consolidate: consolidated }, () =>
    reviewDocumentDecomposed({ document, playbook, reviewMode: 'own-paper', arm: 'decomposed' }));
  assert.ok(result.findings.some(f => f.sourceRule === 'CAP'), 'the CAP worker’s finding is kept');
  assert.equal(result.consolidation.conflicts, 0, 'nothing to reconcile once EXCL is gone');
  assert.ok(result.limits.some(l => /^EXCL: not assessed/.test(l)), 'the failure is stated');
  assert.deepEqual(result.model.notAssessed, ['EXCL']);
});

test('an executor failure (usage limit, CLI error) still fails the whole review, so the run is retried rather than scored', async () => {
  await withReplay({ 'rule-CAP': { findings: [cap] }, sweep }, () =>
    assert.rejects(reviewDocumentDecomposed({ document, playbook, reviewMode: 'own-paper', arm: 'decomposed' }), /No recorded run|recorded runs/));
});

test('hybrid: checker findings are added only where the main review flagged nothing, and say where they came from', () => {
  const main = [{ ...cap, id: 'm1' }, { ...exclOk, id: 'm2' }];
  const missed = { paragraphId: 'p2', title: 'Exclusion too narrow', status: 'attention', decision: 'counter', explanation: 'EXCL.', evidence: q('p2', 'breach of confidentiality'), ruleIds: ['EXCL'], sourceRule: 'EXCL' };
  const { added, ignored } = addCheckerFindings(main, [{ ...excl, sourceRule: 'EXCL' }, { ...exclOk, sourceRule: 'EXCL' }, missed]);
  assert.deepEqual(added.map(f => f.title), ['Exclusion too narrow'], 'p1 is already flagged by the main review; within-guidance findings are not added');
  assert.equal(ignored, 2);
  assert.match(added[0].notes.at(-1), /per-rule check for EXCL/);
});

test('hybrid end to end: the main single call plus per-rule checkers on the worker model', async () => {
  const missed = { paragraphId: 'p2', title: 'Exclusion too narrow', status: 'attention', decision: 'counter', explanation: 'EXCL.', evidence: q('p2', 'breach of confidentiality'), ruleIds: ['EXCL'] };
  const result = await withReplay({ review: { findings: [cap] }, 'rule-CAP': { findings: [cap] }, 'rule-EXCL': { findings: [excl, missed] } }, async () => {
    process.env.REVIEW_WORKER_MODEL = 'claude-haiku-5-5';
    return reviewDocumentDecomposed({ document, playbook, reviewMode: 'third-party', arm: 'hybrid' });
  });
  assert.deepEqual(result.findings.filter(f => f.status === 'attention').map(f => [f.paragraphId, f.title]), [['p1', 'Cap too low'], ['p2', 'Exclusion too narrow']]);
  assert.equal(result.model.arm, 'hybrid'); assert.equal(result.model.workerModel, 'claude-haiku-5-5');
  assert.equal(result.model.checkers.added, 1);
  assert.ok(result.findings.every(f => f.change), 'every finding carries its change status');
});

test('single review agent: uses a tool, then answers; assembled like the single call', async () => {
  const result = await withReplay({ 'agent-t1': { tool: 'resolve', reference: 'Section 3' }, 'agent-t2': { findings: [cap, exclOk] } }, async trace => {
    const r = await reviewDocumentDecomposed({ document, playbook, reviewMode: 'third-party', arm: 'agent' });
    assert.deepEqual(JSON.parse(readFileSync(path.join(trace, 'agent-transcript.json'), 'utf8')), [{ tool: 'resolve', reference: 'Section 3' }]);
    return r;
  });
  const model = result.findings.filter(f => f.title !== 'Amendment for contextual review'); // the validator's note on p3's recorded change, as in the single call
  assert.deepEqual(model.map(f => f.title), ['Cap too low', 'Confidentiality excluded']);
  assert.equal(result.model.arm, 'agent'); assert.equal(result.model.turns, 2); assert.deepEqual(result.model.toolRequests, ['resolve']);
  assert.ok(result.findings.every(f => f.change));
});

test('single review agent: a tool request on the last turn is not an answer', async () => {
  const result = await withReplay({ 'agent-t1': { tool: 'search', query: 'cap' }, 'agent-t2': { tool: 'search', query: 'fees' }, 'agent-t3': { tool: 'read', paragraphIds: ['p1'] } }, () =>
    reviewDocumentDecomposed({ document, playbook, reviewMode: 'third-party', arm: 'agent' }));
  assert.equal(result.findings.filter(f => f.title !== 'Amendment for contextual review').length, 0);
  assert.ok(result.limits.some(l => /agent: ran out of turns/.test(l)));
});

test('agent-hybrid: the agent is the main review and per-rule checkers add only what it did not flag', async () => {
  const missed = { paragraphId: 'p2', title: 'Exclusion too narrow', status: 'attention', decision: 'counter', explanation: 'EXCL.', evidence: q('p2', 'breach of confidentiality'), ruleIds: ['EXCL'] };
  const result = await withReplay({ 'agent-t1': { findings: [cap] }, 'rule-CAP': { findings: [cap] }, 'rule-EXCL': { findings: [missed] } }, () =>
    reviewDocumentDecomposed({ document, playbook, reviewMode: 'third-party', arm: 'agent-hybrid' }));
  assert.deepEqual(result.findings.filter(f => f.status === 'attention').map(f => f.paragraphId), ['p1', 'p2']);
  assert.equal(result.model.arm, 'agent-hybrid'); assert.equal(result.model.checkers.added, 1); assert.equal(result.model.main.calls, 1);
});
