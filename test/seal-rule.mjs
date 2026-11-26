// The rule test/seal.test.mjs holds over test/: a PATH a test writes keeps the runner's seal (test/seal.mjs).
//  - Into the whole environment (`...process.env`, `process.env.PATH = …`): the runner's variables are kept, so the
//    PATH passes when it keeps the traps (its value names process.env.PATH or a copy saved as was, saved, before,
//    pathBefore or PATH) or holds no folder of the computer's own (only the test's folders: no real program is found).
//  - Into an environment of its own: through sealed() or sealedPath(), which keep the traps and the variables.
//  - Otherwise a comment `// seal: <why>` on the line says why it needs none: a value no program is started with
//    (a function's input, a title), only the test's own folders in this process (which keeps the runner's
//    variables), or a sandbox with a root of its own.
import fs from 'node:fs';
import path from 'node:path';

const WRITES = /(^|[\s{,(])(PATH|Path)\s*:|\.(PATH|Path)\s*=(?!=)|[{,]\s*PATH\s*[,}]/;
const VALUE = /(PATH|Path)\s*(:|=(?!=))([\s\S]*)$/;
const KEEPS = /process\.env\.PATH|\b(was|saved|before|pathBefore)\b|\$\{PATH\}|^\s*PATH\b/;
const SYSTEM = /['"`:;](\/usr)?\/s?bin\b|\/usr\/local|\/opt\/|C:\\\\|dirname\(process\.execPath\)|process\.env\.PATH/;
const WHOLE_ENV = /\.\.\.process\.env\b|process\.env\.(PATH|Path)\s*=|Object\.assign\(process\.env\b/;
// The seal's own files, and the runner's fixture that drops the file's name on purpose (test/seal.test.mjs).
const OWN = new Set(['seal.mjs', 'seal-rule.mjs', 'seal.test.mjs', ['fixtures', 'runner', 'reaches.mjs'].join(path.sep)]);

/** The lines of the test folder `dir` that write a PATH without the seal: "test/file:line: text". */
export function unsealedPaths(dir) {
  const out = [];
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    if (!/\.m?js$/.test(rel) || OWN.has(rel) || rel.split(/[\\/]/).includes('node_modules')) continue;
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    // `{ PATH }`: the value is the file's own `const PATH = …`.
    const named = /\b(?:const|let)\s+PATH\s*=\s*(.+)$/m.exec(text)?.[1] ?? '';
    let open = false; // inside a `sealed({` that spans lines, up to its `});`
    text.split('\n').forEach((l, i) => {
      const inBlock = open;
      if (/\bsealed\(\{\s*$/.test(l)) open = true;
      else if (open && /^\s*\}\)/.test(l)) open = false;
      if (inBlock || !WRITES.test(l) || /^\s*(\/\/|\*)/.test(l) || /\bsealed(Path)?\(|\/\/ seal: \S/.test(l)) return;
      const value = VALUE.exec(l)?.[3] || named;
      if (/\bsealed(Path)?\(/.test(value)) return;
      if (WHOLE_ENV.test(l) && (KEEPS.test(value) || !SYSTEM.test(value))) return;
      out.push(`test/${rel.split(path.sep).join('/')}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  return out;
}

// The second rule: a child started past the sealed environment, either with it CLEARED by `env -i` (also `env -iX`,
// `env -`, `--ignore-environment`), with PATH alone removed (`env -u PATH`, `--unset=PATH`, `-uPATH`), or with its
// PATH RESET inside a shell string (`sh -c 'PATH=… cmd'`). The in-process
// wrap seals the environment a test hands a child, and holds an `env` ARGV that clears or resets PATH by construction
// (tools/test-seal.mjs sealEnvArgv forces the sealed PATH and the runner's variables into env's own arguments). But a
// SHELL STRING the wrap cannot rewrite: `env` then throws the sealed environment away, or `PATH=…` overrides it, and
// the program after it is searched on the system's folders, where no trap is. So a test may not write one on a line
// that starts a child: in a command string (exec, execSync, spawn of `sh -c`…), or — though the wrap now holds it too
// — as the argv of `env` (spawnSync('env', ['-i', …]) or ['-u', 'PATH', …], a full path to env). A line
// that needs it says why with `// seal: <why>`. Options between `env` and `-i`, a multi-line argv, and a command
// built in a variable are held by the wrap, not by this line-based rule (said at the head of tools/test-seal.mjs).
const CLEARS_IN_STRING = /\benv\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+|[A-Za-z_]\w*\s+(?=-))*(?:-[a-zA-Z]*i[a-zA-Z]*|--ignore-environment|-)(?=[\s'"`]|$)/;
const CLEARS_IN_ARGV = /['"`](?:[^'"`]*\/)?env['"`]\s*,\s*\[?\s*['"`](?:-[a-zA-Z]*i[a-zA-Z]*|--ignore-environment|-)['"`]/;
// `env … -u PATH` / `--unset=PATH` / `-uPATH`: PATH alone is removed, so the command runs on the system's folders past
// the traps. The lazy span between `env` and the token stays inside one quoted string; the lookahead keeps `PATH` a
// whole name (not `PATHX`). The wrap holds the argv form by construction; the rule names the shell-string form it
// cannot rewrite, and the argv form too, the way env -i is named. (`-iu PATH` clears, so CLEARS already names it.)
const UNSETS_PATH_IN_STRING = /\benv\b[^'"`]*?(?:-u\s?PATH|--unset[=\s]PATH)(?=[\s'"`]|$)/;
const UNSETS_PATH_IN_ARGV = /['"`](?:[^'"`]*\/)?env['"`]\s*,\s*\[[^\]]*?(?:['"`]-u['"`]\s*,\s*['"`]PATH['"`]|['"`]-[a-zA-Z]*uPATH['"`]|['"`]--unset=PATH['"`]|['"`]--unset['"`]\s*,\s*['"`]PATH['"`])/;
// A PATH set at the head of a shell command string (`'PATH=… cmd'`, after any other assignments): the command after
// it is searched on that PATH, past the traps. The command inside the same string (the trailing \s+\S) marks it as a
// shell string, not an `env` PATH= argv element (`'PATH=…'` on its own), which the wrap seals by construction.
const RESETS_PATH_IN_STRING = /['"`](?:[A-Za-z_]\w*=[^'"`\s]*\s+)*PATH=[^'"`\s]*\s+[^'"`\s]/;
const STARTS = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|shell:\s*true/;

/** The lines of the test folder `dir` that start a child past the sealed environment (env -i, or a PATH reset in a
 *  shell string): "test/file:line: text". */
export function clearedEnvs(dir) {
  const out = [];
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    if (!/\.m?js$/.test(rel) || OWN.has(rel) || rel.split(/[\\/]/).includes('node_modules')) continue;
    fs.readFileSync(path.join(dir, rel), 'utf8').split('\n').forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l) || /\/\/ seal: \S/.test(l)) return;
      if (CLEARS_IN_ARGV.test(l) || UNSETS_PATH_IN_ARGV.test(l) || (STARTS.test(l) && (CLEARS_IN_STRING.test(l) || UNSETS_PATH_IN_STRING.test(l) || RESETS_PATH_IN_STRING.test(l)))) out.push(`test/${rel.split(path.sep).join('/')}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  return out;
}

// The third rule: the runner's df, ps and ss stand in for the computer's own (tools/seal-standins.cjs), and the
// listing of /proc holds the test's own processes only. A test that needs the real one for what it proves sets
// HOPRIG_SEAL_REAL (a list of df, ps, ss, proc, or a program it starts by a full path) on a line that says why: `// seal: <why>`. REAL_PROGRAMS lists those
// test files, so a new one is a choice someone made and read, never a way round the stand-ins by accident.
export const REAL_PROGRAMS = [
  'test/desktop/feature.test.mjs', // ps: the processes above the dashboard (the runner's) are guarded; read only
  'test/desktop/files.test.mjs', // tar on Windows: the system's own by its full path packs and unpacks the test's tiny archives
  'test/editor/archive-own.test.mjs', // tar on Windows: what the system's own does with an archive of the test's holding names outside its code page
  'test/machines/forward-browser.test.mjs', // the browser: which cookies a real browser sends; pages on 127.0.0.1 only
  'test/machines/hostkeys.test.mjs', // ssh-keygen: its print of a key file the test wrote; reaches no other computer
  'test/pcsetup/flutterkit.test.mjs', // tar on Windows: the system's own by its full path unpacks the test's tiny archives
  'test/pcsetup/unpack.test.mjs', // tar on Windows: the system's own by its full path unpacks the test's tiny archives
  'test/setup/doctor.test.mjs', // whoami on Windows: doctor as its own process reads this account's SID; it only reads
  'test/skill/claims.test.mjs', // whoami on Windows: doctor in a child reads this account's SID; it only reads
];

/** The test files of `dir` that set HOPRIG_SEAL_REAL, and the lines that set it without a reason. */
export function realPrograms(dir) {
  const files = new Set();
  const bare = [];
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    if (!/\.m?js$/.test(rel) || OWN.has(rel) || rel.split(/[\\/]/).includes('node_modules')) continue;
    const name = `test/${rel.split(path.sep).join('/')}`;
    fs.readFileSync(path.join(dir, rel), 'utf8').split('\n').forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l) || !/HOPRIG_SEAL_REAL/.test(l)) return;
      files.add(name);
      if (!/\/\/ seal: \S/.test(l)) bare.push(`${name}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  return { files: [...files], bare };
}
