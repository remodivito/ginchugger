// SPDX-License-Identifier: GPL-3.0-or-later
// The side-parameterised review prompt (arms/plain.md, BENCHMARK-V2.md 10): {side} and {playbookParty} are filled from
// the playbook's `party` field, else from the side its rule ids name (C- Customer, V- Provider), else "client" (the
// product prompt's own word, for a playbook that names no side, such as the balanced ContractNLI NDA playbook).
// review-one.mjs renders the prompt into a file beside the trace and hands that file to the reviewer.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** The party a playbook speaks for. */
export const partyOf = playbook => playbook.party || ({ C: 'Customer', V: 'Provider' })[String(playbook.rules?.[0]?.id || '').slice(0, 2).replace('-', '')] || 'client';
/** The prompt text with its placeholders filled. */
export const fillPrompt = (text, playbook) => { const party = partyOf(playbook); return text.split('{side}').join(party).split('{playbookParty}').join(party); };
/** Fill a side-parameterised prompt; returns the file to use (the original when it has no placeholders). */
export function renderPrompt(file, playbook, dir) {
  const text = readFileSync(file, 'utf8'); if (!/\{(side|playbookParty)\}/.test(text)) return file;
  const party = partyOf(playbook); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.basename(file, '.md')}.${party.replace(/[^A-Za-z]+/g, '-').toLowerCase()}.md`);
  writeFileSync(out, fillPrompt(text, playbook)); return out;
}
