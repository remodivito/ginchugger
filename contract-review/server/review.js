// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { alignDocument } from '../shared/compare.js';
import { runModel, getExecutorConfig, toolsSupported } from './executors.js';
import { citableText } from './store/text.js';
import { parseAskReply, proseAnswer, ASK_CORRECTION } from './ask-reply.js';
const isAskAnswer=v=>Boolean(v) && typeof v==='object' && typeof v.answer==='string' && Boolean(v.answer.trim());
// Prompts are files, not code (spec R5.1, T5). Loaded once, hashed, and the hash travels with every response.
// REVIEW_PROMPT / ASK_PROMPT may name alternative files for benchmarking; the default files are the product's.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const PROMPT_DIR = fileURLToPath(new URL('../prompts/', import.meta.url));
const promptCache = new Map();
export function loadPrompt(name) {
  const file = process.env[`${name.toUpperCase().replace(/-/g, '_')}_PROMPT`] || `${PROMPT_DIR}${name}.md`;
  if (!promptCache.has(file)) { const text = readFileSync(file, 'utf8'); promptCache.set(file, { text, sha256: createHash('sha256').update(text).digest('hex'), file }); }
  return promptCache.get(file);
}

/** The agentic prompt (product v2 spec 6.4.1; plan task 10): review.md's instructions followed by the store section, with the call limit. */
export function loadAgenticPrompt(maxToolCalls) {
  const p = loadPrompt('review-record');
  return { ...p, text: p.text.split('{maxToolCalls}').join(String(maxToolCalls)) };
}

export function checkInputs(document, playbook, baseline) {
  if (!document || !Array.isArray(document.paragraphs) || !document.paragraphs.length) throw new Error('A document with paragraphs is required.');
  if (document.paragraphs.length > 2000 || document.paragraphs.reduce((n,p)=>n+String(p.text || '').length,0)>250000) throw new Error('Document exceeds the prototype limit (250,000 characters / 2,000 paragraphs).');
  const ids = new Set();
  for (const p of document.paragraphs) {
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.text !== 'string' || p.text.length>50000) throw new Error('Document paragraphs need unique IDs and bounded text.');
    if(p.originalText!==undefined && (typeof p.originalText!=='string' || p.originalText.length>50000)) throw new Error('Recorded original text must be a bounded text string.');
    ids.add(p.id);
  }
  if (!playbook || !Array.isArray(playbook.rules)) throw new Error('A saved playbook is required.');
  const ruleIds=new Set();
  for(const rule of playbook.rules) {
    if(typeof rule.id!=='string' || !rule.id || ruleIds.has(rule.id)) throw new Error('Playbook rules need unique IDs.');
    ruleIds.add(rule.id);
  }
  if(playbook.rules.length>100 || JSON.stringify(playbook).length>150000) throw new Error('Playbook exceeds the prototype size limit.');
  if (baseline && !Array.isArray(baseline.paragraphs)) throw new Error('Baseline paragraphs are invalid.');
  if(baseline) checkInputs(baseline,{rules:[]},null);
  if(JSON.stringify({document,baseline}).length>600000) throw new Error('Supplied document data exceeds the prototype size limit.');
}

export function changeFor(p, baseline, document) {
  if (!p) return 'unknown'; // an unanchored finding has no paragraph to compare
  if(document) return alignDocument(document,baseline).paragraphs.find(x=>x.id===p.id)?.change || 'unknown';
  if (baseline) {
    // Exact unchanged text survives independently imported paragraph IDs and
    // inserted paragraphs shifting positional identifiers.
    if(baseline.paragraphs.some(b=>b.text===p.text)) return 'unchanged';
    const before = baseline.paragraphs.find(b => b.id === p.id);
    return before ? (before.text === p.text ? 'unchanged' : 'changed') : 'changed';
  }
  return typeof p.originalText === 'string' && p.originalText !== p.text ? 'recorded' : 'unknown';
}

export function makeReview(document, baseline, playbook, engine) {
  return {id:randomUUID(),documentId:document.id,documentRevision:document.revision,playbookVersion:playbook.version,engine,createdAt:new Date().toISOString(),scope:baseline ? 'Current agreement and supplied comparison version' : document.paragraphs.some(p=>typeof p.originalText==='string' && p.originalText!==p.text) ? 'Current agreement and retained revisions; no sent-version history' : 'Current agreement; negotiation changes cannot be established',findings:[],coverage:[],limits:[]};
}

// Finding contract (spec R5.2, R5.3; T2, 3 October 2026). One validator for every workflow.
// It flags and never discards: a finding with a bad quote, an unknown rule, an unanchored
// target or an out-of-scope proposal is returned with the problem recorded on it.
const DECISIONS=['accept','reject','accept-with-modification','counter','reserved','none'];
const RISK_SCHEME=/\b(?:high|medium|low|critical)[- ]risk\b|\brisk (?:rating|classification|tier|level|matrix|categor)/i;
const str=(v,max)=>typeof v==='string' ? (v.length>max ? v.slice(0,max) : v) : '';
// A store citation's document id: a whole number, or a string of digits (as a model sometimes writes it).
export const citedDocument=c=>Number.isInteger(c?.documentId) && c.documentId>0 ? c.documentId : (typeof c?.documentId==='string' && /^\d{1,9}$/.test(c.documentId) ? Number(c.documentId) : null);
const citations=f=>(Array.isArray(f?.record) ? f.record : []).slice(0,10);

/**
 * One store citation checked (plan task 10; PR-REV-04 on the flat store): verified only when the document exists, the
 * quote is an exact substring of its text as read_document returns it, and the `counterparty` label is true (`same` iff
 * the document's counterparty is the one under review). When the review's counterparty is unknown the label is not
 * checked. `lookup(documentId)` -> { text, counterparty } | null, or null when the store was not read.
 */
export function checkCitation(c,lookup,counterparty) {
  const documentId=citedDocument(c); const quote=typeof c?.quote==='string' ? c.quote : ''; const label=['same','other'].includes(c?.counterparty) ? c.counterparty : null;
  const src=lookup && documentId!==null ? lookup(documentId) : null;
  const same=src && counterparty ? String(src.counterparty||'').toLowerCase()===String(counterparty).toLowerCase() : null;
  let reason=null;
  if(!lookup) reason='The document store was not read in this review.';
  else if(!src) reason='No such document in the store.';
  else if(!quote.trim() || typeof src.text!=='string' || !src.text.includes(quote)) reason='The quote is not in that document\'s text.';
  else if(same!==null && label!==(same ? 'same' : 'other')) reason=same ? 'The document belongs to this counterparty, not another.' : 'The document belongs to another counterparty.';
  return {documentId,quote:quote.slice(0,2000),counterparty:label,note:typeof c?.note==='string' ? c.note.slice(0,300) : null,verified:!reason,...(reason ? {reason} : {})};
}

/** Resolve every document a list of citations names, once each, so the validators stay synchronous. */
export async function resolveCitations(list,resolve) {
  const found=new Map();
  for(const c of list) { const id=citedDocument(c); if(id===null || found.has(id)) continue; found.set(id,await resolve(id)); }
  return id=>found.get(id) ?? null;
}

// `citations` (plan task 10): { lookup(documentId) -> { text, counterparty } | null, counterparty }, from
// prepareAgenticReview's resolver (server/store/tools.js). Without it every store citation is unverified. Unverified
// citations are kept with a reason, as unverified quotes are.
export function validateFindings(raw,document,playbook,{history=[],context=null,citations:cited=null}={}) {
  const lookup=cited && typeof cited.lookup==='function' ? cited.lookup : null;
  const histById=new Map((history||[]).map(h=>[h.itemId,h]));
  // A proposal without a playbook rule may rest on an instruction or a held email, but only when this review was given one (9 Oct 2026, audit item 10).
  const hasInstructions=Array.isArray(context) && context.some(c=>c && typeof c.text==='string' && c.text.trim()); const hasHistory=histById.size>0;
  // A playbook that classifies risk (High/Medium/Low, risk tiers, a risk matrix) obliges a rating on each deviation (4 Oct 2026).
  const hasRiskScheme=(playbook?.rules||[]).some(r=>r && r.enabled!==false && RISK_SCHEME.test([r.title,r.guidance,r.escalation,r.hardLine,r.rationale].filter(Boolean).join(' ')));
  if (!raw || typeof raw!=='object' || !Array.isArray(raw.findings)) throw new Error('Model returned an invalid review structure: no findings array.');
  const rules=new Set((playbook.rules||[]).filter(r=>r.enabled!==false).map(r=>r.id));
  const current=new Map(document.paragraphs.map(p=>[p.id,p.text]));
  const original=new Map(document.paragraphs.map(p=>[p.id,typeof p.originalText==='string' ? p.originalText : p.text]));
  const notes=[]; const findings=[];
  for (const f of raw.findings.slice(0,200)) {
    if (!f || typeof f!=='object') { notes.push('Skipped a non-object entry in findings.'); continue; }
    const fn=[]; const pid=typeof f.paragraphId==='string' ? f.paragraphId : '';
    const anchored=current.has(pid); if(!anchored) fn.push(`Target paragraph ${pid||'(missing)'} is not in the document; shown unanchored.`);
    let status=['attention','within-guidance','context'].includes(f.status) ? f.status : 'context'; if(status!==f.status) fn.push(`Status "${f.status}" not recognised; shown as context.`);
    const title=str(f.title,200)||'Untitled finding'; const explanation=str(f.explanation,8000);
    const rawRules=Array.isArray(f.ruleIds) ? f.ruleIds.filter(x=>typeof x==='string') : [];
    const ruleIds=rawRules.filter(id=>rules.has(id)); const unknownRuleIds=rawRules.filter(id=>!rules.has(id));
    if(unknownRuleIds.length) fn.push(`Rule reference(s) not in the active playbook: ${unknownRuleIds.join(', ')}.`);
    if(status==='within-guidance' && !ruleIds.length) { status='context'; fn.push('Within-guidance claimed without a saved rule; shown as context.'); }
    const evidence=(Array.isArray(f.evidence) ? f.evidence : []).slice(0,30).map(e=>{
      const eid=typeof e?.paragraphId==='string' ? e.paragraphId : pid; const quote=typeof e?.quote==='string' ? e.quote : '';
      const source=e?.source==='baseline'||e?.source==='original' ? 'baseline' : undefined;
      const pool=source ? original.get(eid) : current.get(eid);
      const verified=Boolean(quote.trim()) && typeof pool==='string' && pool.includes(quote);
      return {paragraphId:eid,quote,...(source ? {source} : {}),verified};
    });
    if(!evidence.length) fn.push('No evidence quoted.');
    else if(!evidence.some(e=>e.verified && e.paragraphId===pid)) fn.push('No verified quote from the target paragraph.');
    if(evidence.some(e=>!e.verified)) fn.push(`${evidence.filter(e=>!e.verified).length} quote(s) could not be verified against the document and are shown as unverified.`);
    let decision=DECISIONS.includes(f.decision) ? f.decision : 'none';
    const supported=ruleIds.length>0 || (hasInstructions && /instruction|client/i.test(explanation)) || (hasHistory && /email|\.eml|earlier round/i.test(explanation));
    const text=typeof f.proposedText==='string' ? f.proposedText : (typeof f.suggestedText==='string' ? f.suggestedText : undefined);
    let proposalStatus, proposalNote;
    if(text!==undefined) {
      const cap=Math.max(current.get(pid)?.length||0,original.get(pid)?.length||0)*4+4000;
      if(!text.trim() && !current.get(pid)?.trim()) { proposalStatus='not-applicable'; proposalNote='Empty proposed wording for an empty paragraph.'; }
      else if(!anchored) { proposalStatus='not-applicable'; proposalNote='Cannot apply: target paragraph not found.'; }
      else if(!supported) { proposalStatus='not-applicable'; proposalNote='No playbook rule or client instruction cited in support.'; }
      else if(text.length>cap) { proposalStatus='not-applicable'; proposalNote='Far longer than the target paragraph; review before use.'; }
      else proposalStatus='ok';
      if(proposalStatus!=='ok') fn.push(`Proposed wording shown but not offered for application: ${proposalNote}`);
    }
    const insertAfter=(Array.isArray(f.insertAfter) ? f.insertAfter : []).filter(x=>x && typeof x.text==='string' && x.text.trim()).map(x=>({afterParagraphId:x.afterParagraphId,text:x.text.slice(0,20000),anchored:current.has(x.afterParagraphId)}));
    if(insertAfter.some(x=>!x.anchored)) fn.push('An insertion names a paragraph that is not in the document; shown unanchored.');
    const deletion=text!==undefined && !text.trim() && proposalStatus==='ok';
    const options=(Array.isArray(f.options) ? f.options : []).slice(0,8).map(o=>typeof o==='string' ? {label:o} : (o && typeof o.label==='string' ? {label:str(o.label,200),...(typeof o.text==='string' ? {text:o.text} : {})} : null)).filter(Boolean);
    const positions=f.positions && typeof f.positions==='object' ? Object.fromEntries(['preferred','acceptable','escalation','hardLine'].map(k=>[k,typeof f.positions[k]==='string' && f.positions[k].trim() ? f.positions[k].slice(0,1500) : null])) : null;
    const risk=f.risk && typeof f.risk==='object' && typeof f.risk.rating==='string' && f.risk.rating.trim() ? {rating:f.risk.rating.slice(0,100),basis:typeof f.risk.basis==='string' ? f.risk.basis.slice(0,500) : null} : null;
    // Completeness flags (4 Oct 2026, EXP-019 diagnosis): a decision that changes the text needs wording; a deviation needs a risk
    // rating when the playbook has a scheme. Flagged for the lawyer, never discarded, never invented by the tool.
    const missingWording=['reject','counter','accept-with-modification'].includes(decision) && text===undefined && !insertAfter.length;
    if(missingWording) fn.push('The decision calls for wording but none was drafted. Use Revise to ask for it.');
    const missingRisk=hasRiskScheme && status==='attention' && !['none','accept'].includes(decision) && !risk;
    if(missingRisk) fn.push('No risk rating given although the playbook has a risk scheme.');
    // History excerpts (R8.5): each must be an exact quote from a held item; unverified ones are shown as such.
    const hist=(Array.isArray(f.history) ? f.history : []).slice(0,5).map(h=>{const src=h && histById.get(h.itemId); const q=typeof h?.quote==='string' ? h.quote : ''; const verified=Boolean(src && q.trim() && src.text.includes(q)); return {itemId:h?.itemId||null,filename:src?.filename||null,date:src?.date||null,quote:q.slice(0,1500),note:typeof h?.note==='string' ? h.note.slice(0,300) : null,verified};});
    if(hist.some(h=>!h.verified)) fn.push('A history excerpt could not be verified against the held item; shown as unverified.');
    const cites=citations(f).map(c=>checkCitation(c,lookup,cited?.counterparty||null));
    if(cites.some(c=>!c.verified)) fn.push(`${cites.filter(c=>!c.verified).length} store citation(s) could not be verified against the document store; shown as unverified.`);
    findings.push({id:randomUUID(),paragraphId:pid,anchored,title,status,decision,explanation,evidence,ruleIds,untouched:f.untouched===true,...(hist.length ? {history:hist} : {}),...(cites.length ? {record:cites} : {}),...(positions && Object.values(positions).some(Boolean) ? {positions} : {}),...(risk ? {risk} : {}),...(unknownRuleIds.length ? {unknownRuleIds} : {}),
      ...(text!==undefined ? {proposedText:text,proposalStatus,...(proposalNote ? {proposalNote} : {}),...(proposalStatus==='ok' ? {suggestedText:text} : {}),...(deletion ? {deletion:true} : {})} : {}),...(typeof f.revisionNote==='string' && f.revisionNote.trim() ? {revisionNote:f.revisionNote.trim().slice(0,300)} : {}),
      ...(insertAfter.length ? {insertAfter} : {}),...(options.length ? {options} : {}),flags:{...(missingWording ? {missingWording:true} : {}),...(missingRisk ? {missingRisk:true} : {})},notes:fn});
  }
  if(raw.findings.length>200) notes.push(`Only the first 200 of ${raw.findings.length} findings were kept.`);
  return {findings,notes,limits:Array.isArray(raw.limits) ? raw.limits.filter(x=>typeof x==='string') : []};
}

// Back-compatible name used by older callers: returns the findings array (never throws per finding).
export function validateModelReview(raw,document,playbook) { return validateFindings(raw,document,playbook).findings; }

// Every review is a model call through the configured executor. Sample mode is the replay executor over the recorded
// demo (product v2 spec section 2); the former local rule engine is tough-eval/baselines/local-rules.mjs. `mode` is
// accepted from older callers and ignored.
//
// `agentic` (product v2 spec 4.3, 6.4, 7.4; plan task 10), from prepareAgenticReview in server/store/tools.js:
//   { tools: { names, call, scope, maxToolCalls, listener }, citations: { resolve, counterparty }, brief }
// With it, and an executor that supports tools, the prompt is review-record.md, the model reads the document store
// through the four store tools, `history` is not sent (the tools replace it), and store citations are verified against
// the documents' text. An executor without tools (codex, muse, a provider whose smoke test failed, or one that refuses
// `tools`) runs the single call with review.md and the review says the store was not consulted.
//
// `signal`, optional (17 Oct 2026): the route's, aborted when the client goes away (the pane's Stop); the model call is
// then ended (the Claude CLI child killed, an API call cancelled) and the review throws { code: 'stopped' }.
export async function reviewDocument({document,baseline=null,playbook,context=null,reviewMode='own-paper',history=null,agentic=null,config=null,signal=null}) {
  checkInputs(document,playbook,baseline);
  if (!['own-paper','third-party'].includes(reviewMode)) throw new Error('Unknown review mode.');
  // Third-party paper (spec R4.7, T6): the counterparty's draft is reviewed whole against the playbook. A supplied
  // "baseline" is the client's standard form, which becomes reference language in context, never a diff target.
  if (reviewMode==='third-party' && baseline) { context=[...(context||[]),{name:'standard-form (reference language, not a prior version)',text:baseline.paragraphs.map(p=>p.text).filter(Boolean).join('\n')}]; baseline=null; }
  const wantTools=Boolean(agentic?.tools);
  // `config`, optional: the executor configuration for this call (the tool smoke test, the benchmark); else the environment's.
  const cfg={...(config ? {config} : {}),...(signal ? {signal} : {})};
  let useTools=wantTools && toolsSupported(config || getExecutorConfig());
  const held=Array.isArray(history) && history.length ? history.map(h=>({itemId:h.itemId,filename:h.filename,kind:h.kind,date:h.date,text:h.text})) : null;
  const single=async()=>{
    const prompt=loadPrompt('review');
    const call=await runModel({...cfg,name:'review',system:prompt.text,payload:{document,baseline,playbook:{...playbook,rules:playbook.rules.filter(r=>r.enabled!==false)},...(context ? {context} : {}),...(held ? {history:held} : {}),mode:reviewMode},...(held ? {replayIds:Object.fromEntries(held.map(h=>[h.filename,h.itemId]))} : {})});
    return {prompt,call};
  };
  let prompt, call, fallback=null;
  if (useTools) {
    prompt=loadAgenticPrompt(agentic.tools.maxToolCalls);
    try { call=await runModel({...cfg,name:'review',system:prompt.text,payload:{document,baseline,playbook:{...playbook,rules:playbook.rules.filter(r=>r.enabled!==false)},...(context ? {context} : {}),...(agentic.brief ? {store:agentic.brief} : {}),mode:reviewMode},tools:agentic.tools}); }
    catch (e) { if (e.code!=='tools_unsupported') throw e; useTools=false; fallback=e.message; ({prompt,call}=await single()); }
  } else ({prompt,call}=await single());
  const raw=call.data;
  // Store citations are resolved before validation, so the validator itself stays synchronous.
  let citedOpt=null;
  if (agentic?.citations && typeof agentic.citations.resolve==='function') {
    const all=(Array.isArray(raw?.findings) ? raw.findings.slice(0,200) : []).flatMap(f=>citations(f));
    citedOpt={counterparty:agentic.citations.counterparty||null,lookup:await resolveCitations(all,agentic.citations.resolve)};
  }
  const toolCalls=Array.isArray(call.toolCalls) ? call.toolCalls : [];
  const result=makeReview(document,baseline,playbook,'live-model'); result.model={...call.meta,promptFile:prompt.file.split(/[\\/]/).slice(-2).join('/'),reviewMode,agentic:useTools,toolCalls:toolCalls.length};
  const validated=validateFindings(raw,document,playbook,{history:useTools ? [] : held||[],context,citations:citedOpt}); const validationNotes=validated.notes;
  result.findings=validated.findings.map(f=>({...f,change:changeFor(document.paragraphs.find(p=>p.id===f.paragraphId),baseline)}));
  // Enforce amendment visibility independently of the model's recall.
  if (reviewMode==='own-paper') for (const p of document.paragraphs) if (['changed','recorded'].includes(changeFor(p,baseline)) && !result.findings.some(f=>f.paragraphId===p.id)) result.findings.push({id:randomUUID(),paragraphId:p.id,title:'Amendment not assessed by model',status:'context',explanation:'The model did not return an assessment of this recorded amendment. Inspect the wording and related clauses directly.',evidence:[{paragraphId:p.id,quote:p.text}],ruleIds:[],change:changeFor(p,baseline)});
  const recordLimits=[];
  if (wantTools && !useTools) recordLimits.push(`Document store not consulted by the model: ${fallback ? 'the provider refused tool calling' : 'this setup runs the single-call review'}.`);
  if (toolCalls.some(t=>t.result?.error?.code==='store_unavailable')) recordLimits.push('The document store could not be read during this review.');
  result.limits=validated.limits.concat(validationNotes).concat(recordLimits).concat('Model findings require lawyer verification. Exact citation validation does not establish the correctness of an interpretation. No automatic approval or sending occurs.');
  result.coverage=playbook.rules.filter(r=>r.enabled!==false).map(r=>({ruleId:r.id,status:result.findings.some(f=>f.ruleIds.includes(r.id)) ? 'examined':'not-assessed',findingIds:result.findings.filter(f=>f.ruleIds.includes(r.id)).map(f=>f.id)}));
  if (wantTools || citedOpt) {
    result.toolCalls=toolCalls.map(t=>({name:t.name,args:t.args,bytes:t.bytes,...(t.result?.error ? {error:t.result.error.code} : {})}));
    result.unverifiedRecordCitations=result.findings.reduce((n,f)=>n+(f.record||[]).filter(c=>!c.verified).length,0);
  }
  return attachComparison(result,document,baseline);
}

export function attachComparison(result,document,baseline) {
  const alignment=alignDocument(document,baseline);
  const changes=new Map(alignment.paragraphs.map(p=>[p.id,p.change]));
  for(const f of result.findings) f.change=changes.get(f.paragraphId)||'unknown';
  // Remove phantom ID-based amendment notices after sequence alignment.
  result.findings=result.findings.filter(f=>!(['Amendment for contextual review','Amendment not assessed by model'].includes(f.title) && f.change==='unchanged'));
  for(const p of alignment.paragraphs) {
    if(['changed','recorded'].includes(p.change) && !result.findings.some(f=>f.paragraphId===p.id))result.findings.push({id:randomUUID(),paragraphId:p.id,title:'Amendment for contextual review',status:'context',explanation:'The available text comparison identifies this amendment. Inspect it alongside related definitions and obligations; no reusable response has been established.',evidence:p.text ? [{paragraphId:p.id,quote:p.text}] : [{paragraphId:p.id,quote:p.originalText || p.comparisonText,source:'original'}],ruleIds:[],change:p.change,...(!p.text ? {deleted:true}: {})});
  }
  for(const p of alignment.deleted) result.findings.push({id:randomUUID(),paragraphId:p.id,title:'Removed paragraph',status:'context',deleted:true,explanation:'This wording exists in the supplied comparison version and is absent from the aligned current text. Inspect whether its obligation was removed, replaced or moved elsewhere; the comparison alone cannot establish the intended outcome.',evidence:[{paragraphId:p.id,quote:p.text,source:'baseline'}],ruleIds:[],change:'changed'});
  // Entire retained deletions have no current text available to quote.
  for(const f of result.findings) {
    const p=document.paragraphs.find(x=>x.id===f.paragraphId);
    if(!f.deleted && p && !p.text && p.originalText) {f.deleted=true;f.evidence=[{paragraphId:p.id,quote:p.originalText,source:'original'}];f.title='Recorded paragraph deletion';delete f.suggestedText;}
  }
  result.limits.push(...alignment.limits);
  for(const coverage of result.coverage)coverage.findingIds=result.findings.filter(f=>f.ruleIds.includes(coverage.ruleId)).map(f=>f.id);
  return result;
}

// Revise one finding (spec R6.1, T9): the lawyer gives a short instruction for a single finding; the model
// regenerates that finding only, with the same inputs and the instruction as matter context. Nothing is applied.
export async function reviseFinding({document,baseline=null,playbook,finding,instruction,context=null,reviewMode='own-paper'}) {
  checkInputs(document,playbook,baseline);
  if (!finding || typeof finding.paragraphId!=='string' || !document.paragraphs.some(p=>p.id===finding.paragraphId)) throw Object.assign(new Error('The finding to revise must name a paragraph in the document.'),{status:400});
  if (typeof instruction!=='string' || !instruction.trim() || instruction.length>2000) throw Object.assign(new Error('Give a short instruction (up to 2,000 characters).'),{status:400});
  const prompt=loadPrompt('review');
  const focus=`Revise exactly one finding. The lawyer's instruction for this finding: ${JSON.stringify(instruction.trim())}. Return findings containing only the revised finding for paragraph ${finding.paragraphId}; keep every other rule in the system prompt. Keep the title as a plain title; say in a few words what the revision changed in a \`revisionNote\` field on the finding.`;
  const call=await runModel({name:'revise',system:prompt.text+'\n\n'+focus,payload:{document,baseline,playbook:{...playbook,rules:playbook.rules.filter(r=>r.enabled!==false)},...(context ? {context} : {}),mode:reviewMode,previousFinding:{paragraphId:finding.paragraphId,title:finding.title,explanation:finding.explanation,proposedText:finding.proposedText||finding.suggestedText||null}}});
  const validated=validateFindings(call.data,document,playbook,{context});
  const revised=validated.findings.find(f=>f.paragraphId===finding.paragraphId)||validated.findings[0];
  if (!revised) throw new Error('The model returned no revised finding.');
  return {finding:{...revised,id:finding.id||revised.id,change:changeFor(document.paragraphs.find(p=>p.id===revised.paragraphId),baseline),revisedWith:instruction.trim()},notes:validated.notes,model:{...call.meta,promptFile:prompt.file.split(/[\\/]/).slice(-2).join('/')}};
}

/** The selection sent with a question, bounded: its text (up to 4,000 characters) and the ids of this document's paragraphs it covers; null when empty. */
export function askSelection(selection,document) {
  const text=typeof selection?.text==='string' ? selection.text.trim().slice(0,4000) : '';
  if (!text) return null;
  const ids=new Set(document.paragraphs.map(p=>p.id));
  return {text,paragraphIds:[...new Set((Array.isArray(selection.paragraphIds) ? selection.paragraphIds : []).filter(id=>typeof id==='string' && ids.has(id)))].slice(0,50)};
}
/** Ask's prompt with the store section's call limit filled in. */
export function loadAskPrompt(maxToolCalls=0) {
  const p=loadPrompt('ask');
  return { ...p, text: p.text.split('{maxToolCalls}').join(String(maxToolCalls)) };
}

/**
 * Ask (plan task 10). `agentic` (prepareAgenticReview in server/store/tools.js): with an executor that supports tools the
 * model reads the document store through the store tools and cites documents as { documentId, quote }, checked against
 * each document's text. `context` is the fallback for an executor without tools (server/store/context.js): the
 * counterparty's other documents go with the question, and citations are checked against them. Neither: the draft alone.
 */
export async function askQuestion({document,baseline=null,playbook,question,finding=null,selection=null,context=null,agentic=null,config=null,signal=null}) {
  checkInputs(document,playbook,baseline);
  if (typeof question!=='string' || !question.trim() || question.length>4000) throw new Error('Ask a question of up to 4,000 characters.');
  // Reconstruct selection context from current source, rather than forwarding a
  // stale client finding (or arbitrary instructions disguised as a finding).
  if(finding) {
    const paragraph=document.paragraphs.find(p=>p.id===finding.paragraphId);
    if(!paragraph) throw new Error('The selected passage is no longer present. Select it again.');
    if(finding.deleted || finding.evidence?.some(e=>e.source==='baseline' || e.source==='original')) throw new Error('This selection is removed wording. Review its source comparison directly; questions currently require a passage in the current agreement.');
    finding={paragraphId:paragraph.id,text:paragraph.text};
  }
  const cfg={...(config ? {config} : {}),...(signal ? {signal} : {})}; // signal: Ask's Stop
  let useTools=Boolean(agentic?.tools) && toolsSupported(config || getExecutorConfig());
  const docs=context?.documents?.length ? context.documents : null;
  // The passage selected in Word (17 Oct 2026): its text and the ids of its paragraphs in this document, as data.
  const sel=askSelection(selection,document);
  const base={document,baseline,playbook:{...playbook,rules:playbook.rules.filter(r=>r.enabled!==false)},question,finding,...(sel ? {selection:sel} : {})};
  let call, fallback=null;
  // Lenient and non-blocking (17 Oct 2026): a reply without a JSON object comes back as text, and the Claude CLI's single
  // call no longer blocks the server, so the pane's steps keep arriving while the model works.
  const once=(extra={})=>useTools
    ? runModel({...cfg,name:'ask',lenient:true,system:loadAskPrompt(agentic.tools.maxToolCalls).text,payload:{...base,...(agentic.brief ? {store:agentic.brief} : {}),...extra},tools:agentic.tools})
    : runModel({...cfg,name:'ask',lenient:true,system:loadAskPrompt(0).text,payload:{...base,...(docs ? {counterpartyDocuments:{counterparty:context.counterparty,documents:docs.map(({paragraphs,...d})=>d)}} : {}),...extra}});
  if (useTools) {
    try { call=await once(); }
    catch (e) { if (e.code!=='tools_unsupported') throw e; useTools=false; fallback=e.message; }
  }
  if (!call) call=await once();
  let raw=isAskAnswer(call.data) ? call.data : parseAskReply(call.raw), unchecked=false, retried=false;
  if (!raw) {
    // No JSON object: ask once more with the reply and a short correction; the first attempt's lookups still count.
    console.error(`Ask: the reply had no JSON object (${String(call.raw||'').length} characters); asking again.`);
    retried=true;
    const again=await once({previousReply:String(call.raw||'').slice(0,20000),correction:ASK_CORRECTION});
    const parsed=isAskAnswer(again.data) ? again.data : parseAskReply(again.raw);
    if (parsed) { raw=parsed; call={...again,toolCalls:[...(call.toolCalls||[]),...(again.toolCalls||[])]}; }
    else {
      // Still prose: show it, and say plainly that its sources could not be checked.
      const text=proseAnswer(again.raw)||proseAnswer(call.raw);
      if (text) { raw={answer:text,evidence:[],sources:[],ruleIds:[],limits:[]}; unchecked=true; }
    }
  }
  if (!raw || typeof raw.answer!=='string' || !raw.answer.trim()) throw new Error('No answer came back. Ask again.');
  if (raw.answer.length>12000) raw={...raw,answer:proseAnswer(raw.answer)};
  // Flag, never refuse (9 Oct 2026, audit item 2): unverifiable quotes, unknown rules and a missing basis are said, not hidden.
  const evidence=(Array.isArray(raw.evidence) ? raw.evidence : []).slice(0,30).map(e=>{const quote=typeof e?.quote==='string' ? e.quote : ''; const pid=typeof e?.paragraphId==='string' ? e.paragraphId : ''; return {paragraphId:pid,quote,verified:Boolean(quote.trim()) && document.paragraphs.some(p=>p.id===pid && p.text.includes(quote))};});
  const rawRules=(Array.isArray(raw.ruleIds) ? raw.ruleIds : []).filter(x=>typeof x==='string'); const ruleIds=rawRules.filter(id=>playbook.rules.some(r=>r.id===id && r.enabled!==false));
  // Store citations: against the store through the resolver (tools), or against the documents sent with the question.
  const rawSources=(Array.isArray(raw.sources) ? raw.sources : []).slice(0,20);
  let lookup=null;
  if (useTools && typeof agentic?.citations?.resolve==='function') lookup=await resolveCitations(rawSources,agentic.citations.resolve);
  else if (docs) { const byId=new Map(docs.map(d=>[Number(d.documentId),{text:citableText({paragraphs:d.paragraphs||[]}),counterparty:context.counterparty||null}])); lookup=id=>byId.get(id) ?? null; }
  // Each source names the counterparty the store files that document under, and says when it is not the one under
  // review (security review, 17 Oct 2026): the tools read the whole store, so an answer about one counterparty can
  // quote another's documents, and the lawyer must see that. Read from the store, never from the model's own claim.
  const scopeCp=agentic?.citations?.counterparty || context?.counterparty || null;
  const sources=rawSources.map(c=>{ const v=checkCitation(c,lookup,null); delete v.counterparty; const src=lookup && v.documentId!==null ? lookup(v.documentId) : null; const name=typeof src?.counterparty==='string' && src.counterparty ? src.counterparty : null; const other=Boolean(name && scopeCp && name.toLowerCase()!==String(scopeCp).toLowerCase()); return {...v,...(name ? {counterparty:name} : {}),...(other ? {otherCounterparty:true} : {})}; });
  const others=[...new Set(sources.filter(c=>c.otherCounterparty).map(c=>c.counterparty))];
  const notes=[...(evidence.some(e=>!e.verified) ? [`${evidence.filter(e=>!e.verified).length} quote(s) could not be verified against the agreement and are shown as unverified.`] : []), ...(sources.some(c=>!c.verified) ? [`${sources.filter(c=>!c.verified).length} quote(s) from other documents could not be verified against the store and are shown as unverified.`] : []), ...(others.length ? [`The answer quotes documents of another counterparty (${others.join(', ')}); they are precedent, not this matter's record.`] : []), ...(rawRules.length>ruleIds.length ? [`Rule reference(s) not in the active playbook: ${rawRules.filter(id=>!ruleIds.includes(id)).join(', ')}.`] : []), ...(!unchecked && !evidence.some(e=>e.verified) && !sources.some(c=>c.verified) ? ['No passage of the agreement was quoted in support; check the answer against the agreement.'] : [])];
  const storeLimits=[...(agentic?.tools && !useTools && !docs ? [`Document store not consulted: ${fallback ? 'the provider refused tool calling' : 'this setup answers in a single call'}.`] : []), ...((call.toolCalls||[]).some(t=>t.result?.error?.code==='store_unavailable') ? ['The document store could not be read while answering.'] : [])];
  const toolCalls=Array.isArray(call.toolCalls) ? call.toolCalls.map(t=>({name:t.name,args:t.args,bytes:t.bytes,...(t.result?.error ? {error:t.result.error.code} : {})})) : null;
  return {answer:raw.answer,evidence,ruleIds,...(unchecked ? {unchecked:true} : {}),...(sources.length ? {sources} : {}),engine:'live-model',limits:[...notes,...storeLimits,...(Array.isArray(raw.limits) ? raw.limits.filter(x=>typeof x==='string') : [])],model:{...call.meta,agentic:useTools,storeDocuments:useTools ? null : docs?.length || 0,...(retried ? {retried:true} : {})},...(toolCalls ? {toolCalls} : {})};
}
