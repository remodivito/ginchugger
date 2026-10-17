// SPDX-License-Identifier: GPL-3.0-or-later
// The version banner (product v2 spec 6.2.5, 7.11, PR-TEAM-07, decision 167): the local app and the team server may
// differ; neither refuses the other, and nothing updates itself. The banner appears when the app's major version
// differs from the server's, when the app is older than the server's minClientVersion, or when the server is older
// than the app's minServerVersion, and links to the server's release.
const parse = v => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? m.slice(1, 4).map(Number) : null; };
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b); if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** `{ text, link }` or null. `releases`: the releases page prefix, to which `v<server version>` is added. */
export function versionBanner({ app, server, minClientVersion = null, minServerVersion = null, releases }) {
  if (!parse(app) || !parse(server)) return null;
  const mismatch = parse(app)[0] !== parse(server)[0] || (minClientVersion && compareVersions(app, minClientVersion) < 0) || (minServerVersion && compareVersions(server, minServerVersion) < 0);
  if (!mismatch) return null;
  return { text: `Your app is ${app}; the team server is ${server}. Install the matching release.`, link: `${releases}v${server}` };
}
