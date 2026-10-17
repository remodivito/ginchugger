// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's reply read leniently, and its errors in plain words (17 Oct 2026; "The model did not return a JSON object." was
// shown in Word for "What did they change in this draft?").
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAskReply, proseAnswer, askErrorMessage, ASK_CORRECTION } from '../server/ask-reply.js';

const obj = { answer: '**Yes.**', evidence: [], ruleIds: [], limits: [] };

test('the answer object is found bare, fenced, after a sentence, or after prose that has braces of its own', () => {
  assert.deepEqual(parseAskReply(JSON.stringify(obj)), obj);
  assert.deepEqual(parseAskReply('```json\n' + JSON.stringify(obj) + '\n```'), obj);
  assert.deepEqual(parseAskReply('Here is the answer:\n\n' + JSON.stringify(obj) + '\n\nHope that helps.'), obj);
  assert.deepEqual(parseAskReply('Clause {4} changed. ' + JSON.stringify(obj) + ' and {5}'), obj);
  assert.deepEqual(parseAskReply('{"answer":"a } brace in a string","evidence":[]}'), { answer: 'a } brace in a string', evidence: [] });
});

test('prose, an object without an answer and empty text are not answers; prose is shown without its fence, JSON never', () => {
  assert.equal(parseAskReply('### What changed\n- **Payment** moves to 90 days.'), null);
  assert.equal(parseAskReply('{"evidence":[]}'), null);
  assert.equal(parseAskReply(''), null);
  assert.equal(proseAnswer('```markdown\n**Bold** prose\n```'), '**Bold** prose');
  assert.equal(proseAnswer('{"evidence":[]}'), '');
  assert.equal(proseAnswer('x'.repeat(13000)).length, 12000);
  assert.match(ASK_CORRECTION, /Return only the JSON object described/);
});

test('errors are said in words a lawyer can act on; the app\'s own plain messages pass through', () => {
  assert.equal(askErrorMessage(Error('The model did not return a JSON object.')), 'The question could not be answered. Ask again.');
  assert.equal(askErrorMessage(Error('Claude CLI failed (exit 1): boom')), 'The question could not be answered. Ask again.');
  assert.equal(askErrorMessage(Error('Claude CLI could not start: spawn claude ENOENT')), 'The model could not be started on this computer. Check the review setup under Settings · Models, then ask again.');
  assert.equal(askErrorMessage(Error('Live provider returned HTTP 429. No offline result was substituted.')), 'The model is busy or at its usage limit. Wait a moment, then ask again.');
  assert.equal(askErrorMessage(Error('Claude CLI failed (exit null, SIGTERM): ')), 'The model took too long to answer. Ask again, or ask a narrower question.');
  assert.equal(askErrorMessage(Object.assign(Error('The model used every turn without returning the review.'), { code: 'tool_turns_exhausted' })), 'The model ran out of steps before it answered. Ask a narrower question.');
  assert.equal(askErrorMessage(Error('Live review needs ANTHROPIC_API_KEY on the server. No offline result was substituted.')), 'The model is not signed in or set up. Check the review setup under Settings · Models, then ask again.');
  for (const plain of ['No answer came back. Ask again.', 'The selected passage is no longer present. Select it again.']) assert.equal(askErrorMessage(Error(plain)), plain);
});
