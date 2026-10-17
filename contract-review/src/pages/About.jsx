// SPDX-License-Identifier: GPL-3.0-or-later
// About: what the prototype is, where data goes, and the developer detail the review screens leave out (decision 126):
// the engine, executor and model, the prompt hash, and whether the last review read the record.
import React from 'react';
import { LIMITS_LINE } from '../review/Pane.jsx';

const when = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const short = h => (h ? String(h).slice(0, 12) : null);

function Grid({ rows }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  return <div className="grid grid--wide">{shown.map(([k, v]) => <React.Fragment key={k}><span className="label grid__label">{k}</span><span className="grid__value body">{v}</span></React.Fragment>)}</div>;
}

export default function AboutPage({ status, review }) {
  const meta = review?.model || {};
  return <main className="page page--narrow" aria-label="About">
    <section className="section">
      <h1 className="page__title">About</h1>
      <p className="body-l">GinChugger is a prototype AI-assisted contract review tool for in-house legal teams. The model reviews; the lawyer decides. Nothing is approved, sent or applied without an explicit action.</p>
      <p className="body">{LIMITS_LINE}</p>
    </section>
    <section className="section">
      <span className="label">Engine</span>
      <Grid rows={[
        [status?.executor === 'replay' ? 'Recorded runs (test)' : 'Live AI', `${status?.executor === 'replay' ? 'Test setup: plays recorded runs from disk. No model call.' : `The server's configured executor${status?.executor ? ` (${status.executor}${status.model ? `, ${status.model}` : ''})` : ''}.`}${status && !status.liveAvailable && status.reason ? ` Not available: ${status.reason}` : ''}`],
      ]}/>
    </section>
    {review && <section className="section">
      <span className="label">Last review</span>
      <Grid rows={[
        ['Engine', meta.executor === 'replay' ? 'Recorded runs (test)' : 'Live AI'],
        ['Executor', [meta.executor, meta.model, meta.effort].filter(Boolean).join(' · ') || null],
        ['Prompt', meta.promptFile ? `${meta.promptFile}${meta.promptSha256 ? ` · sha256 ${short(meta.promptSha256)}…` : ''}` : null],
        ['Duration', meta.seconds ? `${meta.seconds} s` : null],
        ['Playbook', review.playbook ? `${review.playbook.title} v${review.playbookVersion}` : null],
        ['Record', meta.agentic ? `Read through tools · ${meta.toolCalls || 0} ${meta.toolCalls === 1 ? 'call' : 'calls'}` : null],
        ['Run', when(review.createdAt)],
      ]}/>
    </section>}
    <section className="section">
      <span className="label">Data</span>
      <p className="body">Documents you open are processed by this local server. The team's documents are kept in the document store (Paperless-ngx, on this computer in solo mode, on the team machine in team mode); the playbook and people are in the app's own record, and the review history (what was applied or dismissed, and why) in its review-history database. No analytics connection exists. A live model receives the document, the playbook, the comparison version and what it reads from the counterparty's other documents in the store.</p>
    </section>
  </main>;
}
