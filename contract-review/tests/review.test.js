// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDocument, askQuestion, reviseFinding, validateModelReview } from '../server/review.js';
import { alignDocument } from '../shared/compare.js';

const book={version:1,rules:[{id:'duration',topic:'duration',title:'Duration',guidance:'General confidentiality up to 5 years after termination. Separate trade-secret protection is permitted.',enabled:true},{id:'retention',topic:'retention',title:'Retention',guidance:'Backups only if protection and limited use continue.',enabled:true},{id:'payment',topic:'payment',title:'Payment',guidance:'Undisputed invoices within 60 days.',enabled:true}]};
const doc=(paragraphs)=>({id:'new-document',revision:1,title:'Test agreement',paragraphs:paragraphs.map((text,i)=>({id:`p${i}`,text}))});
// A model that answers with no findings, through the replay executor: what remains is the product's own comparison and checks.
async function withEmptyModel(fn,answers={review:{findings:[],limits:[]}}) {
  const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-')); for(const [name,a] of Object.entries(answers)) fs.writeFileSync(path.join(dir,`${name}.raw.txt`),JSON.stringify(a));
  const saved={...process.env}; process.env.REVIEW_EXECUTOR='replay'; process.env.REVIEW_REPLAY_DIR=dir; delete process.env.REVIEW_TRACE_DIR;
  try { return await fn(); } finally { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved); }
}

test('finding validator flags problems and never discards (spec R5.3)',()=>{
  const document=doc(['Invoices due in 90 days.','Schedule A applies.']);
  const f={paragraphId:'p0',title:'Payment period',status:'attention',explanation:'Outside supplied term.',evidence:[{paragraphId:'p0',quote:'Invoices due in 90 days.'}],ruleIds:['payment']};
  const clean=validateModelReview({findings:[f],limits:[]},document,book);
  assert.equal(clean.length,1);assert.equal(clean[0].notes.length,0);assert.equal(clean[0].evidence[0].verified,true);assert.equal(clean[0].anchored,true);
  const cases=[
    [{evidence:[{paragraphId:'p0',quote:'Invoices due in 60 days.'}]},r=>r.evidence[0].verified===false && r.notes.some(n=>/could not be verified/.test(n))],
    [{ruleIds:['fiction']},r=>r.unknownRuleIds?.[0]==='fiction' && r.ruleIds.length===0],
    [{evidence:[{paragraphId:'p1',quote:'Schedule A applies.'}]},r=>r.notes.some(n=>/No verified quote from the target paragraph/.test(n))],
    [{status:'within-guidance',ruleIds:[]},r=>r.status==='context'],
    [{paragraphId:'p9'},r=>r.anchored===false],
    [{suggestedText:'Invoices due in 30 days.',ruleIds:[]},r=>r.proposalStatus==='not-applicable' && r.suggestedText===undefined && r.proposedText==='Invoices due in 30 days.'],
    [{suggestedText:'Invoices due in 30 days.'},r=>r.proposalStatus==='ok' && r.suggestedText==='Invoices due in 30 days.'],
  ];
  for(const [patch,check] of cases) { const out=validateModelReview({findings:[{...f,...patch}],limits:[]},document,book); assert.equal(out.length,1,'nothing is discarded'); assert.ok(check(out[0]),JSON.stringify(patch)); }
  assert.throws(()=>validateModelReview({limits:[]},document,book),/no findings array/);
});

test('recorded EXP-008 v1.1 output keeps all 53 findings under the flag-never-discard validator',async()=>{
  const fs=await import('node:fs');
  const {document,playbook}=JSON.parse(fs.readFileSync(new URL('./fixtures/exp008-v1.1/inputs.json',import.meta.url)));
  const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/exp008-v1.1/model-output.json',import.meta.url)));
  const out=validateModelReview(raw,document,playbook);
  assert.equal(out.length,53);
  const p49=out.find(f=>f.paragraphId==='p49'); assert.ok(p49 && p49.proposedText && p49.proposalStatus==='ok','the suggestion that sank v1.1 is kept and applicable (it cites a rule)');
  const whitespace=out.filter(f=>['p75','p76'].includes(f.paragraphId) && f.evidence.some(e=>!e.verified)); assert.equal(whitespace.length,2,'single-space quotes are flagged, not dropped');
  assert.ok(out.every(f=>Array.isArray(f.notes) && f.flags && typeof f.anchored==='boolean'));
});
test('invalid duplicate paragraph identities are rejected',async()=>{
  const document=doc(['One','Two']);document.paragraphs[1].id='p0';await assert.rejects(reviewDocument({document,playbook:book}),/unique IDs/);
});
test('a review with no working model fails visibly: no offline result is substituted, whatever mode the caller sends',async()=>{
  const saved=process.env.OPENAI_API_KEY,savedEx=process.env.REVIEW_EXECUTOR;delete process.env.OPENAI_API_KEY;process.env.REVIEW_EXECUTOR='openai';
  try {for(const mode of ['live','demo',undefined]) await assert.rejects(reviewDocument({document:doc(['Invoices due in 90 days.']),playbook:book,mode}),/No offline result was substituted/);}
  finally {if(saved===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=saved;if(savedEx===undefined)delete process.env.REVIEW_EXECUTOR;else process.env.REVIEW_EXECUTOR=savedEx;}
});
test('a finding with no paragraph is shown unanchored, not a crash',async()=>{
  const oldFetch=global.fetch,oldKey=process.env.OPENAI_API_KEY,oldModel=process.env.OPENAI_MODEL,oldEx=process.env.REVIEW_EXECUTOR;
  process.env.OPENAI_API_KEY='test-only';process.env.OPENAI_MODEL='test-provider';process.env.REVIEW_EXECUTOR='openai';
  try {
    global.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({findings:[{paragraphId:null,title:'Document-level issues',status:'context',explanation:'General points.',evidence:[]}],limits:[]})}}]})});
    const r=await reviewDocument({document:doc(['Notices must be delivered by courier.']),playbook:book,mode:'live',reviewMode:'third-party'});
    const f=r.findings.find(x=>x.title==='Document-level issues');
    assert.ok(f);assert.equal(f.change,'unknown');
  } finally {
    global.fetch=oldFetch;
    for(const [key,value] of [['OPENAI_API_KEY',oldKey],['OPENAI_MODEL',oldModel],['REVIEW_EXECUTOR',oldEx]]) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
test('live response is validated and omitted amendments stay accessible',async()=>{
  const oldFetch=global.fetch,oldKey=process.env.OPENAI_API_KEY,oldModel=process.env.OPENAI_MODEL,oldEx=process.env.REVIEW_EXECUTOR;
  process.env.OPENAI_API_KEY='test-only';process.env.OPENAI_MODEL='test-provider';process.env.REVIEW_EXECUTOR='openai';
  const document=doc(['Notices must be delivered by courier.']);document.paragraphs[0].originalText='Notices may be emailed.';
  try {
    global.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({findings:[],limits:['No interpretation returned.']})}}]})});
    const r=await reviewDocument({document,playbook:book,mode:'live'});
    assert.equal(r.engine,'live-model');assert.equal(r.findings.length,1);assert.equal(r.findings[0].status,'context');assert.equal(r.findings[0].change,'recorded');
    global.fetch=async()=>({ok:false,status:429});
    await assert.rejects(reviewDocument({document,playbook:book,mode:'live'}),/HTTP 429/);
  } finally {
    global.fetch=oldFetch;
    for(const [key,value] of [['OPENAI_API_KEY',oldKey],['OPENAI_MODEL',oldModel],['REVIEW_EXECUTOR',oldEx]]) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
test('imported paragraph insertion does not turn unchanged clauses into phantom edits',async()=>{
  const baseline={...doc(['Alpha','Beta','Gamma']),source:'docx',imported:true};
  const document={...doc(['New introductory text','Alpha','Beta','Gamma']),source:'docx',imported:true};
  const a=alignDocument(document,baseline);
  assert.deepEqual(a.paragraphs.map(p=>p.change),['changed','unchanged','unchanged','unchanged']);assert.equal(a.deleted.length,0);
  const r=await withEmptyModel(()=>reviewDocument({document,baseline,playbook:book}));assert.equal(r.findings.length,1);assert.equal(r.findings[0].paragraphId,'p0');
});
test('whole paragraph deletions stay accessible with baseline evidence',async()=>{
  const baseline={...doc(['Alpha','Sensitive obligation','Gamma']),source:'docx'};
  const document={...doc(['Alpha','Gamma']),source:'docx'};
  const r=await withEmptyModel(()=>reviewDocument({document,baseline,playbook:book}));
  const f=r.findings.find(f=>f.deleted);assert.equal(f.evidence[0].source,'baseline');assert.equal(f.evidence[0].quote,'Sensitive obligation');assert.equal(f.suggestedText,undefined);
});
test('retained whole deletion has original evidence, never an empty quote',async()=>{
  const document=doc(['']);document.paragraphs[0].originalText='An obligation was deleted.';
  const r=await withEmptyModel(()=>reviewDocument({document,playbook:book}));assert.equal(r.findings[0].deleted,true);assert.equal(r.findings[0].evidence[0].source,'original');assert.equal(r.findings[0].evidence[0].quote,'An obligation was deleted.');
});
test('ambiguous many-to-many imported changes preserve both sides without invented pairing',()=>{
  const baseline={...doc(['Alpha','Old A','Old B','Gamma']),source:'docx'};
  const document={...doc(['Alpha','New A','New B','New C','Gamma']),source:'docx'};
  const a=alignDocument(document,baseline);assert.equal(a.deleted.length,2);assert.equal(a.paragraphs.filter(p=>p.change==='changed').length,3);assert.ok(a.limits.some(x=>/one-to-one/.test(x)));
});
test('adjacent edited paragraphs are paired with what they were, by their tracked changes or by measured likeness',async()=>{
  const {readFileSync}=await import('node:fs');const {importDocx}=await import('../server/docx.js');
  const load=n=>importDocx(readFileSync(new URL('../data/fixtures/history/'+n,import.meta.url)),n);
  // The fixture markup edits paragraphs 13 and 14, which sit side by side. Against the draft it was made from, both are changes, nothing is removed.
  const v1=await load('helix-brightwater-nda-v1.docx'),v2=await load('helix-brightwater-nda-v2-bw-markup.docx');
  const a=alignDocument(v2,v1);
  assert.equal(a.deleted.length,0);assert.deepEqual(a.paragraphs.filter(p=>p.change==='changed').map(p=>p.id),['p5','p13','p14']);
  for(const id of ['p13','p14']){const p=a.paragraphs.find(x=>x.id===id);assert.equal(p.comparisonText,v1.paragraphs.find(x=>x.id===id).text);assert.ok(p.text.startsWith(p.comparisonText.slice(0,80)));}
  // The same edits with no tracked changes to go by (a clean retyped copy): paired by likeness, in order.
  const clean={...v2,paragraphs:v2.paragraphs.map(({originalText,...p})=>p)};
  const b=alignDocument(clean,v1);
  assert.equal(b.deleted.length,0);assert.deepEqual(b.paragraphs.filter(p=>p.change==='changed').map(p=>p.id),['p5','p13','p14']);
  assert.equal(b.paragraphs.find(x=>x.id==='p14').comparisonText,v1.paragraphs.find(x=>x.id==='p14').text);
  // Unlike paragraphs in the same block are still not paired.
  const base={...doc(['Alpha','The supplier shall keep the information secret for three years.','Each party bears its own costs of negotiation.','Gamma']),source:'docx'};
  const next={...doc(['Alpha','The supplier shall keep the information secret for seven years and thereafter.','Notices are sent by email to the addresses on the cover page.','Gamma']),source:'docx'};
  const c=alignDocument(next,base);
  // One old and one new paragraph left in the same place are a replacement, as a lone changed paragraph always was.
  assert.equal(c.paragraphs[1].comparisonText,base.paragraphs[1].text);assert.equal(c.paragraphs[2].comparisonText,base.paragraphs[2].text);assert.equal(c.deleted.length,0);
  // Two left over on one side is still not guessed.
  const more={...doc(['Alpha','The supplier shall keep the information secret for seven years and thereafter.','Notices are sent by email.','A wholly new clause about audits.','Gamma']),source:'docx'};
  const d=alignDocument(more,base);assert.equal(d.paragraphs[2].comparisonText,'');assert.equal(d.deleted.length,1);assert.ok(d.limits.some(x=>/one-to-one/.test(x)));
});
test('a clean return with silent edits, and a return still showing our own tracked changes',async()=>{
  const {readFileSync}=await import('node:fs');const {importDocx}=await import('../server/docx.js');
  const load=async n=>({...(await importDocx(readFileSync(new URL('../data/fixtures/history/'+n,import.meta.url)),n)),source:'docx',imported:true});
  const v1=await load('helix-brightwater-nda-v1.docx'),v2=await load('helix-brightwater-nda-v2-bw-markup.docx'),v3=await load('helix-brightwater-nda-v3-helix-counter.docx');
  const swap=t=>t.replace(/England and Wales\. Jurisdiction: the courts of England and Wales/,'Scotland. Jurisdiction: the courts of Scotland');
  // No tracked changes at all; the term and the governing law quietly altered in neighbouring clauses.
  const clean={...v1,paragraphs:v1.paragraphs.map(p=>({id:p.id,text:swap(p.text.replace('three (3) years','seven (7) years'))}))};
  const a=alignDocument(clean,v1);
  assert.deepEqual(a.paragraphs.filter(p=>p.change==='changed').map(p=>p.id),['p5','p6']);assert.equal(a.deleted.length,0);
  assert.match(a.paragraphs.find(p=>p.id==='p6').comparisonText,/England and Wales/);
  // Our counter-turn (v3) comes back with our revisions still showing and one new change of theirs.
  const second={...v3,paragraphs:v3.paragraphs.map(p=>/^Governing Law:/.test(p.text) ? {id:p.id,text:swap(p.text),originalText:p.text} : {...p})};
  const b=alignDocument(second,v3);
  assert.deepEqual(b.paragraphs.filter(p=>p.change==='changed').map(p=>p.id),['p6'],'only their new change is theirs; ours are not shown as changes');
});
test('stale selection context cannot be forwarded to assistance',async()=>{
  await assert.rejects(askQuestion({document:doc(['Current text']),playbook:book,question:'Explain',finding:{paragraphId:'absent'}}),/no longer present/);
});

test('review and ask prompts are files, loaded and hashed, with the hash in response metadata',async()=>{
  const {loadPrompt}=await import('../server/review.js');
  const p=loadPrompt('review'); assert.match(p.sha256,/^[0-9a-f]{64}$/); assert.ok(p.text.includes('Return only JSON')); assert.ok(p.file.replace(/\\/g,'/').endsWith('prompts/review.md'));
  assert.ok(loadPrompt('ask').text.includes('do not offer replacement wording'));
  const src=await (await import('node:fs/promises')).readFile(new URL('../server/review.js',import.meta.url),'utf8');
  assert.ok(!/const SYSTEM/.test(src),'no prompt text remains in review.js');
  const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-')); fs.writeFileSync(path.join(dir,'review.raw.txt'),JSON.stringify({findings:[],limits:[]}));
  const saved={...process.env}; process.env.REVIEW_EXECUTOR='replay'; process.env.REVIEW_REPLAY_DIR=dir;
  try { const r=await reviewDocument({document:doc(['Invoices due in 90 days.']),playbook:book,mode:'live'}); assert.equal(r.model.promptSha256,p.sha256); assert.equal(r.model.promptFile,'prompts/review.md'); assert.equal(r.model.reviewMode,'own-paper'); }
  finally { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved); }
});

test('third-party mode reviews the whole draft against the playbook: no form diff, no phantom amendments',async()=>{
  const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-'));
  fs.writeFileSync(path.join(dir,'review.raw.txt'),JSON.stringify({findings:[{paragraphId:'p0',title:'Term outside playbook',status:'attention',decision:'counter',explanation:'Playbook payment.',evidence:[{paragraphId:'p0',quote:'Invoices due in 90 days.'}],ruleIds:['payment'],proposedText:'Invoices due in 60 days.'}],limits:[]}));
  const saved={...process.env}; process.env.REVIEW_EXECUTOR='replay'; process.env.REVIEW_REPLAY_DIR=dir; process.env.REVIEW_TRACE_DIR=path.join(dir,'trace');
  const theirDraft=doc(['Invoices due in 90 days.','Their own warranty clause.','Their own notices clause.']);
  const ourForm={id:'form',paragraphs:[{id:'f0',text:'Invoices due in 60 days.'},{id:'f1',text:'Our warranty clause.'}]};
  try {
    const r=await reviewDocument({document:theirDraft,baseline:ourForm,playbook:book,mode:'live',reviewMode:'third-party'});
    assert.equal(r.findings.length,1,'no "Amendment for contextual review" entries for paragraphs that merely differ from our form');
    assert.ok(r.findings.every(f=>f.title!=='Amendment not assessed by model' && f.title!=='Amendment for contextual review'));
    assert.equal(r.model.reviewMode,'third-party');
    const sent=JSON.parse(fs.readFileSync(path.join(dir,'trace','review.user.json'),'utf8'));
    assert.equal(sent.baseline,null,'the form is not sent as a baseline'); assert.equal(sent.mode,'third-party');
    assert.ok(sent.context.some(c=>/standard-form/.test(c.name) && c.text.includes('Our warranty clause.')),'the form reaches the model as reference language');
    const own=await reviewDocument({document:theirDraft,baseline:ourForm,playbook:book,mode:'live',reviewMode:'own-paper'});
    assert.ok(own.findings.length>1,'own-paper mode still surfaces every aligned difference');
    await assert.rejects(reviewDocument({document:theirDraft,playbook:book,mode:'live',reviewMode:'sideways'}),/Unknown review mode/);
  } finally { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved); }
});

test('Revise regenerates exactly one finding with the instruction as context and applies nothing',async()=>{
  const {reviseFinding}=await import('../server/review.js');
  const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-'));
  fs.writeFileSync(path.join(dir,'revise.raw.txt'),JSON.stringify({findings:[{paragraphId:'p0',title:'Payment period (revised)',status:'attention',decision:'counter',explanation:'Per your instruction, counter at 45 days.',evidence:[{paragraphId:'p0',quote:'Invoices due in 90 days.'}],ruleIds:['payment'],proposedText:'Invoices due in 45 days.'}],limits:[]}));
  const saved={...process.env}; process.env.REVIEW_EXECUTOR='replay'; process.env.REVIEW_REPLAY_DIR=dir; process.env.REVIEW_TRACE_DIR=path.join(dir,'trace');
  try {
    const document=doc(['Invoices due in 90 days.','Schedule A applies.']);
    const r=await reviseFinding({document,playbook:book,finding:{id:'f-1',paragraphId:'p0',title:'Payment period',explanation:'x'},instruction:'Counter at 45 days, not 60.'});
    assert.equal(r.finding.id,'f-1'); assert.equal(r.finding.proposedText,'Invoices due in 45 days.'); assert.equal(r.finding.revisedWith,'Counter at 45 days, not 60.'); assert.equal(r.finding.proposalStatus,'ok');
    const sent=JSON.parse(fs.readFileSync(path.join(dir,'trace','revise.user.json'),'utf8')); assert.equal(sent.previousFinding.paragraphId,'p0');
    const sys=fs.readFileSync(path.join(dir,'trace','revise.system.txt'),'utf8'); assert.ok(sys.includes('Counter at 45 days, not 60.') && sys.includes('exactly one finding'));
    await assert.rejects(reviseFinding({document,playbook:book,finding:{paragraphId:'p9'},instruction:'x'}),/name a paragraph/);
    await assert.rejects(reviseFinding({document,playbook:book,finding:{paragraphId:'p0'},instruction:''}),/short instruction/);
  } finally { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved); }
});
test('matter instructions reach the model as context with precedence stated, and a finding relying on them keeps its proposal (T10)',async()=>{
  const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-'));
  fs.writeFileSync(path.join(dir,'review.raw.txt'),JSON.stringify({findings:[{paragraphId:'p0',title:'Term extended',status:'attention',decision:'accept',explanation:'Per the matter-instructions (from the reviewing lawyer), be flexible on term: accept seven years.',evidence:[{paragraphId:'p0',quote:'seven (7) years'}],ruleIds:[],proposedText:'The term is seven (7) years.'}],limits:[]}));
  const saved={...process.env}; process.env.REVIEW_EXECUTOR='replay'; process.env.REVIEW_REPLAY_DIR=dir; process.env.REVIEW_TRACE_DIR=path.join(dir,'trace');
  try {
    const document=doc(['The term is seven (7) years.']); document.paragraphs[0].originalText='The term is three (3) years.';
    const context=[{name:'matter-instructions (from the reviewing lawyer)',text:'Strategic customer: be flexible on term, hold the line on liability.'}];
    const r=await reviewDocument({document,playbook:book,mode:'live',context});
    const sent=JSON.parse(fs.readFileSync(path.join(dir,'trace','review.user.json'),'utf8'));
    assert.equal(sent.context[0].name,'matter-instructions (from the reviewing lawyer)'); assert.match(sent.context[0].text,/flexible on term/);
    const sys=fs.readFileSync(path.join(dir,'trace','review.system.txt'),'utf8'); assert.match(sys,/instructions from the lawyer or client in `context` govern this review/);
    const f=r.findings.find(x=>x.title==='Term extended'); assert.equal(f.proposalStatus,'ok','an instruction-backed proposal is not downgraded for lacking a playbook id'); assert.equal(f.suggestedText,'The term is seven (7) years.');
  } finally { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved); }
});
test('history beside a finding (R8.5): on the fixture counter-turn, the term finding carries the prior-round comment, quotes verified, unverified ones flagged (T18)',async()=>{
  const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path'); const {importDocx}=await import('../server/docx.js');
  const FIX=new URL('../data/fixtures/history/',import.meta.url); const read=f=>fs.readFileSync(new URL(f,FIX));
  const document=await importDocx(read('helix-brightwater-nda-v3-helix-counter.docx'),'helix-brightwater-nda-v3-helix-counter.docx'); const baseline=await importDocx(read('helix-brightwater-nda-v2-bw-markup.docx'),'v2');
  const comment=read('2026-05-20-brightwater-comment-on-term.eml').toString('utf8');
  const history=[{itemId:'item-comment',filename:'2026-05-20-brightwater-comment-on-term.eml',kind:'eml',date:'2026-05-20T14:03:40.000Z',text:comment}];
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-'));
  fs.writeFileSync(path.join(dir,'review.raw.txt'),JSON.stringify({findings:[{paragraphId:'p5',title:'Confidentiality period moved to five years',status:'attention',decision:'counter',explanation:'Our counter moves seven to five years; the counterparty indicated five was acceptable with the trade-secret tail.',evidence:[{paragraphId:'p5',quote:'five (5) years from the date of disclosure'}],ruleIds:[],history:[{itemId:'item-comment',quote:'we could live with five years if the trade-secret tail stays as drafted',note:'counterparty counsel, 20 May'},{itemId:'item-comment',quote:'they insisted on ten years',note:'wrong'}]}],limits:[]}));
  const saved={...process.env}; process.env.REVIEW_EXECUTOR='replay'; process.env.REVIEW_REPLAY_DIR=dir; process.env.REVIEW_TRACE_DIR=path.join(dir,'trace');
  try {
    const r=await reviewDocument({document,baseline,playbook:book,mode:'live',history});
    const sent=JSON.parse(fs.readFileSync(path.join(dir,'trace','review.user.json'),'utf8')); assert.equal(sent.history[0].itemId,'item-comment'); assert.match(sent.history[0].text,/five years/);
    const f=r.findings.find(x=>x.paragraphId==='p5' && x.history); assert.equal(f.history.length,2);
    assert.equal(f.history[0].verified,true); assert.equal(f.history[0].filename,'2026-05-20-brightwater-comment-on-term.eml'); assert.equal(f.history[0].note,'counterparty counsel, 20 May');
    assert.equal(f.history[1].verified,false); assert.ok(f.notes.some(n=>/history excerpt could not be verified/.test(n)));
    const sys=fs.readFileSync(path.join(dir,'trace','review.system.txt'),'utf8'); assert.match(sys,/never approval or standing policy/);
  } finally { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved); }
});
test('completeness flags: a text-changing decision without wording, and a deviation without a risk rating under a playbook that has a scheme, are flagged, kept and not invented (EXP-019)',async()=>{
  const {validateFindings}=await import('../server/review.js');
  const document=doc(['Liability is capped at fees paid in three months.','Either party may terminate on 30 days notice.']);
  const riskBook={version:1,rules:[{id:'LIAB',title:'Liability cap',topic:'liability',guidance:'Cap at 12 months of fees. Any lower cap is High Risk and requires GC approval.',enabled:true},{id:'TERM',title:'Termination',topic:'custom',guidance:'Ninety days notice.',enabled:true}]};
  const raw={findings:[
    {paragraphId:'p0',title:'Cap too low',status:'attention',decision:'counter',explanation:'Below the playbook cap (LIAB).',evidence:[{paragraphId:'p0',quote:'three months'}],ruleIds:['LIAB']},
    {paragraphId:'p1',title:'Notice period',status:'attention',decision:'counter',explanation:'Playbook requires ninety days (TERM).',evidence:[{paragraphId:'p1',quote:'30 days'}],ruleIds:['TERM'],proposedText:'Either party may terminate on 90 days notice.',risk:{rating:'Medium',basis:'TERM'}},
    {paragraphId:'p1',title:'Routine',status:'within-guidance',decision:'accept',explanation:'Fine under TERM.',evidence:[{paragraphId:'p1',quote:'Either party'}],ruleIds:['TERM']}],limits:[]};
  const {findings}=validateFindings(raw,document,riskBook);
  assert.equal(findings.length,3,'nothing discarded');
  const cap=findings[0]; assert.equal(cap.flags.missingWording,true); assert.equal(cap.flags.missingRisk,true); assert.equal(cap.proposedText,undefined,'no wording invented'); assert.equal(cap.risk,undefined,'no rating invented');
  assert.ok(cap.notes.some(n=>/calls for wording/.test(n)) && cap.notes.some(n=>/No risk rating/.test(n)));
  assert.equal(findings[1].flags.missingWording,undefined); assert.equal(findings[1].flags.missingRisk,undefined);
  assert.equal(findings[2].flags.missingRisk,undefined,'accepted or compliant points need no rating');
  const plain=validateFindings(raw,document,book).findings[0]; assert.equal(plain.flags.missingRisk,undefined,'no scheme in the playbook, no rating demanded'); assert.equal(plain.flags.missingWording,true);
});
