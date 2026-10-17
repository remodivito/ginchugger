// SPDX-License-Identifier: GPL-3.0-or-later
// Replay a recorded demo review (data/recorded-runs/demo-fixture) with the `history` payload it was recorded with. The
// recordings were made when the record held matters and rounds (before decision 190); the record and its history
// builder are gone, so this helper rebuilds the same history items straight from the fixture files: each earlier round
// "<matter>/<n>" and covering email "<matter>/<n>/covering", text as the record's builder made it (tracked text
// annotated; emails with From, Date and Subject). The single-call review then runs on the replay executor, no tools.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REC = fileURLToPath(new URL('../../../data/recorded-runs/demo-fixture/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../data/fixtures/', import.meta.url));
const replay = { executor: 'replay', model: null, effort: null, replayDir: REC, traceDir: null, toolsSupported: false };

/** The demo sets as the record loaded them (server/record/demo.js before decision 190). */
export const DEMO_SETS = {
  history: {
    dir: 'history', matter: 'Helix / Brightwater NDA (demo fixture)', incoming: 4,
    rounds: [
      { n: 1, side: 'ours', file: 'helix-brightwater-nda-v1.docx', receivedAt: '2026-05-04T09:00:00.000Z' },
      { n: 2, side: 'theirs', file: 'helix-brightwater-nda-v2-bw-markup.docx', covering: '2026-05-19-brightwater-returns-markup.eml', respondsTo: 1, receivedAt: '2026-05-19T09:52:11.000Z' },
      { n: 3, side: 'theirs', file: '2026-05-20-brightwater-comment-on-term.eml', respondsTo: 1, receivedAt: '2026-05-20T14:03:40.000Z' },
      { n: 4, side: 'ours', file: 'helix-brightwater-nda-v3-helix-counter.docx', respondsTo: 2, receivedAt: '2026-05-22T16:21:05.000Z' },
    ],
  },
  'order-form': {
    dir: 'order-form', matter: 'Helix / Northgate order form (demo fixture)', incoming: 2,
    rounds: [
      { n: 1, side: 'ours', file: 'helix-northgate-order-form-v1.docx', receivedAt: '2026-06-01T09:00:00.000Z' },
      { n: 2, side: 'theirs', file: 'helix-northgate-order-form-v2-customer-markup.docx', covering: '2026-06-04-northgate-returns-order-form.eml', respondsTo: 1, receivedAt: '2026-06-04T10:00:00.000Z' },
    ],
  },
};

const iso = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.valueOf()) ? d.toISOString() : null; };
const bound = text => (text.length > 8000 ? text.slice(0, 8000) + '\n[… truncated]' : text);
const docText = paragraphs => (paragraphs || []).slice(0, 40).map(p => (typeof p.originalText === 'string' && p.originalText !== p.text ? `${p.text}  [tracked; before: ${p.originalText}]` : p.text)).filter(Boolean).join('\n');
const mailText = m => [m.from ? `From: ${m.from}` : null, m.date ? `Date: ${m.date}` : null, m.subject ? `Subject: ${m.subject}` : null].filter(Boolean).join('\n') + `\n\n${m.text || ''}`;

/** Review the document a demo set opens on, against its earlier round, with the history the recording was made with. */
export async function replayDemo(set, { round = null, playbookFile = 'playbook.json' } = {}) {
  const { reviewDocument } = await import('../../../server/review.js');
  const { importDocx } = await import('../../../server/docx.js');
  const { extractText, parseEml, MEDIA } = await import('../../../server/record/files.js');
  const s = DEMO_SETS[set]; const matterId = 'demo';
  const read = f => readFileSync(path.join(FIXTURES, s.dir, f));
  const n = round ?? s.incoming; const own = s.rounds.find(r => r.n === n);
  const document = await importDocx(read(own.file), own.file);
  const base = await importDocx(read(s.rounds.find(r => r.n === own.respondsTo).file), 'base.docx');
  const history = [];
  for (const r of s.rounds) {
    const label = `${s.matter}, round ${r.n} (${r.side})`;
    if (r.n !== n && r.n !== own.respondsTo) {
      const email = r.file.endsWith('.eml');
      const t = await extractText(read(r.file), email ? MEDIA['.eml'] : MEDIA['.docx'], r.file);
      const text = email ? mailText({ ...parseEml(read(r.file)), text: t.paragraphs.map(p => p.text).join('\n') }) : docText(t.paragraphs);
      history.push({ itemId: `${matterId}/${r.n}`, filename: label, kind: email ? 'eml' : 'docx', date: iso(r.receivedAt), text: bound(text) });
    }
    if (r.covering) {
      const t = await extractText(read(r.covering), MEDIA['.eml'], r.covering); const h = t.warnings[0] || {};
      history.push({ itemId: `${matterId}/${r.n}/covering`, filename: `${label}, covering email`, kind: 'eml', date: iso(h.date) || iso(r.receivedAt), text: bound(mailText({ ...h, text: t.text })) });
    }
  }
  history.sort((a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : a.itemId < b.itemId ? -1 : 1);
  const playbook = JSON.parse(readFileSync(new URL(`../../../data/${playbookFile}`, import.meta.url), 'utf8'));
  const r = await reviewDocument({ document, baseline: { id: `${matterId}/${own.respondsTo}`, title: `Round ${own.respondsTo}`, paragraphs: base.paragraphs, imported: true }, playbook, reviewMode: 'own-paper', history, config: replay });
  return { demo: { matterId, incoming: { round: s.incoming } }, history, review: r };
}
