# ContractNLI layer (layer B of the benchmark)

Real NDAs, labelled by someone other than us. 607 non-disclosure agreements from ContractNLI (Koreeda & Manning, Findings of EMNLP 2021; CC BY 4.0; provenance and checksum in `data/README.md`), each labelled against 17 fixed statements with a verdict (Entailment, Contradiction, NotMentioned) and the evidence spans. Built 14 October 2026 under decision 148.

## How the dataset becomes a review task

- **Document.** Each NDA is a variant in the product's document shape; its paragraphs are the dataset's spans, so an evidence span always maps onto whole paragraphs. `build.mjs` writes `variants/N###.json`, `manifest.json` (with the gold label per rule) and `split.json`.
- **Playbook.** `playbook-nda.json`: one rule per hypothesis, written from the balanced, mutual stance (Common Paper Mutual NDA, oneNDA), with preferred, acceptable and escalation positions. The hypotheses are the dataset's; the positions are ours, written before any model ran on this layer, and not tuned to results.
- **Gold verdict.** `rules.mjs` maps each dataset label to a verdict against the playbook: for most rules the hypothesis states the balanced position, so *Contradiction* is a departure; for three (express identification of all confidential information, confidential information limited to technical matter, non-solicitation) the hypothesis states the one-sided position, so *Entailment* is the departure. *NotMentioned* is always "silent": this layer does not treat silence as a departure for any rule, because that would be a judgement made by us alone. The dataset labels absence explicitly, so silence-as-departure can be scored as a variant later.
- **Reviewer's finding.** An "attention" finding citing the rule is "departs"; anything else is "ok".
- **Split.** The dataset's own: dev (61) is our development split, test (123) the held-out split scored once per release, train (423) a pool run only on request.

## Scoring (`score.mjs`)

What the labels can support, learned in the 14 October calibration (`label-audit.md`): they are yes/no hypotheses, the playbook is graded, and the product never reports "silent" (it reports acceptable silence as within-guidance and unacceptable silence as a departure). So the layer's headline is **recall of labelled departures, with citation**, not precision:

- **caught**: gold departures with a departs finding; **located**: a caught departure whose finding sits on a gold evidence paragraph (by id or verified quote). Located measures agreement with the annotator's choice of span as much as citation accuracy.
- **false alarms**: departs findings on pairs the dataset labels NotMentioned, for the six rules whose playbook position accepts silence. The one class of flag the labels can call wrong.
- **stricter than label** (departs where the dataset says the contract complies) and **omission flags** (departs on a silent pair where the playbook wants the term present): reported per rule, audited by hand, not scored.
- **agreement on labelled pairs**: departs/ok against the label's, over Entailment and Contradiction pairs.
- the hallucination gate (unverifiable quote or unknown rule ID fails the document); **all-pass**: every gold departure caught and located, no false alarm, no hallucination, review usable; failed reviews count as nothing found.

`selftest.mjs` checks the scorer with an oracle, a silent reviewer, a flag-everything reviewer, an inventor of quotes and a misplacer of citations. An earlier three-way design (departs / complies / silent, scored as verdict accuracy) was dropped the same day: see the decision log for 14 October.

## Running

```sh
node tough-eval/contractnli/build.mjs                         # once, from data/
node tough-eval/contractnli/selftest.mjs
node tough-eval/run.mjs --suite contractnli --name cnli-opus55 --model claude-opus-5-5 --effort medium --variants development --concurrency 4
node tough-eval/contractnli/score.mjs runs/<runDir>
```

What this layer does not measure: fixes (the dataset has no reference wording), and anything about the quality of the positions themselves. Its labels have one primary annotator and no published agreement figures; a first reading found them mostly sound, with some evidence spans pointing at a definition clause rather than the operative wording, and a few documents that are not NDAs (government statements of work, employee restrictive covenants). The labels are public, so contamination cannot be excluded; the layer is reported as secondary to the planted-departure layer for that reason.
