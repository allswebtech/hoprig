// A file path in the chat (a tool card's path, or a `path` in Claude's text) as a button that opens Hoprig's editor at
// that file and line, and the menu of the desktop app for it (right-click, the menu key, or a long press on a phone):
// Attach as context, Open in > Editor / Source control, Copy > Absolute path / Relative path / Filename.
import { copyText, h, link, openApp, toast } from '../lib.js';
import { withMenu } from '../desktop/menu.js';
import { inFolder } from './words.js';

const EXT = 'js|mjs|cjs|jsx|ts|tsx|json|md|py|css|scss|html|vue|svelte|yml|yaml|toml|sh|txt|go|rs|java|kt|php|sql|rb|c|h|cpp|swift|lock|env|xml|ini|cfg|conf|log';
const SHAPE = new RegExp(`^(?=.*[/]|.*\\.(?:${EXT})(?::\\d|#L\\d|$))[\\w@.+~/-]+(?::(\\d+)(?::\\d+)?|#L(\\d+))?$`, 'i');

/**
 * What `text` says about a file of the folder `cwd`: { rel, abs, name, line } or null when it is no path that is inside
 * the folder (a plain word, an address, a path outside it). "src/a.js:12" and "src/a.js#L12" carry a line.
 */
export function pathSpec(text, cwd, line = 0) {
  const t = String(text || '').trim();
  const m = SHAPE.exec(t);
  if (!m || /^[a-z]+:\/\//i.test(t) || /(^|\/)\.\.(\/|$)|\/\//.test(t.replace(/^\/\//, ''))) return null;
  const at = Number(m[1] || m[2]) || line || 0;
  const bare = t.replace(/(?::\d+(?::\d+)?|#L\d+)$/, '');
  const base = String(cwd || '').replace(/\/+$/, '');
  let rel = bare;
  if (bare.startsWith('/')) {
    rel = inFolder(bare, base);
    if (rel === bare && base) return null; // outside the folder: the editor does not open it (no folder known yet: asked again when pressed)
  } else if (bare.startsWith('~')) return null;
  rel = rel.replace(/^\.\//, '');
  if (!rel || rel.endsWith('/')) return null;
  return { rel, abs: base ? `${base}/${rel}` : rel, name: rel.split('/').pop(), line: at };
}

/** The editor's address for a file of a folder (on this page's computer). */
export const fileLink = (dir, file, { line = 0, view = '' } = {}) => {
  const q = new URLSearchParams({ dir, file });
  if (line > 0) q.set('line', String(line));
  if (view) q.set('view', view);
  return link(`#/code?${q}`, null);
};

/** Open the file in the editor (a window of the desktop opens it beside the chat). */
export const openFile = (cwd, spec, view = '') => openApp('editor', fileLink(cwd, spec.rel, { line: spec.line, view }));

const copied = async (text) => toast((await copyText(text)) ? 'Copied' : 'Select it and copy it by hand');

/** The menu's items for one file. */
export function pathItems(cwd, spec) {
  return [
    { label: 'Attach as context', icon: 'plus', run: () => document.dispatchEvent(new CustomEvent('chat-attach-path', { detail: { path: spec.rel } })) },
    { label: 'Open in', icon: 'external', items: [
      { label: 'Editor', run: () => openFile(cwd, spec) },
      { label: 'Source control', run: () => openFile(cwd, spec, 'changes') },
    ] },
    { label: 'Copy', icon: 'copy', items: [
      { label: 'Absolute path', run: () => copied(spec.abs) },
      { label: 'Relative path', run: () => copied(spec.rel) },
      { label: 'Filename', run: () => copied(spec.name) },
    ] },
  ];
}

/**
 * A button for a path, or null when `text` is no file of the folder. `shown`: what it says (default: the path as typed).
 * The folder is read when it is pressed (dataset.cwd, said again by tools.js rePaths once the chat knows it).
 */
export function pathButton(text, { cwd = '', line = 0, shown = null } = {}) {
  const spec = pathSpec(text, cwd, line);
  if (!spec) return null;
  const b = h('button.chat-pathbtn', { type: 'button', title: `Open ${spec.rel} in the editor (right-click for more)`, 'aria-label': `Open ${spec.rel}${spec.line ? ` at line ${spec.line}` : ''} in the editor`,
    dataset: { pathfile: String(text), cwd: String(cwd || ''), line: String(line || 0) },
    onclick: () => {
      const s = pathSpec(b.dataset.pathfile, b.dataset.cwd, Number(b.dataset.line) || 0);
      if (s) openFile(b.dataset.cwd, s);
      else toast('That file is outside this session\'s folder');
    } }, shown ?? String(text));
  withMenu(b, () => {
    const s = pathSpec(b.dataset.pathfile, b.dataset.cwd, Number(b.dataset.line) || 0);
    return s ? pathItems(b.dataset.cwd, s) : null;
  }, `File ${spec.rel}`);
  return b;
}

/** The button `b` says its file again once the folder is known (title and screen-reader name too). */
export function repathButton(b, cwd) {
  b.dataset.cwd = cwd || '';
  const s = pathSpec(b.dataset.pathfile, cwd, Number(b.dataset.line) || 0);
  if (!s) return;
  b.title = `Open ${s.rel} in the editor (right-click for more)`;
  b.setAttribute('aria-label', `Open ${s.rel}${s.line ? ` at line ${s.line}` : ''} in the editor`);
}
