// SPDX-License-Identifier: GPL-3.0-or-later
// What the store's screens compute without a browser (src/pages/store-view.js): search snippets rendered as text, our
// rules' reasons, history entries from Paperless (string values, ids, m2m tags) and from the fake (names) in plain words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightParts, unescapeHtml, protection, describeChange, labelsOf, labelBody, sameLabels } from '../src/pages/store-view.js';

test('highlightParts: the engine\'s <b> highlights become parts; everything else stays text, entities decoded', () => {
  assert.deepEqual(highlightParts('within 30 days of the <b>invoice</b> date; we&#x27;ll pay &lt;b&gt;'), [
    { text: 'within 30 days of the ', hit: false }, { text: 'invoice', hit: true }, { text: ' date; we\'ll pay <b>', hit: false }]);
  assert.deepEqual(highlightParts('<span class="match">Term</span>'), [{ text: 'Term', hit: true }]);
  assert.deepEqual(highlightParts('<img src=x onerror=alert(1)>plain'), [{ text: 'plain', hit: false }], 'tags are dropped, never rendered');
  assert.deepEqual(highlightParts(''), []);
  assert.equal(unescapeHtml('&amp;&quot;&#39;&#x41;'), '&"\'A');
});

test('protection: signed and on-hold documents say why they stay out of the trash', () => {
  assert.equal(protection({ tags: ['Signed'] }), 'Signed: kept out of the trash');
  assert.equal(protection({ tags: ['on hold', 'inbox'] }), 'On hold: kept out of the trash');
  assert.equal(protection({ tags: ['inbox'] }), null);
});

test('describeChange: Paperless history in plain words, its housekeeping left out', () => {
  assert.equal(describeChange({ action: 'create', changes: { title: ['None', 'nda.docx'], content: ['None', '…'] } }), 'Added');
  assert.equal(describeChange({ action: 'update', changes: { 'Note Added': ['None', 5] } }), 'Added a note');
  assert.equal(describeChange({ action: 'update', changes: { tags: { type: 'm2m', operation: 'add', objects: ['signed'] } } }), 'Tagged signed');
  assert.equal(describeChange({ action: 'update', changes: { tags: { type: 'm2m', operation: 'remove', objects: ['inbox'] } } }), 'Removed tag inbox');
  // Paperless 3.3.2's own word for a tag taken off (a hold lifted read as "Tagged on hold": walkthrough 17 Oct).
  assert.equal(describeChange({ action: 'update', changes: { tags: { type: 'm2m', operation: 'delete', objects: ['on hold'] } } }), 'Removed tag on hold');
  assert.equal(describeChange({ action: 'update', changes: { owner: ['None', '2'], correspondent: ['None', '1'], document_type: ['None', '1'] } }), 'Changed the counterparty; Changed the type');
  assert.equal(describeChange({ action: 'create', changes: { custom_fields: { type: 'custom_field', field: 'Former round', value: '3, ours' } } }), 'Set Former round');
  assert.equal(describeChange({ action: 'update', changes: { archive_checksum: ['None', 'x'], filename: ['None', '1.docx'] } }), null);
  assert.equal(describeChange({ action: 'update', changes: { deleted_at: ['None', '2026-10-16'] } }), 'Moved to the trash');
});

test('describeChange: the fake\'s history (names, tag lists) reads the same way', () => {
  assert.equal(describeChange({ action: 'create', changes: { title: [null, 'nda'] } }), 'Added');
  assert.equal(describeChange({ action: 'update', changes: { counterparty: [null, 'Corrigan Ltd'], tags: [['inbox'], ['urgent']] } }), 'Counterparty set to Corrigan Ltd; Tagged urgent; Removed tag inbox');
  assert.equal(describeChange({ action: 'update', changes: { title: ['a', 'Corrigan NDA'], created: ['2026-01-01', '2026-05-01'] } }), 'Renamed to “Corrigan NDA”; Date set to 2026-05-01');
});

test('labels: the inbox tag is the Inbox\'s state, not a label, and is kept when saving', () => {
  const d = { title: 'NDA', counterparty: null, type: 'NDA', created: '2026-05-01', tags: ['inbox', 'urgent'], inbox: true };
  const l = labelsOf(d);
  assert.deepEqual(l, { title: 'NDA', counterparty: '', type: 'NDA', created: '2026-05-01', tags: ['urgent'] });
  assert.deepEqual(labelBody({ ...l, counterparty: 'Corrigan' }, d), { title: 'NDA', counterparty: 'Corrigan', type: 'NDA', created: '2026-05-01', tags: ['urgent', 'inbox'] });
  assert.ok(sameLabels(l, labelsOf(d)));
});
