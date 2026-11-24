// The demo's AI brain plan names Claude Code's home memory folder after a made-up home: the demo's temporary path
// never shows on a page or in a screenshot. A real home keeps its own folder name, the one Claude Code reads.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { claude } from '../../src/codetools/claude.mjs';

const memoryOf = (home) => claude.brainLinks({ base: path.join(home, '.claude'), brain: '/b', home }).find((e) => e.id === 'memory').link;

test('demo: the home memory link is named after a made-up home, not the temporary folder', () => {
  const home = path.join('/tmp', 'hoprig-demo-Ab12Cd', 'home');
  const link = memoryOf(home);
  assert.doesNotMatch(path.basename(path.dirname(link)), /tmp|hoprig-demo/);
  assert.equal(path.basename(path.dirname(link)), '-home-alex');
});

test('a real home keeps the folder Claude Code itself reads', () => {
  assert.equal(path.basename(path.dirname(memoryOf('/home/sam'))), '-home-sam');
  assert.equal(path.basename(path.dirname(memoryOf('/srv/hoprig-demo-notes/sam'))), '-srv-hoprig-demo-notes-sam');
});
