// SPDX-License-Identifier: GPL-3.0-or-later
// A small reader for the .docx files RedlineBench ships (BENCHMARK-V2.md section 7, layer C), with no dependency:
//   unzip      the zip container (stored and deflated entries, read through the central directory);
//   paragraphs the body's top-level paragraphs as RedlineBench's own tools number them (python-docx
//              `document.paragraphs`: direct w:p children of w:body; table and content-control paragraphs are outside
//              its view and its grader's), ids p-000, p-001, ...; per paragraph
//                text          as it now reads (tracked insertions in, tracked deletions out)
//                originalText  as it read before any tracked change (only when the paragraph carries revisions)
//              exactly the rules of redline-subset/extract.py (w:t, w:delText, w:tab as a space, w:br as a newline;
//              w:ins / w:moveTo current only, w:del / w:moveFrom original only), so the two readers agree;
//   comments   the comments part (id, author, text) and the paragraph each comment is anchored to.
import { inflateRawSync } from 'node:zlib';

/** Every entry of a zip archive as { name: Buffer }. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10); let at = buf.readUInt32LE(eocd + 16); const out = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw Error('corrupt zip central directory');
    const method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20), nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nlen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28); const data = buf.subarray(start, start + csize);
    if (method === 0) out[name] = Buffer.from(data); else if (method === 8) out[name] = inflateRawSync(data); else throw Error(`zip entry ${name}: compression method ${method} not supported`);
    at += 46 + nlen + xlen + clen;
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));
const attr = (attrs, name) => { const m = attrs.match(new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`)); return m ? unescapeXml(m[1]) : null; };

/** A light XML walk: calls on(type, name, attrs, text, stack) for open, close, self-closing tags and text. */
function walk(xml, on) {
  const rx = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g; const stack = []; let m;
  while ((m = rx.exec(xml))) {
    if (m[6] !== undefined || m[5] !== undefined) { on('text', null, '', m[6] !== undefined ? unescapeXml(m[6]) : m[5], stack); continue; }
    if (!m[2]) continue;
    if (m[1]) { on('close', m[2], '', null, stack); stack.pop(); continue; }
    if (m[4]) { stack.push(m[2]); on('empty', m[2], m[3], null, stack); stack.pop(); continue; }
    stack.push(m[2]); on('open', m[2], m[3], null, stack);
  }
}

/** The text of one paragraph's XML (current, original), its tracked-change segments and the comment ids anchored in it.
 *  segments: [{ text, kind: 'ins' | 'del' | null, author }] in document order, adjacent pieces of one kind merged. */
function paragraphTexts(pxml) {
  let current = '', original = ''; const comments = [], segments = []; const marks = [];
  const push = (text, kind, author) => { const last = segments[segments.length - 1]; if (last && last.kind === kind && last.author === author) last.text += text; else segments.push({ text, kind, author }); };
  walk(pxml, (type, name, attrs, text, stack) => {
    if (type === 'open' && ['w:ins', 'w:del', 'w:moveTo', 'w:moveFrom'].includes(name)) marks.push({ kind: name === 'w:ins' || name === 'w:moveTo' ? 'ins' : 'del', author: attr(attrs, 'w:author') });
    if (type === 'close' && ['w:ins', 'w:del', 'w:moveTo', 'w:moveFrom'].includes(name)) marks.pop();
    if (type === 'empty' && (name === 'w:commentRangeStart' || name === 'w:commentReference')) { const id = attr(attrs, 'w:id'); if (id !== null && !comments.includes(id)) comments.push(id); }
    let value = null; const leaf = stack[stack.length - 1];
    if (type === 'text' && (leaf === 'w:t' || leaf === 'w:delText')) value = text;
    else if (type === 'empty' && name === 'w:tab' && stack.includes('w:r')) value = ' ';
    else if (type === 'empty' && name === 'w:br') value = '\n';
    if (value === null) return;
    const inIns = stack.includes('w:ins') || stack.includes('w:moveTo'); const inDel = stack.includes('w:del') || stack.includes('w:moveFrom');
    const mark = [...marks].reverse().find(m => (inDel || leaf === 'w:delText' ? m.kind === 'del' : m.kind === 'ins')) || null;
    if (leaf === 'w:delText' || inDel) { original += value; push(value, 'del', mark?.author ?? null); }
    else if (inIns) { current += value; push(value, 'ins', mark?.author ?? null); }
    else { current += value; original += value; push(value, null, null); }
  });
  return { current, original, comments, segments };
}

/** The XML of each direct w:p child of w:body, in order. */
export function bodyParagraphXml(documentXml) {
  const body = documentXml.indexOf('<w:body'); if (body < 0) throw Error('word/document.xml has no w:body');
  const out = []; const rx = /<(\/?)(w:p|w:tbl|w:sdt|w:body)(?=[\s>/])([^>]*?)(\/?)>/g; rx.lastIndex = body; let depth = 0, start = -1, m;
  // depth counts nesting of w:p / w:tbl / w:sdt under the body; only depth-0 w:p elements are top-level paragraphs.
  while ((m = rx.exec(documentXml))) {
    const [whole, close, name, , self] = m;
    if (name === 'w:body') { if (close) break; continue; }
    if (self) { if (depth === 0 && name === 'w:p') out.push(whole); continue; }
    if (!close) { if (depth === 0 && name === 'w:p') start = m.index; depth++; }
    else { depth--; if (depth === 0 && name === 'w:p' && start >= 0) { out.push(documentXml.slice(start, m.index + whole.length)); start = -1; } }
  }
  return out;
}

/** The comments part: [{ id, author, text }]. */
export function readComments(commentsXml) {
  if (!commentsXml) return [];
  const out = []; const rx = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g; let m;
  while ((m = rx.exec(commentsXml))) {
    const paras = [...m[2].matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)].map(p => paragraphTexts(p[0]).current);
    out.push({ id: attr(m[1], 'w:id'), author: attr(m[1], 'w:author'), text: paras.join('\n').trim() });
  }
  return out;
}

/**
 * A .docx as the review's document shape plus its comments and tracked-change markup:
 * { paragraphs: [{ id, text, originalText? }], comments: [{ id, author, text, paragraphId }],
 *   markup: { <paragraph id>: segments } (only paragraphs that carry tracked changes) }.
 */
export function readDocx(buf) {
  const files = unzip(buf); const doc = files['word/document.xml']; if (!doc) throw Error('no word/document.xml');
  const paragraphs = []; const anchor = new Map(); const markup = {};
  bodyParagraphXml(doc.toString('utf8')).forEach((px, i) => {
    const id = `p-${String(i).padStart(3, '0')}`; const t = paragraphTexts(px);
    paragraphs.push(t.original !== t.current ? { id, text: t.current, originalText: t.original } : { id, text: t.current });
    if (t.segments.some(x => x.kind)) markup[id] = t.segments;
    for (const c of t.comments) if (!anchor.has(c)) anchor.set(c, id);
  });
  const comments = readComments(files['word/comments.xml']?.toString('utf8')).map(c => ({ ...c, paragraphId: anchor.get(c.id) ?? null }));
  return { paragraphs, comments, markup };
}
