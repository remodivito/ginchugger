# Notices and provenance

GinChugger is licensed under the GNU General Public License v3.0 or later (see `LICENSE`). This file records what in the repository comes from elsewhere and on what terms.

## Ported code

Components translated into this codebase from other GPL-licensed projects, with the source and licence. Each ported file also carries this in its header.

- `contract-review/server/ports/paperless/matching.js`: correspondent matching (`matches`, `_split_match`, and the time-guarded regex search `safe_regex_search` / `validate_regex_pattern`), translated to JavaScript for GinChugger on 15 October 2026 (modified: the classifier mode is left out and the model is plain data). Source: Paperless-ngx (https://github.com/paperless-ngx/paperless-ngx), GPL-3.0, files `src/documents/matching.py` and `src/documents/regex.py` at commit `c50c6f5517e3fd8f97fa546ede69a52b622e2b20`. The original files, with Paperless's tests `src/documents/tests/test_matchables.py`, are kept unchanged in `contract-review/server/ports/paperless/reference/`. Its fuzzy mode follows `fuzz.partial_ratio` of rapidfuzz 3.14.6 (MIT, Max Bachmann). Known differences: `contract-review/docs/ports/known-diffs.md`.
- `contract-review/server/ports/paperless/mail.js`: the mail consumer's logic (rule criteria `make_criterias`, the mail actions and `get_rule_action`, `mailbox_login`, `apply_mail_action`, host pinning `get_mailbox` / `PinnedIMAP4` / `PinnedMailBox`, and `MailAccountHandler`: title and correspondent selection, UIDVALIDITY-aware processed-mail tracking, attachment selection with `fnmatch` include and exclude filters, `.eml` consumption) with the rule model's choices from `models.py`, translated to JavaScript for GinChugger on 15 October 2026 (modified: Django, Celery, the GPG preprocessor, the OAuth refresh manager and temporary files are left out; IMAP is imapflow and MIME is mailparser; criteria are data objects; skipped attachments and rule errors are kept for the status page). Source: Paperless-ngx, GPL-3.0, `src/paperless_mail/mail.py` and `src/paperless_mail/models.py` at commit `c50c6f5517e3fd8f97fa546ede69a52b622e2b20`.
- `contract-review/server/ports/paperless/network.js`: `is_public_ip` and `resolve_hostname_ips`, translated to JavaScript on 15 October 2026 (modified: Python `ipaddress` ranges spelled out over node:net BlockList; the httpx transports are left out). Source: Paperless-ngx, GPL-3.0, `src/paperless/network.py` at the same commit.
- `contract-review/tests/fixtures/paperless/bogus-mailbox.js` and `contract-review/tests/paperless-mail.test.js`: Paperless-ngx's `BogusMailBox`, `MessageBuilder` and mail tests (`src/paperless_mail/tests/helpers.py`, `test_mail.py`, `test_mail_nfc.py`, `src/paperless/tests/test_network.py`, same commit), translated to JavaScript on 15 October 2026 (modified: the simulated mailbox sits at the imapflow client boundary). The original Python files are kept unchanged in `contract-review/server/ports/paperless/reference/`.

## Paperless-ngx as a separate service (decision 191)

GinChugger uses Paperless-ngx 3.3.2 (https://github.com/paperless-ngx/paperless-ngx, GPL-3.0) unmodified, as a separate program in its own Docker containers, pulled from its published image `ghcr.io/paperless-ngx/paperless-ngx:3.3.2`. Its web interface is not shown to users. Our code talks to it only over its HTTP API (`contract-review/server/store/paperless.js`).

We ship only a compose file, `contract-review/paperless/docker-compose.yml`, derived from upstream's `docker/compose/docker-compose.sqlite-tika.yml` at v3.3.2. Its header lists the changes: every image pinned; the web server published on 127.0.0.1 only; bind mounts under one data folder instead of named volumes; secrets read from a `paperless.env` file the app writes on first start; restart "unless-stopped"; the scheduled classifier training switched off.

The same compose file runs these images, also unmodified:

- `docker.io/valkey/valkey:9-alpine`: Valkey (BSD-3-Clause), the task broker.
- `docker.io/apache/tika:3.3.1.0`: Apache Tika (Apache-2.0), text extraction.
- `docker.io/gotenberg/gotenberg:8.37`: Gotenberg (MIT), document conversion.

None of these images is redistributed in this repository; Docker pulls them from their publishers.

## DMS batch 1 (16 October 2026)

These files were removed from the repository on 16 October 2026 with decision 190: the document store now provides the trash, notes and history. `contract-review/server/record/inbox.js` was removed at the same time. The provenance below is kept as a historical record; those files are not part of this repository.

Ported into the record for the trash, matter notes and the activity screen. Each file names its source, the file and commit in its header and says what was changed. The upstream licence texts are in `contract-review/docs/ports/licences/`.

- `contract-review/server/record/trash.js`: the trash's restore and empty actions, the purge after N days and the days-remaining count, translated from Paperless-ngx (GPL-3.0), commit `30a24ee02e8869fb0838c903b132acb914cd6b09`: `src/documents/tasks.py` (`empty_trash`), `src/documents/views.py` (`TrashView`), `src/paperless/settings/__init__.py` (`EMPTY_TRASH_DELAY`) and `src-ui/src/app/components/admin/trash/trash.component.ts` (`getDaysRemaining`). The permanent-delete checks (refuse what is not in the trash; delete the stored file only when nothing else references it) follow OpenContracts (MIT), commit `2b7dda249923ea1e8f2f3ea45c39f2ee32717bbb`, `opencontractserver/documents/versioning.py` (`permanently_delete_document`, `restore_document`). Modified: the soft delete is an event in the record's ledger, not a `deleted_at` column; a purged matter keeps a tombstone.
- `contract-review/server/record/notes.js` and `foldNotes` in `server/record/projections.js`: matter notes, translated from Paperless-ngx (GPL-3.0, same commit) `src/documents/models.py` (`Note`) and `src/documents/views.py` (`DocumentViewSet.notes`), and from OpenContracts (MIT, same commit) `opencontractserver/annotations/models.py` (`Note.version_up`, `NoteRevision`: version counter, unified diff, SHA-256 checksums). Modified: each revision is an event carrying the full text; the author alone edits or deletes a note.
- `contract-review/server/record/activity.js`: the paged, filtered audit query, translated from Papermerge (Apache-2.0, Copyright Eugen Ciur), commit `1f0c8c4682aa6a9f1f0ad185874b23aba0a9b907`, `papermerge/core/features/audit/db/api.py` (`get_audit_logs`). Modified: it reads the record's `events` table (no triggers); free-text search and other sort columns left out.
- `contract-review/src/pages/activity.js`: event types grouped in labelled namespaces, the unknown-type label and the "System" actor, translated from Mayan EDMS 4.5.13 (Apache-2.0, Copyright 2024 Roberto Rosario), from the 4.5.13 source distribution: `mayan/apps/events/classes.py` (`EventTypeNamespace`), `mayan/apps/events/html_widgets.py` (`widget_event_type_link`, `widget_event_actor_link`) and `mayan/apps/events/literals.py` (`TEXT_UNKNOWN_EVENT_ID`). Modified: the labels and namespaces are GinChugger's own event types. Only 4.5.13 (Apache-2.0) was used; Mayan 4.6 and later (GPL-2.0-only) were not.
- Screens (`contract-review/src/pages/Trash.jsx`, `Activity.jsx`, the Notes section of `MatterTimeline.jsx`) were written new in React after the layouts of Paperless-ngx's trash page, Papermerge's audit-log list and Mayan's event list; no markup was copied. `src/pages/note-text.js` (markdown-lite) is written new.
- Nothing was copied from Docspell (AGPL-3.0), Teedy (GPL-2.0) or Mayan 4.6 and later.

OpenContracts licence notice (MIT), as its licence requires, kept for the files' history:

> Copyright (c) 2026 John Scrudato IV
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Papermerge and Mayan EDMS 4.5.13 are under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0; full text in `contract-review/docs/ports/licences/Apache-2.0-papermerge.txt`). Neither ships a NOTICE file at the commits used.

## Designs and ideas

Not copyrightable, credited as a courtesy:
- The counterparty-as-entity ("correspondent"), document direction and symmetrical document-link model: Paperless-ngx (GPL-3.0) and Docspell (AGPL-3.0), from their documentation.
- Duplicate detection by content checksum, linking a duplicate rather than refusing it (`contract-review/server/record/inbox.js`, written fresh, no code copied; removed with decision 190, when the store took this over): the idea of Paperless-ngx's `pre_check_duplicate` and its v3 behaviour of accepting and linking duplicates.
- The immutable-file-plus-version split: Mayan EDMS (GPL-2.0), from its documentation.
- The clause-level position register with hashed citations: contract-opf playbook-engine (Apache-2.0).
- Keying precedent by clause type across matters, and the playbook-drift design kept as a parked idea: Anthropic's `claude-for-legal` repository (Apache-2.0), from its documentation and prompts; no code copied.

## Data

- Common Paper Cloud Service Agreement, DPA, SLA and Mutual NDA: CC BY 4.0, Common Paper.
- Common Paper documents in this repository: `contract-review/data/source-common-paper-nda-v1.json` (Mutual NDA Standard Terms v1.0, see `contract-review/docs/DATA.md`) and `tough-eval/sources/*.docx` (Cloud Service Agreement v2.1, DPA v1.1, SLA v2.0, Mutual NDA v1.0), with the benchmark's base documents built from them (`tough-eval/base*.json`, `tough-eval/v2/base-*.json`, `tough-eval/variants/`, `tough-eval/claude-for-word/input/`). Adapted from Common Paper's standard agreements, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); cover terms and planted edits are ours; no endorsement by Common Paper is implied. Details: `tough-eval/sources/ATTRIBUTION.md`.
- ContractNLI (Koreeda & Manning 2021): CC BY 4.0, Hitachi America, Ltd.; see `tough-eval/contractnli/data/README.md`. The data and the variants built from it: `tough-eval/contractnli/data/contract-nli/` (the dataset's own `LICENSE`, `TERMS` and `README.md` are kept beside it) and `tough-eval/contractnli/variants/`.
- RedlineBench (Crosby Legal and micro1), dataset `crosbylegal/RedlineBench` on Hugging Face at revision `eee1b6790982ed1279e86bec7616b662a61993e6`, CC BY 4.0: the layer C tasks under `tough-eval/v2/layer-c/` (`source/`, `documents/`, `golden/`, `markup/`, `playbooks/` and `layer-c-tasks.json` are taken or derived from it). Details: `tough-eval/sources/ATTRIBUTION.md`.
- Harvey LAB (https://github.com/harveyai/harvey-labs, commit `f93ae2ac2831e65892fea83094cfb50149bc2e59`), MIT, Copyright (c) 2026 Harvey AI: the synthetic "Velantis" NDA negotiation playbook in `contract-review/tests/fixtures/playbooks/velantis-nda-negotiation-playbook.txt` (rendered to text from the task's `.docx`) and the Velantis NDA payload in `contract-review/tests/fixtures/exp008-v1.1/`. Licence text: `contract-review/docs/ports/licences/MIT-harvey-labs.txt`.
- `contract-review/data/clause-types.json`: the clause types are the CUAD v1 category list (The Atticus Project, Contract Understanding Atticus Dataset; Hendrycks, Burns, Chen and Ball 2021), CC BY 4.0.

## Dependencies

npm dependencies keep their own licences (MIT, ISC, Apache-2.0, BSD; the mail consumer uses imapflow 2.1.2 (MIT, Postal Systems OÜ), mailparser 3.9.32 (MIT, Andris Reinman) and @azure/msal-node 7.0.0 (MIT, Microsoft)), all compatible with use inside a GPL-3.0 project; see each package's `LICENSE`.
