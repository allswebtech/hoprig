// The demo's Settings → Version and updates names cloudflared as the real list does (src/automation/updateitems.mjs), so the
// demo shows the words a person sees on a real computer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { demoUpdateItems } = await import('../../src/demo/updates.mjs');

test('the demo names cloudflared "The helper for the public link (cloudflared)", as the real list does', () => {
  const real = fs.readFileSync(new URL('../../src/automation/updateitems.mjs', import.meta.url), 'utf8');
  const title = /id: 'cloudflared',\s*title: '([^']+)'/.exec(real)[1];
  const demo = demoUpdateItems().find((i) => i.id === 'cloudflared');
  assert.ok(demo, 'the demo lists cloudflared');
  assert.equal(demo.title, title);
  assert.equal(demo.title, 'The helper for the public link (cloudflared)');
});
