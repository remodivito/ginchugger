// SPDX-License-Identifier: GPL-3.0-or-later
// The v1 rule engine (the product's former Sample mode), moved from contract-review/tests/review.test.js with the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewLocal as reviewDocument, askLocal as askQuestion } from './local-rules.mjs';

const book={version:1,rules:[{id:'duration',topic:'duration',title:'Duration',guidance:'General confidentiality up to 5 years after termination. Separate trade-secret protection is permitted.',enabled:true},{id:'retention',topic:'retention',title:'Retention',guidance:'Backups only if protection and limited use continue.',enabled:true},{id:'payment',topic:'payment',title:'Payment',guidance:'Undisputed invoices within 60 days.',enabled:true}]};
const doc=(paragraphs)=>({id:'new-document',revision:1,title:'Test agreement',paragraphs:paragraphs.map((text,i)=>({id:`p${i}`,text}))});

test('fractional periods are compared and replaced as whole quantities',async()=>{
  for(const years of ['15.5','7.7']) {
    const r=await reviewDocument({document:doc([`Confidentiality lasts ${years} years after termination.`]),playbook:book});
    assert.equal(r.findings[0].status,'attention');
    assert.equal(r.findings[0].suggestedText,'Confidentiality lasts 5 years after termination.');
  }
  const payment=await reviewDocument({document:doc(['Invoices due in 160.5 days.']),playbook:book});
  assert.equal(payment.findings[0].status,'attention');
  assert.equal(payment.findings[0].suggestedText,'Invoices due in 60 days.');
});
test('unsupported compound quantities never pass by their numeric suffix',async()=>{
  for(const period of ['twenty-five','twenty five','five and a half','1,005']) {
    const r=await reviewDocument({document:doc([`Confidentiality lasts ${period} years after termination.`]),playbook:book});
    assert.notEqual(r.findings[0].status,'within-guidance');
    assert.equal(r.findings[0].suggestedText,undefined);
  }
  const payment=await reviewDocument({document:doc(['Invoices due in ninety-five days.']),playbook:book});
  assert.equal(payment.findings[0].status,'context');
  assert.equal(payment.findings[0].suggestedText,undefined);
});

test('duration compares current guidance and preserves trade-secret sentence in suggested wording',async()=>{
  const document=doc(['General confidentiality lasts 7 years after termination. Trade secrets remain protected while they qualify.']);
  const r=await reviewDocument({document,playbook:book});
  assert.equal(r.findings[0].status,'attention');
  assert.equal(r.findings[0].suggestedText,'General confidentiality lasts 5 years after termination. Trade secrets remain protected while they qualify.');
  const changed=structuredClone(book); changed.rules[0].guidance='General confidentiality up to 8 years after termination.';
  assert.equal((await reviewDocument({document,playbook:changed})).findings[0].status,'within-guidance');
});
test('disabled guidance cannot support a suggested replacement or classification',async()=>{
  const playbook=structuredClone(book);playbook.rules[0].enabled=false;
  const r=await reviewDocument({document:doc(['Confidentiality lasts 9 years after termination.']),playbook});
  assert.equal(r.findings[0].status,'context');assert.deepEqual(r.findings[0].ruleIds,[]);assert.equal(r.findings[0].suggestedText,undefined);
});
test('continuing protection elsewhere changes the retention assessment',async()=>{
  const text='Recipient may retain confidential information in routine backups.';
  const good=await reviewDocument({document:doc([text,'Retained copies remain subject to confidentiality and limited-use obligations.']),playbook:book});
  const bad=await reviewDocument({document:doc([text,'Retained copies are not subject to continuing confidentiality obligations.']),playbook:book});
  assert.notEqual(good.findings.find(f=>f.paragraphId==='p0').status,'attention');
  const finding=bad.findings.find(f=>f.paragraphId==='p0');assert.equal(finding.status,'attention');assert.ok(finding.evidence.some(e=>e.paragraphId==='p1'));
});
test('missing controlling payment schedule blocks within-guidance despite acceptable number',async()=>{
  const r=await reviewDocument({document:doc(['Undisputed invoices payable in 30 days.','Schedule A overrides payment terms and is not supplied.']),playbook:book});
  const f=r.findings.find(f=>f.paragraphId==='p0');assert.equal(f.status,'context');assert.ok(f.evidence.some(e=>e.paragraphId==='p1'));
});
test('uncovered amendments remain visible without invented policies',async()=>{
  const document=doc(['Notices must be delivered by courier.']);document.paragraphs[0].originalText='Notices may be emailed.';
  const r=await reviewDocument({document,playbook:book});assert.equal(r.findings.length,1);assert.equal(r.findings[0].status,'context');assert.equal(r.findings[0].change,'recorded');assert.deepEqual(r.findings[0].ruleIds,[]);
});
test('no baseline does not pretend to know negotiation history',async()=>{
  const r=await reviewDocument({document:doc(['Invoices due in 90 days.']),playbook:book});assert.equal(r.findings[0].change,'unknown');assert.match(r.scope,/cannot be established/);
});
test('offline questions explicitly decline unsupported answers',async()=>{
  const r=await askQuestion({document:doc(['Invoices due in 30 days.']),playbook:book,question:'Who won the Olympics?'});assert.match(r.answer,/cannot reliably answer/);assert.deepEqual(r.evidence,[]);
});
test('custom named duration rule is not mistaken for executable duration policy',async()=>{
  const playbook={version:1,rules:[{id:'custom',topic:'custom',title:'Duration',guidance:'Duration permitted 5 years.'}]};
  const r=await reviewDocument({document:doc(['Confidentiality lasts 9 years after termination.']),playbook});
  assert.ok(r.findings.every(f=>f.status==='context' && !f.suggestedText && !f.ruleIds.length));
});
test('conflicting structured and written conditions defer judgment',async()=>{
  const playbook=structuredClone(book);playbook.rules[0].conditions={maxYears:10};
  const r=await reviewDocument({document:doc(['Confidentiality lasts 9 years after termination.']),playbook});
  assert.equal(r.findings[0].status,'context');assert.equal(r.findings[0].suggestedText,undefined);assert.match(r.findings[0].explanation,/disagree/);
});
test('the engine still answers exactly as the product\'s Sample mode did on the recorded demo document', async () => {
  const { readFileSync } = await import('node:fs'); const { importDocx } = await import('../../contract-review/server/docx.js');
  const name = 'helix-brightwater-nda-v3-helix-counter.docx';
  const document = await importDocx(readFileSync(new URL(`../../contract-review/data/fixtures/history/${name}`, import.meta.url)), name);
  const playbook = JSON.parse(readFileSync(new URL('../../contract-review/data/playbook.json', import.meta.url), 'utf8'));
  const r = reviewDocument({ document, playbook });
  assert.equal(r.engine, 'local-rules'); assert.ok(r.findings.length > 0); assert.ok(r.limits.some(l => /Offline demonstration/.test(l)));
  assert.ok(r.findings.every(f => f.evidence.every(e => typeof e.quote === 'string')));
});
