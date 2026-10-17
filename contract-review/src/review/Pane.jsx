// SPDX-License-Identifier: GPL-3.0-or-later
// The review pane (decision 184, 16 Oct 2026: "the word pane has one purpose"). One component for the Word task pane
// and the browser's review column. Its one job: review this draft against the playbook, then apply or dismiss each
// point; plus Ask (Ask C, 17 Oct 2026): a second tab with the document's questions, asked from the floating bar. On
// the store (task 8) the host finds the open document in the store, or adds it to the inbox, before the review: one line says its counterparty and type and opens its Document page;
// nothing is asked. Labels, playbook edits and everything else live in the web app. Nothing here decides anything:
// every action is a callback the host wires to an explicit lawyer action.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { worstFirst, diffExcerpt, quoteExcerpt, applicableText, optionReply, leadSentences, planEdits, notVerified, passageFor } from './model.js';
import { Markdown } from './markdown.js';

const paraNo = id => (/^p(\d+)$/.exec(id || '') || [])[1];

// The pane's limits (PR-PANE-08). Since decision 184 the line is stated on the About page only.
export const LIMITS_LINE = 'Findings are the model’s reading, checked for exact quotes, not legal advice; counterparty text can carry instructions the model may follow.';

/** A point's severity as a dot: attention (push back), context (check), within guidance (fine); grey once done. */
const Dot = ({ status }) => <span className={`dot dot--${['attention', 'context', 'within-guidance', 'done'].includes(status) ? status : 'context'}`} aria-hidden="true"/>;
const Square = ({ on }) => <span className={`sq ${on ? 'sq--on' : ''}`} aria-hidden="true"/>;
const DONE = { applied: 'Applied', dismissed: 'Dismissed', reviewed: 'Reviewed', chosen: 'Recorded' };
/** A dismissed point says why (audit finding 1): not an issue (the model was wrong), or their wording accepted. The row
 * says it; the reopened card does not repeat it (UX audit, 17 Oct 2026). */
const doneWord = o => (o.kind === 'dismissed' && o.reason === 'accepted' ? 'Accepted' : o.kind === 'dismissed' && o.reason === 'not-an-issue' ? 'Not an issue' : DONE[o.kind] || 'Done');

/** Words from the contract with our change drawn in. */
function Parts({ excerpt }) {
  if (!excerpt) return null;
  return <p className="quote">{excerpt.lead ? '…' : ''}{excerpt.parts.map((p, i) => p.kind === 'add' ? <ins key={i}>{p.text}</ins> : p.kind === 'del' ? <del key={i}>{p.text}</del> : <React.Fragment key={i}>{p.text}</React.Fragment>)}{excerpt.trail ? '…' : ''}</p>;
}

export default function Pane(props) {
  const { surface, title, phase, review, outcomes = {}, selectedId, onSelect, busy, error, storeDoc } = props;
  const findings = review?.findings || [];
  const list = useMemo(() => worstFirst(findings), [findings]);
  const done = list.filter(f => outcomes[f.id]).length;
  const [question, setQuestion] = useState('');
  const [choosingBook, setChoosingBook] = useState(false), [coverageOpen, setCoverageOpen] = useState(false);
  const [started, setStarted] = useState(null);
  // A finished point opened again to read (one at a time), and the one whose Undo was last asked for (its message shows there).
  const [reopened, setReopened] = useState(null), [undoing, setUndoing] = useState(null);
  const [, tick] = useState(0);
  const tab = props.tab === 'ask' ? 'ask' : 'review';
  const asks = props.asks || [];
  const progress = props.progress || null;
  useEffect(() => { if (busy === 'review') { setStarted(Date.now()); const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); } setStarted(null); }, [busy]);

  /** After a decision, the next open point below it opens (or the first open one above); none when all are done. */
  const advance = f => {
    const at = list.indexOf(f);
    const next = list.find((x, i) => i > at && !outcomes[x.id]) || list.find(x => x.id !== f.id && !outcomes[x.id]);
    onSelect(next ? next.id : null);
  };

  // Header D (17 Oct 2026): the wordmark and the playbook, the document's title, and one segment per point, filled as
  // points are done; the count is said in words for screen readers ("2 of 5 done").
  const counted = phase === 'review' && list.length;
  const header = <header className="pane__header">
    <div className="pane__brand">
      <span className="pane__mark" aria-hidden="true">GinChugger</span>
      {props.playbookLabel ? <span className="pane__book" title={`Playbook · ${props.playbookLabel}`}>Playbook · {props.playbookLabel}</span> : null}
    </div>
    <div className="pane__doc" title={title}>{title}</div>
    {counted ? <div className="pane__progress">
      <div className="pane__segs" aria-hidden="true">{list.map((f, i) => <span key={f.id} className={i < done ? 'on' : ''}/>)}</div>
      <span className="pane__done sr-only">{done} of {list.length} done</span>
    </div> : null}
  </header>;
  // Ask C: Review and Ask as two tabs under the header; asking from Review opens Ask.
  const tabs = <div className="seg pane__tabs" role="tablist" aria-label="Pane">
    <button type="button" role="tab" id="tab-review" aria-controls="panel-review" aria-selected={tab === 'review'} onClick={() => props.onTab?.('review')}>{counted ? `Review · ${done} of ${list.length}` : 'Review'}</button>
    <button type="button" role="tab" id="tab-ask" aria-controls="panel-ask" aria-selected={tab === 'ask'} onClick={() => props.onTab?.('ask')}>Ask</button>
  </div>;

  // A running review (17 Oct 2026): the time so far and Stop, the same control as Ask's; a stopped review says so once.
  const reviewing = busy === 'review';
  const elapsed = started ? Math.floor((Date.now() - started) / 1000) : 0;
  const reviewClock = <span className="elapsed">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>;
  const stopReview = reviewing && props.onStopReview ? <button type="button" className="askbar__go" aria-label="Stop" onClick={props.onStopReview}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor"/></svg></button> : null;
  // One status line (7.4, R6.6): a review running again, with Stop, or just stopped; the document or playbook changed
  // since the review, with the only Review again; else a batch of events the record refused, with Retry; else a review
  // that could not read the record.
  const rl = props.recordLine;
  const status = phase === 'review' && reviewing ? <div className="pane__status" role="status">
    <span>Reviewing {reviewClock}</span>{stopReview}
  </div> : phase === 'review' && props.reviewStopped ? <div className="pane__status" role="status">
    <span>Review stopped.</span>
    <button type="button" className="link" onClick={props.onReviewAgain} disabled={!!busy}>Review again</button>
  </div> : phase === 'review' && (props.wordChanged || props.stale) ? <div className="pane__status" role="status">
    <span>{props.stale === 'playbook' ? 'Playbook changed' : 'Document changed'}</span>
    <button type="button" className="link" onClick={props.onReviewAgain} disabled={!!busy}>Review again</button>
  </div> : phase === 'review' && rl ? <div className="pane__status" role="status">
    <span>{rl.text}</span>{rl.action && <button type="button" className="link" onClick={rl.onAction} disabled={!!busy}>{rl.action}</button>}
  </div> : null;

  // What the review did not check (audit finding 3): one grey line under the header, opening to the rules no point was
  // reported on and the parts of the document not read.
  const cov = phase === 'review' ? props.coverage : null;
  const coverage = cov ? <div className="pane__coverage">
    <button type="button" className="link" aria-expanded={coverageOpen} onClick={() => setCoverageOpen(!coverageOpen)}>{cov.line}</button>
    {coverageOpen && <ul className="pane__coverage-list" aria-label="Not checked">
      {cov.rules.map(r => <li key={r.id}>{r.title} · not reported on</li>)}
      {cov.parts.map(p => <li key={p}>{p[0].toUpperCase() + p.slice(1)} · not read</li>)}
      {cov.unverified.length ? <li>{cov.unverified.length} point{cov.unverified.length === 1 ? '' : 's'} with a quote or citation not verified</li> : null}
    </ul>}
  </div> : null;

  const pointError = error && ['apply', 'undo', 'locate'].includes(error.name) ? error.message : null;
  const askError = error?.name === 'ask' ? error.message : null;
  const otherError = error && !pointError && !askError ? error.message : null;
  const open = list.find(f => f.id === selectedId && !outcomes[f.id]) || null;
  const undoError = pointError && error.name === 'undo' && outcomes[undoing] ? pointError : null;
  const undo = f => { setUndoing(f.id); setReopened(null); props.onUndo(f); };
  // A greyed row opens a read-only card; opening it closes the open point, and opening any other row closes it.
  const toggle = f => { if (reopened === f.id) { setReopened(null); return; } setReopened(f.id); if (open) onSelect(null); };

  let body;
  if (phase !== 'review') {
    const running = reviewing;
    const label = running ? <>Reviewing {reviewClock}</>
      : busy === 'open' || busy === 'import' ? 'Reading the document' : 'Review';
    // One line under Review (UX taste call 1, 17 Oct 2026): the document's counterparty and type, opening its Document
    // page (with no store, nothing is said about one), then Change playbook. The playbook itself is named once, in
    // header D; with none inferred the line says "Choose a playbook" and the choice opens (audit finding 2: no silent NDA).
    const books = props.playbooks || [];
    const book = books.find(b => b.id === props.playbookId);
    const party = storeDoc ? <span className="pane__store">
      <button type="button" className="link" onClick={() => props.onOpenDocument?.(storeDoc.id)}>{[storeDoc.counterparty, storeDoc.type].filter(Boolean).join(' · ') || 'No counterparty'}</button>
    </span> : null;
    const bookControl = !books.length ? null : book
      ? <button type="button" className="link" aria-expanded={choosingBook} onClick={() => setChoosingBook(!choosingBook)} disabled={!!busy}>Change playbook</button>
      : <span>Choose a playbook</span>;
    const ctxLine = <>
      {party || bookControl ? <p className="meta grey pane__ctx">{party}{party && bookControl ? <span aria-hidden="true">·</span> : null}{bookControl}</p> : null}
      {books.length && (choosingBook || !book) ? <div className="choices pane__books" role="radiogroup" aria-label="Playbook">{books.map(b => <button key={b.id} type="button" role="radio" className="choice" aria-checked={b.id === props.playbookId} disabled={!!busy} onClick={() => { props.onChoosePlaybook?.(b.id); setChoosingBook(false); }}><Square on={b.id === props.playbookId}/><span>{b.title}</span></button>)}</div> : null}
    </>;
    // No model route works yet (a first start: /api/status says liveAvailable false): one line that says where to set one up,
    // instead of an error after Review. The Word pane cannot open the app's pages, so it names them.
    const setupLine = props.needsModel ? <p className="meta grey pane__ctx pane__setup" role="status">{surface === 'word' ? <span>No model set up yet · open Settings · Models in the browser app</span> : <><span>No model set up yet</span><span aria-hidden="true">·</span><a className="link" href="#/settings/models">Settings · Models</a></>}</p> : null;
    body = <div className="start">
      <div className="start__run">
        <button type="button" className={`primary ${running || ['open', 'import'].includes(busy) ? 'primary--busy' : ''}`} onClick={props.onReview} disabled={!props.canReview || !!busy}>{label}</button>
        {stopReview}
      </div>
      {ctxLine}
      {!busy && props.reviewStopped ? <p className="meta grey pane__ctx" role="status">Review stopped.</p> : null}
      {setupLine}
    </div>;
  } else {
    body = <ul className="points" aria-label="Points">
      {list.map(f => {
        const name = f.title || props.headingFor?.(f) || 'Point';
        const o = outcomes[f.id];
        if (o) {
          const expanded = reopened === f.id;
          return <li key={f.id} className={`prow prow--done ${expanded ? 'prow--open' : ''}`}>
            <div className="prow__line">
              <button type="button" className="prow__toggle" aria-expanded={expanded} onClick={() => toggle(f)}><Dot status="done"/><span className="prow__title">{name}</span><span className="prow__state">{doneWord(o)}</span></button>
              {!expanded && <button type="button" className="link" onClick={() => undo(f)} disabled={!!busy}>Undo</button>}
            </div>
            {o.warning && <p className="prow__note" role="status">{o.warning}</p>}
            {o.reply && <p className="prow__note" role="status">{o.reply}</p>}
            {expanded && <Finished f={f} o={o} busy={busy} onUndo={() => undo(f)} onOpenEvidence={props.onOpenEvidence}/>}
            {undoError && undoing === f.id && <p className="pane__error prow__error" role="alert">{undoError}</p>}
          </li>;
        }
        if (f === open) return <Point key={f.id} {...props} f={f} name={name} error={pointError} onDone={() => advance(f)}/>;
        return <li key={f.id}><button type="button" className="prow" aria-expanded="false" onClick={() => { setReopened(null); onSelect(f.id); }}><span className="prow__line"><Dot status={f.status}/><span className="prow__title">{name}</span>{notVerified(f) ? <span className="tag tag--warn">Not verified</span> : null}</span></button></li>;
      })}
      {!findings.length && <li className="prow"><span className="prow__line grey">Nothing found.</span></li>}
    </ul>;
    // Every point handled: the one closing action, saving the version that goes back as a new document of the same
    // counterparty and type (decision 185 on the store: no round, no question).
    if (props.onSaveReply && list.length && done === list.length) body = <>{body}
      <div className="save-reply">
        {props.saved ? <p className="meta" role="status">Saved to Library · <button type="button" className="link" onClick={() => props.onOpenDocument?.(props.saved.id)}>Open</button></p>
          : <button type="button" className={`primary ${busy === 'record' ? 'primary--busy' : ''}`} onClick={props.onSaveReply} disabled={!!busy}>Save as our reply</button>}
      </div></>;
  }

  const running = !!progress;
  const ask = e => { e.preventDefault(); if (question.trim() && !busy) { props.onAsk(question); setQuestion(''); } };
  const askNow = q => { if (!busy) props.onAsk(q); };
  const suggestions = (props.suggestions || []).filter(q => !asks.some(a => a.question === q));
  // On Review, one suggested question above the bar until something is asked (task 8); on Ask, the chips sit in the thread.
  const chipOnReview = tab === 'review' && !asks.length && !busy && !question ? suggestions[0] : null;
  return <section className={`pane pane--${surface || 'browser'}`} aria-label="Review">
    {header}
    {tabs}
    {tab === 'review' && status}
    {tab === 'review' && coverage}
    {tab === 'review' ? <div className="pane__middle" role="tabpanel" id="panel-review" aria-labelledby="tab-review">
      {otherError && <p className="pane__error" role="alert">{otherError}</p>}
      {body}
      {pointError && !open && !undoError && <p className="pane__error" role="alert">{pointError}</p>}
    </div> : <div className="pane__middle" role="tabpanel" id="panel-ask" aria-labelledby="tab-ask">
      {otherError && <p className="pane__error" role="alert">{otherError}</p>}
      <AskThread asks={asks} progress={progress} error={askError} suggestions={!running && !busy && (!asks.length || asks[asks.length - 1].answer) ? suggestions : []} onAsk={askNow} onOpenEvidence={props.onOpenEvidence} onOpenDocument={props.onOpenDocument}/>
    </div>}
    <div className="askwrap">
      {props.selection ? <div className="selchip" role="group" aria-label="Selection">
        <span className="selchip__text">“{props.selection}” selected</span>
        <button type="button" className="selchip__x" aria-label="Clear selection" onClick={props.onClearSelection}>×</button>
      </div> : chipOnReview && <button type="button" className="askchip" onClick={() => askNow(chipOnReview)}>{chipOnReview}</button>}
      <form className="askbar" onSubmit={ask}>
        <input aria-label="Ask about this draft" placeholder="Ask about this draft" value={question} onChange={e => setQuestion(e.target.value)}/>
        {running ? <button type="button" className="askbar__go" aria-label="Stop" onClick={props.onStop}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor"/></svg></button>
          : <button type="submit" className="askbar__go" aria-label="Ask" disabled={!question.trim() || !!busy}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M2.5 6.5 7 2l4.5 4.5"/></svg>
          </button>}
      </form>
    </div>
  </section>;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const clock = s => (s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/**
 * The Ask tab (Ask C): the document's questions, oldest first, each with its answer and its sources behind one control;
 * the question being answered shows its steps as they happen, with the time so far. Suggested questions follow.
 */
function AskThread({ asks, progress, error, suggestions, onAsk, onOpenEvidence, onOpenDocument }) {
  const endRef = useRef(null);
  const last = asks[asks.length - 1];
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [asks.length, last?.answer, last?.error, progress?.steps?.length]);
  return <div className="thread">
    {asks.map(a => <AskEntry key={a.id} entry={a} progress={progress?.id === a.id ? progress : null} onOpenEvidence={onOpenEvidence} onOpenDocument={onOpenDocument}/>)}
    {error && <p className="pane__error" role="alert">{error}</p>}
    {suggestions.length ? <div className="chips" role="group" aria-label="Suggested questions">{suggestions.map(q => <button key={q} type="button" className="chip" onClick={() => onAsk(q)}>{q}</button>)}</div> : null}
    <div ref={endRef} className="thread__end"/>
  </div>;
}

function AskEntry({ entry, progress, onOpenEvidence, onOpenDocument }) {
  const [open, setOpen] = useState(null); // 'sources' | 'notes' | null
  const a = entry.answer;
  const evidence = a?.evidence || [], sources = a?.sources || [], limits = a?.limits || [];
  const count = evidence.length + sources.length;
  return <article className="qa" aria-label={entry.question}>
    <p className="qa__q">{entry.question}</p>
    {entry.selection ? <p className="qa__sel">“{entry.selection}”</p> : null}
    {progress ? <Progress progress={progress}/>
      : entry.error ? <p className="pane__error" role="alert">{entry.error}</p>
      : entry.stopped ? <p className="meta grey">Stopped</p>
      : a ? <>
        <Markdown text={a.answer || a.text || a.explanation} className="md qa__a" cites={{ evidence, sources, onOpenEvidence }}/>
        {a.unchecked ? <p className="meta grey">This answer’s sources could not be checked.</p> : null}
        {count || limits.length ? <div className="qa__more">
          {count ? <button type="button" className="link" aria-expanded={open === 'sources'} onClick={() => setOpen(open === 'sources' ? null : 'sources')}>{plural(count, 'source')}</button> : null}
          {limits.length ? <button type="button" className="link" aria-expanded={open === 'notes'} onClick={() => setOpen(open === 'notes' ? null : 'notes')}>{plural(limits.length, 'note')}</button> : null}
        </div> : null}
        {open === 'sources' && <ul className="sources" aria-label="Sources">
          {evidence.map((e, i) => <li key={`e${i}`} className="source">
            <span className="source__head"><span className="source__title">This draft</span>{paraNo(e.paragraphId) ? <span className="grey"> · ¶ {paraNo(e.paragraphId)}</span> : null}{e.verified === false ? <span className="tag tag--warn">Not verified</span> : null}</span>
            <p className="quote quote--s">“{e.quote}”</p>
            <button type="button" className="link" onClick={() => onOpenEvidence?.(e)}>Show in document</button>
          </li>)}
          {sources.map((c, i) => <li key={`s${i}`} className="source">
            <span className="source__head"><span className="source__title">{c.title || `Document ${c.documentId}`}</span>{c.date ? <span className="grey"> · {c.date}</span> : null}{c.otherCounterparty ? <span className="tag tag--warn">Other counterparty · {c.counterparty}</span> : null}{c.verified ? null : <span className="tag tag--warn">Not verified</span>}</span>
            <p className="quote quote--s">“{c.quote}”</p>
            {c.documentId ? <button type="button" className="link" onClick={() => onOpenDocument?.(c.documentId)}>Open document</button> : null}
          </li>)}
        </ul>}
        {open === 'notes' && <ul className="sources sources--notes" aria-label="Notes">{limits.map((l, i) => <li key={i} className="meta grey">{l}</li>)}</ul>}
      </> : null}
  </article>;
}

/** What Ask is doing now: each step as it starts (spinner) and ends (tick), then the time so far. */
function Progress({ progress }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
  const steps = progress.steps || [];
  const active = steps.some(s => s.state === 'active');
  const elapsed = Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1000));
  return <div className="progress" role="status" aria-label="Progress">
    <ol className="progress__steps">
      {steps.map(s => <li key={s.id} className={`step step--${s.state}`}><span className="step__icon" aria-hidden="true"/>{s.text}</li>)}
      {!active && <li className="step step--active"><span className="step__icon" aria-hidden="true"/>{steps.length ? 'Writing the answer' : 'Working…'}</li>}
    </ol>
    <span className="progress__time">{clock(elapsed)}</span>
  </div>;
}

/**
 * A finished point opened again to read: what was wrong, what was applied (before and after, as on the open card), the
 * passage with Show in document, and Undo (why it was dismissed is on its row). Nothing here can be edited.
 */
function Finished({ f, o, busy, onUndo, onOpenEvidence }) {
  const lead = leadSentences(String(f.explanation || '').trim());
  const quote = passageFor(f);
  const ev = (f.evidence || []).find(e => e.quote === quote) || { quote, paragraphId: f.paragraphId };
  const applied = o.kind === 'applied';
  const excerpts = applied ? [
    typeof o.before === 'string' && typeof o.text === 'string' ? diffExcerpt(o.before, o.text, { lead: 14, trail: 10, limit: 2000 }) || quoteExcerpt(o.text, { limit: 2000 }) : null,
    ...(o.added || []).map(t => ({ parts: [{ text: t, kind: 'add' }] })),
  ].filter(Boolean) : [];
  // An applied point is shown where its new wording now stands; a dismissed one at the passage quoted.
  const shown = applied && typeof o.text === 'string' && o.text.trim() ? { ...ev, quote: o.text } : ev;
  return <div className="finished">
    {lead && <p className="point__why">{lead}</p>}
    {excerpts.length > 0 && <div className="point__box">{excerpts.map((x, i) => <Parts key={i} excerpt={x}/>)}</div>}
    {quote && <div className="finished__quote">
      <p className="quote quote--s">“{quote}”</p>
      <button type="button" className="link" onClick={() => onOpenEvidence?.(shown, f)}>Show in document</button>
    </div>}
    <div className="point__actions"><button type="button" className="quiet" onClick={onUndo} disabled={!!busy}>{busy === 'undo' ? 'Undoing…' : 'Undo'}</button></div>
  </div>;
}

/**
 * An opened point: what is wrong in one or two sentences, the suggested wording drawn into the clause, Apply and
 * Dismiss. A reply that makes two or more edits (PR-PANE-05) lists them for
 * Confirm before anything lands.
 */
function Point(props) {
  const { f, name, surface, busy, error, onDone } = props;
  const [confirming, setConfirming] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [ticks, setTicks] = useState({});
  const [results, setResults] = useState(null);
  const change = props.changeFor(f); // { before, after }
  const current = change.after ?? '';
  // The suggested wording, else the first option whose text is wording for this clause; a proposal to delete the
  // clause (empty wording) strikes it.
  const deleting = f.deletion === true && f.proposalStatus === 'ok';
  const suggested = applicableText(f);
  const optionText = !suggested && !deleting ? (f.options || []).map(o => optionReply(o, [change.after, change.before])).find(o => o.text)?.text || null : null;
  const replyText = deleting ? '' : suggested ?? optionText;
  const deletes = deleting && !!current.trim();
  const edits = planEdits(f, { replyText, current, deletes, insertions: surface === 'word', order: props.orderOf || (() => 0) });
  const ticked = edits.filter(e => ticks[e.key] !== false);
  const lead = leadSentences(String(f.explanation || '').trim());
  const excerptOf = e => e.kind === 'insert' ? { parts: [{ text: e.after, kind: 'add' }] } : diffExcerpt(e.before, e.after, { lead: 14, trail: 10, limit: 2000 }) || quoteExcerpt(e.after, { limit: 2000 });

  const apply = async () => {
    if (edits.length >= 2) { setTicks({}); setResults(null); setConfirming(true); return; }
    const ok = edits[0].kind === 'insert' ? !!(await props.onApplyEdits(f, edits, null))?.results?.some(r => r.ok) : await props.onApply(f, deletes ? '' : replyText, null);
    if (ok) onDone();
  };
  const confirm = async () => {
    if (!ticked.length) return;
    const r = await props.onApplyEdits(f, ticked, null);
    if (r) setResults(r.results);
    if (r?.results?.some(x => x.ok)) onDone();
  };
  const dismiss = reason => { props.onDismiss(f, reason); onDone(); };

  return <li className="point">
    <div className="point__title"><Dot status={f.status}/><span>{name}</span>{notVerified(f) ? <span className="tag tag--warn">Not verified</span> : null}</div>
    {lead && <p className="point__why">{lead}</p>}
    {edits.length > 0 && !confirming && <div className="point__box">{edits.map(e => <Parts key={e.key} excerpt={excerptOf(e)}/>)}</div>}
    {confirming && <div className="choices point__box" role="group" aria-label="Changes">
      {edits.map(e => { const result = results?.find(r => r.key === e.key); const on = ticks[e.key] !== false;
        return <button key={e.key} type="button" className="choice bulkrow" aria-pressed={on} disabled={!!busy} onClick={() => setTicks(t => ({ ...t, [e.key]: !on }))}>
          <Square on={on}/><span className="bulkrow__text">
            <span className="meta grey">{e.kind === 'insert' ? `New ¶ after ¶ ${paraNo(e.paragraphId) || e.paragraphId}` : `¶ ${paraNo(e.paragraphId) || e.paragraphId}`}{result ? ` · ${result.ok ? 'Applied' : result.error ? 'Failed' : 'Not applied'}` : ''}</span>
            <Parts excerpt={e.kind === 'insert' ? quoteExcerpt(e.after, { limit: 90 }) : diffExcerpt(e.before, e.after, { lead: 3, trail: 2, limit: 90 }) || quoteExcerpt(e.after, { limit: 90 })}/>
          </span>
        </button>; })}
    </div>}
    {error && <p className="pane__error" role="alert">{error}</p>}
    <div className="point__actions">
      {confirming ? <>
        <button type="button" className="primary" onClick={confirm} disabled={!!busy || !ticked.length}>{busy === 'apply' ? 'Applying…' : 'Confirm'}</button>
        <button type="button" className="quiet" onClick={() => setConfirming(false)} disabled={!!busy}>Cancel</button>
      </> : dismissing ? <div className="point__why-dismiss" role="group" aria-label="Dismiss">
        <button type="button" className="quiet" onClick={() => dismiss('not-an-issue')} disabled={!!busy}>Not an issue</button>
        <button type="button" className="quiet" onClick={() => dismiss('accepted')} disabled={!!busy}>Accept their wording</button>
        <button type="button" className="link" onClick={() => setDismissing(false)} disabled={!!busy}>Cancel</button>
      </div> : <>
        {edits.length > 0 && <button type="button" className="primary" onClick={apply} disabled={!!busy}>{busy === 'apply' ? 'Applying…' : 'Apply'}</button>}
        <button type="button" className="quiet" onClick={() => setDismissing(true)} disabled={!!busy}>Dismiss</button>
      </>}
    </div>
  </li>;
}
