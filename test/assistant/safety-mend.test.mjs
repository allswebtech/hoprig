// Three holes the review of the safety lane proved: the wake of a watched session carried the raw screen to her model,
// her start could reach the dashboard's own state folder (it holds private keys), and a value that a coding tool
// printed with an indent on the continuation line was not found. Marker values are made up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { sandbox } from '../server/helpers.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const box = sandbox('safety-mend');
test.after(() => box.cleanup());
const ws = fs.realpathSync(box.workspace);
const MARK = 'MADEUP-CRED-VALUE-7731abcdzebra';
const creds = path.join(ws, 'credentials');
fs.mkdirSync(path.join(creds, 'shop'), { recursive: true });
fs.writeFileSync(path.join(creds, 'shop', 'shop.env.local'), `SHOP_KEY=${MARK}\n`, { mode: 0o600 });
const proj = path.join(ws, 'projects', 'shop');
fs.mkdirSync(path.join(proj, 'code', 'shop'), { recursive: true });
fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ name: 'shop', repos: [{ dir: 'code/shop' }], credentials: { 'code/shop/.env.local': 'shop/shop.env.local' } }));
const { forgetValues, maskValues } = await import('../../src/assistant/maskvalues.mjs');
const { isSecretFolder } = await import('../../src/server/folders.mjs');
const { stateDir, configDir } = await import('../../src/paths.mjs');
const BUILTIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'skills');

const make = (screens, now = Date.now) => {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'work' };
  s.screens = { ...s.screens, ...screens };
  const ops = new FakeOps(s);
  const core = createAssistantCore({ ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }), skills: new Skills({ dirs: [{ dir: BUILTIN, source: 'built-in' }] }) });
  return { ops, core, call: (tool, args) => core.call(tool, args, { conversation: 'c1' }) };
};

test('the wake of a watched session holds no credential value', async () => {
  forgetValues();
  let t = 1_000_000;
  const { ops, core, call } = make({ 'this|api-fix': `> cat .env.local\nSHOP_KEY=${MARK}\n> ` }, () => t);
  await call('list_sessions', {});
  const w = await call('watch_session', { session: 'api-fix', goal: 'tests pass' });
  assert.equal(w.isError, false, w.text);
  const screenOf = (e) => ops.capture({ computer: e.computer, session: e.session, lines: 60 });
  await core.jobTick(await ops.listSessions({}), screenOf);
  ops.s.sessions[0].status = 'waiting';
  t += 1000;
  const wakes = await core.jobTick(await ops.listSessions({}), screenOf);
  assert.equal(wakes.length, 1);
  assert.ok(!wakes[0].message.includes(MARK), 'the wake message holds the value');
});

test('a value a coding tool wrapped with an indent is hidden', async () => {
  forgetValues();
  const { call } = make({ 'this|api-fix': `> cat .env.local\n  ⎿  SHOP_KEY=${MARK.slice(0, 16)}\n     ${MARK.slice(16)}\n> ` });
  await call('list_sessions', {});
  const r = await call('read_session', { session: 'api-fix' });
  assert.equal(r.isError, false, r.text);
  assert.ok(!r.text.includes(MARK.slice(0, 16)) && !r.text.includes(MARK.slice(16)), r.text.slice(-300));
  assert.ok(!(await maskValues(`SHOP_KEY=${MARK.slice(0, 20)}\n    \t${MARK.slice(20)}`)).includes(MARK.slice(20)));
});

test('the dashboard own folders are secret places for a start', async () => {
  assert.equal(isSecretFolder(stateDir()), true);
  assert.equal(isSecretFolder(path.join(stateDir(), 'sub')), true);
  assert.equal(isSecretFolder(configDir()), true);
  assert.equal(isSecretFolder(proj), false);
  const { call } = make({});
  const s = await call('start_session', { folder: stateDir(), account: 'sub' });
  assert.equal(s.isError, true, s.text);
});
