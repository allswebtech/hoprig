// A Codex or OpenCode terminal session the dashboard starts for Tia (its launch file says so) goes through the one
// startAsHers, as Claude Code's does: its run is marked hers, so a move keeps it hers, and git and gh sign in with the
// token the owner chose in place of his own. A session of his own keeps his environment unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-hertoolenv-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_WORKSPACE_DIR = path.join(tmp, 'ws');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { toolEnv } = await import('../../src/codetools/terminal.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { isMarkedHers } = await import('../../src/hermark.mjs');
const R = await import('../../src/runs.mjs');

fs.mkdirSync(path.join(tmp, 'ws', 'credentials'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'ws', 'credentials', 'tia-token'), 'ghp_herMadeUpToken_tool_0001\n');
const HIS = { HOME: '/home/alex', GH_TOKEN: 'ghp_HIS_own_tool', GITHUB_TOKEN: 'ghp_HIS_own_tool' };

test('her Codex or OpenCode terminal is marked hers and signs in with the chosen token; his is unchanged', () => {
  saveConfig({ server: { herGitSignin: { file: 'tia-token', at: 1 } } });
  const hers = R.createRun({ profile: 'gw', cwd: tmp, tool: 'opencode' }).file;
  const env = toolEnv(HIS, hers, { hers: true });
  assert.equal(env.HOPRIG_RUN_FILE, hers);
  assert.equal(env.GH_TOKEN, 'ghp_herMadeUpToken_tool_0001');
  assert.equal(env.GITHUB_TOKEN, 'ghp_herMadeUpToken_tool_0001');
  assert.ok(isMarkedHers(hers), 'her run is marked where a move reads it');
  R.removeRun(hers);
  assert.ok(!isMarkedHers(hers), 'the mark goes with the record');

  // His session starts after hers ended, as two sessions of one launcher do: two records one process makes in the
  // same millisecond share a run id, and his would then read as the record hers left.
  const his = R.createRun({ profile: 'gw', cwd: tmp, tool: 'opencode' }).file;
  const mine = toolEnv(HIS, his);
  assert.equal(mine.GH_TOKEN, 'ghp_HIS_own_tool', 'his own session keeps his sign-in');
  assert.ok(!isMarkedHers(his), 'his own session is not marked');
  R.removeRun(his);
});

test('her Codex or OpenCode terminal with a chosen file that cannot be read gets no git token at all', () => {
  saveConfig({ server: { herGitSignin: { file: 'gone', at: 2 } } });
  const hers = R.createRun({ profile: 'gw', cwd: tmp, tool: 'codex' }).file;
  const env = toolEnv(HIS, hers, { hers: true });
  // No git token: each token variable gh reads holds the placeholder (gh fails, never asks the keyring), never his.
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) assert.equal(env[k], 'none', `${k} holds the placeholder`);
  assert.ok(!JSON.stringify(env).includes('ghp_HIS_own_tool'), 'his own token is not in her session');
  R.removeRun(hers);
});
