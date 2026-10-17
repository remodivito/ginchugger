// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {importDocx,exportDocx} from '../server/docx.js';
const doc={id:'demo',title:'NDA',revision:0,paragraphs:[{id:'p1',text:'Term is five years.',originalText:'Term is three years.'},{id:'p2',text:'England law applies.'}]};
test('authored DOCX preserves original/current text',async()=>{const result=await importDocx(await exportDocx(doc),'NDA.docx');assert.equal(result.paragraphs[0].text,'Term is five years.');assert.equal(result.paragraphs[0].originalText,'Term is three years.');});
test('narrow edit retains unrelated revisions and original ZIP parts',async()=>{let buffer=await exportDocx(doc);const z=await JSZip.loadAsync(buffer);z.file('customXml/test.xml','<retained/>');buffer=await z.generateAsync({type:'nodebuffer'});const parsed=await importDocx(buffer);parsed.paragraphs[1].text='English law applies.';const output=await exportDocx(parsed,buffer);const re=await importDocx(output);assert.equal(re.paragraphs[0].originalText,'Term is three years.');assert.equal(re.paragraphs[0].text,'Term is five years.');assert.equal(re.paragraphs[1].originalText,'England law applies.');assert.equal(re.paragraphs[1].text,'English law applies.');assert.equal(await (await JSZip.loadAsync(output)).file('customXml/test.xml').async('string'),'<retained/>');});
test('refuses edit through pre-existing revision',async()=>{const b=await exportDocx(doc);const d=await importDocx(b);d.paragraphs[0].text='Term is six years.';await assert.rejects(exportDocx(d,b),/existing revisions/);});
test('refuses changed paragraph structure',async()=>{const b=await exportDocx(doc);const d=await importDocx(b);d.paragraphs.reverse();await assert.rejects(exportDocx(d,b),/order changed/);});
test('rejects XML entities',async()=>{const z=await JSZip.loadAsync(await exportDocx(doc));z.file('word/document.xml','<!DOCTYPE x [<!ENTITY x SYSTEM "file:///tmp/x">]><x>&x;</x>');await assert.rejects(importDocx(await z.generateAsync({type:'nodebuffer'})),/entities/);});
test('refuses malformed document XML',async()=>{const z=await JSZip.loadAsync(await exportDocx(doc));z.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p></w:body>');await assert.rejects(importDocx(await z.generateAsync({type:'nodebuffer'})),/Malformed/);});
test('imported content cannot be silently exported without original archive',async()=>{const d=await importDocx(await exportDocx(doc));await assert.rejects(exportDocx(d),/Original DOCX/);});
test('moved text is version-specific and warned as incomplete',async()=>{const z=await JSZip.loadAsync(await exportDocx(doc));z.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:moveFrom><w:r><w:delText>Before</w:delText></w:r></w:moveFrom><w:moveTo><w:r><w:t>After</w:t></w:r></w:moveTo></w:p></w:body></w:document>');const d=await importDocx(await z.generateAsync({type:'nodebuffer'}));assert.equal(d.paragraphs[0].text,'After');assert.equal(d.paragraphs[0].originalText,'Before');assert(d.warnings.some(x=>x.includes('moveFrom')));});

test('rejects oversized archive entry count before document parsing',async()=>{const z=new JSZip();for(let i=0;i<2001;i++)z.file(`part${i}.xml`,'');await assert.rejects(importDocx(await z.generateAsync({type:'nodebuffer'})),/expanded size limit/);});

test('standalone authored exports carry escaped source attribution and licensing metadata',async()=>{
 const source={title:'Common Paper <NDA>',url:'https://example.test/nda?a=1&b=2',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',attribution:'Adapted from Common Paper & marked amendments added.'};
 const buffer=await exportDocx({...doc,source});const zip=await JSZip.loadAsync(buffer);const core=await zip.file('docProps/core.xml').async('string');
 assert(core.includes('Common Paper &lt;NDA&gt;'));assert(core.includes('Paper &amp; marked'));assert(core.includes('a=1&amp;b=2'));assert(core.includes('CC BY 4.0'));assert(core.includes(source.licenseUrl));
 assert((await zip.file('[Content_Types].xml').async('string')).includes('/docProps/core.xml'));assert((await zip.file('_rels/.rels').async('string')).includes('relationships/metadata/core-properties'));
 const imported=await importDocx(buffer);assert.equal(imported.paragraphs.length,doc.paragraphs.length);const exportedAgain=await JSZip.loadAsync(await exportDocx(imported,buffer));assert.equal(await exportedAgain.file('docProps/core.xml').async('string'),core);
});

async function rowRevisionDocument(){
 const z=await JSZip.loadAsync(await exportDocx(doc));
 z.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>
 <w:tr><w:trPr><w:del w:id="20" w:author="Counterparty"/></w:trPr><w:tc><w:p><w:r><w:t>Liability is unlimited.</w:t></w:r></w:p></w:tc></w:tr>
 <w:tr><w:trPr><w:ins w:id="21" w:author="Counterparty"/></w:trPr><w:tc><w:p><w:r><w:t>Liability is capped at fees paid.</w:t></w:r></w:p></w:tc></w:tr>
 <w:tr><w:tc><w:p><w:r><w:t>Payment is due in 30 days.</w:t></w:r></w:p></w:tc></w:tr>
 </w:tbl></w:body></w:document>`);
 return z.generateAsync({type:'nodebuffer'});
}
test('tracked table row insertions and deletions have distinct original/current text',async()=>{
 const buffer=await rowRevisionDocument();const d=await importDocx(buffer);
 assert.equal(d.paragraphs[0].text,'');assert.equal(d.paragraphs[0].originalText,'Liability is unlimited.');
 assert.equal(d.paragraphs[1].text,'Liability is capped at fees paid.');assert.equal(d.paragraphs[1].originalText,'');
 assert.equal(d.paragraphs[0].editable,false);assert.equal(d.paragraphs[1].editable,false);assert.equal(d.paragraphs[2].editable,true);
 const roundTrip=await importDocx(await exportDocx(d,buffer));assert.deepEqual(roundTrip.paragraphs,d.paragraphs);
 d.paragraphs[1].text='Liability is capped at twice fees paid.';await assert.rejects(exportDocx(d,buffer),/existing revisions/);
});

test('a whole clause deleted is exported as one tracked deletion across its runs, and reads back with its original wording', async () => {
  const { readFileSync } = await import('node:fs');
  const buffer = readFileSync(new URL('../data/fixtures/history/helix-brightwater-nda-v1.docx', import.meta.url));
  const document = await importDocx(buffer, 'v1.docx');
  const i = document.paragraphs.findIndex(p => p.text.length > 80 && p.editable !== false); const before = document.paragraphs[i].text;
  const out = await exportDocx({ ...document, paragraphs: document.paragraphs.map((p, j) => j === i ? { ...p, text: '' } : p) }, buffer);
  const back = await importDocx(out, 'out.docx');
  assert.equal(back.paragraphs[i].text, ''); assert.equal(back.paragraphs[i].originalText, before);
  assert.ok(back.paragraphs.every((p, j) => j === i || p.text === document.paragraphs[j].text), 'no other paragraph changes');
});
