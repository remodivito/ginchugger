// SPDX-License-Identifier: GPL-3.0-or-later
// Ask's request from the pane (Ask C, 17 Oct 2026): the streamed answer with its steps, and the polling fallback for a
// webview that holds the stream back.
import { plainMessage } from '../../shared/plain-error.js';
/**
 * POST /api/ask with `stream: true`: each { type: 'step' } line goes to `onStep` as it arrives; the { type: 'answer' }
 * line is the result, { type: 'error' } throws. A plain JSON answer (no streaming on the way) is returned as it is.
 * When no chunk has come for two seconds the steps so far are read from GET /api/ask/progress/:askId every second, so
 * they show in a webview that holds a streamed response back until it ends (17 Oct 2026).
 */
export async function askStream(body, signal, onStep, { quietMs = 2000, everyMs = 1000 } = {}) {
  const step = s => { if (s?.id) onStep({ id: String(s.id), text: String(s.text || ''), state: s.state === 'done' ? 'done' : 'active' }); };
  let lastChunk = Date.now(), polling = false, finished = false;
  const poll = async () => {
    if (finished || polling || !body.askId || Date.now() - lastChunk < quietMs) return;
    polling = true;
    try {
      const r = await fetch(`/api/ask/progress/${encodeURIComponent(body.askId)}`, { signal, cache: 'no-store' });
      const v = r.ok ? await r.json() : null;
      if (!finished) for (const s of v?.steps || []) step(s);
    } catch { /* progress only */ } finally { polling = false; }
  };
  const timer = body.askId ? setInterval(poll, everyMs) : null;
  try {
    let response;
    try { response = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json' }, body: JSON.stringify(body), signal }); }
    catch (e) { if (signal.aborted) throw e; throw Error('The local app could not be reached. Retry.'); }
    if (!response.ok || !String(response.headers.get('content-type') || '').includes('ndjson') || !response.body) {
      const text = await response.text().catch(() => '');
      let value = {}; try { value = JSON.parse(text); } catch { value = readNdjson(text); }
      if (!response.ok) throw Error(plainMessage(typeof value.error === 'string' ? value.error : value.error?.message, 'The question could not be answered. Ask again.'));
      if (value?.type === 'error') throw Error(plainMessage(value.error, 'The question could not be answered. Ask again.'));
      return value?.type === 'answer' ? value.answer : value;
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    const handle = text => {
      let event; try { event = JSON.parse(text); } catch { return null; }
      if (event.type === 'step') { step(event.step); return null; }
      if (event.type === 'error') throw Error(plainMessage(event.error, 'The question could not be answered. Ask again.'));
      if (event.type === 'answer') return event.answer;
      return null;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (value?.length) lastChunk = Date.now();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n'); buffer = done ? '' : lines.pop();
      for (const l of lines) { if (!l.trim()) continue; const answer = handle(l); if (answer) return answer; }
      if (done) throw Error('The answer did not arrive. Ask again.');
    }
  } finally { finished = true; if (timer) clearInterval(timer); }
}
/** The last answer or error line of an NDJSON body read in one piece (a webview without a readable body). */
function readNdjson(text) {
  let last = {};
  for (const l of String(text).split('\n')) { if (!l.trim()) continue; try { const e = JSON.parse(l); if (e.type === 'answer' || e.type === 'error') last = e; } catch { /* skip */ } }
  return last;
}
/** A step merged into the steps shown: new ones join the end; a step that is done never goes back to active. */
export function mergeStep(steps, s) {
  const i = steps.findIndex(x => x.id === s.id);
  if (i < 0) return [...steps, s];
  if (steps[i].state === 'done' && s.state !== 'done') return steps;
  if (steps[i].state === s.state && steps[i].text === s.text) return steps;
  return steps.map((x, j) => (j === i ? s : x));
}

// ---- The selection in Word (17 Oct 2026): Ask about the passage the lawyer has selected ----------------------------
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
/** The chip's and the history's short form of a selection: the first `n` characters, ellipsised. */
export function selectionSnippet(text, n = 40) { const t = squash(text); return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t; }
/**
 * Word's indexes of the selected paragraphs: the first run of body paragraphs whose texts match the selection's
 * paragraphs in order (a paragraph partly selected still matches by its whole text). Empty when none match.
 */
export function selectionIndexes(bodyTexts, selectedTexts) {
  const body = bodyTexts.map(squash), sel = selectedTexts.map(squash);
  if (!sel.length) return [];
  for (let i = 0; i + sel.length <= body.length; i++) if (sel.every((t, k) => body[i + k] === t)) return sel.map((_, k) => i + k);
  return sel.map(t => body.indexOf(t)).filter(i => i >= 0);
}
/**
 * What goes with the question: { text, paragraphIds }, the ids the review's document gives the selected Word paragraphs
 * (through its `wordIndex`). Null for no selection or an empty one.
 */
export function selectionPayload(selection, doc) {
  const text = String(selection?.text ?? '').trim();
  if (!text) return null;
  const byIndex = new Map(Object.entries(doc?.wordIndex || {}).filter(([, i]) => Number.isInteger(i)).map(([id, i]) => [i, id]));
  const paragraphIds = [...new Set((selection.wordIndexes || []).map(i => byIndex.get(i)).filter(Boolean))];
  return { text: text.slice(0, 4000), paragraphIds };
}
