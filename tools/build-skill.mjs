#!/usr/bin/env node
// Builds the Hoprig skill, so that it cannot fall behind the commands it teaches:
//
//   node tools/build-skill.mjs           write the files
//   node tools/build-skill.mjs --check   write nothing; exit 1 and name the files that are not up to date
//
// From three sources:
//  - templates/skills/hoprig.src.md: the short hand-written part (when to use Hoprig, the order of steps, what never
//    to do);
//  - every command's usage text as the program prints it: `bin/hoprig.mjs` is run with each command's help words in
//    a throw-away home (nothing real is read or written there, see PROBES);
//  - the version in package.json.
// Into templates/skills/hoprig (SKILL.md, references/commands.md), which Hoprig installs (`hoprig skills`), and the
// same files in packages/hoprig-skill/skill, which `npx hoprig-skill` installs. test/skill/build.test.mjs builds it
// again and compares: a command or an option that changed without a new build fails the suite.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE = 'templates/skills/hoprig.src.md';
export const SKILL_DIRS = ['templates/skills/hoprig', 'packages/hoprig-skill/skill'];
const PACKAGE = 'packages/hoprig-skill';

/**
 * The help each command prints, asked of the program: [title, arguments]. Every one of these only prints (a usage,
 * or "unknown option" and the usage): none starts a session, a server or a setup. A new entry is checked the same way
 * before it goes in (test/skill/build.test.mjs runs them all in an empty home and asserts it stays empty).
 */
export const PROBES = [
  ['hoprig help', ['help']],
  ['hoprig profiles', ['profiles', '--help']],
  ['hoprig add', ['add', '--help']],
  ['hoprig rm', ['rm', '--help']],
  ['hoprig auto', ['auto', '--help']],
  ['hoprig chat', ['chat', '--help']],
  ['hoprig opencode', ['opencode', '--help']],
  ['hoprig setup', ['setup', '--help']],
  ['hoprig doctor', ['doctor', '--help']],
  ['hoprig claude', ['claude', 'help']],
  ['hoprig update', ['update', '--help']],
  ['hoprig tools', ['tools', 'help']],
  ['hoprig pc', ['pc', 'help']],
  ['hoprig pc setup', ['pc', 'setup', '--help']],
  ['hoprig pc leave', ['pc', 'leave', '--help']],
  ['hoprig get, project clone', ['get']],
  ['hoprig drop', ['drop', '--help']],
  ['hoprig adopt', ['adopt', '--help']],
  ['hoprig sessions', ['sessions', '--help']],
  ['hoprig project', ['project', 'help']],
  ['hoprig project new', ['project', 'new']],
  ['hoprig project add', ['project', 'add']],
  ['hoprig project status', ['project', 'status', '--help']],
  ['hoprig project sync', ['project', 'sync', '--help']],
  ['hoprig project link', ['project', 'link', '--help']],
  ['hoprig project setup', ['project', 'setup', '--help']],
  ['hoprig workspace', ['workspace', 'help']],
  ['hoprig sync', ['sync', '--help']],
  ['hoprig tasks', ['tasks', 'help']],
  ['hoprig ship', ['ship', 'help']],
  ['hoprig skills', ['skills', 'help']],
  ['hoprig addons', ['addons', 'help']],
  ['hoprig gateways', ['gateways', 'help']],
  ['hoprig public', ['public', 'help']],
  ['hoprig link', ['link', '--help']],
  ['hoprig pair', ['pair', '--help']],
  ['hoprig tokens', ['tokens', '--help']],
  ['hoprig machines', ['machines', '--help']],
  ['hoprig join', ['join', '--help']],
  ['hoprig serve', ['serve', '--help']],
  ['hoprig passwd', ['passwd', '--help']],
  ['hoprig service', ['service', '--help']],
  ['hoprig mcp', ['mcp', '--help']],
  ['hoprig field', ['field', '--help']],
  ['hoprig move-to-user', ['move-to-user', '--help']],
  ['hoprig box', ['box', '--help']],
  ['hoprig demo', ['demo', '--help']],
];

/** Commands of bin/hoprig.mjs that people do not type (Hoprig starts them itself, or keeps them switched off). */
export const NOT_TYPED = ['hook', 'router', 'router-url', 'run', 'codex', 'version'];

/** The commands of bin/hoprig.mjs (its switch's case labels) that no probe or the top help covers. */
export function uncovered(commands) {
  const covered = new Set([...NOT_TYPED, 'help']);
  for (const [title] of PROBES) for (const w of title.replace(/^hoprig /, '').split(/,\s*/)) covered.add(w.split(' ')[0]);
  return commands.filter((c) => !covered.has(c));
}

/** The commands bin/hoprig.mjs dispatches: the case labels of its main(). */
export function binCommands(root = ROOT) {
  const src = fs.readFileSync(path.join(root, 'bin/hoprig.mjs'), 'utf8');
  return [...new Set([...src.slice(src.indexOf('async function main(')).matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]))];
}

/** A throw-away home: every place Hoprig and Claude Code would read or write points into it. */
export function probeEnv(home) {
  return {
    PATH: process.env.PATH || '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    HOPRIG_CONFIG_DIR: path.join(home, 'config'),
    HOPRIG_STATE_DIR: path.join(home, 'state'),
    HOPRIG_PROFILES_DIR: path.join(home, 'profiles'),
    HOPRIG_WORKSPACE_DIR: path.join(home, 'Workspace'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    NO_COLOR: '1',
  };
}

/** What a probe printed, as the reference shows it: the throw-away home said as the usual places, no error words. */
export function cleanUsage(text, home) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(path.join(home, 'profiles')).join('~/.config/hoprig/profiles')
    .split(home).join('~')
    .split('\n')
    .map((l) => l.replace(/^\s*✗ /, '').replace(/^(hoprig \S+: )?unknown option --help(\s+—\s+)?/, '').replace(/\s+$/, ''))
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

function runProbe(root, args, env, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin/hoprig.mjs'), ...args], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hoprig ${args.join(' ')} did not end within 20 s: a probe must only print`));
    }, 20_000);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Every probe's usage text: [{ title, command, text }], and what the probes left in their home (must be nothing). */
export async function usageTexts(root = ROOT) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-skill-')));
  try {
    const env = probeEnv(home);
    const texts = await Promise.all(PROBES.map(([, args]) => runProbe(root, args, env, home)));
    const left = fs.readdirSync(home, { recursive: true });
    return { usages: PROBES.map(([title, args], i) => ({ title, command: `hoprig ${args.join(' ')}`, text: cleanUsage(texts[i], home) })), left };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** templates/skills/hoprig.src.md as { name, description, body }. */
export function readSource(text) {
  const m = /^---\nname: (.+)\ndescription: (.+)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n?/g, '\n'));
  if (!m) throw new Error(`${SOURCE}: front matter of exactly "name" and "description" (one line each), then the text`);
  return { name: m[1].trim(), description: m[2].trim(), body: m[3].trim() };
}

/**
 * What the hand-written part names (`hop <command> [<sub> | <sub>] … [--option]`) that the program's help does not have:
 * a command, a subcommand or an option of it. That part is the safety text (what never to run without a yes, what
 * only reads), so a command renamed or removed in the program must stop the build, not leave a rule about a word
 * nobody types any more. `hop <provider> …` is a profile's name, not a command.
 */
export function unknownMentions(source, usages) {
  const word = /^[a-z][a-z-]*$/;
  const missing = [];
  for (const [, span] of readSource(source).body.matchAll(/`hop ([^`]+)`/g)) {
    const [cmd, ...more] = span.trim().split(/\s+/);
    if (!word.test(cmd)) continue;
    const subs = [];
    if (word.test(more[0] || '')) {
      subs.push(more[0]);
      for (let i = 1; more[i] === '|' && word.test(more[i + 1] || ''); i += 2) subs.push(more[i + 1]);
    }
    const options = more.filter((w) => /^--[a-z]/.test(w));
    for (const phrase of subs.length ? subs.map((s) => `${cmd} ${s}`) : [cmd]) {
      const named = new RegExp(`\\bhoprig ${phrase}(?![\\w-])`);
      const texts = usages.filter((u) => named.test(u.text));
      if (!texts.length) missing.push(`hop ${phrase}`);
      else for (const o of options) if (!texts.some((u) => new RegExp(`${o}(?![\\w-])`).test(u.text))) missing.push(`hop ${phrase} ${o}`);
    }
  }
  return [...new Set(missing)];
}

const yamlString = (s) => JSON.stringify(s); // a JSON string is a valid YAML double-quoted string

/** The files of the skill (relative to its folder) from the sources. Pure: the test feeds it changed sources. */
export function renderSkill({ source, usages, version }) {
  const { name, description, body } = readSource(source);
  const commands = [...new Set(usages.slice(1).flatMap((u) => u.title.replace(/^hoprig /, '').split(/,\s*/).map((w) => w.split(' ')[0])))];
  const skill = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    'license: Apache-2.0',
    'metadata:',
    `  version: ${yamlString(version)}`,
    '  generated-by: "tools/build-skill.mjs in the Hoprig repository"',
    '---',
    '',
    body,
    '',
    '## Every command and option',
    '',
    `This skill is Hoprig ${version}'s. The commands: ${commands.map((c) => `\`hop ${c}\``).join(', ')}.`,
    'Read [references/commands.md](references/commands.md) before you type a command you have not used here, when a',
    'command answers with "usage", or when the user asks what an option does: it is every command\'s own help as this',
    'version prints it. On this computer `hop help`, and `hop <command> --help` for each command above, print the same.',
    '`help`, `--help` or `-h` after a subcommand prints that subcommand\'s help and does nothing else (`hop service',
    'uninstall --help` too).',
    '',
  ].join('\n');
  const ref = [
    `# Hoprig ${version}: every command`,
    '',
    'Each command\'s own help, as the program prints it (`hoprig` and `hop` are the same command). Made by',
    'tools/build-skill.mjs at every build of the skill, so it matches this version.',
    '',
    ...usages.flatMap((u) => [`## ${u.title}`, '', `\`${u.command}\` prints:`, '', '```text', u.text, '```', '']),
  ].join('\n');
  return { 'SKILL.md': skill, 'references/commands.md': ref };
}

/** Every file the build writes, relative to the repository: { path: content }. */
export async function buildFiles(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { usages, left } = await usageTexts(root);
  if (left.length) throw new Error(`a probe wrote into its home (${left.slice(0, 3).join(', ')}): it must only print`);
  const source = fs.readFileSync(path.join(root, SOURCE), 'utf8');
  const unknown = unknownMentions(source, usages);
  if (unknown.length) throw new Error(`${SOURCE} names what the program's help does not have: ${unknown.join(', ')}. Change the text to match`);
  const skill = renderSkill({ source, usages, version: pkg.version });
  const files = {};
  for (const dir of SKILL_DIRS) for (const [rel, text] of Object.entries(skill)) files[`${dir}/${rel}`] = text;
  // The package carries Hoprig's version and license.
  const sub = JSON.parse(fs.readFileSync(path.join(root, PACKAGE, 'package.json'), 'utf8'));
  files[`${PACKAGE}/package.json`] = `${JSON.stringify({ ...sub, version: pkg.version }, null, 2)}\n`;
  files[`${PACKAGE}/LICENSE`] = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  return files;
}

/** The files whose content on disk is not what the build makes (missing ones too), and the generated files on disk
 * that the build no longer makes. */
export function staleFiles(files, root = ROOT) {
  const stale = Object.entries(files).filter(([rel, text]) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8') !== text;
    } catch {
      return true;
    }
  }).map(([rel]) => rel);
  for (const dir of SKILL_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const rel = path.relative(root, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/');
      if (!(rel in files)) stale.push(rel);
    }
  }
  return stale;
}

async function main() {
  const check = process.argv.includes('--check');
  const files = await buildFiles();
  const stale = staleFiles(files);
  if (check) {
    if (stale.length) {
      console.error(`The skill is not up to date: ${stale.join(', ')}. Build it: node tools/build-skill.mjs`);
      return 1;
    }
    console.log('The skill is up to date.');
    return 0;
  }
  for (const rel of stale) {
    const abs = path.join(ROOT, rel);
    if (!(rel in files)) fs.rmSync(abs);
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, files[rel]);
    }
  }
  console.log(stale.length ? `Wrote ${stale.join(', ')}.` : 'The skill was up to date.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => (process.exitCode = code), (e) => {
    console.error(`build-skill: ${e.message}`);
    process.exitCode = 1;
  });
}
