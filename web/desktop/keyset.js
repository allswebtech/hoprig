// Settings → Appearance, the desktop's keys: one plain list of them and the one choice that changes them (Alt+Shift,
// Ctrl+Alt, Off), kept on this device as the style is (keymap.js reads it, here and in every window's page).
import { fill, h, prefs } from '../lib.js';
import { fold } from '../shell.js';
import { DESK_KEYS, keyParts, keySet, keySetChoices, keysText, setLabel } from './keymap.js';

/** The fieldrow of the keys; `mark` is the row's "saved" mark. */
export function keysRow(mark) {
  const list = h('ul.desk-keylist');
  const line = h('div.hint.desk-keys-text');
  const paintList = (set) => {
    const l = setLabel(set);
    fill(line, keysText(set).map((t) => h('p', t)));
    fill(list, l ? DESK_KEYS.map((k) => h('li', h('kbd.desk-menu-key', keyParts(`${l}+${k.key}`).map((p) => (p.arrow ? h('span.desk-key-arrow', p.text) : p.text))), h('span', k.what)))
      : h('li', h('span', 'The desktop takes no key. The title bar\'s menu (a right click, or a long press) has every act.')));
  };
  const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Desktop keys' });
  const paint = (cur) => {
    fill(seg, keySetChoices().map(([v, label]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: (e) => {
      e.preventDefault();
      prefs.set('desktop.keys', v);
      paint(v);
      mark.show();
    } }, h('span', label))));
    paintList(cur);
  };
  paint(keySet(prefs.get('desktop.keys', 'alt-shift')));
  // The notes and the table of keys are under "Keys", closed: the choice is what a person comes for.
  return h('div.fieldrow', h('span.field-label', 'Desktop keys', mark), seg, fold('desktop-keys', 'Keys', line, list));
}
