// A git repository whose own settings name programs, the way a folder cloned, unpacked or written by a coding tool can:
// an fsmonitor command, a hooks folder (post-index-change and every other hook), a clean / smudge / process filter
// bound by .gitattributes (also one whose name holds "="), a text converter, an external diff command, signature
// checks with a gpg program, and a partial clone's remote whose upload-pack is a program. Each writes a marker file
// named after itself into `marks` when it runs. POSIX only (the programs are shell scripts).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROGRAMS = ['fsmonitor', 'hook', 'clean', 'smudge', 'process', 'eqclean', 'textconv', 'command', 'external', 'gpg', 'uploadpack'];

/**
 * Make it at `dir` (created) with marks in `marks`. The repository has one commit (a.txt, b.txt, c.md, gone.txt; its
 * commit carries a signature; gone.txt's stored copy is missing), then: a.txt changed ("one" → "one\ntwo"), b.txt touched with the same text (git compares its
 * contents), new.txt untracked. → { dir, marks, ran(): names of the programs that ran, clear() }.
 */
export function hostileRepo(dir, marks) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(marks, { recursive: true });
  const bin = path.join(path.dirname(marks), `${path.basename(dir)}-programs`);
  fs.mkdirSync(bin, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(bin, 'no-global') };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_PARAMETERS|EXTERNAL_DIFF)$/.test(k)) delete env[k];
  const g = (...a) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  // One script per program: it leaves its mark, then behaves (a filter passes its input through, a converter prints
  // the file, the rest end with "no").
  const script = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n: > '${path.join(marks, name)}'\n${body}\n`, { mode: 0o755 });
    return p;
  };
  for (const n of ['clean', 'smudge', 'eqclean']) script(n, 'cat');
  script('textconv', 'cat "$1"');
  script('fsmonitor', 'exit 1');
  for (const n of ['command', 'external', 'process', 'uploadpack']) script(n, 'exit 1');
  script('gpg', 'exit 1');
  const hooks = path.join(bin, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const h of ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction', 'fsmonitor-watchman']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\n: > '${path.join(marks, 'hook')}'\n`, { mode: 0o755 });
  }

  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'same\n');
  fs.writeFileSync(path.join(dir, 'c.md'), 'see\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'its stored copy is missing\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=evil diff=evil\n*.md filter=a=b\n');
  g('add', '-A');
  g('commit', '-qm', 'first');
  // A commit that carries a signature: a log that checks signatures starts gpg.program for it.
  const raw = g('cat-file', 'commit', 'HEAD');
  const sig = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n';
  const signed = raw.replace(/\n\n/, `\n${sig}\n`).replace('first', 'signed');
  const tmp = path.join(bin, 'commit.raw');
  fs.writeFileSync(tmp, signed);
  const id = g('hash-object', '-t', 'commit', '-w', tmp).trim();
  g('update-ref', 'refs/heads/main', id);
  // gone.txt's stored copy is removed, as in a partial clone that never fetched it.
  const blob = g('rev-parse', 'HEAD:gone.txt').trim();
  fs.rmSync(path.join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

  const set = (k, v) => g('config', k, v);
  set('core.fsmonitor', path.join(bin, 'fsmonitor'));
  set('core.hooksPath', hooks);
  set('filter.evil.clean', path.join(bin, 'clean'));
  set('filter.evil.smudge', path.join(bin, 'smudge'));
  set('filter.evil.required', 'true');
  set('filter.a=b.clean', path.join(bin, 'eqclean'));
  set('diff.evil.textconv', path.join(bin, 'textconv'));
  set('diff.evil.command', path.join(bin, 'command'));
  set('diff.external', path.join(bin, 'external'));
  set('log.showSignature', 'true');
  set('gpg.program', path.join(bin, 'gpg'));
  set('submodule.recurse', 'true');
  // A partial clone: an object it lacks would be fetched from "origin", whose upload-pack is a program here.
  set('remote.origin.url', bin);
  set('remote.origin.uploadpack', path.join(bin, 'uploadpack'));
  set('remote.origin.promisor', 'true');
  set('extensions.partialClone', 'origin');
  set('protocol.file.allow', 'always');
  // The hooks folder's own copies too (.git/hooks), for a reader that only moves core.hooksPath away.
  for (const h of fs.readdirSync(hooks)) fs.copyFileSync(path.join(hooks, h), path.join(dir, '.git', 'hooks', h));

  // The working state: a.txt changed, b.txt the same text with a newer time (git must compare its contents, with the
  // clean filter when one runs), new.txt not tracked yet.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'b.txt'), later, later);
  fs.utimesSync(path.join(dir, 'c.md'), later, later);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  const clear = () => {
    for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f), { force: true });
  };
  clear();
  return { dir, marks, bin, commit: id, ran: () => fs.readdirSync(marks).filter((f) => PROGRAMS.includes(f)).sort(), clear };
}
