// The places a run_command line names, for the never list (credentials folder): every Windows spelling is found, and on
// Linux and macOS only what always was ("/x", "~/x"). Windows-shaped lines are fed with platform 'win32', so the test
// runs on every system; command-never.test.mjs refuses for real on the system the test runs on.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { commandPlaces, expandHome } from '../../src/assistant/commandplaces.mjs';

const W = { platform: 'win32', home: 'C:\\Users\\alex', env: { USERPROFILE: 'C:\\Users\\alex', APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' } };
const cred = 'C:\\Users\\alex\\Workspace\\credentials';
const names = (cmd, folder) => commandPlaces(cmd, folder, W).map((x) => x.toLowerCase());
const finds = (cmd, folder = 'C:\\Users\\alex') => names(cmd, folder).some((x) => x === cred.toLowerCase() || x.startsWith(`${cred.toLowerCase()}\\`));

test('Windows: a path to the credentials folder is found in every spelling', () => {
  for (const c of [
    `cat ${cred}\\shop\\key.env`, 'cat C:/Users/alex/Workspace/credentials/shop/key.env', 'cat c:\\users\\ALEX\\workspace\\CREDENTIALS\\k', `type "${cred}\\a b\\k"`, `type '${cred}\\k'`,
    'cat /c/Users/alex/Workspace/credentials/k', 'cat /mnt/c/Users/alex/Workspace/credentials/k', `cat ${cred}\\`, `cat \\\\?\\${cred}\\k`,
    'cat ~/Workspace/credentials/k', 'cat ~\\Workspace\\credentials\\k', 'type %USERPROFILE%\\Workspace\\credentials\\k', 'gc $env:USERPROFILE\\Workspace\\credentials\\k',
    'cat $HOME/Workspace/credentials/k', `cat --file=${cred}\\k`, `cat >${cred}\\k`, `cp x "${cred}\\k"`, `ls;cat ${cred}\\k`, 'cat Workspace\\credentials\\k', 'cat ..\\credentials\\k',
  ]) assert.ok(finds(c, c.includes('..') ? `${cred}\\shop` : c.startsWith('cat Workspace') ? 'C:\\Users\\alex' : 'C:\\Users\\alex'), c);
  assert.ok(finds('ls', cred));
  assert.ok(finds('ls', 'C:/Users/alex/Workspace/credentials/shop'));
  assert.equal(finds('cat C:\\Users\\alex\\Workspace\\projects\\k'), false);
});

test('Windows: a folder with ~ or an environment name is expanded', () => {
  assert.equal(expandHome('~\\x', W), path.win32.join(W.home, 'x'));
  assert.equal(expandHome('%USERPROFILE%\\x', W), 'C:\\Users\\alex\\x');
  assert.equal(expandHome('$env:userprofile\\x', W), 'C:\\Users\\alex\\x');
  assert.equal(expandHome('rel\\x', W), 'rel\\x');
});

test('Linux and macOS read what they always read: a path from "/" or "~/", and nothing else', () => {
  const P = { platform: 'linux', home: '/home/alex', env: { HOME: '/home/alex' } };
  assert.deepEqual(commandPlaces('cat /home/alex/Workspace/credentials/k ~/x relative/y "C:\\x"', '/p', P), ['/p', '/home/alex/Workspace/credentials/k', '/home/alex/x']);
  assert.deepEqual(commandPlaces('ls', undefined, P), []);
});
