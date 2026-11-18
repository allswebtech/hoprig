// An AI brain folder that is a link (the owner moved it to another disk) is not followed until he names it: the
// upkeep then writes no map, and it must say so where he looks, with the command. Status names the brain's link and
// that the map cannot be written; the upkeep's needs line gives the mylink command; once named, the round records,
// commits and pushes again. Temporary homes and local bare repositories only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-brainlinkstatus');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { saveConfig } = await import('../../src/config.mjs');

const A = w.computer('alex');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
saveConfig({ projectsDir: A.projects });
const o = { dir: A.ws, projects: A.projects };
const away = w.clone(w.bare('brain'), path.join(A.home, 'elsewhere', 'ai_brain'));
fs.mkdirSync(A.ws, { recursive: true });
fs.symlinkSync(away, path.join(A.ws, 'ai_brain'));
w.clone(w.bare('shop'), path.join(A.projects, 'shop'));
fs.writeFileSync(path.join(away, 'workspace.json'), `${JSON.stringify({ version: 2, brain: { url: w.url('brain') }, projects: [{ name: 'shop', url: w.url('shop'), repos: [] }], others: [] }, null, 2)}\n`);
w.sh(away, 'add', 'workspace.json');
w.sh(away, 'commit', '-q', '-m', 'map');
w.sh(away, 'push', '-q', 'origin', 'HEAD');

test('a brain behind a link: status and the upkeep name it with the mylink command; named, the round records again', { skip: process.platform === 'win32' && 'links need rights on Windows' }, async () => {
  const link = path.join(A.ws, 'ai_brain');
  w.clone(w.bare('shop-web'), path.join(A.projects, 'shop', 'code', 'shop-web'));
  const r = await upkeepMap({ ...o, commit: true, push: true });
  assert.equal(r.changed, false);
  assert.match(r.skipped, /ai_brain leaves its folder through a link/);
  assert.ok(r.needs.some((n) => n.includes(`if the link is yours:  hoprig workspace mylink add ${link}`)), r.needs.join('\n'));
  const q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.ok(q.text().includes(`${link}: leaves its folder through a link: not followed  →  if it is yours:  hoprig workspace mylink add ${link}`), q.text());
  assert.match(q.text(), /the map cannot be written now.*ai_brain leaves its folder through a link: the map is not written through it/);
  const add = await quietUi();
  assert.equal(await main(['mylink', 'add', link], { ui: add.ui, write: () => {} }), 0, add.text());
  const again = await upkeepMap({ ...o, commit: true, push: true });
  assert.equal(again.changed, true, JSON.stringify(again));
  assert.deepEqual([again.commit.done, again.pushed.done], [true, true]);
  assert.ok(M.readMap(A.ws).map.projects[0].repos.some((x) => x.dir === 'code/shop-web'));
});
