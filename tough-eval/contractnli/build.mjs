// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the ContractNLI layer: one variant per NDA in the product's document shape (paragraphs = the dataset's spans,
// so an evidence span always maps to whole paragraphs), a manifest with the gold labels per rule, and a split that
// follows the dataset's own: its dev set (61) is our development split, its test set (123) the held-out split scored
// once per release, its train set (423) a pool that is not run unless asked for.
// Usage: node tough-eval/contractnli/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from './rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = s => createHash('sha256').update(s).digest('hex');
mkdirSync(path.join(here, 'variants'), { recursive: true });
const hypToRule = Object.fromEntries(Object.entries(RULES).map(([r, m]) => [m.hypothesis, r]));
const split = { development: [], heldout: [], pool: [] };
const variants = []; let labels = null;
for (const [set, bucket] of [['dev', 'development'], ['test', 'heldout'], ['train', 'pool']]) {
  const data = JSON.parse(readFileSync(path.join(here, 'data/contract-nli', `${set}.json`), 'utf8')); labels = data.labels;
  for (const d of data.documents) {
    const id = `N${String(d.id).padStart(3, '0')}`;
    const paragraphs = d.spans.map(([a, b], i) => ({ id: `s${i}`, text: d.text.slice(a, b) })).filter(p => p.text.trim());
    const doc = { id, revision: 1, title: d.file_name, source: { dataset: 'ContractNLI', documentId: d.id, type: d.document_type, url: d.url || null }, paragraphs };
    const text = JSON.stringify(doc, null, 1); writeFileSync(path.join(here, 'variants', `${id}.json`), text);
    const ann = d.annotation_sets[0].annotations;
    const gold = Object.fromEntries(Object.entries(ann).filter(([h]) => hypToRule[h]).map(([h, a]) => [hypToRule[h], { choice: a.choice, spans: a.spans.map(i => `s${i}`) }]));
    variants.push({ id, sha256: sha(text), set, chars: d.text.length, paragraphs: paragraphs.length, gold });
    split[bucket].push(id);
  }
}
const manifest = { version: 'contractnli-1', built: new Date().toISOString(), source: 'ContractNLI (Koreeda & Manning 2021), CC BY 4.0; see data/README.md', hypotheses: Object.fromEntries(Object.entries(RULES).map(([r, m]) => [r, { hypothesis: m.hypothesis, text: labels[m.hypothesis].hypothesis, departs: m.departs }])), variants };
writeFileSync(path.join(here, 'manifest.json'), JSON.stringify(manifest, null, 1));
writeFileSync(path.join(here, 'split.json'), JSON.stringify(split, null, 1));
console.log(`${variants.length} variants (${split.development.length} development, ${split.heldout.length} held-out, ${split.pool.length} pool)`);
