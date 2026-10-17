// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the long-bundle part of the tough eval: the Cloud Service Agreement from build.mjs followed by a Data
// Processing Agreement and a Service Level Agreement, as a real deal arrives (about twice the length of the agreement
// alone). Both annexes are Common Paper standard terms (CC BY 4.0) with filled-in cover terms written for this suite.
// Four kinds of variant, all reviewed against playbook-bundle.json (the agreement's 19 rules plus 8 for the annexes):
//   B00          the clean bundle (must raise nothing)
//   BA28..BA38   one deviation planted in an annex
//   BD07..BD10   one harmless edit in an annex (must not be flagged)
//   BL01..BL24   an agreement plant from build.mjs, now inside the long bundle: the same plant scored short and long
//                separates the effect of length from the effect of the plant
//   BK2..BK6     a development markup from build.mjs (seven agreement deviations, two harmless edits) plus two annex
//                deviations and one harmless annex edit
// Paragraph ids of the agreement (p1..p145) are unchanged; annex paragraphs are a1, a2, ...
// Output: base-bundle.json, playbook-bundle.json, variants/B*.json, manifest-bundle.json (with hashes).
// Usage: node tough-eval/build.mjs && node tough-eval/build-bundle.mjs
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { numberedParagraphs } from './numbering.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = s => createHash('sha256').update(s).digest('hex');
const csaManifest = JSON.parse(readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const csaBase = JSON.parse(readFileSync(path.join(here, 'base.json'), 'utf8'));
const csaVariant = id => JSON.parse(readFileSync(path.join(here, 'variants', `${id}.json`), 'utf8'));

const DPA_TERMS = [
  'Data Processing Agreement',
  'Agreement: This DPA supplements the Cloud Service Agreement between Halden Cloud, Inc. ("Provider") and Northwind Analytics Ltd ("Customer"), and forms part of it.',
  'Approved Subprocessors: Nimbus Hosting Ltd (Ireland; hosting and storage of the Cloud Service); Relay Mail Ltd (United Kingdom; transactional email).',
  'Provider Security Contact: security@halden.example.',
  'Security Policy: As defined in the Agreement. Provider will maintain annually updated reports or annual certifications of compliance with SOC 2 Type II.',
  'Governing Member State: UK Transfers: the laws of England and Wales. EEA Transfers: Ireland.',
  'Categories of Data Subjects: Customer’s employees, and Customer’s end users and customers.',
  'Categories of Personal Data: Name; contact information such as email, phone number, or address; user activity and analysis such as device information or IP address.',
  'Special Category Data: No special category data is Processed.',
  'Frequency of Transfer: Continuous.',
  'Nature and Purpose of Processing: Receiving, holding, using, protecting and erasing Customer Personal Data, to provide and maintain the Service.',
  'Duration of Processing: For the duration of the Agreement, and until the Customer Personal Data is returned or deleted under Section 7 of the DPA Standard Terms.',
  'DPA Standard Terms',
];
const SLA_TERMS = [
  'Service Level Agreement',
  'SLA: The Order Form incorporates the Common Paper Service Level Agreement Standard Terms Version 2.0, with the details below.',
  'Target Uptime: 99.9%.',
  'Uptime Credit: Where Actual Uptime Percentage is from 99.0% to below the Target Uptime, 5% of the monthly Cloud Service Fee; from 95.0% to below 99.0%, 10%; below 95.0%, 25%.',
  'Scheduled Downtime: Routine maintenance between 22:00 and 02:00 UK time on Sundays.',
  'Target Response Time: 4 business hours.',
  'Response Time Credit: 2% of the monthly Cloud Service Fee for each time Provider fails to meet the Target Response Time.',
  'Support Channel: support@halden.example.',
  'SLA Standard Terms',
];

// Rules for the annexes, written so the clean bundle meets every preferred or acceptable position.
const ANNEX_RULES = [
  { id: 'C-20', title: 'Security incident notification', topic: 'data protection', guidance: 'We must hear about any personal data breach quickly enough to meet our own 72-hour regulatory deadline, and "Security Incident" must cover every personal data breach, not only those the Provider has confirmed or finished investigating.',
    preferred: 'Notice without undue delay and no later than 72 hours after the Provider becomes aware; Security Incident means any personal data breach under the GDPR.', acceptable: 'A shorter notice period (e.g. 24 or 48 hours).', escalation: 'Notice later than 72 hours after awareness, or a definition of Security Incident narrowed by confirmation, investigation, encryption or harm thresholds. Escalate to the Data Protection Officer.', hardLine: 'No obligation to notify Customer of a Security Incident.' },
  { id: 'C-21', title: 'Subprocessors', topic: 'data protection', guidance: 'Customer Personal Data may only go to subprocessors we have approved, and we must get written notice of changes early enough to object.',
    preferred: 'Prior approval of subprocessors; at least 10 business days’ written notice of any change, with a right to object within 30 days.', acceptable: 'General written authorisation with at least 10 business days’ notice and a right to object.', escalation: 'Notice shorter than 10 business days, notice only by updating a web page, or no right to object.', hardLine: 'Provider may engage any subprocessor without notice.' },
  { id: 'C-22', title: 'Liability for subprocessors', topic: 'data protection', guidance: 'The Provider must stay fully responsible for what its subprocessors do with our data.',
    preferred: 'Provider remains fully liable for its subprocessors’ acts and omissions.', acceptable: 'Same, with the Provider passing equivalent data protection terms down to each subprocessor.', escalation: 'Any limitation or removal of the Provider’s responsibility for subprocessors.', hardLine: 'Provider excluded from liability for subprocessors.' },
  { id: 'C-23', title: 'Audit and security reports', topic: 'data protection', guidance: 'We need enough evidence to show our own compliance: independent audit reports and answers to security questionnaires. We accept that audit rights are exercised through reports and questionnaires rather than on-site visits.',
    preferred: 'Compliance information on request, a copy of the Provider’s current independent audit report on written request, and answers to security questionnaires at least once a year; records kept for 3 years.', acceptable: 'Audit rights exercised only through reports and questionnaires, as above.', escalation: 'Removal of access to independent audit reports, questionnaires less often than once a year, or Customer paying for routine compliance evidence.', hardLine: 'No audit rights or compliance evidence at all.' },
  { id: 'C-24', title: 'Return and deletion of personal data', topic: 'data protection', guidance: 'When the DPA ends the Provider returns or deletes our personal data as we instruct, keeping only what the law requires.',
    preferred: 'Return or deletion at Customer’s instruction, except where storage is required or authorised by Applicable Law.', acceptable: 'Deletion within a stated period, with a certificate of deletion on request.', escalation: 'Any right for the Provider to keep personal data for its own purposes, or deletion only at the Provider’s discretion.', hardLine: 'No obligation to return or delete personal data.' },
  { id: 'C-25', title: 'DPA liability and precedence', topic: 'data protection', guidance: 'Data protection claims must keep the protection the Agreement gives them (they are Increased Claims under its 3x cap), and on data protection matters the transfer clauses and the DPA must prevail over the Agreement.',
    preferred: 'DPA liability subject to the Agreement’s limits (so privacy breaches fall under the Increased Cap); order of precedence: transfer clauses, then the DPA, then the Agreement.', acceptable: 'A separate DPA cap at least equal to the Increased Cap Amount.', escalation: 'A separate DPA cap below the Increased Cap Amount, or the Agreement prevailing over the DPA or the transfer clauses.', hardLine: 'DPA liability limited to service credits, or excluded.' },
  { id: 'C-26', title: 'Service levels and credits', topic: 'service levels', guidance: 'The platform is business-critical: we need a monthly uptime commitment of at least 99.5% with meaningful credits, and a fair window to claim them.',
    preferred: 'Target Uptime of 99.9% per month; credits of at least 5%, 10% and 25% of the monthly fee by band; claims within 7 days of month end; credits capped at no less than 8% of annual fees; response within 4 business hours.', acceptable: 'Target Uptime from 99.5%; claim window of at least 7 days; credit cap of at least 5% of annual fees; response within one business day.', escalation: 'Target Uptime below 99.5%, a claim window under 7 days, credits capped below 5% of annual fees, or no response-time commitment.', hardLine: 'No uptime commitment.' },
  { id: 'C-27', title: 'Service level remedies', topic: 'service levels', guidance: 'Service credits may be the exclusive remedy for missing the uptime and response targets only. They must not replace our other remedies under the Agreement, and repeated failure must let us leave with a refund.',
    preferred: 'Credits are the exclusive remedy only for missing the Target Uptime and Target Response Time; termination with a prorated refund after failures in 2 of any 3 consecutive months.', acceptable: 'Termination after failures in 3 of any 6 months, with a prorated refund.', escalation: 'Credits made the exclusive remedy for other failures (performance, data loss, security), or the termination right or its refund removed.', hardLine: 'No termination right for chronic failure.' },
];

// Annex plants: same shape as build.mjs. `in` must be unique among the annex paragraphs.
const PLANTS = [
  { id: 'P28', level: 'easy', rules: ['C-20'], what: 'Breach notice within 7 days instead of 72 hours', edits: [{ in: 'Upon becoming aware of any Security Incident', find: 'no later than 72 hours', to: 'no later than 7 days' }], fix: [{ require: ['72 hours|seventy-two'], forbid: ['7 days'] }] },
  { id: 'P29', level: 'easy', rules: ['C-26'], what: 'Target Uptime 99.0%', edits: [{ in: 'Target Uptime: 99.9%', find: '99.9%', to: '99.0%' }], fix: [{ num: 'Target Uptime: ([0-9.]+)%', min: 99.5 }] },
  { id: 'P30', level: 'medium', rules: ['C-21'], what: 'Subprocessor changes by web update, no advance notice', edits: [{ in: '(a) Provider will not provide, transfer', find: 'Provider will inform Customer at least 10 business days in advance and in writing of any intended changes to the Approved Subprocessors whether by addition or replacement of a Subprocessor, which allows Customer to have enough time to object to the changes before the Provider begins using the new Subprocessor(s).', to: 'Provider will update the list of Approved Subprocessors on its website when it adds or replaces a Subprocessor.' }], fix: [{ require: ['10 business days|ten business days'] }] },
  { id: 'P31', level: 'medium', rules: ['C-22'], what: 'Provider no longer liable for subprocessors (sentence deleted)', edits: [{ in: '(d) Provider remains fully liable', find: 'Provider remains fully liable for all obligations subcontracted to its Subprocessors, including the acts and omissions of its Subprocessors in Processing Customer Personal Data. ', to: '' }], fix: [{ require: ['liable|responsib'] }] },
  { id: 'P32', level: 'hard', rules: ['C-27', 'C-14'], what: 'SLA credits made the exclusive remedy for any performance failure (undercuts the Agreement’s warranty remedy)', edits: [{ in: 'Exclusive Remedy.  This SLA describes', find: 'for any failure of the Cloud Service to meet the Target Uptime and for any inability to meet the Target Response Time.', to: 'for any failure of the Cloud Service to be available or to perform in accordance with the Agreement, including any failure to meet the Target Uptime or the Target Response Time.' }], fix: [{ require: ['Target Uptime'], forbid: ['perform in accordance'] }] },
  { id: 'P33', level: 'hard', rules: ['C-20'], what: 'Security Incident narrowed to breaches confirmed after investigation (definition)', edits: [{ in: '“Security Incident” means', find: 'means a Personal Data Breach as defined in Article 4 of the GDPR.', to: 'means a Personal Data Breach as defined in Article 4 of the GDPR that Provider has confirmed, following completion of its forensic investigation, resulted in unauthorized access to unencrypted Customer Personal Data.' }], fix: [{ require: ['Personal Data Breach'], forbid: ['confirmed', 'forensic', 'unencrypted'] }] },
  { id: 'P34', level: 'hard', rules: ['C-25'], what: 'Agreement made to prevail over the DPA and the transfer clauses', edits: [{ in: 'This DPA forms part of and supplements the Agreement.', find: '(1) the EEA SCCs or the UK Addendum, (2) this DPA, and then (3) the Agreement.', to: '(1) the Agreement, (2) the EEA SCCs or the UK Addendum, and then (3) this DPA.' }], fix: [{ require: ['this DPA'], forbid: ['\\(1\\) the Agreement'] }] },
  { id: 'P35', level: 'hard', rules: ['C-25', 'C-02'], what: 'Separate DPA cap of 3 months’ fees (undercuts the 3x Increased Cap)', edits: [{ in: 'Liability Caps and Damages Waiver.  To the maximum extent', find: 'will be subject to the waivers, exclusions, and limitations of liability stated in the Agreement.', to: 'will be subject to the waivers and exclusions stated in the Agreement and will not exceed, in aggregate, the Fees paid by Customer in the 3 months before the claim.' }], fix: [{ forbid: ['3 months'] }] },
  { id: 'P36', level: 'medium', rules: ['C-24'], what: 'Provider may keep personal data for its own purposes at expiry', edits: [{ in: '(a) After the DPA expires', find: 'Provider will return or delete Customer Personal Data at Customer’s instruction unless', to: 'Provider may retain Customer Personal Data for its internal business purposes, and will otherwise return or delete it at Customer’s instruction unless' }], fix: [{ require: ['return or delete'], forbid: ['internal business purposes'] }] },
  { id: 'P37', level: 'medium', rules: ['C-26'], what: 'Credit claims within 24 hours of month end', edits: [{ in: 'Requesting A Service Credit.', find: 'within 7 days of the end of the month', to: 'within 24 hours of the end of the month' }], fix: [{ num: 'within ([0-9]+) days', min: 7, forbid: ['24 hours'] }] },
  { id: 'P38', level: 'hard', rules: ['C-26'], what: 'Service credits capped at 1% of annual fees', edits: [{ in: 'Service Credit Limitations.', find: 'more than 8% of Cloud Service Fees', to: 'more than 1% of Cloud Service Fees' }], fix: [{ num: '([0-9.]+)% of Cloud Service Fees', min: 5 }] },
  { id: 'D07', kind: 'benign', level: 'benign', rules: ['C-20'], what: 'Breach notice within 48 hours', edits: [{ in: 'Upon becoming aware of any Security Incident', find: 'no later than 72 hours', to: 'no later than 48 hours' }] },
  { id: 'D08', kind: 'benign', level: 'benign', rules: ['C-26'], what: 'Target Uptime 99.95%', edits: [{ in: 'Target Uptime: 99.9%', find: '99.9%', to: '99.95%' }] },
  { id: 'D09', kind: 'benign', level: 'benign', rules: ['C-26'], what: 'Credit claims within 30 days', edits: [{ in: 'Requesting A Service Credit.', find: 'within 7 days of the end of the month', to: 'within 30 days of the end of the month' }] },
  { id: 'D10', kind: 'benign', level: 'benign', rules: ['C-26'], what: 'Target Response Time 2 business hours', edits: [{ in: 'Target Response Time: 4 business hours', find: '4 business hours', to: '2 business hours' }] },
];
// Agreement plants that also run inside the bundle (development split only; mixed levels; one insertion).
const LENGTH_PAIRED = ['P01', 'P02', 'P06', 'P12', 'P17', 'P20', 'P22', 'P24'];
const MARKUPS = { BK2: ['K02', 'P28', 'P34', 'D08'], BK4: ['K04', 'P30', 'P35', 'D07'], BK5: ['K05', 'P32', 'P37', 'D10'], BK6: ['K06', 'P29', 'P33', 'D09'] };

async function standardTerms(file, startsAt, last = false) {
  const ps = (await numberedParagraphs(readFileSync(path.join(here, 'sources', file)))).filter(p => p.text.trim());
  const i = last ? ps.findLastIndex(p => p.text.trim() === startsAt) + 1 : ps.findIndex(p => p.text.trim().startsWith(startsAt));
  if (i <= 0) throw Error(`${file}: start "${startsAt}" not found`);
  return ps.slice(i).map(p => `${p.label ? p.label + ' ' : ''}${p.text.trim()}`);
}
// The clean bundle must meet the playbook. Calibration (10 October, clean-bundle run, Opus 5.5, twice) found one DPA
// sentence a customer's lawyer would rightly not accept: the Provider may change the processing details, including the
// purpose of processing and special category data, by notice alone (C-15). As with the Key Terms, the negotiated copy
// differs from the published standard terms: that sentence is removed. Recorded in README.md, calibration log.
const SOURCE_EDITS = [{ in: '2.3 Processing by Provider.', find: ' If Provider updates the Service to update existing or include new products, features, or functionality, Provider may change the Categories of Data Subjects, Categories of Personal Data, Special Category Data, Special Category Data Restrictions or Safeguards, Frequency of Transfer, Nature and Purpose of Processing, and Duration of Processing as needed to reflect the updates by notifying Customer of the updates and changes.', to: '' }];
const dpa = (await standardTerms('common-paper-dpa-v1.1.docx', 'Processor and Subprocessor Relationships')).map(t => SOURCE_EDITS.reduce((s, e) => {
  if (!s.startsWith(e.in)) return s; if (!s.includes(e.find)) throw Error(`source edit: "${e.find.slice(0, 40)}" not in "${e.in}"`); return s.replace(e.find, e.to);
}, t));
if (SOURCE_EDITS.some(e => !dpa.some(t => t.startsWith(e.in)))) throw Error('a source edit found no paragraph');
const sla = await standardTerms('common-paper-sla-v2.0.docx', 'Service Level Agreement', true);
const annexTexts = [...DPA_TERMS, ...dpa, ...SLA_TERMS, ...sla];
const annex = annexTexts.map((text, i) => ({ id: `a${i + 1}`, text }));

function locate(paragraphs, needle) {
  const hits = paragraphs.filter(p => p.text.includes(needle));
  if (hits.length !== 1) throw Error(`Anchor "${needle}" matched ${hits.length} annex paragraphs`);
  return hits[0];
}
function plantAnnex(paragraphs, ids) {
  const targets = {}, fixes = {};
  for (const id of ids) {
    const plant = PLANTS.find(p => p.id === id); targets[id] = [];
    for (const [k, e] of plant.edits.entries()) {
      const p = locate(paragraphs, e.in);
      if (!p.text.includes(e.find)) throw Error(`${id}: "${e.find.slice(0, 40)}" not in ${p.id}`);
      p.text = p.text.replace(e.find, e.to); targets[id].push(p.id);
      (fixes[id] = fixes[id] || []).push({ paragraph: p.id, restore: e.find.trim(), planted: e.to.trim(), check: (plant.fix || [])[k] || null });
    }
  }
  return { targets, fixes };
}
const csaEntry = id => csaManifest.variants.find(v => v.id === id);

const VARIANTS = [{ id: 'B00', from: null, annex: [] },
  ...PLANTS.map(p => ({ id: p.kind ? `BD${p.id.slice(1)}` : `BA${p.id.slice(1)}`, from: null, annex: [p.id] })),
  ...LENGTH_PAIRED.map(id => ({ id: `BL${id.slice(1)}`, from: id, annex: [] })),
  ...Object.entries(MARKUPS).map(([id, [k, ...rest]]) => ({ id, from: k, annex: rest }))];

for (const f of readdirSync(path.join(here, 'variants'))) if (f.startsWith('B')) rmSync(path.join(here, 'variants', f));
const base = { id: 'tough-bundle-base', revision: 1, title: 'Cloud Service Agreement, DPA and SLA — Halden Cloud / Northwind Analytics', paragraphs: [...csaBase.paragraphs, ...annex] };
writeFileSync(path.join(here, 'base-bundle.json'), JSON.stringify(base, null, 1));
const csaPlaybook = JSON.parse(readFileSync(path.join(here, 'playbook.json'), 'utf8'));
const playbook = { ...csaPlaybook, id: `${csaPlaybook.id}-bundle`, title: `${csaPlaybook.title} (with DPA and SLA)`, rules: [...csaPlaybook.rules, ...ANNEX_RULES] };
const playbookText = JSON.stringify(playbook, null, 1);
writeFileSync(path.join(here, 'playbook-bundle.json'), playbookText);

const entries = [];
for (const v of VARIANTS) {
  const front = v.from ? csaVariant(v.from).paragraphs : csaBase.paragraphs;
  const back = annex.map(p => ({ ...p }));
  const { targets, fixes } = plantAnnex(back, v.annex);
  const doc = { id: `tough-bundle-${v.id}`, revision: 1, title: base.title, paragraphs: [...front.map(p => ({ ...p })), ...back] };
  const json = JSON.stringify(doc, null, 1); writeFileSync(path.join(here, 'variants', `${v.id}.json`), json);
  const plants = [...(v.from ? csaEntry(v.from).plants : []),
    ...v.annex.map(pid => { const p = PLANTS.find(x => x.id === pid); return { id: pid, kind: p.kind || 'deviation', level: p.level, rules: p.rules, what: p.what, targets: targets[pid], fixes: fixes[pid] }; })];
  entries.push({ id: v.id, sha256: sha(json), base: 'base-bundle.json', playbook: 'playbook-bundle.json', from: v.from, plants });
}
const chars = base.paragraphs.reduce((n, p) => n + p.text.length, 0);
const manifest = {
  suite: 'tough-eval long bundle', version: 'v3-bundle', builtAt: new Date().toISOString(),
  sources: ['common-paper-dpa-v1.1.docx', 'common-paper-sla-v2.0.docx'].map(f => ({ file: `sources/${f}`, sha256: sha(readFileSync(path.join(here, 'sources', f))), licence: 'CC BY 4.0, Common Paper (https://commonpaper.com/standards/)' })),
  agreementManifestSha256: sha(readFileSync(path.join(here, 'manifest.json'), 'utf8')),
  base: { paragraphs: base.paragraphs.length, chars, agreementChars: csaManifest.base.chars, sha256: sha(JSON.stringify(base, null, 1)) },
  playbook: { file: 'playbook-bundle.json', sha256: sha(playbookText), rules: playbook.rules.length },
  mode: 'third-party (counterparty paper, no baseline), whole bundle in one review',
  variants: entries,
};
writeFileSync(path.join(here, 'manifest-bundle.json'), JSON.stringify(manifest, null, 1));
console.log(`bundle ${base.paragraphs.length} paragraphs, ${chars} chars (agreement alone ${csaManifest.base.chars}); ${entries.length} variants; playbook ${playbook.rules.length} rules`);
