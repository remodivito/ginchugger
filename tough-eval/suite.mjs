// SPDX-License-Identifier: GPL-3.0-or-later
// The whole tough eval as one list of variants: the agreement suite (manifest.json) and, when built, the long bundle
// (manifest-bundle.json). Each variant says which clean text it was planted in (`base`) and which playbook reviews it
// (`playbook`), so the agreement variants keep their 19-rule playbook and stay comparable with earlier runs.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(path.join(here, f), 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');

// `name` picks the suite: 'tough' (default) is the planted-deviation suite; 'contractnli' is the real-NDA layer built by
// contractnli/build.mjs, with its own playbook, split and scorer. Every variant carries `file` (its JSON, relative to
// this directory) and the suite carries `split` (its split file) so run.mjs needs no suite-specific paths.
export function loadSuite(name = 'tough') {
  if (name === 'contractnli') {
    const m = JSON.parse(read('contractnli/manifest.json'));
    const variants = m.variants.map(v => ({ ...v, playbook: 'contractnli/playbook-nda.json', file: `contractnli/variants/${v.id}.json` }));
    const playbooks = { 'contractnli/playbook-nda.json': { file: 'contractnli/playbook-nda.json', sha256: sha(read('contractnli/playbook-nda.json')), rules: JSON.parse(read('contractnli/playbook-nda.json')).rules } };
    return { name, manifests: [m], variants, playbooks, baseText: () => new Map(), version: m.version, split: 'contractnli/split.json' };
  }
  if (V2_ROOTS[name]) return name.startsWith('v2h') ? loadV2h(name) : loadV2a(name);
  if (name !== 'tough') throw Error(`unknown suite ${name}; known: tough, contractnli, ${Object.keys(V2_ROOTS).join(', ')}`);
  const manifests = [JSON.parse(read('manifest.json'))];
  if (existsSync(path.join(here, 'manifest-bundle.json'))) manifests.push(JSON.parse(read('manifest-bundle.json')));
  const variants = manifests.flatMap(m => m.variants.map(v => ({ base: 'base.json', playbook: 'playbook.json', ...v, file: `variants/${v.id}.json` })));
  const playbooks = Object.fromEntries([...new Set(variants.map(v => v.playbook))].map(f => [f, { file: f, sha256: sha(read(f)), rules: JSON.parse(read(f)).rules }]));
  const bases = {};
  const baseText = file => bases[file] || (bases[file] = new Map(JSON.parse(read(file)).paragraphs.map(p => [p.id, p.text])));
  return { name, manifests, variants, playbooks, baseText, version: manifests.map(m => m.version).join('+'), split: 'split.json' };
}
// v1 markups are K and BK; v2 markups are M-<author>-<document>-<side> (BENCHMARK-V2.md 11.3).
export const isMarkup = id => /^B?K/.test(id) || /^M-/.test(id);

// ---- v2 (BENCHMARK-V2.md 11.2 to 11.4) ------------------------------------------------------------------------------
// v2a: layer A items and markups as variants, from <root>/manifest.json (written by v2/apply.mjs); each variant's file is
// <root>/variants/<id>.json unless the manifest names one. v2h: layer H, one variant per scenario in <root>/scenarios/,
// whose document is the scenario's current layer A variant and whose plants are that item's, so score.mjs scores the
// current document unchanged and v2/score-h.mjs adds the record measures. The fixture suites are the same loaders over
// the synthetic fixture (v2/fixtures/synthetic/), used by the self-tests and the dry runs until the real items exist.
// v2a-prelim and v2h-prelim (17 October 2026): the item set of the preliminary run (16 to 17 October), kept byte for byte
// in v2/prelim/snapshot-2026-10-17 when the layer A fixes rebuilt the variants on the calibrated base documents, so the
// preliminary runs stay scorable and the preliminary report reproducible. A v2a or v2h run whose manifest records the
// item set version "v2a-dev" (every run before the fixes; the rebuilt set is "v2a-1" and later) is scored on it.
export const PRELIM_SNAPSHOT = 'v2/prelim/snapshot-2026-10-17';
export const PRELIM_VERSION = 'v2a-dev';
export const V2_ROOTS = { v2a: 'v2', v2h: 'v2', 'v2a-fixture': 'v2/fixtures/synthetic', 'v2h-fixture': 'v2/fixtures/synthetic', 'v2a-prelim': PRELIM_SNAPSHOT, 'v2h-prelim': PRELIM_SNAPSHOT };
export const isV2 = name => Boolean(V2_ROOTS[name]);
export const isPrelimSuite = name => /-prelim$/.test(String(name));
/** The suite a run was made on, from its manifest (runs made before suiteName existed are the v1 suite). */
export const suiteOfRun = meta => {
  if (!(meta && (meta.suiteName === 'contractnli' || V2_ROOTS[meta.suiteName]))) return 'tough';
  if (['v2a', 'v2h'].includes(meta.suiteName) && String(meta.suite || '').split('+')[0] === PRELIM_VERSION) return `${meta.suiteName}-prelim`;
  return meta.suiteName;
};
function loadV2a(name) {
  const root = V2_ROOTS[name.replace(/^v2h/, 'v2a')];
  const file = `${root}/manifest.json`;
  if (!existsSync(path.join(here, file))) throw Error(`${file} does not exist yet (written by v2/apply.mjs); the synthetic fixture is suite ${name}-fixture`);
  const m = JSON.parse(read(file));
  const variants = m.variants.map(v => ({ ...v, markup: v.markup ?? isMarkup(v.id), file: v.file || `${root}/variants/${v.id}.json` }));
  const playbooks = Object.fromEntries([...new Set([...Object.keys(m.playbooks || {}), ...variants.map(v => v.playbook)])].map(f => [f, { file: f, sha256: sha(read(f)), rules: JSON.parse(read(f)).rules }]));
  const bases = {};
  const baseText = f => bases[f] || (bases[f] = new Map(JSON.parse(read(f)).paragraphs.map(p => [p.id, p.text])));
  const items = existsSync(path.join(here, root, 'items.json')) ? JSON.parse(read(`${root}/items.json`)).items : [];
  return { name, root, manifests: [m], variants, playbooks, baseText, items, version: m.version, split: null };
}
function loadV2h(name) {
  const a = loadV2a(name); const dir = path.join(here, a.root, 'scenarios');
  const byVariant = new Map(a.variants.map(v => [v.id, v]));
  // A file-sync conflict copy ("H-glm-01 2.json", as iCloud writes them in this workspace) is never a scenario.
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
  const copies = files.filter(f => /\s/.test(f)); if (copies.length) console.warn(`${a.root}/scenarios: ignoring ${copies.length} file(s) with a space in the name (sync conflict copies?): ${copies.join(', ')}`);
  const variants = files.filter(f => !/\s/.test(f)).map(f => {
    const rel = `${a.root}/scenarios/${f}`; const sc = JSON.parse(read(rel)); const cur = byVariant.get(sc.current.variantId);
    if (!cur) throw Error(`${rel}: current variant ${sc.current.variantId} is not in ${a.root}/manifest.json`);
    return { ...cur, id: sc.id, sha256: sha(cur.sha256 + sha(read(rel))), playbook: sc.current.playbook || cur.playbook, author: sc.author, itemAuthor: cur.author, itemId: sc.current.itemId,
      variantId: cur.id, scenario: rel, kind: sc.kind, status: sc.status, markup: false };
  });
  const playbooks = Object.fromEntries([...new Set(variants.map(v => v.playbook))].map(f => [f, { file: f, sha256: sha(read(f)), rules: JSON.parse(read(f)).rules }]));
  return { ...a, name, variants, playbooks: { ...a.playbooks, ...playbooks }, version: `${a.version}+h${variants.length}` };
}
