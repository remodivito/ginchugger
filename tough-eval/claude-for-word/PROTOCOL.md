# Claude for Word on the tough eval (arm C)

Does Anthropic's Claude for Word, given the same playbook, review as well as Margin? Ten development cases, one pass each, done by hand in Word, scored by the same scorer as every other run.

## Before you start

- Documents: `input/Agreement A.docx` to `input/Agreement J.docx`. The names are neutral on purpose; which case each one is lives in `sample.json`, which you don't need to open.
- Playbooks: Agreements **A–H** use `input/playbook.txt`. Agreements **I and J** (the long ones) use `input/playbook-bundle.txt`.
- Note which model Claude for Word is using (shown in its panel or settings). Use the strongest one available, and the same one for all ten.
- Keep one Claude for Word conversation per document. Close the document before opening the next.

## For each document

1. Copy it into a new folder `output/` next to `input/` (so the original stays clean), and open the copy in Word.
2. Open Claude for Word and paste this prompt, followed by the whole playbook text file (A–H: `playbook.txt`; I–J: `playbook-bundle.txt`):

   > We are the Customer. Review this agreement against our playbook below. For every provision that departs from the playbook, edit the wording as a tracked change so it meets at least an acceptable position, and add a comment on that provision naming the playbook entry ID (for example C-05) with a one-line reason. Do not edit or comment on anything that already complies. Make all the edits in the document; don't ask me to confirm them.
   >
   > [playbook text]

3. Let it finish. If it stops partway or asks for confirmation, reply only "Continue with all the edits." Do not steer it towards anything specific.
4. Don't accept or reject its tracked changes. Save the document (same name, in `output/`).
5. Jot anything notable in `notes.md` (time taken, whether it asked questions, anything odd).

About 3–6 minutes per document; under an hour in all.

## Then

Tell Claude Code it's done. It runs `node tough-eval/claude-for-word/ingest.mjs` and compares the result with Margin on the same ten cases (and plain Claude with the same playbook, arm B).

## Fairness notes

- Claude for Word gets what Margin gets: the agreement and the playbook. The prompt asks for the same output (edits with the rule named), so the scorer can read it. It is told nothing about what was planted.
- The ID in the comment is how the scorer knows which rule a change answers; Margin is held to the same requirement.
- One pass each, as for the open models. Margin's numbers on these ten cases come from three runs; the comparison will say so.
- Scoring reads tracked changes and comments only. Anything Claude for Word says in its chat panel but does not put into the document is not counted, because a lawyer receiving the document would not see it either.
