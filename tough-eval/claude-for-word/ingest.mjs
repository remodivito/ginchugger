// SPDX-License-Identifier: GPL-3.0-or-later
// Turns the documents Claude for Word edited (./output/Agreement X.docx) into a tough-eval run directory, so the same
// scorer and comparison apply. Each edited or commented paragraph becomes a finding: status "attention", the playbook
// entry ids its comments name (e.g. C-05) as ruleIds, and its new wording as proposedText when it was changed.
// Paragraphs are matched to the variant by their pre-change text, in order; inserted paragraphs join the paragraph
// before them; a deleted paragraph proposes empty wording.
// Usage: node tough-eval/claude-for-word/ingest.mjs [--name claude-for-word]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from '../../contract-review/node_modules/jszip/lib/index.js';
import { DOMParser } from '../../contract-review/node_modules/@xmldom/xmldom/lib/index.js';
import { importDocx } from '../../contract-review/server/docx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : 'claude-for-word';
const inputDir = process.argv.includes('--input') ? process.argv[process.argv.indexOf('--input') + 1] : 'output';
const sample = JSON.parse(readFileSync(path.join(here, 'sample.json'), 'utf8'));
const runDir = path.join(here, '..', 'runs', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z-${name}`);
if (existsSync(runDir)) throw Error('run directory exists');
mkdirSync(path.join(runDir, 'results'), { recursive: true });
const textOf = el => Array.from(el.getElementsByTagName('w:t')).map(t => t.textContent).join('');

async function commentsByParagraph(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'text/xml');
  const cx = zip.file('word/comments.xml'); const comments = new Map();
  if (cx) for (const c of Array.from(new DOMParser().parseFromString(await cx.async('string'), 'text/xml').getElementsByTagName('w:comment'))) comments.set(c.getAttribute('w:id'), textOf(c));
  const body = doc.getElementsByTagName('w:body')[0];
  return Array.from(body.getElementsByTagName('w:p')).map(p => {
    const ids = new Set([...Array.from(p.getElementsByTagName('w:commentRangeStart')), ...Array.from(p.getElementsByTagName('w:commentReference'))].map(e => e.getAttribute('w:id')));
    return [...ids].map(id => comments.get(id) || '').join('\n');
  });
}

const missing = [];
for (const s of sample) {
  const file = path.join(here, inputDir, s.file);
  if (!existsSync(file)) { missing.push(s.file); continue; }
  const buffer = readFileSync(file);
  const edited = await importDocx(buffer, s.file); const notes = await commentsByParagraph(buffer);
  const variant = JSON.parse(readFileSync(path.join(here, '..', 'variants', `${s.id}.json`), 'utf8'));
  const findings = new Map(); let vi = 0, last = null;
  const add = (pid, change, note) => {
    const f = findings.get(pid) || { paragraphId: pid, status: 'attention', decision: 'counter', ruleIds: [], evidence: [], comments: [] };
    if (change !== undefined) f.proposedText = f.proposedText === undefined ? change : f.proposedText + '\n' + change;
    if (note) { f.comments.push(note); f.ruleIds = [...new Set([...f.ruleIds, ...(note.match(/\b[A-Z]{1,3}-\d{1,3}\b/g) || [])])]; }
    findings.set(pid, f);
  };
  edited.paragraphs.forEach((p, i) => {
    const before = p.originalText ?? p.text;
    let match = null;
    if (before) for (let j = vi; j < variant.paragraphs.length; j++) if (variant.paragraphs[j].text === before) { match = variant.paragraphs[j].id; vi = j + 1; break; }
    if (match) { last = match; if (p.text !== before) add(match, p.text, notes[i]); else if (notes[i]) add(match, undefined, notes[i]); }
    else if (last && (p.text || notes[i])) { // an inserted paragraph joins the proposal for the paragraph before it
      if (findings.get(last)?.proposedText === undefined) add(last, variant.paragraphs.find(x => x.id === last).text);
      add(last, p.text, notes[i]);
    }
  });
  writeFileSync(path.join(runDir, 'results', `${s.id}.json`), JSON.stringify({ ok: true, ms: null, model: { executor: 'claude-for-word (manual)' }, findings: [...findings.values()], limits: [] }, null, 1));
}
writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ startedAt: new Date().toISOString(), executor: 'claude-for-word (manual, see PROTOCOL.md)', model: 'claude-for-word', effort: 'n/a', control: null, arm: null, reviewMode: 'third-party', variants: sample.map(s => ({ id: s.id, playbook: s.playbook })), missing }, null, 1));
console.log(runDir, missing.length ? `missing: ${missing.join(', ')}` : 'all documents ingested');
