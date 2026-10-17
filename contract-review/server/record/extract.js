// SPDX-License-Identifier: GPL-3.0-or-later
// Text extraction in a worker thread with a time cap (product v2 spec 7.2 step 4, 8.1 T3). A file whose extraction
// takes longer than the cap, or crashes the worker, is stored all the same with `text_status = 'failed'`: that capture
// fails to give text, nothing else does. The mail consumer uses it; the record's storeFile takes it as `extract`.
import { Worker } from 'node:worker_threads';

export const EXTRACT_TIMEOUT_MS = 10_000;
const failed = reason => ({ textStatus: 'failed', paragraphs: null, text: null, warnings: [reason], contentKey: null });

export function extractTextInWorker(buffer, mediaType, name, { timeoutMs = EXTRACT_TIMEOUT_MS, resourceLimits = { maxOldGenerationSizeMb: 512 } } = {}) {
  return new Promise(resolve => {
    const bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), { workerData: { bytes, mediaType, name }, transferList: [bytes.buffer], resourceLimits });
    let done = false;
    const finish = out => { if (done) return; done = true; clearTimeout(timer); worker.terminate().catch(() => {}); resolve(out); };
    const timer = setTimeout(() => finish(failed(`Text extraction took longer than ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    worker.once('message', out => finish(out));
    worker.once('error', e => finish(failed(`Text extraction failed: ${e.message}`)));
    worker.once('exit', code => finish(failed(`Text extraction stopped (exit ${code}).`)));
  });
}
