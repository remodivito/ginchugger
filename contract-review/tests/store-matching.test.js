// SPDX-License-Identifier: GPL-3.0-or-later
// Our side in counterparty matching (server/store/matching.js): our own names (ourNames) are never suggested, and mail
// from our own domains (internalDomains) is a colleague forwarding it, so the sender read is the forwarded original one
// from outside, or none (the subject and text decide).
import test from 'node:test';
import assert from 'node:assert/strict';
import { senderForMatching, isInternalDomain, forwardedFrom, suggestCounterparty } from '../server/store/matching.js';

const CPS = ['Northgate Biosciences Ltd', 'Helix Instruments Ltd', 'Brightwater Analytics Ltd'].map(name => ({ id: name, name, aliases: [], matchAlgorithm: 'literal', matchPattern: '', matchInsensitive: true }));
const FORWARD = ['FYI, see below.', '', '-----Original Message-----', 'From: Jo Park <jo@brightwater.example>', 'Subject: NDA'].join('\n');

test('internalDomains: a domain or one below it is ours; a forward names its original sender', () => {
  assert.equal(isInternalDomain('helix.example', ['helix.example']), true);
  assert.equal(isInternalDomain('mail.helix.example', ['@Helix.example']), true);
  assert.equal(isInternalDomain('nothelix.example', ['helix.example']), false);
  assert.equal(isInternalDomain('helix.example', []), false);
  assert.equal(forwardedFrom(FORWARD).address, 'jo@brightwater.example');
  assert.equal(forwardedFrom('No quoted header here.'), null);
});

test('mail matching: an outside sender is read; a colleague\'s forward is read as its original sender; a colleague with no quoted sender is not read', () => {
  const internal = ['helix.example'];
  assert.equal(senderForMatching('Jo Park <jo@brightwater.example>', '', internal), 'Jo Park <jo@brightwater.example>');
  assert.equal(senderForMatching('Ada <ada@helix.example>', FORWARD, internal), 'Jo Park <jo@brightwater.example>');
  assert.equal(senderForMatching('Ada <ada@helix.example>', 'Please file this.', internal), null);
  assert.equal(senderForMatching('Ada <ada@helix.example>', ['From: Ben <ben@helix.example>'].join('\n'), internal), null, 'a forward between colleagues names no outside sender');
  assert.equal(senderForMatching('Helix Legal <legal@helix.example>', '', []), 'Helix Legal <legal@helix.example>', 'without internalDomains every sender is read, as before');
  assert.equal(senderForMatching('', '', internal), null);

  // "Helix Legal <legal@helix.example>" would match our own name as the counterparty: internalDomains stops the sender
  // being read, and the text decides; ourNames keeps our own name out even when nothing else matches.
  const ours = { ourNames: ['Helix Instruments Ltd'] };
  const viaSender = suggestCounterparty(CPS, { from: senderForMatching('Helix Instruments Ltd <legal@helix.example>', 'Please file.', internal), subject: '', paragraphs: ['Mutual NDA with Northgate Biosciences Ltd.'] }, ours);
  assert.equal(viaSender.counterparty.name, 'Northgate Biosciences Ltd');
  assert.match(viaSender.counterparty.how, /in the document$/);
  assert.equal(suggestCounterparty(CPS, { from: 'Helix Instruments Ltd <legal@helix.example>', paragraphs: [] }, ours).counterparty, null);
});
