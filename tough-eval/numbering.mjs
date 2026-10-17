// SPDX-License-Identifier: GPL-3.0-or-later
// Renders Word's automatic list numbering into paragraph text ("1.", "2.6", "(a)"), which the importer drops. Reads
// numbering.xml (abstract levels: start, numFmt, lvlText) and each paragraph's numPr, directly or through its style.
// Counters run per abstract list, and a level resets when a shallower level advances. Bullets and empty paragraphs are
// left unlabelled.
// Usage: const paragraphs = await numberedParagraphs(buffer)  ->  [{ text, label, level }]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../contract-review/package.json', import.meta.url));
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const kids = (node, name) => Array.from(node?.childNodes || []).filter(n => n.namespaceURI === W && n.localName === name);
const kid = (node, name) => kids(node, name)[0];
const val = node => node?.getAttributeNS(W, 'val') ?? node?.getAttribute('w:val') ?? null;
const all = (node, name) => Array.from(node.getElementsByTagNameNS(W, name));

function roman(n) { const r = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [v, t] of r) while (n >= v) { s += t; n -= v; } return s; }
function format(n, fmt) {
  switch (fmt) {
    case 'lowerLetter': return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    case 'upperLetter': return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    default: return String(n);
  }
}

export async function numberedParagraphs(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parse = async f => { const file = zip.file(f); return file ? new DOMParser().parseFromString(await file.async('string'), 'text/xml') : null; };
  const [doc, numbering, styles] = await Promise.all([parse('word/document.xml'), parse('word/numbering.xml'), parse('word/styles.xml')]);
  const abstract = {}; const nums = {};
  if (numbering) {
    for (const a of all(numbering, 'abstractNum')) {
      const id = a.getAttributeNS(W, 'abstractNumId') || a.getAttribute('w:abstractNumId'); abstract[id] = {};
      for (const l of kids(a, 'lvl')) {
        const ilvl = l.getAttributeNS(W, 'ilvl') || l.getAttribute('w:ilvl');
        abstract[id][ilvl] = { start: Number(val(kid(l, 'start')) ?? 1), fmt: val(kid(l, 'numFmt')) || 'decimal', text: val(kid(l, 'lvlText')) ?? '' };
      }
    }
    for (const n of all(numbering, 'num')) {
      const id = n.getAttributeNS(W, 'numId') || n.getAttribute('w:numId');
      nums[id] = { abstract: val(kid(n, 'abstractNumId')), overrides: Object.fromEntries(kids(n, 'lvlOverride').map(o => [o.getAttributeNS(W, 'ilvl') || o.getAttribute('w:ilvl'), Number(val(kid(o, 'startOverride')) ?? NaN)])) };
    }
  }
  const styleNum = {};
  if (styles) for (const s of all(styles, 'style')) {
    const numPr = kid(kid(s, 'pPr'), 'numPr'); if (!numPr) continue;
    styleNum[s.getAttributeNS(W, 'styleId') || s.getAttribute('w:styleId')] = { numId: val(kid(numPr, 'numId')), ilvl: val(kid(numPr, 'ilvl')) ?? '0' };
  }
  const counters = {}; const out = [];
  for (const p of all(doc, 'p')) {
    const text = all(p, 't').map(t => t.textContent).join('');
    const pPr = kid(p, 'pPr'); const direct = kid(pPr, 'numPr'); const style = val(kid(pPr, 'pStyle'));
    let numId = direct ? val(kid(direct, 'numId')) : null, ilvl = direct ? (val(kid(direct, 'ilvl')) ?? null) : null;
    if (style && styleNum[style]) { numId = numId ?? styleNum[style].numId; ilvl = ilvl ?? styleNum[style].ilvl; }
    ilvl = ilvl ?? '0';
    const num = numId && numId !== '0' ? nums[numId] : null; const levels = num ? abstract[num.abstract] : null;
    // Empty numbered paragraphs are not counted: Common Paper's CSA has one before section 1 that its published copy does not number.
    if (!levels || !levels[ilvl] || levels[ilvl].fmt === 'bullet' || levels[ilvl].fmt === 'none' || !text.trim()) { out.push({ text, label: null, level: null }); continue; }
    const c = counters[num.abstract] = counters[num.abstract] || {}; const L = Number(ilvl);
    const start = l => Number.isNaN(num.overrides[l] ?? NaN) ? levels[l]?.start ?? 1 : num.overrides[l];
    c[L] = c[L] === undefined ? start(L) : c[L] + 1;
    for (const k of Object.keys(c)) if (Number(k) > L) delete c[k];
    const label = levels[ilvl].text.replace(/%(\d)/g, (_, d) => { const l = Number(d) - 1; return format(c[l] ?? start(l), levels[l]?.fmt || 'decimal'); });
    out.push({ text, label, level: L });
  }
  return out;
}
