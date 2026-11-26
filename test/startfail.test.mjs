// A coding tool that ends at its start is said on its card, for every user: never a quiet shell.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-startfail-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HOPRIG_PROFILES_DIR;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { binFile, runsDir } = await import('../src/paths.mjs');
const P = await import('../src/profiles.mjs');
const F = await import('../src/startfail.mjs');
const { Deck } = await import('../src/server/deck.mjs');

// The words Claude Code 2.1.329 prints as root for bypass permissions mode (seen on a real server and as user id 0).
const REFUSAL = '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons';
const TERM = 'pty-aaaaaaaaaaaa';

function launchWith(body, { termId = TERM, args = [] } = {}) {
  // No extension: a #!/usr/bin/env node file the test seal starts with Node on Windows too, as the system does here.
  const fake = path.join(tmp, `fake-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(fake, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json'), JSON.stringify({ claudeBin: fake }));
  P.writeProfile('api', { env: { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_AUTH_TOKEN: 'tok' } });
  const env = { ...process.env, HOPRIG_TERM_ID: termId || '' };
  if (!termId) delete env.HOPRIG_TERM_ID;
  return spawnSync(process.execPath, [binFile(), 'api', ...args], { env, encoding: 'utf8', cwd: tmp });
}
const notes = () => F.startFailures();
const clear = () => notes().forEach(F.dropStartFailure);

test('a stand-in that prints a line and exits 1 at once: noted for its terminal, and the launcher says it under the tool\'s words', () => {
  clear();
  const r = launchWith(`console.error(${JSON.stringify(REFUSAL)}); process.exit(1);`, { args: ['--permission-mode', 'bypassPermissions'] });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`${REFUSAL}\nhoprig: Claude Code ended at its start (exit code 1).\n`), r.stderr);
  const [n, ...more] = notes();
  assert.equal(more.length, 0);
  assert.deepEqual([n.code, n.tool, n.termId, n.profile], [1, 'claude', TERM, 'api']);
  if (process.platform !== 'win32') assert.equal((fs.statSync(n.file).mode & 0o777).toString(8), '600');
  assert.deepEqual(fs.readdirSync(runsDir()).filter((f) => f.endsWith('.json')), [], 'the run record went as before');
});

test('no note for an end that is no failure: exit 0, a terminal the dashboard does not hold', () => {
  clear();
  assert.equal(launchWith('process.exit(0);').status, 0);
  assert.equal(launchWith('console.error("bad"); process.exit(1);', { termId: null }).status, 1);
  assert.deepEqual(notes(), []);
});

test('an end after the first seconds is not an end at the start', () => {
  assert.equal(F.endedAtStart({ code: 1, ms: 300 }), true);
  assert.equal(F.endedAtStart({ code: 1, ms: F.EARLY_MS }), false);
  assert.equal(F.endedAtStart({ code: 0, ms: 10 }), false);
  assert.equal(F.endedAtStart({ code: 143, ms: 10, signalled: true }), false, 'the terminal was closed');
  assert.equal(F.endedAtStart({ code: 1, ms: 10, moved: true }), false, 'Hoprig stopped it for a move');
});

test('the reason: what the tool printed last, from the screen, cleaned and bounded', () => {
  const screen = [
    'root@box2:~/projects/shop# hoprig api --permission-mode bypassPermissions',
    'hoprig: profile sub · Claude account (stored login)',
    `\x1b[31m${REFUSAL}\x1b[0m`,
    F.endedLine('claude', 1),
    'root@box2:~/projects/shop# ',
  ].join('\n');
  assert.equal(F.reasonFrom(screen), REFUSAL);
  // Several lines are joined; a secret is masked; a long text keeps its end, at most 300 characters.
  assert.equal(F.reasonFrom(`hoprig: profile api · Key\nError: bad key sk-ant-abcdefghijklmnop\nTry again\n${F.endedLine('claude', 2)}\n$ `), 'Error: bad key *** · Try again');
  const long = F.reasonFrom(`${'x'.repeat(400)} the end\n${F.endedLine('opencode', 1)}`);
  assert.equal(long.length, F.REASON_MAX);
  assert.ok(long.startsWith('…') && long.endsWith('the end'));
  assert.equal(F.reasonFrom('nothing of ours here\n$ '), '', 'no line of the launcher: no reason read');
});

test('the card: a terminal back at its shell after a failed start reads "failed", with the reason, never a quiet shell', async () => {
  clear();
  const r = launchWith(`console.error(${JSON.stringify(REFUSAL)}); process.exit(1);`);
  assert.equal(r.status, 1);
  const screen = `hoprig: profile api · Key\n${REFUSAL}\n${F.endedLine('claude', 1)}\nroot@box2:~# `;
  const terms = [{ id: TERM, session: 'shop', pid: process.pid, cwd: tmp, attached: false, created: Date.now() - 60_000, activity: 1, command: 'bash', active: true }];
  const deck = new Deck({ backend: { list: async () => terms.slice(), capture: async () => screen }, config: () => ({}), profiles: () => [P.readProfile('api')], now: () => Date.now() });
  const [card] = await deck.list();
  assert.equal(card.status, 'failed');
  assert.equal(card.note, REFUSAL);
  assert.deepEqual(card.startFailed, { code: 1, tool: 'claude' });
  assert.equal(card.failure.text, REFUSAL);
  assert.equal(card.profile.name, 'api');
  assert.equal(JSON.stringify(card).includes('tok'), false, 'no value of the provider');
  // A browser attached and the pane grew (or the screen was cleared): the words are not in the capture any more, and
  // the card still says them.
  const tall = new Deck({ backend: { list: async () => terms.slice(), capture: async () => '\n'.repeat(60) + 'root@box2:~# ' }, config: () => ({}), profiles: () => [], now: () => Date.now() });
  assert.equal((await tall.list())[0].note, REFUSAL);
  // Started again in the same terminal: a record written since ends the note.
  const later = Date.now() + 5;
  fs.writeFileSync(path.join(runsDir(), 'zz-again.json'), JSON.stringify({ runId: 'zz-again', pid: process.pid, proc: null, profile: 'api', cwd: tmp, termId: TERM, status: 'starting', startedAt: later, statusAt: later }));
  const [again] = await deck.list();
  assert.notEqual(again.status, 'failed');
  assert.deepEqual(notes(), []);
  fs.rmSync(path.join(runsDir(), 'zz-again.json'), { force: true });
});

test('a terminal that is gone takes its note with it', async () => {
  clear();
  launchWith('process.exit(3);');
  assert.equal(notes().length, 1);
  const deck = new Deck({ backend: { list: async () => [], capture: async () => '' }, config: () => ({}), profiles: () => [], now: () => Date.now() });
  await deck.list();
  assert.deepEqual(notes(), []);
});
