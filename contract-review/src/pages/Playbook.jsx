// SPDX-License-Identifier: GPL-3.0-or-later
// Playbook page (R7; #/playbook/<id>): entries with their tiers, import, a draft with one explicit "Use this playbook",
// and the entry editor (also used by Add to playbook from the pane). The shared playbook lives in the record: its
// owners (admins, and members an admin names) save directly; anyone else's save is a proposed change, listed here for
// an owner to accept or decline (decision 178). Every applied save records who, when, which entry and what kind of
// change, shown as the change counter and the last-change line (PR-PAGE-02). No version history (decision 150).
import React, { useRef, useState } from 'react';
import { Drawer, plainName } from '../ui.jsx';
import { day, useLoad } from './shared.jsx';

export const TIERS = [['preferred', 'Preferred'], ['acceptable', 'Acceptable'], ['escalation', 'Escalation'], ['hardLine', 'Hard line']];
const tiersOf = r => TIERS.filter(([k]) => r[k]).map(([, l]) => l);

// The entry (decision 124): one card with Title, Position, Acceptable and Hard line, and the wording it came from attached
// in a box; everything else behind More, whose row names what it holds. Save, Cancel. Used by Add to playbook from the pane,
// by Edit on an entry, and by Edit on an entry of a draft.
const MORE = [['topic', 'Topic'], ['preferred', 'Preferred'], ['escalation', 'Escalation'], ['wording', 'Wording'], ['fallback', 'Fallback'], ['rationale', 'Rationale']];
const paraLabel = p => (p ? `¶ ${String(p).replace(/^p/, '')}` : '');

export function RuleEditor({ draft, setDraft, onSave, onCancel, onRemove, busy, existing }) {
  const [more, setMore] = useState(false);
  const set = (k, v) => setDraft({ ...draft, [k]: v });
  const area = (k, label, rows = 2) => <div className="field" key={k}><label className="label" htmlFor={`rule-${k}`}>{label}</label><textarea id={`rule-${k}`} rows={Math.min(8, Math.max(rows, Math.ceil(String(draft[k] || '').length / 44) + 1))} value={draft[k] || ''} onChange={e => set(k, e.target.value)}/></div>;
  const held = MORE.filter(([k]) => k === 'topic' ? draft.topic && draft.topic !== 'custom' : String(draft[k] || '').trim()).map(([, l]) => l);
  const off = draft.enabled === false;
  return <form className="card entrycard" onSubmit={e => { e.preventDefault(); onSave(); }} aria-label="Playbook entry">
    <span className="label">{existing ? 'Entry' : 'New entry'}</span>
    <div className="field"><label className="label" htmlFor="rule-title">Title</label><input id="rule-title" value={draft.title} onChange={e => set('title', e.target.value)}/></div>
    {area('guidance', 'Position', 3)}
    {area('acceptable', 'Acceptable')}
    {area('hardLine', 'Hard line')}
    {draft.sources?.filter(x => x.quote).map((x, i) => <div key={i} className="box">
      <div className="box__head"><span className="label">Source</span><span className="meta grey">{[plainName(x.document), paraLabel(x.paragraph)].filter(Boolean).join(' · ')}{x.verified === false ? ' · not found' : ''}</span></div>
      <p className="quote quote--s">“{x.quote}”</p>
    </div>)}
    <div className="drawers">
      <Drawer name="More" sum={held.length || off ? [...held, ...(off ? ['Off'] : [])].join(' · ') : null} open={more} onToggle={() => setMore(!more)}>
        <div className="field"><label className="label" htmlFor="rule-topic">Topic</label><select id="rule-topic" className="select" value={draft.topic} onChange={e => setDraft({ ...draft, topic: e.target.value, conditions: {} })}>{['custom', 'duration', 'purpose', 'retention', 'liability', 'indemnity', 'payment'].map(t => <option key={t}>{t}</option>)}</select></div>
        {area('preferred', 'Preferred')}
        {area('escalation', 'Escalation')}
        {area('wording', 'Wording', 3)}
        {area('fallback', 'Fallback')}
        {area('rationale', 'Rationale')}
        <label className="check-row"><input type="checkbox" checked={!off} onChange={e => set('enabled', e.target.checked)}/>Use in reviews</label>
      </Drawer>
    </div>
    <div className="actions">
      <button className="primary primary--inline" disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
      {existing && onRemove && <button type="button" className="quiet quiet--end" onClick={onRemove} disabled={!!busy}>Remove entry</button>}
    </div>
  </form>;
}

const KIND = { added: 'added', edited: 'edited', removed: 'removed', enabled: 'turned on', disabled: 'turned off', imported: 'replaced by an import', created: 'created' };
/** "Change 4 · Last changed by sam on 15 Oct 2026 · CAP-01 edited" (PR-PAGE-02), from the record's playbook row. */
export function lastChangeLine(meta, nameOf = id => id) {
  if (!meta?.updatedAt) return null;
  const by = meta.updatedBy && !['migrated', 'seed'].includes(meta.updatedBy) ? ` by ${nameOf(meta.updatedBy)}` : '';
  const date = new Date(meta.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const what = meta.lastChange ? (meta.lastChange.ruleId ? `${meta.lastChange.ruleId} ${KIND[meta.lastChange.kind] || meta.lastChange.kind}` : `Playbook ${KIND[meta.lastChange.kind] || meta.lastChange.kind}`) : null;
  return [`Change ${meta.changeCount}`, `Last changed${by} on ${date}`, what].filter(Boolean).join(' · ');
}

const PROPOSED = { added: 'added', edited: 'edited', removed: 'removed', enabled: 'turned on', disabled: 'turned off', imported: 'replaced by an import' };

/** Proposed changes (decision 178): each names the entry and the proposer; an owner opens one, then accepts or declines. */
function Proposals({ api, playbook, meta, canDecide, nameOf, onDecided }) {
  const id = playbook?.id;
  const { data, error, reload, setError } = useLoad(() => (id ? api(`/api/v2/playbooks/${encodeURIComponent(id)}/proposals`) : Promise.resolve([])), [id, meta?.changeCount, meta?.proposals]);
  const [open, setOpen] = useState(null), [declining, setDeclining] = useState(null), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  if (!data?.length && !error) return null;
  async function decide(p, action) {
    setBusy(true); setError(null);
    try { await api(`/api/v2/playbooks/${encodeURIComponent(id)}/proposals/${encodeURIComponent(p.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'decline' ? { note } : {}) }); setDeclining(null); setNote(''); setOpen(null); reload(); onDecided?.(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const what = p => (p.ruleId ? `${p.ruleId} ${PROPOSED[p.kind] || p.kind}` : `Playbook ${PROPOSED[p.kind] || p.kind}`);
  return <section className="section" aria-label="Proposed changes">
    <div className="row-between"><span className="label">Proposed changes</span><span className="meta grey">{data?.length || 0}</span></div>
    {error && <p className="page-error page-error--inline" role="alert">{error}</p>}
    <div className="drawers">{(data || []).map(p => <div key={p.id} aria-label={`Proposed: ${what(p)}`}>
      <button type="button" className="listrow listrow--two" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
        <span className="listrow__text"><span className="listrow__title">{what(p)}</span><span className="meta grey">{nameOf(p.proposedBy)} · {day(p.at)}</span></span>
      </button>
      {open === p.id && <div className="entry__body">
        {p.changes.map(c => <div key={c.ruleId} className="card">
          {c.rule ? <>
            <p className="strong">{c.rule.title}</p>
            {c.rule.guidance && <p>{c.rule.guidance}</p>}
            <div className="grid grid--wide">{TIERS.filter(([k]) => c.rule[k]).map(([k, l]) => <React.Fragment key={k}><span className="label grid__label">{l}</span><span className="grid__value body">{c.rule[k]}</span></React.Fragment>)}</div>
            {c.rule.enabled === false && <p className="meta grey">Off</p>}
          </> : <p>{c.ruleId} removed</p>}
        </div>)}
        {canDecide && (declining === p.id ? <form className="editor" aria-label="Decline" onSubmit={e => { e.preventDefault(); decide(p, 'decline'); }}>
          <div className="field"><label className="label" htmlFor={`decline-${p.id}`}>Note</label><textarea id={`decline-${p.id}`} rows={2} value={note} onChange={e => setNote(e.target.value)}/></div>
          <div className="actions"><button className="primary primary--inline" disabled={busy || !note.trim()}>Decline</button><button type="button" className="quiet" onClick={() => setDeclining(null)}>Cancel</button></div>
        </form> : <div className="actions">
          <button type="button" className="primary primary--inline" disabled={busy} onClick={() => decide(p, 'accept')}>Accept</button>
          <button type="button" className="quiet" disabled={busy} onClick={() => { setDeclining(p.id); setNote(''); }}>Decline</button>
        </div>)}
      </div>}
    </div>)}</div>
  </section>;
}

export default function PlaybookPage({ api, team = null, onProposalDecided, playbook, playbooks = [], meta = null, nameOf = id => id, onOpenPlaybook, draft, ruleDraft, setRuleDraft, busy, onImport, onActivate, onCreate, onDiscardDraft, onSaveRule, onRemoveRule, onNewRule }) {
  const importRef = useRef();
  const [openDraftEntry, setOpenDraftEntry] = useState(null);
  const [draftLimits, setDraftLimits] = useState(false);
  // P6: a draft can also become a new playbook, with a name and what it applies to (the words that identify its documents).
  const [asNew, setAsNew] = useState(null); // { title, label, phrases } while the form is open
  const editing = ruleDraft;
  // Decision 178: solo mode, an admin, or a named owner decides on proposed changes; the server checks it again.
  const canDecide = !team || team.mode !== 'team' || !!team.user?.admin || (playbook?.owners || []).includes(team.user?.userId);
  const changed = lastChangeLine(meta, nameOf), appliesTo = playbook?.appliesTo?.label || null;
  const provenance = playbook?.provenance ? (typeof playbook.provenance === 'string' ? playbook.provenance : playbook.provenance.method) : null;
  const existing = editing && (playbook?.rules.some(r => r.id === editing.id) || draft?.rules.some(r => r.id === editing.id));
  if (editing) return <main className="page page--narrow" aria-label="Playbook">
    <section className="section">
      <h1 className="page__title">{playbook?.title || 'Playbook'}</h1>
      <RuleEditor draft={editing} setDraft={setRuleDraft} onSave={onSaveRule} onCancel={() => setRuleDraft(null)} onRemove={playbook?.rules.some(r => r.id === editing.id) && !draft?.rules.some(r => r.id === editing.id) ? () => onRemoveRule(editing.id) : null} busy={busy} existing={existing}/>
    </section>
  </main>;
  return <main className="page" aria-label="Playbook">
    <section className="section">
      <h1 className="page__title">{playbook?.title || 'Playbook'}</h1>
      {/* UX taste call 2 (17 Oct 2026): the title, then one line: what it applies to and its last change, with a quiet
          Switch playbook; how it was made (the demonstration note) is the line's tooltip. */}
      <p className="meta grey pagehead__line" title={provenance || undefined}>
        {[appliesTo && <span key="for">For {appliesTo}</span>, changed && <span key="changed" data-testid="last-change">{changed}</span>].filter(Boolean).map((x, i) => <React.Fragment key={i}>{i ? <span aria-hidden="true">·</span> : null}{x}</React.Fragment>)}
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => importRef.current.click()} disabled={!!busy}>Import DOCX</button>
        <button type="button" className="quiet" onClick={onNewRule}>Add entry</button>
        {playbooks.length > 1 && <select aria-label="Switch playbook" className="select select--quiet" value="" disabled={!!busy} onChange={e => e.target.value && onOpenPlaybook(e.target.value)}>
          <option value="" disabled hidden>Switch playbook</option>
          {playbooks.filter(p => p.id !== playbook?.id).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>}
      </div>
      <input hidden ref={importRef} type="file" accept=".docx" onChange={e => { onImport(e.target.files[0]); e.target.value = ''; }}/>
    </section>

    {draft && <section className="section" aria-label="Draft playbook">
      <div className="row-between"><h2 className="h2">{String(draft.title || 'Draft').replace(/\.(docx|eml|txt|md)\b/gi, '')}</h2><span className="tag">Draft</span></div>
      {draft.summary && <p className="meta grey">{draft.summary.verifiedQuotes} of {draft.summary.quotes} quotes found in the documents</p>}
      <div className="drawers">
        {draft.rules.map(r => { const verified = !r.sources || r.sources.some(x => x.verified !== false); return <div key={r.id}>
          <button type="button" className="listrow listrow--two" aria-expanded={openDraftEntry === r.id} onClick={() => setOpenDraftEntry(openDraftEntry === r.id ? null : r.id)}>
            <span className="listrow__text"><span className="listrow__title">{r.title}</span><span className="meta grey">{tiersOf(r).join(' · ') || r.topic}</span></span>{!verified && <span className="tag">Unverified</span>}
          </button>
          {openDraftEntry === r.id && <div className="entry__body">
            {(r.guidance || r.notes?.length || r.unknowns?.length) ? <div className="card">
              {r.guidance && <p>{r.guidance}</p>}
              {r.notes?.map((n, i) => <p key={i} className="strong">{n}</p>)}
              {r.unknowns?.length ? <p className="meta grey">Not established: {r.unknowns.map(u => String(u).replace(/[.;\s]+$/, '')).join('; ')}</p> : null}
            </div> : null}
            <div className="grid grid--wide">{TIERS.filter(([k]) => r[k]).map(([k, l]) => <React.Fragment key={k}><span className="label grid__label">{l}</span><span className="grid__value body">{r[k]}</span></React.Fragment>)}</div>
            {r.sources?.filter(x => x.quote).map((x, i) => <div key={i} className="quoted"><p className="quote quote--s">“{x.quote}”</p><span className="meta grey">{[plainName(x.document), paraLabel(x.paragraph)].filter(Boolean).join(' · ')}{x.verified === false ? ' · not found' : ''}</span></div>)}
            <div className="links"><button type="button" className="quiet" onClick={() => setRuleDraft(structuredClone(r))}>Edit</button></div>
          </div>}
        </div>; })}
        {draft.limits?.length || draft.provenance?.method ? <Drawer name="Limits" sum={draft.limits?.length || 0} open={draftLimits} onToggle={() => setDraftLimits(!draftLimits)}>
          <ul className="plain body">{draft.provenance?.method && <li>{draft.provenance.method}</li>}{draft.limits?.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </Drawer> : null}
      </div>
      {asNew ? <form className="editor" aria-label="New playbook" onSubmit={e => { e.preventDefault(); onCreate({ title: asNew.title, appliesTo: { label: asNew.label, phrases: asNew.phrases.split(',').map(x => x.trim()).filter(Boolean) } }); }}>
        <div className="field field--narrow"><label className="label" htmlFor="new-title">Name</label><input id="new-title" value={asNew.title} onChange={e => setAsNew({ ...asNew, title: e.target.value })}/></div>
        <div className="field field--narrow"><label className="label" htmlFor="new-label">Applies to</label><input id="new-label" value={asNew.label} placeholder="Customer order forms" onChange={e => setAsNew({ ...asNew, label: e.target.value })}/></div>
        <div className="field field--narrow"><label className="label" htmlFor="new-phrases">Title words</label><input id="new-phrases" value={asNew.phrases} placeholder="order form, customer order" onChange={e => setAsNew({ ...asNew, phrases: e.target.value })}/></div>
        <div className="actions">
          <button className="primary primary--inline" disabled={!!busy || !asNew.title.trim()}>Save</button>
          <button type="button" className="quiet" onClick={() => setAsNew(null)}>Cancel</button>
        </div>
      </form> : <div className="actions">
        <button type="button" className="primary primary--inline" onClick={onActivate} disabled={!!busy || !playbook}>Use this playbook</button>
        {onCreate && <button type="button" className="quiet" onClick={() => setAsNew({ title: draft.title || '', label: '', phrases: '' })} disabled={!!busy}>Save as new playbook</button>}
        <button type="button" className="quiet" onClick={onDiscardDraft}>Discard</button>
      </div>}
    </section>}

    {api && <Proposals api={api} playbook={playbook} meta={meta} canDecide={canDecide} nameOf={nameOf} onDecided={onProposalDecided}/>}

    <section className="section" aria-label="Entries">
      <div className="row-between"><span className="label">Entries</span><span className="meta grey">{playbook?.rules.length || 0}</span></div>
      <div className="table">{playbook?.rules.map(r => <button key={r.id} type="button" className="trow trow--btn" onClick={() => setRuleDraft(structuredClone(r))}>
        <span className="trow__cell grey mono">{r.id}</span>
        <span className="trow__main strong">{r.title}</span>
        <span className="trow__cell grey">{tiersOf(r).join(' · ') || r.topic}</span>
        <span className="trow__cell">{r.enabled === false ? 'Off' : ''}</span>
      </button>)}</div>
    </section>
  </main>;
}
