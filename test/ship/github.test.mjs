// GitHub's token reaches a go-live command only when the project's confirmed live block names that it needs it
// ("github": true, src/ship/project.mjs), never by itself; the line is part of what he confirms (a block that gains it
// asks again) and the sheet and the command line show it. A provider's key reaches none of them either way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempShip } from './helpers.mjs';

const t = tempShip('ship-github');
test.after(() => t.cleanup());
const { putTogether, readTogether } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow, isAllowed } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive, cleanLive } = await import('../../src/ship/project.mjs');
const { goLive } = await import('../../src/ship/live.mjs');
const idle = () => ({ over: false, why: null });

const NAMES = ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY'];
async function liveOnce(name, extra) {
  const dir = path.join(t.projects, name);
  const seen = path.join(t.root, `${name}.seen`);
  const write = `require('node:fs').writeFileSync(${JSON.stringify(seen)}, ${JSON.stringify(NAMES)}.filter((k) => k in process.env).join(','))`;
  const live = { update: [['node', '-e', write]], verify: [['node', '-e', '0']], back: [['node', '-e', '0']], ...extra };
  t.repo(dir, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live }) });
  t.branch(dir, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');
  const r = await putTogether(dir, { name, branches: ['work/menu'] });
  allow(dir, 'check', readCheck(r.dir).check);
  await runCheck(dir, r.dir, { busy: idle });
  allow(dir, 'live', readLive(r.dir).live);
  const step = await goLive(dir, readTogether(r.id));
  const done = await step.done;
  assert.equal(done.outcome, 'live', done.why);
  return fs.readFileSync(seen, 'utf8');
}

test('without "github" in the confirmed block: no GitHub token, no provider key', async () => {
  Object.assign(process.env, { GH_TOKEN: 'made-up', GITHUB_TOKEN: 'made-up', ANTHROPIC_API_KEY: 'made-up' });
  assert.equal(await liveOnce('cafe', {}), '');
});

test('with "github": true confirmed: GitHub\'s token, still no provider key', async () => {
  Object.assign(process.env, { GH_TOKEN: 'made-up', GITHUB_TOKEN: 'made-up', ANTHROPIC_API_KEY: 'made-up' });
  assert.equal(await liveOnce('deli', { github: true }), 'GH_TOKEN,GITHUB_TOKEN');
  assert.deepEqual(t.trapped(), []);
});

test('"github" is part of what he confirms, and only true or false', () => {
  const base = { update: [['x']], verify: [['x']], back: [['x']] };
  const without = cleanLive(base).live;
  const withIt = cleanLive({ ...base, github: true }).live;
  assert.equal(without.github, undefined, 'kept only when true: an older yes still holds');
  assert.equal(withIt.github, true);
  const real = path.join(t.projects, 'cafe');
  allow(real, 'live', without);
  assert.equal(isAllowed(real, 'live', withIt), false, 'a block that gains the token asks again');
  assert.match(cleanLive({ ...base, github: 'yes' }).errors[0], /github/);
});
