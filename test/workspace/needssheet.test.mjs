// "Also open" in the new-session sheet (web/newsession-also.js): nothing to offer, nothing shown; the project's own
// needs shown as included (one not here with its get); a tick adds a name; another coding tool is told it gets none;
// the start sends the ticked names as "with" (web/newsession-start.js, web/chat/start.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byClass, texts } from '../chat/fakedom.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const inputs = (n) => (n && n.children ? [...(n.tag === 'input' ? [n] : []), ...n.children.flatMap(inputs)] : []);

test('Also open: the needs as included, a tick per project, another coding tool told', async () => {
  const { alsoOpen } = await import('../../web/newsession-also.js');
  assert.equal(alsoOpen({ data: null, chosen: [], tool: 'claude' }), null);
  assert.equal(alsoOpen({ data: { project: 'shop', needs: [], choices: [] }, chosen: [], tool: 'claude' }), null);
  const data = { project: 'shop', needs: [{ name: 'kits/parts', here: true, accepted: true }, { name: 'docs', here: false, accepted: false, fix: 'hoprig get docs' }], choices: ['blog'] };
  const chosen = [];
  let changed = 0;
  const f = alsoOpen({ data, chosen, tool: 'claude', toolName: 'Claude Code', onchange: () => changed++ });
  const words = texts(f).join(' | ');
  assert.match(words, /Also open/);
  assert.match(words, /shop needs, and gets by itself once you allow it here:/);
  assert.match(words, /shop reads kits\/parts/);
  assert.match(words, /docs: not on this computer, so it is not opened \(hoprig get docs\)/);
  assert.match(words, /Its file tools cannot write there; a shell command still could/);
  assert.doesNotMatch(words, /never write/);
  const box = inputs(f).find((x) => x.attrs['data-key'] === 'also:blog');
  assert.ok(box, 'a tick for blog');
  assert.equal(inputs(f).length, 1, 'no tick for a need: it comes by itself');
  box.listeners.change({ target: { checked: true } });
  assert.deepEqual(chosen, ['blog']);
  assert.equal(changed, 1);
  box.listeners.change({ target: { checked: false } });
  assert.deepEqual(chosen, []);
  // A refused need (the credentials folder): why it is not opened, never "not on this computer" or "undefined".
  const refused = alsoOpen({ data: { ...data, needs: [{ name: 'credentials', here: false, why: '"credentials" is the credentials folder, which is never shared with another project' }] }, chosen: [], tool: 'claude', toolName: 'Claude Code' });
  const rw = texts(refused).join(' | ');
  assert.match(rw, /credentials: not opened: "credentials" is the credentials folder, which is never shared/);
  assert.doesNotMatch(rw, /undefined|not on this computer/);
  const oc = alsoOpen({ data, chosen: [], tool: 'opencode', toolName: 'OpenCode' });
  assert.match(texts(oc).join(' '), /OpenCode gets no extra folders/);
  assert.equal(inputs(oc).length, 0);
  assert.equal(byClass(f, 'ns-also-picks').length, 1);
  assert.equal(byClass(f, 'ns-also-allow').length, 0, 'no allow button without a project to give it for');
  // With a chosen project: a need here not allowed yet says so and offers Allow; an allowed one offers Take back.
  const asked = [];
  const g = alsoOpen({ data: { ...data, needs: [{ name: 'kits/parts', here: true, accepted: false }, { name: 'blog', here: true, accepted: true }] }, chosen: [], tool: 'claude', toolName: 'Claude Code', onallow: (n, yes) => asked.push([n, yes]) });
  assert.match(texts(g).join(' | '), /shop reads kits\/parts: not allowed on this computer yet, so it is not opened/);
  const buttons = byClass(g, 'ns-also-allow');
  assert.deepEqual(buttons.map((b) => texts(b).join('')), ['Allow', 'Take back']);
  buttons[0].listeners.click();
  buttons[1].listeners.click();
  assert.deepEqual(asked, [['kits/parts', true], ['blog', false]]);
  const later = alsoOpen({ data: { ...data, needs: [{ name: 'docs', here: false, accepted: true, fix: 'hoprig get docs' }] }, chosen: [], tool: 'claude', toolName: 'Claude Code', onallow: () => {} });
  assert.match(texts(later).join(' '), /shop reads docs: not on this computer, so it is not opened \(hoprig get docs\); allowed once it is here/, 'a need allowed before it is here says so');
  // The start sends them, to a terminal and to the App.
  const start = fs.readFileSync(path.join(WEB, 'newsession-start.js'), 'utf8');
  assert.match(start, /with: alsoOf\(st\)/);
  assert.match(fs.readFileSync(path.join(WEB, 'chat', 'start.js'), 'utf8'), /body\.with = o\.with/);
});

test('the generated "Your workspace" rules say what a need is, and that it is no wall', async () => {
  const src = fs.readFileSync(path.join(WEB, '..', 'src', 'pcsetup', 'wsrules.mjs'), 'utf8');
  assert.match(src, /named in its project\.json\\'s `needs` \(asked for with `hoprig get <name>`\)/);
  assert.match(src, /never to write/);
  assert.match(src, /it is no wall: never write into a need/);
});

test('docs/WORKSPACE.md and the help say what needs and --with are, and that it is no wall', async () => {
  const doc = fs.readFileSync(path.join(WEB, '..', 'docs', 'WORKSPACE.md'), 'utf8');
  assert.match(doc, /## Needs: what a project reads from elsewhere/);
  assert.match(doc, /"needs": \["kits\/parts"\]/);
  assert.match(doc, /A shell command could still write there: it is no wall/);
  assert.match(doc, /\| OpenCode \| none/);
  assert.match(doc, /Needs count only for a project of the map: one that is only on this computer \(not in the map\) gets\s+no extra folder, and status and drop do not read its `needs`/);
  assert.match(doc, /Only the file tools are refused\s+there: a shell command \(`grep -r`\) can still read its private folders and follows its links/);
  assert.match(doc, /\| Its private folders \|/);
  // get's words for a need of a need, and where Also open sits in the sheet (before the project choice), as they are now.
  assert.match(doc, /`shop also needs, to read: kits\/parts; and kits\/parts needs tools`/);
  assert.ok(!/needs it too/.test(doc), 'not the old words of get');
  assert.match(doc, /\*\*Also open\*\*, before the project\s+choice in the new-session sheet/);
  const { DROP_USAGE } = await import('../../src/workspace/dropcli.mjs');
  assert.match(DROP_USAGE, /when another project here names it in "needs", drop asks first \(--check and --json: neededBy\)/);
  assert.match(fs.readFileSync(path.join(WEB, '..', 'src', 'workspace', 'cli.mjs'), 'utf8'), /names each project's "needs" that are not on this computer/);
  // The short top help left it out; it stands in "hoprig help all" (src/helpall.mjs).
  const help = fs.readFileSync(path.join(WEB, '..', 'src', 'helpall.mjs'), 'utf8');
  assert.match(help, /hoprig <profile> --with <name> {2}also let this session read another project/);
  assert.match(fs.readFileSync(path.join(WEB, '..', 'src', 'pcsetup', 'getproject.mjs'), 'utf8'), /--with-needs {2}also get what the project names in "needs"/);
});
