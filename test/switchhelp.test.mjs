// One line of help under each switch of Settings, the rest under a closed "More" (web/helpline.js). The source walk
// reads every switch of the Settings pages listed below (toggle, switchRow, the pages' own wrappers, and helpParts for
// a switch drawn by hand) and holds that the help a person sees at first is one sentence that fits one line; what is
// more stands in { line, more }, whose "more" is folded. The page part holds the fold itself: closed at first, "More"
// opens it and never turns the switch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byClass, texts } from './chat/fakedom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** The files of the Settings pages and their tabs that draw a switch. */
const FILES = ['web/settings.js', 'web/sessiondefaults.js', 'web/leadswitch.js', 'web/handsoffsettings.js', 'web/publiclink.js',
  'web/tia.js', 'web/automation.js', 'web/worktell.js', 'web/updates.js', 'web/codingtools.js', 'web/editor/index.js'];
/** Settings pages whose switches another part of the work changes now: not walked here. */
const ELSEWHERE = ['web/workspace.js', 'web/operator-tia.js', 'web/skilllearned.js'];
/** A call that draws a switch, and which of its arguments is the help. */
const CALLS = { toggle: 3, switchRow: 1, rule: 3, helpParts: 0 };
/** A table of switches: its rows' help is the last element. */
const TABLES = { 'web/worktell.js': 'ITEMS' };
/** One line at 1440 px: the Settings card's width at the hint's size holds about this many characters. */
const ONE_LINE = 130;

function skipString(s, j) {
  const q = s[j];
  for (let k = j + 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (q === '`' && s[k] === '$' && s[k + 1] === '{') {
      let d = 1;
      k += 2;
      for (; d; k++) if (s[k] === '{') d++; else if (s[k] === '}') d--;
      k--;
    } else if (s[k] === q) return k;
  }
  return s.length;
}

/** The arguments of the call (or the items of the list) whose bracket opens at `i`, as source text. */
function argsAt(s, i) {
  const out = [];
  let depth = 0;
  let start = i + 1;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\'' || c === '"' || c === '`') j = skipString(s, j);
    else if (c === '/' && s[j + 1] === '/') j = s.indexOf('\n', j);
    else if (c === '/' && s[j + 1] === '*') j = s.indexOf('*/', j) + 1;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (--depth === 0) {
        out.push(s.slice(start, j).trim());
        return out.filter((x, n) => x || n < out.length - 1);
      }
    } else if (c === ',' && depth === 1) {
      out.push(s.slice(start, j).trim());
      start = j + 1;
    }
  }
  throw new Error('unclosed call');
}

/** The text of every string in a piece of source; a ${NAME} of a constant of the file is put in. */
function strings(src, file) {
  const out = [];
  for (let j = 0; j < src.length; j++) {
    const c = src[j];
    if (c !== '\'' && c !== '"' && c !== '`') continue;
    const k = skipString(src, j);
    let t = src.slice(j + 1, k).replace(/\\(.)/g, '$1');
    if (c === '`') t = t.replace(/\$\{([A-Z_]+)\}/g, (m, name) => constant(file, name)).replace(/\$\{[^}]*\}/g, 'x');
    out.push(t);
    j = k;
  }
  return out;
}

function constant(file, name) {
  const s = read(file);
  const m = new RegExp(`(?:^|\\n)(?:export )?const ${name} = `).exec(s);
  assert.ok(m, `${file}: the constant ${name}`);
  const at = m.index + m[0].length;
  return strings(s.slice(at, skipString(s, at) + 1), file)[0];
}

/** The help a person sees at first, as its strings; null: decided at run time (splitHelp) or by the wrapper's callers. */
function visible(hint, file) {
  hint = hint && hint.replace(/^(\s*\/\/[^\n]*\n)+/, '').trim(); // a comment before the argument
  hint = hint && hint.replace(/^\s*\/\/[^\n]*\n/gm, '');
  if (!hint || hint === 'null' || hint === 'hint') return [];
  if (/^splitHelp\(/.test(hint)) return null;
  if (/^[A-Z_]+$/.test(hint)) return [constant(file, hint)];
  if (hint.startsWith('{')) {
    const props = argsAt(hint, 0);
    const line = props.find((p) => /^line:/.test(p));
    assert.ok(line, `${file}: a split help has its line: ${hint.slice(0, 80)}`);
    assert.ok(props.some((p) => /^more:/.test(p)), `${file}: a split help has its more`);
    return visible(line.replace(/^line:\s*/, ''), file);
  }
  return strings(hint, file);
}

/** Every switch's help in the file: [where, its visible strings]. */
function switches(file) {
  const s = read(file);
  const out = [];
  // Not a method (x.toggle), not the definition; a spread (...helpParts) is a call.
  for (const m of s.matchAll(/(?<!\w|[^.]\.|function )(toggle|switchRow|rule|helpParts)\(/g)) {
    const a = argsAt(s, m.index + m[0].length - 1);
    out.push([`${file}:${s.slice(0, m.index).split('\n').length} ${m[1]}`, a[CALLS[m[1]]] ?? null]);
  }
  if (TABLES[file]) {
    const at = s.indexOf(`const ${TABLES[file]} = [`);
    for (const row of argsAt(s, s.indexOf('[', at))) out.push([`${file} ${TABLES[file]}`, argsAt(row, 0).at(-1)]);
  }
  return out.map(([where, hint]) => [where, visible(hint, file)]);
}

const oneSentence = (t) => !/[.!?:;]?[.!?]["')”]?\s+\S/.test(t.trim());

test('every switch of Settings: the help it shows at first is one sentence on one line; the rest is under More', () => {
  let n = 0;
  for (const file of FILES) {
    const found = switches(file);
    if (!['web/publiclink.js', 'web/updates.js'].includes(file)) assert.ok(found.length, `${file}: its switches are found`);
    for (const [where, parts] of found) {
      if (!parts) continue;
      n++;
      for (const t of parts) assert.ok(oneSentence(t), `${where}: one sentence, not "${t}"`);
      const all = parts.join('');
      assert.ok(all.length <= ONE_LINE, `${where}: fits one line (${all.length} characters): "${all}"`);
    }
  }
  assert.ok(n >= 20, `the walk found ${n} switches`);
  // Drawn by hand (a checkbox and its line): through helpParts too, or one sentence as it is.
  assert.equal(read('web/sessiondefaults.js').match(/\.\.\.helpParts\(\{ line:/g).length, 1, 'bypass');
  assert.match(read('web/publiclink.js'), /h\('p\.hint', 'Off until you turn it on: nothing is reachable from outside while it is off\.'\)/);
  assert.match(read('web/tia.js'), /\}, splitHelp\(v\.help\.enabled\)\);/, 'Tia is on: the server\'s first sentence, the rest under More');
  for (const f of ELSEWHERE) assert.ok(!FILES.includes(f));
});

test('the fold: a line, then "More" closed; More opens with a press or Enter and never turns the switch', async () => {
  const { MORE, helpParts, splitHelp } = await import('../web/helpline.js');
  const [plain] = helpParts('Phones only.');
  assert.deepEqual(texts(plain), ['Phones only.']);
  const input = document.createElement('input');
  const [line, fold] = helpParts({ line: 'One line.', more: 'The rest.' }, { input, label: 'A switch' });
  assert.deepEqual(texts(line), ['One line.']);
  assert.equal(fold.tag, 'details');
  assert.notEqual(fold.open, true, 'closed at first');
  const summary = fold.children[0];
  assert.equal(summary.tag, 'summary', 'a summary: Tab reaches it, Enter and Space open it');
  assert.ok(texts(summary).includes(MORE) && MORE === 'More');
  assert.deepEqual(texts(byClass(fold, 'help-more-body')[0]), ['The rest.']);
  let taken = 0;
  summary.listeners.click({ preventDefault: () => taken++ });
  assert.equal(fold.open, true, 'opened');
  summary.listeners.click({ preventDefault: () => taken++ });
  assert.equal(fold.open, false, 'closed again');
  assert.equal(taken, 2, 'the press is taken: the label around it does not turn the switch');
  assert.equal(input.getAttribute('aria-label'), 'A switch', 'its name is the label alone');
  assert.equal(input.getAttribute('aria-describedby'), line.attrs.id, 'the line describes it');
  assert.deepEqual(splitHelp('Turn Tia on or off (off at first; she is new). Off hides her tab.'), { line: 'Turn Tia on or off (off at first; she is new).', more: 'Off hides her tab.' });
  assert.deepEqual(splitHelp('One sentence.'), { line: 'One sentence.', more: null });
  const css = read('web/style.css');
  assert.match(css, /\.help-more-summary \{[^}]*min-height/);
  assert.match(css, /\.help-more-summary::-webkit-details-marker \{ display: none; \}/);
});

test('the changelog says it', () => {
  const log = read('site/content/changelog.md');
  const block = log.slice(log.indexOf('\n## 0.3.4 '), log.indexOf('\n## ', log.indexOf('\n## 0.3.4 ') + 1));
  assert.match(block, /- \*\*One line of help under each switch\.\*\* [^\n]*\*\*More\*\*, closed at first/);
});
