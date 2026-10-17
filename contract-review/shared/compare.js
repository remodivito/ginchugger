import { diffArrays } from 'diff';

// IDs emitted by independently opened Word files are positional, not durable
// contract clause identities. Preserve sequence and never pair arbitrary runs.
export function alignDocument(document, baseline = null) {
  const paragraphs=document.paragraphs.map(p=>({...p,comparisonText:typeof p.originalText==='string' ? p.originalText : undefined,change:typeof p.originalText==='string' && p.originalText!==p.text ? 'recorded':'unknown'}));
  const deleted=[],limits=[];
  if(!baseline)return {paragraphs,deleted,limits};
  if(!document.imported && !baseline.imported && document.source!=='docx' && baseline.source!=='docx' && document.source!=='word' && baseline.source!=='word') {
    const previous=new Map(baseline.paragraphs.map(p=>[p.id,p]));
    for(const p of paragraphs) {const old=previous.get(p.id);p.comparisonText=old?.text ?? '';p.change=old?.text===p.text ? 'unchanged':'changed';}
    const currentIds=new Set(paragraphs.map(p=>p.id));
    deleted.push(...baseline.paragraphs.filter(p=>!currentIds.has(p.id)).map(p=>({...p,deleted:true,source:'baseline'})));
    return {paragraphs,deleted,limits};
  }
  // A paragraph that carries tracked changes is placed by the text those changes were made to. When the comparison
  // version is the document the changes were made against, every paragraph then lines up exactly and the recorded
  // change is the change, however many neighbouring paragraphs were edited (found in Word on 5 Oct 2026: two adjacent
  // edited paragraphs were shown as two removals and two insertions).
  // ...unless its current wording is already in the earlier version: a return that still shows OUR tracked changes (they
  // sent our counter-turn back with its revisions unaccepted) must line up with the version we sent, not with the one before it.
  const held=new Set(baseline.paragraphs.map(p=>p.text));
  const base=p=>held.has(p.text) ? p.text : typeof p.originalText==='string' ? p.originalText : p.text;
  const chunks=diffArrays(baseline.paragraphs.map(p=>p.text),paragraphs.map(base));
  let oldIndex=0,newIndex=0;
  for(let i=0;i<chunks.length;i++) {
    const chunk=chunks[i];
    if(!chunk.added && !chunk.removed) {
      for(let n=0;n<chunk.value.length;n++) {const p=paragraphs[newIndex++],old=baseline.paragraphs[oldIndex++];p.comparisonText=old.text;p.change=p.text===old.text ? 'unchanged':'changed';}
      continue;
    }
    const removed=[],added=[];
    while(i<chunks.length && (chunks[i].added || chunks[i].removed)) {
      const part=chunks[i];
      for(let n=0;n<part.value.length;n++) if(part.removed) removed.push(baseline.paragraphs[oldIndex++]);else added.push(paragraphs[newIndex++]);
      i++;
    }
    i--;
    if(removed.length===1 && added.length===1) {added[0].comparisonText=removed[0].text;added[0].change='changed';}
    else {
      // Several paragraphs changed side by side. Pair the ones that are measurably the same clause (most of the shorter
      // one's three-word sequences survive in the other), keeping their order; anything else stays unpaired as before.
      const pairs=pairInOrder(removed.map(p=>p.text),added.map(base));
      // Between two matched pairs (or a block edge), one old paragraph and one new one in the same place are a replacement,
      // exactly as a lone changed paragraph is: a short clause rewritten outright ("Governing Law: Scotland…") keeps few of its words.
      const anchors=[[-1,-1],...pairs,[removed.length,added.length]];
      for(let k=0;k+1<anchors.length;k++) {const [r0,a0]=anchors[k],[r1,a1]=anchors[k+1];if(r1-r0===2 && a1-a0===2)pairs.push([r0+1,a0+1]);}
      const taken=new Set(pairs.map(([r])=>r)),matched=new Map(pairs.map(([r,a])=>[a,r]));
      added.forEach((p,n)=>{p.comparisonText=matched.has(n) ? removed[matched.get(n)].text : '';p.change=p.comparisonText===p.text ? 'unchanged':'changed';});
      const unpaired=removed.filter((_,n)=>!taken.has(n));
      deleted.push(...unpaired.map(p=>({...p,deleted:true,source:'baseline'})));
      if(unpaired.length && added.length>pairs.length) limits.push('A block contains multiple removed or added paragraphs. They are shown separately because reliable one-to-one clause matching was not established.');
    }
  }
  limits.push('Imported-file comparison uses text sequence. Moved or repeated wording may appear as additions and deletions; authorship and negotiation history are not inferred.');
  return {paragraphs,deleted,limits:[...new Set(limits)]};
}

const SAME_CLAUSE=0.6;
const triples=text=>{const w=String(text).toLowerCase().match(/[a-z0-9']+/g)||[];const out=new Set();for(let i=0;i+3<=w.length;i++)out.add(w.slice(i,i+3).join(' '));return out;};
/** Share of the smaller paragraph's three-word sequences found in the other; 0 when either is too short to say. */
export function sameClause(a,b) {const x=triples(a),y=triples(b);if(!x.size || !y.size)return 0;let n=0;for(const t of x)if(y.has(t))n++;return n/Math.min(x.size,y.size);}
/** Order-preserving pairs [oldIndex,newIndex] whose similarity clears the bar, chosen to maximise total similarity. */
function pairInOrder(olds,news) {
  const sim=olds.map(o=>news.map(n=>{const v=sameClause(o,n);return v>=SAME_CLAUSE ? v : 0;}));
  const best=Array.from({length:olds.length+1},()=>Array(news.length+1).fill(0));
  for(let i=olds.length-1;i>=0;i--)for(let j=news.length-1;j>=0;j--)best[i][j]=Math.max(best[i+1][j],best[i][j+1],sim[i][j] ? sim[i][j]+best[i+1][j+1] : 0);
  const pairs=[];let i=0,j=0;
  while(i<olds.length && j<news.length) {
    if(sim[i][j] && best[i][j]===sim[i][j]+best[i+1][j+1]) {pairs.push([i,j]);i++;j++;}
    else if(best[i+1][j]>=best[i][j+1])i++;else j++;
  }
  return pairs;
}
