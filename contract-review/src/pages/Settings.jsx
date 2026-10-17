// SPDX-License-Identifier: GPL-3.0-or-later
// Settings (#/settings[/<category>]; product v2 spec 6.2.2, PR-MODEL-01, 03, 04), laid out as a category list beside
// grouped panels (the redesign of 16 Oct 2026, board "Settings B"):
//   Reviewing  the playbooks the record holds (one per contract kind), the model in use, the record signing key.
//   Models     each way a review can reach a model and which one is in use, the model and effort, the connections
//              (the Claude CLI, the executor keys in the keychain: values go in, never come back out) and the tool check.
//   Team       joining a team with a setup code (7.10 step 3), leaving it.
//   GinBench   each benchmarked setup's error profile from the results ledger, "Not benchmarked" otherwise.
// A value the environment sets is shown, not editable. There is no "read the record" switch: inside a matter the review
// always asks to read the record (the settings API still takes review.agentic, for the benchmark and old files).
import React, { useEffect, useState } from 'react';
import { Drawer } from '../ui.jsx';
import { when, useLoad, PageError } from './shared.jsx';

export const EXECUTOR_NAMES = { claude: 'Claude CLI', anthropic: 'Anthropic API', openai: 'OpenAI-compatible', replay: 'Recorded runs (test)' };
/** How a review reaches the model, per executor: what the Models panel says under each one. */
export const EXECUTOR_HOW = { claude: 'Claude subscription · the Claude CLI on this computer', anthropic: 'Anthropic API key', openai: 'Munito or another OpenAI-compatible API · API key', replay: 'Test setup · no model is called' };
const EXECUTOR_TITLE = { claude: 'Claude', anthropic: 'Claude', openai: 'OpenAI-compatible model', replay: 'Recorded runs (test)' };
export const CATEGORIES = [['reviewing', 'Reviewing', 'R', '#1D1D1F'], ['models', 'Models', 'M', '#3A3A3C'], ['team', 'Team', 'T', '#6E6E73'], ['benchmark', 'GinBench', 'G', '#AEAEB2']];

/** A model's name as the benchmark profiles give it ("claude-opus-5-5" -> "Opus 5.5"), else its id. */
export const modelName = (id, profiles = []) => (id ? profiles.find(p => p.model === id)?.name || id : null);

function Profile({ profile }) {
  return profile.layers.map(l => <div key={l.name} className="stack profile">
    <div className="row-between"><span className="strong">{l.name}</span><span className="meta grey">{l.scope}</span></div>
    <div className="grid grid--wide">
      <span className="label grid__label">Caught</span><span className="grid__value">{l.caught}</span>
      <span className="label grid__label">Invented quotes</span><span className="grid__value">{l.inventedQuotes ?? 'Not reported'}</span>
      <span className="label grid__label">False alarms</span><span className="grid__value">{l.falseAlarms}</span>
      <span className="label grid__label">Source</span><span className="grid__value meta">results-ledger.md {l.ledger.join(', ')}<span className="run">{l.runs.join(', ')}</span></span>
    </div>
  </div>);
}

const Group = ({ label, children, foot, ...rest }) => <section className="groupwrap" {...rest}>
  {label ? <div className="label">{label}</div> : null}
  <div className="group">{children}</div>
  {foot ? <p className="foot">{foot}</p> : null}
</section>;
const Item = ({ k, children, ...rest }) => <div className="item" {...rest}>{k ? <span className="item__k">{k}</span> : null}{children}</div>;

function Team({ api, team, onChange }) {
  const [draft, setDraft] = useState({ serverUrl: team?.serverUrl || '', code: '', deviceName: '', caFile: team?.caFile || '' }), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const signedIn = team?.mode === 'team' && team.signedIn;
  async function run(fn) { setBusy(true); setError(null); try { await fn(); onChange(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const join = () => run(async () => { await api('/api/v2/local/sign-in', { method: 'POST', body: JSON.stringify(draft) }); setDraft(d => ({ ...d, code: '' })); });
  const leave = () => run(() => api('/api/v2/local/sign-out', { method: 'POST', body: '{}' }));
  return <Group label="Team server" aria-label="Team">
    {error ? <Item><PageError error={error} onClose={() => setError(null)}/></Item> : null}
    {signedIn ? <Item>
      <span className="item__k" role="status">Signed in as {team.user.name}{team.user.admin ? ' (admin)' : ''}</span>
      <span className="item__v item__v--quiet">{team.serverUrl}</span>
      <button type="button" className="secondary" onClick={leave} disabled={busy}>Sign out</button>
    </Item> : <form aria-label="Join a team" onSubmit={e => { e.preventDefault(); join(); }}>
      <Item k={<label htmlFor="team-url">Server address</label>}><div className="field"><input id="team-url" placeholder="https://" value={draft.serverUrl} onChange={e => setDraft({ ...draft, serverUrl: e.target.value })}/></div></Item>
      <Item k={<label htmlFor="team-code">Setup code</label>}><div className="field"><input id="team-code" autoComplete="off" value={draft.code} onChange={e => setDraft({ ...draft, code: e.target.value })}/></div></Item>
      <Item k={<label htmlFor="team-device">Device name</label>}><div className="field"><input id="team-device" value={draft.deviceName} onChange={e => setDraft({ ...draft, deviceName: e.target.value })}/></div></Item>
      <Item k={<label htmlFor="team-ca">CA file</label>}><div className="field"><input id="team-ca" value={draft.caFile} onChange={e => setDraft({ ...draft, caFile: e.target.value })}/></div></Item>
      <Item>
        <span className="item__k"/>
        {team?.mode === 'team' ? <button type="button" className="quiet" onClick={leave} disabled={busy}>Use solo</button> : null}
        <button className="primary primary--inline" disabled={busy || !draft.serverUrl.trim() || !draft.code.trim()}>{busy ? 'Joining…' : 'Join'}</button>
      </Item>
    </form>}
  </Group>;
}

/** One key in the keychain: Set or Not set, with Add / Replace / Remove; the value is never read back. */
function KeyRow({ api, name, label, keys }) {
  const { data, reload, setError } = keys;
  const [edit, setEdit] = useState(false), [value, setValue] = useState(''), [busy, setBusy] = useState(false);
  async function run(fn) { setBusy(true); setError(null); try { await fn(); setEdit(false); setValue(''); reload(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const set = data.set.includes(name);
  return <div className="item" aria-label={label}>
    <span className="item__k">{label}</span>
    <span className="item__v item__v--quiet">{set ? (data.store === 'keychain' ? 'Saved in the keychain' : 'Set') : 'Not set'}</span>
    {edit ? <form onSubmit={e => { e.preventDefault(); run(() => api('/api/v2/local/secrets', { method: 'PUT', body: JSON.stringify({ name, value }) })); }}>
      <input type="password" aria-label={label} autoComplete="off" value={value} autoFocus onChange={e => setValue(e.target.value)} style={{ flex: 1 }}/>
      <button className="secondary" disabled={busy || !value.trim()}>Save</button><button type="button" className="quiet" onClick={() => setEdit(false)}>Cancel</button>
    </form> : <span className="links">
      {set ? <button type="button" className="quiet" disabled={busy} onClick={() => run(() => api(`/api/v2/local/secrets/${name}`, { method: 'DELETE' }))}>Remove</button> : null}
      <button type="button" className="secondary" onClick={() => { setEdit(true); setValue(''); }}>{set ? 'Replace' : 'Add'}</button>
    </span>}
  </div>;
}

export default function SettingsPage({ api, onSaved, team = null, onTeamChange = () => {}, category = null, playbooks = [] }) {
  const { data, error, reload, setError } = useLoad(() => Promise.all([api('/api/v2/local/settings'), api('/api/v2/local/benchmarks')]), []);
  const keys = useLoad(() => api('/api/v2/local/secrets'), []);
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(''), [open, setOpen] = useState({}), [saved, setSaved] = useState(false);
  const [s, bench] = data || [];
  const cat = CATEGORIES.some(([k]) => k === category) ? category : 'reviewing';
  useEffect(() => { if (s) setDraft({ executor: s.effective.executor, model: s.effective.model || '', effort: s.effective.effort || 'medium' }); }, [s]);
  const cats = <nav className="settings__cats" aria-label="Settings categories">
    <h1 className="page__title">Settings</h1>
    {CATEGORIES.map(([k, l, ic, bg]) => <a key={k} className="cat" href={`#/settings/${k}`} aria-current={k === cat ? 'page' : undefined}><span className="cat__ic" style={{ background: bg }} aria-hidden="true">{ic}</span>{l}</a>)}
  </nav>;
  if (!s || !draft) return <main className="page" aria-label="Settings"><div className="settings">{cats}<div className="settings__panel"><PageError error={error}/></div></div></main>;

  const profiles = bench?.profiles || [];
  const locked = s.locked; const fixed = [...new Set([locked.executor, locked.model, locked.effort].filter(Boolean))];
  const change = (k, v) => { setSaved(false); setDraft(d => ({ ...d, [k]: v })); };
  const changed = Object.fromEntries(Object.entries({ executor: draft.executor, model: draft.model.trim() || null, effort: draft.effort })
    .filter(([k, v]) => !locked[k] && v !== (k === 'model' ? s.effective.model || null : s.effective[k])));
  async function run(name, fn) { setBusy(name); setError(null); try { await fn(); reload(); onSaved?.(); } catch (e) { setError(e.message); } finally { setBusy(''); } }
  const save = () => run('save', async () => { await api('/api/v2/local/settings', { method: 'PUT', body: JSON.stringify({ review: changed }) }); setSaved(true); });
  const check = () => run('check', () => api('/api/v2/local/tool-smoke', { method: 'POST', body: '{}' }));
  const current = profiles.find(p => p.model === s.effective.model) || null;
  const smoke = s.toolSmoke;
  const inUse = s.effective.executor === 'replay' ? EXECUTOR_NAMES.replay : `${modelName(s.effective.model, profiles) || EXECUTOR_TITLE[s.effective.executor] || s.effective.executor} · ${EXECUTOR_NAMES[s.effective.executor] || s.effective.executor}`;
  const envLine = fixed.length ? `Set by ${fixed.join(', ')} in the environment` : null;

  const panels = {
    reviewing: <>
      <h2>Reviewing</h2>
      <Group label="Playbooks" aria-label="Playbooks">
        {playbooks.length ? playbooks.map(p => <Item key={p.id} k={p.title}>
          <span className="item__v item__v--quiet">{Number.isInteger(p.changeCount) ? `Change ${p.changeCount}` : ''}</span>
          <a className="quiet" href={`#/playbook/${encodeURIComponent(p.id)}`}>Open</a>
        </Item>) : <Item k="No playbooks in the record"/>}
      </Group>
      <Group label="Model" aria-label="Model in use">
        <Item k="Reviews use"><span className="item__v item__v--quiet">{inUse}</span><a className="quiet" href="#/settings/models">Models</a></Item>
      </Group>
      {keys.data ? <Group label="Record" foot={keys.data.note}>
        <KeyRow api={api} name="record-signing-key" label="Record signing key" keys={keys}/>
        {keys.error ? <Item><PageError error={keys.error} onClose={() => keys.setError(null)}/></Item> : null}
      </Group> : null}
    </>,
    models: <>
      <h2>Models</h2>
      <form aria-label="Review setup" onSubmit={e => { e.preventDefault(); save(); }}>
        <Group label="Reviews use" aria-label="Reviews use" foot={envLine}>
          <div role="radiogroup" aria-label="Executor">
            {/* Replay (recorded runs) is test infrastructure, not a model a lawyer picks: listed only while the environment runs it (REVIEW_EXECUTOR=replay). */}
            {[...new Set([...s.executors, draft.executor])].filter(x => x !== 'replay' || s.effective.executor === 'replay').map(x => {
              const on = draft.executor === x;
              const title = on && x !== 'replay' ? modelName(draft.model.trim() || (x === s.effective.executor ? s.effective.model : null), profiles) || EXECUTOR_TITLE[x] : EXECUTOR_TITLE[x] || x;
              return <button key={x} type="button" role="radio" aria-checked={on} aria-label={EXECUTOR_NAMES[x] || x} className="item item--btn model" disabled={!!locked.executor} onClick={() => change('executor', x)}>
                <span className={`model__ic ${x === 'openai' ? 'model__ic--other' : x === 'replay' ? 'model__ic--replay' : ''}`} aria-hidden="true">{x === 'openai' ? 'O' : x === 'replay' ? 'R' : 'C'}</span>
                <span className="model__text"><span>{title}</span><span className="model__how">{EXECUTOR_HOW[x] || x}</span></span>
                {on ? <span className="model__on" aria-hidden="true">✓</span> : null}
              </button>;
            })}
          </div>
          {draft.executor === 'replay' ? null : <Item k={<label htmlFor="set-model">Model</label>}><div className="field" style={{ maxWidth: 260 }}><input id="set-model" value={draft.model} disabled={!!locked.model} onChange={e => change('model', e.target.value)}/></div></Item>}
          <Item k={<label htmlFor="set-effort">Effort</label>}>
            <select id="set-effort" className="select" value={draft.effort} disabled={!!locked.effort} onChange={e => change('effort', e.target.value)}>{s.efforts.map(x => <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>)}</select>
          </Item>
          <Item>
            <span className="item__k">{saved && !Object.keys(changed).length ? <span className="item__v--quiet" role="status">Saved</span> : null}</span>
            <button className="primary primary--inline" disabled={!!busy || !Object.keys(changed).length}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          </Item>
        </Group>
      </form>
      <Group label="Connections" aria-label="Connections" foot={keys.data?.note || 'A subscription runs reviews through the Claude CLI on this computer. A key sends them to the provider directly.'}>
        <Item k="Claude subscription"><span className={`item__v ${s.effective.executor === 'claude' && s.effective.available !== false ? 'item__v--fine' : 'item__v--quiet'}`}>{s.effective.executor !== 'claude' ? 'Not in use' : s.effective.available === false ? s.effective.reason : 'Claude CLI found'}</span></Item>
        {keys.data ? <>
          <KeyRow api={api} name="anthropic-key" label="Anthropic API key" keys={keys}/>
          <KeyRow api={api} name="openai-key" label="OpenAI-compatible key (Munito)" keys={keys}/>
        </> : null}
        {keys.error ? <Item><PageError error={keys.error} onClose={() => keys.setError(null)}/></Item> : null}
      </Group>
      <Group label="Tool check" aria-label="Tool check">
        <Item k="Result"><span className="item__v item__v--quiet">{smoke ? `${smoke.passed ? 'Passed' : 'Failed'} · ${when(smoke.at)} · ${smoke.toolCalls} ${smoke.toolCalls === 1 ? 'lookup' : 'lookups'}${smoke.error ? ` · ${smoke.error}` : ''}` : 'Not run'}</span></Item>
        <Item k="Record tools"><span className="item__v item__v--quiet">{!s.review.agentic ? 'Off' : s.toolsSupported ? 'Used' : 'Not used: single call'}</span></Item>
        {s.effective.available === false && s.effective.reason ? <Item k="Setup"><span className="item__v item__v--quiet">{s.effective.reason}</span></Item> : null}
        <Item><span className="item__k"/><button type="button" className="secondary" onClick={check} disabled={!!busy || s.effective.available === false}>{busy === 'check' ? 'Checking…' : 'Run check'}</button></Item>
      </Group>
    </>,
    team: <>
      <h2>Team</h2>
      <Team key={`${team?.mode}-${team?.signedIn}-${team?.signedOut}`} api={api} team={team} onChange={() => { onTeamChange(); reload(); }}/>
    </>,
    benchmark: <>
      <h2>GinBench</h2>
      <section className="groupwrap" aria-label="GinBench">
        {!current && <p className="body" data-testid="current-benchmark" style={{ paddingLeft: 16 }}>{s.effective.executor === 'replay' ? EXECUTOR_NAMES.replay : s.effective.model || EXECUTOR_NAMES[s.effective.executor]}: Not benchmarked</p>}
        <div className="drawers">{profiles.map(p => <Drawer key={p.model} name={p.name} sum={[p.model, p.effort, p === current ? 'In use' : null].filter(Boolean).join(' · ')} open={open[p.model]} onToggle={() => setOpen(o => ({ ...o, [p.model]: !o[p.model] }))}>
          <Profile profile={p}/>
        </Drawer>)}</div>
      </section>
    </>,
  };

  return <main className="page" aria-label="Settings">
    <div className="settings">
      {cats}
      <div className="settings__panel">
        <PageError error={error} onClose={() => setError(null)}/>
        {panels[cat]}
      </div>
    </div>
  </main>;
}
