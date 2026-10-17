// SPDX-License-Identifier: GPL-3.0-or-later
// A fake of the parts of Office.js and the Word API that src/word.js calls, installed into the page before the pane loads
// (page.addInitScript). It lets a real browser drive the real pane, against the real server, with no Word.
//
// The document is a list of paragraphs; a paragraph is a list of characters, each with an id and a state: 'n' plain,
// 'ins' a tracked insertion, 'del' a tracked deletion (with author, date and revision id). Paragraph and range text is
// what Word reports: tracked deletions excluded. A range is the ids of its first and last character, so it survives
// edits elsewhere in the paragraph, as a Word range does. Tracking mode, revisions, bookmarks, highlights and the
// add-in settings are kept in sessionStorage, which is what survives a task-pane reload in Word: the document is still
// open, every JavaScript handle is gone. window.__word exposes the state to the test.
//
// Comments (WordApi 1.4, product v2 spec 11.2): `seed.comments` puts a thread on a paragraph ({ paragraph, author,
// text, resolved }); body.getComments() lists them, comment.getRange() is the paragraph it sits on and comment.reply()
// adds a reply under the lawyer's name. A new paragraph inserted under tracking is one tracked insertion. Paragraphs
// carry a uniqueLocalId (WordApi 1.6) that survives insertions around them.
//
// Limits, deliberately: the file Word hands over (getFileAsync) is the seed .docx; edits made in the fake are not
// written back into it. One paragraph per range. Deleting your own insertion removes it; deleting anything else under
// tracking marks it deleted (rejecting that deletion restores what was there, another author's insertion included). Rejecting a paragraph that is wholly a tracked insertion removes it, as Word does.
//
// Keep this function self-contained: Playwright serialises it into the page, so it cannot use anything outside it.
export function installOfficeFake(seed) {
  const KEY = 'office-fake-document';
  const now = () => new Date().toISOString();
  const fresh = () => {
    let id = 1, rev = 1; const paragraphs = seed.paragraphs.map(segments => segments.flatMap(seg => {
      const r = seg.state === 'n' ? null : rev++;
      return [...seg.text].map(ch => ({ id: id++, ch, s: seg.state, a: seg.author || null, d: seg.date || null, r }));
    }));
    const comments = (seed.comments || []).map((c, k) => { const list = paragraphs[c.paragraph] || []; return { id: `c${k + 1}`, from: list[0]?.id ?? null, to: list[list.length - 1]?.id ?? null, author: c.author || 'Counterparty', text: c.text || '', resolved: !!c.resolved, replies: [] }; });
    return { paragraphs, nextId: id, nextRev: rev, mode: 'Off', bookmarks: {}, settings: {}, highlighted: [], selection: null, log: [], comments };
  };
  let state; try { state = JSON.parse(sessionStorage.getItem(KEY)) || fresh(); } catch { state = fresh(); }
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
  const log = entry => { state.log.push(entry); save(); };
  save();

  const chars = p => state.paragraphs[p];
  const visible = p => chars(p).filter(c => c.s !== 'del');
  const textOf = p => visible(p).map(c => c.ch).join('');
  const indexOf = (p, id) => chars(p).findIndex(c => c.id === id);
  const tracking = () => state.mode === 'TrackAll';
  const where = id => { for (let p = 0; p < state.paragraphs.length; p++) if (indexOf(p, id) >= 0) return p; return -1; };

  function searchIn(p, list, needle) {
    const text = list.map(c => c.ch).join(''); const out = []; let from = 0;
    if (!needle) return out;
    // Word refuses a search string over 255 characters (stress audit: the real error reached the pane as its bare code).
    if (needle.length > 255) throw Object.assign(new Error('SearchStringInvalidOrTooLong'), { code: 'SearchStringInvalidOrTooLong', name: 'RichApi.Error' });
    while (true) { const at = text.indexOf(needle, from); if (at < 0) break; out.push(range(p, list[at].id, list[at + needle.length - 1].id)); from = at + 1; }
    return out;
  }
  const collection = items => ({ items, load() { return this; } });

  // Consecutive characters of one revision make one tracked change.
  function changesIn(p, from = 0, to = chars(p).length - 1) {
    const list = chars(p); const out = []; let i = 0;
    while (i < list.length) {
      const c = list[i]; if (c.s === 'n') { i++; continue; }
      let j = i; while (j + 1 < list.length && list[j + 1].r === c.r && list[j + 1].s === c.s) j++;
      if (j >= from && i <= to) out.push(trackedChange(p, list.slice(i, j + 1).map(x => x.id)));
      i = j + 1;
    }
    return out;
  }
  function trackedChange(p, ids) {
    const first = chars(p).find(c => c.id === ids[0]);
    const text = ids.map(id => chars(p).find(c => c.id === id)?.ch || '').join('');
    return { type: first.s === 'ins' ? 'Added' : 'Deleted', text, author: first.a, date: first.d,
      load() { return this; },
      reject() { const set = new Set(ids); if (first.s === 'ins') { const whole = chars(p).every(c => set.has(c.id)); state.paragraphs[p] = chars(p).filter(c => !set.has(c.id)); if (whole) state.paragraphs.splice(p, 1); } else chars(p).forEach(c => { if (set.has(c.id)) { Object.assign(c, c.was || { s: 'n', a: null, d: null, r: null }); delete c.was; } }); log({ op: 'reject', type: this.type, text }); },
      accept() { const set = new Set(ids); if (first.s === 'del') state.paragraphs[p] = chars(p).filter(c => !set.has(c.id)); else chars(p).forEach(c => { if (set.has(c.id)) Object.assign(c, { s: 'n', a: null, d: null, r: null }); }); log({ op: 'accept', type: this.type, text }); } };
  }

  function range(p, fromId, toId) {
    const span = () => { const a = indexOf(p, fromId), b = indexOf(p, toId); return a < 0 || b < 0 ? [] : chars(p).slice(a, b + 1); };
    return {
      isNullObject: false,
      get text() { return span().filter(c => c.s !== 'del').map(c => c.ch).join(''); },
      paragraphs: { getFirst: () => paragraph(p) },
      load() { return this; },
      search(needle) { return collection(searchIn(p, span().filter(c => c.s !== 'del'), needle)); },
      expandTo(other) { return range(p, fromId, other._to); },
      _to: toId,
      insertText(text, location) {
        const author = seed.author || 'Lawyer', r = tracking() ? state.nextRev++ : null, d = now();
        const added = [...text].map(ch => ({ id: state.nextId++, ch, s: tracking() ? 'ins' : 'n', a: tracking() ? author : null, d: tracking() ? d : null, r }));
        const at = /before|start/i.test(location) ? indexOf(p, fromId) : indexOf(p, toId) + 1;
        chars(p).splice(at, 0, ...added);
        log({ op: 'insert', location, text, tracked: tracking() });
        return range(p, added[0].id, added[added.length - 1].id);
      },
      delete() {
        const author = seed.author || 'Lawyer', ids = new Set(span().map(c => c.id)), r = state.nextRev++, d = now(); let removed = '';
        state.paragraphs[p] = chars(p).filter(c => {
          if (!ids.has(c.id) || c.s === 'del') return true;
          removed += c.ch;
          if (!tracking() || (c.s === 'ins' && c.a === author)) return false;
          if (c.s === 'ins') c.was = { s: c.s, a: c.a, d: c.d, r: c.r }; // rejecting this deletion brings their insertion back
          Object.assign(c, { s: 'del', a: author, d, r }); return true;
        });
        log({ op: 'delete', text: removed, tracked: tracking() });
      },
      insertBookmark(name) { state.bookmarks[name] = { p, from: fromId, to: toId }; log({ op: 'bookmark', name }); },
      getTrackedChanges() { const a = indexOf(p, fromId), b = indexOf(p, toId); return collection(changesIn(p, a, b)); },
      select(mode = 'Select') { state.selection = { p, text: this.text, mode }; log({ op: 'select', mode, text: this.text }); },
      highlight() { state.highlighted = [...new Set([...state.highlighted, ...span().map(c => c.id)])]; log({ op: 'highlight', text: this.text }); },
      removeHighlight() { const ids = new Set(span().map(c => c.id)); state.highlighted = state.highlighted.filter(id => !ids.has(id)); log({ op: 'removeHighlight' }); },
      untrack() { return this; },
    };
  }
  function paragraph(p) {
    const whole = () => { const list = chars(p); return list.length ? range(p, list[0].id, list[list.length - 1].id) : null; };
    return {
      get text() { return textOf(p); },
      get uniqueLocalId() { return `u${chars(p)[0]?.id ?? `empty${p}`}`; },
      load() { return this; },
      insertParagraph(text, location) {
        const author = seed.author || 'Lawyer', r = tracking() ? state.nextRev++ : null, d = now();
        const added = [...text].map(ch => ({ id: state.nextId++, ch, s: tracking() ? 'ins' : 'n', a: tracking() ? author : null, d: tracking() ? d : null, r }));
        const at = /before|start/i.test(location) ? p : p + 1;
        state.paragraphs.splice(at, 0, added);
        log({ op: 'insertParagraph', location, text, tracked: tracking() });
        return paragraph(at);
      },
      search(needle) { return collection(searchIn(p, visible(p), needle)); },
      getTrackedChanges() { return collection(changesIn(p)); },
      getRange() { return whole(); },
    };
  }
  const body = {
    get text() { return state.paragraphs.map((_, p) => textOf(p)).join('\n'); },
    paragraphs: { get items() { return state.paragraphs.map((_, p) => paragraph(p)); }, load() { return this; } },
    search(needle) { return collection(state.paragraphs.flatMap((_, p) => searchIn(p, visible(p), needle))); },
    getTrackedChanges() { return collection(state.paragraphs.flatMap((_, p) => changesIn(p))); },
    getRange() { return { getBookmarks() { return { value: Object.keys(state.bookmarks) }; } }; },
    getComments() { return collection(state.comments.map(comment)); },
  };
  function comment(c) {
    return {
      id: c.id, authorName: c.author, content: c.text, resolved: c.resolved,
      load() { return this; },
      getRange() { const p = where(c.from); return p < 0 ? { paragraphs: { getFirst: () => ({ text: '', uniqueLocalId: null, load() { return this; } }) } } : range(p, c.from, c.to); },
      reply(text) { const r = { author: seed.author || 'Lawyer', text }; c.replies.push(r); log({ op: 'reply', comment: c.id, text }); return { ...r, load() { return this; } }; },
    };
  }
  const document = {
    body,
    properties: { title: seed.title || '', load() { return this; } },
    get changeTrackingMode() { return state.mode; },
    set changeTrackingMode(mode) { state.mode = mode; log({ op: 'mode', mode }); },
    load() { return this; },
    getBookmarkRangeOrNullObject(name) {
      const b = state.bookmarks[name]; const p = b ? where(b.from) : -1;
      return p < 0 ? { isNullObject: true, load() { return this; } } : range(p, b.from, b.to);
    },
    deleteBookmark(name) { delete state.bookmarks[name]; log({ op: 'deleteBookmark', name }); },
    // The lawyer's selection in Word (window.__word.selectText / selectNone): its text and the paragraph it is in.
    getSelection() { const u = userSel; return { text: u ? u.text : '', paragraphs: { items: u ? [paragraph(u.p)] : [], load() { return this; } }, load() { return this; } }; },
  };
  let userSel = null; const selectionHandlers = [];
  const selectionChanged = () => selectionHandlers.forEach(h => h({ type: 'documentSelectionChanged' }));
  const context = { document, sync: async () => {}, trackedObjects: { add() {}, remove() {} } };

  const bytes = Uint8Array.from(atob(seed.fileBase64 || ''), c => c.charCodeAt(0));
  const settings = {
    get: k => state.settings[k], set: (k, v) => { state.settings[k] = v; save(); }, remove: k => { delete state.settings[k]; save(); },
    saveAsync: cb => { save(); cb?.({ status: 'succeeded' }); },
  };
  const maxSet = seed.wordApi || 1.8;
  window.Office = {
    onReady(cb) { const info = { host: 'Word', platform: 'Mac' }; setTimeout(() => cb?.(info), 0); return Promise.resolve(info); },
    context: { host: 'Word', platform: 'Mac', diagnostics: { version: 'office-fake' },
      requirements: { isSetSupported: (set, v) => set === 'WordApi' && Number(v) <= maxSet },
      document: { url: seed.url || '', settings,
        addHandlerAsync(type, handler, cb) { if (type === 'documentSelectionChanged') selectionHandlers.push(handler); cb?.({ status: 'succeeded' }); },
        removeHandlerAsync(type, options, cb) { const i = selectionHandlers.indexOf(options?.handler); if (i >= 0) selectionHandlers.splice(i, 1); cb?.({ status: 'succeeded' }); },
        getFileAsync(type, options, cb) {
          if (seed.fileFails) return cb({ status: 'failed', error: { message: 'The file could not be read.' } });
          cb({ status: 'succeeded', value: { size: bytes.length, sliceCount: 1, getSliceAsync: (i, done) => done({ status: 'succeeded', value: { data: Array.from(bytes) } }), closeAsync: done => done?.({ status: 'succeeded' }) } });
        } } },
    EventType: { DocumentSelectionChanged: 'documentSelectionChanged' },
    FileType: { Compressed: 'compressed' }, AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' }, HostType: { Word: 'Word' },
  };
  window.Word = {
    run: async (a, b) => (typeof a === 'function' ? a : b)(context),
    ChangeTrackingMode: { trackAll: 'TrackAll', off: 'Off' }, InsertLocation: { after: 'After', before: 'Before', replace: 'Replace' },
    SelectionMode: { start: 'Start', select: 'Select' },
  };
  window.__word = {
    texts: () => state.paragraphs.map((_, p) => textOf(p)),
    changes: () => state.paragraphs.flatMap((_, p) => changesIn(p).map(c => ({ paragraph: p, type: c.type, text: c.text, author: c.author }))),
    bookmarks: () => ({ ...state.bookmarks }),
    highlighted: () => { const ids = new Set(state.highlighted); return state.paragraphs.map((_, p) => visible(p).filter(c => ids.has(c.id)).map(c => c.ch).join('')).filter(Boolean); },
    settings: () => ({ ...state.settings }),
    selection: () => state.selection,
    log: () => state.log.slice(),
    comments: () => state.comments.map(c => ({ id: c.id, author: c.author, text: c.text, paragraph: where(c.from), replies: c.replies.slice() })),
    // Act as the lawyer would in Word, outside the pane.
    rejectBy(author) { for (let p = state.paragraphs.length - 1; p >= 0; p--) for (const c of changesIn(p).reverse()) if (c.author === author) c.reject(); },
    selectText(p, text) { if (!textOf(p).includes(text)) throw Error(`"${text}" not in paragraph ${p}`); userSel = { p, text }; selectionChanged(); },
    selectNone() { userSel = null; selectionChanged(); },
    typeInto(p, from, to) { const t = textOf(p); const i = t.indexOf(from); if (i < 0) throw Error(`"${from}" not in paragraph ${p}`); const list = visible(p); const r = range(p, list[i].id, list[i + from.length - 1].id); r.insertText(to, 'After'); r.delete(); },
  };
}
