// SPDX-License-Identifier: GPL-3.0-or-later
// The v1 rule engine: the product's former Sample mode, moved here by the v2 trim (product spec section 2, hardening
// H-04) and kept unchanged as a trivial baseline of the benchmark (BENCHMARK-V2.md section 9). Deterministic text
// checks, no model call. `run.mjs --demo` runs it through review-one.mjs; the product's own helpers (makeReview,
// changeFor, attachComparison) are imported, not copied, so its output has the product's shape.
import { randomUUID } from 'node:crypto';
import { makeReview, changeFor, attachComparison, checkInputs } from '../../contract-review/server/review.js';

export const WORD_NUMBERS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, ten:10, twelve:12, thirty:30, sixty:60, ninety:90 };
export const normalize = text => String(text || '').toLowerCase().replace(/\b(one|two|three|four|five|six|seven|ten|twelve|thirty|sixty|ninety)\b/g, x => WORD_NUMBERS[x]);
export const units = (text, unit) => {
  // A partial quantity is worse than no assessment: do not read the "five"
  // in "twenty-five", or the suffix of a comma-formatted number, as a limit.
  const source=String(text || '');
  const stripped=source.replace(new RegExp(`\\b(?:thirty|sixty|ninety)\\s+${unit}s?\\b`, 'gi'),'');
  if(new RegExp(`\\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|quarter|point)\\b[^.;:\\n]{0,40}\\b${unit}s?\\b`, 'i').test(stripped)) return [];
  return [...normalize(source).matchAll(new RegExp(`(?<![\\d.,])\\b(\\d+(?:\\.\\d+)?)\\s*[- ]?${unit}s?\\b`, 'g'))].map(m => Number(m[1]));
};
const ruleText = r => [r.title,r.topic,r.guidance,r.conditions,r.fallback].map(x => typeof x === 'string' ? x : JSON.stringify(x || '')).join(' ');
const topicPatterns = {
  duration:/duration|confidentiality.*term|survival|confidentiality period/i,
  purpose:/permitted use|purpose|residual|mutuality/i,
  retention:/retention|return.*destr|backup/i,
  liability:/liability|liability cap/i,
  indemnity:/indemn/i,
  payment:/payment|invoice/i,
  completeness:/complete agreement|completeness|missing|precedence|incorporat/i,
  history:/prior decision|exception|negotiation history/i,
};

export function localReview(document, baseline, playbook) {
  const result = makeReview(document,baseline,playbook,'local-rules');
  const active = playbook.rules.filter(r=>r.enabled!==false);
  const matchingRules = topic => active.filter(r=>r.topic==='custom' ? false : r.topic===topic || (!r.topic && topicPatterns[topic]?.test(r.title || '')));
  const ruleFor = topic => matchingRules(topic)[0];
  const evidence = p => ({paragraphId:p.id,quote:p.text});
  const add = (p,topic,title,status,explanation,extra=[],suggestedText) => {
    const rule = ruleFor(topic);
    const ambiguous=matchingRules(topic).length>1;
    result.findings.push({id:randomUUID(),paragraphId:p.id,title,status:rule && !ambiguous ? status : 'context',explanation:ambiguous ? `Multiple enabled rules address this topic. The offline checker cannot resolve their conditions or precedence. ${explanation}` : rule ? explanation : `${explanation} No saved rule for this topic determines a response.`,evidence:[p,...extra.filter(x=>x.id!==p.id)].map(evidence),ruleIds:matchingRules(topic).map(r=>r.id),change:changeFor(p,baseline),...(suggestedText && !ambiguous ? {suggestedText}: {})});
  };
  const paras=document.paragraphs;
  const all=paras.map(p=>p.text).join('\n');
  for (const p of paras) {
    const t=normalize(p.text);
    if (/confidential|non.disclosure|trade secret/.test(t) && /year|indefinit|perpetu|surviv/.test(t)) {
      const r=ruleFor('duration'), guidance=r ? ruleText(r) : '', limits=units(guidance,'year'), max=limits.length ? Math.max(...limits) : null;
      const general=p.text.toLowerCase().split(/(?:except|provided|however|but|trade secrets?)/)[0];
      const years=units(general,'year');
      const pureSecret=/trade secret/.test(t) && !/confidential (information|obligation)|confidentiality/.test(t);
      const indefinite=/indefinit|perpetu|without time limit/.test(general);
      const referencedDuration=/term of confidentiality/.test(t) && paras.some(x=>x.id!==p.id && /confidential/i.test(x.text) && units(x.text,'year').length);
      const uncertain=!pureSecret && !referencedDuration && (!years.length && !indefinite || !/after|from|following|termination|disclosure|effective date/.test(t));
      const exceeds=!pureSecret && (indefinite || max!==null && years.some(n=>n>max));
      const status=exceeds || uncertain ? 'attention' : max===null || referencedDuration ? 'context' : 'within-guidance';
      const suggestedText=exceeds && !indefinite && years.length===1 && max!==null && /\b\d+(?:\.\d+)?\s+years\b/i.test(p.text) ? p.text.replace(/\b\d+(?:\.\d+)?(?=\s+years\b)/i,String(max)) : undefined;
      add(p,'duration',pureSecret ? 'Separate trade-secret protection' : 'Confidentiality duration',status,pureSecret ? 'This sentence addresses trade secrets separately. Verify that general confidential information has its own duration and that the saved guidance permits this distinction.' : referencedDuration ? 'This survival provision uses the separately stated Term of Confidentiality. Read that duration together with this provision; survival does not itself establish an indefinite period.' : max===null ? 'The saved guidance does not provide a numerical duration this demonstration can reliably apply. Inspect the duration and trigger together.' : exceeds ? `The general confidentiality period appears to exceed the ${max}-year limit stated in the saved guidance. Separate trade-secret protection does not extend general confidentiality automatically.` : uncertain ? 'The duration or its starting event is unclear to this bounded checker. Read the obligation and survival provisions together.' : `The stated general period is within the saved ${max}-year numerical limit. Check the starting event and any separate survival language; this is not contract approval.`,referencedDuration ? paras.filter(x=>x.id!==p.id && /confidential/i.test(x.text) && units(x.text,'year').length).slice(0,1) : [],suggestedText);
    }
    if (/residual|unaided memory|product development|develop.*products/.test(t)) {
      const negative=/\b(no|not|shall not|may not|prohibit)\b.{0,65}(residual|unaided memory|develop)/.test(t);
      const r=ruleFor('purpose');
      add(p,'purpose','Use rights and stated purpose',negative ? 'context' : 'attention',negative ? 'This text appears to restrict residual or development use. Check the exact scope against the permitted-purpose clause.' : 'This wording may permit use beyond evaluating the relationship. Compare the grant with the purpose restriction; a general confidentiality obligation does not by itself resolve an additional use right.',paras.filter(x=>x.id!==p.id && /solely|permitted purpose|evaluat/i.test(x.text)).slice(0,2));
    }
    if (/backup|back.up|retain(?:ed)? (?:copies|confidential|information|records)|retention|archival/.test(t) && /confidential|copies|information|records/.test(t)) {
      const direct=/remain.{0,35}(confidential|bound|subject|protect)|continu.{0,35}(confidential|obligation|protect)|subject to.{0,35}(agreement|obligation|confidential)/.test(t);
      const related=paras.filter(x=>x.id!==p.id && /retain|backup|archiv/i.test(x.text) && /remain|continue|subject to/i.test(x.text));
      const dangerous=/free of|without.{0,20}(restriction|obligation)|not.{0,20}(bound|subject)|business use/.test(t) || related.some(x=>/not.{0,20}(bound|subject)|without.{0,20}(restriction|obligation)/i.test(x.text));
      add(p,'retention','Protection of retained copies',dangerous || !direct && !related.length ? 'attention' : 'context',dangerous ? 'The retention language appears to remove protection or permit business use. Compare this with the saved conditions for retained copies.' : direct || related.length ? 'Continuing protection is referenced. Check both the purpose restriction and survival period for retained copies; a backup exception alone is not a reason to propose an amendment.' : 'This retention clause does not itself establish continuing protection. Check whether another provision keeps retained copies confidential and restricts their use.',related.slice(0,2));
    }
    if (/liability|aggregate.*cap|uncapped/.test(t)) {
      const mandatoryOnly=/cannot lawfully be limited/.test(t) && /contractual.{0,50}subject to/.test(t);
      const exclusions=!mandatoryOnly && /unlimited|uncapped|shall not apply|does not apply|not subject|excluded from|without limit/.test(t);
      const rule=ruleFor('liability'), gt=rule ? normalize(ruleText(rule)) : '';
      const max=/twice|2 times|2x/.test(gt) ? 2 : /fees/.test(gt) ? 1 : null;
      const multiplier=/three times|3 times|3x/.test(t) ? 3 : /twice|2 times|2x/.test(t) ? 2 : /fees/.test(t) ? 1 : null;
      const months=units(p.text,'month');
      const related=paras.filter(x=>x.id!==p.id && /uncapped|unlimited|cap.{0,20}(not apply|exclude)|not subject to.{0,20}cap|liability.*schedule/i.test(x.text));
      const materialRelated=related.some(x=>!/cannot lawfully be limited/.test(x.text.toLowerCase()));
      add(p,'liability','Liability cap and exceptions',!mandatoryOnly && (exclusions && (!/except for unlimited claims/.test(t) || materialRelated) || materialRelated || max!==null && multiplier>max || months.some(n=>n!==12)) ? 'attention' : 'context',exclusions ? 'This clause contains a cap exclusion or unlimited exposure. Identify the affected obligations and compare them with the saved guidance; this checker cannot determine which liabilities must legally remain unlimited.' : related.length ? 'A numerical cap appears here, but other supplied wording may change its reach. Review these provisions together before relying on the cap.' : 'Check the fee base, measurement period and exclusions together. The existence of a numerical cap does not establish the exposure for every obligation.',related.slice(0,3));
    }
    if (/indemnif|indemnity/.test(t)) {
      const broad=/any breach|all (claims|losses)|first.party|any and all/.test(t);
      const narrow=/third.party/.test(t)&&/intellectual property|infringe/.test(t);
      add(p,'indemnity','Indemnity scope and liability treatment',broad ? 'attention' : 'context',broad ? 'The indemnity appears broader than third-party product IP infringement. Inspect the covered losses, exclusions and defence process, and whether the liability cap applies.' : narrow ? 'The clause refers to third-party IP claims. Check exclusions, defence control and liability treatment before relying on the apparent scope.' : 'The covered claims are not clearly limited to third-party product IP infringement in this text. Check the scope, procedure and liability treatment.',paras.filter(x=>x.id!==p.id && /liability|cap/i.test(x.text)).slice(0,2));
    }
    if (/invoice|payment|payable/.test(t) && /day|due|schedule|order form/.test(t)) {
      const rule=ruleFor('payment'), days=units(p.text,'day'), permitted=rule ? units(ruleText(rule),'day') : [], max=permitted.length ? Math.max(...permitted) : null;
      const competing=paras.filter(x=>x.id!==p.id && /payment|invoice/i.test(x.text) && /override|prevail|precedence|not supplied|not provided/i.test(x.text));
      const excess=max!==null && days.some(n=>n>max);
      const suggestedText=excess && days.length===1 && /\b\d+(?:\.\d+)?\s+days\b/i.test(p.text) ? p.text.replace(/\b\d+(?:\.\d+)?(?=\s+days\b)/i,String(max)) : undefined;
      add(p,'payment','Invoice payment period',competing.length ? 'context' : excess ? 'attention' : days.length && max!==null ? 'within-guidance' : 'context',competing.length ? 'Another supplied provision overrides or qualifies these payment terms. The actual due date cannot be established from this clause alone; obtain any missing controlling schedule.' : max===null ? 'The saved guidance has no numerical payment limit this checker can apply. Confirm due dates and any competing order-form terms.' : excess ? `The stated period exceeds the saved ${max}-day limit. Inspect whether disputed invoices or another document alter the term. The optional wording only changes the numerical period.` : days.length ? `The numerical period is within the saved ${max}-day limit. Check invoice-dispute conditions and competing payment terms.` : 'The due date depends on another provision or document. Confirm the actual payment period before applying the guidance.',competing,competing.length ? undefined : suggestedText);
    }
    if (/schedule|annex|attachment|exhibit|order form/.test(t) && /incorporat|subject to|set out|specified|prevail|govern|provided in/.test(t)) {
      const references=[...t.matchAll(/\b(schedule|annex|exhibit|attachment)\s+([a-z0-9]+)\b/g)].map(m=>m[0]);
      const missing=references.filter(ref=>!paras.some(x=>x.id!==p.id && normalize(x.text).startsWith(ref)));
      add(p,'completeness','Incorporated terms and precedence',missing.length ? 'attention' : 'context',missing.length ? `A referenced document (${missing.join(', ')}) was not identified as a supplied section. It may change these terms; absence from the supplied text does not mean no obligation exists.` : 'Check the referenced terms and any precedence provision together. A heading match alone cannot establish that the complete attachment was supplied.');
    }
  }
  for(const f of result.findings) {
    const r=active.find(r=>f.ruleIds.includes(r.id));
    if(!r)continue;
    const key=r.topic==='duration' ? 'maxYears' : r.topic==='payment' ? 'maxDays' : null;
    const values=key ? units(ruleText(r),key==='maxYears' ? 'year':'day') : [];
    if(key && typeof r.conditions?.[key]==='number' && values.length && r.conditions[key]!==Math.max(...values)) {
      f.status='context'; delete f.suggestedText;
      f.explanation='The saved numerical condition and written guidance disagree. Reconcile the playbook entry before relying on a threshold comparison; no replacement is proposed.';
    }
  }
  for (const p of paras) {
    if (['changed','recorded'].includes(changeFor(p,baseline)) && !result.findings.some(f=>f.paragraphId===p.id)) {
      add(p,'unsupported','Amendment for contextual review','context','This paragraph differs from the available comparison text. Read the revised wording alongside related definitions and obligations. The bounded checker has no reliable interpretation or reusable response for this amendment.');
    }
  }
  // Keep each amendment inspectable, while presenting a linked issue once.
  // A cap definition or retained-copy exception is evidence for the earlier
  // operative clause, not a second request for the same decision.
  for (let i=0;i<result.findings.length;i++) {
    const f=result.findings[i];
    if(f.status!=='attention') continue;
    const earlier=result.findings.slice(0,i).find(other=>other.status==='attention' && other.title===f.title && other.ruleIds.some(id=>f.ruleIds.includes(id)) && other.evidence.some(e=>e.paragraphId===f.paragraphId));
    if(earlier) {f.status='context';f.explanation=`Related wording for “${earlier.title}” above. ${f.explanation}`;delete f.suggestedText;}
  }
  for (const rule of active) {
    const findings=result.findings.filter(f=>f.ruleIds.includes(rule.id));
    result.coverage.push({ruleId:rule.id,status:findings.length ? 'examined' : 'not-assessed',findingIds:findings.map(f=>f.id),note:findings.length ? 'Bounded pattern checks; not comprehensive legal interpretation.' : 'No reliable assessment produced. Absence of a finding is not compliance.'});
  }
  result.limits.push('Offline demonstration: deterministic text checks, not an LLM or comprehensive legal review. Negation, defined terms and complex clause interactions require human inspection.','Only supplied text and enabled provisional guidance were examined. No mailbox, prior deal history or external legal sources were accessed.','Within guidance describes a bounded comparison, never approval or permission to sign.');
  if (!baseline) result.limits.push('No comparison version supplied. Retained revisions do not establish everything changed since the document was last sent.');
  else if (baseline.paragraphs.some(p=>!paras.some(q=>q.id===p.id))) result.limits.push('The comparison version contains paragraphs absent from the current document. Review those deletions in the document comparison; current-text findings cannot fully assess removed obligations.');
  return result;
}

/** A whole review as the product's Sample mode returned it: the engine's findings with the comparison attached. */
export function reviewLocal({ document, baseline = null, playbook }) {
  checkInputs(document, playbook, baseline);
  return attachComparison(localReview(document, baseline, playbook), document, baseline);
}

/** The engine's answer to a question, as the product's Sample mode gave it: the existing checks that match. */
export function askLocal({ document, baseline = null, playbook, question, finding = null }) {
  checkInputs(document, playbook, baseline);
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw new Error('Ask a question of up to 4,000 characters.');
  if(finding) {
    const paragraph=document.paragraphs.find(p=>p.id===finding.paragraphId);
    if(!paragraph) throw new Error('The selected passage is no longer present. Select it again.');
    if(finding.deleted || finding.evidence?.some(e=>e.source==='baseline' || e.source==='original')) throw new Error('This selection is removed wording. Review its source comparison directly; questions currently require a passage in the current agreement.');
    finding={paragraphId:paragraph.id,text:paragraph.text};
  }
  const review=localReview(document,baseline,playbook);
  const words=question.toLowerCase().match(/[a-z]{4,}/g) || [];
  const selected=finding ? review.findings.filter(f=>f.paragraphId===finding.paragraphId) : review.findings.filter(f=>words.some(w=>(f.title+' '+f.explanation+' '+f.evidence.map(e=>e.quote).join(' ')).toLowerCase().includes(w)));
  const matches=selected.slice(0,3);
  return {answer:matches.length ? `These existing checks may help with your question:\n\n${matches.map(f=>`${f.title}: ${f.explanation}`).join('\n\n')}` : 'The offline demonstration cannot reliably answer this question. Inspect the agreement and saved guidance, or configure live assistance. No conclusion has been inferred from missing evidence.',evidence:[...new Map(matches.flatMap(f=>f.evidence).map(e=>[e.paragraphId,e])).values()],ruleIds:[...new Set(matches.flatMap(f=>f.ruleIds))],engine:'local-rules',limits:['Offline assistance retrieves bounded checks; it does not interpret arbitrary questions or search historical documents.']};
}
