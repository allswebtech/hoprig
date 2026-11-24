// A chat (the App) in `shop` (chat/run.mjs chatExtras): its need kits/parts and the names "Also open" chose reach its
// Claude Code as additional directories with the deny rules, in the settings file Hoprig hands it; the start note is
// one line in the chat; a need not here is named and nothing is fetched; another coding tool gets none and is told.
// Against the stand-in Claude Code of the chat tests, which writes down its arguments.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { needsWorld } from './needsfix.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'chat', 'fixtures', 'fake-claude.mjs');
const POSIX = process.platform === 'win32' ? 'the hook command is written for a POSIX shell here' : false;

test('a chat in shop: its need and "Also open" as read-only extra folders, the note said once', { skip: POSIX }, async () => {
  const w = needsWorld('needs-chat', { shopNeeds: ['kits/parts', 'docs'] });
  process.env.HOPRIG_WORKSPACE_DIR = w.ws;
  const { Chat } = await import('../../src/chat/chat.mjs');
  const argsFile = path.join(w.root, 'args.log');
  const c = new Chat({
    id: crypto.randomUUID(), cwd: fs.realpathSync(w.shop), profile: 'p', withs: ['blog'],
    command: { command: process.execPath, args: [FAKE] }, engineOpts: { version: '2.1.326' },
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }),
  });
  try {
    const done = new Promise((r) => c.once('turn', r));
    await c.send('hello');
    await done;
    const argv = fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find(Array.isArray);
    const s = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
    const parts = fs.realpathSync(w.parts);
    const blog = fs.realpathSync(path.join(w.projects, 'blog'));
    assert.deepEqual(s.permissions.additionalDirectories, [parts, blog]);
    for (const r of [`Write(/${parts}/**)`, `Edit(/${blog}/**)`, `Read(/${parts}/ai-ignore-dir/**)`, `Read(/${parts}/.env)`]) assert.ok(s.permissions.deny.includes(r), r);
    assert.ok(s.hooks && s.hooks.PermissionRequest, 'the hook is still there');
    assert.ok(!JSON.stringify(s).includes('Bash(rm'), 'no allow rule of the need');
    const notes = c.events.filter((e) => e.kind === 'notice').map((e) => e.text);
    assert.equal(notes.filter((t) => /extra folders to read \(its file tools cannot write there; a shell command still could\): kits\/parts, blog/.test(t)).length, 1);
    assert.ok(notes.some((t) => /hoprig get docs/.test(t)));
    assert.deepEqual(c.extras, ['kits/parts', 'blog']);
    assert.deepEqual(c.record().withs, ['blog'], 'kept with the chat, never in project.json');
    assert.ok(!fs.existsSync(path.join(w.projects, 'docs')), 'nothing fetched');
    // A second start says nothing new.
    await c.stopAndWait();
    const again = new Promise((r) => c.once('turn', r));
    await c.send('again');
    await again;
    assert.equal(c.events.filter((e) => e.kind === 'notice' && /extra folders/.test(e.text)).length, 1);
  } finally {
    await c.stopAndWait();
    w.cleanup();
  }
});

test('an App start walks each extra folder once, and hands the result to its settings', { skip: POSIX }, async () => {
  const w = needsWorld('needs-chat-once', { shopNeeds: ['kits/parts'] });
  process.env.HOPRIG_WORKSPACE_DIR = w.ws;
  const { Chat } = await import('../../src/chat/chat.mjs');
  const argsFile = path.join(w.root, 'args.log');
  const parts = fs.realpathSync(w.parts);
  const had = fs.opendirSync;
  const walked = [];
  fs.opendirSync = function (p, ...r) { walked.push(String(p)); return had.call(this, p, ...r); };
  const c = new Chat({
    id: crypto.randomUUID(), cwd: fs.realpathSync(w.shop), profile: 'p',
    command: { command: process.execPath, args: [FAKE] }, engineOpts: { version: '2.1.326' },
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }),
  });
  try {
    const done = new Promise((r) => c.once('turn', r));
    await c.send('hello');
    await done;
    assert.deepEqual(c.extras, ['kits/parts'], 'opened');
    assert.equal(walked.filter((p) => p === parts).length, 1, `the need's folder was walked once at this start (${walked.filter((p) => p === parts).length})`);
  } finally {
    fs.opendirSync = had;
    await c.stopAndWait();
    delete process.env.HOPRIG_WORKSPACE_DIR;
    w.cleanup();
  }
});
