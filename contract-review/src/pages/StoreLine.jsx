// SPDX-License-Identifier: GPL-3.0-or-later
// One line when the document store cannot be used (tasks/paperless-store-plan.md task 1): read from
// /api/v2/store/status on start and on every page change. Nothing shows while it starts, when it is ready, or when the
// store is off. Without Docker the solo app runs the built-in store, and the line says so and what that means. Phase 2 puts the store's screens behind the same status.
import React, { useEffect, useState } from 'react';
import { plainMessage } from '../../shared/plain-error.js';

export default function StoreLine({ api, page }) {
  const [status, setStatus] = useState(null);
  useEffect(() => { let live = true; api('/api/v2/store/status').then(s => { if (live) setStatus(s); }).catch(() => {}); return () => { live = false; }; }, [page]);
  if (status?.state === 'ready' && status.builtIn) return <p className="teamline" role="status" title={status.builtIn}><span>Document store: built-in ({builtInWhy(status.builtIn)}) · documents are kept until the app stops</span></p>;
  if (status?.state !== 'unavailable') return null;
  // The reason is shown when it is written for people ("Docker is not installed."); a raw one stays in the log
  // (readiness audit, 17 Oct 2026: a first start without Docker said only "unavailable" and "try again in a moment").
  const reason = status.reason ? plainMessage(status.reason, '') : '';
  return <p className="teamline" role="status" title={status.reason || undefined}><span>Document store unavailable{reason ? ` · ${reason}` : ''}</span></p>;
}

/** "Docker is not installed." → "Docker not found"; "Docker is not running." → "Docker not running". */
export const builtInWhy = reason => (/not running/i.test(reason || '') ? 'Docker not running' : 'Docker not found');
