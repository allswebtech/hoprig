// What the trash does by itself (src/chat/deletes.mjs start: at the dashboard's start, then once a day): with an empty
// trash it reads nothing but its own folder and writes nothing at all. A real dashboard is started on a home with
// projects and conversations, its daily look made to come every 100 ms, and three looks are waited for. Every file
// call made from the trash's code is recorded, and the whole home is compared before and after (content and time).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');

/** Every file and folder under `root`: its content's hash and its time. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = path.relative(root, p);
      const st = fs.lstatSync(p);
      if (e.isDirectory()) {
        out[`${r}/`] = `dir ${st.mtimeMs}`;
        walk(p);
      } else out[r] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

test('the trash\'s look at the start and each day: with an empty trash it reads only its own folder and writes nothing', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('trashquiet');
  const work = path.join(box.root, 'work');
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { projectDir } = await import('../../src/sessions.mjs');
  const { trashDir } = await import('../../src/chat/trash.mjs');
  // A home with three projects, their conversations (one with its own folder), a memory folder and a project file.
  for (const name of ['shop', 'blog', 'alpha']) {
    const cwd = path.join(work, name);
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'main.js'), `// ${name}\n`);
    const dir = projectDir(fs.realpathSync(cwd));
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# notes\n');
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: `${name} work ${i}` } })}\n`);
      if (i === 0) {
        fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
        fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-a1.jsonl'), '{}\n');
      }
    }
  }
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });

  // Every file call the trash's own code makes (deletes.mjs start → trash.mjs recover and purge).
  const calls = [];
  const names = ['readdirSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync', 'openSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'cpSync', 'copyFileSync', 'utimesSync'];
  const had = {};
  for (const n of names) {
    had[n] = fs[n];
    fs[n] = function spied(p, ...rest) {
      const stack = new Error().stack || '';
      if (/src[\\/]chat[\\/]trash\.mjs/.test(stack)) calls.push([n, String(p)]);
      return had[n].call(this, p, ...rest);
    };
  }
  t.after(() => {
    for (const n of names) fs[n] = had[n];
  });

  const before = snapshot(box.root);
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000, purgeEvery: 100 } });
  await app.listen(0, '127.0.0.1');
  try {
    // The start's two looks (what a stopped dashboard left half done, then what is 30 days old), then three ticks.
    const looks = () => calls.filter(([n, p]) => n === 'readdirSync' && p === trashDir()).length;
    const end = Date.now() + 10_000;
    while (looks() < 5 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    assert.ok(looks() >= 5, `the start and three ticks looked at the trash (${looks()} looks)`);
  } finally {
    await app.close();
  }
  for (const n of names) fs[n] = had[n];
  const after = snapshot(box.root);

  const touched = [...new Set(calls.map(([, p]) => p))];
  assert.deepEqual(touched, [trashDir()], 'it read only its own folder');
  assert.deepEqual([...new Set(calls.map(([n]) => n))], ['readdirSync'], 'and only listed it: nothing written, moved or removed');
  assert.equal(fs.existsSync(trashDir()), false, 'an empty trash is not even made');
  const diff = changed(before, after);
  const conv = path.relative(box.root, path.join(box.claude, 'projects'));
  assert.deepEqual(diff.filter((k) => k.startsWith(conv) || k.startsWith('work')), [], 'no conversation, folder or project file changed (content or time)');
  t.diagnostic(`what the dashboard itself wrote meanwhile (not the trash): ${diff.join(', ') || 'nothing'}`);
});
