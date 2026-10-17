// SPDX-License-Identifier: GPL-3.0-or-later
import express from 'express';
import multer from 'multer';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { reviewDocument, askQuestion, reviseFinding } from './review.js';
import { importDocx, exportDocx } from './docx.js';
import { describeExecutor, toolsSupported, getExecutorConfig } from './executors.js';
import { importProsePlaybook } from './playbook.js';
import { getSession, saveSession, clearSession } from './pane-session.js';
import { buildRecord } from './record.js';
import { openRecord, soloActor } from './record/index.js';
import { recordRoutes } from './record/http.js';
import { importPlaybooks, defaultSeeds } from './record/legacy.js';
import { pidFile } from './record/admin.js';
import { startToolsListener, createTokenStore } from './tools-listener.js';
import { readSettings, applyReviewSettings, readStoreSettings } from './settings.js';
import { openSecrets, secretsLoader } from './secrets.js';
import { localGuard } from './local-guard.js';
import { makeTeamClient, APP_VERSION } from './team-client.js';
import { localRoutes } from './local-routes.js';
import { runToolSmoke } from './tool-smoke.js';
import { storeConfig, createStoreService } from './store/service.js';
import { storeRoutes } from './store/http.js';
import { openReviewHistory } from './store/review-history.js';
import { counterpartyContext } from './store/context.js';
import { prepareAgenticReview, DEFAULT_MAX_TOOL_CALLS } from './store/tools.js';
import { askProgress, progressRegistry, ndjsonLine } from './ask-progress.js';
import { askErrorMessage, reviewErrorMessage } from './ask-reply.js';
import { plainMessage } from '../shared/plain-error.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Local configuration is never served to the browser or included in exports.
if (existsSync(path.join(root, '.env'))) {
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}
// The review setup on the Settings page lives in settings.json; a REVIEW_* variable set now (the environment or .env)
// overrides it (product v2 spec 6.5) and is never changed by the page.
const fixedEnv = new Set(Object.keys(process.env).filter(k => k.startsWith('REVIEW_') && process.env[k] !== ''));
// Keys set in the environment or `.env` at start win over the keychain's (development, 6.2.2).
const startEnv = new Set(Object.keys(process.env).filter(k => process.env[k] !== ''));
// The record signing key (an Ed25519 seed) is for /api/review-record only. Taken out of the process environment here,
// before anything is spawned, so a model CLI started for a review or a question never inherits it (readiness audit,
// 17 Oct 2026, security finding 1; the executors' own strip list is frozen by the benchmark, so the key is kept out of
// process.env altogether instead). A key saved on the Settings page is read from the keychain at signing time and is
// never placed in the environment either (server/secrets.js).
const signingKeyFromEnv = process.env.REVIEW_RECORD_SIGNING_KEY || null;
delete process.env.REVIEW_RECORD_SIGNING_KEY;
const app = express();
app.disable('x-powered-by');
// Localhost only, and only this origin: Host, Origin and Sec-Fetch-Site are checked on every request (server/local-guard.js).
app.use(localGuard({ secure: !!(process.env.HTTPS_KEY && process.env.HTTPS_CERT) }));
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const originals = new Map();
const local = process.env.MARGIN_STATE_DIR || path.join(root, '.local');
if (!process.env.PANE_SESSION_ROOT) process.env.PANE_SESSION_ROOT = path.join(local, 'pane-sessions');
// The record (product v2 spec section 5, after decision 190): the team's playbooks, members and settings in SQLite in the
// data folder in solo mode, or the team server's through RemoteRecord in team mode (slice S7; `mode: team` and the key
// in the keychain). In solo mode the shipped playbooks are copied in (slice S6); in team mode the team server does it.
// Documents live in the document store (below).
const secrets = await openSecrets({ dataDir: local });
const keys = secretsLoader(secrets, { fixed: startEnv });
let record, soloReady = Promise.resolve();
async function soloSetup(rec) {
  // From S6 every save is a `playbook_changed` event naming who, when, which rule and what kind of change (PR-PAGE-02).
  await importPlaybooks(rec, local).catch(e => console.error(`Playbooks not copied into the record: ${e.message}`));
}
const team = await makeTeamClient({ dataDir: local, secrets, openLocal: () => { const r = openRecord({ dataDir: local }); soloReady = soloSetup(r); return r; }, onSwitch: r => { record = r; } });
record = team.record();
await soloReady;
if (team.mode === 'team') console.log(`Team mode: the record is on ${team.view().serverUrl}${team.view().user ? ` (signed in as ${team.view().user.name})` : ''}.`);
applyReviewSettings(local, { fixed: fixedEnv, describe: env => describeExecutor(env) });
// The document store (decision 191; plan task 1): Paperless-ngx, started in the background so the app never waits for
// it. Managed by default only for the app's own data folder in solo mode; any other folder (the tests') has it off
// unless settings.json or GCL_STORE says otherwise. Without Docker the solo app falls back to the built-in, in-memory
// store (documents kept until the app stops) and says so in one line. The Inbox, Library, document, Trash, Activity and Admin screens, the
// Word pane and the agent's tools read it.
const store = createStoreService({ config: storeConfig({ settings: readStoreSettings(local), dataDir: local, defaultMode: !process.env.MARGIN_STATE_DIR && team.mode === 'solo' ? 'managed' : 'off' }), builtInWhenNoDocker: team.mode === 'solo' });
store.start().then(async s => {
  if (s.state === 'unavailable') return console.error(`Document store unavailable: ${s.reason}`);
  // Solo mode: this computer's user gets their own store user, so the store's history names them (plan decision 5).
  if (s.state === 'ready' && team.mode === 'solo') await store.ensureUser({ id: soloActor(), name: soloActor() }).catch(e => console.error(`Store user not created: ${e.message}`));
});
/**
 * The store documents come from: this computer's (solo mode), or the team store on the team machine through the team
 * server, as the signed-in member (team mode; server/store/remote.js). Paperless and its tokens never leave that machine.
 */
const documents = () => team.store || store;
/** A record failure that means "the team server is not there for us": a review then uses the playbooks last read (PR-TEAM-06). */
const RECORD_DOWN = new Set(['record_unavailable', 'certificate_untrusted', 'key_revoked', 'unauthorized']);
const recordDown = e => RECORD_DOWN.has(e?.code);
// The tools listener (product v2 spec 6.4.2 step 4; plan task 10): plain HTTP on 127.0.0.1 at an ephemeral port, review
// tokens only, for the Claude CLI's MCP child during an agentic review or an Ask. Tokens are minted in-process by
// runModel, never over HTTP; each names the lawyer, so the lookups read the store as them.
const reviewTokens = createTokenStore();
const toolsListener = await startToolsListener({ getStore: scope => documents().getClient(scope.actor || null), tokens: reviewTokens });
const maxToolCalls = () => Number(process.env.REVIEW_MAX_TOOL_CALLS) || DEFAULT_MAX_TOOL_CALLS;
/**
 * The store tools for a review or a question about store document `id` (plan task 10), as the acting lawyer; null when
 * there is no such document or the store is unavailable (the review then runs without it and says so).
 */
async function storeAgentic(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { agentic: null, unavailable: false };
  try {
    const a = storeActor();
    return { agentic: await prepareAgenticReview(documents().getClient(a.id), { documentId: n, actor: a.id, listener: toolsListener, maxToolCalls: maxToolCalls() }), unavailable: false };
  } catch (e) { return { agentic: null, unavailable: e.code === 'store_unavailable' || e.status === 503 }; }
}
const load = async name => JSON.parse(await readFile(path.join(root, 'data', name), 'utf8'));
// Playbooks, from the record: the NDA playbook is the default for any caller that names none, as before. The playbook
// keeps `version` as an alias of its change counter (PR-PB-02).
const playbookId = v => typeof v === 'string' && v.trim() ? v.trim() : undefined;
// In team mode the last playbook read is kept, so a review still runs while the team server is unreachable (PR-TEAM-06).
const lastPlaybooks = new Map();
const getPlaybook = async id => {
  const want = playbookId(id) || 'nda';
  try { const pb = await record.playbooks.get(want); lastPlaybooks.set(want, pb); return pb; } catch (e) {
    if (!recordDown(e)) throw e;
    if (lastPlaybooks.has(want)) return lastPlaybooks.get(want);
    const seed = defaultSeeds().find(x => x.id === want);
    if (!seed) throw e;
    const pb = JSON.parse(readFileSync(seed.seedPath, 'utf8'));
    return { ...pb, id: want, version: Number(pb.version) || 1, changeCount: Number(pb.version) || 1 };
  }
};
// What a review, a revision or a question sends the model: the playbook's content and change counter, not who changed it.
const reviewPlaybook = async id => { const pb = await getPlaybook(id); return { id: pb.id, title: pb.title, version: pb.version, ...(pb.appliesTo ? { appliesTo: pb.appliesTo } : {}), ...(pb.provenance ? { provenance: pb.provenance } : {}), rules: pb.rules }; };
const listed = p => ({ id: p.id, title: p.title, version: p.changeCount, appliesTo: p.appliesTo, rules: p.rules, provenance: null, changeCount: p.changeCount, updatedAt: p.updatedAt, updatedBy: p.updatedBy, lastChange: p.lastChange });
const listPlaybooks = async () => {
  try { return await Promise.all((await record.playbooks.list()).map(async p => { const pb = await record.playbooks.get(p.id); lastPlaybooks.set(p.id, pb); return { ...listed(p), provenance: pb.provenance || null }; })); } catch (e) {
    if (!recordDown(e)) throw e;
    // The team server is unreachable: the playbooks last read here, else the shipped ones, so a review can still run.
    const ids = [...new Set([...lastPlaybooks.keys(), ...defaultSeeds().map(x => x.id)])];
    return (await Promise.all(ids.map(id => getPlaybook(id).catch(() => null)))).filter(Boolean).map(pb => ({ ...listed({ ...pb, rules: pb.rules?.length ?? 0 }), rules: pb.rules?.length ?? 0, provenance: pb.provenance || null }));
  }
};
const playbookRef = pb => ({ id: pb.id, title: pb.title || pb.id, version: pb.version });
function validateDocument(doc) {
  if (!doc || typeof doc.id !== 'string' || !Array.isArray(doc.paragraphs) || !doc.paragraphs.length || doc.paragraphs.length > 1500) throw new Error('Supply a document with 1–1,500 paragraphs.');
  const ids = new Set();
  for (const p of doc.paragraphs) {
    if (typeof p.id !== 'string' || ids.has(p.id) || typeof p.text !== 'string' || p.text.length > 50000) throw new Error('Document paragraphs must have unique identifiers and valid text.');
    ids.add(p.id);
  }
}
// The version comes from package.json (6.2.5); the executor is described with the keychain's keys in view.
app.get('/api/status', (req, res) => { const ex = describeExecutor(keys.view()); res.json({ diagnostics: process.env.PANE_DIAGNOSTICS === '1', liveAvailable: ex.available, executor: ex.executor, model: ex.model, effort: ex.effort, reason: ex.reason, version: APP_VERSION, mode: team.mode }); });
app.get('/api/cases', async (req, res) => {
  const cases = await load('cases.json');
  res.json(cases.map(({ expected, ...sample }) => sample));
});
// The /api/playbooks family stays for compatibility (6.2.2), over the record: what it writes is a playbook change like
// any other, attributed to this computer's user.
app.get('/api/playbooks', async (req, res, next) => { try { res.json(await listPlaybooks()); } catch (e) { next(e); } });
// Create a playbook from an imported draft: an explicit action with a name and what it applies to (P6).
app.post('/api/playbooks', async (req, res, next) => { try { res.status(201).json(await record.playbooks.create({ title: req.body?.title, appliesTo: req.body?.appliesTo || null, draft: req.body?.draft || {} }, soloActor())); } catch (e) { next(e); } });
// One playbook: ?id= names it; without an id the first (NDA) playbook answers, as the single playbook did before.
app.get('/api/playbook', async (req, res, next) => { try { res.json(await getPlaybook(req.query.id)); } catch (e) { next(e); } });
app.put('/api/playbook', async (req, res, next) => {
  try {
    const id = playbookId(req.query.id) || playbookId(req.body?.id) || 'nda'; const b = req.body || {};
    const seen = Number.isInteger(b.version) ? b.version : b.changeCount; // an old caller sends back the `version` it read
    const out = await record.playbooks.update(id, { rules: b.rules, ...(typeof b.title === 'string' ? { title: b.title } : {}), ...(b.appliesTo !== undefined ? { appliesTo: b.appliesTo } : {}) }, seen, soloActor());
    res.status(out?.proposal ? 202 : 200).json(out); // a non-owner's save is a proposal (decision 178)
  } catch (e) { next(e); }
});
// Import a prose playbook (R7.1, D43): returns a draft for inspection; nothing is activated until the lawyer says so.
app.post('/api/playbook/import', upload.single('file'), async (req, res, next) => {
  try {
    let text, sourceName;
    if (req.file) {
      if (!req.file.originalname.toLowerCase().endsWith('.docx')) throw Object.assign(new Error('Import a Word .docx playbook or paste text.'), { status: 400 });
      const doc = await importDocx(req.file.buffer, req.file.originalname); sourceName = req.file.originalname;
      text = doc.paragraphs.map((p, i) => `[p${i + 1}] ${p.text}`).join('\n');
    } else { text = typeof req.body?.text === 'string' ? req.body.text : ''; sourceName = typeof req.body?.sourceName === 'string' ? req.body.sourceName : 'pasted-text'; }
    if (!text.trim()) throw Object.assign(new Error('Nothing to import.'), { status: 400 });
    const rules = importProsePlaybook(text, { sourceName });
    if (!rules.length) throw Object.assign(new Error('No "Section N — Title" headings found; the mechanical importer needs numbered section headings.'), { status: 400 });
    res.json({ draft: { title: `Imported from ${sourceName}`, provenance: { method: 'mechanical heading split, no model', source: sourceName, importedAt: new Date().toISOString() }, rules }, note: 'A draft. Review it, then Use this playbook to activate it.' });
  } catch (e) { next(e); }
});
// Use this playbook: an imported draft replaces the playbook's entries, recorded as an `imported` change.
app.post('/api/playbook/activate', async (req, res, next) => {
  try {
    const id = playbookId(req.query.id) || playbookId(req.body?.playbookId) || 'nda'; const draft = req.body?.draft || {};
    const current = await record.playbooks.get(id);
    const seen = Number.isInteger(req.body?.changeCount) ? req.body.changeCount : current.changeCount;
    const out = await record.playbooks.update(id, { rules: draft.rules, ...(typeof draft.title === 'string' ? { title: draft.title } : {}), ...(draft.appliesTo ? { appliesTo: draft.appliesTo } : {}), ...(draft.provenance ? { provenance: draft.provenance } : {}) }, seen, soloActor(), { kind: 'imported' });
    res.status(out?.proposal ? 202 : 201).json(out);
  } catch (e) { next(e); }
});
/** A review's failure in words a lawyer can act on (the internal message goes to the log); a model failure is a 502. */
function reviewError(e) {
  const message = reviewErrorMessage(e);
  if (message === e.message) return e;
  console.error(`Review failed: ${e.message}`);
  return Object.assign(new Error(message), { status: e.status && e.status !== 400 ? e.status : 502 });
}
// The client going away (the pane's Stop) aborts the review: the Claude CLI child is killed, an API call is cancelled,
// and nothing is answered (17 Oct 2026; stress scenarios review-hang, review-blocks-server).
app.post('/api/review', async (req, res, next) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    validateDocument(req.body.document);
    if (req.body.baseline) validateDocument(req.body.baseline);
    const playbook = await reviewPlaybook(req.body.playbookId);
    const context = Array.isArray(req.body.context) ? req.body.context.filter(c => c && typeof c.name === 'string' && typeof c.text === 'string' && c.text.length <= 200000).slice(0, 12) : null;
    // The document under review in the store (plan task 10): the pane sends `storeDocumentId`. With an executor that has
    // tools the model reads the store through the store tools, as this lawyer; `agentic: false` (the benchmark) or the
    // Settings switch (review.agentic) runs the single call. No events are written here: the pane posts them (7.4 step 6).
    const wantStore = req.body.storeDocumentId !== undefined && req.body.agentic !== false && readSettings(local).review.agentic;
    const { agentic, unavailable } = wantStore ? await storeAgentic(req.body.storeDocumentId) : { agentic: null, unavailable: false };
    const result = await keys.with(() => reviewDocument({ document: req.body.document, baseline: req.body.baseline || null, playbook, context, reviewMode: req.body.reviewMode === 'third-party' ? 'third-party' : 'own-paper', agentic, signal: controller.signal }));
    if (controller.signal.aborted) return; // Stop: nobody is listening
    // The result says which playbook and version it used (P5), so "changed since review" uses the same one.
    res.json({ ...result, playbook: playbookRef(playbook), playbookSnapshot: playbook, ...(unavailable ? { storeUnavailable: true } : {}) });
  } catch (e) { if (controller.signal.aborted) return; next(reviewError(e)); }
});
app.post('/api/review/revise', async (req, res, next) => {
  try {
    validateDocument(req.body.document);
    if (req.body.baseline) validateDocument(req.body.baseline);
    const playbook = await reviewPlaybook(req.body.playbookId);
    res.json(await keys.with(() => reviseFinding({ document: req.body.document, baseline: req.body.baseline || null, playbook, finding: req.body.finding, instruction: req.body.instruction, context: req.body.context || null, reviewMode: req.body.reviewMode || 'own-paper' })));
  } catch (e) { next(reviewError(e)); }
});
// Ask (plan task 10): with `storeDocumentId` the question is about a document the store holds. With an executor that
// has tools the model reads the store itself through the store tools, as this lawyer; without tools the counterparty's
// other documents go with the question (server/store/context.js, phase 2b's fallback). Without the store the question
// is still answered, from the draft alone.
async function askContext(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  try {
    const client = documents().getClient(storeActor().id);
    const d = await client.getDocument(n);
    if (!d.counterparty) return null;
    const items = await counterpartyContext(client, { counterparty: d.counterparty, exclude: [d.id, ...(d.duplicates || []).map(x => x.id)] });
    return items.length ? { counterparty: d.counterparty, documents: items } : null;
  } catch { return null; }
}
/** A source's document title and date, for the pane's "N sources" list; the citation check is unchanged. */
async function titledSources(sources, { titles = new Map(), docs = [] } = {}) {
  if (!Array.isArray(sources) || !sources.length) return sources;
  const known = new Map(docs.map(d => [Number(d.documentId), { title: d.title, date: d.created || null }]));
  let client = null;
  return Promise.all(sources.map(async c => {
    if (!Number.isInteger(c.documentId)) return c;
    let d = known.get(c.documentId);
    if (!d) {
      try { client ||= documents().getClient(storeActor().id); const x = await client.getDocument(c.documentId); d = { title: x.title, date: x.created || null }; } catch { d = titles.has(c.documentId) ? { title: titles.get(c.documentId), date: null } : null; }
      if (d) known.set(c.documentId, d);
    }
    return d ? { ...c, title: d.title || null, date: d.date ? String(d.date).slice(0, 10) : null } : c;
  }));
}
/**
 * Ask, with live progress (Ask C, 17 Oct 2026). With `stream: true` the answer comes as NDJSON: one
 * { type: 'step', step: { id, text, state } } line per step as it starts or ends (the store lookups as the model makes
 * them, from the tools listener or the tool loop; the fallback without tools reads the counterparty's documents as one
 * step), then { type: 'answer', answer } or { type: 'error', error }. Without `stream` one JSON answer, as before.
 * The client going away (Stop) aborts the call: the Claude CLI child is killed, an API call is cancelled.
 */
// With `askId` (the pane's name for the request) the steps are also kept for GET /api/ask/progress/:id, which the pane
// reads when no stream chunk has come for a while (17 Oct 2026: a webview may hold a streamed response back). Each
// streamed line is padded to 512 bytes and the stream opens with a 2 KB line, for the same reason.
const askRuns = progressRegistry();
app.get('/api/ask/progress/:id', (req, res) => { res.set('Cache-Control', 'no-store').json(askRuns.get(req.params.id)); });
app.post('/api/ask', async (req, res, next) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let streaming = false;
  const line = (o, pad = 0) => { if (streaming && !res.writableEnded && !controller.signal.aborted) res.write(ndjsonLine(o, pad)); };
  const askId = askRuns.open(req.body?.askId);
  let asking = false; // the input checks' messages are already plain; from here on errors are translated
  try {
    validateDocument(req.body.document);
    if (typeof req.body.question !== 'string' || !req.body.question.trim() || req.body.question.length > 4000) throw new Error('Ask a question of up to 4,000 characters.');
    const playbook = await reviewPlaybook(req.body.playbookId);
    const { storeDocumentId, agentic: _ignored, stream, askId: _id, ...body } = req.body;
    if (stream === true) {
      streaming = true;
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      line({ type: 'start', ...(askId ? { askId } : {}) }, 2048);
    }
    asking = true;
    const out = await keys.with(async () => {
      const tools = toolsSupported(getExecutorConfig()) && readSettings(local).review.agentic;
      const { agentic } = storeDocumentId !== undefined && tools ? await storeAgentic(storeDocumentId) : { agentic: null };
      const progress = askProgress({ emit: step => { askRuns.step(askId, step); line({ type: 'step', step }, 512); }, counterparty: agentic?.tools?.scope?.counterparty || null, documentId: agentic?.tools?.scope?.documentId || null });
      let context = null;
      if (agentic) { agentic.tools.onCall = progress.onCall; progress.draft(); }
      else {
        const cp = streaming && storeDocumentId !== undefined ? await askCounterparty(storeDocumentId) : null;
        if (cp) progress.counterpartyDocuments(cp);
        context = await askContext(storeDocumentId);
        if (cp) progress.counterpartyDocumentsDone(cp, context?.documents?.length ?? 0);
        progress.draft();
      }
      const answer = await askQuestion({ ...body, playbook, context, agentic, signal: controller.signal });
      progress.finish();
      return { ...answer, ...(answer.sources ? { sources: await titledSources(answer.sources, { titles: progress.titles, docs: context?.documents || [] }) } : {}) };
    });
    askRuns.end(askId);
    if (streaming) { line({ type: 'answer', answer: out }); return res.end(); }
    res.json(out);
  } catch (e) {
    askRuns.end(askId);
    if (controller.signal.aborted) return; // Stop: nobody is listening
    // Said in words a lawyer can act on; the internal message goes to the log only.
    const message = asking ? askErrorMessage(e) : plainMessage(e.message, 'The question could not be asked. Ask again.');
    if (!streaming) { if (asking) console.error(e.message); return next(Object.assign(new Error(message), { status: asking && message !== e.message && (!e.status || e.status === 400) ? 502 : e.status || 400 })); }
    console.error(e.message); line({ type: 'error', error: message }); res.end();
  }
});
/** The counterparty of store document `id`, for the fallback's one progress step; null when unknown. */
async function askCounterparty(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  try { return (await documents().getClient(storeActor().id).getDocument(n)).counterparty || null; } catch { return null; }
}

// The Word pane's review and decisions for one document, so a reload brings them back (decision 134).
app.get('/api/pane-session', async (req, res, next) => { try { res.json(await getSession(req.query.key)); } catch (e) { next(e); } });
app.put('/api/pane-session', async (req, res, next) => { try { res.json(await saveSession(req.body?.key, req.body?.state)); } catch (e) { next(e); } });
app.delete('/api/pane-session', async (req, res, next) => { try { res.json(await clearSession(req.query.key)); } catch (e) { next(e); } });
// Export record (decision 136): the review and the decisions with a hash of each part, signed when a key is configured.
// The signing key goes to buildRecord directly (the environment at start, else the keychain), never through process.env.
app.post('/api/review-record', async (req, res, next) => {
  try {
    const key = signingKeyFromEnv || secrets.get('record-signing-key') || null;
    res.json(buildRecord(req.body || {}, { env: key ? { REVIEW_RECORD_SIGNING_KEY: key } : {} }));
  } catch (e) { next(e); }
});
// Diagnostics from the Word pane (Phase 6, W1): the pane has no console we can read, so measurements are posted here
// and appended to a local file. Local only (the origin check above applies), size-capped, never served back.
app.post('/api/diagnostics', express.json({ limit: '8mb' }), async (req, res, next) => {
  if (process.env.PANE_DIAGNOSTICS !== '1') return res.status(204).end(); // off unless asked for (audit item 5)
  try { await mkdir(local, { recursive: true }); const { appendFile } = await import('node:fs/promises'); await appendFile(path.join(local, 'diagnostics.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...(req.body || {}) }).slice(0, 8_000_000) + '\n'); res.status(204).end(); } catch (e) { next(e); }
});
app.post('/api/documents/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.originalname.toLowerCase().endsWith('.docx')) throw new Error('Choose a Word .docx file, up to 10 MB.');
    const doc = await importDocx(req.file.buffer, req.file.originalname);
    validateDocument(doc);
    doc.id ||= randomUUID();
    originals.set(doc.id, req.file.buffer);
    if (originals.size > 20) originals.delete(originals.keys().next().value);
    res.json(doc);
  } catch (e) { next(e); }
});
app.post('/api/documents/export', async (req, res, next) => {
  try {
    validateDocument(req.body.document);
    const document = req.body.document;
    if (document.imported && !originals.has(document.id)) throw new Error('Reopen the original DOCX before exporting: this server no longer has its formatting package.');
    // Audit finding 9: the tracked changes carry the lawyer's name: the pane's (Word's own author, or the signed-in member),
    // else the signed-in member's, else this computer's user; never the tool's.
    const given = typeof req.body.author === 'string' && req.body.author.trim() ? req.body.author : null;
    const member = team.mode === 'team' ? team.view().user?.name || null : null;
    const buffer = await exportDocx(document, originals.get(document.id), { author: given || member || soloActor() });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="reviewed-agreement.docx"');
    res.send(Buffer.from(buffer));
  } catch (e) { next(e); }
});
// The store's screens (plan tasks 4–7) act as this computer's user in solo mode, or the signed-in member in team mode;
// the admin flag is the same one the record's routes use (solo: the one user is the admin).
const storeActor = () => {
  const user = team.mode === 'team' ? team.view().user : null;
  return { id: user?.userId || soloActor(), name: user?.name || soloActor(), admin: team.mode !== 'team' || !!user?.admin };
};
// Review history on the store (task 8): which points were applied or dismissed and why, by store document, in our SQLite
// (on the team server in team mode, beside the team store).
const reviews = openReviewHistory({ dataDir: local });
const localStoreRoutes = storeRoutes(store, { actor: storeActor, reviews, ourNames: () => readSettings(local).ourNames });
// In team mode every store request (the pages', the Word pane's) goes to the team server with the member's key.
app.use('/api/v2/store', (req, res, next) => (team.store ? team.store.proxy(req, res) : localStoreRoutes(req, res, next)));
app.use('/api/v2/local', localRoutes({ dataDir: local, fixed: fixedEnv, runSmoke: config => keys.with(() => runToolSmoke(config)), describeEnv: () => keys.view(), team, secrets }));
const started = Date.now();
app.use('/api/v2', recordRoutes(() => record, {
  actor: soloActor,
  // Solo mode: the Admin page shows the status (and records the retention statement); codes and users live on a team server.
  adminGuard: (req, op) => { if (team.mode === 'solo' && !['status', 'setRetention'].includes(op)) throw Object.assign(new Error('Setup codes and users are managed on a team server.'), { status: 403, code: 'forbidden' }); },
  statusExtras: async () => (team.mode === 'solo' ? { uptimeSeconds: Math.round((Date.now() - started) / 1000), store: store.status() } : {}),
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown operation.' }));
// The last guard (stress audit, 17 Oct 2026): a message that shows internals is replaced by a plain sentence.
app.use((err, req, res, next) => { console.error(err.message); res.status(err.status || 400).json({ error: plainMessage(err.message, 'The operation could not be completed. Try again.'), ...(err.code && !/^[A-Z_]+$/.test(err.code) ? { code: err.code } : {}) }); });
if (existsSync(path.join(root, 'dist'))) {
  // The pane and pages must never run an old build: index.html is always revalidated; hashed assets may be cached.
  app.use(express.static(path.join(root, 'dist'), { setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
const tls = process.env.HTTPS_KEY && process.env.HTTPS_CERT;
const listener = tls ? createHttpsServer({ key: readFileSync(process.env.HTTPS_KEY), cert: readFileSync(process.env.HTTPS_CERT) }, app) : app;
// The pid file lets `gcl restore` refuse while the app runs (section 9.5).
const removePid = () => { try { if (readFileSync(pidFile(local), 'utf8') === String(process.pid)) rmSync(pidFile(local)); } catch { /* already gone */ } };
process.on('exit', () => { removePid(); team.close(); });
void toolsListener; // closed with the process
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
const server = listener.listen(port, '127.0.0.1', () => { // PORT=0 takes any free port and says which
  writeFileSync(pidFile(local), String(process.pid));
  console.log(`GinChugger is ready at ${tls ? 'https' : 'http'}://localhost:${server.address().port}`);
});
