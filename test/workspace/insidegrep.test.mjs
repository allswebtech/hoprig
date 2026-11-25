// Where Hoprig acts in the workspace, the check cannot be forgotten: every raw act (a file written, copied, linked,
// renamed, made or removed, also by a named import or a write stream; git or gh run in a folder, a clone; a program
// started with a cwd, shorthand too) in src/workspace and src/pcsetup goes through inside.mjs. The few that stay raw
// act OUTSIDE the workspace, and each file's count is named here with why: a new raw call anywhere fails this test
// until it moves to inside.mjs or is named and justified. A line that calls gitIn, startIn or cloneInto is checked
// there. (A grep cannot see an act hidden behind a helper of a file's own; inside.mjs's tests and the property test
// cover what the acts do.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The acts on a file or folder by name, in node:fs and node:fs/promises (sync, callback and promise forms).
const ACTS = 'writeFile|appendFile|copyFile|symlink|rename|mkdir|mkdtemp|rm|rmdir|unlink|chmod|lchmod|chown|lchown|utimes|lutimes|truncate|cp|link|createWriteStream';
const RAW = [
  /\[\s*'git',\s*'-C'/, // git run in a folder
  /'git',\s*'clone'/, // a clone
  /\bcwd\s*:/, // a program started in a folder
  /[{,]\s*cwd\s*[,}]/, // the same, as a shorthand property ({ cwd })
  /(['"])(git|gh)\1.*(['"])(-C|--source|--git-dir|--work-tree)\3/, // git or gh pointed at a folder, anywhere in its argv
  /\[\s*(['"])git\1,\s*\.\.\./, // git whose first arguments are spread in (['git', ...gitDir(dir), 'push'])
  /\b(execFileSync|execFile|spawnSync|spawn)\(\s*(['"])(git|gh)\2/, // git or gh started directly
  // The sync names stand alone: a named import of them is an act wherever it is called.
  new RegExp(`(^|[^.\\w])(${ACTS.split('|').filter((n) => n !== 'createWriteStream').map((n) => `${n}Sync`).join('|')}|createWriteStream)\\(`),
];
// Write flags of an open: a file opened with one of them (or without flags shown to be read-only) is an act.
const WRITE_FLAGS = /O_(WRONLY|RDWR|CREAT|TRUNC|APPEND)\b|['"][^'"]*[wa+][^'"]*['"]/;
const READ_ONLY = /^\s*('r'|"r"|(fs\.constants\.)?O_RDONLY\b)/;

/** A call's text with its arguments: `name(` up to its closing parenthesis (or the end of the line). */
function callsOf(l, name) {
  const out = [];
  const re = new RegExp(`(^|[^\\w.$])${name}\\(`, 'g');
  for (let m; (m = re.exec(l));) {
    const from = m.index + m[1].length;
    let depth = 0;
    let to = l.length;
    for (let i = from + name.length; i < l.length; i++) {
      if (l[i] === '(') depth++;
      else if (l[i] === ')' && --depth === 0) {
        to = i + 1;
        break;
      }
    }
    out.push([from, to]);
  }
  return out;
}
/** The line without the calls inside.mjs checks itself (gitIn, startIn, cloneInto) and the commands only shown. */
function withoutChecked(l) {
  for (const n of ['gitIn', 'startIn', 'cloneInto', 'showCommand', 'showCommands']) {
    for (const [a, b] of callsOf(l, n).reverse()) l = `${l.slice(0, a)}${' '.repeat(b - a)}${l.slice(b)}`;
  }
  return l;
}

/**
 * The raw acts of one file: [line numbers]. The fs names it imports (named, aliased, a namespace, a destructuring of
 * one) are learned from the file, so `import { rm } from 'node:fs/promises'` makes a bare rm( an act, and
 * fs.writeFile(f, t, cb) and fsp.open(f, 'w') are acts as fs.writeFileSync is.
 */
function rawLines(text) {
  const spaces = new Set(['fs', 'fsp', 'promises']);
  const bare = new Set();
  const learn = (list) => {
    for (const part of list.split(',')) {
      const m = /^\s*(\w+)(?:\s*(?:as|:)\s*(\w+))?\s*$/.exec(part);
      if (m && new RegExp(`^(${ACTS}|open|promises)(Sync)?$`).test(m[1])) (m[1] === 'promises' ? spaces : bare).add(m[2] || m[1]);
    }
  };
  const FS = `['"](node:)?fs(/promises)?['"]`;
  for (const m of text.matchAll(new RegExp(`import\\s+(?:(\\w+)\\s*,?\\s*)?(?:\\*\\s+as\\s+(\\w+)|\\{([^}]*)\\})?\\s*from\\s*${FS}`, 'g'))) {
    if (m[1]) spaces.add(m[1]);
    if (m[2]) spaces.add(m[2]);
    if (m[3]) learn(m[3]);
  }
  for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:await\\s+import\\(${FS}\\)|require\\(${FS}\\)|(?:fs\\.)?promises\\b)`, 'g'))) spaces.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(\w+(?:\.promises)?|await\s+import\(['"](?:node:)?fs(?:\/promises)?['"]\))/g)) {
    if (/import/.test(m[2]) || spaces.has(m[2].split('.')[0])) learn(m[1]);
  }
  const ns = [...spaces].join('|');
  const named = new RegExp(`\\b(${ns})(\\.promises)?\\.(${ACTS})(Sync)?\\(`);
  const bareActs = [...bare].filter((n) => !/^open(Sync)?$/.test(n));
  const bareRe = bareActs.length ? new RegExp(`(^|[^.\\w$])(${bareActs.join('|')})\\(`) : null;
  const opens = [...bare].filter((n) => /^open(Sync)?$/.test(n));
  const isOpen = (l) => {
    const calls = [...callsOf(l, 'openSync'), ...opens.flatMap((n) => callsOf(l, n))];
    for (const m of l.matchAll(new RegExp(`\\b(${ns})(\\.promises)?\\.(open|openSync)\\(`, 'g'))) calls.push(...callsOf(l.slice(m.index), m[0].slice(0, -1)).map(([a, b]) => [a + m.index, b + m.index]));
    return calls.some(([a, b]) => {
      const args = l.slice(a, b).replace(/^[^(]*\(/, '').replace(/\)$/, '');
      const comma = args.indexOf(',');
      const flags = comma < 0 ? '' : args.slice(comma + 1);
      return WRITE_FLAGS.test(flags) || !READ_ONLY.test(flags);
    });
  };
  return text.split('\n').map((l, i) => [withoutChecked(l), i + 1])
    .filter(([l]) => !/^\s*(\/\/|\*)/.test(l) && (RAW.some((p) => p.test(l)) || named.test(l) || (bareRe && bareRe.test(l)) || isOpen(l)))
    .map(([, n]) => n);
}

// file → [how many raw acts, why they stay raw]
const ALLOWED = {
  'src/workspace/dropacts.mjs': [1, 'a memory link of a dropped project taken away in Claude Code\'s own folder, outside the workspace (only a link, never a real folder: lstat first)'],
  'src/workspace/grouptool.mjs': [6, 'the launcher in Hoprig\'s own command folder (~/.local/bin), outside the workspace'],
  'src/workspace/link.mjs': [11, 'the coding tools\' own files and links (~/.claude, ~/.config/opencode), outside the workspace; what is written into the brain (the Memory section, merged and adopted files) goes through inside.mjs, and a link is made only to a place of the brain leaves() finds inside it'],
  'src/workspace/restore.mjs': [3, 'the temporary folder of a dry run, made by mkdtemp and removed after'],
  'src/workspace/credrepo.mjs': [3, 'git ls-remote --get-url and ssh -G, run outside any folder: which server an address reaches, from the owner\'s own settings only; and pushAddresses\' reads of the credentials folder\'s own remote (git config --get-all, git remote get-url), asked in the push\'s own environment so the check sees the rules the push will use'],
  'src/workspace/setup.mjs': [2, 'the workspace folder itself (the base every check starts from), and git asked for the name outside any folder'],
  'src/pcsetup/devinstall.mjs': [9, 'a kit\'s own steps in development/: every folder on the way to the place is checked to be a real folder first (never through a link or a file), the place must hold nothing, the work is done in a temporary folder made by mkdtemp there and moved into the place by one rename, and an adoption link is made only at such a free place; what is removed is only what the step itself made (by its record), or the temporary folder of a run whose process is gone and that holds nothing but its own two names'],
  'src/pcsetup/cli.mjs': [1, 'a recipe saved to the file the owner typed (never over one: wx)'],
  'src/pcsetup/fetchkit.mjs': [1, 'the file of a kit download, opened new (wx: never over one) in the temporary folder devinstall.mjs made for it'],
  'src/pcsetup/feature.mjs': [3, 'a recipe in Hoprig\'s state folder, and the projects folder the owner chose (a base)'],
  'src/pcsetup/newprojectstart.mjs': [4, 'the command token of `project new --start` in Hoprig\'s state folder (mode 600, made at each start of the dashboard and removed with it); the project itself is only read, through inside.mjs'],
  'src/pcsetup/getproject.mjs': [4, 'signInProbe: the GIT_ASKPASS stand-in in a temporary folder made by mkdtemp (and removed after), and git ls-remote run outside any folder'],
  'src/pcsetup/leftovers.mjs': [13, 'the locks of hoprig get in Hoprig\'s state folder; what is in a place goes through inside.mjs'],
  'src/pcsetup/project.mjs': [4, 'a template cloned into a temporary folder made by mkdtemp (and removed after), and git asked for the name outside any folder'],
  'src/pcsetup/rules.mjs': [7, 'the working rules in Claude Code\'s own folder, outside the workspace (as the released version)'],
  'src/pcsetup/setup.mjs': [1, 'the projects folder the owner chose (a base)'],
  'src/pcsetup/workspace.mjs': [4, 'the memory link in Claude Code\'s own folder (its target is checked by inside.mjs), and git ls-remote run outside any folder'],
  'src/pcsetup/wsrules.mjs': [4, 'the workspace rules file in Claude Code\'s own folder, never through a link (lstat first)'],
};

test('no raw act in src/workspace or src/pcsetup outside inside.mjs, except the ones named here with why', () => {
  const found = {};
  for (const dir of ['src/workspace', 'src/pcsetup']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.mjs'))) {
      const rel = `${dir}/${f}`;
      if (rel === 'src/workspace/inside.mjs') continue;
      const hits = rawLines(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      if (hits.length) found[rel] = hits;
    }
  }
  for (const [rel, lines] of Object.entries(found)) {
    assert.ok(ALLOWED[rel], `${rel} acts raw at line ${lines.join(', ')}: move it to inside.mjs (gitIn, cloneInto, startIn, writeIn, copyIn, mkdirIn, renameIn, removeIn), or name it here with why`);
    assert.equal(lines.length, ALLOWED[rel][0], `${rel}: ${lines.length} raw acts (lines ${lines.join(', ')}), ${ALLOWED[rel][0]} named (${ALLOWED[rel][1]})`);
  }
  for (const rel of Object.keys(ALLOWED)) assert.ok(found[rel], `${rel} has no raw act any more: take it off the list`);
});

test('the grep sees what it must: a raw write or a git spawn in a folder is caught', () => {
  const line = (s) => rawLines(`import fs from 'node:fs';\n${s}`).length > 0;
  assert.equal(line("  fs.writeFileSync(path.join(root, '.env'), text);"), true);
  assert.equal(line("  await run(['git', '-C', dir, 'push']);"), true);
  assert.equal(line("  await runner(['npm', 'ci'], { cwd: dest });"), true);
  assert.equal(line("  await stream(['git', 'clone', '--', url, dest]);"), true);
  assert.equal(line('  fs.chmodSync(dir, 0o700);'), true, 'a mode set through a link changes what it points to');
  assert.equal(line('  await fsp.writeFile(file, text);'), true, 'the async calls too');
  assert.equal(line("  todo.push({ command: showCommand(['git', '-C', dir, 'push']) });"), false, 'a command printed for the owner is no act');
  // The forms the first version missed.
  assert.equal(line("  execFileSync('git', ['-C', dir, 'push']);"), true, 'git started directly');
  assert.equal(line('  await run(argv, { cwd });'), true, 'a shorthand cwd');
  assert.equal(line('  await run(argv, { env, cwd, timeout });'), true, 'a shorthand cwd among others');
  assert.equal(line('  writeFileSync(file, text);'), true, 'a named import');
  assert.equal(line("  const fd = fs.openSync(file, 'w');"), true, 'a file opened for writing');
  assert.equal(line('  const fd = fs.openSync(file, flags, 0o644);'), true, 'a file opened with flags not shown to be read-only');
  assert.equal(line('  const out = fs.createWriteStream(file);'), true, 'a write stream');
  assert.equal(line("  await run(['gh', 'repo', 'create', n, '--source', dir, '--push']);"), true, 'gh pushing from a folder');
  assert.equal(line("  await run(['git', ...gitDir(dir), 'push']);"), true, 'git with its folder spread in');
  assert.equal(line("  await run(['git', '--git-dir', g, '--work-tree', dir, 'add', '-A']);"), true, 'git with --git-dir and --work-tree');
  assert.equal(line("  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);"), false, 'a read is no act');
  assert.equal(line("  const fd = fs.openSync(file, 'r');"), false, 'a read is no act');
  assert.equal(line("  return startIn(at, dir, ['gh', 'repo', 'create', n, '--source', dir], run);"), false, 'an act through inside.mjs is checked there');
  // The forms the second version missed: named imports of node:fs/promises, the callback forms, an open with a write
  // flag among read ones, and a raw act on the same line as a checked call.
  const inFile = (head, s) => rawLines(`${head}\n${s}`).length > 0;
  assert.equal(inFile("import { rm, writeFile } from 'node:fs/promises';", '  await rm(dir, { recursive: true });'), true, 'rm by a named import');
  assert.equal(inFile("import { rm, writeFile } from 'node:fs/promises';", '  await writeFile(file, text);'), true, 'writeFile by a named import');
  assert.equal(inFile("import { rename as mv } from 'node:fs/promises';", '  await mv(a, b);'), true, 'an aliased named import');
  assert.equal(inFile("import { open } from 'node:fs/promises';", "  const h = await open(file, 'w');"), true, 'open by a named import, for writing');
  assert.equal(inFile("import { open } from 'node:fs/promises';", "  const h = await open(file, 'r');"), false, 'open by a named import, for reading');
  assert.equal(inFile("import fsp from 'node:fs/promises';", "  await fsp.open(file, 'w');"), true, 'a promise open for writing');
  assert.equal(inFile("import * as files from 'node:fs';", '  files.writeFileSync(file, text);'), true, 'a namespace import by another name');
  assert.equal(inFile("const { writeFile: put } = fs.promises;", '  await put(file, text);'), true, 'a destructuring of fs.promises');
  assert.equal(line('  fs.writeFile(file, text, cb);'), true, 'the callback form');
  assert.equal(line('  fs.rm(dir, { recursive: true }, cb);'), true, 'the callback form of rm');
  assert.equal(line("  await fs.promises.open(file, 'w');"), true, 'fs.promises.open for writing');
  assert.equal(line('  fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_CREAT);'), true, 'O_CREAT among read flags makes a file');
  assert.equal(line('  fs.openSync(file, fs.constants.O_RDWR);'), true, 'O_RDWR');
  assert.equal(line('  const r = await gitIn(at, d, [\'status\']); fs.rmSync(d, { recursive: true });'), true, 'a raw act beside a checked call');
  assert.equal(line("  todo.push({ command: showCommand(['git', '-C', dir, 'push']) }); fs.rmSync(d);"), true, 'a raw act beside a shown command');
  assert.equal(line("  const r = await gitIn(at, dir, ['-C', x]);"), false, 'what is inside a checked call stays checked there');
  assert.equal(line('  fs.readFileSync(file, \'utf8\');'), false, 'a read is no act');
  // The form the third version missed: an aliased import (or destructuring) of a Sync name or a write stream.
  assert.equal(inFile("import { writeFileSync as put } from 'node:fs';", '  put(file, text);'), true, 'an aliased Sync import');
  assert.equal(inFile("import { rmSync as remove } from 'node:fs';", '  remove(dir, { recursive: true });'), true, 'an aliased rmSync');
  assert.equal(inFile("import fs from 'node:fs';\nconst { rmSync: remove } = fs;", '  remove(dir, { recursive: true });'), true, 'a destructured, renamed rmSync');
  assert.equal(inFile("import { createWriteStream as out } from 'node:fs';", '  const s = out(file);'), true, 'an aliased write stream');
  assert.equal(inFile("import { readFileSync as read } from 'node:fs';", '  read(file);'), false, 'an aliased read is no act');
});
