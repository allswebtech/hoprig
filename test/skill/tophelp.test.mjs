// The top help ("hoprig help", and "hoprig" with an unknown word) is short and plain: about fifteen commands of every
// day, each explained in one line, in the order a person needs them; then one block that only NAMES every other
// command. Every command still has its own help ("hoprig help <command>" and "hoprig <command> --help").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatchedCommands } from '../../src/helptext.mjs';
import { ROOT, probeEnv } from '../../tools/build-skill.mjs';
import { sealed } from '../seal.mjs';

const BIN = path.join(ROOT, 'bin/hoprig.mjs');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tophelp-')));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const hop = (...args) => spawnSync(process.execPath, [BIN, ...args], { env: sealed({ ...probeEnv(home), PORT: '0' }), cwd: home, encoding: 'utf8' });

// Words that Hoprig starts itself, or that this version does not offer: not for a person to read in the top help.
const NOT_NAMED = ['hook', 'router', 'router-url', 'run', '__service-restart', 'codex'];
const top = hop('help').stdout;
const lines = top.replace(/\n+$/, '').split('\n');
const moreAt = lines.findIndex((l) => /^More:/.test(l));
const explained = lines.slice(0, moreAt).filter((l) => /^ {2}hoprig\b/.test(l));
const more = lines.slice(moreAt).join(' ');

test('the top help is 45 lines or fewer, and an unknown word prints the same', () => {
  assert.ok(lines.length <= 45, `${lines.length} lines`);
  assert.ok(lines.length >= 20, `${lines.length} lines`);
  for (const args of [['--help'], ['-h']]) assert.equal(hop(...args).stdout, top, args.join(' '));
  const unknown = hop('qwertyuiop');
  assert.notEqual(unknown.status, 0);
  assert.ok((unknown.stdout + unknown.stderr).includes(lines[0]), 'the top help follows the unknown word');
});

test('every word the launcher dispatches on is named in the top help, and the rest of the block only names', () => {
  assert.ok(moreAt > 0, 'a "More:" block');
  const words = [...dispatchedCommands().filter((c) => !NOT_NAMED.includes(c)), 'help', 'version'];
  for (const w of words) assert.match(top, new RegExp(`(^|[\\s,|(])${w}([\\s,|).:]|$)`, 'm'), `"${w}" is named`);
  assert.match(more, /hoprig help <command>/, 'the block says where each is explained');
  assert.doesNotMatch(top, /Codex|hoprig codex/);
});

test('each explained command has one plain line, and about fifteen are explained', () => {
  assert.ok(explained.length >= 12 && explained.length <= 20, `${explained.length} explained rows`);
  for (const l of explained) {
    const [, text] = /^ {2}hoprig[^\n]*?\s{2,}(\S.*)$/.exec(l) || [];
    assert.ok(text, `a row with its words: ${l}`);
    assert.ok(l.length <= 110, `one line: ${l}`);
  }
  // No word that needs knowledge a person has not got: none of these stays in the top help.
  for (const jargon of ['MODELS', 'PRERUN', 'MCP', 'adopt scan', 'way-round', 'fingerprint']) assert.ok(!top.includes(jargon), jargon);
});

test('"hoprig help <command>" prints what "hoprig <command> --help" prints, for every command', () => {
  for (const c of dispatchedCommands()) {
    const a = hop('help', c);
    assert.equal(a.status, 0, c);
    assert.equal(a.stdout, hop(c, '--help').stdout, c);
    assert.notEqual(a.stdout, top, `${c}: its own help, not the top one`);
  }
});

test('the help pages that used to be lines of the top help are kept whole', () => {
  assert.match(hop('auto', '--help').stdout, /hoprig auto order a b c\s+the providers Auto mode uses, most preferred first/);
  assert.match(hop('profiles', '--help').stdout, /hoprig profiles map <name> \[on\|off\] \[--yes\]/);
  assert.match(hop('add', '--help').stdout, /hoprig add \[name\]/);
  assert.match(hop('rm', '--help').stdout, /hoprig rm <name> \[--yes\]\s+delete a profile \(asks first/);
});

test('"hoprig help all" still lists every command with its options, as the top help did before it was short', () => {
  const all = hop('help', 'all').stdout;
  assert.ok(all.split('\n').length > 80, 'the long list');
  for (const c of dispatchedCommands().filter((w) => !NOT_NAMED.includes(w))) assert.match(all, new RegExp(`hoprig ${c}[ \\n]`), c);
  assert.match(more, /hoprig help all/, 'the top help says where the long list is');
});
