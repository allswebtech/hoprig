// Where the editor is opened: the folders opened lately (the page without a folder lists them), a folder's name on any
// system, and what the page says, in place of everything else, about a folder it cannot open.
import { btn, h, link, prefs, tildePath } from '../lib.js';
import { icon } from '../icons.js';

/** The folders opened in this browser lately, newest first: [{ dir, machine }]. */
export const recentFolders = () => {
  const v = prefs.get('editor.recent', []);
  return Array.isArray(v) ? v.filter((x) => x && typeof x.dir === 'string').slice(0, 8) : [];
};
const others = (dir, m) => recentFolders().filter((x) => !(x.dir === dir && (x.machine || null) === (m || null)));
export function remember(dir, m) {
  prefs.set('editor.recent', [{ dir, machine: m || null }, ...others(dir, m)].slice(0, 8));
}
export function forget(dir, m) {
  prefs.set('editor.recent', others(dir, m));
}

/** The last part of a folder's path, on any system ("C:\\work\\shop" and "/home/a/shop" alike). */
export const folderName = (dir) => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;

/**
 * The page for a folder that cannot be opened (outside the folders the dashboard may show, private, gone, or the
 * computer does not answer): what it is, and what to do next.
 */
export function refused(e, root) {
  const outside = e.status === 403 && /may show/.test(e.message);
  const [title, text] = e.status === 404
    ? ['This folder is not there', 'It may have been moved or deleted.']
    : outside
      ? ['This folder is outside the dashboard\'s folders', 'The editor opens only folders inside the folder list in Settings → New-session defaults → Advanced → Folders. Open a project from Workspace, or add its folder to that list.']
      : e.status === 403
        ? ['This folder is not opened in the editor', `${e.message[0].toUpperCase()}${e.message.slice(1)}.`]
        : ['The folder could not be read', e.message];
  return h('div.ed-fail', icon('folder', { size: 34 }), h('h2.ed-fail-title', title), h('p.ed-fail-text', text), h('p.ed-fail-text.muted', tildePath(root)),
    h('div.ed-fail-tools',
      h('a.btn.primary', { href: link('#/workspace') }, 'Go to Workspace'),
      outside ? h('a.btn.secondary', { href: link('#/settings/new-sessions?show=folders', null) }, 'Open the folder list') : null,
      e.status >= 500 || !e.status ? btn('secondary', { icon: 'refresh', label: 'Try again', onclick: () => location.reload() }) : null));
}
