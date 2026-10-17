// SPDX-License-Identifier: GPL-3.0-or-later
// Library (#/library; tasks/paperless-store-plan.md task 5): every document in the store in one list, replacing Matters,
// Register and Search. Filters by counterparty, type, tag and date; full-text search (the engine's index) with the
// matching words highlighted in a snippet; sorting and paging. A counterparty's page is this list filtered to it
// (#/library?counterparty=<name>). Byte-identical documents are one row marked
// "n copies" (fix B); the Document page lists the others.
import React, { useEffect, useState } from 'react';
import { day, PageError } from './shared.jsx';
import { highlightParts, docHref, SORT_OPTIONS } from './store-view.js';

const PAGE_SIZE = 25;
const EMPTY = { q: '', counterparty: '', type: '', tag: '', from: '', to: '', sort: '-created', page: 1 };

export function Snippet({ html }) {
  return <span className="snippet">{highlightParts(html).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</span>;
}

export default function LibraryPage({ api, query = {} }) {
  const [filters, setFilters] = useState(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(query).filter(([k]) => k in EMPTY && k !== 'page')) }));
  const [draft, setDraft] = useState(filters.q);
  const [data, setData] = useState(null), [taxonomy, setTaxonomy] = useState(null), [error, setError] = useState(null);
  // At a phone width the filters fold behind one Filters button that counts the ones in use (UX taste call 5); on a
  // wider screen the button is hidden and the filters always show (CSS).
  const [showFilters, setShowFilters] = useState(false);
  const active = ['counterparty', 'type', 'tag', 'from', 'to'].filter(k => filters[k]).length;
  useEffect(() => { api('/api/v2/store/taxonomy').then(setTaxonomy).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    const p = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    for (const [k, v] of Object.entries(filters)) if (v !== '' && !(k === 'sort' && filters.q)) p.set(k, String(v));
    api(`/api/v2/store/documents?${p}`).then(d => live && (setData(d), setError(null))).catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setFilters(f => ({ ...f, [k]: v, page: k === 'page' ? v : 1 }));
  const searching = !!filters.q;
  const pages = data ? Math.max(1, Math.ceil(data.count / PAGE_SIZE)) : 1;
  const select = (k, label, options) => <div className="field"><label className="label" htmlFor={`lib-${k}`}>{label}</label>
    <select id={`lib-${k}`} className="select" value={filters[k]} onChange={e => set(k, e.target.value)}>
      <option value="">All</option>
      {(options || []).map(o => <option key={o} value={o}>{o}</option>)}
      {filters[k] && !(options || []).includes(filters[k]) ? <option value={filters[k]}>{filters[k]}</option> : null}
    </select></div>;

  return <main className="page" aria-label="Library">
    <section className="section">
      <h1 className="page__title">Library</h1>
      <form className="form-row" role="search" aria-label="Search the library" onSubmit={e => { e.preventDefault(); set('q', draft.trim()); }}>
        <div className="field field--grow"><label className="label" htmlFor="lib-q">Search</label><input id="lib-q" type="search" value={draft} placeholder="Words in the documents" onChange={e => { setDraft(e.target.value); if (!e.target.value) set('q', ''); }}/></div>
        <button className="secondary">Search</button>
      </form>
      <button type="button" className="quiet filters-toggle" aria-label={active ? `Filters, ${active} in use` : 'Filters'} aria-expanded={showFilters} aria-controls="lib-filters" onClick={() => setShowFilters(!showFilters)}>Filters{active ? <span className="grey">{active}</span> : null}</button>
      <div id="lib-filters" className={`form-row form-row--filters ${showFilters ? 'is-open' : ''}`} role="group" aria-label="Filters">
        {select('counterparty', 'Counterparty', taxonomy?.counterparties)}
        {select('type', 'Type', taxonomy?.types)}
        {select('tag', 'Tag', (taxonomy?.tags || []).filter(t => t !== 'inbox'))}
        <div className="field"><label className="label" htmlFor="lib-from">From</label><input id="lib-from" type="date" value={filters.from} onChange={e => set('from', e.target.value)}/></div>
        <div className="field"><label className="label" htmlFor="lib-to">To</label><input id="lib-to" type="date" value={filters.to} onChange={e => set('to', e.target.value)}/></div>
        <div className="field"><label className="label" htmlFor="lib-sort">Sort</label>
          <select id="lib-sort" className="select" value={searching ? 'relevance' : filters.sort} disabled={searching} onChange={e => set('sort', e.target.value)}>
            {searching ? <option value="relevance">Relevance</option> : null}
            {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
      </div>
      <PageError error={error} onClose={() => setError(null)}/>
    </section>
    {data && <section className="section" aria-label="Documents">
      <div className="row-between"><span className="label">Documents</span><span className="meta grey" aria-live="polite">{data.count}</span></div>
      {data.results.length ? <div className="table" role="table" aria-label="Documents">
        <div className="trow trow--library trow--head" role="row">{['Title', 'Counterparty', 'Type', 'Date'].map(h => <span key={h} role="columnheader" className="label">{h}</span>)}</div>
        {data.results.map(d => <div key={d.id} className="trow trow--library" role="row" aria-label={d.title}>
          <span role="cell" className="trow__stack">
            <a className="trow__main" href={docHref(d.id)}>{d.title}</a>
            {d.hit?.highlights ? <Snippet html={d.hit.highlights}/> : null}
            {d.tags.filter(t => t !== 'inbox').length || d.inbox || d.copies > 1 ? <span className="meta grey">{[...(d.inbox ? ['In the inbox'] : []), ...d.tags.filter(t => t !== 'inbox'), ...(d.copies > 1 ? [`${d.copies} copies`] : [])].join(' · ')}</span> : null}
          </span>
          <span role="cell" className="trow__cell">{d.counterparty ? <a className="quietlink" href={`#/library?counterparty=${encodeURIComponent(d.counterparty)}`} onClick={e => { e.preventDefault(); set('counterparty', d.counterparty); }}>{d.counterparty}</a> : ''}</span>
          <span role="cell" className="trow__cell">{d.type || ''}</span>
          <span role="cell" className="trow__cell">{day(d.created)}</span>
        </div>)}
      </div> : <p className="body grey">No documents match.</p>}
      {pages > 1 && <nav className="pager" aria-label="Pages">
        <button type="button" className="quiet" disabled={data.page <= 1} onClick={() => set('page', data.page - 1)}>Previous</button>
        <span className="meta grey">Page {data.page} of {pages}</span>
        <button type="button" className="quiet" disabled={data.page >= pages} onClick={() => set('page', data.page + 1)}>Next</button>
      </nav>}
    </section>}
  </main>;
}
