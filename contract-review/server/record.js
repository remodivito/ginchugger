// SPDX-License-Identifier: GPL-3.0-or-later
// The review record a recipient can check (decision 136). Export record returns the review, the lawyer's decisions and
// what they were made against, with a SHA-256 of each part and a digest over those hashes. When the server holds a
// signing key (REVIEW_RECORD_SIGNING_KEY: a 32-byte Ed25519 seed, hex, e.g. `openssl rand -hex 32`), the digest is
// signed; anyone holding the matching public key can tell an untouched record from an edited one. Without a key the
// record is unsigned and says so; a key that is set but malformed is an error, never a quiet downgrade to unsigned.
// Hashes are over canonical JSON (keys sorted), so the same content always gives the same hash.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const FORMAT = 'margin-review-record/1';
// The signature covers this label, a zero byte and the digest, so it cannot be replayed as a signature over anything else.
const DOMAIN = Buffer.concat([Buffer.from(FORMAT), Buffer.from([0])]);
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const PARTS = ['document', 'baseline', 'playbook', 'review', 'decisions'];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
const sha256 = text => createHash('sha256').update(text).digest('hex');

function signingKey(env = process.env) {
  const hex = env.REVIEW_RECORD_SIGNING_KEY;
  if (!hex) return null;
  if (!/^[0-9a-f]{64}$/i.test(hex.trim())) throw Object.assign(new Error('REVIEW_RECORD_SIGNING_KEY must be 64 hex characters (a 32-byte Ed25519 seed); the record was not exported.'), { status: 500 });
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(hex.trim(), 'hex')]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length).toString('hex');
  return { privateKey, publicKey };
}
const digestOf = hashes => sha256(canonical({ format: FORMAT, hashes }));

/** Build the record from what the pane holds. `input`: { document, baseline, review, outcomes, events, stale }. */
export function buildRecord(input, { env = process.env, now = new Date() } = {}) {
  const { document, baseline = null, review, outcomes = {}, events = [], stale = false } = input || {};
  if (!review || !Array.isArray(review.findings) || !document || !Array.isArray(document.paragraphs)) throw Object.assign(new Error('Export needs the review and the document it was made on.'), { status: 400 });
  const key = signingKey(env);
  const parts = {
    document: { title: document.title || null, paragraphs: document.paragraphs.map(p => ({ id: p.id, text: p.text, ...(typeof p.originalText === 'string' && p.originalText !== p.text ? { originalText: p.originalText } : {}) })) },
    baseline: baseline ? { id: baseline.id || null, title: baseline.title || null, paragraphs: (baseline.paragraphs || []).map(p => ({ id: p.id, text: p.text })) } : null,
    playbook: { ref: review.playbook || null, version: review.playbookVersion ?? null, snapshot: review.playbookSnapshot || null },
    review: { ...review, playbookSnapshot: undefined },
    decisions: { outcomes, events, stale },
  };
  const hashes = Object.fromEntries(PARTS.map(k => [k, sha256(canonical(parts[k]))]));
  const digest = digestOf(hashes);
  const signature = key ? { algorithm: 'Ed25519', publicKey: key.publicKey, value: sign(null, Buffer.concat([DOMAIN, Buffer.from(digest, 'hex')]), key.privateKey).toString('base64') } : null;
  return { format: FORMAT, createdAt: now.toISOString(), ...parts, manifest: { hashes, digest, signature },
    note: signature ? 'Each part is hashed and the digest is signed. Check it with: node scripts/verify-record.js <file> [public key].' : 'Each part is hashed; this record is not signed (no signing key on the server), so the hashes show consistency, not origin.',
    disclaimer: "Review notes, not contract approval. Demonstration guidance is illustrative, not any organisation's policy." };
}

/**
 * Check a record: every part against its hash, the digest against the hashes, and the signature (against `publicKey`
 * when given, else against the key the record names, which proves only that it is internally consistent).
 * Returns { ok, parts: { name: true|false }, digest: bool, signature: 'valid'|'invalid'|'unsigned', keyMatches: bool|null,
 * trusted: bool }. `signature` is about the digest only; a changed part shows in `parts` and makes `ok` false.
 */
export function verifyRecord(record, publicKey = null) {
  const m = record?.manifest || {}; const hashes = m.hashes || {};
  const parts = Object.fromEntries(PARTS.map(k => [k, hashes[k] === sha256(canonical(record?.[k] ?? null))]));
  const digest = typeof m.digest === 'string' && m.digest === digestOf(hashes);
  let signature = 'unsigned';
  if (m.signature) {
    const keyHex = publicKey || m.signature.publicKey;
    try {
      const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(String(keyHex), 'hex')]), format: 'der', type: 'spki' });
      signature = digest && verify(null, Buffer.concat([DOMAIN, Buffer.from(m.digest, 'hex')]), key, Buffer.from(String(m.signature.value), 'base64')) ? 'valid' : 'invalid';
    } catch { signature = 'invalid'; }
  }
  const ok = Object.values(parts).every(Boolean) && digest && signature !== 'invalid';
  const keyMatches = publicKey ? publicKey === m.signature?.publicKey : null;
  return { ok, parts, digest, signature, keyMatches, trusted: ok && signature === 'valid' && keyMatches === true };
}
