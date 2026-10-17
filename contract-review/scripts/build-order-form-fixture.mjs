// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the order-form fixture (Phase 7, P1): our order form as sent, the customer's tracked markup of it, the
// customer's cover email, a short policy note for order forms, and hand-written truth. The order form is an original
// text written for this prototype (see data/fixtures/order-form/README.md for why a public standard form was not used).
// Parties, people, addresses, products and email domains (.example) are fictional; Helix Instruments Ltd stands in for
// our side, as in the NDA fixture. Deterministic: fixed dates and authors, so rebuilding yields byte-identical files.
// Run: node scripts/build-order-form-fixture.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { exportDocx } from '../server/docx.js';

import { pathToFileURL } from 'node:url';
// ORDER_FORM_OUT lets the test rebuild into a scratch folder and compare bytes with the committed files.
const OUT = process.env.ORDER_FORM_OUT ? pathToFileURL(process.env.ORDER_FORM_OUT.replace(/\/?$/, '/')) : new URL('../data/fixtures/order-form/', import.meta.url); mkdirSync(OUT, { recursive: true });

// The form as Helix sent it. Paragraph indexes are referred to below by their clause numbers.
const sent = [
  'Order Form',
  'Reference: HX-OF-2026-0147',
  'Supplier: Helix Instruments Ltd (company number 09811234, 14 Fenchurch Avenue, London EC3M 5AD).',
  'Customer: Northgate Biosciences Ltd (company number 12873456, 3 Quayside Court, Newcastle upon Tyne NE1 3DX).',
  'Order Date: 1 June 2026.',
  '1. Subscription. Helix grants the Customer a non-exclusive, non-transferable right for up to 25 named users to use the Helix LabTrack software service during the Subscription Term, for the Customer\'s internal business purposes.',
  '2. Subscription Term and renewal. The Subscription Term is 12 months from the Order Date. It renews automatically for further periods of 12 months unless either party gives written notice of non-renewal at least 60 days before the end of the current term.',
  '3. Fees. The subscription fee is £24,000 a year, excluding VAT, invoiced annually in advance.',
  '4. Price changes. Helix may increase the fees for a renewal term by giving at least 90 days\' written notice before that term begins. No increase will exceed 5% of the fees for the previous term.',
  '5. Payment. The Customer shall pay each undisputed invoice within 30 days of the invoice date.',
  '6. Termination. Either party may terminate this Order Form by written notice if the other party commits a material breach and does not remedy it within 30 days of being notified of it. Neither party may terminate for convenience during a Subscription Term.',
  '7. Limitation of liability. Each party\'s total liability arising out of or in connection with this Order Form in any 12-month period is limited to the fees paid and payable for that period. Liability for death or personal injury caused by negligence, for fraud, or for anything else that cannot lawfully be limited is not limited.',
  '8. Intellectual property indemnity. Helix shall defend the Customer against any third-party claim that the Customer\'s use of Helix LabTrack in accordance with this Order Form infringes that third party\'s intellectual property rights, and shall pay any damages finally awarded against the Customer on that claim.',
  '9. Entire agreement. This Order Form is the entire agreement between the parties about its subject matter. No terms in any purchase order or other document issued by the Customer apply.',
  '10. Governing law. English law applies to this Order Form and to any dispute arising from it, and the courts of England and Wales have exclusive jurisdiction.',
  'Signed for and on behalf of Helix Instruments Ltd',
  'Signed for and on behalf of Northgate Biosciences Ltd',
];
const at = n => sent.findIndex(t => t.startsWith(`${n}. `));

// Northgate's markup of the sent form (tracked). Five changes: affiliates added to the licence (not covered by the
// playbook); price changes and payment, two neighbouring clauses; termination for convenience added; and the
// customer's purchasing terms made to prevail over the order form.
const markup = sent.map(t => ({ text: t, originalText: t }));
const change = (n, text) => { markup[at(n)] = { originalText: sent[at(n)], text }; };
change(1, '1. Subscription. Helix grants the Customer a non-exclusive, non-transferable right for up to 25 named users of the Customer and its Affiliates to use the Helix LabTrack software service during the Subscription Term, for the internal business purposes of the Customer and its Affiliates.');
change(4, '4. Price changes. The fees are fixed for the first Subscription Term and the first renewal term. After that, Helix may increase the fees for a renewal term by giving at least 90 days\' written notice before that term begins. No increase will exceed 3% of the fees for the previous term.');
change(5, '5. Payment. The Customer shall pay each undisputed invoice within 90 days of the invoice date.');
change(6, '6. Termination. Either party may terminate this Order Form by written notice if the other party commits a material breach and does not remedy it within 30 days of being notified of it. The Customer may terminate this Order Form for convenience on 30 days\' written notice, and Helix shall refund any prepaid fees for the period after termination.');
change(9, '9. Entire agreement. This Order Form is the entire agreement between the parties about its subject matter. If the Customer issues a purchase order, the Customer\'s purchasing terms prevail over this Order Form where they conflict.');

async function docx(name, paragraphs, { author = 'Helix Legal', date = '2026-06-01T09:00:00Z' } = {}) {
  const buffer = await exportDocx({ id: name, title: name, revision: 0, paragraphs: paragraphs.map((p, i) => ({ id: `p${i + 1}`, ...(typeof p === 'string' ? { text: p } : p) })) }, null);
  const zip = await JSZip.loadAsync(buffer);
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace(/w:author="[^"]*" w:date="[^"]+"/g, `w:author="${author}" w:date="${date}"`);
  zip.file('word/document.xml', xml);
  for (const entry of Object.values(zip.files)) entry.date = new Date('2026-06-01T00:00:00Z'); // fixed zip timestamps: byte-identical rebuilds
  const out = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }));
  writeFileSync(new URL(name, OUT), out); return out;
}
function eml(name, { from, to, date, subject, messageId, inReplyTo = null, body }) {
  const text = [`From: ${from}`, `To: ${to}`, `Date: ${date}`, `Subject: ${subject}`, `Message-ID: ${messageId}`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body.trim(), ''].join('\r\n');
  writeFileSync(new URL(name, OUT), text); return Buffer.from(text);
}
function txt(name, body) { const text = body.trim() + '\n'; writeFileSync(new URL(name, OUT), text); return Buffer.from(text); }

const files = {};
files['helix-northgate-order-form-v1.docx'] = await docx('helix-northgate-order-form-v1.docx', sent);
files['helix-northgate-order-form-v2-customer-markup.docx'] = await docx('helix-northgate-order-form-v2-customer-markup.docx', markup, { author: 'Daniel Osei (Northgate)', date: '2026-06-04T11:20:00Z' });
files['2026-06-04-northgate-returns-order-form.eml'] = eml('2026-06-04-northgate-returns-order-form.eml', { from: 'Daniel Osei <d.osei@northgate-bio.example>', to: 'Priya Raman <p.raman@helix-instruments.example>', date: 'Thu, 04 Jun 2026 12:05:37 +0100', subject: 'Helix LabTrack order form HX-OF-2026-0147 — our comments', messageId: '<ng-2026-06-04-1205@northgate-bio.example>', body: `
Priya,

Thank you for the order form for Helix LabTrack. Our comments are in track changes in the attached copy (helix-northgate-order-form-v2-customer-markup.docx). In short:

1. Our two subsidiaries will use the service, so the licence needs to cover our Affiliates within the same 25 named users.
2. Our budget is set for two years, so we need the price fixed for the first term and the first renewal, and a lower cap after that.
3. Our standard supplier payment terms are 90 days. Finance will not approve anything shorter without an exception.
4. We need to be able to end the subscription on notice if the project is cancelled, with a refund of the unused part.
5. Our procurement system issues a purchase order for every supplier, and our purchasing terms are attached to it. We have said those terms prevail where they conflict.

Happy to take any of these on a call.

Kind regards,
Daniel Osei
Commercial Counsel, Northgate Biosciences Ltd
` });
files['policy-note.txt'] = txt('policy-note.txt', `
Order forms on our paper: policy note (demonstration only; fictional; not any organisation's policy and not lawyer validated)

This note is for the demonstration of playbook generation. It describes the positions of a fictional software supplier when a customer returns its standard order form with changes.

1. Payment. We ask for payment of undisputed invoices within 30 days. Up to 60 days is acceptable without escalation. Anything longer needs approval from the finance director.
2. Price changes. We keep the right to increase fees at renewal on 90 days' notice, capped at 5% a year. A lower cap of no less than 3% is acceptable. A price freeze beyond the first term needs approval from the sales director.
3. Renewal. Subscriptions renew automatically for 12 months unless either party gives 60 days' notice. A shorter notice period of no less than 30 days is acceptable.
4. Termination for convenience. We do not offer termination for convenience during a subscription term. A customer request for it goes to the general counsel, and any refund of prepaid fees is a hard line we do not cross without the general counsel's written approval.
5. Liability. Each party's liability is capped at the fees paid and payable in a 12-month period. Up to twice that amount is acceptable. Uncapped liability other than what the law does not allow us to limit is a hard line.
6. Indemnity. We defend third-party intellectual property claims about our software. Wider indemnities go to the general counsel.
7. Customer terms. The customer's purchase order terms never apply to our order form. This is a hard line.
8. Governing law. English law and the courts of England and Wales. Another law needs approval from the general counsel.
`);

const sha = b => createHash('sha256').update(b).digest('hex');
const truth = {
  description: 'Hand-written ground truth for the order-form fixture. Item keys are filenames. Fictional parties; original text written for this prototype.',
  matters: { 'helix-northgate-order-form': { parties: ['Helix Instruments Ltd', 'Northgate Biosciences Ltd'], items: ['helix-northgate-order-form-v1.docx', 'helix-northgate-order-form-v2-customer-markup.docx', '2026-06-04-northgate-returns-order-form.eml'] } },
  order: ['helix-northgate-order-form-v1.docx', 'helix-northgate-order-form-v2-customer-markup.docx'],
  baselineOf: { 'helix-northgate-order-form-v2-customer-markup.docx': 'helix-northgate-order-form-v1.docx' },
  emailLinks: [{ email: '2026-06-04-northgate-returns-order-form.eml', document: 'helix-northgate-order-form-v2-customer-markup.docx', relation: 'carries' }],
  playbook: { 'helix-northgate-order-form-v1.docx': 'order-form', 'helix-northgate-order-form-v2-customer-markup.docx': 'order-form' },
  changes: {
    v2: [
      { clause: '1. Subscription', paragraph: `p${at(1) + 1}`, what: 'licence extended to the Customer\'s Affiliates', playbook: null, note: 'not covered by the order-form playbook' },
      { clause: '4. Price changes', paragraph: `p${at(4) + 1}`, what: 'price fixed for the first term and first renewal; cap 5% → 3%', playbook: 'PRI-01', note: 'neighbours clause 5' },
      { clause: '5. Payment', paragraph: `p${at(5) + 1}`, what: 'payment period 30 → 90 days', playbook: 'PAY-01', note: 'neighbours clause 4' },
      { clause: '6. Termination', paragraph: `p${at(6) + 1}`, what: 'customer termination for convenience on 30 days\' notice, with refund of prepaid fees', playbook: 'TFC-01' },
      { clause: '9. Entire agreement', paragraph: `p${at(9) + 1}`, what: 'customer purchasing terms made to prevail over the order form', playbook: 'PRE-01' },
    ],
  },
  sha256: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
};
writeFileSync(new URL('truth.json', OUT), JSON.stringify(truth, null, 2) + '\n');
console.log(Object.entries(truth.sha256).map(([k, v]) => `${v.slice(0, 12)}  ${k}`).join('\n'));
