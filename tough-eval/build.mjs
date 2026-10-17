// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the tough eval (seeded defects, v0): a long, real, openly licensed agreement reviewed as the counterparty's
// paper against a customer playbook whose positions it already meets, with known deviations planted one at a time (and
// a few together), plus harmless edits that must not be flagged. Scoring is exact: we know what was planted and where.
//
// Base: Common Paper Cloud Service Agreement v2.1 standard terms (CC BY 4.0, https://commonpaper.com/standards/), with a
// filled-in Key Terms block written for this suite. Output: base.json, variants/<id>.json, manifest.json (with hashes).
// Usage: node tough-eval/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDocx } from '../contract-review/server/docx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = s => createHash('sha256').update(s).digest('hex');

const KEY_TERMS = [
  'Cloud Service Agreement',
  'Key Terms and Order Form between Halden Cloud, Inc. ("Provider") and Northwind Analytics Ltd ("Customer").',
  'Effective Date: The date of last Cover Page signature.',
  'Governing Law: The laws of England and Wales.',
  'Chosen Courts: The courts located in London, England.',
  'Provider Covered Claims: Any action, proceeding, or claim that the Cloud Service, when used by Customer according to the terms of the Agreement, violates, misappropriates, or otherwise infringes upon anyone else’s intellectual property or other proprietary rights.',
  'Customer Covered Claims: Any action, proceeding, or claim that (1) the Customer Content, when used according to the terms of the Agreement, violates, misappropriates, or otherwise infringes upon anyone else’s intellectual property or other proprietary rights; or (2) results from Customer’s breach or alleged breach of Section 2.1 (Restrictions on Customer).',
  'General Cap Amount: 1x the Fees paid or payable by Customer to Provider in the 12 month period immediately before the claim.',
  'Increased Claims: (a) Breach of Section 3 (Privacy & Security); and (b) breach of Section 10 (Confidentiality), other than a data or security breach, which falls under (a).',
  'Increased Cap Amount: 3x the Fees paid or payable by Customer to Provider in the 12 month period immediately before the claim.',
  'Unlimited Claims: An Indemnifying Party’s indemnification obligation.',
  'Security Policy: Provider will use commercially reasonable efforts to secure the Cloud Service from unauthorized access, alteration, or use and other unlawful tampering.',
  'Additional Warranties: None.',
  'DPA: The Data Processing Agreement signed by the parties on the Effective Date.',
  'Notice Address: For Provider: legal@halden.example. For Customer: legal@northwind.example.',
  'Cloud Service: Halden Insight, a hosted data analytics platform.',
  'Order Date: The date of last signature on this Order Form.',
  'Subscription Period: 12 months.',
  'Cloud Service Fees: £48,000 per Subscription Period. Fees may increase by up to 5% per renewal.',
  'Currency: All Fees, invoices and payments under this Order Form are in pounds sterling (GBP).',
  'Payment Process: Provider will invoice Customer annually in advance. Customer will pay each invoice within 30 days from Customer’s receipt of invoice.',
  'Non-Renewal Notice Date: At least 30 days before the end of the current Subscription Period.',
  'Technical Support: Provider will provide email support during business hours (09:00 to 17:30 UK time, Monday to Friday).',
  'Use Limitations: None.',
  'Standard Terms',
];

// Each plant: edits located by a substring unique to one paragraph (`in`), replacing `find` with `to`; or an inserted
// paragraph after the paragraph containing `after`. `rules` are the playbook entries a correct review cites.
// kind: deviation (must be flagged) | benign (must not be flagged as a deviation). level: easy | medium | hard.
const PLANTS = [
  // Easy: explicit values in the Key Terms.
  { id: 'P01', level: 'easy', rules: ['C-01'], what: 'General cap cut to 0.25x', edits: [{ in: 'General Cap Amount:', find: '1x the Fees', to: '0.25x the Fees' }] , fix: [{ num: '([0-9.]+)x the Fees', min: 1, require: ['12 month'] }] },
  { id: 'P02', level: 'easy', rules: ['C-10'], what: 'Payment due in 10 days', edits: [{ in: 'Payment Process:', find: 'within 30 days', to: 'within 10 days' }] , fix: [{ num: 'within ([0-9]+) days', min: 30 }] },
  { id: 'P03', level: 'easy', rules: ['C-17'], what: 'Delaware law and courts', edits: [{ in: 'Governing Law: The laws', find: 'England and Wales', to: 'the State of Delaware' }, { in: 'Chosen Courts:', find: 'London, England', to: 'Wilmington, Delaware' }] , fix: [{ require: ['England and Wales'] }, { require: ['London'] }] },
  { id: 'P04', level: 'easy', rules: ['C-11'], what: 'Non-renewal notice 120 days', edits: [{ in: 'Non-Renewal Notice Date:', find: 'At least 30 days', to: 'At least 120 days' }] , fix: [{ num: 'least ([0-9]+) days', max: 60 }] },
  { id: 'P05', level: 'easy', rules: ['C-11'], what: 'Price increases up to 15%', edits: [{ in: 'Cloud Service Fees:', find: 'up to 5% per renewal', to: 'up to 15% per renewal' }] , fix: [{ num: 'up to ([0-9.]+)%', max: 5 }] },
  // Medium: wording in the operative terms.
  { id: 'P06', level: 'medium', rules: ['C-05'], what: 'Content usable to improve and build new products', edits: [{ in: 'Customer Content.  Provider may copy', find: 'only as needed to provide and maintain the Product and related offerings', to: 'to provide, maintain, and improve the Product and to develop new products and services' }] , fix: [{ require: ['only as needed to provide'], forbid: ['improve', 'develop new'] }] },
  { id: 'P07', level: 'medium', rules: ['C-06'], what: 'ML safeguards (aggregation, de-identification) deleted', edits: [{ in: 'Machine Learning. Usage Data', find: ' However, (a) Usage Data and Customer Content must be aggregated before it can be used for these purposes, and (b) Provider will use commercially reasonable efforts consistent with industry standard technology to de-identify Usage Data and Customer Content before such use.', to: '' }] , fix: [{ require: ['aggregat', 'de-identif'] }] },
  { id: 'P08', level: 'medium', rules: ['C-09'], what: 'Suspension for any balance 5 days overdue', edits: [{ in: 'Suspension.  If Customer', find: 'outstanding, undisputed balance on its account for more than 30 days', to: 'outstanding balance on its account for more than 5 days' }] , fix: [{ require: ['undisputed'], num: '([0-9]+) days', min: 30 }] },
  { id: 'P09', level: 'medium', rules: ['C-13'], what: 'Deletion within 180 days', edits: [{ in: 'Provider will delete Customer Content within', find: 'within 60 days', to: 'within 180 days' }] , fix: [{ num: 'within ([0-9]+) days', max: 90 }] },
  { id: 'P10', level: 'medium', rules: ['C-12'], what: 'Only Provider may terminate for breach or insolvency', edits: [{ in: 'Termination.  Either party may terminate', find: 'Either party may terminate', to: 'Provider may terminate' }] , fix: [{ require: ['(either|each) party'], forbid: ['^5\\.3 Termination\\.\\s+Provider may terminate'] }] },
  { id: 'P11', level: 'medium', rules: ['C-14', 'C-12'], what: 'Warranty remedy loses the refund', edits: [{ in: 'Provider Warranty Remedy.', find: 'Customer may terminate the affected Order Form and Provider will pay to Customer a prorated refund of prepaid Fees for the remainder of the Subscription Period.', to: 'Customer may terminate the affected Order Form.' }] , fix: [{ require: ['refund'] }] },
  { id: 'P12', level: 'medium', rules: ['C-04'], what: 'Settlement without consent allowed (sentence deleted)', edits: [{ in: 'Procedure.  The Indemnifying Party', find: ' The Indemnifying Party may not agree to any settlement of a Covered Claim that contains an admission of fault or otherwise materially and adversely impacts the Protected Party without the prior written consent of the Protected Party.', to: '' }] , fix: [{ require: ['settle', 'consent'] }] },
  { id: 'P13', level: 'medium', rules: ['C-15'], what: 'Provider may change the terms by posting', edits: [{ in: 'Modifications, Severability, and Waiver.', find: 'signed or electronically accepted by each party.', to: 'signed or electronically accepted by each party. However, Provider may update these Standard Terms by posting a revised version on its website, effective 30 days after posting.' }] , fix: [{ forbid: ['posting', 'update these Standard Terms'] }] },
  { id: 'P14', level: 'medium', rules: ['C-16'], what: 'Provider may assign freely; Customer needs consent', edits: [{ in: 'Assignment.  Neither party may assign', find: 'Neither party may assign any rights or obligations under this Agreement without the prior written consent of the other party.', to: 'Customer may not assign any rights or obligations under this Agreement without the prior written consent of Provider. Provider may assign this Agreement without notice or consent.' }] , fix: [{ require: ['(neither|either|each) party'], forbid: ['without notice or consent'] }] },
  { id: 'P15', level: 'medium', rules: ['C-18'], what: 'Case study without consent', edits: [{ in: 'Logo Rights.', find: 'as a user of Provider\'s products and services.', to: 'as a user of Provider\'s products and services. Provider may also publish a case study describing Customer\'s use of the Product and the results Customer has achieved.' }] , fix: [{ forbid: ['case study'], allowIf: 'consent' }] },
  { id: 'P16', level: 'medium', rules: ['C-08'], what: 'Compelled disclosure without notice', edits: [{ in: 'Required Disclosures.  Recipient may disclose', find: ' if, unless prohibited by Applicable Laws, Recipient provides Discloser reasonable advance notice of the required disclosure and reasonably cooperates, at Discloser’s expense, with Discloser’s efforts to obtain confidential treatment for the Confidential Information', to: '' }] , fix: [{ require: ['notice'] }] },
  // P17 v2: v1 deleted confidentiality from the waiver exceptions only, which changed nothing because confidentiality breaches
  // stayed Increased Claims (both models rightly passed it). Now both places change, so the waiver really reaches them.
  { id: 'P17', level: 'hard', rules: ['C-03', 'C-02'], what: 'Confidentiality out of Increased Claims and out of the waiver exceptions', edits: [{ in: 'Increased Claims:', find: '; and (b) breach of Section 10 (Confidentiality), other than a data or security breach, which falls under (a).', to: '.' }, { in: 'Exceptions.  The liability cap in Section 8.1(a)', find: 'does not apply to any Increased Claims or a breach of Section 10 (Confidentiality).', to: 'does not apply to any Increased Claims.' }] , fix: [{ require: ['Section 10|Confidentiality'] }, { require: ['Section 10|Confidentiality'] }] },
  { id: 'P26', level: 'medium', rules: ['C-02'], what: 'Increased cap cut to 1.5x', edits: [{ in: 'Increased Cap Amount:', find: '3x the Fees', to: '1.5x the Fees' }] , fix: [{ num: '([0-9.]+)x the Fees', min: 2 }] },
  // Hard: cross-clause, distant from the rule's natural home, or a deletion that leaves fluent text.
  { id: 'P18', level: 'hard', rules: ['C-03'], what: 'Only Customer\'s indemnity is uncapped', edits: [{ in: 'Unlimited Claims:', find: 'An Indemnifying Party’s indemnification obligation.', to: 'Customer’s indemnification obligation.' }] , fix: [{ require: ['indemnif'], forbid: ['^Unlimited Claims: Customer’s indemnification'] }] },
  { id: 'P19', level: 'hard', rules: ['C-05'], what: 'Outputs carved out of Customer Content (definition)', edits: [{ in: '“Customer Content” means', find: 'but excludes Feedback.', to: 'but excludes Feedback and any reports, insights, or other output generated by the Product.' }] , fix: [{ forbid: ['output', 'insights', 'reports'] }] },
  // P20 v2: v1 deleted the express inclusion, but limb (b) of the definition still covers customer data, so both models
  // read Customer Content as still confidential (defensible). Now the definition excludes it in terms.
  { id: 'P20', level: 'hard', rules: ['C-08'], what: 'Customer Content excluded from Confidential Information (definition)', edits: [{ in: '“Confidential Information” means', find: ' Customer’s Confidential Information includes non-public Customer Content and Provider’s Confidential Information includes non-public information about the Product.', to: ' Provider’s Confidential Information includes non-public information about the Product. Customer Content is not Confidential Information.' }] , fix: [{ require: ['Customer Content'], forbid: ['Customer Content is not Confidential'] }] },
  { id: 'P21', level: 'hard', rules: ['C-08'], what: 'Confidentiality dropped from survival list', edits: [{ in: 'The following sections will survive', find: 'Section 10 (Confidentiality), ', to: '' }] , fix: [{ require: ['Confidentiality'] }] },
  { id: 'P22', level: 'hard', rules: ['C-02'], what: 'Increased cap only for gross negligence', edits: [{ in: 'Increased Claims:', find: 'Breach of Section 3 (Privacy & Security);', to: 'Breach of Section 3 (Privacy & Security) resulting from gross negligence or willful misconduct;' }] , fix: [{ forbid: ['gross negligence', 'wil+ful misconduct'] }] },
  { id: 'P23', level: 'hard', rules: ['C-12'], what: 'Force majeure termination loses the refund', edits: [{ in: 'Force Majeure.  Either party may terminate', find: ' Provider will pay to Customer a prorated refund of any prepaid Fees for the remainder of the Subscription Period.', to: '' }] , fix: [{ require: ['refund'] }] },
  { id: 'P24', level: 'hard', rules: ['C-19'], what: 'Audit clause inserted (system inspection, 5 days, Customer pays)', insert: { after: 'Assignment.  Neither party may assign', text: 'Audit.  Provider may audit Customer’s use of the Product, including by inspecting Customer’s systems, on five business days’ notice, and Customer will reimburse Provider’s reasonable audit costs.' } , fix: [{ deleteOr: true, forbid: ['inspect'], require: ['(30|thirty) days'] }] },
  { id: 'P25', level: 'hard', rules: ['C-15'], what: 'AUP "as updated from time to time" incorporated', edits: [{ in: 'Entire Agreement.  This Agreement is the only', find: 'regardless of what such terms may say.', to: 'regardless of what such terms may say. Customer will comply with Provider’s Acceptable Use Policy, available on Provider’s website and as updated by Provider from time to time, which forms part of this Agreement.' }] , fix: [{ forbid: ['as updated'] }] },
  { id: 'P27', level: 'hard', rules: ['C-01'], what: 'Cap measured over 3 months of Fees', edits: [{ in: 'General Cap Amount:', find: 'in the 12 month period', to: 'in the 3 month period' }] , fix: [{ require: ['12 month|twelve'], forbid: ['3 month'] }] },
  // Benign: changes in our favour or neutral; flagging them as deviations is a false alarm.
  { id: 'D01', kind: 'benign', level: 'benign', rules: ['C-10'], what: 'Payment due in 45 days', edits: [{ in: 'Payment Process:', find: 'within 30 days', to: 'within 45 days' }] },
  { id: 'D02', kind: 'benign', level: 'benign', rules: ['C-13'], what: 'Deletion within 30 days', edits: [{ in: 'Provider will delete Customer Content within', find: 'within 60 days', to: 'within 30 days' }] },
  { id: 'D03', kind: 'benign', level: 'benign', rules: [], what: 'Four-hour response for critical incidents', edits: [{ in: 'Technical Support:', find: 'Monday to Friday).', to: 'Monday to Friday). Critical incidents receive a response within four hours, at any time.' }] },
  { id: 'D04', kind: 'benign', level: 'benign', rules: [], what: 'Notices to Customer copied to legal', edits: [{ in: 'Notices.  Any notice', find: 'sent to the Notice Address.', to: 'sent to the Notice Address, and notices to Customer will also be copied to legal@northwind.example.' }] },
  { id: 'D05', kind: 'benign', level: 'benign', rules: ['C-11'], what: 'Price increases up to 3%', edits: [{ in: 'Cloud Service Fees:', find: 'up to 5% per renewal', to: 'up to 3% per renewal' }] },
  { id: 'D06', kind: 'benign', level: 'benign', rules: [], what: 'British spelling', edits: [{ in: 'Mutual.  Each party represents', find: 'duly organized', to: 'duly organised' }] },
];
const VARIANTS = [
  { id: 'C00', plants: [] },
  ...PLANTS.map(p => ({ id: p.id, plants: [p.id] })),
  { id: 'M1', plants: ['P01', 'P07', 'P16', 'P23'] },
  { id: 'M2', plants: ['P02', 'P12', 'P20', 'P24'] },
  { id: 'M3', plants: ['P05', 'P09', 'P19', 'D01'] },
];
// v2: realistic markups. A counterparty's return carries many changes at once, harmful and harmless, so each deviation
// competes for attention. Twelve markups, each with seven deviations and two benign edits, assigned round robin from a
// seeded shuffle so every deviation appears about three times in different company; no two edits share a paragraph.
const anchors = p => [...(p.edits || []).map(e => e.in), ...(p.insert ? [p.insert.after] : [])];
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function shuffled(xs, rand) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
{
  const rand = rng(20261009); const dev = shuffled(PLANTS.filter(p => !p.kind), rand), ben = shuffled(PLANTS.filter(p => p.kind), rand);
  let di = 0, bi = 0;
  for (let k = 1; k <= 12; k++) {
    const chosen = []; const used = new Set();
    const take = (pool, n, start) => { let i = start, picked = 0, tries = 0; while (picked < n && tries < pool.length * 2) { const p = pool[i % pool.length]; i++; tries++; if (chosen.includes(p.id) || anchors(p).some(a => used.has(a))) continue; chosen.push(p.id); anchors(p).forEach(a => used.add(a)); picked++; } return i; };
    di = take(dev, 7, di); bi = take(ben, 2, bi);
    VARIANTS.push({ id: `K${String(k).padStart(2, '0')}`, plants: chosen });
  }
}

const source = readFileSync(path.join(here, 'sources/common-paper-csa-v2.1.docx'));
const imported = await importDocx(source, 'common-paper-csa-v2.1.docx');
const start = imported.paragraphs.findIndex(p => p.text.trim() === 'Service');
const raw = imported.paragraphs.slice(start).map(p => p.text.trim()).filter(Boolean);
// Common Paper CSA v2.1 numbering, as shown in the published document: sections, subsections, and lettered items.
const SECTIONS = [['Service', ['Access and Use', 'Support', 'User Accounts', 'Feedback and Usage Data', 'Customer Content', 'Machine Learning']],
  ['Restrictions & Obligations', ['Restrictions on Customer', 'Suspension']], ['Privacy & Security', ['Personal Data', 'Prohibited Data']],
  ['Payment & Taxes', ['Fees', 'Invoicing', 'Automatic Payment', 'Taxes', 'Payment', 'Payment Dispute']],
  ['Term & Termination', ['Order Form and Agreement', 'Framework Terms', 'Termination', 'Force Majeure', 'Effect of Termination', 'Survival']],
  ['Representations & Warranties', ['Mutual', 'From Customer', 'From Provider', 'Provider Warranty Remedy']], ['Disclaimer of Warranties', []],
  ['Limitation of Liability', ['Liability Caps', 'Damages Waiver', 'Applicability', 'Exceptions']],
  ['Indemnification', ['Protection by Provider', 'Protection by Customer', 'Procedure', 'Changes to Product', 'Exclusions', 'Exclusive Remedy']],
  ['Confidentiality', ['Non-Use and Non-Disclosure', 'Exclusions', 'Required Disclosures', 'Permitted Disclosures']], ['Reservation of Rights', []],
  ['General Terms', ['Entire Agreement', 'Modifications, Severability, and Waiver', 'Governing Law and Chosen Courts', 'Injunctive Relief', 'Non-Exhaustive Remedies', 'Assignment', 'Beta Products', 'Logo Rights', 'Notices', 'Independent Contractors', 'No Third-Party Beneficiary', 'Force Majeure', 'Export Controls', 'Government Rights', 'Anti-Bribery', 'Titles and Interpretation', 'Signature']],
  ['Definitions', ['Defining Variables']]];
const LETTERED = { '2.1': 2, '5.3': 2, '5.5': 4, '5.6': 2, '8.1': 2, '9.5': 2 }; // items that follow these subsections
const terms = []; let sec = 0, sub = 0, letters = 0, current = null;
for (const t of raw) {
  const heading = SECTIONS[sec] && t.replace(/\.$/, '') === SECTIONS[sec][0];
  if (heading) { sec++; sub = 0; letters = 0; current = null; terms.push(`${sec}. ${t.replace(/\.$/, '')}`); continue; }
  const subs = SECTIONS[sec - 1]?.[1] || [];
  if (sub < subs.length && t.startsWith(subs[sub] + '.')) { sub++; current = `${sec}.${sub}`; letters = LETTERED[current] || 0; terms.push(`${current} ${t}`); continue; }
  if (letters > 0) { const k = (LETTERED[current] - letters); letters--; terms.push(`(${'abcd'[k]}) ${t}`); continue; }
  terms.push(t);
}
if (sec !== SECTIONS.length) throw Error(`numbering stopped at section ${sec}`);
const baseTexts = [...KEY_TERMS, ...terms];
const base = { id: 'tough-csa-base', revision: 1, title: 'Cloud Service Agreement — Halden Cloud / Northwind Analytics', paragraphs: baseTexts.map((text, i) => ({ id: `p${i + 1}`, text })) };

function locate(paragraphs, needle) {
  const hits = paragraphs.filter(p => p.text.includes(needle));
  if (hits.length !== 1) throw Error(`Anchor "${needle}" matched ${hits.length} paragraphs`);
  return hits[0];
}
function apply(doc, plantIds) {
  const paragraphs = doc.paragraphs.map(p => ({ ...p })); const targets = {}; const fixes = {};
  for (const id of plantIds) {
    const plant = PLANTS.find(p => p.id === id); targets[id] = [];
    for (const e of plant.edits || []) {
      const p = locate(paragraphs, e.in);
      if (!p.text.includes(e.find)) throw Error(`${id}: "${e.find.slice(0, 40)}" not in ${p.id}`);
      p.text = p.text.replace(e.find, e.to); targets[id].push(p.id);
      (fixes[id] = fixes[id] || []).push({ paragraph: p.id, restore: e.find.trim(), planted: e.to.trim(), check: (plant.fix || [])[plant.edits.indexOf(e)] || null });
    }
    if (plant.insert) {
      const after = locate(paragraphs, plant.insert.after); const at = paragraphs.indexOf(after) + 1;
      const pid = `${after.id}-ins-${id}`; paragraphs.splice(at, 0, { id: pid, text: plant.insert.text }); targets[id].push(pid);
      (fixes[id] = fixes[id] || []).push({ paragraph: pid, restore: '', planted: plant.insert.text, inserted: true, check: (plant.fix || [])[0] || null });
    }
  }
  return { doc: { ...doc, id: `tough-csa-${plantIds.join('-') || 'clean'}`, paragraphs }, targets, fixes };
}

rmSync(path.join(here, 'variants'), { recursive: true, force: true }); mkdirSync(path.join(here, 'variants'), { recursive: true });
writeFileSync(path.join(here, 'base.json'), JSON.stringify(base, null, 1));
const manifestVariants = [];
for (const v of VARIANTS) {
  const { doc, targets, fixes } = apply(base, v.plants);
  const json = JSON.stringify(doc, null, 1); writeFileSync(path.join(here, 'variants', `${v.id}.json`), json);
  manifestVariants.push({ id: v.id, sha256: sha(json), plants: v.plants.map(pid => { const p = PLANTS.find(x => x.id === pid); return { id: pid, kind: p.kind || 'deviation', level: p.level, rules: p.rules, what: p.what, targets: targets[pid], fixes: fixes[pid] }; }) });
}
const playbookText = readFileSync(path.join(here, 'playbook.json'), 'utf8');
const manifest = {
  suite: 'tough-eval seeded defects', version: 'v2.1', builtAt: new Date().toISOString(),
  source: { file: 'sources/common-paper-csa-v2.1.docx', sha256: sha(source), licence: 'CC BY 4.0, Common Paper (https://commonpaper.com/standards/)', paragraphsTaken: terms.length },
  base: { paragraphs: base.paragraphs.length, chars: baseTexts.join('').length, sha256: sha(JSON.stringify(base, null, 1)) },
  playbook: { file: 'playbook.json', sha256: sha(playbookText), rules: JSON.parse(playbookText).rules.length },
  mode: 'third-party (counterparty paper, no baseline): the reviewer must find deviations without a diff',
  variants: manifestVariants,
};
writeFileSync(path.join(here, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`base ${base.paragraphs.length} paragraphs, ${manifest.base.chars} chars; ${manifestVariants.length} variants; ${PLANTS.filter(p => !p.kind).length} deviations, ${PLANTS.filter(p => p.kind).length} benign`);
