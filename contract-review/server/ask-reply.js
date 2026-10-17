// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's reply, read leniently (17 Oct 2026, found in Word: "The model did not return a JSON object." for "What did they
// change in this draft?"). The model is asked for one JSON object; it sometimes wraps it in a code fence or a sentence,
// or answers in Markdown prose instead. The object is found wherever it is; without one Ask asks once more, then shows
// the prose with a plain line that its sources could not be checked. Errors are said in words a lawyer can act on.

/** The correction sent with the second attempt when the first reply had no JSON object. */
export const ASK_CORRECTION = 'Your previous reply was not the JSON object described in the instructions. Return only the JSON object described, with your answer in its "answer" field: no text before or after it and no code fence. Make no further lookups unless a quote needs checking.';

const isAnswer = v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.answer === 'string';
const tryParse = s => { try { return JSON.parse(s); } catch { return undefined; } };
/** The balanced object starting at `start` (respecting strings), or null. */
function balanced(str, start) {
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inString) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

/**
 * Ask's answer object out of a reply: the whole reply, a fenced block, or the first balanced object with an `answer`
 * string anywhere in the text (so a sentence with braces before it does not hide it). Null when there is none.
 */
export function parseAskReply(text) {
  const str = String(text ?? '').trim();
  if (!str) return null;
  const whole = tryParse(str); if (isAnswer(whole)) return whole;
  for (const m of str.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) { const v = tryParse(m[1].trim()); if (isAnswer(v)) return v; }
  for (let i = str.indexOf('{'); i >= 0 && i < str.length; i = str.indexOf('{', i + 1)) {
    const chunk = balanced(str, i); if (!chunk) continue;
    const v = tryParse(chunk); if (isAnswer(v)) return v;
  }
  return null;
}

/** A prose reply as an answer to show: code fences dropped, trimmed, bounded. Empty when there is nothing to show. */
export function proseAnswer(text) {
  const s = String(text ?? '').replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (tryParse(s) !== undefined) return ''; // JSON without an answer is not prose to show
  return s.length > 12000 ? `${s.slice(0, 11999)}…` : s;
}

// Messages already written for the lawyer (input checks in the route and askQuestion) pass through unchanged.
// The replay executor's coverage line ("The recorded runs do not include "ask" for this document…") is written for people too:
// without it the pane said "Ask again", which a recording never answers (readiness audit, 17 Oct 2026).
const PLAIN = [/^Ask a question of up to/, /^The selected passage is no longer present/, /^This selection is removed wording/, /^No answer came back/, /^A document with paragraphs is required/, /^Document exceeds the prototype limit/, /^Playbook exceeds/, /^Supplied document data exceeds/, /^Unknown playbook/i, /^The recorded runs do not include/];
// The review's own input checks (the route's validateDocument, reviewDocument's and reviseFinding's checks) are written
// for people too.
const REVIEW_PLAIN = [...PLAIN, /^Supply a document with/, /^Document paragraphs must have/, /^Document paragraphs need/, /^Recorded original text/, /^A saved playbook is required/, /^Playbook rules need/, /^Baseline paragraphs/, /^Unknown review mode/, /^The finding to revise must/, /^Give a short instruction/, /^That playbook/i];
const ASK_WORDS = { busy: 'The model is busy or at its usage limit. Wait a moment, then ask again.', slow: 'The model took too long to answer. Ask again, or ask a narrower question.', turns: 'The model ran out of steps before it answered. Ask a narrower question.',
  start: 'The model could not be started on this computer. Check the review setup under Settings · Models, then ask again.', setup: 'The model is not signed in or set up. Check the review setup under Settings · Models, then ask again.', store: 'The document store could not be read. Ask again.', other: 'The question could not be answered. Ask again.' };
const REVIEW_WORDS = { busy: 'The model is busy or at its usage limit. Wait a moment, then review again.', slow: 'The model took too long to review this draft. Review again.', turns: 'The model ran out of steps before it finished the review. Review again.',
  start: 'The model could not be started on this computer. Check the review setup under Settings · Models, then review again.', setup: 'The model is not signed in or set up. Check the review setup under Settings · Models, then review again.', store: 'The document store could not be read during the review. Review again.',
  unreadable: 'The model’s reply could not be read as a review. Review again.', other: 'The review could not be completed. Review again.' };
function category(e) {
  const m = String(e?.message || e || '');
  if (/usage limit|rate[ _-]?limit|quota|\b429\b|too many requests|overloaded|\b529\b/i.test(m)) return 'busy';
  if (/timed? ?out|timeout|ETIMEDOUT|SIGTERM|SIGKILL/i.test(m)) return 'slow';
  if (e?.code === 'tool_turns_exhausted' || /every turn|max[_ ]turns/i.test(m)) return 'turns';
  if (/could not start|not on PATH|ENOENT/i.test(m)) return 'start';
  if (/API_KEY|needs .*key|not logged in|authenticat|login/i.test(m)) return 'setup';
  if (/store/i.test(m)) return 'store';
  if (/JSON|findings array|review structure|no revised finding/i.test(m)) return 'unreadable';
  return 'other';
}
/** Any Ask failure in words a lawyer can act on; internals (CLI output, HTTP codes, parser messages) never reach the pane. */
export function askErrorMessage(e) {
  const m = String(e?.message || e || '');
  if (PLAIN.some(r => r.test(m))) return m;
  const c = category(e); return ASK_WORDS[c] || ASK_WORDS.other;
}
/** A review's or a revision's failure in the same plain words (stress audit, 17 Oct 2026: "The model did not return a JSON object."). */
export function reviewErrorMessage(e) {
  const m = String(e?.message || e || '');
  if (REVIEW_PLAIN.some(r => r.test(m))) return m;
  return REVIEW_WORDS[category(e)] || REVIEW_WORDS.other;
}
