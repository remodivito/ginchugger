// SPDX-License-Identifier: GPL-3.0-or-later
// A document's labels as one group of rows (Inbox and the document page; plan tasks 4 and 6): title, counterparty,
// type, date and tags, each editable in place, with the store's existing names offered. Typing a new name makes a new
// one when saved (as Paperless does). The "on hold" tag is shown to everyone but only an admin adds or removes it.
import React, { useState } from 'react';
import { TAG_HOLD } from './store-view.js';

const lc = s => String(s ?? '').toLowerCase();

export default function Labels({ value, onChange, taxonomy, canHold = false, id = 'labels', disabled = false }) {
  const [tagDraft, setTagDraft] = useState('');
  const set = (k, v) => onChange({ ...value, [k]: v });
  const has = t => value.tags.some(x => lc(x) === lc(t));
  const addTag = name => {
    const t = String(name || '').trim();
    setTagDraft('');
    if (!t || has(t) || (lc(t) === TAG_HOLD && !canHold)) return;
    set('tags', [...value.tags, (taxonomy?.tags || []).find(x => lc(x) === lc(t)) || t]);
  };
  const offered = (taxonomy?.tags || []).filter(t => lc(t) !== 'inbox' && !has(t) && (canHold || lc(t) !== TAG_HOLD));
  return <div className="group labels" role="group" aria-label="Labels">
    <label className="item"><span className="item__k">Title</span><input aria-label="Title" value={value.title} disabled={disabled} onChange={e => set('title', e.target.value)}/></label>
    <label className="item"><span className="item__k">Counterparty</span><input aria-label="Counterparty" list={`${id}-cp`} value={value.counterparty} placeholder="None" disabled={disabled} onChange={e => set('counterparty', e.target.value)}/></label>
    <label className="item"><span className="item__k">Type</span><input aria-label="Type" list={`${id}-type`} value={value.type} placeholder="None" disabled={disabled} onChange={e => set('type', e.target.value)}/></label>
    <label className="item"><span className="item__k">Date</span><input aria-label="Date" type="date" value={value.created} disabled={disabled} onChange={e => set('created', e.target.value)}/></label>
    <div className="item item--tags">
      <span className="item__k">Tags</span>
      <span className="tagset">
        {value.tags.map(t => <span key={t} className="tagchip">{t}{(lc(t) !== TAG_HOLD || canHold) && !disabled ? <button type="button" aria-label={`Remove ${t}`} onClick={() => set('tags', value.tags.filter(x => x !== t))}>×</button> : null}</span>)}
        <input aria-label="Add tag" className="tagset__add" list={`${id}-tags`} value={tagDraft} placeholder="Add tag" disabled={disabled}
          onChange={e => { const v = e.target.value; if (offered.some(t => t === v)) addTag(v); else setTagDraft(v); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagDraft); } }} onBlur={() => tagDraft && addTag(tagDraft)}/>
      </span>
    </div>
    <datalist id={`${id}-cp`}>{(taxonomy?.counterparties || []).map(n => <option key={n} value={n}/>)}</datalist>
    <datalist id={`${id}-type`}>{(taxonomy?.types || []).map(n => <option key={n} value={n}/>)}</datalist>
    <datalist id={`${id}-tags`}>{offered.map(n => <option key={n} value={n}/>)}</datalist>
  </div>;
}
