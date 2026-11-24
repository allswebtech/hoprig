// A change of folder that lands in the home folder itself is what `cd ~` is: no touch of Hoprig's own files. A first
// project often stands directly in the home folder, and from there `cd ..` was held while `cd ~` went through. What
// the line does in the home folder afterwards is read from there, and every other naming of a folder above
// Hoprig's own stays held (src/wall.mjs movesHome, lineTouchesHoprig, touchesHoprig).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wallhome-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, 'home', 'alex');
const shop = path.join(home, 'shop'); // the session's own folder, directly in the home folder
const cfg = path.join(home, '.config', 'hoprig');
const state = path.join(home, '.local', 'state', 'hoprig');
const ws = path.join(home, 'Workspace');
for (const d of [path.join(shop, 'sub'), cfg, state, path.join(ws, 'projects')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, 'config.json'), '{}');

const places = (cwd) => ({ cwd, home, workspace: ws, projects: [path.join(ws, 'projects')], hoprig: [cfg, state], own: shop, relative: true });
// Asked both ways the wall is asked: with the event's own folder, and with the places alone.
const kinds = (cmd, cwd = shop) => [wallHeld({ tool: 'Bash', input: { command: cmd }, cwd, places: places(cwd) }), wallHeld({ tool: 'Bash', input: { command: cmd }, places: places(cwd) })].map((h) => (h ? h.kind : null));

test('a change of folder to the home folder itself, and something harmless there, goes through', () => {
  for (const line of ['cd ..', 'cd .. && ls', 'cd ../ && ls -la', 'pushd .. && ls', 'cd .. ; pwd', 'cd ./.. && ls', `cd ${home} && ls`, `cd ${home}/ && ls`, 'cd ~ && ls', 'cd $HOME && ls', 'cd && ls',
    'cd ../shop && npm test', 'cd .. && cd shop && ls', 'cd sub && cd .. && ls', 'cd .. && git -C shop status']) {
    assert.deepEqual(kinds(line), [null, null], line);
  }
  assert.deepEqual(kinds('cd ../.. && ls', path.join(shop, 'sub')), [null, null], 'two steps up from a folder below');
});

test('what the line does in the home folder afterwards is read from there: held as after cd ~', () => {
  for (const line of ['cd .. && mv .config old', 'cd .. && rm -rf .config/hoprig', 'cd .. && cat .config/hoprig/config.json', 'cd .. ; echo x > .config/hoprig/config.json', 'cd .. && ./.config/hoprig/x',
    'pushd .. && mv .local away', 'cd ..; mv .config/hoprig x', `cd ${home} && mv .config old`, 'cd ~ && mv .config old', 'cd .. && cp -r .local/state/hoprig /tmp/x', 'cd .. && tar czf x.tgz .config']) {
    assert.deepEqual(kinds(line).map((k) => k !== null), [true, true], line);
  }
  // A delete from the home folder is never a plain one.
  for (const line of ['cd .. && rm -rf shop', 'cd .. && find . -delete', 'cd .. && rm -rf Workspace']) assert.deepEqual(kinds(line).map((k) => k !== null), [true, true], line);
});

test('every other naming of the home folder or of a folder above Hoprig\'s own stays held', () => {
  // The folder named to another program; a change of folder into a folder above Hoprig's own or into one of them;
  // a change of folder with an option, a second word, a redirection, quotes or a variable.
  for (const line of ['mv .. /tmp/x', 'tar czf x.tgz ..', 'cp -r .. /tmp/y', 'chmod -R 777 ..', 'ln -s .. x', 'rsync -a ../ /tmp/z', 'ls ..', 'du -sh ..', 'cd ../.config && ls', 'cd ../.config/hoprig',
    'cd ../.local/state && ls', 'cd ../.local', 'cd .. extra', 'cd -P ..', 'cd .. > out', 'env -C .. ls', 'cd ../shop/../.config', `cd ${home}/.config`, `mv ${home} /tmp/x`, 'cd ".."', "cd '..'", 'X=1 cd ..',
    'command cd ..', 'builtin cd ..']) {
    assert.deepEqual(kinds(line).map((k) => k !== null), [true, true], line);
  }
  assert.deepEqual(kinds('sudo cd ..'), ['admin', 'admin']);
});
