// Whether this computer's sudo asks for a password, as the administrator-rights route reads it: through the same
// reader set-up uses (sysFacts and sudoNeedsPassword), with a stand-in sudo first on PATH through the suite's seal, so
// the real sudo is never reached. No variable of a test's environment decides it, and turning Full on asks sudo again,
// so a change of the computer's sudo rules after the dashboard started is seen at that moment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealedPath } from '../seal.mjs';

const POSIX = process.platform !== 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tia-herrights-sudo-'));
const bin = path.join(tmp, 'bin');
const answer = path.join(tmp, 'answer'); // "open": sudo -n runs with no password; anything else: it asks for one
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(answer, 'open');
// The stand-in sudo: only `sudo -n true` is asked here; it answers from the file, so the test can change the rules.
fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
if [ "$1" = "-n" ] && [ "$(cat "${answer}")" = "open" ]; then exit 0; fi
echo "sudo: a password is required" >&2
exit 1
`, { mode: 0o755 });
process.env.PATH = sealedPath(`${bin}${path.delimiter}${process.env.PATH}`);
const { herRightsFeature } = await import('../../src/server/herrights.mjs');
const { fullConfirmSentence, herRightsLevel } = await import('../../src/assistant/herrights.mjs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function fakeCtx(cfg) {
  let c = structuredClone(cfg);
  return {
    config: () => c,
    saveConfig: (patch) => { c = { ...c, server: { ...(c.server || {}), ...(patch.server || {}) } }; },
    caller: () => 'page',
    readJson: async (req) => req,
    HttpError,
  };
}
const routes = (ctx) => {
  const f = herRightsFeature(ctx, { version: 'test-1' });
  return { get: f.routes.find(([m]) => m === 'GET')[2], post: f.routes.find(([m]) => m === 'POST')[2] };
};

test('no variable of the environment decides what the route says of sudo: the reader asks the computer\'s sudo', { skip: !POSIX && 'the stand-in sudo is a shell script' }, async () => {
  fs.writeFileSync(answer, 'password');
  const prev = process.env.HOPRIG_TEST_SUDO;
  process.env.HOPRIG_TEST_SUDO = 'nopassword';
  try {
    const r = await routes(fakeCtx({ server: {} })).get();
    assert.equal(r.sudoPresent, true);
    assert.equal(r.needsPassword, true, 'the stand-in sudo asks for a password, whatever the variable says');
    assert.equal(r.fullOffered, false);
  } finally {
    if (prev === undefined) delete process.env.HOPRIG_TEST_SUDO;
    else process.env.HOPRIG_TEST_SUDO = prev;
  }
});

test('turning Full on asks sudo again: a password rule added after the page was read refuses Full', { skip: !POSIX && 'the stand-in sudo is a shell script' }, async () => {
  fs.writeFileSync(answer, 'open');
  const ctx = fakeCtx({ server: {} });
  const { get, post } = routes(ctx);
  assert.equal((await get()).fullOffered, true, 'sudo asks nothing: Full is offered');
  // The computer's sudo rules change while the dashboard runs: sudo now asks for a password.
  fs.writeFileSync(answer, 'password');
  await assert.rejects(() => post({ level: 'full', confirm: fullConfirmSentence('this computer') }), (e) => e.status === 400 && /needs no password/i.test(e.message));
  assert.equal(herRightsLevel(ctx.config(), 'test-1'), 'off', 'the level stayed off');
  assert.equal((await get()).needsPassword, true, 'the page reads the fresh answer from then on');
  // And the other way: sudo stops asking, and Full may be turned on.
  fs.writeFileSync(answer, 'open');
  assert.deepEqual(await post({ level: 'full', confirm: fullConfirmSentence('this computer') }), { level: 'full' });
});
