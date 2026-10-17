// SPDX-License-Identifier: GPL-3.0-or-later
// Content-addressed file store (product v2 spec section 5.3). A blob lives at <data>/files/<sha256[0:2]>/<sha256> with
// no extension, written to files/tmp first and renamed into place; the bytes are never changed. Text is extracted at
// store time: .docx by docx.js, .eml headers and text body, .txt/.md as text, paragraph documents as given; PDFs are
// stored with no text (no OCR in v2.0).
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { importDocx } from '../docx.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const PARAGRAPHS_MEDIA = 'application/vnd.ginchugger.paragraphs+json';
export const MEDIA = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eml': 'message/rfc822',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': PARAGRAPHS_MEDIA,
};
export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** Identity of a document's words, tracked changes included, whatever its bytes (as matter.js `contentKey`). */
export const contentKey = paragraphs => Array.isArray(paragraphs) && paragraphs.length ? sha256(Buffer.from(JSON.stringify(paragraphs.map(p => [p.text, typeof p.originalText === 'string' ? p.originalText : null])))) : null;

export const blobPath = (dataDir, hash) => path.join(dataDir, 'files', hash.slice(0, 2), hash);
export const storedPath = hash => `files/${hash.slice(0, 2)}/${hash}`;

export function mediaTypeOf(name, { allowOther = false } = {}) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (MEDIA[ext]) return MEDIA[ext];
  if (allowOther) return 'application/octet-stream';
  throw Object.assign(new Error('Not a document we file.'), { status: 400, code: 'bad_request' });
}

/** Write a blob once; storing the same bytes again leaves the first copy. */
export function writeBlob(dataDir, buffer) {
  const hash = sha256(buffer); const target = blobPath(dataDir, hash);
  if (existsSync(target)) return hash;
  const tmp = path.join(dataDir, 'files', 'tmp'); mkdirSync(tmp, { recursive: true }); mkdirSync(path.dirname(target), { recursive: true });
  const t = path.join(tmp, randomUUID()); writeFileSync(t, buffer); renameSync(t, target);
  return hash;
}
export const readBlob = (dataDir, hash) => readFileSync(blobPath(dataDir, hash));

// ---- .eml: headers and a text body, nothing fetched (section 5.3). `parseEml` reads the headers (and a body, for the
// synchronous callers); `extractText` takes the body and subject from mailparser (MIT), which decodes every charset and
// transfer encoding, with link and image handling off. HTML becomes text here; nothing in it is fetched.
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(/utf-?8/i.test(charset) ? 'utf-8' : 'latin1').decode(buf);
    } catch { return text; }
  });
}
function splitHead(raw) {
  const i = raw.search(/\r?\n\r?\n/); const head = i < 0 ? raw : raw.slice(0, i); const body = i < 0 ? '' : raw.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const m = /^([^:\s]+):\s*(.*)$/.exec(line); if (m) { const k = m[1].toLowerCase(); if (!(k in headers)) headers[k] = m[2]; } }
  return { headers, body };
}
function decodeBody(body, headers) {
  const enc = String(headers['content-transfer-encoding'] || '').toLowerCase().trim();
  const charset = /charset="?([^";]+)"?/i.exec(headers['content-type'] || '')?.[1] || 'utf-8';
  let buf;
  if (enc === 'base64') buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') buf = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  else return body;
  try { return new TextDecoder(/utf-?8/i.test(charset) ? 'utf-8' : 'latin1').decode(buf); } catch { return buf.toString('utf8'); }
}
export const htmlToText = html => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
function textPart(body, headers, depth = 0) {
  const type = String(headers['content-type'] || 'text/plain').toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(headers['content-type'] || '')?.[1];
  if (type.startsWith('multipart/') && boundary && depth < 5) {
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\r?\\n?`)).slice(1).map(p => splitHead(p)).filter(p => Object.keys(p.headers).length);
    const plain = parts.map(p => textPart(p.body, p.headers, depth + 1)).filter(Boolean);
    return plain.find(p => p.kind === 'plain') || plain.find(p => p.kind === 'html') || null;
  }
  if (/attachment/i.test(headers['content-disposition'] || '')) return null;
  if (type.startsWith('text/plain')) return { kind: 'plain', text: decodeBody(body, headers).trim() };
  if (type.startsWith('text/html')) return { kind: 'html', text: htmlToText(decodeBody(body, headers)) };
  return null;
}
export function parseEml(buffer) {
  const { headers, body } = splitHead(buffer.toString('utf8'));
  const part = textPart(body, headers);
  return { from: decodeWords(headers.from) || null, to: decodeWords(headers.to) || null, subject: decodeWords(headers.subject) || null, date: headers.date || null, messageId: headers['message-id'] || null, text: part ? part.text : '' };
}

/** parseEml's headers, with the subject and body as mailparser decodes them (parseEml's when mailparser cannot read it). */
export async function parseEmlFull(buffer) {
  const head = parseEml(buffer);
  let p;
  try { p = await simpleParser(buffer, { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true, maxHtmlLengthToParse: 2_000_000 }); } catch { return head; }
  const text = typeof p.text === 'string' && p.text.trim() ? p.text.trim() : typeof p.html === 'string' ? htmlToText(p.html) : head.text;
  return { ...head, subject: p.subject ?? head.subject, text };
}

/** Extract text from stored bytes. Returns { textStatus, paragraphs, text, warnings, contentKey }. */
export async function extractText(buffer, mediaType, name) {
  try {
    if (mediaType === MEDIA['.docx']) {
      const doc = await importDocx(buffer, name);
      const paragraphs = doc.paragraphs.map(p => ({ id: p.id, text: p.text, ...(typeof p.originalText === 'string' && p.originalText !== p.text ? { originalText: p.originalText } : {}), ...(p.hidden ? { hidden: true } : {}) }));
      return { textStatus: 'extracted', paragraphs, text: paragraphs.map(p => p.text).join('\n'), warnings: doc.warnings || [], contentKey: contentKey(doc.paragraphs) };
    }
    if (mediaType === PARAGRAPHS_MEDIA) {
      const doc = JSON.parse(buffer.toString('utf8'));
      if (!doc || !Array.isArray(doc.paragraphs)) throw new Error('A paragraph document holds a paragraphs array.');
      const paragraphs = doc.paragraphs.map((p, i) => ({ id: typeof p.id === 'string' ? p.id : `p${i + 1}`, text: String(p.text ?? ''), ...(typeof p.originalText === 'string' && p.originalText !== p.text ? { originalText: p.originalText } : {}) }));
      return { textStatus: 'extracted', paragraphs, text: paragraphs.map(p => p.text).join('\n'), warnings: [], contentKey: contentKey(doc.paragraphs) };
    }
    if (mediaType === MEDIA['.eml']) {
      const mail = await parseEmlFull(buffer);
      const lines = mail.text.split(/\r?\n/);
      return { textStatus: 'extracted', paragraphs: lines.map((t, i) => ({ id: `p${i + 1}`, text: t })), text: mail.text, warnings: [{ from: mail.from, to: mail.to, subject: mail.subject, date: mail.date, messageId: mail.messageId }], contentKey: null };
    }
    if (mediaType === MEDIA['.txt'] || mediaType === MEDIA['.md']) {
      const text = buffer.toString('utf8');
      return { textStatus: 'extracted', paragraphs: text.split(/\r?\n/).map((t, i) => ({ id: `p${i + 1}`, text: t })), text, warnings: [], contentKey: null };
    }
    return { textStatus: 'not-extracted', paragraphs: null, text: null, warnings: [], contentKey: null };
  } catch (e) {
    return { textStatus: 'failed', paragraphs: null, text: null, warnings: [String(e.message || e)], contentKey: null };
  }
}

/** A synthetic .eml for a seed's covering email (section 5.5). */
export function syntheticEml({ from = '', subject = '', date = '', text = '' } = {}) {
  return Buffer.from(`From: ${from}\r\nSubject: ${subject}\r\nDate: ${date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`, 'utf8');
}
