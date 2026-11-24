// A move that never replaces (the save sheet's Move out uses it) is one of inside.mjs's acts: both folders are
// checked at the moment it runs, a link at the source is refused, a file at the target is never replaced. A temporary
// home only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-insidemove');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const { moveNoReplaceIn } = await import('../../src/workspace/inside.mjs');

const brain = path.join(A.ws, 'ai_brain');
const beside = path.join(A.ws, 'ai_brain-moved-out');
const outside = path.join(w.root, 'OUTSIDE');
fs.mkdirSync(brain, { recursive: true });
fs.mkdirSync(beside, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const at = (root) => ({ dir: A.ws, projects: A.projects, root });

test('a file moves to a free name: there after, gone before', () => {
  fs.writeFileSync(path.join(brain, 'a.pem'), 'one\n');
  const to = moveNoReplaceIn(at(brain), path.join(brain, 'a.pem'), at(beside), path.join(beside, 'a.pem'));
  assert.equal(fs.readFileSync(to, 'utf8'), 'one\n');
  assert.equal(fs.existsSync(path.join(brain, 'a.pem')), false);
});

test('a file at the target is never replaced, and the source stays', () => {
  fs.writeFileSync(path.join(brain, 'b.pem'), 'new\n');
  fs.writeFileSync(path.join(beside, 'b.pem'), 'old\n');
  assert.throws(() => moveNoReplaceIn(at(brain), path.join(brain, 'b.pem'), at(beside), path.join(beside, 'b.pem')), (e) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(path.join(beside, 'b.pem'), 'utf8'), 'old\n');
  assert.equal(fs.readFileSync(path.join(brain, 'b.pem'), 'utf8'), 'new\n');
});

test('a target folder that leads out through a link at the moment of the act: refused, nothing moved', () => {
  fs.writeFileSync(path.join(brain, 'c.pem'), 'c\n');
  fs.symlinkSync(outside, path.join(beside, 'sub'));
  assert.throws(() => moveNoReplaceIn(at(brain), path.join(brain, 'c.pem'), at(beside), path.join(beside, 'sub', 'c.pem')), (e) => e.code === 'ELEAVES');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(brain, 'c.pem')), true);
});

test('a source folder that leads out: refused, the file out there stays', () => {
  fs.writeFileSync(path.join(outside, 'd.pem'), 'd\n');
  fs.symlinkSync(outside, path.join(brain, 'away'));
  assert.throws(() => moveNoReplaceIn(at(brain), path.join(brain, 'away', 'd.pem'), at(beside), path.join(beside, 'd.pem')), (e) => e.code === 'ELEAVES');
  assert.equal(fs.existsSync(path.join(outside, 'd.pem')), true);
  assert.equal(fs.existsSync(path.join(beside, 'd.pem')), false);
});

test('a link at the source is refused, never followed', () => {
  fs.writeFileSync(path.join(brain, 'real.md'), 'r\n');
  fs.symlinkSync(path.join(brain, 'real.md'), path.join(brain, 'e.pem'));
  assert.throws(() => moveNoReplaceIn(at(brain), path.join(brain, 'e.pem'), at(beside), path.join(beside, 'e.pem')), (e) => e.status === 409);
  assert.equal(fs.lstatSync(path.join(brain, 'e.pem')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(beside, 'e.pem')), false);
});
