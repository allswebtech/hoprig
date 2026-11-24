#!/usr/bin/env node
// Writes the section "What Tia can do, and what she cannot" of docs/OPERATOR.md from src/assistant/inventory.json,
// between its two markers. `--check` only compares and exits 1 when the page differs (the test runs that).
//
//   node tools/tia-acts-doc.mjs           write the section
//   node tools/tia-acts-doc.mjs --check   say whether the page matches the inventory
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, loadInventory } from '../src/assistant/acts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC = path.join(ROOT, 'docs', 'OPERATOR.md');
export const BEGIN = '<!-- tia-acts: made by tools/tia-acts-doc.mjs from src/assistant/inventory.json; do not edit by hand -->';
export const END = '<!-- /tia-acts -->';

const CARD = { yes: 'always asks you', maybe: 'asks you when the facts say so', no: 'does it' };
const doer = (h) => `${h.tool}${h.action ? ` ${h.action}` : ''}`;

/** The section as Markdown, from the rows. */
export function section(rows = loadInventory().rows) {
  const hers = rows.filter((r) => r.hers);
  const same = rows.filter((r) => r.same);
  const not = rows.filter((r) => r.not && !r.hers);
  const count = (list, kind) => list.filter((r) => r.kind === kind).length;
  const out = [BEGIN, '', '## What Tia can do, and what she cannot', ''];
  out.push(`Every act of Hoprig is one row of \`src/assistant/inventory.json\`: ${rows.length} in all (${count(rows, 'command')} commands, ${count(rows, 'route')} changes in the dashboard, ${count(rows, 'skill')} skills). Tia does ${hers.length} of them with a tool of hers, ${same.length} more by another route of the same effect, and ${not.length} are not hers. A test holds the file to the code: a new command or route without a row fails it.`, '');
  out.push('### What she does', '', '| Act | Her tool | Card |', '|---|---|---|');
  for (const r of hers) {
    const cards = [...new Set(r.hers.map((h) => `${CARD[h.card]}${h.note ? ` (${h.note})` : ''}`))].join('; ');
    out.push(`| \`${r.act}\` | ${[...new Set(r.hers.map(doer))].join(', ')} | ${cards}${r.not ? ` (the rest is yours: ${r.why.replace(/\.$/, '')})` : ''} |`);
  }
  out.push('', '### What she does by another way', '', '| Act | Her tool | Why |', '|---|---|---|');
  for (const r of same) out.push(`| \`${r.act}\` | ${r.same} | ${r.why} |`);
  out.push('', '### What stays yours', '');
  for (const [g, words] of Object.entries(GROUPS)) {
    const list = not.filter((r) => r.not === g);
    if (!list.length) continue;
    out.push(`**${words[0].toUpperCase()}${words.slice(1)}** (${list.length}):`, '');
    for (const r of list) out.push(`- \`${r.act}\`: ${r.why}`);
    out.push('');
  }
  out.push(END);
  return out.join('\n');
}

/** The page with the section put in (after "## For Tia" when the markers are not there yet). */
export function withSection(page, text = section()) {
  const a = page.indexOf(BEGIN);
  const b = page.indexOf(END);
  if (a >= 0 && b > a) return page.slice(0, a) + text + page.slice(b + END.length);
  const at = page.indexOf('\n## For scripts');
  return at >= 0 ? `${page.slice(0, at)}\n${text}\n${page.slice(at)}` : `${page.trimEnd()}\n\n${text}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const page = fs.readFileSync(DOC, 'utf8');
  const want = withSection(page);
  if (process.argv.includes('--check')) {
    if (want !== page) {
      console.error('docs/OPERATOR.md does not match src/assistant/inventory.json: run node tools/tia-acts-doc.mjs');
      process.exit(1);
    }
    console.log('docs/OPERATOR.md matches the inventory');
  } else if (want !== page) {
    fs.writeFileSync(DOC, want);
    console.log('docs/OPERATOR.md: the section was written');
  }
}
