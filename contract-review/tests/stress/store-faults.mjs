// SPDX-License-Identifier: GPL-3.0-or-later
// Store fault injection for the stress harness (tests/stress), with no change to the app: the app (or team) server is
// started with `node --import ./tests/stress/store-faults.mjs`, which redirects server/store/fake.js (the in-memory
// store, GCL_STORE=fake) to faulty-fake.mjs. That wraps every store call: before it runs, the JSON file named by
// GCL_STRESS_STORE_FAULTS is read:
//   { "down": true }            every call fails as Paperless does when it cannot be reached
//   { "raw": true }             every call fails with the raw message the Paperless adapter makes for a refused request
//   { "failTasks": "message" }  every upload's task fails with that message (Paperless reports failures in the task)
//   { "slowMs": n }             every call waits n ms first
import { register } from 'node:module';
register('./store-faults-hooks.mjs', import.meta.url);
