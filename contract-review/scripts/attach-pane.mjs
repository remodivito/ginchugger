// SPDX-License-Identifier: GPL-3.0-or-later
// Attach the review pane to a .docx so Word opens the pane with the document (Microsoft's documented
// "automatically open a task pane with a document" parts: word/webextensions/*, a root relationship and two
// content-type overrides). For tests and the demo only: it writes a copy, never the original, and the attached
// part carries nothing but the add-in's id from public/manifest.xml.
//   node scripts/attach-pane.mjs <in.docx> <out.docx>
import { readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';

const [, , input, output] = process.argv;
if (!input || !output || input === output) { console.error('usage: node scripts/attach-pane.mjs <in.docx> <out.docx>'); process.exit(1); }
const manifest = readFileSync(new URL('../public/manifest.xml', import.meta.url), 'utf8');
const addinId = manifest.match(/<Id>([^<]+)<\/Id>/)?.[1]; const version = manifest.match(/<Version>([^<]+)<\/Version>/)?.[1] || '1.0.0.0';
if (!addinId) throw new Error('No <Id> in public/manifest.xml');
const zip = await JSZip.loadAsync(readFileSync(input));
const TP = 'http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes';
zip.file('word/webextensions/taskpanes.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<wetp:taskpanes xmlns:wetp="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11"><wetp:taskpane dockstate="right" visibility="1" width="350" row="0"><wetp:webextensionref xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></wetp:taskpane></wetp:taskpanes>`);
zip.file('word/webextensions/webextension1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="{85C2E452-54C7-704F-A8C9-E172456A780A}"><we:reference id="${addinId}" version="${version}" store="developer" storeType="Registry"/><we:alternateReferences/><we:properties/><we:bindings/><we:snapshot xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></we:webextension>`);
zip.file('word/webextensions/_rels/taskpanes.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/webextension" Target="webextension1.xml"/></Relationships>`);
let rels = await zip.file('_rels/.rels').async('string');
if (!rels.includes(TP)) { const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1])); const id = `rId${Math.max(0, ...ids) + 1}`; rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="${TP}" Target="word/webextensions/taskpanes.xml"/></Relationships>`); zip.file('_rels/.rels', rels); }
let types = await zip.file('[Content_Types].xml').async('string');
for (const [part, type] of [['/word/webextensions/taskpanes.xml', 'application/vnd.ms-office.webextensiontaskpanes+xml'], ['/word/webextensions/webextension1.xml', 'application/vnd.ms-office.webextension+xml']]) if (!types.includes(part)) types = types.replace('</Types>', `<Override PartName="${part}" ContentType="${type}"/></Types>`);
zip.file('[Content_Types].xml', types);
writeFileSync(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`pane attached: ${output}`);
