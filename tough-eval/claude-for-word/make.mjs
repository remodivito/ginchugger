// SPDX-License-Identifier: GPL-3.0-or-later
// Prepares the Claude for Word comparison (arm C): one .docx per sampled development variant, built the same way the
// product exports a document, and each playbook as plain text to paste into Claude for Word. Writes to ./input.
// Usage: node tough-eval/claude-for-word/make.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportDocx } from '../../contract-review/server/docx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Ten development variants: a clean control, single plants, a benign edit, a multi-plant, two markups, and three from
// the long bundle (a clean bundle is not included; B00's role is played by C00). Chosen before any Claude for Word run.
export const SAMPLE = ['C00', 'P01', 'P10', 'P21', 'D01', 'M2', 'K04', 'K09', 'BL06', 'BK5'];
const out = path.join(here, 'input'); mkdirSync(out, { recursive: true });
// Neutral names: Word shows the file name, and a variant id names the kind of plant.
const fileFor = id => `Agreement ${String.fromCharCode(65 + SAMPLE.indexOf(id))}`;
const playbookFor = id => id.startsWith('B') ? 'playbook-bundle.json' : 'playbook.json';

const asText = pb => [`${pb.title}`, '', ...pb.rules.filter(r => r.enabled !== false).flatMap(r => [
  `${r.id}: ${r.title}`, `Guidance: ${r.guidance}`, ...['preferred', 'acceptable', 'escalation', 'hardLine'].filter(k => r[k]).map(k => `${{ preferred: 'Preferred', acceptable: 'Acceptable', escalation: 'Escalate', hardLine: 'Hard line' }[k]}: ${r[k]}`), '']) ].join('\n');
for (const f of ['playbook.json', 'playbook-bundle.json']) writeFileSync(path.join(out, f.replace('.json', '.txt')), asText(JSON.parse(readFileSync(path.join(here, '..', f), 'utf8'))));

for (const id of SAMPLE) {
  const v = JSON.parse(readFileSync(path.join(here, '../variants', `${id}.json`), 'utf8'));
  const buffer = await exportDocx({ ...v, imported: false });
  writeFileSync(path.join(out, `${fileFor(id)}.docx`), buffer);
}
writeFileSync(path.join(here, 'sample.json'), JSON.stringify(SAMPLE.map(id => ({ id, playbook: playbookFor(id), file: `${fileFor(id)}.docx` })), null, 1));
console.log('wrote', SAMPLE.length, 'documents and 2 playbooks to', out);
