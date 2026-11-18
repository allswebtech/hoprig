// Markdown from a file shown as plain, safe formatting: headings, lists, quotes, code blocks, `code` and **bold**.
// Every piece of the file is set as text through h(); nothing in it is ever read as HTML, a link or an image.
import { add, h } from './lib.js';

/** `code` and **bold** inside one line, as nodes. */
export function inline(line) {
  const out = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m; (m = re.exec(line));) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(m[1] !== undefined ? h('code', m[1]) : h('strong', m[2]));
    last = re.lastIndex;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** The nodes of a Markdown text, in a div.md. */
export function mdView(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // { el, ordered }
  let para = [];
  const endPara = () => {
    if (para.length) out.push(h('p', inline(para.join(' '))));
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
      out.push(h('pre.md-code', code.join('\n')));
      continue;
    }
    // A line that is only an HTML comment (a marker such as Hoprig's around the Memory section) is not shown, as in
    // any rendered Markdown. Nothing else in the file is treated as markup.
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      endPara();
      endList();
      // The closing #s go ("## Title ##"). Trimmed first: a pattern with a run of blanks before the #s took time in
      // the square of the blanks on a heading of a session's text.
      out.push(h(`h${Math.min(4, head[1].length + 1)}`, inline(head[2].trimEnd().replace(/\s#+$/, '').trimEnd())));
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
      add(list.el, h('li', inline(item[3])));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      endPara();
      endList();
      out.push(h('blockquote', inline(line.replace(/^\s*>\s?/, ''))));
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
