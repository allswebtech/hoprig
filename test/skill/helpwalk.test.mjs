// "help" is the word a person types to be safe. So after EVERY command bin/hoprig.mjs dispatches, and after every
// subcommand its own help names, `help`, `--help` and `-h` print help and do nothing else: no file written or
// changed, no program started, no connection made. Without this, "service uninstall help" turned the background
// dashboard off (systemctl), "machines join help" ran ssh to a computer named "help", "auto on --help" turned Auto mode
// on, "add <name> --help" started adding a profile, and help requests asked GitHub who is signed in (gh api user).
//
// The commands come from the dispatch itself (its case labels), the subcommands from the help each command prints, so
// a command added later is walked without a word here; one without help fails. Each case runs in a home of its own,
// seeded with settings, a profile and a state file, with every child_process call and every connection refused and
// written down by a preload, and with the runner's traps first on PATH. The home's listing (sizes, times, contents)
// before and after is the proof that nothing was written.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NO_OWN_HELP } from '../../src/helptext.mjs';
import { PASSED_ON, VALUE_PLACES } from '../../src/helpwords.mjs';
import { ROOT, probeEnv } from '../../tools/build-skill.mjs';
import { sealed } from '../seal.mjs';

const BIN = path.join(ROOT, 'bin/hoprig.mjs');
const WORDS = ['help', '--help', '-h'];
// A made-up value before the help word: also the name of the seeded profile, so "rm alpha help" names a real one.
const VALUE = 'alpha';

/** Every command of the dispatch: the case labels of bin/hoprig.mjs's main(). */
export function dispatched() {
  const src = fs.readFileSync(BIN, 'utf8');
  return [...new Set([...src.slice(src.indexOf('async function main(')).matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]))];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The subcommands a command's own help names: the words after "hoprig <cmd>" at the start of a line (a|b|c too). */
export function subsOf(cmd, text) {
  const re = new RegExp(`^\\s*(?:usage:\\s*)?hoprig ${esc(cmd)} ((?:[a-z][a-z-]*\\s*\\|\\s*)*[a-z][a-z-]*)(?=\\s|$)`);
  const subs = new Set();
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (m) for (const s of m[1].split('|')) subs.add(s.trim());
  }
  return [...subs];
}

// Refuses and writes down every program a child would start and every connection it would make. Loaded by
// --require ahead of the runner's own wrap, so a call never reaches the wrap's traps either.
const PRELOAD = `'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const log = process.env.HELPWALK_LOG;
const note = (s) => { try { fs.appendFileSync(log, s.replace(/\\n/g, ' ') + '\\n'); } catch {} };
const stop = (what) => { note(what); const e = new Error('a help request started something: ' + what); e.code = 'EHELPWALK'; throw e; };
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[k] = function (file, args) { stop(k + ' ' + String(file) + (Array.isArray(args) ? ' ' + args.join(' ') : '')); };
}
require('node:module').syncBuiltinESMExports();
net.Socket.prototype.connect = function (o) { stop('connect ' + JSON.stringify(o).slice(0, 120)); };
net.Server.prototype.listen = function (o) { stop('listen ' + JSON.stringify(o ?? null).slice(0, 60)); };
globalThis.fetch = async (u) => stop('fetch ' + String(u));
`;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

/** Every entry under `dir`: a file by size, time and content, a folder, a link by its target. */
function listing(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    out[rel] = st.isSymbolicLink() ? `link ${fs.readlinkSync(p)}` : st.isDirectory() ? 'dir' : `${st.size} ${st.mtimeMs} ${st.mode} ${sha(fs.readFileSync(p))}`;
  }
  return out;
}

function diff(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => a[k] !== b[k]).map((k) => (a[k] === undefined ? `made ${k}` : b[k] === undefined ? `removed ${k}` : `changed ${k}`));
}

/** A home with settings, one profile and a state file, as a person's would have. */
function seedHome(root) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(root, 'home-')));
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'config.json'), `${JSON.stringify({ autoSwitch: { enabled: false, order: [VALUE] } }, null, 2)}\n`);
  fs.mkdirSync(path.join(home, 'profiles'));
  fs.writeFileSync(path.join(home, 'profiles', `${VALUE}.env`), 'LABEL=Alpha\nANTHROPIC_BASE_URL=http://127.0.0.1:1\nANTHROPIC_AUTH_TOKEN=example-not-a-key\n');
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state', 'kept.txt'), 'kept\n');
  fs.mkdirSync(path.join(home, 'Workspace'));
  fs.mkdirSync(path.join(home, 'tmp'));
  return home;
}

/** `hoprig ...args` in a seeded home of its own: { code, out, err, ran, changed, timedOut }. */
function run(root, preload, args) {
  const home = seedHome(root);
  const log = path.join(path.dirname(home), `${path.basename(home)}.log`);
  const before = listing(home);
  return new Promise((resolve) => {
    const env = sealed({ ...probeEnv(home), TMPDIR: path.join(home, 'tmp'), PORT: '0', HELPWALK_LOG: log, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const changed = diff(before, listing(home));
      const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(log, { force: true });
      resolve({ code, out, err, ran, changed, timedOut });
    });
  });
}

async function some(jobs, n = Math.min(6, os.availableParallelism())) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }));
  return results;
}

/**
 * What went wrong in one case, or '' when it only printed its help. Its help names `hoprig <cmd>`, and with `sub`
 * names that subcommand too (its own line: "hoprig service install|uninstall|status|restart" names uninstall).
 */
function verdict(r, { top, cmd, sub }) {
  const own = sub ? `hoprig ${cmd} ${sub}` : `hoprig ${cmd}`;
  const names = r.out.includes(`hoprig ${cmd}`) && (!sub || subsOf(cmd, r.out).includes(sub));
  const why = [];
  if (r.timedOut) why.push('did not end');
  if (r.code !== 0) why.push(`exit ${r.code}`);
  if (r.ran.length) why.push(`started ${r.ran.slice(0, 2).join(' | ')}`);
  if (r.changed.length) why.push(`${r.changed.slice(0, 3).join(', ')}`);
  if (r.err.trim()) why.push(`said on stderr: ${r.err.trim().split('\n')[0].slice(0, 100)}`);
  if (!r.out.trim()) why.push('printed nothing');
  else if (r.out === top) why.push('printed the top help');
  else if (r.out.includes(NO_OWN_HELP)) why.push('has no help written for it (src/helptext.mjs)');
  else if (!names) why.push(`no "${own}" in its help (${r.out.trim().split('\n')[0].slice(0, 80)})`);
  return why.join('; ');
}

test('every help form after every command and subcommand prints that help and does nothing else', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'helpwalk-')));
  try {
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, PRELOAD);
    const top = (await run(root, preload, ['help'])).out;
    assert.match(top, /^Hoprig — /, 'the top help');
    const commands = dispatched();
    assert.ok(commands.length > 40 && commands.includes('service') && commands.includes('hook'), commands.join(' '));

    // The bare forms first: they are also where the subcommands are read from.
    const bare = commands.flatMap((c) => WORDS.map((w) => [c, w]));
    const bareResults = await some(bare.map((args) => () => run(root, preload, args)));
    const cases = bare.map((args, i) => ({ args, cmd: args[0], r: bareResults[i] }));
    const subsFound = {};
    const more = [];
    for (const c of commands) {
      const passed = Object.hasOwn(PASSED_ON, c);
      const text = bareResults[bare.findIndex(([x, w]) => x === c && w === '--help')].out;
      const subs = subsOf(c, text).filter((s) => !passed || PASSED_ON[c].includes(s));
      subsFound[c] = subs;
      // A made-up value after the command: its words are read as the command reads them.
      if (!passed) for (const w of WORDS) more.push({ args: [c, VALUE, w], cmd: c });
      for (const s of subs) {
        const value = VALUE_PLACES.some(([vc, vs]) => vc === c && vs === s);
        for (const w of WORDS) {
          if (w === 'help' && value) continue; // there "help" is a value (a task's title, a word to search for)
          more.push({ args: [c, s, w], cmd: c, sub: s });
          more.push({ args: [c, s, VALUE, w], cmd: c, sub: s });
        }
      }
    }
    const moreResults = await some(more.map((m) => () => run(root, preload, m.args)));
    more.forEach((m, i) => cases.push({ ...m, r: moreResults[i] }));

    // A subcommand's help is its own where the command's help has lines for it.
    const bad = cases.map((k) => [k.args.join(' '), verdict(k.r, { top, cmd: k.cmd, sub: k.sub })]).filter(([, v]) => v);
    assert.ok(Object.values(subsFound).flat().length > 60, `subcommands found: ${JSON.stringify(subsFound)}`);
    assert.ok(cases.length > 500, `${cases.length} cases`);
    assert.equal(bad.length, 0, `${bad.length} of ${cases.length} help requests did more than print help:\n${bad.map(([a, v]) => `  hoprig ${a}: ${v}`).join('\n')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
