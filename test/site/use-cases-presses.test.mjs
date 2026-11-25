// Every step of a use case names the dashboard's press first and the command second (decided 18 Nov 2026: no step
// exists only as a command). A press a page names is held to the page's code: each part of a bold path, and each
// bold press after "press", "tap", "open", "tick" or "turn on", is words of a file in web/. A step whose command has
// no press in the dashboard yet is listed below with its page and command, and is told as a command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'site/content/use-cases');
const pages = fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'index.md').map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
const page = (f) => pages.find(([n]) => n === f)[1];

// The words of the page's code, as a person sees them: a quote escaped in a string is a quote.
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(js|html)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const WEB = files(path.join(ROOT, 'web')).map((f) => fs.readFileSync(f, 'utf8').replace(/\\'/g, '\'')).join('\n');
// A label built from a template (`Install ${APP_NAME} on ${s.shown}`): each ${…} stands for some words.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A template with no words of its own (`${A}`, `${a} ${b}`) would match any press, so it does not count.
const TEMPLATES = [...WEB.matchAll(/`([^`\n]*\$\{[^`\n]*)`/g)].map((m) => m[1].split(/\$\{[^}]*\}/))
  .filter((parts) => (parts.join('').match(/[A-Za-z]/g) || []).length >= 4)
  .map((parts) => new RegExp(`^${parts.map(esc).join('.+')}$`));
const inWeb = (p) => WEB.includes(p) || TEMPLATES.some((re) => re.test(p));

// A step whose command has no press on the dashboard at this version: [page, the command's start].
const NO_PRESS = [
  ['new-computer.md', 'hop workspace label'],
  ['team-machines.md', 'hop pc status --json'],
  ['always-on-coding-machine.md', 'hoprig setup --hub'],
];

// Pages whose steps are not written press first yet; this list only shrinks.
const NOT_YET = ['not-a-developer.md'];

const COMMAND = /`(?:hop|hoprig)(?:\s[^`]*)?`/;
const VERB = /(?:^|[\s(])(?:press|tap|open|tick|turn on)\s+$/i;

/** The bold presses of a page: a bold path (A → B), or a bold phrase right after a verb of pressing. */
function presses(md) {
  const out = [];
  for (const m of md.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    const text = m[1].trim().replace(/[.:]$/, '');
    const before = md.slice(Math.max(0, m.index - 20), m.index);
    if (text.includes('→')) out.push(...text.split('→').map((s) => s.trim()).filter(Boolean));
    else if (VERB.test(before)) out.push(text);
  }
  return out;
}

/** The numbered steps of "## What Hoprig does", each with its indented lines. */
function steps(md) {
  const part = /^##\s+What Hoprig does[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(md);
  if (!part) return [];
  const list = [];
  for (const line of part[1].split('\n')) {
    if (/^\d+\.\s/.test(line)) list.push(line);
    else if (list.length && /^\s{2,}\S/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
  }
  return list;
}

test('every bold press of a use case is words of the dashboard: each part of a path, each press after its verb', () => {
  const missing = [];
  for (const [f, md] of pages) for (const p of presses(md)) if (!inWeb(p)) missing.push(`${f}: ${p}`);
  assert.deepEqual(missing, [], 'a press the dashboard does not have');
});

test('a step that names a command names a press first, or is listed as a step that has none', () => {
  const bad = [];
  const listed = new Set();
  for (const [f, md] of pages) {
    if (NOT_YET.includes(f)) continue;
    for (const s of steps(md)) {
      const cmd = COMMAND.exec(s);
      if (!cmd) continue;
      const none = NO_PRESS.find(([pf, c]) => pf === f && s.includes(c));
      if (none) {
        listed.add(none);
        assert.ok(!/\*\*/.test(s.slice(0, cmd.index)), `${f}: a step without a press is told as if it had one: ${s}`);
        continue;
      }
      const bold = s.indexOf('**');
      if (bold < 0 || bold > cmd.index) bad.push(`${f}: ${s.slice(0, 120)}`);
    }
  }
  assert.deepEqual(bad, [], 'a step told only as a command, or with the command before its press');
  for (const e of NO_PRESS) assert.ok(listed.has(e), `the list names a step that is no longer there: ${e.join(': ')}`);
});

test('the page about a new computer names the Workspace page\'s card before its first command', () => {
  const md = page('new-computer.md');
  const card = md.indexOf('**Bring my workspace from git**');
  const first = md.search(COMMAND);
  assert.ok(card >= 0 && card < first, 'the card "Bring my workspace from git" comes before the first command');
  assert.match(WEB, /card\('git', 'Bring my workspace from git', 'Your AI brain with its map, your credentials and groups\. Projects stay in the map until you get one\./);
  // The page tells what the card brings, and that the tick in its sheet brings every project, as the code does.
  assert.match(WEB, /'Also get every project of the map on this computer'/);
  const flat = md.replace(/\s+/g, ' ');
  assert.match(flat, /your credentials and groups/);
  assert.match(flat, /\*\*Also get every project of the map on this computer\*\*/);
});
