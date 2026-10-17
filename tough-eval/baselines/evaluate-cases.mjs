// SPDX-License-Identifier: GPL-3.0-or-later
// The v1 development-fixture check of the rule engine (formerly contract-review/scripts/evaluate.js, moved by the v2
// trim with the engine it measures). The ten example documents stay in the product (contract-review/data/cases.json,
// served as examples); their labels live here (cases-v1-labels.json) and never reach the product or a reviewer.
// Usage: node tough-eval/baselines/evaluate-cases.mjs   (writes evaluation-report-v1.json beside this file)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.join(here, '../../contract-review');
// Each case names the playbook it belongs to (NDA cases the NDA playbook, the two commercial cases the order-form
// playbook). `playbook` stays the first (NDA) playbook for callers that pass one playbook for everything.
let library = {};
export async function loadFixtures() {
  const [examples, labels, playbook, orderForm] = await Promise.all([
    fs.readFile(path.join(product, 'data/cases.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(here, 'cases-v1-labels.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(product, 'data/playbook.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(product, 'data/playbooks/order-form.json'), 'utf8').then(JSON.parse),
  ]);
  library = { [playbook.id || 'nda']: playbook, [orderForm.id || 'order-form']: orderForm };
  const cases = examples.map(c => { if (!labels[c.id]) throw new Error(`No v1 label for example ${c.id}`); return { ...c, expected: labels[c.id] }; });
  return { cases, playbook, playbooks: library };
}

// Deliberately whitelist review inputs: reference answers never reach the engine. The case's own playbook is used
// when it names one that is loaded; otherwise the playbook passed in.
export function reviewInput(testCase, playbook, playbooks = library) {
  return { document: testCase.document, baseline: testCase.baseline, playbook: (testCase.playbook && playbooks[testCase.playbook]) || playbook };
}

export function assessReview(testCase, review) {
  const actual = review.findings || [];
  const expected = testCase.expected.findings;
  const errors = [];
  const attention = actual.filter(f => f.status === 'attention');
  const expectedAttention = expected.filter(f => f.status === 'attention');
  let correct = 0;
  let evidenceMatches = 0;
  let evidenceTotal = 0;
  for (const target of expected) {
    const found = actual.find(f => f.paragraphId === target.paragraphId && f.status === target.status);
    if (!found) errors.push(`Missing ${target.status} finding at ${target.paragraphId}`);
    else correct++;
    for (const paragraphId of target.requiredCitationIds) {
      evidenceTotal++;
      if (found?.evidence?.some(e => e.paragraphId === paragraphId)) evidenceMatches++;
      else errors.push(`Missing supporting citation ${paragraphId} for ${target.paragraphId}`);
    }
  }
  const seenAttention = new Set();
  for (const finding of attention) {
    if (seenAttention.has(finding.paragraphId)) errors.push(`Duplicate attention item at ${finding.paragraphId}`);
    seenAttention.add(finding.paragraphId);
    if (!expectedAttention.some(e => e.paragraphId === finding.paragraphId)) {
      errors.push(`Unexpected attention item at ${finding.paragraphId}`);
    }
  }
  const paragraphs = new Map(testCase.document.paragraphs.map(p => [p.id, p.text]));
  let grounded = 0;
  let citations = 0;
  for (const finding of actual) {
    if (!paragraphs.has(finding.paragraphId)) errors.push(`Unknown finding anchor ${finding.paragraphId}`);
    for (const evidence of finding.evidence || []) {
      citations++;
      if (typeof evidence.quote === 'string' && evidence.quote.length > 0 && paragraphs.get(evidence.paragraphId)?.includes(evidence.quote)) grounded++;
      else errors.push(`Ungrounded citation at ${evidence.paragraphId}`);
    }
  }
  const prose = JSON.stringify(review).toLowerCase();
  for (const phrase of testCase.expected.forbiddenPhrases) {
    if (prose.includes(phrase)) errors.push(`Unsupported authority phrase: ${phrase}`);
  }
  const truePositiveAttention = expectedAttention.filter(e => attention.some(f => e.paragraphId === f.paragraphId)).length;
  return {
    id: testCase.id, passed: errors.length === 0, errors,
    expectedFindings: expected.length, correctStatuses: correct,
    expectedAttention: expectedAttention.length, attentionItems: attention.length, truePositiveAttention,
    requiredEvidence: evidenceTotal, matchedEvidence: evidenceMatches,
    citations, groundedCitations: grounded,
  };
}

export async function evaluateAll(review) {
  const { cases, playbook, playbooks } = await loadFixtures();
  const results = [];
  for (const testCase of cases) {
    results.push(assessReview(testCase, await review(reviewInput(testCase, playbook, playbooks))));
  }
  const sum = key => results.reduce((n, r) => n + r[key], 0);
  const ratio = (a, b) => b ? Number((a / b).toFixed(3)) : null;
  return {
    evaluatedAt: new Date().toISOString(),
    mode: 'deterministic demonstration regression; not a model accuracy evaluation',
    cases: results.length, passed: results.filter(r => r.passed).length,
    metrics: {
      attentionPrecision: ratio(sum('truePositiveAttention'), sum('attentionItems')),
      attentionRecall: ratio(sum('truePositiveAttention'), sum('expectedAttention')),
      expectedStatusRecall: ratio(sum('correctStatuses'), sum('expectedFindings')),
      requiredEvidenceCoverage: ratio(sum('matchedEvidence'), sum('requiredEvidence')),
      citationGrounding: ratio(sum('groundedCitations'), sum('citations')),
    },
    limitations: ['Development fixtures only; eight NDA cases share one public source.', 'Constructed expectations without lawyer validation.', 'No measurement of real-world workload reduction or document-format fidelity.'],
    results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { reviewLocal } = await import('./local-rules.mjs');
  const report = await evaluateAll(reviewLocal);
  await fs.writeFile(path.join(here, 'evaluation-report-v1.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.cases) process.exitCode = 1;
}
