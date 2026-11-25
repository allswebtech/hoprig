// Set-up's closing list ("Still yours to do"): every first-day step in it names the dashboard's press first, in the
// page's own words, so no step of a first day exists only as a command. The command stays as the other way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TODO } from '../../src/setup/ui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// What the page calls the presses: Get started's step labels (the server's and the page's own).
const PRESSES = {
  'Home → Get started → Sign in to Claude': [read('src/setup/onboarding.mjs'), "{ kind: 'claude-login', label: 'Sign in to Claude' }"],
  'Home → Get started → Set up git and GitHub': [read('web/getstarted.js'), "if (a.kind === 'git') return 'Set up git and GitHub';"],
  // Health's Gateways part: the press that runs the lingering command through sudo (POST /api/gatewayhost/linger).
  'Computers → this computer → Health → Let them start after a restart': [read('web/health.js'), "btn('small secondary', { label: 'Let them start after a restart',"],
};

test('every first-day step of the closing list names a press on the dashboard, and the press is the page\'s own', () => {
  for (const key of ['identity', 'github', 'claude', 'brain', 'linger']) {
    const { page, step } = TODO[key];
    assert.ok(page, `${key}: a dashboard way`);
    assert.ok(step, `${key}: the command stays as the other way`);
    const [src, said] = PRESSES[page] || [];
    assert.ok(src && src.includes(said), `${key}: "${page}" is a press the page has`);
  }
  // Get started's git step walks the GitHub sign-in, the name and the AI brain's git server, in that order.
  assert.match(read('web/gitsetup.js'), /const todo = \['github', 'identity', 'brain'\]\.map/);
});
