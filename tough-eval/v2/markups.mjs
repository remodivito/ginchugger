// SPDX-License-Identifier: GPL-3.0-or-later
// P9: markups by hash. For each author, document and side: the author's verified deviations ordered by
// sha256("v2-markup:" + author + document + side + id), lowest first. The benign edits are tried in that order; for
// each, the deviations are taken in that order while no paragraph overlaps (an insertion counts as touching its anchor
// paragraph; the benign edit's paragraphs count too), up to five; the first benign edit that leaves four or more is
// used. A markup needs at least four deviations and one benign edit; a side short of
// that gets no markup and is listed. Writes <root>/markups.json and rebuilds the variants and manifest (M-<author>-<document>-<side>).
// Usage: node tough-eval/v2/markups.mjs [--root v2]
import path from 'node:path';
import { SIDES, AUTHORS, sha256, writeJson } from './lib/common.mjs';
import { touched } from './lib/items.mjs';
import { rootAbs, loadItems, rebuild, withStoreLock } from './lib/store.mjs';
import { args } from './author.mjs';

export const markupHash = (author, document, side, id) => sha256('v2-markup:' + author + document + side + id);

/** The markup for one author, document and side from a list of items, or { short } with the reason. Pure. */
export function drawMarkup(items, author, document, side) {
  const mine = items.filter(i => i.author === author && i.document === document && i.side === side && i.status === 'verified');
  const order = xs => xs.map(i => ({ i, h: markupHash(author, document, side, i.id) })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  // Benign edits in hash order; for each, deviations in hash order taken greedily while no paragraph overlaps (the
  // benign edit's included), up to five; the first benign edit that leaves at least four deviations is the markup's.
  const devs = order(mine.filter(i => i.kind === 'deviation'));
  let chosen = [], benign = null;
  for (const b of order(mine.filter(i => i.kind === 'benign'))) {
    const used = new Set(touched(b.i)), pick = [];
    for (const { i, h } of devs) { if (pick.length >= 5) break; const t = touched(i); if (t.some(p => used.has(p))) continue; t.forEach(p => used.add(p)); pick.push({ id: i.id, hash: h }); }
    if (pick.length >= 4) { chosen = pick; benign = b; break; }
    if (pick.length > chosen.length) chosen = pick;
  }
  const id = `M-${author}-${document}-${side}`;
  if (chosen.length < 4 || !benign) return { id, short: `${chosen.length} non-overlapping verified deviations and ${benign ? 1 : 0} benign edit (need 4 and 1)` };
  return { id, author, document, side, items: [...chosen.map(c => c.id), benign.i.id], draw: [...chosen, { id: benign.i.id, hash: benign.h }] };
}

export function buildMarkups(root = 'v2') { return withStoreLock(root, () => buildMarkupsLocked(root)); }
function buildMarkupsLocked(root) {
  const items = loadItems(root).items; const markups = [], short = [];
  for (const author of AUTHORS) for (const s of Object.values(SIDES)) { const m = drawMarkup(items, author, s.document, s.side); if (m.short) { if (items.some(i => i.author === author && i.document === s.document && i.side === s.side)) short.push(m); } else markups.push(m); }
  writeJson(path.join(rootAbs(root), 'markups.json'), { format: 'tough-eval-markups/1', builtAt: new Date().toISOString(), rule: 'sha256("v2-markup:" + author + document + side + id), lowest first; non-overlapping; 4-5 deviations and 1 benign', markups, short });
  rebuild(root);
  return { markups: markups.length, short };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) console.log(JSON.stringify(buildMarkups(args(process.argv.slice(2)).root || 'v2'), null, 1));
