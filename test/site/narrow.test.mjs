// On a phone nothing of a table or a code block is cut off. site/scripts/narrow-check.mjs measures every page of the
// built site at 390x844 in Chrome and judges the boxes with narrowFaults; these tests hold that rule with boxes of
// their own, so the suite and the browser check judge alike.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { narrowFaults, pagesOf, clipsOf, SIZE } = await import('../../site/scripts/narrow-check.mjs');
const W = SIZE.width;

const { renderMarkdown } = await import('../../site/lib/markdown.mjs');
const css = fs.readFileSync(new URL('../../site/app/(site)/pages.css', import.meta.url), 'utf8');

test('the check looks at a phone: 390x844', () => {
  assert.deepEqual(SIZE, { width: 390, height: 844 });
});

test('a table cell that ends inside the window and inside its box is no fault', () => {
  assert.deepEqual(narrowFaults({ width: W, items: [{ kind: 'cell', n: 1, right: 374, box: { right: 374, cue: false } }, { kind: 'cell', n: 1, right: 200, box: null }] }), []);
});

test('a table cell past the window is a fault (the page would scroll sideways)', () => {
  const f = narrowFaults({ width: W, items: [{ kind: 'cell', n: 2, right: 408, box: null }] });
  assert.equal(f.length, 1);
  assert.match(f[0], /table 2: a cell ends at 408 px, outside the window of 390/);
});

test('a table cell hidden in its own sideways scroll is a fault, even with a fade: a table shows every column', () => {
  const f = narrowFaults({ width: W, items: [{ kind: 'cell', n: 1, right: 512, box: { right: 373, cue: true } }] });
  assert.equal(f.length, 1);
  assert.match(f[0], /hidden in a sideways scroll/);
});

test('a code line past its box with no cue is a fault; with the fade it is not', () => {
  const line = { kind: 'code', n: 1, right: 1209 };
  const bare = narrowFaults({ width: W, items: [{ ...line, box: { right: 373, cue: false } }] });
  assert.equal(bare.length, 1);
  assert.match(bare[0], /code block 1: a line ends at 1209 px, past its box's edge at 373, with no cue/);
  assert.deepEqual(narrowFaults({ width: W, items: [{ ...line, box: { right: 373, cue: true } }] }), []);
});

test('a code block whose own box is wider than the window is a fault, cue or not', () => {
  const f = narrowFaults({ width: W, items: [{ kind: 'code', n: 3, right: 500, box: { right: 420, cue: true } }] });
  assert.equal(f.length, 1);
  assert.match(f[0], /scroll box ends at 420 px, outside the window/);
});

test('a code line in no scroll box must end inside the window', () => {
  assert.deepEqual(narrowFaults({ width: W, items: [{ kind: 'code', n: 1, right: 380, box: null }] }), []);
  assert.equal(narrowFaults({ width: W, items: [{ kind: 'code', n: 1, right: 450, box: null }] }).length, 1);
});

test('a pixel of rounding is no fault', () => {
  assert.deepEqual(narrowFaults({ width: W, items: [{ kind: 'cell', n: 1, right: 390.8, box: null }, { kind: 'code', n: 1, right: 373.5, box: { right: 373, cue: false } }] }), []);
});

test('the pages are read from the build itself: index files become addresses, the 404 page stays a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narrow-'));
  try {
    for (const f of ['index.html', '404.html', 'docs/index.html', 'docs/skills/index.html', '_next/static/x.html', 'docs/skills.md']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    assert.deepEqual(pagesOf(dir), ['/', '/404.html', '/docs/', '/docs/skills/']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The rules of one @media block whose query matches `query` (the first such block).
const mediaBlock = (query) => {
  const at = css.indexOf(`@media (${query})`);
  if (at < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  return '';
};

test('every value of a table carries its column\'s name, the first column\'s too (a card has no head row)', () => {
  const { html } = renderMarkdown('| Command | What it does |\n|---|---|\n| `hop list` | the sessions |\n');
  assert.match(html, /<td data-label="Command"><code>hop list<\/code><\/td>/);
  assert.match(html, /<td data-label="What it does">the sessions<\/td>/);
  assert.match(html, /<thead><tr><th scope="col">Command<\/th>/, 'the HTML stays a real table for a screen reader');
  // A table whose rows are named in their first column keeps that cell a row header, with no label of its own.
  const named = renderMarkdown('| | A | B |\n|---|---|---|\n| Sets up | yes | no |\n').html;
  assert.match(named, /<th scope="row">Sets up<\/th><td data-label="A">yes<\/td>/);
});

test('below 480 px every table is cards, each value under its column\'s name, and none scrolls sideways', () => {
  const block = mediaBlock('max-width: 479.98px');
  assert.ok(block, 'a @media (max-width: 479.98px) block in pages.css');
  assert.match(block, /\.prose \.table \{[^}]*overflow: visible/);
  assert.match(block, /\.prose \.table table, \.prose \.table tbody, \.prose \.table tr, \.prose \.table td[^{]*\{[^}]*display: block/);
  assert.match(block, /\.prose \.table thead \{[^}]*clip-path: inset\(50%\)/, 'the head row is kept for a screen reader, not shown');
  assert.match(block, /\.prose \.table td\[data-label\]::before \{[^}]*content: attr\(data-label\)/);
});

test('a code block with a Copy button shows its right fade beside the button, not under it', () => {
  // Seen 22 Nov 2026 at 390 px on the install line: the Copy button (8 px in from the right edge) covered the right
  // fade, so only a few pixels of it showed and the cue that more text follows was lost.
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.prose pre\.has-copy, :root\[data-js\] \.prose pre\[data-copyable\] \{ background-position: ([^;]+); \}/.exec(flat)?.[1] || '';
  const at = rule.split(',').map((x) => x.trim());
  assert.equal(at.length, 5, 'a position for each layer of the block\'s background');
  // Layers 2 and 4 are the right cover (local) and the right fade (scroll): both at the same place, left of the button.
  for (const n of [1, 3]) {
    const off = Number(/^right (\d+)px center$/.exec(at[n])?.[1]);
    assert.ok(off >= 64 && off <= 72, `layer ${n + 1} at ${at[n] || 'the edge'}: its strong end just under the button's left edge (9 + 64 px from the block's edge)`);
  }
  assert.equal(at[1], at[3], 'the cover hides the fade where the fade is');
});

test('a code block can be reached and scrolled by the keyboard, and has a name; Copy still finds its block', () => {
  const { html } = renderMarkdown('```sh\nhoprig doctor\n```');
  assert.match(html, /<pre data-copyable><code class="language-sh" tabindex="0" role="group" aria-label="Code">hoprig doctor<\/code><\/pre>/);
  assert.match(css, /\.prose pre:has\(> code:focus-visible\) \{[^}]*outline: 2px solid/, 'a focus ring on the box');
});

test('a code block wider than its box shows a fade at the edge that has more, gone at the end (both themes)', () => {
  const rule = [...css.matchAll(/\.prose pre \{([^}]*)\}/g)].map((m) => m[1]).find((b) => /background:/.test(b) && /gradient/.test(b)) || '';
  assert.match(rule, /linear-gradient\(to right, var\(--console-bg\)[^,]*, transparent\)[^,]*local/, 'a cover at the left that moves with the code');
  assert.match(rule, /linear-gradient\(to left, var\(--console-bg\)[^,]*, transparent\)[^,]*local/, 'a cover at the right that moves with the code');
  assert.match(rule, /linear-gradient\(to right, var\(--code-fade\), transparent\)[^,]*scroll/, 'a fade that stays at the left edge');
  assert.match(rule, /linear-gradient\(to left, var\(--code-fade\), transparent\)[^,]*scroll/, 'a fade that stays at the right edge');
  // Theme-free: the console's own tokens, which tokens.css sets for light and dark alike.
  assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b/i);
});

test('in a table, a code word with a hyphen is one piece: an option never splits as "[--" and "json]" on a phone', () => {
  // Seen 22 Nov 2026 at 390 px: cards broke "[--" / "json]", "[--dry-" / "run]", "server-" / "setup" (Chrome breaks
  // after any hyphen). Each such word is wrapped and kept on one line; the words still break at their spaces.
  const { html } = renderMarkdown('| Command | What it does |\n|---|---|\n| `hoprig adopt scan [--dry-run] [--json]` | looks |\n');
  assert.match(html, /<code>hoprig adopt scan <span class="tok">\[--dry-run\]<\/span> <span class="tok">\[--json\]<\/span><\/code>/);
  assert.match(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\.prose td code \.tok \{ white-space: nowrap; \}/);
  // A word too long for a card may still break, and code outside a table is left as it is.
  assert.doesNotMatch(renderMarkdown(`| A |\n|---|\n| \`--${'x'.repeat(40)}\` |\n`).html, /class="tok"/);
  assert.match(renderMarkdown('Run `hoprig doctor --offline` now.').html, /<code>hoprig doctor --offline<\/code>/);
});

test('in a table, a long code address breaks only after a "/" or "|", never inside a word', () => {
  // Seen 22 Nov 2026 at 390 px on the operator page: "(install|update|start|sto" then a lone "p)".
  const { html } = renderMarkdown('| Act |\n|---|\n| `POST /api/addons/<id>/(install|update|start|stop)` |\n');
  assert.match(html, /<code>POST \/<wbr>api\/<wbr>addons\/<wbr>&lt;id&gt;\/<wbr>\(install\|<wbr>update\|<wbr>start\|<wbr>stop\)<\/code>/);
  // A short address stays as it is, and code outside a table too.
  assert.match(renderMarkdown('| A |\n|---|\n| `GET /api/state` |\n').html, /<code>GET \/api\/state<\/code>/);
  assert.match(renderMarkdown('See `POST /api/addons/<id>/(install|update|start|stop)`.').html, /<code>POST \/api\/addons\/&lt;id&gt;\/\(install\|update\|start\|stop\)<\/code>/);
});

test('in a table\'s plain words an option or a path with a hyphen is one piece, and a lone "--" keeps its word', () => {
  // Seen 22 Nov 2026 at 390 px on the tools page: "no project unless --" / "with-projects", "push only with --push; --"
  // / "with:", "ID and --" / "\"first message\"", "docs/FIELD-" / "REPORTS.md".
  const cell = (text) => renderMarkdown(`| Command | What it gives |\n|---|---|\n| x | ${text} |\n`).html;
  assert.match(cell('no project unless --with-projects (one)'), /unless <span class="tok">--with-projects<\/span> \(one\)/);
  assert.match(cell('push only with --push; --with: straight'), /with <span class="tok">--push;<\/span> <span class="tok">--with:<\/span> straight/);
  assert.match(cell('(--check only says; --dry-run shows)'), /<span class="tok">\(--check<\/span> only says; <span class="tok">--dry-run<\/span> shows/);
  assert.match(cell('ID and -- "first message" as above'), /and <span class="tok">-- &quot;first<\/span> message/);
  assert.match(cell('way-round; docs/FIELD-REPORTS.md)'), /way-round; <span class="tok">docs\/FIELD-REPORTS\.md\)<\/span>/);
  // An ordinary word with a hyphen still breaks as before, and words outside a table are left as they are.
  assert.doesNotMatch(cell('fetch and fast-forward'), /class="tok"/);
  assert.match(renderMarkdown('Run it with --with-projects now.').html, /<p>Run it with --with-projects now\.<\/p>/);
  assert.match(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\.prose td \.tok \{ white-space: nowrap; \}/);
});

test('a code block\'s Copy button stays beside the code when it scrolls, and no code shows right of it', () => {
  // Seen 22 Nov 2026 at 390 px on the install line: the button sat in the scrolling block, and between it and the
  // block's right border a sliver of the command (":" or "|") showed. The button now sits on a wrapper outside the
  // scroll, with a strip of the console's colour over that sliver.
  const script = fs.readFileSync(new URL('../../site/app/(site)/PageScripts.tsx', import.meta.url), 'utf8');
  assert.match(script, /wrap\.className = 'pre-wrap';/);
  assert.match(script, /wrap\.append\(pre, b\);/, 'the block and its button side by side in the wrapper');
  assert.doesNotMatch(script, /pre\.append\(b\)/, 'the button is not inside the block that scrolls');
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(flat, /\.prose \.pre-wrap \{ position: relative;/);
  const strip = /\.pre-wrap::after \{([^}]*)\}/.exec(flat)?.[1] || '';
  assert.match(strip, /inset: 1px; background: linear-gradient\(to left, var\(--console-bg\) 9px, transparent 9px\)/, 'the strip covers the 8 px right of the button, inside the border');
  // Seen 22 Nov 2026 in light at 390 px: a strip 9 px wide with the block's 14 px radius was drawn with a smaller one
  // (a radius is shrunk to fit its box), so its corner stood over the block's rounded border. The strip has the
  // block's own inner curve: as wide as the block, the radius less the 1 px border.
  assert.match(strip, /border-radius: calc\(var\(--r-lg\) - 1px\)/);
  assert.doesNotMatch(strip, /width: \d/, 'no narrow box that cannot hold the curve');
});

test('a table taller than a picture can hold is kept in parts, so its last cards are seen too', () => {
  // The pictures were cut at 3000 CSS px (6000 px at the phone's scale 2): the tools tables ended in the middle of a card.
  assert.deepEqual(clipsOf('tools-2-table-light', { x: 0, y: 100, width: 390, height: 1200 }), [{ file: 'tools-2-table-light.png', clip: { x: 0, y: 100, width: 390, height: 1200 } }]);
  const parts = clipsOf('tools-2-table-light', { x: 0, y: 100, width: 390, height: 7000 });
  assert.deepEqual(parts.map((p) => p.file), ['tools-2-table-light.png', 'tools-2-table-light-part2.png', 'tools-2-table-light-part3.png']);
  assert.deepEqual(parts.map((p) => [p.clip.y, p.clip.height]), [[100, 3000], [3100, 3000], [6100, 1000]]);
});
