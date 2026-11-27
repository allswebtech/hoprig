// Markdown from a file shown as plain, safe formatting: headings, lists, quotes, code blocks, small tables, `code` and
// **bold**.
// Every piece of the file is set as text through h(); nothing in it is ever read as HTML or an image. Links only in a reply (rich), http and https only.
import { add, h } from './lib.js';

/** A web address that may be a link: http and https only (a text that is anything else stays text). */
export function webUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
}
const link = (href, kids) => h('a.md-link', { href, target: '_blank', rel: 'noopener noreferrer' }, kids);

/**
 * `code` and **bold** inside one line, as nodes. o.rich (a reply in the chat; a file view has none): also [text](url),
 * a bare http(s) address (a full stop or bracket at its end is not part of it) and *italic*. o.onCode(text): a node for
 * a `code` span (a path as a button), or null to leave it code.
 */
export function inline(line, { rich = false, onCode = null } = {}) {
  const out = [];
  const re = rich
    ? /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"'`]+)|(?<![*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![*\w])/g
    : /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m; (m = re.exec(line));) {
    let end = re.lastIndex;
    let node;
    if (m[1] !== undefined) node = (onCode && onCode(m[1])) || h('code', m[1]);
    else if (m[2] !== undefined) node = h('strong', m[2]);
    else if (m[3] !== undefined) {
      const u = webUrl(m[4]);
      node = u ? link(u, m[3]) : null;
    } else if (m[5] !== undefined) {
      const bare = m[5].replace(/[.,;:!?)\]]+$/, '');
      const u = webUrl(bare);
      end = m.index + bare.length;
      node = u ? link(u, bare) : null;
    } else node = h('em', m[6]);
    if (!node) continue; // not a link we make: left as the text it was
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(node);
    last = end;
    re.lastIndex = end;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/**
 * The nodes of a Markdown text, in a div.md. `code(text)`: how a code block is drawn (default: a pre of its text).
 * `rich`, `onCode`: see inline(). `breaks`: a single line break inside a paragraph stays a line break (a chat message), not a space (a file).
 */
export function mdView(text, { code: block = null, breaks = false, rich = false, onCode = null } = {}) {
  const inl = (l) => inline(l, { rich, onCode });
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // { el, ordered }
  let para = [];
  const endPara = () => {
    if (para.length) out.push(h('p', breaks ? para.flatMap((l, k) => (k ? [h('br'), ...inl(l)] : inl(l))) : inl(para.join(' '))));
    para = [];
  };
  const endList = () => {
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      endPara();
      endList();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      out.push(block ? block(code.join('\n')) : h('pre.md-code', code.join('\n')));
      continue;
    }
    // A line that is only an HTML comment (a marker such as Hoprig's around the Memory section) is not shown, as in
    // any rendered Markdown. Nothing else in the file is treated as markup.
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    // A small table ("| a | b |" over "|---|---|"): every cell is text. Its header row is the first.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[i + 1] || '')) {
      endPara();
      endList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]) && rows.length < 50; i++) rows.push(cells(lines[i]));
      i--;
      out.push(h('div.md-tablewrap', h('table.md-table', h('thead', h('tr', head.map((c) => h('th', { scope: 'col' }, inl(c))))),
        h('tbody', rows.map((r) => h('tr', head.map((_, k) => h('td', inl(r[k] || '')))))))));
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      endPara();
      endList();
      // The closing #s go ("## Title ##"). Trimmed first: a pattern with a run of blanks before the #s took time in
      // the square of the blanks on a heading of a session's text.
      out.push(h(`h${Math.min(4, head[1].length + 1)}`, inl(head[2].trimEnd().replace(/\s#+$/, '').trimEnd())));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      const ordered = /\d/.test(item[2]);
      if (!list || list.ordered !== ordered) {
        list = { el: h(ordered ? 'ol' : 'ul'), ordered };
        out.push(list.el);
      }
      add(list.el, h('li', inl(item[3])));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      endPara();
      endList();
      out.push(h('blockquote', inl(line.replace(/^\s*>\s?/, ''))));
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      endPara();
      endList();
      out.push(h('hr'));
      continue;
    }
    if (!line.trim()) {
      endPara();
      endList();
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      add(list.el.lastChild, ` ${line.trim()}`);
      continue;
    }
    endList();
    para.push(line.trim());
  }
  endPara();
  return h('div.md', out);
}
