// SPDX-License-Identifier: GPL-3.0-or-later
// The layer C judge panel (BENCHMARK-V2.md section 7, P19): who judges whom, how two judgements and a tiebreak become
// one verdict, and the panel validity control.
//   Assignment: the judges in order opus, glm, deepseek; a contestant's two judges are the first two whose family is
//   not the contestant's (Claude contestant: GLM and DeepSeek; GLM: Opus and DeepSeek; DeepSeek: Opus and GLM); the
//   tiebreaker is the next one, Qwen 3.8 27B (not a layer C contestant). A judge that fails the validity control is
//   skipped, so "the next family in the assignment order" replaces it (Qwen moves into the panel and Mistral Small 4,
//   the reserve, becomes the tiebreaker); every replacement is recorded. A judge never grades its own family.
//   Verdict: the value at least two of the (up to three) usable judgements give; the tiebreaker is asked only when the
//   two panel judges disagree or one of them returned no usable judgement; with no two concordant votes the
//   criterion is "undecided" and does not pass (listed, never silently dropped).
//   Validity control: every candidate judge grades the golden redline (expected to pass every criterion) and the empty
//   output (expected to fail every 'change' criterion and pass every 'keep' one, criteria.mjs). A judge fails the
//   control if it returned no usable judgement on a control item, or gave the unexpected verdict on an item where at
//   least one other judge gave the expected one. An item every judge gets "wrong" is a fault of the item (criterion
//   wording, rendering or golden), not of a judge: it is recorded as a criterion failure and published, and no judge
//   is replaced for it.
export const JUDGES = {
  opus: { family: 'anthropic', executor: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
  glm: { family: 'zhipu', executor: 'openai', model: 'zai-org/glm-5.3-flash' },
  deepseek: { family: 'deepseek', executor: 'openai', model: 'deepseek-ai/deepseek-v4-flash' },
  qwen: { family: 'alibaba', executor: 'openai', model: 'qwen/qwen3.8-27b' },
  mistral: { family: 'mistral', executor: 'openai', model: 'mistralai/mistral-small-4-119b-2603' },
};
export const ORDER = ['opus', 'glm', 'deepseek', 'qwen', 'mistral'];
export const CONTROL_JUDGES = ['opus', 'glm', 'deepseek', 'qwen'];

/** The family (organisation) of a model id as sent (section 2's table). Null when no family applies (a baseline). */
export function familyOf(model) {
  const m = String(model ?? '').toLowerCase();
  if (/claude|opus|sonnet|haiku|anthropic/.test(m)) return 'anthropic';
  if (/glm|zai-org|zhipu/.test(m)) return 'zhipu';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/qwen/.test(m)) return 'alibaba';
  if (/mistral/.test(m)) return 'mistral';
  if (/gpt|\bsol\b|openai|codex/.test(m)) return 'openai';
  if (/muse|llama|meta/.test(m)) return 'meta';
  if (/gemini|google/.test(m)) return 'google';
  return null;
}

/**
 * The panel for a contestant family: { judges: [a, b], tiebreak, replaced: [{ judge, by, reason }] }.
 * `failedValidity`: judge keys that failed the control.
 */
export function assign(contestantFamily, { failedValidity = [] } = {}) {
  const own = ORDER.filter(j => JUDGES[j].family !== contestantFamily);
  const eligible = own.filter(j => !failedValidity.includes(j));
  if (eligible.length < 3) throw Error(`no panel of three for family ${contestantFamily}: eligible ${eligible.join(', ') || 'none'}`);
  const base = { judges: own.slice(0, 2), tiebreak: own[2] };
  const judges = eligible.slice(0, 2), tiebreak = eligible[2];
  const baseAll = [...base.judges, base.tiebreak]; const incoming = [...judges, tiebreak].filter(j => !baseAll.includes(j));
  const replaced = baseAll.filter(j => failedValidity.includes(j)).map((j, i) => ({ judge: j, by: incoming[i] ?? null, reason: 'failed the panel validity control' }));
  return { judges, tiebreak, replaced };
}

/** A usable judgement's verdict (true/false), or null for a missing or failed one. */
export const verdictOf = j => (j && j.ok && typeof j.pass === 'boolean' ? j.pass : null);
/** Whether the tiebreaker is needed for two panel judgements. */
export function needsTiebreak(a, b) { const x = verdictOf(a), y = verdictOf(b); return x === null || y === null || x !== y; }
/**
 * One criterion's verdict from the panel's judgements. Returns { pass: true|false|null, decidedBy: 'panel' |
 * 'tiebreak' | 'undecided', agreed: true|false|null, votes: { judge: verdict } }.
 */
export function combine(panel, judgements) {
  const [a, b] = panel.judges; const va = verdictOf(judgements[a]), vb = verdictOf(judgements[b]); const vt = verdictOf(judgements[panel.tiebreak]);
  const votes = { [a]: va, [b]: vb, ...(judgements[panel.tiebreak] !== undefined ? { [panel.tiebreak]: vt } : {}) };
  const agreed = va === null || vb === null ? null : va === vb;
  if (agreed === true) return { pass: va, decidedBy: 'panel', agreed, votes };
  const vals = Object.values(votes).filter(v => v !== null); const yes = vals.filter(v => v).length, no = vals.length - yes;
  if (yes >= 2 || no >= 2) return { pass: yes >= 2, decidedBy: 'tiebreak', agreed, votes };
  return { pass: null, decidedBy: 'undecided', agreed, votes };
}

/**
 * The validity control's outcome. `results`: [{ output: 'golden'|'empty', criterion, judge, verdict: true|false|null,
 * expected: true|false }]. Returns { judges: { key: { ok, items, usable, wrong: [...], missing: [...] } }, criterionFailures: [...], failed: [keys] }.
 */
export function validity(results) {
  const byItem = new Map();
  for (const r of results) { const k = `${r.output}\u0000${r.criterion}`; (byItem.get(k) || byItem.set(k, []).get(k)).push(r); }
  const judges = {}; const criterionFailures = [];
  const J = key => (judges[key] ||= { ok: true, items: 0, usable: 0, wrong: [], missing: [], itemFaults: [] });
  for (const [, rs] of byItem) {
    const anyRight = rs.some(r => r.verdict === r.expected);
    if (!anyRight && rs.some(r => r.verdict !== null)) criterionFailures.push({ output: rs[0].output, criterion: rs[0].criterion, expected: rs[0].expected, verdicts: Object.fromEntries(rs.map(r => [r.judge, r.verdict])) });
    for (const r of rs) {
      const j = J(r.judge); j.items++;
      if (r.verdict === null) { j.missing.push({ output: r.output, criterion: r.criterion }); continue; }
      j.usable++;
      if (r.verdict !== r.expected) (anyRight ? j.wrong : j.itemFaults).push({ output: r.output, criterion: r.criterion, verdict: r.verdict, expected: r.expected });
    }
  }
  for (const j of Object.values(judges)) j.ok = j.wrong.length === 0 && j.missing.length === 0;
  return { judges, criterionFailures, failed: Object.entries(judges).filter(([, j]) => !j.ok).map(([k]) => k).sort() };
}
