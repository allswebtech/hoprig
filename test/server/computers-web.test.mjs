// The Computers pages (web/computers.js, web/pc.js, the Setup part of web/pcsetup.js): one list of computers, Add a
// computer by situation, and one computer's page in three parts. The pure parts are tested here; the pages
// themselves are driven in a headless browser on the demo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

// Just enough of a DOM for the modules to load (lib.js h(), shell.js's navigation made at load).
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, children: [] });
  }
  setAttribute() {}
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => t,
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const { PARTS, processList, reachOf, upFor, osName, busyFigures, diskName } = await import('../../web/pc.js');
const { computerLine } = await import('../../web/computers.js');
const { setupSummary } = await import('../../web/pcsetup.js');

test('one computer: three parts, each with its own address and one sentence', () => {
  assert.deepEqual(PARTS.map((p) => [p.id, p.title]), [['', 'Overview'], ['setup', 'Setup'], ['advanced', 'Advanced']]);
  for (const p of PARTS) assert.match(p.text, /^[A-Z][^.]*\.$/, `${p.title}: one sentence`);
  // Home → Get started still lands on Setup
  assert.match(src('getstarted.js'), /'pc\/setup': '#\/computer\/setup'/);
});

test('Advanced: the busiest and the largest programs as ONE list, sorted by CPU or memory', () => {
  const p = (pid, cpu, rss) => ({ pid, cpu, rss, name: `p${pid}` });
  const d = { topCpu: [p(1, 50, 10), p(2, 20, 30), p(3, NaN, 5)], topMem: [p(2, 20, 30), p(4, 1, 900)] };
  assert.deepEqual(processList(d, 'cpu').map((x) => x.pid), [1, 2, 4, 3], 'each once; no CPU figure goes last');
  assert.deepEqual(processList(d, 'mem').map((x) => x.pid), [4, 2, 1, 3]);
  assert.deepEqual(processList({}, 'cpu'), []);
});

test('Overview: whether the computer can be reached from anywhere, in plain words', () => {
  const s = (host, publicUrl = '') => ({ network: { host, port: 7433 }, server: { publicUrl } });
  assert.equal(reachOf(s('127.0.0.1')).level, 'local');
  assert.match(reachOf(s('127.0.0.1')).text, /public link/);
  assert.equal(reachOf(s('0.0.0.0')).level, 'network');
  assert.match(reachOf(s('0.0.0.0')).text, /port 7433/);
  assert.equal(reachOf(s('127.0.0.1', 'https://pc.example.net')).level, 'anywhere');
  // From GET /api/public-link: the kind and its address once it is on.
  const temp = reachOf(s('127.0.0.1'), { on: true, kind: 'temporary', state: 'on', url: 'https://a-b.trycloudflare.com' });
  assert.equal(temp.level, 'anywhere');
  assert.match(temp.text, /a-b\.trycloudflare\.com/);
  assert.match(temp.text, /changes whenever Hoprig or the computer restarts/);
  assert.deepEqual(reachOf(s('127.0.0.1'), { on: true, kind: 'custom', state: 'on', url: 'https://pc.example.com' }), { level: 'anywhere', text: 'Through its public link https://pc.example.com (Custom).' });
  assert.match(reachOf(s('127.0.0.1'), { on: true, kind: 'custom', state: 'starting', url: null }).text, /once it is connected/);
  assert.equal(reachOf(s('127.0.0.1'), { on: false, kind: 'temporary', state: 'off' }).level, 'local');
  // On but not working: never "from anywhere".
  for (const state of ['error', 'retrying', 'blocked']) {
    const r = reachOf(s('127.0.0.1'), { on: true, kind: 'temporary', state, url: null });
    assert.equal(r.level, 'local', state);
    assert.match(r.text, /is on but/, state);
  }
  assert.equal(reachOf(s('0.0.0.0'), { on: true, kind: 'custom', state: 'error', url: null }).level, 'network');
  assert.equal(reachOf(s('127.0.0.1'), null).level, 'local', 'an older computer without the route');
  for (const f of ['pc.js', 'settings.js', 'computers.js', 'gateways.js']) assert.doesNotMatch(src(f), /Tailscale|SSH tunnel/, `${f}: the public link is the way from anywhere`);
  assert.equal(upFor(3 * 86400 + 5 * 3600 + 120), '3 d 5 h');
  assert.equal(upFor(3600 + 120), '1 h 2 min');
  assert.equal(upFor(NaN), '');
  assert.equal(osName('darwin'), 'macOS');
});

test('Setup: one sentence of result, what to fix first, the fine ones counted', () => {
  const c = (id, status, extra = {}) => ({ id, group: 'kit:node', label: id, status, detail: '', ...extra });
  let r = setupSummary([c('a', 'ok'), c('b', 'fail', { fixKit: 'node' }), c('c', 'warn', { fixKit: 'python' }), c('d', 'info'), c('e', 'fail', { group: 'projects' })]);
  assert.equal(r.text, '2 things to fix');
  assert.deepEqual(r.fix.map((x) => x.id), ['b', 'c']);
  assert.deepEqual(r.fine.map((x) => x.id), ['a', 'd'], 'an "info" without anything to do is fine; projects are not part of Setup');
  r = setupSummary([c('a', 'ok'), c('rules', 'info', { action: 'rules' }), c('docker', 'info', { fixKit: 'docker', label: 'Docker' })]);
  assert.equal(r.text, 'Everything needed is installed', 'an optional extra is never something to fix');
  assert.deepEqual(r.optional.map((x) => x.id), ['rules', 'docker'], 'it is offered apart, with its button');
  assert.deepEqual(r.fix, []);
  assert.equal(setupSummary([c('a', 'ok')]).text, 'Everything needed is installed');
});

test('the list: one row per computer with its state, system, sessions and Claude Code', () => {
  const s = { machine: null, machineLabel: 'Desk', status: 'online', sessions: [{}, {}] };
  assert.deepEqual(computerLine(s, null), { online: true, first: 'Online · 2 sessions', claude: '…' }, 'the second line is there before the details arrive');
  assert.deepEqual(computerLine(s, { platform: 'linux', claude: '2.1.0' }), { online: true, first: 'Online · Linux · 2 sessions', claude: 'Claude Code 2.1.0' });
  assert.equal(computerLine(s, { platform: 'linux', claude: '2.1.0' }, '2.2.0').claude, 'Claude Code 2.1.0 · version 2.2.0 is out');
  assert.equal(computerLine({ ...s, sessions: [{}] }, { claude: null }).claude, 'Claude Code not installed');
  const off = computerLine({ machine: 'nas', machineLabel: 'NAS', status: 'offline', error: 'It does not answer.' }, { platform: 'linux', claude: null });
  assert.deepEqual(off, { online: false, first: 'Offline · Linux', claude: 'It does not answer.' }, 'no session count and no "not installed" for a computer that does not answer');
});

test('the pages: one list, Add a computer by situation, Rename/Test/Remove on the computer\'s own page', () => {
  const list = src('computers.js');
  assert.doesNotMatch(list, /Open a computer|Your computers/, 'the computers appear once');
  assert.match(list, /primary: \{ label: 'Add a computer', icon: 'plus', href: '#\/computers\/add' \}/);
  for (const t of ['I can reach it by SSH from this computer', 'It is at home or behind a router and cannot be reached from here', 'It has an address (the same network, or its public link)']) assert.ok(list.includes(t), t);
  assert.match(list, /fold\('computers-add', 'Advanced'/, 'the rare things are under a closed Advanced');
  assert.doesNotMatch(list, /\/rename|\/remove|\/test`/, 'renaming, testing and removing live on the computer\'s page');
  const pc = src('pc.js');
  for (const r of ['/rename', '/remove', '/test', '/api/pc/power']) assert.ok(pc.includes(r), r);
  assert.match(pc, /title: `\$\{label\} \$\{who\}\?`/, 'the power confirmation names the computer');
  for (const f of ['computers.js', 'pc.js', 'pcsetup.js']) {
    const visible = src(f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.doesNotMatch(visible, /'[^']*\bhoprig\b[^']*'/, `${f}: the name comes from brand.js`);
    assert.doesNotMatch(visible, /'[^'\n]*\b(PC|[Pp]rofiles?)\b[^'\n]*'/, `${f}: "computer" and "account"`);
  }
  const css = src('page-computers.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, , sel] of css.matchAll(/(^|})\s*([^{}@]+)\{/g)) {
    for (const part of sel.split(',')) assert.match(part.trim(), /(^|\s|>)\.(cp-|pcsetup)/, `page-computers.css: "${part.trim()}" carries the page's prefix`);
  }
});

test('Overview: how busy in plain words first, the raw load second; the system disk is the main disk', () => {
  const b = busyFigures([1.8, 1.5, 1.2], 10);
  assert.deepEqual([b.word, b.value, b.sub], ['Calm', '18%', '18% · load 1.80 on 10 CPUs']);
  assert.match(b.title, /1\.80, 1\.50, 1\.20/);
  assert.equal(busyFigures([9.5, 0, 0], 10).word, 'Very busy');
  assert.equal(diskName('/'), 'Main disk');
  assert.equal(diskName('C:\\'), 'Main disk');
  assert.equal(diskName('/data'), '/data');
  for (const l of [reachOf({ server: { publicUrl: 'https://x.example' }, network: {} })]) assert.doesNotMatch(l.text, /^Yes/, 'the title says yes once');
});
