// The encrypted move of credentials between the owner's computers (credmove.mjs, credweb.mjs): the four legs on three
// made-up computers in temporary homes (alpha sends, gamma receives, delta is another), the marker value searched for in
// every answer, every log, every Activity line, every file of both state folders and the bytes the main computer relays.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { dropWorld, reset } from './dropfix.mjs';

const w = await dropWorld('credmove', { labels: ['alpha', 'gamma', 'delta'] });
const [A, C, D] = w.computers;
test.after(() => w.cleanup());
const VALUE = 'MARKVALUE-credmove-7e31';
const NAME = 'markname-credmove-c3d9.env';
const OTHER = 'MARKOTHER-credmove-91ab';
const label = (c) => c.home.split(path.sep).pop();
const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
const K = await import('../../src/workspace/transferkeys.mjs');
const { writeOwnFile } = await import('../../src/workspace/computer.mjs');

const clock = { t: Date.now() };
const features = new Map();
const feature = (c) => {
  if (!features.has(c)) features.set(c, workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: (req) => req.by || 'page' }, { dir: c.ws, projectsDir: () => c.projects, now: () => clock.t }));
  return features.get(c);
};
const said = [];
/** A call to a leg on computer `c`: `raw`: the bytes of an upload; `by`: who the server says asks. */
async function call(c, method, url, body, { by = 'page', headers = {}, raw } = {}) {
  c.use();
  const route = feature(c).routes.find(([m, re]) => m === method && re.test(url.split('?')[0]));
  assert.ok(route, `a route for ${method} ${url}`);
  const req = raw ? Object.assign(Readable.from([raw]), { headers: { ...headers, 'content-length': String(raw.length) }, by }) : { body, by, headers };
  try {
    const r = await route[2](req, null, new URLSearchParams(url.split('?')[1] || ''));
    said.push(JSON.stringify(r, (k, v) => (k === 'sealed' ? undefined : v)));
    return { status: 200, json: r };
  } catch (e) {
    said.push(`${e.status} ${e.message}`);
    return { status: e.status || 500, message: e.message, code: e.code };
  }
}
const MOVE = '/api/workspace/credmove';
const brainFile = (c) => path.join(c.brain, 'computers', `${label(c)}.json`);

// The projects: shop on alpha and gamma, naming one credential file; the credentials of alpha.
await reset(A);
await reset(C);
for (const c of [A, C]) {
  const pj = path.join(c.shop, 'project.json');
  const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
  fs.writeFileSync(pj, JSON.stringify({ ...j, credentials: { 'code/shop-api/.env': `shop/${NAME}` } }, null, 2));
}
const cdir = path.join(A.ws, 'credentials');
fs.mkdirSync(path.join(cdir, 'shop'), { recursive: true });
fs.mkdirSync(path.join(cdir, 'other'), { recursive: true });
fs.writeFileSync(path.join(cdir, 'shop', NAME), `API_KEY=${VALUE}\n`);
fs.writeFileSync(path.join(cdir, 'other', 'other.env'), `OTHER=${OTHER}\n`);
fs.symlinkSync('/etc/hostname', path.join(cdir, 'shop', 'a-link'));
fs.chmodSync(cdir, 0o700);

/** Each computer opens its page once (keys made, file written) and the brains are synced (the files copied across). */
async function publishAll() {
  for (const c of [A, C, D]) {
    const r = await call(c, 'POST', `${MOVE}/expect`, {}); // a computer that is asked to receive makes its keys and writes its file
    assert.equal(r.status, 200, JSON.stringify(r));
  }
  for (const from of [A, C, D]) for (const to of [A, C, D]) if (from !== to) fs.copyFileSync(brainFile(from), path.join(to.brain, 'computers', `${label(from)}.json`));
}
await publishAll();

/** The whole move of one scope from `from` to `to`. → { exp, pk, sealed, dry, real } (real only when `go`) */
async function move(from, to, { go = true, replace = false, scope = { project: 'shop' }, extra = {}, rawChange } = {}) {
  const exp = await call(to, 'POST', `${MOVE}/expect`, { from: label(from) });
  assert.equal(exp.status, 200, JSON.stringify(exp));
  const pk = await call(from, 'POST', `${MOVE}/pack`, { to: label(to), nonce: exp.json.nonce, ...scope, ...extra });
  if (pk.status !== 200) {
    if (!extra.expectRefused) assert.fail(`pack: ${JSON.stringify(pk)}`);
    return { exp, pk };
  }
  let sealed = Buffer.from(pk.json.sealed, 'base64');
  if (rawChange) sealed = rawChange(sealed);
  captured.push(sealed);
  const dry = await call(to, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: sealed });
  if (!go || dry.status !== 200) return { exp, pk, sealed, dry };
  const real = await call(to, 'POST', `${MOVE}/upload?seen=${dry.json.seen}${replace ? '&replace=1' : ''}`, undefined, { raw: sealed });
  return { exp, pk, sealed, dry, real };
}
const captured = [];
const modeOf = (p) => fs.statSync(p).mode & 0o777;

test('a project moves from alpha to gamma: files 600 in 700, the link made, nothing else sent', async () => {
  const r = await move(A, C);
  assert.equal(r.real.status, 200, JSON.stringify(r.real));
  assert.equal(r.pk.json.files, 1, 'one project: exactly the target of its link');
  const got = path.join(C.ws, 'credentials', 'shop', NAME);
  assert.equal(fs.readFileSync(got, 'utf8'), `API_KEY=${VALUE}\n`);
  assert.equal(fs.existsSync(path.join(C.ws, 'credentials', 'other')), false, 'the other project was not sent');
  assert.equal(fs.existsSync(path.join(C.ws, 'credentials', 'shop', 'a-link')), false);
  if (process.platform !== 'win32') {
    assert.equal(modeOf(got), 0o600);
    assert.equal(modeOf(path.dirname(got)), 0o700);
    assert.equal(modeOf(path.join(C.ws, 'credentials')), 0o700);
  }
  assert.equal(fs.readdirSync(path.join(C.ws, 'credentials')).some((n) => n.startsWith('.credmove-')), false, 'the temporary folder is gone');
  assert.equal(r.real.json.wrote, 1);
  assert.equal(r.real.json.linked, 1, 'the credential link of the project is made');
  assert.equal(fs.realpathSync(path.join(C.shop, 'code', 'shop-api', '.env')), fs.realpathSync(got));
});

test('the dry run names the files and sizes with their state, never a value or a hash', async () => {
  const r = await move(A, C, { go: false });
  assert.equal(r.dry.status, 200, JSON.stringify(r.dry));
  assert.deepEqual(r.dry.json.items, [{ p: `shop/${NAME}`, size: `API_KEY=${VALUE}\n`.length, state: 'same' }]);
  assert.equal(JSON.stringify(r.dry.json).includes(VALUE), false);
  assert.equal(/[0-9a-f]{40}/.test(JSON.stringify(r.dry.json.items)), false, 'no hash of a file');
  assert.equal(r.dry.json.dryRun, true);
  // a dry run writes nothing and uses no nonce: the same message can still be received for real
  const again = await call(C, 'POST', `${MOVE}/upload?seen=${r.dry.json.seen}`, undefined, { raw: r.sealed });
  assert.equal(again.status, 200, JSON.stringify(again));
});

test('a different file is not replaced without the second press', async () => {
  const got = path.join(C.ws, 'credentials', 'shop', NAME);
  fs.writeFileSync(got, 'API_KEY=their-own-value\n');
  const r = await move(A, C);
  assert.equal(r.dry.json.items[0].state, 'different');
  assert.equal(r.dry.json.differ, 1);
  assert.equal(r.real.status, 200);
  assert.equal(r.real.json.kept, 1);
  assert.equal(r.real.json.wrote, 0);
  assert.equal(fs.readFileSync(got, 'utf8'), 'API_KEY=their-own-value\n', 'left as it was');
  const second = await move(A, C, { replace: true });
  assert.equal(second.real.json.replaced, 1);
  assert.equal(fs.readFileSync(got, 'utf8'), `API_KEY=${VALUE}\n`);
});

test('everything moves too: all of the folder, never its git folder or a link', async () => {
  fs.mkdirSync(path.join(cdir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(cdir, '.git', 'config'), `[x]\n y = ${VALUE}\n`);
  const r = await move(A, D, { scope: { all: true } });
  assert.equal(r.real.status, 200, JSON.stringify(r.real));
  const names = r.dry.json.items.map((i) => i.p).sort();
  assert.deepEqual(names, ['other/other.env', `shop/${NAME}`]);
  assert.equal(r.pk.json.skipped, 1, 'the link inside the folder was left out and counted');
  assert.equal(fs.existsSync(path.join(D.ws, 'credentials', '.git')), false);
  fs.rmSync(path.join(cdir, '.git'), { recursive: true });
});

test('a reused nonce and an expired nonce are each refused', async () => {
  const r = await move(A, C);
  assert.equal(r.real.status, 200);
  const again = await call(C, 'POST', `${MOVE}/upload?seen=${r.dry.json.seen}`, undefined, { raw: r.sealed });
  assert.equal(again.status, 403, JSON.stringify(again));
  assert.equal(again.code, 'nonce');
  // expired: the move is made, six minutes pass
  const x = await move(A, C, { go: false });
  clock.t += 6 * 60 * 1000;
  const late = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: x.sealed });
  clock.t -= 6 * 60 * 1000;
  assert.equal(late.status, 403, JSON.stringify(late));
  assert.equal(late.code, 'nonce');
  // a nonce made for another sender is no use to alpha
  const exp = await call(C, 'POST', `${MOVE}/expect`, { from: 'delta' });
  const pk = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop' });
  const wrong = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: Buffer.from(pk.json.sealed, 'base64') });
  assert.equal(wrong.status, 403, JSON.stringify(wrong));
  // a nonce nobody made
  const made = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: 'a'.repeat(32), project: 'shop' });
  const nobody = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: Buffer.from(made.json.sealed, 'base64') });
  assert.equal(nobody.code, 'nonce');
});

test('a message for gamma, sent to delta, is refused; so is one that was changed', async () => {
  const r = await move(A, C, { go: false });
  const wrong = await call(D, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: r.sealed });
  assert.equal(wrong.status, 403, JSON.stringify(wrong));
  assert.match(wrong.message, /not for this computer/);
  const m = JSON.parse(r.sealed.toString('utf8'));
  const c = Buffer.from(m.c, 'base64');
  c[0] ^= 1;
  const changed = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: Buffer.from(JSON.stringify({ ...m, c: c.toString('base64') })) });
  assert.equal(changed.status, 403, JSON.stringify(changed));
  const s = Buffer.from(m.s, 'base64');
  s[0] ^= 1;
  const bad = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: Buffer.from(JSON.stringify({ ...m, s: s.toString('base64') })) });
  assert.equal(bad.status, 403, JSON.stringify(bad));
  // and nothing of it was written
  assert.equal(fs.readdirSync(path.join(C.ws, 'credentials')).some((n) => n.startsWith('.credmove-')), false);
});

test('a body larger than 8 MB is refused before it is read', async () => {
  const r = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: Buffer.alloc(8 * 1024 * 1024 + 1) });
  assert.equal(r.status, 413);
});

test('something in the way is never replaced: a link, a folder', async () => {
  const dir = path.join(C.ws, 'credentials', 'shop');
  const got = path.join(dir, NAME);
  fs.rmSync(got);
  fs.symlinkSync(path.join(C.home, 'elsewhere'), got);
  const r = await move(A, C);
  assert.equal(r.dry.json.items[0].state, 'blocked');
  assert.equal(r.real.status, 200);
  assert.equal(r.real.json.wrote, 0);
  assert.equal(fs.lstatSync(got).isSymbolicLink(), true, 'the link is still there');
  assert.equal(fs.existsSync(path.join(C.home, 'elsewhere')), false, 'nothing was written through it');
  fs.rmSync(got);
  fs.writeFileSync(got, `API_KEY=${VALUE}\n`, { mode: 0o600 });
});

test('a changed key blocks sending until Trust', async () => {
  // gamma makes new keys; its file reaches alpha's brain
  C.use();
  fs.rmSync(K.keysFile());
  await call(C, 'POST', `${MOVE}/expect`, {});
  fs.copyFileSync(brainFile(C), path.join(A.brain, 'computers', 'gamma.json'));
  const exp = await call(C, 'POST', `${MOVE}/expect`, {});
  const blocked = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop' });
  assert.equal(blocked.status, 409, JSON.stringify(blocked));
  assert.equal(blocked.code, 'key-changed');
  const page = await call(A, 'GET', MOVE);
  assert.equal(page.json.peers.find((p) => p.label === 'gamma').key, 'changed');
  const t = await call(A, 'POST', `${MOVE}/trust`, { label: 'gamma' });
  assert.equal(t.status, 200, JSON.stringify(t));
  const ok = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  // the receiver also holds alpha to its pinned key
  fs.copyFileSync(brainFile(C), path.join(D.brain, 'computers', 'gamma.json'));
  A.use();
  fs.rmSync(K.keysFile());
  await call(A, 'POST', `${MOVE}/expect`, {});
  fs.copyFileSync(brainFile(A), path.join(C.brain, 'computers', 'alpha.json'));
  const e2 = await call(C, 'POST', `${MOVE}/expect`, {});
  fs.copyFileSync(brainFile(C), path.join(A.brain, 'computers', 'gamma.json'));
  const p2 = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: e2.json.nonce, project: 'shop' });
  assert.equal(p2.status, 200, JSON.stringify(p2));
  const stop = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: Buffer.from(p2.json.sealed, 'base64') });
  assert.equal(stop.status, 409, JSON.stringify(stop));
  assert.equal(stop.code, 'key-changed');
  assert.equal((await call(C, 'POST', `${MOVE}/trust`, { label: 'alpha' })).status, 200);
  const go = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: Buffer.from(p2.json.sealed, 'base64') });
  assert.equal(go.status, 200, JSON.stringify(go));
});

test('a computer without a key in the brain is unknown until its key is shown and trusted', async () => {
  const none = await call(A, 'POST', `${MOVE}/pack`, { to: 'nobody', nonce: 'b'.repeat(32), project: 'shop' });
  assert.equal(none.status, 409);
  assert.equal(none.code, 'key-unknown');
  const bad = await call(A, 'POST', `${MOVE}/trust`, { label: 'nobody', offered: { id: 'x' } });
  assert.equal(bad.status, 400);
});

test('a computer whose file has not reached the brain yet is unknown: keys that came over the link are not taken', async () => {
  const file = path.join(A.brain, 'computers', 'gamma.json');
  const keep = fs.readFileSync(file);
  fs.rmSync(file);
  fs.rmSync(path.join(A.env.HOPRIG_STATE_DIR, 'transfer-pins.json'));
  const exp = await call(C, 'POST', `${MOVE}/expect`, {});
  const none = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop' });
  assert.equal(none.code, 'key-unknown');
  // whoever is on the way swaps the keys of the answer for its own: Trust takes nothing from it, the page may not even send it
  const x = crypto.generateKeyPairSync('x25519');
  const e = crypto.generateKeyPairSync('ed25519');
  const spki = (k) => k.export({ format: 'der', type: 'spki' }).toString('base64');
  const swapped = { id: exp.json.id, x25519: spki(x.publicKey), ed25519: spki(e.publicKey) };
  assert.equal((await call(A, 'POST', `${MOVE}/trust`, { label: 'gamma', offered: swapped })).status, 400);
  assert.equal((await call(A, 'POST', `${MOVE}/trust`, { label: 'gamma' })).code, 'key-unknown');
  const still = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop' });
  assert.equal(still.status, 409, 'nothing was sealed');
  assert.equal(still.code, 'key-unknown');
  // once the brain carries its file, it works
  fs.writeFileSync(file, keep);
  const ok = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
});

test('a computer that is not the owner\'s own gets no everything, and a project only with its name typed', async () => {
  // gamma says it is not his own (its own page), and the mark reaches alpha through the brain
  const own = await call(C, 'POST', `${MOVE}/own`, { own: false });
  assert.equal(own.status, 200, JSON.stringify(own));
  assert.equal(JSON.parse(fs.readFileSync(brainFile(C), 'utf8')).own, false);
  fs.copyFileSync(brainFile(C), path.join(A.brain, 'computers', 'gamma.json'));
  fs.copyFileSync(brainFile(C), path.join(D.brain, 'computers', 'gamma.json'));
  const peers = (await call(A, 'GET', MOVE)).json.peers;
  assert.equal(peers.find((p) => p.label === 'gamma').own, false);
  const exp = await call(C, 'POST', `${MOVE}/expect`, {});
  const everything = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, all: true, typed: 'gamma' });
  assert.equal(everything.status, 403, JSON.stringify(everything));
  assert.equal(everything.code, 'not-own');
  const untyped = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop' });
  assert.equal(untyped.status, 400);
  assert.equal(untyped.code, 'type-name');
  const wrongName = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop', typed: 'delta' });
  assert.equal(wrongName.code, 'type-name');
  const ok = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, project: 'shop', typed: 'gamma' });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  // the receiver is not trusting the sender to know: a message for everything is refused there too
  const sealedAll = await (async () => {
    await call(C, 'POST', `${MOVE}/own`, { own: true });
    fs.copyFileSync(brainFile(C), path.join(A.brain, 'computers', 'gamma.json'));
    const e = await call(C, 'POST', `${MOVE}/expect`, {});
    const p = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: e.json.nonce, all: true });
    assert.equal(p.status, 200, JSON.stringify(p));
    await call(C, 'POST', `${MOVE}/own`, { own: false });
    return Buffer.from(p.json.sealed, 'base64');
  })();
  const there = await call(C, 'POST', `${MOVE}/upload?dryRun=1`, undefined, { raw: sealedAll });
  assert.equal(there.status, 403, JSON.stringify(there));
  assert.equal(there.code, 'not-own');
  await call(C, 'POST', `${MOVE}/own`, { own: true });
  fs.copyFileSync(brainFile(C), path.join(A.brain, 'computers', 'gamma.json'));
});

test('this main computer\'s own mark of a computer it controls blocks everything too', async () => {
  A.use();
  fs.mkdirSync(process.env.HOPRIG_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_CONFIG_DIR, 'machines.json'), JSON.stringify({ machines: [{ name: 'rented', token: 'x', via: 'url', url: 'https://rented.example.test' }] }));
  const { publicMachine, getMachine } = await import('../../src/machines/store.mjs');
  assert.equal(publicMachine(getMachine('rented')).own, true, 'his own until he says otherwise');
  assert.equal((await call(A, 'POST', `${MOVE}/mark`, { machine: 'rented', own: false })).status, 200);
  assert.equal(publicMachine(getMachine('rented')).own, false);
  assert.equal(getMachine('rented').own, false);
  const exp = await call(C, 'POST', `${MOVE}/expect`, {});
  const r = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, all: true, machine: 'rented' });
  assert.equal(r.code, 'not-own', JSON.stringify(r));
  const own = await call(A, 'POST', `${MOVE}/pack`, { to: 'gamma', nonce: exp.json.nonce, all: true, machine: 'rented', typed: 'gamma' });
  assert.equal(own.code, 'not-own');
  assert.equal((await call(A, 'POST', `${MOVE}/mark`, { machine: 'nobody', own: false })).status, 404);
  assert.equal((await call(A, 'POST', `${MOVE}/mark`, { machine: 'rented', own: true })).status, 200);
  assert.equal(getMachine('rented').own, undefined);
});

test('a marker value is in no answer, no log, no Activity line, no file of a state folder, and not in what is relayed', async () => {
  const everything = said.join('\n');
  assert.equal(everything.includes(VALUE), false, 'a value in an answer');
  assert.equal(everything.includes(OTHER), false);
  assert.ok(captured.length > 3, 'the relayed bytes were captured');
  for (const b of captured) {
    const text = b.toString('latin1');
    const open = Buffer.from(JSON.parse(b.toString('utf8')).c, 'base64').toString('latin1');
    for (const t of [text, open]) {
      assert.equal(t.includes(VALUE), false, 'a value in the relayed bytes');
      assert.equal(t.includes(OTHER), false);
      assert.equal(t.includes(NAME), false, 'a file name in the relayed bytes');
    }
  }
  for (const c of [A, C, D]) {
    const all = allText(c.env.HOPRIG_STATE_DIR) + allText(c.env.HOPRIG_CONFIG_DIR) + allText(c.brain);
    assert.equal(all.includes(VALUE), false, `a value in the state of ${label(c)}`);
    assert.equal(all.includes(OTHER), false);
  }
  // the log says what moved in counts, with no file's name
  C.use();
  const log = fs.readFileSync(path.join(C.env.HOPRIG_STATE_DIR, 'credmove.log'), 'utf8');
  assert.match(log, /"leg":"receive"/);
  assert.equal(log.includes(NAME), false);
  assert.equal(JSON.parse(log.trim().split('\n').filter((l) => /"leg":"receive"/.test(l))[0]).result, 'ok');
  if (process.platform !== 'win32') assert.equal(modeOf(path.join(C.env.HOPRIG_STATE_DIR, 'credmove.log')), 0o600);
  const activity = fs.readFileSync(path.join(C.env.HOPRIG_STATE_DIR, 'automation.log'), 'utf8');
  assert.match(activity, /Credentials came from alpha/);
  A.use();
  assert.match(fs.readFileSync(path.join(A.env.HOPRIG_STATE_DIR, 'credmove.log'), 'utf8'), /"leg":"pack"/);
});

function allText(dir) {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath ?? e.path, e.name);
    if (e.isFile() && !p.includes(`${path.sep}.git${path.sep}`)) out += `\n${p}\n${fs.readFileSync(p, 'latin1')}`;
  }
  return out;
}
