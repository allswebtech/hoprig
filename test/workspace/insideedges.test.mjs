// The edges of the one check (inside.mjs): a path spelled with "<link>/..", a hard link to a file outside, links
// that each look inside but lead out through each other (a template's), and a root spelled by its real path when the
// workspace itself is a link. Each acted outside before. Temporary folders only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-insideedges-')));
test.after(() => fs.rmSync(T, { recursive: true, force: true }));
process.env.HOPRIG_CONFIG_DIR = path.join(T, 'cfg');
process.env.HOPRIG_STATE_DIR = path.join(T, 'st');
process.env.HOPRIG_WORKSPACE_DIR = path.join(T, 'ws');
const I = await import('../../src/workspace/inside.mjs');
const P = await import('../../src/pcsetup/workspace.mjs');
const posix = process.platform !== 'win32';

const world = (name) => {
  const top = path.join(T, name);
  const ws = path.join(top, 'ws');
  const projects = path.join(ws, 'projects');
  const out = path.join(top, 'OUT');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  return { top, ws, projects, out, at: { dir: ws, projects, mylinks: [] } };
};

test('a path with "<link>/.." is acted on where it was checked, never through the link', { skip: !posix && 'links need rights on Windows' }, () => {
  const x = world('dotdot');
  const shop = path.join(x.projects, 'shop');
  fs.mkdirSync(path.join(shop, 'code'), { recursive: true });
  fs.mkdirSync(path.join(x.out, 'sub'));
  fs.symlinkSync(path.join(x.out, 'sub'), path.join(shop, 'code', 'lnk'));
  const raw = `${shop}/code/lnk/../`;
  const at = { root: shop, ...x.at };
  I.mkdirIn(at, `${raw}evil`);
  I.writeIn(at, `${raw}f.txt`, 'x');
  I.writeIn(at, `${raw}g.txt`, 'y', { atomic: true });
  assert.deepEqual(fs.readdirSync(x.out).sort(), ['sub'], 'nothing was made outside');
  assert.deepEqual(fs.readdirSync(path.join(shop, 'code')).sort(), ['evil', 'f.txt', 'g.txt', 'lnk']);
  assert.equal(I.readIn(at, `${raw}f.txt`).toString(), 'x');
  I.removeIn(at, `${raw}f.txt`);
  assert.equal(fs.existsSync(path.join(shop, 'code', 'f.txt')), false);
});

test('a file of the workspace that is a hard link to a file outside: a write replaces the name, the file outside stays', { skip: !posix && 'hard links need rights on Windows' }, () => {
  const x = world('hard');
  const shop = path.join(x.projects, 'shop');
  fs.mkdirSync(shop);
  const secret = path.join(x.out, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET\n', { mode: 0o600 });
  fs.linkSync(secret, path.join(shop, 'project.json'));
  I.writeIn({ root: shop, ...x.at }, path.join(shop, 'project.json'), '{"x":1}');
  assert.equal(fs.readFileSync(secret, 'utf8'), 'SECRET\n');
  assert.equal(fs.readFileSync(path.join(shop, 'project.json'), 'utf8'), '{"x":1}');
  assert.equal(fs.statSync(path.join(shop, 'project.json')).nlink, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(shop, 'project.json')).mode & 0o777, 0o600, 'it keeps the mode it had');
});

test('a template whose links each look inside but lead out through each other is refused, and nothing leads out', { skip: !posix && 'links need rights on Windows' }, () => {
  const x = world('tpl');
  const tpl = path.join(x.top, 'tpl');
  fs.mkdirSync(path.join(tpl, 'sub'), { recursive: true });
  fs.symlinkSync('..', path.join(tpl, 'sub', 'a'));
  fs.symlinkSync('sub/a/../../OUT', path.join(tpl, 'l'));
  // The real path walks a link's ".." from where the link leads, as the system does.
  assert.equal(I.realOf(path.join(tpl, 'l')), path.join(T, 'OUT'), 'two folders up from where sub/a leads (tpl)');
  assert.throws(() => P.readTemplate(tpl), /the template's link l points outside the template/);
  // Written anyway (a list from elsewhere), in either order: the link that leads out is taken away.
  for (const order of [[{ rel: 'sub/a', kind: 'link', target: '..' }, { rel: 'l', kind: 'link', target: 'sub/a/../../OUT' }], [{ rel: 'l', kind: 'link', target: 'sub/a/../../OUT' }, { rel: 'sub/a', kind: 'link', target: '..' }]]) {
    const dest = path.join(x.projects, `shop${order[0].rel === 'l' ? 2 : 1}`);
    assert.throws(() => P.writeTemplate(dest, order, 'shop', x.at), /leads outside|leaves its folder through a link/);
    assert.equal(fs.lstatSync(path.join(dest, 'l'), { throwIfNoEntry: false }), undefined, 'the link that leads out is not there');
  }
  assert.deepEqual(fs.readdirSync(x.out), []);
});

test('a root spelled by its real path is checked from the workspace down like one spelled by the workspace\'s path', { skip: !posix && 'links need rights on Windows' }, () => {
  const top = path.join(T, 'realroot');
  const realws = path.join(top, 'data', 'Workspace');
  fs.mkdirSync(path.join(realws, 'projects'), { recursive: true });
  const lws = path.join(top, 'Workspace');
  fs.symlinkSync(realws, lws);
  const out = path.join(top, 'OUT');
  fs.mkdirSync(path.join(out, 'code'), { recursive: true });
  fs.symlinkSync(out, path.join(realws, 'projects', 'shop'));
  const at = { dir: lws, projects: path.join(lws, 'projects'), mylinks: [] };
  const byWs = I.leaves(path.join(lws, 'projects', 'shop'), path.join(lws, 'projects', 'shop', 'code'), at);
  const byReal = I.leaves(path.join(realws, 'projects', 'shop'), path.join(realws, 'projects', 'shop', 'code'), at);
  assert.equal(byWs && byWs.what, I.LEAVES);
  assert.equal(byReal && byReal.what, I.LEAVES);
  assert.throws(() => I.mkdirIn({ root: path.join(realws, 'projects', 'shop'), ...at }, path.join(realws, 'projects', 'shop', 'code', 'x')), /leaves its folder through a link/);
  assert.deepEqual(fs.readdirSync(path.join(out, 'code')), []);
});
