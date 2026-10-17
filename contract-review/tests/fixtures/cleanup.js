// SPDX-License-Identifier: GPL-3.0-or-later
// Ending a spawned server and removing its state folder. On Windows a file another process still holds open cannot be
// unlinked (EBUSY), so the process must have exited before its record.sqlite goes, and removal retries briefly.
import { rm } from 'node:fs/promises';

/** Kill a child process and resolve once it has exited (at once if it already has). */
export function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => { child.once('exit', () => resolve()); child.kill(); });
}

/** Remove a folder and everything in it, retrying while Windows releases handles. */
export const removeDir = dir => (dir ? rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) : Promise.resolve());
