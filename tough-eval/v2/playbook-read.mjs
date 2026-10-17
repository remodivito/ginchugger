// SPDX-License-Identifier: GPL-3.0-or-later
// P2: the playbook ambiguity read. GLM-5.3 Flash and DeepSeek V4 Flash each read all four playbooks (CSA customer,
// CSA vendor, NDA discloser-weighted, NDA recipient-weighted), each with its clean document, and list rules that are
// ambiguous, inconsistent or not met by the clean text (prompts/playbook-read.md): eight calls. An unparseable reply is
// retried once with the error quoted. Raw replies: <root>/playbook-read/<family>/<document>-<side>.raw.json; every
// point raised, with an empty disposition for the calibration log ("fixed" or "kept", with the reason):
// <root>/playbook-read/points.json (re-running a call keeps dispositions already written for the same point).
// Usage: node tough-eval/v2/playbook-read.mjs [--family glm|deepseek] [--document csa --side vendor] [--root v2] [--dry-run]
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SIDES, loadSide, writeJson, readJson, parseObjectAnswer, sha256, V2 } from './lib/common.mjs';
import { callModel, MODELS } from './lib/call.mjs';
import { rootAbs, withStoreLock } from './lib/store.mjs';
import { args } from './author.mjs';

export const PROMPT = path.join(V2, 'prompts/playbook-read.md');
export const READERS = ['glm', 'deepseek'];

export function readPrompt(key) { const s = loadSide(key); return { system: readFileSync(PROMPT, 'utf8'), user: JSON.stringify({ side: s.label, playbook: s.playbook, document: s.doc }) }; }
export const pointsOf = raw => { const o = parseObjectAnswer(raw); if (!Array.isArray(o.points)) throw Error('no "points" array'); return o.points; };

export async function readOne({ family, key, root = 'v2', dryRun = false, call = callModel }) {
  const { system, user } = readPrompt(key); const dir = path.join(rootAbs(root), 'playbook-read', family); mkdirSync(dir, { recursive: true });
  if (dryRun) { writeFileSync(path.join(dir, `${key}.prompt.txt`), `${system}\n\nUSER (${user.length} chars, sha ${sha256(user)})\n${user.slice(0, 1500)}…\n`); return { key, dryRun: true, userChars: user.length }; }
  let r = await call({ who: family, system, user, name: `playbook-read-${key}` }), points = null, error = null, tag = '';
  try { points = pointsOf(r.raw); } catch (e) { error = e.message; }
  writeJson(path.join(dir, `${key}.raw.json`), { format: 'tough-eval-playbook-read/1', family, model: MODELS[family].model, side: key, playbook: SIDES[key].playbook, raw: r.raw, reasoning: r.reasoning || '', meta: r.meta, parse: { ok: !error, error } });
  if (error) {
    tag = '.retry'; r = await call({ who: family, system, user: user + `\n\nYour previous answer could not be read: ${error} Return only the JSON object the instructions ask for.`, name: `playbook-read-${key}.retry` });
    error = null; try { points = pointsOf(r.raw); } catch (e) { error = e.message; }
    writeJson(path.join(dir, `${key}${tag}.raw.json`), { format: 'tough-eval-playbook-read/1', family, model: MODELS[family].model, side: key, playbook: SIDES[key].playbook, raw: r.raw, reasoning: r.reasoning || '', meta: r.meta, parse: { ok: !error, error } });
  }
  return { key, family, points: points || [], error, file: `${key}${tag}.raw.json` };
}

export function mergePoints(root, results) { return withStoreLock(root, () => mergePointsLocked(root, results)); }
function mergePointsLocked(root, results) {
  const f = path.join(rootAbs(root), 'playbook-read', 'points.json'); const old = existsSync(f) ? readJson(f).points : [];
  const keyOf = p => sha256(JSON.stringify([p.family, p.side, p.ruleId, p.type, p.explanation]));
  const kept = new Map(old.map(p => [keyOf(p), p]));
  const fresh = results.flatMap(r => r.points.map(p => ({ family: r.family, side: r.key, playbook: SIDES[r.key].playbook, ruleId: p.ruleId ?? null, type: p.type ?? null, paragraphs: p.paragraphs ?? [], explanation: p.explanation ?? '', suggestion: p.suggestion ?? '', source: r.file })));
  const touched = new Set(results.map(r => `${r.family}:${r.key}`));
  const points = [...old.filter(p => !touched.has(`${p.family}:${p.side}`)), ...fresh.map(p => ({ ...p, disposition: kept.get(keyOf(p))?.disposition ?? null, reason: kept.get(keyOf(p))?.reason ?? null }))];
  writeJson(f, { format: 'tough-eval-playbook-points/1', updatedAt: new Date().toISOString(), note: 'P2: every point gets a disposition ("fixed" or "kept") and a reason, copied to calibration-log.md, before P3 freezes the playbooks.', failures: results.filter(r => r.error).map(r => ({ family: r.family, side: r.key, error: r.error })), points });
  return points.length;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const o = args(process.argv.slice(2)); const root = o.root || 'v2';
  const families = o.family ? [o.family] : READERS, keys = o.document && o.side ? [`${o.document}-${o.side}`] : Object.keys(SIDES);
  const results = []; for (const family of families) for (const key of keys) { const r = await readOne({ family, key, root, dryRun: !!o['dry-run'] }); results.push(r); console.log(`${family} ${key}: ${r.dryRun ? `dry run, ${r.userChars} chars` : r.error ? `unusable (${r.error})` : `${r.points.length} points`}`); }
  if (!o['dry-run']) console.log(`${mergePoints(root, results)} points in playbook-read/points.json`);
}
