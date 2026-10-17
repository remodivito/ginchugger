// SPDX-License-Identifier: GPL-3.0-or-later
// Deliberately degraded configurations ("controls"). Each one is worse than the real reviewer by construction, so an
// eval we can trust must score it lower on the measure named in `expect`. If it does not, the eval cannot see that
// kind of difference, and no comparison that depends on it should be believed. Run with `run.mjs --control <name>`.
// The v1 rule engine (`run.mjs --demo`, baselines/local-rules.mjs) and low effort (`--effort low`) are the other two
// controls; they need no code here.

export const CONTROLS = {
  // The reviewer sees only the first half of the agreement. Deviations planted in the second half cannot be found.
  'half-document': {
    expect: 'lower caught (on plants in the second half), no change on plants in the first half',
    apply: ({ document, playbook }) => ({ playbook, document: { ...document, paragraphs: document.paragraphs.slice(0, Math.ceil(document.paragraphs.length / 2)) } }),
  },
  // Each rule keeps its id and title but loses its guidance and tiers, so the reviewer cannot tell an acceptable
  // position from one that needs escalating.
  'titles-only': {
    expect: 'lower fixed (compliant wording), more false alarms or benign edits flagged',
    apply: ({ document, playbook }) => ({ document, playbook: { ...playbook, rules: playbook.rules.map(r => ({ id: r.id, title: r.title, enabled: r.enabled })) } }),
  },
  // Rule ids are rotated by one, so each rule's guidance carries a neighbour's id. A review that applies the right
  // guidance now cites the wrong rule. Tests that "caught" really depends on citing the right rule, not just the place.
  'scrambled-ids': {
    expect: 'caught near zero while located stays high',
    apply: ({ document, playbook }) => { const ids = playbook.rules.map(r => r.id); return { document, playbook: { ...playbook, rules: playbook.rules.map((r, i) => ({ ...r, id: ids[(i + 1) % ids.length] })) } }; },
  },
};

export function applyControl(name, inputs) {
  if (!name) return inputs;
  const c = CONTROLS[name]; if (!c) throw Error(`unknown control ${name}`);
  return c.apply(inputs);
}
