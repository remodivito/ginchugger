// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's live progress (Ask C, 17 Oct 2026): what the model is doing while it answers, as short steps the pane shows one
// under another ("Searched Brightwater’s documents · 4 found", "Reading the 2025 NDA"). Each step is
// { id, text, state: 'active' | 'done' }; a step is sent when it starts and again when it ends, with its text in the
// past tense. The steps come from the store tool calls as they happen (the tools listener for the Claude CLI, the tool
// loop for the API executors), so they say only what was looked up, never what a document says.
const MAX_TITLE = 80;
const cut = s => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t; };
/** "Brightwater Analytics Ltd’s"; a name ending in s takes the apostrophe alone. */
export const possessive = name => { const n = cut(name); return /s$/i.test(n) ? `${n}’` : `${n}’s`; };
const found = n => (Number.isInteger(n) ? ` · ${n} found` : '');

/**
 * The text of one tool call's step. `phase`: 'start' (present tense) or 'done' (past tense, with what came back).
 * `ctx`: { counterparty, documentId (the document under review), titles: Map(documentId -> title) }.
 */
export function toolStepText(name, args = {}, result = null, phase = 'done', ctx = {}) {
  const done = phase === 'done';
  const failed = done && result?.error;
  const titles = ctx.titles || new Map();
  const cp = args.counterparty || (name === 'get_counterparty_overview' ? ctx.counterparty : null);
  const whose = cp ? `${possessive(cp)} documents` : 'the documents';
  let text;
  if (name === 'get_counterparty_overview' || name === 'list_documents') {
    const count = name === 'get_counterparty_overview' ? result?.documentCount : result?.count;
    text = done ? `Searched ${whose}${failed ? '' : found(count)}` : `Searching ${whose}`;
  } else if (name === 'search_documents') {
    const q = args.query ? ` for “${cut(args.query)}”` : '';
    const where = cp ? ` ${whose}` : '';
    text = done ? `Searched${where}${q}${failed ? '' : found(result?.count)}` : `Searching${where}${q}`;
  } else if (name === 'read_document') {
    const id = Number(args.documentId);
    const own = ctx.documentId && id === Number(ctx.documentId);
    const title = own ? 'this draft' : cut(result?.document?.title || titles.get(id) || `document ${Number.isInteger(id) ? id : ''}`.trim());
    text = done ? `Read ${title}` : `Reading ${title}`;
  } else {
    text = done ? 'Looked something up' : 'Looking something up';
  }
  return failed ? `${text} · failed` : text;
}

/** Titles a tool result names (overview, list, search, read), so a later "Reading …" can say which document. */
export function learnTitles(result, titles) {
  if (!result || typeof result !== 'object') return titles;
  const lines = [...(result.documents || []), ...(result.hits || []), ...((result.types || []).flatMap(t => t.documents || [])), ...(result.document ? [result.document] : [])];
  for (const d of lines) if (Number.isInteger(d?.documentId) && typeof d.title === 'string') titles.set(d.documentId, d.title);
  return titles;
}

/**
 * One Ask's progress. `emit(step)` is called with every new or changed step. `draft()` starts "Reading this draft";
 * `counterpartyDocuments(name)` is the single step of the fallback without tools; `onCall` takes the executors' tool
 * events ({ phase: 'start' | 'done', name, args, result }); `finish()` marks every step done.
 */
export function askProgress({ emit = () => {}, counterparty = null, documentId = null } = {}) {
  const steps = new Map(); const titles = new Map(); let n = 0; const open = [];
  const send = s => { steps.set(s.id, s); emit({ ...s }); return s; };
  const start = (id, text) => send({ id, text, state: 'active' });
  const end = (id, text) => { const s = steps.get(id); if (s && s.state !== 'done') send({ ...s, text: text ?? s.text, state: 'done' }); };
  return {
    titles,
    draft() { start('draft', 'Reading this draft'); },
    counterpartyDocuments(name) { start('context', `Reading ${possessive(name)} documents`); },
    counterpartyDocumentsDone(name, count) { end('context', `Read ${possessive(name)} documents${found(count)}`); },
    onCall({ phase, name, args = {}, result = null } = {}) {
      const ctx = { counterparty, documentId, titles };
      if (phase === 'start') {
        end('draft', 'Read this draft');
        const id = `t${++n}`; open.push({ id, name, args: JSON.stringify(args) });
        start(id, toolStepText(name, args, null, 'start', ctx));
      } else if (phase === 'done') {
        learnTitles(result, titles);
        const i = open.findIndex(o => o.name === name && o.args === JSON.stringify(args));
        const id = i >= 0 ? open.splice(i, 1)[0].id : `t${++n}`;
        if (i < 0) start(id, toolStepText(name, args, null, 'start', ctx));
        end(id, toolStepText(name, args, result, 'done', ctx));
      }
    },
    finish() { for (const s of steps.values()) if (s.state !== 'done') end(s.id, s.id === 'draft' ? 'Read this draft' : s.text.replace(/^Reading /, 'Read ').replace(/^Searching/, 'Searched')); },
    steps: () => [...steps.values()],
  };
}

/**
 * Steps so far by request (17 Oct 2026): the pane names each Ask with an `askId` and, when no stream chunk has come for a
 * couple of seconds, reads GET /api/ask/progress/:id, so the steps show in a webview that holds a streamed response back.
 * Kept for `ttlMs` after the Ask ends; at most `max` requests at once (the oldest go first).
 */
export const ASK_ID = /^[A-Za-z0-9_-]{8,64}$/;
export function progressRegistry({ ttlMs = 5 * 60_000, max = 200, now = () => Date.now() } = {}) {
  const runs = new Map();
  const sweep = () => { const t = now(); for (const [id, r] of runs) if (r.endedAt !== null && t - r.endedAt > ttlMs) runs.delete(id); while (runs.size > max) runs.delete(runs.keys().next().value); };
  return {
    open(id) { if (!ASK_ID.test(String(id || ''))) return null; sweep(); runs.delete(id); runs.set(id, { steps: new Map(), endedAt: null }); return id; },
    step(id, s) { const r = runs.get(id); if (r && s?.id) r.steps.set(s.id, { id: s.id, text: s.text, state: s.state }); },
    end(id) { const r = runs.get(id); if (r) r.endedAt = now(); },
    get(id) { sweep(); const r = runs.get(id); return r ? { steps: [...r.steps.values()], done: r.endedAt !== null } : { steps: [], done: false }; },
  };
}

/** One NDJSON line, padded with trailing spaces to at least `min` bytes (JSON.parse ignores them), so a webview that
 *  holds back small chunks of a streamed response still passes each step on. */
export function ndjsonLine(o, min = 0) {
  const s = JSON.stringify(o); const n = Buffer.byteLength(s);
  return (n < min ? s + ' '.repeat(min - n) : s) + '\n';
}
