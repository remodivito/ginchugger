// SPDX-License-Identifier: GPL-3.0-or-later
// Playbook (spec R7.1–R7.5; T13). Entries stay human-readable. The earlier shape (id, title, topic, guidance,
// conditions, fallback, enabled) is kept and widened with tiers and sources; no deterministic rule language.
// One active playbook per kind with a change counter (`version`); an import replaces it only by an explicit activation.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const TIERS = ['preferred', 'acceptable', 'escalation', 'hardLine'];
const str = (v, max = 4000) => typeof v === 'string' ? v.slice(0, max) : '';

/** Normalise one entry to the widened schema without losing anything the older shape carried. */
export function normalizeRule(r) {
  if (!r || typeof r.id !== 'string' || !r.id.trim()) throw Object.assign(new Error('Every rule needs a unique ID, title and guidance.'), { status: 400 });
  const out = { id: r.id.trim(), title: str(r.title, 200).trim(), topic: str(r.topic, 100) || 'custom', guidance: str(r.guidance, 20000).trim(), conditions: r.conditions && typeof r.conditions === 'object' && !Array.isArray(r.conditions) ? r.conditions : {}, fallback: str(r.fallback, 4000), enabled: r.enabled !== false };
  if (!out.title || !out.guidance) throw Object.assign(new Error('Every rule needs a unique ID, title and guidance.'), { status: 400 });
  for (const t of TIERS) if (typeof r[t] === 'string' && r[t].trim()) out[t] = str(r[t], 4000);
  if (typeof r.wording === 'string' && r.wording.trim()) out.wording = str(r.wording, 4000);
  if (typeof r.rationale === 'string' && r.rationale.trim()) out.rationale = str(r.rationale, 4000);
  if (Array.isArray(r.sources)) out.sources = r.sources.filter(s => s && typeof s === 'object').slice(0, 20).map(s => ({ document: str(s.document, 200), paragraph: str(s.paragraph, 40) || null, quote: str(s.quote, 2000) || null, ...(typeof s.verified === 'boolean' ? { verified: s.verified } : {}) }));
  if (typeof r.sourceExample === 'string' && r.sourceExample.trim()) out.sourceExample = str(r.sourceExample, 4000);
  return out;
}

/**
 * What a playbook applies to (Phase 7): a label the lawyer reads ("Mutual NDAs") and the words that identify such a
 * document by its title or opening headings ("non-disclosure agreement"). Used only to suggest a playbook from facts.
 */
export function normalizeAppliesTo(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const label = str(a.label, 120).trim();
  const phrases = Array.isArray(a.phrases) ? [...new Set(a.phrases.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().toLowerCase().slice(0, 80)))].slice(0, 20) : [];
  return label || phrases.length ? { label, phrases } : null;
}

export function validatePlaybook(input) {
  if (!input || !Array.isArray(input.rules) || input.rules.length > 100) throw Object.assign(new Error('Playbook must contain at most 100 rules.'), { status: 400 });
  const ids = new Set(); const rules = [];
  for (const r of input.rules) { const n = normalizeRule(r); if (ids.has(n.id)) throw Object.assign(new Error('Every rule needs a unique ID, title and guidance.'), { status: 400 }); ids.add(n.id); rules.push(n); }
  const appliesTo = normalizeAppliesTo(input.appliesTo);
  return { ...(typeof input.title === 'string' ? { title: input.title.slice(0, 200) } : {}), ...(typeof input.provenance === 'string' || (input.provenance && typeof input.provenance === 'object') ? { provenance: input.provenance } : {}), ...(appliesTo ? { appliesTo } : {}), rules };
}

/**
 * Mechanical import of a prose playbook (R7.1, D43): one entry per "Section N — Title" heading, guidance = the section's
 * full text, tier fields filled from "Preferred Position / Acceptable Without Escalation / Requires Escalation / Hard Line"
 * subsections when present, each entry citing its source paragraphs. No model, no interpretation.
 * `text` is the rendered document: one paragraph per line, optionally prefixed "[pN] ".
 */
export function importProsePlaybook(text, { sourceName = 'playbook' } = {}) {
  const SEC = /^\s*(?:\[p(\d+)\]\s*)?Section\s+(\d+)\s*[—–-]\s*(.+?)\s*$/;
  const SUB = /^\s*(?:\[p(\d+)\]\s*)?(\d+\.\d+(?:\([a-z]\))?)\s*[—–-]\s*(.+?)(?:\.\s{2,}(.*))?\s*$/;
  const TIER = { preferred: /preferred position/i, acceptable: /acceptable without escalation/i, escalation: /requires escalation/i, hardLine: /hard line/i };
  const entries = []; let cur = null, tier = null, firstP = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd(); if (!line.trim() || /^\[table\]|^\[\/table\]|^Rendered from /.test(line)) continue;
    const m = line.match(SEC);
    if (m) { cur = { id: `S-${String(m[2]).padStart(2, '0')}`, title: `Section ${m[2]} — ${m[3]}`, topic: m[3].toLowerCase(), guidance: [], conditions: {}, fallback: '', enabled: true, _tiers: { preferred: [], acceptable: [], escalation: [], hardLine: [] }, sources: [{ document: sourceName, paragraph: m[1] ? `p${m[1]}` : null, quote: null }] }; entries.push(cur); tier = null; continue; }
    if (!cur) continue;
    const pm = line.match(/^\s*\[p(\d+)\]/); const body = line.replace(/^\s*\[p\d+\]\s*/, '').trim();
    cur.guidance.push(body); if (pm) cur.sources[0].lastParagraph = `p${pm[1]}`;
    const sm = line.match(SUB);
    if (sm) { tier = Object.keys(TIER).find(k => TIER[k].test(sm[3])) || null; if (tier && sm[4]) cur._tiers[tier].push(sm[4].trim()); continue; }
    if (tier) cur._tiers[tier].push(body);
  }
  return entries.map(e => { const { _tiers, ...rest } = e; const out = { ...rest, guidance: e.guidance.join('\n').trim() }; for (const t of TIERS) if (_tiers[t].length) out[t] = _tiers[t].join('\n').trim(); if (out.acceptable && !out.fallback) out.fallback = out.acceptable; out.sources[0].paragraph = out.sources[0].paragraph && out.sources[0].lastParagraph ? `${out.sources[0].paragraph}–${out.sources[0].lastParagraph}` : out.sources[0].paragraph; delete out.sources[0].lastParagraph; return out; });
}

/** One active playbook at <dir>/playbook.json. `version` counts changes; no history is kept and there is no rollback (decision 150). */
export function makeStore({ dir, seedPath = null }) {
  const activePath = path.join(dir, 'playbook.json');
  let queue = Promise.resolve();
  const getActive = async () => {
    if (existsSync(activePath)) return JSON.parse(await readFile(activePath, 'utf8'));
    if (seedPath) return JSON.parse(await readFile(seedPath, 'utf8'));
    throw Object.assign(new Error('Playbook not found.'), { status: 404 });
  };
  async function save(next) {
    await mkdir(dir, { recursive: true });
    await writeFile(activePath + '.tmp', JSON.stringify(next, null, 2)); await rename(activePath + '.tmp', activePath);
    return next;
  }
  return {
    getActive,
    /** Replace the active playbook with an edited copy of the current version (optimistic concurrency on version). */
    async update(input) {
      const clean = validatePlaybook(input);
      const op = queue.then(async () => { const current = await getActive(); if (current.version !== input.version) throw Object.assign(new Error('The playbook changed. Reload it before saving.'), { status: 409 }); return save({ ...current, ...clean, version: current.version + 1, updatedAt: new Date().toISOString(), activatedFrom: 'edit' }); });
      queue = op.catch(() => {}); return op;
    },
    /** Activate an imported draft as the active playbook; the change counter moves on. */
    async activate(draft, { origin = 'draft' } = {}) {
      const clean = validatePlaybook(draft);
      // The playbook keeps its identity and scope across versions: a draft without "applies to" keeps the current one.
      const op = queue.then(async () => { const current = await getActive(); return save({ ...(current.id ? { id: current.id } : {}), ...clean, title: clean.title || current.title, ...(clean.appliesTo || current.appliesTo ? { appliesTo: clean.appliesTo || current.appliesTo } : {}), version: current.version + 1, updatedAt: new Date().toISOString(), activatedFrom: origin, previousVersion: current.version }); });
      queue = op.catch(() => {}); return op;
    },
    /** Write the first version of a new playbook. Refused when one already exists here. */
    async init(first, { origin = 'draft' } = {}) {
      const clean = validatePlaybook(first);
      const op = queue.then(async () => { if (existsSync(activePath)) throw Object.assign(new Error('A playbook already exists here.'), { status: 409 }); return save({ ...(first.id ? { id: first.id } : {}), ...clean, version: 1, updatedAt: new Date().toISOString(), activatedFrom: origin }); });
      queue = op.catch(() => {}); return op;
    },
  };
}

/**
 * Playbook library (Phase 7, P2). Several playbooks, each with an id, a title, what it applies to and a change counter.
 * `seeds` lists the shipped playbooks, first one first: it keeps the paths a single playbook always had
 * (<dir>/playbook.json), so a state folder from before the library opens unchanged.
 * Every other playbook lives under <dir>/playbooks/<id>/playbook.json. Playbooks the lawyer creates are
 * listed in <dir>/playbooks/index.json. Nothing is moved or migrated.
 */
export function makeLibrary({ dir, seeds }) {
  if (!Array.isArray(seeds) || !seeds.length) throw new Error('A library needs at least one shipped playbook.');
  const primary = seeds[0].id; const stores = new Map(); const indexPath = path.join(dir, 'playbooks', 'index.json');
  const seedMeta = new Map(seeds.map(s => [s.id, (() => { try { return JSON.parse(readFileSync(s.seedPath, 'utf8')); } catch { return {}; } })()]));
  let queue = Promise.resolve();
  const created = async () => existsSync(indexPath) ? JSON.parse(await readFile(indexPath, 'utf8')) : [];
  const ids = async () => [...seeds.map(s => s.id), ...(await created()).map(c => c.id).filter(id => !seeds.some(s => s.id === id))];
  const storeFor = id => { if (!stores.has(id)) stores.set(id, makeStore({ dir: id === primary ? dir : path.join(dir, 'playbooks', id), seedPath: seeds.find(s => s.id === id)?.seedPath || null })); return stores.get(id); };
  const unknown = () => Object.assign(new Error('Unknown playbook.'), { status: 404 });
  async function store(id) { const key = id || primary; if (typeof key !== 'string' || !(await ids()).includes(key)) throw unknown(); return storeFor(key); }
  // A playbook as read always carries its library id; a file from before the library takes "applies to" from its seed.
  const stamp = (id, pb) => ({ ...pb, id, appliesTo: normalizeAppliesTo(pb.appliesTo) || normalizeAppliesTo(seedMeta.get(id)?.appliesTo) || null });
  return {
    primary,
    async get(id) { const key = id || primary; return stamp(key, await (await store(key)).getActive()); },
    async list() { return Promise.all((await ids()).map(async id => { const pb = await this.get(id); return { id, title: pb.title || id, version: pb.version, appliesTo: pb.appliesTo, rules: pb.rules.length, provenance: pb.provenance || null }; })); },
    async update(id, input) { return stamp(id || primary, await (await store(id)).update(input)); },
    async activate(id, draft, opts) { return stamp(id || primary, await (await store(id)).activate(draft, opts)); },
    /** Create a new playbook from a draft: an explicit action with a name. The playbooks already held are not touched. */
    async create({ title, appliesTo = null, draft, origin = 'draft' }) {
      const name = typeof title === 'string' ? title.trim().slice(0, 200) : '';
      if (!name) throw Object.assign(new Error('Name the new playbook.'), { status: 400 });
      const op = queue.then(async () => {
        const taken = await ids(); const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'playbook';
        let id = base; for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
        const saved = await storeFor(id).init({ ...(draft || {}), id, title: name, appliesTo: normalizeAppliesTo(appliesTo) || normalizeAppliesTo(draft?.appliesTo) || undefined }, { origin });
        await mkdir(path.dirname(indexPath), { recursive: true });
        const index = [...(await created()), { id, title: name, createdAt: saved.updatedAt, origin }];
        await writeFile(indexPath + '.tmp', JSON.stringify(index, null, 2)); await rename(indexPath + '.tmp', indexPath);
        return stamp(id, saved);
      });
      queue = op.catch(() => {}); return op;
    },
  };
}
