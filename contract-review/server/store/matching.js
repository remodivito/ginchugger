// SPDX-License-Identifier: GPL-3.0-or-later
// Which counterparty a new document names, against the store's counterparties (Paperless's correspondents), by the
// ported Paperless-ngx matching (server/ports/paperless/matching.js): sender, then subject, then the document's text; the
// first source any counterparty matches decides, and two or more there suggest none. Our store's correspondents are
// created with Paperless's matching off (spike gap 9), so each is matched here by its name as a literal. Moved here from
// the record's inbox suggestions (server/record/suggest.js, removed with filing by decision 190). No model is asked.
import { matches, partialRatio, MATCH_NONE, MATCH_FUZZY, MATCH_LITERAL, PY_WORD, PY_SPACE } from '../ports/paperless/matching.js';

export const FIRST_PARAGRAPHS = 40;

/** Split a From header into a display name and an address. */
export function parseFrom(header) {
  const raw = typeof header === 'string' ? header.trim() : '';
  if (!raw) return null;
  const angle = /^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(raw);
  const address = (angle ? angle[2] : (/[^\s<>"]+@[^\s<>"]+/.exec(raw) || [''])[0]).toLowerCase();
  const name = (angle ? angle[1] : raw.replace(address, '')).replace(/^[\s"']+|[\s"']+$/g, '');
  return { raw, name, address, domain: address.includes('@') ? address.split('@').pop() : null };
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** A domain is ours when it is one of `internalDomains` (settings) or below one ("mail.firm.example" under "firm.example"). */
export const isInternalDomain = (domain, internalDomains = []) => !!domain && internalDomains.some(d => { const x = String(d || '').trim().toLowerCase().replace(/^@/, ''); const y = String(domain).toLowerCase(); return !!x && (y === x || y.endsWith(`.${x}`)); });

/**
 * The original sender of a forwarded email, read from the quoted header block in its body ("From: Jo <jo@acme.example>"
 * under "Forwarded message" or "Original Message", as Outlook, Gmail and Apple Mail write it). Null when there is none.
 * (Kept from the record's inbox suggestions, server/record/suggest.js, removed by decision 190.)
 */
export function forwardedFrom(text) {
  for (const line of String(text || '').split(/\r?\n/).slice(0, 400)) {
    const m = /^[>\s*]*(?:From|Von|De|Van|Da)\s*:\s*(.+?)\s*\**\s*$/i.exec(line);
    if (!m) continue;
    const from = parseFrom(m[1].replace(/\[mailto:([^\]]*)\]/i, '<$1>').replace(/^[*\s]+|[*\s]+$/g, ''));
    if (from?.address) return from;
  }
  return null;
}

/**
 * The sender matching should read for an email that reached the shared mailbox. Mail from outside: its From. Mail from
 * one of our own domains (`internalDomains`) is a colleague forwarding or dropping it in, so our colleague is not the
 * counterparty: the forwarded original sender when the body quotes one from outside, else no sender (matching then
 * reads the subject and the text). Without internalDomains every sender is read as before.
 */
export function senderForMatching(fromHeader, body, internalDomains = []) {
  const from = parseFrom(fromHeader);
  if (!from) return null;
  if (!isInternalDomain(from.domain, internalDomains)) return from.raw;
  const original = forwardedFrom(body);
  return original && !isInternalDomain(original.domain, internalDomains) ? original.raw : null;
}

/** The rules a counterparty is matched by: its own (an empty pattern means its name) and each alias as a literal. */
export function rulesFor(cp) {
  const algorithm = cp.matchAlgorithm || MATCH_LITERAL;
  if (algorithm === MATCH_NONE) return []; // Paperless's "none": never assigned automatically, aliases included
  const insensitive = cp.matchInsensitive !== false;
  return [
    { match: cp.matchPattern && cp.matchPattern.trim() ? cp.matchPattern : cp.name, matchingAlgorithm: algorithm, isInsensitive: insensitive },
    ...(cp.aliases || []).map(a => ({ match: a, matchingAlgorithm: MATCH_LITERAL, isInsensitive: insensitive })),
  ];
}

/** The fuzzy score Paperless compares with its cutoff of 90, for the "how" line. */
function fuzzyScore(rule, text) {
  const strip = new RegExp(`[^${PY_WORD}${PY_SPACE}]`, 'gu');
  let m = rule.match.replace(strip, ''); let t = text.replace(strip, '');
  if (rule.isInsensitive) { m = m.toLowerCase(); t = t.toLowerCase(); }
  return Math.floor(partialRatio(m, t, 90));
}

/**
 * Which counterparty the capture names. The sources are tried in order (sender, subject, document); the first source
 * any counterparty matches decides. Two or more there: no suggestion, and `how` names them so the member chooses.
 * Counterparties whose name is one of ours (settings.ourNames) are never suggested.
 */
export function suggestCounterparty(counterparties, { from = null, subject = null, paragraphs = [] } = {}, { ourNames = [] } = {}) {
  const candidates = counterparties.filter(cp => !ourNames.some(n => sameName(n, cp.name)));
  const sources = [
    ['the sender', from ? (typeof from === 'string' ? from : from.raw) : ''],
    ['the subject', subject || ''],
    ['the document', (paragraphs || []).slice(0, FIRST_PARAGRAPHS).map(p => (typeof p === 'string' ? p : p.text || '')).join('\n')],
  ];
  for (const [where, text] of sources) {
    if (!text.trim()) continue;
    const hits = [];
    for (const cp of candidates) {
      const rule = rulesFor(cp).find(r => matches(r, text));
      if (rule) hits.push({ cp, rule });
    }
    if (hits.length === 1) {
      const { cp, rule } = hits[0];
      const method = rule.matchingAlgorithm === MATCH_FUZZY ? `fuzzy ${fuzzyScore(rule, text)}` : rule.matchingAlgorithm;
      return { counterparty: { id: cp.id, name: cp.name, how: `matched '${rule.match}' (${method}) in ${where}` }, ambiguous: [] };
    }
    if (hits.length > 1) {
      const names = hits.map(h => h.cp.name).sort((a, b) => a.localeCompare(b));
      return { counterparty: null, ambiguous: hits.map(h => ({ id: h.cp.id, name: h.cp.name })).sort((a, b) => a.name.localeCompare(b.name)), how: `${names.length === 2 ? 'Two' : names.length} matches: ${names.join(', ')}` };
    }
  }
  return { counterparty: null, ambiguous: [], how: 'no counterparty matched' };
}


/** The store's counterparties as the matcher reads them. */
export async function matchableCounterparties(store) {
  const list = await store.taxonomy.counterparties.list();
  return list.map(c => ({ id: c.name, name: c.name, aliases: [], matchAlgorithm: 'literal', matchPattern: '', matchInsensitive: true }));
}

/**
 * The counterparty name matching suggests for a document, or null. `from` and `subject` come from its email (if any);
 * `paragraphs` are its text ([{ text }] or strings). `ourNames` (settings) are never suggested.
 */
export async function suggestStoreCounterparty(store, { from = null, subject = null, paragraphs = [] } = {}, { ourNames = [] } = {}) {
  const found = suggestCounterparty(await matchableCounterparties(store), { from, subject, paragraphs }, { ourNames });
  return found.counterparty?.name || null;
}
