// SPDX-License-Identifier: GPL-3.0-or-later
// Check an exported review record: node scripts/verify-record.js review-record.json [public key hex]
// Without the key, a valid signature proves only that the record is consistent with the key it names; with the key
// you were given separately, it proves the record left that server unedited.
import { readFileSync } from 'node:fs';
import { verifyRecord } from '../server/record.js';

const [file, key] = process.argv.slice(2);
if (!file) { console.error('Usage: node scripts/verify-record.js <review-record.json> [public key hex]'); process.exit(2); }
const r = verifyRecord(JSON.parse(readFileSync(file, 'utf8')), key || null);
for (const [part, good] of Object.entries(r.parts)) console.log(`${good ? 'ok      ' : 'CHANGED '} ${part}`);
console.log(`${r.digest ? 'ok      ' : 'CHANGED '} digest`);
console.log(`signature over the digest: ${r.signature}`);
console.log(`signing key: ${r.keyMatches === null ? 'not checked (pass the key you were given to check it)' : r.keyMatches ? 'the key you gave' : 'NOT the key you gave'}`);
console.log(r.trusted ? 'Result: unedited since it was signed by that key.' : r.ok ? 'Result: consistent, but its origin is not established.' : 'Result: this record has been changed since export.');
process.exit(r.ok && (!key || r.trusted) ? 0 : 1);
