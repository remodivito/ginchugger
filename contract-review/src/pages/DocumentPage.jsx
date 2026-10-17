// SPDX-License-Identifier: GPL-3.0-or-later
// One document (#/documents/<id>; tasks/paperless-store-plan.md task 6): the store's preview beside its labels (editable),
// notes, similar documents and history. "Download original" gives the stored bytes (an "Open in Word" that downloaded the
// same file went in the UX audit of 17 Oct 2026).
// "Ask" puts a question about this document to the existing ask route (/api/ask, the pane's ask bar) with our own text
// of the original. Moving to the trash follows our rules: a signed or held document shows the action disabled with the
// reason. An admin holds or lifts a hold here.
import React, { useEffect, useState } from 'react';
import { when, day, PageError } from './shared.jsx';
import Labels from './Labels.jsx';
import { labelsOf, labelBody, sameLabels, protection, describeChange, hasTag, docHref, storeUrl, TAG_HOLD } from './store-view.js';
import { inferPlaybook } from '../review/model.js';
import { Markdown } from '../review/markdown.js';

function Notes({ api, id, onChanged }) {
  const [notes, setNotes] = useState(null), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null); // a note is deleted for good: one more press confirms (UX audit, 17 Oct 2026)
  useEffect(() => { api(storeUrl(id, 'notes')).then(setNotes).catch(e => setError(e.message)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(fn) { setBusy(true); setError(null); try { setNotes(await fn()); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <section className="section" aria-label="Notes">
    <span className="label">Notes</span>
    <PageError error={error} onClose={() => setError(null)}/>
    <div className="drawers notes">
      {(notes || []).map(n => <div key={n.id} className="note" aria-label={`Note by ${n.user || 'unknown'}`}>
        <div className="note__head"><span className="note__who">{n.user || 'Unknown'}</span><span className="meta grey">{when(n.created)}</span>
          <span className="note__links">{deleting === n.id ? <>
            <button type="button" className="link meta note__confirm" disabled={busy} onClick={() => run(async () => { const r = await api(storeUrl(id, `notes/${n.id}`), { method: 'DELETE' }); setDeleting(null); return r; })}>Confirm delete</button>
            <button type="button" className="link meta" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
          </> : <button type="button" className="link meta" disabled={busy} onClick={() => setDeleting(n.id)}>Delete</button>}</span></div>
        <div className="note__text">{n.text}</div>
      </div>)}
      <form className="note__new" aria-label="Add a note" onSubmit={e => { e.preventDefault(); if (text.trim()) run(async () => { const r = await api(storeUrl(id, 'notes'), { method: 'POST', body: JSON.stringify({ text }) }); setText(''); return r; }); }}>
        <div className="field"><textarea aria-label="Note" rows={2} value={text} placeholder="Add a note" onChange={e => setText(e.target.value)}/></div>
        {text.trim() ? <div className="actions"><button className="primary primary--inline" disabled={busy}>Add note</button></div> : null}
      </form>
    </div>
  </section>;
}

/**
 * The preview: the store's PDF, or, where the store makes none (the built-in, in-memory store used without Docker), our
 * own text of the original; a file with no text we can read says so rather than showing an empty frame.
 */
function Preview({ api, doc }) {
  const [real, setReal] = useState(null), [text, setText] = useState(null);
  useEffect(() => { let live = true; api('/api/v2/store/status').then(s => live && setReal(!(s?.mode === 'fake' || s?.builtIn))).catch(() => live && setReal(true)); return () => { live = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (real !== false) return undefined; let live = true; api(storeUrl(doc.id, 'paragraphs')).then(t => live && setText(t.paragraphs || [])).catch(() => live && setText([])); return () => { live = false; }; }, [real, doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (real === null) return <div className="doc__preview"/>;
  if (real) return <div className="doc__preview"><iframe title={`Preview of ${doc.title}`} src={`${storeUrl(doc.id, 'preview')}#toolbar=0&navpanes=0&view=FitH`}/></div>;
  return <div className="doc__preview doc__preview--text" aria-label={`Text of ${doc.title}`}>
    {text === null ? null : text.length ? <div className="doc__text">{text.map(p => <p key={p.id}>{p.text}</p>)}</div> : <p className="body grey doc__none">No preview for this file.</p>}
  </div>;
}

function History({ api, id, version }) {
  const [items, setItems] = useState(null);
  useEffect(() => { api(storeUrl(id, 'history')).then(setItems).catch(() => setItems([])); }, [id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const lines = (items || []).map(h => ({ ...h, line: describeChange(h) })).filter(h => h.line);
  if (!lines.length) return null;
  return <section className="section" aria-label="History">
    <span className="label">History</span>
    <div className="table" role="table" aria-label="History">{lines.map(h => <div key={h.id} className="trow trow--history" role="row">
      <span role="cell" className="trow__main">{h.line}</span>
      <span role="cell" className="trow__cell">{h.actor || 'System'}</span>
      <span role="cell" className="trow__cell">{when(h.at)}</span>
    </div>)}</div>
  </section>;
}

function Similar({ api, id }) {
  const [docs, setDocs] = useState(null);
  useEffect(() => { api(storeUrl(id, 'similar')).then(r => setDocs(r.results)).catch(() => setDocs([])); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!docs?.length) return null;
  return <section className="section" aria-label="Similar documents">
    <span className="label">Similar</span>
    <div className="drawers">{docs.map(d => <div key={d.id} className="listrow listrow--two">
      <span className="listrow__text"><a className="listrow__title" href={docHref(d.id)}>{d.title}</a><span className="meta grey">{[d.counterparty, d.type, day(d.created)].filter(Boolean).join(' · ')}</span></span>
    </div>)}</div>
  </section>;
}

/**
 * Ask about this document: our own text of the original goes to the ask route with the playbook its words suggest and
 * the document's store id, so the model can read the counterparty's other documents through the store tools (plan
 * task 10). Quotes from other documents link to them.
 */
function Ask({ api, doc }) {
  const [q, setQ] = useState(''), [answer, setAnswer] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  async function ask() {
    setBusy(true); setError(null); setAnswer(null);
    try {
      const [text, playbooks] = await Promise.all([api(storeUrl(doc.id, 'paragraphs')), api('/api/playbooks').catch(() => [])]);
      const playbookId = inferPlaybook(playbooks, text) || undefined;
      setAnswer(await api('/api/ask', { method: 'POST', body: JSON.stringify({ document: text, question: q.trim(), playbookId, storeDocumentId: doc.id }) }));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="section" aria-label="Ask">
    <form className="form-row" aria-label="Ask about this document" onSubmit={e => { e.preventDefault(); if (q.trim()) ask(); }}>
      <div className="field field--grow"><input aria-label="Question" value={q} placeholder="Ask about this document" autoFocus onChange={e => setQ(e.target.value)}/></div>
      <button className="primary primary--inline" disabled={busy || !q.trim()}>{busy ? 'Asking…' : 'Ask'}</button>
    </form>
    <PageError error={error} onClose={() => setError(null)}/>
    {answer ? <div className="card" role="status" aria-label="Answer"><Markdown text={answer.answer} className="md answer" cites={{ sources: answer.sources }}/>{(answer.limits || []).map((l, i) => <p key={i} className="meta grey">{l}</p>)}
      {(answer.sources || []).map((c, i) => <p key={`s${i}`} className="meta"><span className="quote quote--s">“{c.quote}”</span> <a href={docHref(c.documentId)}>{c.title || `Document ${c.documentId}`}</a>{c.otherCounterparty ? <span className="grey"> · Other counterparty: {c.counterparty}</span> : null}{c.verified ? '' : <span className="grey"> · Not verified</span>}</p>)}</div> : null}
  </section>;
}

export default function DocumentPage({ api, id, canHold = false, onToast, onChanged }) {
  const [doc, setDoc] = useState(null), [taxonomy, setTaxonomy] = useState(null), [labels, setLabels] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(null), [asking, setAsking] = useState(false), [version, setVersion] = useState(0);
  const load = () => api(storeUrl(id)).then(d => { setDoc(d); setLabels(labelsOf(d)); setVersion(v => v + 1); }).catch(e => setError(e.message));
  useEffect(() => { load(); api('/api/v2/store/taxonomy').then(setTaxonomy).catch(() => {}); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(name, fn) { setBusy(name); setError(null); try { await fn(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(''); } }
  if (!doc) return <main className="page" aria-label="Document"><section className="section"><h1 className="page__title">Document</h1><PageError error={error}/></section></main>;
  const changed = labels && !sameLabels(labels, labelsOf(doc));
  const protectedBy = protection(doc);
  const held = hasTag(doc, TAG_HOLD);
  const save = () => run('save', async () => { const d = await api(storeUrl(doc.id), { method: 'PATCH', body: JSON.stringify(labelBody(labels, doc)) }); setDoc(d); setLabels(labelsOf(d)); setVersion(v => v + 1); onToast?.('Labels saved'); });
  const trash = () => run('trash', async () => { await api(storeUrl(doc.id, 'trash'), { method: 'POST', body: '{}' }); onToast?.(`${doc.title} moved to the trash`); location.hash = '#/library'; });
  const hold = on => run('hold', async () => { const d = await api(storeUrl(doc.id, 'hold'), { method: 'POST', body: JSON.stringify({ on }) }); setDoc(d); setLabels(labelsOf(d)); setVersion(v => v + 1); onToast?.(on ? 'On hold' : 'Hold lifted'); });
  const dupes = (doc.duplicates || []).filter(d => !d.deletedAt);

  return <main className="page page--doc" aria-label="Document">
    <section className="section doc__head">
      <h1 className="page__title">{doc.title}</h1>
      <p className="meta grey">{[doc.counterparty, doc.type, day(doc.created), doc.inbox ? 'In the inbox' : null].filter(Boolean).join(' · ')}{dupes.length ? <> · Same file as {dupes.map((d, i) => <React.Fragment key={d.id}>{i ? ', ' : ''}<a href={docHref(d.id)}>{d.title}</a></React.Fragment>)}</> : null}</p>
      <div className="actions" role="toolbar" aria-label="Document actions">
        <a className="secondary secondary--link" href={storeUrl(doc.id, 'original')} download>Download original</a>
        <button type="button" className="quiet" aria-pressed={asking} onClick={() => setAsking(!asking)}>Ask</button>
        {canHold ? <button type="button" className="quiet" disabled={!!busy} onClick={() => hold(!held)}>{held ? 'Lift hold' : 'Hold'}</button> : null}
        <button type="button" className="quiet" disabled={!!busy || !!protectedBy} onClick={trash}>Move to trash</button>
        {protectedBy ? <span className="meta grey">{protectedBy}</span> : null}
      </div>
      <PageError error={error} onClose={() => setError(null)}/>
    </section>
    {asking ? <Ask api={api} doc={doc}/> : null}
    <div className="doc">
      <Preview api={api} doc={doc}/>
      <div className="doc__side">
        <section className="section" aria-label="Labels">
          <span className="label">Labels</span>
          <Labels id={`doc-${doc.id}`} value={labels} onChange={setLabels} taxonomy={taxonomy} canHold={canHold} disabled={busy === 'save'}/>
          {changed ? <div className="actions"><button type="button" className="primary primary--inline" disabled={!!busy || !labels.title.trim()} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button><button type="button" className="quiet" onClick={() => setLabels(labelsOf(doc))}>Cancel</button></div> : null}
        </section>
        <Notes api={api} id={doc.id} onChanged={() => setVersion(v => v + 1)}/>
        <Similar api={api} id={doc.id}/>
        <History api={api} id={doc.id} version={version}/>
      </div>
    </div>
  </main>;
}
