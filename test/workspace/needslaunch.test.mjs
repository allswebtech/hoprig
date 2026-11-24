// A terminal session started in `shop` (launch.mjs): its need kits/parts reaches the coding tool as an extra folder
// (--add-dir) with the deny rules in the settings Hoprig hands it, `--with` adds one more for that session only and
// never reaches the tool, a need not here is said once at the start and nothing is fetched, a `--with` that cannot be
// opened refuses the start. A stand-in Claude Code writes down what it was given.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { needsWorld } from './needsfix.mjs';

test('a terminal session in shop: extra folders, deny rules, the start note, --with', { skip: process.platform === 'win32' }, async () => {
  const w = needsWorld('needs-launch', { shopNeeds: ['kits/parts', 'docs'] });
  const cwd = process.cwd();
  const write = process.stderr.write;
  try {
    process.env.HOPRIG_WORKSPACE_DIR = w.ws;
    const fake = path.join(w.root, 'fake-claude.mjs');
    const seen = path.join(w.root, 'seen.json');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
const i = a.indexOf('--settings');
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: a, settings: i < 0 ? null : JSON.parse(fs.readFileSync(a[i + 1], 'utf8')) }));
`, { mode: 0o755 });
    fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
    const cfgFile = path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), claudeBin: fake, usage: false })); // keeps the yes for shop's needs
    const P = await import('../../src/profiles.mjs');
    P.writeProfile('alpha', {});
    const L = await import('../../src/launch.mjs');
    const run = async (args) => {
      fs.rmSync(seen, { force: true });
      let err = '';
      process.stderr.write = (c) => ((err += String(c)), true);
      try {
        const code = await L.launch('alpha', args);
        return { code, err, seen: fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, 'utf8')) : null };
      } finally {
        process.stderr.write = write;
      }
    };
    process.chdir(w.shop);
    const parts = fs.realpathSync(w.parts);
    let r = await run(['--', 'hello']);
    assert.equal(r.code, 0, r.err);
    const ai = r.seen.args.indexOf('--add-dir');
    assert.deepEqual(r.seen.args.slice(ai, ai + 2), ['--add-dir', parts]);
    assert.deepEqual(r.seen.args.slice(-2), ['--', 'hello'], 'the first message stays last');
    assert.ok(r.seen.settings.hooks, 'the hooks are still there');
    assert.deepEqual(r.seen.settings.permissions.additionalDirectories, [parts]);
    for (const rule of [`Write(/${parts}/**)`, `Edit(/${parts}/**)`, `Read(/${parts}/ai-ignore-dir/**)`, `Read(/${parts}/hidden/**)`, `Read(/${parts}/.env)`]) assert.ok(r.seen.settings.permissions.deny.includes(rule), rule);
    assert.ok(!JSON.stringify(r.seen.settings).includes('Bash(rm'), 'the need\'s allow rules never travel');
    assert.match(r.err, /extra folders to read \(its file tools cannot write there; a shell command still could\): kits\/parts/);
    assert.match(r.err, /shop needs docs, which is not on this computer \(nothing is fetched\): hoprig get docs/);
    assert.ok(!fs.existsSync(path.join(w.projects, 'docs')), 'nothing fetched');

    // --with: one more for this session; the flag itself never reaches Claude Code.
    r = await run(['--with', 'blog']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.seen.args.includes('--with'));
    assert.deepEqual(r.seen.settings.permissions.additionalDirectories, [parts, fs.realpathSync(path.join(w.projects, 'blog'))]);
    assert.ok(!fs.readFileSync(path.join(w.shop, 'project.json'), 'utf8').includes('blog'), 'nothing written to project.json');

    // A --with that is not here, or never allowed: the start is refused and Claude Code never runs.
    for (const bad of ['docs', 'credentials', '../../credentials', 'ai_brain']) {
      r = await run(['--with', bad]);
      assert.equal(r.code, 2, bad);
      assert.equal(r.seen, null, bad);
    }
    r = await run(['--with', 'docs']);
    assert.match(r.err, /hoprig get docs/);
    assert.match(r.err, /hoprig: the session was not started\n$/);
    r = await run(['--with', 'nosuch']);
    assert.equal(r.code, 2);
    assert.match(r.err, /the workspace map has no project "nosuch" \(hoprig get --list shows every name\)/);
    assert.match(r.err, /the session was not started/);

    // With settings of the caller's own, Hoprig cannot keep the folders read-only: no extra folder, and it says so.
    const own = path.join(w.root, 'own.json');
    fs.writeFileSync(own, '{}');
    r = await run(['--settings', own]);
    assert.equal(r.code, 0);
    assert.ok(!r.seen.args.includes('--add-dir'));
    assert.match(r.err, /not opened: this session has settings of your own/);
    r = await run(['--settings', own, '--with', 'blog']);
    assert.equal(r.code, 2);

    // A session outside any project: nothing changes.
    process.chdir(w.root);
    r = await run([]);
    assert.ok(!r.seen.args.includes('--add-dir'));
    assert.equal(r.seen.settings.permissions, undefined);
  } finally {
    process.stderr.write = write;
    process.chdir(cwd);
    w.cleanup();
  }
});

test('--with survives a move to another provider; a need is decided again only at the next start', async () => {
  const L = await import('../../src/launch.mjs');
  assert.deepEqual(L.carryArgs(['--with', 'kits/parts', '-c', '--with=blog', 'hello']), ['--with', 'kits/parts', '--with=blog']);
  assert.deepEqual(L.takeWith(['--with', 'a', '--', '--with', 'b']), { withs: ['a'], rest: ['--', '--with', 'b'] });
});
