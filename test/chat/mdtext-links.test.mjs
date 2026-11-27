// A reply's Markdown (web/mdtext.js, option rich): links open in a new tab and only http and https are links, *italic*
// is shown, a code block can carry a Copy button, a `path` in the text can become a button. A file view (no option)
// stays free of links.
import assert from 'node:assert/strict';
import test from 'node:test';
import { texts } from './fakedom.mjs';

const { mdView } = await import('../../web/mdtext.js');
const links = (v) => v.querySelectorAll('a');

test('rich: [text](url) and a bare address are links in a new tab, never an other scheme', () => {
  const v = mdView('See [the docs](https://example.com/a?b=1) and https://example.org/x, then http://example.net.', { rich: true });
  const a = links(v);
  assert.deepEqual(a.map((x) => x.attrs.href), ['https://example.com/a?b=1', 'https://example.org/x', 'http://example.net/']);
  assert.deepEqual(a.map((x) => texts(x).join('')), ['the docs', 'https://example.org/x', 'http://example.net']);
  for (const x of a) {
    assert.equal(x.attrs.target, '_blank');
    assert.match(x.attrs.rel, /noopener/);
  }
  assert.equal(texts(v).join('').endsWith(', then http://example.net.'), true, 'the closing full stop is not part of the address');
});

test('rich: javascript:, data: and other schemes stay plain text', () => {
  const v = mdView('[x](javascript:alert(1)) [y](data:text/html,hi) [z](ftp://h/f) [w](/relative)', { rich: true });
  assert.equal(links(v).length, 0);
  assert.match(texts(v).join(''), /x/);
});

test('rich: *italic* is shown; a star in a sum or a list is not', () => {
  const v = mdView('This is *quite* so, 2*3*4 and **bold**.', { rich: true });
  assert.deepEqual(v.querySelectorAll('em').map((x) => texts(x).join('')), ['quite']);
  assert.deepEqual(v.querySelectorAll('strong').map((x) => texts(x).join('')), ['bold']);
  assert.equal(mdView('- one\n- two', { rich: true }).querySelectorAll('li').length, 2);
});

test('a file view (no option) stays without links and italic', () => {
  const v = mdView('[a](https://example.com) https://example.org *it*');
  assert.equal(links(v).length, 0);
  assert.equal(v.querySelectorAll('em').length, 0);
  assert.match(texts(v).join(''), /https:\/\/example\.org \*it\*/);
});

test('a link text inside code stays code, and a code span can become a path button', () => {
  const v = mdView('Open `src/cart.js:12` and `npm test` or `https://x.org`.', { rich: true, onCode: (t) => (t.startsWith('src/') ? document.createElement('button') : null) });
  assert.equal(v.querySelectorAll('button').length, 1, 'only the path became a button');
  assert.equal(links(v).length, 0, 'inside code a link is not made');
});

test('the code option draws a block', () => {
  const v = mdView('```js\nlet a = 1;\n```', { code: (c) => { const d = document.createElement('div'); d.className = 'cw'; d.append(c); return d; } });
  assert.equal(v.querySelectorAll('.cw').length, 1);
});
