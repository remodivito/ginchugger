![GinChugger](docs/assets/ginchugger-banner.jpg)

<p align="center">Contract review in Word, against your own playbook, and the benchmark that measures it.</p>

<p align="center"><a href="#ginbench">Results</a> · <a href="#the-app">The app</a> · <a href="#run-it">Run it</a> · <a href="docs/README.md">Docs</a></p>

<br>

## GinBench

How often does a model miss a departure from your playbook, raise a false alarm, or invent a quote? GinBench plants deviations in Common Paper agreements and runs the same review code a lawyer uses in Word.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/fully-right-by-cost-dark.png">
  <img src="docs/readme/fully-right-by-cost-light.png" alt="Agreements fully right against cost per review. Opus 5.5: 88% at about 32 cents. DeepSeek V4 Flash: 87% at about 1 cent (estimated). Opus 5.5 with a plain prompt: 85% at about 15 cents. GLM-5.3 Flash: 81% at about 2.5 cents (estimated). Mistral Small 4: 23% at half a cent (estimated).">
</picture>

Opus 5.5 and DeepSeek V4 Flash get about 9 in 10 agreements fully right. DeepSeek, served from the EU, costs about a cent a review; Opus about 32 cents.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/scorecard-dark.png">
  <img src="docs/readme/scorecard-light.png" alt="Scorecard. Planted deviations caught, false alarms per agreement, reviews with an invented quote, agreements fully right. Opus 5.5: 28 of 28, 0.08, 0, 88%. DeepSeek V4 Flash: 28 of 28, 0.11, 1, 87%. Opus 5.5 plain prompt: 27 of 28, 0, 0, 85%. GLM-5.3 Flash with a 131k output limit (declared variant): 26 of 28, 0.12, 1, 76%. GLM-5.3 Flash: 24 of 28, 0.04, 0, 81%. Mistral Small 4: 8 of 28, 2.96, 13, 23%.">
</picture>

<details>
<summary>More results: caught against false alarms, cost and time, own-item advantage</summary>
<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/caught-vs-false-alarms-dark.png">
  <img src="docs/readme/caught-vs-false-alarms-light.png" alt="Planted deviations caught against false alarms per agreement. Opus 5.5 and DeepSeek V4 Flash catch all 28. GLM-5.3 Flash catches 24 with the fewest false alarms. Mistral Small 4 catches 8, with 2.96 false alarms per agreement.">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/cost-and-time-dark.png">
  <img src="docs/readme/cost-and-time-light.png" alt="Median cost and time per review. Cost: Mistral Small 4 $0.005, DeepSeek V4 Flash $0.011, GLM-5.3 Flash $0.025, its 131k variant $0.026 (all estimated), Opus 5.5 plain prompt $0.15, Opus 5.5 $0.32. Time: Opus plain 19 s, Mistral 59 s, Opus 85 s, DeepSeek 307 s, GLM 380 s, GLM 131k 397 s.">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/own-items-dark.png">
  <img src="docs/readme/own-items-light.png" alt="Agreements fully right by which model family wrote the item. No own-item advantage detected for Opus 5.5 or DeepSeek V4 Flash. GLM-5.3 Flash scores 20 points higher on its own items, 95% interval 1.5 to 37 points.">
</picture>

</details>

<sub>Frozen layer A (tag <code>bench-v2.0-a</code>), one run per setup. Open-model costs are estimates from tokens and listed prices. No lawyer has validated the items or answer keys. <a href="tough-eval/RESULTS.md">All results</a> · <a href="tough-eval/BENCHMARK-V2.md">Method</a></sub>

<br>

## The app

Reviews a contract against your playbook inside Word, proposes wording as tracked changes, and reads what your team agreed with the same counterparty before.

<img src="docs/readme/app-review.png" alt="A review of a customer's markup of an order form: nine points, worst first, the first one open beside the tracked change it concerns">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/features-dark.png">
  <img src="docs/readme/features-light.png" alt="Your playbook: preferred position, fallback and hard line for each rule; every finding quotes the clause it rests on. Tracked changes: wording lands in Word under your name, one point at a time. Your team's documents: one store, built on Paperless-ngx; reviews cite past deals word for word.">
</picture>

<br>

## Run it

```sh
cd contract-review
npm install
npm run build
npm start
```

Open http://localhost:3000 and choose a model in Settings. Node.js 22 or later; the document store runs in Docker, or in memory without it. [Full setup](contract-review/docs/SETUP.md)

<br>

---

<sub>A prototype. No lawyer has validated its output, its playbooks or the benchmark, and nothing here is legal advice. [Limits](docs/LIMITS.md) · [Docs](docs/README.md) · [Credits](NOTICE.md) · GPL-3.0-or-later</sub>
