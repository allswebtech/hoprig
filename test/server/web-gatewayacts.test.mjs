// The manage presses of TRouteAI's own page (web/gatewayacts.js): each asks first, names the computer, sends its
// confirmation and goes to a route the server answers; the password needs 12 characters, like Hoprig's public link.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('web-gwacts');
test.after(() => box.cleanup());
const src = fs.readFileSync(new URL('../../web/gatewayacts.js', import.meta.url), 'utf8');
const { gatewayHostFeature } = await import('../../src/addons/gatewayhost.mjs');
class HttpError extends Error {}
const feature = gatewayHostFeature({ HttpError, readJson: async () => ({}) }, { addons: () => [] });

test('every route the manage presses call is a route of the server', () => {
  const used = new Set([...src.matchAll(/\$\{base\(ctx\)\}\/([a-z/]+)/g)].map((m) => m[1]));
  for (const act of ['start', 'stop', 'restart', 'service', 'log', 'password', 'first']) assert.ok(used.has(act), `the page calls ${act}`);
  for (const act of used) assert.ok(feature.routes.some(([, re]) => re.test(`/api/gatewayhost/trouteai/${act}`)), `the server answers ${act}`);
  assert.match(src, /\/api\/addons\/\$\{ctx\.g\.id\}\/\$\{action\}/, 'Update and Remove are the add-on\'s own jobs');
});

test('every press asks first with the computer named, and sends confirm', () => {
  const press = src.slice(src.indexOf('async function press'), src.indexOf('export const startIt'));
  assert.match(press, /confirmSheet\(\{ title, text/);
  assert.match(press, /confirm: ctx\.computer/);
  for (const name of ['startIt', 'stopIt', 'restartIt', 'showFirst']) assert.match(src, new RegExp(`export const ${name} = \\(ctx\\) => press\\(ctx`));
  assert.match(src, /on \$\{ctx\.computer\}\?`/, 'a title names the computer');
  const job = src.slice(src.indexOf('export async function addonJob'), src.indexOf('export const updateIt'));
  assert.ok(job.indexOf('confirmSheet') < job.indexOf('api('), 'the question comes before the request');
  assert.match(job, /confirm: ctx\.computer/);
  const boot = src.slice(src.indexOf('export async function bootSheet'), src.indexOf('/** Services of this computer'));
  assert.ok(boot.indexOf('openSheet') < boot.indexOf('/service`, { on'), 'the service file is shown before it is written');
  assert.match(boot, /confirm: computer/);
});

test('Remove and Stop name what they do to sessions and data, and Remove is a danger press', () => {
  assert.match(src, /Sessions that use it stop working until it runs again\./);
  assert.match(src, /danger: action === 'remove'/);
  assert.match(src, /Its data \(your providers and keys\) and the provider/);
});

test('the new password has at least 12 characters, and goes only to the password route', () => {
  assert.match(src, /export const PASSWORD_MIN = 12;/);
  assert.equal([...src.matchAll(/password: pw/g)].length, 1);
  assert.match(src, /At least \$\{PASSWORD_MIN\} characters/);
});
