// The receiving side is a file, not a service (docs/FIELD-REPORTS.md, "For the product's developers"): reports that
// arrived as files in a folder (how they arrive is the developers' own way), joined by their signature (the version's
// major.minor, the operating system, the command's kind, the error's class) and listed by how often each came up.
// Node's major and the processor kind are counted inside each group, not in its key: the same missing repository on
// two computers that differ only there is one trouble. Node stays in the key for the classes it causes.
//
// Only the folder itself is read, not its sub-folders; a link is not followed; a file over INBOX_FILE_MAX bytes or one
// that is not exactly a report (shape.mjs strictReport) is counted as "not read" and never printed.
import fs from 'node:fs';
import path from 'node:path';
import { strictReport } from './shape.mjs';

export const INBOX_FILE_MAX = 4096;
export const INBOX_FILES_MAX = 20_000;

const minor = (v) => (v === 'other' ? 'other' : v.split('.').slice(0, 2).join('.'));
export const NODE_CLASSES = Object.freeze(['node-too-old', 'terminal-module', 'build-tools']);
const systemKind = (r) => (NODE_CLASSES.includes(r.class) ? `${r.system.os}-node${r.system.node}` : r.system.os);

/** The signature two reports share when they are the same trouble. */
export const signatureOf = (r) => ({ version: minor(r.version), system: systemKind(r), kind: r.kind, class: r.class });
const keyOf = (sig) => `${sig.version}|${sig.system}|${sig.kind}|${sig.class}`;

/**
 * Read `dir`. → { read, notRead, groups: [{ signature, count, outcome, first, last, failedSteps: { id: n }, stepIns: { id: n },
 * nodes: { node22: n }, arches: { x64: n } }] },
 * the groups by count (most first), then by the newest. Throws a plain error when `dir` is not a folder.
 */
export function readInbox(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw Object.assign(new Error('that folder is not there'), { code: 'not-folder' });
  }
  if (!st.isDirectory()) throw Object.assign(new Error('that is not a folder'), { code: 'not-folder' });
  const groups = new Map();
  let read = 0;
  let notRead = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isDirectory()).slice(0, INBOX_FILES_MAX);
  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue;
    const file = path.join(dir, e.name);
    let r = null;
    try {
      const fst = fs.lstatSync(file); // a link is not followed
      if (fst.isFile() && fst.size <= INBOX_FILE_MAX) r = strictReport(fs.readFileSync(file, 'utf8'));
    } catch {
      r = null;
    }
    if (!r) {
      notRead++;
      continue;
    }
    read++;
    const sig = signatureOf(r);
    const k = keyOf(sig);
    const g = groups.get(k) || { signature: sig, count: 0, outcome: r.outcome, first: r.time, last: r.time, failedSteps: {}, stepIns: {}, nodes: {}, arches: {} };
    g.count++;
    const node = `node${r.system.node}`;
    g.nodes[node] = (g.nodes[node] || 0) + 1;
    g.arches[r.system.arch] = (g.arches[r.system.arch] || 0) + 1;
    if (r.time < g.first) g.first = r.time;
    if (r.time > g.last) g.last = r.time;
    if (r.outcome === 'failed') g.outcome = 'failed';
    for (const s of r.steps) {
      if (s.end === 'failed') g.failedSteps[s.id] = (g.failedSteps[s.id] || 0) + 1;
      if (s.stepIns) g.stepIns[s.id] = (g.stepIns[s.id] || 0) + s.stepIns;
    }
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  return { read, notRead, groups: list };
}

// Most first; equal counts by name, so the text is the same whatever order the folder lists its files in.
const counts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ×${n}`).join(', ');

/** The inbox as text for a person: one block per signature. */
export function inboxText(inbox) {
  const lines = [`${inbox.read} report${inbox.read === 1 ? '' : 's'} read${inbox.notRead ? `, ${inbox.notRead} file${inbox.notRead === 1 ? '' : 's'} not read (not a report, or too big)` : ''}.`];
  if (!inbox.groups.length) return `${lines[0]}\n`;
  lines.push('');
  for (const g of inbox.groups) {
    const s = g.signature;
    lines.push(`${String(g.count).padStart(4)}×  ${s.kind}  ${g.outcome === 'ok' ? 'ok' : s.class}   (${s.version}, ${s.system})`);
    lines.push(`       ${g.first.slice(0, 10)} to ${g.last.slice(0, 10)}`);
    lines.push(`       on: ${counts(g.nodes)}; ${counts(g.arches)}`);
    if (Object.keys(g.failedSteps).length) lines.push(`       failed at: ${counts(g.failedSteps)}`);
    if (Object.keys(g.stepIns).length) lines.push(`       stepped in: ${counts(g.stepIns)}`);
  }
  return `${lines.join('\n')}\n`;
}
