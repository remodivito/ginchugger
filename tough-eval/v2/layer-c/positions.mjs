// SPDX-License-Identifier: GPL-3.0-or-later
// The positions source per task (BENCHMARK-V2.md section 7: "a playbook written from the task's own instructions,
// frozen with the list"). Built mechanically from what RedlineBench gives the attorney-agent, never from the rubric or
// the golden redline, so the reviewer is not handed the answer key (the audit's leakage warning):
//   RB-REP  the representation block of instruction.md (Mandate, Hard constraints): whom we act for, against whom;
//   RB-TURN the response-turn instructions (classify each incoming change: accept, refine, reject, leave re-raised
//           points; authorship; limits on new points; how to plan), with tool and comment mechanics removed;
//   RB-HYG  the drafting-hygiene instructions (targeted, minimal, in place, structure and defined terms line up);
//   RB-01…  one rule per labelled paragraph of the represented side's guidelines in the scenario file ("Vendor-side
//           guidelines", "Procurement-side guidelines"), verbatim, as redline-subset/prepare.mjs split them;
//   RB-G    (when the task supplies one) the attorney review guide's sections on edits to the document (Targeted,
//           Minimal Edits; Acceptances; Full-Document Proofread; Internal Consistency Check), verbatim; its sections
//           on comment voice, threading and cover notes are left out because the review writes neither;
//   RB-P01… (when the task supplies one) the represented party's precedent agreement, one rule per numbered section,
//           verbatim, as "our precedent reads".
// The product's review takes no separate context in the benchmark path (review-one.mjs), so everything the attorney
// had as instructions reaches the reviewer as playbook rules. `party` is the represented party, so the side-
// parameterised plain prompt fills {side} correctly.

const clean = s => s.replace(/^# Extracted text of .*\n/, '').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
const MECHANICS = /\.py\b|--reply-to|--author|read_document|propose_edits|add_comment|mark_reserved|script/i;
/** The lines of a markdown section (from a heading matching `from` to the next heading of the same or higher level). */
export function mdSection(md, from) {
  const lines = md.split('\n'); const start = lines.findIndex(l => /^#+ /.test(l) && from.test(l)); if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length; let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { const m = lines[i].match(/^(#+) /); if (m && m[1].length <= level) { end = i; break; } }
  return lines.slice(start + 1, end).join('\n').trim();
}
/** Instruction prose without tool mechanics: sentences naming scripts or flags are dropped. */
export function withoutMechanics(text) {
  text = text.replace(/Apply an? (\*\*)?`propose_edits\.py`(\*\*)? op/g, 'Propose a change').replace(/with (\*\*)?`add_comment\.py[^`]*`(\*\*)?/g, 'with a comment')
    .replace(/Use `add_comment\.py --reply-to N` rather than/g, 'Reply on the existing thread rather than').replace(/(\*\*)?`mark_reserved\.py`(\*\*)?/g, 'marking the section "Reserved"');
  return text.split('\n').map(line => (MECHANICS.test(line) ? line.split(/(?<=[.!?])\s+/).filter(s => !MECHANICS.test(s)).join(' ') : line))
    .filter(l => l.trim() && !/^\s*[-*]\s*$/.test(l)).join('\n').replace(/\*\*/g, '').trim();
}
/** The labelled paragraphs under the "<side>-side guidelines" heading of a scenario file. */
export function sideGuidelines(text) {
  const lines = clean(text).split('\n'); const at = lines.findIndex(l => /-side guidelines\s*$/i.test(l.trim()));
  if (at < 0) return null; const rules = [];
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^([A-Z][A-Za-z ,&/()'’-]{2,60}?):\s+(.*)$/);
    if (m) rules.push({ label: m[1].trim(), text: m[2].trim() }); else if (rules.length && line.trim()) rules.at(-1).text += ' ' + line.trim();
  }
  return { heading: lines[at].trim(), rules };
}
const GUIDE_SECTIONS = ['Targeted, Minimal Edits', 'Acceptances', 'Full-Document Proofread', 'Internal Consistency Check'];
const GUIDE_HEADINGS = new Set(['Purpose and How to Use This Document', 'Establish Context Before You Open the Document', 'Drafting Tracked Changes', 'Track Changes — Always On', ...GUIDE_SECTIONS, 'Comments', 'Mechanics', 'Threading', 'Substantive Pushback', 'Things Not to Say', 'Finalizing', 'Cover Note', 'Opening', 'Sections', 'Key Issues', 'Discipline', 'Multiple Documents']);
/** The attorney guide's sections on edits to the document, verbatim. */
export function guideSections(text) {
  const lines = clean(text).split('\n'); const out = [];
  for (const name of GUIDE_SECTIONS) {
    const i = lines.indexOf(name); if (i < 0) continue; const body = [];
    for (const l of lines.slice(i + 1)) { if (GUIDE_HEADINGS.has(l.trim())) break; if (l.trim()) body.push(l.trim()); }
    out.push({ name, text: body.join('\n') });
  }
  return out;
}
/** A precedent agreement split at its numbered top-level headings ("7. TERM AND TERMINATION."). */
export function precedentSections(text) {
  const lines = clean(text).split('\n').filter(l => l.trim()); const out = []; const HEAD = /^(\d{1,2})\.\s+([A-Z][A-Za-z ,&’'-]{2,60}?)\.?:?$/;
  for (const l of lines.slice(1)) { const m = l.match(HEAD); if (m || !out.length) out.push({ heading: m ? `${m[1]}. ${m[2]}` : lines[0], text: [] }); if (!m) out.at(-1).text.push(l); }
  return out.filter(s => s.text.length).map(s => ({ heading: s.heading, text: s.text.join('\n') }));
}

/**
 * The task's playbook. `files`: { instruction, scenario: { name, text }, guide?: { name, text }, precedent?: { name, text } };
 * `meta`: { task, represented, counterparty }.
 */
export function buildPlaybook({ instruction, scenario, guide = null, precedent = null }, { task, represented, counterparty }) {
  const cite = (document, quote = null) => [{ document, paragraph: null, quote }];
  const rules = [];
  const rep = ['Mandate', 'Hard constraints'].map(h => mdSection(instruction, new RegExp(`^##\\s+${h}`))).filter(Boolean).map(withoutMechanics).join('\n');
  rules.push({ id: 'RB-REP', title: `We act for ${represented} against ${counterparty}`, topic: 'representation', guidance: `We represent ${represented}; the counterparty is ${counterparty}.\n${rep}`, enabled: true, sources: cite('instruction.md (Representation)') });
  const turn = ['Your job in a response turn', 'Authorship matters', 'Your own new edits', 'How to plan in a response turn'].map(h => { const s = mdSection(instruction, new RegExp(`^##\\s+${h}`)); return s ? `${h}:\n${withoutMechanics(s)}` : null; }).filter(Boolean).join('\n\n');
  if (!turn) throw Error(`${task}: no response-turn instructions in instruction.md`);
  rules.push({ id: 'RB-TURN', title: 'Responding to the counterparty\'s changes', topic: 'negotiation turn', guidance: turn, enabled: true, sources: cite('instruction.md (Turn)') });
  const hyg = mdSection(instruction, /^##\s+Redlining hygiene/); if (!hyg) throw Error(`${task}: no redlining hygiene section`);
  rules.push({ id: 'RB-HYG', title: 'Drafting: targeted, minimal, consistent', topic: 'drafting', guidance: withoutMechanics(hyg), enabled: true, sources: cite('instruction.md (Redlining hygiene)') });
  const g = sideGuidelines(scenario.text); if (!g || g.rules.length < 3) throw Error(`${task}: no side guidelines in ${scenario.name}`);
  g.rules.forEach((r, i) => rules.push({ id: `RB-${String(i + 1).padStart(2, '0')}`, title: r.label, topic: r.label.toLowerCase(), guidance: r.text, enabled: true, sources: cite(`${scenario.name} (${g.heading})`, r.text.slice(0, 300)) }));
  if (guide) { const s = guideSections(guide.text); if (s.length) rules.push({ id: 'RB-G', title: 'Review guide: edits to the document', topic: 'review guide', guidance: s.map(x => `${x.name}:\n${x.text}`).join('\n\n'), enabled: true, sources: cite(guide.name) }); }
  if (precedent) precedentSections(precedent.text).forEach((s, i) => rules.push({ id: `RB-P${String(i + 1).padStart(2, '0')}`, title: `Our precedent: ${s.heading}`, topic: 'precedent', guidance: `Our own precedent agreement (${precedent.name.replace(/\.extracted\.md$/, '')}) reads, in ${s.heading}:\n${s.text}`, enabled: true, sources: cite(precedent.name) }));
  for (const r of rules) if (r.guidance.length > 20000) throw Error(`${task}: rule ${r.id} exceeds the product's 20,000-character guidance limit`);
  return { id: `layer-c-${task}`, title: `${represented} positions for ${task} (from the task's own instructions)`, version: 1, party: represented,
    provenance: `Written mechanically from RedlineBench ${task}'s instruction.md and grounding files (layer-c/positions.mjs): the representation, response-turn and drafting-hygiene instructions, the ${g.heading.toLowerCase()} one rule per labelled paragraph${guide ? ', the attorney review guide\'s sections on document edits' : ''}${precedent ? ', and the precedent agreement one rule per numbered section' : ''}. Nothing from the rubric or the attorney redline. Not lawyer validated.`,
    rules };
}
