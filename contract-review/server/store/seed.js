// SPDX-License-Identifier: GPL-3.0-or-later
// A seeded in-memory store (plan task 10): the fake store (server/store/fake.js) filled with documents described as data,
// for the tool smoke test, the tests and the benchmark's layer H, so each can run the product's own store tools
// (server/store/tools.js) with no HTTP and no Docker.
//
// A seed is { format: 'ginchugger-store-seed/1', documents: [doc] }, each doc:
//   { key?, title, counterparty?, type?, created: 'YYYY-MM-DD', tags?: [name], notes?: [text],
//     and its content, one of: paragraphs: [{ id?, text, originalText? }]   (stored in our paragraph format, .json)
//                              email: { from, to?, subject, date?, text }  (stored as an .eml)
//                              text: '...'                                (stored as a .txt) }
// `key` names the document in the returned `ids` (default its title).
import { readFileSync } from 'node:fs';
import { createFakeStore } from './fake.js';
import { syntheticEml } from '../record/files.js';

export const SEED_FORMAT = 'ginchugger-store-seed/1';
const slug = s => String(s || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

/** The searchable text the fake store keeps for a seeded file: the paragraphs' words, not the JSON around them. */
export function seedText(buffer, filename) {
  const s = Buffer.from(buffer).toString('utf8');
  if (/\.json$/i.test(filename)) { try { return (JSON.parse(s).paragraphs || []).map(p => [p.text, p.originalText].filter(Boolean).join('\n')).join('\n'); } catch { return s; } }
  return s;
}

/** One seed document as the file the store holds: { buffer, filename }. */
export function seedFile(doc) {
  const base = slug(doc.title);
  if (Array.isArray(doc.paragraphs)) return { buffer: Buffer.from(JSON.stringify({ title: doc.title, paragraphs: doc.paragraphs.map((p, i) => ({ id: p.id || `p${i + 1}`, text: String(p.text ?? ''), ...(typeof p.originalText === 'string' ? { originalText: p.originalText } : {}) })) })), filename: `${base}.json` };
  if (doc.email && typeof doc.email === 'object') return { buffer: syntheticEml(doc.email), filename: `${base}.eml` };
  if (typeof doc.text === 'string') return { buffer: Buffer.from(doc.text, 'utf8'), filename: `${base}.txt` };
  throw new Error(`Seed document "${doc.title}" has no paragraphs, email or text.`);
}

/**
 * A fake store holding the seed's documents, added in the seed's order (so ids are 1, 2, 3, …). `seed`: the object or a
 * path to its JSON file. `user`: who the store's history and notes credit. Returns { store, ids: { key: id } }.
 */
export async function seedFakeStore(seed, { user = 'seed', now } = {}) {
  const s = typeof seed === 'string' ? JSON.parse(readFileSync(seed, 'utf8')) : seed;
  if (!s || !Array.isArray(s.documents)) throw new Error('A store seed holds a documents array.');
  const store = createFakeStore({ user, text: seedText, ...(now ? { now } : {}) });
  await store.ensureBaseTaxonomy();
  const ids = {};
  for (const doc of s.documents) {
    const { buffer, filename } = seedFile(doc);
    const d = await store.add(buffer, { filename, title: doc.title, counterparty: doc.counterparty || null, type: doc.type || null, created: doc.created || undefined, tags: doc.tags || [] }, { actor: { id: user, admin: true } });
    for (const n of doc.notes || []) await store.notes.add(d.id, n);
    ids[doc.key || doc.title] = d.id;
  }
  return { store, ids };
}
