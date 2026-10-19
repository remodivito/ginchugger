// Cost estimates and token medians for the README charts, from the raw runs (tough-eval/runs/, held back from the public
// snapshot). Prints one line per run; copy the values into data.json. Open-model cost is an estimate: tokens × the listed
// prices in data.json, never a bill. Usage: node tough-eval/v2/charts/extract.mjs [runDir ...]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, '../../runs');
const { prices } = JSON.parse(readFileSync(path.join(HERE, 'data.json'), 'utf8'));
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

const args = process.argv.slice(2);
const runs = args.length ? args : existsSync(RUNS) ? readdirSync(RUNS).filter(d => /Z-(frozen|variant)-A-/.test(d)).map(d => path.join(RUNS, d)) : [];
if (!runs.length) { console.error('No runs found: the raw runs are not part of the public snapshot.'); process.exit(1); }

for (const dir of runs) {
  const files = readdirSync(path.join(dir, 'results')).filter(f => f.endsWith('.json'));
  const cost = [], out = [];
  for (const f of files) {
    const r = JSON.parse(readFileSync(path.join(dir, 'results', f), 'utf8'));
    const u = r.model?.usage ?? {};
    const o = u.completion_tokens ?? u.output_tokens; if (o) out.push(o);
    const price = Object.entries(prices.models).find(([id]) => dir.includes(id.split('/')[1].split('-').slice(0, 2).join('-')))?.[1];
    if (price && u.prompt_tokens != null) {
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      cost.push(((u.prompt_tokens - cached) * price.input + cached * price.cacheRead + (o ?? 0) * price.output) / 1e6);
    }
  }
  const c = median(cost);
  console.log(`${path.basename(dir)}  reviews ${files.length}  median output tokens ${median(out) ?? 'n/a'}  estimated cost ${c == null ? 'n/a (reported by the CLI)' : '$' + c.toFixed(4)}`);
}
