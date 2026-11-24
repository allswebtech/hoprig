// A session's extra folders on its card, its Workspace row and its page (web/sessionitem.js extrasLine): by map name,
// one line, the whole list in its title and its words for a screen reader; nothing for a session without any.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byClass, texts } from '../chat/fakedom.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

test('the card, the row and the page name the extra folders', async () => {
  const { extrasLine, sessionCard, sessionRow } = await import('../../web/sessionitem.js');
  assert.equal(extrasLine({}), null);
  assert.equal(extrasLine({ extras: [] }), null);
  const line = extrasLine({ extras: ['kits/parts', 'blog'] });
  assert.deepEqual(texts(line), ['Also reads: kits/parts, blog']);
  assert.equal(line.attrs['aria-label'], 'Also reads (its file tools cannot write there): kits/parts, blog');
  const s = { name: 'shop', kind: 'claude', status: 'waiting', short: '~/Workspace/projects/shop', extras: ['kits/parts'], machine: null };
  for (const node of [sessionCard(s, [], () => {}, false), sessionRow(s, [], () => {})]) {
    assert.equal(byClass(node, 'card-extras').length, 1);
  }
  assert.equal(byClass(sessionCard({ ...s, extras: undefined }, [], () => {}, false), 'card-extras').length, 0);
  assert.match(fs.readFileSync(path.join(WEB, 'session.js'), 'utf8'), /extrasLine\(s, 'span\.card-extras\.sess-extras'\)/, 'the session page too');
  // On the session page the whole list wraps (a phone has no hover for the title); only the card cuts it.
  assert.match(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8'), /\.sess-extras \.card-extras-text \{ white-space: normal;/);
});
