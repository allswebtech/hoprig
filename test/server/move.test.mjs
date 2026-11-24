// A session moves to another provider, end to end with the REAL launcher and a stand-in Claude Code
// (../automation/fixtures/fake-claude.mjs) that keeps its conversation file the way Claude Code does: from the
// first message on, and `--resume` of a conversation without one ends with "No conversation found with session ID".
//
// The case that failed: a session nobody had typed into yet was moved with `--resume`. Claude Code stopped at once,
// the launcher's menu then said the session "is saved", and choosing a provider there failed the same way. The
// same menu comes after leaving such a session with /exit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmuxUsable } from '../../src/server/backends/index.mjs';
import { sandbox } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'automation', 'fixtures', 'fake-claude.mjs');
const posix = process.platform !== 'win32';

const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
};

test('a session moves to another provider on the built-in pty backend', { timeout: 120_000, skip: !posix && 'the fake Claude wrapper is a POSIX shell script' }, (t) => run(t, 'pty'));
test('a session moves to another provider on tmux', { timeout: 120_000, skip: !tmuxUsable() && 'no tmux 3.2 or newer here' }, (t) => run(t, 'tmux'));

async function run(t, kind) {
  const box = sandbox('move');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'work-')));
  const claudeBin = path.join(box.root, 'fake-claude.sh');
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  const emptyConf = path.join(box.root, 'empty.conf');
  fs.writeFileSync(emptyConf, '');

  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { hasConversation, projectDir } = await import('../../src/sessions.mjs');
  saveConfig({ claudeBin, usage: false, server: { backend: kind, roots: [box.root], passwordHash: await hashPassword('test-password-1') } });
  writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  writeProfile('backup', { label: 'Backup', env: { ANTHROPIC_API_KEY: 'sk-test-not-real-2' } });

  const app = createServer({ tmuxSocket: `move-test-${process.pid}`, tmuxConfigFile: emptyConf, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close().catch(() => {});
    if (kind === 'tmux') {
      const sock = await app.backend.run(['display', '-p', '#{socket_path}']).catch(() => '');
      await app.backend.killServer().catch(() => {});
      if (sock.trim()) fs.rmSync(sock.trim(), { force: true });
    }
    box.cleanup();
  });
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, body) => {
    const r = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
  };
  const screen = async (name) => (await req(`/api/sessions/${name}/history?lines=200`)).json?.text || '';
  // The session as a Claude session that waits on `profile`; an error on the screen ends the wait at once.
  const waitsOn = (name, profile) => until(`the session waiting on ${profile}`, async () => {
    const s = await screen(name);
    assert.ok(!s.includes('No conversation found'), `Claude Code found nothing to resume:\n${s}`);
    const c = (await req('/api/state')).json.sessions.find((x) => x.name === name);
    return c && c.kind === 'claude' && c.status === 'waiting' && c.profile && c.profile.name === profile && c.sessionId ? c : null;
  });
  // What the newest start of Claude Code on the screen was given. Without white space: a terminal may wrap the line.
  const lastStart = (text) => text.replace(/\s+/g, '').split('FAKE-CLAUDEargs=').pop();

  // ---- a new session; nothing is typed into it ----
  const made = await req('/api/sessions', { dir: work, profile: 'work', mode: 'new' });
  assert.equal(made.status, 200, made.text);
  const name = made.json.name;
  const first = await waitsOn(name, 'work');
  const id = first.sessionId;
  assert.equal(first.canSwitch, true, 'the page offers the move as soon as Claude reported its session');
  assert.equal(fs.existsSync(path.join(projectDir(work), `${id}.jsonl`)), false, 'nothing said: no conversation on disk');
  assert.equal(hasConversation(work, id), false);

  // ---- moved before the first message: it starts on the other provider under the same id ----
  assert.equal((await req(`/api/sessions/${name}/switch`, { profile: 'backup' })).status, 200);
  const moved = await waitsOn(name, 'backup');
  assert.equal(moved.sessionId, id, 'the same session');
  const s1 = await until('the new command line', async () => {
    const l = lastStart(await screen(name));
    return l.includes(`"--session-id","${id}"`) ? l : null;
  });
  assert.ok(!s1.includes('--resume'), 'nothing to resume yet');

  // ---- a message is sent: now there is a conversation, and the next move resumes it ----
  assert.equal((await req(`/api/sessions/${name}/send`, { text: 'hello' })).status, 200);
  await until('the reply', async () => (await screen(name)).includes('DONE: hello'));
  assert.equal(hasConversation(work, id), true);
  assert.equal((await req(`/api/sessions/${name}/switch`, { profile: 'work' })).status, 200);
  const back = await waitsOn(name, 'work');
  assert.equal(back.sessionId, id);
  const s2 = await until('the resume command line', async () => {
    const l = lastStart(await screen(name));
    return l.includes(`"--resume","${id}"`) ? l : null;
  });
  assert.ok(!s2.includes('--session-id'));

  // ---- the launcher's own menu after Claude Code ended by a sign-out (a session the person ends with /exit just ends,
  //      with no menu: test/launcher.test.mjs): it does not call a session "saved" that holds nothing ----
  const other = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'other-')));
  const made2 = await req('/api/sessions', { dir: other, profile: 'work', mode: 'new' });
  assert.equal(made2.status, 200, made2.text);
  const name2 = made2.json.name;
  const id2 = (await waitsOn(name2, 'work')).sessionId;
  assert.equal((await req(`/api/sessions/${name2}/send`, { text: '/logout' })).status, 200);
  const menu = await until('the launcher\'s menu', async () => {
    const s = await screen(name2);
    return /on another profile\?/.test(s) ? s : null;
  });
  assert.match(menu, new RegExp(`Nothing was said in session ${id2.slice(0, 8)} yet\\. Start it on another profile\\?`));
  assert.ok(!menu.includes('is saved'));
  // The menu is the launcher's, not the coding tool's: only the owner answers it (the page's message box, owner: true).
  // Text from anyone else is not typed while no coding tool is in front (src/server/typing.mjs).
  const refused = await req(`/api/sessions/${name2}/send`, { text: 'backup' });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.code, 'not_in_front');
  assert.equal((await req(`/api/sessions/${name2}/send`, { text: 'backup', owner: true })).status, 200);
  assert.equal((await waitsOn(name2, 'backup')).sessionId, id2, 'started on the chosen provider, the same session');
  assert.ok(lastStart(await screen(name2)).includes(`"--session-id","${id2}"`));
}
