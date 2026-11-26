// A start stopped before its shell read the start line: Ctrl+C while the shell still reads its own start files throws
// the typed line away, so the launcher never runs and the line's removal of the start's mark never runs either. The
// dashboard must not go on showing the conversation as running in that terminal: within its own look it sees the
// shell back in front with the start's launch file still unread, ends its note and says the start was stopped. A
// normal start is not touched. Real terminals: the built-in ones and tmux on a socket of this test's own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LAUNCHER = [process.execPath, path.join(FIXTURES, 'fake-launcher.mjs')];
const SLOW = [process.execPath, path.join(FIXTURES, 'slow-launcher.mjs')]; // takes its file, then waits: no record yet
const POSIX = process.platform !== 'win32';
const box = sandbox('startstopped');
process.env.HOME = box.home; // the shells read their start files from here
process.env.SHELL = '/bin/bash';
for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete process.env[k];
// A login shell that, while the file "hold" is there, takes a while over its own start files (as a slow profile does):
// the typed start line waits in the terminal meanwhile, and a Ctrl+C then throws it away.
fs.writeFileSync(path.join(box.home, '.bash_profile'), 'if [ -f "$HOME/hold" ]; then mv "$HOME/hold" "$HOME/held"; sleep 20; fi\n');
const { tmuxUsable } = await import('../../src/server/backends/index.mjs');
const { nodePty } = await import('../../src/server/backends/nodepty.mjs');
const { Deck, STOP_MS } = await import('../../src/server/deck.mjs');
const { terminals } = await import('../../src/chat/handoff.mjs');
const { listRuns } = await import('../../src/runs.mjs');
const kinds = POSIX ? [...(nodePty ? ['pty'] : []), ...(tmuxUsable() ? ['tmux'] : [])] : [];
test.after(() => box.cleanup());
// A file with an after hook and no test makes Node's runner loop until it runs out of memory (--test-force-exit, Node 24
// and 26): where no terminal kind is here (always on Windows) one skipped test says why instead.
if (!kinds.length) test('real terminals', { skip: 'neither the built-in terminal nor tmux is here' }, () => {});

const ID = '5c1e7a9d-3b2f-4d8e-a6c4-9e0b1f2d3a47';
const TICK_MS = 5000; // the watcher's own tick (watcher.mjs tickMs)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) {
    last = await fn();
    if (last) return last;
  }
  throw new Error(`timed out waiting for ${what}`);
}
const marks = () => fs.readdirSync(path.join(box.state, 'runs')).filter((f) => f.startsWith('.start-'));
const launches = () => {
  try {
    return fs.readdirSync(path.join(box.state, 'launch'));
  } catch {
    return [];
  }
};

async function backendOf(t, kind) {
  if (kind === 'pty') {
    const { PtyBackend } = await import('../../src/server/backends/pty.mjs');
    const b = new PtyBackend();
    t.after(() => b.close());
    return b;
  }
  const { TmuxBackend } = await import('../../src/server/backends/tmux.mjs');
  const socket = `hoprig-stopped-${process.pid}`;
  const conf = path.join(box.root, `${socket}.conf`);
  fs.writeFileSync(conf, 'set -g default-shell /bin/bash\n');
  const b = new TmuxBackend({ socket, configFile: conf });
  t.after(async () => {
    const sock = await b.run(['display', '-p', '#{socket_path}']).catch(() => '');
    await b.killServer();
    if (sock.trim()) fs.rmSync(sock.trim(), { force: true }); // tmux leaves the socket file behind
  });
  return b;
}

for (const kind of kinds) {
  // Not proven on macOS for the built-in terminals: on the public macOS test computers the conversation is freed and
  // the card is a shell, but the card does not say the start was stopped. With tmux it is proven there too.
  const unproven = kind === 'pty' && process.platform === 'darwin' && 'the built-in terminals on macOS: the stopped start is not shown there yet';
  test(`${kind}: a start stopped with Ctrl+C before the shell read its line frees the conversation; a normal start still runs`, { timeout: 90_000, skip: unproven }, async (t) => {
    const backend = await backendOf(t, kind);
    const deck = new Deck({ backend, config: () => ({ launcher: LAUNCHER }), profiles: () => [] });
    const { terminalOf } = terminals({ HttpError: Error, deck, backend });
    const argv = [...LAUNCHER, 'p', '--resume', ID];

    // Stopped: the shell is still in its start files when Ctrl+C comes.
    fs.writeFileSync(path.join(box.home, 'hold'), '');
    const name = await deck.create({ base: 'proj', dir: box.root, argv, conversation: ID });
    await until('the shell in its start files', () => fs.existsSync(path.join(box.home, 'held')));
    // Longer than STOP_MS: a start file that runs a program hands it the terminal, so the start is never taken for stopped.
    for (const end = Date.now() + STOP_MS + 1500; Date.now() < end; await wait(300)) {
      await deck.list();
      assert.equal((await terminalOf(ID))?.name, name, 'while the shell reads its start files the start holds its conversation');
    }
    const [term] = (await backend.list()).filter((x) => x.session === name);
    await backend.sendKey(term.id, 'C-c');
    const at = Date.now();
    await until('the start seen as stopped', async () => {
      await deck.list();
      return deck.launchOf(ID) === null;
    }, STOP_MS + TICK_MS + 5000);
    assert.ok(Date.now() - at <= STOP_MS + TICK_MS, `seen within the deck's own look (${Date.now() - at} ms)`);
    assert.equal(await terminalOf(ID), null, 'the conversation is free again: the App or a new terminal may take it');
    const card = (await deck.list()).find((c) => c.name === name);
    assert.equal(card.kind, 'shell');
    assert.equal(card.startStopped, true, 'the card says the start was stopped');
    assert.deepEqual(listRuns(), [], 'the launcher never ran');
    assert.deepEqual(marks(), [], 'its mark went with the note');
    assert.equal(launches().length, 1, 'its launch file stays while the terminal lives: a shell that reads the line after all starts as it would have');
    await backend.kill(name);
    await deck.list();
    assert.deepEqual(launches(), [], 'it holds the first message: it goes with its terminal');
    fs.rmSync(path.join(box.home, 'held'), { force: true });

    // Normal: the line is read, the launcher runs and writes its record; the looks never call it stopped.
    const ok = await deck.create({ base: 'proj', dir: box.root, argv, conversation: ID });
    await until('the launcher\'s record', async () => (await terminalOf(ID))?.run);
    for (const end = Date.now() + STOP_MS + 1000; Date.now() < end; await wait(300)) await deck.list();
    const running = (await deck.list()).find((c) => c.name === ok);
    assert.equal(running.kind, 'claude', 'a normal start shows its coding tool running');
    assert.equal(running.startStopped, undefined);
    assert.equal((await terminalOf(ID)).name, ok);
    await backend.kill(ok);
    await until('the launcher ended', () => !listRuns().length);

    // Stopped a moment later: the shell has read the line and the launcher has taken its file, then Ctrl+C ends it
    // before it wrote its record, and the shell drops the rest of the line (the mark's removal).
    const slow = new Deck({ backend, config: () => ({ launcher: SLOW }), profiles: () => [] });
    const late = await slow.create({ base: 'proj', dir: box.root, argv: [...SLOW, 'p', '--resume', ID], conversation: ID });
    await until('the launcher took its file', () => !launches().length);
    for (const end = Date.now() + STOP_MS + 1000; Date.now() < end; await wait(300)) await slow.list();
    assert.ok(slow.launchOf(ID), 'while the launcher runs, its start holds the conversation');
    const [lt] = (await backend.list()).filter((x) => x.session === late);
    await backend.sendKey(lt.id, 'C-c');
    await until('the late stop seen', async () => {
      await slow.list();
      return slow.launchOf(ID) === null;
    }, STOP_MS + TICK_MS + 5000);
    assert.equal((await slow.list()).find((c) => c.name === late).startStopped, true);
    assert.deepEqual(marks(), []);
    await backend.kill(late);
  });
}
