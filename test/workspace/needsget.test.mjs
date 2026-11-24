// `hoprig get shop` when shop's project.json names needs (pcsetup/getproject.mjs needsOffer): the needs not on this
// computer are named in one question, with each need of a need and whose it is; only a yes (or --with-needs) brings
// them, each by the normal get; without a terminal, with --yes or --dry-run nothing more comes and the command is said;
// --json gives needs, missingNeeds and the command. A loop of needs ends. Local bare repositories only (gitfix.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

async function world(name, { mapNeeds = true, runner = null } = {}) {
  const w = gitWorld(`needs-get-${name}`);
  const u = { brain: w.bare('brain', { empty: true }), shop: w.bare('shop-workspace'), parts: w.bare('parts'), tools: w.bare('tools-workspace') };
  const seed = (url, file, json) => {
    const d = w.clone(url, path.join(w.root, `seed-${path.basename(url)}`));
    w.commit(d, file, JSON.stringify(json, null, 2) + '\n');
    w.sh(d, 'push', '-q');
  };
  seed(u.shop, 'project.json', { name: 'shop', repos: [], memories: {}, needs: ['kits/parts', 'credentials', '../x'] });
  seed(u.parts, 'project.json', { name: 'parts', repos: [], memories: {}, needs: ['tools', 'shop'] }); // tools: a need of a need; shop: a loop
  seed(u.tools, 'project.json', { name: 'tools', repos: [], memories: {}, needs: ['kits/parts'] });
  const map = { version: 2, brain: { url: u.brain }, groups: [{ dir: 'kits' }], projects: [{ name: 'shop', url: u.shop, repos: [] }, { name: 'parts', in: 'kits', url: u.parts, repos: [], ...(mapNeeds ? { needs: ['shop', 'tools'] } : {}) }, { name: 'tools', url: u.tools, repos: [] }], others: [] };
  const c = w.computer('alpha');
  c.use();
  fs.mkdirSync(path.join(c.ws, 'ai_brain'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, 'ai_brain', 'workspace.json'), JSON.stringify(map, null, 2) + '\n');
  const { getMain } = await import('../../src/pcsetup/getproject.mjs');
  const { makeUi } = await import('../../src/setup/ui.mjs');
  const get = async (args, { answers = null } = {}) => {
    c.use();
    let text = '';
    let out = '';
    const asked = [];
    const list = answers ? [...answers] : null;
    const ui = makeUi({ interactive: !!list, write: (s) => (text += s), askLine: async (q) => (asked.push(q), list.length ? list.shift() : null) });
    const code = await getMain(args, { ui, write: (s) => (out += s), dir: c.projects, ...(runner ? { runner } : {}) });
    return { code, text, asked, json: out.trim().startsWith('{') ? JSON.parse(out) : null };
  };
  const here = (rel) => fs.existsSync(path.join(c.ws, rel, '.git'));
  // The owner's yes kept on this computer (Hoprig's own settings, workspace/needsyes.mjs).
  const accepted = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(c.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8')).acceptedNeeds || {};
    } catch {
      return {};
    }
  };
  return { w, c, get, here, accepted };
}

test('get shop in a terminal: one question names kits/parts and tools (kits/parts needs it); no fetches nothing more, yes brings both', async () => {
  const { w, get, here, accepted } = await world('ask');
  try {
    let r = await get(['shop'], { answers: ['n'] });
    assert.equal(r.code, 0, r.text);
    assert.ok(here('projects/shop'));
    assert.equal(r.asked.filter((q) => /Get them too, and let the sessions read them\?/.test(q)).length, 1, 'one question');
    assert.match(r.text, /shop also needs, to read: kits\/parts; and kits\/parts needs tools\. They are not on this computer\./);
    assert.match(r.text, /shop names "credentials" as a need: left out, because "credentials" is the credentials folder, which is never shared with another project/);
    assert.doesNotMatch(r.text, /extra folder|not got:/);
    assert.match(r.text, /shop's project\.json: needs: "\.\.\/x" is not a name of the workspace map/);
    assert.match(r.text, /not got and not allowed; later: {2}hoprig get kits\/parts tools {2}and {2}hoprig workspace needs allow shop kits\/parts {2}and {2}hoprig workspace needs allow kits\/parts tools/);
    assert.ok(!here('kits/parts') && !here('projects/tools'), 'a no brings nothing');
    assert.deepEqual(accepted(), {}, 'and allows nothing');
    r = await get(['shop'], { answers: ['y'] });
    assert.equal(r.code, 0, r.text);
    assert.ok(here('kits/parts') && here('projects/tools'), 'one yes brings all, each by the normal get');
    assert.deepEqual(accepted(), { shop: ['kits/parts'], 'kits/parts': ['tools'] }, 'the same yes lets their sessions read them, on this computer');
    assert.ok(!fs.readFileSync(path.join(w.root, 'alpha', 'Workspace', 'projects', 'shop', 'project.json'), 'utf8').includes('accepted'), 'never written into the project');
    // Now all is here: no question, a loop (parts needs shop, tools needs parts) asked nothing more.
    r = await get(['shop'], { answers: [] });
    assert.equal(r.asked.length, 0);
    assert.match(r.text, /every session in shop reads kits\/parts \(allowed on this computer; {2}hoprig workspace needs revoke shop <name> {2}takes that back\)\n/, 'only what is here: never the refused credentials');
  } finally {
    w.cleanup();
  }
});

test('get shop without a terminal, with --yes, with --dry-run: nothing more comes, the command is said; --with-needs brings them', async () => {
  const { w, get, here, accepted } = await world('quiet');
  try {
    let r = await get(['shop']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /nothing more was got or allowed \(no terminal to ask in\): hoprig get kits\/parts tools {2}and {2}hoprig workspace needs allow shop kits\/parts {2}and {2}hoprig workspace needs allow kits\/parts tools {2}\(or hoprig get shop --with-needs\)/);
    assert.ok(!here('kits/parts'));
    r = await get(['shop', '--yes']);
    assert.match(r.text, /--yes never brings or allows a need/);
    assert.ok(!here('kits/parts'));
    r = await get(['shop', '--json']);
    const shop = r.json.projects[0];
    assert.deepEqual(shop.needs, ['kits/parts', 'credentials'], '"../x" is left out by the project.json reader');
    assert.deepEqual(shop.missingNeeds, [{ name: 'kits/parts' }, { name: 'tools', of: 'kits/parts' }]);
    assert.equal(shop.needsCommand, 'hoprig get kits/parts tools');
    assert.deepEqual(shop.notAccepted, [{ name: 'kits/parts' }, { name: 'tools', of: 'kits/parts' }]);
    assert.deepEqual(shop.allowCommands, ['hoprig workspace needs allow shop kits/parts', 'hoprig workspace needs allow kits/parts tools']);
    assert.ok(!here('kits/parts'), '--json asks nothing and brings nothing');
    r = await get(['tools', '--dry-run']);
    assert.ok(!here('projects/tools'));
    assert.deepEqual(accepted(), {}, 'no terminal, --yes, --json and --dry-run allow nothing');
    r = await get(['shop', '--with-needs']);
    assert.equal(r.code, 0, r.text);
    assert.ok(here('kits/parts') && here('projects/tools'));
    assert.deepEqual(accepted(), { shop: ['kits/parts'], 'kits/parts': ['tools'] }, '--with-needs is the owner\'s typed yes');
  } finally {
    w.cleanup();
  }
});

test('a need of a need that only its project.json names (the map says nothing): named after the clone, brought by --with-needs, asked again in a terminal', async () => {
  const { w, get, here } = await world('deeper', { mapNeeds: false });
  try {
    // A fresh computer: kits/parts is only in the map, which has no "needs" for it; parts' project.json needs tools.
    let r = await get(['shop', '--with-needs']);
    assert.equal(r.code, 0, r.text);
    assert.ok(here('kits/parts') && here('projects/tools'), 'one --with-needs brings the need of the need too');
  } finally {
    w.cleanup();
  }
  const b = await world('deeper-ask', { mapNeeds: false });
  try {
    let r = await b.get(['shop']);
    assert.match(r.text, /nothing more was got or allowed \(no terminal to ask in\): hoprig get kits\/parts/);
    r = await b.get(['shop'], { answers: ['y', 'n'] });
    assert.ok(b.here('kits/parts'));
    assert.equal(r.asked.filter((q) => /Get it too, and let the sessions read/.test(q)).length, 2, 'asked again for what the clone named');
    assert.match(r.text, /kits\/parts also needs, to read: tools\. It is not on this computer\./);
    assert.match(r.text, /not got and not allowed; later: {2}hoprig get tools/);
    assert.ok(!b.here('projects/tools'), 'a no brings nothing');
  } finally {
    b.w.cleanup();
  }
});

test('the line for what is missing names a need of a need by whose it is, never as the project\'s own', async () => {
  const { needsWords } = await import('../../src/pcsetup/getproject.mjs');
  assert.equal(needsWords('shop', [{ name: 'docs', of: 'shop' }, { name: 'tools2', of: 'kits/parts' }]), 'shop also needs, to read: docs; and kits/parts needs tools2');
  assert.equal(needsWords('shop', [{ name: 'tools2', of: 'kits/parts' }]), 'kits/parts, which shop reads, needs: tools2');
  assert.equal(needsWords('shop', [{ name: 'a', of: 'kits/parts' }, { name: 'b', of: 'kits/parts' }, { name: 'c', of: 'docs' }]), 'kits/parts, which shop reads, needs: a, b; and docs needs c');
});

test('--with-needs --yes: --yes answers the set-up questions of what was named, never a need\'s install', { skip: process.platform === 'win32' }, async () => {
  // A stand-in npm first on the PATH that fails loudly: the runner below takes every install, so it never runs.
  const { stream } = await import('../../src/setup/system.mjs');
  const installs = [];
  const runner = (argv, o) => (argv[0] === 'git' ? stream(argv, o) : (installs.push({ argv, cwd: o.cwd }), Promise.resolve({ ok: true, code: 0, output: '' })));
  const { w, get, here } = await world('yes', { runner });
  const PATH = process.env.PATH;
  try {
    const trap = path.join(w.root, 'trap');
    fs.mkdirSync(trap);
    fs.writeFileSync(path.join(trap, 'npm'), '#!/bin/sh\necho "TRAP: npm $*" >&2\nexit 99\n', { mode: 0o755 });
    process.env.PATH = `${trap}${path.delimiter}${PATH}`;
    const seed = w.clone(w.url('parts'), path.join(w.root, 'seed-parts2'));
    w.commit(seed, 'package.json', JSON.stringify({ name: 'parts', scripts: { postinstall: 'echo hi' } }) + '\n');
    w.sh(seed, 'push', '-q');
    const r = await get(['shop', '--with-needs', '--yes']);
    assert.equal(r.code, 0, r.text);
    assert.ok(here('kits/parts'));
    assert.deepEqual(installs.filter((x) => x.cwd.includes(`${path.sep}parts`)), [], 'no install of the need ran');
    assert.match(r.text, /parts: run npm install\? \(installs its dependencies\) skipped: no terminal to answer in/);
    assert.doesNotMatch(r.text, /parts: run npm install\?[^\n]*yes \(--yes\)/);
  } finally {
    process.env.PATH = PATH;
    w.cleanup();
  }
});
