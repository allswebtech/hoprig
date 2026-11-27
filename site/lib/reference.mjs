// The /tools/ page, read from the product's own code at build time so that it cannot fall behind:
//  - every command `bin/hoprig.mjs` dispatches (its `case` labels), with its line from `hoprig help all` (src/helpall.mjs);
//  - every usage line in src/ and bin/ that offers --json;
//  - Tia's tools from `src/assistant/tools.mjs` (TOOLS), with their confirmation levels.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Commands the product starts for itself, never typed by a person. Said here because `hoprig help` does not list
// them; a new one without a line in the help still shows up on the page, under "Not in hoprig help".
const INTERNAL = {
  hook: 'started by Claude Code for a hook event; keeps a session\'s status',
  router: 'Auto mode\'s small router on this computer, started by Hoprig',
  'router-url': 'prints the router\'s address with its key masked',
  run: 'the same as `hoprig <profile> [args]`',
  codex: 'kept in the code and switched off in this version',
  version: 'prints the version',
  help: 'lists every command with its options',
};

/** The commands `bin/hoprig.mjs` knows: its switch's case labels plus help and version. */
export function cliCommands(root) {
  const src = fs.readFileSync(path.join(root, 'bin/hoprig.mjs'), 'utf8');
  const main = src.slice(src.indexOf('async function main('));
  const names = new Set(['help', 'version']);
  for (const m of main.matchAll(/^\s*case '([a-z][a-z-]*)':/gm)) names.add(m[1]);
  return [...names];
}

/**
 * A help line whose text starts one space after a long usage ("hoprig project clone <name> get an existing …"):
 * the usage ends at the first plain word after an argument.
 */
function splitUsage(usage, text) {
  if (text) return { usage, text };
  const words = usage.split(' ');
  const at = words.findIndex((w, n) => n > 1 && /^[a-z]+$/.test(w) && /^[<[]/.test(words[n - 1]));
  return at === -1 ? { usage, text } : { usage: words.slice(0, at).join(' '), text: words.slice(at).join(' ') };
}

/** `hoprig help` as [{ command, text }]: the lines that start with `hoprig <word>`, with their continuation lines. */
function helpLines(root) {
  const src = fs.readFileSync(path.join(root, 'src/helpall.mjs'), 'utf8');
  const help = /const HELP_ALL = `([\s\S]*?)`;/.exec(src)[1];
  const out = [];
  for (const line of help.split('\n')) {
    const m = /^ {2}hoprig(?: (\S.*?))?(?: {2,}(.*))?$/.exec(line);
    const example = /^ {10,}(hoprig \S.*?) {2,}(\S.*)$/.exec(line);
    if (m) out.push(splitUsage(`hoprig${m[1] ? ` ${m[1]}` : ''}`, m[2] || ''));
    // An example under a line ("hoprig api -c   continue the last session"): the command as code, then its words.
    else if (example && out.length) (out[out.length - 1].examples ||= []).push(`${code(example[1])}: ${example[2].trim()}`);
    else if (/^ {10,}\S/.test(line) && out.length) out[out.length - 1].text += ` ${line.trim()}`;
  }
  return out.map(({ examples, ...l }) => ({ ...l, text: `${l.text.trim()}${examples ? ` (${examples.join('; ')})` : ''}` }));
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

/**
 * Every documented use of --json: usage lines (`hoprig x [--json]   what it does`) in the commands' own help texts
 * and header comments. One entry per command, the help text's line preferred over a comment's.
 */
export function jsonCommands(root) {
  const known = new Set(cliCommands(root));
  const help = helpLines(root);
  const found = new Map();
  for (const file of [...sourceFiles(path.join(root, 'bin')), ...sourceFiles(path.join(root, 'src'))]) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((raw, n) => {
      const comment = /^\s*\/\//.test(raw);
      let s = raw.replace(/^\s*\/\/\s*/, '').replace(/^\s*export const \w+ = `/, '').replace(/^\s*(?:const \w+ = `)?/, '').replace(/^usage:\s*/, '').trim();
      const prefixed = /^(hoprig|\$\{APP\})\s/.test(s);
      s = s.replace(/^(hoprig|\$\{APP\})\s+/, '');
      const [usage, ...rest] = s.split(/\s{2,}/);
      if (!usage || !usage.includes('--json') || !known.has(usage.split(' ')[0])) return;
      if (!prefixed && !comment) return;
      // A comment's usage line without "hoprig" is set in from the "//" ("//   workspace status [--json]   ..."); a
      // comment's prose that merely starts with a command's name ("// version }; proc: ...") is no usage line.
      if (!prefixed && !/^\s*\/\/\s{2,}\S/.test(raw)) return;
      let text = rest.join(' ').trim();
      // The text goes on in lines indented far to the right (a usage that is too long has all its text there), or, in
      // a usage text that puts it under the line ("  hoprig x [--json]" then "      what it does"), in lines set in
      // deeper than the usage line itself.
      const indent = (l) => /^(\s*\/\/)?(\s*)/.exec(l)[2].length;
      const under = !text && !comment ? indent(raw) : Infinity;
      for (let k = n + 1; (/^(\s*\/\/)?\s{20,}\S/.test(lines[k] || '') || (/\S/.test(lines[k] || '') && indent(lines[k]) > under)) && !/^\s*(\/\/\s*)?hoprig\s/.test(lines[k]); k++) {
        text = `${text} ${lines[k].replace(/^\s*\/\/?/, '').trim().replace(/`;$/, '')}`.trim();
      }
      const key = usage.split(' ').filter((w) => !/^[[<-]/.test(w)).join(' ');
      // A comment's note for the code's readers ("= hoprig get (getproject.mjs)") is no text for a visitor: the
      // command's own line in `hoprig help` says it.
      if (/^=|\b[\w-]+\.mjs\b/.test(text)) {
        const lead = (u) => u.split(' ').filter((w, n, a) => a.slice(0, n + 1).every((x) => /^[a-z][a-z-]*$/.test(x))).join(' ');
        text = help.find((h) => lead(h.usage.slice('hoprig '.length)) === lead(usage))?.text || '';
      }
      const entry = { usage: `hoprig ${usage}`, text: text.replace(/`;$/, ''), file: path.relative(root, file).split(path.sep).join('/'), prefixed };
      const had = found.get(key);
      if (!had || (prefixed && !had.prefixed)) found.set(key, entry);
    });
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, e]) => ({ key, ...e }));
}

/** A level that depends on the call, as the set of levels a few typical calls give. */
function levelRange(level) {
  if (typeof level !== 'function') return level;
  const probes = [{}, { dry_run: true }, { push: true }, { turn: 'on' }, { turn: 'off' }, { addon_action: 'start' }, { addon_action: 'install' }];
  const seen = new Set();
  for (const p of probes) {
    try {
      seen.add(level(p));
    } catch { /* this probe does not fit the action */ }
  }
  const all = [...seen].filter(Boolean).sort();
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} or ${all[all.length - 1]}` : all[0] || 'depends on the call';
}

/** Tia's tools, imported from the product: [{ name, level, card, description, actions: [{ name, level }] }]. */
export async function tiaTools(root) {
  // Loaded by Node itself, also inside the Next build: the product's module is not part of the site's bundle.
  const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(path.join(root, 'src/assistant/tools.mjs')).href);
  return mod.TOOLS.map((t) => ({
    name: t.name,
    level: levelRange(t.level),
    card: t.card === 'maybe',
    description: t.description,
    actions: t.actions ? Object.entries(t.actions).map(([name, a]) => ({ name, level: levelRange(a.level) })) : [],
  }));
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s) => `\`${s.replace(/`/g, '').replace(/\|/g, '\\|')}\``;

/** The page as Markdown (rendered like any other page, and published as its .md twin). */
export async function toolsPage(root) {
  const commands = cliCommands(root);
  const help = helpLines(root);
  const json = jsonCommands(root);
  const tools = await tiaTools(root);
  const listed = (c) => help.filter((h) => h.usage === `hoprig ${c}` || h.usage.startsWith(`hoprig ${c} `));
  // help and version are typed by people although the help does not list itself; the rest Hoprig starts on its own.
  const typed = ['help', 'version'];
  const inHelp = commands.filter((c) => listed(c).length);
  const notInHelp = commands.filter((c) => !listed(c).length && !typed.includes(c));

  const md = [];
  md.push('# Tools: the commands and Tia\'s tools');
  md.push('');
  md.push('This page is for people who script Hoprig and for AI agents that use it. It is made from Hoprig\'s own code each time the site is built, so it lists exactly what the current version has. The command is `hoprig`, or `hop` for short; `hop help` prints the same list in a terminal.');
  md.push('');
  md.push('## Commands that answer in JSON');
  md.push('');
  md.push('Add `--json` and the command prints one JSON document instead of text: the same data the dashboard shows. Read-only unless the line says otherwise; the ones that change something also take `--dry-run`.');
  md.push('');
  md.push('| Command | What it gives |');
  md.push('|---|---|');
  for (const j of json) md.push(`| ${code(j.usage)} | ${cell(j.text || '—')} |`);
  md.push('');
  md.push('## Every command');
  md.push('');
  md.push('| Command | What it does |');
  md.push('|---|---|');
  // In the help's own order, so a line that points at the one before it ("the same, short", "as above") reads right;
  // with the lines that start a coding tool (hoprig, hoprig <profile> [args], hoprig -c), which name no command.
  const ownLine = (h) => /^hoprig(?: [<-]|$)/.test(h.usage) || inHelp.some((c) => h.usage === `hoprig ${c}` || h.usage.startsWith(`hoprig ${c} `));
  for (const h of help.filter(ownLine)) md.push(`| ${code(h.usage)} | ${cell(h.text || '—')} |`);
  for (const c of typed.filter((t) => commands.includes(t) && !listed(t).length)) md.push(`| ${code(`hoprig ${c}`)} | ${cell(INTERNAL[c])} |`);
  md.push('');
  md.push('### Not in `hoprig help`');
  md.push('');
  md.push('Hoprig starts these itself, or keeps them for later. You do not need to type them.');
  md.push('');
  md.push('| Command | What it is |');
  md.push('|---|---|');
  for (const c of notInHelp) md.push(`| ${code(`hoprig ${c}`)} | ${cell(INTERNAL[c] || 'not described in `hoprig help`')} |`);
  md.push('');
  md.push('## Tia\'s tools');
  md.push('');
  md.push('Tia is the assistant in the dashboard (experimental, off until you turn her on). She works only through these tools. The same tools are an MCP server: `hoprig mcp`, for Tia and for any MCP client, such as your own Claude Code. Each tool has a level, and the dashboard enforces it, not the prompt:');
  md.push('');
  md.push('- **L0, read**: runs.');
  md.push('- **L1, act**: runs and is logged; harmless or easy to undo.');
  md.push('- **L2, confirm**: only shows you a card; it runs when you tap Confirm, and is checked again then.');
  md.push('- **L3**: never through her. Passwords, tokens and account sign-ins are your own steps; she opens the right page instead.');
  md.push('');
  md.push('"Can ask first" means the dashboard decides per call: the same tool may need your OK, for example when it would use a paid provider or type into a session she did not start.');
  md.push('');
  md.push('| Tool | Level | What it does |');
  md.push('|---|---|---|');
  for (const t of tools) md.push(`| ${code(t.name)} | ${t.level}${t.card ? ', can ask first' : ''} | ${cell(t.description)} |`);
  md.push('');
  const withActions = tools.filter((t) => t.actions.length);
  if (withActions.length) {
    md.push('### Actions of the tools that have them');
    md.push('');
    md.push('| Tool | Action | Level |');
    md.push('|---|---|---|');
    for (const t of withActions) for (const a of t.actions) md.push(`| ${code(t.name)} | ${code(a.name)} | ${a.level} |`);
    md.push('');
  }
  return { markdown: md.join('\n'), commands, json, tools };
}
