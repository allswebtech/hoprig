// What reading the provider stops does BY ITSELF in the real dashboard (createServer): a start and three ticks of the
// watcher, with a terminal session whose run record already holds an agent's stop and a gateway profile whose endpoint
// is a stand-in that fails this test when anything asks it. The look reads the record and makes the item; nothing is
// started, nothing asks a provider, and nothing in the home changes but what is listed below.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';

const posix = process.platform !== 'win32';

/** Every file under `root` → a hash of its content and its time. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(root);
  return out;
}
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

test('the start and three ticks read an agent\'s stop into an item: nothing is started, no provider is asked, nothing is written', { timeout: 90_000, skip: !posix && 'the stand-ins are POSIX' }, async (t) => {
  const w = tempWork('operator-providers-byitself');
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root), 'a workspace of its own');
  // Traps first on the PATH: a program of the real system that anything here started would be written down.
  const traps = path.join(w.root, 'traps');
  const trapLog = path.join(w.root, 'traps.log');
  fs.mkdirSync(traps);
  for (const n of ['sudo', 'npm', 'systemctl', 'loginctl', 'apt-get', 'ssh', 'claude']) {
    fs.writeFileSync(path.join(traps, n), `#!/bin/sh\necho "${n} $*" >> '${trapLog}'\nexit 97\n`, { mode: 0o755 });
  }
  const PATH = process.env.PATH;
  process.env.PATH = [traps, ...PATH.split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'trouteai')))].join(path.delimiter);
  t.after(() => { process.env.PATH = PATH; });

  // The provider's endpoint: any request to it fails the test.
  const asked = [];
  const relay = http.createServer((req, res) => { asked.push(`${req.method} ${req.url}`); res.writeHead(500).end(); });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = `http://127.0.0.1:${relay.address().port}`;

  const shop = path.join(w.projects, 'shop');
  w.repo(shop);
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createRun, updateRun } = await import('../../src/runs.mjs');
  saveConfig({ claudeBin: path.join(w.root, 'no-claude'), usage: false, addons: { trouteai: { port: 8092 } }, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('relay-a', { label: 'Relay A', env: { ANTHROPIC_BASE_URL: relayUrl, ANTHROPIC_AUTH_TOKEN: 'made-up-token-for-tests' } });
  // A session that works, and one of its agents ended on an ambiguous model name (as the hook writes it).
  const termId = 'pty-aaaaaaaaaaaa';
  const { file } = createRun({ profile: 'relay-a', cwd: shop });
  updateRun(file, { termId, status: 'working', sessionId: '5e551011-0000-4000-8000-000000000001', agentStops: [{ id: 'a6e1e6756ce2da8e7', label: 'Check the shop page', at: Date.now() - 5 * 60_000, error: 'unknown', text: "API Error: 400 Ambiguous model 'relay-large'" }] });
  // A session the coding tool ran without Hoprig, in its own folder: one of its agents stopped on a refused name.
  const outsideId = '8cbd5db6-b133-45aa-9b34-48176460339a';
  const subagents = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-work-blog', outsideId, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, '..', '..', `${outsideId}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), cwd: '/work/blog', sessionId: outsideId, message: { stop_reason: 'end_turn', content: [] } })}\n`);
  fs.writeFileSync(path.join(subagents, 'agent-a77.jsonl'), `${JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a77', timestamp: new Date(Date.now() - 60_000).toISOString(), sessionId: outsideId, error: 'unknown', isApiErrorMessage: true, apiErrorStatus: 400, message: { stop_reason: 'stop_sequence', content: [{ type: 'text', text: "API Error: 400 Ambiguous model 'claude-opus-5'" }] } })}\n`);
  const backend = { kind: 'pty', capabilities: {}, list: async () => [{ id: termId, session: 'shop', cwd: shop, pid: process.pid, activity: Date.now() }], capture: async () => '' };

  const before = snapshot(w.root);
  const programs = [];
  const orig = {};
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    orig[k] = childProcess[k];
    childProcess[k] = function (f, args, ...rest) {
      programs.push([path.basename(String(f)), ...(Array.isArray(args) ? args.map(String) : [])].join(' '));
      return orig[k].call(this, f, args, ...rest);
    };
  }
  syncBuiltinESMExports();
  let app = null;
  const restore = () => { Object.assign(childProcess, orig); syncBuiltinESMExports(); };
  t.after(async () => { restore(); if (app) await app.close().catch(() => {}); w.cleanup(); });

  let offset = 0;
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ backend, watch: false, dashboardFile: false, operator: { now: () => Date.now() + offset } });
  await app.listen(0, '127.0.0.1');
  for (let i = 0; i < 3; i++) {
    await app.watcher.tick();
    offset += 5 * 60_000 + 1000;
  }
  // The look the panel takes: the agent's stop is an item, named and with its step.
  const op = app.features.find((f) => f.name === 'operator');
  const [, , listRoute] = op.routes.find(([m, re]) => m === 'GET' && re.test('/api/operator/attention'));
  const r = await listRoute({ url: '/api/operator/attention', socket: { localPort: app.server.address().port, localAddress: '127.0.0.1' } });
  // The Providers page's view of the gateway profile: it reads, and sends nothing.
  const prov = app.features.find((f) => f.name === 'providers');
  const [, healthRe, health] = prov.routes.find(([m, re]) => m === 'GET' && re.test('/api/providers/relay-a/health'));
  const seen = await health({ url: '/api/providers/relay-a/health' }, healthRe.exec('/api/providers/relay-a/health'));
  assert.equal(seen.check.applies, true);
  assert.equal(seen.check.last, null, 'the check never ran by itself');
  await app.close();
  app = null;
  restore();
  const after = snapshot(w.root);

  const it = r.items.find((x) => x.kind === 'providerstop');
  assert.equal(it?.subject, 'session shop', JSON.stringify(r.items.map((x) => x.kind)));
  assert.ok(it.facts.includes('the session goes on, but a step of it was lost'), it.facts.join('|'));
  assert.ok(it.facts.some((f) => f.startsWith('agent "Check the shop page" stopped: the endpoint refuses this model name')), it.facts.join('|'));
  const out = r.items.find((x) => x.kind === 'providerstop' && /not started by Hoprig/.test(x.subject));
  assert.equal(out?.subject, 'session 8cbd5db6 in blog, not started by Hoprig', JSON.stringify(r.items.map((x) => x.subject)));
  assert.ok(out.facts.some((f) => f.startsWith('agent a77 stopped: the endpoint refuses this model name')), out.facts.join('|'));
  assert.deepEqual(asked, [], 'no request reached the provider');
  assert.ok(!fs.existsSync(trapLog), `a program of the real system was started: ${fs.existsSync(trapLog) ? fs.readFileSync(trapLog, 'utf8') : ''}`);
  assert.ok(!programs.some((p) => /^(claude|codex|opencode|node|curl|wget) /.test(`${p} `)), `no coding tool or request: ${programs.join(' | ')}`);
  // The run record is read, not written; outside the state folder nothing changes; in it, only what the dashboard
  // itself keeps (its own state, the Operator's look time, the watcher's records), never a file of the providers' or a
  // run record.
  const changed = changes(before, after);
  assert.deepEqual(changed.filter((f) => !f.startsWith('state/')), [], 'nothing in the home, the workspace or the git server changed');
  assert.deepEqual(changed.filter((f) => f.startsWith('state/runs/') || f.startsWith('profiles/') || /provider|checks\.json/i.test(f)), [], 'no run record, provider file or check result was written');
  t.diagnostic(`what the dashboard itself wrote in its state folder: ${changed.join(', ') || 'nothing'}`);
});
