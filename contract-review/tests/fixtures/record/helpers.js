// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the tests: a temporary data folder, a minimal .docx, and a record with the shipped playbooks.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openLocalRecord } from '../../../server/record/local.js';
import { importPlaybooks } from '../../../server/record/legacy.js';

export const tempDir = (prefix = 'gcl-') => mkdtempSync(path.join(tmpdir(), prefix));

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A .docx with one paragraph per entry; an entry { text, was } is a tracked change from `was` to `text`. `stamp` varies the bytes, as Word does on every read. */
export async function docx(paragraphs, { stamp = '' } = {}) {
  const zip = new JSZip();
  const body = paragraphs.map(p => typeof p === 'string' ? `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`
    : `<w:p><w:del w:id="1" w:author="Them"><w:r><w:delText xml:space="preserve">${esc(p.was)}</w:delText></w:r></w:del><w:ins w:id="2" w:author="Them"><w:r><w:t xml:space="preserve">${esc(p.text)}</w:t></w:r></w:ins></w:p>`).join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`);
  if (stamp) zip.file('docProps/custom.xml', `<x>${esc(stamp)}</x>`);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** A fresh record in a temp folder with the shipped playbooks (nda, order-form) loaded, and a clock that ticks. */
export async function freshRecord({ dataDir = tempDir(), start = Date.parse('2026-01-01T00:00:00Z') } = {}) {
  let t = start;
  const now = () => new Date(t += 1000).toISOString();
  const record = openLocalRecord({ dataDir, now });
  await importPlaybooks(record, tempDir('empty-state-'));
  return { record, dataDir, now };
}
