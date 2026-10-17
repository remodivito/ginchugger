// SPDX-License-Identifier: GPL-3.0-or-later
// Admin (#/admin; product v2 spec PR-PAGE-03, 7.10, 9.4, PR-SEC-08): the status of the record (and of the team server
// in team mode), setup codes issued and revoked, people revoked, "check mail now", and the date the team adopted its
// retention statement, and each playbook's owners (decision 178: admins own every playbook; an admin names others).
// Admins only in team mode (the server refuses everyone else; the link is hidden); in solo mode the page shows the
// status only. The store's holds (tasks/paperless-store-plan.md task 7): documents on hold, each with Lift hold; a hold
// is set from the document's page. Both are admin-only on the server (server/store/http.js).
import React, { useState } from 'react';
import { when, day, useLoad, PageError } from './shared.jsx';

const mb = b => (b == null ? 'Not reported' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const ago = s => (s == null ? '' : s < 3600 ? `${Math.round(s / 60)} minutes` : s < 172800 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 86400)} days`);
const codeState = c => (c.revokedAt ? 'Revoked' : c.redeemedAt ? `Used ${day(c.redeemedAt)}` : Date.parse(c.expiresAt) <= Date.now() ? 'Expired' : `Expires ${day(c.expiresAt)}`);
const outstanding = c => !c.revokedAt && !c.redeemedAt && Date.parse(c.expiresAt) > Date.now();

/** The document store's state in one line (the record's own file and inbox counts went with decision 190). */
const storeLine = st => st.state === 'ready' ? (st.builtIn ? 'Ready · built-in, in memory (no Docker)' : st.mode === 'fake' ? 'Ready · in memory' : `Ready · Paperless-ngx ${st.version || ''}`.trim())
  : st.state === 'unavailable' ? `Unavailable${st.reason ? `: ${st.reason}` : ''}` : st.state === 'off' ? 'Off' : 'Starting';

function Status({ s, team }) {
  const mail = s.mail || {};
  const rows = [
    ['Version', `${s.version} · schema ${s.schemaVersion}`],
    ['Up for', ago(s.uptimeSeconds)],
    team && ['Address', s.publicUrl || 'Not set'],
    ['Data folder', s.dataDir],
    ['Database', mb(s.database?.bytes)],
    ['Disk free', mb(s.disk?.freeBytes)],
    s.store && ['Document store', storeLine(s.store)],
    team && ['People', `${s.users?.active ?? 0} active${s.users?.revoked ? ` · ${s.users.revoked} revoked` : ''}`],
    team && ['Codes outstanding', s.codesOutstanding],
    team && ['Mail', mail.enabled ? [mail.mailbox, mail.lastCheckAt ? `checked ${when(mail.lastCheckAt)}` : 'not checked yet', mail.lastError ? `last error: ${mail.lastError}` : null, mail.consecutiveFailures ? `${mail.consecutiveFailures} failures in a row` : null].filter(Boolean).join(' · ') : 'Off'],
    team && mail.enabled && ['Mail, last 24 hours', Object.entries(mail.processed24h || {}).map(([k, v]) => `${v} ${k}`).join(' · ')],
    ['Last backup', s.lastBackupAt ? when(s.lastBackupAt) : 'None recorded'],
    ['Retention statement', s.retentionAdoptedOn ? `Adopted ${day(s.retentionAdoptedOn)}` : 'Not adopted'],
    team && s.certificate && ['Certificate expires', day(s.certificate.expiresAt)],
  ].filter(Boolean);
  return <div className="grid grid--wide" role="list" aria-label="Status">{rows.map(([k, v]) => <React.Fragment key={k}><span className="label grid__label" role="listitem">{k}</span><span className="grid__value">{v}</span></React.Fragment>)}</div>;
}

function IssueCode({ api, onIssued }) {
  const [draft, setDraft] = useState({ forName: '', admin: false, days: '7' }), [busy, setBusy] = useState(false), [error, setError] = useState(null), [issued, setIssued] = useState(null);
  async function issue() {
    setBusy(true); setError(null);
    try { const c = await api('/api/v2/admin/setup-codes', { method: 'POST', body: JSON.stringify({ forName: draft.forName.trim(), admin: draft.admin, ttlHours: Number(draft.days) * 24 }) }); setIssued(c); setDraft({ forName: '', admin: false, days: '7' }); onIssued(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <>
    {issued && <div className="card" role="status" aria-label="New setup code">
      <p className="mono strong" data-testid="setup-code">{issued.code}</p>
      <p>Give this to {issued.forName} in person or by a channel you trust. It expires on {day(issued.expiresAt)} and works once.</p>
      <div className="actions"><button type="button" className="quiet" onClick={() => setIssued(null)}>Done</button></div>
    </div>}
    <form className="editor" aria-label="Issue a setup code" onSubmit={e => { e.preventDefault(); issue(); }}>
      <PageError error={error} onClose={() => setError(null)}/>
      <div className="field field--narrow"><label className="label" htmlFor="code-name">Name</label><input id="code-name" value={draft.forName} onChange={e => setDraft({ ...draft, forName: e.target.value })}/></div>
      <div className="field field--narrow"><label className="label" htmlFor="code-days">Expires after (days)</label><input id="code-days" type="number" min="1" max="90" value={draft.days} onChange={e => setDraft({ ...draft, days: e.target.value })}/></div>
      <label className="check-row"><input type="checkbox" checked={draft.admin} onChange={e => setDraft({ ...draft, admin: e.target.checked })}/>Admin</label>
      <div className="actions"><button className="primary primary--inline" disabled={busy || !draft.forName.trim() || !(Number(draft.days) > 0)}>{busy ? 'Issuing…' : 'Issue code'}</button></div>
    </form>
  </>;
}

/** Each playbook's named owners, changed by toggling a member (admins are owners already, so they are not listed). */
function PlaybookOwners({ api, users, busy, run }) {
  const { data: books, reload } = useLoad(() => api('/api/v2/playbooks'), []);
  const [open, setOpen] = useState(null);
  const members = users.filter(u => !u.revokedAt && !u.admin);
  const nameOf = id => users.find(u => u.id === id)?.name || id;
  const set = (b, owners) => run(`owners-${b.id}`, async () => { await api(`/api/v2/playbooks/${encodeURIComponent(b.id)}/owners`, { method: 'PUT', body: JSON.stringify({ owners }) }); reload(); });
  return <section className="section" aria-label="Playbook owners">
    <span className="label">Playbook owners</span>
    <div className="drawers">{(books || []).map(b => { const owners = b.owners || []; return <div key={b.id} className="startrow" aria-label={`Owners of ${b.title}`}>
      <div className="startrow__head">
        <div className="startrow__main"><span className="label">{b.title}</span><span className="startrow__value">{owners.length ? ['Admins', ...owners.map(nameOf)].join(', ') : 'Admins'}</span></div>
        {members.length ? <span className="links meta"><button type="button" className="link" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)}>Change</button></span> : null}
      </div>
      {open === b.id && <div className="choices" role="group" aria-label={`Owners of ${b.title}`}>{members.map(u => { const on = owners.includes(u.id); return <button key={u.id} type="button" className="choice" aria-pressed={on} disabled={!!busy} onClick={() => set(b, on ? owners.filter(o => o !== u.id) : [...owners, u.id])}><span className={`sq${on ? ' sq--on' : ''}`}/><span>{u.name}</span></button>; })}</div>}
    </div>; })}</div>
  </section>;
}

/** Documents on hold in the store; hidden while the store is unavailable. */
function Holds({ api }) {
  const { data, reload } = useLoad(() => api(`/api/v2/store/documents?${new URLSearchParams({ tag: 'on hold', pageSize: '100', sort: 'title' })}`).catch(() => null), []);
  const [busy, setBusy] = useState(null), [error, setError] = useState(null);
  if (!data) return null;
  async function lift(d) { setBusy(d.id); setError(null); try { await api(`/api/v2/store/documents/${d.id}/hold`, { method: 'POST', body: JSON.stringify({ on: false }) }); reload(); } catch (e) { setError(e.message); } finally { setBusy(null); } }
  return <section className="section" aria-label="Holds">
    <span className="label">Holds</span>
    <PageError error={error} onClose={() => setError(null)}/>
    {data.results.length ? <div className="drawers">{data.results.map(d => <div key={d.id} className="listrow" aria-label={d.title}>
      <a className="listrow__title" href={`#/documents/${d.id}`}>{d.title}</a>
      <span className="meta grey">{d.counterparty || ''}</span>
      <button type="button" className="quiet" disabled={busy !== null} onClick={() => lift(d)}>Lift hold</button>
    </div>)}</div> : <p className="body grey">No documents on hold.</p>}
  </section>;
}

export default function AdminPage({ api, team }) {
  const teamMode = team?.mode === 'team';
  const { data, error, reload, setError } = useLoad(() => Promise.all([api('/api/v2/admin/status'), teamMode ? api('/api/v2/admin/setup-codes') : [], teamMode ? api('/api/v2/admin/users') : []]), [teamMode]);
  const [busy, setBusy] = useState(''), [confirm, setConfirm] = useState(null), [note, setNote] = useState('');
  async function run(name, fn) { setBusy(name); setError(null); setNote(''); try { await fn(); reload(); } catch (e) { setError(e.message); } finally { setBusy(''); setConfirm(null); } }
  const [status, codes, users] = data || [];
  const today = new Date().toISOString().slice(0, 10);

  return <main className="page page--narrow" aria-label="Admin">
    <section className="section">
      <h1 className="page__title">Admin</h1>
      <PageError error={error} onClose={() => setError(null)}/>
      {note ? <p className="meta grey" role="status">{note}</p> : null}
    </section>
    {status && <section className="section" aria-label="Server status">
      <span className="label">{teamMode ? 'Team server' : 'This computer'}</span>
      <Status s={status} team={teamMode}/>
      <div className="actions">
        {teamMode && <button type="button" className="secondary" disabled={!!busy} onClick={() => run('mail', async () => { await api('/api/v2/admin/mail/check', { method: 'POST', body: '{}' }); setNote('Mail check started'); })}>{busy === 'mail' ? 'Checking…' : 'Check mail now'}</button>}
        {!status.retentionAdoptedOn && <button type="button" className="quiet" disabled={!!busy} onClick={() => run('retention', () => api('/api/v2/admin/retention', { method: 'PUT', body: JSON.stringify({ adoptedOn: today }) }))}>Mark retention statement adopted</button>}
      </div>
    </section>}
    {teamMode && data && <>
      <section className="section" aria-label="Setup codes">
        <span className="label">Setup codes</span>
        <IssueCode api={api} onIssued={reload}/>
        {codes.length ? <div className="drawers">{codes.map(c => <div key={c.id} className="listrow" aria-label={`Code for ${c.forName}`}>
          <span className="listrow__title">{c.forName}{c.admin ? <span className="grey"> · admin</span> : null}</span>
          <span className="meta grey">{codeState(c)}</span>
          {outstanding(c) && <button type="button" className="quiet" disabled={!!busy} onClick={() => run(`code-${c.id}`, () => api(`/api/v2/admin/setup-codes/${encodeURIComponent(c.id)}`, { method: 'DELETE' }))}>Revoke</button>}
        </div>)}</div> : null}
      </section>
      <section className="section" aria-label="People">
        <span className="label">People</span>
        <div className="drawers">{users.map(u => <div key={u.id} className="listrow listrow--two" aria-label={u.name}>
          <span className="listrow__text">
            <span className="listrow__title">{u.name}{u.admin ? <span className="grey"> · admin</span> : null}</span>
            <span className="meta grey">{u.revokedAt ? `Revoked ${day(u.revokedAt)}` : u.keys.filter(k => !k.revokedAt).map(k => k.deviceName).join(', ') || 'No device'}</span>
          </span>
          {!u.revokedAt && (confirm === u.id
            ? <button type="button" className="quiet quiet--strong" disabled={!!busy} onClick={() => run(`user-${u.id}`, () => api(`/api/v2/admin/users/${encodeURIComponent(u.id)}/revoke`, { method: 'POST', body: '{}' }))}>Confirm revoke</button>
            : <button type="button" className="quiet" disabled={!!busy || u.id === team?.user?.userId} onClick={() => setConfirm(u.id)}>Revoke</button>)}
        </div>)}</div>
        {users.length ? null : <p className="body grey">No one has joined yet.</p>}
      </section>
      <PlaybookOwners api={api} users={users} busy={busy} run={run}/>
    </>}
    {data && <Holds api={api}/>}
  </main>;
}
