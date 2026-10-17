// SPDX-License-Identifier: GPL-3.0-or-later
// Layer C importer (BENCHMARK-V2.md section 7, P19's inputs; file formats as section 11). Two steps:
//   --fetch   download RedlineBench at the pinned revision into layer-c/source/ and check every file against the
//             dataset's object ids (source.mjs); network: huggingface.co only;
//   (build)   offline, from layer-c/source/ (checked again against source/manifest.json):
//             documents/<task>.json  the contract in the review's document shape ({ id, revision, title, paragraphs:
//                                    [{ id, text, originalText? }] }, RedlineBench's own paragraph ids p-NNN), canary on top;
//             markup/<task>.json     the earlier rounds' tracked changes per paragraph with party names, for the renderer
//                                    only (never sent to the reviewer: the product's document shape has no authorship);
//             playbooks/<task>.json  the positions source (positions.mjs: from the task's own instructions);
//             golden/<task>.json     the attorneys' golden redline in the common output shape (render.mjs), or, where
//                                    RedlineBench has none, `source: "none"` and no changes;
//             layer-c-tasks.json     the task list, the 22 criteria with their adapted wording and the attorneys' text,
//                                    the 11 excluded criteria with reasons, hashes of every file above and of the sources.
// Output is deterministic (no timestamps), so its hash can be frozen.
// Usage: node tough-eval/v2/layer-c/import.mjs [--fetch] [--source <dir>] [--out <dir>]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSource, checkSource, sha256, DATASET, REVISION, LICENCE, TASKS, GOLDEN } from './source.mjs';
import { readDocx } from './docx.mjs';
import { buildPlaybook } from './positions.mjs';
import { goldenFrom } from './render.mjs';
import { SELECTION, expectFor } from './criteria.mjs';
import { canaryGuid } from '../canary.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVAL = path.resolve(HERE, '../..');
export const TASKS_FILE = 'layer-c-tasks.json';
const toml = (t, key) => (t.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm')) || [])[1] ?? null;

/** Write JSON with the canary as the first key; returns the file's SHA-256. */
export function writeStamped(file, obj, guid) {
  mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(guid ? { canary: guid, ...obj } : obj, null, 1) + '\n'; writeFileSync(file, text); return sha256(text);
}

/** Build every layer C file from a checked source folder. Returns the tasks object written. */
export function build({ source = path.join(HERE, 'source'), out = HERE, guid = canaryGuid(), selection = SELECTION } = {}) {
  const m = checkSource(source); const rel = f => path.relative(EVAL, f).split(path.sep).join('/');
  const tasks = []; const files = {};
  for (const task of Object.keys(selection)) {
    const src = m.tasks[task]; if (!src) throw Error(`${task} is not in ${source}/manifest.json`);
    const dir = path.join(source, task); const read = f => readFileSync(path.join(dir, f));
    const meta = read('task.toml').toString('utf8'); const instruction = read('instruction.md').toString('utf8');
    const rubric = JSON.parse(read('tests/rubrics.json').toString('utf8'));
    const represented = toml(meta, 'represented_party'), counterparty = toml(meta, 'counterparty');
    // document
    const contract = readDocx(read('contract.docx'));
    const document = { id: `C-${task}`, revision: 1, title: `RedlineBench ${task} contract (turn ${toml(meta, 'level')})`, paragraphs: contract.paragraphs };
    const docFile = path.join(out, 'documents', `${task}.json`); files[rel(docFile)] = writeStamped(docFile, document, guid);
    const markupFile = path.join(out, 'markup', `${task}.json`); files[rel(markupFile)] = writeStamped(markupFile, { task, note: 'Earlier rounds\' tracked changes, authors as in the .docx; read by render.mjs only.', markup: contract.markup }, guid);
    // positions source
    const grounding = readdirSync(path.join(dir, 'grounding')).filter(f => f.endsWith('.extracted.md')).sort().map(f => ({ name: f, text: readFileSync(path.join(dir, 'grounding', f), 'utf8') }));
    const scenario = grounding.find(g => /-side guidelines/i.test(g.text)); if (!scenario) throw Error(`${task}: no "-side guidelines" in grounding`);
    const guide = grounding.find(g => g !== scenario && /Review Guidelines|Guidelines for Reviewing/i.test(g.text.slice(0, 400) + g.name)) || null;
    const precedent = grounding.find(g => g !== scenario && g !== guide) || null;
    const playbook = buildPlaybook({ instruction, scenario, guide, precedent }, { task, represented, counterparty });
    const pbFile = path.join(out, 'playbooks', `${task}.json`); files[rel(pbFile)] = writeStamped(pbFile, playbook, guid);
    // golden
    const hasGolden = src.some(f => f.path === GOLDEN);
    const golden = hasGolden ? goldenFrom(contract, readDocx(read(GOLDEN)), { source: `RedlineBench ${task} ${GOLDEN} (attorney variant ${toml(meta, 'variant')})` })
      : { source: 'none', note: `RedlineBench publishes no golden redline for ${task} at ${REVISION}. Every transferable criterion of this task is a 'keep' criterion (the attorney accepts the counterparty's change), so the attorneys' position is the document left as it is: the golden is the empty output here, and the control expects it to pass every criterion.`, changes: [], explanations: [] };
    const gFile = path.join(out, 'golden', `${task}.json`); files[rel(gFile)] = writeStamped(gFile, { task, ...golden }, guid);
    // criteria
    const byId = new Map(rubric.rubrics.map(r => [r.id, r])); const sel = selection[task];
    const seen = new Set([...sel.criteria.map(c => c.rubricId), ...sel.excluded.map(c => c.rubricId)]);
    for (const r of rubric.rubrics) if (!seen.has(r.id)) throw Error(`${task}: rubric ${r.id} is neither selected nor excluded`);
    const criteria = sel.criteria.map(c => { const r = byId.get(c.rubricId); if (!r) throw Error(`${task}: ${c.rubricId} not in the rubric`);
      return { id: c.id, rubricId: c.rubricId, class: c.class, kind: c.kind, section: c.section, adapted: c.adapted, attorney: { criterion: r.criteria.trim(), justification: r.justification.trim(), category: r.category ?? null, weight: r.weight }, expect: expectFor(c) }; });
    if (!hasGolden && criteria.some(c => c.kind === 'change')) throw Error(`${task}: no golden redline, yet a 'change' criterion is selected; the validity control could not pass it`);
    tasks.push({ id: task, platformTaskId: toml(meta, 'platform_task_id'), scenario: toml(meta, 'scenario_label'), inputGroup: toml(meta, 'input_group'), variant: toml(meta, 'variant'), turn: Number(toml(meta, 'level')),
      represented, counterparty, document: rel(docFile), markup: rel(markupFile), playbook: rel(pbFile), golden: { file: rel(gFile), source: hasGolden ? 'attorney-redline' : 'none' },
      paragraphs: document.paragraphs.length, revisedParagraphs: document.paragraphs.filter(p => p.originalText !== undefined).length, playbookRules: playbook.rules.length,
      sources: Object.fromEntries(src.map(f => [f.path, f.sha256])), criteria, excluded: sel.excluded.map(x => ({ ...x, attorney: { criterion: byId.get(x.rubricId)?.criteria.trim() ?? null, weight: byId.get(x.rubricId)?.weight ?? null } })) });
  }
  const all = tasks.flatMap(t => t.criteria);
  const out_ = { format: 'tough-eval-layer-c-tasks/1',
    source: { dataset: DATASET, revision: REVISION, url: `https://huggingface.co/datasets/${DATASET}/tree/${REVISION}`, licence: LICENCE, attribution: 'tough-eval/sources/ATTRIBUTION.md' },
    selection: 'The 2 October audit (eval-feasibility/redline-task-audit.md): criteria classed U (transfer as written) and A (transfer with output adaptation) are judged; I (incompatible) are excluded with the audit\'s reason. Adapted wording in layer-c/criteria.mjs.',
    reviewMode: 'third-party (as review-one.mjs runs every layer); the document carries originalText for paragraphs with earlier tracked changes; no separate context: the positions reach the reviewer as the playbook',
    counts: { tasks: tasks.length, criteria: all.length, transferAsWritten: all.filter(c => c.class === 'U').length, adapted: all.filter(c => c.class === 'A').length, change: all.filter(c => c.kind === 'change').length, keep: all.filter(c => c.kind === 'keep').length, excluded: tasks.reduce((a, t) => a + t.excluded.length, 0) },
    files, tasks };
  writeStamped(path.join(out, TASKS_FILE), out_, guid);
  return out_;
}

/** The tasks file as the runner, renderer and judge read it (canary removed). */
export function loadTasks(file = path.join(HERE, TASKS_FILE)) { const { canary, ...t } = JSON.parse(readFileSync(file, 'utf8')); return t; }
export const readStripped = file => { const { canary, ...x } = JSON.parse(readFileSync(path.isAbsolute(file) ? file : path.join(EVAL, file), 'utf8')); return x; };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? null : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
  const source = path.resolve(arg('source') || path.join(HERE, 'source')); const out = path.resolve(arg('out') || HERE);
  if (arg('fetch')) { const m = await fetchSource(source, { tasks: TASKS }); console.log(`fetched ${DATASET}@${m.revision} (${m.cardLicence}), ${Object.values(m.tasks).flat().length} files`); }
  if (!existsSync(path.join(source, 'manifest.json'))) { console.error('no source: run with --fetch first'); process.exit(1); }
  const t = build({ source, out });
  console.log(`${t.counts.tasks} tasks, ${t.counts.criteria} criteria (${t.counts.transferAsWritten} as written, ${t.counts.adapted} adapted; ${t.counts.change} change, ${t.counts.keep} keep), ${t.counts.excluded} excluded`);
  for (const x of t.tasks) console.log(`  ${x.id}: ${x.paragraphs} paragraphs (${x.revisedParagraphs} with earlier changes), ${x.playbookRules} rules, ${x.criteria.length} criteria, golden ${x.golden.source}`);
  console.log(`wrote ${path.relative(process.cwd(), path.join(out, TASKS_FILE))}`);
}
