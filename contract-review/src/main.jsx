// SPDX-License-Identifier: GPL-3.0-or-later
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { alignDocument } from '../shared/compare.js';
import { plainMessage } from '../shared/plain-error.js';
import { detectWord, initializeWord, readWordDocument, readWordTexts, wordIndexOf, wordFile, applyWordReplacement, applyWordDeletion, applyWordInsertion, readComments, replyToComment, setDiagnostics, plainError, markPassage, clearMark, wordDocumentKey, watchWordSelection, appliedChangeState, alignParagraphs, cleanOutgoing, currentWordFile, undoWordChange } from './word.js';
import { reviewBatch, decisionEvent } from './review/record-events.js';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/400-italic.css';
import '@fontsource/newsreader/500.css';
import '@fontsource/newsreader/600.css';
import './tokens.css';
import './style.css';
import Pane from './review/Pane.jsx';
import { plainName } from './ui.jsx';
import DocumentView from './review/Document.jsx';
import { worstFirst, passageFor, minimalEdits, clauseHeading, threadFor, commentReplyText, inferPlaybook, coverageOf } from './review/model.js';
import SettingsPage from './pages/Settings.jsx';
import PlaybookPage from './pages/Playbook.jsx';
import AboutPage from './pages/About.jsx';
import AdminPage from './pages/Admin.jsx';
import { useActors } from './pages/shared.jsx';
import StoreLine from './pages/StoreLine.jsx';
import StoreInboxPage from './pages/StoreInbox.jsx';
import LibraryPage from './pages/Library.jsx';
import DocumentPage from './pages/DocumentPage.jsx';
import StoreTrashPage from './pages/StoreTrash.jsx';
import StoreActivityPage from './pages/StoreActivity.jsx';
import { askStream, mergeStep, selectionPayload, selectionSnippet } from './review/ask-client.js';
import { sessionIsFor } from './review/session-match.js';

// Errors arrive as { error: message } (the review routes) or { error: { code, message } } (the record, /api/v2).
async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' } }); }
  catch { throw Object.assign(Error(url.startsWith('/api/v2') ? 'Record unavailable. Retry.' : 'The local app could not be reached. Retry.'), { code: 'record_unavailable' }); }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(plainMessage(typeof value.error === 'string' ? value.error : value.error?.message, 'The request failed. Please try again.')), { code: value.error?.code || value.code || null, status: response.status });
  return value;
}
const post = (url, body, options = {}) => api(url, { ...options, method: 'POST', body: JSON.stringify(body) });
/** A random name for one Ask, for its progress endpoint. */
const newAskId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const clone = x => structuredClone(x);
const now = () => new Date().toISOString();

// Pages by hash route (product v2 spec 6.2.2, after decision 190): #/ review, #/inbox, #/library[?counterparty=…],
// #/documents/<id>, #/playbook[/<id>], #/trash, #/activity (admins), #/settings, #/admin, #/about, so the pane and the
// pages can link to each other. The Inbox, Library, document, Trash and Activity pages read the document store (plan
// tasks 4–7); matters, rounds, the register and the record's search pages went with decision 190. Admin (slice S7) is
// linked for admins in team mode and for the one user in solo mode (status only there).
const PAGES = ['review', 'inbox', 'library', 'documents', 'playbook', 'trash', 'activity', 'settings', 'admin', 'about'];
function parseRoute() {
  const [where, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, id] = where.split('/').filter(Boolean);
  return { page: PAGES.includes(page) ? page : 'review', id: id ? decodeURIComponent(id) : null, query: Object.fromEntries(new URLSearchParams(qs || '')), search: qs || '' };
}
function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => { const on = () => setRoute(parseRoute()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return route;
}
const goTo = (page, id = null) => { location.hash = page === 'review' ? '#/' : `#/${page}${id ? `/${encodeURIComponent(id)}` : ''}`; };

function App() {
  const params = new URLSearchParams(location.search);
  const isWordPane = params.get('host') === 'word' || params.has('word');
  const [cases, setCases] = useState([]), [caseId, setCaseId] = useState(''), [doc, setDoc] = useState(null), [baseline, setBaseline] = useState(null);
  const [review, setReview] = useState(null), [status, setStatus] = useState({});
  // Playbooks (Phase 7): the library's list, each playbook as loaded, the one the next review uses (chosen on the pane, or
  // inferred from the document: decision 184 took the picker out of the pane), and the one open on the Playbook page.
  const [playbookList, setPlaybookList] = useState([]), [books, setBooks] = useState({}), [pageBookId, setPageBookId] = useState('');
  const [choice, setChoice] = useState({ id: '', by: 'none', reason: '', suggestedId: null });
  const route = useRoute(); const page = route.page; const setPage = p => goTo(p);
  const [selected, setSelected] = useState(null), [showChanges, setShowChanges] = useState(true);
  const [busy, setBusy] = useState(''), [error, setError] = useState(null), [toast, setToast] = useState('');
  const [column, setColumn] = useState('agreement'); // browser document column: agreement | examples | held
  const [ruleDraft, setRuleDraft] = useState(null);
  // Ask C (17 Oct 2026): the document's questions and answers, oldest first ({ id, question, at, answer | error | stopped }),
  // the pane's tab, and the question being answered now with its steps ({ id, steps, startedAt }).
  const [asks, setAsks] = useState([]), [paneTab, setPaneTab] = useState('review'), [askProgress, setAskProgress] = useState(null);
  const askAbort = useRef(null);
  // The running review's request, for Stop (17 Oct 2026), and whether the last review was stopped (one plain line).
  const reviewAbort = useRef(null); const [reviewStopped, setReviewStopped] = useState(false);
  const [outcomes, setOutcomes] = useState({}), [applied, setApplied] = useState({});
  // The store (task 8): the open document as the store holds it ({ id, title, counterparty, type }), found by its bytes
  // or added to the Inbox when the pane opens it; null when the store is unavailable or the document is an example.
  const [storeDoc, setStoreDoc] = useState(null);
  // Save as our reply (decision 185 on the store): the document saved, once every point is handled.
  const [saved, setSaved] = useState(null);
  // Kept while the same review is open (a reopened pane brings it back with the session), so it is not saved twice.
  useEffect(() => { setSaved(s => (s && s.reviewId === review?.id ? s : null)); }, [review]);
  // The review's own document in the store: its events go to that document's review history.
  const [reviewCtx, setReviewCtx] = useState(null);
  const [inboxCount, setInboxCount] = useState(0), [clauseTypes, setClauseTypes] = useState(null), [unsent, setUnsent] = useState(null);
  const unsentRef = useRef(null), fileRef = useRef(null);
  // Pane additions (product v2, slice S5): the document's comment threads (undefined until read; null when this Word has
  // no comment API) and the record's playbook list.
  const [comments, setComments] = useState(undefined);
  const [playbookMeta, setPlaybookMeta] = useState([]);
  // Team mode (slice S7): who is signed in, whether an admin signed this computer out, whether the team server can be
  // reached, and the version banner (7.11). Read on start and on every page change; one line at the top when it matters.
  const [team, setTeam] = useState(null);
  const refreshTeam = () => api('/api/v2/local/team').then(setTeam).catch(() => {});
  const actorName = useActors(api, team?.user?.userId || team?.mode || null);
  const outcomesRef = useRef({}); 
  const [prior, setPrior] = useState({}); // the lawyer's actions in earlier passes of this session, by paragraph id
  const [reviewMode, setReviewMode] = useState('own-paper');
  const [playbookDraft, setPlaybookDraft] = useState(null);
  const [word, setWord] = useState(false), [wordChanged, setWordChanged] = useState(false);
  const [narrowView, setNarrowView] = useState('review');
  // At narrow widths the sidebar is a row that scrolls sideways; a fade on its right edge says there is more, gone at
  // the end (UX taste call 4). Desktop has no overflow, so no fade.
  const sideRef = useRef(null);
  useEffect(() => {
    const el = sideRef.current; if (!el) return undefined;
    const update = () => { el.dataset.more = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 2); };
    update(); el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null; ro?.observe(el); const items = el.querySelector('.topnav'); if (items) ro?.observe(items);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, []);
  const uploadRef = useRef(), baselineRef = useRef(), reviewRequest = useRef(0);
  const sample = cases.find(c => c.id === caseId);
  const playbook = choice.id ? books[choice.id] || null : null; // the playbook the next review will use
  const pageBook = books[pageBookId || choice.id || playbookList[0]?.id] || null; // the playbook open on the Playbook page
  // "Playbook changed since review" compares the review with the current version of the same playbook.
  const reviewBook = review?.playbook?.id ? books[review.playbook.id] : null;
  // PR-PANE-07: the playbook moved on since this review, here or on another computer (the record's change counter).
  const recordChange = review?.playbook?.id ? playbookMeta.find(p => p.id === review.playbook.id)?.changeCount : null;
  const stale = !review ? false : (reviewBook && review.playbookVersion !== reviewBook.version) || (Number.isInteger(recordChange) && Number.isInteger(review.playbookVersion) && recordChange > review.playbookVersion) ? 'playbook' : (review.documentId !== doc?.id || review.documentRevision !== doc?.revision) ? 'document' : false;
  const alignment = useMemo(() => doc ? alignDocument(doc, baseline) : { paragraphs: [], deleted: [], limits: [] }, [doc, baseline]);
  // What the counterparty changed is measured on the document as reviewed, before any change applied from the pane.
  const reviewedAlignment = useMemo(() => !doc || !Object.keys(applied).length ? alignment : alignDocument({ ...doc, paragraphs: doc.paragraphs.map(p => applied[p.id] !== undefined ? { ...p, text: applied[p.id] } : p) }, baseline), [alignment, applied]);
  const findings = review?.findings || [];
  const active = findings.find(f => f.id === selected);
  outcomesRef.current = outcomes;
  // In place of "Last time" (task 8): one suggested question when the document has a counterparty.
  const suggestions = [...(storeDoc?.counterparty ? [`What did we accept from ${storeDoc.counterparty} before?`] : []), 'What did they change in this draft?', 'Summarise the key terms'];
  // Header D: the playbook the review used, else the one the next review will use.
  const headerBook = review?.playbook || playbookList.find(b => b.id === choice.id) || null;
  const playbookLabel = headerBook ? `${headerBook.title}${Number.isInteger(headerBook.version) ? ` v${headerBook.version}` : ''}` : null;

  useEffect(() => {
    Promise.all([api('/api/cases'), api('/api/playbooks'), api('/api/status')]).then(([list, pbs, s]) => {
      setCases(list); setPlaybookList(pbs); setStatus(s); setDiagnostics(s.diagnostics); refreshInbox(); refreshPlaybookMeta();
      const initial = list.find(c => c.id.includes('duration')) || list[1] || list[0];
      if (initial && !isWordPane) openCase(initial);
      if (isWordPane) initializeWord().then(() => setWord(detectWord())).catch(e => setError({ name: 'word', message: e.message }));
    }).catch(e => setError({ name: 'load', message: e.message, code: e.code }));
  }, []);
  useEffect(() => { refreshTeam(); }, [page]);
  // Word: read the open document when the pane connects and look it up in the record (7.1 steps 1 and 2).
  useEffect(() => { if (word) openWordDocument(); }, [word]);
  // The selection in Word (17 Oct 2026): shown as a chip above the ask bar and sent with the question; an empty selection clears it.
  const [wordSelection, setWordSelection] = useState(null);
  useEffect(() => (word ? watchWordSelection(s => setWordSelection(s?.text?.trim() ? s : null)) : undefined), [word]);
  useEffect(() => { if (toast) { const id = setTimeout(() => setToast(''), 4500); return () => clearTimeout(id); } }, [toast]);
  useEffect(() => { if (choice.id && !books[choice.id]) loadBook(choice.id); }, [choice.id]);
  useEffect(() => { const id = pageBookId || choice.id || playbookList[0]?.id; if (page === 'playbook' && id && !books[id]) loadBook(id); }, [page, pageBookId, choice.id, playbookList]);
  // #/playbook/<id> opens that playbook; the Playbook page reads the change counter afresh (another member may have saved).
  useEffect(() => { if (page === 'playbook') { if (route.id) setPageBookId(route.id); refreshPlaybookMeta(); } }, [page, route.id]);
  // A playbook another member saved since it was loaded is read again before anyone edits it.
  useEffect(() => { if (page !== 'playbook' || !pageBook || ruleDraft) return; const m = playbookMeta.find(p => p.id === pageBook.id); if (m && Number.isInteger(m.changeCount) && m.changeCount !== (pageBook.changeCount ?? pageBook.version)) loadBook(pageBook.id); }, [page, playbookMeta, pageBook]);
  // A page opens at its top.
  useEffect(() => { document.querySelector('.page')?.scrollTo?.(0, 0); }, [page, route.id]);
  useEffect(() => { if (page === 'review' || page === 'inbox') refreshInbox(); if (page === 'review') refreshPlaybookMeta(); }, [page]);
  // Back on Review, the open document's store line is read again (stress audit): labels changed on its Document page show,
  // and a document moved to the trash there is no longer offered (its page would say "Document not found.").
  useEffect(() => { if (page !== 'review' || !storeDoc?.id) return; const id = storeDoc.id; api(`/api/v2/store/documents/${encodeURIComponent(id)}`).then(d => setStoreDoc(s => (s?.id === id ? storeRef(d) : s))).catch(e => { if (e.status === 404) setStoreDoc(s => (s?.id === id ? null : s)); }); }, [page]);
  // The playbook may change on another computer: its change counter is read again whenever the pane gets focus.
  useEffect(() => { window.addEventListener('focus', refreshPlaybookMeta); return () => window.removeEventListener('focus', refreshPlaybookMeta); }, []);
  // The playbook is inferred from the document (decision 184); the lawyer may change it on the pane's playbook line.
  useEffect(() => { if (!choice.id && doc && playbookList.length) { const id = inferPlaybook(playbookList, doc); if (id) setChoice({ id, by: 'inferred', reason: '', suggestedId: null }); } }, [doc, playbookList, choice.id]);
  // Word: notice when the document changes under the review (R6.6).
  useEffect(() => {
    if (!word || !review || !doc) return;
    const check = async () => {
      try {
        const texts = await readWordTexts(); const expected = doc.wordTexts ? doc.wordTexts.map((t, i) => { const p = doc.paragraphs.find(x => wordIndexOf(doc, x.id) === i); return p ? p.text : t; }) : doc.paragraphs.map(p => p.text);
        const differs = JSON.stringify(texts) !== JSON.stringify(expected);
        // PR-PANE-06 (U1, U2): a change undone (Cmd+Z / Ctrl+Z) or rejected in Word reopens its point on the next read.
        if (differs && await reopenUndone(texts)) return;
        setWordChanged(differs);
      } catch { /* pane detached */ }
    };
    window.addEventListener('focus', check); const timer = setInterval(check, 20000); check();
    return () => { window.removeEventListener('focus', check); clearInterval(timer); };
  }, [word, review, doc]);
  useEffect(() => { if (!review) setWordChanged(false); }, [review]);

  // Word: keep the review and the lawyer's decisions for this document on the server, so closing or reloading the pane
  // does not lose them (decision 134). Saved a moment after each change; nothing is written into the document.
  useEffect(() => {
    // The questions asked go with it (Ask C), and before any review they are kept on their own.
    const kept = asks.filter(a => a.answer || a.error || a.stopped).slice(-30);
    if (!word || !doc || (!review && !kept.length)) return;
    const key = wordDocumentKey(); if (!key) return;
    const state = review ? { doc: { ...doc, wordTexts: undefined }, baseline, review, outcomes, applied, prior, selected, choice, storeDoc, reviewCtx, reviewMode, saved, book: books[review.playbook?.id] || null, asks: kept } : { asks: kept };
    const timer = setTimeout(() => { fetch('/api/pane-session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, state }) }).catch(() => {}); }, 300);
    return () => clearTimeout(timer);
  }, [word, review, doc, baseline, outcomes, applied, prior, selected, storeDoc, saved, asks]);

  async function loadBook(id) {
    try { const pb = await api(`/api/playbook?id=${encodeURIComponent(id)}`); setBooks(b => ({ ...b, [id]: pb })); return pb; } catch (e) { setError({ name: 'load', message: e.message, code: e.code }); return null; }
  }
  /** A new document starts with no playbook: the document's own words choose it. */
  const clearChoice = () => setChoice({ id: '', by: 'none', reason: '', suggestedId: null });

  function openCase(c) {
    clearChoice(); setStoreDoc(null); fileRef.current = null;
    reviewRequest.current++; setCaseId(c.id); setDoc(clone(c.document)); setBaseline(c.baseline ? clone(c.baseline) : null); setReview(null); setSelected(null);
    setOutcomes({}); setApplied({}); stopAsk(); setAsks([]); setPaneTab('review'); setError(null); setColumn('agreement'); setReviewMode('own-paper');
  }
  /**
   * Save as our reply (decision 185 on the store): strip the pane's hidden bookmarks (W7), read the document from Word and
   * add it to the store as a new document with the reviewed document's counterparty and type, out of the Inbox, titled
   * "<its title> (our reply)". No question and no round: the store keeps every file as its own document.
   */
  async function saveReply() {
    if (!word) return;
    await act('record', async () => {
      await cleanOutgoing();
      // The bookmarks are gone but the changes stay: an applied point must not read as "rejected in Word" from now on.
      setOutcomes(o => Object.fromEntries(Object.entries(o).map(([id, x]) => [id, x.kind === 'applied' ? { ...x, bookmark: null, bookmarks: [] } : x])));
      const file = await currentWordFile(doc?.fileName);
      const form = new FormData(); form.append('file', file);
      if (storeDoc?.id) form.append('sourceId', String(storeDoc.id));
      const r = await api('/api/v2/store/pane/save', { method: 'POST', body: form });
      // The pane's own line says "Saved to Library · Open"; no toast repeats it (UX audit, 17 Oct 2026).
      setSaved({ id: r.document.id, title: r.document.title, reviewId: review?.id || null });
    });
  }
  async function act(name, fn) { setBusy(name); setError(null); try { return await fn(); } catch (e) { setError({ name, message: plainError(e), code: e.code || null }); return undefined; } finally { setBusy(''); } }

  // ---- the record ------------------------------------------------------------------------------------------------
  // The Inbox count is the store's: documents tagged "inbox" (plan task 4).
  function refreshInbox() { api('/api/v2/store/inbox?count=1').then(r => setInboxCount(r.count || 0)).catch(() => setInboxCount(0)); }
  async function clauseTypeFile() { if (clauseTypes) return clauseTypes; try { const t = await api('/api/v2/clause-types'); setClauseTypes(t); return t; } catch { return null; } }
  /**
   * The review's events go to the document's review history in our SQLite (task 8; 7.4 step 6), keyed by its store id.
   * A batch refused is kept in memory and sent again, ahead of the next one, on the next pane action or on Retry; it is
   * lost if the pane closes.
   */
  async function postEvents(documentId, events) {
    const held = unsentRef.current?.documentId === documentId ? unsentRef.current.events : [];
    const batch = [...held, ...events.filter(Boolean)];
    if (!documentId || !batch.length) return;
    try { await post(`/api/v2/store/documents/${encodeURIComponent(documentId)}/review-events`, { events: batch }); unsentRef.current = null; setUnsent(null); }
    catch { unsentRef.current = { documentId, events: batch }; setUnsent(unsentRef.current); }
  }
  function recordDecision(kind, f, data = {}) {
    if (!reviewCtx?.documentId) return; // a review of a document the store does not hold writes nothing
    postEvents(reviewCtx.documentId, [decisionEvent(kind, { review, finding: f, clauseTypes, ...data })]);
  }
  function refreshPlaybookMeta() { api('/api/v2/playbooks').then(list => setPlaybookMeta(Array.isArray(list) ? list : [])).catch(() => {}); }
  const storeRef = d => ({ id: d.id, title: d.title, counterparty: d.counterparty || null, type: d.type || null });
  /**
   * The open document in the store (task 8): found by its bytes (or its paragraphs' content key), else, for a Word
   * document, added to the Inbox with the counterparty matching suggests. Nothing is asked before the review. A file
   * opened in the browser is only looked up.
   */
  async function identify(file, source) {
    fileRef.current = file || null; setStoreDoc(null);
    if (!file) return;
    try {
      const form = new FormData(); form.append('file', file);
      if (source !== 'pane') form.append('add', 'false');
      const r = await api('/api/v2/store/pane/open', { method: 'POST', body: form });
      if (r.document) setStoreDoc(storeRef(r.document));
      if (r.document && !r.found) refreshInbox();
    } catch { /* the store is unavailable: the review runs without it */ }
  }
  /** The store document holding `file`, looked up only (never added): null for none, undefined when the store cannot say. */
  async function lookUp(file) {
    if (!file) return undefined;
    try { const form = new FormData(); form.append('file', file); form.append('add', 'false'); return (await api('/api/v2/store/pane/open', { method: 'POST', body: form })).document || null; } catch { return undefined; }
  }
  function select(f) {
    if (!f) { setSelected(null); clearMark(); return; } // every point done: nothing open, nothing marked
    if (f.id !== selected) setError(null); // an action's message belongs to the point it was about
    setSelected(f.id);
    if (word && !f.deleted && f.anchored !== false) { const quote = passageFor(f); if (quote) markPassage(quote, wordIndexOf(doc, f.paragraphId)); }
  }
  function openEvidence(e, f) {
    if (word && !e.source && e.verified !== false) { markPassage(e.quote, wordIndexOf(doc, e.paragraphId)); return; }
    setColumn('agreement'); setNarrowView('agreement');
    const el = document.getElementById(`${e.source === 'baseline' ? 'baseline' : 'paragraph'}-${e.paragraphId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (f) setSelected(f.id);
    else if (el) { el.classList.add('para--flash'); setTimeout(() => el.classList.remove('para--flash'), 1600); } // Ask's ¶ chip: the passage lights briefly
  }

  /** The review: the draft against the playbook; its events go to the document's review history in the store. */
  async function runReview() {
    if (!choice.id) return; // never review against a guess: with no playbook chosen, Review waits
    const request = ++reviewRequest.current;
    setReviewStopped(false);
    const controller = new AbortController(); reviewAbort.current = controller;
    // Stop: the request is cancelled, the server ends the model call, and nothing of the review is applied.
    const stop = () => { if (!controller.signal.aborted) return false; setReviewStopped(true); return true; };
    await act('review', async () => {
      const current = word ? await readWordDocument() : doc;
      if (word) setDoc(current);
      // What the lawyer did in the review being replaced, by clause. It is shown beside the new findings (R6.7), and our own
      // applied changes are named to the model: on a rerun in Word (5 Oct 2026) it took our reply for the counterparty's move.
      const before = { ...prior }; for (const f of findings) { const o = outcomes[f.id]; if (o) before[f.paragraphId] = { kind: o.kind, at: o.at, note: o.note || null, option: o.option || null, before: o.before || null, text: o.text || null, title: f.title }; }
      const ours = Object.entries(before).filter(([, o]) => o.kind === 'applied' && o.before && o.text);
      const context = [...(ours.length ? [{ name: 'our-own-applied-changes (tracked changes the reviewing lawyer made through this tool in an earlier pass; they are our reply, not the counterparty\'s changes)', text: ours.map(([id, o]) => `Paragraph ${id}: we changed "${o.before}" to "${o.text}"`).join('\n').slice(0, 8000) }] : [])];
      const ctx = storeDoc ? { documentId: storeDoc.id } : null;
      // The store tools (plan task 10): with the document in the store the review reads the counterparty's other documents.
      if (stop()) return;
      let result;
      try { result = await post('/api/review', { document: current, baseline, context: context.length ? context : null, reviewMode, playbookId: choice.id, ...(ctx ? { storeDocumentId: ctx.documentId } : {}) }, { signal: controller.signal }); }
      catch (e) { if (stop()) return; throw e; }
      finally { if (reviewAbort.current === controller) reviewAbort.current = null; }
      if (stop() || request !== reviewRequest.current) return;
      // Comment threads are read when the review arrives (7.7 step 1) and matched to points by paragraph.
      if (word) setComments(await readComments().catch(() => undefined));
      setBooks(b => ({ ...b, [result.playbook.id]: result.playbookSnapshot }));
      setPrior(before); setReview(result); setReviewCtx(ctx); setOutcomes({}); setApplied({}); setPaneTab('review');
      // The pane is the one writer of review events (7.4 step 6): review_run and the flagged findings, in one batch.
      if (ctx) postEvents(ctx.documentId, reviewBatch(result, { round: null, reviewMode, clauseTypes: await clauseTypeFile() }));
      const first = worstFirst(result.findings)[0];
      setSelected(first?.id || null);
      if (word && first) { const quote = passageFor(first); if (quote) markPassage(quote, wordIndexOf(current, first.paragraphId)); }
      setPage('review'); setNarrowView('review');
    });
  }
  /**
   * Dismiss has no note field in the pane (decision 184) but asks why in one tap (audit finding 1): 'not-an-issue' (the
   * model was wrong; never a position) or 'accepted' (we accept their wording; the record's concession).
   */
  function dismiss(f, reason) { const why = ['not-an-issue', 'accepted'].includes(reason) ? reason : null; setOutcomes(o => ({ ...o, [f.id]: { at: now(), kind: 'dismissed', note: '', reason: why } })); recordDecision('dismissed', f, { note: '', reason: why }); }
  /**
   * Place one finding's wording in its paragraph (Word: tracked, verified; browser: checked). Returns { warning, bookmark,
   * at, changes }: `changes` is what Undo needs to reject exactly these tracked changes ({ bookmark, inserted, deleted }).
   */
  async function placeReplacement(f, p, text) {
    if (word) {
      // R6.5: the document may have changed elsewhere; apply only if this paragraph's wording is still there exactly once.
      const texts = await readWordTexts(); const mapped = wordIndexOf(doc, p.id);
      const hits = texts.map((t, i) => [t, i]).filter(([t]) => t === p.text).map(([, i]) => i);
      const at = mapped !== null && texts[mapped] === p.text ? mapped : hits.length === 1 ? hits[0] : null;
      if (at === null) throw Error(hits.length ? 'That wording appears more than once in the document; apply it in Word by hand.' : 'That passage could not be located in the document; it may have been edited.');
      const edits = text ? minimalEdits(p.text, text) : []; if (text && !edits.length) throw Error('That wording is already in the document.');
      let result = null, done = 0; const changes = []; // one tracked change per place that differs, last place first
      // Empty wording deletes the clause (audit item 8): one tracked deletion of its whole text.
      if (!text) result = await applyWordDeletion({ quote: p.text, paragraphIndex: at });
      else try { for (const edit of edits) { result = await applyWordReplacement({ findingId: f.id, quote: edit.context, replacement: edit.contextReplacement, inner: edit.inner, innerReplacement: edit.innerReplacement, insertAfter: edit.insertAfter || null, paragraphIndex: at }); done++; if (result.bookmark) changes.push({ bookmark: result.bookmark, inserted: result.inserted, deleted: result.deleted || '' }); } }
      catch (e) { if (done) throw Error(`${done} of ${edits.length} changes in this clause were applied before one could not be placed (${plainError(e)}) Check the clause in Word.`); throw e; }
      return { warning: result.warning || null, bookmark: result.bookmark || null, at, changes };
    }
    if (p.editable === false) throw Error('This passage already contains tracked changes or complex Word content. Copy the wording and resolve it in Word.');
    return { warning: null, bookmark: null, at: null, changes: [] };
  }
  /** The pane's own view of a paragraph after its wording was applied (the Word index of the paragraph does not change). */
  function noteApplied(p, text) {
    const nextRevision = doc.revision + 1;
    setApplied(a => ({ ...a, [p.id]: a[p.id] ?? p.text }));
    setDoc(d => ({ ...d, revision: nextRevision, paragraphs: d.paragraphs.map(x => x.id === p.id ? { ...x, originalText: x.originalText ?? x.text, text } : x) }));
    setReview(r => ({ ...r, documentRevision: nextRevision })); // our own change does not make the review stale
  }
  /**
   * After an applied change is verified, reply in the comment thread on that paragraph (7.7): text composed by code,
   * posted under the lawyer's name, written to the record as comment_replied. Returns the line the Applied state shows
   * when no reply could be posted, else null.
   */
  async function replyInThread(f, before, after, at) {
    if (!word || comments === undefined) return null;
    if (comments === null) return 'Reply not posted: Word version';
    const thread = threadFor(comments, at); if (!thread) return null;
    const text = commentReplyText(before, after); // no playbook or rule id: the counterparty reads it (audit finding 9)
    try { await replyToComment(thread.id, text); } catch { return 'Reply failed'; }
    recordDecision('replied', f, { commentId: thread.id, text });
    return null;
  }
  async function applyFinding(f, text, option) {
    return act('apply', async () => {
      const p = doc.paragraphs.find(x => x.id === f.paragraphId);
      if (!p) throw Error('That passage could not be located in the document; it may have been edited.');
      const { warning, bookmark, at, changes } = await placeReplacement(f, p, text);
      recordDecision('applied', f, { before: p.text, after: text, bookmark, overRevisions: typeof p.originalText === 'string' && p.originalText !== p.text });
      noteApplied(p, text);
      const reply = await replyInThread(f, p.text, text, at);
      setOutcomes(o => ({ ...o, [f.id]: { kind: 'applied', at: now(), text, before: p.text, option, warning, reply, paragraphId: p.id, bookmark, bookmarks: changes.map(c => c.bookmark), changes, count: Math.max(1, minimalEdits(p.text, text).length) } }));
      return true;
    });
  }
  /**
   * Bulk application (7.8, PR-PANE-05): the edits one point's reply makes, confirmed on the card, applied one by one
   * through the Word queue in document order, stopping at the first failure. Each success writes edit_applied.
   * Returns { results: [{ key, ok, error }] } for the card.
   */
  async function applyEdits(f, rows, option) {
    const results = rows.map(r => ({ key: r.key, ok: false, error: null }));
    await act('apply', async () => {
      const p = doc.paragraphs.find(x => x.id === f.paragraphId);
      let replaced = null, failure = null, warning = null; const inserted = [], changes = [];
      for (const [i, row] of rows.entries()) {
        try {
          if (row.kind === 'replace') {
            if (!p) throw Error('That passage could not be located in the document; it may have been edited.');
            const r = await placeReplacement(f, p, row.after);
            recordDecision('applied', f, { before: p.text, after: row.after, bookmark: r.bookmark, overRevisions: typeof p.originalText === 'string' && p.originalText !== p.text });
            replaced = { before: p.text, after: row.after, bookmark: r.bookmark, at: r.at }; changes.push(...r.changes);
            warning ||= r.warning;
          } else {
            if (!word) throw Error('A new paragraph is added in Word.');
            const anchor = doc.paragraphs.find(x => x.id === row.paragraphId);
            const anchorText = replaced && row.paragraphId === f.paragraphId ? replaced.after : anchor?.text;
            const r = await applyWordInsertion({ anchorText, paragraphIndex: wordIndexOf(doc, row.paragraphId), text: row.after });
            recordDecision('applied', f, { paragraphId: row.paragraphId, before: '', after: row.after, bookmark: r.bookmark });
            inserted.push({ text: row.after, bookmark: r.bookmark }); if (r.bookmark) changes.push({ bookmark: r.bookmark, inserted: r.inserted ?? row.after, deleted: '' });
            warning ||= r.warning;
          }
          results[i].ok = true;
        } catch (e) { results[i].error = plainError(e); failure = plainError(e); break; }
      }
      const done = results.filter(r => r.ok).length;
      if (!done) throw Error(failure || 'Nothing was applied.');
      if (replaced) noteApplied(p, replaced.after);
      if (word) { const texts = await readWordTexts(); setDoc(d => ({ ...d, wordTexts: texts, wordIndex: alignParagraphs(d.paragraphs, texts).index })); }
      const reply = await replyInThread(f, replaced ? replaced.before : '', replaced ? replaced.after : inserted[0].text, replaced?.at ?? wordIndexOf(doc, f.paragraphId));
      const bookmarks = changes.length ? changes.map(c => c.bookmark) : [replaced?.bookmark, ...inserted.map(x => x.bookmark)].filter(Boolean);
      setOutcomes(o => ({ ...o, [f.id]: { kind: 'applied', at: now(), text: replaced ? replaced.after : null, before: replaced ? replaced.before : null, added: inserted.map(x => x.text), option, reply, paragraphId: f.paragraphId, bookmark: bookmarks[0] || null, bookmarks, changes, count: done,
        warning: failure ? `${done} of ${rows.length} changes were applied before one could not be placed (${failure}) Check the document in Word.` : warning } }));
    });
    return { results };
  }
  /**
   * A change the pane applied whose every bookmark is gone or empty was undone or rejected in Word (decision 134,
   * PR-PANE-06): its point opens again, the paragraph reads as before, and the record says the edit was rejected.
   * Returns true when any point reopened.
   */
  async function reopenUndone(texts) {
    const gone = [];
    for (const [id, o] of Object.entries(outcomesRef.current || {})) {
      if (o.kind !== 'applied') continue;
      const marks = (o.bookmarks?.length ? o.bookmarks : [o.bookmark]).filter(Boolean); if (!marks.length) continue;
      const states = await Promise.all(marks.map(b => appliedChangeState(b).catch(() => 'unknown')));
      if (states.every(x => x === 'gone')) gone.push([id, o]);
    }
    if (!gone.length) return false;
    setOutcomes(x => { const n = { ...x }; for (const [id] of gone) delete n[id]; return n; });
    setApplied(a => { const n = { ...a }; for (const [, o] of gone) if (o.paragraphId && typeof o.before === 'string') delete n[o.paragraphId]; return n; });
    setDoc(d => { const paragraphs = d.paragraphs.map(p => { const g = gone.find(([, o]) => o.paragraphId === p.id && typeof o.before === 'string'); return g ? { ...p, text: g[1].before } : p; }); return { ...d, paragraphs, wordTexts: texts, wordIndex: alignParagraphs(paragraphs, texts).index }; });
    for (const [id, o] of gone) {
      const f = review?.findings.find(x => x.id === id); if (f) recordDecision('rejected', f, { bookmark: o.bookmark });
    }
    setWordChanged(false);
    return true;
  }
  /**
   * Undo a finished point. A dismissal comes back (and an accepted wording's note leaves the document in the store). An
   * applied change in Word is rejected through Word (undoWordChange: exactly the pane's own tracked changes for the
   * point, all or none); when that cannot be done safely the point stays applied and the message says to undo it in
   * Word. Afterwards the point is open with Apply offered, as after Cmd+Z, and the record has edit_rejected_in_word.
   */
  async function undo(f) {
    const o = outcomes[f.id]; if (!o) return;
    const ok = await act('undo', async () => {
      if (o.kind === 'applied' && word) {
        await undoWordChange({ changes: o.changes || [] });
        const texts = await readWordTexts().catch(() => null);
        setApplied(a => { const n = { ...a }; if (typeof o.before === 'string') delete n[o.paragraphId]; return n; });
        setDoc(d => { const paragraphs = d.paragraphs.map(p => p.id === o.paragraphId && typeof o.before === 'string' ? { ...p, text: o.before } : p); return texts ? { ...d, paragraphs, wordTexts: texts, wordIndex: alignParagraphs(paragraphs, texts).index } : { ...d, paragraphs }; });
        recordDecision('rejected', f, { bookmark: o.bookmark });
      } else if (o.kind === 'applied') {
        const nextRevision = doc.revision + 1;
        setDoc(d => ({ ...d, revision: nextRevision, paragraphs: d.paragraphs.map(x => x.id === o.paragraphId ? { ...x, text: o.before } : x) }));
        setReview(r => ({ ...r, documentRevision: nextRevision }));
        setApplied(a => { const n = { ...a }; delete n[o.paragraphId]; return n; });
      }
      if (o.kind === 'dismissed') recordDecision('undismissed', f);
      setOutcomes(x => { const n = { ...x }; delete n[f.id]; return n; });
      return true;
    });
    if (ok) select(f);
  }
  async function openWordDocument() {
    await act('open', async () => {
      const current = await readWordDocument();
      const key = wordDocumentKey(); const saved = key ? await api(`/api/pane-session?key=${encodeURIComponent(key)}`).catch(() => null) : null;
      // The saved review may be another document's: a new version saved over the old file keeps the URL (stress audit).
      const other = saved?.state?.review && saved.state.doc && !sessionIsFor(saved.state, current.wordTexts || current.paragraphs.map(p => p.text), await lookUp(wordFile()));
      if (saved?.state?.review && saved.state.doc && !other) return restoreSession(saved.state, current, saved.savedAt);
      setDoc(current);
      setAsks(!other && Array.isArray(saved?.state?.asks) ? saved.state.asks : []);
      clearChoice();
      await identify(wordFile(), 'pane');
    });
  }
  /**
   * Bring back the review this pane had open on this document (decision 134). The record is checked against the
   * document before it is believed: a change applied from the pane whose bookmark is gone or empty was rejected or
   * deleted in Word, so its point is open again and the activity says so. Paragraphs are lined up with Word afresh.
   */
  async function restoreSession(state, current, savedAt) {
    let restoredDoc = state.doc; const outcomesNow = { ...state.outcomes }; const appliedNow = { ...state.applied }; const notes = [];
    for (const [id, o] of Object.entries(state.outcomes || {})) {
      const marks = o.kind === 'applied' ? (o.bookmarks?.length ? o.bookmarks : [o.bookmark]).filter(Boolean) : [];
      if (!marks.length) continue;
      if (!(await Promise.all(marks.map(b => appliedChangeState(b).catch(() => 'unknown')))).every(x => x === 'gone')) continue;
      delete outcomesNow[id]; if (typeof o.before === 'string') delete appliedNow[o.paragraphId];
      if (typeof o.before === 'string') restoredDoc = { ...restoredDoc, paragraphs: restoredDoc.paragraphs.map(p => p.id === o.paragraphId ? { ...p, text: o.before } : p) };
      notes.push({ capturedAt: now(), type: 'edit_rejected_in_word', findingId: id, paragraphId: o.paragraphId, bookmark: o.bookmark });
    }
    const aligned = alignParagraphs(restoredDoc.paragraphs, current.wordTexts || []);
    setDoc({ ...restoredDoc, wordTexts: current.wordTexts, wordIndex: aligned.index });
    setBaseline(state.baseline || null); setReview(state.review); setOutcomes(outcomesNow); setApplied(appliedNow); setPrior(state.prior || {});
    setSelected(state.selected || null); setChoice(state.choice || { id: '', by: 'none', reason: '', suggestedId: null });
    if (state.book) setBooks(b => ({ ...b, [state.book.id]: state.book }));
    setStoreDoc(state.storeDoc || null); setReviewCtx(state.reviewCtx?.documentId ? state.reviewCtx : null);
    setReviewMode(state.reviewMode || 'own-paper'); setSaved(state.saved || null);
    setAsks(Array.isArray(state.asks) ? state.asks : []);
    fileRef.current = wordFile();
    // The comment threads are read again rather than kept with the session.
    setComments(await readComments().catch(() => undefined));
    // A change rejected in Word while the pane was closed is a review event of the review it belongs to (decision 134).
    if (state.reviewCtx?.documentId && notes.length) postEvents(state.reviewCtx.documentId, notes.map(n => decisionEvent('rejected', { review: state.review, finding: state.review.findings.find(x => x.id === n.findingId), bookmark: n.bookmark })));
    setPage('review'); setNarrowView('review'); setToast(`Review restored · ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  }
  /** Open a .docx in the browser (or set it as the comparison version); a document the store holds is looked up. */
  async function importFile(file, asBaseline = false) {
    if (!file) return;
    await act('import', async () => {
      const form = new FormData(); form.append('file', file);
      const imported = await api('/api/documents/import', { method: 'POST', body: form });
      reviewRequest.current++;
      if (asBaseline) { setBaseline(imported); setReview(null); setReviewMode('own-paper'); return; }
      setDoc(imported); setBaseline(null); setCaseId(''); setReview(null); setOutcomes({}); setApplied({}); setSelected(null); stopAsk(); setAsks([]); setPaneTab('review'); setColumn('agreement');
      clearChoice();
      await identify(file, 'upload');
    });
  }
  async function importPlaybook(file) {
    if (!file) return;
    await act('import-playbook', async () => { const form = new FormData(); form.append('file', file); const r = await api('/api/playbook/import', { method: 'POST', body: form }); setPlaybookDraft(r.draft); setRuleDraft(null); });
  }
  const listed = saved => setPlaybookList(l => l.some(p => p.id === saved.id) ? l.map(p => p.id === saved.id ? { ...p, title: saved.title, version: saved.version, rules: saved.rules.length, appliesTo: saved.appliesTo } : p) : [...l, { id: saved.id, title: saved.title, version: saved.version, rules: saved.rules.length, appliesTo: saved.appliesTo }]);
  async function activateDraft() {
    if (!pageBook) return;
    await act('activate', async () => {
      const saved = await post(`/api/playbook/activate?id=${encodeURIComponent(pageBook.id)}`, { draft: playbookDraft, changeCount: pageBook.changeCount ?? pageBook.version });
      setPlaybookDraft(null); refreshPlaybookMeta();
      if (saved.proposal) { setToast('Change proposed'); return; } // not an owner: an owner accepts it (decision 178)
      setBooks(b => ({ ...b, [saved.id]: saved })); listed(saved); setToast(`${saved.title} v${saved.version} active`);
    });
  }
  /** P6: an imported draft becomes a new playbook with its own name and scope; the others are untouched. */
  async function createFromDraft({ title, appliesTo }) {
    await act('activate', async () => {
      const saved = await post('/api/playbooks', { title, appliesTo, draft: playbookDraft, origin: playbookDraft.origin || 'import' });
      setBooks(b => ({ ...b, [saved.id]: saved })); listed(saved); setPageBookId(saved.id); goTo('playbook', saved.id); setPlaybookDraft(null); refreshPlaybookMeta(); setToast(`${saved.title} v${saved.version} saved`);
    });
  }
  async function saveRule() {
    await act('save', async () => {
      if (!ruleDraft.title.trim() || !ruleDraft.guidance?.trim()) throw Error('Add a title and a position before saving.');
      const entry = ruleDraft;
      if (playbookDraft && playbookDraft.rules.some(r => r.id === entry.id)) { setPlaybookDraft({ ...playbookDraft, rules: playbookDraft.rules.map(r => r.id === entry.id ? entry : r) }); setRuleDraft(null); return; }
      const target = pageBook; if (!target) throw Error('That playbook is not loaded. Open it on the Playbook page and try again.');
      const rules = target.rules.some(r => r.id === entry.id) ? target.rules.map(r => r.id === entry.id ? entry : r) : [...target.rules, entry];
      const saved = await savePlaybook(target, rules);
      setRuleDraft(null); setToast(saved.proposal ? 'Change proposed' : `Saved · ${saved.title} v${saved.version}`);
    });
  }
  /**
   * One save of the shared playbook to the record (PR-PAGE-02): refused when someone else saved since it was read. A
   * member who does not own the playbook gets `{ proposal }` back: the playbook is unchanged until an owner accepts.
   */
  async function savePlaybook(target, rules) {
    const saved = await api(`/api/v2/playbooks/${encodeURIComponent(target.id)}`, { method: 'PUT', body: JSON.stringify({ changeCount: target.changeCount ?? target.version, rules }) });
    if (!saved.proposal) { setBooks(b => ({ ...b, [saved.id]: saved })); listed(saved); }
    refreshPlaybookMeta();
    return saved;
  }
  async function removeRule(id) {
    await act('save', async () => {
      const target = pageBook; if (!target) throw Error('That playbook is not loaded. Open it on the Playbook page and try again.');
      const saved = await savePlaybook(target, target.rules.filter(r => r.id !== id));
      setRuleDraft(null); setToast(saved.proposal ? 'Change proposed' : `Removed · ${saved.title} v${saved.version}`);
    });
  }
  /** A new playbook entry (Add entry on the Playbook page); the lawyer fills it in, then one explicit save. */
  function newRule() {
    setRuleDraft({ id: `RULE-${Date.now()}`, title: '', topic: 'custom', guidance: '', conditions: {}, fallback: '', enabled: true, sourceExample: '', sources: [] });
    setPage('playbook');
  }
  async function downloadDoc() {
    await act('export', async () => {
      const exportDocument = word ? await readWordDocument() : doc;
      const res = await fetch('/api/documents/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: exportDocument }) });
      if (!res.ok) throw Error((await res.json()).error);
      download(await res.blob(), `${(doc?.title || 'agreement').replace(/[^\w.-]+/g, '-')}-tracked.docx`);
    });
  }
  function download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  /**
   * Ask (Ask C): the question opens the Ask tab and joins the document's history; the server streams the steps as the
   * model takes them, then the answer (NDJSON). A server that answers with one JSON body is read as before. Stop
   * cancels the request, and the server ends the model call.
   */
  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    const id = `q${Date.now()}`;
    setPaneTab('ask'); setError(null);
    const sel = word && wordSelection ? wordSelection : null;
    setAsks(list => [...list, { id, question: q, at: now(), ...(sel ? { selection: selectionSnippet(sel.text, 80) } : {}) }]);
    setAskProgress({ id, steps: [], startedAt: Date.now() });
    const controller = new AbortController(); askAbort.current = controller;
    const settle = patch => setAsks(list => list.map(a => (a.id === id ? { ...a, ...patch } : a)));
    setBusy('ask');
    try {
      const current = word ? await readWordDocument() : doc;
      // A point that quotes an earlier version, or whose clause we have since changed, is not a passage to ask about; the question then goes to the agreement as a whole.
      // With the document in the store, the model reads the store through its tools (or gets the counterparty's documents).
      const body = { document: current, baseline, finding: stale || !active || active.deleted || active.evidence?.some(e => e.source) || applied[active.paragraphId] !== undefined ? null : active, question: q, playbookId: review?.playbook?.id || choice.id || undefined, ...(storeDoc?.id ? { storeDocumentId: storeDoc.id } : {}), stream: true, askId: newAskId() };
      const selection = sel ? selectionPayload(sel, current) : null;
      if (selection) body.selection = selection;
      const answer = await askStream(body, controller.signal, step => setAskProgress(p => { if (p?.id !== id) return p; const steps = mergeStep(p.steps, step); return steps === p.steps ? p : { ...p, steps }; }));
      settle({ answer });
    } catch (e) {
      if (controller.signal.aborted) settle({ stopped: true });
      else settle({ error: plainError(e) });
    } finally {
      if (askAbort.current === controller) askAbort.current = null;
      setAskProgress(p => (p?.id === id ? null : p)); setBusy(b => (b === 'ask' ? '' : b));
    }
  }
  function stopAsk() { askAbort.current?.abort(); }
  function stopReview() { reviewAbort.current?.abort(); }

  // A record error the team line already explains (signed out, team server unreachable) is not repeated beneath it.
  const explained = error && team?.mode === 'team' && ['key_revoked', 'unauthorized', 'record_unavailable', 'certificate_untrusted'].includes(error.code);
  const pageError = error && !explained && ['import-playbook', 'activate', 'save', 'history', 'export', 'import', 'load'].includes(error.name) ? error : null;
  const paneError = error && !pageError ? error : null;
  const phase = review ? 'review' : 'start';
  const docTitle = word ? (doc?.title || 'Current Word document') : doc?.title || 'No agreement open';
  const showAdmin = team && (team.mode !== 'team' || team.user?.admin);
  // Plan task 5: Library replaces Matters, Register and Search in the navigation.
  const nav = [['review', 'Review'], ['inbox', 'Inbox'], ['library', 'Library'], ['playbook', 'Playbook'], ['trash', 'Trash'], null, ['settings', 'Settings'], ...(showAdmin ? [['activity', 'Activity'], ['admin', 'Admin']] : []), ['about', 'About']];
  const navCurrent = item => page === item || (item === 'library' && page === 'documents');
  const isAdmin = !team || team.mode !== 'team' || !!team.user?.admin;
  // One line for the team state (7.10 step 4, 7.11, PR-TEAM-06); it never blocks work.
  const teamNote = !team || team.mode !== 'team' ? null
    : team.signedOut ? { text: 'Signed out by an admin', href: '#/settings/team', label: 'Settings' }
    : team.reachable === false ? { text: 'Record unavailable: the team server cannot be reached' }
    : !team.signedIn ? { text: 'Not signed in to the team server', href: '#/settings/team', label: 'Settings' }
    : team.banner ? { text: team.banner.text, href: team.banner.link, label: 'Release', external: true } : null;
  const teamLine = teamNote && <p className="teamline" role="status"><span>{teamNote.text}</span>{teamNote.href ? <a href={teamNote.href} {...(teamNote.external ? { target: '_blank', rel: 'noreferrer' } : {})}>{teamNote.label}</a> : null}</p>;
  // In team mode the store is reached through the team server: when the team line already says the server is out of reach
  // or this member is signed out, the store line would only repeat it (seen as two lines saying "Signed out by an admin", 17 Oct 2026).
  const storeLine = team?.mode === 'team' && (team.signedOut || team.reachable === false || !team.signedIn) ? null : <StoreLine api={api} page={page}/>;
  const goPage = (p, id = null) => { if (id) goTo(p, id); else setPage(p); if (p === 'playbook') setRuleDraft(r => r); };
  // One status line under the pane's header (7.4): a batch the record refused, or a review that did not read the record.
  const recordLine = unsent ? { text: 'Not recorded: the review history did not accept the events', action: 'Retry', onAction: () => postEvents(unsent.documentId, []) }
    : review?.storeUnavailable ? { text: 'Store unavailable: reviewed without it' } : null;

  const pane = <Pane surface={word || isWordPane ? 'word' : 'browser'} title={storeDoc?.title || plainName(docTitle)} phase={phase} review={review} storeDoc={storeDoc} onOpenDocument={id => goPage('documents', String(id))}
    outcomes={outcomes} selectedId={selected} onSelect={id => select(findings.find(f => f.id === id))} busy={busy} error={paneError}
    headingFor={f => clauseHeading(doc?.paragraphs || [], f.paragraphId)} recordLine={recordLine}
    canReview={(!!doc || word) && !!choice.id} onReview={() => runReview()} needsModel={status.liveAvailable === false}
    playbooks={playbookList} playbookId={choice.id} playbookBy={choice.by} onChoosePlaybook={id => setChoice({ id, by: 'lawyer', reason: '', suggestedId: null })}
    coverage={review ? coverageOf(review, { doc, rules: (books[review.playbook?.id] || review.playbookSnapshot)?.rules || [] }) : null}
    changeFor={f => { const p = reviewedAlignment.paragraphs.find(x => x.id === f.paragraphId); const del = reviewedAlignment.deleted.find(x => x.id === f.paragraphId); if (f.deleted && del) return { before: del.text, after: '' }; return { before: p?.comparisonText, after: p?.text }; }}
    onApply={applyFinding} onApplyEdits={applyEdits} onUndo={undo} onDismiss={dismiss} orderOf={id => doc?.paragraphs.findIndex(p => p.id === id) ?? 0}
    onOpenEvidence={openEvidence} stale={stale} wordChanged={wordChanged} onReviewAgain={() => runReview()} onStopReview={stopReview} reviewStopped={reviewStopped} onAsk={ask} onStop={stopAsk} selection={word && wordSelection ? selectionSnippet(wordSelection.text) : null} onClearSelection={() => setWordSelection(null)} asks={asks} progress={askProgress} suggestions={suggestions}
    tab={paneTab} onTab={setPaneTab} playbookLabel={playbookLabel}
    onSaveReply={word ? saveReply : null} saved={saved}/>;

  const pages = {
    inbox: <StoreInboxPage api={api} canHold={isAdmin} onToast={setToast} onChanged={() => { refreshInbox(); }}/>,
    library: <LibraryPage key={route.search} api={api} query={route.query}/>,
    documents: <DocumentPage key={route.id} api={api} id={route.id} canHold={isAdmin} onToast={setToast} onChanged={() => { refreshInbox(); }}/>,
    settings: <SettingsPage api={api} team={team} category={route.id} playbooks={playbookMeta} onTeamChange={() => { refreshTeam(); refreshInbox(); refreshPlaybookMeta(); api('/api/playbooks').then(setPlaybookList).catch(() => {}); }} onSaved={() => api('/api/status').then(setStatus).catch(() => {})}/>,
    admin: <AdminPage api={api} team={team}/>,
    trash: <StoreTrashPage api={api} onToast={setToast} onChanged={() => { refreshInbox(); }}/>,
    activity: <StoreActivityPage api={api}/>,
    playbook: <PlaybookPage api={api} team={team} onProposalDecided={() => { if (pageBook) loadBook(pageBook.id); refreshPlaybookMeta(); }} playbook={pageBook} playbooks={playbookList} meta={playbookMeta.find(p => p.id === pageBook?.id) || null} nameOf={actorName} onOpenPlaybook={id => { goTo('playbook', id); setRuleDraft(null); }} draft={playbookDraft} ruleDraft={ruleDraft} setRuleDraft={setRuleDraft} busy={busy}
      onImport={importPlaybook} onActivate={activateDraft} onCreate={createFromDraft} onDiscardDraft={() => setPlaybookDraft(null)} onSaveRule={saveRule} onRemoveRule={removeRule} onNewRule={newRule}/>,
    about: <AboutPage status={status} review={review}/>,
  };
  const pageErrorLine = pageError && <p className="page-error" role="alert"><span>{pageError.message}</span><button type="button" className="quiet" onClick={() => setError(null)}>Close</button></p>;
  const toastLine = toast && <div className="toast" role="status">{toast}</div>;

  if (isWordPane) {
    if (page !== 'review') return <div className="app app--word">
      <div className="backbar"><button type="button" className="quiet backbar__btn" onClick={() => setPage('review')}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>Review</button></div>
      {teamLine}{storeLine}{pageErrorLine}{pages[page]}{toastLine}
    </div>;
    return <div className="app app--word">{teamLine}{storeLine}{pane}{toastLine}</div>;
  }

  // The browser frame (redesign, 16 Oct 2026): a floating sidebar with the wordmark and quiet nav items beside the page.
  return <div className="app shell">
    <nav aria-label="Application" className="side" ref={sideRef}>
      <a className="wordmark" href="/">GinChugger</a>
      <div className="topnav">{nav.map((item, i) => item ? <a key={item[0]} href={item[0] === 'review' ? '#/' : `#/${item[0]}`} className="topnav__item" aria-current={navCurrent(item[0]) ? 'page' : undefined}>{item[1]}{item[0] === 'inbox' && inboxCount ? <span className="grey"> {inboxCount}</span> : null}</a> : <div key={`gap-${i}`} className="topnav__spacer"/>)}</div>
    </nav>
    <div className="main">
    {teamLine}{storeLine}{pageErrorLine}
    {page !== 'review' ? pages[page] : <div className={`workspace show-${narrowView}`}>
      <div className="narrow-switch" role="group" aria-label="View">
        {/* Document / Points (UX taste call 4): at a phone width the nav, the pane's tab and its button already say Review. */}
        <button type="button" aria-pressed={narrowView === 'agreement'} onClick={() => setNarrowView('agreement')}>Document</button>
        <button type="button" aria-pressed={narrowView === 'review'} onClick={() => setNarrowView('review')}>Points</button>
      </div>
      <section className="doccol" aria-label="Agreement">
        <div className="doccol__head">
          <span className="doccol__title" title={doc?.title}>{column === 'examples' ? 'Examples' : plainName(doc?.title) || 'No agreement open'}</span>
          {/* What a lawyer uses at this moment (decision 126): before a review, open a document or an example and set what it
              is compared with (the start card does that when a matter proposed it); during a review, the markup and the download. */}
          <div className="doccol__actions">
            {review ? <>
              <button type="button" className="quiet" aria-pressed={showChanges} onClick={() => setShowChanges(!showChanges)}>Markup</button>
              <button type="button" className="quiet" onClick={downloadDoc} disabled={!doc || !!busy}>Download</button>
            </> : <>
              <button type="button" className="quiet" aria-pressed={column === 'examples'} onClick={() => setColumn(column === 'examples' ? 'agreement' : 'examples')} disabled={!!busy}>Examples</button>
              <button type="button" className="quiet" onClick={() => uploadRef.current.click()} disabled={!!busy}>Open</button>
              {column !== 'examples' && <button type="button" className="quiet" onClick={() => baselineRef.current.click()} disabled={!!busy || !doc}>{baseline ? 'Change comparison' : 'Add comparison'}</button>}
              {baseline && column !== 'examples' && <button type="button" className="quiet" onClick={() => { setBaseline(null); setReview(null); }} disabled={!!busy}>Remove comparison</button>}
            </>}
          </div>
        </div>
        <input hidden ref={uploadRef} type="file" accept=".docx" onChange={e => { importFile(e.target.files[0]); e.target.value = ''; }}/>
        <input hidden ref={baselineRef} type="file" accept=".docx" onChange={e => { importFile(e.target.files[0], true); e.target.value = ''; }}/>
        <div className="doccol__scroll">
          {column === 'examples' ? <div className="paper paper--list">{cases.map(c => <button key={c.id} type="button" className="example" onClick={() => openCase(c)}><span className="strong">{c.title}</span><span className="meta grey">{c.subtitle}</span></button>)}</div>
            : <DocumentView doc={doc} alignment={alignment} findings={findings} applied={applied} markedId={active && !active.deleted ? active.paragraphId : null} showChanges={showChanges} onPick={f => { select(f); setNarrowView('review'); }} sample={sample}/>}
        </div>
      </section>
      <aside className="panecol" aria-label="Review">{pane}</aside>
    </div>}
    </div>
    {toastLine}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
