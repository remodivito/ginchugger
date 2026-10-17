// SPDX-License-Identifier: GPL-3.0-or-later
// P1: the two clean documents of layer A v2.
//   v2/base-nda.json  Common Paper Mutual NDA Version 1.0 (CC BY 4.0), imported from the publisher's own Cover Page and
//                     Standard Terms .docx through the product's importer (contract-review/server/docx.js, as build.mjs
//                     does for the CSA). The Standard Terms are taken verbatim with the published section numbers written
//                     into the text; the Cover Page is replaced by filled cover terms written for this suite (fictional
//                     parties, .example domains), one term per paragraph, as the CSA's Key Terms are.
//   v2/base-csa.json  the CSA bundle (agreement, DPA, SLA), the same paragraphs as base-bundle.json (5.2).
// Both are in the product's document shape (id, revision, title, paragraphs) plus the top-level canary, nothing else,
// because the review path sends the whole document object to the model. Provenance (file, sha256, licence, URL, date,
// and the first paragraph of the published standard terms, so the memorisation probe (P11) can draw from standard
// terms only) goes to v2/documents.json beside them.
// Usage: node tough-eval/v2/import-documents.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importDocx } from '../../contract-review/server/docx.js';
import { EVAL, sha256, writeJson, readJson } from './lib/common.mjs';

export const NDA_SOURCE = 'sources/common-paper-mutual-nda-v1.0.docx';
// Cover terms written for this suite. Party 1 is the party that expects mainly to disclose (its designs, roadmap and
// pricing); Party 2 mainly receives. Values sit where the published Cover Page has its brackets; the Term of
// Confidentiality takes the most common fixed period on Common Paper's annotated page (2 years).
export const COVER = [
  'Mutual Non-Disclosure Agreement',
  'Cover Page between Corvel Robotics, Inc. ("Party 1") and Ashgrove Logistics LLC ("Party 2").',
  // The published Cover Page's own opening sentence, verbatim.
  null,
  'Purpose: Evaluating whether to enter into a business relationship with the other party, namely whether Party 2 will buy autonomous warehouse robots and fleet-management software from Party 1, for which Party 1 will share product designs, its product roadmap, pricing and security documentation, and Party 2 will share information about its warehouse sites.',
  'Effective Date: 1 September 2026.',
  'MNDA Term: Expires 1 year from the Effective Date.',
  'Term of Confidentiality: 2 years from the Effective Date, but in the case of trade secrets, until Confidential Information is no longer considered a trade secret under applicable laws.',
  'Governing Law: Delaware.',
  'Jurisdiction: New Castle County, Delaware.',
  'Changes to Standard Terms: None.',
  'Notice Address: For Party 1: legal@corvel.example. For Party 2: contracts@ashgrove.example.',
  // The published Cover Page's closing sentence, verbatim.
  null,
  'Standard Terms',
];

export async function buildNda() {
  const bytes = readFileSync(path.join(EVAL, NDA_SOURCE));
  const imported = await importDocx(bytes, path.basename(NDA_SOURCE));
  const texts = imported.paragraphs.map(p => p.text.trim());
  const opening = texts.find(t => t.startsWith('This Mutual Non-Disclosure Agreement (the “MNDA”) consists of'));
  const closing = texts.find(t => t.startsWith('Neither party has changed the Standard Terms'));
  const start = texts.findIndex(t => t.startsWith('Introduction. This Mutual Non-Disclosure Agreement'));
  if (!opening || !closing || start < 0) throw Error('the .docx does not have the expected Cover Page and Standard Terms');
  const standard = texts.slice(start).filter(Boolean);
  const HEADINGS = ['Introduction', 'Use and Protection of Confidential Information', 'Exceptions', 'Disclosures Required by Law', 'Term and Termination', 'Return or Destruction of Confidential Information', 'Proprietary Rights', 'Disclaimer', 'Governing Law and Jurisdiction', 'Equitable Relief', 'General'];
  if (standard.length !== HEADINGS.length) throw Error(`expected ${HEADINGS.length} sections of Standard Terms, found ${standard.length}`);
  standard.forEach((t, i) => { if (!t.startsWith(HEADINGS[i] + '.')) throw Error(`section ${i + 1} should start "${HEADINGS[i]}."`); });
  let fill = [opening, closing];
  const cover = COVER.map(t => (t === null ? fill.shift() : t));
  const texts2 = [...cover, ...standard.map((t, i) => `${i + 1}. ${t}`)];
  return {
    id: 'v2-nda-base', revision: 1, title: 'Mutual Non-Disclosure Agreement — Corvel Robotics / Ashgrove Logistics',
    _source: { file: NDA_SOURCE, sourceSha256: sha256(bytes), title: 'Common Paper Mutual Non-Disclosure Agreement, Version 1.0 (Cover Page and Standard Terms)', url: 'https://commonpaper.com/standards/mutual-nda/1.0', downloadedFrom: 'https://commonpaper.com/standards/mutual-nda/1.0/mutual-nda-cover-page-and-standard-terms-docx', retrieved: '2026-10-15', licence: 'CC BY 4.0, Common Paper, Inc. (https://creativecommons.org/licenses/by/4.0/)', standardTermsFrom: `p${cover.length + 1}`, coverWrittenForSuite: true },
    paragraphs: texts2.map((text, i) => ({ id: `p${i + 1}`, text })),
  };
}

export function buildCsa() {
  const bundle = readJson('base-bundle.json');
  return { id: 'v2-csa-base', revision: 1, title: bundle.title,
    _source: { file: 'base-bundle.json', sourceSha256: sha256(readFileSync(path.join(EVAL, 'base-bundle.json'))), title: 'Common Paper Cloud Service Agreement v2.1, DPA v1.1 and SLA v2.0 standard terms with Key Terms written for this suite (build.mjs, build-bundle.mjs)', licence: 'CC BY 4.0, Common Paper, Inc.', standardTermsFrom: bundle.paragraphs.find(p => p.text.startsWith('1. Service'))?.id ?? null, coverWrittenForSuite: true, annexes: { dpa: 'a1', sla: 'a89' } },
    paragraphs: bundle.paragraphs };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const nda = await buildNda(), csa = buildCsa();
  const split = ({ _source, ...doc }) => [doc, _source];
  const [ndaDoc, ndaSrc] = split(nda), [csaDoc, csaSrc] = split(csa);
  const a = writeJson('v2/base-nda.json', ndaDoc), b = writeJson('v2/base-csa.json', csaDoc);
  writeJson('v2/documents.json', { format: 'tough-eval-documents/1', documents: { nda: { base: 'v2/base-nda.json', baseSha256: a.sha256, paragraphs: ndaDoc.paragraphs.length, ...ndaSrc }, csa: { base: 'v2/base-csa.json', baseSha256: b.sha256, paragraphs: csaDoc.paragraphs.length, ...csaSrc } } });
  console.log(`base-nda.json ${nda.paragraphs.length} paragraphs (${a.sha256.slice(0, 12)}); base-csa.json ${csa.paragraphs.length} paragraphs (${b.sha256.slice(0, 12)})`);
}
