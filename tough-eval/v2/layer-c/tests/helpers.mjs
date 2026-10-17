// SPDX-License-Identifier: GPL-3.0-or-later
// Test helpers for layer C: a stored (uncompressed) .docx writer, and a pinned fixture of one RedlineBench-shaped task
// served by a fake fetch exactly as the Hugging Face API and resolve endpoints answer at a revision.
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

/** A zip archive of { name: string | Buffer } with every entry stored. */
export function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'); const n = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const r = t => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const ins = (a, t) => `<w:ins w:id="1" w:author="${a}">${r(t)}</w:ins>`;
const del = (a, t) => `<w:del w:id="2" w:author="${a}"><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:del>`;
/** A .docx whose body is the given paragraph bodies (already XML), with optional comments. */
export function docx(paragraphs, comments = []) {
  const body = paragraphs.map(p => `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${p}</w:p>`).join('') + '<w:tbl><w:tr><w:tc><w:p>' + r('table text is outside the view') + '</w:p></w:tc></w:tr></w:tbl>';
  const files = { '[Content_Types].xml': '<Types/>', 'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>` };
  if (comments.length) files['word/comments.xml'] = `<w:comments ${W}>${comments.map(c => `<w:comment w:id="${c.id}" w:author="${c.author}"><w:p>${r(c.text)}</w:p></w:comment>`).join('')}</w:comments>`;
  return zip(files);
}
export const P = { r, ins, del, anchor: id => `<w:commentRangeStart w:id="${id}"/>` };

export const REV = 'eee1b6790982ed1279e86bec7616b662a61993e6';
export const TASK = 'redline-s9-t4-g01a';
const CONTRACT = [
  `${r('1. Definitions. “Services” means the hosted service.')}`,
  `${r('2. Cap. Liability shall not exceed the fees paid in 12 months')}${ins('Trainer 1 - LargeCo', ' or $1,000,000')}${r('.')}`,
  `${r('3. Training. Provider will not train AI models on Customer Data')}${del('Trainer 1 - LargeCo', ' except for service improvement')}${r('.')}`,
  `${P.anchor(7)}${r('4. Testing. Customer may not probe the Service')}${ins('Trainer 2 - LargeCo', ', except for security testing')}${r('.')}`,
];
const ATTORNEY = [
  CONTRACT[0],
  `${r('2. Cap. Liability shall not exceed the fees paid in 12 months')}${ins('Trainer 1 - LargeCo', '')}${r('.')}`,
  CONTRACT[2],
  `${P.anchor(9)}${r('4. Testing. Customer may not probe the Service.')}`,
  `${r('5. Notices. Notices are given in writing.')}`,
];
export function fixtureFiles() {
  return {
    'task.toml': `[metadata]\nscenario_label = "Fixture MSA"\nplatform_task_id = "999"\ninput_group = "s9-t4-g01"\nvariant = "a"\nlevel = "4"\nrepresented_party = "AgentCo"\ncounterparty = "LargeCo"\n`,
    'instruction.md': `# Representation — AgentCo Legal (Side A)\n\n## Mandate\n\nRedline the provided contract in **AgentCo's best interests**.\n\n## Hard constraints\n\n- You do not represent LargeCo.\n\n# Contract Redliner — base mechanics\n\n## Redlining hygiene\n\n- **Targeted and minimal.** Only delete or add what's necessary.\n- **Whole-section removal uses \`mark_reserved.py\`.**\n\n# Turn 4 — response to prior redlines\n\n## Your job in a response turn is mostly classification, then action\n\n1. **Acceptable as written.** Leave it alone; optionally, reply with **\`add_comment.py --reply-to N --comment "Accepted."\`** so they see it.\n3. **Unacceptable.** Apply a \`propose_edits.py\` op that walks the change back.\n\n## How to plan in a response turn\n\n- **Tier 1:** reject unacceptable counterparty changes.\n\n## Grounding\n`,
    'environment/app/contract.docx': docx(CONTRACT, [{ id: 7, author: 'Trainer 2 - LargeCo', text: 'We need to test.' }]),
    'environment/app/grounding/Scenario_9.extracted.md': '# Extracted text of Scenario_9.pdf\n\n Shared context \n A fixture deal. \n Vendor-side guidelines \n Core objective:  Win the deal. \n Liability and indemnity:  Protect the cap at fees \n paid in the prior twelve months. \n Security, SLA and audit:  Resist uncontrolled testing. \n',
    'tests/rubrics.json': JSON.stringify({ task_id: 999, rubrics: [
      { id: 'rubric_cap', criteria: 'Rejects in Section 2 the insertion of "or $1,000,000".', justification: 'Cap at 12 months of fees.', category: 'Negotiation Quality', weight: 5 },
      { id: 'rubric_train', criteria: 'Accepts in Section 3 the deletion of "except for service improvement".', justification: 'No training.', category: 'Commercial Context', weight: 7 },
      { id: 'rubric_test', criteria: 'Rejects in Section 4 the security testing exception.', justification: 'Uncontrolled testing.', category: 'Legal correctness', weight: 9 },
      { id: 'rubric_excluded', criteria: 'Changes the governing law.', justification: 'Preference.', category: 'Commercial Context', weight: 2 }] }),
    'tests/attorney_redlines.docx': docx(ATTORNEY, [{ id: 7, author: 'Trainer 2 - LargeCo', text: 'We need to test.' }, { id: 9, author: 'Trainer 2 - AgentCo', text: 'We can’t accept testing of our systems.' }]),
    'tests/judge.py': 'not wanted by the importer',
  };
}
export const SELECTION = { [TASK]: { criteria: [
  { id: 'C-s9-01', rubricId: 'rubric_cap', class: 'A', kind: 'change', section: '2', adapted: 'The output proposes deleting "or $1,000,000" from Section 2.' },
  { id: 'C-s9-02', rubricId: 'rubric_train', class: 'U', kind: 'keep', section: '3', adapted: 'The deletion of "except for service improvement" in Section 3 stays.' },
  { id: 'C-s9-03', rubricId: 'rubric_test', class: 'A', kind: 'change', section: '4', adapted: 'The output proposes removing ", except for security testing" from Section 4.' }],
  excluded: [{ rubricId: 'rubric_excluded', class: 'I', reason: 'A preference with no grounding.' }] } };

const gitOid = b => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
/** A fetch that answers like huggingface.co at REV for the fixture task (LFS for .docx), and 404 elsewhere. */
export function fakeHub(files = fixtureFiles(), { tamper = null } = {}) {
  const bytes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')]));
  const tree = Object.entries(bytes).map(([p, b]) => ({ type: 'file', path: `tasks/${TASK}/${p}`, size: b.length, oid: gitOid(b), ...(p.endsWith('.docx') ? { lfs: { oid: createHash('sha256').update(b).digest('hex'), size: b.length } } : {}) }));
  const calls = [];
  const res = (status, body, json) => ({ ok: status === 200, status, json: async () => json, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes(`/api/datasets/crosbylegal/RedlineBench/tree/${REV}/tasks/${TASK}`)) return res(200, Buffer.alloc(0), [{ type: 'directory', path: `tasks/${TASK}/tests` }, ...tree]);
    if (url.includes(`/api/datasets/crosbylegal/RedlineBench/revision/${REV}`)) return res(200, Buffer.alloc(0), { sha: REV, lastModified: '2026-06-18T14:40:28.000Z', cardData: { license: 'cc-by-4.0' } });
    const m = url.match(new RegExp(`/resolve/${REV}/tasks/${TASK}/(.+)$`)); if (m && bytes[m[1]]) { const b = tamper === m[1] ? Buffer.concat([bytes[m[1]], Buffer.from(' ')]) : bytes[m[1]]; return res(200, b); }
    return res(404, Buffer.alloc(0));
  };
  return { fetchImpl, calls };
}
