// SPDX-License-Identifier: GPL-3.0-or-later
// frozen.json (BENCHMARK-V2.md 11.7, 13, 14.1, P12): the hashes of everything a test result depends on, and the check
// that a checkout still matches them. Paths are relative to the repository root. A path ending in /* stands for every
// file in that folder: its value is the SHA-256 of the sorted list of the files' SHA-256s, one per line. The spec file
// itself is compared as it stands at the tag (it may be edited after the tag only in its hardening log, challenges and
// a dated appendix), so for it the tagged version is hashed when the tag exists.
//   node tough-eval/v2/check-frozen.mjs [--frozen <file>] [--require-tag]      check; exit 1 on any mismatch
//   node tough-eval/v2/check-frozen.mjs --write [--draft] [--tag bench-v2.0] [--frozen <file>] [--layer A]
//        [--prompt-per-setup deepseek-v4-flash=product,glm-5.3-flash=product]
//        --layer A freezes layer A only (FROZEN_FILES_A; frozen.json gets "layers": ["A"] and no layerBTest)
//        write frozen.json from the working tree, keeping promptPerSetup and toolsSupported from the existing file and
//        filling layerBTest from contractnli/manifest.json. --draft (P3) allows files that do not exist yet (null).
// run.mjs --test calls checkFrozen({ requireTag: true }): HEAD must be the commit the tag names, frozen.json must be
// the tagged one and not a draft, and every listed file must hash as recorded.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const FROZEN_PATH = path.join(here, 'frozen.json');
export const DEFAULT_TAG = 'bench-v2.0';
const sha = b => createHash('sha256').update(b).digest('hex');
// 11.7's list, then (marked) the files the published numbers also depend on that 11.7 does not name.
export const FROZEN_FILES = [
  'contract-review/server/review.js', 'contract-review/server/executors.js', 'contract-review/server/store/tools.js',
  'contract-review/server/store/tool-schemas.json', 'contract-review/shared/compare.js',
  'contract-review/prompts/review.md', 'contract-review/prompts/review-record.md', 'tough-eval/arms/plain.md',
  'tough-eval/playbook-bundle.json', 'tough-eval/playbook-vendor.json', 'tough-eval/v2/playbook-nda-discloser.json',
  'tough-eval/v2/playbook-nda-recipient.json', 'tough-eval/contractnli/playbook-nda.json',
  'tough-eval/v2/base-csa.json', 'tough-eval/v2/base-nda.json', 'tough-eval/v2/items.json', 'tough-eval/v2/manifest.json',
  'tough-eval/v2/scenarios/*', 'tough-eval/v2/layer-c/layer-c-tasks.json', 'tough-eval/v2/layer-c/prompts/judge-c.md',
  'tough-eval/v2/AUTHORING-SPEC.md', 'tough-eval/BENCHMARK-V2.md', 'tough-eval/score.mjs', 'tough-eval/contractnli/score.mjs',
  'tough-eval/v2/score-h.mjs', 'tough-eval/compare.mjs', 'tough-eval/contractnli/split.json', 'tough-eval/split.json', 'contract-review/data/clause-types.json',
  'tough-eval/suite.mjs', 'tough-eval/run.mjs', 'tough-eval/review-one.mjs', 'tough-eval/v2/profile.mjs', 'tough-eval/v2/by-author.mjs', 'tough-eval/v2/seed-record.mjs',
  'tough-eval/v2/apply-scenarios.mjs', 'tough-eval/v2/lib/scenarios.mjs', 'tough-eval/v2/verify-scenarios.mjs', 'tough-eval/v2/roster.json', 'tough-eval/v2/prompts/verify-scenario.md', 'tough-eval/v2/layer-c/render.mjs', 'tough-eval/v2/layer-c/judge.mjs', 'tough-eval/v2/layer-c/panel.mjs', 'tough-eval/v2/layer-c/score.mjs', 'tough-eval/v2/layer-c/criteria.mjs', 'tough-eval/v2/layer-c/positions.mjs', 'tough-eval/v2/layer-c/docx.mjs', 'tough-eval/v2/layer-c/import.mjs', 'tough-eval/v2/layer-c/source.mjs', 'tough-eval/v2/layer-c/run.mjs', 'tough-eval/v2/layer-c/documents/*', 'tough-eval/v2/layer-c/playbooks/*', 'tough-eval/v2/layer-c/golden/*', 'tough-eval/v2/layer-c/markup/*', 'tough-eval/v2/retry-policy.mjs', 'tough-eval/baselines/local-rules.mjs',
  'contract-review/server/store-mcp.js',
  // Not named in 11.7 but read by the code above when it produces a result or a score (E1, 15 October):
  'tough-eval/v2/variants/*', 'tough-eval/v2/stats.mjs', 'tough-eval/v2/canary.mjs', 'tough-eval/v2/baselines.mjs', 'tough-eval/v2/check-frozen.mjs',
  'tough-eval/contractnli/rules.mjs', 'tough-eval/contractnli/manifest.json', 'tough-eval/controls.mjs',
  'contract-review/server/store/seed.js', 'contract-review/server/tools-listener.js',
  // The flat document store of decisions 190 and 191 (16 October 2026): the in-memory store layer H seeds, its shared
  // rules, and the text extraction read_document returns and citations are checked against.
  'contract-review/server/store/fake.js', 'contract-review/server/store/index.js', 'contract-review/server/store/text.js', 'contract-review/server/record/files.js',
];
export const TAGGED_VERSION = ['tough-eval/BENCHMARK-V2.md'];
/**
 * Layer A only (17 October 2026, the frozen layer A run; tag bench-v2.0-a): what a layer A test result depends on. The
 * single-call review path and its two prompts (the product's review.md and arms/plain.md, side-filled by
 * arms/render-prompt.mjs), the executors, the four playbooks, the calibrated base documents, the items, markups, variants,
 * manifest and inserted-clause accept checks, the scorer and profile code, and the runner. Layers B, C and H are not
 * frozen by this file; run.mjs --test refuses a suite whose layer is not in `layers`.
 */
export const FROZEN_FILES_A = [
  'contract-review/server/review.js', 'contract-review/server/executors.js', 'contract-review/shared/compare.js', 'contract-review/server/store/text.js',
  'contract-review/server/store/tools.js', 'contract-review/prompts/review.md', 'contract-review/package.json', 'contract-review/package-lock.json',
  'tough-eval/arms/plain.md', 'tough-eval/arms/render-prompt.mjs', 'tough-eval/arms/review-decomposed.mjs',
  'tough-eval/playbook-bundle.json', 'tough-eval/playbook-vendor.json', 'tough-eval/v2/playbook-nda-discloser.json', 'tough-eval/v2/playbook-nda-recipient.json',
  'tough-eval/v2/base-csa.json', 'tough-eval/v2/base-nda.json', 'tough-eval/v2/items.json', 'tough-eval/v2/markups.json', 'tough-eval/v2/manifest.json',
  'tough-eval/v2/variants/*', 'tough-eval/v2/inserted-checks.json',
  'tough-eval/v2/AUTHORING-SPEC.md', 'tough-eval/BENCHMARK-V2.md',
  'tough-eval/score.mjs', 'tough-eval/suite.mjs', 'tough-eval/run.mjs', 'tough-eval/review-one.mjs', 'tough-eval/controls.mjs',
  'tough-eval/v2/profile.mjs', 'tough-eval/v2/by-author.mjs', 'tough-eval/v2/stats.mjs', 'tough-eval/v2/canary.mjs', 'tough-eval/v2/retry-policy.mjs',
  'tough-eval/v2/check-frozen.mjs', 'tough-eval/v2/baselines.mjs', 'tough-eval/baselines/local-rules.mjs',
  'tough-eval/v2/lib/store.mjs', 'tough-eval/v2/lib/items.mjs', 'tough-eval/v2/lib/common.mjs', 'tough-eval/v2/apply.mjs', 'tough-eval/v2/markups.mjs',
  'tough-eval/v2/frozen/lane-frozen-a.zsh', 'tough-eval/v2/frozen/gate.mjs', 'tough-eval/v2/frozen/report.mjs',
];
export const FILES_BY_LAYERS = { all: FROZEN_FILES, A: FROZEN_FILES_A };
/** The layer a suite belongs to (A: v2a, B: contractnli, H: v2h, C: layer C), for the `layers` check of run.mjs --test. */
export const layerOfSuite = name => (String(name).startsWith('v2a') ? 'A' : String(name).startsWith('v2h') ? 'H' : name === 'contractnli' ? 'B' : String(name).startsWith('v2c') ? 'C' : null);

const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const tagCommit = tag => { const b = git('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`); return b ? b.toString().trim() : null; };
// Paths here are relative to outputs/; the repository's top level may be above it (it is: outputs/ is a subfolder).
let prefix = null; const gitPrefix = () => (prefix ??= (git('rev-parse', '--show-prefix')?.toString().trim() ?? ''));
const atTag = (tag, rel) => (tag && tagCommit(tag) ? git('show', `${tag}:${gitPrefix()}${rel}`) : null);

/** The hash of one entry in the working tree (or, for TAGGED_VERSION files, at the tag when it exists); null if absent. */
export function hashEntry(rel, { tag = null } = {}) {
  if (rel.endsWith('/*')) {
    const dir = path.join(ROOT, rel.slice(0, -2)); if (!existsSync(dir)) return null;
    const hs = readdirSync(dir).filter(f => statSync(path.join(dir, f)).isFile()).map(f => sha(readFileSync(path.join(dir, f)))).sort();
    return hs.length ? sha(hs.join('\n')) : null;
  }
  if (TAGGED_VERSION.includes(rel)) { const b = atTag(tag, rel); if (b) return sha(b); }
  const f = path.join(ROOT, rel); return existsSync(f) ? sha(readFileSync(f)) : null;
}
/** The number of labelled departures in ContractNLI's test split (E-16), computed from the manifest before any run. */
export async function layerBTest() {
  const m = JSON.parse(readFileSync(path.join(ROOT, 'tough-eval/contractnli/manifest.json'), 'utf8'));
  const split = JSON.parse(readFileSync(path.join(ROOT, 'tough-eval/contractnli/split.json'), 'utf8'));
  const { RULES, verdictOf } = await import('../contractnli/rules.mjs');
  const test = new Set(split.heldout); let n = 0;
  for (const v of m.variants.filter(v => test.has(v.id))) for (const r of Object.keys(RULES)) if (v.gold[r] && verdictOf(r, v.gold[r].choice) === 'departs') n++;
  return { ndas: test.size, labelledDepartures: n };
}

/** Check a checkout against frozen.json. Never throws: returns { ok, problems, notYetFrozen, tag, frozenSha256, draft, data }. */
export function checkFrozen({ frozenPath = FROZEN_PATH, requireTag = false } = {}) {
  const out = { ok: false, problems: [], notYetFrozen: [], tag: null, frozenSha256: null, draft: null, data: null };
  if (!existsSync(frozenPath)) { out.problems.push(`${path.relative(ROOT, frozenPath)} does not exist (written at P12 by check-frozen.mjs --write)`); return out; }
  const bytes = readFileSync(frozenPath); out.frozenSha256 = sha(bytes);
  let data; try { data = JSON.parse(bytes); } catch (e) { out.problems.push(`frozen.json does not parse: ${e.message}`); return out; }
  out.data = data; out.tag = data.tag || null; out.draft = !!data.draft;
  if (data.format !== 'tough-eval-frozen/1') out.problems.push(`format is ${data.format}, want tough-eval-frozen/1`);
  for (const [rel, want] of Object.entries(data.files || {})) {
    if (want === null) { out.notYetFrozen.push(rel); continue; }
    const have = hashEntry(rel, { tag: out.tag });
    if (have === null) out.problems.push(`${rel}: missing`); else if (have !== want) out.problems.push(`${rel}: hash differs`);
  }
  if (requireTag) {
    if (out.draft) out.problems.push('frozen.json is a draft (P3); P12 writes the final one');
    if (out.notYetFrozen.length) out.problems.push(`not yet frozen: ${out.notYetFrozen.join(', ')}`);
    const commit = out.tag && tagCommit(out.tag); const head = git('rev-parse', 'HEAD')?.toString().trim();
    if (!out.tag) out.problems.push('frozen.json names no tag');
    else if (!commit) out.problems.push(`tag ${out.tag} does not exist`);
    else {
      if (commit !== head) out.problems.push(`HEAD ${head?.slice(0, 12)} is not ${out.tag} (${commit.slice(0, 12)})`);
      const tagged = atTag(out.tag, path.relative(ROOT, frozenPath)); if (!tagged || sha(tagged) !== out.frozenSha256) out.problems.push(`frozen.json differs from the one committed under ${out.tag}`);
    }
  }
  out.ok = out.problems.length === 0;
  return out;
}

/**
 * The frozen per-setup entry (promptPerSetup or toolsSupported) a run is bound by: [key, value] or null. A key binds a
 * run whose --setup or model id contains it once both are reduced to lower-case letters and digits, so the keys of
 * 11.7 ("qwen-3.8-27b") match the ids actually sent ("qwen/qwen3.8-27b"); a raw substring test missed that and let the
 * run through unbound (pre-flight, 15 October).
 */
export function frozenChoice(map, { setup = null, model = null } = {}) {
  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const hay = [norm(setup), norm(model)].filter(Boolean);
  for (const [key, value] of Object.entries(map || {})) { const k = norm(key); if (k && hay.some(h => h.includes(k))) return [key, value]; }
  return null;
}
/** Executors whose setups need a frozen prompt choice (and, agentic, a tool-support entry): every non-Claude one. */
export const FROZEN_CHOICE_EXECUTORS = ['openai', 'muse', 'codex', 'agy'];
/**
 * The problems that refuse a --test run under the frozen per-setup choices (11.7, 13): the prompt must be the one
 * promptPerSetup fixes, a non-Claude setup must have an entry, and an agentic non-Claude setup must have toolsSupported
 * true (a recorded false refuses any setup). Returns a list of messages (empty when the run may start).
 */
export function frozenChoiceProblems(data, { setup = null, model = null, executor = 'claude', reviewPrompt = null, agentic = false } = {}) {
  const out = []; if (!data) return out;
  const prompt = frozenChoice(data.promptPerSetup, { setup, model }); const plain = /plain/.test(String(reviewPrompt || ''));
  if (prompt && (prompt[1] === 'plain') !== plain) out.push(`frozen.json fixes the ${prompt[1]} prompt for ${prompt[0]}`);
  if (!prompt && FROZEN_CHOICE_EXECUTORS.includes(executor) && Object.keys(data.promptPerSetup || {}).length) out.push(`frozen.json fixes no prompt for ${setup || model} (promptPerSetup has ${Object.keys(data.promptPerSetup).join(', ')})`);
  if (agentic) {
    const tools = frozenChoice(data.toolsSupported, { setup, model });
    if (tools && tools[1] === false) out.push(`frozen.json records no tool support for ${tools[0]}`);
    else if (!tools && FROZEN_CHOICE_EXECUTORS.includes(executor)) out.push(`frozen.json records no tool smoke result for ${setup || model} (toolsSupported)`);
  }
  return out;
}

export async function writeFrozen({ frozenPath = FROZEN_PATH, tag = DEFAULT_TAG, draft = false, canary = null, layer = 'all', promptPerSetup = null } = {}) {
  const prev = existsSync(frozenPath) ? JSON.parse(readFileSync(frozenPath, 'utf8')) : {};
  const list = FILES_BY_LAYERS[layer]; if (!list) throw Error(`unknown --layer ${layer}; known: ${Object.keys(FILES_BY_LAYERS).join(', ')}`);
  const files = Object.fromEntries(list.map(rel => [rel, hashEntry(rel, { tag })]));
  const missing = Object.entries(files).filter(([, h]) => h === null).map(([k]) => k);
  if (missing.length && !draft) throw Error(`cannot freeze, missing: ${missing.join(', ')} (use --draft before P12)`);
  const { canaryGuid } = await import('./canary.mjs');
  const data = { format: 'tough-eval-frozen/1', tag, frozenAt: new Date().toISOString(), canary: canary || canaryGuid() || prev.canary || null, ...(draft ? { draft: true } : {}),
    ...(layer === 'all' ? {} : { layers: [layer] }), files,
    promptPerSetup: promptPerSetup || prev.promptPerSetup || {}, toolsSupported: prev.toolsSupported || {}, ...(layer === 'all' ? { layerBTest: await layerBTest() } : {}) };
  writeFileSync(frozenPath, JSON.stringify(data, null, 1) + '\n');
  return { data, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2); const opt = k => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
  const frozenPath = opt('frozen') ? path.resolve(opt('frozen')) : FROZEN_PATH;
  if (opt('write')) {
    const pps = opt('prompt-per-setup') ? Object.fromEntries(String(opt('prompt-per-setup')).split(',').map(x => x.split('='))) : null;
    const { data, missing } = await writeFrozen({ frozenPath, tag: opt('tag') || DEFAULT_TAG, draft: !!opt('draft'), layer: opt('layer') || 'all', promptPerSetup: pps });
    console.log(`wrote ${frozenPath}: ${Object.keys(data.files).length} entries${data.layers ? ` (layers ${data.layers.join(', ')})` : ''}${missing.length ? `, ${missing.length} not yet present (draft): ${missing.join(', ')}` : ''}${data.layerBTest ? `; layer B test: ${data.layerBTest.ndas} NDAs, ${data.layerBTest.labelledDepartures} labelled departures` : ''}`);
  } else {
    const r = checkFrozen({ frozenPath, requireTag: !!opt('require-tag') });
    const listed = Object.keys(r.data?.files || {}).length;
    console.log(`${frozenPath}\nsha256 ${r.frozenSha256}\ntag ${r.tag}${r.draft ? ' (draft)' : ''}; ${listed} entries, ${listed - r.notYetFrozen.length} hashed${r.notYetFrozen.length ? `, ${r.notYetFrozen.length} not yet frozen` : ''}`);
    if (r.ok) console.log('frozen check passed'); else { console.log('frozen check FAILED\n- ' + r.problems.join('\n- ')); process.exitCode = 1; }
  }
}
