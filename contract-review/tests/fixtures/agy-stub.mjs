// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for Google's Antigravity CLI (agy) in print mode with stream-json in and out, for executors.test.js.
// Records its arguments, working directory and stdin to STUB_ARGS_FILE; STUB_MODE picks the answer:
//   ok (default) | tool (a tool step, then the answer) | slow (ignores SIGTERM, as agy 1.4.0 does) | quota | error | cutoff | empty | slow | crash
import { writeFileSync, readFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
if (process.env.STUB_ARGS_FILE) writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input, env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null } }));
const mode = process.env.STUB_MODE || 'ok'; const conv = 'conv-1';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const result = (status, response, extra = {}) => out({ event: 'result', result: { conversation_id: conv, status, response, duration_seconds: 2.5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 120 }, ...extra } });
const model = process.argv[process.argv.indexOf('--model') + 1];
if (mode === 'crash') { process.stderr.write('panic: something broke\n'); process.exit(3); }
out({ event: 'init', conversation_id: conv, init: { model, cwd: process.cwd(), tools: ['view_file'], permission_mode: 'request-review' } });
const answer = '{"findings":[],"limits":["stub"]}';
if (mode === 'slow') { process.on('SIGTERM', () => {}); setTimeout(() => result('SUCCESS', answer), 60_000); }
else if (mode === 'tool') {
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'search_web' } });
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'search_web' } });
  result('SUCCESS', answer);
} else if (mode === 'quota') { result('ERROR', '', { error: 'RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 3h.' }); process.exitCode = 1; }
else if (mode === 'cutoff') result('ERROR', '', { error: 'Your previous response was cut off because it exceeded the output token limit\nPlease continue from where you left off, keeping your response shorter\nRetries remaining: 3' });
else if (mode === 'error') { result('ERROR', '', { error: 'stream closed unexpectedly' }); process.exitCode = 1; }
else if (mode === 'empty') result('SUCCESS', '', { denied_actions: [{ action: 'write_file', display_name: 'WriteToFile' }] });
else result('SUCCESS', '```json\n' + answer + '\n```\n');
