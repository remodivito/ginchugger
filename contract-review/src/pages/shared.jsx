// SPDX-License-Identifier: GPL-3.0-or-later
// What the browser pages (slice S6) share: dates as a lawyer reads them, actor names, a loader for one page's reads and
// a page's error line. (The record's outcome and side names, page links and position rows went with decision 190.)
import React, { useCallback, useEffect, useState } from 'react';

export const when = iso => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const day = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/**
 * Actor ids as names (slice S7): members' names from the record, "Mailbox" and "Watched folder" for the server's own
 * captures; anything else (the computer's user name in solo mode) shows as it is. Read once per page.
 */
export function useActors(api, refresh = null) {
  const [names, setNames] = useState({});
  useEffect(() => { let live = true; api('/api/v2/actors').then(n => live && setNames(n || {})).catch(() => {}); return () => { live = false; }; }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  return id => (id ? names[id] || id : '');
}

/** Load what a page reads; `reload` reads again. */
export function useLoad(load, deps) {
  const [data, setData] = useState(null), [error, setError] = useState(null);
  const run = useCallback(() => { let live = true; setError(null); load().then(d => live && setData(d)).catch(e => live && setError(e.message)); return () => { live = false; }; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(run, [run]);
  return { data, error, reload: run, setError };
}

export function PageError({ error, onClose }) {
  if (!error) return null;
  return <p className="page-error page-error--inline" role="alert"><span>{error}</span>{onClose && <button type="button" className="quiet" onClick={onClose}>Close</button>}</p>;
}
