// The desktop's keys, with no DOM: which modifiers they use (Settings → Appearance, kept on this device), which key
// does what, how a key is written in a menu, and whether a key press belongs to the desktop or to the page in the
// window. lib.js reads it inside a window's page too, so the keys work wherever the keyboard is.
//
// Alt+Tab, Cmd+Tab and the Windows key belong to the computer: a browser page never gets them. The desktop's own
// keys take one modifier set and the arrows, M, W and ` (the key above Tab).

/** The modifier sets: what is held with the desktop's keys ("mac": how a Mac's keyboard names them). "Off": none. */
export const KEY_SETS = {
  'alt-shift': { label: 'Alt+Shift', mac: 'Option+Shift', alt: true, shift: true, ctrl: false },
  'ctrl-alt': { label: 'Ctrl+Alt', mac: 'Ctrl+Option', alt: true, shift: false, ctrl: true },
  off: null,
};
/** The kept choice, read back: anything unknown is the default. */
export const keySet = (v) => (Object.hasOwn(KEY_SETS, v) ? v : 'alt-shift');

/** The keys of the desktop, in the order Settings lists them. `arrow`: the code editor has its own use for it. */
export const DESK_KEYS = [
  { act: 'left', code: 'ArrowLeft', key: '←', aria: 'ArrowLeft', what: 'Snap to the left half', arrow: true },
  { act: 'right', code: 'ArrowRight', key: '→', aria: 'ArrowRight', what: 'Snap to the right half', arrow: true },
  { act: 'up', code: 'ArrowUp', key: '↑', aria: 'ArrowUp', what: 'Maximise; from a half, its top quarter', arrow: true },
  { act: 'down', code: 'ArrowDown', key: '↓', aria: 'ArrowDown', what: 'Back to its place; from a half, its bottom quarter; then minimise', arrow: true },
  { act: 'cycle', code: 'Backquote', key: '`', aria: '`', what: 'The next window, in the order last used (hold the keys and press again to go on)' },
  { act: 'min', code: 'KeyM', key: 'M', aria: 'M', what: 'Minimise' },
  { act: 'close', code: 'KeyW', key: 'W', aria: 'W', what: 'Close' },
];

/** A Mac, where Option+Shift with a key types a character, or with an arrow selects by word, in every text box. */
export const onMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent || '');

/** A Linux desktop, where GNOME keeps some of these keys for itself (its window manager's default keys). */
export const onLinux = () => typeof navigator !== 'undefined' && /Linux/.test(navigator.platform || '') && !/Android/.test(navigator.userAgent || '');

/** The name of a modifier set as this computer's keyboard says it ("Alt+Shift", on a Mac "Option+Shift"); null: off. */
export function setLabel(set, mac = onMac()) {
  const s = KEY_SETS[keySet(set)];
  return s ? (mac ? s.mac : s.label) : null;
}

/** The choice in Settings, as [value, name] in its order, named as this computer's keyboard says them. */
export const keySetChoices = (mac = onMac()) => Object.keys(KEY_SETS).map((v) => [v, setLabel(v, mac) || 'Off']);

/** How a key is written in a menu: "Alt+Shift+←" ("Option+Shift+←" on a Mac); null with the keys off. */
export function keyLabel(set, act, mac = onMac()) {
  const l = setLabel(set, mac);
  const k = DESK_KEYS.find((x) => x.act === act);
  return l && k ? `${l}+${k.key}` : null;
}

/** The key for a screen reader (aria-keyshortcuts): "Alt+Shift+ArrowLeft"; null with the keys off. */
export function keyShortcut(set, act) {
  const s = KEY_SETS[keySet(set)];
  const k = DESK_KEYS.find((x) => x.act === act);
  return s && k ? [s.ctrl && 'Control', s.alt && 'Alt', s.shift && 'Shift', k.aria].filter(Boolean).join('+') : null;
}

/** The parts of a key's name for drawing: text, and each arrow on its own (drawn larger; desktop.css .desk-key-arrow). */
export const keyParts = (label) => String(label).split(/([←→↑↓])/).filter(Boolean).map((t) => ({ text: t, arrow: /^[←→↑↓]$/.test(t) }));

/** The two presses that reach a quarter (a half, then up or down): "Alt+Shift+← ↑"; null with the keys off. */
const QUARTER_PATH = { tl: ['left', 'up'], tr: ['right', 'up'], bl: ['left', 'down'], br: ['right', 'down'] };
export function quarterLabel(set, quarter, mac = onMac()) {
  const [a, b] = QUARTER_PATH[quarter] || [];
  const first = a ? keyLabel(set, a, mac) : null;
  return first ? `${first} ${DESK_KEYS.find((x) => x.act === b).key}` : null;
}

/**
 * The plain sentences under the choice in Settings, for this computer (`mac`, `linux`). GNOME's defaults take
 * Shift+Alt+Above_Tab (switch-group-backward) and Ctrl+Alt with an arrow (switch-to-workspace-*) before the browser.
 */
export function keysText(set, { mac = onMac(), linux = onLinux() } = {}) {
  const v = keySet(set);
  const l = setLabel(v, mac);
  // A Mac's top row is its own keys (brightness, sound…) unless the owner chose otherwise: F6 there is Fn+F6.
  const f6 = mac ? 'Fn+F6' : 'F6';
  const out = `${f6} takes the keyboard from the app in a window to its title bar.`;
  if (!l) return [`Off: every key goes to the app in the window, except ${f6}, which takes the keyboard to its title bar.`];
  return [
    `${mac ? 'Cmd+Tab' : 'Alt+Tab'} belongs to your computer; here it is ${l}+\`.`,
    mac ? 'In the code editor and in any text box these keys stay with what you type; every act is also in the title bar\'s menu.'
      : 'In the code editor these keys with the arrows stay with what you type; every act is also in the title bar\'s menu.',
    linux && v === 'alt-shift' ? 'On GNOME, Alt+Shift+` is the computer\'s too: there "Next window" in the title bar\'s menu goes on.' : null,
    linux && v === 'ctrl-alt' ? 'On GNOME, Ctrl+Alt with an arrow switches workspaces: there only Ctrl+Alt+M, W and ` reach the desktop.' : null,
    out,
  ].filter(Boolean);
}

/**
 * What the keyboard's place keeps of the desktop's keys: 'all' on a Mac in any place to type (a text box, the code
 * editor: Option+Shift with a letter or ` types a character there, a Mac reports no AltGraph, and with an arrow it
 * selects by word); 'arrows' in the code editor elsewhere (copy a line, add a cursor); false anywhere else. A terminal
 * keeps none: the desktop takes its keys there (a Mac's terminal reads Option as Meta).
 */
export function inTextField(el, mac = onMac()) {
  if (!el || typeof el.closest !== 'function') return false;
  if (el.classList && el.classList.contains('xterm-helper-textarea')) return false;
  if (el.closest('.monaco-editor')) return mac ? 'all' : 'arrows';
  return mac && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true) ? 'all' : false;
}

/**
 * The desktop's act for a key press ('left', 'cycle', 'min'…), or null when it is not the desktop's. `e` is a keydown
 * (or its fields: code, altKey, shiftKey, ctrlKey, metaKey, altGraph). `inText`: what the keyboard's place keeps
 * (inTextField: 'all', 'arrows' or false). With Ctrl+Alt, a key typed with AltGr (Ctrl+Alt on Windows, a character on many keyboards
 * outside the US) stays a character.
 */
export function deskKeyOf(e, set = 'alt-shift', { inText = false } = {}) {
  const s = KEY_SETS[keySet(set)];
  if (!s || !e || e.metaKey || inText === 'all') return null;
  const altGraph = e.altGraph ?? (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'));
  if (altGraph || !!e.altKey !== s.alt || !!e.shiftKey !== s.shift || !!e.ctrlKey !== s.ctrl) return null;
  const k = DESK_KEYS.find((x) => x.code === e.code);
  if (!k || (k.arrow && inText)) return null;
  return k.act;
}

/** True while `e` is a key up of one of the set's modifiers: a cycle through the windows ends. */
export function modifierUp(e, set = 'alt-shift') {
  const s = KEY_SETS[keySet(set)];
  if (!s || !e) return false;
  return (s.alt && /^Alt/.test(e.key || e.code || '')) || (s.shift && /^Shift/.test(e.key || e.code || '')) || (s.ctrl && /^Control/.test(e.key || e.code || ''));
}
