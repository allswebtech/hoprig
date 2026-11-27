// Her process is gone 10 minutes after the last turn of a conversation (here: a few milliseconds, the time is a setting
// of the test), and the next message starts it again with --resume: 33 idle processes were measured holding 6.4 GB.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Engine, IDLE_MS } from '../../src/assistant/engine.mjs';

function fakeSpawn(record) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    record.push({ cmd, args, opts, child, killed: false });
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      record.find((r) => r.child === child).killed = true;
      setImmediate(() => child.emit('exit', 0));
    };
    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }) + '\n');
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (line) => {
      const text = JSON.parse(line).message.content[0].text;
      child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: `echo: ${text}`, session_id: 'sess-1', total_cost_usd: 0.001 }) + '\n');
    });
    return child;
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = (dir, record, idleMs) => new Engine({ profile: 'api', systemPrompt: 'P', url: 'http://127.0.0.1:1', tokenFile: '/s/token', conversation: 'c1', dir, idleMs, spawnImpl: fakeSpawn(record), resolveEnv: async () => ({}), command: { command: 'fake-claude', args: [] } });

test('the idle time is ten minutes', () => {
  assert.equal(IDLE_MS, 10 * 60_000);
});

test('her process ends after the idle time and the next message resumes the same conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-idle-'));
  try {
    const record = [];
    const e = engine(dir, record, 60);
    assert.equal((await e.send('one')).done.text, 'echo: one');
    assert.equal(record.length, 1);
    assert.equal(record[0].killed, false, 'alive right after the turn');
    await wait(250);
    assert.equal(record[0].killed, true, 'gone after the idle time');
    assert.equal(e.child, null);
    assert.equal((await e.send('two')).done.text, 'echo: two');
    assert.equal(record.length, 2, 'started again');
    assert.equal(record[1].args[record[1].args.indexOf('--resume') + 1], 'sess-1', 'the same conversation');
    e.cleanup();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a message inside the idle time keeps the process, and a turn that runs is never cut', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-idle-'));
  try {
    const record = [];
    const e = engine(dir, record, 150);
    await e.send('one');
    await wait(90);
    await e.send('two');
    await wait(90);
    assert.equal(record[0].killed, false, 'the second message started the time again');
    assert.equal(record.length, 1, 'one process');
    await wait(300);
    assert.equal(record[0].killed, true);
    e.cleanup();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
