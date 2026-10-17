// SPDX-License-Identifier: GPL-3.0-or-later
// Activity (#/activity, admins; tasks/paperless-store-plan.md task 7): recent changes across the store, newest first,
// in plain words, each naming its document and who made it (plan decision 5: one store user per lawyer). The store
// interface has no history across documents, so the server builds this from the most recently changed documents'
// histories (server/store/http.js, GET /activity); the one context line says so.
import React from 'react';
import { when, useLoad, PageError } from './shared.jsx';
import { describeChange, docHref } from './store-view.js';

export default function StoreActivityPage({ api }) {
  const { data, error, setError } = useLoad(() => api('/api/v2/store/activity'), []);
  const items = (data?.items || []).map(h => ({ ...h, line: describeChange(h) })).filter(h => h.line);
  return <main className="page" aria-label="Activity">
    <section className="section">
      <h1 className="page__title">Activity</h1>
      {data?.documents ? <p className="meta grey">From the {data.documents} most recently changed documents</p> : null}
      <PageError error={error} onClose={() => setError(null)}/>
    </section>
    {data && <section className="section" aria-label="Changes">
      {items.length ? <div className="table" role="table" aria-label="Changes">
        <div className="trow trow--storeactivity trow--head" role="row">{['Change', 'Document', 'Person', 'When'].map(h => <span key={h} role="columnheader" className="label">{h}</span>)}</div>
        {items.map(h => <div key={`${h.document.id}-${h.id}`} className="trow trow--storeactivity" role="row">
          <span role="cell" className="trow__main">{h.line}</span>
          <span role="cell" className="trow__cell"><a className="quietlink" href={docHref(h.document.id)}>{h.document.title}</a></span>
          <span role="cell" className="trow__cell">{h.actor || 'System'}</span>
          <span role="cell" className="trow__cell">{when(h.at)}</span>
        </div>)}
      </div> : <p className="body grey">No changes yet.</p>}
    </section>}
  </main>;
}
