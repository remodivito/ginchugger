// SPDX-License-Identifier: GPL-3.0-or-later
// Fetching RedlineBench at a pinned revision (BENCHMARK-V2.md section 7, layer C). Only the files layer C uses are
// fetched: per task the metadata, the instruction, the contract, the grounding text (.extracted.md), the attorney
// rubric and the attorney golden redline. Every file is checked against the dataset's own object id at that revision
// (git blob SHA-1 for plain files, the LFS SHA-256 for LFS files), and the list with both hashes is written to
// source/manifest.json, which the build checks again offline. Network: huggingface.co only; no model is called.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { canaryGuid } from '../canary.mjs';

export const DATASET = 'crosbylegal/RedlineBench';
export const REVISION = 'eee1b6790982ed1279e86bec7616b662a61993e6'; // HF main on 15 Oct 2026 (lastModified 2026-06-18); also redline-subset's pin
export const LICENCE = { data: 'CC BY 4.0', code: 'MIT', attribution: 'RedlineBench by Crosby Legal and micro1' };
export const HF = 'https://huggingface.co';
/** The three later-round inputs the 2 October audit read (../../../eval-feasibility/redline-task-audit.md), attorney variant a. */
export const TASKS = ['redline-s1-t3-g01a', 'redline-s2-t4-g03a', 'redline-s3-t4-g02a'];
const WANT = [/^task\.toml$/, /^instruction\.md$/, /^environment\/app\/contract\.docx$/, /^environment\/app\/grounding\/[^/]+\.extracted\.md$/, /^tests\/rubrics\.json$/, /^tests\/attorney_redlines\.docx$/];
export const GOLDEN = 'tests/attorney_redlines.docx';
export const REQUIRED = ['task.toml', 'instruction.md', 'environment/app/contract.docx', 'tests/rubrics.json'];
export const wanted = rel => WANT.some(rx => rx.test(rel));

export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const gitBlobSha1 = b => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
/** Whether bytes match a tree entry: LFS entries by their SHA-256, others by their git blob id. */
export const matchesEntry = (bytes, e) => (e.lfsSha256 ? sha256(bytes) === e.lfsSha256 : gitBlobSha1(bytes) === e.oid) && bytes.length === e.size;
/** Where a fetched file is kept locally: source/<task>/<path within the task, flattened of environment/app/>. */
export const localName = rel => rel.replace(/^environment\/app\//, '');

async function getJson(url, fetchImpl) { const r = await fetchImpl(url); if (!r.ok) throw Error(`HTTP ${r.status} for ${url}`); return r.json(); }
async function getBytes(url, fetchImpl) { const r = await fetchImpl(url); if (!r.ok) throw Error(`HTTP ${r.status} for ${url}`); return Buffer.from(await r.arrayBuffer()); }

/** The tree entries layer C wants for one task at the pinned revision. */
export async function treeFor(task, { revision = REVISION, fetchImpl = fetch } = {}) {
  const list = await getJson(`${HF}/api/datasets/${DATASET}/tree/${revision}/tasks/${task}?recursive=true`, fetchImpl);
  return list.filter(e => e.type === 'file').map(e => ({ path: e.path.slice(`tasks/${task}/`.length), size: e.size, oid: e.oid, lfsSha256: e.lfs?.oid ?? null })).filter(e => wanted(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Download, verify and keep every wanted file; write source/manifest.json. Returns the manifest. */
export async function fetchSource(dir, { tasks = TASKS, revision = REVISION, fetchImpl = fetch, log = console.log } = {}) {
  const info = await getJson(`${HF}/api/datasets/${DATASET}/revision/${revision}`, fetchImpl).catch(() => null);
  const manifest = { ...(canaryGuid() ? { canary: canaryGuid() } : {}), format: 'layer-c-source/1', dataset: DATASET, revision, url: `${HF}/datasets/${DATASET}/tree/${revision}`, licence: LICENCE, cardLicence: info?.cardData?.license ?? null, lastModified: info?.lastModified ?? null, fetchedAt: new Date().toISOString(), tasks: {} };
  for (const task of tasks) {
    const entries = await treeFor(task, { revision, fetchImpl }); const files = [];
    for (const e of entries) {
      const bytes = await getBytes(`${HF}/datasets/${DATASET}/resolve/${revision}/tasks/${task}/${e.path}`, fetchImpl);
      if (!matchesEntry(bytes, e)) throw Error(`${task}/${e.path}: bytes do not match the dataset's object id at ${revision}`);
      const local = path.join(dir, task, localName(e.path)); mkdirSync(path.dirname(local), { recursive: true }); writeFileSync(local, bytes);
      files.push({ path: e.path, local: path.relative(dir, local), size: e.size, oid: e.oid, lfsSha256: e.lfsSha256, sha256: sha256(bytes) });
      log(`  ${task}/${e.path} ${bytes.length} bytes ok`);
    }
    for (const need of REQUIRED) if (!files.some(f => f.path === need)) throw Error(`${task}: ${need} missing at ${revision}`);
    // RedlineBench has golden redlines for 138 of its 140 tasks; a task without one is recorded, not failed.
    if (!files.some(f => f.path === GOLDEN)) log(`  ${task}: no tests/attorney_redlines.docx at ${revision} (recorded)`);
    manifest.tasks[task] = files;
  }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}

/** Offline check of a kept source folder against its manifest; returns the manifest or throws naming the file. */
export function checkSource(dir) {
  const file = path.join(dir, 'manifest.json'); if (!existsSync(file)) throw Error(`${file} missing: run import.mjs --fetch first`);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  for (const [task, files] of Object.entries(m.tasks)) for (const f of files) {
    const local = path.join(dir, f.local); if (!existsSync(local)) throw Error(`${task}: ${f.local} missing`);
    const bytes = readFileSync(local); if (sha256(bytes) !== f.sha256 || !matchesEntry(bytes, f)) throw Error(`${task}: ${f.local} differs from the pinned revision`);
  }
  return m;
}
