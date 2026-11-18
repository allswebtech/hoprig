// A small Markdown renderer for the site: the subset the product's docs, its README and the site's own pages use
// (headings, paragraphs, lists, fenced code, tables, block quotes, raw HTML blocks, links, images, emphasis, code).
// It is written here instead of taken from npm so that the site builds, and its test runs, with no install at all.
//
//   renderMarkdown(text, { link(href) → href, slug: makeSlugger() }) → { html, headings: [{ depth, text, id }] }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const escapeHtml = esc;

/** GitHub's heading ids: lower case, punctuation dropped, spaces to hyphens; a repeat gets -1, -2 … */
export function makeSlugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/** The visible text of an inline Markdown string (for ids, titles and descriptions). */
export function plainText(md) {
  return md
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*]+)\*/g, '$1$2')
    // Real HTML tags only: a placeholder such as <brain address> is text.
    .replace(/<\/?(?:p|br|img|a|b|i|em|strong|code|span|kbd|sub|sup|div|picture|source)\b[^>]*>/gi, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    .trim();
}

// ---------------------------------------------------------------- inline

const INLINE_TAGS = /^<\/?(br|kbd|b|i|em|strong|sub|sup)\s*\/?>/i;

function inline(src, opts) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && /[\\`*_{}[\]()#+\-.!|<>]/.test(src[i + 1] || '')) {
      s += hold(esc(src[i + 1]));
      i += 2;
    } else if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0];
      const end = src.indexOf(run, i + run.length);
      // A run of backticks closes only on a run of the same length.
      let close = end;
      while (close !== -1 && src[close + run.length] === '`') close = src.indexOf(run, close + run.length + 1);
      if (close === -1) {
        s += run;
        i += run.length;
      } else {
        let code = src.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        s += hold(`<code>${esc(code)}</code>`);
        i = close + run.length;
      }
    } else if (c === '<' && /^<(https?:\/\/[^\s>]+)>/.test(src.slice(i))) {
      const url = /^<(https?:\/\/[^\s>]+)>/.exec(src.slice(i))[1];
      s += hold(`<a href="${esc(opts.link(url))}">${esc(url)}</a>`);
      i += url.length + 2;
    } else if (c === '<' && INLINE_TAGS.test(src.slice(i))) {
      const tag = INLINE_TAGS.exec(src.slice(i))[0];
      s += hold(tag);
      i += tag.length;
    } else if ((c === '[' || (c === '!' && src[i + 1] === '[')) && linkAt(src, i)) {
      const l = linkAt(src, i);
      const href = esc(opts.link(l.href));
      if (l.image) s += hold(`<img src="${href}" alt="${esc(plainText(l.text))}"${l.title ? ` title="${esc(l.title)}"` : ''}>`);
      else s += hold(`<a href="${href}"${l.title ? ` title="${esc(l.title)}"` : ''}>${inline(l.text, opts)}</a>`);
      i = l.end;
    } else {
      s += c;
      i++;
    }
  }
  s = esc(s)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[Number(n)]);
}

/** A link or image starting at i: [text](href "title"), the text may hold one level of brackets, the address balanced
 * parentheses (a link such as https://en.wikipedia.org/wiki/Tmux_(software) is not cut at its first ")"). */
function linkAt(src, i) {
  const image = src[i] === '!';
  let j = i + (image ? 2 : 1);
  let depth = 1;
  for (; j < src.length && depth; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '[') depth++;
    else if (src[j] === ']') depth--;
  }
  if (depth || src[j] !== '(') return null;
  let k = j + 1;
  while (src[k] === ' ') k++;
  let href = '';
  if (src[k] === '<') {
    const close = src.indexOf('>', k);
    if (close === -1 || /[\n<]/.test(src.slice(k + 1, close))) return null;
    href = src.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    for (; k < src.length && !/\s/.test(src[k]); k++) {
      if (src[k] === '\\' && k + 1 < src.length) { href += src[++k]; continue; }
      if (src[k] === '(') parens++;
      else if (src[k] === ')' && !parens--) break;
      href += src[k];
    }
    if (parens > 0) return null;
  }
  const rest = /^(?:\s+"([^"]*)")?\s*\)/.exec(src.slice(k));
  if (!rest) return null;
  return { image, text: src.slice(i + (image ? 2 : 1), j - 1), href, title: rest[1] || '', end: k + rest[0].length };
}

// ---------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)([^`]*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
// A line that is one HTML comment is a note for whoever edits the file (a generator's part is filled before this).
const COMMENT = /^ {0,3}<!--.*-->\s*$/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)/;
const HTML_BLOCK = /^ {0,3}<\/?(p|div|img|table|details|summary|picture|section|figure|br|hr|h[1-6]|ul|ol|li|blockquote|pre|center|a)\b/i;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const CONTAINER = /^:::\s*([\w-]+(?:\s+[\w-]+)*)\s*$/;

/**
 * Whether a fenced block gets a copy button: a shell block only, never one with a <placeholder> line or one marked
 * `nocopy` (a list of alternatives). For the product's docs ('one') only a single command: their blocks of several
 * lines are lists of choices more often than scripts, and they are not edited for the site.
 */
function copyable(lang, info, body, mode) {
  if (!/^(sh|bash|shell)$/.test(lang) || /\bnocopy\b/.test(info)) return false;
  const lines = body.map((l) => l.replace(/(^|\s+)#(\s.*)?$/, '')).filter((l) => l.trim());
  // A stand-in is a placeholder too: <name>, a value cut short with …, an example.com address.
  if (!lines.length || lines.some((l) => /<[^<>\s][^<>]*>|…|\bexample\.(com|org|net)\b/.test(l))) return false;
  return mode === 'one' ? lines.length === 1 : true;
}

const indentOf = (line) => /^ */.exec(line)[0].length;
const blank = (line) => !line.trim();

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || LIST.test(line) || HTML_BLOCK.test(line) || /^ {0,3}>/.test(line)
    || CONTAINER.test(line) || (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'));
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '`') {
      code = !code;
      cur += '`';
    } else if (s[i] === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function blocks(lines, opts, out) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line) || COMMENT.test(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1];
      const pad = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) body.push(lines[i++].replace(new RegExp(`^ {0,${pad}}`), ''));
      i++;
      const lang = m[2] ? ` class="language-${esc(m[2])}"` : '';
      const copy = copyable(m[2], m[3], body, opts.copy) ? ' data-copyable' : '';
      out.push(`<pre${copy}><code${lang}>${esc(body.join('\n'))}</code></pre>`);
    } else if ((m = HEADING.exec(line))) {
      const depth = m[1].length;
      const text = plainText(m[2]);
      const id = opts.slug(text);
      opts.headings.push({ depth, text, id });
      out.push(`<h${depth} id="${esc(id)}">${inline(m[2], opts)}</h${depth}>`);
      i++;
    } else if (HR.test(line)) {
      out.push('<hr>');
      i++;
    } else if ((m = CONTAINER.exec(line))) {
      const body = [];
      i++;
      let depth = 1;
      while (i < lines.length) {
        if (CONTAINER.test(lines[i])) depth++;
        else if (/^:::\s*$/.test(lines[i]) && !--depth) break;
        body.push(lines[i++]);
      }
      i++;
      out.push(`<div class="${esc(m[1])}">`);
      blocks(body, opts, out);
      out.push('</div>');
    } else if (HTML_BLOCK.test(line)) {
      const body = [];
      while (i < lines.length && !blank(lines[i])) body.push(lines[i++]);
      out.push(opts.html(body.join('\n')));
    } else if (/^ {0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && !blank(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push('<blockquote>');
      blocks(body, opts, out);
      out.push('</blockquote>');
    } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      // A class, not a style attribute: the pages' content security policy allows no inline style.
      const al = (n) => (align[n] ? ` class="al-${align[n]}"` : '');
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      // data-label: on a phone a wide table shows as one card per row, each answer under its column's name.
      const label = (n) => (n && plainText(head[n]) ? ` data-label="${esc(plainText(head[n]))}"` : '');
      const wide = head.length >= 4 ? ' table-wide' : '';
      out.push(`<div class="table${wide}"><table><thead><tr>${head.map((c, n) => `<th${al(n)}>${inline(c, opts)}</th>`).join('')}</tr></thead><tbody>`
        + rows.map((r) => `<tr>${head.map((_, n) => `<td${al(n)}${label(n)}>${inline(r[n] || '', opts)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>');
    } else if (LIST.test(line)) {
      i = list(lines, i, opts, out);
    } else {
      const body = [line.trim()];
      i++;
      while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) body.push(lines[i++].trim());
      out.push(`<p>${inline(body.join('\n'), opts)}</p>`);
    }
  }
}

/** One list from line i; returns the index after it. Items hold blocks of their own (nested lists, code). */
function list(lines, i, opts, out) {
  const first = LIST.exec(lines[i]);
  const ordered = /\d/.test(first[2]);
  const base = first[1].length;
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const pad = m[1].length + m[2].length + (m[3].length > 4 || !m[3].length ? 1 : m[3].length);
    const body = [lines[i].slice(Math.min(pad, lines[i].length))];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        sawBlank = true;
        body.push('');
        i++;
        continue;
      }
      const ind = indentOf(l);
      if (ind >= pad || (ind > base && LIST.test(l))) {
        if (sawBlank) loose = true;
        body.push(l.slice(Math.min(ind, pad)));
        sawBlank = false;
        i++;
      } else if (!sawBlank && !startsBlock(l, lines[i + 1])) {
        body.push(l.trim()); // a lazy continuation of the item's paragraph
        i++;
      } else break;
    }
    while (body.length && blank(body[body.length - 1])) body.pop();
    if (sawBlank && i < lines.length && LIST.test(lines[i]) && LIST.exec(lines[i])[1].length === base) loose = true;
    items.push(body);
  }
  const start = ordered && Number.parseInt(first[2], 10) !== 1 ? ` start="${Number.parseInt(first[2], 10)}"` : '';
  out.push(ordered ? `<ol${start}>` : '<ul>');
  for (const body of items) {
    const inner = [];
    blocks(body, opts, inner);
    let html = inner.join('\n');
    if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, '$1');
    out.push(`<li>${html}</li>`);
  }
  out.push(ordered ? '</ol>' : '</ul>');
  return i;
}

// Raw HTML in a doc: only what the README really uses survives as markup, with only the attributes it uses. Every
// other tag (a script, a style, an iframe, an onerror=…) is shown as text, so a doc can never put code into a page.
const HTML_TAGS = new Set(['p', 'img', 'a', 'br', 'b', 'h1']);
const HTML_ATTRS = new Set(['align', 'src', 'alt', 'width', 'height', 'href']);
const VOID = new Set(['img', 'br']);
const decode = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Text keeps the entities it already has (&nbsp; &quot;); a bare & or < becomes text.
const escText = (t) => t.replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** An address that may stand in an href or src: http(s), mailto, a path or an anchor; never javascript: or data:. */
export const safeUrl = (v) => (/^(https?:|mailto:|\/|#|\.|[\w-]+(?:[/.#?]|$))/i.test(v) && !/^\s*(javascript|vbscript|data):/i.test(v) ? v : '#');

// Judged before and after the page's own rewriting: a javascript: address never becomes a path that holds it.
const linkSafe = (v, link) => (safeUrl(v) === '#' ? '#' : safeUrl(link(v)));

export function sanitizeHtml(block, link = (h) => h) {
  let out = '';
  let last = 0;
  for (const m of block.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g)) {
    out += escText(block.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (!HTML_TAGS.has(name)) {
      out += escText(m[0]);
      continue;
    }
    if (m[1]) {
      out += VOID.has(name) ? '' : `</${name}>`;
      continue;
    }
    let attrs = '';
    for (const a of m[3].matchAll(/([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
      const key = a[1].toLowerCase();
      if (!HTML_ATTRS.has(key)) continue;
      let v = decode(a[2] ?? a[3] ?? a[4] ?? '');
      if (key === 'href' || key === 'src') v = linkSafe(v, link);
      attrs += ` ${key}="${esc(v)}"`;
    }
    out += `<${name}${attrs}>`;
  }
  return out + escText(block.slice(last));
}

/** Markdown to HTML. `link` rewrites every href and src (also inside raw HTML); `slug` makes heading ids. `copy`
 * decides which shell blocks get a copy button: 'site' (no placeholder, no `nocopy`) or 'one' (one command only). */
export function renderMarkdown(text, { link = (h) => h, slug = makeSlugger(), copy = 'site' } = {}) {
  const headings = [];
  const html = (block) => sanitizeHtml(block, link);
  const opts = { link: (h) => linkSafe(h, link), slug, headings, html, copy };
  const out = [];
  blocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), opts, out);
  return { html: out.join('\n'), headings };
}

/** `---` front matter of plain `key: value` lines; values `true`/`false`/numbers become those. */
export function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n?/g, '\n'));
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    data[kv[1]] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
  }
  return { data, body: text.replace(/\r\n?/g, '\n').slice(m[0].length) };
}
