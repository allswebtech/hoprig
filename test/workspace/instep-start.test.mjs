// The look at a session's start is ONE function (src/workspace/instep.mjs lookBeforeStart) called from the two places a
// session starts: the route that starts a terminal session and the start of a chat. Nothing else may start one without it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('a terminal session and a chat both look before they start', () => {
  const server = src('src/server/server.mjs');
  const route = server.slice(server.indexOf("['POST', /^\\/api\\/sessions$/"), server.indexOf("['POST', /^\\/api\\/shells$/"));
  assert.equal((route.match(/lookBeforeStart\(/g) || []).length, 1, 'once in the route');
  assert.ok(route.indexOf('lookBeforeStart(') < route.indexOf('deck.start('), 'before the tool starts');
  const run = src('src/chat/run.mjs');
  assert.equal((run.match(/lookBeforeStart\(/g) || []).length, 1);
  assert.ok(run.indexOf('lookBeforeStart(') < run.indexOf('createChatRun({'), 'before the chat holds its record');
});

test('the look never throws and gives nothing back where there is no map', async () => {
  const { lookBeforeStart } = await import('../../src/workspace/instep.mjs');
  const r = await lookBeforeStart('/nonexistent/folder', { dir: '/nonexistent', projects: '/nonexistent/projects', ff: { projects: true } });
  assert.deepEqual((r || { items: [] }).items, []);
  assert.equal(await lookBeforeStart('/nonexistent/folder', { dir: '/nonexistent', ff: { projects: false } }), null, 'every switch off: no look');
});
