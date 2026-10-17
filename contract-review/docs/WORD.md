# Word integration status

This prototype includes an Office task-pane manifest and an Office.js adapter. Browser/DOCX tests do not establish that the add-in works inside Word. Actual Mac/Windows Word sideloading and visual verification remain necessary.

## Run and sideload

Serve the application over trusted local HTTPS on port 3443. The manifest is `public/manifest.xml`; change its SourceLocation, SupportUrl and both icon URLs if using a different HTTPS origin. Port 3000 may be used for browser development, but plain HTTP is not the documented Word setup. The frontend calls initializeWord(), which loads Microsoft Office.js and waits for Office.onReady before enabling Word buttons.

On Mac, sideload the manifest using Microsoft's instructions below. The current Office document is exported as compressed DOCX through Office.js, then uploaded to this application's `/api/documents/import` endpoint. Imported content therefore reaches the local application server; any configured model request is a separate data transfer. No email connection is made.

## How a change is applied (3 October 2026)

The pane follows the pattern shipping open-source add-ins use (research in `../../history-grouping-research-signals.md` and `../../word-edit-placement-research.md`):

1. **Locate once, then narrow.** The pane works out the smallest edit: the changed words, and a short run of unchanged words around them that occurs exactly once in the paragraph. Word searches the paragraph for that run (exactly one hit is required; none or several produce a warning and no edit), then for the changed words inside it; if they are found once there, only they are struck and replaced, otherwise the run is. Word's search takes at most 255 characters: a longer passage is located by its first and last 255 characters and replaced whole, or refused if its end cannot be placed. It is never replaced in part.
2. **Track in its own step.** Change tracking is set to track-all in a separate sync, the replacement is inserted after the range and the range deleted (a tracked Replace can decompose on Word for Mac), and the previous tracking mode is restored.
3. **Anchor the new wording.** After the tracked insert-and-delete, a hidden bookmark (name `_m_<time><random>`: the leading underscore makes Word hide it, the name stays under Word's 40-character limit and says nothing about the review) is placed on the inserted text. The pane and its saved session remember which bookmark belongs to which point. Nothing is written to the document's add-in settings (changed 5 October 2026; see "What is left in the file" below).
4. **Verify.** The paragraph is re-read and the new wording confirmed before the pane reports success. Applying on top of the counterparty's existing tracked changes is allowed and flagged, so the lawyer can check how Word shows the layered revisions.

Application is per change on explicit action; nothing is applied in bulk or on the lawyer's behalf. Unit tests with a fake Word object model are in `tests/word.test.js`; the real-Word check is recorded in `../../tasks/t1-report.md` (EXP-013) and the retest with this adapter is pending.

## Marking the passage on screen, and undo (4 October 2026)

When the pane moves to a point it marks that passage without changing the file: `Range.highlight()` (WordApi 1.8; one pale colour that Word chooses) followed by `select(Start)`, which scrolls Word to the passage without selecting it; below WordApi 1.8 it falls back to `select()`. The previous highlight is removed through a tracked range. An optional critique-annotation mode for every open point (`src/word-annotations.js`, `?marks=annotations`) existed until 9 October 2026 and was removed; it had been seen working in Word for Mac 16.113 on 5 October (5 of 5 drawn) but the underline colour sat close to Word's per-author revision colours and read as another tracked change. Undo after Apply (browser view; in Word see below) rejects exactly the pane's own tracked deletion and insertion in that paragraph and removes the hidden bookmark. Both are unit-tested against a fake object model (`tests/word-mark.test.js`) and have not yet been exercised in real Word: the attempt on 4 October stopped at the macOS lock screen (`../../ui-log.md`). Research: `../../word-highlighting-research.md`.

## Boundaries

The manifest requires WordApi 1.6. Multi-paragraph insertions are prepared as text for Word rather than inserted automatically. Headers, footers, notes, fields, drawings and moves are not reviewed and generate coverage warnings. Imported originals must remain available to the server to export a DOCX that preserves the original package.

## Verified API references

- [Tracked changes and tracking mode](https://learn.microsoft.com/en-us/office/dev/add-ins/word/manage-tracked-changes)
- [Get the whole document](https://learn.microsoft.com/en-us/office/dev/add-ins/word/get-the-whole-document-from-an-add-in-for-word)
- [Sideload on Mac](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac)
- [Requirement sets](https://learn.microsoft.com/en-us/office/dev/add-ins/reference/requirement-sets/word-api-requirement-sets)

Microsoft documents compressed file retrieval for desktop Word on Mac/Windows. Availability must still be checked in the user's installed host. Tracked-change search has known complexity; the adapter uses exact current-text verification and refuses overlapping revisions rather than assume an arbitrary found range is safe.

## The localhost certificate (product v2, PR-REL-01)

Word loads the pane only from a trusted HTTPS address. `setup-word` makes a self-signed certificate for `localhost` and `127.0.0.1`, valid for 825 days (the longest a Mac accepts for a TLS server certificate), with no openssl needed. It never installs trust, changes Word's settings or sideloads the manifest; it prints the trust step for the platform:

- Installed release: `"/Library/Application Support/GinChugger Legal/bin/ginchugger-legal" setup-word` on a Mac, `"C:\Program Files\GinChugger Legal\bin\ginchugger-legal.cmd" setup-word` on Windows. The certificate goes in `word-tls` in the user's data folder, and the app serves HTTPS on port 3443 from its next start.
- Source checkout: `node scripts/setup-word.js` writes to `.local/word-tls/` (or `$MARGIN_STATE_DIR/word-tls/`), then `PORT=3443 HTTPS_KEY=.local/word-tls/localhost.key HTTPS_CERT=.local/word-tls/localhost.crt npm start`.

The trust step, once per computer:

- **Mac.** Open the `.crt` file (it goes into the login keychain), double-click "localhost" in Keychain Access, open Trust and set "When using this certificate" to Always Trust. Or in Terminal: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "<path>/localhost.crt"`.
- **Windows.** `certutil -user -addstore Root "<path>\localhost.crt"` for the signed-in user (Windows asks you to confirm), or `certutil -addstore Root "<path>\localhost.crt"` from an administrator prompt for everyone on the computer.

Both the browser and Word must trust the certificate before sideloading; clicking through a browser warning is not a substitute. Never commit or share `localhost.key`. After 825 days, delete the `word-tls` folder, run `setup-word` again and trust the new certificate.

## Verification attempt

Microsoft's `office-addin-manifest validate` command passed on 29 September 2026. The manifest includes local help and PNG icon assets. This validates manifest structure and declared requirements; it does not establish runtime support on every platform listed by the validator.

Microsoft Word is installed on this Mac. An actual Computer Use inspection was attempted; it returned “The Mac is locked and automatic unlock could not unlock it.” No Word session, manifest loading, or live tracked insertion could be verified. Unlocking the Mac is required before that final host check. No system trust configuration was changed.

## Reading the open document, and what Word will not do (Phase 6, measured 5 October 2026, Word for Mac 16.113)

**The review reads the file itself.** The pane asks Word for the open document's bytes (`getFileAsync`, compressed, in 64 KB slices) and posts them to the same `/api/documents/import` the browser uses, so the review sees the counterparty's tracked changes and their original text. Measured: 0.25–0.38 s to read files of 16–71 KB, 23–61 ms to import. Word's own paragraphs then line up with the server's by index with identical text: 18 of 18, 150 of 150 (116 tracked changes) and 496 of 496 (tables and field codes). Word's `paragraph.text` is the current text, with tracked deletions left out. If Word cannot hand over the file the pane falls back to plain paragraph text and says that tracked changes were not read.

**Undo from the pane (17 October 2026).** Measured on 5 October: `getTrackedChanges()` on a paragraph does not list a revision made on top of another author's revision, and lists deletions with empty text; the first attempt (`rejectApplied`) was removed on 9 October for that reason. `undoTracked` in `src/word.js` (WordApi 1.6: `Range.getTrackedChanges`, `TrackedChange.reject`; the manifest already requires 1.6, and the button falls back to "Undo this change in Word." where `isSetSupported('WordApi', '1.6')` is false) does not guess: each change the pane made is remembered as { bookmark, inserted, deleted }; the bookmark must still hold exactly the inserted wording, contain exactly one tracked insertion (ours; its author is the lawyer's Word identity for the rest of the match), and the deletions in that paragraph by the same author must carry the struck wording, or, when Word reports no text, be exactly as many as ours. Then all of the point's changes are rejected in one sync, newest first, and the bookmarks deleted; otherwise nothing is rejected and the pane says "This change was edited in Word. Undo it there." A clause deletion has no bookmark and is undone in Word. A pane change layered on the counterparty's revision may still be unlisted in real Word for Mac (not yet rechecked); then Undo refuses in the same words. On success the point is open again, as after Cmd+Z, and `edit_rejected_in_word` goes to the review history.

**Deleting a clause.** When a point proposes deleting its clause (empty wording; see `docs/FINDING.md`, `deletion`), Delete clause locates the paragraph's text as Apply does, strikes it in one tracked deletion with tracking switched on for that step, and re-reads the paragraph to confirm the wording is gone. Nothing is inserted, so no bookmark is placed.

**Diagnostics.** The pane's timings and failed marks are posted to the server's `.local/diagnostics.jsonl` only when the server runs with `PANE_DIAGNOSTICS=1`; otherwise nothing is sent or written.

**Opening the pane with a document.** `scripts/attach-pane.mjs` writes a copy of a `.docx` that carries the add-in's task-pane parts, so Word opens the pane with it (Microsoft's documented auto-open mechanism). Used for tests and the demo; it adds nothing but the add-in's id.

**Marking follows the pane.** Moving to a point scrolls Word to its passage and highlights the whole quote, including quotes longer than Word's 255-character search limit (the mark runs from the first match to the end of the quote). Requests run one at a time and only the latest is carried out, so stepping quickly leaves one passage marked. A quote the server could not find in the document is never marked; quotes that carry no flag (recorded runs played back in tests) are checked against the paragraph by Word before marking.

## The document in the store, and the version sent back (decisions 184, 185, 190 and 191; 16 October 2026)

**Opening.** When the pane connects it reads the open file and posts it to the store (`POST /api/v2/store/pane/open`). A document the store already holds, by its bytes or by its paragraphs' content key (Word hands over different bytes on every read), is recognised; any other Word document is added to the Inbox with the counterparty matching suggests. Nothing is asked: one grey line names the counterparty and type and opens the document's page, where labels are corrected. A file opened in the browser is only looked up. When the store cannot be reached the review runs without it and the pane's status line says so.

**During the review.** The review call carries `storeDocumentId`; with an executor that has tool calling the model reads the counterparty's other documents through the four read-only store tools, as the signed-in lawyer. The pane writes the review's events to the document's review history (`POST /api/v2/store/documents/:id/review-events`): `review_run` and the flagged findings when the review arrives, then each dismissal, applied change, change rejected in Word and comment reply. "Accept their wording" also puts a note on the document in the store; Undo removes it. A batch the history refuses is kept for one retry ("Not recorded: the review history did not accept the events", Retry).

**Save as our reply.** Once every point is handled, Save as our reply first removes what the add-in placed in the document (below), then reads the file as it now is and adds it to the store as a new document with the reviewed document's counterparty and type, titled "<title> (our reply)", out of the Inbox. There is no round, no filing decision and no earlier-version picker: the store is flat, and the comparison version is whatever the lawyer opens with Add comparison in the browser.

### Superseded: the matter, the earlier version and the version sent back (product v2, slice S4, 15 October 2026)

Kept as the record of what was built and checked in Word on 16 October; decision 190 removed matters, rounds, filing and the record's inbox the same day. None of the routes below exist now.

**Matter.** When the pane connects it reads the open file and posts it to the record (`POST /api/v2/files`, source `pane`). If the bytes, or the document's paragraphs (Word hands over different bytes on every read), are already a round of a matter, the pane opens in that matter on that round; the start card says "Filled in from the matter". Otherwise Matter reads None and Round reads Not recorded, with Record beside it. No model guesses the matter; the earlier code that proposed one (`propose-matter.js`) is gone.

**Record this round.** Record (on the start card, with or without a review) captures the open document into the inbox (`POST /api/v2/inbox/pane`) and shows one card: Matter, Side, Round, Responds to, Signed, Confirm, each filled from the inbox's deterministic suggestions (product v2 spec 7.1, 7.3). Side is Theirs before a review and Ours on the signed and version-sent paths; "Tracked changes by <author>" names whose markup it is. A document already filed says "Already filed as <matter>, round <n>." and Confirm links it (`round_linked`). Confirm posts `POST /api/v2/inbox/:id/confirm`; the record writes `file_stored` and `round_recorded`. A clash on the round number offers "Record as round n+1" (and the link when there is one); a record that cannot be reached says "Record unavailable. Retry." and nothing is kept locally.

**Earlier version.** Read from the record, never chosen by a model: the round the open document responds to when it is a round, else the matter's latest round of ours; Change offers the matter's other rounds and Playbook only. (`baseline.js` and its model call are gone; the round's "responds to" supplies the comparison.)

**During the review.** Inside a matter the review call carries `agentic: true`, `matterId` and `round`; the local app gives the model the record tools when the executor has them, and otherwise the single call with the record's history, and the pane then says "Record not consulted by the model". The pane writes the review's events to the record (`POST /api/v2/matters/:id/events`): `review_run` and the flagged findings when the review arrives, then each dismissal, rewording, applied change, change rejected in Word and export. A batch the record refuses is kept for one retry ("Not recorded: the record did not accept the events", Retry). The count of documents waiting in the inbox sits in the pane's header and opens the Inbox page.

**Record this round, after the review.** On the all-decided state, Record this round first removes what the add-in placed in the document (below), then reads the file as it now is and records it as our round (side Ours). The pane then says to save the document in Word before sending, because the clean-up is in the open document, not yet on disk.

## Comment threads, new paragraphs and undo (product v2, slice S5, 15 October 2026; not yet run in Word)

- **Comments** (`readComments`, `replyToComment` in `src/word.js`, WordApi 1.4): when a review arrives the pane reads `body.getComments()` (id, author, content, resolved) and, for each, the first paragraph of `comment.getRange()`; the paragraph's index is found by `uniqueLocalId` (WordApi 1.6) when Word has it, else as the one paragraph with that text (a repeated text is left unmatched). After an applied change is verified, an unresolved thread on that paragraph gets one `comment.reply(text)`, queued like every change, with text composed by code: "Changed: “…” to “…”. Playbook <rule>." (≤ 300 characters). Word attributes the reply to the signed-in user. Below WordApi 1.4 nothing is read and the Applied state says "Reply not posted: Word version"; a reply that throws leaves the edit and says "Reply failed". The reply writes into the document (a comment), unlike the marks of "Marking the passage on screen", which still never use comments.
- **A new paragraph** (`applyWordInsertion`): `paragraph.insertParagraph(text, 'After')` with tracking on in its own sync, restored after; the anchor is found at its index when the text agrees, else as the one paragraph with that text; the new paragraph gets a hidden `_m_` bookmark and is re-read. Used only from the bulk card (a point whose reply adds a paragraph), one edit at a time through the queue, in document order, stopping at the first failure.
- **Undo** (PR-PANE-06): a change the pane applied whose every bookmark is gone or empty was undone (Cmd+Z / Ctrl+Z) or rejected in Word. The pane checks this whenever it re-reads the document (on focus and every 20 seconds, as for "Document changed") and on reload: the point opens again, the pane takes the paragraph to read as it did before the change (if Word's text differs from that, the next read shows "Document changed"), and `edit_rejected_in_word` goes to the review history. Whether one Cmd+Z undoes the pane's insert, delete and bookmark together is what U1 checks (`docs/VERIFICATION.md`).

The Office fake (`tests/e2e/office-fake.js`) implements these calls for the end-to-end tests; the real-Word checks W2 to W5, U1 and U2 are listed for a person in `docs/VERIFICATION.md`.

## What is left in the file (decision 99)

While a review is in progress the document carries one hidden bookmark per applied change, named `_m_` plus characters that mean nothing. Save this version deletes every bookmark with that prefix (`Range.getBookmarks(true, true)` on the whole body, then `Document.deleteBookmark`; both WordApi 1.4) and removes the `margin.anchors.v1` setting if a build before 5 October 2026 left one. Tracked changes, comments and other bookmarks are not touched. The add-in writes no settings, so a document opened from the ribbon gains no add-in part from a review. Copies made by `scripts/attach-pane.mjs` do carry the add-in's task-pane parts, because that is how they open the pane; they are for tests and the demo and should not be sent. Checked in real Word on 5 October 2026: after Apply the saved file held one `_m_` bookmark; after Save this version and a save in Word it held none and no `margin.` setting, and the applied change was intact (`../../tasks/w-report.md`).

## Closing or reloading the pane (decision 134)

The review on screen and the lawyer's decisions are kept by the server for that document, under a hash of the address Word reports for it (`Office.context.document.url`), in `.local/pane-sessions/`; nothing is written into the document. Reopening the pane on the same document brings them back ("Review restored"). Before an applied change is believed, its hidden bookmark is read: if it is missing or empty, the change was rejected or deleted in Word, so the point is open again and the activity records "edit rejected in word". New review forgets the saved review. A document that has never been saved has no address, so nothing is kept for it. A change made in Word while the pane was closed shows as "Document changed", as it would with the pane open.

**Measured at open.** Reading the file takes 3–5 s when Word has just opened the document (three samples: 3.2, 3.9, 4.8 s) and about 0.25 s afterwards. The pane's button reads "Reading the document" meanwhile. Word returns different bytes each time it is asked for the same document, so the server recognises a document it already holds by its words and tracked changes.

## Choosing the playbook (product v2)

Two playbooks ship: NDAs and customer order forms, both demonstration only. The playbook is inferred from the document's own words (decision 184) and named in the pane's header ("Playbook · <title>") and changed from the one line under Review ("<counterparty> · Change playbook"); with none inferred the pane asks the lawyer to choose, never silently (audit finding 2). The review, its events in the review history and the exported review record name the playbook's id, title and change count. "Playbook changed" appears when the record's change counter has moved past the review's. Playbooks are edited by hand in the web app; there is no Add to playbook in the pane. Tests: `tests/playbook-routes.test.js`, `tests/playbook-library.test.js`.
