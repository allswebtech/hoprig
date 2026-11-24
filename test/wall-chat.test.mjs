// The App chat is held by the same wall as a terminal. (a) A Claude chat's handed hooks carry the
// same gated PreToolUse hold while Hands-off is offered (chatHooks), so a held command in a chat in bypass mode is
// held too; a chat too old for the exact events gets no hooks and cannot hold. (b) The installed program folder is
// one of Hoprig's own folders, so no delete there is answered by itself — for an OpenCode chat (which decides by its
// own places) as well as a terminal (the hook's places, point 1).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallchat-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_WORKSPACE_DIR = path.join(tmp, 'ws');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { chatHooks } = await import('../src/launch.mjs');
const { openCodeAllows } = await import('../src/chat/asks.mjs');
const { hookFile } = await import('../src/paths.mjs');

test('a Claude chat gets the gated PreToolUse hold while Hands-off is offered, and none when it is not', () => {
  const on = chatHooks('2.1.328', true);
  assert.ok(Array.isArray(on.PreToolUse), 'the wall hold is handed to the chat when offered');
  const cmd = on.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.startsWith('if [ -e "${HOPRIG_RUN_FILE%/runs/*}/handsoff-active" ]; then '), cmd);
  assert.equal(on.PreToolUse[0].matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit');
  assert.ok(on.PermissionRequest, 'the PermissionRequest hook is still there');
  const off = chatHooks('2.1.328', false);
  assert.equal(off.PreToolUse, undefined, 'no wall hold while Hands-off is not offered');
  assert.equal(chatHooks('2.1.300', true), null, 'a Claude Code too old for the exact events gets no hooks');
});

test('an OpenCode chat does not answer a delete in the installed program folder by itself', () => {
  const INSTALL = path.dirname(path.dirname(hookFile())); // the install root (its bin/ holds the hook file)
  const del = { type: 'permission', shell: true, tool: 'Bash', full: { command: 'rm -rf build' }, owner: false };
  const chat = { cwd: INSTALL, session: {} };
  assert.equal(openCodeAllows(chat, del, 'bypassPermissions'), false, 'a delete in the install folder is a card, not answered');
  // An ordinary (non-delete) command in the same folder is still answered by itself — only the delete is held here.
  assert.equal(openCodeAllows(chat, { type: 'permission', shell: true, tool: 'Bash', full: { command: 'ls -la' }, owner: false }, 'bypassPermissions'), true);
});

test('a chat of Tia\'s gets the wall\'s hook with no Hands-off gate, offered or not', { skip: process.platform === 'win32' && 'no POSIX gate on Windows' }, () => {
  for (const offered of [true, false]) {
    const hers = chatHooks('2.1.328', offered, true);
    const cmd = hers.PreToolUse[0].hooks[0].command;
    assert.ok(!cmd.includes('handsoff-active'), `no gate (offered: ${offered}): ${cmd}`);
  }
  assert.equal(chatHooks('2.1.328', false).PreToolUse, undefined, 'his chat with Hands-off not offered: no hold, as before');
});

test('a chat of Tia\'s on a Claude Code too old for the exact events still carries the hold, and nothing else', { skip: process.platform === 'win32' && 'no POSIX gate on Windows' }, () => {
  for (const offered of [true, false]) {
    const hers = chatHooks('2.1.300', offered, true);
    assert.ok(hers && Array.isArray(hers.PreToolUse), `the hold is handed (offered: ${offered})`);
    assert.ok(!hers.PreToolUse[0].hooks[0].command.includes('handsoff-active'), 'no gate');
    assert.equal(hers.PreToolUse[0].matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit');
    assert.equal(hers.PermissionRequest, undefined, 'no OK answered by hook on that version');
  }
  assert.equal(chatHooks('2.1.300', true), null, 'his chat on that version: no hooks, as before');
});
