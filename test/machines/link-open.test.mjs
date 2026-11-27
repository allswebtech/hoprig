// `hoprig link --open`: the one-time link goes to this computer's own browser (the Start menu and app menu entries run
// it), once, with no QR code; a computer with no opener prints the link instead.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('link-open');
test.after(box.cleanup);
const { main } = await import('../../src/machines/cli.mjs');
const { openerFor, openBrowser } = await import('../../src/openbrowser.mjs');

async function run(args, hooks) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    return { code: await main('link', args, hooks), text: lines.join('\n') };
  } finally {
    console.log = log;
  }
}

test('--open calls the opener once with a one-time link of this computer, and says where it is', async () => {
  const opened = [];
  const r = await run(['--open'], { open: (u) => { opened.push(u); return true; } });
  assert.equal(r.code, 0);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/login#link=[A-Za-z0-9_-]{43}$/);
  assert.match(r.text, /Opening Hoprig in your browser/);
  assert.ok(r.text.includes(opened[0]), 'the fallback link is printed');
  assert.doesNotMatch(r.text, /Scan with your phone/, 'no QR code');
});

test('--open with no opener prints the link', async () => {
  const r = await run(['--open'], { open: () => false });
  assert.equal(r.code, 0);
  assert.match(r.text, /Open this link in a browser/);
  assert.match(r.text, /#link=/);
});

test('the opener of each system keeps the whole address as one argument', () => {
  const url = 'http://127.0.0.1:7433/login#link=abc&x=1';
  assert.deepEqual(openerFor(url, 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(openerFor(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(openerFor(url, 'linux'), ['xdg-open', [url]]);
  const seen = [];
  assert.equal(openBrowser(url, { platform: 'linux', run: (c, a) => { seen.push([c, a]); return { on() {}, unref() {} }; } }), true);
  assert.deepEqual(seen, [['xdg-open', [url]]]);
  assert.equal(openBrowser(url, { run: () => { throw new Error('no opener'); } }), false);
});
