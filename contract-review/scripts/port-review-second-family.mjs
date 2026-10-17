// SPDX-License-Identifier: GPL-3.0-or-later
// Second-family review of the Paperless matching port (product spec 10.A.6), via Munito (OpenAI-compatible).
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.argv[2], model = process.argv[3], out = process.argv[4];
const env = Object.fromEntries(readFileSync(root + '/.env', 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const f = p => readFileSync(root + '/' + p, 'utf8');
const prompt = `You are reviewing a port of Paperless-ngx's correspondent matching from Python to JavaScript. The port must reproduce the Python's behaviour exactly, except for the documented differences. Find every place where the JavaScript can give a different result from the Python for some input (case folding, Unicode, regex escaping and flags, word boundaries, whitespace splitting, fuzzy scoring and thresholds, the 'none' mode, ordering, empty patterns), and any security issue (catastrophic regex backtracking, unbounded input, timeouts). For each: the function, a concrete input that diverges, what Python returns, what JavaScript returns, and severity (high: wrong counterparty suggested or a match missed in normal names; medium; low). Do not report the documented differences unless the documentation is wrong. Report at most ten findings, most severe first, in under 800 words. Keep your private reasoning short: compare the two implementations function by function once, then answer. If you find nothing, say so.

=== Python: matching.py ===
${f('server/ports/paperless/reference/matching.py')}

=== Python: regex.py ===
${f('server/ports/paperless/reference/regex.py')}

=== JavaScript port: matching.js ===
${f('server/ports/paperless/matching.js')}

=== Documented differences ===
${f('docs/ports/known-diffs.md')}`;
const r = await fetch('https://api.eu.munito.ai/inference/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.MUNITO_API_KEY }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 64000, stream: true, reasoning_effort: 'low' }) });
let content = '', reasoningChars = 0, buf = '', reasoning = '';
const dec = new TextDecoder();
for await (const chunk of r.body) {
  buf += dec.decode(chunk, { stream: true });
  let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (d === '[DONE]') continue;
    try { const j = JSON.parse(d); const delta = j.choices?.[0]?.delta || {}; if (delta.content) content += delta.content; if (delta.reasoning) { reasoningChars += delta.reasoning.length; reasoning += delta.reasoning; } } catch {} }
}
writeFileSync(out, content + '\n'); writeFileSync(out.replace('.md', '.reasoning.txt'), reasoning);
console.log('done', r.status, out, 'content chars', content.length, 'reasoning chars', reasoningChars);
