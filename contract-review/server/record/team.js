// SPDX-License-Identifier: GPL-3.0-or-later
// Team sign-in over the record's SQLite (product v2 spec 3.4, 7.10, PR-TEAM-02 to 05): setup codes issued by an admin
// for a named person (26 characters of Crockford base32 over 128 random bits, shown once, stored as SHA-256, expiring,
// single use, revocable) and the long-lived keys a code is redeemed for (256 random bits, shown once, stored as
// SHA-256 with the user and the device name). Used by LocalRecord's `admin` operations, the team server's redeem route
// and identity check, and `gcl admin` inside the container. Plain functions over the database: no network, no model.
import { createHash, randomBytes } from 'node:crypto';
import { newId } from './events.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 26;
/** The reserved actors (PR-TEAM-04): captures the server makes, and admin commands run inside the container. */
export const SYSTEM_ACTORS = { 'system:mail': 'Mailbox', 'system:folder': 'Watched folder', 'system:gcl': 'Admin command', 'system:trash': 'Automatic purge' };
const err = (status, code, message) => Object.assign(new Error(message), { status, code });
export const hash = s => createHash('sha256').update(String(s)).digest('hex');
/** One message for a wrong, expired, used or revoked code (7.10): the reason goes to the server log only. */
export const CODE_INVALID = 'This code is not valid.';

/** 128 random bits as 26 Crockford base32 characters (the top two bits of the first character are zero). */
export function newCode(bytes = randomBytes(16)) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) { out = CROCKFORD[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}
/** What a person types, as stored: upper case, separators dropped, the letters Crockford reads as digits mapped. */
export const normalizeCode = s => String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
export const newKey = () => randomBytes(32).toString('base64url');

/** A sliding one-minute window per key (7.10: 10 a minute per address, per code prefix, and 60 in all). */
export function rateLimiter({ now = () => Date.now(), windowMs = 60_000 } = {}) {
  const hits = new Map();
  return {
    allow(key, limit) {
      const t = now(); const list = (hits.get(key) || []).filter(x => t - x < windowMs);
      if (list.length >= limit) { hits.set(key, list); return false; }
      list.push(t); hits.set(key, list);
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k);
      return true;
    },
  };
}

export function makeTeam({ db, now, insertEvent, tx, log = console }) {
  const userOut = u => u && ({ id: u.id, name: u.name, admin: !!u.admin, createdAt: u.created_at, revokedAt: u.revoked_at });
  const codeOut = c => ({ id: c.id, forName: c.for_name, admin: !!c.admin, userId: c.user_id || null, issuedAt: c.issued_at, issuedBy: c.issued_by, expiresAt: c.expires_at, redeemedAt: c.redeemed_at, redeemedBy: c.redeemed_by, revokedAt: c.revoked_at });
  const issuer = actor => (actor && db.prepare('SELECT 1 FROM users WHERE id = ?').get(actor) ? actor : null);

  return {
    /** Issue a code (7.10 steps 1 and 2). `userId` issues one for a second device of that user. The code is returned once. */
    issueCode({ forName, admin = false, ttlHours = 168, userId = null } = {}, actor) {
      let name = typeof forName === 'string' ? forName.trim() : '';
      if (userId) { const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId); if (!u) throw err(404, 'not_found', 'User not found.'); name = u.name; admin = !!u.admin; }
      if (!name || name.length > 100) throw err(400, 'bad_request', 'Name the person the code is for.');
      const hours = Number(ttlHours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) throw err(400, 'bad_request', 'A code lasts between an hour and 90 days.');
      const code = newCode(); const id = newId(); const at = now();
      const expiresAt = new Date(Date.parse(at) + hours * 3_600_000).toISOString();
      tx(() => {
        db.prepare('INSERT INTO setup_codes (id, code_hash, for_name, admin, issued_by, issued_at, expires_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, hash(code), name, admin ? 1 : 0, issuer(actor), at, expiresAt, userId);
        insertEvent({ type: 'code_issued', at, actor: actor || null, payload: { codeId: id, forName: name, admin: !!admin, expiresAt } });
      });
      return { id, code, forName: name, admin: !!admin, expiresAt };
    },

    listCodes() { return db.prepare('SELECT * FROM setup_codes ORDER BY issued_at DESC, id').all().map(codeOut); },

    revokeCode(id, actor) {
      const c = db.prepare('SELECT * FROM setup_codes WHERE id = ?').get(id);
      if (!c) throw err(404, 'not_found', 'Setup code not found.');
      if (c.redeemed_at) throw err(409, 'conflict', 'That code has been used; revoke the person instead.');
      if (!c.revoked_at) tx(() => { const at = now(); db.prepare('UPDATE setup_codes SET revoked_at = ? WHERE id = ?').run(at, id); insertEvent({ type: 'code_revoked', at, actor: actor || null, payload: { codeId: id } }); });
      return codeOut(db.prepare('SELECT * FROM setup_codes WHERE id = ?').get(id));
    },

    /** Redeem a code for a key (7.10 step 3). Every failure gives the same message; the reason is logged without the code. */
    redeem({ code, deviceName } = {}) {
      const device = typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 100) : 'unnamed device';
      const c = db.prepare('SELECT * FROM setup_codes WHERE code_hash = ?').get(hash(normalizeCode(code)));
      const at = now();
      const reason = !c ? 'unknown code' : c.redeemed_at ? 'code already used' : c.revoked_at ? 'code revoked' : Date.parse(c.expires_at) <= Date.parse(at) ? 'code expired' : null;
      if (reason) { log.log(`Setup code refused: ${reason}${c ? ` (code ${c.id})` : ''}.`); throw err(400, 'bad_request', CODE_INVALID); }
      const key = newKey();
      const out = tx(() => {
        let user = c.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id) : null;
        if (user && user.revoked_at) db.prepare('UPDATE users SET revoked_at = NULL WHERE id = ?').run(user.id);
        if (!user) { const id = newId(); db.prepare('INSERT INTO users (id, name, admin, created_at) VALUES (?, ?, ?, ?)').run(id, c.for_name, c.admin, at); user = db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
        const keyId = newId();
        db.prepare('INSERT INTO api_keys (id, user_id, key_hash, device_name, created_at) VALUES (?, ?, ?, ?, ?)').run(keyId, user.id, hash(key), device, at);
        db.prepare('UPDATE setup_codes SET redeemed_at = ?, redeemed_by = ? WHERE id = ?').run(at, user.id, c.id);
        insertEvent({ type: 'user_joined', at, actor: user.id, payload: { userId: user.id, name: user.name, admin: !!user.admin, codeId: c.id, deviceName: device } });
        return { userId: user.id, name: user.name, admin: !!user.admin };
      });
      return { ...out, key };
    },

    /** The member a bearer key names (6.2.6 `whoIs`): `{ userId, name, admin, keyId }`, `{ revoked: true }`, or null. */
    whoIs(key) {
      if (typeof key !== 'string' || key.length < 20 || key.length > 200) return null;
      const k = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash(key)); // a lookup by the hash of 256 random bits
      if (!k) return null;
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(k.user_id);
      if (k.revoked_at || !u || u.revoked_at) return { revoked: true };
      return { userId: u.id, name: u.name, admin: !!u.admin, keyId: k.id };
    },

    listUsers() {
      return db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE, id').all().map(u => ({ ...userOut(u),
        keys: db.prepare('SELECT id, device_name, created_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at').all(u.id).map(k => ({ id: k.id, deviceName: k.device_name, createdAt: k.created_at, revokedAt: k.revoked_at })) }));
    },

    /** Revoke a person (7.10 step 4): every key of theirs, one `key_revoked` event each. */
    revokeUser(id, actor) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) throw err(404, 'not_found', 'User not found.');
      tx(() => {
        const at = now();
        for (const k of db.prepare('SELECT id FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').all(id)) {
          db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(at, k.id);
          insertEvent({ type: 'key_revoked', at, actor: actor || null, payload: { userId: id, keyId: k.id } });
        }
        if (!u.revoked_at) db.prepare('UPDATE users SET revoked_at = ? WHERE id = ?').run(at, id);
      });
      return this.listUsers().find(x => x.id === id);
    },

    /** Actor ids as names, for "Last changed by" and the tombstones: every user, and the server's own capture actors. */
    actors() {
      const out = { ...SYSTEM_ACTORS };
      for (const u of db.prepare('SELECT id, name FROM users').all()) out[u.id] = u.name;
      return out;
    },

    counts() {
      const at = now();
      return {
        users: { active: db.prepare('SELECT COUNT(*) AS n FROM users WHERE revoked_at IS NULL').get().n, revoked: db.prepare('SELECT COUNT(*) AS n FROM users WHERE revoked_at IS NOT NULL').get().n },
        admins: db.prepare('SELECT COUNT(*) AS n FROM users WHERE revoked_at IS NULL AND admin = 1').get().n,
        codesOutstanding: db.prepare('SELECT COUNT(*) AS n FROM setup_codes WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(at).n,
      };
    },
  };
}
