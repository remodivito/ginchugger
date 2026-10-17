// SPDX-License-Identifier: GPL-3.0-or-later
// Load the record into the document store (tasks/paperless-store-plan.md task 3; decisions 190 and 191). One-off:
//   node scripts/migrate-record-to-paperless.mjs [path/to/record.sqlite]      (default .local/record.sqlite)
//   node scripts/migrate-record-to-paperless.mjs --retitle [path/to/record.sqlite]
//     (fix A, 16 Oct: titles carry no file extension; --retitle takes the extension off the title of every document in
//     the store that still has one, and changes nothing else. Idempotent: a second run changes nothing.)
//   node scripts/migrate-record-to-paperless.mjs --content-keys [path/to/record.sqlite]
//     (plan task 11: sets the "Content key" field, the hash of a Word file's paragraphs and tracked changes from our own
//     extraction, on every live .docx document that lacks it or holds a stale one, so the Library collapses copies
//     whose words are the same though Word gave them new bytes. Idempotent: a second run changes nothing.)
// The record is backed up first (record-before-paperless-<time>.sqlite beside it) and only ever read. Every stored file
// (rounds' files and covering emails, inbox entries, our standard forms, loose files: everything in `files`) becomes one
// document with:
//   title: its original name without the extension; counterparty: its matter's (the matter of its latest round, else the matter it was
//   stored in; an unconfirmed inbox entry: the suggested one);
//   type: from the matter's kind (nda → NDA, order-form → Order form, …), Email for an .eml;
//   created: the round's received_at (an inbox entry's, else the file's created_at);
//   tags: signed (the round was signed), on hold (the matter is held), inbox (the inbox entry is still waiting);
//   fields: Former matter (the matter's name), Former round ("2, theirs" or "2, theirs, covering email"), and Source
//   checksum (the record's SHA-256, which also makes the run idempotent);
//   notes: the matter's notes on its latest file; a standard form gets a note saying so.
// Paperless refuses JSON (verified 16 Oct), so a file in our paragraph format (the demo fixtures) is converted to a
// .docx with its tracked changes (server/docx.js) and says so in a note; its original stays in the backup.
// A file in the record's trash is moved to the store's trash after it is added. Re-running skips what is there.
// The store is the one the app would use (server/store/service.js; settings.json `store`, GCL_STORE_*), started if
// managed. Writes paperless-migration-<time>.json beside the record and prints the counts.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportDocx } from '../server/docx.js';
import { readStoreSettings } from '../server/settings.js';
import { storeConfig, createStoreService } from '../server/store/service.js';
import { TAG_SIGNED, TAG_HOLD, TAG_INBOX, TITLE_EXTENSION, titleFromName, CONTENT_KEY_FIELD } from '../server/store/index.js';
import { extractText, MEDIA } from '../server/record/files.js';

export const PARAGRAPHS_MEDIA = 'application/vnd.ginchugger.paragraphs+json';
export const FIELD_MATTER = 'Former matter';
export const FIELD_ROUND = 'Former round';
export const FIELD_SOURCE = 'Source checksum';
const ACTOR = { actor: { id: 'migration', admin: true } };
const sha256 = b => createHash('sha256').update(b).digest('hex');
const KIND_TYPES = { nda: 'NDA', 'order-form': 'Order form', msa: 'MSA', dpa: 'DPA', sow: 'SOW' };
/** A document type from a matter kind: known kinds by name, others as words (`supply-agreement` → Supply agreement). */
export const typeForKind = kind => (!kind ? null : KIND_TYPES[kind] || (s => s.charAt(0).toUpperCase() + s.slice(1))(String(kind).replace(/[-_]+/g, ' ')));
const isEml = f => f.media_type === 'message/rfc822' || /\.eml$/i.test(f.original_name);

/**
 * What a matter's trash events left in the trash (the record's projection, kept here as the one piece of the old record
 * layer this script still needs: decision 190 removed the rest; the script only reads an old record.sqlite).
 */
export function trashState(evs) {
  const t = { matter: null, rounds: new Map(), files: new Map(), purgedRounds: new Set(), purgedFiles: new Set() };
  for (const e of evs) {
    const p = e.payload;
    if (e.type === 'matter_trashed') t.matter = { at: e.at, actor: e.actor, seq: e.seq };
    else if (e.type === 'matter_restored') t.matter = null;
    else if (e.type === 'round_trashed') t.rounds.set(p.round, { at: e.at, actor: e.actor, seq: e.seq });
    else if (e.type === 'round_restored') t.rounds.delete(p.round);
    else if (e.type === 'round_purged') { t.rounds.delete(p.round); t.purgedRounds.add(p.round); }
    else if (e.type === 'file_trashed') t.files.set(p.sha256, { at: e.at, actor: e.actor, seq: e.seq });
    else if (e.type === 'file_restored') t.files.delete(p.sha256);
    else if (e.type === 'file_purged') { t.files.delete(p.sha256); t.purgedFiles.add(p.sha256); }
  }
  return t;
}

/**
 * What each file of the record becomes: [{ sha256, name, mediaType, blob, title, counterparty, type, created, tags,
 * fields, notes, trashed }]. `db`: the record (read only). `blobOf(sha256)`: the file's bytes, or null if missing.
 */
export function planMigration(db, blobOf) {
  const matters = new Map(db.prepare('SELECT m.*, c.name AS cp FROM matters m LEFT JOIN counterparties c ON c.id = m.counterparty_id').all().map(m => [m.id, m]));
  const rounds = db.prepare('SELECT * FROM rounds ORDER BY matter_id, n').all();
  const inbox = db.prepare('SELECT * FROM inbox').all();
  const forms = db.prepare('SELECT * FROM standard_forms').all();
  const hasNotes = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'matter_notes'").get();
  const notes = hasNotes ? db.prepare('SELECT * FROM matter_notes ORDER BY created_at, event_seq').all() : [];
  const events = db.prepare("SELECT * FROM events WHERE type LIKE '%_trashed' OR type LIKE '%_restored' OR type LIKE '%_purged' ORDER BY seq").all().map(e => ({ ...e, payload: JSON.parse(e.payload) }));
  const trash = new Map([...matters.keys()].map(id => [id, trashState(events.filter(e => e.matter_id === id))]));
  // A file kept in a matter without a round (an imported folder store's files) belongs to the matter it was stored in.
  const storedIn = new Map(); const storedOrder = new Map();
  for (const e of db.prepare("SELECT matter_id, json_extract(payload, '$.sha256') AS sha FROM events WHERE type = 'file_stored' AND matter_id IS NOT NULL ORDER BY seq").all()) { storedIn.set(e.sha, e.matter_id); storedOrder.set(e.matter_id, e.sha); }
  // The latest file of each matter carries its notes (plan task 3): its last round's, else the last file stored in it.
  const latest = new Map(storedOrder); for (const r of rounds) latest.set(r.matter_id, r.file_sha256);

  return db.prepare('SELECT * FROM files ORDER BY created_at, sha256').all().map(f => {
    const asFile = rounds.filter(r => r.file_sha256 === f.sha256); const asCover = rounds.filter(r => r.covering_sha256 === f.sha256);
    const uses = [...asFile.map(r => ({ r, covering: false })), ...asCover.map(r => ({ r, covering: true }))].sort((a, b) => a.r.received_at.localeCompare(b.r.received_at));
    const use = uses.at(-1) || null; const m = matters.get(use ? use.r.matter_id : storedIn.get(f.sha256)) || null;
    const waiting = inbox.find(e => e.status === 'waiting' && (e.file_sha256 === f.sha256 || e.covering_sha256 === f.sha256));
    const entry = waiting || inbox.find(e => e.file_sha256 === f.sha256 || e.covering_sha256 === f.sha256);
    let suggested = null; if (!m && waiting) { try { suggested = JSON.parse(waiting.suggestions || '{}'); } catch { suggested = null; } }
    const form = forms.find(x => x.file_sha256 === f.sha256);
    const kind = m?.kind || (form ? form.kind : suggested?.kind) || null;
    const tags = [];
    if (asFile.some(r => r.signed)) tags.push(TAG_SIGNED);
    if (uses.some(u => matters.get(u.r.matter_id)?.on_hold) || (!use && m?.on_hold)) tags.push(TAG_HOLD);
    if (waiting) tags.push(TAG_INBOX);
    const fields = { [FIELD_SOURCE]: f.sha256 };
    if (m) fields[FIELD_MATTER] = m.name;
    if (use) fields[FIELD_ROUND] = `${use.r.n}, ${use.r.side}${use.covering ? ', covering email' : ''}`;
    const noteList = [];
    for (const [matterId, sha] of latest) if (sha === f.sha256) for (const n of notes.filter(x => x.matter_id === matterId)) noteList.push(`${n.text}\n\n(Matter note by ${n.author || 'unknown'}, ${n.created_at.slice(0, 10)}${n.edited_at ? `, edited ${n.edited_at.slice(0, 10)}` : ''}; matter: ${matters.get(matterId)?.name})`);
    if (form) noteList.push(`Our standard form for ${form.kind} (${form.name}), from the record.`);
    const t = m ? trash.get(m.id) : null;
    const trashed = !!(t && (t.matter || uses.some(u => u.r.matter_id === m.id && t.rounds.has(u.r.n)) || t.files.has(f.sha256)));
    return {
      sha256: f.sha256, name: f.original_name, mediaType: f.media_type, bytes: f.bytes, blob: blobOf(f.sha256),
      title: titleFromName(f.original_name), counterparty: m?.cp || suggested?.counterparty?.name || null, type: isEml(f) ? 'Email' : typeForKind(kind),
      created: (use?.r.received_at || entry?.received_at || f.created_at).slice(0, 10), tags, fields, notes: noteList, trashed,
    };
  });
}

/** Our paragraph format as a .docx (tracked changes kept), since Paperless refuses JSON. */
async function paragraphsToDocx(buffer, name) {
  const doc = JSON.parse(buffer.toString('utf8'));
  const paragraphs = (doc.paragraphs || []).map((p, i) => ({ id: p.id || `p${i + 1}`, text: String(p.text ?? ''), ...(typeof p.originalText === 'string' ? { originalText: p.originalText } : {}) }));
  return Buffer.from(await exportDocx({ id: name, title: doc.title || name.replace(/\.json$/i, ''), paragraphs }, null, { author: 'GinChugger (migrated)' }));
}

/** An existing document for this record file, in the store or its trash: by our Source checksum field, else by the original's checksum. */
async function existing(store, sha, trash) {
  const byField = await store.list({ fields: [[FIELD_SOURCE, 'exact', sha]], pageSize: 1 });
  return byField.results[0] || await store.findByChecksum(sha) || trash.find(d => d.fields?.[FIELD_SOURCE] === sha || d.checksum === sha) || null;
}

/**
 * Add every planned file to `store` (a store with our rules). Returns the report: counts and one line per file.
 * `verify`: download each original afterwards and compare checksums.
 */
export async function migrateRecord({ db, blobOf, store, verify = true, log = () => {} }) {
  await store.taxonomy.fields.ensure(FIELD_SOURCE, { dataType: 'string' });
  await store.taxonomy.fields.ensure(FIELD_MATTER, { dataType: 'string' });
  await store.taxonomy.fields.ensure(FIELD_ROUND, { dataType: 'string' });
  const plan = planMigration(db, blobOf);
  const trash = await store.listTrash();
  const rows = [];
  for (const p of plan) {
    const row = { sha256: p.sha256, name: p.name, title: p.title, counterparty: p.counterparty, type: p.type, created: p.created, tags: p.tags, outcome: null, documentId: null, converted: false, verified: null, notes: p.notes.length, trashed: p.trashed };
    rows.push(row);
    try {
      if (!p.blob) { row.outcome = 'missing'; log(`missing  ${p.name}: the file is not in the record's files folder`); continue; }
      if (sha256(p.blob) !== p.sha256) { row.outcome = 'failed'; row.error = 'the stored bytes do not match the record checksum'; continue; }
      const found = await existing(store, p.sha256, trash);
      if (found) { row.outcome = 'skipped'; row.documentId = found.id; row.converted = found.checksum !== p.sha256; log(`skipped  ${p.name}: already document ${found.id}`); }
      else {
        let body = p.blob; let filename = p.name;
        if (p.mediaType === PARAGRAPHS_MEDIA || /\.json$/i.test(p.name)) { body = await paragraphsToDocx(p.blob, p.name); filename = p.name.replace(/\.json$/i, '') + '.docx'; row.converted = true; }
        const doc = await store.add(body, { filename, title: p.title, counterparty: p.counterparty, type: p.type, created: p.created, tags: p.tags, fields: p.fields }, ACTOR);
        row.documentId = doc.id; row.outcome = 'added';
        const notes = row.converted ? [...p.notes, `Converted from the record's paragraph format (${p.name}, SHA-256 ${p.sha256}) because the store does not take JSON; the original is in the record backup.`] : p.notes;
        for (const n of notes) await store.notes.add(doc.id, n, ACTOR);
        row.notes = notes.length;
        if (p.trashed) await store.trash([doc.id], ACTOR).then(() => { row.trashedInStore = true; }, e => { row.trashedInStore = false; row.error = e.message; });
        log(`added    ${p.name} → document ${doc.id}${row.converted ? ' (converted to .docx)' : ''}`);
      }
      if (verify && row.documentId && !p.trashed) {
        const o = await store.getOriginal(row.documentId);
        row.verified = row.converted ? sha256(o.body) === (await store.getDocument(row.documentId)).checksum && (await store.getDocument(row.documentId)).fields[FIELD_SOURCE] === p.sha256 : sha256(o.body) === p.sha256;
      }
    } catch (e) { row.outcome = 'failed'; row.error = e.message; log(`FAILED   ${p.name}: ${e.message}`); }
  }
  const count = (fn) => rows.filter(fn).length;
  const by = key => rows.filter(r => r.outcome === 'added' || r.outcome === 'skipped').reduce((o, r) => { const vals = [].concat(r[key] ?? []); for (const v of vals.length ? vals : ['(none)']) o[v] = (o[v] || 0) + 1; return o; }, {});
  const summary = {
    filesInRecord: rows.length, added: count(r => r.outcome === 'added'), skipped: count(r => r.outcome === 'skipped'), failed: count(r => r.outcome === 'failed'), missing: count(r => r.outcome === 'missing'),
    byteIdentical: count(r => r.verified === true && !r.converted), converted: count(r => r.converted), convertedVerified: count(r => r.verified === true && r.converted), verifyFailed: count(r => r.verified === false),
    notesAdded: rows.filter(r => r.outcome === 'added').reduce((n, r) => n + r.notes, 0), trashed: count(r => r.trashedInStore),
    byType: by('type'), byCounterparty: by('counterparty'), byTag: by('tags'),
  };
  summary.inStore = summary.added + summary.skipped;
  summary.countsMatch = summary.inStore === summary.filesInRecord && summary.failed === 0 && summary.missing === 0 && summary.verifyFailed === 0;
  return { summary, files: rows };
}

/**
 * Fix A: every live document whose title ends in a file extension gets the title without it. Returns
 * { checked, retitled: [{ id, from, to }] }. Documents in the trash are left as they are.
 */
export async function retitleDocuments(store, { log = () => {} } = {}) {
  const retitled = []; let checked = 0;
  for (let page = 1; ; page++) {
    const r = await store.list({ sort: 'added', page, pageSize: 100 });
    for (const d of r.results) {
      checked++;
      if (!TITLE_EXTENSION.test(d.title || '')) continue;
      const to = titleFromName(d.title);
      if (to === d.title) continue;
      await store.update(d.id, { title: to }, ACTOR);
      retitled.push({ id: d.id, from: d.title, to });
      log(`retitled ${d.id}: ${d.title} → ${to}`);
    }
    if (page * r.pageSize >= r.count || !r.results.length) break;
  }
  return { checked, retitled };
}

/**
 * Plan task 11: the Content key field on every live .docx document, from our own extraction of its original. Returns
 * { checked, set: [{ id, title, key }], unchanged, failed: [{ id, title, error }] }. Documents in the trash are left.
 */
export async function setContentKeys(store, { log = () => {} } = {}) {
  await store.taxonomy.fields.ensure(CONTENT_KEY_FIELD, { dataType: 'string' });
  const set = []; const failed = []; let checked = 0, unchanged = 0;
  for (let page = 1; ; page++) {
    const r = await store.list({ sort: 'added', page, pageSize: 100 });
    for (const d of r.results) {
      const isDocx = /\.docx$/i.test(d.originalName || '') || d.mimeType === MEDIA['.docx'];
      if (!isDocx) continue;
      checked++;
      try {
        const t = await extractText((await store.getOriginal(d.id)).body, MEDIA['.docx'], d.originalName || d.title);
        if (!t.contentKey) { failed.push({ id: d.id, title: d.title, error: t.warnings?.[0] || 'no text' }); continue; }
        if (d.fields?.[CONTENT_KEY_FIELD] === t.contentKey) { unchanged++; continue; }
        await store.update(d.id, { fields: { [CONTENT_KEY_FIELD]: t.contentKey } }, ACTOR);
        set.push({ id: d.id, title: d.title, key: t.contentKey });
        log(`content key ${d.id}: ${d.title} → ${t.contentKey.slice(0, 12)}…`);
      } catch (e) { failed.push({ id: d.id, title: d.title, error: e.message }); log(`FAILED   ${d.id} ${d.title}: ${e.message}`); }
    }
    if (page * r.pageSize >= r.count || !r.results.length) break;
  }
  return { checked, set, unchanged, failed };
}

async function main(argvAll) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const retitle = argvAll.includes('--retitle');
  const contentKeys = argvAll.includes('--content-keys');
  const argv = argvAll.filter(a => a !== '--retitle' && a !== '--content-keys');
  const recordPath = path.resolve(argv[0] || path.join(root, '.local', 'record.sqlite'));
  if (contentKeys) {
    const dataDir = path.dirname(recordPath);
    const config = storeConfig({ settings: readStoreSettings(dataDir), dataDir, defaultMode: 'managed' });
    const service = createStoreService({ config });
    const s = await service.start();
    if (s.state !== 'ready') { console.error(`The document store is ${s.state}: ${s.reason}`); process.exit(1); }
    const r = await setContentKeys(service.serviceClient(), { log: line => console.log(line) });
    console.log(`Word documents checked: ${r.checked}. Content key set: ${r.set.length}. Already set: ${r.unchanged}. Failed: ${r.failed.length}.`);
    process.exit(r.failed.length ? 1 : 0);
  }
  if (retitle) {
    const dataDir = path.dirname(recordPath);
    const config = storeConfig({ settings: readStoreSettings(dataDir), dataDir, defaultMode: 'managed' });
    const service = createStoreService({ config });
    const s = await service.start();
    if (s.state !== 'ready') { console.error(`The document store is ${s.state}: ${s.reason}`); process.exit(1); }
    const r = await retitleDocuments(service.serviceClient(), { log: line => console.log(line) });
    console.log(`Documents checked: ${r.checked}. Retitled: ${r.retitled.length}.`);
    process.exit(0);
  }
  if (!existsSync(recordPath)) { console.error(`No record at ${recordPath}.`); process.exit(2); }
  const dataDir = path.dirname(recordPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const db = new Database(recordPath, { readonly: true, fileMustExist: true });
  const backup = path.join(dataDir, `record-before-paperless-${stamp}.sqlite`);
  await db.backup(backup);
  console.log(`Backed up the record to ${backup}.`);
  const config = storeConfig({ settings: readStoreSettings(dataDir), dataDir, defaultMode: 'managed' });
  console.log(`Starting the document store (${config.mode}${config.url ? ` at ${config.url}` : ''}${config.mode === 'managed' ? `, data in ${config.dataDir}` : ''})…`);
  const service = createStoreService({ config });
  const s = await service.start();
  if (s.state !== 'ready') { console.error(`The document store is ${s.state}: ${s.reason}`); process.exit(1); }
  const blobOf = sha => { const f = path.join(dataDir, 'files', sha.slice(0, 2), sha); return existsSync(f) ? readFileSync(f) : null; };
  const report = await migrateRecord({ db, blobOf, store: service.serviceClient(), log: line => console.log(line) });
  const out = path.join(dataDir, `paperless-migration-${stamp}.json`);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), record: recordPath, backup, store: s, ...report }, null, 2) + '\n');
  const m = report.summary;
  console.log(`\nFiles in the record: ${m.filesInRecord}. Added: ${m.added}. Already there: ${m.skipped}. Failed: ${m.failed}. Missing: ${m.missing}.`);
  console.log(`Byte-identical: ${m.byteIdentical}. Converted to .docx: ${m.converted} (verified ${m.convertedVerified}). Notes added: ${m.notesAdded}. Moved to the trash: ${m.trashed}.`);
  console.log(`Counts match: ${m.countsMatch ? 'yes' : 'NO'}. Report: ${out}`);
  db.close();
  process.exit(m.countsMatch ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
