# ContractNLI label audit (development split)

A hand reading of every labelled departure in the development NDAs the reviewer had processed when the first calibration run was half done (14 October 2026, 29 of 61 documents, Opus 5.5 medium, run `2026-10-14T10-18-40Z-cnli-dev-opus55`). The point is to know how far the published labels can be trusted as ground truth before any number is quoted. Nothing here changes a label: the scorer uses the dataset as published, and this audit is reported beside the scores.

## The reviewer's "misses" (gold departure, reviewer did not flag): 7

| Document, rule | Gold label and passage | Reviewer | Reading |
|---|---|---|---|
| N007 NDA-02 | Entailment ("confidential information shall only include technical information"); passage lists "commercial, marketing and business information, strategic and development plans..." | within-guidance: the definition is broad | **Label wrong.** The contract plainly covers business information. |
| N007 NDA-17 | Contradiction ("may create a copy"); passage: "not to copy... except as may be reasonably necessary for the Purpose" | within-guidance: copying permitted as necessary | **Label wrong.** The exception permits copies. |
| N009 NDA-05 | Contradiction ("may share with some employees"); passage: employees must be disclosed to and approved by BPS and sign the agreement | within-guidance: approved employees may receive, which is the acceptable tier | **Label arguable, probably wrong.** Sharing is permitted, conditionally. |
| N015 NDA-01 | Entailment ("all confidential information shall be expressly identified"); passage: "mark or otherwise designate... to show expressly or by necessary implication" | within-guidance: "by necessary implication" is a catch-all | **Label coarse.** Identification is required but may be implicit; the playbook's preferred position is met on the reviewer's reading. |
| N027 NDA-01 | Entailment; passage has a catch-all for information that "ought to be treated as confidential" | within-guidance | **Label coarse or wrong.** A catch-all means not all information must be expressly identified. |
| N032 NDA-01 | Entailment; marking is only limb (c) of a three-limb definition | within-guidance: marking is an alternative, not a condition | **Label coarse or wrong.** |
| N069 NDA-01 | Entailment; "All such Information shall be identified as confidential... in accordance with the following" | within-guidance | **Genuine miss.** Identification is a condition of protection; the reviewer read the regime as acceptable. |

Six of seven are label problems on the reviewer's reading; one is a real miss. Recall on the published labels was 27 of 34 (79%); on the labels as read here it would be 33 of 34.

## The second half of the run (documents 30–61, read after the run finished)

Final figures on the published labels: 77 departures, 62 caught (80.5%), 55 of those on the gold passage (88.7%). Eight further misses:

| Document, rule | Gold label and passage | Reviewer | Reading |
|---|---|---|---|
| N152 NDA-20 | Contradiction (no retention); products and residue to be returned within 120 days or destroyed | attention, but cited under NDA-16 (return or destruction), not NDA-20 | **Genuine miss on the rule citation.** The clause was found; the departure was filed under the neighbouring rule. |
| N205 NDA-16 | Contradiction ("shall destroy or return"); the contract requires return or destruction on request and permits retained copies | within-guidance: return or destroy on request, more protective than acceptable | **Label wrong.** The obligation exists; retention is NDA-20's point. |
| N381 NDA-01 | Entailment (must be expressly identified); the definition covers "all other confidential and proprietary information" with no marking requirement | within-guidance | **Label wrong.** |
| N405 NDA-01 | Entailment; "regardless of whether such information is specifically identified" | within-guidance | **Label wrong.** The passage says the opposite. |
| N406 NDA-01 | Entailment; protection where written material is marked, oral disclosures denominated, "or" otherwise reasonably identifiable | within-guidance | **Label coarse.** Marking is one route of three. |
| N406 NDA-17 | Contradiction (no copies); "must not... duplicate, reproduce... except to perform the Project" | within-guidance: copying permitted for the Project | **Label wrong.** |
| N456 NDA-02 | Entailment (technical only); the gold passage is an export-control clause | no finding on NDA-02 | **Label and span doubtful.** The cited passage is not about the definition. Counted as a miss. |
| N547 NDA-16 | Contradiction; "will promptly return... or destroy all documents" on written request, destruction confirmed in writing | within-guidance | **Label wrong.** |

Across the whole run: 15 misses on the published labels, of which two are the reviewer's (N069 NDA-01; N152 NDA-20, right clause, wrong rule), one doubtful either way (N456), and twelve are label problems on this reading. Recall on the labels as read here would be about 95%.

## False alarms on the silence-acceptable rules

The scorer counted 0.97 false alarms per NDA, almost all on two rules. NDA-11 (reverse engineering, 29): the playbook's acceptable tier read "the agreement is silent and no tangible materials or software are exchanged", and the reviewer took any mention of software, samples or products as reason to flag the omission. That is the playbook's wording inviting the flag, so it is corrected in playbook v2 (silence acceptable without condition), a calibration change on the development split, recorded. NDA-16 (return or destruction, 20): on reading, most are absolute return-everything obligations the reviewer filed under NDA-16 as well as NDA-20; the playbook wording is not at fault and these are left as scored.

## The reviewer's catches that did not land on the gold passage: 5 of 27 at the halfway point, 7 of 62 at the end

N003 NDA-01, N009 NDA-07, N017 NDA-07, N054 NDA-07, N070 NDA-07. In each the reviewer cites a different paragraph on the same topic (the oral-disclosure limb instead of the documentary-marking limb; the general prohibition instead of the representatives clause). None is an invented passage; all quotes verified. "Located" therefore measures agreement with the annotator's choice of span as much as citation accuracy, and is reported as such.

## Flags the labels call compliant or silent

The reviewer raised 8.2 points per NDA. On the pairs the dataset labels Entailment-as-compliant, it flagged 118 of 256; on pairs labelled NotMentioned, 92 of 203. Reading a sample of each: the flags on "compliant" pairs are the playbook's graded positions applied to contracts the yes/no hypothesis accepts (oral disclosures protected only under two cumulative conditions; third-party disclosure only with consent at sole discretion; an internal inconsistency between a blanket prohibition and a representatives carve-out). The flags on "silent" pairs are omissions the playbook wants filled (no notice before compelled disclosure) or positions inferred from other clauses (an absolute "return all copies" read as "no retention"). The dataset's labels cannot say whether these are right, so the scorer reports them as "stricter than label" and "omission flags" rather than as false alarms, and only flags on silent pairs for rules whose playbook position accepts silence count as false alarms.

## What this means for the layer

- The headline is **recall of labelled departures, with citation**, not precision: the labels are good enough to say what the reviewer missed, not good enough to say what it over-flagged.
- The label error rate on departures, about one in five of the "misses" being the label's fault rather than the reviewer's, is consistent with the paper's single-adjudicator annotation and no published agreement figures.
- A per-release hand audit of the misses, as here, is part of the method for this layer.
