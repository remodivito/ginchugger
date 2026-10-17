// SPDX-License-Identifier: GPL-3.0-or-later
// What goes public, checked (product v2 spec PR-REL-02, PR-REL-01). Replaces the v1 check of the application ZIP,
// which the release builds superseded:
//   1. every source file in contract-review carries the SPDX header;
//   2. every ported file (its header names the project it was translated from) is listed in NOTICE.md;
//   3. no tracked file in the repository is an environment file, a private key, local state or a release build;
//      paths that look like private material (session transcripts, raw source material) are listed as warnings,
//      and fail the check with --strict (publishing them is the owner's decision);
//   4. each installer in release/ matches its .sha256, and a Mac .pkg holds the app, Node, the native modules and
//      the login item and nothing from .local, .env, tests or keys.
//   node scripts/verify-submission.js [--strict]
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
const strict = process.argv.includes('--strict');
const failures = [], warnings = [];
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);

// 1. SPDX headers. The paperless reference folder holds Paperless-ngx's own files unchanged; shared/compare.js is
// hashed by the benchmark (BENCHMARK-V2.md section 13), so a header there waits for benchmark v2.1.
const SOURCE = /\.(m?js|cjs|jsx|css|ps1|wxs|sh)$|(^|\/)(Dockerfile|compose\.yml)$/;
const EXEMPT = [/server\/ports\/paperless\/reference\//, /^shared\/compare\.js$/];
const own = [...new Set([...git(['ls-files', '.'], root), ...git(['ls-files', '--others', '--exclude-standard', '.'], root)])].filter(f => existsSync(path.join(root, f)));
const sources = own.filter(f => SOURCE.test(f) && !EXEMPT.some(r => r.test(f)));
for (const f of sources) if (!readFileSync(path.join(root, f), 'utf8').split('\n').slice(0, 3).some(l => l.includes('SPDX-License-Identifier: GPL-3.0-or-later'))) failures.push(`No SPDX header: ${f}`);

// 2. NOTICE entries for ported files.
const notice = readFileSync(path.join(repo, 'NOTICE.md'), 'utf8');
const ported = sources.filter(f => /\.(m?js)$/.test(f) && /translated to JavaScript|Source: Paperless-ngx|Ported from/i.test(readFileSync(path.join(root, f), 'utf8').split('\n').slice(0, 15).join('\n')));
const prefix = path.relative(repo, root).split(path.sep).join('/');
for (const f of ported) if (!notice.includes(`${prefix}/${f}`)) failures.push(`Ported file not in NOTICE.md: ${f}`);

// 3. What the repository would publish.
const tracked = git(['ls-files']);
const FORBIDDEN = [[/(^|\/)\.env(\.|$)(?!example$)/, 'environment file'], [/\.(pem|key|p12|pfx)$/i, 'private key or certificate store'], [/(^|\/)\.local\//, 'local state'], [/(^|\/)contract-review\/release\//, 'release build'], [/(^|\/)node_modules\//, 'dependencies']];
for (const f of tracked) for (const [re, what] of FORBIDDEN) if (re.test(f)) failures.push(`Tracked ${what}: ${f}`);
const PRIVATE = [[/(^|\/)source-material\/raw\//, 'raw source material'], [/(^|\/)source-material\/conversations\//, 'session transcript extract'], [/transcript/i, 'transcript'], [/\.jsonl$/, 'session or trace log']];
const flagged = {};
for (const f of tracked) for (const [re, what] of PRIVATE) if (re.test(f)) (flagged[what] ||= []).push(f);
for (const [what, files] of Object.entries(flagged)) (strict ? failures : warnings).push(`${files.length} tracked file(s) that look like ${what}, e.g. ${files.slice(0, 3).join(', ')}`);

// 4. Release artefacts.
const release = path.join(root, 'release');
const artefacts = existsSync(release) ? readdirSync(release).filter(f => /\.(pkg|msi)$/.test(f)) : [];
const checked = [];
for (const name of artefacts) {
  const file = path.join(release, name);
  const sum = existsSync(`${file}.sha256`) ? readFileSync(`${file}.sha256`, 'utf8').split(/\s+/)[0] : null;
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sum !== actual) { failures.push(`${name}: ${sum ? 'checksum does not match' : 'no .sha256 beside it'}`); continue; }
  if (name.endsWith('.pkg') && process.platform === 'darwin') {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gcl-pkg-'));
    try {
      execFileSync('pkgutil', ['--expand', file, path.join(tmp, 'x')]);
      const comp = readdirSync(path.join(tmp, 'x')).find(d => d.endsWith('.pkg'));
      const paths = spawnSync('lsbom', ['-s', path.join(tmp, 'x', comp, 'Bom')], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout.split('\n').filter(Boolean);
      const base = './Library/Application Support/GinChugger Legal/';
      for (const need of ['app/RELEASE.json', 'app/server/index.js', 'app/dist/index.html', 'app/public/manifest.xml', 'node/bin/node', 'bin/ginchugger-legal', 'app/node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'app/node_modules/@napi-rs/keyring-darwin-arm64/package.json', 'app/node_modules/@napi-rs/keyring-darwin-x64/package.json']) if (!paths.includes(base + need)) failures.push(`${name}: missing ${need}`);
      if (!paths.includes('./Library/LaunchAgents/com.ginchugger.legal.plist')) failures.push(`${name}: missing the login item`);
      const bad = paths.filter(p => /\/\.local(\/|$)|\/\.env|\/\._|\.(pem|key)$|\/app\/(tests|src)\//.test(p));
      if (bad.length) failures.push(`${name}: ${bad.length} excluded path(s), e.g. ${bad[0]}`);
      checked.push({ name, sha256: actual, entries: paths.length });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } else checked.push({ name, sha256: actual });
}

console.log(JSON.stringify({ sourceFiles: sources.length, exempt: EXEMPT.map(String), ported, trackedFiles: tracked.length, artefacts: checked, warnings, failures }, null, 2));
if (failures.length) process.exitCode = 1;
