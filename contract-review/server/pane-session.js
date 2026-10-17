// SPDX-License-Identifier: GPL-3.0-or-later
// What the Word pane needs to come back after it is closed or reloaded (decision 134): the review on screen, the
// lawyer's decisions on it and the questions asked about it (Ask C), kept per document on this machine. The key is the
// document's address as Word reports it, stored only as a hash; nothing is written into the document (W7). One file per document, replaced on every save.
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export function sessionRoot() { return process.env.PANE_SESSION_ROOT || path.join(process.cwd(), '.local', 'pane-sessions'); }
function fileFor(key) {
  if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw Object.assign(new Error('A document key is required.'), { status: 400 });
  return path.join(sessionRoot(), `${createHash('sha256').update(key.trim()).digest('hex')}.json`);
}

export async function getSession(key) {
  try { return JSON.parse(await readFile(fileFor(key), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function saveSession(key, state) {
  // A session holds a review and its document, or (before any review) the document's Ask history alone (Ask C).
  const asksOnly = state && Array.isArray(state.asks) && state.asks.length && !state.review;
  if (!state || typeof state !== 'object' || Array.isArray(state) || (!asksOnly && (!state.review || !state.doc))) throw Object.assign(new Error('A session holds a review and its document.'), { status: 400 });
  const file = fileFor(key); await mkdir(sessionRoot(), { recursive: true });
  const record = { savedAt: new Date().toISOString(), state };
  const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(record)); await rename(temp, file);
  return { savedAt: record.savedAt };
}

export async function clearSession(key) { await rm(fileFor(key), { force: true }); return { cleared: true }; }
