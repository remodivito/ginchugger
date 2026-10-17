#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Stages the installed app for one platform (PR-REL-01): a Node 22 runtime, the built app, its production
// dependencies, and prebuilt better-sqlite3 and @napi-rs/keyring binaries for each architecture. The Mac `.pkg` and
// the Windows `.msi` are wrapped around the folder this writes:
//   <out>/node/      the Node runtime (Mac: bin/node, universal; Windows: node.exe)
//   <out>/app/       server, shared, bin, dist, data, prompts, public, the launcher, production node_modules
//   <out>/bin/       ginchugger-legal (Mac) or ginchugger-legal.cmd (Windows)
// Downloads come from nodejs.org (checked against its SHASUMS256.txt), the npm registry and better-sqlite3's GitHub
// release (through prebuild-install, as `npm install` itself does). Nothing here signs anything.
//   node scripts/release/stage.mjs --platform darwin --arch universal --out <dir>
//   node scripts/release/stage.mjs --platform win32 --arch x64 --out <dir>
import { mkdirSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync, chmodSync, renameSync, readdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const NODE_VERSION = process.env.GCL_NODE_VERSION || '22.22.0';
const root = fileURLToPath(new URL('../../', import.meta.url));
const repo = path.join(root, '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const platform = arg('platform', process.platform);
const archArg = arg('arch', platform === 'darwin' ? 'universal' : 'x64');
const out = path.resolve(arg('out', path.join(root, 'release', `stage-${platform}-${archArg}`)));
const cache = path.resolve(process.env.GCL_RELEASE_CACHE || path.join(root, 'release', '.cache'));
const arches = archArg === 'universal' ? ['arm64', 'x64'] : [archArg];
if (!['darwin', 'win32'].includes(platform)) throw Error(`Unsupported platform ${platform}: darwin or win32.`);
if (platform === 'win32' && archArg === 'universal') throw Error('Windows builds one architecture at a time.');

// Windows: System32's bsdtar, not a GNU tar from Git that reads "C:" as a remote host.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && /^(npm|npx)$/.test(cmd), ...opts });
  if (r.status !== 0) throw Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error?.message}).`);
};
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
async function download(url, file) {
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(url); if (!res.ok) throw Error(`${url}: HTTP ${res.status}`);
  writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer())); renameSync(file + '.part', file);
  return file;
}

// 1. The Node runtime, checked against nodejs.org's published checksums.
async function stageNode() {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}/`;
  const sums = readFileSync(await download(base + 'SHASUMS256.txt', path.join(cache, `node-v${NODE_VERSION}-SHASUMS256.txt`)), 'utf8');
  const binaries = [];
  for (const arch of arches) {
    const name = platform === 'darwin' ? `node-v${NODE_VERSION}-darwin-${arch}.tar.gz` : `node-v${NODE_VERSION}-win-${arch}.zip`;
    const file = await download(base + name, path.join(cache, name));
    const want = sums.split('\n').find(l => l.endsWith(`  ${name}`))?.split(' ')[0];
    if (!want || want !== sha256(file)) { rmSync(file); throw Error(`Checksum mismatch for ${name}; the download was removed.`); }
    const dir = path.join(cache, `x-${platform}-${arch}`); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    run(TAR, ['-xf', file, '-C', dir]);
    binaries.push(path.join(dir, name.replace(/\.(tar\.gz|zip)$/, '')));
  }
  const node = path.join(out, 'node'); mkdirSync(node, { recursive: true });
  if (platform === 'darwin') {
    mkdirSync(path.join(node, 'bin'), { recursive: true });
    const target = path.join(node, 'bin', 'node');
    if (binaries.length > 1) run('lipo', ['-create', ...binaries.map(b => path.join(b, 'bin', 'node')), '-output', target]);
    else cpSync(path.join(binaries[0], 'bin', 'node'), target);
    chmodSync(target, 0o755);
  } else cpSync(path.join(binaries[0], 'node.exe'), path.join(node, 'node.exe'));
  cpSync(path.join(binaries[0], 'LICENSE'), path.join(node, 'LICENSE'));
}

// 2. The app: the built pages and what the server and the launcher read at run time. No tests, sources or .local.
const APP = ['server', 'shared', 'bin', 'dist', 'data', 'prompts', 'public', 'package.json', 'package-lock.json', 'README.md', 'docs/FOR-IT.md', 'docs/WORD.md', 'docs/RETENTION.md', 'docs/DATA.md', 'scripts/launch.mjs', 'scripts/setup-word.js', 'scripts/verify-record.js'];
// Bundled into dist by Vite and never imported by the server once dist exists (server/index.js).
const BUILD_ONLY = ['vite', 'react', 'react-dom', 'lucide-react', '@fontsource/dm-sans', '@fontsource/geist', '@fontsource/newsreader', '@fontsource/source-serif-4'];
const KEYRING = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'win32-x64': 'win32-x64-msvc', 'win32-arm64': 'win32-arm64-msvc' };

function stageApp() {
  if (!existsSync(path.join(root, 'dist', 'index.html'))) throw Error('Run `npm run build` first: the release serves the built pages.');
  const app = path.join(out, 'app'); mkdirSync(app, { recursive: true });
  for (const rel of APP) if (existsSync(path.join(root, rel))) cpSync(path.join(root, rel), path.join(app, rel), { recursive: true, filter: src => !/(^|[\\/])(\.local|\.env|node_modules|\.DS_Store)([\\/]|$)/.test(path.relative(root, src)) });
  for (const f of ['LICENSE', 'NOTICE.md']) cpSync(path.join(repo, f), path.join(app, f));
  // Production dependencies only, without install scripts: the native binaries are fetched per architecture below.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app });
  const pkg = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
  for (const name of BUILD_ONLY) delete pkg.dependencies[name];
  delete pkg.devDependencies; delete pkg.scripts;
  writeFileSync(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app });

  // better-sqlite3: the prebuilt binary for each architecture (Mac: joined into one universal file).
  const sqlite = path.join(app, 'node_modules', 'better-sqlite3');
  const builds = [];
  for (const arch of arches) {
    rmSync(path.join(sqlite, 'build'), { recursive: true, force: true });
    run(process.execPath, [path.join(app, 'node_modules', 'prebuild-install', 'bin.js'), '--runtime', 'node', '--target', NODE_VERSION, '--platform', platform, '--arch', arch, '--verbose'], { cwd: sqlite });
    const built = path.join(sqlite, 'build', 'Release', 'better_sqlite3.node');
    const keep = path.join(cache, `better_sqlite3-${platform}-${arch}.node`); mkdirSync(cache, { recursive: true }); cpSync(built, keep); builds.push(keep);
  }
  const target = path.join(sqlite, 'build', 'Release', 'better_sqlite3.node');
  if (builds.length > 1) run('lipo', ['-create', ...builds, '-output', target]); else cpSync(builds[0], target);
  // Not needed at run time once the binary is in place.
  for (const dir of ['deps', 'src']) rmSync(path.join(sqlite, dir), { recursive: true, force: true });

  // @napi-rs/keyring: one package per platform and architecture, chosen by the loader at run time.
  const scope = path.join(app, 'node_modules', '@napi-rs');
  const version = JSON.parse(readFileSync(path.join(scope, 'keyring', 'package.json'), 'utf8')).version;
  const wanted = arches.map(a => `keyring-${KEYRING[`${platform}-${a}`]}`);
  for (const name of readdirSync(scope)) if (name.startsWith('keyring-') && !wanted.includes(name)) rmSync(path.join(scope, name), { recursive: true });
  for (const name of wanted) {
    if (existsSync(path.join(scope, name, 'package.json'))) continue;
    const tgz = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', `@napi-rs/${name}@${version}`, '--pack-destination', cache, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
    mkdirSync(path.join(scope, name), { recursive: true });
    run(TAR, ['-xzf', path.join(cache, tgz), '-C', path.join(scope, name), '--strip-components', '1']);
  }
  return { keyring: wanted, sqlite: arches };
}

// 3. The launcher in bin/, and a record of what was staged.
function stageLaunchers(version, natives) {
  const bin = path.join(out, 'bin'); mkdirSync(bin, { recursive: true });
  if (platform === 'darwin') {
    const file = path.join(bin, 'ginchugger-legal');
    writeFileSync(file, '#!/bin/sh\n# GinChugger: start the app, or `ginchugger-legal setup-word`, or `ginchugger-legal gcl <command>`.\nHERE="$(cd "$(dirname "$0")/.." && pwd)"\nexec "$HERE/node/bin/node" "$HERE/app/scripts/launch.mjs" "$@"\n');
    chmodSync(file, 0o755);
  } else {
    writeFileSync(path.join(bin, 'ginchugger-legal.cmd'), '@echo off\r\nrem GinChugger: start the app, or "ginchugger-legal setup-word", or "ginchugger-legal gcl <command>".\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\app\\scripts\\launch.mjs" %*\r\n');
  }
  let commit = null; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  writeFileSync(path.join(out, 'app', 'RELEASE.json'), JSON.stringify({ name: 'GinChugger', version, platform, arch: archArg, node: NODE_VERSION, natives, commit, builtAt: new Date().toISOString() }, null, 2) + '\n');
}

// 4. Load both native modules with the bundled Node, under each architecture this machine can run.
function smoke() {
  const node = platform === 'darwin' ? path.join(out, 'node', 'bin', 'node') : path.join(out, 'node', 'node.exe');
  const code = `const { createRequire } = require('node:module'); const r = createRequire(${JSON.stringify(path.join(out, 'app', 'package.json'))});
const db = new (r('better-sqlite3'))(':memory:'); const v = db.prepare('select sqlite_version() v').get().v; db.exec("create virtual table t using fts5(x)");
const { Entry } = r('@napi-rs/keyring'); new Entry('GinChugger release check', 'none');
console.log(process.version + ' ' + process.arch + ': better-sqlite3 (SQLite ' + v + ', FTS5) and @napi-rs/keyring load');`;
  if (process.platform !== platform) { console.log(`Smoke test skipped: staged for ${platform} on ${process.platform}.`); return; }
  for (const arch of arches) {
    if (platform === 'darwin' && arch !== process.arch) {
      if (spawnSync('arch', ['-x86_64', '/usr/bin/true']).status !== 0) { console.log(`Smoke test for ${arch} skipped: Rosetta is not installed.`); continue; }
      run('arch', [arch === 'x64' ? '-x86_64' : '-arm64', node, '-e', code]);
    } else if (arch === process.arch) run(node, ['-e', code]);
  }
}

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
await stageNode();
const natives = stageApp();
stageLaunchers(version, natives);
smoke();
console.log(`Staged GinChugger ${version} for ${platform} ${archArg} (Node ${NODE_VERSION}) in ${out}`);
