# Documentation

## The app

- [Setup](../contract-review/docs/SETUP.md): from a fresh machine to a first review.
- [The app in detail](../contract-review/README.md): what it does, how it is built, the team server.
- [Word setup](../contract-review/docs/WORD.md) and [for IT and security teams](../contract-review/docs/FOR-IT.md).
- [Security review](../contract-review/docs/SECURITY-REVIEW.md): a red-team pass by the people who built it, with regression tests in `contract-review/tests/security/`.
- [Verification record](../contract-review/docs/VERIFICATION.md): what has and has not been checked by a person.
- [Limits](LIMITS.md).

## GinBench

- [Specification](../tough-eval/BENCHMARK-V2.md) and [results](../tough-eval/RESULTS.md); the [summary with commentary](../tough-eval/v2/RESULTS-2026-10-17.md); the [frozen layer A report](../tough-eval/v2/frozen/REPORT.md).
- The README charts are drawn from [`tough-eval/v2/charts/data.json`](../tough-eval/v2/charts/data.json), which a test checks against the frozen report. `node tough-eval/v2/charts/render.mjs` redraws them (after `npm install` in `contract-review/`).

GinBench v2 has four layers, reported separately and never merged into one score:

- **A. Planted deviations.** Edits planted in Common Paper's public agreements (CSA and Mutual NDA, both sides of each), beside harmless edits that should not be flagged. Three model families wrote the items; each item was checked by the two families that did not write it.
- **B. Real NDAs.** The ContractNLI test split (123 NDAs), with the dataset's published labels mapped to a playbook.
- **H. History.** Scenarios in which the reviewer must use the document store correctly: cite precedent, refuse bait concessions, ignore the wrong counterparty, ignore instructions injected into documents.
- **C. Attorney fixes.** Three tasks adapted from RedlineBench, judged by two model judges against attorney redlines.

Code scores layers A, B and H against an answer key. A review with an invented quote fails. Results are an error profile per setup with confidence intervals; there is no pass mark. Layer A is frozen; layers H, B and C are preliminary ([report](../tough-eval/v2/prelim/REPORT.md), [write-up](../tough-eval/v2/PRELIMINARY-WRITEUP-2026-10-17.md), [audit of B and C](../tough-eval/v2/analysis/audit-B-C-2026-10-17.md)).

**The app and the frozen benchmark.** The frozen layer A runs used the app as it was at the tag `bench-v2.0-a`. The app here has moved on since (live progress for questions, reviews that can be stopped, the security fixes), so `contract-review/server/review.js`, `server/executors.js`, `server/store/tools.js`, `server/store/text.js` and `package.json` differ from the frozen hashes. The review's request to the model is unchanged since the tag (same prompt, payload and CLI flags), and `contract-review/tests/review-nonblocking.test.js` pins it. The tag is in the project's private history, not in this repository, so a re-run from this snapshot would be a new benchmark version. `node tough-eval/v2/check-frozen.mjs` lists the changed files and the held-back ones.

**v1.** The earlier suite (one Common Paper CSA plus a 60,000-character bundle, items written by one model) is kept in `tough-eval/` as v2's development set and described in [its README](../tough-eval/README.md). It is published whole, including the 24 cases its `split.json` marks as held out: their plant definitions are in v1's generator and manifests anyway. v1 is superseded and none of its held-out results is claimed.

## What is held back, and why

Publishing the test items before every frozen result is in would let anyone, or any model trained on this repository, see the answers. These parts will be published with the frozen results:

- **Layer A test items:** `tough-eval/v2/items.json`, `markups.json`, `manifest.json`, `inserted-checks.json`, `variants/`, `authoring/`, `verification/`; the contested-item list `ERRATA.md`; and the two item-level error analyses, which quote planted wording.
- **Layer H scenarios:** `tough-eval/v2/scenarios/`, `verification-scenarios/`, `scenarios-manifest.json`.
- **Development authoring runs and the preliminary item snapshot:** `tough-eval/v2/dev/` and `tough-eval/v2/prelim/snapshot-*`.
- **Raw model outputs and logs:** `tough-eval/runs/`, `tough-eval/results/`, the run logs and the raw calibration outputs (the calibration summaries are included). `tough-eval/v2/charts/extract.mjs`, which estimates the open models' costs, reads these runs.

[`tough-eval/v2/frozen.json`](../tough-eval/v2/frozen.json) records the SHA-256 of every file the frozen layer A result depends on, held-back items included, so they can be checked against it once published. Some documents mention files that are not here (the held-back files and the project's working notes); those are plain mentions, not links. One app test that checks results-ledger citations, and one benchmark test that needs the held-back items, skip.

## Tests

No test calls a model.

```sh
cd contract-review
REVIEW_EXECUTOR=refuse-live npm test      # unit and integration; any live model call fails the test
npm run test:e2e                          # end to end, against a fake of Word's API (a fake is not Word)
npm run stress                            # concurrent workflows against its own servers and a stub model

cd ..
node --test tough-eval/arms/*.test.mjs tough-eval/baselines/*.test.mjs tough-eval/v2/*.test.mjs tough-eval/v2/tests/*.test.mjs tough-eval/v2/layer-c/tests/*.test.mjs tough-eval/v2/charts/*.test.mjs
node tough-eval/selftest.mjs              # the v1 scorer against synthetic reviewers with known answers
node tough-eval/contractnli/selftest.mjs  # the same for layer B
```

The benchmark tests import the app's code, so run `npm install` in `contract-review/` first. The end-to-end tests use fixed ports (3197, 3291, 3292); set `E2E_PORT_OFFSET` if those are taken.

## Repository layout

| Path | What it is |
|---|---|
| `contract-review/` | The app: Node.js server, React pages, the Word task pane, the team server, and its tests. |
| `tough-eval/` | GinBench: specification, runner and scorers, public data, base documents, playbooks, reports and the chart pipeline. It keeps this working name until the next benchmark version, because the frozen hashes are keyed on its paths. |
| `docs/` | These pages and the README images. |
| `common-paper-notes.md`, `benchmark-self-bias-research.md` | Short sourced notes the playbooks and the specification cite. |
| `NOTICE.md`, `LICENSE` | Where code, data and ideas come from; GPL-3.0-or-later. |

Some files say "run from `outputs/`": here that is the top-level folder.

## How it was made

The app and the benchmark were built with heavy use of AI coding agents. Models from several families wrote and cross-checked the benchmark items, as the specification describes. This repository is a snapshot without the project's history.
