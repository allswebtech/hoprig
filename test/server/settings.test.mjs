import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { DEFAULT_QUICK_ACTIONS, cleanPublicUrl, cleanQuickActions, cleanRoots, cleanServerPatch } from '../../src/server/settings.mjs';

const box = sandbox();
test.after(() => box.cleanup());

test('quick actions', () => {
  assert.deepEqual(cleanQuickActions(DEFAULT_QUICK_ACTIONS), DEFAULT_QUICK_ACTIONS);
  assert.deepEqual(cleanQuickActions([{ label: ' go ', text: 'a\r\nb' }]), [{ label: 'go', text: 'a\nb' }]);
  assert.throws(() => cleanQuickActions('x'), /list/);
  assert.throws(() => cleanQuickActions([{ label: '', text: 'x' }]), /label/);
  assert.throws(() => cleanQuickActions([{ label: 'x'.repeat(25), text: 'x' }]), /label/);
  assert.throws(() => cleanQuickActions([{ label: 'a\nb', text: 'x' }]), /label/);
  assert.throws(() => cleanQuickActions([{ label: 'a', text: ' ' }]), /text/);
  assert.throws(() => cleanQuickActions([{ label: 'a', text: 'x'.repeat(501) }]), /text/);
  assert.throws(() => cleanQuickActions(Array.from({ length: 21 }, () => ({ label: 'a', text: 'b' }))), /20/);
});

test('roots must be existing absolute folders', () => {
  assert.deepEqual(cleanRoots([box.root, box.root]), [box.root]);
  assert.throws(() => cleanRoots([]), /at least one/);
  assert.throws(() => cleanRoots(['relative']), /absolute/);
  assert.throws(() => cleanRoots([`${box.root}/nope`]), /does not exist/);
});

test('public URL', () => {
  assert.equal(cleanPublicUrl('https://pc.example.net/'), 'https://pc.example.net');
  assert.equal(cleanPublicUrl(''), '');
  assert.throws(() => cleanPublicUrl('javascript:alert(1)'), /https/);
  assert.throws(() => cleanPublicUrl('not a url'), /valid/);
});

test('server patch: known keys only, every value checked', () => {
  assert.deepEqual(cleanServerPatch({ publicUrl: '', notify: null }), { publicUrl: '', notify: null });
  assert.throws(() => cleanServerPatch({ passwordHash: 'x' }), /cannot be changed/);
  assert.throws(() => cleanServerPatch({ launcher: ['sh'] }), /cannot be changed/);
  assert.throws(() => cleanServerPatch([]), /object/);
  assert.throws(() => cleanServerPatch({ notify: { url: 'ftp://x' } }), /https/);
});
