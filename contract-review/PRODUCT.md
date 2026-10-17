# GinChugger
<!-- impeccable:product-schema 1 -->

## Platform
Web application with an optional Word task pane. The pane has one job (decision 184): review the open draft against the playbook, apply or dismiss each point, and ask about the draft. The web app holds the Inbox, the Library, each document's page, the playbook, the trash and settings. Documents live in a document store: Paperless-ngx, run unmodified as a separate local service and never shown to users (decisions 190 and 191). In team mode it runs on the team machine only, and each lawyer's app reaches it through the team server, acting as that lawyer.

## Stack
React/Vite, local Node server, Paperless-ngx in Docker as the document store behind our own store interface, DOCX import/export, configurable model adapter. Architecture remains replaceable.

## Users
A small in-house legal team reviewing routine agreements under queue pressure. This is the assumed operating context, not a claim about any verified team's workflows.

## Product Purpose
Reduce repetitive investigative preparation while preserving lawyer judgment. Provide a working prototype with visible evidence and reproducible development checks.

## Operating Context
Operate mode: document-first legal review. The agreement remains the primary surface; guidance and questions sit alongside it. A saved playbook and current document are required; a supplied prior version is optional. No mailbox, CLM or historical repository is assumed.

## Capabilities and Constraints
Explicit review, evidence-linked findings, editable playbook (by hand, in the web app), human-triggered tracked edits, review notes and on-demand questions. Every review uses the model route configured in Settings (Claude CLI, Anthropic API or an OpenAI-compatible endpoint). Documents are flat: each has a counterparty, a type, tags (such as "signed" and "on hold"), a date, notes and full-text search. New documents arrive in the Inbox; a lawyer checks the labels and clicks Done. The Library lists every document with filters and search. A document's page shows its preview, labels, notes, history and similar documents. The trash restores what was moved there; a signed document, or one an admin has put on hold, cannot be trashed, and only an admin sets or lifts a hold. The model reads the store through four read-only tools, and only inside a review or a question (no external MCP access, decision 188). Citations to other documents are verified against their text. The pane says which playbook it uses, what the review did not check, and asks why a point is dismissed: only "Accept their wording" is recorded as a position. Text the counterparty can read names no playbook or rule, and tracked changes carry the lawyer's name. No autonomous approval, silent policy learning, fake lawyer validation or productivity claims. Actual Word-host validation remains pending.

## Evidence on Hand
Complete public NDA-derived fixtures, controlled mutations and two compact constructed commercial extracts. Reference labels are evaluator-only. No internal contracts or validated organizational policies supplied. GinBench, the benchmark, scores the same review code the product runs; its code is in `tough-eval/`, a folder that keeps its old name until the next benchmark version because the frozen benchmark's hashes key on paths.

## Product Principles
Keep the document visible. Make evidence easy to check. Distinguish current wording, recorded revisions and supplied comparison history. Expose stale findings. Make uncertainty actionable. Let the reviewer decide.
