// What docs/PC-SETUP.md, PROVIDERS.md, SKILLS.md, GO-LIVE.md and FIELD-REPORTS.md say about the product, held to the
// code that does it. When the code changes, the sentence has to change with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

/** The titles of a page's array of parts (`export const <name> = [ { …, title: '…' }, … ];`), in order. */
function titles(file, name) {
  const t = read(file);
  const at = t.indexOf(`export const ${name} = [`);
  assert.ok(at >= 0, `${file} has ${name}`);
  const body = t.slice(at, t.indexOf('\n];', at));
  return [...body.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
}

test('PC-SETUP: a computer\'s page has the parts the guide names, and Setup links to Settings → Workspace', () => {
  const parts = titles('web/pc.js', 'PARTS');
  assert.deepEqual(parts, ['Overview', 'Setup', 'Health', 'Advanced']);
  const doc = flat(read('docs/PC-SETUP.md'));
  assert.ok(doc.includes(`one of its ${['', '', 'two', 'three', 'four', 'five'][parts.length]} parts: ${parts.slice(0, -1).map((p) => `**${p}**`).join(', ')} and **${parts.at(-1)}**`), 'the guide names every part');
  assert.match(read('web/pcsetup.js'), /h\('a\.row', \{ href: link\('#\/settings\/workspace'\) \}/, 'Setup links to Settings → Workspace');
  assert.ok(doc.includes('Setup also has a link to the workspace folders, which live in **Settings → Workspace**'));
});

test('PC-SETUP: pc status names the coding tools Hoprig installs, as the status code checks them', async () => {
  const { TOOLS } = await import('../src/codetools/index.mjs');
  const { codingToolChecks } = await import('../src/pcsetup/status.mjs');
  const managed = TOOLS.filter((t) => t.managed);
  const stand = managed.map((t) => ({ ...t, installedVersion: () => null }));
  const checks = await codingToolChecks(stand);
  assert.deepEqual(checks.map((c) => c.group), managed.map(() => 'codetools'), 'pc status has a line per installable coding tool');
  const doc = flat(read('docs/PC-SETUP.md'));
  assert.ok(doc.includes(`the other coding tools Hoprig installs into its own tools folder (${managed.map((t) => t.name).join(', ')})`), 'the status list names them');
});

test('PC-SETUP: the projects folder is changed in the Workspace page\'s Advanced part', () => {
  const page = read('web/projects.js');
  assert.match(page, /fold\('projects', 'Advanced', advanced\)/, 'the Workspace page has an Advanced part');
  assert.match(page, /fill\(advanced, folderLine\(data, load\)\)/, 'the folder line is in it');
  assert.match(page, /'Projects folder: '[\s\S]{0,200}label: 'Change'/, 'with its Change button');
  assert.ok(flat(read('docs/PC-SETUP.md')).includes('change the folder there: **Advanced**, **Projects folder**, **Change**'));
});

test('PROVIDERS: an endpoint that does not answer offers a gateway restart only where a gateway runs the provider', async () => {
  const { detectProviderStop } = await import('../src/operator/detect/providerstop.mjs');
  const now = Date.now();
  const board = (gateways) => ({ sessions: [{ name: 'alpha', provider: 'relay', state: 'idle', stop: { at: now - 1000, reason: 'no-answer', text: 'Request timed out' }, agents: [] }], gateways, providers: [] });
  const ids = (g) => detectProviderStop(board(g), { now })[0].acts.map((a) => (typeof a === 'string' ? a : a.id));
  assert.deepEqual(ids([{ name: 'gw1', users: ['relay'] }]), ['restart-gateway', 'open']);
  assert.deepEqual(ids([]), ['open']);
  assert.ok(flat(read('docs/PROVIDERS.md')).includes('| Restart the gateway, when the provider runs through a gateway on this computer; else open the session and continue it when the endpoint answers again |'));
});

test('SKILLS: the bundled skills the guide counts are the catalog\'s bundled entries', () => {
  const cat = JSON.parse(read('src/skillhub/catalog.json'));
  const list = Array.isArray(cat) ? cat : cat.entries || cat.skills || Object.values(cat);
  const bundled = list.filter((x) => x.bundled);
  const doc = flat(read('docs/SKILLS.md'));
  assert.ok(doc.includes(`${['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][bundled.length]} entries are **bundled**`), 'the count');
  for (const x of bundled) assert.ok(doc.includes(`the \`${x.id}\` skill in \`${x.bundled}\``), `${x.id} is named with its folder`);
});

test('SKILLS: the weekly update check is off at first and tells only by a notification', async () => {
  const page = read('web/skillhub.js');
  assert.match(page, /toggle\('Look for updates and new skills once a week', data\.settings\.weekly/, 'its switch on the Skills page');
  const feat = read('src/skillhub/feature.mjs');
  assert.match(feat, /weekly: s\.weekly === true/, 'off unless turned on');
  assert.match(feat, /sctx\.notify\(\{ title: `Skill updates/, 'it tells by a notification');
  // No part of the page reads the weekly check's result: there is no badge from it.
  for (const f of fs.readdirSync(path.join(ROOT, 'web'), { recursive: true }).filter((f) => f.endsWith('.js'))) assert.ok(!read(path.join('web', f)).includes('lastResult'), `${f} shows no weekly result`);
  const doc = flat(read('docs/SKILLS.md'));
  assert.ok(doc.includes('It only tells you, with a notification where you set one up in **Settings → Notifications**; it never installs.'));
  assert.ok(!/a notification and a badge/.test(doc));
});

test('GO-LIVE: a limiter that is not confirmed stops the check; nothing waits to run it later', async () => {
  const { limiterOf } = await import('../src/ship/allow.mjs');
  assert.deepEqual(limiterOf({ ship: { limiter: { run: ['nice', '-n', '15'] } } }), { run: ['nice', '-n', '15'], allowed: false }, 'a limiter without its yes is not allowed');
  assert.deepEqual(limiterOf({}), { run: null, allowed: true }, 'no limiter: checks run as they are');
  assert.match(read('src/ship/check.mjs'), /if \(lim\.run && !lim\.allowed\) throw fail\(409, '[^']*confirm them again there first'/, 'the check refuses');
  const doc = flat(read('docs/GO-LIVE.md'));
  assert.ok(doc.includes('Until it is confirmed, no check starts: the check stops with "confirm them again there first", and you start it again after your yes.'));
  assert.ok(!doc.includes('Until it is confirmed, checks wait.'));
});

test('FIELD-REPORTS: adopt and a service install after an update make reports, as the guide lists', async () => {
  const os = await import('node:os');
  process.env.HOPRIG_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'field-docs-'));
  const { reportAdopt, reportRetire, reportRestart } = await import('../src/field/wire.mjs');
  const { appVersion } = await import('../src/setup/checks.mjs');
  assert.equal(reportAdopt({ ok: true, lines: [{ what: 'copy', ok: true }] }, Date.now())?.kind, 'adopt');
  assert.equal(reportAdopt({ ok: true, dryRun: true, lines: [] }, Date.now()), null, 'a dry run makes none');
  assert.equal(reportRetire({ ok: true }, Date.now())?.kind, 'adopt');
  const mine = appVersion();
  assert.equal(reportRestart({ before: { version: '0.0.1', pid: 1 }, code: 0, after: { version: mine, pid: 2 }, mine, startedAt: Date.now() })?.kind, 'go-live');
  assert.equal(reportRestart({ before: { version: mine, pid: 1 }, code: 0, after: { version: mine, pid: 2 }, mine, startedAt: Date.now() }), null, 'the same version again makes none');
  // Where they are called: the adopt command and its page route, and `service install`.
  assert.match(read('src/adopt/cli.mjs'), /reportAdopt\(x, startedAt\)[\s\S]*reportRetire\(x, startedAt\)/);
  assert.match(read('src/adopt/feature.mjs'), /reportAdopt\(x, startedAt\)/);
  assert.match(read('src/server/cli.mjs'), /if \(args\[0\] === 'install'\) return installWithReport\(\);/);
  const doc = flat(read('docs/FIELD-REPORTS.md'));
  assert.ok(doc.includes('`adopt apply` and `adopt retire` (and the same arranging from the dashboard), `update`, `service install` when it replaced an older version that was running'));
});
