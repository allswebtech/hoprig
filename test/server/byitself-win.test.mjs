// After an update, nothing new of this part runs by itself: a real start of an isolated dashboard and three upkeep
// ticks start none of the programs it added (reg, whoami, taskkill, powershell, pymanager), make no call of its modules
// that writes, and change nothing in the home, also where Claude Code's own settings name a gateway (the press is the
// owner's, never the dashboard's). Written so that it runs on Windows too: the stand-in coding tool is node itself.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempWork } from '../work/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'automation', 'fixtures', 'fake-claude.mjs');
const OURS = /src[\\/](setup[\\/]winpath|server[\\/]takeover|codetools[\\/]ownsettings|server[\\/]service[\\/]windows)\.mjs/;
const PROGRAMS = /^(reg|whoami|taskkill|schtasks|powershell|pymanager|py)(\.exe)?$/i;
const WRITES = /^(writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|symlinkSync)$/;

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function watch() {
  const seen = { programs: [], writes: [] };
  const origCp = {};
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    origCp[k] = childProcess[k];
    childProcess[k] = function (file, args, ...rest) {
      const name = path.basename(String(file));
      if (PROGRAMS.test(name) || OURS.test(new Error().stack)) seen.programs.push([file, ...(Array.isArray(args) ? args : [])].join(' '));
      return origCp[k].call(this, file, args, ...rest);
    };
  }
  const origFs = {};
  for (const k of Object.keys(fs).filter((n) => WRITES.test(n))) {
    origFs[k] = fs[k];
    const w = function (p, ...rest) {
      if (OURS.test(new Error().stack)) seen.writes.push(`${k} ${p}`);
      return origFs[k].call(this, p, ...rest);
    };
    fs[k] = w;
  }
  syncBuiltinESMExports();
  seen.stop = () => {
    Object.assign(childProcess, origCp);
    Object.assign(fs, origFs);
    syncBuiltinESMExports();
  };
  return seen;
}

test('a start and three upkeep ticks: none of this part\'s programs, no write of its modules, the home unchanged', { timeout: 90_000 }, async (t) => {
  const w = tempWork('win-byitself');
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root));
  process.env.USERPROFILE = w.home;
  const claudeDir = process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8279', ANTHROPIC_AUTH_TOKEN: 'sk-gw-' + 'x'.repeat(30) } }, null, 2)}\n`);
  fs.mkdirSync(path.join(w.projects, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(w.projects, 'shop', '.env.example'), 'KEY=\n');
  fs.writeFileSync(path.join(w.projects, 'shop', '.env.local'), 'KEY=mine\n');
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  // The stand-in coding tool: node with the fixture, named as a program on every system.
  saveConfig({ claudeBin: process.execPath, claudeArgs: [FAKE_CLAUDE], usage: false, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') } });
  const before = snapshot(w.root);
  const seen = watch();
  let app = null;
  t.after(async () => {
    seen.stop();
    if (app) await app.close().catch(() => {});
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `win-byitself-${process.pid}` });
  await app.listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const auto = app.features.find((f) => f.name === 'automation').automation;
  for (let i = 0; i < 3; i++) await auto.tick();
  await new Promise((r) => setTimeout(r, 500));
  const programs = [...seen.programs];
  const writes = [...seen.writes];
  seen.stop();
  assert.deepEqual(programs, [], 'no reg, whoami, taskkill, schtasks, powershell or pymanager, nothing from this part\'s modules');
  assert.deepEqual(writes, [], 'no write from this part\'s modules');
  const after = snapshot(w.root);
  const inHome = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k.startsWith('home/') && a[k] !== b[k]).sort();
  assert.deepEqual(inHome(before, after), [], 'nothing in the home changed: the settings file, no backup, no .env');
});
