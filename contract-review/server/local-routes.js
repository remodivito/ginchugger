// SPDX-License-Identifier: GPL-3.0-or-later
// The local app's own routes under /api/v2/local (product v2 spec 6.2.2), slice S6: the settings file minus secrets
// (GET, PUT), the tool smoke test (PR-MODEL-03) and the benchmark error profiles the Settings page links each setup to
// (PR-MODEL-04); slice S7 the team: joining with a setup code, leaving, the team state the pages' banner shows
// (signed in as, signed out by an admin, record unavailable, version mismatch), and the executor keys kept in the
// keychain (values go in, never out). Errors are { error: { code, message } } (6.2.4). Mounted before /api/v2 and only
// on the local app, never on the team server.
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeExecutor, getExecutorConfig } from './executors.js';
import { EDITABLE } from './secrets.js';
import { readSettings, writeReviewSettings, applyReviewSettings, lockedReviewSettings, reviewExecutors, REVIEW_EFFORTS } from './settings.js';

export const BENCHMARK_PROFILES = fileURLToPath(new URL('../data/benchmark-profiles.json', import.meta.url));

/** The benchmark profile for a model id (PR-MODEL-04: matched by model id), or null: "not benchmarked". */
export function profileFor(profiles, model) { return (profiles?.profiles || []).find(p => p.model === model) || null; }

/**
 * `fixed`: the names of the environment variables set when the app started; they override the file (6.5).
 * `runSmoke`: the tool smoke test (server/tool-smoke.js), injected so tests never call a model.
 */
export function localRoutes({ dataDir, fixed, runSmoke, describeEnv = () => process.env, team = null, secrets = null }) {
  const r = express.Router();
  const h = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
  const view = () => {
    const s = readSettings(dataDir).review; const effective = describeExecutor(describeEnv());
    const smoke = s.toolSmoke && s.toolSmoke.executor === effective.executor && (s.toolSmoke.model || null) === (effective.model || null) ? s.toolSmoke : null;
    return { review: { executor: s.executor, model: s.model, effort: s.effort, agentic: s.agentic }, effective, toolSmoke: smoke, toolsSupported: getExecutorConfig().toolsSupported, locked: lockedReviewSettings(fixed), executors: reviewExecutors(), efforts: REVIEW_EFFORTS };
  };
  const apply = () => applyReviewSettings(dataDir, { fixed, describe: env => describeExecutor(env) });

  r.get('/settings', h(async (req, res) => res.json(view())));
  r.put('/settings', express.json({ limit: '64kb' }), h(async (req, res) => {
    writeReviewSettings(dataDir, req.body?.review, { fixed }); apply(); res.json(view());
  }));
  r.post('/tool-smoke', h(async (req, res) => {
    const config = getExecutorConfig();
    const out = await runSmoke({ config: { ...config, toolsSupported: true } });
    const toolSmoke = { passed: !!out.passed, at: new Date().toISOString(), executor: config.executor, model: config.model || null, toolCalls: (out.toolCalls || []).length, calledTools: !!out.calledTools, error: out.error ? String(out.error.message || out.error).slice(0, 300) : null };
    writeReviewSettings(dataDir, { toolSmoke }, { fixed }); apply(); res.json(view());
  }));
  // Team mode (7.10, 7.11): the state the pages show, joining with a code, and leaving.
  r.get('/team', h(async (req, res) => res.json(team ? await team.check() : { mode: 'solo' })));
  r.post('/sign-in', express.json({ limit: '16kb' }), h(async (req, res) => {
    const b = req.body || {};
    res.json(await team.signIn({ serverUrl: b.serverUrl, code: b.code, deviceName: typeof b.deviceName === 'string' ? b.deviceName : '', caFile: typeof b.caFile === 'string' && b.caFile.trim() ? b.caFile.trim() : null }));
  }));
  r.post('/sign-out', h(async (req, res) => res.json(await team.signOut())));
  // Executor keys in the keychain (6.2.2): which are set, never their values.
  r.get('/secrets', h(async (req, res) => res.json({ set: secrets.names(), store: secrets.kind, note: secrets.note })));
  r.put('/secrets', express.json({ limit: '16kb' }), h(async (req, res) => {
    const name = req.body?.name;
    if (!EDITABLE.includes(name)) throw Object.assign(new Error(`Name one of: ${EDITABLE.join(', ')}.`), { status: 400 });
    secrets.set(name, req.body?.value); res.json({ set: secrets.names(), store: secrets.kind, note: secrets.note });
  }));
  r.delete('/secrets/:name', h(async (req, res) => {
    if (!EDITABLE.includes(req.params.name)) throw Object.assign(new Error(`Name one of: ${EDITABLE.join(', ')}.`), { status: 400 });
    secrets.delete(req.params.name); res.json({ set: secrets.names(), store: secrets.kind, note: secrets.note });
  }));
  r.get('/benchmarks', h(async (req, res) => res.json(JSON.parse(readFileSync(BENCHMARK_PROFILES, 'utf8')))));

  r.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown operation.' } }));
  // eslint-disable-next-line no-unused-vars
  r.use((e, req, res, next) => { const status = e.status || (e.type === 'entity.too.large' ? 413 : 500); res.status(status).json({ error: { code: e.code && !/^[A-Z_]+$/.test(e.code) ? e.code : status === 400 ? 'bad_request' : 'error', message: e.message || 'The operation could not be completed.' } }); });
  return r;
}
