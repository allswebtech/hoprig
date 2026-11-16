// A small reader of TOML, enough for Codex's config.toml: tables, arrays of tables, dotted and quoted keys, every
// string form, arrays and inline tables. Other values (numbers, dates) are kept as their text where they are not
// true, false or a plain number: Hoprig reads only a few keys of the owner's file and never writes it.
// It throws on text it cannot read; callers decide what that means.

/** A TOML string (Codex parses every -c value as TOML): JSON's escapes are TOML's, plus DEL. */
export const tomlString = (s) => JSON.stringify(String(s)).replace(/\x7f/g, '\\u007f');

const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const BARE = /[A-Za-z0-9_-]+/y;
const SCALAR = /[^\s,\]}#]+/y;

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseToml(text) {
  const s = String(text);
  let i = 0;
  const fail = (what) => {
    throw new Error(`cannot read the TOML at character ${i}: ${what}`);
  };
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  const comment = () => {
    if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
  };
  const blank = () => {
    for (;;) {
      if (' \t\r\n'.includes(s[i]) && i < s.length) i++;
      else if (s[i] === '#') comment();
      else return;
    }
  };
  const endOfLine = () => {
    ws();
    comment();
    if (s[i] === '\r') i++;
    if (i < s.length && s[i] !== '\n') fail('more after a value on its line');
  };

  function escape() {
    const c = s[i + 1];
    if (c in ESC) return (i += 2), ESC[c];
    const n = c === 'u' ? 4 : c === 'U' ? 8 : c === 'x' ? 2 : 0;
    const hex = s.slice(i + 2, i + 2 + n);
    if (!n || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== n) fail('an escape');
    i += 2 + n;
    return String.fromCodePoint(parseInt(hex, 16));
  }

  function string() {
    const q = s[i];
    if (s.startsWith(q.repeat(3), i)) {
      i += 3;
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
      let out = '';
      for (;;) {
        if (i >= s.length) fail('a string that is not closed');
        if (s.startsWith(q.repeat(3), i)) {
          let n = 3;
          while (s[i + n] === q && n < 5) n++; // up to two quotes may end the text itself
          out += q.repeat(n - 3);
          i += n;
          return out;
        }
        if (q === '"' && s[i] === '\\') {
          const m = /\\[ \t]*\r?\n[ \t\r\n]*/y;
          m.lastIndex = i;
          if (m.exec(s)) i = m.lastIndex; // a line-ending backslash joins the lines
          else out += escape();
          continue;
        }
        out += s[i++];
      }
    }
    i++;
    let out = '';
    for (;;) {
      const c = s[i];
      if (c === undefined || c === '\n') fail('a string that is not closed');
      if (c === q) return i++, out;
      if (q === '"' && c === '\\') out += escape();
      else out += s[i++];
    }
  }

  function key() {
    const parts = [];
    for (;;) {
      ws();
      if (s[i] === '"' || s[i] === "'") parts.push(string());
      else {
        BARE.lastIndex = i;
        const m = BARE.exec(s);
        if (!m) fail('a key');
        parts.push(m[0]);
        i = BARE.lastIndex;
      }
      ws();
      if (s[i] !== '.') return parts;
      i++;
    }
  }

  function put(obj, parts, v) {
    let o = obj;
    for (const p of parts.slice(0, -1)) {
      if (o[p] === undefined) o[p] = {};
      if (!isTable(o[p])) fail(`"${parts.join('.')}" twice`);
      o = o[p];
    }
    const last = parts[parts.length - 1];
    if (last in o) fail(`"${parts.join('.')}" twice`);
    o[last] = v;
  }

  function value() {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") return string();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        blank();
        if (s[i] === ']') return i++, arr;
        arr.push(value());
        blank();
        if (s[i] === ',') i++;
        else if (s[i] === ']') return i++, arr;
        else fail('an array');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        blank();
        if (s[i] === '}') return i++, obj;
        const k = key();
        if (s[i] !== '=') fail('"=" after a key');
        i++;
        put(obj, k, value());
        blank();
        if (s[i] === ',') i++;
        else if (s[i] === '}') return i++, obj;
        else fail('an inline table');
      }
    }
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(s);
    if (!m) fail('a value');
    i = SCALAR.lastIndex;
    const t = m[0];
    if (t === 'true' || t === 'false') return t === 'true';
    const n = Number(t.replace(/_/g, ''));
    return /^[+-]?[0-9_.eE+-]+$/.test(t) && Number.isFinite(n) ? n : t;
  }

  const root = {};
  let cur = root;
  for (;;) {
    blank();
    if (i >= s.length) return root;
    if (s[i] === '[') {
      const many = s[i + 1] === '[';
      i += many ? 2 : 1;
      const parts = key();
      if (s[i] !== ']' || (many && s[i + 1] !== ']')) fail('a table name');
      i += many ? 2 : 1;
      let o = root;
      parts.forEach((p, n) => {
        const lastPart = n === parts.length - 1;
        if (lastPart && many) {
          if (o[p] === undefined) o[p] = [];
          if (!Array.isArray(o[p])) fail(`"${parts.join('.')}" twice`);
          o[p].push({});
          o = o[p][o[p].length - 1];
          return;
        }
        if (o[p] === undefined) o[p] = {};
        if (Array.isArray(o[p])) o = o[p][o[p].length - 1];
        else if (isTable(o[p])) o = o[p];
        else fail(`"${parts.join('.')}" twice`);
      });
      cur = o;
      endOfLine();
      continue;
    }
    const k = key();
    if (s[i] !== '=') fail('"=" after a key');
    i++;
    put(cur, k, value());
    endOfLine();
  }
}
