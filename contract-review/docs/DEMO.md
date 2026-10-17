# The demo (spec R11.2; product v2, on the document store)

A returned order form reviewed where the lawyer works, with the team's documents in the store (decisions 190 and 191: flat documents with a counterparty, a type, tags, a date and notes; no matters or rounds). Everything the lawyer "does" in this script is a simulated lawyer action; nothing in the demo is legal advice or an approval, and the documents are fictional (`data/fixtures/*/README.md`).

## Setup (once)

1. `npm install && npm run build && npm start` ([Setup](SETUP.md) has the details). Docker running (the store is Paperless-ngx; the first start pulls about 6.6 GB). Without Docker the app uses its built-in, in-memory store and says so in one line; it starts empty each time, so do step 4 after every start.
2. Choose a route in **Settings · Models** (README, Model routes). On every route the model reads the store through its four read-only tools during the review and Ask, when the route supports tool calls:
   - **Your own Claude plan, your own machine:** the Claude CLI; start the app from a terminal where `claude` is signed in.
   - **API key:** the Anthropic API, with the key added under Connections.
   - **Open models:** an OpenAI-compatible endpoint (`OPENAI_BASE_URL` in `.env`), for example an EU-hosted one.
3. For Word: serve over trusted local HTTPS on :3443 and sideload `public/manifest.xml` (docs/WORD.md). Make a pane-carrying copy of the markup: `node scripts/attach-pane.mjs data/fixtures/order-form/helix-northgate-order-form-v2-customer-markup.docx <folder>/helix-northgate-order-form-v2-customer-markup.docx` (keep the file name). For the browser: `http://localhost:3000`.
4. Put the earlier documents in the store: **Inbox → Add files**, choose `data/fixtures/order-form/helix-northgate-order-form-v1.docx` and `2026-06-04-northgate-returns-order-form.eml`, and the three `data/fixtures/history/helix-brightwater-nda-v*.docx`. For each, check the labels and press **Done**: counterparty Northgate Biosciences Ltd (type Order form, or Email for the email) or Brightwater Analytics Ltd (type NDA), and tag the Brightwater v3 "signed". On the signed NDA's page add a note, for example "Signed 2 June. Brightwater accepted three years." `npm run screenshots` does the same through the app's routes, if you want to see the result first.

## Script (about five minutes)

**0:00 — The Library.** Open **Library**: one list of the team's documents with their counterparty, type and date; filter to Northgate; search "payment terms" and the email's passage comes up with the words marked. Open the signed NDA: its labels, the note, and its history naming who did what. Say: "Every document is in one store the team shares; the review reads it and never writes to it."

**0:45 — Open the markup in Word.** Open the pane-carrying copy of the markup. The pane finds the document in the store, or adds it to the Inbox with the counterparty matching names, and says so in one line under Review ("Northgate Biosciences Ltd · Order form · Change playbook", or "No counterparty · Change playbook" until it is labelled); the counterparty opens the document's page. The header names the playbook it inferred from the document ("Playbook · Order forms (demonstration)"). Nothing has to be chosen. Say: "Nothing is filed by hand before a review: the store holds what arrived, and the labels are checked in the Inbox when convenient."

**1:30 — Review.** Press **Review**. Nine points, worst first, "0 of 9 done" in the header; the Affiliates change is open: what is wrong in a sentence or two, the suggested wording drawn into the clause, **Apply** and **Dismiss**. On a route with tool calls the review has read the store first (what the team holds for Northgate: the email, the order form Helix sent), and points can cite those documents. Say: "One list, one decision per point."

**2:30 — Apply one change.** On the termination point press **Apply**. In Word: only the changed words, under your name, tracked. If the clause carries a comment thread, the pane replies in it under your name. The row turns grey and struck through, "Applied", and the count moves on. Undo it with Cmd+Z (or reject it in Word's Review pane) and click back into the pane: the point is open again. Apply once more. Say: "One change, one action, reversible in Word. A point whose reply makes several edits asks first, on one card; there is no Apply All."

**3:15 — Dismiss one, and ask.** On the price point, **Dismiss**, then **Not an issue** or **Accept their wording**: the pane writes the decision and why to the document's review history. The ask bar at the foot offers one question ("What did we accept from Northgate Biosciences Ltd before?"); the answer reads the store and quotes the documents it relied on, each quote checked word for word against that document.

**4:00 — Save as our reply.** Once every point is handled, **Save as our reply** adds the document to the Library as a new document with Northgate as its counterparty and the same type ("… (our reply)"), not in the Inbox. "Saved to Library · Open" opens it.

**Close.** Open **About**: the engine, the prompt and its hash, the limits line. State what is not established: lawyer validation, time saved, behaviour on real counterparties' documents.

## Team mode

Join a team server (Settings → Team) and the same script runs on the team's store: what one lawyer's pane adds is in everyone's Inbox and Library, the history names each lawyer, and the model's tools read the team store through the team server. Paperless runs on the team machine only.

## If something fails live

A failed model call is reported as a failure; the app never substitutes an offline result for a live one. Review again, or switch to another route in Settings · Models and continue; say that you did. If the store is unavailable, one line on each page says so; a review of the document open in Word still runs, without the store.
