// tmux's prefix key in the browser's terminal (src/server/backends/tmuxprefix.mjs): a Ctrl+B typed there reaches the
// program, as it does in a plain terminal, instead of starting a tmux command.
import assert from 'node:assert/strict';
import test from 'node:test';
import { controlByte, prefixBytes, prefixDoubler } from '../../src/server/backends/tmuxprefix.mjs';

const KEYS = 'bind-key    -T prefix C-b     send-prefix\nbind-key    -T prefix x       confirm-before -p "kill-pane #P? (y/n)" kill-pane\n';

test('the byte of a prefix key name', () => {
  assert.equal(controlByte('C-b'), '\x02');
  assert.equal(controlByte('C-a'), '\x01');
  assert.equal(controlByte('C-Space'), '\x00');
  assert.equal(controlByte('C-_'), '\x1f');
  for (const n of ['None', 'M-a', 'b', '', null]) assert.equal(controlByte(n), null, String(n));
});

test('only a prefix bound to send-prefix is doubled, and never Escape', () => {
  assert.deepEqual(prefixBytes({ prefix: 'C-b', prefix2: 'None', keys: KEYS }), ['\x02']);
  assert.deepEqual(prefixBytes({ prefix: 'C-a', prefix2: 'None', keys: KEYS }), [], 'C-a has no send-prefix: doubling it would not give one back');
  assert.deepEqual(prefixBytes({ prefix: 'C-a', prefix2: 'C-b', keys: 'bind-key -T prefix C-a send-prefix\nbind-key -T prefix C-b send-prefix -2\n' }), ['\x01', '\x02']);
  assert.deepEqual(prefixBytes({ prefix: 'C-[', prefix2: 'None', keys: 'bind-key -T prefix C-[ send-prefix\n' }), []);
});

test('the prefix byte is doubled when typed, left as it is inside a bracketed paste (also across two writes)', () => {
  const f = prefixDoubler(['\x02']);
  assert.equal(f('\x02'), '\x02\x02');
  assert.equal(f('a\x02b'), 'a\x02\x02b');
  assert.equal(f('\x1b[200~p\x02'), '\x1b[200~p\x02', 'tmux passes a paste on as it is');
  assert.equal(f('q\x1b[20'), 'q\x1b[20');
  assert.equal(f('1~\x02'), '1~\x02\x02', 'the paste ended in the write before');
  assert.equal(prefixDoubler([])('\x02'), '\x02');
});

test('a prefix byte right after an Escape is Ctrl+Alt with the key, not a prefix: it goes once (also across two writes)', () => {
  const f = prefixDoubler(['\x02']);
  assert.equal(f('\x1b\x02'), '\x1b\x02', 'Ctrl+Alt+B: doubled, its second byte would be a lone prefix');
  assert.equal(f('x'), 'x');
  assert.equal(f('\x1b\x1b\x02'), '\x1b\x1b\x02\x02', 'two Escapes are one key (M-Escape): the byte after them is a prefix');
  assert.equal(f('\x1b\x1b\x1b\x02'), '\x1b\x1b\x1b\x02', 'the third joins it');
  assert.equal(f('\x1b[A\x02'), '\x1b[A\x02\x02', 'after a whole key the byte is a prefix again');
  let t = 0;
  const g = prefixDoubler(['\x02'], { joinMs: 10, now: () => t });
  assert.equal(g('\x1b'), '\x1b');
  t = 5;
  assert.equal(g('\x02'), '\x02', 'within tmux\'s escape-time the two writes are one key');
  assert.equal(g('\x1b'), '\x1b');
  t = 100;
  assert.equal(g('\x02'), '\x02\x02', 'later tmux took the Escape alone: this one is a prefix');
});

test('a paste of megabytes goes through the doubler in one write without holding the dashboard up', () => {
  // The terminal socket hands a held paste over in one write (src/server/terminal.mjs), and every other terminal
  // and request of the dashboard waits while it is filtered: one character at a time, the cap of 4 Mi took 500 ms.
  const f = prefixDoubler(['\x02'], { joinMs: 10 });
  const body = `${'A'.repeat(1 << 20)}\x02${'B'.repeat(3 << 20)}`;
  const paste = `\x1b[200~${body}\x1b[201~`;
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    assert.equal(f(paste), paste, 'inside a paste nothing is doubled');
    best = Math.min(best, performance.now() - t);
  }
  assert.ok(best < 250, `4 Mi of paste took ${best.toFixed(0)} ms`);
  assert.equal(f(`x\x02${'y'.repeat(1 << 20)}\x02`), `x\x02\x02${'y'.repeat(1 << 20)}\x02\x02`, 'outside a paste every prefix byte still goes twice');
});

test('a paste dense with prefix bytes goes straight to its end mark: nothing in it is looked at one byte at a time', () => {
  // Going from one prefix byte to the next inside a paste took 100-300 ms for 1 Mi of Ctrl+B, while the dashboard waited.
  for (const body of ['\x02'.repeat(1 << 20), 'a\x02'.repeat(1 << 19)]) {
    const paste = `\x1b[200~${body}\x1b[201~`;
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const f = prefixDoubler(['\x02'], { joinMs: 10 });
      const t = performance.now();
      const out = f(`k\x02${paste}\x02`);
      best = Math.min(best, performance.now() - t);
      assert.ok(out === `k\x02\x02${paste}\x02\x02`, 'typed prefix bytes twice, the paste as it is');
    }
    assert.ok(best < 40, `1 Mi of paste with prefix bytes took ${best.toFixed(0)} ms`);
  }
  // The end mark split across writes, at every place: found, and a prefix byte after it is doubled again.
  for (let cut = 1; cut < 6; cut++) {
    const f = prefixDoubler(['\x02']);
    const text = '\x1b[200~\x02\x02\x1b[201~';
    const parts = [text.slice(0, text.length - cut), text.slice(text.length - cut), '\x02'];
    assert.deepEqual(parts.map(f), [...parts.slice(0, 2), '\x02\x02'], `end mark cut ${cut} from its end`);
  }
});
