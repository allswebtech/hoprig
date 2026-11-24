// What these parts of Tia (the inventory, the spend cap, the five new acts, her own address) do BY THEMSELVES
// after an update: nothing. On an isolated home with Tia on, a paid provider allowed, a daily cap set and her stand-in
// engine, a real server start and three ticks of the upkeep leave every file outside the state folder as it was, start
// no session, call no model (the stand-in engine writes a mark when it starts) and write no spend, and no file call or
// program start comes from acts.mjs or spend.mjs.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const OURS = /src[\\/]assistant[\\/](acts|spend)\.mjs/;

function snapshot(root, skip) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (skip(rel)) continue;
      const st = fs.lstatSync(p);
      if (e.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) {
        out[rel] = `dir ${(st.mode & 0o7777).toString(8)}`;
        walk(p);
      } else out[rel] = `file ${st.size} ${(st.mode & 0o7777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

function watch() {
  const seen = [];
  let on = true;
  const orig = { cp: {}, fs: {} };
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    orig.cp[k] = childProcess[k];
    childProcess[k] = function (file, ...rest) {
      if (on && OURS.test(new Error().stack)) seen.push(`${k} ${file}`);
      return orig.cp[k].call(this, file, ...rest);
    };
  }
  for (const k of ['readFileSync', 'readdirSync', 'appendFileSync', 'writeFileSync', 'mkdirSync', 'statSync']) {
    orig.fs[k] = fs[k];
    const wrapped = function (p, ...rest) {
      if (on && OURS.test(new Error().stack)) seen.push(`${k} ${typeof p === 'string' ? p : ''}`);
      return orig.fs[k].call(this, p, ...rest);
    };
    Object.assign(wrapped, orig.fs[k]);
    fs[k] = wrapped;
  }
  syncBuiltinESMExports();
  return {
    seen,
    pause: () => (on = false),
    stop: () => {
      Object.assign(childProcess, orig.cp);
      Object.assign(fs, orig.fs);
      syncBuiltinESMExports();
    },
  };
}

test('a server start and three ticks with Tia on and a cap set: no file outside its state, no session, no model call, no spend', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('tia-byitself');
  // Traps first on PATH: none of these may be reached.
  const traps = path.join(box.root, 'traps');
  const trapped = path.join(box.root, 'trapped.log');
  fs.mkdirSync(traps);
  for (const n of ['ssh', 'sudo', 'systemctl', 'loginctl', 'npm', 'apt-get', 'git']) fs.writeFileSync(path.join(traps, n), `#!/bin/sh\necho "${n} $*" >> '${trapped}'\nexit 99\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${traps}${path.delimiter}${oldPath}`;
  // Her stand-in engine: any start of it leaves a mark (a model call would follow).
  const engineMark = path.join(box.root, 'engine-started');
  const engine = path.join(box.root, 'engine.mjs');
  fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(engineMark)}, 'started');\nprocess.exit(1);\n`);
  const work = path.join(box.home, 'projects');
  fs.mkdirSync(path.join(work, 'shop'), { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ usage: false, server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'handsoff', accounts: ['api'], runsOn: 'api', dailyCapUsd: 5 } });
  writeProfile('api', { label: 'API', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  const skip = (rel) => rel === 'state' || rel.startsWith('state/');
  const before = snapshot(box.root, skip);
  const w = watch();
  let app = null;
  t.after(async () => {
    w.stop();
    process.env.PATH = oldPath;
    if (app) await app.close().catch(() => {});
    box.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, assistant: { engine: { command: { command: process.execPath, args: [engine] }, resolveEnv: async () => ({ ...process.env }) } } });
  await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const auto = app.features.find((f) => f.name === 'automation').automation;
  for (let i = 0; i < 3; i++) await auto.tick();
  await new Promise((r) => setTimeout(r, 500));
  w.pause();
  const after = snapshot(box.root, skip);

  assert.deepEqual(w.seen, [], 'no file call and no program from acts.mjs or spend.mjs');
  assert.deepEqual(changes(before, after), [], 'nothing outside the state folder changed');
  assert.equal(fs.existsSync(engineMark), false, 'her engine was never started: no model call');
  assert.equal(fs.existsSync(path.join(box.state, 'assistant', 'spend.jsonl')), false, 'nothing was spent or held');
  const st = await app.features.find((f) => f.name === 'assistant').ops.listSessions({ computer: 'this' });
  assert.deepEqual(st, [], 'no session was started');
  assert.equal(fs.existsSync(trapped) ? fs.readFileSync(trapped, 'utf8') : '', '', 'no trapped program');
});

test('Tia administrator rights by itself: a server start and three ticks at Off, Ask and Full start no session, write nothing outside state, and run no administrator command', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async () => {
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { herRightsLevel } = await import('../../src/assistant/herrights.mjs');
  const { hoprigVersion } = await import('../../src/handsoff.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const skip = (rel) => rel === 'state' || rel.startsWith('state/');

  // null = no herRights key (a fresh install, and what an update leaves): the level must read Off, so nothing of hers
  // ever runs an administrator command until the owner turns it on on his own page. Ask and Full set the level but, by
  // themselves, start nothing: only a command of hers through run_command is governed by the level, and an idle tick
  // issues none. Full is stamped with the running version so it reads as Full here (the downgrade is its own test).
  const scenarios = [
    { name: 'absent (a fresh home)', herRights: null, expect: 'off' },
    { name: 'Ask each time', herRights: { level: 'ask', version: hoprigVersion(), at: 1 }, expect: 'ask' },
    { name: 'Full', herRights: { level: 'full', version: hoprigVersion(), at: 1 }, expect: 'full' },
  ];

  for (const sc of scenarios) {
    const box = sandbox('tia-admin-byitself');
    const traps = path.join(box.root, 'traps');
    const trapped = path.join(box.root, 'trapped.log');
    fs.mkdirSync(traps);
    // The escalators an administrator command would use, trapped first on PATH: none may be reached by an idle tick.
    for (const n of ['sudo', 'su', 'doas', 'pkexec', 'runas']) fs.writeFileSync(path.join(traps, n), `#!/bin/sh\necho "${n} $*" >> '${trapped}'\nexit 99\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${traps}${path.delimiter}${oldPath}`;
    const engineMark = path.join(box.root, 'engine-started');
    const engine = path.join(box.root, 'engine.mjs');
    fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(engineMark)}, 'started');\nprocess.exit(1);\n`);
    const work = path.join(box.home, 'projects');
    fs.mkdirSync(path.join(work, 'shop'), { recursive: true });
    saveConfig({ usage: false, server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests'), ...(sc.herRights ? { herRights: sc.herRights } : {}) }, assistant: { enabled: true, level: 'handsoff', accounts: ['api'], runsOn: 'api', dailyCapUsd: 5 } });
    writeProfile('api', { label: 'API', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });

    // The level reads as the owner chose, and Off when he chose nothing — never "on when absent".
    assert.equal(herRightsLevel(loadConfig()), sc.expect, `${sc.name}: the administrator-rights level`);

    const before = snapshot(box.root, skip);
    let app = null;
    try {
      app = createServer({ watch: false, dashboardFile: false, assistant: { engine: { command: { command: process.execPath, args: [engine] }, resolveEnv: async () => ({ ...process.env }) } } });
      await app.listen(0, '127.0.0.1');
      await new Promise((r) => setTimeout(r, 1500));
      const auto = app.features.find((f) => f.name === 'automation').automation;
      for (let i = 0; i < 3; i++) await auto.tick();
      await new Promise((r) => setTimeout(r, 500));
      const after = snapshot(box.root, skip);

      assert.deepEqual(changes(before, after), [], `${sc.name}: nothing outside the state folder changed`);
      assert.equal(fs.existsSync(engineMark), false, `${sc.name}: her engine was never started (no model call)`);
      const st = await app.features.find((f) => f.name === 'assistant').ops.listSessions({ computer: 'this' });
      assert.deepEqual(st, [], `${sc.name}: no session was started`);
      assert.equal(fs.existsSync(trapped) ? fs.readFileSync(trapped, 'utf8') : '', '', `${sc.name}: no administrator command ran`);
      // The level still reads as chosen after the server ran (the live reader, not just the file on disk).
      assert.equal(herRightsLevel(loadConfig()), sc.expect, `${sc.name}: the level is unchanged after a start`);
    } finally {
      process.env.PATH = oldPath;
      if (app) await app.close().catch(() => {});
      box.cleanup();
    }
  }

  // After an update: Full chosen under another Hoprig version reads as Ask, so an update never silently keeps her
  // no-card administrator rights — she is held until the owner chooses Full again under the new version.
  const box = sandbox('tia-admin-byitself');
  try {
    saveConfig({ server: { herRights: { level: 'full', version: 'another-version', at: 1 } } });
    assert.equal(herRightsLevel(loadConfig()), 'ask', 'Full under another version reads as Ask after an update');
  } finally {
    box.cleanup();
  }
});
