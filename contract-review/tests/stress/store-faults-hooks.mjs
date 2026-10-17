// SPDX-License-Identifier: GPL-3.0-or-later
// Module resolve hook for store-faults.mjs: server/store/fake.js, imported by anything but faulty-fake.mjs, resolves to
// faulty-fake.mjs.
const WRAPPER = new URL('./faulty-fake.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r.url.endsWith('/server/store/fake.js') && context.parentURL !== WRAPPER) return { ...r, url: WRAPPER };
  return r;
}
