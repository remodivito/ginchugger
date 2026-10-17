// SPDX-License-Identifier: GPL-3.0-or-later
// Shared pieces of the v2 authoring pipeline (BENCHMARK-V2.md P4 to P10): where things live, the documents and playbooks
// per side, the canary, hashing, writing JSON with the canary at the top, and reading a JSON answer out of a model's raw
// output (which may carry reasoning, <think> blocks, code fences or a wrapper object around the array).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canaryGuid, stripCanary } from '../canary.mjs';

export const V2 = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // tough-eval/v2
export const EVAL = path.dirname(V2);                                            // tough-eval
export const ROOT = path.dirname(EVAL);                                          // outputs
export const sha256 = s => createHash('sha256').update(s).digest('hex');
export const AUTHORS = ['opus', 'glm', 'deepseek'];
export const FAMILY_OF = { opus: 'anthropic', glm: 'zhipu', deepseek: 'deepseek' };

/** The four document-side pairs (BENCHMARK-V2.md 5.2). Paths are relative to tough-eval/. */
export const SIDES = {
  'csa-customer': { document: 'csa', side: 'customer', base: 'v2/base-csa.json', playbook: 'playbook-bundle.json', label: 'CSA, reviewed for the Customer (Northwind Analytics Ltd), who buys the service' },
  'csa-vendor': { document: 'csa', side: 'vendor', base: 'v2/base-csa.json', playbook: 'playbook-vendor.json', label: 'CSA, reviewed for the Provider (Halden Cloud, Inc.), who sells the service' },
  'nda-discloser': { document: 'nda', side: 'discloser', base: 'v2/base-nda.json', playbook: 'v2/playbook-nda-discloser.json', label: 'Mutual NDA, reviewed for the party that expects mainly to disclose Confidential Information (Corvel Robotics, Inc.)' },
  'nda-recipient': { document: 'nda', side: 'recipient', base: 'v2/base-nda.json', playbook: 'v2/playbook-nda-recipient.json', label: 'Mutual NDA, reviewed for the party that expects mainly to receive Confidential Information (Ashgrove Logistics LLC)' },
};
export const sideKey = (document, side) => { const k = `${document}-${side}`; if (!SIDES[k]) throw Error(`unknown document-side ${k}; known: ${Object.keys(SIDES).join(', ')}`); return k; };

export const readJson = file => JSON.parse(readFileSync(path.isAbsolute(file) ? file : path.join(EVAL, file), 'utf8'));
export const readText = file => readFileSync(path.isAbsolute(file) ? file : path.join(EVAL, file), 'utf8');
/** The canary GUID (v2/CANARY.md); every JSON file written under v2/ carries it at the top level. */
export function canary() { const g = canaryGuid(); if (!g) throw Error('v2/CANARY.md holds no GUID'); return g; }
/** Write JSON with `canary` as the first key (11: "every JSON file under v2/ carries the canary at the top level"). */
export function writeJson(file, obj, { stamp = true } = {}) {
  const abs = path.isAbsolute(file) ? file : path.join(EVAL, file); mkdirSync(path.dirname(abs), { recursive: true });
  const body = stamp && obj && typeof obj === 'object' && !Array.isArray(obj) ? { canary: canary(), ...stripCanary(obj) } : obj;
  const text = JSON.stringify(body, null, 1) + '\n'; writeFileSync(abs, text); return { file: abs, sha256: sha256(text) };
}
export const exists = file => existsSync(path.isAbsolute(file) ? file : path.join(EVAL, file));

/** The clean document and the playbook for a side, as the reviewer (and the author) sees them: canary removed. */
export function loadSide(key) {
  const s = SIDES[key]; if (!s) throw Error(`unknown side ${key}`);
  const doc = stripCanary(readJson(s.base)), playbook = stripCanary(readJson(s.playbook));
  return { key, ...s, doc, playbook, ruleIds: new Set(playbook.rules.map(r => r.id)), paragraphs: new Map(doc.paragraphs.map(p => [p.id, p.text])) };
}

/** A section of a markdown file, from a heading line matching `from` up to (not including) the next heading of the same
 *  or higher level, or up to a heading matching `until`. Used to cut the authoring spec into what authors receive. */
export function mdSection(md, from, until = null) {
  const lines = md.split('\n'); const start = lines.findIndex(l => /^#+ /.test(l) && from.test(l)); if (start < 0) throw Error(`section ${from} not found`);
  const level = lines[start].match(/^#+/)[0].length; let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { const m = lines[i].match(/^(#+) /); if (!m) continue; if (until ? until.test(lines[i]) : m[1].length <= level) { end = i; break; } }
  return lines.slice(start, end).join('\n').trim();
}

// ---- reading a JSON answer out of raw model output --------------------------------------------------------------------
/** Strip what reasoning models put around an answer: <think>…</think> blocks (closed, or open with no close when the
 *  answer follows a lone </think>), and markdown code fences. */
export function stripReasoning(raw) {
  let t = String(raw ?? '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = t.lastIndexOf('</think>'); if (close >= 0) t = t.slice(close + '</think>'.length);
  return t;
}
/** Every balanced top-level JSON value (object or array) in the text, in order, that parses. Strings are respected. */
export function jsonCandidates(text) {
  const s = String(text); const out = [];
  for (let i = 0; i < s.length; i++) {
    const open = s[i]; if (open !== '[' && open !== '{') continue;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '[' || ch === '{') depth++; else if (ch === ']' || ch === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    try { out.push({ value: JSON.parse(s.slice(i, j + 1)), start: i, end: j + 1 }); i = j; } catch { /* not JSON from here; keep scanning */ }
  }
  return out;
}
/**
 * The array of objects a batch answer holds. Accepts: a bare array; an array inside fences or after reasoning; an object
 * wrapping one array of objects (`{"items": [...]}`), which a JSON-object mode produces. When several arrays parse, the
 * last array of objects wins (reasoning often drafts an array before the final one). Throws with a reason otherwise.
 */
export function parseArrayAnswer(raw, { expectKey = null } = {}) {
  const body = stripReasoning(raw); const cands = jsonCandidates(body);
  const arrays = [];
  for (const c of cands) {
    if (Array.isArray(c.value) && c.value.length && c.value.every(x => x && typeof x === 'object' && !Array.isArray(x))) arrays.push(c.value);
    else if (c.value && typeof c.value === 'object' && !Array.isArray(c.value)) {
      const inner = expectKey && Array.isArray(c.value[expectKey]) ? [c.value[expectKey]] : Object.values(c.value).filter(v => Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object'));
      if (inner.length === 1) arrays.push(inner[0]);
      else if (!arrays.length && looksLikeItem(c.value)) arrays.push([c.value]);
    }
  }
  if (!arrays.length) throw Error(cands.length ? 'The answer holds JSON but no array of objects.' : (String(raw || '').trim() ? 'The answer holds no parseable JSON.' : 'The answer is empty.'));
  return arrays[arrays.length - 1];
}
const looksLikeItem = o => 'kind' in o && 'edits' in o;
/** One JSON object out of raw output (the last top-level object that parses), for single-object answers. */
export function parseObjectAnswer(raw) {
  const cands = jsonCandidates(stripReasoning(raw)).filter(c => c.value && typeof c.value === 'object' && !Array.isArray(c.value));
  if (!cands.length) throw Error(String(raw || '').trim() ? 'The answer holds no JSON object.' : 'The answer is empty.');
  return cands[cands.length - 1].value;
}

// ---- deterministic order ------------------------------------------------------------------------------------------------
/** Order a list by sha256(prefix + key), lowest first: the "by hash" rule used for draws and shuffles. */
export const byHash = (xs, prefix, key = x => x.id) => [...xs].sort((a, b) => { const ha = sha256(prefix + key(a)), hb = sha256(prefix + key(b)); return ha < hb ? -1 : ha > hb ? 1 : 0; });
