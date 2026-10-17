# Starter history fixture (spec R8.7, task T16)

Seven files and a hand-written `truth.json`, built by `node scripts/build-history-fixture.mjs` (deterministic; hashes in `truth.json`).

**One negotiation, three rounds.** Helix Instruments Ltd (our side) sends its NDA to Brightwater Analytics Ltd; Brightwater returns a tracked markup (three changes: confidentiality period 3 → 7 years, a backup-retention carve-out, a residuals sentence); Helix counters, tracked against the accepted markup (7 → 5 years, residuals narrowed, retention accepted). Two cover emails carry the markup and the counter-turn; a third email, in the same thread, is the counterparty's explanatory comment that it "could live with five years if the trade-secret tail stays as drafted". That comment is the history a later review of the counter-turn should surface beside the term finding.

**One trap.** `helix-oakfield-nda-v1.docx` is the same form, sent the same month to a different counterparty, with a similar filename and identical standard terms. It must not join the Brightwater matter. Text resemblance between it and the Brightwater v1 is high (only the cover differs); party names are the signal.

**Provenance.** Standard terms are the public Common Paper Mutual NDA Standard Terms v1.0 (CC BY 4.0, https://commonpaper.com/standards/mutual-nda/1.0/), via `data/source-common-paper-nda-v1.json`. Cover fields, parties, people, addresses, email domains (`.example`), dates and all changes are fictional constructions. Tracked changes carry named authors and dates (unlike the Harvey synthetic documents, which carry none); emails carry Message-ID / In-Reply-To headers so threading signals exist. Nothing here is a real negotiation, and nothing in the files establishes any policy.

**What the truth file records.** Matter membership, round order, which document each markup was made against, email-to-document links (carries / comments on), the trap, and the prior-round comment with its exact quote.
