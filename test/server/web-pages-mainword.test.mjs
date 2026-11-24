// "hub" is "main computer" in every sentence a person reads on the Computers pages and their parts (code names, ids
// and routes keep "hub").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const FILES = ['web/computers.js', 'web/sshkey.js', 'web/pc.js', 'web/pcsetup.js', 'web/health.js', 'web/sessiondefaults.js', 'web/joinlink.js'];
const DIRS = ['web/desktop', 'web/editor'];

const root = new URL('../../', import.meta.url);
const all = [...FILES, ...DIRS.flatMap((d) => fs.readdirSync(new URL(d, root)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`))];

test('words: no sentence on the Computers pages says hub; it is the main computer', () => {
  for (const f of all) {
    const src = fs.readFileSync(new URL(f, root), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    const strings = src.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
    // A string with a space in it is a sentence; a bare 'hub' is an id, and ${t.hub} is code.
    for (const s of strings.filter((x) => / /.test(x))) assert.doesNotMatch(s.replace(/\$\{[^}]*\}/g, ''), /\bhubs?\b/i, `${f}: ${s}`);
  }
  const c = fs.readFileSync(new URL('web/computers.js', root), 'utf8');
  assert.match(c, /'Mark as my main computer'/);
  assert.match(c, /`\$\{t\.name\} is marked as your main computer`/);
  // The route keeps its name: only the words changed.
  assert.match(c, /~\/api\/tokens\/\$\{t\.id\}\/hub/);
});
