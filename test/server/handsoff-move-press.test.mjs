// The owner's switch pressed WHILE a move is still in flight (src/server/handsoff.mjs session route). During a move
// the terminal's run id is changing: for a moment `deck.find` may still return the OLD run (its record lingers) before
// the new launcher's record is in place. If the route writes the switch against the run as it is at that instant, it
// lands on the old id that is going away — and when the move carried no Hands-off state (#handOver returns null for a
// session with no own switch and no stops, so no forward old→new is set up) the new run inherits nothing and keeps
// following the project switch, losing the owner's press. The route must wait for the move to settle and write the run
// that remains. This plays the real order a coding-tool run showed (the press resolving to the old id mid-move), which
// a stand-in move in a full server cannot time deterministically.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered): a test that switches it on or reads its
// answer gets 409 or nothing there.
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };

const box = sandbox('movepress');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { handsOffFeature } = await import('../../src/server/handsoff.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { runsDir } = await import('../../src/paths.mjs');
const V = hoprigVersion();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const OLD = 'old00000-1-aaaabbbb';
const NEW = 'new11111-1-ccccdddd';
const writeRecord = (id) => {
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(path.join(runsDir(), `${id}.json`), JSON.stringify({ runId: id, cwd: box.home, profile: 'api', tool: 'claude', sessionId: 'conv-1', status: 'working' }));
};
const sessionRoute = (deck) => {
  const ctx = { HttpError, config: () => loadConfig(), saveConfig, readJson: async () => ({ name: 'shop', on: false }), deck, poke: () => {} };
  const { routes } = handsOffFeature(ctx, { version: V });
  return routes.find(([m, re]) => m === 'POST' && re.test('/api/handsoff/session'))[2];
};
const sessionsNow = () => (loadConfig().handsOff || {}).sessions || {};

test('a switch pressed while the move is still in flight reaches the NEW run, never the old id that is going away', OFFERED, async () => {
  saveConfig({ handsOff: { offered: true } });
  writeRecord(OLD);
  writeRecord(NEW);
  // The move is in flight: the first find returns the OLD run (its record still there), the term moving; after one poll
  // the move has settled and find returns the NEW run. forwardOf gives nothing (a move with no Hands-off carry).
  let finds = 0;
  const deck = {
    find: async (name) => {
      finds += 1;
      if (name !== 'shop') return null;
      return finds >= 2 ? { term: { id: 'T1' }, run: { runId: NEW } } : { term: { id: 'T1' }, run: { runId: OLD } };
    },
    movingTerm: (id) => id === 'T1' && finds < 2,
    forwardOf: () => undefined,
    handedOver: () => false,
  };
  const r = await sessionRoute(deck)({});
  assert.deepEqual(r, { on: false });
  const sessions = sessionsNow();
  assert.equal(sessions[NEW] && sessions[NEW].on, false, 'the new run carries the owner\'s Off');
  assert.equal(sessions[OLD], undefined, 'nothing is written under the old id that is going away');
});

test('with no move in flight the press writes the current run at once (no wait, no regression)', OFFERED, async () => {
  saveConfig({ handsOff: { offered: true, sessions: {} } });
  writeRecord(NEW);
  const deck = {
    find: async (name) => (name === 'shop' ? { term: { id: 'T1' }, run: { runId: NEW } } : null),
    movingTerm: () => false,
    forwardOf: () => undefined,
    handedOver: () => false,
  };
  const t0 = Date.now();
  const r = await sessionRoute(deck)({});
  assert.deepEqual(r, { on: false });
  assert.ok(Date.now() - t0 < 120, 'no wait when nothing is moving');
  assert.equal(sessionsNow()[NEW].on, false);
});
