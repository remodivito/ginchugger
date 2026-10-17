// SPDX-License-Identifier: GPL-3.0-or-later
// Layer H's seeded document store (BENCHMARK-V2.md section 8; decisions 190 and 191, 16 October 2026): a scenario's seed,
// unchanged, flattened into the product's store seed (`ginchugger-store-seed/1`, contract-review/server/store/seed.js)
// and loaded into the in-memory store with the product's own loader (seedFakeStore); the product's store tools and
// citation resolver over it (prepareAgenticReview, server/store/tools.js); and for the Claude CLI the product's tools
// listener, exactly as the product's tool smoke test does. The benchmark adds no tool and no prompt of its own.
//
// The flattening (the store has no matters or rounds; the model rebuilds a negotiation from the documents):
//   - every round of every matter is one document: title "<matter name> - our draft <n>" or "- their markup <n>", the
//     matter's counterparty (its name), type CSA or NDA (from the matter kind), created the day the round was received,
//     tagged `signed` when it is the matter's signed round; the round's paragraphs as its text;
//   - a round's covering email is a separate Email document (title its subject, created its date, same counterparty);
//   - a round's dismissals (finding_dismissed events) are notes on that round's document, in the lawyer's own words;
//     flags and applied edits are not carried (an applied edit shows in the next draft's text);
//   - the current document (canary removed) is the last document: the current matter's round `matter.round`, received
//     from the counterparty one day after its earlier rounds, as before;
//   - documents go into the store in date order, so ids rise with time.
// `docs` maps each store document id to { matterId, round, email, current, counterparty } for the scorer; it is never
// shown to the model. The canary is removed from the seed and every document before the store holds them. The
// empty-record store of the 40 empty-record items holds the current document and its counterparty, nothing else.
import { stripSeed, stripCanary } from './canary.mjs';
import { seedFakeStore, SEED_FORMAT } from '../../contract-review/server/store/seed.js';
import { prepareAgenticReview, DEFAULT_MAX_TOOL_CALLS } from '../../contract-review/server/store/tools.js';
import { readStoreText, citableText } from '../../contract-review/server/store/text.js';

/** The record kind (clause-type mapping key) for a document and side: the CSA sides map by side, the NDA as `nda`. */
export const kindFor = (document, side) => (document === 'nda' ? 'nda' : side === 'vendor' ? 'vendor' : 'customer');
/** The store document type for a record kind. */
export const typeFor = kind => (kind === 'nda' ? 'NDA' : 'CSA');
export const EMAIL_TYPE = 'Email';
const DAY = 86_400_000;
const day = iso => String(iso || '').slice(0, 10);
const roundTitle = (name, r) => `${name} - ${r.side === 'ours' ? 'our draft' : r.side === 'theirs' ? 'their markup' : 'draft'} ${r.n}`;

/** When the current document arrives: one day after the current matter's last earlier round or event (as before). */
function currentAt(seed, m) {
  const cur = seed.matters.find(x => x.id === m.id);
  const earlier = (cur?.rounds || []).filter(r => !Number.isInteger(m.round) || r.n < m.round).sort((a, b) => a.n - b.n); const last = earlier[earlier.length - 1];
  const lastAt = [last?.receivedAt, ...(last?.events || []).map(e => e.at)].filter(Boolean).sort().pop();
  return lastAt ? new Date(Date.parse(lastAt) + DAY).toISOString() : '2026-10-01T09:00:00.000Z';
}

/**
 * The store seed a scenario loads, and the scorer's map of it. Returns { seed: ginchugger-store-seed/1, refs, counterparty }
 * where refs[i] describes seed.documents[i]: { matterId, round, email, current, counterparty (the seed's id) }.
 */
export function scenarioStoreSeed(scenario, currentDocument = null) {
  const seed = stripSeed(scenario.seed);
  if (seed.standardForms?.length) throw Error(`${scenario.id}: a layer H seed holds no standard form (section 8)`);
  const cpName = new Map((seed.counterparties || []).map(c => [c.id, c.name])); const name = id => cpName.get(id) ?? id;
  const m = scenario.matter; const entries = [];
  for (const mt of seed.matters) {
    const type = typeFor(mt.kind || m.kind);
    for (const r of mt.rounds || []) {
      const ref = { matterId: mt.id, round: r.n, email: false, current: false, counterparty: mt.counterparty };
      const notes = (r.events || []).filter(e => e.type === 'finding_dismissed' && typeof e.payload?.note === 'string' && e.payload.note.trim()).map(e => e.payload.note);
      const signed = mt.status === 'signed' && mt.signedRound === r.n;
      entries.push({ at: r.receivedAt, ref, doc: { key: `${mt.id}#${r.n}`, title: roundTitle(mt.name, r), counterparty: name(mt.counterparty), type, created: day(r.receivedAt), tags: signed ? ['signed'] : [], ...(notes.length ? { notes } : {}), paragraphs: stripCanary(r.document).paragraphs } });
      if (r.covering?.text) {
        const c = r.covering; const at = c.date && !Number.isNaN(Date.parse(c.date)) ? c.date : r.receivedAt;
        entries.push({ at, ref: { ...ref, email: true }, doc: { key: `${mt.id}#${r.n}-email`, title: c.subject?.trim() || `${mt.name} - email`, counterparty: name(mt.counterparty), type: EMAIL_TYPE, created: day(at), email: { from: c.from || '', subject: c.subject || '', date: c.date || r.receivedAt, text: c.text } } });
      }
    }
  }
  // Date order (stable); at the same instant an email goes before the draft it carried.
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(b.ref.email) - Number(a.ref.email));
  if (currentDocument) {
    const at = currentAt(seed, m); const round = Number.isInteger(m.round) ? m.round : 1;
    entries.push({ at, ref: { matterId: m.id, round, email: false, current: true, counterparty: m.counterparty },
      doc: { key: 'current', title: roundTitle(m.name, { side: 'theirs', n: round }), counterparty: name(m.counterparty), type: typeFor(m.kind), created: day(at), tags: [], paragraphs: stripCanary(currentDocument).paragraphs } });
  }
  return { seed: { format: SEED_FORMAT, documents: entries.map(e => e.doc) }, refs: entries.map(e => e.ref), counterparty: m.counterparty };
}

/** The store of an empty-record item (section 8): the current document under its counterparty, nothing else. */
export function emptyStoreSeed({ document: kindDoc, side }, currentDocument) {
  return { seed: { format: SEED_FORMAT, documents: [{ key: 'current', title: 'Current matter - their markup 1', counterparty: 'Current counterparty', type: typeFor(kindFor(kindDoc, side)), created: '2026-10-01', tags: [], paragraphs: stripCanary(currentDocument).paragraphs }] },
    refs: [{ matterId: 'm-current', round: 1, email: false, current: true, counterparty: 'cp-current' }], counterparty: 'cp-current' };
}

/** Load a flattened seed into a fresh in-memory store. Returns { store, docs: Map(id -> ref), currentId }. */
export async function loadStore(flat) {
  const { store, ids } = await seedFakeStore(flat.seed);
  const docs = new Map(flat.seed.documents.map((d, i) => [ids[d.key], flat.refs[i]]));
  return { store, docs, currentId: ids.current ?? null };
}

/**
 * What the reviewer's store held, as the scorer reads it: per document id its text exactly as read_document returns it
 * (the product's server/store/text.js, the text review.js verifies citations against), its owner and its place in the
 * scenario. Returns { byId: Map(id -> { documentId, text, ...ref }), counterparty (the scenario's), docsOf(matterId) }.
 */
export async function storeView(scenario, currentDocument) {
  const flat = scenarioStoreSeed(scenario, currentDocument); const { store, docs } = await loadStore(flat);
  const byId = new Map();
  for (const [id, ref] of docs) byId.set(id, { ...ref, documentId: id, text: citableText(await readStoreText(store, id)) });
  const docsOf = matterId => [...byId.values()].filter(d => d.matterId === matterId).sort((a, b) => a.round - b.round || Number(a.email) - Number(b.email) || a.documentId - b.documentId);
  return { byId, counterparty: flat.counterparty, docsOf };
}

/**
 * Open the store and prepare the agentic review. `scenario` is a scenario object (11.4) or null with `item`
 * ({ document, side }) for the empty-record store; `document` is the current document. `listen`: start the product's
 * tools listener (the Claude CLI needs it). Returns { agentic, store, docs, currentId, scope, close }.
 */
export async function openReviewStore({ scenario = null, item = null, document = null, listen = false, maxToolCalls = DEFAULT_MAX_TOOL_CALLS } = {}) {
  if (!document) throw Error('openReviewStore needs the current document');
  const flat = scenario ? scenarioStoreSeed(scenario, document) : emptyStoreSeed(item, document);
  const { store, docs, currentId } = await loadStore(flat);
  let listener = null;
  try {
    if (listen) { const { startToolsListener } = await import('../../contract-review/server/tools-listener.js'); listener = await startToolsListener({ getStore: () => store }); }
    const agentic = await prepareAgenticReview(store, { documentId: currentId, listener, maxToolCalls });
    return { agentic, store, docs, currentId, scope: agentic.tools.scope, close: async () => { if (listener) await listener.close(); } };
  } catch (e) { if (listener) await listener.close(); throw e; }
}
