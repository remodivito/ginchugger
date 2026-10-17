#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The Mac installer (PR-REL-01): a universal `.pkg` that installs the staged app into
// /Library/Application Support/GinChugger Legal and a login item (/Library/LaunchAgents/com.ginchugger.legal.plist)
// that starts it for each person at login. Unsigned unless MAC_INSTALLER_IDENTITY names a "Developer ID Installer"
// identity in the keychain; notarisation is a separate step (xcrun notarytool) and is not done here.
//   npm run build && node scripts/release/build-mac-pkg.mjs        -> release/GinChugger-<version>-mac-universal.pkg (+ .sha256)
import { mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ID = 'com.ginchugger.legal';
// The folder name predates the rename to GinChugger (decision 194); it stays so an upgrade replaces the installed app.
export const INSTALL_DIR = '/Library/Application Support/GinChugger Legal';
const root = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const release = path.join(root, 'release');
const work = path.join(release, 'mac-work');
const pkgroot = path.join(work, 'root');
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } }); if (r.status !== 0) throw Error(`${cmd} failed (${r.status}).`); };

rmSync(work, { recursive: true, force: true });
run(process.execPath, [path.join(root, 'scripts', 'release', 'stage.mjs'), '--platform', 'darwin', '--arch', 'universal', '--out', path.join(pkgroot, INSTALL_DIR.slice(1))]);

// The login item: runs the launcher at each login for the person signed in; output goes to the data folder's app.log.
const agents = path.join(pkgroot, 'Library', 'LaunchAgents'); mkdirSync(agents, { recursive: true });
writeFileSync(path.join(agents, `${ID}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ID}</string>
  <key>ProgramArguments</key>
  <array><string>${INSTALL_DIR}/bin/ginchugger-legal</string><string>--log</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`);

// Stop a running copy before the files are replaced; start the new one for whoever is at the screen.
const scripts = path.join(work, 'scripts'); mkdirSync(scripts, { recursive: true });
const consoleUser = 'user=$(stat -f %Su /dev/console 2>/dev/null)\n[ -n "$user" ] && [ "$user" != root ] && [ "$user" != loginwindow ] || exit 0\nuid=$(id -u "$user")\n';
writeFileSync(path.join(scripts, 'preinstall'), `#!/bin/sh\n${consoleUser}launchctl bootout "gui/$uid/${ID}" 2>/dev/null || true\nexit 0\n`);
writeFileSync(path.join(scripts, 'postinstall'), `#!/bin/sh\n${consoleUser}launchctl bootstrap "gui/$uid" "/Library/LaunchAgents/${ID}.plist" 2>/dev/null || true\nexit 0\n`);
for (const f of ['preinstall', 'postinstall']) chmodSync(path.join(scripts, f), 0o755);

const component = path.join(work, `${ID}.pkg`);
run('pkgbuild', ['--root', pkgroot, '--identifier', ID, '--version', version, '--scripts', scripts, '--install-location', '/', '--ownership', 'recommended', component]);
// pkgbuild carries each file's extended attributes as an AppleDouble `._` entry, and recent macOS puts a
// com.apple.provenance attribute on every file that cannot be removed. Rebuild the payload with cpio (odc, owned by
// root:wheel), which leaves them out, and its bill of materials to match.
const expanded = path.join(work, 'expanded');
run('pkgutil', ['--expand', component, expanded]);
const shell = (script, cwd) => { const r = spawnSync('/bin/sh', ['-c', script], { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } }); if (r.status !== 0) throw Error(`${script} failed.`); };
shell(`find . | sort | cpio -o --format odc -R 0:0 2>/dev/null | gzip -9 > "${path.join(expanded, 'Payload')}"`, pkgroot);
const bom = path.join(expanded, 'Bom'), list = path.join(work, 'bom.txt');
shell(`lsbom "${bom}" | grep -v '/\\._' > "${list}"`, work);
rmSync(bom); run('mkbom', ['-i', list, bom]);
const files = spawnSync('/bin/sh', ['-c', 'find . | wc -l'], { cwd: pkgroot, encoding: 'utf8' }).stdout.trim();
const info = path.join(expanded, 'PackageInfo');
writeFileSync(info, readFileSync(info, 'utf8').replace(/numberOfFiles="\d+"/, `numberOfFiles="${files}"`));
rmSync(component); run('pkgutil', ['--flatten', expanded, component]);
writeFileSync(path.join(work, 'distribution.xml'), `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>GinChugger ${version}</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_localSystem="true"/>
  <volume-check><allowed-os-versions><os-version min="11.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="default"><line choice="${ID}"/></line></choices-outline>
  <choice id="default"/>
  <choice id="${ID}" visible="false"><pkg-ref id="${ID}"/></choice>
  <pkg-ref id="${ID}" version="${version}" onConclusion="none">${ID}.pkg</pkg-ref>
</installer-gui-script>
`);
const name = `GinChugger-${version}-mac-universal.pkg`;
const target = path.join(release, name);
const sign = process.env.MAC_INSTALLER_IDENTITY ? ['--sign', process.env.MAC_INSTALLER_IDENTITY] : [];
run('productbuild', ['--distribution', path.join(work, 'distribution.xml'), '--package-path', work, ...sign, target]);
const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${hash}  ${name}\n`);
if (!process.env.GCL_KEEP_WORK) rmSync(work, { recursive: true, force: true });
console.log(`${target}\n${(statSync(target).size / 1048576).toFixed(1)} MB, sha256 ${hash}${sign.length ? '' : ' (unsigned)'}`);
