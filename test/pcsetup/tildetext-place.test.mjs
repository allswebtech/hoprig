// "This link is mine" and the other sheets write the home folder as "~" only where it starts a path and only before
// a separator or the end: a sibling folder (<home>.bak) or a tree that repeats the home path is shown whole, so the
// sheet shows the place the yes saves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tildeText } from '../../src/pcsetup/feature.mjs';

const H = '/home/ann';

test('a sibling of the home folder is shown whole, never as ~.bak', () => {
  assert.equal(tildeText('/home/ann.bak/shop-web', H), '/home/ann.bak/shop-web');
  assert.equal(tildeText('link to /home/ann.bak/shop-web', H), 'link to /home/ann.bak/shop-web');
  assert.equal(tildeText('/home/ann-old/shop', H), '/home/ann-old/shop');
});

test('a tree that repeats the home path is shown whole', () => {
  assert.equal(tildeText('/srv/mirror/home/ann/shop-web', H), '/srv/mirror/home/ann/shop-web');
  assert.equal(tildeText('"/srv/mirror/home/ann/shop-web"', H), '"/srv/mirror/home/ann/shop-web"');
  assert.equal(tildeText('C:\\backup\\Users\\ann\\p', 'C:\\Users\\ann'), 'C:\\backup\\Users\\ann\\p');
});

test('the home where it starts a path is still ~', () => {
  assert.equal(tildeText('/home/ann/disk2/shop-web', H), '~/disk2/shop-web');
  assert.equal(tildeText('from /home/ann/a to /home/ann.bak/a', H), 'from ~/a to /home/ann.bak/a');
  assert.equal(tildeText('it is in /home/ann.', H), 'it is in ~.');
  assert.equal(tildeText('(/home/ann/x)', H), '(~/x)');
  assert.equal(tildeText('HOME=/home/ann', H), 'HOME=~');
});
