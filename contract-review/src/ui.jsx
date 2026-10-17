// SPDX-License-Identifier: GPL-3.0-or-later
// The two components the pane and the pages share (docs/DESIGN-SYSTEM.md): the chevron, the only icon, and the drawer,
// a row that says what is inside and opens in place.
import React from 'react';

export function Chevron({ dir }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={dir === 'left' ? 'M10 3 5 8l5 5' : dir === 'down' ? 'm3 6 5 5 5-5' : 'm6 3 5 5-5 5'}/></svg>;
}

export function Drawer({ name, sum, open, onToggle, children }) {
  return <>
    <button type="button" className="drawer" aria-expanded={!!open} onClick={onToggle}><span className="drawer__text"><span className="drawer__name">{name}</span>{sum || sum === 0 ? <span className="drawer__sum">· {sum}</span> : null}</span><Chevron dir={open ? 'down' : 'right'}/></button>
    {open && <div className="drawer__body">{children}</div>}
  </>;
}

/** A file's name as a lawyer reads it: without the extension. */
export const plainName = n => String(n || '').replace(/\.(docx|eml|txt|md|pdf|xlsx)$/i, '');
