// SPDX-License-Identifier: GPL-3.0-or-later
// Product v2, slice S1 ("the trim", spec section 2): what left the product stays out of it. Sample mode left too
// (17 Oct 2026): replay over the recorded demo is test infrastructure the tests start themselves, not a mode for users.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = p => path.join(root, p);
const source = dir => readdirSync(at(dir)).filter(f => /\.(m?js|jsx)$/.test(f)).map(f => [`${dir}/${f}`, readFileSync(at(`${dir}/${f}`), 'utf8')]);

test('the removed modules, prompts and scripts are gone from the product and nothing imports them', () => {
  for (const f of ['server/review-decomposed.js', 'server/playbook-generate.js', 'server/suggest-playbook.js', 'scripts/evaluate.js', 'scripts/evaluate-live.js', 'data/evaluation-report.json',
    'prompts/review-rule.md', 'prompts/review-rule-agent.md', 'prompts/review-agent.md', 'prompts/sweep.md', 'prompts/consolidate.md', 'prompts/playbook.md']) assert.ok(!existsSync(at(f)), `${f} is removed`);
  for (const [file, text] of [...source('server'), ...source('scripts'), ...source('src'), ...source('src/pages'), ...source('src/review')])
    assert.doesNotMatch(text, /review-decomposed|playbook-generate|suggest-playbook|evaluate\.js|\/api\/evaluation|\/api\/playbook\/versions|\/api\/playbooks\/suggest|\/api\/playbook\/generate|REVIEW_ARM/, file);
});

test('the local rule engine left review.js; the arms and the engine live in the benchmark', () => {
  const review = readFileSync(at('server/review.js'), 'utf8');
  for (const name of ['localReview', 'WORD_NUMBERS', 'topicPatterns', "mode==='demo'"]) assert.ok(!review.includes(name), name);
  for (const f of ['../tough-eval/baselines/local-rules.mjs', '../tough-eval/arms/review-decomposed.mjs', '../tough-eval/arms/review-rule.md']) assert.ok(existsSync(at(f)), f);
});

test('replay is test infrastructure over the recorded demo (review, ask and revise); Sample mode is gone', async () => {
  const { getExecutorConfig, DEMO_RECORDING } = await import('../server/executors.js');
  assert.equal(getExecutorConfig({ REVIEW_EXECUTOR: 'replay' }).replayDir, DEMO_RECORDING);
  for (const name of ['review', 'ask', 'revise']) assert.ok(existsSync(path.join(DEMO_RECORDING, `${name}.raw.txt`)), name);
  assert.ok(!existsSync(at('scripts/sample.mjs')), 'scripts/sample.mjs is removed');
  // Settings offers replay only when the environment runs it (the tests, the benchmark) or GCL_DEV_REPLAY=1.
  const { reviewExecutors } = await import('../server/settings.js');
  assert.deepEqual(reviewExecutors({}), ['claude', 'anthropic', 'openai']);
  assert.deepEqual(reviewExecutors({ REVIEW_EXECUTOR: 'replay' }), ['claude', 'anthropic', 'openai', 'replay']);
  assert.deepEqual(reviewExecutors({ GCL_DEV_REPLAY: '1' }), ['claude', 'anthropic', 'openai', 'replay']);
  for (const f of ['public/help.html', 'README.md', 'docs/SETUP.md', 'src/pages/Settings.jsx', 'src/pages/About.jsx']) assert.doesNotMatch(readFileSync(at(f), 'utf8'), /Sample mode|npm run sample|Sample \(recorded/, f);
});

test('cases.json carries no evaluator labels; they moved beside the engine they measured', () => {
  const cases = JSON.parse(readFileSync(at('data/cases.json'), 'utf8'));
  assert.ok(cases.length >= 10 && cases.every(c => !('expected' in c)));
  const labels = JSON.parse(readFileSync(at('../tough-eval/baselines/cases-v1-labels.json'), 'utf8'));
  assert.deepEqual(Object.keys(labels).sort(), cases.map(c => c.id).sort());
});

test('slice S4: the folder store, the matter proposal, the model-chosen baseline and organising are gone, and no route of section 2 remains in src/', () => {
  for (const f of ['server/matter.js', 'server/history.js', 'server/propose-matter.js', 'server/baseline.js', 'server/organise.js', 'prompts/baseline.md', 'prompts/organise.md',
    'tests/matter.test.js', 'tests/history.test.js', 'tests/propose-matter.test.js', 'tests/baseline.test.js', 'tests/organise.test.js', 'scripts/measure-organise.mjs']) assert.ok(!existsSync(at(f)), `${f} is removed`);
  for (const [file, text] of [...source('server'), ...source('server/record'), ...source('scripts'), ...source('src'), ...source('src/pages'), ...source('src/review')])
    assert.doesNotMatch(text, /from '\.\.?\/(matter|history|propose-matter|baseline|organise)\.js'|\/api\/matters\b|\/organise|\/baseline\/confirm|matterHistory|proposeBaseline|syncLegacy|MATTER_ROOT/, file);
});

test('decision 184: the pane has one job; the controls it lost are gone from its source, and the routes behind them stay', () => {
  const pane = readFileSync(at('src/review/Pane.jsx'), 'utf8');
  // 'Sources' (the review's old sources card) is not listed: Ask C (17 Oct 2026) puts "N sources" under each Ask answer.
  for (const gone of ['Add to playbook', 'Record this round', 'Export record', 'Round summary', 'Also noticed', 'Positions', 'Reword', 'Mark reviewed', 'Copy wording', 'New review', 'Instruction', 'Earlier version', 'Inbox', 'Last time', 'Filed under', 'FilingCard', 'matter'])
    assert.ok(!pane.includes(gone), gone);
  // Audit finding 2 (16 Oct): the playbook is named (in header D, "Playbook · <title>") and changeable from the one quiet
  // line under Review ("<counterparty> · Change playbook", UX taste call 1), with a compact choice only when none was
  // inferred; no picker card or dropdown.
  for (const back of ['Playbook · {props.playbookLabel}', 'Change playbook', 'Choose a playbook']) assert.ok(pane.includes(back), back);
  assert.ok(!pane.includes('<select'), 'no dropdown in the pane');
  for (const kept of ["'Apply'", '>Dismiss<', 'of {list.length} done', 'Ask about this draft', 'Review again']) assert.ok(pane.includes(kept), kept);
  assert.equal((pane.match(/aria-label="Sources"/g) || []).length, 1, 'sources appear only under an Ask answer');
  const app = readFileSync(at('src/main.jsx'), 'utf8');
  for (const route of ['/api/review-record', '/api/review/revise']) assert.ok(!app.includes(route), `${route} is no longer called by the app`);
  // Task 8 (the pane on the store): Save as our reply adds the version going back to the store; no filing in the pane.
  assert.ok(app.includes('/api/v2/store/pane/save'), 'Save as our reply sends the version going back to the store');
  for (const gone of ['/api/v2/inbox/pane', 'filingView', 'useMatter', 'docRound', 'lastTime(']) assert.ok(!app.includes(gone), `${gone} left the app`);
  const server = readFileSync(at('server/index.js'), 'utf8') + readFileSync(at('server/record/http.js'), 'utf8');
  for (const route of ["'/api/review-record'", "'/api/review/revise'"]) assert.ok(server.includes(route), `${route} is still served`);
  // Decision 190: the record's inbox and its pane capture route went with filing.
  for (const gone of ["'/inbox/pane'", "'/matters'", "'/counterparties'"]) assert.ok(!server.includes(gone), `${gone} is no longer served`);
});
