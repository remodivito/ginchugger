// SPDX-License-Identifier: GPL-3.0-or-later
// The browser's document column (the fallback review workspace): the agreement with its changes, the passage on screen
// marked, and paragraphs that carry a point selectable. Word supplies this surface when the pane runs inside Word.
import React, { useEffect } from 'react';
import { wordDiff } from './model.js';

function Marked({ before, after, ours }) {
  if (before === undefined || before === after) return after;
  return wordDiff(before, after).map((p, i) => p.kind === 'add' ? <ins key={i} className={ours ? 'ours' : ''}>{p.text}</ins> : p.kind === 'del' ? <del key={i} className={ours ? 'ours' : ''}>{p.text}</del> : <React.Fragment key={i}>{p.text}</React.Fragment>);
}

export default function DocumentView({ doc, alignment, findings, applied, markedId, showChanges, onPick, sample }) {
  useEffect(() => { if (markedId) document.getElementById(`paragraph-${markedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [markedId]);
  if (!doc) return <div className="paper paper--empty"/>;
  return <article className="paper" aria-label="Agreement">
    {doc.source?.attribution && <p className="meta grey">{doc.source.attribution}</p>}
    {doc.warnings?.map((w, i) => <p className="meta grey" key={i}>{w}</p>)}
    {alignment.paragraphs.map(p => {
      const f = findings.find(x => x.paragraphId === p.id && x.evidence?.[0]?.source !== 'baseline');
      const ours = applied[p.id];
      const body = showChanges ? <Marked before={ours !== undefined ? ours : p.comparisonText} after={p.text} ours={ours !== undefined}/> : p.text;
      const cls = `para ${markedId === p.id ? 'para--marked' : ''}`;
      return f
        ? <button type="button" id={`paragraph-${p.id}`} key={p.id} className={`${cls} para--point`} onClick={() => onPick(f)} aria-label={`Show point: ${f.title}`}>{body}</button>
        : <p id={`paragraph-${p.id}`} key={p.id} className={cls}>{body}</p>;
    })}
    {alignment.deleted.length > 0 && <div className="removed"><span className="label">Removed from the comparison version</span>{alignment.deleted.map(p => <p className="para" id={`baseline-${p.id}`} key={p.id}><del>{p.text}</del></p>)}</div>}
    {doc.source?.url && <p className="meta grey"><a href={doc.source.url} target="_blank" rel="noreferrer">Public source</a> · {doc.source.license}</p>}
    {sample?.subtitle && <p className="meta grey">{sample.subtitle}</p>}
  </article>;
}
