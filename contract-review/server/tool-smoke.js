// SPDX-License-Identifier: GPL-3.0-or-later
// The tool smoke test (product v2 spec PR-MODEL-03; benchmark P14; plan task 10): one fixed agentic review of the
// fixture in data/fixtures/tools-smoke/ over an in-memory store seeded from store-seed.json (server/store/seed.js), with
// the product's own store tools. A setup passes when the model calls at least one store tool and returns a parseable
// findings array; a setup that fails runs single-call (toolsSupported: false). The same run reports whether any store
// citation verified, which scripts/smoke-agentic.mjs uses as its exit check. The store and listener live only for the
// run; nothing touches .local or Paperless.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { seedFakeStore } from './store/seed.js';
import { prepareAgenticReview, DEFAULT_MAX_TOOL_CALLS } from './store/tools.js';
import { startToolsListener } from './tools-listener.js';
import { reviewDocument } from './review.js';
import { getExecutorConfig } from './executors.js';

export const TOOLS_SMOKE_DIR = fileURLToPath(new URL('../data/fixtures/tools-smoke/', import.meta.url));

/** The fixture: its store seed and its fixed review (counterparty, document, playbook, mode). */
export function loadToolsSmoke(dir = TOOLS_SMOKE_DIR) {
  const review = JSON.parse(readFileSync(path.join(dir, 'review.json'), 'utf8'));
  const playbook = JSON.parse(readFileSync(path.resolve(dir, review.playbook), 'utf8'));
  return { seedPath: path.join(dir, 'store-seed.json'), review, playbook };
}

/** The fixture's store and the agentic review prepared over it (the listener too, for the Claude CLI). */
export async function openToolsSmoke({ dir = TOOLS_SMOKE_DIR, listen = true, maxToolCalls = DEFAULT_MAX_TOOL_CALLS } = {}) {
  const { seedPath, review, playbook } = loadToolsSmoke(dir);
  const { store, ids } = await seedFakeStore(seedPath);
  const listener = listen ? await startToolsListener({ getStore: () => store }) : null;
  const agentic = await prepareAgenticReview(store, { counterparty: review.counterparty, listener, maxToolCalls });
  return { store, ids, review, playbook, agentic, listener, close: async () => { if (listener) await listener.close(); } };
}

/**
 * Run the smoke review. `config` is the executor configuration (default: the environment's); `traceDir` keeps the
 * trace. Returns { passed, calledTools, parseable, toolCalls, citations, verifiedCitations, result, error }.
 */
export async function runToolSmoke({ config = getExecutorConfig(), traceDir = null, maxToolCalls = DEFAULT_MAX_TOOL_CALLS, dir = TOOLS_SMOKE_DIR } = {}) {
  const s = await openToolsSmoke({ dir, maxToolCalls });
  try {
    let result, error = null;
    try { result = await reviewDocument({ document: s.review.document, playbook: s.playbook, reviewMode: s.review.reviewMode, agentic: s.agentic, config: { ...config, traceDir: traceDir || config.traceDir || null } }); }
    catch (e) { error = e; }
    const toolCalls = result?.toolCalls || [];
    const citations = (result?.findings || []).flatMap(f => (f.record || []).map(c => ({ ...c, paragraphId: f.paragraphId })));
    const calledTools = toolCalls.length > 0;
    const parseable = Boolean(result && Array.isArray(result.findings));
    return { passed: calledTools && parseable, calledTools, parseable, agentic: Boolean(result?.model?.agentic), toolCalls, citations, verifiedCitations: citations.filter(c => c.verified), result: result || null, error };
  } finally { await s.close(); }
}
