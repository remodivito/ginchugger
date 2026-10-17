# Order-form fixture (Phase 7, task P1)

Four files and a hand-written `truth.json`, built by `node scripts/build-order-form-fixture.mjs` (deterministic; hashes in `truth.json`; `tests/order-form-fixture.test.js` rebuilds them in a scratch folder and compares bytes).

**One negotiation, one return.** Helix Instruments Ltd (our side, a fictional software supplier, standing in for the client as in the NDA fixture) sends its order form for a 12-month subscription to "Helix LabTrack" to Northgate Biosciences Ltd, a fictional customer. Northgate returns the form with tracked changes under "Daniel Osei (Northgate)", dated 4 June 2026, and a cover email explaining them.

| File | What it is |
|---|---|
| `helix-northgate-order-form-v1.docx` | The order form as Helix sent it (no tracked changes) |
| `helix-northgate-order-form-v2-customer-markup.docx` | Northgate's markup of it, five tracked changes |
| `2026-06-04-northgate-returns-order-form.eml` | Northgate's cover email carrying the markup, with a reason for each change |
| `policy-note.txt` | A short policy note for order forms, so the demo can generate a playbook draft from documents (P6). Demonstration only |
| `truth.json` | Matter, order, which document the markup was made against, the email link, the playbook each document belongs to, the five changes with the playbook entry each one falls under, hashes |

**The five changes.** (1) The licence is extended to the customer's Affiliates: no playbook entry covers this, on purpose. (4) Price changes: price fixed for the first term and the first renewal, increase cap 5% → 3%. (5) Payment: 30 → 90 days. Clauses 4 and 5 are neighbours. (6) Termination: the customer may terminate for convenience on 30 days' notice with a refund of prepaid fees. (9) Entire agreement: the customer's purchasing terms are made to prevail over the order form, which is the "order form that tries to override the main terms" entry in the order-form playbook.

**Source and licence.** The text is original, written for this prototype on 5 October 2026; no clause is copied from a published form. A public standard was looked for first: Common Paper publishes a Cloud Service Agreement whose Cover Page includes an Order Form, "free to use and modify under CC BY 4.0" (https://commonpaper.com/standards/cloud-service-agreement/ and https://commonpaper.com/standards/cloud-service-agreement/2.1/, read 5 October 2026 on the publisher's site). It was not used because its Order Form is a set of variables that depends on the Standard Terms, a master agreement; reviewing a master agreement with its order form is out of scope for this phase. The fixture is therefore a self-contained order form with its own short terms. Its structure (order date, subscription period, automatic renewal with a notice date, fees, payment period, governing law) covers the same ground as such forms, in our own words.

**Fictional parties.** Helix Instruments Ltd, Northgate Biosciences Ltd, Helix LabTrack, Priya Raman, Daniel Osei, the company numbers, addresses and email domains (`.example`) are invented. Nothing here is a real negotiation, and nothing in these files establishes any organisation's policy. The policy note describes a fictional supplier's positions for the demonstration.
