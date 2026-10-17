// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from Paperless-ngx (https://github.com/paperless-ngx/paperless-ngx), GPL-3.0.
//   Source: src/documents/matching.py (`matches`, `_split_match`) and src/documents/regex.py (`safe_regex_search`,
//   `validate_regex_pattern`), commit c50c6f5517e3fd8f97fa546ede69a52b622e2b20; the Python is kept unchanged in
//   ./reference/ for provenance. Fuzzy matching follows rapidfuzz 3.14.6 `fuzz.partial_ratio` (MIT), the version
//   Paperless pins at that commit.
//   Modified: translated to JavaScript for GinChugger, 15 October 2026. MATCH_AUTO (the trained classifier) is
//   left out; the model object is plain data ({ match, matchingAlgorithm, isInsensitive }) instead of a Django model;
//   the document is its text. Product v2 spec section 10.A; residual differences in docs/ports/known-diffs.md.
//
// Python -> JavaScript semantics this file keeps (spec 10.A.6):
// - Python `re` on str is Unicode-aware: \w is str.isalnum() or "_" and \s is str.isspace(); JavaScript's \w, \s and
//   \b are ASCII, so the classes below spell them out with Unicode properties (`u` flag) and \b is a lookaround pair.
// - REGEX mode runs Paperless's `regex` module, whose \w is the UTS #18 word class (Alphabetic, marks, decimal digits,
//   connector punctuation, join controls) and whose \s is White_Space; patterns are translated to JavaScript and run
//   under a 0.1-second time guard (Paperless's MATCH_REGEX_TIMEOUT_SECONDS default). Python syntax JavaScript cannot
//   express is refused: the match is false and validateRegexPattern() names the reason for the counterparty page.
// - Strings are compared by code point, as Python does, not by UTF-16 unit.
import vm from 'node:vm';

export const MATCH_NONE = 'none';
export const MATCH_ANY = 'any';
export const MATCH_ALL = 'all';
export const MATCH_LITERAL = 'literal';
export const MATCH_REGEX = 'regex';
export const MATCH_FUZZY = 'fuzzy';
export const ALGORITHMS = [MATCH_NONE, MATCH_ANY, MATCH_ALL, MATCH_LITERAL, MATCH_REGEX, MATCH_FUZZY];
export const REGEX_TIMEOUT_MS = 100;

let logger = (level, message) => console[level === 'error' ? 'error' : 'warn'](`paperless matching: ${message}`);
/** Where log lines go (Paperless logs a refused or timed-out regex; it never fails the match loudly). */
export function setLogger(fn) { logger = fn; }

// ---- character classes (Python `re` on str)
/** Python `re` \s: the characters str.isspace() accepts (Unicode 15). */
export const PY_SPACE = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Python `re` \w: str.isalnum() or "_". */
export const PY_WORD = '\\p{L}\\p{N}_';
const wordBoundary = w => `(?:(?<=[${w}])(?![${w}])|(?<![${w}])(?=[${w}]))`;
const notWordBoundary = w => `(?:(?<=[${w}])(?=[${w}])|(?<![${w}])(?![${w}]))`;
const PY_B = wordBoundary(PY_WORD);
// ---- character classes (the `regex` module, REGEX mode)
const RX_WORD = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}';
const RX_SPACE = '\\p{White_Space}';

/** Python's str.strip() with no argument. */
const pyStrip = s => s.replace(new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu'), '');
/** re.escape for a JavaScript `u` pattern: the same literal, spelled so the `u` flag accepts it. */
export const escapeRegex = s => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
/** Python re's IGNORECASE makes i, I, dotted İ and dotless ı one class; JavaScript's case folding pairs only i and I. */
const foldDotless = (s, insensitive) => (insensitive ? s.replace(/[İı]/gu, 'i') : s);
const search = (source, content, insensitive) => new RegExp(source, insensitive ? 'iu' : 'u').test(foldDotless(content, insensitive));

/**
 * Does the counterparty's rule match the document's text? `matchingModel` is { match, matchingAlgorithm,
 * isInsensitive }; `documentContent` is the text (Paperless reads document.get_effective_content() or "").
 */
export function matches(matchingModel, documentContent) {
  const documentContentText = documentContent || '';
  const match = String(matchingModel.match ?? '');
  const insensitive = !!matchingModel.isInsensitive;

  // Check that match is not empty
  if (!pyStrip(match)) return false;

  switch (matchingModel.matchingAlgorithm) {
    case MATCH_NONE:
      return false;
    case MATCH_ALL:
      for (const word of _splitMatch(matchingModel)) {
        if (!search(`${PY_B}${foldDotless(word, insensitive)}${PY_B}`, documentContentText, insensitive)) return false;
      }
      return true;
    case MATCH_ANY:
      for (const word of _splitMatch(matchingModel)) {
        if (search(`${PY_B}${foldDotless(word, insensitive)}${PY_B}`, documentContentText, insensitive)) return true;
      }
      return false;
    case MATCH_LITERAL:
      return search(`${PY_B}${foldDotless(escapeRegex(match), insensitive)}${PY_B}`, documentContentText, insensitive);
    case MATCH_REGEX:
      return !!safeRegexSearch(match, documentContentText, { ignoreCase: insensitive });
    case MATCH_FUZZY: {
      const strip = new RegExp(`[^${PY_WORD}${PY_SPACE}]`, 'gu');
      let m = match.replace(strip, '');
      let text = documentContentText.replace(strip, '');
      if (insensitive) { m = m.toLowerCase(); text = text.toLowerCase(); }
      return partialRatio(m, text, 90) > 0;
    }
    default:
      throw new Error('Unsupported matching algorithm');
  }
}

/**
 * Splits the match to individual keywords, getting rid of unnecessary spaces and grouping quoted words together.
 * Each keyword is returned escaped, with its inner whitespace as one-or-more whitespace, ready to sit between \b.
 *   '  some random  words "with   quotes  " and   spaces' => some, random, words, with\s+quotes, and, spaces
 */
export function _splitMatch(matchingModel) {
  const findterms = new RegExp(`"([^"]+)"|([^${PY_SPACE}]+)`, 'gu');
  const normspace = s => s.replace(new RegExp(`[${PY_SPACE}]+`, 'gu'), ' ');
  return [...String(matchingModel.match ?? '').matchAll(findterms)]
    .map(t => escapeRegex(normspace(pyStrip(t[1] || t[2]))).replaceAll(' ', `[${PY_SPACE}]+`));
}

// ---- REGEX mode: Paperless's safe_regex_search over a translation of the pattern

const ESCAPE_CLASS = { w: `[${RX_WORD}]`, W: `[^${RX_WORD}]`, d: '\\p{Nd}', D: '\\P{Nd}', s: RX_SPACE, S: '\\P{White_Space}' };
const IN_CLASS = { w: RX_WORD, d: '\\p{Nd}', D: '\\P{Nd}', s: RX_SPACE, S: '\\P{White_Space}' };
const CONTROL = { n: '\\n', t: '\\t', r: '\\r', f: '\\f', v: '\\v', a: '\\x07' };
const refuse = (why) => { throw Object.assign(new Error(why), { code: 'regex_unsupported' }); };
const isHex = (s, n) => s.length === n && /^[0-9a-fA-F]+$/.test(s);
const codePoint = cp => `\\u{${cp.toString(16)}}`;

function propertyEscape(kind, name) {
  // The regex module accepts \p{Lu}, \p{Latin}, \p{IsLatin}, \p{Script=Latin}; JavaScript wants a canonical form.
  const candidates = [name, `Script=${name}`, name.replace(/^Is/, ''), `Script=${name.replace(/^Is/, '')}`, `General_Category=${name}`];
  for (const c of candidates) { try { new RegExp(`\\${kind}{${c}}`, 'u'); return `\\${kind}{${c}}`; } catch { /* try the next spelling */ } }
  return refuse(`The property \\${kind}{${name}} is not known here.`);
}

/** Translate a Python `regex` (version 0) pattern to a JavaScript source and flags, or throw `regex_unsupported`. */
export function translateRegex(pattern, { ignoreCase = false } = {}) {
  const ch = Array.from(pattern);
  const flags = { i: ignoreCase, m: false, s: false, x: false };
  let i = 0;
  // Global inline flags at the start, as in (?i) or (?ms).
  for (;;) {
    const m = /^\(\?([a-zA-Z]+)\)/.exec(ch.slice(i).join(''));
    if (!m) break;
    for (const f of m[1]) {
      if (f === 'i') flags.i = true; else if (f === 'm') flags.m = true; else if (f === 's') flags.s = true; else if (f === 'x') flags.x = true;
      else if (f !== 'u') refuse(`The inline flag (?${f}) is not supported here.`);
    }
    i += Array.from(m[0]).length;
  }
  // Capturing groups are emitted with a marker naming their Python number (or a wrapper's own number), and numbered
  // references with a marker too; the last step numbers the JavaScript groups in order of their opening parenthesis,
  // because the atomic and possessive emulation below adds capturing groups Python does not have.
  let out = '';
  let groups = 0; let wrappers = 0;
  const open = tag => `\u0001C${tag}\u0001(`;
  const ref = tag => `\u0001R${tag}\u0001(?:)`;
  const stack = []; // per open group: { start, close }
  let atomStart = -1;
  const peek = (k = 0) => ch[i + k];
  const readUntil = (end) => { let s = ''; while (i < ch.length && ch[i] !== end) s += ch[i++]; if (ch[i] !== end) refuse(`Missing ${end} in the pattern.`); i++; return s; };
  const readHex = n => { const s = ch.slice(i, i + n).join(''); if (!isHex(s, n)) refuse('A hex escape needs its digits.'); i += n; return parseInt(s, 16); };

  function escape(inClass) {
    const e = ch[i++];
    if (e === undefined) refuse('The pattern ends with a backslash.');
    if (inClass ? IN_CLASS[e] : ESCAPE_CLASS[e]) return inClass ? IN_CLASS[e] : ESCAPE_CLASS[e];
    if (inClass && e === 'W') refuse('\\W inside a character class is not supported here.');
    if (inClass && e === 'b') return '\\x08';
    if (!inClass && e === 'b') return wordBoundary(RX_WORD);
    if (!inClass && e === 'B') return notWordBoundary(RX_WORD);
    if (!inClass && e === 'A') return '(?<![\\s\\S])';
    if (!inClass && e === 'Z') return '(?![\\s\\S])';
    if (CONTROL[e]) return CONTROL[e];
    if (e === 'x') return codePoint(readHex(2));
    if (e === 'u') return codePoint(readHex(4));
    if (e === 'U') return codePoint(readHex(8));
    if (e === 'p' || e === 'P') {
      if (peek() === '{') { i++; return propertyEscape(e, readUntil('}')); }
      return propertyEscape(e, ch[i++] || refuse('A property escape needs a name.'));
    }
    if (/[0-7]/.test(e) && (e === '0' || (/[0-7]/.test(peek() || '') && /[0-7]/.test(peek(1) || '')))) {
      let digits = e; while (digits.length < 3 && /[0-7]/.test(peek() || '')) digits += ch[i++];
      return codePoint(parseInt(digits, 8));
    }
    if (/[1-9]/.test(e) && !inClass) {
      let digits = e; if (/[0-9]/.test(peek() || '')) digits += ch[i++];
      if (Number(digits) > groups) refuse(`Group ${digits} is referred to before it exists.`);
      return ref(`p${digits}`);
    }
    if (/[A-Za-z0-9]/.test(e)) refuse(`The escape \\${e} is not supported here.`);
    // Any other escaped character stands for itself.
    if (inClass) return /[\\\]\[\-^]/.test(e) ? `\\${e}` : e;
    return escapeRegex(e);
  }

  function charClass() {
    let s = '[';
    if (peek() === '^') { s += '^'; i++; }
    if (peek() === ']') { s += '\\]'; i++; }
    for (;;) {
      const c = ch[i];
      if (c === undefined) refuse('A character class is not closed.');
      if (c === ']') { i++; return `${s}]`; }
      if (c === '[') { if (peek(1) === ':') refuse('POSIX classes such as [[:alpha:]] are not supported here.'); s += '\\['; i++; continue; }
      if (c === '\\') { i++; s += escape(true); continue; }
      s += c === '/' ? '\\/' : c; i++;
    }
  }

  function quantifierTail() {
    if (peek() === '?') { out += '?'; i++; return; }
    if (peek() !== '+') return;
    // Possessive X*+ is atomic (?>X*): emulated as (?=(X*))\N, which never gives back what it took.
    i++;
    if (atomStart < 0) refuse('A possessive quantifier needs something to repeat.');
    const w = `w${++wrappers}`;
    out = `${out.slice(0, atomStart)}(?=${open(w)}${out.slice(atomStart)}))${ref(w)}`;
  }

  while (i < ch.length) {
    const c = ch[i];
    if (flags.x && new RegExp(`^[${PY_SPACE}]$`, 'u').test(c)) { i++; continue; }
    if (flags.x && c === '#') { while (i < ch.length && ch[i] !== '\n') i++; continue; }
    const quantifier = c === '*' || c === '+' || c === '?' || (c === '{' && /^\{(\d+(,\d*)?|,\d*)\}/.test(ch.slice(i, i + 24).join('')));
    if (!quantifier && c !== ')') atomStart = out.length;
    switch (c) {
      case '\\': i++; out += escape(false); break;
      case '[': i++; out += charClass(); break;
      case '(': {
        i++;
        const start = out.length;
        if (peek() !== '?') { groups++; out += open(`p${groups}`); stack.push({ start, close: ')' }); break; }
        const rest = ch.slice(i).join('');
        let m;
        if (rest.startsWith('?:') || rest.startsWith('?=') || rest.startsWith('?!')) { out += `(${rest.slice(0, 2)}`; i += 2; stack.push({ start, close: ')' }); }
        else if (rest.startsWith('?<=') || rest.startsWith('?<!')) { out += `(${rest.slice(0, 3)}`; i += 3; stack.push({ start, close: ')' }); }
        else if (rest.startsWith('?>')) { const w = `w${++wrappers}`; out += `(?=${open(w)}`; i += 2; stack.push({ start, close: `))${ref(w)}` }); }
        else if ((m = /^\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest))) { groups++; out += `${open(`p${groups}`).slice(0, -1)}(?<${m[1]}>`; i += m[0].length; stack.push({ start, close: ')' }); }
        else if ((m = /^\?P=([A-Za-z_][A-Za-z0-9_]*)\)/.exec(rest))) { out += `\\k<${m[1]}>`; i += m[0].length; }
        else if (rest.startsWith('?#')) { i += 2; readUntil(')'); }
        else refuse(`The group (${rest.slice(0, 3)}… is not supported here.`);
        break;
      }
      case ')': {
        i++;
        const g = stack.pop();
        if (!g) refuse('A closing parenthesis has no opening one.');
        out += g.close; atomStart = g.start;
        break;
      }
      case '.': i++; out += flags.s ? '[\\s\\S]' : '[^\\n]'; break;
      case '^': i++; out += flags.m ? '(?<![^\\n])' : '(?<![\\s\\S])'; break;
      case '$': i++; out += flags.m ? '(?=\\n|(?![\\s\\S]))' : '(?=\\n?(?![\\s\\S]))'; break;
      case '*': case '+': case '?': i++; out += c; quantifierTail(); break;
      case '{': {
        const m = /^\{(\d*)(?:(,)(\d*))?\}/.exec(ch.slice(i).join(''));
        if (m && (m[1] !== '' || m[2])) { out += `{${m[1] || '0'}${m[2] ? `,${m[3]}` : ''}}`; i += m[0].length; quantifierTail(); } else { out += '\\{'; i++; }
        break;
      }
      case '}': case ']': case '/': i++; out += `\\${c}`; break;
      default: i++; out += c;
    }
  }
  if (stack.length) refuse('A group is not closed.');
  const numbers = new Map(); let n = 0;
  for (const m of out.matchAll(/\u0001C(\w+)\u0001/g)) numbers.set(m[1], ++n);
  out = out.replace(/\u0001C\w+\u0001/g, '').replace(/\u0001R(\w+)\u0001/g, (m, tag) => `\\${numbers.get(tag)}`);
  const jsFlags = flags.i ? 'iu' : 'u';
  try { new RegExp(out, jsFlags); } catch (e) { refuse(`The pattern could not be read: ${e.message}`); }
  return { source: out, flags: jsFlags };
}

/** Port of validate_regex_pattern: throws with a plain reason when the pattern will not run here. */
export function validateRegexPattern(pattern) { translateRegex(String(pattern ?? '')); }

const guard = vm.createContext(Object.create(null));
const guarded = new vm.Script('re.test(text)');

/**
 * Port of safe_regex_search: a search with a time limit. Validation errors and timeouts are logged and treated as no
 * match. Returns true or null (the Python returns a match object or None; only its truth is used).
 */
export function safeRegexSearch(pattern, text, { ignoreCase = false, timeoutMs = REGEX_TIMEOUT_MS } = {}) {
  let compiled;
  try {
    const t = translateRegex(pattern, { ignoreCase });
    compiled = new RegExp(t.source, t.flags);
  } catch (e) {
    logger('error', `Error while processing regular expression ${pattern.slice(0, 80)}: ${e.message}`);
    return null;
  }
  guard.re = compiled; guard.text = text;
  try {
    return guarded.runInContext(guard, { timeout: timeoutMs }) ? true : null;
  } catch (e) {
    if (e.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
    logger('warn', `Regular expression matching timed out for pattern ${pattern.slice(0, 80)}`);
    return null;
  } finally { guard.re = null; guard.text = null; }
}

// ---- FUZZY mode: rapidfuzz fuzz.partial_ratio

/** Length of the longest common subsequence of a (as a bit-parallel pattern) and b, by Hyyrö's algorithm. */
function lcsLength(pm, len1, b, from, to) {
  const words = Math.ceil(len1 / 32);
  const S = new Uint32Array(words).fill(0xffffffff);
  const top = len1 % 32 === 0 ? 0xffffffff : (2 ** (len1 % 32)) - 1;
  S[words - 1] = top;
  for (let k = from; k < to; k++) {
    const M = pm.get(b[k]);
    if (!M) continue;
    let carry = 0;
    for (let w = 0; w < words; w++) {
      const s = S[w]; const u = (s & M[w]) >>> 0;
      const sum = s + u + carry;
      carry = sum > 0xffffffff ? 1 : 0;
      S[w] = ((sum >>> 0) | (s & ~u)) >>> 0;
    }
    S[words - 1] &= top;
  }
  let ones = 0;
  for (let w = 0; w < words; w++) { let v = S[w]; while (v) { v &= v - 1; ones++; } }
  return len1 - ones;
}

function patternMasks(a) {
  const pm = new Map(); const words = Math.ceil(a.length / 32);
  a.forEach((c, idx) => { if (!pm.has(c)) pm.set(c, new Uint32Array(words)); pm.get(c)[idx >> 5] |= (1 << (idx & 31)) >>> 0; });
  return pm;
}

/** Normalised Indel similarity of a and b[from:to], 0 when below the cutoff (rapidfuzz's block similarity). */
function normalizedSimilarity(pm, a, b, from, to, cutoff) {
  const maximum = a.length + (to - from);
  const dist = maximum - 2 * lcsLength(pm, a.length, b, from, to);
  const normSim = 1.0 - (maximum ? dist / maximum : 0);
  return normSim >= cutoff ? normSim : 0;
}

/** rapidfuzz's _partial_ratio_impl: s1 no longer than s2; every alignment that could be optimal is scored. */
function partialRatioImpl(s1, s2, scoreCutoff) {
  const len1 = s1.length; const len2 = s2.length;
  const s1CharSet = new Set(s1); const pm = patternMasks(s1);
  let best = 0;
  for (let i = 1; i < len1; i++) {
    if (!s1CharSet.has(s2[i - 1])) continue;
    const r = normalizedSimilarity(pm, s1, s2, 0, i, scoreCutoff);
    if (r > best) { best = scoreCutoff = r; if (best === 1) return 100; }
  }
  for (let i = 0; i < len2 - len1; i++) {
    if (!s1CharSet.has(s2[i + len1 - 1])) continue;
    const r = normalizedSimilarity(pm, s1, s2, i, i + len1, scoreCutoff);
    if (r > best) { best = scoreCutoff = r; if (best === 1) return 100; }
  }
  for (let i = Math.max(0, len2 - len1); i < len2; i++) {
    if (!s1CharSet.has(s2[i])) continue;
    const r = normalizedSimilarity(pm, s1, s2, i, len2, scoreCutoff);
    if (r > best) { best = scoreCutoff = r; if (best === 1) return 100; }
  }
  return best * 100;
}

/** rapidfuzz fuzz.partial_ratio(s1, s2, score_cutoff): 0 to 100, or 0 below the cutoff. Compares code points. */
export function partialRatio(s1, s2, scoreCutoff = 0) {
  const a = Array.from(s1); const b = Array.from(s2);
  if (!a.length && !b.length) return 100 >= scoreCutoff ? 100 : 0;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let score = partialRatioImpl(shorter, longer, scoreCutoff / 100);
  if (score !== 100 && a.length === b.length) {
    const score2 = partialRatioImpl(longer, shorter, Math.max(scoreCutoff, score) / 100);
    if (score2 > score) score = score2;
  }
  return score < scoreCutoff ? 0 : score;
}
