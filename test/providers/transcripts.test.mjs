// Sessions Hoprig did not start (src/providers/transcripts.mjs): the coding tool's own records are read so that a stop
// of such a session, or of an agent in it, is a board card; only what changed is read, a line cut at the end is read on
// the next look, a very large record costs a bounded read, a record rewritten from the start is read again, and a
// session Hoprig started is left out. The lines are shaped as Claude Code 2.1.328 writes them; made-up names only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LIMITS, ownConversations, transcriptReader } from '../../src/providers/transcripts.mjs';

const SID = '8cbd5db6-b133-45aa-9b34-48176460339a';
const NOW = Date.parse('2026-11-19T05:00:00Z');
const at = (min) => new Date(NOW - min * 60_000).toISOString();

const ok = (min) => `${JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: at(min), cwd: '/work/shop', sessionId: SID, message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })}\n`;
const ambiguous = (min, agentId = null) => `${JSON.stringify({ type: 'assistant', isSidechain: !!agentId, ...(agentId ? { agentId } : {}), timestamp: at(min), cwd: '/work/shop', sessionId: SID, error: 'unknown', isApiErrorMessage: true, apiErrorStatus: 400, message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "API Error: 400 Ambiguous model 'claude-opus-5' (key sk-ant-api03-MADEUPKEY0000000000000000, alex.relay@example.com)" }] } })}\n`;
const refusal = (min) => `${JSON.stringify({ type: 'assistant', timestamp: at(min), cwd: '/work/shop', sessionId: SID, error: 'invalid_request', isApiErrorMessage: true, refusingModel: 'claude-opus-5-5', message: { model: '<synthetic>', stop_reason: 'refusal', content: [{ type: 'text', text: "API Error: Opus 5.5's safeguards flagged this message" }] } })}\n`;

function home(name) {
  const dir = path.join(process.env.HOME, name, 'projects');
  const proj = path.join(dir, '-work-shop');
  fs.mkdirSync(path.join(proj, SID, 'subagents'), { recursive: true });
  return { dir, file: path.join(proj, `${SID}.jsonl`), agent: (id) => path.join(proj, SID, 'subagents', `agent-${id}.jsonl`), meta: (id) => path.join(proj, SID, 'subagents', `agent-${id}.meta.json`) };
}
const reader = (h, limits) => transcriptReader({ dir: () => h.dir, now: () => NOW, ...(limits ? { limits } : {}) });
const snap = (d) => fs.readdirSync(d, { recursive: true }).sort().map((f) => { const p = path.join(d, f); const s = fs.statSync(p); return `${f} ${s.size} ${s.mtimeMs}`; });

test("an agent's stop in a session started outside Hoprig is a card within one look, and nothing is written", () => {
  const h = home('a');
  fs.writeFileSync(h.file, ok(10));
  fs.writeFileSync(h.agent('a6e1e6756ce2da8e7'), ambiguous(5, 'a6e1e6756ce2da8e7'));
  fs.writeFileSync(h.meta('a6e1e6756ce2da8e7'), JSON.stringify({ agentType: 'general-purpose', description: 'Check the shop page' }));
  const before = snap(h.dir);
  const [c, ...rest] = reader(h).look();
  assert.equal(rest.length, 0);
  assert.equal(c.outside, true);
  assert.equal(c.sessionId, SID);
  assert.equal(c.folder, 'shop');
  assert.equal(c.stop, null, 'the session itself goes on');
  assert.deepEqual(c.agents.map((a) => [a.id, a.label, a.stop.reason]), [['a6e1e6756ce2da8e7', 'Check the shop page', 'model']]);
  assert.doesNotMatch(JSON.stringify(c), /MADEUPKEY|alex\.relay|example\.com/);
  assert.deepEqual(snap(h.dir), before);
});

test('the session\'s own stop, then a later reply clears it; a session Hoprig started is left out', () => {
  const h = home('b');
  fs.writeFileSync(h.file, ok(20) + refusal(9));
  const r = reader(h);
  assert.equal(r.look()[0].stop.reason, 'refusal');
  assert.deepEqual(r.look({ skip: new Set([SID]) }), [], 'the hook\'s record wins');
  fs.appendFileSync(h.file, ok(2));
  assert.deepEqual(r.look(), []);
});

test('a line cut at the end is read whole on the next look', () => {
  const h = home('c');
  const line = ambiguous(3);
  fs.writeFileSync(h.file, ok(10) + line.slice(0, 40));
  const r = reader(h);
  assert.deepEqual(r.look(), []);
  fs.appendFileSync(h.file, line.slice(40));
  assert.equal(r.look()[0].stop.reason, 'model');
  // A line written in three parts, none of them with a line's end until the last.
  const next = refusal(1);
  for (const part of [next.slice(0, 30), next.slice(30, 90)]) {
    fs.appendFileSync(h.file, part);
    assert.equal(r.look()[0].stop.reason, 'model', 'nothing read from half a line');
  }
  fs.appendFileSync(h.file, next.slice(90));
  assert.equal(r.look()[0].stop.reason, 'refusal');
});

test('a very large record is read in bounded steps, and a very long line is passed over', () => {
  const h = home('d');
  const big = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(3 * 1024 * 1024) } })}\n`;
  fs.writeFileSync(h.file, ok(30) + big + ambiguous(4));
  const limits = { files: 64, bytes: 256 * 1024, perFile: 128 * 1024, tail: 8 * 1024 * 1024, line: 64 * 1024, stats: 4000, ms: 1000 };
  const r = reader(h, limits);
  let looks = 0;
  let cards = [];
  while (!cards.length && looks < 100) {
    cards = r.look();
    looks++;
  }
  assert.equal(cards[0]?.stop?.reason, 'model', 'the stop after it is still found');
  assert.ok(looks > 10, `each look read a bounded part (${looks} looks)`);
  // A file seen first when it is already large is read from near its end only.
  const h2 = home('d2');
  fs.writeFileSync(h2.file, big + ambiguous(4));
  const r2 = reader(h2);
  assert.equal(r2.look()[0].stop.reason, 'model', 'one look: only its last part is read');
});

test('a record rewritten from the start is read again', () => {
  const h = home('e');
  fs.writeFileSync(h.file, ok(30) + ok(20) + ok(10));
  const r = reader(h);
  assert.deepEqual(r.look(), []);
  fs.writeFileSync(h.file, refusal(1));
  assert.equal(r.look()[0].stop.reason, 'refusal');
  // Another file under the same name, of the same size as the first.
  const again = ambiguous(1);
  fs.rmSync(h.file);
  fs.writeFileSync(h.file, again);
  assert.equal(r.look()[0].stop.reason, 'model');
});

// A file system that keeps the inode, a rewrite of the same size, and a clock whose tick the rewrite falls in: the
// stat says nothing changed. Played for certain: the file is rewritten in place and given back the same whole second.
test('a record rewritten in place with the same size and the same time is read again', () => {
  const h = home('e2');
  const first = refusal(1);
  const j = JSON.parse(ok(1));
  j.pad = '';
  j.pad = 'x'.repeat(first.length - `${JSON.stringify(j)}\n`.length);
  const second = `${JSON.stringify(j)}\n`;
  assert.equal(second.length, first.length, 'the same size');
  const tick = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.writeFileSync(h.file, first);
  fs.utimesSync(h.file, tick, tick);
  const was = fs.statSync(h.file);
  const r = reader(h);
  assert.equal(r.look()[0].stop.reason, 'refusal');
  fs.writeFileSync(h.file, second); // in place: the same inode
  fs.utimesSync(h.file, tick, tick);
  const now = fs.statSync(h.file);
  assert.deepEqual([now.ino, now.size, now.mtimeMs], [was.ino, was.size, was.mtimeMs], 'the stat is as it was');
  assert.deepEqual(r.look(), [], 'the later reply in the rewritten record clears the stop');
});

test('a stop older than a day is no card', () => {
  const h = home('f');
  fs.writeFileSync(h.file, ambiguous(25 * 60));
  assert.deepEqual(reader(h).look(), []);
});

test('with more old records than a look may stat, a new session is still found at once, and one that goes on in an old folder within a few looks', () => {
  const dir = path.join(process.env.HOME, 'many', 'projects');
  const old = (NOW - 3 * 24 * 3600_000) / 1000;
  const id = (p, n) => `${String(p).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  for (let p = 0; p < 30; p++) {
    const proj = path.join(dir, `-work-old-${p}`);
    fs.mkdirSync(proj, { recursive: true });
    for (let n = 0; n < 10; n++) {
      const f = path.join(proj, `${id(p, n)}.jsonl`);
      fs.writeFileSync(f, ok(3 * 24 * 60));
      fs.utimesSync(f, old, old);
    }
    fs.utimesSync(proj, old, old);
  }
  const limits = { ...LIMITS, stats: 40 };
  const r = transcriptReader({ dir: () => dir, now: () => NOW, limits });
  assert.deepEqual(r.look(), [], '300 old records: no card');
  // A new session in a folder of its own: found on the very next look.
  const fresh = path.join(dir, '-work-zzz-shop');
  fs.mkdirSync(fresh);
  fs.writeFileSync(path.join(fresh, `${SID}.jsonl`), ambiguous(1));
  assert.deepEqual(r.look().map((c) => c.sessionId), [SID]);
  // A session that goes on in an old folder: its file grows, the folder's time stays old.
  const goesOn = path.join(dir, '-work-old-17', `${id(17, 4)}.jsonl`);
  fs.appendFileSync(goesOn, ambiguous(1).replaceAll(SID, id(17, 4)));
  fs.utimesSync(path.dirname(goesOn), old, old);
  let looks = 0;
  let found = false;
  while (!found && looks < 20) {
    looks++;
    found = r.look().some((c) => c.sessionId === id(17, 4));
  }
  assert.ok(found, 'reached in turns');
  assert.ok(looks <= Math.ceil(300 / 40) + 1, `${looks} looks`);
});

test('an id Hoprig ran is kept a day from when it was LAST seen, also past a restart, and a look a minute later writes nothing', () => {
  const file = path.join(process.env.HOME, 'own', 'conversations.json');
  const H = 3600_000;
  let t = NOW - 20 * H;
  const a = ownConversations({ file: () => file, now: () => t });
  a.note([SID]);
  t = NOW - H;
  a.note([SID]);
  const written = fs.statSync(file).mtimeMs;
  const held = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(held)[SID], NOW - H, 'the file holds when it was last seen');
  t = NOW - H + 60_000;
  a.note([SID]);
  assert.equal(fs.readFileSync(file, 'utf8'), held, 'not written on every look');
  assert.equal(fs.statSync(file).mtimeMs, written);
  // A restart five hours later: the session's stop from an hour before it is still its own.
  const b = ownConversations({ file: () => file, now: () => NOW + 5 * H });
  assert.ok(b.note([]).has(SID));
});

test('a new session in one folder with more old records than a look may stat is found on the next look, and within a few after a restart', () => {
  const dir = path.join(process.env.HOME, 'big', 'projects');
  const proj = path.join(dir, '-work-big-shop');
  fs.mkdirSync(proj, { recursive: true });
  const old = (NOW - 3 * 24 * 3600_000) / 1000;
  for (let n = 0; n < 200; n++) {
    const f = path.join(proj, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}.jsonl`);
    fs.writeFileSync(f, ok(3 * 24 * 60));
    fs.utimesSync(f, old, old);
  }
  fs.utimesSync(proj, old, old);
  const limits = { ...LIMITS, stats: 40 };
  const r = transcriptReader({ dir: () => dir, now: () => NOW, limits });
  assert.deepEqual(r.look(), []);
  // Its id sorts after every old one: a walk in name order spends the cap before it, on every look.
  const NEW = 'ffffffff-0000-4000-8000-000000000000';
  fs.writeFileSync(path.join(proj, `${NEW}.jsonl`), ambiguous(1).replaceAll(SID, NEW));
  assert.deepEqual(r.look().map((c) => c.sessionId), [NEW], 'the next look');
  // A restart: every name is new to the fresh reader, and each look walks the next part of them.
  const fresh = transcriptReader({ dir: () => dir, now: () => NOW, limits });
  let looks = 0;
  let found = false;
  while (!found && looks < 20) {
    looks++;
    found = fresh.look().some((c) => c.sessionId === NEW);
  }
  assert.ok(found, 'found after a restart');
  assert.ok(looks <= Math.ceil(201 / 40) + 1, `${looks} looks`);
});

test('a stop in a session the reader already knows, in an active folder beside many old ones, is seen on the next look wherever the round stands', () => {
  const dir = path.join(process.env.HOME, 'hot', 'projects');
  const old = (NOW - 3 * 24 * 3600_000) / 1000;
  for (let f = 0; f < 6; f++) {
    const p = path.join(dir, `-work-old-${f}`);
    fs.mkdirSync(p, { recursive: true });
    for (let n = 0; n < 100; n++) {
      const x = path.join(p, `00000000-0000-4000-8000-${String(f * 1000 + n).padStart(12, '0')}.jsonl`);
      fs.writeFileSync(x, ok(3 * 24 * 60));
      fs.utimesSync(x, old, old);
    }
    fs.utimesSync(p, old, old);
  }
  const act = path.join(dir, '-work-shop');
  fs.mkdirSync(act, { recursive: true });
  const ids = [1, 2, 3, 4, 5].map((i) => `aaaaaaaa-0000-4000-8000-00000000000${i}`);
  for (const id of ids) fs.writeFileSync(path.join(act, `${id}.jsonl`), ok(60).replaceAll(SID, id));
  const seen = [];
  ids.forEach((id, i) => {
    let t = NOW;
    const r = transcriptReader({ dir: () => dir, now: () => t, limits: { ...LIMITS, stats: 40 } });
    for (let w = 0; w < 20 + 3 * i; w++) { t += 5000; r.look(); } // everything known, the round at another point each time
    fs.appendFileSync(path.join(act, `${id}.jsonl`), ambiguous(0).replaceAll(SID, id));
    let looks = 0;
    while (looks < 40) { looks++; t += 5000; if (r.look().some((c) => c.sessionId === id)) break; }
    seen.push(looks);
  });
  assert.deepEqual(seen, [1, 1, 1, 1, 1]);
});
