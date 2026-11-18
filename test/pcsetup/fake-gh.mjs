#!/usr/bin/env node
// A stand-in for GitHub's `gh`, put first on PATH by the tests: the "accounts" are folders of bare repositories
// (FAKE_GH_ROOT/<owner>/<repo>.git), reached through git's url.insteadOf for https://github.com/. Only what Hoprig
// asks is answered; anything else fails. Nothing leaves the computer. Like GitHub, a name is found in any letter case,
// and a renamed repository answers under its old name too (FAKE_GH_ROOT/<owner>/renamed.json: { "old": "new" };
// a test links old.git to new.git for git itself).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.FAKE_GH_ROOT;
const user = process.env.FAKE_GH_USER || '';
const orgs = (process.env.FAKE_GH_ORGS || '').split(',').filter(Boolean);
const a = process.argv.slice(2);
/** "owner/name" as the repository is really called (any case; an old name after a rename), or the input. */
const real = (full) => {
  const [o, n] = String(full).split('/');
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, o)).filter((x) => x.endsWith('.git') && !fs.lstatSync(path.join(root, o, x)).isSymbolicLink()).map((x) => x.slice(0, -4));
  } catch {
    return full;
  }
  let renamed = {};
  try {
    renamed = JSON.parse(fs.readFileSync(path.join(root, o, 'renamed.json'), 'utf8'));
  } catch {
    /* none */
  }
  const lower = (n || '').toLowerCase();
  const to = Object.entries(renamed).find(([old]) => old.toLowerCase() === lower);
  const hit = names.find((x) => x.toLowerCase() === (to ? to[1] : n || '').toLowerCase());
  return hit ? `${o}/${hit}` : full;
};
const bare = (full) => path.join(root, `${real(full)}.git`);
const done = (text = '', code = 0) => {
  if (text) process.stdout.write(`${text}\n`);
  process.exit(code);
};

if (!root || !user) done('', 4); // "not signed in"
if (a[0] === 'api' && a[1] === 'user') done(user);
if (a[0] === 'api' && a[1] === 'user/orgs') done(orgs.join('\n'));
if (a[0] === 'repo' && a[1] === 'view') done(fs.existsSync(bare(a[2])) ? JSON.stringify({ name: real(a[2]).split('/')[1] }) : '', fs.existsSync(bare(a[2])) ? 0 : 1);
let m = /^repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(a[1] || '');
if (a[0] === 'api' && m) {
  try {
    execFileSync('git', ['--git-dir', bare(m[1]), 'cat-file', '-e', `HEAD:${m[2]}`], { stdio: 'ignore' });
    // --jq .content: the file itself, base64 as GitHub sends it; else its name
    if (a.includes('.content')) done(execFileSync('git', ['--git-dir', bare(m[1]), 'show', `HEAD:${m[2]}`]).toString('base64'));
    done(path.basename(m[2]));
  } catch {
    done('', 1);
  }
}
if (a[0] === 'repo' && a[1] === 'list') {
  const dir = path.join(root, a[2]);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.git') && !fs.lstatSync(path.join(dir, n)).isSymbolicLink()).map((n) => n.slice(0, -4)) : [];
  done(JSON.stringify(names.map((n) => ({ name: n, url: `https://github.com/${a[2]}/${n}` }))));
}
if (a[0] === 'repo' && a[1] === 'create') {
  // gh repo create <owner>/<name> --private --source <dir> --remote origin --push
  const full = a[2];
  if (fs.existsSync(bare(full))) done(`GraphQL: Name already exists on this account (createRepository)`, 1);
  const src = a[a.indexOf('--source') + 1];
  fs.mkdirSync(bare(full), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare(full)]);
  execFileSync('git', ['-C', src, 'remote', 'add', 'origin', `https://github.com/${full}.git`]);
  execFileSync('git', ['-C', src, 'push', '-q', '-u', 'origin', 'HEAD'], { stdio: 'ignore' });
  done(`https://github.com/${full}`);
}
m = null;
done('', 2);
