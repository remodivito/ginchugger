// SPDX-License-Identifier: GPL-3.0-or-later
// One text extraction off the main thread (product v2 spec 7.2 step 4, 8.1 T3): run by extractTextInWorker in
// extract.js, so a pathological attachment cannot block the event loop every lawyer's requests share.
import { parentPort, workerData } from 'node:worker_threads';
import { extractText } from './files.js';

const { bytes, mediaType, name } = workerData;
parentPort.postMessage(await extractText(Buffer.from(bytes), mediaType, name));
