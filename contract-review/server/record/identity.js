// SPDX-License-Identifier: GPL-3.0-or-later
// The identity seam (product v2 spec 6.2.6, PR-TEAM-08, decision 167). `whoIs(req)` answers who a request comes from:
// `{ userId, name, admin }`, `{ revoked: true }` for a key an admin revoked, or null. The shipped implementation reads a
// bearer key and checks its hash against `api_keys` (server/record/team.js). OpenID Connect is not built: when the
// team's security staff ask for it, an implementation would validate an ID token with `jose`, obtained by the local
// app through `openid-client` with a loopback redirect (RFC 8252), map `sub` to `users.id`, and, when
// `settings.auth.oidc.issuer` is set, make `POST /setup-codes/redeem` answer 410 `codes_disabled`. Nothing else in the
// server depends on how this question is answered.

/** The bearer key of a request, or null. */
export const bearerOf = req => /^Bearer (\S+)$/.exec(String(req.headers?.authorization || ''))?.[1] || null;

/** `whoIs` for the shipped sign-in: the bearer key against the team's keys. */
export function bearerIdentity(req, team) {
  const key = bearerOf(req);
  return key ? team.whoIs(key) : null;
}
