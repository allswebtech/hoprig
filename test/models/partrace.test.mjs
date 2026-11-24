// "Use other providers": the limit of parts at once (src/models/partdoor.mjs) holds when calls come together. A part's
// slot is taken before the session is opened, so calls that arrive while the first one opens see it as running; a
// session that does not start gives its slot back. The chat is a stand-in whose open takes a while.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('partrace');
test.after(() => box.cleanup());
const { writeProfile } = await import('../../src/profiles.mjs');
const { partDoor } = await import('../../src/models/partdoor.mjs');

writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8248', ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });

/** A door on a stand-in chat; `fail(n)`: whether the n-th open (from 0) does not take the brief. */
async function door(t, { openMs = 150, fail = () => false } = {}) {
  const opened = [];
  let calls = 0; // opens asked for, started or not
  const sessions = new Map();
  const lead = { id: 'lead-1', cwd: box.root, lead: true, others: ['alpha'], byTia: false };
  const chat = {
    recordOf: (id) => (id === lead.id ? lead : null),
    peek: (id) => sessions.get(id) || null,
    notice() {},
    async open(b) {
      await new Promise((r) => setTimeout(r, openMs));
      if (fail(calls++)) return { id: null, sent: false, why: 'it did not start' };
      const id = `chat-${opened.push(b)}`;
      sessions.set(id, { busy: true });
      return { id, sent: true };
    },
  };
  // A part's start looks its kind's model up in the provider's list: a stand-in here, so no address is ever asked.
  const d = partDoor({ chat, config: () => ({ automation: { schedules: { atOnce: 1 } } }), url: () => 'http://127.0.0.1:1', models: async () => null });
  // The token is made as a Lead chat with ticks starts (configFor); the file goes to the sandbox's state folder.
  d.configFor(lead);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const token = fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'part-servers', 'lead-1.token'), 'utf8').trim();
  const srv = http.createServer(async (req, res) => {
    if (!(await d.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const call = (body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/api/parts', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve(JSON.parse(s)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  return { call, opened };
}

test('five parts at once with a limit of one: one starts, four are refused', async (t) => {
  const { call, opened } = await door(t);
  const r = await Promise.all(Array.from({ length: 5 }, (_, i) => call({ action: 'start', provider: 'alpha', brief: `part ${i}` })));
  assert.equal(r.filter((x) => !x.isError).length, 1, JSON.stringify(r.map((x) => x.text)));
  assert.equal(r.filter((x) => /at most 1 at once/.test(x.text)).length, 4);
  assert.equal(opened.length, 1, 'one session opened');
});

test('a part that does not start gives its slot back', async (t) => {
  const { call, opened } = await door(t, { openMs: 20, fail: (n) => n === 0 });
  const first = await call({ action: 'start', provider: 'alpha', brief: 'part 1' });
  assert.match(first.text, /Not started: it did not start/);
  const second = await call({ action: 'start', provider: 'alpha', brief: 'part 2' });
  assert.ok(!second.isError, second.text);
  assert.equal(opened.length, 1);
});
