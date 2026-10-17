# Design system (E2)

The review interface is one system, E2, chosen on 4 October 2026 from the design canvas ("E2 · Slip, with hierarchy"). It serves the Word task pane and the browser's review column with the same components, and the browser pages (Inbox, Library, the document page, Playbook, Trash, Activity, Settings, Admin, About) with the same type and rules. Tokens live in `src/tokens.css`; every rule in `src/style.css` reads them. The canvas holds the drawn states.

The reasoning behind each choice is in `../../ui-log.md` (to be folded into the decision log).

**What stands today (17 October 2026).** The rules, the three levels of hierarchy, the type scale, the spacing and the components listed under "Components" below, read with the redesign note (the glass look: Newsreader for the wordmark and titles, Geist for the tool speaking, white cards on #F7F7F8, a black pill for the primary action, severity as the only colour). The screens in `src/pages/` are Inbox, Library, the document page, Playbook, Trash, Activity, Settings, Admin and About; the pane is `src/review/Pane.jsx`. Everything about matters, rounds, filing, the Register, Positions, Sources, the "Last time" drawer, Reword, Mark reviewed, Record this round and Export record is history, and is gathered under "History" at the end so a reader does not have to carry four dated notes through the page.

## Changes, newest first

**Decisions 190 and 191 (16 October 2026): the store.** Matters, rounds, the filing decision, the Register, the record's Search, Inbox, Trash and Activity pages and the matter page's timeline are gone; the Inbox, Library, document page, Trash and Activity now read the document store (`src/pages/StoreInbox.jsx`, `Library.jsx`, `DocumentPage.jsx`, `StoreTrash.jsx`, `StoreActivity.jsx`). The paragraphs below that describe those screens, the "Filing" lines and the pane's "Last time" drawer are the record of earlier work and no longer stand; the type, colour, spacing and component rules do.

**Redesign of 16 October 2026 ("glass": boards Pane A, Matter B, Inbox B, Settings B and Models B).** The look changed; the hierarchy and the rules below did not. The system font is the tool speaking and Newsreader (bundled from `@fontsource/newsreader`) is the wordmark, page titles and quoted words; the page is #F7F7F8 with a floating white sidebar; cards and groups are white with a 0.5 px hairline; the primary button is a black pill and lesser actions are quiet pills; severity is the only colour (push back / open #C9600A, check #AEAEB2, fine green). Liquid glass is used only on floating control bars (the pane's action bar, the matter page's action pill), never on content. Where a table below still names Geist, Source Serif 4, squares or the ink block, read the tokens in `src/tokens.css`. Product changes that came with it: no grey line under the pane's title and no "Review without the record" in the pane (the API keeps `agentic: false`); no "Read the record" switch in Settings, which is now a category list (Reviewing, Models, Team, Benchmark); the matter page shows each round as a card with a proportion bar, a legend and a status chip per point (`src/pages/timeline.js`); the Inbox is a list beside the one open, with "What we found" and "Add to <matter>".

**Decision 184 (16 October 2026, board Pane D): the pane has one job.** Review this draft against the playbook, then apply or dismiss each point; plus "Ask about this draft". Header: the matter's name (or the document's) in the serif and "N of M done". Before a review: one Review button and at most one quiet line, "Filed under <matter>", linking to the matter page. After: every point in one list, worst first; the open point shows one or two sentences on what is wrong, the suggested wording drawn into the clause (what goes struck in grey, what comes on a green tint), one "Last time: …" line when the record holds one, and Apply and Dismiss (Dismiss has no note); a reply with several edits lists them for Confirm first. A done point is a grey, struck-through row ending "Applied" or "Dismissed", with Undo as a quiet link where the pane can undo it (not an applied change in Word: rejecting it in Word reopens the point). One status line, "Document changed" or "Playbook changed" with Review again, or a refused record batch with Retry. The only glass is the floating ask bar at the foot; an answer and its quotes appear inline above it. Gone from the pane: the start card and its pickers, the instruction field, the limits line (About keeps it), Round summary, Also noticed, the count with squares and arrows, Positions, Sources, the Last time drawer, Reword, Mark reviewed, Record decision, Copy wording, Add to playbook, Record this round, Export record, New review, This review, Activity, the inbox count and the Word links to Matters, Playbook and About. The sections below describe the E2 pane before this decision and stand for the pages.

**Safety batch (16 October 2026; decisions 186 and 188, design deviation audit).** Each addition to the pane is one line or one card. *Filing* (`src/review/Filing.jsx`, words in `filing-view.js`): two choice rows, "Round n of <matter> (<side>)" and "New agreement: <name>", the record's suggestion pre-selected and its reason in one grey line beneath; "Uncertain: <reason>" in the open-severity text with neither row pre-selected; side as two quiet pills (Theirs, Ours), both always shown. In the Inbox it is the "File as" group above "What we found". In the pane, before a review of a document the record does not hold, it is one line above Review ("Round 2 of X (theirs) · Change", "New agreement: X · Change", "Uncertain: … · Choose", or "Not filed · File" when no counterparty was found), and Change opens the card; Review files as shown, then reviews. At "Save as our reply" with no matter known the same card sits above the button. *Playbook*: one grey line under Review, "Playbook: <title> · Change" (since the UX taste calls of 17 October: named in header D only, and the line reads "<counterparty> · Change playbook"); Change, or no playbook inferred ("Choose a playbook"), shows the playbooks as choice rows, never a dropdown. *Coverage*: one grey line under the header after a review when something was not checked ("12 of 14 rules checked · headers and notes not read · 1 not verified"), opening to the list; a point whose quote or record citation failed verification carries a "Not verified" tag. *Dismiss*: the point's actions become "Not an issue" and "Accept their wording" (quiet pills) with Cancel; the done row reads "Not an issue" or "Accepted". *Matter page*: "Put on hold" / "Release hold" in the Edit form for admins; a held or signed matter shows "On hold: kept out of the trash" (or "Signed: …") in place of Move to trash; Trash's Remaining reads "Kept" when no purge is set.

## The rules

These come from the lawyer who will use it, and they outrank anything below.

| Rule | Principle it serves |
|---|---|
| No headline sentences, explanatory copy, dashboard numerals or decorative graphics. Empty space stays empty. | Signal over noise; visual hierarchy only works when little competes. |
| Nothing is drawn that the product cannot produce. Every element maps to a field in `docs/FINDING.md`, the matter record, a playbook field, or a real Word capability. | Honesty of the interface; error prevention (a lawyer never acts on something that is not there). |
| Every function the app had is still reachable. | Completeness; nothing lost to minimalism. |
| The model's reasoning is behind one link, never on the face. | Progressive disclosure. |
| One decision at a time, three levels of hierarchy only. | Hick's law (one primary choice on screen); visual hierarchy. |

## Hierarchy: three levels

1. **What they changed and what goes back.** Both in the same serif at the same size, so the eye pairs them. The reply sits in the ink block at the bottom of the pane with its Apply button inside it.
2. **Why.** The playbook's stated positions, a risk rating when one was given, an earlier-round excerpt, other quoted evidence, and any validation flag. Small, in a two-column label/value grid.
3. **Where and what else.** Clause name, the count "1 / 3" with squares, previous/next, and the lesser actions as quiet text.

Nothing sits outside these three levels. If a new element cannot be placed in one of them, it does not belong on the face of a decision.

## Type

Two families. **Geist** is the tool speaking. **Source Serif 4** is used only for words quoted from the contract or an email (the changed words, the reply wording, earlier-round excerpts, evidence). The lawyer's own words (instruction, notes) are Geist. Fonts are bundled from `@fontsource/geist` and `@fontsource/source-serif-4`; no font is fetched at run time.

| Token | Size / line height | Use |
|---|---|---|
| `--t-quote-l` | 27 / 1.18, serif | Level 1 excerpt, up to about sixty characters |
| `--t-quote-m` | 17 / 1.36, serif | Level 1 excerpt when longer; cut at 140 characters with "Full wording" |
| `--t-quote-s` | 14.5 / 1.42, serif (italic for earlier-round excerpts) | Level 2 quotes |
| `--t-button` | 16, 600 | The primary button |
| `--t-input` | 15 | Text the lawyer types |
| `--t-body` | 13.5 / 1.45 | Level 2 values, quiet actions, list rows |
| `--t-count` | 13, 600 | Count and clause line |
| `--t-meta` | 12.5 | Sources, times, links under a value |
| `--t-label` | 11, uppercase, 0.08em | Labels |

Both level-1 excerpts take the size of the longer one, so they always match. Insertions in a short excerpt are 600 with a 2 px underline; in a long excerpt they are underlined only. Deletions are struck through in `--struck` (on white) or `--on-ink-struck` (on ink).

## Colour

White ground, ink `#111111`, grey `#5F5F5F`, hairline `#E4E4E4`. No accent colour, no status colours, no pills, no gradients. State is carried by words, weight, position and the square, never by hue. All text is at least 4.5:1 against its ground (values are listed in `tokens.css`). The ink block inverts: white text, `#BDBDBD` labels, `#DADADA` quiet actions.

## Space and size

A 4 px grid; 20 px side margins (Microsoft's task-pane default); 20 px between level-1 and level-2 groups; 16 px between grid rows. Every control is at least 44 px tall. The primary button is 56 px tall and full width. The label column of the grid is 64 px; below 300 px of pane width the grid stacks, labels above values.

Pane widths that must work: 320 px (Windows default), 270 px (Mac default), 330 px (Word on the web). A Word pane can be as short as 445 px (Microsoft's figure at 1366 x 768 with the ribbon), so the middle scrolls and the bottom region is pinned.

## Components

All controls are real `<button>`, `<a>`, `<input>`, `<textarea>`, `<select>`. No icons except the two chevrons. No cards, no rounded boxes, no shadows in the pane.

- **Header.** The count (a button: it opens the list), the squares (filled = decided, outline = open), previous and next (44 px chevron buttons). When the point is on text nobody changed, the count reads "Also noticed 1 / 2".
- **Status line.** One line under the header for system status that applies to the whole review: "Document changed" (or "Playbook changed") with Review again. Hairline below. Nothing else uses this slot.
- **Title row** (decision 120, 6 Oct 2026). The clause heading in 600 with one tag on the right (Playbook / Not covered). The heading is read from the document (the paragraph's own label such as "Confidentiality Period", or the nearest numbered or title-case line above it); when the document has none, the finding's title stands in. Under it, in grey meta: what changed and the paragraph number ("Confidentiality Period reduced from seven to five years · ¶ 5"). A validation note, the lawyer's earlier action on the clause (Before), and after Reword what the revision did ("Reworded · five-year tail, trade-secret tail unchanged", from the bracket the model adds to the title, which is taken out of the title) are lines here, never hidden.
- **Card.** The tool's own words about the point: the first two sentences of the explanation on a light grey ground, with Reasoning to open the rest. The one place the pane speaks in prose.
- **Box.** The clause as it will read, inside a hairline border: our reply drawn into it, what goes on a warm tint with a strike, what comes on a cool tint (Word's convention, used nowhere else). Head: the label (Reply / Changed / Unchanged / In the document) and Edit · Full clause · Open. Edit turns the box into a serif text field in place; Done keeps the text, Cancel drops it. One line beneath says what Apply will write. With no reply, the box shows their change; after Apply, the change as it now stands in the document.
- **Drawers.** One component (`Drawer` in Pane.jsx): a 46 px row with the name in 500, a grey summary after a middle dot, a chevron; opens in place. On a point, two rows under the box, each saying what is inside so most never need opening: Positions ("Counter at five years in the box · 2 more") and Sources ("Playbook DUR-01 · Earlier 2 · Quoted 2"). Positions opens to one row per position, the one in the box marked, each ending "edits the clause" or "records a decision"; picking one swaps the box. Sources opens to the why grid as before: Playbook (positions as pairs, rule references, Add to playbook), Risk, Earlier, Quoted, New ¶.
- **Reply block (ink).** Label "Reply" and the position or decision on one line; any error; the primary button (white on ink); the quiet actions. The wording itself is in the box above, not here.
- **Bottom region (white).** Used when there is no wording to send: a 2 px ink rule on top, an optional label line, the primary button (ink on white), quiet actions. The button is in the same place as Apply, so the target never moves.
- **Primary button.** 56 px, full width, one per screen, and its verb follows the box: "Apply 1 change" (the count from the minimal edits) when the box differs from the document; "Record decision" when a position records rather than edits, or the lawyer keeps the drafted wording where positions were offered; "Mark reviewed" when nothing was proposed; Next point after an outcome. Also: Review against playbook, Reword, Revise, Dismiss, Review again, Ask, Use this playbook.
- **Quiet action.** 13.5 px text button, 44 px tall: Reword, Dismiss, Undo, Copy wording, Add to playbook (after an outcome). Edit and Reasoning live in the box and the card.
- **Disabled primary.** Hairline grey ground with grey text, so it reads as unavailable; while a review runs the button stays ink with the elapsed time, because it is busy, not unavailable.
- **Choice rows.** One row per choice, 44 px, hairline between, square filled when recorded. Used for the baseline answer and for a finding's options.
- **Field.** Uppercase label above, a borderless input with a single ink underline. Dismiss and Reword (decision 123) are one field under the box, in the middle region: the label and Cancel on one line (as Edit · Done · Cancel sit in the box head), the field beneath; the primary button keeps its place and takes the field's verb.
- **Links in a card or a box head** are grey and not underlined (ink and underlined on hover), with a 44 px hit area drawn around them so the line does not move.
- **Pages (browser).** Same type and rules; a top bar with the four destinations as text; content in a single column up to 1120 px; sections separated by hairlines and labelled with the uppercase label.
- **About** holds the developer words the review screens no longer show: which engine the next review uses; for the last review the engine, executor, model and effort, the prompt file with the first twelve characters of its hash, the duration, the playbook and version, the time. (Until slice S4 it also showed the model's earlier-version proposal; the record now says which round a document answers.)
- **Page hairlines.** A section that begins or ends with a list of rows does not draw its own rule as well; the rows' hairlines do it.

## Keyboard

Return applies (or presses whatever the primary button is), the left and right arrow keys move between points, D opens Dismiss. None of these fire while focus is in a text field, a select, or a button that handles its own keys. Escape closes the list, Reword, Edit and Dismiss.

## Marking the document (Word)

From `../../word-highlighting-research.md`. Only marks that leave the counterparty's file untouched.

- **The passage on screen:** `Range.highlight()` (Word API 1.8; one pale colour Word chooses) and `select(Start)` to scroll without selecting; the previous highlight is removed. Below 1.8, `select()`.
- **Every open point:** not marked. An optional critique-underline mode existed until 9 October 2026 and was removed (it was never relied on).
- **After Apply:** Word's own revision marks. Nothing of ours.
- Never: content controls, `font.highlightColor`, shading, comments (they write into the file).

## History: screens and states that no longer exist

Kept as the record of what was designed and built before decisions 184 (the pane has one job) and 190–192 (the flat document store). None of the screens below is in `src/` now; `src/review/Filing.jsx`, `filing-view.js` and `src/pages/timeline.js` were removed with them.

- **Pane additions** (product v2, slice S5). The limits line: one grey line above the start card with Close, shown once per install. Start card rows Standard form (Attach / Remove) and Files (Change opens the matter's files as choice rows), and one grey line under Playbook, "Last changed by X on date". Last time: a third drawer on a point after Sources, present only when the record holds something; its rows open to the quote and Open matter. Round summary: a drawer above the list of points, one row per change (clause heading, the changed words in serif, the rule). Bulk card: a point whose reply makes several edits opens a field-style card under the box, one choice row per edit (paragraph, the words), Confirm in the ink block.
- **List** (decision 122). One list serves "all points" (opened from the count) and "all decided" (past the last point). Each row: the square, the clause heading (the finding's title when the document has none), one status line beneath (Open / Applied 1 change · 09:25 / Dismissed · “note” / Recorded · position / Reviewed · 09:25), one tag (Playbook / Not covered). Also noticed is a collapsed drawer row with its count. At the foot, three drawers: Ask (the field and a quiet Ask; the answer in a card, its quotes beneath), This review (time and playbook; opens to scope, instruction and limits), Activity (count; opens to the events). In Word, Matter · Playbook · About follow as quiet links. The bottom says what is next: "2 to decide" with Continue, or, when every point is decided, the finishing action.
- **Record pages** (product v2, slice S6; screenshots in `docs/screenshots/`). Hash routes, and the top bar's destinations are links (Review, Inbox, Matters, Register, Search, Playbook, Settings, Admin, About). Matters is a table whose matter and counterparty cells are links, with Deleted (the tombstone's one line) and Demo beneath. A matter's timeline: name, one grey line (counterparty link · kind · status · end date), Add file (secondary) with Edit and Close matter quiet; Rounds as drawers ("Round 2 · Theirs · file · date · 2 flagged · 1 applied") opening to the source line, downloads and the round's positions; Standard form as a start-card row with Change opening choice rows of the matter's Word files; Other files; Matter record; Delete matter (quiet) opening a card with the flow 7.9 sentence, the name field and Delete matter, enabled only on an exact match. A position is one row: the outcome in 600, the clause in grey, where it was taken as a meta line, the quoted words in the italic serif. Counterparty: the matching rule as a grid with Edit, its matters, positions as one drawer per clause type. Register and Search: filters as fields in one row above the results, a count beside the results label; search passages in the serif with the matched words marked. Playbook: the change counter and "Last changed by X on date · entry kind" as one line under the title; Remove entry in the entry card. Settings: the review setup as fields (the environment's values shown disabled with one grey line naming the variable), Tool check as a grid with Run check, and one drawer per benchmarked setup opening to its error profile and the ledger entry it comes from.
- **Trash, Notes, Activity** (DMS batch 1, 16 October 2026). The matter page's Delete matter became Move to trash (quiet, for everyone); a round card and an Other files row have Move to trash as a quiet link; Activity is a quiet link on the matter's action pill. Notes is a white group after Standard form: one row per note (author in 600, time and "edited" in grey meta, Edit, Delete and History as quiet links on the reader's own notes), the text in markdown-lite (bold, italic, code, bullets, links), History indented under a 2 px rule; the new-note field and Add note (inline primary) close the group. Trash is a table (Item with its matter or counterparty beneath, Moved by, Remaining "N days", Restore and Delete permanently as quiet pills); Delete permanently opens the delete card in place, with the name field for a matter. Activity is the Register's filter row (Type grouped by namespace, Person) above a table (Event as a sentence, Person, Matter for the whole record, When), 25 to a page with Previous, "Page n of m" and Next. No line explains any of them.
- **Playbook entry** (decision 124). Reached from Add to playbook in the pane, Add entry, an entry row, or Edit on a draft entry. While it is open the page is the playbook's name and one card (760 px column): "New entry" or "Entry", then Title, Position, Acceptable, Hard line; the wording it came from in a white hairline box inside the card (head: Source, and the document and paragraph); then a More drawer whose row names the hidden fields that hold something ("More · Wording"; "Off" when the entry is not used in reviews), opening to Topic, Preferred, Escalation, Wording, Fallback, Rationale and "Use in reviews". Save (inline primary), Cancel (quiet). Text areas grow with what they hold, up to eight lines.
- **Matter page** (decision 125; replaced in product v2 by the matter's timeline under Record pages, and Organise removed in slice S4). The matter's name; one primary, Add files (inline), and Organise as a quiet action beside it. Items are pressable rows: the name without its extension, a grey line with what the item is to this review (Under review / Earlier version / Duplicate) and when it was added, the kind as a tag (Document / Email); a row opens the item. Organise's suggestions are cards (the tool's sentence, its reason and check), the quoted words in a box beneath, then Confirm (quiet, 600) · Swap order · Not this; what it could not establish is a drawer. The matter record is a drawer with its count. With no matter: the name field with Start matter, and the two demo matters as rows with a Fictional tag and a quiet Load action.
- **Document column head (browser)** (decision 126). The document's name without its extension, then only what a lawyer uses at that moment: before a review, Examples · Open, and Add / Change / Remove comparison when no matter proposed the earlier version (when one did, the start card's Earlier version row does that); during a review, Markup · Download; with an email or earlier round open from a quote, its name in the head and the item's tag and Back above it. The toast stays.
- **Draft playbook** (removed in product v2 slice S1 with playbook generation). The draft's name with a Draft tag; one grey line, "N of M quotes found in the documents"; one row per entry (title, the tiers it fills as a grey line, an Unverified tag when no quote was found); a row opens to a card (the draft's own words, notes, what is not established), the tiers, and the source quotes in serif; Limits as a drawer with its count. Use this playbook (primary), Save as new playbook and Discard (quiet).

### States of the pane (the E2 pane before decision 184)

| State | Face | Primary |
|---|---|---|
| Start (decision 121; product v2 S4) | One card with Matter (Change), Round (the document's round, or Not recorded, with Record beside it), Earlier version (read from the record; Change opens the matter's rounds and Playbook only under the row) and Playbook (the matter's kind until changed); the inbox count beside the document's name, hidden at zero; the instruction field with no label; nothing explained beneath anything | Review (or Choose a playbook) |
| Running | The start card's values, fixed: Earlier version, Playbook with its version, the instruction if one was given (no engine or model) | Disabled, "Reviewing" with elapsed time |
| Deciding, with wording | Title row, card, the box with our reply drawn in, drawers | Apply N change(s) |
| Deciding, deleting the clause | As above; the box shows the whole clause struck through (a proposal with empty wording; with positions, it is the first, "Delete the clause") | Delete clause |
| With positions | As above; the first position with wording is in the box; the Positions drawer lists the rest, each saying whether it edits the clause or records a decision | Apply, or Record decision for a position without wording |
| Not covered / no wording | "Not covered" tag; the box shows their change; the Sources row lists only what it holds (Quoted 1), its Playbook row is Add to playbook; white bottom region | Mark reviewed |
| Wording missing or not offered | A validator's line under the title; wording the tool would not offer is a box "Not offered" with Copy in its head, under the main box | Reword (Mark reviewed when Reword is unavailable) |
| Reword | The field under the box, "Reword" with Cancel in its head, placeholder "Instruction"; the bottom keeps only the button | Revise |
| Edit | The box becomes a serif field in place; Done / Cancel in its head | Apply N change(s) |
| Dismiss | The field under the box, "Dismiss" with Cancel in its head, placeholder "Note, optional" | Dismiss |
| Applied | White region, "Applied" with the count and time; in Word one grey line, "To undo, reject the change in Word." | Next point; Undo quiet (browser) |
| Dismissed / reviewed | White region, outcome, time and note | Next change; Undo quiet |
| Document changed | Status line under the header | Unchanged (apply still checks the passage) |
| All decided | The list, every square filled; quiet Review again · New review · Export record | Record this round (Word), Download tracked document (browser), else Review again; after recording, "Recorded as round n" and one line: save the document in Word before sending |
| Error | The error's own words above the button; when the passage can no longer be found, a white region (not the ink block) with Copy wording · Dismiss | The action that can actually recover (Review again) |
| List | The same list with open rows; "N to decide" above the button; drawers for Ask, This review, Activity | Continue (to the first open point) |

## What was replaced

`../DESIGN.md` describes the previous "Margin" interface (green actions, amber attention, rounded cards). It is kept for the record with a pointer to this file.
