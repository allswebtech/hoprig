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
  replaceChildren(...n) {
    this.children = n;
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
const { fixText } = await import('../../web/health.js');

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
  assert.equal(upFor(3 * 86400 + 5 * 3600 + 120), '3 days 5 h');
  assert.equal(upFor(86400 + 120), '1 day 0 h', 'one day, as the rest of the page writes it');
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
  assert.deepEqual(off, { online: false, first: 'Cannot be reached · open it to see what to check', claude: 'It does not answer.' }, 'no session count and no "not installed" for a computer that does not answer');
});

test('the pages: one list, Add a computer by situation, Rename/Test/Remove on the computer\'s own page', () => {
  const list = src('computers.js');
  assert.doesNotMatch(list, /Open a computer|Your computers/, 'the computers appear once');
  assert.match(list, /primary: \{ label: 'Add a computer', icon: 'plus', href: '#\/computers\/add' \}/);
  for (const t of ['I can reach it by SSH from this computer', 'It is at home or behind a router and cannot be reached from here', 'It has an address (the same network, or its public link)']) assert.ok(list.includes(t), t);
  // a laptop of his first; SSH is not offered as "the easiest way" to someone who does not know the word
  const ways = list.slice(list.indexOf('const WAYS'), list.indexOf('];', list.indexOf('const WAYS')));
  assert.ok(ways.indexOf("value: 'join'") < ways.indexOf("value: 'ssh'"), 'the way for a laptop comes first');
  assert.doesNotMatch(ways, /easiest/i);
  assert.match(ways, /A laptop or another computer of yours/);
  // no terminal step on the page where the page has its own way: the key file, and the pairing code on its page
  assert.doesNotMatch(list, /run once on this computer: ssh-copy-id|ssh-copy-id \$\{target\} sets that up/);
  assert.match(list, /choose "I have a key file for it" above/);
  assert.ok(list.indexOf('Let another computer add this one. (In a terminal there') > 0, 'the page way first, the command after it');
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

test('Add by SSH with a key file: the key is sent once and the field emptied before the answer; the print is confirmed by name', () => {
  const k = src('sshkey.js');
  const sent = k.indexOf("key.value = ''");
  assert.ok(sent > 0 && sent < k.indexOf("await api('~/api/machines/ssh/key', body)"), 'the field is emptied before the request is answered');
  assert.doesNotMatch(k, /localStorage|sessionStorage|console\.(log|error)/, 'the key is never kept or logged by the page');
  assert.match(k, /\/api\/machines\/ssh\/key\/confirm', \{ pending: s\.pending, print: s\.print, confirm: s\.name \}/);
  // Confirmed by name; the sentence of a root login goes with it only when typed (web/rootlogin.js).
  assert.match(k, /\/api\/machines\/ssh\/key\/install', \{ pending, confirm: s\.name, \.\.\.\(stayRoot \? \{ stayRoot \} : \{\}\), \.\.\.\(workUser \? \{ workUser \} : \{\}\) \}/, 'the root-login box\'s choice ({ name, noAdmin }) is sent as it is');
  assert.match(src('computers.js'), /byKey\(isAlive, added\)/, 'Add a computer → by SSH offers it');
});

test('Health: since when a computer is not reached, and the rules of its buttons', async () => {
  const { notReached } = await import('../../web/health.js');
  assert.equal(notReached('Box 2', null), 'Box 2 was never reached from here.');
  assert.match(notReached('Box 2', Date.now() - 3 * 3600_000), /^Box 2 was not reached since .+ \(3 h ago\)\.$|^Box 2 was not reached since .+\)\.$/);
  const hs = src('health.js');
  assert.doesNotMatch(hs, /setInterval|setTimeout\(load|setTimeout\(gateways/, 'read when opened or on Refresh, never on a timer');
  assert.match(hs, /confirm: d\.computer/, 'every press carries the computer\'s name');
  assert.match(hs, /href: r\.forward\.url, target: '_blank', rel: 'noopener noreferrer'/, 'a gateway\'s page opens at its own address');
  assert.doesNotMatch(hs, /<iframe|h\('iframe/, 'never inside the dashboard');
});

test('a Fix on Health always says what it runs there, and that it needs administrator rights when its plan does', () => {
  assert.equal(fixText({ admin: true, commands: ['sudo apt-get install -y gh'], fix: 'hoprig pc setup --kits github' }, 'box2'), 'This needs administrator rights on box2. It runs on box2: sudo apt-get install -y gh');
  assert.equal(fixText({ admin: false, commands: [], fix: 'hoprig pc setup --kits git' }, 'box2'), 'It runs on box2: hoprig pc setup --kits git');
});

test('Health says what lingering means in plain words; the word lingering stays only inside the command', () => {
  const s = src('health.js');
  assert.match(s, /start only after you log in there, not after a restart/);
  assert.match(s, /Let them start after a restart/);
  assert.doesNotMatch(s.replace(/\/\/.*$/gm, ''), /[`'"][^`'"]*\b[Ll]ingering\b/, 'no "lingering" in what the page says');
});

test('the hidden key file input shows its focus on its label button', () => {
  assert.match(src('sshkey.js'), /label\.btn\.secondary\.small\.cp-keybtn/);
  assert.match(src('page-computers.css'), /\.cp-keybtn:has\(\.cp-keyfile:focus-visible\)\s*\{[^}]*box-shadow/);
});

test('at a phone\'s width a Health check\'s name and reason wrap instead of being cut', () => {
  assert.match(src('page-computers.css'), /@media \(max-width: 640px\) \{ \.cp-health \.row-title, \.cp-health \.row-sub \{ white-space: normal;/);
});

test('during an add the server is called by the address typed, and Health calls an offline computer by its label', () => {
  const k = src('sshkey.js');
  assert.match(k, /shown: body\.host/);
  assert.doesNotMatch(k, /(label|title|text|ok): `[^`]*\$\{s\.name\}/, 'no inner name in what the page says');
  assert.match(src('health.js'), /unreachedWords\(r, r\.label \|\| ctx\.label\(\)\)/);
  assert.match(src('health.js'), /head: notReached\(label, r\.seenAt\)/);
  assert.match(src('health.js'), /head: `\$\{label\}: \$\{MACHINE_STATE\.unauthorised\}\.`/);
});

test('Health says where a command is typed, shows the service once, and the use-case page does not promise no terminal', () => {
  const s = src('health.js');
  assert.match(s, /Type this in a terminal on \$\{ctx\.label\(\)\}:/);
  assert.doesNotMatch(s, /'Fix there:'/);
  assert.match(s, /c\.id !== 'service'/);
  const uc = fs.readFileSync(path.join(WEB, '..', 'site', 'content', 'use-cases', 'server-from-the-dashboard.md'), 'utf8');
  assert.doesNotMatch(uc, /no terminal is needed/);
});

test('Health\'s banner lets its button go under the text on a phone instead of squeezing the text', () => {
  assert.match(src('page-computers.css'), /\.cp-health \.banner \{ flex-wrap: wrap;/);
  assert.match(src('page-computers.css'), /\.cp-health \.banner > span \{ flex: 1 1 220px;/);
});

test('Health shows why a computer was not reached, and says "on and online" only for one that is off', async () => {
  const { healthAdvanced } = await import('../../web/health.js');
  const { machine } = await import('../../web/lib.js');
  const words = (n) => (typeof n === 'string' ? n : (n.children || []).map(words).join(' '));
  const drawn = async (answer) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => answer });
    machine.set('box2');
    try {
      const el = healthAdvanced({ label: () => 'Box 2' });
      for (let i = 0; i < 20 && !words(el).includes('not reached'); i++) await new Promise((r) => setTimeout(r, 10));
      return words(el);
    } finally {
      machine.set(null);
      delete globalThis.fetch;
    }
  };
  const old = await drawn({ reached: false, state: 'too-old', label: 'Box 2', seenAt: Date.now() - 60_000, error: 'Box 2 runs a Hoprig too old for this. Update it there: hoprig update' });
  assert.match(old, /Box 2 was not reached since/);
  assert.match(old, /runs a Hoprig too old for this\. Update it there: hoprig update/, 'the hub\'s reason is shown');
  assert.doesNotMatch(old, /on and online/, 'no advice to switch on a computer that answered');
  const off = await drawn({ reached: false, state: 'offline', label: 'Box 2', seenAt: null, error: 'Box 2 cannot be reached by SSH: connection refused' });
  assert.match(off, /cannot be reached by SSH: connection refused/);
  assert.match(off, /Check that it is on and online/);
});

test('when sudo asks for a password, Health names the computer where the command is typed', () => {
  const s = src('health.js');
  assert.match(s, /Type this once in a terminal on \$\{d\.computer\}:/);
  assert.doesNotMatch(s, /in a terminal there/);
});

test('Open its page: the plain link uses a name the owner is not signed in under; a computer without SSH gets one sentence', async () => {
  const { plainHost, noForwardWords } = await import('../../web/health.js');
  assert.equal(plainHost('127.0.0.1', []), 'localhost');
  assert.equal(plainHost('localhost', []), '127.0.0.1');
  assert.equal(plainHost('127.0.0.1', ['localhost']), null, 'signed in under the other name too: no link that would carry it');
  assert.equal(plainHost('[::1]', ['localhost']), '127.0.0.1');
  assert.equal(plainHost('[::1]', []), 'localhost');
  const line = noForwardWords('Relay', 'Box 9', 8197);
  assert.equal(line, 'Relay\'s page cannot be opened from here, because Box 9 is linked to this dashboard without SSH and so this dashboard has no way to reach that page: open it in a browser on Box 9 itself, at http://127.0.0.1:8197/.');
  assert.equal(line.split('. ').length, 1, 'one sentence');
  const s = src('health.js');
  assert.match(s, /st\.via === 'other'\) return fill\(msg, .*noForwardWords\(/);
  assert.match(s, /plainHost\(location\.hostname, signedIn\)/);
});

test('Health at a phone\'s width: a check\'s button goes under its name, never beside a name squeezed to one word a line', () => {
  assert.match(src('page-computers.css'), /@media \(max-width: 640px\) \{ \.cp-health \.row > \.row-main \{ flex: 1 1 200px; \} \.cp-health \.row > a\.btn, \.cp-health \.row > button\.btn \{ margin-left: 44px; \} \}/);
});
