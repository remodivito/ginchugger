// SPDX-License-Identifier: GPL-3.0-or-later
// The item store of one workspace (default tough-eval/v2; a smoke or dry run uses its own folder so nothing reaches the
// real test set): items.json (11.2), markups.json, variants/<id>.json and manifest.json (11.3), rebuilt from the items
// so the three never disagree. Paths inside the manifest are relative to tough-eval/, as suite.mjs expects.
import { readFileSync, existsSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { EVAL, SIDES, readJson, writeJson, sha256, canary } from './common.mjs';
import { stripCanary } from '../canary.mjs';
import { validateItem, applyEdits, coverPageSecondary } from './items.mjs';

export const rootAbs = root => path.isAbsolute(root) ? root : path.join(EVAL, root);
export const rootRel = root => path.relative(EVAL, rootAbs(root)).split(path.sep).join('/');
export function loadItems(root) { const f = path.join(rootAbs(root), 'items.json'); return existsSync(f) ? readJson(f) : { format: 'tough-eval-items/2', builtAt: null, items: [] }; }
export function saveItems(root, store) { return writeJson(path.join(rootAbs(root), 'items.json'), { format: 'tough-eval-items/2', builtAt: new Date().toISOString(), items: store.items }); }
/**
 * Run `fn` holding the workspace's store lock (<root>/.store.lock, a directory): several lanes apply, verify and build
 * markups at once in the preliminary run (16 October 2026), and each does load-modify-save on items.json. A lock older
 * than ten minutes, or held by a process that no longer exists, is taken over.
 */
export function withStoreLock(root, fn) {
  const dir = path.join(rootAbs(root), '.store.lock'); mkdirSync(rootAbs(root), { recursive: true });
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const started = Date.now();
  for (;;) {
    try { mkdirSync(dir); writeFileSync(path.join(dir, 'owner'), `${process.pid} ${new Date().toISOString()}`); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { const [pid] = readFileSync(path.join(dir, 'owner'), 'utf8').split(' '); try { process.kill(Number(pid), 0); } catch { stale = true; } } catch { /* owner not written yet */ }
      try { if (Date.now() - statSync(dir).mtimeMs > 600_000) stale = true; } catch { /* gone */ }
      if (stale) { rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() - started > 1_800_000) throw Error(`store lock ${dir} held for 30 minutes`);
      sleep(250);
    }
  }
  try { return fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
}
export function loadMarkups(root) { const f = path.join(rootAbs(root), 'markups.json'); return existsSync(f) ? readJson(f) : { format: 'tough-eval-markups/1', markups: [] }; }

const docCache = new Map();
const cleanDoc = base => { if (!docCache.has(base)) docCache.set(base, stripCanary(readJson(base))); return docCache.get(base); };
const sideOf = it => SIDES[`${it.document}-${it.side}`];

/** The variant document of a single item: the clean document with the item's edits, in the product's shape. */
export function itemVariant(item) {
  const s = sideOf(item), doc = cleanDoc(s.base), ruleIds = new Set(stripCanary(readJson(s.playbook)).rules.map(r => r.id));
  const v = validateItem(item, { doc, ruleIds }); if (v.errors.length) throw Error(`${item.id}: ${v.errors.join('; ')}`);
  return { doc: { id: item.id, revision: 1, title: doc.title, paragraphs: v.applied.paragraphs }, plant: plantOf(item, v.applied) };
}
export function plantOf(item, applied) {
  const s = sideOf(item); const secondary = s ? coverPageSecondary(item, cleanDoc(s.base)) : [];
  const accept = insertedChecks();
  return { id: item.id, kind: item.kind, level: item.kind === 'deviation' ? item.difficulty : 'benign', family: item.family, rules: [item.rule], targets: applied.targets,
    ...(secondary.length ? { secondaryTargets: secondary } : {}),
    ...(item.kind === 'deviation' ? { fixes: applied.fixes.map(f => ({ paragraph: f.paragraph, restore: f.restore, planted: f.planted, check: f.check, inserted: f.inserted,
      ...(f.inserted && accept[item.id]?.[f.paragraph] ? { acceptCheck: accept[item.id][f.paragraph].acceptCheck } : {}) })) } : {}) };
}
/**
 * Acceptable-wording checks for inserted clauses (fix 4, 17 October 2026): <EVAL>/v2/inserted-checks.json, keyed by item
 * id and inserted paragraph id. Without an entry an inserted clause is fixed only by its deletion, as before.
 */
let insertedCache = null;
export const INSERTED_CHECKS = 'v2/inserted-checks.json';
export function insertedChecks() {
  if (insertedCache) return insertedCache; const f = path.join(EVAL, INSERTED_CHECKS); insertedCache = {};
  if (existsSync(f)) for (const e of readJson(f).checks || []) (insertedCache[e.item] ||= {})[e.paragraph] = e;
  return insertedCache;
}
/** A markup: several items of one author, document and side applied together (paragraphs never overlap). */
export function markupVariant(markup, items) {
  const s = SIDES[`${markup.document}-${markup.side}`], doc = cleanDoc(s.base), clean = new Map(doc.paragraphs.map(p => [p.id, p.text]));
  let paragraphs = doc.paragraphs.map(p => ({ ...p })); const plants = [];
  for (const id of markup.items) {
    const item = items.find(i => i.id === id); if (!item) throw Error(`${markup.id}: item ${id} missing`);
    const a = applyEdits(paragraphs, item.edits, clean); if (a.errors.length) throw Error(`${markup.id}/${id}: ${a.errors.join('; ')}`);
    paragraphs = a.paragraphs;
    const single = itemVariant(item).plant; // targets and fixes as the single item; planted text taken from the markup
    const now = new Map(paragraphs.map(p => [p.id, p.text]));
    plants.push({ ...single, ...(single.fixes ? { fixes: single.fixes.map(f => ({ ...f, planted: now.get(f.paragraph) ?? f.planted, restore: f.inserted ? '' : clean.get(f.paragraph) })) } : {}) });
  }
  return { doc: { id: markup.id, revision: 1, title: doc.title, paragraphs }, plants };
}

/** Rewrite variants/ and manifest.json from items.json and markups.json. Dropped items get no variant. */
// The item set version written into manifest.json (and so into every run's manifest as `suite`): v2a-dev for the
// preliminary run's set (now in v2/prelim/snapshot-2026-10-17), v2a-1 from the layer A fixes of 17 October 2026 on.
export const ITEM_SET_VERSION = 'v2a-1';
export function rebuild(root, { version = ITEM_SET_VERSION } = {}) {
  const abs = rootAbs(root), rel = rootRel(root), store = loadItems(root), markups = loadMarkups(root).markups;
  // Rewritten in place, never deleted and recreated: a run reading variants while another lane rebuilds must not find a
  // file missing (preliminary run, 16 October 2026). A file whose bytes are unchanged is not touched; stale ones removed.
  const vdir = path.join(abs, 'variants'); mkdirSync(vdir, { recursive: true });
  const variants = []; const keep = new Set();
  const writeVariant = (file, obj) => { keep.add(path.basename(file)); const text = JSON.stringify({ canary: canary(), ...stripCanary(obj) }, null, 1) + '\n'; if (!existsSync(file) || readFileSync(file, 'utf8') !== text) { writeFileSync(file + '.tmp', text); renameSync(file + '.tmp', file); } return { file, sha256: sha256(text) }; };
  for (const item of store.items.filter(i => i.status !== 'dropped')) {
    const { doc, plant } = itemVariant(item); const w = writeVariant(path.join(vdir, `${item.id}.json`), doc);
    variants.push({ id: item.id, sha256: w.sha256, file: `${rel}/variants/${item.id}.json`, base: sideOf(item).base, playbook: sideOf(item).playbook, document: item.document, side: item.side, author: item.author, markup: false, status: item.status, plants: [plant] });
  }
  for (const m of markups) {
    const { doc, plants } = markupVariant(m, store.items); const w = writeVariant(path.join(vdir, `${m.id}.json`), doc);
    const st = m.items.map(id => store.items.find(i => i.id === id)?.status);
    variants.push({ id: m.id, sha256: w.sha256, file: `${rel}/variants/${m.id}.json`, base: SIDES[`${m.document}-${m.side}`].base, playbook: SIDES[`${m.document}-${m.side}`].playbook, document: m.document, side: m.side, author: m.author, markup: true, status: st.every(s => s === 'verified') ? 'verified' : 'contested', plants });
  }
  for (const f of readdirSync(vdir)) if (f.endsWith('.json') && !keep.has(f)) rmSync(path.join(vdir, f), { force: true });
  const fileSha = f => sha256(readFileSync(path.join(EVAL, f)));
  const manifest = { suite: 'tough-eval v2a', version, builtAt: new Date().toISOString(),
    documents: { csa: { base: 'v2/base-csa.json', sha256: fileSha('v2/base-csa.json') }, nda: { base: 'v2/base-nda.json', sha256: fileSha('v2/base-nda.json') } },
    playbooks: Object.fromEntries([...new Set(Object.values(SIDES).map(s => s.playbook))].map(f => [f, fileSha(f)])), variants };
  writeJson(path.join(abs, 'manifest.json'), manifest);
  return { variants: variants.length, canary: canary() };
}
export const listVariantFiles = root => { const d = path.join(rootAbs(root), 'variants'); return existsSync(d) ? readdirSync(d) : []; };
