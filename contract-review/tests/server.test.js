// SPDX-License-Identifier: GPL-3.0-or-later
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportDocx, importDocx } from '../server/docx.js';
import { readFileSync } from 'node:fs';
import { stopProcess, removeDir } from './fixtures/cleanup.js';
const root=fileURLToPath(new URL('../',import.meta.url));
let base; // the server takes a free port and names it, so test files can run side by side
let processHandle, stateDirectory;
before(async()=>{
  stateDirectory=await mkdtemp(path.join(tmpdir(),'margin-test-')); 
  processHandle=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,PORT:'0',MARGIN_STATE_DIR:stateDirectory,OPENAI_API_KEY:'',OPENAI_MODEL:'',HTTPS_KEY:'',HTTPS_CERT:'',REVIEW_EXECUTOR:'replay',REVIEW_REPLAY_DIR:'',REVIEW_TRACE_DIR:''},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Test server did not start')),10000);
    processHandle.stdout.on('data',data=>{const m=/ready at https?:\/\/localhost:(\d+)/.exec(String(data));if(m){base=`http://127.0.0.1:${m[1]}`;clearTimeout(timer);resolve();}});
    processHandle.on('exit',code=>{clearTimeout(timer);reject(Error(`Test server exited ${code}`));});
  });
});
after(async()=>{await stopProcess(processHandle);await removeDir(stateDirectory);});
async function request(path,body){return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
// The test starts the server with the replay executor over the recorded demo (REVIEW_EXECUTOR=replay; test infrastructure).
const demoName='helix-brightwater-nda-v3-helix-counter.docx';
const demoDocument=async()=>({...(await importDocx(readFileSync(path.join(root,'data/fixtures/history',demoName)),demoName)),id:'demo-v3',revision:1});
test('served examples carry no evaluator labels; under replay a document outside the recording is refused',async()=>{
  const list=await (await fetch(base+'/api/cases')).json();
  assert.ok(list.length>=10);assert.ok(list.every(c=>!('expected' in c)));
  const example=list.find(c=>c.id==='nda-duration');
  const response=await request('/api/review',{document:example.document,baseline:example.baseline,mode:'demo'});
  assert.equal(response.status,503,'an example the recording does not cover is refused, never answered by local rules');
  assert.match((await response.json()).error,/demonstration documents only/);
});
test('replay plays the recorded review, ask and revise; the mode a caller sends is ignored',async()=>{
  const status=await (await fetch(base+'/api/status')).json();assert.equal(status.executor,'replay');assert.equal(status.liveAvailable,true);
  const document=await demoDocument();
  for(const mode of ['demo','live','other',undefined]) {
    const response=await request('/api/review',{document,mode,playbookId:'nda'});assert.equal(response.status,200,String(mode));
    const review=await response.json();assert.equal(review.engine,'live-model');assert.equal(review.model.executor,'replay');
    assert.match(review.model.replayedFrom.replace(/\\/g,'/'),/data\/recorded-runs\/demo-fixture\/review\.raw\.txt$/);
    assert.ok(review.findings.some(f=>f.status==='attention'));
  }
  const review=await (await request('/api/review',{document,playbookId:'nda'})).json();
  const target=review.findings.find(f=>f.status==='attention'&&f.paragraphId&&document.paragraphs.some(p=>p.id===f.paragraphId));
  const asked=await request('/api/ask',{document,question:'Does anything else change what the residuals sentence allows?',mode:'demo',playbookId:'nda'});
  assert.equal(asked.status,200);const answer=await asked.json();assert.equal(answer.engine,'live-model');assert.ok(answer.answer.length>0);
  const revised=await request('/api/review/revise',{document,finding:target,instruction:'Keep five years.',playbookId:'nda'});
  assert.equal(revised.status,200);assert.equal((await revised.json()).model.executor,'replay');
  const other={id:'x',revision:1,paragraphs:[{id:'p1',text:'Confidentiality lasts 7 years after termination.'}]};
  const unrecorded=await request('/api/ask',{document:other,question:'How long?',mode:'demo'});
  assert.equal(unrecorded.status,503,'Ask on a document outside the recording is unavailable, plainly');
});
test('removed routes are gone: evaluation, playbook versions, generation and suggestion',async()=>{
  for(const [method,route] of [['GET','/api/evaluation'],['GET','/api/playbook/versions'],['GET','/api/playbook/versions/1'],['POST','/api/playbook/generate'],['POST','/api/playbooks/suggest']]) {
    const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:method==='POST'?'{}':undefined});assert.equal(r.status,404,route);
  }
});
test('cross-site mutation is rejected and malformed document input is bounded',async()=>{
  const response=await fetch(base+'/api/review',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
  const malformed=await request('/api/review',{document:{id:'x',paragraphs:[{id:'p',text:'a'},{id:'p',text:'b'}]}});assert.equal(malformed.status,400);
});
test('DOCX import and export roundtrip preserve current text and revisions',async()=>{
  const document={id:'io',revision:1,title:'Test',paragraphs:[{id:'a',text:'Confidentiality lasts 7 years after termination.',originalText:'Confidentiality lasts 3 years after termination.'},{id:'b',text:'Use is solely for evaluating the business relationship.'}]};
  const buffer=await exportDocx(document);const form=new FormData();form.append('file',new Blob([buffer]),'agreement.docx');
  const importedResponse=await fetch(base+'/api/documents/import',{method:'POST',body:form});assert.equal(importedResponse.status,200);
  const imported=await importedResponse.json();assert.equal(imported.paragraphs[0].originalText,document.paragraphs[0].originalText);
  const exported=await request('/api/documents/export',{document:imported});assert.equal(exported.status,200);
  const parsed=await importDocx(Buffer.from(await exported.arrayBuffer()));assert.deepEqual(parsed.paragraphs.map(p=>[p.text,p.originalText]),imported.paragraphs.map(p=>[p.text,p.originalText]));
});
test('playbook cannot overwrite a newer saved version',async()=>{
  const book=await (await fetch(base+'/api/playbook')).json();
  const result=await fetch(base+'/api/playbook',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...book,version:-1})});
  assert.equal(result.status,409);
});
test('new guidance moves the change counter, remains explicit, and is included in review provenance',async()=>{
  const book=await (await fetch(base+'/api/playbook')).json();
  const rule={id:'PUBLICITY-TEST',title:'Publicity permission',topic:'custom',guidance:'Ask before using the other party name in publicity.',fallback:'Request written consent.',conditions:{},enabled:true};
  const saved=await fetch(base+'/api/playbook',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...book,rules:[...book.rules,rule]})});
  assert.equal(saved.status,200);const next=await saved.json();assert.equal(next.version,book.version+1);
  const reviewed=await (await request('/api/review',{document:await demoDocument()})).json();
  assert.equal(reviewed.playbookSnapshot.version,next.version);
  assert.deepEqual(reviewed.playbookSnapshot.rules.at(-1),rule);
  assert.ok(reviewed.coverage.some(c=>c.ruleId===rule.id&&c.status==='not-assessed'));
});
