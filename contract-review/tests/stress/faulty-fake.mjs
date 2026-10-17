// SPDX-License-Identifier: GPL-3.0-or-later
// The in-memory store with faults injected from a JSON file (see store-faults.mjs). Same exports as server/store/fake.js.
import { readFileSync } from 'node:fs';
import { createFakeStore as realCreate, paperlessRejects } from '../../server/store/fake.js';
import { storeError } from '../../server/store/index.js';

export { paperlessRejects };
const faults = () => { try { return JSON.parse(readFileSync(process.env.GCL_STRESS_STORE_FAULTS, 'utf8')); } catch { return {}; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SKIP = new Set(['then', 'failNextTask', 'constructor']);

function wrap(target, real) {
  if (!target || typeof target !== 'object') return target;
  const cache = new Map();
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop !== 'string' || SKIP.has(prop)) return value;
      if (typeof value === 'function') {
        if (!cache.has(prop)) cache.set(prop, async function (...args) {
          const f = faults();
          if (f.slowMs) await sleep(Number(f.slowMs));
          if (f.down) throw storeError(503, 'store_unavailable', 'The document store cannot be reached (fetch failed).');
          if (f.raw) throw storeError(400, 'store_rejected', `The document store refused GET /api/documents/?query=${encodeURIComponent(typeof args[0] === 'string' ? args[0] : 'contract')} (400: {"query":["SearchStringInvalidOrTooLong: whoosh.QueryParserError at line 1"]}).`, { upstreamStatus: 400 });
          if (f.failTasks && prop === 'addDocument') real.failNextTask(String(f.failTasks));
          const r = await value.apply(obj, args);
          return prop === 'as' ? wrap(r, r) : r;
        });
        // `as` is synchronous in the fake: keep it so (it returns another user's view of the same store).
        if (prop === 'as') return (...args) => { const r = value.apply(obj, args); return wrap(r, r); };
        return cache.get(prop);
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) { if (!cache.has(prop)) cache.set(prop, wrap(value, real)); return cache.get(prop); }
      return value;
    },
  });
}
export function createFakeStore(options) { const store = realCreate(options); return wrap(store, store); }
