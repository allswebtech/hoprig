// "This session's acts are held" means its handed settings carry the wall's OWN PreToolUse entry (the Bash|Write|…
// matcher that launch.mjs hookSettings/chatHooks build), not any PreToolUse entry. A Lead model session (and a Lead
// chat) carries the Agent|Task entry (launch.mjs leadHook) without the wall's: it answers questions but holds none of
// its acts, so it is uncovered. settingsHoldWall decides it; sessionHasHold reads the handed file through it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallcover-'));
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { WALL_MATCHER, settingsHoldWall } = await import('../../src/handsoff.mjs');
const { sessionHasHold } = await import('../../src/server/handsoff.mjs');
const { hookSettingsDir } = await import('../../src/paths.mjs');
const { hookSettings, chatHooks, leadHook } = await import('../../src/launch.mjs');

const hook = [{ type: 'command', command: 'hoprig-hook' }];
const wall = { matcher: WALL_MATCHER, hooks: hook };
const lead = { matcher: 'Agent|Task', hooks: hook };
const S = (pre) => ({ hooks: { PreToolUse: pre, SessionStart: [{ hooks: hook }] } });

test('settingsHoldWall: the wall\'s own entry counts; the Lead model\'s does not; neither does none', () => {
  assert.equal(settingsHoldWall(S([lead])), false, 'a Lead chat: Agent|Task only, no wall');
  assert.equal(settingsHoldWall(S([wall, lead])), true, 'both entries: covered');
  assert.equal(settingsHoldWall(S([lead, wall])), true, 'both entries, either order: covered');
  assert.equal(settingsHoldWall(S([wall])), true, 'the wall only: covered');
  assert.equal(settingsHoldWall(S([])), false, 'no PreToolUse entry');
  assert.equal(settingsHoldWall({ hooks: {} }), false, 'no PreToolUse key');
  assert.equal(settingsHoldWall({}), false);
  assert.equal(settingsHoldWall(null), false);
  // A PreToolUse entry the matcher of which is a near-miss is not the wall.
  assert.equal(settingsHoldWall(S([{ matcher: 'Bash', hooks: hook }])), false);
});

test('the real settings the launcher and the chat hand carry the wall\'s entry, and recognise it', () => {
  assert.equal(settingsHoldWall(hookSettings({ offered: true })), true, 'a launched terminal session');
  assert.equal(settingsHoldWall(hookSettings({ offered: false })), false, 'nothing held while not offered');
  // A chat that leads: the wall entry and the lead entry are joined (chat/engines/claude.mjs); still covered.
  const joined = (x, y) => Object.fromEntries([...new Set([...Object.keys(x || {}), ...Object.keys(y || {})])].map((k) => [k, [...((x || {})[k] || []), ...((y || {})[k] || [])]]));
  assert.equal(settingsHoldWall({ hooks: joined(chatHooks('2.1.327', true), leadHook()) }), true, 'a Lead chat, offered: both entries');
  assert.equal(settingsHoldWall({ hooks: joined(chatHooks('2.1.327', false), leadHook()) }), false, 'a Lead chat started while not offered: the lead entry only, uncovered');
});

test('sessionHasHold reads the handed file through settingsHoldWall', () => {
  fs.mkdirSync(hookSettingsDir(), { recursive: true });
  const put = (id, pre) => fs.writeFileSync(path.join(hookSettingsDir(), `${id}.json`), JSON.stringify(S(pre)));
  put('leadchat', [lead]);
  put('both', [wall, lead]);
  put('wall', [wall]);
  assert.equal(sessionHasHold('leadchat'), false);
  assert.equal(sessionHasHold('both'), true);
  assert.equal(sessionHasHold('wall'), true);
  assert.equal(sessionHasHold('no-such-session'), false, 'no handed file: uncovered');
});
