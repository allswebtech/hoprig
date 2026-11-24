// The Hoprig skill tells a coding tool that `hop <command> --help` prints that command's help. So every help word after
// every command the skill names only prints: "hoprig pair help" made a real pairing code, "link help" a sign-in link,
// "join help" connected by SSH to "help", "get help" looked for a project, "auto --help" tried to start a session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dispatchedCommands, hasHelp, linesFor } from '../../src/helptext.mjs';
import { HELP_WORDS, PASSED_ON, VALUE_PLACES, helpRequest } from '../../src/helpwords.mjs';
import { ROOT, binCommands, probeEnv } from '../../tools/build-skill.mjs';
import { sealed } from '../seal.mjs';

const BIN = path.join(ROOT, 'bin/hoprig.mjs');

/**
 * `hoprig ...args` in its own empty home: { code, out, left (what it wrote), timedOut }. `noPath`: no program can be
 * found (a command that acts anyway, such as "claude update", then cannot reach this computer's real tools).
 */
function run(args, { noPath = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'helpwords-')));
  return new Promise((resolve) => {
    // PORT 0: a dashboard that started anyway would not take a port another test uses.
    const env = sealed({ ...probeEnv(home), PORT: '0', ...(noPath ? { PATH: path.join(home, 'no-programs') } : {}) });
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const left = fs.readdirSync(home, { recursive: true });
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, out, left, timedOut });
    });
  });
}

/** Runs `jobs` (functions returning promises) a few at a time. */
async function some(jobs, n = 8) {
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

test('every command of the dispatch has a help written for it, read from the dispatch itself', () => {
  const commands = dispatchedCommands();
  assert.ok(commands.includes('service') && commands.includes('__service-restart') && commands.includes('hook'), commands.join(' '));
  assert.deepEqual(binCommands().filter((c) => !commands.includes(c)), [], 'the skill\'s list of commands is part of it');
  assert.deepEqual(commands.filter((c) => !hasHelp(c)), []);
  assert.equal(hasHelp('brandnew'), false, 'a command added later without a help is found');
});

test('every help word after every command the skill names prints a usage and writes nothing', async () => {
  const skill = fs.readFileSync(path.join(ROOT, 'templates/skills/hoprig/SKILL.md'), 'utf8');
  const line = /^This skill is Hoprig .*?The commands: (.*?)\.$/ms.exec(skill);
  assert.ok(line, 'SKILL.md names its commands');
  const named = [...line[1].matchAll(/`hop ([a-z-]+)`/g)].map((m) => m[1]);
  assert.ok(named.length > 25 && named.includes('pair') && named.includes('auto'), named.join(' '));
  const cases = named.flatMap((c) => HELP_WORDS.map((w) => [c, w]));
  const results = await some(cases.map(([c, w]) => () => run([c, w])));
  const bad = [];
  results.forEach((r, i) => {
    const [c, w] = cases[i];
    const usage = /usage|^hoprig \S+ — |^Hoprig — |^\s*hoprig opencode /m.test(r.out);
    if (r.timedOut || !usage || r.left.length) bad.push(`hoprig ${c} ${w}: ${r.timedOut ? 'did not end; ' : ''}${usage ? '' : `no usage (${r.out.trim().split('\n')[0]}); `}${r.left.length ? `wrote ${r.left.slice(0, 3).join(', ')}` : ''}`);
  });
  assert.deepEqual(bad, []);
});

test('pair and link refuse a stray word instead of making a code or a link; with a help word they only print help', async () => {
  const r = await run(['pair', 'now']);
  assert.equal(r.code, 2, `pair now: ${r.out}`);
  assert.match(r.out, /takes no word/);
  assert.deepEqual(r.left, [], 'hoprig pair now wrote nothing');
  for (const args of [['pair', '--json', 'help'], ['link', 'help', '--minutes', '5']]) {
    const h = await run(args);
    assert.equal(h.code, 0, `${args.join(' ')}: ${h.out}`);
    assert.match(h.out, new RegExp(`^usage:\\n  hoprig ${args[0]}\\b`));
    assert.doesNotMatch(h.out, /Pairing code|Scan with|hoprig machines add/, 'only that command\'s lines');
    assert.deepEqual(h.left, [], `hoprig ${args.join(' ')} wrote nothing`);
  }
});

// "claude update --help" updated Claude Code, "tools on claude --help" changed the config, "pc clone -h" made the projects
// folder, "pc recipe save help" wrote a file named help, "skills update --help" ran the update check.
test('a help word after a subcommand prints a usage and writes nothing', async () => {
  const subs = [
    ['claude', 'status'], ['claude', 'update'], ['claude', 'install', 'latest'],
    ['tools', 'status'], ['tools', 'install', 'opencode'], ['tools', 'update', 'all'], ['tools', 'on', 'claude'], ['tools', 'off', 'claude'],
    ['pc', 'status'], ['pc', 'setup'], ['pc', 'recipe', 'save'], ['pc', 'clone', 'example/shop'],
    ['setup', '--yes'], ['doctor', '--offline'], ['update', '--dry-run'],
    ['skills', 'update'], ['skills', 'add', 'example/skill'], ['skills', 'list'],
    ['workspace', 'setup'], ['workspace', 'set', 'brain', 'x'], ['project', 'new', 'shop'], ['get', 'shop'],
    ['tasks', 'add', 'buy milk'], ['addons', 'setup', 'gateway'], ['gateways', 'add', 'x'], ['public', 'on'],
    ['tokens', 'revoke', 'all'], ['machines', 'rm', 'laptop'], ['service', 'install'], ['demo'], ['mcp'],
  ];
  const plain = ['setup', 'doctor', 'claude', 'update', 'tools', 'pc'];
  const cases = subs.flatMap((s) => ['--help', '-h', ...(plain.includes(s[0]) ? ['help'] : [])].map((w) => [...s, w]));
  cases.push(['pc', 'recipe', 'save', 'help', '--with-email'], ['tools', 'on', '-h', 'claude'], ['claude', 'update', 'now'], ['claude', 'status', 'now']);
  const results = await some(cases.map((args) => () => run(args, { noPath: true })));
  const bad = [];
  results.forEach((r, i) => {
    const usage = /usage|^hoprig \S+ — /m.test(r.out);
    const { left } = r;
    if (r.timedOut || !usage || left.length) bad.push(`hoprig ${cases[i].join(' ')}: ${r.timedOut ? 'did not end; ' : ''}${usage ? '' : `no usage (${r.out.trim().split('\n')[0]}); `}${left.length ? `wrote ${left.slice(0, 3).join(', ')}` : ''}`);
  });
  assert.deepEqual(bad, []);
});

test('a help word in the place of a subcommand or after one is a help request, for every command alike', () => {
  for (const [cmd, rest] of [
    ['service', ['uninstall', 'help']], ['machines', ['join', 'help']], ['auto', ['on', '--help']], ['rm', ['alpha', '--help']],
    ['add', ['alpha', '-h']], ['profiles', ['map', 'help']], ['pair', ['help']], ['tokens', ['revoke', 'x', 'help']],
    ['skills', ['update', 'help']], ['tasks', ['done', 'help']], ['tasks', ['help']], ['skills', ['help']],
  ]) assert.ok(helpRequest(cmd, rest), `hoprig ${cmd} ${rest.join(' ')}`);
  assert.deepEqual(helpRequest('service', ['uninstall', 'help']), { sub: 'uninstall' });
  assert.deepEqual(helpRequest('service', ['--help']), { sub: null });
  assert.equal(helpRequest('service', ['uninstall']), null, 'no help word: the command runs as typed');
});

test('"help" as a value stays a value only in the places named as data; words for a coding tool stay theirs', () => {
  // The places, as data: after these subcommands the words are free text.
  assert.deepEqual(VALUE_PLACES, [['tasks', 'add'], ['tasks', 'edit'], ['skills', 'find'], ['skills', 'search'], ['field', 'way-round']]);
  assert.equal(helpRequest('field', ['way-round', '--failed', 'help', '--worked', 'x']), null, 'a text that says help');
  assert.equal(helpRequest('tasks', ['add', 'help']), null, 'a task named help');
  assert.equal(helpRequest('tasks', ['edit', 'renew', '--note', 'help']), null, 'a note that says help');
  assert.equal(helpRequest('skills', ['find', 'help']), null, 'a skill searched by that word');
  assert.equal(helpRequest('skills', ['search', 'help', 'me']), null);
  // There --help and -h are still help, and so is "help" in the place of the subcommand.
  assert.deepEqual(helpRequest('tasks', ['add', 'x', '--help']), { sub: 'add' });
  assert.deepEqual(helpRequest('skills', ['find', 'x', '-h']), { sub: 'find' });
  assert.deepEqual(helpRequest('tasks', ['help']), { sub: null });
  // Anywhere else the plain word is help, also after a value.
  assert.deepEqual(helpRequest('tasks', ['done', 'help']), { sub: 'done' });
  assert.deepEqual(helpRequest('pc', ['recipe', 'save', 'help']), { sub: 'recipe' });
  // After "--" nothing is Hoprig's.
  assert.equal(helpRequest('tasks', ['add', 'x', '--', '-h']), null);
  assert.equal(helpRequest('box', ['run', '--write', 'd', '--', 'ls', '--help']), null);
  // Words handed on to a coding tool, unless the first word is a help word or one of Hoprig's own subcommands.
  assert.deepEqual(Object.keys(PASSED_ON).sort(), ['auto', 'codex', 'opencode', 'run']);
  assert.equal(helpRequest('opencode', ['-c', '--help']), null);
  assert.equal(helpRequest('opencode', ['alpha', 'help']), null);
  assert.equal(helpRequest('codex', ['x', '-h']), null);
  assert.equal(helpRequest('auto', ['-c', '--help']), null, 'after auto the words go to Claude Code');
  assert.equal(helpRequest('run', ['alpha', '--help']), null);
  assert.deepEqual(helpRequest('auto', ['on', '--help']), { sub: 'on' }, 'auto on is a setting: its help word is Hoprig\'s');
  assert.deepEqual(helpRequest('opencode', ['--help']), { sub: null });
  assert.deepEqual(helpRequest('codex', ['login', 'help']), { sub: 'login' });
});

test('a subcommand\'s lines are taken from the command\'s help, with the lines that go on under them', () => {
  const text = 'usage:\n  hoprig x a|b [--y]   one\n                       more of it\n  hoprig x c          two\n  hoprig other';
  assert.equal(linesFor(text, 'x', 'b'), 'usage:\n  hoprig x a|b [--y]   one\n                       more of it');
  assert.equal(linesFor(text, 'x', 'c'), 'usage:\n  hoprig x c          two');
  assert.equal(linesFor(text, 'x', 'z'), null);
});
