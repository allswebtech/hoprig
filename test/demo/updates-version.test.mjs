// The demo's Settings → Version and updates shows the package's own version for Hoprig, read from package.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { demoUpdateItems } from '../../src/demo/updates.mjs';

test("the demo's Hoprig row is the package's own version, up to date", async () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const row = demoUpdateItems().find((i) => i.id === 'hoprig');
  const info = await row.info();
  assert.equal(info.installed, version);
  assert.equal(info.latest, version);
  assert.equal(info.updateAvailable, false);
});
