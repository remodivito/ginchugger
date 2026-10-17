// SPDX-License-Identifier: GPL-3.0-or-later
// Inbox (#/inbox; tasks/paperless-store-plan.md task 4, plan decision 3): the documents tagged "inbox" in the store,
// newest first, beside the one chosen (the redesign's board "Inbox B"). A document is already stored when it arrives;
// the lawyer checks the labels matching gave it and presses Done (the inbox tag goes), or Not a contract (it goes to the
// trash). Nothing is chosen before the document is stored, so there is no round-or-new decision. Uploads show as
// "Processing" while the store's task runs. Duplicates are flagged from the store's own duplicate check.
import React, { useEffect, useRef, useState } from 'react';
import { when, day, PageError } from './shared.jsx';
import Labels from './Labels.jsx';
import { plainName } from '../ui.jsx';
import { labelsOf, labelBody, protection, isEmail, docHref, storeUrl } from './store-view.js';

const POLL_MS = 1500;

function useEmail(api, doc) {
  const [mail, setMail] = useState(null);
  useEffect(() => { let live = true; setMail(null); if (isEmail(doc)) api(storeUrl(doc.id, 'email')).then(m => live && setMail(m)).catch(() => {}); return () => { live = false; }; }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return mail;
}

function Detail({ api, doc, taxonomy, canHold, busy, onDone, onTrash }) {
  const [labels, setLabels] = useState(() => labelsOf(doc));
  // The thumbnail is shown once it has loaded: a store without previews (the built-in one) then never collapses the
  // layout under the cursor while the labels are filled in (the team e2e test's Done click missed by that shift, 17 Oct 2026).
  const [thumb, setThumb] = useState(false);
  const mail = useEmail(api, doc);
  const protectedBy = protection(doc);
  const dupes = doc.duplicates || [];
  return <article className="inbox__detail" aria-label={doc.title}>
    <div className="stack" style={{ gap: 4 }}>
      {/* The file's name only when the title does not already say it (UX audit, 17 Oct 2026). */}
      <p className="meta grey">{mail ? [mail.from, when(Number.isNaN(Date.parse(mail.date)) ? doc.added : mail.date)].filter(Boolean).join(' · ') : [plainName(doc.originalName) === doc.title ? null : doc.originalName, when(doc.added)].filter(Boolean).join(' · ')}</p>
      <h2 className="inbox__subject">{mail?.subject || doc.title}</h2>
    </div>
    {mail?.text ? <p className="inbox__email">{mail.text.length > 700 ? `${mail.text.slice(0, mail.text.lastIndexOf(' ', 700))}…` : mail.text}</p> : null}
    {!isEmail(doc) ? <a className="inbox__thumb" href={docHref(doc.id)} aria-label={`Open ${doc.title}`} style={thumb ? undefined : { display: 'none' }}><img src={storeUrl(doc.id, 'thumb')} alt="" onLoad={() => setThumb(true)} onError={() => setThumb(false)}/></a> : null}
    <div className="groupwrap">
      <div className="label">Labels</div>
      <Labels id={`inbox-${doc.id}`} value={labels} onChange={setLabels} taxonomy={taxonomy} canHold={canHold} disabled={!!busy}/>
    </div>
    {/* UX taste call 3 (17 Oct 2026): said only when the document is a duplicate; a new one needs no row. */}
    {dupes.length ? <div className="groupwrap">
      <div className="group">
        <div className="item"><span className="item__k">Already in the library?</span>
          <span className="item__v">Same file as {dupes.map((d, i) => <React.Fragment key={d.id}>{i ? ', ' : ''}{d.deletedAt ? `${d.title} (in the trash)` : <a href={docHref(d.id)}>{d.title}</a>}</React.Fragment>)}</span>
        </div>
      </div>
    </div> : null}
    <div className="actions">
      <button type="button" className="primary primary--inline" disabled={!!busy || !labels.title.trim()} onClick={() => onDone(doc, labelBody(labels, doc))}>{busy === `done-${doc.id}` ? 'Saving…' : 'Done'}</button>
      <button type="button" className="secondary" disabled={!!busy || !!protectedBy} onClick={() => onTrash(doc)}>Not a contract</button>
      {protectedBy ? <span className="meta grey">{protectedBy}</span> : null}
      <a className="quiet quiet--link" href={docHref(doc.id)}>Open</a>
    </div>
  </article>;
}

export default function StoreInboxPage({ api, canHold = false, onChanged, onToast }) {
  const [data, setData] = useState(null), [taxonomy, setTaxonomy] = useState(null), [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(null);
  const filesRef = useRef();
  const load = () => Promise.all([api('/api/v2/store/inbox'), api('/api/v2/store/taxonomy')]).then(([d, t]) => { setData(d); setTaxonomy(t); }).catch(e => setError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // While the store processes an upload, read the inbox again until it lands.
  const waiting = (data?.processing || []).some(p => !p.error);
  useEffect(() => { if (!waiting) return undefined; const t = setTimeout(() => { load().then(() => onChanged?.()); }, POLL_MS); return () => clearTimeout(t); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(name, fn) { setBusy(name); setError(null); try { await fn(); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(''); } }
  const done = (doc, body) => run(`done-${doc.id}`, async () => { await api(storeUrl(doc.id, 'done'), { method: 'POST', body: JSON.stringify(body) }); onToast?.(`${body.title} filed`); setSelected(null); });
  const trash = doc => run(`trash-${doc.id}`, async () => { await api(storeUrl(doc.id, 'trash'), { method: 'POST', body: '{}' }); onToast?.(`${doc.title} moved to the trash`); setSelected(null); });
  const add = files => run('upload', async () => { const form = new FormData(); for (const f of files) form.append('file', f); await api('/api/v2/store/documents', { method: 'POST', body: form }); });
  const dismiss = taskId => run('dismiss', () => api(`/api/v2/store/processing/${encodeURIComponent(taskId)}`, { method: 'DELETE' }));
  const docs = data?.documents || [];
  const current = docs.find(d => d.id === selected) || docs[0] || null;

  return <main className="page" aria-label="Inbox">
    <div className="inbox">
      <section className="inbox__list" aria-label="Waiting">
        <h1 className="page__title">Inbox</h1>
        <PageError error={error} onClose={() => setError(null)}/>
        {(data?.processing || []).map(p => <div key={p.taskId} className="li li--processing" role="status" aria-label={`Processing ${p.filename}`}>
          <span className="li__m"><span>{p.error ? 'Not added' : 'Processing'}</span><span>{when(p.since)}</span></span>
          <span className="li__t">{p.filename}</span>
          {p.error ? <span className="li__s">{p.error} <button type="button" className="link" onClick={() => dismiss(p.taskId)}>Dismiss</button></span> : null}
        </div>)}
        {data && !docs.length && !(data.processing || []).length ? <p className="body grey" style={{ padding: '0 14px' }}>Nothing waiting.</p> : null}
        {docs.map(d => <button key={d.id} type="button" className="li" aria-current={d.id === current?.id} onClick={() => setSelected(d.id)}>
          <span className="li__m"><span>{d.counterparty || 'No counterparty'}</span><span>{day(d.added)}</span></span>
          <span className="li__t">{d.title}</span>
          <span className="li__s">{[d.type, d.duplicates?.length ? 'Duplicate' : null].filter(Boolean).join(' · ')}</span>
        </button>)}
        <div className="actions" style={{ padding: '8px 6px' }}><button type="button" className="quiet" onClick={() => filesRef.current.click()} disabled={!!busy}>{busy === 'upload' ? 'Adding…' : 'Add files'}</button></div>
        <input hidden ref={filesRef} type="file" multiple accept=".docx,.eml,.pdf,.txt,.md" aria-label="Add files" onChange={e => { add(Array.from(e.target.files)); e.target.value = ''; }}/>
      </section>
      {current ? <Detail key={current.id} api={api} doc={current} taxonomy={taxonomy} canHold={canHold} busy={busy} onDone={done} onTrash={trash}/> : null}
    </div>
  </main>;
}
