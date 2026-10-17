// SPDX-License-Identifier: GPL-3.0-or-later
// Trash (#/trash; tasks/paperless-store-plan.md task 7): the store's trash, most recently deleted first, with Restore for
// everyone. The engine empties its trash itself after its retention period; the store interface has no "delete for
// good", so the page offers none. Signed and held documents never reach the trash (our rules, server/store/index.js):
// their pages show "Move to trash" disabled with the reason.
import React, { useState } from 'react';
import { day, useLoad, PageError } from './shared.jsx';

export default function StoreTrashPage({ api, onToast, onChanged }) {
  const { data, error, reload, setError } = useLoad(() => api('/api/v2/store/trash'), []);
  const [busy, setBusy] = useState(null);
  async function restore(d) {
    setBusy(d.id); setError(null);
    try { await api('/api/v2/store/trash/restore', { method: 'POST', body: JSON.stringify({ ids: [d.id] }) }); onToast?.(`${d.title} restored`); onChanged?.(); reload(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  const items = data?.items || [];
  return <main className="page" aria-label="Trash">
    <section className="section">
      <h1 className="page__title">Trash</h1>
      <PageError error={error} onClose={() => setError(null)}/>
    </section>
    {data && (items.length ? <section className="section" aria-label="In the trash">
      <div className="table" role="table" aria-label="In the trash">
        <div className="trow trow--storetrash trow--head" role="row">{['Document', 'Deleted', ''].map((h, i) => <span key={i} role="columnheader" className="label">{h}</span>)}</div>
        {items.map(d => <div key={d.id} className="trow trow--storetrash" role="row" aria-label={d.title}>
          <span role="cell" className="trow__stack"><span className="trow__main">{d.title}</span>{d.counterparty || d.type ? <span className="meta grey">{[d.counterparty, d.type].filter(Boolean).join(' · ')}</span> : null}</span>
          <span role="cell" className="trow__cell">{day(d.deletedAt)}</span>
          <span role="cell" className="trow__actions"><button type="button" className="quiet" disabled={busy !== null} onClick={() => restore(d)}>Restore</button></span>
        </div>)}
      </div>
    </section> : <section className="section"><p className="body grey">The trash is empty.</p></section>)}
  </main>;
}
