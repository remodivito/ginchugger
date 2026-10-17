// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the starter history fixture (spec R8.7; T16): three versions of one NDA, one explanatory comment, one
// unrelated similarly named NDA on the same form, two cover emails, and hand-written truth. Text is the public
// Common Paper Mutual NDA Standard Terms v1.0 (CC BY 4.0) with fictional cover fields and controlled changes.
// Deterministic: fixed dates and authors, so rebuilding yields byte-identical files. Run: node scripts/build-history-fixture.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { exportDocx } from '../server/docx.js';

const OUT = new URL('../data/fixtures/history/', import.meta.url); mkdirSync(OUT, { recursive: true });
const source = JSON.parse(readFileSync(new URL('../data/source-common-paper-nda-v1.json', import.meta.url), 'utf8'));
const terms = source.paragraphs.map(p => typeof p === 'string' ? p : p.text);

function cover(counterparty, { term = 'three (3) years', effective = '4 May 2026', law = 'England and Wales' } = {}) {
  return [
    `Mutual Non-Disclosure Agreement — Cover Page`,
    `Parties: Helix Instruments Ltd (company number 09811234, 14 Fenchurch Avenue, London EC3M 5AD) and ${counterparty}.`,
    `Purpose: evaluating a potential commercial relationship concerning laboratory data analytics.`,
    `Effective Date: ${effective}. MNDA Term: one (1) year from the Effective Date.`,
    `Confidentiality Period: ${term} from the date of disclosure, except that obligations in respect of trade secrets continue for so long as the information remains a trade secret.`,
    `Governing Law: ${law}. Jurisdiction: the courts of ${law === 'England and Wales' ? 'England and Wales' : law}.`,
    `Standard Terms: the Common Paper Mutual NDA Standard Terms v1.0 below form part of this MNDA.`,
  ];
}
const BRIGHTWATER = 'Brightwater Analytics Ltd (company number 11230987, Unit 4, Cambridge Science Park, Cambridge CB4 0WS)';
const OAKFIELD = 'Oakfield Diagnostics Ltd (company number 10455621, 2 Lyle Way, Manchester M15 4GB)';

const v1 = [...cover(BRIGHTWATER), ...terms];
// Round 2: Brightwater's markup of v1 (tracked). Three changes: period 3 → 7 years; retention right added to return/destroy; a residuals sentence added to IP.
const v2 = v1.map(t => ({ text: t, originalText: t }));
v2[4] = { originalText: v1[4], text: v1[4].replace('three (3) years', 'seven (7) years') };
const idxReturn = 7 + 5, idxIp = 7 + 6;
v2[idxReturn] = { originalText: v1[idxReturn], text: v1[idxReturn] + ' Notwithstanding the foregoing, the Receiving Party may retain copies of Confidential Information in its routine backup systems and as required by its internal compliance policies, provided such copies remain subject to this MNDA.' };
v2[idxIp] = { originalText: v1[idxIp], text: v1[idxIp] + ' Nothing in this MNDA restricts either party from using general knowledge, skills and experience retained in the unaided memory of its personnel (Residuals).' };
// Round 3: Helix's counter-turn against v2 as accepted (tracked): 7 → 5 years; residuals narrowed; retention accepted as is.
const v2accepted = v2.map(p => p.text);
const v3 = v2accepted.map(t => ({ text: t, originalText: t }));
v3[4] = { originalText: v2accepted[4], text: v2accepted[4].replace('seven (7) years', 'five (5) years') };
v3[idxIp] = { originalText: v2accepted[idxIp], text: v2accepted[idxIp].replace('(Residuals).', '(Residuals), provided that this does not apply to trade secrets or to information the Disclosing Party has marked as restricted, and grants no licence under any patent or copyright.') };
// Unrelated: the same form sent to Oakfield, clean, same month, similar filename.
const oak = [...cover(OAKFIELD, { effective: '11 May 2026' })];
for (const t of terms) oak.push(t);

async function docx(name, paragraphs, { author = null, date = '2026-05-19T10:12:00Z' } = {}) {
  const buffer = await exportDocx({ id: name, title: name, revision: 0, paragraphs: paragraphs.map((p, i) => ({ id: `p${i + 1}`, ...(typeof p === 'string' ? { text: p } : p) })) }, null);
  const zip = await JSZip.loadAsync(buffer);
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace(/w:author="[^"]*" w:date="[^"]+"/g, `w:author="${author || 'Helix Legal'}" w:date="${date}"`);
  zip.file('word/document.xml', xml);
  for (const entry of Object.values(zip.files)) entry.date = new Date('2026-05-19T00:00:00Z'); // zip timestamps fixed so rebuilds are byte-identical
  const out = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }));
  writeFileSync(new URL(name, OUT), out); return out;
}
function eml(name, { from, to, date, subject, messageId, inReplyTo = null, body }) {
  const text = [`From: ${from}`, `To: ${to}`, `Date: ${date}`, `Subject: ${subject}`, `Message-ID: ${messageId}`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body.trim(), ''].join('\r\n');
  writeFileSync(new URL(name, OUT), text); return Buffer.from(text);
}

const files = {};
files['helix-brightwater-nda-v1.docx'] = await docx('helix-brightwater-nda-v1.docx', v1);
files['helix-brightwater-nda-v2-bw-markup.docx'] = await docx('helix-brightwater-nda-v2-bw-markup.docx', v2, { author: 'Nkechi Okafor (Brightwater)', date: '2026-05-19T09:40:00Z' });
files['helix-brightwater-nda-v3-helix-counter.docx'] = await docx('helix-brightwater-nda-v3-helix-counter.docx', v3, { author: 'Priya Raman (Helix Legal)', date: '2026-05-22T16:05:00Z' });
files['helix-oakfield-nda-v1.docx'] = await docx('helix-oakfield-nda-v1.docx', oak);
files['2026-05-19-brightwater-returns-markup.eml'] = eml('2026-05-19-brightwater-returns-markup.eml', { from: 'Nkechi Okafor <n.okafor@brightwater-analytics.example>', to: 'Priya Raman <p.raman@helix-instruments.example>', date: 'Tue, 19 May 2026 10:52:11 +0100', subject: 'Helix / Brightwater NDA — our markup', messageId: '<bw-2026-05-19-0931@brightwater-analytics.example>', body: `
Priya,

Please find attached our markup of the NDA you sent on 4 May (helix-brightwater-nda-v2-bw-markup.docx). Three points, all in track changes:

1. Confidentiality period extended to seven years. Our data sets include clinical-adjacent records held under retention schedules of that length, so a three-year period would leave material unprotected while we are still obliged to hold it.
2. A retention carve-out for backups and compliance copies, since we cannot purge immutable backup media on request.
3. A residuals sentence so that our analysts are not treated as in breach for what they remember.

Happy to discuss any of these on a call.

Kind regards,
Nkechi Okafor
Senior Legal Counsel, Brightwater Analytics Ltd
` });
files['2026-05-20-brightwater-comment-on-term.eml'] = eml('2026-05-20-brightwater-comment-on-term.eml', { from: 'Nkechi Okafor <n.okafor@brightwater-analytics.example>', to: 'Priya Raman <p.raman@helix-instruments.example>', date: 'Wed, 20 May 2026 15:03:40 +0100', subject: 'Re: Helix / Brightwater NDA — our markup', messageId: '<bw-2026-05-20-1503@brightwater-analytics.example>', inReplyTo: '<bw-2026-05-19-0931@brightwater-analytics.example>', body: `
Priya,

Following our call: on the seven-year point, we could live with five years if the trade-secret tail stays as drafted. Seven was our opening position, not a requirement. The retention carve-out is the one we cannot move on because of the backup media.

Nkechi
` });
files['2026-05-22-helix-sends-counter-turn.eml'] = eml('2026-05-22-helix-sends-counter-turn.eml', { from: 'Priya Raman <p.raman@helix-instruments.example>', to: 'Nkechi Okafor <n.okafor@brightwater-analytics.example>', date: 'Fri, 22 May 2026 17:21:05 +0100', subject: 'Re: Helix / Brightwater NDA — our markup', messageId: '<hx-2026-05-22-1721@helix-instruments.example>', inReplyTo: '<bw-2026-05-20-1503@brightwater-analytics.example>', body: `
Nkechi,

Attached is our counter-turn (helix-brightwater-nda-v3-helix-counter.docx), tracked against your markup. We have accepted the retention carve-out, moved the confidentiality period to five years as discussed, and kept the residuals sentence with a carve-out for trade secrets and marked information and a no-licence clarification.

If this works for you we can go to signature next week.

Best,
Priya Raman
Legal Counsel, Helix Instruments Ltd
` });

const sha = b => createHash('sha256').update(b).digest('hex');
const truth = {
  description: 'Hand-written ground truth for the starter history fixture. Item keys are filenames.',
  matters: {
    'helix-brightwater-nda': { parties: ['Helix Instruments Ltd', 'Brightwater Analytics Ltd'], items: ['helix-brightwater-nda-v1.docx', 'helix-brightwater-nda-v2-bw-markup.docx', 'helix-brightwater-nda-v3-helix-counter.docx', '2026-05-19-brightwater-returns-markup.eml', '2026-05-20-brightwater-comment-on-term.eml', '2026-05-22-helix-sends-counter-turn.eml'] },
    'helix-oakfield-nda': { parties: ['Helix Instruments Ltd', 'Oakfield Diagnostics Ltd'], items: ['helix-oakfield-nda-v1.docx'] },
  },
  order: ['helix-brightwater-nda-v1.docx', 'helix-brightwater-nda-v2-bw-markup.docx', 'helix-brightwater-nda-v3-helix-counter.docx'],
  lineage: [{ earlier: 'helix-brightwater-nda-v1.docx', later: 'helix-brightwater-nda-v2-bw-markup.docx', relation: 'later is a markup of earlier' }, { earlier: 'helix-brightwater-nda-v2-bw-markup.docx', later: 'helix-brightwater-nda-v3-helix-counter.docx', relation: 'later is a markup of earlier (against the accepted text)' }],
  baselineOf: { 'helix-brightwater-nda-v2-bw-markup.docx': 'helix-brightwater-nda-v1.docx', 'helix-brightwater-nda-v3-helix-counter.docx': 'helix-brightwater-nda-v2-bw-markup.docx' },
  emailLinks: [{ email: '2026-05-19-brightwater-returns-markup.eml', document: 'helix-brightwater-nda-v2-bw-markup.docx', relation: 'carries' }, { email: '2026-05-20-brightwater-comment-on-term.eml', document: 'helix-brightwater-nda-v2-bw-markup.docx', relation: 'comments on' }, { email: '2026-05-22-helix-sends-counter-turn.eml', document: 'helix-brightwater-nda-v3-helix-counter.docx', relation: 'carries' }],
  trap: { 'helix-oakfield-nda-v1.docx': 'same form, same month, similar filename, different counterparty; must not join the Brightwater matter' },
  priorRoundComment: { clause: 'Confidentiality Period (cover paragraph 5)', document: '2026-05-20-brightwater-comment-on-term.eml', quote: 'we could live with five years if the trade-secret tail stays as drafted' },
  changes: { v2: ['Confidentiality Period three (3) → seven (7) years', 'retention carve-out appended to return/destroy', 'residuals sentence appended to IP clause'], v3: ['seven (7) → five (5) years', 'residuals narrowed: trade secrets, marked information, no licence', 'retention carve-out accepted unchanged'] },
  sha256: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
};
writeFileSync(new URL('truth.json', OUT), JSON.stringify(truth, null, 2) + '\n');
console.log(Object.entries(truth.sha256).map(([k, v]) => `${v.slice(0, 12)}  ${k}`).join('\n'));
