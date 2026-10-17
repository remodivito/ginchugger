// SPDX-License-Identifier: GPL-3.0-or-later
// Recorded reviewer answers for layer C's dry run: <out>/C-<task>/review.raw.txt in the model's own JSON shape, so
// `layer-c/run.mjs --executor replay --replay-dir <out>` drives the product's whole review path (validation, quote
// checks, traces) with no model. Reviewers: oracle (proposes exactly the attorneys' golden changes, citing RB-TURN),
// silent (no findings), malformed (not JSON: exercises the retry policy). Development and tests only.
// Usage: node tough-eval/v2/layer-c/fixtures/write-replay.mjs --reviewer oracle|silent|malformed --out <dir>
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, readStripped } from '../import.mjs';

/** The raw answer a reviewer gives for one task. */
export function rawFor(task, reviewer) {
  if (reviewer === 'malformed') return 'I could not produce JSON this time.';
  if (reviewer === 'silent') return JSON.stringify({ findings: [], limits: [] });
  const doc = readStripped(task.document); const text = new Map(doc.paragraphs.map(p => [p.id, p.text])); const golden = readStripped(task.golden.file);
  const quote = id => (text.get(id) || '').trim().slice(0, 60).trim();
  const findings = golden.changes.filter(c => quote(c.paragraphId ?? c.afterParagraphId)).map(c => ({ paragraphId: c.inserted ? c.afterParagraphId : c.paragraphId, title: 'Change proposed', status: 'attention', decision: 'counter', ruleIds: ['RB-TURN'],
    explanation: 'This change answers the counterparty\'s markup under our positions.', evidence: [{ paragraphId: c.inserted ? c.afterParagraphId : c.paragraphId, quote: quote(c.inserted ? c.afterParagraphId : c.paragraphId) }],
    ...(c.inserted ? { insertAfter: [{ afterParagraphId: c.afterParagraphId, text: c.text }] } : { proposedText: c.text }) }));
  return JSON.stringify({ findings, limits: [] });
}
export function writeReplay(out, reviewer, tasks = loadTasks().tasks) {
  for (const t of tasks) { const dir = path.join(out, `C-${t.id}`); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'review.raw.txt'), rawFor(t, reviewer)); }
  return tasks.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opt = k => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? null : process.argv[i + 1]; };
  const reviewer = opt('reviewer') || 'oracle'; const out = path.resolve(opt('out'));
  console.log(`${writeReplay(out, reviewer)} recordings (${reviewer}) in ${out}`);
}
