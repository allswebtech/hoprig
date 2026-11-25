// Field reports (src/field): nothing private can be in one, by construction, and the shape cannot grow a field or a
// free-text value without this test changing. Made-up names only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-field-')));
process.env.HOPRIG_STATE_DIR = path.join(root, 'state');
process.env.HOPRIG_CONFIG_DIR = path.join(root, 'config');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const { buildReport, makeReport, listReports, reportsDir, fieldRun, KEEP_MAX } = await import('../../src/field/report.mjs');
const shape = await import('../../src/field/shape.mjs');

// What a person would not want anyone else to read, in every form a run can carry it.
const SECRETS = [
  '/home/zoltan-brightwater', 'C:\\Users\\zoltan-brightwater', 'zoltan-brightwater', 'quasar-box-17',
  'zoltan@quasar-box-17', 'zoltan.brightwater@example.org', '203.0.113.77', '10.4.4.9',
  'sk-ant-api03-Xq7VhK2mP9wL4tR8nB3cF6dJ1gS5yA0eZ', 'ghp_Z9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF',
  'git@github.com:moonfield/orchard-shop.git', 'https://github.com/moonfield/orchard-shop', 'orchard-shop', 'moonfield',
  'npm ERR! code E404', 'fatal: could not read Username',
];

function privateRun() {
  const err = new Error(`clone of /home/zoltan-brightwater/Workspace/projects/orchard-shop failed: fatal: could not read Username for https://github.com/moonfield/orchard-shop (zoltan@quasar-box-17, zoltan.brightwater@example.org, 203.0.113.77)`);
  err.code = 'git@github.com:moonfield/orchard-shop.git';
  err.stack = `Error: npm ERR! code E404\n    at C:\\Users\\zoltan-brightwater\\x.js:1:1\n    at /home/zoltan-brightwater/y.mjs ${SECRETS.join(' ')}`;
  err.details = { code: 'sk-ant-api03-Xq7VhK2mP9wL4tR8nB3cF6dJ1gS5yA0eZ', path: '/home/zoltan-brightwater', host: 'quasar-box-17' };
  err.cause = new Error('ghp_Z9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF 10.4.4.9');
  err.status = 'orchard-shop';
  err.fieldClass = 'zoltan.brightwater@example.org';
  return {
    kind: 'get',
    steps: [
      { id: 'clone', end: 'failed', stepIns: 2, path: '/home/zoltan-brightwater', output: 'npm ERR! code E404' },
      { id: '/home/zoltan-brightwater/Workspace', end: 'ok' },
      { id: 'kit:orchard-shop', end: 'zoltan@quasar-box-17', stepIns: '3' },
      { id: 'zoltan.brightwater@example.org', end: 'by-hand', stepIns: 1.5 },
      { id: 'quasar-box-17', end: 'skipped', stepIns: -4 },
      { id: 'https://github.com/moonfield/orchard-shop', end: 'ok', stepIns: { valueOf: () => 9 } },
      { id: 'sk-ant-api03-Xq7VhK2mP9wL4tR8nB3cF6dJ1gS5yA0eZ', end: 'ok' },
      { id: '__proto__', end: 'ok' },
      { id: 'constructor', end: 'ok' },
    ],
    error: err,
    version: '0.3.3-zoltan+quasar-box-17',
    system: { os: 'linux zoltan-brightwater', arch: 'x64 quasar-box-17', node: 'v22.0.0 /home/zoltan-brightwater' },
    id: '/home/zoltan-brightwater',
    env: { HOME: '/home/zoltan-brightwater', USER: 'zoltan-brightwater', HOSTNAME: 'quasar-box-17', TOKEN: 'ghp_Z9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF' },
    home: '/home/zoltan-brightwater',
    host: 'quasar-box-17',
    repo: 'git@github.com:moonfield/orchard-shop.git',
    output: 'npm ERR! code E404\nfatal: could not read Username',
  };
}

test('A: a run full of paths, names, addresses, keys and printed lines leaves none of them in the written file', () => {
  const before = { ...process.env };
  Object.assign(process.env, { USER: 'zoltan-brightwater', HOSTNAME: 'quasar-box-17', LOGNAME: 'zoltan-brightwater' });
  try {
    const r = makeReport(privateRun());
    assert.ok(r, 'a report was made');
    const bytes = fs.readFileSync(path.join(reportsDir(), fs.readdirSync(reportsDir()).find((n) => n.includes(r.id))));
    const text = bytes.toString('utf8');
    for (const s of SECRETS) assert.equal(bytes.includes(Buffer.from(s)), false, `"${s}" is in the report:\n${text}`);
    // Also any piece of them that would still say something: the user's name, the host, the project, the key's start.
    for (const s of ['zoltan', 'brightwater', 'quasar', 'orchard', 'moonfield', 'sk-ant', 'ghp_', '@', '/home', 'Users', '203.0', 'E404', 'fatal']) {
      assert.equal(text.includes(s), false, `"${s}" is in the report:\n${text}`);
    }
    // What it does say is what a developer can act on.
    assert.equal(r.kind, 'get');
    assert.equal(r.outcome, 'failed');
    assert.equal(r.version, 'other');
    assert.deepEqual(r.system, { os: 'other', arch: 'other', node: 0 });
    assert.equal(r.steps[0].id, 'clone');
    assert.equal(r.steps[0].stepIns, 2);
    assert.ok(Buffer.byteLength(text) < 1024, `${Buffer.byteLength(text)} bytes`);
  } finally {
    for (const k of ['USER', 'HOSTNAME', 'LOGNAME']) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
  }
});

test('A: an error whose code is a path, a key or a message never becomes a class of its own', () => {
  for (const code of ['/home/zoltan-brightwater', 'ENOENT /home/zoltan-brightwater', 'toString', '__proto__', 'hasOwnProperty']) {
    const e = Object.assign(new Error('x'), { code });
    assert.ok(shape.CLASSES.includes(shape.classOf(e)), code);
    assert.equal(shape.classOf(e), 'other', code);
  }
  assert.equal(shape.classOf(Object.assign(new Error('/home/zoltan-brightwater: no such file'), { code: 'ENOENT' })), 'not-found');
  assert.equal(shape.classOf('zoltan@quasar-box-17'), 'other');
});

// The shape, written out here: a new field or a new free-text value cannot be added without this test changing.
const ALLOWED = {
  fields: ['format', 'id', 'time', 'kind', 'outcome', 'class', 'version', 'system', 'seconds', 'steps', 'stepsLeftOut'],
  system: ['os', 'arch', 'node'],
  step: ['id', 'end', 'stepIns'],
  kind: ['setup', 'server-setup', 'pc-setup', 'kit', 'get', 'adopt', 'drop', 'go-live', 'start', 'doctor'],
  outcome: ['ok', 'failed'],
  end: ['ok', 'failed', 'skipped', 'by-hand'],
  os: ['linux', 'darwin', 'win32', 'other'],
  arch: ['x64', 'arm64', 'other'],
  class: ['none', 'network', 'timeout', 'not-found', 'permission', 'disk-full', 'port-in-use', 'missing-program',
    'program-failed', 'install-failed', 'build-tools', 'node-too-old', 'terminal-module', 'signin-needed', 'git-auth',
    'git-conflict', 'git-not-clean', 'git-not-pushed', 'folder-in-the-way', 'config-broken', 'not-set-up', 'service-failed',
    'usage-limit', 'stopped', 'refused', 'open-to-network', 'other'],
  steps: [
    'node', 'app', 'config', 'dir-config', 'dir-profiles', 'dir-state', 'command', 'claude', 'login', 'profile',
    'profiles', 'terminal', 'pty', 'password', 'https', 'access', 'service', 'port', 'rules', 'summary', 'pc',
    'git', 'workspace', 'project', 'skills', 'skills-updates', 'skill', 'skill-update', 'disk', 'kit', 'basics', 'python',
    'github', 'extras', 'docker', 'php', 'fvm', 'flutter', 'android', 'curl', 'unzip', 'build', 'tmux', 'gh', 'ripgrep', 'jq', 'npm',
    'pip', 'venv', 'composer', 'mariadb', 'identity', 'signin', 'projects', 'tools', 'find', 'clone', 'env',
    'hooks', 'memory', 'install', 'setup', 'check', 'commit', 'push', 'remove', 'map', 'brain', 'plan', 'copy',
    'proof', 'sessions', 'download',
    'restart', 'health', 'tool', 'provider', 'folder', 'launch', 'other'
  ],
};

test('B: the shape\'s fields and each field\'s values are exactly the allow-list of this test', () => {
  assert.deepEqual([...shape.FIELDS], ALLOWED.fields);
  assert.deepEqual([...shape.SYSTEM_FIELDS], ALLOWED.system);
  assert.deepEqual([...shape.STEP_FIELDS], ALLOWED.step);
  assert.deepEqual([...shape.KINDS], ALLOWED.kind);
  assert.deepEqual([...shape.OUTCOMES], ALLOWED.outcome);
  assert.deepEqual([...shape.ENDS], ALLOWED.end);
  assert.deepEqual([...shape.OSES], ALLOWED.os);
  assert.deepEqual([...shape.ARCHES], ALLOWED.arch);
  assert.deepEqual([...shape.CLASSES], ALLOWED.class);
  assert.deepEqual([...shape.STEPS], ALLOWED.steps);
});

const valueOk = (r) => {
  assert.deepEqual(Object.keys(r), ALLOWED.fields);
  assert.equal(r.format, 1);
  assert.match(r.id, /^[0-9a-f]{16}$/);
  assert.match(r.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(ALLOWED.kind.includes(r.kind));
  assert.ok(ALLOWED.outcome.includes(r.outcome));
  assert.ok(ALLOWED.class.includes(r.class));
  assert.ok(r.version === 'other' || /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(r.version), r.version);
  assert.deepEqual(Object.keys(r.system), ALLOWED.system);
  assert.ok(ALLOWED.os.includes(r.system.os) && ALLOWED.arch.includes(r.system.arch) && Number.isInteger(r.system.node));
  assert.ok(Number.isInteger(r.seconds) && Number.isInteger(r.stepsLeftOut));
  for (const s of r.steps) {
    assert.deepEqual(Object.keys(s), ALLOWED.step);
    assert.ok(shape.STEPS.includes(s.id) && ALLOWED.end.includes(s.end) && Number.isInteger(s.stepIns));
  }
};

test('B: every report made holds only allowed values, whatever it was given', () => {
  valueOk(buildReport(privateRun()));
  valueOk(buildReport({ kind: 'doctor', steps: [{ id: 'pty', end: 'failed' }], error: 'terminal-module', version: '0.3.3', system: { os: 'linux', arch: 'x64', node: '22.11.0' } }));
  valueOk(buildReport({ kind: 'setup', steps: Array.from({ length: 40 }, (_, i) => ({ id: i % 7 ? 'node' : 'pty', end: i % 7 ? 'ok' : 'failed' })) }));
  assert.equal(buildReport({ kind: 'deploy' }), null, 'a kind off the list makes no report');
  assert.equal(buildReport({ kind: '__proto__' }), null);
});

test('B: the reader refuses anything that is not exactly what the maker writes', () => {
  const r = buildReport({ kind: 'drop', steps: [{ id: 'push', end: 'failed', stepIns: 1 }], error: { code: 'ECONNREFUSED' }, version: '0.3.3', system: { os: 'linux', arch: 'x64', node: '22.1.0' } });
  const text = shape.reportText(r);
  assert.deepEqual(shape.strictReport(text), r);
  const edits = [
    text.replace('"kind": "drop"', '"kind": "drop /home/zoltan-brightwater"'),
    text.replace('"class": "network"', '"class": "network", "note": "orchard-shop"'),
    text.replace('"class": "network"', '"class": "network",\n  "class": "other"'),
    text.replace('"stepsLeftOut": 0', '"stepsLeftOut": 0,\n  "__proto__": {"x": 1}'),
    text.replace('"stepIns":1', '"stepIns":"1"'),
    text.replace('"node":22', '"node":"22"'),
    text.replace('"id":"push"', '"id":"zoltan"'),
    text.replace('  "kind"', '   "kind"'),
    text.replace('"version": "0.3.3"', '"version": "0.3.3-quasar"'),
    text + ' '.repeat(1100),
    // A field of text given as a one-item array or as a number: String() of either passes the pattern.
    shape.reportText({ ...r, time: [r.time] }),
    shape.reportText({ ...r, id: 1234567890123456 }),
    '[]', 'null', '',
  ];
  for (const e of edits) {
    assert.notEqual(e, text, 'the edit changed something');
    assert.equal(shape.strictReport(e), null, e);
  }
});

test('reports are kept: one small file each, the newest KEEP_MAX, and a hand-edited file is not read', () => {
  const dir = reportsDir();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < KEEP_MAX + 5; i++) makeReport({ kind: 'start', steps: [{ id: 'launch', end: 'ok' }], startedAt: t0 + i * 1000, endedAt: t0 + i * 1000 + 3000 });
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, KEEP_MAX);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size < 1024);
  const first = files.sort()[0];
  fs.appendFileSync(path.join(dir, first), '\n');
  const { reports, notRead } = listReports();
  assert.equal(notRead, 1);
  assert.equal(reports.length, KEEP_MAX - 1);
});

test('a failure to make a report is swallowed and changes nothing', () => {
  const before = process.env.HOPRIG_STATE_DIR;
  const file = path.join(root, 'a-file');
  fs.writeFileSync(file, 'x');
  process.env.HOPRIG_STATE_DIR = file; // a file where the folder would be
  try {
    assert.equal(makeReport({ kind: 'doctor', steps: [] }), null);
    const run = fieldRun('get');
    run.step('clone', 'ok');
    assert.equal(run.done(), null);
    assert.equal(run.done(), null, 'done twice makes nothing more');
  } finally {
    process.env.HOPRIG_STATE_DIR = before;
  }
});
